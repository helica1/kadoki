import Foundation
import Capacitor
import UIKit
import WebKit

#if os(visionOS)
import SwiftUI
import RealityKit
import ImageIO
import Spatial
import UniformTypeIdentifiers
#endif

/**
 * SpatialImage — visionOS-only. Presents a card-mode picture as a RealityKit
 * SPATIAL SCENE (visionOS 26's generative-depth "Spatial Scene", the same
 * thing Photos uses) rendered BEHIND the transparent Capacitor webview, so a
 * subs2srs movie frame gains real parallax as you lean.
 *
 * ── WHY IT LIVES BEHIND THE WEBVIEW ──────────────────────────────────────
 * WebKit cannot composite RealityKit content inline — there is no CSS or
 * WebXR path to ImagePresentationComponent. So the picture has to be hoisted
 * out of the DOM. Rather than move card mode wholesale into SwiftUI (which
 * would duplicate dictionary lookup, furigana, the inSubtitleSafeZone scroll
 * carve-out, swipe-up-to-Anki and every place-saving guard), we punch a hole:
 * the page goes transparent, the DOM <img> goes to opacity 0, and this layer
 * draws the same picture natively at the <img>'s exact rect. Everything else
 * in card mode keeps working because nothing else moved.
 *
 * ── WHY THE LAYER PAINTS ITS OWN BACKDROP ────────────────────────────────
 * Making the page transparent means the page's black no longer paints — every
 * part of the window that ISN'T the picture would fall through to the
 * system's window glass, which is a startling whole-app appearance change for
 * a feature that only concerns one <img>. So the layer fills itself with the
 * page's own background colour (JS reads the computed value and passes it),
 * and the net visual is "identical to before, except the picture now has
 * depth". The backdrop is drawn ONLY while a picture is presented; hide()
 * puts the page's own black back in charge.
 *
 * ── COST ─────────────────────────────────────────────────────────────────
 * generate() is a multi-second on-device generative pass with NO serialization
 * API — nothing to cache on disk, so a cold launch always regenerates. Hence
 * the in-process LRU here and the settle-gating + lookahead in
 * spatial-cards.js: never generate for a card the user is swiping past.
 *
 * JS: SpatialImage.available() -> { available }
 *     SpatialImage.present({ image, key?, x, y, width, height, spatial?, z?, backdrop? })
 *     SpatialImage.prepare({ image, key, spatial? })   // generate + cache, don't show
 *     SpatialImage.hide()
 *     SpatialImage.clearCache()
 */

#if os(visionOS)

/// Shared state the SwiftUI layer observes. Single instance — there is only
/// ever one card picture on screen.
@MainActor
final class KadokiSpatialModel: ObservableObject {
    static let shared = KadokiSpatialModel()

