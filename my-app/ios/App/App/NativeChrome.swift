import SwiftUI
import UIKit
import WebKit

#if os(iOS)
/// Native iOS menu for the web toolbar's hamburger (#shellMoreBtn).
///
/// A native button (glass on iOS 26, a gray circle before) sits over the web
/// button, which stays in place invisible (native-menu.js reports where it is
/// and whether it is the top-most element there). A red dot on it mirrors the
/// web button's "new AI data" dot.
///
/// The menu is a native panel rather than a system UIMenu (iOS fixes a menu's
/// size; this one runs the full height under the button and is wider). It is
/// built fresh on every open from window.__kadokiMenuModel() — the same rows
/// the web menu draws (shell.js shellMenuEntries) plus pinned titles — and a
/// pick runs window.__kadokiMenuSelect(id).
final class KadokiNativeMenu: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let button = UIButton(type: .system)
    private let dot = UIView()
    private var chromeHidden = false
    private var panel: UIView?
    private var panelCard: UIView?
    private static let size: CGFloat = 40

    /// Flag the page before any script runs so native-menu.js arms itself.
    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_MENU=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in host: UIView, webView: WKWebView) {
        self.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativeMenu")
        button.isHidden = true
        var cfg: UIButton.Configuration
        if #available(iOS 26.0, *) { cfg = .glass() } else { cfg = .gray() }
        cfg.image = UIImage(systemName: "line.3.horizontal", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        cfg.cornerStyle = .capsule
        cfg.baseForegroundColor = .label
        cfg.contentInsets = .zero
        button.configuration = cfg
        button.accessibilityLabel = NSLocalizedString("Menu", comment: "hamburger menu")
        button.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        dot.backgroundColor = .systemRed
        dot.layer.cornerRadius = 4.5
        dot.isUserInteractionEnabled = false
        dot.isHidden = true
        dot.frame = CGRect(x: Self.size - 11, y: 2, width: 9, height: 9)
        button.addSubview(dot)
        host.addSubview(button)
    }

    // Anchor report: {visible, x, y, w, h, dot, chrome} in web CSS px (= points in the web view).
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let wv = webView, let host = button.superview else { return }
        defer {
            if let c = d["chrome"] as? Bool, c == chromeHidden {
                chromeHidden = !c
                KadokiChromeSlide.apply([button], hidden: chromeHidden)
            }
        }
        let visible = (d["visible"] as? Bool) ?? false
        guard visible, let x = d["x"] as? Double, let y = d["y"] as? Double,
              let w = d["w"] as? Double, let h = d["h"] as? Double else {
            // Covered while open = its own pick opened a web dialog; leave the
            // panel to its dismissal, just hide the button.
            if panel == nil { button.isHidden = true }
            return
        }
        let r = wv.convert(CGRect(x: x, y: y, width: w, height: h), to: host)
        let s = Self.size
        // Centered on the web button, but never past the screen's right edge.
        let cx = min(r.midX, host.bounds.width - host.safeAreaInsets.right - 8 - s / 2)
        KadokiChromeSlide.place(button, CGRect(x: cx - s / 2, y: r.midY - s / 2, width: s, height: s))
        dot.isHidden = !((d["dot"] as? Bool) ?? false)
        if panel == nil { host.bringSubviewToFront(button) }
        button.isHidden = false
    }

    // MARK: panel

    @objc private func toggle() {
        if panel != nil { dismiss(); return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard let wv = webView else { return }
        wv.callAsyncJavaScript("return await window.__kadokiMenuModel()", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, case .success(let v) = result, let json = v as? String,
                  let data = json.data(using: .utf8),
                  let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
            self.present(rows)
        }
    }

    private func present(_ raw: [[String: Any]]) {
        guard panel == nil, let host = button.superview else { return }
        var top: [KMenuRow] = []
        var sections: [[KMenuRow]] = [[]]
        for r in raw {
            if (r["divider"] as? Bool) == true {
                if !(sections.last?.isEmpty ?? true) { sections.append([]) }
                continue
            }
            let row = Self.row(r)
            if (r["top"] as? Bool) == true { top.append(row) } else { sections[sections.count - 1].append(row) }
        }
        sections = sections.filter { !$0.isEmpty }

        // A full-screen catcher: a tap outside the card closes the menu.
        let shade = UIView(frame: host.bounds)
        shade.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        shade.backgroundColor = UIColor.black.withAlphaComponent(0.18)
        shade.alpha = 0
        shade.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(shadeTapped(_:))))

        let width = min(330, host.bounds.width - 24)
        let y0 = button.frame.maxY + 8
        let bottom = host.bounds.height - max(host.safeAreaInsets.bottom, 8) - 8
        let right = host.bounds.width - max(host.safeAreaInsets.right, 0) - 10
        let frame = CGRect(x: right - width, y: y0, width: width, height: max(240, bottom - y0))
        let view = KMenuPanel(top: top, sections: sections) { [weak self] id in self?.dismiss(then: id) }
        let hosting = UIHostingController(rootView: view)
        hosting.view.backgroundColor = .clear
        hosting.overrideUserInterfaceStyle = .dark
        let card = hosting.view!
        // Grow out of the button's corner, like a system menu.
        card.layer.anchorPoint = CGPoint(x: 1, y: 0)
        card.frame = frame
        card.transform = CGAffineTransform(scaleX: 0.35, y: 0.2)
        card.alpha = 0
        shade.addSubview(card)
        host.addSubview(shade)
        host.bringSubviewToFront(button)
        panel = shade
        panelCard = card
        objc_setAssociatedObject(shade, &Self.hostingKey, hosting, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) {
            card.transform = .identity
            card.alpha = 1
            shade.alpha = 1
        }
    }
    private static var hostingKey = 0

    @objc private func shadeTapped(_ g: UITapGestureRecognizer) {
        guard let card = panelCard else { dismiss(); return }
        if !card.frame.contains(g.location(in: g.view)) { dismiss() }
    }

    private func dismiss(then id: String? = nil) {
        guard let shade = panel, let card = panelCard else { return }
        panel = nil; panelCard = nil
        shade.isUserInteractionEnabled = false
        UIView.animate(withDuration: 0.2, animations: {
            card.transform = CGAffineTransform(scaleX: 0.6, y: 0.5)
            card.alpha = 0
            shade.alpha = 0
        }, completion: { _ in shade.removeFromSuperview() })
        if let id { select(id) }
    }

    private static func row(_ r: [String: Any]) -> KMenuRow {
        var label = (r["label"] as? String) ?? ""
        if (r["top"] as? Bool) == true, label.hasSuffix("…") { label.removeLast() }
        return KMenuRow(id: (r["id"] as? String) ?? UUID().uuidString, label: label,
                        symbol: (r["icon"] as? String) ?? "", image: thumb(r["image"] as? String),
                        subtitle: (r["subtitle"] as? String) ?? "", badge: (r["badge"] as? String) ?? "",
                        checked: (r["checked"] as? Bool) ?? false,
                        children: ((r["children"] as? [[String: Any]]) ?? []).map { row($0) })
    }

    /// A cover thumbnail (data URI) for a pinned title's row.
    private static func thumb(_ uri: String?) -> UIImage? {
        guard let uri, let comma = uri.firstIndex(of: ","),
              let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

    private func select(_ id: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id]),
              let arg = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__kadokiMenuSelect(...\(arg))", completionHandler: nil)
    }
}

