#if os(visionOS)
import SwiftUI
import RealityKit
import AVFoundation
import Combine

/// visionOS video Titles: the picture layer.
///
/// BackgroundAudioPlugin's video engine (KadokiVideoPlayer / AVPlayer) owns
/// playback; this model mirrors what the display layer needs — the player,
/// the DOM anchor rect JS streams via BackgroundAudio.videoSurface, the
/// subtitle state, and the AI-3D toggle.
///
/// TWO RENDER PATHS (the load-bearing design decision):
///  • FLAT: a plain 2D SwiftUI/AVPlayerLayer view. 2D content sits EXACTLY on
///    the window plane, so the subtitle can stay pure DOM with native WebKit
///    gaze glow — no mirrors, no parallax, no "different plane" artifacts.
///    (Measured: RealityKit content in this hierarchy renders ~6cm in FRONT
///    of the window plane regardless of z or the depth-frame alignment — 2D
///    is the only way to be truly coplanar.)
///  • AI-3D: RealityView + the GridPlayer stereo pipeline (Depth Anything →
///    Metal warp → per-eye packed texture through Stereo.usda) on a curved
///    panel. The subtitle is NATIVE SwiftUI text in a scene attachment in
///    front of the panel (structurally un-occludable); the DOM twin is
///    invisible but laid out, so its word rects still drive the UIKit gaze
///    hover targets and tap replay.
@MainActor
final class KadokiVideoModel: ObservableObject {
    static let shared = KadokiVideoModel()

    @Published var player: AVPlayer?
    @Published var frame: CGRect = .zero       // CSS points, window coordinates
    @Published var visible = false
    @Published var stereoOn = false
    @Published var videoSize: CGSize = .zero   // natural size (0×0 until loaded)
    /// Bumped when async work (material load) finishes and the view must re-run.
    @Published var generation = 0

    /// What JS last asked for. `visible` = wantsVisible && player — recomputed
    /// on BOTH clocks (videoSurface sends and player adoption), so no ordering
    /// leaves the plane hidden.
    var wantsVisible = false

    /// The engine, weakly: BackgroundAudioPlugin owns its lifetime.
    private(set) weak var videoRef: KadokiVideoPlayer?

    /// Metres per SwiftUI point, measured off the live scene (1/1360 fallback).
    var mpp: Float = 1.0 / 1360.0

    /// One-shot migration: earlier sessions were tuned against a pipeline
    /// with real defects (inverted/strided DA3, 0.35 temporal blend, no
    /// MetalFX) — reset ONCE to the reference recipe (3D_QUALITY_HANDOFF.md).
    static let tuningMigrated: Bool = {
        let d = UserDefaults.standard
        if d.bool(forKey: "kadoki.video.tuned.v2") { return true }
        d.set(true, forKey: "kadoki.video.tuned.v2")
        d.set(0.03, forKey: "kadoki.video.strength")
        d.set(0.45, forKey: "kadoki.video.convergence")
        return true
    }()

    @Published var strength: Double = { _ = KadokiVideoModel.tuningMigrated
        return UserDefaults.standard.object(forKey: "kadoki.video.strength") == nil
        ? 0.03 : UserDefaults.standard.double(forKey: "kadoki.video.strength") }() {
        didSet {
            UserDefaults.standard.set(strength, forKey: "kadoki.video.strength")
            KadokiVideoStereo.shared.renderer?.strength = Float(strength)
        }
    }
    @Published var convergence: Double = { _ = KadokiVideoModel.tuningMigrated
        return UserDefaults.standard.object(forKey: "kadoki.video.convergence") == nil
        ? 0.45 : UserDefaults.standard.double(forKey: "kadoki.video.convergence") }() {
        didSet {
            UserDefaults.standard.set(convergence, forKey: "kadoki.video.convergence")
            KadokiVideoStereo.shared.renderer?.convergence = Float(convergence)
        }
    }
    /// Depth model: "small" (V2 Small — the reference) or "base" (DA3 Base,
    /// finer depth, ~3× weights). Switching rebuilds the pipeline live.
    @Published var depthModel: String = UserDefaults.standard.string(forKey: "kadoki.video.depthmodel") ?? "small" {
        didSet {
            UserDefaults.standard.set(depthModel, forKey: "kadoki.video.depthmodel")
            KadokiVideoStereo.shared.modelChanged()
            bump()
        }
    }
    /// Stereo renderer: "splat" (forward-splat + z-buffer + background fill,
    /// the StereoCrafter-style pipeline) or "classic" (reference gather).
    @Published var renderMode: String = UserDefaults.standard.string(forKey: "kadoki.video.render") ?? "splat" {
        didSet {
            UserDefaults.standard.set(renderMode, forKey: "kadoki.video.render")
            KadokiVideoStereo.shared.renderer?.useSplat = (renderMode == "splat")
        }
    }
    /// Subtitle placement: "below" the frame (its own strip) or "overlay" —
    /// movie-style on the lower part of the picture.
    @Published var subPlacement: String = UserDefaults.standard.string(forKey: "kadoki.video.subplace") ?? "below" {
        didSet { UserDefaults.standard.set(subPlacement, forKey: "kadoki.video.subplace") }
    }
    /// MainViewController hooks this to the webview chrome (transparent page
    /// while the video plane is up — "cinema mode").
    var onVisible: ((Bool) -> Void)?

