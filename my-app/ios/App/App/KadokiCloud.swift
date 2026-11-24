import Foundation

/// iCloud Drive library storage (shared by the iOS/visionOS plugin and the Mac
/// app's message handler — Foundation only, no UIKit/AppKit).
///
/// Everything lives in the app's public ubiquity container, shown in iCloud
/// Drive as "Kadoki". Paths in and out are RELATIVE to the container's
/// Documents folder ("Library/<syncId>/title.json"); ".." is refused.
///
/// One request/reply contract for both platforms: `handle(req)` where
/// req["op"] picks the operation. Replies are JSON-safe dictionaries.
/// Events (file changes, download progress, account changes) go out through
/// `onEvent(name, payload)`.
///
/// Placeholders: a file that isn't on this device is still listed (with
/// status "notDownloaded"); reads start its download and wait for it. Older
/// systems show such files as ".name.icloud" — listing maps those back to the
/// real name.
final class KadokiCloud: NSObject {
    static let shared = KadokiCloud()
    static let containerID = "iCloud.com.helica1.yama"

    /// Set by the platform wrapper: delivers events to JS.
    var onEvent: ((String, [String: Any]) -> Void)?

    private let queue = DispatchQueue(label: "kadoki.cloud", qos: .utility)
    private var docsURL: URL?          // resolved container Documents (queue only)
    private var resolved = false
    private var query: NSMetadataQuery?
    private var lastToken: NSObjectProtocol?

    private override init() {
        super.init()
        lastToken = FileManager.default.ubiquityIdentityToken.map { $0 as NSObjectProtocol }
        NotificationCenter.default.addObserver(self, selector: #selector(identityChanged),
                                               name: .NSUbiquityIdentityDidChange, object: nil)
    }

    // MARK: - Entry point

    typealias Reply = ([String: Any]?, String?) -> Void

    func handle(_ req: [String: Any], reply: @escaping Reply) {
        let op = (req["op"] as? String) ?? ""
        if op == "watch" {   // NSMetadataQuery lives on the main run loop
            DispatchQueue.main.async { self.setWatching(req["on"] as? Bool ?? true); reply(["ok": true], nil) }
            return
        }
        queue.async {
            do { reply(try self.run(op, req), nil) }
            catch { reply(nil, (error as NSError).localizedDescription) }
        }
    }

    private struct CloudError: LocalizedError {
        let errorDescription: String?
        init(_ s: String) { errorDescription = s }
    }

    // MARK: - Container

    /// Resolves (once) and returns the container's Documents folder. Blocking —
    /// call on `queue` only.
    private func docs() throws -> URL {
        if let d = docsURL { return d }
        guard let c = FileManager.default.url(forUbiquityContainerIdentifier: Self.containerID) else {
            throw CloudError("iCloud Drive is unavailable. Check that you're signed in to iCloud and iCloud Drive is on.")
        }
        let d = c.appendingPathComponent("Documents", isDirectory: true).resolvingSymlinksInPath()
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        docsURL = d
        return d
    }

    private func url(_ rel: Any?) throws -> URL {
        let r = ((rel as? String) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if r.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) { throw CloudError("bad path") }
        let base = try docs()
        return r.isEmpty ? base : base.appendingPathComponent(r)
    }

    private func rel(_ u: URL) -> String {
        guard let base = docsURL?.path else { return u.path }
        let p = u.resolvingSymlinksInPath().path
        if p == base { return "" }
        return p.hasPrefix(base + "/") ? String(p.dropFirst(base.count + 1)) : p
    }

    /// The real URL for an item, whether it's present or a legacy ".x.icloud" stub.
    private func stubURL(for u: URL) -> URL {
        u.deletingLastPathComponent().appendingPathComponent("." + u.lastPathComponent + ".icloud")
    }

    // MARK: - Operations

