import SwiftUI
import UIKit
import WebKit

#if os(iOS)
/// Native iOS menu for the web toolbar's hamburger (#shellMoreBtn).
///
/// iOS only presents a UIMenu from a control the user taps, so a transparent
/// UIButton sits exactly over the web button (native-menu.js reports where it
/// is and whether it is the top-most element there). The web button still
/// draws the icon and the red "new AI data" dot underneath.
///
/// The menu is built fresh on every open from window.__kadokiMenuModel() — the
/// same rows the web menu draws (shell.js shellMenuEntries) — and a pick runs
/// window.__kadokiMenuSelect(id).
final class KadokiNativeMenu: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let button = UIButton(type: .custom)

    /// Flag the page before any script runs so native-menu.js arms itself.
    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_MENU=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in host: UIView, webView: WKWebView) {
        self.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativeMenu")
        button.isHidden = true
        button.backgroundColor = .clear
        button.accessibilityLabel = NSLocalizedString("Menu", comment: "hamburger menu")
        button.showsMenuAsPrimaryAction = true
        button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            self?.loadMenu(completion) ?? completion([])
        }])
        host.addSubview(button)
    }

    // Anchor report: {visible, x, y, w, h} in web CSS px (= points in the web view).
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let wv = webView, let host = button.superview else { return }
        let visible = (d["visible"] as? Bool) ?? false
        guard visible, let x = d["x"] as? Double, let y = d["y"] as? Double,
              let w = d["w"] as? Double, let h = d["h"] as? Double else {
            button.isHidden = true
            return
        }
        let inWeb = CGRect(x: x, y: y, width: w, height: h)
        button.frame = wv.convert(inWeb, to: host)
        host.bringSubviewToFront(button)
        button.isHidden = false
    }

    private func loadMenu(_ completion: @escaping ([UIMenuElement]) -> Void) {
        guard let wv = webView else { completion([]); return }
        wv.callAsyncJavaScript("return await window.__kadokiMenuModel()", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, case .success(let v) = result, let json = v as? String,
                  let data = json.data(using: .utf8),
                  let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
                completion([]); return
            }
            completion(self.elements(rows))
        }
    }

    /// Rows flagged top go in the compact icon row at the head of the menu (a
    /// full list is taller than iOS lets a menu grow from the toolbar). The
    /// rest: dividers split them into inline sections (iOS draws separators).
    private func elements(_ rows: [[String: Any]]) -> [UIMenuElement] {
        var head: [UIMenuElement] = []
        var sections: [[UIMenuElement]] = [[]]
        for r in rows {
            if #available(iOS 16.0, *), (r["top"] as? Bool) == true {
                head.append(element(r, short: true))
                continue
            }
            if (r["divider"] as? Bool) == true {
                if !(sections.last?.isEmpty ?? true) { sections.append([]) }
                continue
            }
            sections[sections.count - 1].append(element(r))
        }
        var out: [UIMenuElement] = []
        if #available(iOS 16.0, *), !head.isEmpty {
            let row = UIMenu(options: .displayInline, children: head)
            row.preferredElementSize = .medium
            out.append(row)
        }
        return out + sections.filter { !$0.isEmpty }.map { UIMenu(options: .displayInline, children: $0) }
    }

    /// short: the compact row's labels drop the trailing "…" (no room).
    private func element(_ r: [String: Any], short: Bool = false) -> UIMenuElement {
        let id = (r["id"] as? String) ?? ""
        var label = (r["label"] as? String) ?? ""
        if short, label.hasSuffix("…") { label.removeLast() }
        let icon = (r["icon"] as? String).flatMap { $0.isEmpty ? nil : UIImage(systemName: $0) }
        if let kids = r["children"] as? [[String: Any]] {
            return UIMenu(title: label, image: icon, children: kids.map { element($0) })
        }
        let action = UIAction(title: label, image: icon) { [weak self] _ in self?.select(id) }
        var sub: [String] = []
        if let s = r["subtitle"] as? String, !s.isEmpty { sub.append(s) }
        if let b = r["badge"] as? String, !b.isEmpty { sub.append("(\(b))") }
        if !sub.isEmpty {
            if #available(iOS 16.0, *) { action.subtitle = sub.joined(separator: " ") }
            else { action.title = label + "  " + sub.joined(separator: " ") }
        }
        return action
    }

    private func select(_ id: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id]),
              let arg = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__kadokiMenuSelect(...\(arg))", completionHandler: nil)
    }
}

/// A full-screen SwiftUI layer over the web view (native Preferences and
/// Library). A child view, not a presented sheet: web alert()/confirm() and
/// file pickers present from the main view controller, which must not already
/// be presenting. When a web dialog covers the screen, the layer steps aside.
final class KadokiOverlay<Content: View> {
    private var hosting: UIHostingController<Content>?
    var isShown: Bool { hosting != nil }

    func show(_ root: Content, in vc: UIViewController) {
        guard hosting == nil else { return }
        let h = UIHostingController(rootView: root)
        vc.addChild(h)
        h.view.frame = vc.view.bounds
        h.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        h.view.transform = CGAffineTransform(translationX: 0, y: vc.view.bounds.height)
        vc.view.addSubview(h.view)
        h.didMove(toParent: vc)
        hosting = h
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.92, initialSpringVelocity: 0) {
            h.view.transform = .identity
        }
    }

    func hide() {
        guard let h = hosting else { return }
        hosting = nil
        UIView.animate(withDuration: 0.25, animations: {
            h.view.transform = CGAffineTransform(translationX: 0, y: h.view.bounds.height)
        }, completion: { _ in
            h.willMove(toParent: nil)
            h.view.removeFromSuperview()
            h.removeFromParent()
        })
    }

    /// A web dialog over the screen: fade out (and stop taking touches) until it closes.
    func setCovered(_ on: Bool) {
        UIView.animate(withDuration: 0.2) { self.hosting?.view.alpha = on ? 0 : 1 }
        hosting?.view.isUserInteractionEnabled = !on
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
#endif
