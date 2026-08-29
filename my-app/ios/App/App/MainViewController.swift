import UIKit
import Capacitor
import WebKit
#if os(visionOS)
import SwiftUI

// Shared observable state for the native transport ornament. Fed by
// BackgroundAudioPlugin's state notifications (playing) and the JS layer's
// tpState pushes (dictionary mode).
final class KadokiTransportModel: ObservableObject {
    static let shared = KadokiTransportModel()
    @Published var playing = false
    @Published var dictOn = true
    @Published var mode = "card"
    /// Card-mode picture style: flat (legacy) vs spatial depth. Mirrors the
    /// Appearance → Card → "Spatial pictures" pref; JS pushes it via tpState.
    @Published var spatialOn = false
    /// A video Title is active in audio mode (video-mode.js pushes it): the
    /// cube button doubles as the video AI-3D toggle there.
    @Published var videoOn = false
    /// The 3D-tuning slider card (depth / convergence) is expanded above the bar.
    @Published var video3dOpen = false
    /// Playback progress for the video transport row (whole seconds; fed by
    /// BackgroundAudioPlugin's position ticks via KadokiAudioProgress).
    @Published var positionMs = 0
    @Published var durationMs = 0
    /// A text field has focus in the page (JS pushes focusin/focusout via
    /// tpState): hardware-key commands stand down so typing isn't hijacked.
    var typing = false
}

// The native dictionary panel's state — content is mirrored from the ghosted
// in-window popup (see kvMirrorPopupToPanel in enhanced-dictionary.js).
final class KadokiDictModel: ObservableObject {
    static let shared = KadokiDictModel()
    @Published var visible = false
    @Published var dockLeading = false   // dock-side toggle (⇄)
    @Published var docked = true         // false = floating second window
}

// A single shared WKWebView renders the popup's OWN HTML with the app's OWN
// CSS — pixel-identical formatting. Button taps inside it post their
// document-order index; JS clicks the ghost popup's matching real button, so
// Anki / navigation / audio all run the existing code paths.
final class KadokiDictWeb: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = KadokiDictWeb()
    let webView: WKWebView
    private var shellLoaded = false
    private var loadingShell = false
    private var cssCache = ""
    private var pendingHtml: String?
    override private init() {
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        super.init()
        cfg.userContentController.add(self, name: "kadokiDict")
        webView.navigationDelegate = self
    }
    func setContent(css: String?, html: String) {
        if let c = css, !c.isEmpty { cssCache = c; shellLoaded = false }
        if !shellLoaded {
            shellLoaded = true
            loadingShell = true
            pendingHtml = nil
            let shell = """
            <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>\(cssCache)
            html, body { background: transparent !important; margin: 0; padding: 18px 12px 12px; overflow-y: auto; }
            * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }
            #dictPopup { position: static !important; display: block !important; opacity: 1 !important;
              pointer-events: auto !important; width: auto !important; max-width: none !important;
              height: auto !important; max-height: none !important; left: auto !important; top: auto !important;
              right: auto !important; bottom: auto !important; box-shadow: none !important;
              animation: none !important; transform: none !important;
              padding-top: 18px !important; overflow: visible !important; }
            #dictPopup > :first-child { margin-top: 0 !important; }
            /* Panel-only ergonomics: gaze-sized play / audio-cycler / Anki
               buttons with roomier spacing. The in-window iPhone popup keeps
               its compact sizes — these rules exist only in this shell. */
            .dict-popup-header-icons { gap: 14px !important; }
            .dict-popup-icon-btn { padding: 10px 12px !important; border-radius: 12px !important; }
            .dict-popup-icon-btn svg { width: 28px !important; height: 28px !important; }
            .dict-popup-anki-btn { padding: 12px 22px !important; font-size: 0.95em !important; }
            .dict-popup-nav { gap: 16px !important; }
            .dict-popup-nav-btn { padding: 8px 16px !important; font-size: 0.85em !important; }
            </style>
            <div id="dictPopup">\(html)</div>
            <script>
            document.addEventListener('click', function (e) {
              var b = e.target && e.target.closest ? e.target.closest('button') : null;
              if (!b) return;
              e.preventDefault(); e.stopPropagation();
              var all = Array.prototype.slice.call(document.querySelectorAll('button'));
              try { webkit.messageHandlers.kadokiDict.postMessage({ i: all.indexOf(b) }); } catch (_) {}
            }, true);
            window.__setHTML = function (h) { document.getElementById('dictPopup').innerHTML = h; };
            </script>
            """
            webView.loadHTMLString(shell, baseURL: nil)
        } else if loadingShell {
            pendingHtml = html
        } else {
            evalSet(html)
        }
    }
    private func evalSet(_ html: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [html]),
              let js = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__setHTML((\(js))[0])", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingShell = false
        if let p = pendingHtml { pendingHtml = nil; evalSet(p) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let i = d["i"] as? Int, i >= 0 else { return }
        NotificationCenter.default.post(name: Notification.Name("KadokiDictAction"), object: nil, userInfo: ["i": i])
    }
}
struct KadokiDictWebRep: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { KadokiDictWeb.shared.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

// DOCKED: glass side panel (leading/trailing ornament) — auto-appears with a
// lookup, auto-hides on dismiss, never covers the text. UNDOCKED: the same
// webview moves into a real second window (moveable + resizable by the
// system); re-dock returns it here.
struct KadokiDictPanelView: View {
    @ObservedObject var model = KadokiDictModel.shared
    private func act(_ i: Int) {
        NotificationCenter.default.post(name: Notification.Name("KadokiDictAction"),
                                        object: nil, userInfo: ["i": i])
    }
    var body: some View {
        Group {
            if model.visible && model.docked {
                VStack(spacing: 0) {
                    HStack(spacing: 14) {
                        Button { model.dockLeading.toggle()
                                 NotificationCenter.default.post(name: Notification.Name("KadokiDictDock"), object: nil) } label: {
                            Image(systemName: "arrow.left.arrow.right")
                        }
                        .buttonStyle(.borderless)
                        Spacer()
                        Button { NotificationCenter.default.post(name: Notification.Name("KadokiDictUndock"), object: nil) } label: {
                            Image(systemName: "rectangle.on.rectangle")
                        }
                        .buttonStyle(.borderless)
                        Button { act(-1) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    KadokiDictWebRep()
                        .frame(width: 440, height: 580)
                }
                // Darker read surface: a black tint layer between the web
                // content and the system glass (glass alone was too bright
                // beside the dimmed reading window).
                .background(Color.black.opacity(0.45))
                .glassBackgroundEffect()
                // Angle the side panel ~30° toward the reader, hinged on its
                // window-side edge (tri-fold mirror). Signs: rotation about
                // +y by a NEGATIVE angle brings the +x (right) edge toward
                // the viewer — so trailing dock = -30 about its leading
                // edge; leading dock mirrors.
                .rotation3DEffect(
                    .degrees(model.dockLeading ? 30 : -30),
                    axis: (x: 0, y: 1, z: 0),
                    anchor: model.dockLeading ? .trailing : .leading
                )
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }
    }
}

// The undocked floating window's content: same shared webview + a re-dock
// button. The window itself is system-moveable and resizable.
struct KadokiDictWindowView: View {
    @ObservedObject var model = KadokiDictModel.shared
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("辞書").font(.headline)
                Spacer()
                Button { NotificationCenter.default.post(name: Notification.Name("KadokiDictRedock"), object: nil) } label: {
                    Image(systemName: "pip.exit")
                }
                .buttonStyle(.borderless)
            }
            .padding(12)
            if !model.docked {
                KadokiDictWebRep()
            } else {
                Spacer()
            }
        }
    }
}

// ---- detachable panel windows (Timeline & Scenes / chapter summary / Characters) ----
// The dictionary panel MIRRORS its HTML into a shared webview because the popup
// is small, static and self-contained. These panels are not: a long feed with
// blob-URL images, a waveform canvas, quote-clip audio and live refresh. A
// mirror would render a dead text ghost of them.
//
// So a panel window hosts its OWN WKWebView pointed at panel.html on the SAME
// capacitor://localhost origin as the main window. Same origin + the shared
// default website data store = the same IndexedDB and localStorage, so the panel
// renders the REAL panel off the REAL data — images, dictionary lookups and
// scrolling all intact.
//
// Deliberately NOT given Capacitor's content controller: with the bridge's own
// user scripts and message handlers, plugin calls from this webview would be
// executed natively but their results evaluated back into the MAIN webview, so
// every call would hang. Without them `window.Capacitor` is simply undefined and
// the app's `window.Capacitor?.Plugins?.X` guards no-op — which is exactly what
// a read-only panel wants. Anything it genuinely needs from the main window
// (jump to a chapter, play a quote clip, send to Anki) is relayed through here.
final class KadokiPanelHost: NSObject, WKScriptMessageHandler {
    static let shared = KadokiPanelHost()
    weak var mainWebView: WKWebView?
    private var webs: [String: WKWebView] = [:]
    // The controller we actually registered the handler on. `webView.configuration`
    // hands back a COPY, so removing the handler through that would leave the real
    // registration (and its strong reference to us) in place.
    private var uccs: [String: WKUserContentController] = [:]

