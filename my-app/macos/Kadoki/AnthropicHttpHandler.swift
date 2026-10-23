import Foundation
import WebKit

/// Native HTTPS for api.anthropic.com (`kadokiHttp`). The Message Batches
/// endpoint rejects the browser CORS preflight (400, no allow-origin), so the
/// WKWebView's fetch fails with "Load failed" before the request is sent. On
/// iOS these calls already go through native CapacitorHttp; the Mac shell has
/// no such plugin, so ai.js uses this bridge for batch and model-list calls.
/// Restricted to api.anthropic.com — it is not a general proxy.
///
/// Request (JSON string): { url, method, headers, body? } → { status, body }.
final class AnthropicHttpHandler: NSObject, WKScriptMessageHandlerWithReply {

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 600
        return URLSession(configuration: c)
    }()

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let reply: (Any?, String?) -> Void = { v, e in DispatchQueue.main.async { replyHandler(v, e) } }
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let urlStr = req["url"] as? String, let url = URL(string: urlStr) else {
            reply(nil, "bad request"); return
        }
        guard url.scheme == "https", url.host == "api.anthropic.com" else {
            reply(nil, "host not allowed"); return
        }
        var r = URLRequest(url: url)
        r.httpMethod = (req["method"] as? String) ?? "GET"
        for (k, v) in (req["headers"] as? [String: String]) ?? [:] { r.setValue(v, forHTTPHeaderField: k) }
        if let b = req["body"] as? String { r.httpBody = b.data(using: .utf8) }
        session.dataTask(with: r) { d, resp, err in
            if let err = err { reply(nil, err.localizedDescription); return }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = d.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            reply(["status": status, "body": text], nil)
        }.resume()
    }
}