    /// Startup re-place nudge: on DEVICE the subtitle attachment can begin
    /// its life depth-composited behind the film until any window move
    /// re-evaluates the scene (not reproducible in the simulator). A window
    /// move heals it by CHANGING the transform — so the first seconds of a
    /// stereo scene schedule tiny z jiggles (±1mm) that force the same
    /// re-evaluation without user action.
    @Published var placeNudge = 0
    func scheduleStartupNudges() {
        for (i, d) in [0.5, 1.2, 2.2, 4.0, 7.0].enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) { [weak self] in
                guard let self, self.visible, self.stereoOn else { return }
                self.placeNudge = i + 1
            }
        }
    }
    /// Series navigator state (pushed from JS with each videoSurface send).
    @Published var episodeIndex = 0     // 1-based; 0 = not a series
    @Published var episodeCount = 0
    /// On-screen estimate of the 3D subtitle panel (UIKit points) — the
    /// stereo host's hit-test region: gaze/pinch inside it reaches the
    /// SwiftUI words, everything else falls through to the webview.
    var subHitRect: CGRect = .zero
    /// Subtitle mirror state: the DOM cue panel's rect + its plain text.
    /// Rendered natively (SwiftUI) wherever the DOM itself can't win: the 3D
    /// scene attachment, the flat-overlay panel, and the card-mode attachment.
    @Published var subText: String = ""
    @Published var subRect: CGRect = .zero
    /// Word segmentation of subText for the 3D panel: [text, kwordIndex] pairs
    /// (kwordIndex "-1" = particle/non-word). Tappable words hover-glow inside
    /// the attachment (the window-plane glow layers are BEHIND the popped-out
    /// 3D film, so the panel must light itself) and forward taps to JS.
    @Published var subSegs: [[String]] = []
    /// Depth→disparity curve exponent (γ<1 expands near/mid separation;
    /// the linear map reads flat/diorama-like — pipeline notes §4).
    @Published var depthGamma: Double = UserDefaults.standard.object(forKey: "kadoki.video.gamma") == nil
        ? 0.85 : UserDefaults.standard.double(forKey: "kadoki.video.gamma") {
        didSet {
            UserDefaults.standard.set(depthGamma, forKey: "kadoki.video.gamma")
            KadokiVideoStereo.shared.renderer?.depthGamma = Float(depthGamma)
        }
    }
    /// Bilateral edge sigma: smaller = depth hugs image edges harder.
    @Published var edgeSigma: Double = UserDefaults.standard.object(forKey: "kadoki.video.edge") == nil
        ? 0.08 : UserDefaults.standard.double(forKey: "kadoki.video.edge") {
        didSet {
            UserDefaults.standard.set(edgeSigma, forKey: "kadoki.video.edge")
            KadokiVideoStereo.shared.renderer?.edgeSigma = Float(edgeSigma)
        }
    }
    /// Subtitle size in points (ornament settings slider).
    @Published var subSize: Double = UserDefaults.standard.object(forKey: "kadoki.video.subsize") == nil
        ? 30 : UserDefaults.standard.double(forKey: "kadoki.video.subsize") {
        didSet { UserDefaults.standard.set(subSize, forKey: "kadoki.video.subsize") }
    }

    func applyVisibility() {
        let v = wantsVisible && player != nil
        if v != visible {
            visible = v
            onVisible?(v)
        }
        NSLog("[KadokiVideo] visibility: wants=\(wantsVisible) player=\(player != nil) → \(v)")
    }

    func adopt(_ v: KadokiVideoPlayer) {
        videoRef = v
        player = v.avPlayer
        videoSize = v.videoSize
        v.onVideoSize = { [weak self] sz in self?.videoSize = sz }
        applyVisibility()
    }

    func clear() {
        videoRef = nil
        player = nil
        visible = false
        subText = ""
        subRect = .zero
        KadokiVideoStereo.shared.teardown()
    }

    func bump() { generation &+= 1 }

    /// Aspect-fit of the video inside the JS anchor rect — the single source
    /// of truth for where the picture draws (view + videoSurface response).
    func containedFrame() -> CGRect {
        let f = frame
        guard f.width > 1, f.height > 1 else { return f }
        var aspect = CGFloat(16.0 / 9.0)
        if videoSize.width > 1, videoSize.height > 1 { aspect = videoSize.width / videoSize.height }
        var w = f.width, h = f.height
        if w / h > aspect { w = h * aspect } else { h = w / aspect }
        return CGRect(x: f.midX - w / 2, y: f.midY - h / 2, width: w, height: h)
    }
}