    private func run(_ op: String, _ req: [String: Any]) throws -> [String: Any] {
        let fm = FileManager.default
        switch op {
        case "status":
            do { let d = try docs(); return ["available": true, "root": d.path] }
            catch { return ["available": false, "error": error.localizedDescription] }

        case "list":
            let dir = try url(req["path"])
            let recursive = req["recursive"] as? Bool ?? false
            return ["entries": try list(dir, recursive: recursive)]

        case "stat":
            let u = try url(req["path"])
            guard let e = entry(u) ?? (fm.fileExists(atPath: stubURL(for: u).path) ? entry(stubURL(for: u)) : nil)
            else { return ["exists": false] }
            var out = e; out["exists"] = true; return out

        case "localPath":
            let u = try url(req["path"])
            return ["path": u.path, "downloaded": isCurrent(u)]

        case "readText":
            let u = try url(req["path"])
            try ensureLocal(u, waitMs: (req["waitMs"] as? Double) ?? 20000)
            var text: String?; var readErr: Error?
            var cErr: NSError?
            NSFileCoordinator().coordinate(readingItemAt: u, options: [], error: &cErr) { r in
                do { text = try String(contentsOf: r, encoding: .utf8) } catch { readErr = error }
            }
            if let e = cErr ?? (readErr as NSError?) { throw e }
            return ["text": text ?? ""]

        case "writeText":
            let u = try url(req["path"])
            let text = (req["text"] as? String) ?? ""
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            var writeErr: Error?; var cErr: NSError?
            NSFileCoordinator().coordinate(writingItemAt: u, options: .forReplacing, error: &cErr) { w in
                do { try text.write(to: w, atomically: true, encoding: .utf8) } catch { writeErr = error }
            }
            if let e = cErr ?? (writeErr as NSError?) { throw e }
            return ["ok": true]

        case "mkdir":
            try fm.createDirectory(at: try url(req["path"]), withIntermediateDirectories: true)
            return ["ok": true]

        case "download":
            let u = try url(req["path"])
            var n = 0
            for f in try filesUnder(u) where !isCurrent(f) { try? fm.startDownloadingUbiquitousItem(at: f); n += 1 }
            if req["wait"] as? Bool == true { try ensureLocal(u, waitMs: (req["waitMs"] as? Double) ?? 600_000) }
            return ["started": n]

        case "evict":
            // "Remove download": the file stays in iCloud, this device drops its copy.
            let u = try url(req["path"])
            var n = 0
            for f in try filesUnder(u) where isCurrent(f) {
                if (try? f.resourceValues(forKeys: [.ubiquitousItemIsUploadedKey]).ubiquitousItemIsUploaded) == true {
                    try? fm.evictUbiquitousItem(at: f); n += 1
                }
            }
            return ["evicted": n]

        case "importFile":
            // Moves (or copies) a local file into the library. A move is
            // atomic: the source is never deleted unless it arrived.
            var src = (req["src"] as? String) ?? ""
            if src.hasPrefix("file://") { src = URL(string: src)?.path ?? String(src.dropFirst(7)) }
            src = src.removingPercentEncoding ?? src
            guard !src.isEmpty, fm.fileExists(atPath: src) else { throw CloudError("source missing: \(src)") }
            let dest = try url(req["dest"])
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) {
                guard req["overwrite"] as? Bool == true else { throw CloudError("destination exists") }
                try coordinatedRemove(dest)
            }
            var from = URL(fileURLWithPath: src)
            if req["move"] as? Bool != true {
                let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + from.lastPathComponent)
                try fm.copyItem(at: from, to: tmp)
                from = tmp
            }
            try fm.setUbiquitous(true, itemAt: from, destinationURL: dest)
            return ["ok": true, "path": rel(dest)]

        case "remove":
            let u = try url(req["path"])
            guard !rel(u).isEmpty else { throw CloudError("refusing to remove the library root") }
            if fm.fileExists(atPath: u.path) { try coordinatedRemove(u) }
            else if fm.fileExists(atPath: stubURL(for: u).path) { try coordinatedRemove(stubURL(for: u)) }
            return ["ok": true]

        case "move":
            let from = try url(req["from"]), to = try url(req["to"])
            try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            var mErr: Error?; var cErr: NSError?
            NSFileCoordinator().coordinate(writingItemAt: from, options: .forMoving, writingItemAt: to,
                                           options: .forReplacing, error: &cErr) { a, b in
                do { try fm.moveItem(at: a, to: b) } catch { mErr = error }
            }
            if let e = cErr ?? (mErr as NSError?) { throw e }
            return ["ok": true]

