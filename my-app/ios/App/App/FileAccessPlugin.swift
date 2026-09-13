import Foundation
import Capacitor
import UIKit
import AVFoundation
import UniformTypeIdentifiers

/**
 * FileAccessPlugin — iOS implementation of the cross-platform file
 * picker plugin our JS uses. The file-access npm package's iOS sources
 * are an `echo`-only stub from `cap plugin:generate`. This replaces it
 * with a real implementation registered under the same jsName ("FileAccess")
 * that JS already calls.
 *
 * JS API (matches Android):
 *   pickFileWithUri({type}) → {uri, name, available} | {cancelled:true}
 *   materializeToCache({uri}) → {path, size, cached}
 *   getPersistedUriPermissions() → {uris: [{uri, name, lastUsed}]}
 *
 * iOS specifics:
 *   - UIDocumentPickerViewController for picking
 *   - Security-scoped bookmark per picked file, persisted in UserDefaults
 *   - materialize copies the file (under scoped access) to NSTemporaryDirectory
 *   - "cached" flag set when the source's mtime is older than the cache's
 *
 * The @objc class name is FileAccessNativePlugin (distinct from the
 * stub's FileAccessPluginPlugin) so the ObjC runtime sees two separate
 * classes. jsName=FileAccess wins on the JS side.
 */
