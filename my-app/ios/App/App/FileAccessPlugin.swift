import Foundation
import Capacitor
import UIKit
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
        CAPPluginMethod(name: "materializeToCache",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPersistedUriPermissions", returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarksKey = "FileAccess.bookmarks.v1"
    private var pendingPickCall: CAPPluginCall?

    public override func load() {
        NSLog("[FileAccess] plugin loaded — jsName=\(jsName) methods=\(pluginMethods.count)")
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
            let picker = UIDocumentPickerViewController(
                forOpeningContentTypes: contentTypes, asCopy: false
            )
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingPickCall = call
            viewController.present(picker, animated: true)
        }
    }

    // MARK: - materializeToCache

    @objc func materializeToCache(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri") else {
            call.reject("uri required")
            return
        }
        guard let entry = findBookmark(forUri: uri) else {
            call.reject("uri not found in saved bookmarks — re-pick the file")
            return
        }
        guard let url = resolveBookmark(entry.bookmark) else {
            call.reject("Bookmark stale — re-pick the file")
            return
        }

        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }

        let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension
        let hash = stableHash(uri)
        let cacheDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("decks", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let cacheURL = cacheDir.appendingPathComponent("deck_\(hash).\(ext)")

        // Cache-hit path: cache file exists AND its mtime is >= source mtime.
        if let srcAttrs   = try? FileManager.default.attributesOfItem(atPath: url.path),
           let cacheAttrs = try? FileManager.default.attributesOfItem(atPath: cacheURL.path),
           let srcMod   = srcAttrs[.modificationDate]   as? Date,
           let cacheMod = cacheAttrs[.modificationDate] as? Date,
           cacheMod >= srcMod {
            let size = (cacheAttrs[.size] as? Int) ?? 0
            // Bump lastUsed so getPersistedUriPermissions sorting is fresh.
            touchLastUsed(uri: uri)
            call.resolve([
                "path":   cacheURL.path,
                "size":   size,
                "cached": true
            ])
            return
        }

        // Fresh copy.
        do {
            try? FileManager.default.removeItem(at: cacheURL)
            try FileManager.default.copyItem(at: url, to: cacheURL)
            let attrs = try FileManager.default.attributesOfItem(atPath: cacheURL.path)
            let size = (attrs[.size] as? Int) ?? 0
            touchLastUsed(uri: uri)
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
            return [.audio, .mp3, .mpeg4Audio,
                    UTType(filenameExtension: "m4b") ?? .audio,
                    UTType(filenameExtension: "m4a") ?? .audio]
        case "epub":
            return [UTType("org.idpf.epub-container") ?? .data,
                    UTType(filenameExtension: "epub") ?? .data]
        case "srt":
            return [UTType(filenameExtension: "srt") ?? .plainText, .text]
        case "image":
            return [.image]
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
            return
        }
        pendingPickCall = nil

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
    }
}
