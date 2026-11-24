import Foundation
import Capacitor

/// Capacitor face of KadokiCloud (iCloud Drive library). One method, `op`,
/// carrying {op, ...} — the same request the Mac's kadokiCloud handler takes,
/// so www/icloud.js talks to both identically. Events: "change", "account".
@objc(KadokiCloudPlugin)
public class KadokiCloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KadokiCloudPlugin"
    public let jsName = "KadokiCloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "op", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        KadokiCloud.shared.onEvent = { [weak self] name, payload in
            self?.notifyListeners(name, data: payload)
        }
        #if DEBUG
        if ProcessInfo.processInfo.environment["KADOKI_CLOUD_SELFTEST"] == "1" { KadokiCloud.shared.selfTest() }
        #endif
    }

    @objc func op(_ call: CAPPluginCall) {
        KadokiCloud.shared.handle(call.options as? [String: Any] ?? [:]) { value, err in
            if let err = err { call.reject(err) } else { call.resolve(value ?? [:]) }
        }
    }
}