@objc(FileAccessNativePlugin)
public class FileAccessNativePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "FileAccessNativePlugin"
    public let jsName = "FileAccess"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFileWithUri",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolderTree",            returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "materializeToCache",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPersistedUriPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk",                 returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mediaTags",                 returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "localPath",                 returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarksKey = "FileAccess.bookmarks.v1"
    private var pendingPickCall: CAPPluginCall?
    // Set when the in-flight document picker is a FOLDER pick, so the shared
    // delegate routes the result to folder enumeration instead of file pick.
    private var pendingPickIsFolder = false

    // Media extensions surfaced from a folder scan (lowercase, no dot).
    private static let mediaExts: Set<String> = [
        "epub", "txt", "mp3", "m4a", "m4b", "ogg", "oga", "opus", "wav", "flac", "aac", "srt", "vtt", "ass",
        // Video titles (folder-import.js pairs them with SRTs like audiobooks).
        "mp4", "m4v", "mov", "3gp",
        // Unplayable containers, scanned ONLY so the import UI can explain
        // ("convert your mkv to mp4") instead of reporting an empty folder.
        "mkv", "avi", "wmv"
    ]

    public override func load() {
        NSLog("[FileAccess] plugin loaded — jsName=\(jsName) methods=\(pluginMethods.count)")
    }

    // MARK: - readChunk
    // Read a byte range from a real filesystem PATH (a materialized cache file)
    // as base64, so JS can stream large media (audiobooks) to Drive in bounded
    // chunks without loading the whole file. Used by drive-sync.
    @objc func readChunk(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("path is required"); return }
        let offset = call.getInt("offset") ?? 0
        let length = call.getInt("length") ?? 0
        if length <= 0 { call.reject("length must be > 0"); return }
        DispatchQueue.global(qos: .utility).async {
            let url = URL(fileURLWithPath: path)
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(max(0, offset)))
                let data = handle.readData(ofLength: length)
                call.resolve([
                    "data": data.base64EncodedString(),
                    "bytesRead": data.count
                ])
            } catch {
                call.reject("readChunk failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - pickFileWithUri

    @objc func pickFileWithUri(_ call: CAPPluginCall) {
        let type = call.getString("type") ?? "any"
        let contentTypes = contentTypesFor(type)
        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("No root view controller to present from")
                return
            }
            guard self.pendingPickCall == nil else {
                call.reject("A file or folder pick is already in progress")
                return
            }
            let picker = UIDocumentPickerViewController(
                forOpeningContentTypes: contentTypes, asCopy: false
            )
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingPickCall = call
            self.pendingPickIsFolder = false
            viewController.present(picker, animated: true)
        }
    }

    // MARK: - pickFolderTree

    /// Present a FOLDER picker, persist a security-scoped bookmark for the
    /// chosen folder, then recursively enumerate it. Returns
    /// { rootUri, rootName, files:[{uri,name,dir,relPath,ext}] }. Each file's
    /// `uri` is a synthetic `folder-child://` URI that materializeToCache
    /// resolves via the folder bookmark + relPath — so folder children flow
    /// through the exact same open/materialize path as individually-picked
    /// files, no per-file bookmark needed.
    @objc func pickFolderTree(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("No root view controller to present from")
                return
            }
            guard self.pendingPickCall == nil else {
                call.reject("A file or folder pick is already in progress")
                return
            }
            let picker = UIDocumentPickerViewController(
                forOpeningContentTypes: [UTType.folder], asCopy: false
            )
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingPickCall = call
            self.pendingPickIsFolder = true
            viewController.present(picker, animated: true)
        }
    }

    private func handlePickedFolder(_ folderURL: URL, _ call: CAPPluginCall) {
        let didStart = folderURL.startAccessingSecurityScopedResource()
        defer { if didStart { folderURL.stopAccessingSecurityScopedResource() } }

        // Persist a security-scoped bookmark for the FOLDER. Children are
        // materialized later by resolving this bookmark and appending relPath
        // (see materializeToCache's folder-child:// branch). One folder grant
        // covers every descendant — cleaner than a bookmark per file.
        let folderUri = folderURL.absoluteString
        do {
            let bm = try folderURL.bookmarkData(
                options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            addOrUpdateBookmark(uri: folderUri, name: folderURL.lastPathComponent, bookmark: bm)
        } catch {
            call.reject("Folder bookmark failed: \(error.localizedDescription)")
            return
        }

        var files: [[String: Any]] = []
        var count = 0
        if let en = FileManager.default.enumerator(
            at: folderURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) {
            for case let fileURL as URL in en {
                let isReg = (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) ?? false
                if !isReg { continue }
                let ext = fileURL.pathExtension.lowercased()
                if !Self.mediaExts.contains(ext) { continue }
                let relPath = Self.relativePath(of: fileURL, under: folderURL)
                let dir = (relPath as NSString).deletingLastPathComponent
                files.append([
                    "uri":     Self.folderChildUri(folderUri: folderUri, relPath: relPath),
                    "name":    fileURL.lastPathComponent,
                    "dir":     dir,
                    "relPath": relPath,
                    "ext":     ext
                ])
                count += 1
                if count % 10 == 0 {
                    self.notifyListeners("folderScanProgress", data: ["count": count])
                }
            }
        }

        call.resolve([
            "rootUri":  folderUri,
            "rootName": folderURL.lastPathComponent,
            "files":    files
        ])
    }

    // MARK: - materializeToCache

    /// iCloud: ensure the item at `url` is fully downloaded locally before we read
    /// it. On iPad especially, a file added on another device (or offloaded to free
    /// space) is a DATALESS placeholder — copying it yields a TRUNCATED file, and
    /// the JS .apkg ZIP reader then fails with "End of central directory not found".
    /// Triggers the download and blocks (on the plugin's background queue, NOT the
    /// main thread) until it's `.current` or the timeout elapses. Returns false on
    /// timeout. A non-iCloud (local) file returns true immediately.
    private func ensureDownloaded(_ url: URL, timeout: TimeInterval = 45) -> Bool {
        let keys: Set<URLResourceKey> = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]
        guard let vals = try? url.resourceValues(forKeys: keys),
              vals.isUbiquitousItem == true else {
            return true   // not an iCloud-managed item → already local
        }
        if vals.ubiquitousItemDownloadingStatus == .current { return true }
        do { try FileManager.default.startDownloadingUbiquitousItem(at: url) }
        catch { NSLog("[FileAccess] startDownloadingUbiquitousItem failed: \(error.localizedDescription)") }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let v = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]),
               v.ubiquitousItemDownloadingStatus == .current {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// Resolve a picked-file or folder-child:// URI to its source file and the
    /// security-scoped URL to hold open while reading it.
    private func resolveSource(_ uri: String) -> (source: URL, scope: URL)? {
        if let parsed = Self.parseFolderChildUri(uri) {
            guard let entry = findBookmark(forUri: parsed.folderUri), let folderURL = resolveBookmark(entry.bookmark) else { return nil }
            let relComps = (parsed.relPath as NSString).pathComponents
            if parsed.relPath.hasPrefix("/") || relComps.contains("..") { return nil }
            return (folderURL.appendingPathComponent(parsed.relPath), folderURL)
        }
        guard let entry = findBookmark(forUri: uri), let url = resolveBookmark(entry.bookmark) else { return nil }
        return (url, url)
    }

    /// Audio/video tags without copying the file: title, artist, album,
    /// duration (ms). Used by folder import to pair audiobooks with EPUBs.
    @objc func mediaTags(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), let r = resolveSource(uri) else { call.resolve([:]); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let didStart = r.scope.startAccessingSecurityScopedResource()
            defer { if didStart { r.scope.stopAccessingSecurityScopedResource() } }
            let asset = AVURLAsset(url: r.source)
            let sem = DispatchSemaphore(value: 0)
            asset.loadValuesAsynchronously(forKeys: ["commonMetadata", "duration"]) { sem.signal() }
            _ = sem.wait(timeout: .now() + 10)
            var out: [String: Any] = [:]
            for item in asset.commonMetadata {
                guard let key = item.commonKey?.rawValue, let v = item.stringValue, !v.isEmpty else { continue }
                if key == "title" { out["title"] = v }
                else if key == "artist" { out["artist"] = v }
                else if key == "albumName" { out["album"] = v }
            }
            let d = asset.duration
            if d.isNumeric && d.seconds.isFinite { out["durationMs"] = Int(d.seconds * 1000) }
            call.resolve(out)
        }
    }

    // MARK: - In-place library (On My iPhone ▸ Kadoki)
    //
    // Files inside the app's OWN Documents folder are used where they are:
    // no copy into the purgeable cache, no duplicate bytes, and a library the
    // user manages in the Files app. The picked-folder URI may carry an OLD
    // container UUID (dev reinstalls) — the path is rebased onto the live
    // Documents directory by its "/Documents/…" suffix, no bookmark needed.
    private static func documentsURL() -> URL {
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].standardizedFileURL
    }
    /// The live path of a file that lives under Documents, from a picked-file
    /// or folder-child:// URI; nil when the URI points outside the container.
    private static func containerLocalSource(uri: String) -> URL? {
        var base: String
        var rel = ""
        if let parsed = parseFolderChildUri(uri) {
            base = parsed.folderUri; rel = parsed.relPath
            let relComps = (rel as NSString).pathComponents
            if rel.hasPrefix("/") || relComps.contains("..") { return nil }
        } else {
            base = uri
        }
        let basePath = URL(string: base)?.path ?? base.removingPercentEncoding ?? base
        guard let r = basePath.range(of: "/Containers/Data/Application/") else { return nil }
        let afterApp = basePath[r.upperBound...]                       // "<UUID>/Documents/Library/…"
        guard let slash = afterApp.firstIndex(of: "/") else { return nil }
        let inside = String(afterApp[afterApp.index(after: slash)...])  // "Documents/Library/…"
        guard inside == "Documents" || inside.hasPrefix("Documents/") else { return nil }
        let suffix = inside == "Documents" ? "" : String(inside.dropFirst("Documents/".count))
        var url = documentsURL()
        if !suffix.isEmpty { url.appendPathComponent(suffix) }
        if !rel.isEmpty { url.appendPathComponent(rel) }
        if FileManager.default.fileExists(atPath: url.path) { return url }
        // The original was an .mkv that has since been remuxed in place → its
        // .mp4 sibling is the file now.
        if url.pathExtension.lowercased() == "mkv" {
            let mp4 = url.deletingPathExtension().appendingPathExtension("mp4")
            if FileManager.default.fileExists(atPath: mp4.path) { return mp4 }
        }
        return nil
    }
    private func resolveInPlace(_ call: CAPPluginCall, source: URL, uri: String) {
        var out = source
        let ext = source.pathExtension.lowercased()
        #if (os(visionOS) || os(iOS)) && !targetEnvironment(simulator)
        if ext == "mkv" {
            // Remux next to the original, then DROP the .mkv (user's call: the
            // library must never hold two copies of a video).
            let mp4 = source.deletingPathExtension().appendingPathExtension("mp4")
            let ok = (try? FileManager.default.attributesOfItem(atPath: mp4.path))?[.size] as? Int ?? 0
            if ok <= 65536 {
                NSLog("[FileAccess] remuxing in place: \(source.lastPathComponent)")
                var err = [CChar](repeating: 0, count: 256)
                let rc = kadoki_remux(source.path, mp4.path, &err, 256, nil, nil)
                if rc != 0 {
                    let msg = String(cString: err)
                    try? FileManager.default.removeItem(at: mp4)
                    call.reject("mkv remux failed: \(msg.isEmpty ? "code \(rc)" : msg)")
                    return
                }
            }
            try? FileManager.default.removeItem(at: source)
            out = mp4
        }
        #endif
        // Reclaim a stale cache copy made before in-place use existed.
        let cacheDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("decks", isDirectory: true)
        for cand in ["deck_\(stableHash(uri)).\(ext)", "deck_\(stableHash(uri)).mp4"] {
            let c = cacheDir.appendingPathComponent(cand)
            if FileManager.default.fileExists(atPath: c.path) { try? FileManager.default.removeItem(at: c); NSLog("[FileAccess] dropped cache copy \(cand) (file lives in Kadoki)") }
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: out.path))?[.size] as? Int ?? 0
        call.resolve(["path": out.path, "size": size, "cached": true, "inPlace": true])
    }

    /// {path} when the URI's file lives inside the app's Documents folder
    /// (used in place — and any stale cache copy is dropped), else {}.
    /// Never copies anything: safe to call for every attachment at boot.
    @objc func localPath(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), let local = Self.containerLocalSource(uri: uri) else { call.resolve([:]); return }
        if local.pathExtension.lowercased() == "mkv" { call.resolve([:]); return }   // needs the remux: leave it to materialize on open
        let ext = local.pathExtension.lowercased()
        let cacheDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("decks", isDirectory: true)
        for cand in ["deck_\(stableHash(uri)).\(ext)", "deck_\(stableHash(uri)).mp4"] {
            let c = cacheDir.appendingPathComponent(cand)
            if FileManager.default.fileExists(atPath: c.path) { try? FileManager.default.removeItem(at: c); NSLog("[FileAccess] dropped cache copy \(cand) (file lives in Kadoki)") }
        }
        call.resolve(["path": local.path])
    }

    @objc func materializeToCache(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri") else {
            call.reject("uri required")
            return
        }
        if let local = Self.containerLocalSource(uri: uri) {
            resolveInPlace(call, source: local, uri: uri)
            return
        }

        // Resolve the URI to a concrete source file plus the security-scoped
        // URL we must hold open while copying. For a normally-picked file these
        // are the same. For a folder-child:// URI, the scope is the FOLDER
        // bookmark and the source is folderURL + relPath.
        let sourceURL: URL
        let scopeURL: URL
        let touchUri: String      // which bookmark-store entry to keep fresh
        if let parsed = Self.parseFolderChildUri(uri) {
            guard let entry = findBookmark(forUri: parsed.folderUri) else {
                call.reject("Folder not found in saved bookmarks — re-import the folder")
                return
            }
            guard let folderURL = resolveBookmark(entry.bookmark) else {
                call.reject("Folder bookmark stale — re-import the folder")
                return
            }
            scopeURL  = folderURL
            sourceURL = folderURL.appendingPathComponent(parsed.relPath)
            touchUri  = parsed.folderUri
            // Path-traversal guard: reject a crafted relPath that would climb
            // out of the granted folder (e.g. "../../etc/..."). Check the
            // relPath LEXICALLY — comparing standardizedFileURL paths here was
            // unreliable: this runs BEFORE startAccessingSecurityScopedResource,
            // and standardizedFileURL resolves symlinks (e.g. /var -> /private/var)
            // only for paths it can stat, so after a cold relaunch the folder
            // and child standardized asymmetrically and this guard spuriously
            // tripped for folder-imported titles ("Resolved path escapes the
            // imported folder"). relPath is always folder-relative by
            // construction, so a lexical ".."/absolute check is the real intent.
            let relComps = (parsed.relPath as NSString).pathComponents
            if parsed.relPath.hasPrefix("/") || relComps.contains("..") {
                call.reject("Resolved path escapes the imported folder")
                return
            }
        } else {
            guard let entry = findBookmark(forUri: uri) else {
                call.reject("uri not found in saved bookmarks — re-pick the file")
                return
            }
            guard let url = resolveBookmark(entry.bookmark) else {
                call.reject("Bookmark stale — re-pick the file")
                return
            }
            scopeURL  = url
            sourceURL = url
            touchUri  = uri
        }

        let didStart = scopeURL.startAccessingSecurityScopedResource()
        defer { if didStart { scopeURL.stopAccessingSecurityScopedResource() } }

        // iCloud: the source may be a DATALESS placeholder (offloaded, or added on
        // another device — common on iPad). Download it BEFORE copying, or the
        // cache ends up truncated and the .apkg ZIP read fails with "End of central
        // directory not found". No-op for a normal local file.
        if !ensureDownloaded(sourceURL) {
            call.reject("iCloud download didn't finish — open the file once in the Files app to download it, then try again")
            return
        }

        let ext = sourceURL.pathExtension.isEmpty ? "bin" : sourceURL.pathExtension
        let hash = stableHash(uri)
        let cacheDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("decks", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        // mkv: AVFoundation can't open the Matroska container, but the H.264/
        // HEVC + AAC/AC3 streams inside play fine — materialize as a LOSSLESS
        // remux into mp4 (kadoki_remux, the embedded minimal libavformat)
        // instead of a byte copy. visionOS only (the static lib is xros-only).
        #if (os(visionOS) || os(iOS)) && !targetEnvironment(simulator)
        let remuxMkv = ext.lowercased() == "mkv"   // libkadokiremux is a device-only build (xros + iphoneos)
        #else
        let remuxMkv = false
        #endif
        let cacheURL = cacheDir.appendingPathComponent("deck_\(hash).\(remuxMkv ? "mp4" : ext)")

        // Cache-hit path: cache file exists AND its mtime is >= source mtime.
        if let srcAttrs   = try? FileManager.default.attributesOfItem(atPath: sourceURL.path),
           let cacheAttrs = try? FileManager.default.attributesOfItem(atPath: cacheURL.path),
           let srcMod   = srcAttrs[.modificationDate]   as? Date,
           let cacheMod = cacheAttrs[.modificationDate] as? Date,
           let srcSize  = srcAttrs[.size] as? Int,
           let cacheSize = cacheAttrs[.size] as? Int,
           cacheMod >= srcMod,
           // size match rejects a TRUNCATED cache from a prior dataless
           // (placeholder) copy. A remuxed cache legitimately differs in size
           // from its source — sanity-check non-trivial instead.
           (remuxMkv ? cacheSize > 65536 : cacheSize == srcSize) {
            let size = cacheSize
            // Bump lastUsed so getPersistedUriPermissions sorting is fresh.
            touchLastUsed(uri: touchUri)
            call.resolve([
                "path":   cacheURL.path,
                "size":   size,
                "cached": true
            ])
            return
        }

        // Fresh copy (or remux).
        do {
            try? FileManager.default.removeItem(at: cacheURL)
            if remuxMkv {
                #if (os(visionOS) || os(iOS)) && !targetEnvironment(simulator)
                NSLog("[FileAccess] remuxing mkv → mp4: \(sourceURL.lastPathComponent)")
                var err = [CChar](repeating: 0, count: 256)
                let rc = kadoki_remux(sourceURL.path, cacheURL.path, &err, 256, nil, nil)
                if rc != 0 {
                    let msg = String(cString: err)
                    try? FileManager.default.removeItem(at: cacheURL)
                    call.reject("mkv remux failed: \(msg.isEmpty ? "code \(rc)" : msg)")
                    return
                }
                #endif
            } else {
                try FileManager.default.copyItem(at: sourceURL, to: cacheURL)
            }
            let attrs = try FileManager.default.attributesOfItem(atPath: cacheURL.path)
            let size = (attrs[.size] as? Int) ?? 0
            touchLastUsed(uri: touchUri)
            NSLog("[FileAccess] materialized \(cacheURL.lastPathComponent) size=\(size)")
            call.resolve([
                "path":   cacheURL.path,
                "size":   size,
                "cached": false
            ])
        } catch {
            call.reject("Copy to cache failed: \(error.localizedDescription)")
        }
    }

    // MARK: - getPersistedUriPermissions

    @objc func getPersistedUriPermissions(_ call: CAPPluginCall) {
        // Match the Android plugin's contract: { uris: [String, ...] }.
        // The JS-side caller (app.js autoRestoreFromTitles) does
        // `uris.includes(savedUri)`, which only works on a flat string
        // array. Returning the richer {uri,name,lastUsed} objects we used
        // to expose silently broke recall on iOS.
        let bookmarks = loadBookmarks()
        let uris: [String] = bookmarks.map { $0.uri }
        call.resolve(["uris": uris])
    }

    // MARK: - bookmark store

    private struct BookmarkEntry {
        let uri: String
        let name: String
        let bookmark: Data
        var lastUsed: Int64
    }

    private func loadBookmarks() -> [BookmarkEntry] {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarksKey),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return array.compactMap { d in
            guard let uri   = d["uri"]   as? String,
                  let name  = d["name"]  as? String,
                  let bmStr = d["bookmark"] as? String,
                  let bm    = Data(base64Encoded: bmStr) else { return nil }
            let lu = (d["lastUsed"] as? NSNumber)?.int64Value ?? 0
            return BookmarkEntry(uri: uri, name: name, bookmark: bm, lastUsed: lu)
        }
    }

    private func saveBookmarks(_ entries: [BookmarkEntry]) {
        let array: [[String: Any]] = entries.map { e in
            [
                "uri":      e.uri,
                "name":     e.name,
                "bookmark": e.bookmark.base64EncodedString(),
                "lastUsed": e.lastUsed
            ]
        }
        if let data = try? JSONSerialization.data(withJSONObject: array) {
            UserDefaults.standard.set(data, forKey: Self.bookmarksKey)
        }
    }

    private func findBookmark(forUri uri: String) -> BookmarkEntry? {
        return loadBookmarks().first { $0.uri == uri }
    }

    private func addOrUpdateBookmark(uri: String, name: String, bookmark: Data) {
        var entries = loadBookmarks().filter { $0.uri != uri }
        entries.append(BookmarkEntry(
            uri: uri, name: name, bookmark: bookmark,
            lastUsed: Int64(Date().timeIntervalSince1970 * 1000)
        ))
        saveBookmarks(entries)
    }

    private func touchLastUsed(uri: String) {
        var entries = loadBookmarks()
        if let idx = entries.firstIndex(where: { $0.uri == uri }) {
            entries[idx].lastUsed = Int64(Date().timeIntervalSince1970 * 1000)
            saveBookmarks(entries)
        }
    }

    private func resolveBookmark(_ data: Data) -> URL? {
        var isStale = false
        guard let url = try? URL(
            resolvingBookmarkData: data, options: [],
            relativeTo: nil, bookmarkDataIsStale: &isStale
        ) else { return nil }
        return url
    }

    // MARK: - helpers

    /// Stable, short, filename-safe hash. djb2.
    private func stableHash(_ s: String) -> String {
        var h: UInt32 = 5381
        for b in s.utf8 { h = (h &<< 5) &+ h &+ UInt32(b) }
        return String(format: "%08x", h)
    }

    /// Map JS "type" hints to UTTypes for the document picker.
    private func contentTypesFor(_ type: String) -> [UTType] {
        switch type.lowercased() {
        case "audio":
            // Movie types included: a video file can stand as the audiobook
            // attachment (video Titles — audio plays everywhere, the picture
            // shows on visionOS).
            return [.audio, .mp3, .mpeg4Audio,
                    UTType(filenameExtension: "m4b") ?? .audio,
                    UTType(filenameExtension: "m4a") ?? .audio,
                    .movie, .mpeg4Movie, .quickTimeMovie,
                    UTType(filenameExtension: "m4v") ?? .movie]
        case "epub":
            return [UTType("org.idpf.epub-container") ?? .data,
                    UTType(filenameExtension: "epub") ?? .data,
                    UTType(filenameExtension: "txt") ?? .plainText,
                    .plainText]   // .txt plain-text books
        case "srt":
            return [UTType(filenameExtension: "srt") ?? .plainText, .text]
        case "image":
            return [.image]
        case "font":
            return [UTType("public.font") ?? .data,
                    UTType("public.truetype-ttf-font") ?? .data,
                    UTType("public.opentype-font") ?? .data,
                    UTType("com.apple.truetype-datafork-suitcase-font") ?? .data, // .ttc
                    UTType(filenameExtension: "ttf") ?? .data,
                    UTType(filenameExtension: "otf") ?? .data,
                    UTType(filenameExtension: "ttc") ?? .data,
                    UTType(filenameExtension: "woff") ?? .data,
                    UTType(filenameExtension: "woff2") ?? .data]
        case "anki", "deck", "apkg":
            return [UTType(filenameExtension: "apkg") ?? .data, .data, .item]
        default:
            return [.data, .item]
        }
    }
}