    @Published var component: ImagePresentationComponent?
    /// The DOM <img> rect in CSS points, in the webview's coordinate space.
    @Published var frame: CGRect = .zero
    /// Fires whenever the layer takes or gives up the picture. MainViewController
    /// uses it to flip the webview's opacity — the hole only exists while a
    /// picture is actually up, so normal card mode is untouched.
    var onVisible: ((Bool) -> Void)?
    @Published var visible = false { didSet { if oldValue != visible { onVisible?(visible) } } }
    /// The page's own background colour. The page goes transparent so this
    /// layer can be seen, so without repainting it every part of the window
    /// that isn't the picture would fall through to the system's window glass
    /// (which reads as a blurred view of whatever is behind the app).
    @Published var backdropColor: UIColor = .black
    /// A snapshot of the WEBVIEW'S OWN PIXELS, drawn back on top of the
    /// spatial scene. The depth-bearing layer composites in front of the
    /// webview it lives in, whatever z its entities sit at — measured across
    /// several builds: the subtitle and nav zones vanished under the picture
    /// every time. There is no way to get WebKit's pixels over RealityKit
    /// content from the UIKit side, so we carry them over ourselves:
    /// WKWebView.takeSnapshot of the (transparent) page gives the UI with
    /// transparent gaps, and this image sits in front of the scene inside the
    /// same SwiftUI tree, where 2D-over-3D ordering does work. Pixel-exact —
    /// furigana, dictionary highlights, the chrome — with no DOM duplication.
    /// Taps never touch it: the layer doesn't hit-test, so they land on the
    /// real DOM elements sitting in exactly the same place underneath.
    @Published var overlay: UIImage?
    @Published var overlayRect: CGRect = .zero
    /// Gaze targets. visionOS draws its hover glow for web content ITSELF, on
    /// top of the webview — it is not part of WebKit's rendering, so it never
    /// appears in the snapshot, and under the depth layer it is invisible. We
    /// rebuild it: one invisible RealityKit plane per word/zone (rects sent by
    /// JS each refresh) carrying HoverEffectComponent, so the system glows
    /// them on gaze exactly as it did the DOM elements. A pinch on one is
    /// forwarded back to the DOM as a click at the same point (onTap).
    @Published var hotspots: [CGRect] = [] { didSet { onHotspots?(hotspots) } }
    /// MainViewController mirrors `hotspots` into UIKit views carrying
    /// UIHoverStyle — the same system highlight WebKit draws for 2D content,
    /// crisp at the word rect. (The earlier RealityKit hover planes glowed
    /// only as a soft haze — a 1%-opacity plane gives the highlight almost no
    /// surface to light — and were removed once the UIKit targets shipped.)
    var onHotspots: (([CGRect]) -> Void)?
    var onTap: ((CGPoint) -> Void)?
    // Tried and dead (2026-08-22): the layer UNDER the webview's scroll view
    // with no mirror — visionOS still drew the 3D content over the real page
    // even with the picture recessed behind the plane (subtitle vanished). The
    // snapshot mirror is the design.

    fileprivate var entity: Entity?
    /// Metres per CSS point, MEASURED from the scene (RealityViewContent.convert)
    /// rather than assumed. The 1360 guess was close but not exact: the
    /// overlay copy and the backdrop scaled relative to the DOM, and the error
    /// grew toward the window corners (the COPY pill showed twice, offset).
    fileprivate var mpp: Float = 1.0 / 1360
    /// Bumped by every present(). ImagePresentationComponent does NOT re-present
    /// when swapped on a live entity (the 3D→3D cut kept showing the first
    /// card's scene while audio and subtitle advanced), so the layer replaces
    /// the entity whenever this changes.
    @Published var generation = 0
    fileprivate var placedGeneration = -1

    private var cache: [String: ImagePresentationComponent] = [:]
    private var cacheOrder: [String] = []
    private let cacheLimit = 8

    func cached(_ key: String) -> ImagePresentationComponent? {
        guard let c = cache[key] else { return nil }
        cacheOrder.removeAll { $0 == key }
        cacheOrder.append(key)
        return c
    }

    func peek(_ key: String) -> Bool { cache[key] != nil }

    func store(_ key: String, _ comp: ImagePresentationComponent) {
        if cache[key] == nil { cacheOrder.append(key) }
        cache[key] = comp
        while cacheOrder.count > cacheLimit {
            cache.removeValue(forKey: cacheOrder.removeFirst())
        }
    }

    func clearCache() {
        cache.removeAll()
        cacheOrder.removeAll()
    }
}

/// Inserted at index 0 of MainViewController's view, so it sits behind the
/// webview. Never hit-tests — every gesture in card mode belongs to the DOM
/// on top (swipe next/prev, send-to-Anki, dict taps).
///
/// ── THE DEPTH BUDGET (the thing that made this work) ─────────────────────
/// A RealityView in a plain visionOS window gets almost NO depth. Geometry at
/// z=0 renders; anything even a centimetre behind is clipped away, and
/// ImagePresentationComponent — which is depth by definition — rendered
/// nothing at all. `.frame(depth:)` is how a view asks for a depth region, and
/// with one the component presents correctly. No volumetric window required.
///
/// Everything then lives BEHIND the window plane, because the webview and all
/// its chrome (subtitle, transport, nav zones) draw at z=0 on top of this
/// layer. A picture floated forward of that plane swallows the UI.
struct KadokiSpatialLayer: View {
    @ObservedObject private var m = KadokiSpatialModel.shared

