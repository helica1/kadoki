import AppKit
import WebKit

#if DEBUG
/// Debug-only automation hook (screenshots, scripted checks). Inert unless the
/// app is launched with KADOKI_DEV_DIR=<folder>; never compiled into Release.
///   <dir>/cmd.js  → run as an async JS function body; result → <dir>/out.txt
///   <dir>/size    → "w h": resize the whole window frame to w×h pt (capture it
///                   with screencapture -l; takeSnapshot misses composited layers)
/// KADOKI_AUTOPICK=<folder> answers the folder picker with that folder.
final class KadokiDevHook {
    static var autoPick: String? { ProcessInfo.processInfo.environment["KADOKI_AUTOPICK"] }

    private let dir: URL
    private weak var webView: WKWebView?
    private var timer: Timer?

    init?(webView: WKWebView) {
        guard let d = ProcessInfo.processInfo.environment["KADOKI_DEV_DIR"] else { return nil }
        dir = URL(fileURLWithPath: d, isDirectory: true)
        self.webView = webView
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        let fm = FileManager.default
        let cmd = dir.appendingPathComponent("cmd.js")
        if let js = try? String(contentsOf: cmd, encoding: .utf8) {
            try? fm.removeItem(at: cmd)
            webView?.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
                guard let self = self else { return }
                let text: String
                switch result {
                case .success(let v):
                    if JSONSerialization.isValidJSONObject(v),
                       let d = try? JSONSerialization.data(withJSONObject: v) { text = String(decoding: d, as: UTF8.self) }
                    else { text = "\(v)" }
                case .failure(let e): text = "ERR \(e)"
                }
                try? text.write(to: self.dir.appendingPathComponent("out.txt"), atomically: true, encoding: .utf8)
            }
        }
        let size = dir.appendingPathComponent("size")
        if let wh = try? String(contentsOf: size, encoding: .utf8) {
            try? fm.removeItem(at: size)
            let v = wh.split(separator: " ").compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            if v.count == 2, let win = webView?.window {
                var f = win.frame
                f.origin.y += f.size.height - v[1]
                f.size = NSSize(width: v[0], height: v[1])
                win.setFrame(f, display: true)
            }
        }
    }
}
#endif