// MARK: - UIDocumentPickerDelegate

extension FileAccessNativePlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController,
                                didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, let call = pendingPickCall else {
            pendingPickCall = nil
            pendingPickIsFolder = false
            return
        }
        pendingPickCall = nil
        let isFolder = pendingPickIsFolder
        pendingPickIsFolder = false

        if isFolder {
            handlePickedFolder(url, call)
            return
        }

        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }
        do {
            let bm = try url.bookmarkData(
                options: [], includingResourceValuesForKeys: nil, relativeTo: nil
            )
            let uri  = url.absoluteString
            let name = url.lastPathComponent
            addOrUpdateBookmark(uri: uri, name: name, bookmark: bm)
            call.resolve([
                "uri":       uri,
                "name":      name,
                "available": true
            ])
        } catch {
            call.reject("Bookmark failed: \(error.localizedDescription)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingPickCall?.resolve(["cancelled": true])
        pendingPickCall = nil
        pendingPickIsFolder = false
    }
}

// MARK: - folder-child URI helpers

extension FileAccessNativePlugin {
    /// Relative path of `fileURL` beneath `base`, using standardized paths.
    static func relativePath(of fileURL: URL, under base: URL) -> String {
        var basePath = base.standardizedFileURL.path
        let filePath = fileURL.standardizedFileURL.path
        if !basePath.hasSuffix("/") { basePath += "/" }   // require a path-component boundary
        if filePath.hasPrefix(basePath) {
            return String(filePath.dropFirst(basePath.count))
        }
        if filePath == String(basePath.dropLast()) { return "" }
        return fileURL.lastPathComponent
    }

    /// folder-child://<base64url(folderUri)>/<base64url(relPath)>
    static func folderChildUri(folderUri: String, relPath: String) -> String {
        return "folder-child://" + b64url(folderUri) + "/" + b64url(relPath)
    }

    static func parseFolderChildUri(_ uri: String) -> (folderUri: String, relPath: String)? {
        let prefix = "folder-child://"
        guard uri.hasPrefix(prefix) else { return nil }
        let rest = String(uri.dropFirst(prefix.count))
        let parts = rest.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let folderUri = unb64url(String(parts[0])),
              let relPath   = unb64url(String(parts[1])) else { return nil }
        return (folderUri, relPath)
    }

    private static func b64url(_ s: String) -> String {
        return Data(s.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func unb64url(_ s: String) -> String? {
        var t = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t) else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