    func webView(for kind: String) -> WKWebView {
        if let w = webs[kind] { return w }
        let cfg = WKWebViewConfiguration()
        // The asset handler that serves capacitor://localhost. Reusing the main
        // webview's instance is what puts this webview on the same ORIGIN; a
        // file:// load would be a different origin and share no storage at all.
        if let h = mainWebView?.configuration.urlSchemeHandler(forURLScheme: "capacitor") {
            cfg.setURLSchemeHandler(h, forURLScheme: "capacitor")
        }
        if let ds = mainWebView?.configuration.websiteDataStore { cfg.websiteDataStore = ds }
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ucc = WKUserContentController()
        ucc.add(self, name: "kadokiPanel")
        cfg.userContentController = ucc
        uccs[kind] = ucc
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.scrollView.backgroundColor = .clear
        // A connected trackpad pans this scroll view directly. The panel is a
        // strictly VERTICAL surface, so take horizontal motion off the table at
        // the native layer too — the CSS side (overflow-x:hidden on every
        // vertical scroller) only governs elements inside the document.
        w.scrollView.bounces = false
        w.scrollView.alwaysBounceHorizontal = false
        w.scrollView.showsHorizontalScrollIndicator = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(visionOS 26.0, *) { w.configuration.preferences.isLookToScrollEnabled = true }
        w.isInspectable = true
        if let url = URL(string: "capacitor://localhost/panel.html?kvpanel=" + kind) {
            w.load(URLRequest(url: url))
        }
        webs[kind] = w
        return w
    }

    // Window closed: drop the webview so a later pop-out boots fresh against
    // current data instead of resurrecting a stale render.
    //
    // Deliberately does NOT load a blank page or otherwise drive WebKit here.
    // This runs off the back of scene teardown, and driving a navigation on a
    // webview the system is in the middle of pulling out of a disconnecting
    // scene is how you take the whole app down with it. Stop the load, unhook
    // the handler, release — teardown is the system's job.
    func drop(kind: String) {
        if let u = uccs.removeValue(forKey: kind) { u.removeScriptMessageHandler(forName: "kadokiPanel") }
        if let w = webs.removeValue(forKey: kind) { w.stopLoading() }
        NSLog("[KadokiPanel] dropped webview for \(kind)")
    }

    // main → panel relay
    func post(kind: String, msg: String) {
        guard let w = webs[kind] else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: [msg]),
              let js = String(data: data, encoding: .utf8) else { return }
        w.evaluateJavaScript("window.__kadokiPanelRecv && window.__kadokiPanelRecv((\(js))[0])", completionHandler: nil)
    }

    // panel → main relay (and the panel's own "close my window" request)
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any] else { return }
        let kind = (d["kind"] as? String) ?? ""
        if (d["action"] as? String) == "close" {
            NotificationCenter.default.post(name: Notification.Name("KadokiPanelWindow"), object: nil,
                                            userInfo: ["action": "close", "kind": kind])
            return
        }
        guard let msg = d["msg"] as? String,
              let data = try? JSONSerialization.data(withJSONObject: [msg]),
              let js = String(data: data, encoding: .utf8) else { return }
        mainWebView?.evaluateJavaScript("window.__kadokiPanelFromWindow && window.__kadokiPanelFromWindow((\(js))[0])",
                                        completionHandler: nil)
    }
}

