import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/**
 * AnkiBridgePlugin — iOS port via AnkiMobile URL scheme + bookmarked
 * media folder for zero-tap media delivery.
 *
 * Flow:
 *   1) ONE-TIME setup: user calls linkMediaFolder() which presents the
 *      iOS document picker. User navigates to AnkiMobile's
 *      collection.media folder (in Files → On My iPhone → AnkiMobile)
 *      and taps Open. We store a security-scoped bookmark.
 *   2) EVERY SEND: addNote() writes audio/image bytes directly into
 *      that folder, embeds [sound:filename] / <img src=filename> in
 *      the corresponding field, then opens anki://x-callback-url/addnote.
 *      AnkiMobile receives the URL, creates the note with the media
 *      references, and finds the files in its own media folder. No
 *      Share Sheet, no extra tap.
 *
 * If no folder is linked, media still gets written (to temp) and the
 * URL scheme send still fires, but AnkiMobile won't find the files —
 * Preferences should prompt the user to link the folder.
 *
 * JS API extensions over the Android plugin:
 *   linkMediaFolder()       → { linked: bool, path?, name?, cancelled? }
 *   unlinkMediaFolder()     → { linked: false }
 *   getMediaFolderStatus()  → { linked: bool, path?, name? }
 *
 * Reference: https://docs.ankimobile.net/url-schemes.html
 */
