import Foundation
import WebKit

/// Forwards AnkiConnect JSON payloads from the web layer to the local
/// AnkiConnect server (Anki desktop add-on, port 8765). Doing this natively
/// sidesteps CORS entirely — no webCorsOriginList configuration needed.
final class AnkiConnectProxy: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String, let bodyData = body.data(using: .utf8) else {
            replyHandler(nil, "bad request body")
            return
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8765")!)
        req.httpMethod = "POST"
        req.httpBody = bodyData
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { data, _, error in
            DispatchQueue.main.async {
                if let error = error {
                    replyHandler(nil, error.localizedDescription)
                } else if let data = data, let text = String(data: data, encoding: .utf8) {
                    replyHandler(text, nil)
                } else {
                    replyHandler(nil, "empty response")
                }
            }
        }.resume()
    }
}