struct KMenuRow: Identifiable {
    let id: String
    let label: String
    let symbol: String
    let image: UIImage?
    let subtitle: String
    let badge: String
    let checked: Bool
    let children: [KMenuRow]
}

/// The menu card: a compact icon row (Library / Stats / Preferences), then
/// the sections — pinned titles with their covers first — in a frosted,
/// rounded panel that scrolls when it needs to.
struct KMenuPanel: View {
    let top: [KMenuRow]
    let sections: [[KMenuRow]]
    let pick: (String) -> Void
    @State private var open: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            if !top.isEmpty {
                HStack(spacing: 0) {
                    ForEach(top) { r in
                        Button { pick(r.id) } label: {
                            VStack(spacing: 6) {
                                Image(systemName: r.symbol.isEmpty ? "circle" : r.symbol).font(.system(size: 21))
                                Text(r.label).font(.footnote).lineLimit(1).minimumScaleFactor(0.8)
                            }
                            .frame(maxWidth: .infinity, minHeight: 64)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(KMenuPress())
                    }
                }
                .padding(.horizontal, 6).padding(.top, 6)
                Divider().opacity(0.6)
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(sections.enumerated()), id: \.offset) { i, sec in
                        if i > 0 { Rectangle().fill(Color.black.opacity(0.35)).frame(height: 8) }
                        ForEach(sec) { r in item(r, indent: false) }
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .foregroundStyle(.primary)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
    }

    private func item(_ r: KMenuRow, indent: Bool) -> AnyView {   // AnyView: rows nest (submenus)
        AnyView(itemBody(r, indent: indent))
    }
    @ViewBuilder private func itemBody(_ r: KMenuRow, indent: Bool) -> some View {
        if r.children.isEmpty {
            Button { pick(r.id) } label: { line(r, indent: indent, expandable: false) }
                .buttonStyle(KMenuPress())
        } else {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if open.contains(r.id) { open.remove(r.id) } else { open.insert(r.id) }
                }
            } label: { line(r, indent: indent, expandable: true) }
                .buttonStyle(KMenuPress())
            if open.contains(r.id) {
                ForEach(r.children) { c in item(c, indent: true) }
            }
        }
    }

    private func line(_ r: KMenuRow, indent: Bool, expandable: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold))
                .opacity(r.checked ? 1 : 0).frame(width: 14)
            if let img = r.image {
                Image(uiImage: img).resizable().scaledToFill()
                    .frame(width: 30, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            } else if !r.symbol.isEmpty {
                Image(systemName: r.symbol).font(.system(size: 18)).frame(width: 30)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(r.label).font(.body).lineLimit(2)
                if !r.subtitle.isEmpty { Text(r.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 6)
            if !r.badge.isEmpty {
                Text(r.badge).font(.caption.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.red, in: Capsule())
            }
            if expandable {
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                    .rotationEffect(.degrees(open.contains(r.id) ? 90 : 0))
            }
        }
        .padding(.leading, indent ? 30 : 12).padding(.trailing, 16)
        .padding(.vertical, r.image == nil ? 12 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Row highlight while pressed, like a menu.
struct KMenuPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(Color.white.opacity(configuration.isPressed ? 0.12 : 0))
    }
}

/// The web header slides up and fades when the reader hides its chrome
/// (theme.css body.chrome-hidden #appHeader: translateY(-110%) over 0.22 s
/// ease, opacity over 0.18 s). The native controls laid over it run the same
/// animation themselves on the same frame, instead of chasing position
/// reports, so the whole bar moves as one.
enum KadokiChromeSlide {
    static let headerHeight: CGFloat = 48

    static func apply(_ views: [UIView], hidden: Bool) {
        let ease = (CGPoint(x: 0.25, y: 0.1), CGPoint(x: 0.25, y: 1))
        let move = UIViewPropertyAnimator(duration: 0.22, controlPoint1: ease.0, controlPoint2: ease.1) {
            for v in views { v.transform = hidden ? CGAffineTransform(translationX: 0, y: -headerHeight * 1.1) : .identity }
        }
        let fade = UIViewPropertyAnimator(duration: 0.18, controlPoint1: ease.0, controlPoint2: ease.1) {
            for v in views { v.alpha = hidden ? 0 : 1 }
        }
        move.isUserInteractionEnabled = !hidden
        fade.isUserInteractionEnabled = !hidden
        move.startAnimation()
        fade.startAnimation()
    }

    /// Place by center + size so a frame set mid-slide doesn't fight the transform.
    static func place(_ v: UIView, _ f: CGRect) {
        let c = CGPoint(x: f.midX, y: f.midY)
        if abs(v.center.x - c.x) > 0.5 || abs(v.center.y - c.y) > 0.5 { v.center = c }
        if abs(v.bounds.width - f.width) > 0.5 || abs(v.bounds.height - f.height) > 0.5 { v.bounds.size = f.size }
    }

    static func color(_ css: String?) -> UIColor {
        var s = (css ?? "").trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let n = UInt64(s, radix: 16) else { return .systemGreen }
        return UIColor(red: CGFloat((n >> 16) & 0xFF) / 255, green: CGFloat((n >> 8) & 0xFF) / 255, blue: CGFloat(n & 0xFF) / 255, alpha: 1)
    }
}

/// The toolbar's play / pause: a flat capsule in the mode accent that springs
/// when pressed. Paused it shows the play glyph; playing, a little spectrum
/// analyzer that follows the audio takes the glyph's place (tap = pause). The
/// bars only animate while audio plays and the button is on screen.
final class KadokiPlayButton: UIControl {
    var spectrum: ((Int) -> [Float]?)?
    private(set) var playing = false
    private let fill = CAGradientLayer()
    private let glyph = UIImageView()
    private let barCount = 7
    private var bars: [CALayer] = []
    private var levels: [Float] = []
    private var link: CADisplayLink?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(fill)
        for _ in 0..<barCount {
            let b = CALayer()
            b.backgroundColor = UIColor(white: 0.06, alpha: 0.85).cgColor
            b.cornerRadius = 1.5
            layer.addSublayer(b)
            bars.append(b)
        }
        levels = Array(repeating: 0, count: barCount)
        glyph.tintColor = UIColor(white: 0.06, alpha: 0.9)
        glyph.contentMode = .center
        glyph.isUserInteractionEnabled = false
        addSubview(glyph)
        isAccessibilityElement = true
        accessibilityTraits = .button
        addTarget(self, action: #selector(down), for: [.touchDown, .touchDragEnter])
        addTarget(self, action: #selector(up), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        set(playing: false, accent: .systemGreen)
    }
    required init?(coder: NSCoder) { fatalError() }

    func set(playing p: Bool, accent: UIColor) {
        playing = p
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        accent.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        // Flat, with only a hint of light from above.
        let top = UIColor(hue: h, saturation: s * 0.94, brightness: min(1, b * 1.04), alpha: 1)
        let bottom = UIColor(hue: h, saturation: s, brightness: b * 0.96, alpha: 1)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        fill.colors = [top.cgColor, bottom.cgColor]
        CATransaction.commit()
        glyph.image = UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .bold))
        accessibilityLabel = p ? NSLocalizedString("Pause", comment: "") : NSLocalizedString("Play", comment: "")
        UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.glyph.alpha = p ? 0 : 1
        }
        if !p { for i in levels.indices { levels[i] = 0 } }
        updateLink()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let r = bounds.height / 2
        CATransaction.begin(); CATransaction.setDisableActions(true)
        fill.frame = bounds
        fill.cornerRadius = r
        CATransaction.commit()
        glyph.frame = CGRect(x: bounds.midX - 8, y: 0, width: 18, height: bounds.height)
        drawBars()
    }

    private func drawBars() {
        let bw: CGFloat = 3, gap: CGFloat = 2.5
        let total = CGFloat(barCount) * bw + CGFloat(barCount - 1) * gap
        let x0 = bounds.midX - total / 2, maxH = bounds.height - 12, minH: CGFloat = 3
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (i, b) in bars.enumerated() {
            let h = minH + (maxH - minH) * CGFloat(levels[i])
            b.frame = CGRect(x: x0 + CGFloat(i) * (bw + gap), y: bounds.midY - h / 2, width: bw, height: h)
            b.opacity = playing ? 1 : 0
        }
        CATransaction.commit()
    }

    override func didMoveToWindow() { super.didMoveToWindow(); updateLink() }
    override var isHidden: Bool { didSet { updateLink() } }

    private func updateLink() {
        let want = playing && window != nil && !isHidden && spectrum != nil
        if want, link == nil {
            let l = CADisplayLink(target: KadokiWeakTarget(self), selector: #selector(KadokiWeakTarget.tick))
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 30, preferred: 30)
            l.add(to: .main, forMode: .common)
            link = l
        } else if !want, let l = link {
            l.invalidate()
            link = nil
            drawBars()
        }
    }

    fileprivate func tick() {
        guard alpha > 0.01 else { return }
        let target = spectrum?(barCount) ?? Array(repeating: 0, count: barCount)
        for i in 0..<barCount {
            let t = i < target.count ? target[i] : 0
            // Quick rise, slower fall, like a meter.
            levels[i] += (t - levels[i]) * (t > levels[i] ? 0.6 : 0.2)
        }
        drawBars()
    }

    @objc private func down() {
        UIView.animate(withDuration: 0.12, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.glyph.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
            self.fill.opacity = 0.85
        }
        // Scale the contents, not the view: the view's transform belongs to the chrome slide.
        layer.sublayerTransform = CATransform3DMakeScale(0.93, 0.93, 1)
    }
    @objc private func up() {
        UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.glyph.transform = .identity
        }
        let spring = CASpringAnimation(keyPath: "sublayerTransform.scale")
        spring.fromValue = 0.93
        spring.toValue = 1
        spring.damping = 11
        spring.stiffness = 300
        spring.duration = spring.settlingDuration
        layer.sublayerTransform = CATransform3DIdentity
        layer.add(spring, forKey: "press")
        fill.opacity = 1
    }

    deinit { link?.invalidate() }
}