@objc(AnkiBridgePlugin)
public class AnkiBridgePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "AnkiBridgePlugin"
    public let jsName = "AnkiBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deckNames",            returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modelNames",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modelFieldNames",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addNote",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "linkMediaFolder",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlinkMediaFolder",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMediaFolderStatus", returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarkKey = "AnkiBridge.mediaFolderBookmark.v1"
    private static let lastNameKey = "AnkiBridge.mediaFolderName.v1"

    private var pendingLinkCall: CAPPluginCall?

    // Listen for the AppDelegate's URL-open notification and forward to
    // JS. Avoids the @capacitor/app dependency which isn't installed.
    public override func load() {
        super.load()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppUrlOpen(_:)),
            name: Notification.Name("AnkiBridgeAppUrlOpen"),
            object: nil
        )
        NSLog("[AnkiBridge] plugin loaded; AnkiBridgeAppUrlOpen observer attached")
    }

    @objc private func handleAppUrlOpen(_ notification: Notification) {
        let url = (notification.userInfo?["url"] as? String) ?? ""
        NSLog("[AnkiBridge] AnkiBridgeAppUrlOpen → \(url)")
        notifyListeners("ankiCallbackUrl", data: ["url": url])
    }

    // MARK: - availability + permission

    @objc func isAvailable(_ call: CAPPluginCall) {
        var result: [String: Any] = ["available": canOpenAnki()]
        if !canOpenAnki() { result["error"] = "AnkiMobile not installed" }
        call.resolve(result)
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        // iOS URL schemes don't need runtime permission.
        call.resolve(["granted": canOpenAnki()])
    }

    // MARK: - introspection stubs

    @objc func deckNames(_ call: CAPPluginCall)        { call.resolve(["decks":  [String]()]) }
    @objc func modelNames(_ call: CAPPluginCall)       { call.resolve(["models": [String]()]) }
    @objc func modelFieldNames(_ call: CAPPluginCall)  { call.resolve(["fields": [String]()]) }

    // MARK: - media folder linking

    @objc func linkMediaFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("Cannot present document picker — no root view controller")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingLinkCall = call
            // .keepInPresentingApp: true would block the picker from returning
            // to AnkiMobile; we want it to come back to OUR app.
            viewController.present(picker, animated: true)
        }
    }

    @objc func unlinkMediaFolder(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
        UserDefaults.standard.removeObject(forKey: Self.lastNameKey)
        call.resolve(["linked": false])
    }

    @objc func getMediaFolderStatus(_ call: CAPPluginCall) {
        if let url = resolveMediaFolder() {
            call.resolve([
                "linked": true,
                "path":   url.path,
                "name":   url.lastPathComponent
            ])
        } else {
            let savedName = UserDefaults.standard.string(forKey: Self.lastNameKey)
            var ret: [String: Any] = ["linked": false]
            if let name = savedName { ret["lastName"] = name }
            call.resolve(ret)
        }
    }

    // MARK: - addNote

    @objc func addNote(_ call: CAPPluginCall) {
        guard canOpenAnki() else {
            call.reject("AnkiMobile not installed. Buy + install from the App Store to send cards.")
            return
        }
        guard let deckName = call.getString("deckName"), !deckName.isEmpty,
              let modelName = call.getString("modelName"), !modelName.isEmpty else {
            call.reject("deckName and modelName required")
            return
        }

        let fieldsObj  = call.getObject("fields") ?? JSObject()
        let tagsArr    = call.getArray("tags") ?? JSArray()
        let audioArr   = mediaArrayParam(call, key: "audio")
        let pictureArr = mediaArrayParam(call, key: "picture")

        // Primary media delivery: embedded HTTP server on 127.0.0.1. Manatan's
        // decoded approach (see reference-manatan-ios-strategy memory). Each
        // media blob gets written to NSTemporaryDirectory, then exposed via
        // http://127.0.0.1:<port>/<filename> for AnkiMobile to fetch.
        // The bookmarked-media-folder path is kept as a fallback for users
        // who already set it up — server first, folder write second.
        AnkiMediaServer.shared.sweepOldFiles()
        let serverStarted = AnkiMediaServer.shared.start()
        let mediaFolder   = resolveMediaFolder()
        let mediaLinked   = mediaFolder != nil

        var savedAudioRefs:   [String] = []
        var savedPictureRefs: [String] = []
        // Per-field appends. Two kinds:
        //   urlAppends:  HTTP URL string → goes straight into the field value
        //                so AnkiMobile fetches via loopback.
        //   refAppends:  classic [sound:filename] / <img src=...> string →
        //                requires AnkiMobile to find the file in its media
        //                folder. Used only if we couldn't serve via HTTP.
        var urlAppends: [String: String] = [:]
        var refAppends: [String: String] = [:]

        for m in audioArr {
            guard let stored = decodeAndServe(m, kind: .audio, useServer: serverStarted, fallbackFolder: mediaFolder) else { continue }
            savedAudioRefs.append(stored.filename)
            guard let f = m["field"] as? String, !f.isEmpty else { continue }
            if let urlStr = stored.httpURL {
                // For the URL path we DON'T wrap in [sound:]; AnkiMobile
                // recognizes a bare http://… in the audio field and
                // downloads + plays the file. (Same as Manatan's pattern.)
                if urlAppends[f] == nil { urlAppends[f] = urlStr }
                else { urlAppends[f]! += " " + urlStr }
            } else {
                if refAppends[f] == nil { refAppends[f] = "[sound:\(stored.filename)]" }
                else { refAppends[f]! += " [sound:\(stored.filename)]" }
            }
        }
        for m in pictureArr {
            guard let stored = decodeAndServe(m, kind: .picture, useServer: serverStarted, fallbackFolder: mediaFolder) else { continue }
            savedPictureRefs.append(stored.filename)
            guard let f = m["field"] as? String, !f.isEmpty else { continue }
            if let urlStr = stored.httpURL {
                // Bare URL — AnkiMobile fetches it and rewrites the field
                // to <img src="local-filename"> automatically. Wrapping it
                // ourselves in <img> made AnkiMobile treat the URL as plain
                // HTML to store, which left the card with a broken-image
                // icon pointing at our (long-since-shut-down) loopback URL.
                if urlAppends[f] == nil { urlAppends[f] = urlStr }
                else { urlAppends[f]! += " " + urlStr }
            } else {
                let tag = "<img src=\"\(stored.filename)\">"
                if refAppends[f] == nil { refAppends[f] = tag }
                else { refAppends[f]! += " " + tag }
            }
        }
        // Merge the two: URL appends take precedence; ref appends only kick
        // in if there's no URL version for that field.
        var fieldAppends: [String: String] = urlAppends
        for (k, v) in refAppends where fieldAppends[k] == nil {
            fieldAppends[k] = v
        }

        var components = URLComponents()
        components.scheme = "anki"
        components.host = "x-callback-url"
        components.path = "/addnote"
        var items: [URLQueryItem] = [
            URLQueryItem(name: "type", value: modelName),
            URLQueryItem(name: "deck", value: deckName),
        ]
        for (key, value) in fieldsObj {
            var v = anyToString(value)
            if let extra = fieldAppends[key], !extra.isEmpty {
                if !v.isEmpty { v += " " }
                v += extra
            }
            items.append(URLQueryItem(name: "fld\(key)", value: v))
        }
        for (key, val) in fieldAppends where fieldsObj[key] == nil {
            items.append(URLQueryItem(name: "fld\(key)", value: val))
        }
        // AnkiMobile's URL scheme expects a SINGLE `tags=` parameter with
        // space-separated values (not multiple `tag=` params — that raises
        // "Unknown argument tag"). Same convention as anki:// docs.
        let tagStrings = tagsArr.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }
                                .filter { !$0.isEmpty }
        if !tagStrings.isEmpty {
            items.append(URLQueryItem(name: "tags", value: tagStrings.joined(separator: " ")))
        }
        // x-callback-url success/error: AnkiMobile opens these after
        // creating the note (or failing). Pointing at our own URL
        // scheme produces the "flash to Anki, flash back" UX —
        // user momentarily sees AnkiMobile then returns automatically.
        items.append(URLQueryItem(name: "x-success", value: "ankideckreader://anki-success"))
        items.append(URLQueryItem(name: "x-error",   value: "ankideckreader://anki-error"))
        components.queryItems = items

        guard let url = components.url else {
            call.reject("Failed to construct anki:// URL")
            return
        }
        // Log payload summary before the server health check so we have a
        // useful breadcrumb even if the request bails out below.
        let fullURL = url.absoluteString
        let safeURL = fullURL.replacingOccurrences(of: "%", with: "%%")
        NSLog("[AnkiBridge] addNote prep: len=\(fullURL.count) url=\(safeURL)")
        NSLog("[AnkiBridge] deck=\(deckName) model=\(modelName) audioFiles=\(savedAudioRefs) picFiles=\(savedPictureRefs)")
        let fieldSummary = fieldsObj.map { "\($0.key)=\(String(describing: $0.value).prefix(40))" }.joined(separator: " | ")
        NSLog("[AnkiBridge] fields: \(fieldSummary)")

        // Health-check + open URL. Both steps need the main thread:
        //   - forceRestart() asserts main (GCDWebServer.startWithOptions
        //     internal NSAssert)
        //   - UIApplication.open is documented as main-thread only.
        // Hop once, do everything inside.
        DispatchQueue.main.async {
            let server = AnkiMediaServer.shared
            // First-pass ping. If the server is healthy we can open the URL
            // immediately. If not, attempt a forced restart and re-ping.
            // A stale listening socket on iOS doesn't surface as a stop
            // event, so isRunning may still be true while the socket is
            // dead — that's exactly the "Could not connect to server"
            // failure mode users hit after long backgrounding.
            var pingOk = server.selfPing(timeoutSeconds: 0.5)
            var didRestart = false
            if !pingOk {
                NSLog("[AnkiBridge] media server ping FAILED before send — forcing restart")
                let restarted = server.forceRestart()
                didRestart = true
                if restarted {
                    pingOk = server.selfPing(timeoutSeconds: 1.5)
                }
                NSLog("[AnkiBridge] post-restart: restarted=\(restarted) ping=\(pingOk ? 1 : 0)")
            }
            if !pingOk {
                // Server is genuinely dead. Don't hand the URL to AnkiMobile —
                // it would just time out and show its own "Could not connect"
                // message, which is what the user has been seeing. Surface a
                // clear actionable error instead.
                call.reject("Anki media server is unreachable on port \(server.port). Restart the app and try again.")
                return
            }

            NSLog("[AnkiBridge] opening URL (didRestart=\(didRestart))")
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok {
                    let info: [String: Any] = [
                        "noteId":            -1,
                        "audioFilenames":    savedAudioRefs,
                        "pictureFilenames":  savedPictureRefs,
                        "mediaFolderLinked": mediaLinked,
                        "mediaServerActive": serverStarted,
                        "mediaServerPort":   server.port,
                        "mediaServerPingOk": pingOk,
                        "mediaServerRestartedThisSend": didRestart,
                        // Echo the constructed URL back so JS-side
                        // diagnostics can show / copy it.
                        "constructedUrl":    fullURL
                    ]
                    call.resolve(info)
                } else {
                    call.reject("Failed to open AnkiMobile URL")
                }
            }
        }
    }

    // MARK: - helpers

    /// Resolve the persisted bookmark to a URL. Returns nil if no bookmark
    /// is saved or the bookmark is stale / the folder is gone.
    private func resolveMediaFolder() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var isStale = false
        do {
            let url = try URL(
                resolvingBookmarkData: data,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            if isStale {
                // Try to renew. Requires the URL to be still reachable.
                if let newBookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                    UserDefaults.standard.set(newBookmark, forKey: Self.bookmarkKey)
                }
            }
            return url
        } catch {
            NSLog("[AnkiBridge] bookmark resolve failed: \(error.localizedDescription)")
            return nil
        }
    }

    private func mediaArrayParam(_ call: CAPPluginCall, key: String) -> [[String: Any]] {
        if let arr = call.getArray(key) {
            return arr.compactMap { $0 as? [String: Any] }
        }
        if let single = call.getObject(key) {
            return [single]
        }
        return []
    }

    private struct StoredMedia { let filename: String; let path: String }
    private struct ServedMedia  { let filename: String; let httpURL: String? }

    private enum MediaKind { case audio, picture }

    /// Decode the base64 bytes of an attachment and make them available
    /// to AnkiMobile. Preferred path: write to the embedded HTTP server's
    /// temp dir and return a loopback HTTP URL (zero user setup). Fallback:
    /// write to the bookmarked AnkiMobile media folder if linked, so the
    /// classic [sound:filename] reference works. Last resort: write to
    /// our own temp dir — the filename is returned but AnkiMobile won't
    /// find the bytes.
    private func decodeAndServe(_ attachment: [String: Any],
                                 kind: MediaKind,
                                 useServer: Bool,
                                 fallbackFolder: URL?) -> ServedMedia? {
        guard let suggestedName = attachment["filename"] as? String else {
            return nil
        }
        // Two ways the JS side can provide the bytes:
        //   1) `dataBase64`: classic — JS reads the file, base64-encodes it,
        //      passes the string. Required to go through Capacitor's bridge
        //      which can mangle large transfers (and on iOS the
        //      cacheFileToDataUri fetch sometimes returns "" silently when
        //      WKWebView can't access the path).
        //   2) `srcPath`: NEW — JS just passes the absolute on-disk path
        //      (e.g. a fresh AudioSlicer output). Native reads it directly,
        //      skips the base64 round-trip. Same trick Manatan uses.
        let data: Data
        if let base64 = attachment["dataBase64"] as? String,
           let decoded = Data(base64Encoded: base64), !decoded.isEmpty {
            data = decoded
        } else if let srcPath = attachment["srcPath"] as? String,
                  let bytes = try? Data(contentsOf: URL(fileURLWithPath: srcPath)),
                  !bytes.isEmpty {
            data = bytes
            NSLog("[AnkiBridge] srcPath read OK: %d bytes from %@", bytes.count, srcPath)
        } else {
            NSLog("[AnkiBridge] media \"%@\" has neither readable dataBase64 nor srcPath — dropping", suggestedName)
            return nil
        }
        // Path 1: embedded HTTP server.
        if useServer, let served = AnkiMediaServer.shared.writeMedia(data, suggestedName: suggestedName) {
            return ServedMedia(filename: served.filename, httpURL: served.url.absoluteString)
        }
        // Path 2: bookmarked AnkiMobile media folder.
        if let folder = fallbackFolder {
            let didStart = folder.startAccessingSecurityScopedResource()
            defer { if didStart { folder.stopAccessingSecurityScopedResource() } }
            let out = folder.appendingPathComponent(suggestedName)
            if (try? data.write(to: out, options: .atomic)) != nil {
                return ServedMedia(filename: suggestedName, httpURL: nil)
            }
            NSLog("[AnkiBridge] linked-folder write failed — falling through")
        }
        // Path 3: tmp only (caller can decide what to do; usually nothing).
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("anki-outbound", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let out = dir.appendingPathComponent(suggestedName)
        if (try? data.write(to: out, options: .atomic)) != nil {
            return ServedMedia(filename: suggestedName, httpURL: nil)
        }
        return nil
    }

    /// Legacy storeMedia — kept for any future callers that want the
    /// raw write without the URL/server logic. Currently unused inside
    /// addNote (which uses decodeAndServe).
    private func storeMedia(_ attachment: [String: Any], into folder: URL?) -> StoredMedia? {
        guard let suggestedName = attachment["filename"] as? String,
              let base64        = attachment["dataBase64"] as? String,
              let data          = Data(base64Encoded: base64) else {
            return nil
        }
        if let folder = folder {
            let didStart = folder.startAccessingSecurityScopedResource()
            defer { if didStart { folder.stopAccessingSecurityScopedResource() } }
            let out = folder.appendingPathComponent(suggestedName)
            do {
                try data.write(to: out, options: .atomic)
                return StoredMedia(filename: suggestedName, path: out.path)
            } catch {
                NSLog("[AnkiBridge] write to linked folder failed: \(error.localizedDescription) — falling back to tmp")
                // fall through to tmp save
            }
        }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("anki-outbound", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let out = dir.appendingPathComponent(suggestedName)
        do {
            try data.write(to: out, options: .atomic)
            return StoredMedia(filename: suggestedName, path: out.path)
        } catch {
            NSLog("[AnkiBridge] tmp media save failed: \(error.localizedDescription)")
            return nil
        }
    }

    private func anyToString(_ v: Any) -> String {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return String(describing: v)
    }

    private func canOpenAnki() -> Bool {
        guard let url = URL(string: "anki://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }
}

// MARK: - UIDocumentPickerDelegate

extension AnkiBridgePlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, let call = pendingLinkCall else {
            pendingLinkCall = nil
            return
        }
        pendingLinkCall = nil

        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }

        do {
            let bookmarkData = try url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            UserDefaults.standard.set(bookmarkData, forKey: Self.bookmarkKey)
            UserDefaults.standard.set(url.lastPathComponent, forKey: Self.lastNameKey)
            call.resolve([
                "linked": true,
                "path":   url.path,
                "name":   url.lastPathComponent
            ])
        } catch {
            call.reject("Failed to bookmark folder: \(error.localizedDescription)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingLinkCall?.resolve(["linked": false, "cancelled": true])
        pendingLinkCall = nil
    }
}