/// Stereo machinery holder — survives view rebuilds.
@MainActor
final class KadokiVideoStereo {
    static let shared = KadokiVideoStereo()

    var renderer: StereoRenderer?
    var material: ShaderGraphMaterial?
    private var materialLoading = false
    private weak var attachedItem: AVPlayerItem?
    private var builtKind = ""

    func ensureMaterial() {
        guard material == nil, !materialLoading else { return }
        materialLoading = true
        Task { @MainActor in
            self.material = try? await ShaderGraphMaterial(
                named: "/Root/StereoMaterial", from: "Stereo.usda", in: nil)
            self.materialLoading = false
            if self.material == nil { NSLog("[KadokiVideo] Stereo.usda material FAILED to load") }
            KadokiVideoModel.shared.bump()
        }
    }

    func modelChanged() { teardown() }

    func ensureRenderer(item: AVPlayerItem?) {
        let kind = KadokiVideoModel.shared.depthModel
        if renderer != nil && kind != builtKind { teardown() }
        if renderer == nil {
            builtKind = kind
            let estimator = try? DepthEstimator(kind: kind)
            if estimator == nil { NSLog("[KadokiVideo] DepthEstimator init failed (model missing?) kind=\(kind)") }
            renderer = try? StereoRenderer(estimator: estimator)
            if renderer == nil { NSLog("[KadokiVideo] StereoRenderer init failed") }
            renderer?.strength = Float(KadokiVideoModel.shared.strength)
            renderer?.convergence = Float(KadokiVideoModel.shared.convergence)
            renderer?.useSplat = (KadokiVideoModel.shared.renderMode == "splat")
            renderer?.depthGamma = Float(KadokiVideoModel.shared.depthGamma)
            renderer?.edgeSigma = Float(KadokiVideoModel.shared.edgeSigma)
            // Reference recipe: MetalFX 2× spatial upscale on the single film
            // (no-op where MetalFX is unavailable, e.g. the simulator).
            renderer?.upscaleFactor = 2
        }
        if let item, attachedItem !== item {
            renderer?.attach(to: item)
            attachedItem = item
            NSLog("[KadokiVideo] stereo: renderer attached to item")
        } else if item == nil {
            NSLog("[KadokiVideo] stereo: ensureRenderer called with NO item (videoRef gone?) — no frames will flow")
        }
    }

    func detachOnly() {
        renderer?.detach()
        renderer?.updateSubscription = nil
        attachedItem = nil
    }

    func teardown() {
        detachOnly()
        renderer = nil
    }
}

/// Plain 2D video: AVPlayerLayer in a UIView — the flat path's whole point is
/// that 2D content is exactly coplanar with the window/webview.
final class KadokiPlayerLayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct KadokiPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    func makeUIView(context: Context) -> KadokiPlayerLayerUIView {
        let v = KadokiPlayerLayerUIView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        v.isUserInteractionEnabled = false
        return v
    }
    func updateUIView(_ v: KadokiPlayerLayerUIView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
    }
}