struct KadokiPanelWebRep: UIViewRepresentable {
    let kind: String
    func makeUIView(context: Context) -> WKWebView { KadokiPanelHost.shared.webView(for: kind) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct KadokiPanelWindowView: View {
    let kind: String
    private var title: String {
        switch kind {
        case "timeline": return "\u{30bf}\u{30a4}\u{30e0}\u{30e9}\u{30a4}\u{30f3}"
        case "summary": return "\u{7ae0}\u{306e}\u{8981}\u{7d04}"
        case "characters": return "\u{767b}\u{5834}\u{4eba}\u{7269}"
        default: return "Kadoki"
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                // Re-dock: closing the window is what returns the panel to an
                // in-window overlay (sceneDidDisconnect notifies the main webview).
                Button {
                    NotificationCenter.default.post(name: Notification.Name("KadokiPanelWindow"), object: nil,
                                                    userInfo: ["action": "close", "kind": kind])
                } label: { Image(systemName: "pip.exit") }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            KadokiPanelWebRep(kind: kind)
        }
    }
}

// The glass transport bar that floats BELOW the window (a real visionOS
// ornament — system glass, system hover). Buttons only post notifications;
// MainViewController forwards them to the SAME JS handlers the in-window
// controls use, so smart-rewind, fades, and cue logic stay in one place.
struct KadokiTransportView: View {
    @ObservedObject var model = KadokiTransportModel.shared
    private func send(_ action: String) {
        NotificationCenter.default.post(name: Notification.Name("KadokiTransportTap"),
                                        object: nil, userInfo: ["action": action])
    }
    private func modeButton(_ m: String, _ symbol: String) -> some View {
        Button { send("mode:" + m) } label: {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(model.mode == m ? Color(red: 0.81, green: 0.75, blue: 0.96) : Color.secondary)
        }
        .buttonStyle(.borderless)
        .frame(width: 56, height: 56)
    }
    var body: some View {
        VStack(spacing: 10) {
            if model.mode == "audio" && model.videoOn && model.video3dOpen {
                KadokiVideo3DSettings()
            }
            bar
        }
    }
    private func fmtTime(_ ms: Int) -> String {
        let s = max(0, ms / 1000)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }
    private var bar: some View {
        VStack(spacing: 8) {
        HStack(spacing: 14) {
            // Mode selectors (Card / Read / Audio) — mirror the top tabs so
            // the top bar can stay hidden entirely.
            modeButton("card", "square.stack")
            modeButton("read", "book")
            modeButton("audio", "headphones")
            Divider().frame(height: 32)
            // backward/forward.frame = "step one unit" — reads as prev/next
            // SUBTITLE, not rewind/fast-forward.
            Button { send("prev") } label: {
                Image(systemName: "backward.frame.fill").font(.title2)
            }
            .buttonStyle(.borderless)
            .frame(width: 68, height: 68)
            Button { send("toggle") } label: {
                Image(systemName: model.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .frame(width: 50, height: 50)
            }
            .buttonStyle(.borderless)
            .frame(width: 84, height: 84)
            Button { send("next") } label: {
                Image(systemName: "forward.frame.fill").font(.title2)
            }
            .buttonStyle(.borderless)
            .frame(width: 68, height: 68)
            // Video: replay the current subtitle (was an in-window ⟲ that
            // collided with the cue panel).
            if model.mode == "audio" && model.videoOn {
                Button { send("replay") } label: {
                    Image(systemName: "arrow.counterclockwise").font(.title2)
                }
                .buttonStyle(.borderless)
                .frame(width: 60, height: 60)
                // Episode / subtitle browser (DOM overlay; the video plane
                // hides itself while it's open).
                Button { send("epBrowse") } label: {
                    Image(systemName: "list.bullet.rectangle").font(.title3)
                }
                .buttonStyle(.borderless)
                .frame(width: 56, height: 56)
            }
            // 辞書 toggle removed (2026-08-27, user: "we will always leave it
            // on") — dictionary lookups are permanently enabled; JS forces the
            // AB_DICT_LOOKUP pref on at boot. The movie-mode click-anywhere
            // pause that dict-off enabled is gone with it (transport owns
            // play/pause).
            // Card mode: flat ⇄ spatial (depth) pictures (same pref as
            // Appearance → Card → "Spatial pictures"). Audio mode with a video
            // Title: the video's AI-3D stereo toggle. One-pinch switch either way.
            if model.mode == "card" || (model.mode == "audio" && model.videoOn) {
                Button { send("spatial") } label: {
                    Image(systemName: model.spatialOn ? "cube.fill" : "cube")
                        .font(.title3)
                        .foregroundStyle(model.spatialOn ? Color(red: 0.81, green: 0.75, blue: 0.96) : Color.secondary)
                }
                .buttonStyle(.borderless)
                .frame(width: 56, height: 56)
            }
            // Video settings (3D tuning + subtitle placement).
            if model.mode == "audio" && model.videoOn {
                Button { model.video3dOpen.toggle() } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.title3)
                        .foregroundStyle(model.video3dOpen ? Color(red: 0.81, green: 0.75, blue: 0.96) : Color.secondary)
                }
                .buttonStyle(.borderless)
                .frame(width: 56, height: 56)
            }
            Divider().frame(height: 32)
            // Chapter summary — reachable from EVERY mode (card / read / audio),
            // not just the audio view's own 章の要約 button. openCurrentChapter
            // resolves the chapter from whichever modality is active and opens a
            // self-contained popup, so playback and the reading place are untouched.
            // Chapter summary is a book concept — hidden while a video Title
            // plays (mode audio + videoOn).
            if !(model.mode == "audio" && model.videoOn) {
                Button { send("summary") } label: {
                    Image(systemName: "text.book.closed").font(.title3)
                }
                .buttonStyle(.borderless)
                .frame(width: 56, height: 56)
            }
            Divider().frame(height: 32)
            // Top-bar toggle + hamburger menu live HERE too — reaching for
            // the in-window header (or re-summoning it) was cumbersome.
            Button { send("chrome") } label: {
                Image(systemName: "rectangle.topthird.inset.filled").font(.title3)
            }
            .buttonStyle(.borderless)
            .frame(width: 56, height: 56)
            Button { send("menu") } label: {
                Image(systemName: "line.3.horizontal").font(.title2)
            }
            .buttonStyle(.borderless)
            .frame(width: 56, height: 56)
        }
        // Video transport: elapsed / progress / total / percent. Display-only
        // (no scrubbing — cue stepping is the navigation model).
        if model.mode == "audio" && model.videoOn && model.durationMs > 0 {
            HStack(spacing: 10) {
                Text(fmtTime(model.positionMs)).font(.caption.monospacedDigit())
                ProgressView(value: min(1.0, Double(model.positionMs) / Double(max(1, model.durationMs))))
                    .progressViewStyle(.linear)
                    .frame(width: 300)
                Text(fmtTime(model.durationMs)).font(.caption.monospacedDigit())
                Text("\(Int((Double(model.positionMs) * 100 / Double(max(1, model.durationMs))).rounded()))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 12)
        .glassBackgroundEffect()
    }
}

/// Slider card above the transport bar: live AI-3D tuning for video Titles.
/// Binds straight to KadokiVideoModel — changes hit the stereo renderer on
/// the next frame and persist in UserDefaults.
struct KadokiVideo3DSettings: View {
    @ObservedObject var vm = KadokiVideoModel.shared
    private func send(_ action: String) {
        NotificationCenter.default.post(name: Notification.Name("KadokiTransportTap"),
                                        object: nil, userInfo: ["action": action])
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text("Depth").font(.callout).frame(width: 110, alignment: .leading)
                Slider(value: $vm.strength, in: 0...0.06)
                Text(String(format: "%.3f", vm.strength))
                    .font(.callout.monospacedDigit()).frame(width: 56, alignment: .trailing)
            }
            HStack(spacing: 12) {
                Text("Convergence").font(.callout).frame(width: 110, alignment: .leading)
                Slider(value: $vm.convergence, in: 0...1.3)
                Text(String(format: "%.2f", vm.convergence))
                    .font(.callout.monospacedDigit()).frame(width: 56, alignment: .trailing)
            }
            HStack(spacing: 12) {
                Text("Subtitle size").font(.callout).frame(width: 110, alignment: .leading)
                Slider(value: $vm.subSize, in: 22...44, step: 1)
                Text("\(Int(vm.subSize))")
                    .font(.callout.monospacedDigit()).frame(width: 56, alignment: .trailing)
            }
            HStack(spacing: 12) {
                Text("Subtitles").font(.callout).frame(width: 110, alignment: .leading)
                Picker("", selection: $vm.subPlacement) {
                    Text("Below").tag("below")
                    Text("Overlay").tag("overlay")
                }
                .pickerStyle(.segmented)
            }
            HStack(spacing: 12) {
                Text("Model").font(.callout).frame(width: 110, alignment: .leading)
                Picker("", selection: $vm.depthModel) {
                    Text("Small (fast)").tag("small")
                    Text("Base (HQ)").tag("base")
                }
                .pickerStyle(.segmented)
            }
            HStack(spacing: 12) {
                Text("Curve").font(.callout).frame(width: 110, alignment: .leading)
                Slider(value: $vm.depthGamma, in: 0.5...1.5)
                Text(String(format: "%.2f", vm.depthGamma))
                    .font(.callout.monospacedDigit()).frame(width: 56, alignment: .trailing)
            }
            HStack(spacing: 12) {
                Text("Edge").font(.callout).frame(width: 110, alignment: .leading)
                Slider(value: $vm.edgeSigma, in: 0.03...0.2)
                Text(String(format: "%.2f", vm.edgeSigma))
                    .font(.callout.monospacedDigit()).frame(width: 56, alignment: .trailing)
            }
            HStack(spacing: 12) {
                Text("Renderer").font(.callout).frame(width: 110, alignment: .leading)
                Picker("", selection: $vm.renderMode) {
                    Text("Splat (new)").tag("splat")
                    Text("Classic").tag("classic")
                }
                .pickerStyle(.segmented)
            }
            if vm.episodeCount > 1 {
                HStack(spacing: 12) {
                    Text("Episode").font(.callout).frame(width: 110, alignment: .leading)
                    Button { send("epPrev") } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(.borderless)
                    Text("\(vm.episodeIndex)/\(vm.episodeCount)")
                        .font(.callout.monospacedDigit()).frame(width: 70)
                    Button { send("epNext") } label: { Image(systemName: "chevron.right") }
                        .buttonStyle(.borderless)
                    Spacer()
                }
            }
            HStack {
                Spacer()
                Button("Reset") { vm.strength = 0.03; vm.convergence = 0.45 }
                    .font(.callout)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 14)
        .frame(width: 480)
        .glassBackgroundEffect()
    }
}
#endif

/**
 * Capacitor 7 does NOT auto-discover plugins compiled into the app target —
 * only ones installed via CocoaPods. To wire our four in-app Swift plugins
 * (BackgroundAudio, AudioSlicer, AnkiBridge, FileAccess) into the bridge,
 * we subclass CAPBridgeViewController and register them in capacitorDidLoad().
 *
 * Main.storyboard's root view controller is set to this class (customModule=App).
 */
#if os(visionOS)
/// Container for the spatial layer. UIKit hit-testing decides BOTH where a
/// pinch lands AND which view the system's gaze glow targets (measured: with
/// this returning nil the hover views never glowed — the hidden webview's
/// own regions won — while pinches fell through to the page). So it claims a
/// point ONLY inside a visible hover target; the target forwards the pinch to
/// the DOM (KadokiHoverTargetView). Everywhere else → nil → webview as before.
final class KadokiSpatialHostView: UIView {
    var hoverHit: ((CGPoint) -> UIView?)?
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard isUserInteractionEnabled, !isHidden, let hit = hoverHit?(point) else { return nil }
        return hit
    }
}

/// One gaze-glow target. Carries the system highlight (UIHoverStyle — the
/// very effect WebKit's 2D glow uses, so a word lights up as the same crisp
/// capsule it does on a flat card) and forwards a pinch to the DOM as a
/// click at the same point (SpatialImagePlugin.onTap → kadokiSpatialTap →
/// spatial-cards.js replays touchstart/touchend/click on elementFromPoint).
final class KadokiHoverTargetView: UIView {
    var onPinch: ((CGPoint) -> Void)?
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = true
        hoverStyle = UIHoverStyle(effect: .highlight, shape: .capsule)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        addGestureRecognizer(tap)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard let sup = superview else { return }
        onPinch?(g.location(in: sup))
    }
}
#endif

class MainViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        #if os(visionOS)
        installVideoLayer()                   // idempotent; covers a late bridge
        #endif
        guard let bridge = self.bridge else {
            NSLog("[MainViewController] bridge nil at capacitorDidLoad — cannot register plugins")
            return
        }
        bridge.registerPluginInstance(BackgroundAudioPlugin())
        bridge.registerPluginInstance(AudioSlicerPlugin())
        bridge.registerPluginInstance(AnkiBridgePlugin())
        bridge.registerPluginInstance(FileAccessNativePlugin())
        bridge.registerPluginInstance(ArchiveExtractorPlugin())
        bridge.registerPluginInstance(PdfExportPlugin())
        bridge.registerPluginInstance(AutoTranscribePlugin())
        bridge.registerPluginInstance(WatchBridgePlugin())
        // Registered on every platform even though it only does anything on
        // visionOS — off vision its available() resolves {available:false}, so
        // the JS side feature-tests with one call instead of having to catch a
        // "plugin not implemented" bridge error.
        bridge.registerPluginInstance(SpatialImagePlugin())
        NSLog("[MainViewController] registered 9 app-target plugins")

        // Boot the AnkiMediaServer eagerly while we're guaranteed to be on
        // the main thread (CAPBridgeViewController lifecycle). GCDWebServer
        // asserts main-thread in -startWithOptions:, so doing this lazily
        // from the AnkiBridge plugin queue would either SIGABRT (no wrap)
        // or freeze for many seconds (DispatchQueue.main.sync deadlock with
        // WebKit's IPC). Starting at launch sidesteps both.
        AnkiMediaServer.shared.start()

        // Handoff server (iPhone ⇄ Vision Pro LAN sync): Bonjour-advertised;
        // requests round-trip through this webview because the state lives in
        // IndexedDB. Started on every platform — both sides can serve.
        KadokiHandoffServer.shared.jsEval = { [weak self] js in
            self?.bridge?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
        KadokiHandoffServer.shared.start()

        #if os(visionOS)
        // The panel windows build their own webviews from THIS one's asset
        // handler + data store — that's what puts them on the same origin.
        KadokiPanelHost.shared.mainWebView = self.bridge?.webView
        #endif
    }

    #if os(visionOS)
    // Look-to-Scroll (Safari's gaze-at-the-edge scrolling) for our web
    // content — WebKit exposes it as a preference on visionOS 26.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let cfg = super.webViewConfiguration(for: instanceConfiguration)
        if #available(visionOS 26.0, *) {
            cfg.preferences.isLookToScrollEnabled = true
        }
        return cfg
    }

    private var tpObservers: [NSObjectProtocol] = []
    private var tpOrnament: UIHostingOrnament<KadokiTransportView>?
    private var dictOrnament: UIHostingOrnament<KadokiDictPanelView>?
    private var dictAnchorY: CGFloat = 0.5   // vertical dock position (fraction of window height)
    private func applyOrnaments() {
        var list: [UIOrnament] = []
        if let t = tpOrnament { list.append(t) }
        if let d = dictOrnament { list.append(d) }
        self.ornaments = list
    }
    // Docked = FULLY OUTSIDE the window edge (contentAlignment pushes the
    // panel entirely past the anchor), so it can never cover the text — the
    // iOS popup's "politely out of the way" contract. The anchor's y tracks
    // the looked-up line, so the definition opens beside what you're reading.
    private func placeDictOrnament() {
        guard let d = dictOrnament else { return }
        var leading = KadokiDictModel.shared.dockLeading
        // Curved 3D film: its edges bow forward over the docks — force the
        // panel RIGHT and push it further out so the bow can't clip it.
        var xAnchor: CGFloat = 1
        if KadokiVideoModel.shared.visible, KadokiVideoModel.shared.stereoOn {
            leading = false
            xAnchor = 1.06
        }
        d.sceneAnchor = UnitPoint(x: leading ? 0 : xAnchor, y: dictAnchorY)
        d.contentAlignment = leading ? .trailing : .leading
        applyOrnaments()
    }
    /// The spatial-image layer (see installSpatialLayer for why it is on TOP).
    private var spatialHost: UIHostingController<KadokiSpatialLayer>?
    private var spatialBox: KadokiSpatialHostView?

    /// Card-mode spatial pictures (SpatialImagePlugin) render in RealityKit,
    /// which WebKit cannot composite inline — so the layer goes BEHIND the
    /// webview and the webview goes transparent, letting the DOM punch a hole
    /// where the <img> was. Nothing shows through until JS actually makes the
    /// page transparent (body.kv-spatial-live in theme.css), so this is inert
    /// for every mode that never asks for it.
    private func installSpatialLayer() {
        guard spatialHost == nil else { return }
        // Webview transparency is applied per-presentation (applySpatialChrome),
        // NOT here. Doing it at viewDidLoad was the bug behind "the picture area
        // turns white": the bridge's webView may not exist yet, and Capacitor
        // sets the webview's own background while loading the page afterwards —
        // so an opaque webview with its default WHITE background was left
        // painting over everything the moment the page went transparent.
        KadokiSpatialModel.shared.onVisible = { [weak self] on in
            self?.applySpatialChrome(on)
        }
        KadokiSpatialModel.shared.onHotspots = { [weak self] rects in
            self?.syncHoverViews(rects)
        }
        let host = UIHostingController(rootView: KadokiSpatialLayer())
        host.view.backgroundColor = .clear
        // NON-interactive, and this is load-bearing. With the hosting view
        // interactive, visionOS treats the whole of it as the input surface and
        // swallows every pinch over the window — not just on hotspots — and
        // that routing never touches UIKit hit-testing, so a pass-through
        // hitTest on the container cannot save it (measured: zero taps logged
        // anywhere, nav and dictionary dead the moment the layer was up). The
        // attachment's SwiftUI hotspots receive pinches through the system's
        // own routing regardless of this flag (that is how the overlay image
        // swallowed pinches while the host was non-interactive).
        host.view.isUserInteractionEnabled = false
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The layer goes ON TOP of the webview in UIKit order, inside a
        // container that claims a touch ONLY inside a hover hotspot. Why on
        // top: Capacitor's `view` IS the webview, so a subview at index 0 sat
        // beneath WKWebView's scroll view and UIKit hit-testing never reached
        // it — the system targeted a hotspot plane for the pinch (it glowed),
        // the hosting view could not receive the gesture, and the pinch was
        // simply lost (nav zones glowed but would not navigate). Everywhere
        // outside a hotspot the container returns nil and the webview gets
        // the touch exactly as before.
        let box = KadokiSpatialHostView(frame: view.bounds)
        box.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        box.backgroundColor = .clear
        box.hoverHit = { [weak self] pt in
            guard let self = self else { return nil }
            guard KadokiSpatialModel.shared.visible || KadokiVideoModel.shared.visible else { return nil }
            return self.hoverViews.first { !$0.isHidden && $0.frame.contains(pt) }
        }
        box.addSubview(host.view)
        addChild(host)
        view.addSubview(box)
        host.didMove(toParent: self)
        spatialHost = host
        spatialBox = box
        NSLog("[KadokiSpatial] layer installed behind webview")
    }

    // MARK: - Video layer (video Titles: audio mode with a picture)

    private var videoFlatHost: UIHostingController<KadokiVideoFlatView>?

    /// Claims gaze/pinch ONLY over the 3D subtitle panel's screen region.
    final class KadokiStereoHostBox: UIView {
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            let m = KadokiVideoModel.shared
            guard m.visible, m.stereoOn else { return nil }
            let r = m.subHitRect
            guard r.width > 1, r.insetBy(dx: -44, dy: -44).contains(point) else { return nil }
            return super.hitTest(point, with: event)
        }
    }

    private var videoStereoHost: UIHostingController<KadokiVideoStereoView>?
    private var videoFitDone = false

    /// Ask the system to resize the window so its height matches the video's
    /// aspect plus the header + subtitle strip — once per video appearance
    /// (never while the user is mid-resize fight). The user remains free to
    /// resize afterwards.
    @discardableResult
    private func fitWindowToVideo() -> Bool {
        guard let ws = view.window?.windowScene else { NSLog("[KadokiVideo] fit: no windowScene"); return false }
        let b = ws.coordinateSpace.bounds
        NSLog("[KadokiVideo] fit: scene bounds \(Int(b.width))x\(Int(b.height))")
        guard b.width > 300 else { return false }
        var aspect: CGFloat = 16.0 / 9.0
        let vs = KadokiVideoModel.shared.videoSize
        if vs.width > 1, vs.height > 1 { aspect = vs.width / vs.height }
        // top pad 6 (header hidden in cinema) + bottom reserve + slack.
        // "below": the subtitle strip; "overlay": subs sit ON the film.
        let reserve: CGFloat = KadokiVideoModel.shared.subPlacement == "overlay" ? 40 : 170
        let target = CGSize(width: b.width, height: (b.width / aspect) + 6 + reserve + 10)
        guard abs(target.height - b.height) > 40 else { NSLog("[KadokiVideo] fit: already close (target \(Int(target.height)))"); return true }
        ws.requestGeometryUpdate(.Vision(size: target))
        NSLog("[KadokiVideo] window fit: \(Int(b.width))x\(Int(b.height)) → \(Int(target.width))x\(Int(target.height))")
        return true
    }

    /// The video Title plane (KadokiVideoLayer). Same hosting arrangement as
    /// the spatial-card layer — RealityKit content draws over the webview
    /// regardless of UIKit order, so it sits on top — but with NO hotspot box:
    /// the subtitle lives in the DOM below the video rect, so every pinch must
    /// fall through (isUserInteractionEnabled = false end to end). JS
    /// (video-mode.js) hides the plane whenever DOM content must win.
    private func installVideoLayer() {
        guard videoFlatHost == nil else { return }
        // FLAT host UNDER the webview: 2D video obeys UIKit order — the
        // transparent page shows it through, DOM subtitles draw over it.
        let flat = UIHostingController(rootView: KadokiVideoFlatView())
        flat.view.backgroundColor = .clear
        flat.view.isUserInteractionEnabled = false
        flat.view.frame = view.bounds
        flat.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addChild(flat)
        view.insertSubview(flat.view, at: 0)
        flat.didMove(toParent: self)
        videoFlatHost = flat
        // STEREO host ABOVE the webview, inside a REGION-GATED container:
        // gaze/pinch routing follows UIKit hit-testing, so hover for the 3D
        // subtitle words needs an interactive chain — but only over the
        // panel's own rect; everywhere else hitTest returns nil and the
        // webview behaves exactly as before (KadokiSpatialHostView pattern).
        let stereo = UIHostingController(rootView: KadokiVideoStereoView())
        stereo.view.backgroundColor = .clear
        stereo.view.isUserInteractionEnabled = true
        stereo.view.frame = view.bounds
        stereo.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let box = KadokiStereoHostBox(frame: view.bounds)
        box.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        box.backgroundColor = .clear
        box.addSubview(stereo.view)
        addChild(stereo)
        view.addSubview(box)
        stereo.didMove(toParent: self)
        videoStereoHost = stereo
        // Cinema mode: while the plane is up, the page goes transparent (the
        // window reads as glass with the video + subtitle floating on it).
        // Reuses the spatial-cards chrome (same save/restore of webview
        // opacity); video and spatial cards live in different modes, so they
        // never fight over it. Also auto-fits the window height to the movie
        // once per appearance, so the glass is a thin frame around the film
        // instead of a half-empty slab.
        // Subtitle mirror: JS streams the DOM cue panel's rect; snapshot that
        // region (≤5/s) and hand it to the scene attachment.
        NotificationCenter.default.addObserver(forName: Notification.Name("KadokiVideoSubs"), object: nil, queue: .main) { [weak self] note in
            guard let self, let u = note.userInfo else { return }
            let visible = (u["visible"] as? Bool) ?? false
            let rect = CGRect(x: (u["x"] as? Double) ?? 0, y: (u["y"] as? Double) ?? 0,
                              width: (u["w"] as? Double) ?? 0, height: (u["h"] as? Double) ?? 0)
            let m = KadokiVideoModel.shared
            if visible {
                m.subRect = rect
                m.subText = (u["text"] as? String) ?? ""
            } else {
                m.subText = ""; m.subRect = .zero
            }
            NSLog("[KadokiVideo] subs: visible=\(visible) textLen=\(m.subText.count) segs=\(m.subSegs.count) words=\(m.subSegs.filter { ($0.count > 1 ? Int($0[1]) ?? -1 : -1) >= 0 }.count)")
            // Gaze targets for the mirrored subtitle: the WebKit hover glow
            // never shows through RealityKit content (spatial-cards law), so
            // the word rects become UIKit hover views — same pool the card
            // mirror uses. hs_manage=false leaves ownership to spatial-cards
            // (card mode), where its own hotspot pipeline already runs.
            // (Hover-view feed retired for video: flat mode's subtitle is pure
            // DOM with native WebKit glow; 3D words self-hover inside the
            // attachment. Clear anything a previous build left behind.)
            if (u["hs_manage"] as? Bool) ?? true, !self.hoverViews.isEmpty {
                self.syncHoverViews([])
            }
            m.subSegs = (u["segs"] as? [[String]]) ?? []
        }
        NotificationCenter.default.addObserver(forName: Notification.Name("KadokiVideoWordTap"), object: nil, queue: .main) { [weak self] note in
            guard let k = note.userInfo?["k"] as? Int else { return }
            self?.bridge?.triggerWindowJSEvent(eventName: "kadokiVideoWordTap", data: "{\"k\":\(k)}")
        }
        KadokiVideoModel.shared.onVisible = { [weak self] on in
            self?.applySpatialChrome(on)
            guard let self else { return }
            if on {
                // fit returns false when the scene isn't ready — retry on the
                // next visible pulse (the 3s enforcement re-sends).
                if !self.videoFitDone { self.videoFitDone = self.fitWindowToVideo() }
            } else {
                self.videoFitDone = false
            }
        }
        NSLog("[KadokiVideo] layer installed")
    }

    /// The webview's own opacity is part of the hole-punch, so it is restored
    /// the instant the spatial layer lets go — normal card mode never runs with
    /// a transparent webview.
    private var savedWebOpaque: Bool?
    private var savedWebBg: UIColor?

    /// Gaze-glow targets as UIKit views: UIHoverStyle is the very highlight
    /// WebKit's 2D glow uses, so a word lights up as a crisp capsule exactly as
    /// it does on a flat card. The views live in the pass-through container
    /// ABOVE the webview (topmost layer wins the system's hover hit-test), and
    /// because the container's hitTest returns nil the pinch itself still goes
    /// to the webview — the same fall-through already proven with the
    /// RealityKit planes. Empty list (feature off / layer hidden) = no views.
    private var hoverViews: [KadokiHoverTargetView] = []
    private func syncHoverViews(_ rects: [CGRect]) {
        guard let box = spatialBox else { return }
        while hoverViews.count < rects.count {
            let v = KadokiHoverTargetView(frame: .zero)
            v.onPinch = { pt in
                NSLog("[KadokiSpatial] pinch on hover target (\(Int(pt.x)),\(Int(pt.y)))")
                KadokiSpatialModel.shared.onTap?(pt)
            }
            box.addSubview(v)
            hoverViews.append(v)
        }
        for (i, v) in hoverViews.enumerated() {
            if i < rects.count {
                v.isHidden = false
                v.frame = rects[i].insetBy(dx: -3, dy: 0)
            } else {
                v.isHidden = true
            }
        }
        if hoverViews.count > 64 && rects.isEmpty {   // a long subtitle once; don't keep 240 views forever
            hoverViews.forEach { $0.removeFromSuperview() }
            hoverViews.removeAll()
        }
    }

    private func applySpatialChrome(_ on: Bool) {
        installSpatialLayer()                 // idempotent; covers a late bridge
        installVideoLayer()
        // Container ON TOP of the webview: the hover targets are the topmost
        // layer, so they win the gaze hit-test. (Tried and dead: the layer
        // UNDER the webview's scroll view with no mirror — the 3D content
        // still drew over the real page; the subtitle vanished.)
        if let b = spatialBox, view.subviews.last !== b { view.bringSubviewToFront(b) }
        guard let wv = findWebView() else {
            NSLog("[KadokiSpatial] chrome on=\(on) — NO WEBVIEW FOUND, page will paint over the layer")
            return
        }
        if on {
            if savedWebOpaque == nil {
                savedWebOpaque = wv.isOpaque
                savedWebBg = wv.backgroundColor
            }
            wv.isOpaque = false
            wv.backgroundColor = .clear
            wv.scrollView.backgroundColor = .clear
        } else {
            wv.isOpaque = savedWebOpaque ?? true
            wv.backgroundColor = savedWebBg
            wv.scrollView.backgroundColor = savedWebBg
            savedWebOpaque = nil
            savedWebBg = nil
        }
        NSLog("[KadokiSpatial] chrome on=\(on) host=\(spatialHost?.view.superview != nil) onTop=\(view.subviews.last === spatialBox)")
    }

    /// bridge?.webView is nil early in the lifecycle, so fall back to walking
    /// the hierarchy — this must not silently no-op.
    private func findWebView() -> WKWebView? {
        if let w = self.bridge?.webView { return w }
        func walk(_ v: UIView) -> WKWebView? {
            if let w = v as? WKWebView { return w }
            for sub in v.subviews { if let w = walk(sub) { return w } }
            return nil
        }
        return walk(view)
    }

    // Hardware keyboard on visionOS: the system claims arrow keys (focus
    // navigation / scrolling) before the page sees them, so they are taken
    // as UIKeyCommands here — priority over system behaviour — and replayed
    // into the page as the same document keydown the nav zones synthesize
    // (app.js: ArrowLeft/ArrowRight = prev/next card, Space = replay). Stand
    // down while a text field has focus.
    override var canBecomeFirstResponder: Bool { true }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }
    override var keyCommands: [UIKeyCommand]? {
        if KadokiTransportModel.shared.typing { return nil }
        let keys: [(String, String)] = [
            (UIKeyCommand.inputLeftArrow, "ArrowLeft"),
            (UIKeyCommand.inputRightArrow, "ArrowRight"),
            (" ", "Space"),
            (UIKeyCommand.inputDownArrow, "Space"),   // ↓ = replay, same as Space
        ]
        return keys.map { input, code in
            let c = UIKeyCommand(title: "", action: #selector(kadokiHardwareKey(_:)), input: input,
                                 modifierFlags: [], propertyList: code)
            c.wantsPriorityOverSystemBehavior = true
            return c
        }
    }
    @objc private func kadokiHardwareKey(_ cmd: UIKeyCommand) {
        guard let code = cmd.propertyList as? String else { return }
        bridge?.triggerWindowJSEvent(eventName: "kadokiKey", data: "{\"code\":\"\(code)\"}")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        installSpatialLayer()
        installVideoLayer()
        // Native glass transport BELOW the window. Taps round-trip through JS
        // (same handlers as the in-window controls); state flows back via
        // NotificationCenter from the audio plugin + JS tpState.
        // contentAlignment .top hangs the bar FULLY below the window, in EVERY
        // mode. Audio mode used to switch to .center to tuck the bar into the
        // window's dead black space, but that overlapped the bottom of the audio
        // view and sat on top of its own controls (the 章の要約 button). Nothing
        // in the window is worth occluding for a few points of height.
        let orn = UIHostingOrnament(sceneAnchor: .bottom, contentAlignment: .top) { KadokiTransportView() }
        tpOrnament = orn
        // The dictionary side panel (real depth, beside the window). Docked
        // placement is computed per-lookup in placeDictOrnament(); undock
        // (rectangle.on.rectangle) moves it to a freely-placeable window.
        let dOrn = UIHostingOrnament(sceneAnchor: .trailing, contentAlignment: .leading) { KadokiDictPanelView() }
        dictOrnament = dOrn
        applyOrnaments()
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiUiMode"), object: nil, queue: .main) { [weak self] note in
            guard let mode = note.userInfo?["mode"] as? String else { return }
            // Mode now only drives which selector is highlighted — the bar's
            // placement no longer moves with it (see the .top note above).
            KadokiTransportModel.shared.mode = mode
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictPanel"), object: nil, queue: .main) { [weak self] note in
            let m = KadokiDictModel.shared
            m.visible = (note.userInfo?["show"] as? Bool) ?? false
            if let html = note.userInfo?["html"] as? String {
                KadokiDictWeb.shared.setContent(css: note.userInfo?["css"] as? String, html: html)
            }
            guard let self = self, m.visible, m.docked else { return }
            if let yf = note.userInfo?["yf"] as? Double {
                // Dock beside the looked-up line — clamp so the ~620pt panel
                // stays within the window's vertical span.
                let h = self.view.window?.windowScene?.coordinateSpace.bounds.height ?? 860
                let half: CGFloat = 330
                let cy = min(max(CGFloat(yf) * h, half), max(h - half, half))
                self.dictAnchorY = h > 0 ? cy / h : 0.5
            }
            if let xf = note.userInfo?["xf"] as? Double {
                // Near-side docking with a wide dead zone: only a clearly
                // edge-of-window lookup moves the panel across; mid-screen
                // lookups keep whichever side it's on (no ping-pong).
                if xf < 0.32 { m.dockLeading = true }
                else if xf > 0.68 { m.dockLeading = false }
            }
            self.placeDictOrnament()
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictUndock"), object: nil, queue: .main) { _ in
            guard KadokiDictModel.shared.docked else { return }
            // `docked` flips to false only when the window scene actually
            // CONNECTS (KadokiDictSceneDelegate) — if activation fails, the
            // ornament panel stays, instead of the dictionary vanishing.
            let act = NSUserActivity(activityType: "com.helica1.yama.dictwin")
            UIApplication.shared.requestSceneSessionActivation(nil, userActivity: act, options: nil) { err in
                NSLog("[KadokiDict] undock scene activation failed: \(err.localizedDescription)")
            }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictRedock"), object: nil, queue: .main) { _ in
            KadokiDictModel.shared.docked = true
            if let s = KadokiDictSceneDelegate.session {
                UIApplication.shared.requestSceneSessionDestruction(s, options: nil, errorHandler: nil)
            }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictAction"), object: nil, queue: .main) { [weak self] note in
            guard let i = note.userInfo?["i"] as? Int else { return }
            self?.bridge?.triggerWindowJSEvent(eventName: "kadokiDictAction", data: "{\"i\": \(i)}")
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictDock"), object: nil, queue: .main) { [weak self] _ in
            self?.placeDictOrnament()
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiPanelWindow"), object: nil, queue: .main) { [weak self] note in
            let action = (note.userInfo?["action"] as? String) ?? "open"
            let kind = (note.userInfo?["kind"] as? String) ?? "timeline"
            switch action {
            case "open":
                // Focus the existing window for this kind rather than stacking
                // duplicates — requestSceneSessionActivation with a session
                // reuses it; nil creates one.
                let act = NSUserActivity(activityType: "com.helica1.yama.panelwin")
                act.userInfo = ["kind": kind]
                act.targetContentIdentifier = kind
                UIApplication.shared.requestSceneSessionActivation(
                    KadokiPanelSceneDelegate.sessions[kind], userActivity: act, options: nil) { err in
                    NSLog("[KadokiPanel] activation failed for \(kind): \(err.localizedDescription)")
                }
            case "close":
                // Belt and braces: destroying the MAIN window's session here would
                // close the book (and, with the panel already going away, take the
                // whole app with it). A panel may only ever destroy its own.
                if let sess = KadokiPanelSceneDelegate.sessions[kind],
                   sess !== KadokiMainSceneDelegate.currentScene?.session {
                    UIApplication.shared.requestSceneSessionDestruction(sess, options: nil, errorHandler: nil)
                } else {
                    // No window ever opened (or already gone) — still tell the
                    // main webview so it re-renders the panel in-window.
                    self?.bridge?.triggerWindowJSEvent(eventName: "kadokiPanelClosed", data: "{\"kind\":\"\(kind)\"}")
                }
            case "post":
                KadokiPanelHost.shared.post(kind: kind, msg: (note.userInfo?["msg"] as? String) ?? "")
            default: break
            }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiPanelClosed"), object: nil, queue: .main) { [weak self] note in
            let kind = (note.userInfo?["kind"] as? String) ?? ""
            KadokiPanelHost.shared.drop(kind: kind)
            self?.bridge?.triggerWindowJSEvent(eventName: "kadokiPanelClosed", data: "{\"kind\":\"\(kind)\"}")
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiTransportTap"), object: nil, queue: .main) { [weak self] note in
            guard let action = note.userInfo?["action"] as? String else { return }
            self?.bridge?.triggerWindowJSEvent(eventName: "kadokiTransport", data: "{\"action\":\"\(action)\"}")
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiAudioState"), object: nil, queue: .main) { note in
            if let p = note.userInfo?["playing"] as? Bool { KadokiTransportModel.shared.playing = p }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiDictMode"), object: nil, queue: .main) { note in
            if let d = note.userInfo?["on"] as? Bool { KadokiTransportModel.shared.dictOn = d }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiTyping"), object: nil, queue: .main) { note in
            if let d = note.userInfo?["on"] as? Bool { KadokiTransportModel.shared.typing = d }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiSpatialMode"), object: nil, queue: .main) { note in
            if let d = note.userInfo?["on"] as? Bool { KadokiTransportModel.shared.spatialOn = d }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiVideoMode"), object: nil, queue: .main) { note in
            if let d = note.userInfo?["on"] as? Bool { KadokiTransportModel.shared.videoOn = d }
        })
        tpObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("KadokiAudioProgress"), object: nil, queue: .main) { note in
            guard let p = note.userInfo?["pos"] as? Int, let dd = note.userInfo?["dur"] as? Int else { return }
            let m = KadokiTransportModel.shared
            // per-second throttle: the row shows whole seconds
            if p / 1000 != m.positionMs / 1000 { m.positionMs = p }
            if dd != m.durationMs { m.durationMs = dd }
        })
    }
    #endif
}