/// CADisplayLink retains its target; this breaks the cycle.
private final class KadokiWeakTarget: NSObject {
    weak var button: KadokiPlayButton?
    init(_ b: KadokiPlayButton) { button = b }
    @objc func tick() { button?.tick() }
}

/// Native toolbar controls over the web toolbar (native-toolbar.js): the mode
/// tabs as a UISegmentedControl (only the title's own tabs, its mode accent)
/// and play / pause as a native button. Each sits exactly over its web
/// control, is shown only while that control is the top-most thing there,
/// and forwards taps to it, so mode switches and playback run the web code
/// unchanged. Long-press the tabs → the per-title tab chooser.
final class KadokiNativeToolbar: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let tabs = UISegmentedControl()
    private let play = KadokiPlayButton()
    private var modes: [String] = []
    private var labels: [String] = []
    private var accent = ""
    private var accents: [String: String] = [:]
    private var playAccent = ""
    private var shownPlaying: Bool?
    private var chromeHidden = false
    // A tap is shown at once; reports that still carry the old state (the web
    // side hasn't switched yet) don't undo it until they catch up or time out.
    private var pendingMode: String?
    private var pendingModeUntil = Date.distantPast
    private var pendingPlaying: Bool?
    private var pendingPlayUntil = Date.distantPast

    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_TOOLBAR=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// audio: the live player's spectrum for the play button's bars.
    func install(in host: UIView, webView: WKWebView, spectrum: ((Int) -> [Float]?)? = nil) {
        self.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativeToolbar")
        tabs.isHidden = true
        tabs.setTitleTextAttributes([.foregroundColor: UIColor.black, .font: UIFont.systemFont(ofSize: 13, weight: .semibold)], for: .selected)
        tabs.setTitleTextAttributes([.foregroundColor: UIColor.secondaryLabel, .font: UIFont.systemFont(ofSize: 13, weight: .medium)], for: .normal)
        tabs.addTarget(self, action: #selector(tabChanged), for: .valueChanged)
        tabs.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(tabsLongPress(_:))))
        play.isHidden = true
        play.spectrum = spectrum
        play.addTarget(self, action: #selector(playTapped), for: .touchUpInside)
        host.addSubview(tabs)
        host.addSubview(play)
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let wv = webView, let host = tabs.superview else { return }
        func rect(_ o: [String: Any]) -> CGRect? {
            guard let x = o["x"] as? Double, let y = o["y"] as? Double, let w = o["w"] as? Double, let h = o["h"] as? Double else { return nil }
            return wv.convert(CGRect(x: x, y: y, width: w, height: h), to: host)
        }
        // Tabs
        let t = d["tabs"] as? [String: Any] ?? [:]
        if (t["visible"] as? Bool) == true, let r = rect(t), let items = t["items"] as? [[String: Any]], !items.isEmpty {
            let m = items.map { $0["mode"] as? String ?? "" }
            let l = items.map { $0["label"] as? String ?? "" }
            if m != modes || l != labels {
                modes = m; labels = l
                tabs.removeAllSegments()
                for (i, title) in l.enumerated() { tabs.insertSegment(withTitle: title, at: i, animated: false) }
            }
            for (i, it) in items.enumerated() {
                let on = !((it["disabled"] as? Bool) ?? false)
                if tabs.isEnabledForSegment(at: i) != on { tabs.setEnabled(on, forSegmentAt: i) }
            }
            accents = (t["accents"] as? [String: String]) ?? accents
            var sel = t["selected"] as? Int ?? -1
            if let pm = pendingMode {
                let reported = (sel >= 0 && sel < m.count) ? m[sel] : ""
                if reported == pm || Date() > pendingModeUntil { pendingMode = nil }
                else if let pi = m.firstIndex(of: pm) { sel = pi }
            }
            let want = (sel >= 0 && sel < m.count) ? sel : UISegmentedControl.noSegment
            if tabs.selectedSegmentIndex != want { tabs.selectedSegmentIndex = want }
            let a = pendingMode == nil ? ((t["accent"] as? String) ?? "") : accent
            if a != accent { accent = a; tabs.selectedSegmentTintColor = KadokiChromeSlide.color(a) }
            let h = max(r.height, 32)
            KadokiChromeSlide.place(tabs, CGRect(x: r.minX, y: r.midY - h / 2, width: r.width, height: h))
            host.bringSubviewToFront(tabs)
            tabs.isHidden = false
        } else {
            tabs.isHidden = true
        }
        // Play / pause: a fixed-size capsule, wider than the web button, so it
        // grows leftward (the hamburger is to its right).
        let p = d["play"] as? [String: Any] ?? [:]
        if (p["visible"] as? Bool) == true, let r = rect(p) {
            var playing = (p["playing"] as? Bool) ?? false
            if let pp = pendingPlaying {
                if playing == pp || Date() > pendingPlayUntil { pendingPlaying = nil } else { playing = pp }
            }
            setPlay(playing: playing, accent: (p["accent"] as? String) ?? playAccent)
            KadokiChromeSlide.place(play, CGRect(x: r.maxX - 76, y: r.midY - 17, width: 62, height: 34))
            host.bringSubviewToFront(play)
            play.isHidden = false
        } else {
            play.isHidden = true
        }
        if let c = d["chrome"] as? Bool, c == chromeHidden {
            chromeHidden = !c
            KadokiChromeSlide.apply([tabs, play], hidden: chromeHidden)
        }
    }

    private func setPlay(playing: Bool, accent a: String) {
        guard playing != shownPlaying || a != playAccent else { return }
        shownPlaying = playing
        playAccent = a
        play.set(playing: playing, accent: KadokiChromeSlide.color(a))
    }

    @objc private func tabChanged() {
        let i = tabs.selectedSegmentIndex
        guard i >= 0, i < modes.count else { return }
        pendingMode = modes[i]
        pendingModeUntil = Date().addingTimeInterval(2.5)
        // The bubble takes the new mode's color as it slides.
        if let a = accents[modes[i]], a != accent { accent = a; tabs.selectedSegmentTintColor = KadokiChromeSlide.color(a) }
        js("window.__kadokiToolbarTab(\(Self.quoted(modes[i])))")
    }
    @objc private func tabsLongPress(_ g: UILongPressGestureRecognizer) {
        if g.state == .began { UIImpactFeedbackGenerator(style: .medium).impactOccurred(); js("window.__kadokiToolbarChooser()") }
    }
    @objc private func playTapped() {
        // Flip at once (the real state confirms it a moment later).
        let next = !(shownPlaying ?? false)
        pendingPlaying = next
        pendingPlayUntil = Date().addingTimeInterval(2)
        setPlay(playing: next, accent: playAccent)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        js("window.__kadokiToolbarPlay()")
    }
    private func js(_ s: String) { webView?.evaluateJavaScript(s, completionHandler: nil) }

    private static func quoted(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: d, as: UTF8.self).dropFirst().dropLast())
    }
}

