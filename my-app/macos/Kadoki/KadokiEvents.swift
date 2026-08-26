import Foundation

/// Native → web event push. AppDelegate installs the closure at launch; it
/// serializes the payload and dispatches into the shim's
/// window.__kadokiNativeEvent(plugin, event, payload) router.
enum KadokiEvents {
    static var push: ((_ plugin: String, _ event: String, _ payload: [String: Any]) -> Void)?
}