/// Simple centered flow layout: words wrap like text lines. (SwiftUI has no
/// built-in flow container; Text can't give per-word hover targets.)
struct KadokiFlowLayout: Layout {
    var spacing: CGFloat = 0
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? 800
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0, usedW: CGFloat = 0
        for v in subviews {
            let sz = v.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > maxW {
                usedW = max(usedW, x)
                x = 0; y += lineH + lineSpacing; lineH = 0
            }
            x += sz.width + spacing
            lineH = max(lineH, sz.height)
        }
        usedW = max(usedW, x)
        return CGSize(width: min(usedW, maxW), height: y + lineH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxW = bounds.width
        // First pass: break into lines so each can be centered.
        var lines: [[(Int, CGSize)]] = [[]]
        var x: CGFloat = 0
        for (i, v) in subviews.enumerated() {
            let sz = v.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > maxW {
                lines.append([]); x = 0
            }
            lines[lines.count - 1].append((i, sz))
            x += sz.width + spacing
        }
        var y = bounds.minY
        for line in lines {
            let lineW = line.reduce(CGFloat(0)) { $0 + $1.1.width } + spacing * CGFloat(max(0, line.count - 1))
            let lineH = line.reduce(CGFloat(0)) { max($0, $1.1.height) }
            var lx = bounds.minX + (maxW - lineW) / 2
            for (i, sz) in line {
                subviews[i].place(at: CGPoint(x: lx, y: y + (lineH - sz.height) / 2),
                                  proposal: ProposedViewSize(sz))
                lx += sz.width + spacing
            }
            y += lineH + lineSpacing
        }
    }
}

/// The native subtitle panel (3D scene attachment + card-mode attachment).
/// With word segments, each word is its own hover-glowing, tappable view —
/// the window-plane glow layers are BEHIND the popped-out 3D film, so the
/// panel must light itself; taps post the word index back to JS, which runs
/// the normal dictionary flow on the DOM twin.
struct KadokiSubsPanel: View {
    let text: String
    var segs: [[String]] = []
    let translucent: Bool
    let maxWidth: CGFloat
    var fontSize: Double = 30

    private var font: Font { .system(size: fontSize, weight: .medium, design: .serif) }

    var body: some View {
        Group {
            if segs.isEmpty {
                Text(text)
                    .font(font)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .lineSpacing(6)
                    .allowsHitTesting(false)
            } else {
                KadokiFlowLayout() {
                    ForEach(Array(segs.enumerated()), id: \.offset) { _, seg in
                        let t = seg.count > 0 ? seg[0] : ""
                        let k = seg.count > 1 ? Int(seg[1]) ?? -1 : -1
                        if k >= 0 {
                            Text(t)
                                .font(font)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 3)
                                .padding(.vertical, 1)
                                // Faint chip: shows the word is a target (and
                                // is the diagnostic for segmentation reaching
                                // the panel — chips without glow = hover
                                // routing issue, no chips = no segments).
                                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.10)))
                                .contentShape(RoundedRectangle(cornerRadius: 8))
                                .hoverEffect(.highlight)
                                .onTapGesture {
                                    NotificationCenter.default.post(
                                        name: Notification.Name("KadokiVideoWordTap"),
                                        object: nil, userInfo: ["k": k])
                                }
                        } else {
                            Text(t)
                                .font(font)
                                .foregroundStyle(.white)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 18)
            .fill(Color.black.opacity(translucent ? 0.42 : 0.80)))
        .frame(maxWidth: maxWidth)
    }
}