    /// How far into the window the picture sits, in metres. Must exceed the
    /// spatial scene's own forward relief or the nearest parts of the scene
    /// poke through the subtitle.
    private let setback: Float = 0.04
    /// Backdrop sits further back again, but well inside the depth frame.
    /// Just behind the picture, NOT far back: at 13cm the square backdrop and
    /// the window's own rounded frame separated visibly in parallax and read as
    /// two superimposed frames.
    private let backdropZ: Float = -0.055

    var body: some View {
        GeometryReader { geo in
            if m.visible, m.component != nil {
                RealityView { content, attachments in
                    // The backdrop is RealityKit geometry, not a SwiftUI Color:
                    // a sibling SwiftUI view has its own depth handling and got
                    // clipped when pushed back, whereas a plane inside the depth
                    // frame is ordered by plain 3D occlusion.
                    measureScale(content)
                    // Oversized: it sits behind the plane, so perspective shrinks
                    // it on screen; a margin keeps the corners covered (the DOM
                    // was peeking out at the corners at exact size).
                    let bw = Float(geo.size.width) * m.mpp * 1.4
                    let bh = Float(geo.size.height) * m.mpp * 1.4
                    let back = ModelEntity(
                        mesh: .generatePlane(width: max(bw, 0.1), height: max(bh, 0.1)),
                        materials: [UnlitMaterial(color: m.backdropColor)])
                    back.position = SIMD3<Float>(0, 0, backdropZ)
                    content.add(back)

                    let e = Entity()
                    content.add(e)
                    m.entity = e
                    m.placedGeneration = m.generation
                    place(content, e, geo.size)
                    placeOverlay(content, attachments, geo.size)
                } update: { content, attachments in
                    if m.placedGeneration != m.generation {
                        m.entity?.removeFromParent()
                        let e = Entity()
                        content.add(e)
                        m.entity = e
                        m.placedGeneration = m.generation
                    }
                    if let e = m.entity { place(content, e, geo.size) }
                    placeOverlay(content, attachments, geo.size)
                } attachments: {
                    // The webview's own pixels, carried INTO the RealityKit scene
                    // as an attachment so RealityKit depth-sorts them against the
                    // picture itself. A plain SwiftUI Image layered after the
                    // RealityView in the 2D tree never made it in front of the
                    // scene — 3D content wins over 2D siblings however the stack
                    // is ordered. Attachments are the sanctioned way to put 2D
                    // content in front of 3D content.
                    Attachment(id: "ui") {
                        if let img = m.overlay, m.overlayRect.width > 1 {
                            ZStack(alignment: .topLeading) {
                                Image(uiImage: img)
                                    .resizable()
                                    .interpolation(.high)
                                    .frame(width: m.overlayRect.width, height: m.overlayRect.height)
                                    // A picture of the UI, never the UI — the
                                    // ray passes through to the hotspots below
                                    // or, where there is none, to the webview.
                                    .allowsHitTesting(false)
                            }
                            .frame(width: m.overlayRect.width, height: m.overlayRect.height, alignment: .topLeading)
                        }
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
                // DEPTH GEOMETRY (measured the hard way): the region is
                // SYMMETRIC about the layer's origin, and `alignment` moves
                // the origin relative to the window plane — .back put it half
                // the depth IN FRONT of the window, so at 500pt the whole layer
                // floated ~18cm out (occluding the dictionary ornament, reading
                // magnified, and the UI copy sat ahead of the real DOM → the
                // "doubled UI"); shrinking the depth then culled the picture
                // and backdrop, which sat outside the small forward region.
                // .center puts the origin ON the plane: the UI copy is coplanar
                // with the DOM, the picture is genuinely behind, and the region
                // only needs to reach the backdrop either way (±85pt here).
                .frame(depth: 170, alignment: .center)
            }
        }
        .ignoresSafeArea()
    }

    /// Put the UI attachment exactly over its screen rect, in front of the
    /// picture. Attachments are laid out at their SwiftUI point size, so only
    /// the centre needs converting (points from top-left, y down → metres from
    /// the view centre, y up). Forward of the picture by more than the scene's
    /// own relief so the UI wins everywhere, including over foreground subjects.
    private func placeOverlay(_ content: RealityViewContent, _ attachments: RealityViewAttachments, _ size: CGSize) {
        guard let a = attachments.entity(for: "ui") else { return }
        if a.parent == nil { content.add(a) }
        let r = m.overlayRect
        // z = 0: the UI sits ON the window plane, where every other piece of
        // the app's UI lives, and the picture is recessed behind it like a
        // view through the window. Floating the UI 4cm forward (the previous
        // value) put subtitle and picture on visibly different planes and made
        // refocusing between them a chore.
        a.position = SIMD3<Float>(
            Float(r.midX - size.width / 2) * m.mpp,
            Float(size.height / 2 - r.midY) * m.mpp,
            0)
    }

    /// Size and position the presented picture to the DOM rect. RealityKit
    /// works in metres from the view's CENTRE with y up; CSS gives us points
    /// from the top-left with y down.
    /// Measure metres-per-point off the live scene; falls back to the 1360 guess.
    private func measureScale(_ content: RealityViewContent) {
        let a = content.convert(Point3D(x: 0, y: 0, z: 0), from: .local, to: .scene)
        let b = content.convert(Point3D(x: 0, y: 1000, z: 0), from: .local, to: .scene)
        let d = abs(b.y - a.y) / 1000
        if d.isFinite && d > 0.0001 && d < 0.01 { m.mpp = d }
    }

    private func place(_ content: RealityViewContent, _ entity: Entity, _ size: CGSize) {
        guard var comp = m.component else { return }
        measureScale(content)
        let metres = Float(m.frame.height) * m.mpp
        // Recessed `setback` behind the window plane, the picture reads
        // smaller by perspective — ~(D + setback)/D at a typical ~0.75m
        // viewing distance — which showed as a visible resize during the
        // flat→3D cross-fade. Scale it back up so the two match.
        comp.screenHeight = metres * (1 + setback / 0.75)
        entity.components.set(comp)
        entity.position = SIMD3<Float>(
            Float(m.frame.midX - size.width / 2) * m.mpp,
            Float(size.height / 2 - m.frame.midY) * m.mpp,
            -setback)
    }
}

/// An ALTERNATIVE presentation: the same picture in a real volumetric scene
/// (UISceneSession.Role.windowApplicationVolumetric), floating free of the card
/// window. Built while diagnosing why the in-window path drew nothing; the real
/// cause turned out to be the missing depth budget, so nothing calls this now.
/// Kept because it is a working second option if a free-floating picture is
/// ever wanted — reach it via SpatialImage.openVolume().
struct KadokiSpatialVolumeView: View {
    @ObservedObject private var m = KadokiSpatialModel.shared

    var body: some View {
        RealityView { content in
            let e = Entity()
            if var c = m.component {
                c.screenHeight = 0.35
                e.components.set(c)
            }
            content.add(e)
            NSLog("[KadokiSpatial] VOLUME content built component=\(m.component != nil)")
        } update: { content in
            guard var c = m.component, let e = content.entities.first else { return }
            c.screenHeight = 0.35
            e.components.set(c)
        }
    }
}

#endif

@objc(SpatialImagePlugin)
public class SpatialImagePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "SpatialImagePlugin"
    public let jsName = "SpatialImage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshOverlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isCached", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCache", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        #if os(visionOS)
        Task { @MainActor in
            KadokiSpatialModel.shared.onTap = { [weak self] pt in
                NSLog("[KadokiSpatial] forward tap → JS (\(pt.x),\(pt.y)) bridge=\(self?.bridge != nil)")
                self?.bridge?.triggerWindowJSEvent(
                    eventName: "kadokiSpatialTap",
                    data: "{\"x\":\(Double(pt.x)),\"y\":\(Double(pt.y))}")
            }
        }
        #endif
    }