/// Native iOS action sheets for the web choosers (ios-feel.js routes a
/// libSheet that holds only plain choices here). Message: {id, title,
/// options: [{label, sub, destructive}], cancel}; the pick goes back as
/// window.__kadokiSheetDone(id, index), -1 for Cancel.
final class KadokiActionSheet: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private weak var hostVC: UIViewController?

    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_SHEETS=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in vc: UIViewController, webView: WKWebView) {
        self.webView = webView
        hostVC = vc
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiActionSheet")
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let id = d["id"] as? Int,
              let opts = d["options"] as? [[String: Any]], var vc = hostVC else { return }
        while let p = vc.presentedViewController, !p.isBeingDismissed { vc = p }
        let title = (d["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let sheet = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        for (i, o) in opts.enumerated() {
            var label = (o["label"] as? String) ?? ""
            if let sub = o["sub"] as? String, !sub.isEmpty { label += " — " + sub }
            let style: UIAlertAction.Style = ((o["destructive"] as? Bool) == true) ? .destructive : .default
            sheet.addAction(UIAlertAction(title: label, style: style) { [weak self] _ in self?.done(id, i) })
        }
        sheet.addAction(UIAlertAction(title: (d["cancel"] as? String) ?? "Cancel", style: .cancel) { [weak self] _ in self?.done(id, -1) })
        if let pop = sheet.popoverPresentationController {   // iPad: anchored popover
            pop.sourceView = vc.view
            pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 40, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        vc.present(sheet, animated: true)
    }

    private func done(_ id: Int, _ index: Int) {
        webView?.evaluateJavaScript("window.__kadokiSheetDone && window.__kadokiSheetDone(\(id), \(index))", completionHandler: nil)
    }
}

/// Native toasts: a capsule just below the toolbar, above the web view AND
/// the native Preferences / Library layers (web toasts were hidden under
/// them). ios-feel.js sends showToast() here: {text, ms}.
final class KadokiToast: NSObject, WKScriptMessageHandler {
    private weak var hostView: UIView?
    private var current: UIView?
    private var hideWork: DispatchWorkItem?

    func install(in view: UIView, webView: WKWebView) {
        hostView = view
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiToast")
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let text = d["text"] as? String, !text.isEmpty,
              let host = hostView else { return }
        let ms = (d["ms"] as? Double) ?? 2500
        hideWork?.cancel()
        current?.removeFromSuperview()

        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
        blur.clipsToBounds = true
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.numberOfLines = 3
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(label)
        blur.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(blur)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 18),
            label.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -18),
            label.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 11),
            label.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -11),
            blur.centerXAnchor.constraint(equalTo: host.centerXAnchor),
            blur.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor, constant: 56),   // below the toolbar
            blur.widthAnchor.constraint(lessThanOrEqualTo: host.widthAnchor, constant: -40),
        ])
        host.layoutIfNeeded()
        blur.layer.cornerRadius = min(blur.bounds.height / 2, 22)
        blur.alpha = 0
        blur.transform = CGAffineTransform(translationX: 0, y: -12).scaledBy(x: 0.96, y: 0.96)
        current = blur
        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) {
            blur.alpha = 1
            blur.transform = .identity
        }
        let work = DispatchWorkItem { [weak self, weak blur] in
            UIView.animate(withDuration: 0.25, animations: {
                blur?.alpha = 0
                blur?.transform = CGAffineTransform(translationX: 0, y: -8)
            }, completion: { _ in
                blur?.removeFromSuperview()
                if self?.current === blur { self?.current = nil }
            })
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(1.2, ms / 1000), execute: work)
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