/// FLAT host content — lives UNDER the webview (2D video obeys UIKit order,
/// the transparent cinema page shows it through, and the DOM subtitle draws
/// on top with native WebKit gaze glow).
struct KadokiVideoFlatView: View {
    @ObservedObject private var m = KadokiVideoModel.shared
    var body: some View {
        GeometryReader { geo in
            if m.visible, !m.stereoOn, let player = m.player {
                flatBody(geo: geo, player: player)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func flatBody(geo: GeometryProxy, player: AVPlayer) -> some View {
        // The host view sits UNDER the webview: the transparent cinema page
        // shows the video through, and the DOM subtitle (below OR overlaid)
        // draws on top of it with native WebKit gaze glow — no mirrors at all.
        let f = m.frame
        KadokiPlayerLayerView(player: player)
            .frame(width: max(f.width, 1), height: max(f.height, 1))
            .position(x: f.midX, y: f.midY)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
    }

}

/// STEREO host content — lives ABOVE the webview: input routing follows UIKit
/// hit-testing (spatial-cards law #1), so the subtitle attachment's word
/// hover/tap only receives gaze from an above-webview host. The host UIView
/// is non-interactive (webview gets all non-attachment pinches); attachments
/// bypass that flag via the system's own routing.
struct KadokiVideoStereoView: View {
    @ObservedObject private var m = KadokiVideoModel.shared

    /// Recess of the curved panel's base behind the (lifted) content plane.
    private let setback: Float = 0.015
    /// Total horizontal arc of the curved (AI-3D) panel — reference 0.85 rad.
    private let curveArc: Float = 0.85

    var body: some View {
        GeometryReader { geo in
            if m.visible, m.stereoOn, m.player != nil {
                stereoBody(geo: geo)
            }
        }
        .ignoresSafeArea()
    }

    @ViewBuilder
    private func stereoBody(geo: GeometryProxy) -> some View {
        RealityView { content, attachments in
            measureScale(content)
            // This closure runs for a FRESH RealityView scene: any surviving
            // renderer subscription belongs to a destroyed scene and would
            // never tick again (the 3D-toggle white-screen bug) — drop it so
            // syncStereo resubscribes to THIS scene.
            KadokiVideoStereo.shared.renderer?.updateSubscription = nil
            m.scheduleStartupNudges()
            let plane = ModelEntity(mesh: StereoPanelMeshes.curved(arc: curveArc))
            plane.name = "videoplane"
            applyMaterial(plane)
            content.add(plane)
            place(content, plane, geo.size)
            placeSubs(content, attachments, geo.size)
        } update: { content, attachments in
            guard let plane = content.entities.first(where: { $0.name == "videoplane" }) as? ModelEntity else { return }
            _ = m.generation   // async material load re-runs us
            applyMaterial(plane)
            syncStereo(content, plane, geo.size)
            place(content, plane, geo.size)
            placeSubs(content, attachments, geo.size)
        } attachments: {
            Attachment(id: "subs") {
                if !m.subText.isEmpty, m.subRect.width > 1 {
                    KadokiSubsPanel(text: m.subText,
                                    segs: m.subSegs,
                                    translucent: m.subPlacement == "overlay",
                                    maxWidth: max(m.subRect.width + 120, 420),
                                    fontSize: m.subSize)
                }
            }
        }
        .frame(width: geo.size.width, height: geo.size.height)
        // Depth budget for the curved bow + the popped-out stereo content.
        .frame(depth: 260, alignment: .center)
    }

    private func applyMaterial(_ plane: ModelEntity) {
        let s = KadokiVideoStereo.shared
        s.ensureMaterial()
        s.ensureRenderer(item: m.videoRef?.item)
        if let mat = s.material, s.renderer != nil {
            if !(plane.model?.materials.first is ShaderGraphMaterial) {
                plane.model?.materials = [mat]
            }
            return
        }
        // Material/renderer not ready: show the flat video on the panel so
        // the picture never blanks while 3D spins up.
        if !(plane.model?.materials.first is VideoMaterial), let p = m.player {
            plane.model?.materials = [VideoMaterial(avPlayer: p)]
        }
    }

    /// Per-frame drive: tick the renderer and rebind the packed texture inside
    /// the scene tick (the ImmersiveView pattern).
    private func syncStereo(_ content: RealityViewContent, _ plane: ModelEntity, _ size: CGSize) {
        let s = KadokiVideoStereo.shared
        guard let renderer = s.renderer else { return }
        let r = m.containedFrame()
        renderer.viewSize = CGSize(width: r.width, height: r.height)
        if renderer.updateSubscription == nil {
            NSLog("[KadokiVideo] stereo: subscribing scene tick (viewSize=\(renderer.viewSize))")
            renderer.updateSubscription = content.subscribe(to: SceneEvents.Update.self) { [weak plane] _ in
                Task { @MainActor in
                    guard let plane, let r = KadokiVideoStereo.shared.renderer else { return }
                    r.tick()
                    if let packed = r.packedTexture,
                       var mat = plane.model?.materials.first as? ShaderGraphMaterial {
                        try? mat.setParameter(name: "packedTex", value: .textureResource(packed))
                        plane.model?.materials = [mat]
                    }
                }
            }
        }
    }

    // MARK: geometry

    private func measureScale(_ content: RealityViewContent) {
        let a = content.convert(Point3D(x: 0, y: 0, z: 0), from: .local, to: .scene)
        let b = content.convert(Point3D(x: 0, y: 1000, z: 0), from: .local, to: .scene)
        let d = abs(b.y - a.y) / 1000
        if d.isFinite && d > 0.0001 && d < 0.01 { m.mpp = Float(d) }
    }

    /// CSS points (top-left origin, y down) → metres from view centre, y up.
    /// The curved panel is compensated (×0.94, base recessed by half its bow)
    /// so its APPARENT footprint stays near the layout slot despite the
    /// platform's forward lift of RealityKit content.
    private static var lastPlaceLog: Double = 0
    private func place(_ content: RealityViewContent, _ plane: ModelEntity, _ size: CGSize) {
        measureScale(content)
        let now = CACurrentMediaTime()
        if now - Self.lastPlaceLog > 2 {
            Self.lastPlaceLog = now
            NSLog("[KadokiVideo] place: view=\(Int(size.width))x\(Int(size.height)) anchor=\(m.frame) contained=\(m.containedFrame()) mpp=\(m.mpp)")
        }
        let r = m.containedFrame()
        let w = max(Float(r.width) * m.mpp, 0.001) * 0.94
        let h = max(Float(r.height) * m.mpp, 0.001) * 0.94
        let bow = 0.1082 * w   // arc 0.85: radius·(1−cos(arc/2)) per unit width
        var t = plane.transform
        t.scale = [w, h, w]
        t.translation = SIMD3<Float>(
            Float(r.midX - size.width / 2) * m.mpp,
            Float(size.height / 2 - r.midY) * m.mpp,
            -setback - bow * 0.5)
        plane.transform = t
    }

    /// Subtitle attachment: GLUED to the film — centered under the plane's
    /// real (compensated) bottom edge, just 2.5cm in front of the panel base.
    /// (The old DOM-rect + 6cm placement read as "too far below and too far
    /// in front": the DOM strip sits below the film's visual bottom, and 6cm
    /// competed with the stereo pop-out.)
    private func placeSubs(_ content: RealityViewContent, _ attachments: RealityViewAttachments, _ size: CGSize) {
        guard let a = attachments.entity(for: "subs") else { return }
        if a.parent == nil { content.add(a) }
        guard m.subRect.width > 1, !m.subText.isEmpty else { a.isEnabled = false; return }
        a.isEnabled = true
        // STABLE INPUTS ONLY. The previous placement derived z from
        // visualBounds, which is unreliable mid-layout — the panel's depth
        // wobbled per cue/update and long cues flipped BEHIND the film. All
        // sizes now come from the DOM rect (subRect) + fixed paddings, and z
        // clears the curve's bow at the panel's own half-width with margin.
        let r = m.containedFrame()
        let cx = Float(r.midX - size.width / 2) * m.mpp
        let centerY = Float(size.height / 2 - r.midY) * m.mpp
        let hScaled = Float(r.height) * m.mpp * 0.94
        let wScaled = max(Float(r.width) * m.mpp, 0.001) * 0.94
        let bow = 0.1082 * wScaled
        let planeBottom = centerY - hScaled / 2
        // Panel size estimate from the DOM twin (+panel chrome): text width
        // + horizontal padding 52pt + backing padding; height + vertical 26pt.
        let panelW = (Float(m.subRect.width) + 60) * m.mpp
        let panelH = (Float(m.subRect.height) + 30) * m.mpp
        var y: Float
        if m.subPlacement == "overlay" {
            y = planeBottom + 0.02 + panelH / 2
        } else {
            y = planeBottom - 0.015 - panelH / 2
            let windowBottom = -Float(size.height / 2) * m.mpp
            if y - panelH / 2 < windowBottom + 0.012 {
                y = windowBottom + 0.012 + panelH / 2
            }
        }
        // Bow clearance at the panel's half-width (+15% safety), floor 1.5cm
        // in front of the window plane — the panel can NEVER lose the depth
        // contest to the film, for any cue length or window size.
        let radius = 0.5 / sin(curveArc / 2)
        let uMax = min(0.5, (panelW * 0.575) / max(wScaled, 0.001))
        let bowAtPanel = radius * (1 - cos(uMax * curveArc)) * wScaled
        var z = max((-setback - bow * 0.5) + bowAtPanel + 0.02, 0.015)
        z += Float(m.placeNudge % 2) * 0.001   // startup jiggle (see scheduleStartupNudges)
        a.position = SIMD3<Float>(cx, y, z)
        // Hit-test region estimate (same stable inputs, generous margins).
        let wPt = CGFloat(panelW / m.mpp), hPt = CGFloat(panelH / m.mpp)
        let cxPt = size.width / 2 + CGFloat(cx / m.mpp)
        let cyPt = size.height / 2 - CGFloat(y / m.mpp)
        m.subHitRect = CGRect(x: cxPt - wPt / 2, y: cyPt - hPt / 2, width: wPt, height: hPt)
    }
}
#endif