    /// Resolves rather than rejects off visionOS so the JS side can feature-test
    /// with one call instead of catching a "plugin not implemented" bridge error.
    @objc func available(_ call: CAPPluginCall) {
        #if os(visionOS)
        call.resolve(["available": true])
        #else
        call.resolve(["available": false])
        #endif
    }

    @objc func present(_ call: CAPPluginCall) {
        #if os(visionOS)
        guard let src = Self.decode(call) else {
            call.reject("image (base64, no data: prefix) required"); return
        }
        let rect = CGRect(x: call.getDouble("x") ?? 0,
                          y: call.getDouble("y") ?? 0,
                          width: call.getDouble("width") ?? 0,
                          height: call.getDouble("height") ?? 0)
        guard rect.width > 1, rect.height > 1 else {
            call.reject("width/height required (the <img> rect in CSS points)"); return
        }
        let wantSpatial = call.getBool("spatial") ?? true
        let pad = call.getDouble("pad") ?? 0.12
        let key = call.getString("key") ?? ""
        let backdrop = Self.color(call.getString("backdrop"))
        let t0 = CFAbsoluteTimeGetCurrent()

        Task { @MainActor in
            let m = KadokiSpatialModel.shared
            let built = await Self.build(src: src, spatial: wantSpatial, key: key, pad: pad)
            guard let comp = built.component else {
                call.reject("image unusable: \(built.reason)"); return
            }
            m.component = comp
            m.generation &+= 1
            m.frame = rect
            m.backdropColor = backdrop
            // Seed the overlay with the screen AS IT IS NOW, before the layer
            // shows. The first visible frame of the layer is then identical to
            // what was on screen (the flat card, opaque page and all), and the
            // hand-over is a true cross-fade driven by the DOM image fading out
            // under subsequent snapshots — instead of the scene popping in bare
            // for the ~100ms the first async snapshot used to take.
            if let wv = self.bridge?.webView {
                let r0 = wv.bounds
                let cfg = WKSnapshotConfiguration()
                cfg.rect = r0
                cfg.snapshotWidth = NSNumber(value: Double(r0.width) * 2)
                cfg.afterScreenUpdates = false
                let img: UIImage? = await withCheckedContinuation { cont in
                    wv.takeSnapshot(with: cfg) { img, _ in cont.resume(returning: img) }
                }
                if let img = img { m.overlay = img; m.overlayRect = r0 }
            }
            m.visible = true

            let ms = Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)
            NSLog("[KadokiSpatial] present key=\(key) spatial=\(built.generated) cached=\(built.cached) \(ms)ms")
            var out: [String: Any] = ["generated": built.generated,
                                      "cached": built.cached, "ms": ms,
                                      "generation": m.generation]
            if !built.reason.isEmpty { out["fallbackReason"] = built.reason }
            call.resolve(out)
        }
        #else
        call.reject("visionOS only")
        #endif
    }

    /// Lookahead: run the generative pass for a card the user has NOT arrived
    /// at yet and park it in the cache, so landing on it is instant. Presents
    /// nothing and never disturbs what is on screen.
    @objc func prepare(_ call: CAPPluginCall) {
        #if os(visionOS)
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key required"); return
        }
        guard let src = Self.decode(call) else {
            call.reject("image (base64) required"); return
        }
        let wantSpatial = call.getBool("spatial") ?? true
        let pad = call.getDouble("pad") ?? 0.12
        Task { @MainActor in
            let built = await Self.build(src: src, spatial: wantSpatial, key: key, pad: pad)
            call.resolve(["generated": built.generated, "cached": built.cached])
        }
        #else
        call.resolve(["generated": false, "cached": false])
        #endif
    }

    /// Is this picture's generated scene already in the LRU? Lets JS cut
    /// straight from one 3D card to the next instead of dropping to flat.
    @objc func isCached(_ call: CAPPluginCall) {
        #if os(visionOS)
        let key = call.getString("key") ?? ""
        let spatial = call.getBool("spatial") ?? true
        let pad = call.getDouble("pad") ?? 0.12
        Task { @MainActor in
            let ck = key.isEmpty ? "" : "\(key)|\(spatial ? "3d" : "mono")|\(Int(pad * 100))"
            call.resolve(["cached": !ck.isEmpty && KadokiSpatialModel.shared.peek(ck)])
        }
        #else
        call.resolve(["cached": false])
        #endif
    }

    /// Re-snapshot the webview and redraw its pixels over the spatial scene.
    /// JS calls this on every DOM change while a picture is up (debounced), so
    /// the overlay tracks the subtitle, highlights, timer and chrome.
    @objc func refreshOverlay(_ call: CAPPluginCall) {
        #if os(visionOS)
        let rect = CGRect(x: call.getDouble("x") ?? 0, y: call.getDouble("y") ?? 0,
                          width: call.getDouble("width") ?? 0, height: call.getDouble("height") ?? 0)
        guard rect.width > 1, rect.height > 1 else { call.reject("rect required"); return }
        let scale = call.getDouble("scale") ?? 2.0
        // Gaze targets travel with every refresh: [[x,y,w,h], ...] in CSS points.
        var hot: [CGRect] = []
        if let arr = call.getArray("hot") as? [[Double]] {
            for q in arr where q.count >= 4 && q[2] > 1 && q[3] > 1 {
                hot.append(CGRect(x: q[0], y: q[1], width: q[2], height: q[3]))
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let wv = self?.bridge?.webView else { call.reject("no webview"); return }
            let m = KadokiSpatialModel.shared
            guard m.visible else { call.resolve(["skipped": true]); return }
            if m.hotspots.count != hot.count { NSLog("[KadokiSpatial] hotspots=\(hot.count)") }
            m.hotspots = hot
            let cfg = WKSnapshotConfiguration()
            cfg.rect = rect
            cfg.snapshotWidth = NSNumber(value: Double(rect.width) * scale)
            cfg.afterScreenUpdates = true
            wv.takeSnapshot(with: cfg) { img, err in
                if let img = img {
                    // Drop a stale frame that lands after the picture was hidden
                    // (a swipe mid-snapshot) — it must not reappear over the
                    // next card.
                    if m.visible {
                        m.overlay = img
                        m.overlayRect = rect
                    }
                    call.resolve(["ok": true, "w": img.size.width, "h": img.size.height,
                                  "scale": img.scale])
                } else {
                    call.reject("snapshot failed: \(err?.localizedDescription ?? "?")")
                }
            }
        }
        #else
        call.resolve()
        #endif
    }

    /// Opens the alternative volumetric presentation (KadokiSpatialVolumeView).
    /// Unused by the card-mode flow, which draws in-window.
    @objc func openVolume(_ call: CAPPluginCall) {
        #if os(visionOS)
        Task { @MainActor in
            let act = NSUserActivity(activityType: "com.helica1.yama.spatialvol")
            let req = UISceneSessionActivationRequest(role: .windowApplicationVolumetric,
                                                      userActivity: act, options: nil)
            UIApplication.shared.activateSceneSession(for: req) { err in
                NSLog("[KadokiSpatial] volume activation FAILED: \(err.localizedDescription)")
            }
            NSLog("[KadokiSpatial] volume activation requested")
            call.resolve()
        }
        #else
        call.resolve()
        #endif
    }

    @objc func hide(_ call: CAPPluginCall) {
        #if os(visionOS)
        Task { @MainActor in
            KadokiSpatialModel.shared.visible = false
            KadokiSpatialModel.shared.overlay = nil
            KadokiSpatialModel.shared.hotspots = []
            call.resolve()
        }
        #else
        call.resolve()
        #endif
    }

    @objc func clearCache(_ call: CAPPluginCall) {
        #if os(visionOS)
        Task { @MainActor in
            KadokiSpatialModel.shared.clearCache()
            call.resolve()
        }
        #else
        call.resolve()
        #endif
    }

    // MARK: - Shared build path

    #if os(visionOS)

    private static func decode(_ call: CAPPluginCall) -> CGImageSource? {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(src) > 0 else { return nil }
        return src
    }

    /// Parses "rgb(12, 12, 12)" / "rgba(...)" / "#0c0c0c" as handed over by
    /// getComputedStyle. Anything unrecognised falls back to black, which is
    /// what the page uses anyway.
    private static func color(_ css: String?) -> UIColor {
        guard let css = css?.trimmingCharacters(in: .whitespaces), !css.isEmpty else { return .black }
        if css.hasPrefix("#") {
            var hex = String(css.dropFirst())
            if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
            guard hex.count >= 6, let v = UInt32(hex.prefix(6), radix: 16) else { return .black }
            return UIColor(red: CGFloat((v >> 16) & 0xff) / 255,
                           green: CGFloat((v >> 8) & 0xff) / 255,
                           blue: CGFloat(v & 0xff) / 255, alpha: 1)
        }
        let nums = css.components(separatedBy: CharacterSet(charactersIn: "rgba(), "))
            .filter { !$0.isEmpty }
            .compactMap { Double($0) }
        guard nums.count >= 3 else { return .black }
        return UIColor(red: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255, alpha: 1)
    }

    /// Prepares the bytes for generate(). Two jobs:
    ///
    /// PAD — visionOS crops into a spatial scene when it presents it, to give
    /// itself parallax headroom (Photos does the same). There is no API to
    /// control that crop, so the framing you get back is tighter than the frame
    /// you put in. Adding a margin first means the crop eats the MARGIN instead
    /// of the picture, and you see the whole subtitle frame.
    ///
    /// FLOOR — generate() rejects anything under 320px on its short side, and
    /// subs2srs routinely emits 480x270. Without the upscale the most common
    /// deck for this feature would never get depth at all. The generator does
    /// not care that the pixels were interpolated.
    ///
    /// Padding is applied first, so it counts toward clearing the floor, and it
    /// is proportional, so the 1:3..3:1 aspect limit is preserved.
    private static func prepared(_ src: CGImageSource, pad: Double) -> CGImageSource? {
        guard let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let w = Double(img.width), h = Double(img.height)
        guard w > 0, h > 0 else { return nil }
        let padX = (w * pad).rounded(), padY = (h * pad).rounded()
        let boxW = w + 2 * padX, boxH = h + 2 * padY
        let short = min(boxW, boxH)
        let scale = short < 320 ? 320.0 / short : 1.0
        let cw = Int((boxW * scale).rounded(.up)), ch = Int((boxH * scale).rounded(.up))
        guard scale != 1.0 || pad > 0 else { return nil }   // nothing to do
        guard let ctx = CGContext(data: nil, width: cw, height: ch,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(UIColor.black.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: cw, height: ch))
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: padX * scale, y: padY * scale,
                                 width: w * scale, height: h * scale))
        guard let out = ctx.makeImage() else { return nil }
        let buf = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buf, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(dest, out, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        NSLog("[KadokiSpatial] prepared \(Int(w))x\(Int(h)) -> \(cw)x\(ch) (pad \(pad), scale \(scale))")
        return CGImageSourceCreateWithData(buf as CFData, nil)
    }

    private struct Built {
        var component: ImagePresentationComponent?
        var generated = false
        var cached = false
        var reason = ""
    }

    @MainActor
    private static func build(src: CGImageSource, spatial: Bool, key: String,
                              pad: Double) async -> Built {
        let m = KadokiSpatialModel.shared
        let cacheKey = key.isEmpty ? "" : "\(key)|\(spatial ? "3d" : "mono")|\(Int(pad * 100))"
        var out = Built()
        if !cacheKey.isEmpty, let hit = m.cached(cacheKey) {
            out.component = hit
            out.generated = hit.desiredViewingMode == .spatial3D
            out.cached = true
        }
        if out.component != nil {
            // Cache hit still needs the diagnostic sidecar built below, so fall
            // through rather than returning early.
        } else if spatial {
            let source = prepared(src, pad: pad) ?? src
            do {
                let s3 = try await ImagePresentationComponent.Spatial3DImage(imageSource: source)
                try await s3.generate()
                var c = ImagePresentationComponent(spatial3DImage: s3)
                c.desiredViewingMode = .spatial3D
                out.component = c
                out.generated = true
            } catch {
                // Still possible after upscaling: aspect ratio outside 1:3..3:1,
                // or an image the generator simply can't read depth from.
                out.reason = "\(error)"
                NSLog("[KadokiSpatial] generate failed, falling back to mono: \(out.reason)")
            }
        }
        if out.component == nil {
            do {
                var c = try await ImagePresentationComponent(imageSource: src)
                c.desiredViewingMode = .mono
                out.component = c
            } catch {
                out.reason = "\(error)"
                return out
            }
        }
        if !cacheKey.isEmpty, let c = out.component { m.store(cacheKey, c) }
        return out
    }

    #endif
}
