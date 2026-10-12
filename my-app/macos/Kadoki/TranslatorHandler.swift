import AppKit
import Foundation
import SwiftUI
import Translation
import WebKit

/// Apple's on-device Translation for the send-to-Anki dialog (macOS 15+), as a
/// script message handler. Same contract as the iOS TranslatorPlugin:
///   status({source, target})          → {available, status: "installed"|"supported"|"unsupported"}
///   translate({text, source, target}) → {text}
final class TranslatorHandler: NSObject, WKScriptMessageHandlerWithReply {

    /// Where the SwiftUI .translationTask host view is attached (the web view).
    weak var hostView: NSView?

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
        let reply: (Any?, String?) -> Void = { value, err in
            DispatchQueue.main.async { replyHandler(value, err) }
        }
        let source = Locale.Language(identifier: (req["source"] as? String) ?? "ja")
        let target = Locale.Language(identifier: (req["target"] as? String) ?? "en")
        switch op {
        case "status":
            guard #available(macOS 15.0, *) else {
                reply(["available": false, "status": "unsupported"], nil)
                return
            }
            Task {
                let st = await LanguageAvailability().status(from: source, to: target)
                reply(["available": true, "status": MacAppleTranslation.statusName(st)], nil)
            }
        case "translate":
            let text = ((req["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { reply(nil, "Nothing to translate"); return }
            guard #available(macOS 15.0, *) else {
                reply(nil, "Apple Translation needs macOS 15 or later")
                return
            }
            Task { @MainActor in
                do {
                    let out = try await MacAppleTranslation.translate(text, from: source, to: target,
                                                                      host: self.hostView)
                    reply(["text": out], nil)
                } catch {
                    reply(nil, error.localizedDescription)
                }
            }
        default:
            reply(nil, "unknown op \(op)")
        }
    }
}

@available(macOS 15.0, *)
@MainActor
enum MacAppleTranslation {

    nonisolated static func statusName(_ s: LanguageAvailability.Status) -> String {
        switch s {
        case .installed: return "installed"
        case .supported: return "supported"
        default: return "unsupported"
        }
    }

    static func translate(_ text: String, from source: Locale.Language, to target: Locale.Language,
                          host: NSView?) async throws -> String {
        // Fast path (macOS 26+): the language pack is installed, so a session
        // can be created directly — no view, no UI.
        if #available(macOS 26.0, *) {
            if await LanguageAvailability().status(from: source, to: target) == .installed {
                let session = TranslationSession(installedSource: source, target: target)
                return try await session.translate(text).targetText
            }
        }
        // Otherwise a session only comes from SwiftUI's .translationTask, which
        // also lets the system offer to download the language pack.
        guard let host = host else { throw MacTranslationError.noHost }
        return try await hosted(text, source, target, host)
    }

    private static func hosted(_ text: String, _ source: Locale.Language, _ target: Locale.Language,
                               _ host: NSView) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            var hostingView: NSHostingView<MacTranslationHostView>?
            var finished = false
            let finish: (Result<String, Error>) -> Void = { result in
                guard !finished else { return }
                finished = true
                hostingView?.removeFromSuperview()
                hostingView = nil
                cont.resume(with: result)
            }
            let v = NSHostingView(rootView: MacTranslationHostView(
                configuration: .init(source: source, target: target), text: text) { result in
                    DispatchQueue.main.async { finish(result) }
                })
            v.frame = NSRect(x: 0, y: 0, width: 1, height: 1)
            host.addSubview(v)
            hostingView = v
            DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
                finish(.failure(MacTranslationError.timedOut))
            }
        }
    }
}

@available(macOS 15.0, *)
struct MacTranslationHostView: View {
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

enum MacTranslationError: LocalizedError {
    case noHost, timedOut
    var errorDescription: String? {
        switch self {
        case .noHost: return "Apple Translation could not start"
        case .timedOut: return "Apple Translation did not respond"
        }
    }
}
