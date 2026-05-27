import Foundation
import Capacitor
import UIKit

/**
 * AnkiBridgePlugin — iOS port. Talks to AnkiMobile via its
 * `anki://x-callback-url/addnote?...` URL scheme.
 *
 * iOS has no equivalent to AnkiDroid's ContentProvider, so this is a
 * fundamentally different transport than the Android plugin — but the
 * JS API surface is the same so all the JS callers in sendToAnkiConnect.js
 * and enhanced-dictionary.js work unchanged.
 *
 * Capabilities & limits vs. Android:
 *   ✓ addNote text fields
 *   ✓ tags
 *   ✗ deck / model / field introspection — AnkiMobile's URL scheme
 *     doesn't expose these. JS prefs UI falls back to free-text
 *     inputs (user types their exact deck/model/field names)
 *   ⚠ media: this round embeds [sound:filename] in the field but does
 *     NOT transfer audio/image bytes to AnkiMobile. The user has to
 *     attach media manually. A follow-up round will handle this via
 *     .apkg generation + Share Sheet (Apple's only reliable
 *     cross-app file delivery on iOS).
 *
 * Requirements:
 *   • AnkiMobile installed (one-time $25 App Store purchase)
 *   • Info.plist must list "anki" in LSApplicationQueriesSchemes so
 *     canOpenURL works on iOS 9+
 *
 * Reference: https://docs.ankimobile.net/url-schemes.html
 */
@objc(AnkiBridgePlugin)
public class AnkiBridgePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "AnkiBridgePlugin"
    public let jsName = "AnkiBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deckNames",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modelNames",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "modelFieldNames",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addNote",           returnType: CAPPluginReturnPromise),
    ]

    // MARK: - availability + permission

    @objc func isAvailable(_ call: CAPPluginCall) {
        let installed = canOpenAnki()
        var result: [String: Any] = ["available": installed]
        if !installed {
            result["error"] = "AnkiMobile not installed"
        }
        call.resolve(result)
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        // iOS URL schemes don't need runtime permission. Resolve granted
        // iff AnkiMobile is installed and reachable.
        call.resolve(["granted": canOpenAnki()])
    }

    // MARK: - introspection stubs

    /// AnkiMobile's URL scheme can't return deck/model/field metadata.
    /// JS sees empty arrays and falls back to free-text inputs in the
    /// Preferences UI (handled in preferences.js).
    @objc func deckNames(_ call: CAPPluginCall) {
        call.resolve(["decks": [String]()])
    }
    @objc func modelNames(_ call: CAPPluginCall) {
        call.resolve(["models": [String]()])
    }
    @objc func modelFieldNames(_ call: CAPPluginCall) {
        call.resolve(["fields": [String]()])
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

        let fieldsObj = call.getObject("fields") ?? JSObject()
        let tagsArr   = call.getArray("tags") ?? JSArray()
        let audioArr  = mediaArrayParam(call, key: "audio")
        let pictureArr = mediaArrayParam(call, key: "picture")

        // Persist any media bytes to the app's tmp folder. AnkiMobile
        // won't auto-discover these via the URL scheme — they're saved
        // here for a future .apkg-bundle round to pick up.
        var savedAudioRefs: [String] = []
        var savedPictureRefs: [String] = []
        var fieldAppends: [String: String] = [:]
        for m in audioArr {
            if let stored = storeMediaForLater(m) {
                savedAudioRefs.append(stored.filename)
                if let f = m["field"] as? String, !f.isEmpty {
                    fieldAppends[f, default: ""] += " [sound:\(stored.filename)]"
                }
            }
        }
        for m in pictureArr {
            if let stored = storeMediaForLater(m) {
                savedPictureRefs.append(stored.filename)
                if let f = m["field"] as? String, !f.isEmpty {
                    fieldAppends[f, default: ""] += " <img src=\"\(stored.filename)\">"
                }
            }
        }

        // Compose URL components. AnkiMobile expects field params named
        // "fld<FieldName>" with the literal field name from the model.
        var components = URLComponents()
        components.scheme = "anki"
        components.host = "x-callback-url"
        components.path = "/addnote"

        var items: [URLQueryItem] = [
            URLQueryItem(name: "type", value: modelName),
            URLQueryItem(name: "deck", value: deckName),
        ]
        for (key, value) in fieldsObj {
            var stringVal = anyToString(value)
            if let extra = fieldAppends[key], !extra.isEmpty {
                if !stringVal.isEmpty { stringVal += " " }
                stringVal += extra.trimmingCharacters(in: .whitespaces)
            }
            items.append(URLQueryItem(name: "fld\(key)", value: stringVal))
        }
        // Any field that got media tokens but didn't already exist in
        // `fields` should still be sent so AnkiMobile shows the [sound:..]
        // reference (even if it can't resolve the media yet).
        for (key, val) in fieldAppends {
            if fieldsObj[key] != nil { continue }
            items.append(URLQueryItem(name: "fld\(key)", value: val.trimmingCharacters(in: .whitespaces)))
        }
        for raw in tagsArr {
            if let s = raw as? String, !s.isEmpty {
                items.append(URLQueryItem(name: "tag", value: s))
            }
        }
        components.queryItems = items

        guard let url = components.url else {
            call.reject("Failed to construct anki:// URL")
            return
        }
        NSLog("[AnkiBridge] opening: \(url.absoluteString.prefix(160))")

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok {
                    var info: [String: Any] = [
                        "noteId": -1, // AnkiMobile doesn't return one via URL scheme
                        "audioFilenames": savedAudioRefs,
                        "pictureFilenames": savedPictureRefs
                    ]
                    if !savedAudioRefs.isEmpty || !savedPictureRefs.isEmpty {
                        info["mediaNote"] = "Media saved locally; attach in AnkiMobile manually"
                    }
                    call.resolve(info)
                } else {
                    call.reject("Failed to open AnkiMobile URL")
                }
            }
        }
    }

    // MARK: - helpers

    /// Read an array of media-attachment objects from a PluginCall. Accepts
    /// either an array (new shape: audio: [{...}, {...}]) or a single
    /// object (legacy shape: audio: {...}).
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

    /// Decode base64 bytes to the app's tmp folder. Returns the stored
    /// filename and path. Returns nil on failure (missing fields, bad
    /// base64, etc.).
    private func storeMediaForLater(_ attachment: [String: Any]) -> StoredMedia? {
        guard let suggestedName = attachment["filename"] as? String,
              let base64        = attachment["dataBase64"] as? String,
              let data          = Data(base64Encoded: base64) else {
            return nil
        }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("anki-outbound", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let out = dir.appendingPathComponent(suggestedName)
        do {
            try data.write(to: out, options: .atomic)
            return StoredMedia(filename: suggestedName, path: out.path)
        } catch {
            NSLog("[AnkiBridge] failed to save media \(suggestedName): \(error.localizedDescription)")
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
