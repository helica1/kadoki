import AppKit
import Foundation
import WebKit
import UniformTypeIdentifiers

/// Native file operations for the web layer. Files picked here stay IN PLACE
/// (real absolute paths, no copying at import — matching the mobile lazy-import
/// contract). The scheme handler serves any granted path with Range support so
/// the web audio element can stream/seek multi-hour audiobooks efficiently.
///
/// Ops (JSON string in → JSON dictionary out):
///   pickFile   {kind|accept}                 → {path, name, size} | {canceled}
///   pickFolder {}                            → {rootPath, rootName, files:[{path,name,relPath,dir,ext,size}]} | {canceled}
///   stat       {path}                        → {exists, size}
///   readChunk  {path, offset, length}        → {data(base64), bytesRead}
///   writeChunk {path, dataBase64, append}    → {ok, size}   (restricted to the media root)
///   mediaRoot  {}                            → {path}
final class FileStoreHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = FileStoreHandler()

    private let grantedKey = "KadokiGrantedPaths"
    /// path → security-scoped bookmark. Sandboxed, a picked file or folder is
    /// reachable after relaunch only through its bookmark; each one is resolved
    /// and held open for the app's lifetime.
    private let bookmarksKey = "KadokiGrantBookmarks"
    private let exportKey = "KadokiExportFolderBookmark"
    private(set) var grantedPaths: Set<String>
    private var bookmarks: [String: Data]

    let mediaRoot: URL
    /// The user-visible folder behind Filesystem 'DOCUMENTS' (<folder>/Kadoki):
    /// exported books land in Books/ there, like Files › Kadoki › Books on iOS.
    /// Unsandboxed it is ~/Documents/Kadoki; sandboxed the user picks the parent
    /// folder once (first export) and it is kept as a bookmark.
    private(set) var documentsRoot: URL

    override init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kadoki", isDirectory: true)
            .appendingPathComponent("media", isDirectory: true)
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        self.mediaRoot = appSupport
        self.documentsRoot = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kadoki", isDirectory: true)
        self.grantedPaths = Set(UserDefaults.standard.stringArray(forKey: grantedKey) ?? [])
        self.bookmarks = (UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data]) ?? [:]
        super.init()
        for (path, data) in bookmarks { _ = openBookmark(data, savedFor: path) }
        if let data = UserDefaults.standard.data(forKey: exportKey),
           let url = openBookmark(data, savedFor: nil) {
            documentsRoot = url.appendingPathComponent("Kadoki", isDirectory: true)
        }
    }

    /// Resolve a bookmark and start accessing it (never stopped: grants last the
    /// app's lifetime). A stale bookmark is re-saved.
    @discardableResult
    private func openBookmark(_ data: Data, savedFor path: String?) -> URL? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                                 relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        _ = url.startAccessingSecurityScopedResource()
        if stale, let path = path, let fresh = try? url.bookmarkData(options: [.withSecurityScope]) {
            bookmarks[path] = fresh
            UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
        }
        return url
    }

    /// The scheme handler consults this before serving an absolute path.
    func isPathAllowed(_ path: String) -> Bool {
        let p = (KadokiSandbox.local(path) as NSString).standardizingPath
        if p.hasPrefix(mediaRoot.path) || p.hasPrefix(documentsRoot.path + "/") { return true }
        return grantedPaths.contains { p == $0 || p.hasPrefix($0 + "/") }
    }

    private func grant(_ url: URL) {
        let path = (url.path as NSString).standardizingPath
        grantedPaths.insert(path)
        UserDefaults.standard.set(Array(grantedPaths), forKey: grantedKey)
        if let data = try? url.bookmarkData(options: [.withSecurityScope]) {
            bookmarks[path] = data
            UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
        }
    }

    /// Granted paths the sandbox can't reach: saved by the pre-sandbox build,
    /// which kept bare paths with no bookmark.
    private func ungrantedLegacyPaths() -> [String] {
        guard KadokiSandbox.isSandboxed else { return [] }
        return grantedPaths.filter { p in
            bookmarks[p] == nil &&
            !bookmarks.keys.contains { p.hasPrefix($0 + "/") } &&
            !p.hasPrefix(mediaRoot.path)
        }.sorted()
    }

    /// First sandboxed launch with a migrated library: ask once for the folders
    /// its books live in (one pick covers everything beneath it).
    func promptForLegacyGrants(in window: NSWindow?) -> Bool {
        let missing = ungrantedLegacyPaths()
        guard !missing.isEmpty, !UserDefaults.standard.bool(forKey: "KadokiLegacyGrantAsked") else { return false }
        UserDefaults.standard.set(true, forKey: "KadokiLegacyGrantAsked")
        // Deepest folder that holds every missing path.
        var common = (missing[0] as NSString).deletingLastPathComponent
        for p in missing.dropFirst() {
            while !(p.hasPrefix(common + "/")) && common.count > 1 { common = (common as NSString).deletingLastPathComponent }
        }
        let alert = NSAlert()
        alert.messageText = "Allow access to your books"
        alert.informativeText = "Kadoki now runs in the Mac App Store sandbox and needs permission again for the folder that holds your books. Choose that folder (or a folder above it) in the next window."
        alert.addButton(withTitle: "Choose Folder…")
        alert.addButton(withTitle: "Not Now")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        return grantFolderInteractively(startingAt: common)
    }

    /// File › Allow Access to Folder… (and the migration prompt): one pick
    /// grants the folder and everything beneath it. Returns true on a grant.
    func grantFolderInteractively(startingAt dir: String? = nil) -> Bool {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Allow"
        panel.message = "Choose a folder that holds your books. Kadoki can then open everything inside it."
        panel.directoryURL = URL(fileURLWithPath: dir ?? KadokiSandbox.realHome, isDirectory: true)
        guard panel.runModal() == .OK, let url = panel.urls.first else { return false }
        grant(url)
        KadokiEvents.push?("FileAccess", "grantsChanged", [:])
        return true
    }

    /// Where exported books go. Sandboxed with no folder chosen yet: ask once.
    private func resolveDocumentsRoot(_ reply: @escaping (Any?, String?) -> Void) {
        guard KadokiSandbox.isSandboxed, UserDefaults.standard.data(forKey: exportKey) == nil else {
            reply(["path": documentsRoot.path], nil); return
        }
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Choose"
            panel.message = "Choose where Kadoki saves books. A Kadoki folder is made inside it."
            panel.directoryURL = URL(fileURLWithPath: KadokiSandbox.realHome + "/Documents", isDirectory: true)
            panel.begin { result in
                if result == .OK, let url = panel.urls.first,
                   let data = try? url.bookmarkData(options: [.withSecurityScope]) {
                    UserDefaults.standard.set(data, forKey: self.exportKey)
                    _ = url.startAccessingSecurityScopedResource()
                    self.documentsRoot = url.appendingPathComponent("Kadoki", isDirectory: true)
                }
                reply(["path": self.documentsRoot.path], nil)
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = req["op"] as? String else {
            replyHandler(nil, "bad request")
            return
        }
        switch op {
        case "pickFile":   pickFile(req, replyHandler)
        case "pickFolder": pickFolder(replyHandler)
        case "stat":       stat(req, replyHandler)
        case "readChunk":  readChunk(req, replyHandler)
        case "writeChunk": writeChunk(req, replyHandler)
        case "mediaRoot":  replyHandler(["path": mediaRoot.path], nil)
        case "documentsRoot": resolveDocumentsRoot(replyHandler)
        case "granted":    replyHandler(["paths": Array(grantedPaths)], nil)
        default:           replyHandler(nil, "unknown op \(op)")
        }
    }

    // MARK: - Pickers

    private func contentTypes(forKind kind: String?) -> [UTType]? {
        let exts: [String]
        switch kind {
        case "epub":  exts = ["epub", "txt", "apkg"]
        case "audio": exts = ["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "flac"]
        case "image": exts = ["png", "jpg", "jpeg", "webp", "gif"]
        default:      return nil // any file
        }
        return exts.compactMap { UTType(filenameExtension: $0) }
    }

    private func pickFile(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            if let types = self.contentTypes(forKind: req["kind"] as? String), !types.isEmpty {
                panel.allowedContentTypes = types
                panel.allowsOtherFileTypes = true
            }
            panel.begin { result in
                guard result == .OK, let url = panel.urls.first else {
                    reply(["canceled": true], nil)
                    return
                }
                self.grant(url)
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
                reply(["path": url.path, "name": url.lastPathComponent, "size": size], nil)
            }
        }
    }

    private func pickFolder(_ reply: @escaping (Any?, String?) -> Void) {
        #if DEBUG
        if let auto = KadokiDevHook.autoPick {
            DispatchQueue.main.async { self.replyFolder(URL(fileURLWithPath: auto, isDirectory: true), reply) }
            return
        }
        #endif
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.begin { result in
                guard result == .OK, let root = panel.urls.first else {
                    reply(["canceled": true], nil)
                    return
                }
                self.replyFolder(root, reply)
            }
        }
    }

    private func replyFolder(_ root: URL, _ reply: @escaping (Any?, String?) -> Void) {
        grant(root)
        var files: [[String: Any]] = []
        let fm = FileManager.default
        if let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                                  options: [.skipsHiddenFiles]) {
            for case let url as URL in en {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                let rel = String(url.path.dropFirst(root.path.count + 1))
                let dir = (rel as NSString).deletingLastPathComponent
                files.append([
                    "path": url.path,
                    "name": url.lastPathComponent,
                    "relPath": rel,
                    "dir": dir,
                    "ext": url.pathExtension.lowercased(),
                    "size": (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0,
                ])
            }
        }
        reply(["rootPath": root.path, "rootName": root.lastPathComponent, "files": files], nil)
    }

    // MARK: - IO

    private func stat(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let raw = req["path"] as? String else { reply(nil, "stat: no path"); return }
        let path = KadokiSandbox.local(raw)
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
        let size = exists ? ((try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0) : 0
        reply(["exists": exists, "size": size], nil)
    }

    private func readChunk(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let raw = req["path"] as? String,
              let offset = req["offset"] as? Int,
              let length = req["length"] as? Int else { reply(nil, "readChunk: bad args"); return }
        let path = KadokiSandbox.local(raw)
        guard isPathAllowed(path) else { reply(nil, "readChunk: path not granted"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let fh = FileHandle(forReadingAtPath: path) else {
                DispatchQueue.main.async { reply(nil, "readChunk: cannot open") }
                return
            }
            defer { try? fh.close() }
            do {
                try fh.seek(toOffset: UInt64(offset))
                let data = try fh.read(upToCount: length) ?? Data()
                DispatchQueue.main.async {
                    reply(["data": data.base64EncodedString(), "bytesRead": data.count], nil)
                }
            } catch {
                DispatchQueue.main.async { reply(nil, "readChunk: \(error.localizedDescription)") }
            }
        }
    }

    private func writeChunk(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let path = req["path"] as? String,
              let b64 = req["dataBase64"] as? String,
              let data = Data(base64Encoded: b64) else { reply(nil, "writeChunk: bad args"); return }
        let append = (req["append"] as? Bool) ?? false
        // Writes only land inside the app's media root or ~/Documents/Kadoki.
        let std = (KadokiSandbox.local(path) as NSString).standardizingPath
        guard std.hasPrefix(mediaRoot.path) || std.hasPrefix(documentsRoot.path + "/") else {
            reply(nil, "writeChunk: outside media root"); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let url = URL(fileURLWithPath: std)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if append, FileManager.default.fileExists(atPath: std) {
                    let fh = try FileHandle(forWritingTo: url)
                    defer { try? fh.close() }
                    try fh.seekToEnd()
                    try fh.write(contentsOf: data)
                } else {
                    try data.write(to: url)
                }
                let size = (try? FileManager.default.attributesOfItem(atPath: std)[.size] as? Int) ?? 0
                DispatchQueue.main.async { reply(["ok": true, "size": size], nil) }
            } catch {
                DispatchQueue.main.async { reply(nil, "writeChunk: \(error.localizedDescription)") }
            }
        }
    }
}
