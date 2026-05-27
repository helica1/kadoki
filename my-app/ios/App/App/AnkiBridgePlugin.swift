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

        let mediaFolder = resolveMediaFolder()
        let mediaLinked = mediaFolder != nil

        var savedAudioRefs:   [String] = []
        var savedPictureRefs: [String] = []
        var fieldAppends: [String: String] = [:]

        for m in audioArr {
            if let stored = storeMedia(m, into: mediaFolder) {
                savedAudioRefs.append(stored.filename)
                if let f = m["field"] as? String, !f.isEmpty {
                    var existing = fieldAppends[f] ?? ""
                    if !existing.isEmpty { existing += " " }
                    existing += "[sound:\(stored.filename)]"
                    fieldAppends[f] = existing
                }
            }
        }
        for m in pictureArr {
            if let stored = storeMedia(m, into: mediaFolder) {
                savedPictureRefs.append(stored.filename)
                if let f = m["field"] as? String, !f.isEmpty {
                    var existing = fieldAppends[f] ?? ""
                    if !existing.isEmpty { existing += " " }
                    existing += "<img src=\"\(stored.filename)\">"
                    fieldAppends[f] = existing
                }
            }
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
        for raw in tagsArr {
            if let s = raw as? String, !s.isEmpty {
                items.append(URLQueryItem(name: "tag", value: s))
            }
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
        NSLog("[AnkiBridge] open: \(url.absoluteString.prefix(160))")

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok {
                    var info: [String: Any] = [
                        "noteId":            -1,
                        "audioFilenames":    savedAudioRefs,
                        "pictureFilenames":  savedPictureRefs,
                        "mediaFolderLinked": mediaLinked
                    ]
                    if !mediaLinked && (!savedAudioRefs.isEmpty || !savedPictureRefs.isEmpty) {
                        info["mediaWarning"] = "Media not delivered — link AnkiMobile's media folder in Preferences for zero-tap audio."
                    }
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

    /// Write base64-decoded bytes to `folder` if non-nil (with security-scoped
    /// access), else to a temp directory. Returns the final filename.
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
