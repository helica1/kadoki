import Foundation
import Capacitor
#if os(iOS)
import SwiftUI
import UIKit
import Translation
#endif

/**
 * Translator — Apple's on-device Translation framework for the send-to-Anki
 * dialog: free, private, no API key. iOS 18+. visionOS has no Translation
 * framework, so there (and on older iOS) status() reports available:false and
 * the JS layer (anki-translate.js) falls back to the AI backend.
 *
 * JS: Translator.status({ source, target })         → { available, status: "installed" | "supported" | "unsupported" }
 *     Translator.translate({ text, source, target }) → { text }
 * Languages are BCP-47 identifiers; defaults ja → en.
 */
@objc(TranslatorPlugin)
public class TranslatorPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TranslatorPlugin"
    public let jsName = "Translator"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
    ]

    @objc func status(_ call: CAPPluginCall) {
        #if os(iOS)
        if #available(iOS 18.0, *) {
            let (source, target) = Self.languages(call)
            Task {
                let st = await LanguageAvailability().status(from: source, to: target)
                call.resolve(["available": true, "status": AppleTranslation.statusName(st)])
            }
            return
        }
        #endif
        call.resolve(["available": false, "status": "unsupported"])
    }

    @objc func translate(_ call: CAPPluginCall) {
        let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { call.reject("Nothing to translate"); return }
        #if os(iOS)
        if #available(iOS 18.0, *) {
            let (source, target) = Self.languages(call)
            Task { @MainActor in
                do {
                    let out = try await AppleTranslation.translate(text, from: source, to: target,
                                                                   host: self.bridge?.viewController)
                    call.resolve(["text": out])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
            return
        }
        #endif
        call.reject("Apple Translation is not available on this device")
    }

    #if os(iOS)
    @available(iOS 18.0, *)
    private static func languages(_ call: CAPPluginCall) -> (Locale.Language, Locale.Language) {
        (Locale.Language(identifier: call.getString("source") ?? "ja"),
         Locale.Language(identifier: call.getString("target") ?? "en"))
    }
    #endif
}

#if os(iOS)
@available(iOS 18.0, *)
@MainActor
enum AppleTranslation {

    nonisolated static func statusName(_ s: LanguageAvailability.Status) -> String {
        switch s {
        case .installed: return "installed"
        case .supported: return "supported"
        default: return "unsupported"
        }
    }

    static func translate(_ text: String, from source: Locale.Language, to target: Locale.Language,
                          host: UIViewController?) async throws -> String {
        // Fast path (iOS 26+): the language pack is already on the device, so a
        // session can be created directly — no view, no UI.
        if #available(iOS 26.0, *) {
            if await LanguageAvailability().status(from: source, to: target) == .installed {
                let session = TranslationSession(installedSource: source, target: target)
                return try await session.translate(text).targetText
            }
        }
        // Otherwise a session only comes from SwiftUI's .translationTask, which
        // also lets the system offer to download the language pack on first use.
        guard let host = host else { throw AppleTranslationError.noHost }
        return try await hosted(text, source, target, host)
    }

    private static func hosted(_ text: String, _ source: Locale.Language, _ target: Locale.Language,
                               _ host: UIViewController) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            var controller: UIHostingController<TranslationHostView>?
            var finished = false
            let finish: (Result<String, Error>) -> Void = { result in
                guard !finished else { return }
                finished = true
                if let c = controller {
                    c.willMove(toParent: nil)
                    c.view.removeFromSuperview()
                    c.removeFromParent()
                }
                controller = nil
                cont.resume(with: result)
            }
            let view = TranslationHostView(configuration: .init(source: source, target: target), text: text) { result in
                DispatchQueue.main.async { finish(result) }
            }
            let c = UIHostingController(rootView: view)
            c.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
            c.view.backgroundColor = .clear
            c.view.isUserInteractionEnabled = false
            host.addChild(c)
            host.view.addSubview(c.view)
            c.didMove(toParent: host)
            controller = c
            // A dismissed download prompt throws on its own; this only guards a
            // task that never starts, so JS can fall back instead of hanging.
            DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
                finish(.failure(AppleTranslationError.timedOut))
            }
        }
    }
}

@available(iOS 18.0, *)
struct TranslationHostView: View {
    let configuration: TranslationSession.Configuration
    let text: String
    let done: (Result<String, Error>) -> Void

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .translationTask(configuration) { session in
                do {
                    let response = try await session.translate(text)
                    done(.success(response.targetText))
                } catch {
                    done(.failure(error))
                }
            }
    }
}

enum AppleTranslationError: LocalizedError {
    case noHost, timedOut
    var errorDescription: String? {
        switch self {
        case .noHost: return "Apple Translation could not start"
        case .timedOut: return "Apple Translation did not respond"
        }
    }
}
#endif