        default:
            throw CloudError("unknown op \(op)")
        }
    }

    private func coordinatedRemove(_ u: URL) throws {
        var rErr: Error?; var cErr: NSError?
        NSFileCoordinator().coordinate(writingItemAt: u, options: .forDeleting, error: &cErr) { w in
            do { try FileManager.default.removeItem(at: w) } catch { rErr = error }
        }
        if let e = cErr ?? (rErr as NSError?) { throw e }
    }

    // MARK: - Listing / status

    private static let keys: [URLResourceKey] = [
        .isDirectoryKey, .fileSizeKey, .contentModificationDateKey,
        .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey,
        .ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey,
    ]

    private func entry(_ u: URL) -> [String: Any]? {
        guard let v = try? u.resourceValues(forKeys: Set(Self.keys)) else { return nil }
        var name = u.lastPathComponent
        var path = rel(u)
        var status = "current"
        if name.hasPrefix("."), name.hasSuffix(".icloud") {          // legacy placeholder
            name = String(name.dropFirst().dropLast(7))
            path = (path as NSString).deletingLastPathComponent
            path = path.isEmpty ? name : path + "/" + name
            status = "notDownloaded"
        } else if name.hasPrefix(".") {
            return nil
        } else if let s = v.ubiquitousItemDownloadingStatus {
            status = s == .current ? "current" : (s == .downloaded ? "downloaded" : "notDownloaded")
        }
        var e: [String: Any] = [
            "name": name, "path": path,
            "isDir": v.isDirectory ?? false,
            "status": status,
            "downloading": v.ubiquitousItemIsDownloading ?? false,
            "uploaded": v.ubiquitousItemIsUploaded ?? true,
            "uploading": v.ubiquitousItemIsUploading ?? false,
        ]
        if let s = v.fileSize { e["size"] = s }
        if let m = v.contentModificationDate { e["mtime"] = Int(m.timeIntervalSince1970 * 1000) }
        return e
    }

    private func list(_ dir: URL, recursive: Bool) throws -> [[String: Any]] {
        let fm = FileManager.default
        var out: [[String: Any]] = []
        guard fm.fileExists(atPath: dir.path) else { return out }
        if recursive {
            let en = fm.enumerator(at: dir, includingPropertiesForKeys: Self.keys, options: [])
            while let u = en?.nextObject() as? URL { if let e = entry(u) { out.append(e) } }
        } else {
            for u in try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: Self.keys, options: []) {
                if let e = entry(u) { out.append(e) }
            }
        }
        return out
    }

    /// Files at or under `u` (the item itself when it's a file), real names.
    private func filesUnder(_ u: URL) throws -> [URL] {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: u.path, isDirectory: &isDir) {
            if !isDir.boolValue { return [u] }
            var out: [URL] = []
            let en = fm.enumerator(at: u, includingPropertiesForKeys: [.isDirectoryKey], options: [])
            while let f = en?.nextObject() as? URL {
                if (try? f.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { continue }
                let n = f.lastPathComponent
                if n.hasPrefix("."), n.hasSuffix(".icloud") {
                    out.append(f.deletingLastPathComponent().appendingPathComponent(String(n.dropFirst().dropLast(7))))
                } else if !n.hasPrefix(".") { out.append(f) }
            }
            return out
        }
        if fm.fileExists(atPath: stubURL(for: u).path) { return [u] }
        throw CloudError("not found: \(rel(u))")
    }

    private func isCurrent(_ u: URL) -> Bool {
        if !FileManager.default.fileExists(atPath: u.path) { return false }
        let s = (try? u.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus
        return s == nil || s == .current
    }

    /// Starts the download of a file not on this device and waits for it.
    private func ensureLocal(_ u: URL, waitMs: Double) throws {
        let files = try filesUnder(u)
        let missing = files.filter { !isCurrent($0) }
        if missing.isEmpty { return }
        for f in missing { try? FileManager.default.startDownloadingUbiquitousItem(at: f) }
        let deadline = Date().addingTimeInterval(waitMs / 1000)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            if missing.allSatisfy({ isCurrent($0) }) { return }
        }
        throw CloudError("still downloading from iCloud: \(rel(u))")
    }

    // MARK: - Change feed (NSMetadataQuery)

    private func setWatching(_ on: Bool) {
        if !on { query?.stop(); query = nil; return }
        if query != nil { return }
        let q = NSMetadataQuery()
        q.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
        q.predicate = NSPredicate(format: "%K LIKE '*'", NSMetadataItemFSNameKey)
        q.notificationBatchingInterval = 1.0
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(queryUpdated(_:)), name: .NSMetadataQueryDidFinishGathering, object: q)
        nc.addObserver(self, selector: #selector(queryUpdated(_:)), name: .NSMetadataQueryDidUpdate, object: q)
        query = q
        q.start()
    }

    @objc private func queryUpdated(_ n: Notification) {
        guard let q = n.object as? NSMetadataQuery else { return }
        q.disableUpdates()
        var items: [NSMetadataItem] = []
        if n.name == .NSMetadataQueryDidFinishGathering {
            items = (q.results as? [NSMetadataItem]) ?? []
        } else {
            for k in [NSMetadataQueryUpdateAddedItemsKey, NSMetadataQueryUpdateChangedItemsKey] {
                items += (n.userInfo?[k] as? [NSMetadataItem]) ?? []
            }
        }
        let removed = ((n.userInfo?[NSMetadataQueryUpdateRemovedItemsKey] as? [NSMetadataItem]) ?? [])
        func describe(_ it: NSMetadataItem) -> [String: Any]? {
            guard let u = it.value(forAttribute: NSMetadataItemURLKey) as? URL else { return nil }
            var d: [String: Any] = ["url": u.path]
            if let s = it.value(forAttribute: NSMetadataUbiquitousItemDownloadingStatusKey) as? String {
                d["status"] = s == NSMetadataUbiquitousItemDownloadingStatusCurrent ? "current"
                    : (s == NSMetadataUbiquitousItemDownloadingStatusDownloaded ? "downloaded" : "notDownloaded")
            }
            if let p = it.value(forAttribute: NSMetadataUbiquitousItemPercentDownloadedKey) as? Double { d["percent"] = p }
            if let up = it.value(forAttribute: NSMetadataUbiquitousItemIsUploadedKey) as? Bool { d["uploaded"] = up }
            return d
        }
        let changed = items.compactMap(describe)
        let gone = removed.compactMap(describe)
        q.enableUpdates()
        // Relative paths need the resolved container (queue-owned).
        queue.async {
            _ = try? self.docs()
            let fix: ([String: Any]) -> [String: Any] = { d in
                var o = d; o["path"] = self.rel(URL(fileURLWithPath: d["url"] as? String ?? "")); o.removeValue(forKey: "url"); return o
            }
            let payload: [String: Any] = ["initial": n.name == .NSMetadataQueryDidFinishGathering,
                                          "changed": changed.map(fix), "removed": gone.map(fix)]
            DispatchQueue.main.async { self.onEvent?("change", payload) }
        }
    }

    @objc private func identityChanged() {
        let tok = FileManager.default.ubiquityIdentityToken.map { $0 as NSObjectProtocol }
        let same = (tok == nil && lastToken == nil) || (tok != nil && lastToken != nil && tok!.isEqual(lastToken!))
        lastToken = tok
        queue.async { self.docsURL = nil }   // re-resolve against the new account
        DispatchQueue.main.async { self.onEvent?("account", ["signedIn": tok != nil, "changed": !same]) }
    }

    #if DEBUG
    /// Runs every KadokiCloud op once against a scratch folder and NSLogs the
    /// results ("[CloudTest] ..."). Launch with KADOKI_CLOUD_SELFTEST=1.
    func selfTest() {
        let c = self
        let steps: [[String: Any]] = [
            ["op": "status"],
            ["op": "writeText", "path": "SelfTest/a/hello.json", "text": "{\"a\":1}"],
            ["op": "readText", "path": "SelfTest/a/hello.json"],
            ["op": "stat", "path": "SelfTest/a/hello.json"],
            ["op": "stat", "path": "SelfTest/nope.json"],
            ["op": "list", "path": "SelfTest", "recursive": true],
            ["op": "move", "from": "SelfTest/a/hello.json", "to": "SelfTest/b/moved.json"],
            ["op": "readText", "path": "SelfTest/b/moved.json"],
            ["op": "readText", "path": "../escape"],
            ["op": "download", "path": "SelfTest"],
            ["op": "remove", "path": "SelfTest"],
            ["op": "list", "path": ""],
        ]
        func run(_ i: Int) {
            guard i < steps.count else { NSLog("[CloudTest] done"); return }
            c.handle(steps[i]) { v, e in
                NSLog("[CloudTest] %@ → %@", "\(steps[i]["op"]!) \(steps[i]["path"] ?? steps[i]["from"] ?? "")",
                      e.map { "ERR " + $0 } ?? String(describing: v ?? [:]))
                run(i + 1)
            }
        }
        run(0)
    }
    #endif
}
