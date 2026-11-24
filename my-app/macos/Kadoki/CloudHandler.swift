import Foundation
import WebKit

/// Mac face of KadokiCloud (iCloud Drive library) — the same {op, ...}
/// contract as the iOS KadokiCloud plugin. Events go out through
/// KadokiEvents as plugin "KadokiCloud".
final class CloudHandler: NSObject, WKScriptMessageHandlerWithReply {
    override init() {
        super.init()
        KadokiCloud.shared.onEvent = { name, payload in
            KadokiEvents.push?("KadokiCloud", name, payload)
        }
        #if DEBUG
        if ProcessInfo.processInfo.environment["KADOKI_CLOUD_SELFTEST"] == "1" { KadokiCloud.shared.selfTest() }
        #endif
    }


    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            replyHandler(nil, "bad request"); return
        }
        KadokiCloud.shared.handle(req) { value, err in
            DispatchQueue.main.async { replyHandler(value, err) }
        }
    }
}
