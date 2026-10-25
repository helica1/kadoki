import Foundation
import Network
import Capacitor
import UIKit
import AVFoundation
import AVKit
import Accelerate
import MediaPlayer

// Native position tap for the Apple Watch live-subtitle stream (Phase B):
// WatchBridgePlugin observes this instead of a new timer of its own, so the
// watch's live view rides the SAME cadence the lock screen / cue tracking
// already use — no duplicate polling.
extension Notification.Name {
    static let kadokiPositionTick = Notification.Name("kadokiPositionTick")
    // Watch → phone remote play/pause toggle (Phase B tap gesture). Posted by
    // WatchBridgePlugin when the watch's live view is tapped.
    static let kadokiRemoteToggleRequest = Notification.Name("kadokiRemoteToggleRequest")
    // Watch → phone subtitle paging (Phase B left/right swipe). userInfo
    // ["dir": ±1]. Relayed to JS through the SAME "remoteCommand" channel the
    // lock-screen ⏮⏭ buttons use — one cue-jump path, one staleness guard.
    static let kadokiRemoteCueJumpRequest = Notification.Name("kadokiRemoteCueJumpRequest")
}

/**
 * BackgroundAudioPlugin — iOS port of the Android BackgroundAudio plugin.
 *
 * Provides single-instance audiobook playback that survives background +
 * lock screen, populates Now Playing info (lock-screen + Control Center),
 * and accepts hardware/lock-screen transport commands.
 *
 * JS API surface matches the Android plugin exactly so reading-mode.js
 * and friends are platform-agnostic:
 *   play({url, startMs, rate}) → starts a new file at startMs
 *   pause() / resume() / stop()
 *   seek({ms})
 *   setRate({rate})       — 0.5 .. 2.0 (AVAudioPlayer cap)
 *   getState()            → {playing, ready, positionMs, durationMs}
 *   setMetadata({title, subtitle})
 *
 * Events emitted (via notifyListeners):
 *   "state"    {playing: Bool}
 *   "position" {positionMs, durationMs, playing}  ~150 ms cadence while playing
 *   "ended"    {} — natural end-of-file
 *   "error"    {message: String}
 *
 * Architectural notes:
 *   • iOS doesn't need an explicit foreground service like Android. The
 *     UIBackgroundModes:audio entry in Info.plist + AVAudioSession.playback
 *     category is sufficient to keep audio running when backgrounded.
 *   • Position updates use a Timer at 150 ms (matches the Android polling
 *     cadence so the cue-highlight UX feels identical on both platforms).
 *   • AVAudioPlayer requires enableRate=true BEFORE play() for setRate to
 *     work afterward — set during initial load.
 */
@objc(BackgroundAudioPlugin)
public class BackgroundAudioPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "BackgroundAudioPlugin"
    public let jsName = "BackgroundAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scrubPrime",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scrubBegin",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scrub",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scrubEnd",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEngine",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLastSavedPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleArt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setChapterRepeat",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToNextChapter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceModel",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeDuration",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showRoutePicker",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "powerState",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "safeAreaInsets",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tpState",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictPanel",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "panelWindow",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "handoffPeers",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "handoffGet",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "handoffServeResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSavedPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "videoSurface",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "videoSubs",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "videoFrame",         returnType: CAPPluginReturnPromise),
    ]

    /// Current video frame as a JPEG data URI — the Anki card's "what was on
    /// screen when this line was spoken" picture. Rejects when no video is
    /// playing (audio-only Titles fall back to the cover image in JS).
    @objc func videoFrame(_ call: CAPPluginCall) {
        let maxDim = call.getDouble("maxDim") ?? 1280
        DispatchQueue.main.async { [weak self] in
            guard let vp = self?.player as? KadokiVideoPlayer,
                  let item = vp.avPlayer.currentItem else {
                call.reject("no video playing")
                return
            }
            let gen = AVAssetImageGenerator(asset: item.asset)
            gen.appliesPreferredTrackTransform = true
            // Tight tolerance so the frame matches the subtitle being sent,
            // not the nearest keyframe seconds away.
            gen.requestedTimeToleranceBefore = CMTime(seconds: 0.15, preferredTimescale: 600)
            gen.requestedTimeToleranceAfter  = CMTime(seconds: 0.15, preferredTimescale: 600)
            gen.maximumSize = CGSize(width: maxDim, height: maxDim)
            // The async generator is iOS 16+/visionOS-only; video Titles only
            // exist on visionOS today, so older iOS just reports unsupported.
            if #available(iOS 16.0, *) {
                gen.generateCGImageAsynchronously(for: vp.avPlayer.currentTime()) { cg, _, err in
                    guard let cg = cg else {
                        call.reject("frame grab failed: \(err?.localizedDescription ?? "unknown")")
                        return
                    }
                    guard let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.85) else {
                        call.reject("jpeg encode failed")
                        return
                    }
                    call.resolve(["dataUri": "data:image/jpeg;base64," + jpg.base64EncodedString()])
                }
            } else {
                call.reject("frame grab needs iOS 16+")
            }
        }
    }

    /// visionOS video Titles: the DOM subtitle's rect (CSS points). Native
    /// snapshots that region and mirrors it into the RealityKit scene as an
    /// attachment IN FRONT of the video plane — structurally impossible for
    /// the video to occlude, while the DOM original underneath keeps gaze
    /// glow + dictionary taps.
    @objc func videoSubs(_ call: CAPPluginCall) {
        #if os(visionOS)
        var spots: [[Double]] = []
        if let arr = call.getArray("hotspots") {
            for it in arr {
                if let d = it as? [String: Any],
                   let hx = d["x"] as? Double, let hy = d["y"] as? Double,
                   let hw = d["w"] as? Double, let hh = d["h"] as? Double {
                    spots.append([hx, hy, hw, hh])
                }
            }
        }
        NotificationCenter.default.post(name: Notification.Name("KadokiVideoSubs"), object: nil, userInfo: [
            "x": call.getDouble("x") ?? 0, "y": call.getDouble("y") ?? 0,
            "w": call.getDouble("w") ?? 0, "h": call.getDouble("h") ?? 0,
            "visible": call.getBool("visible") ?? false,
            "hotspots": spots,
            "hs_manage": call.getBool("hsManage") ?? true,
            "text": call.getString("text") ?? "",
            "segs": (call.getArray("segs") as? [[String]]) ?? [],
            // Previous cue (2026-08-30): shown above the current line, its
            // own rect for an independent panel size/position estimate.
            "prevText": call.getString("prevText") ?? "",
            "prevSegs": (call.getArray("prevSegs") as? [[String]]) ?? [],
            "prevX": call.getDouble("prevX") ?? 0, "prevY": call.getDouble("prevY") ?? 0,
            "prevW": call.getDouble("prevW") ?? 0, "prevH": call.getDouble("prevH") ?? 0,
        ])
        #endif
        call.resolve()
    }

    /// visionOS video Titles: JS streams the DOM anchor's rect (CSS points)
    /// plus visibility + AI-3D state; the RealityKit plane in KadokiVideoLayer
    /// follows. No-op (active:false) off visionOS.
    @objc func videoSurface(_ call: CAPPluginCall) {
        #if os(visionOS)
        let visible = call.getBool("visible") ?? false
        let x = call.getDouble("x") ?? 0, y = call.getDouble("y") ?? 0
        let w = call.getDouble("w") ?? 0, h = call.getDouble("h") ?? 0
        let stereo = call.getBool("stereo") ?? false
        let active = self.player is KadokiVideoPlayer
        Task { @MainActor in
            let m = KadokiVideoModel.shared
            if visible { m.frame = CGRect(x: x, y: y, width: w, height: h) }
            m.stereoOn = stereo
            m.wantsVisible = visible
            m.episodeIndex = call.getInt("epIndex") ?? 0
            m.episodeCount = call.getInt("epCount") ?? 0
            m.applyVisibility()
            // Re-assert the cinema chrome on every send while visible — other
            // features (spatial cards) share the webview-transparency toggle
            // and can restore an opaque page underneath us.
            if m.visible { m.onVisible?(true) }
            // Resolve with the AUTHORITATIVE contained video rect (true
            // aspect from the loaded track) so JS can pin the subtitle panel
            // exactly under the frame — its own 16:9 guess misplaces the
            // panel for any other aspect, and the plane draws over the DOM.
            let r = m.containedFrame()
            call.resolve([
                "active": active,
                "frameX": r.origin.x, "frameY": r.origin.y,
                "frameW": r.size.width, "frameH": r.size.height,
                "subPlacement": m.subPlacement,
                "subSize": m.subSize,
            ])
        }
        #elseif os(iOS)
        // iOS flat path: AVPlayerLayer view under the webview, driven by the
        // same JS stream. Resolve with the contained rect for the DOM subs.
        let visible = call.getBool("visible") ?? false
        // "cinema" = still conceptually in the video layout even though the
        // PICTURE is momentarily hidden (a modal/menu covering it) — keeps
        // the webview transparent+black in that case instead of reverting to
        // its pre-cinema background (that revert was the "screen goes white
        // behind the hamburger menu" bug: it fell back to the page's default,
        // e.g. plain white, since nothing else painted over it).
        let cinema = call.getBool("cinema") ?? visible
        let x = call.getDouble("x") ?? 0, y = call.getDouble("y") ?? 0
        let w = call.getDouble("w") ?? 0, h = call.getDouble("h") ?? 0
        let landscape = call.getBool("landscape") ?? false
        let active = self.player is KadokiVideoPlayer
        DispatchQueue.main.async {
            let host = KadokiVideoIOSHost.shared
            if let vp = self.player as? KadokiVideoPlayer { host.adopt(vp.avPlayer) }
            let r = host.update(frame: CGRect(x: x, y: y, width: w, height: h),
                                visible: visible && active, cinema: cinema && active, landscape: landscape)
            call.resolve([
                "active": active,
                "frameX": r.origin.x, "frameY": r.origin.y,
                "frameW": r.size.width, "frameH": r.size.height,
                "subPlacement": "below",
                "subSize": 24,
            ])
        }
        #else
        call.resolve(["active": false])
        #endif
    }

    // Handoff apply: the device-local durable floor must not out-vote a
    // position the user just adopted from another device (it's forward-only
    // by design — restore would keep THIS device's old spot). Clearing it
    // lets the freshly-written prefs position rule the next restore.
    @objc func clearSavedPosition(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        d.removeObject(forKey: Self.posKeyUrl)
        d.removeObject(forKey: Self.posKeyMs)
        d.removeObject(forKey: Self.posKeyTs)
        call.resolve()
    }

    // MARK: - Handoff (iPhone ⇄ Vision Pro LAN sync)

    // Continuously-running Bonjour browser; results cached for handoffPeers.
    private static var handoffBrowser: NWBrowser?
    private static var handoffFound: [String] = []
    private static let handoffLock = NSLock()
    private static func ensureBrowser() {
        guard handoffBrowser == nil else { return }
        let b = NWBrowser(for: .bonjour(type: "_kadoki._tcp", domain: nil), using: NWParameters())
        b.browseResultsChangedHandler = { results, _ in
            var names: [String] = []
            for r in results {
                if case let .service(name, _, _, _) = r.endpoint { names.append(name) }
            }
            handoffLock.lock(); handoffFound = names; handoffLock.unlock()
        }
        b.start(queue: DispatchQueue.global(qos: .utility))
        handoffBrowser = b
    }

    @objc func handoffPeers(_ call: CAPPluginCall) {
        Self.ensureBrowser()
        // First call after boot: give the browser a beat to find peers.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.2) {
            Self.handoffLock.lock()
            var names = Self.handoffFound
            Self.handoffLock.unlock()
            // Never hand back OURSELVES (same-name self-sync loop).
            #if os(visionOS)
            names.removeAll { $0 == "Kadoki Vision" }
            #else
            names.removeAll { $0 == "Kadoki " + UIDevice.current.name }
            #endif
            call.resolve(["peers": names])
        }
    }

    // Minimal HTTP GET over NWConnection straight to the Bonjour endpoint —
    // no name resolution step, no ATS involvement, tiny and dependable.
    @objc func handoffGet(_ call: CAPPluginCall) {
        guard let service = call.getString("service"), let path = call.getString("path") else {
            call.reject("service + path required")
            return
        }
        let endpoint = NWEndpoint.service(name: service, type: "_kadoki._tcp", domain: "local.", interface: nil)
        let conn = NWConnection(to: endpoint, using: .tcp)
        var buffer = Data()
        var done = false
        let finish: (String?) -> Void = { body in
            if done { return }
            done = true
            conn.cancel()
            if let body = body { call.resolve(["body": body]) }
            else { call.reject("handoff fetch failed") }
        }
        func readLoop() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 512 * 1024) { data, _, isComplete, err in
                if let d = data { buffer.append(d) }
                if isComplete || err != nil {
                    // split headers/body at CRLFCRLF
                    if let range = buffer.range(of: Data([13, 10, 13, 10])) {
                        let body = buffer.subdata(in: range.upperBound..<buffer.endIndex)
                        finish(String(data: body, encoding: .utf8))
                    } else { finish(nil) }
                    return
                }
                readLoop()
            }
        }
        conn.stateUpdateHandler = { st in
            switch st {
            case .ready:
                let req = "GET \(path) HTTP/1.1\r\nHost: kadoki\r\nConnection: close\r\n\r\n"
                conn.send(content: req.data(using: .utf8), completion: .contentProcessed { _ in })
                readLoop()
            case .failed, .cancelled:
                finish(nil)
            default: break
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 15) { finish(nil) }   // hard timeout
        conn.start(queue: DispatchQueue.global(qos: .userInitiated))
    }

    // JS → native: the built JSON for a parked handoff-server request.
    @objc func handoffServeResult(_ call: CAPPluginCall) {
        let reqId = call.getString("reqId") ?? ""
        let body = call.getString("body") ?? ""
        KadokiHandoffServer.shared.fulfill(reqId: reqId, body: body)
        call.resolve()
    }

    // JS → native dictionary panel (visionOS): the ghost popup's HTML (and,
    // once per session, the app's CSS bundle) for the panel's WKWebView.
    @objc func dictPanel(_ call: CAPPluginCall) {
        var info: [String: Any] = ["show": call.getBool("show") ?? false]
        if let html = call.getString("html") { info["html"] = html }
        if let css = call.getString("css") { info["css"] = css }
        if let xf = call.getDouble("xf") { info["xf"] = xf }
        if let yf = call.getDouble("yf") { info["yf"] = yf }
        NotificationCenter.default.post(name: Notification.Name("KadokiDictPanel"),
                                        object: nil, userInfo: info)
        call.resolve()
    }

    // JS → native detachable panel windows (visionOS): Timeline & Scenes, the
    // chapter summary and the Characters screen can each be popped OUT of the
    // main window into a real, system-placeable window. Unlike the dictionary
    // panel (whose HTML is mirrored into a shared webview), a panel window
    // hosts its OWN WKWebView on the SAME capacitor://localhost origin, so it
    // renders the real thing — shared IndexedDB, working images and lookups.
    //   action "open"  — activate (or focus) the window for `kind`
    //   action "close" — destroy it; the panel returns to an in-window overlay
    //   action "post"  — relay `msg` to that window's webview (see KadokiPanelHost)
    @objc func panelWindow(_ call: CAPPluginCall) {
        var info: [String: Any] = ["action": call.getString("action") ?? "open"]
        if let kind = call.getString("kind") { info["kind"] = kind }
        if let msg = call.getString("msg") { info["msg"] = msg }
        NotificationCenter.default.post(name: Notification.Name("KadokiPanelWindow"),
                                        object: nil, userInfo: info)
        call.resolve()
    }

    // JS → native transport-UI state (visionOS ornament): dictionary mode +
    // active app mode. Each field only fires when present, so a mode-only
    // push can't reset the dictionary flag (and vice versa).
    @objc func tpState(_ call: CAPPluginCall) {
        if let typing = call.getBool("typing") {
            NotificationCenter.default.post(name: Notification.Name("KadokiTyping"),
                                            object: nil, userInfo: ["on": typing])
        }
        if let spatialOn = call.getBool("spatialOn") {
            NotificationCenter.default.post(name: Notification.Name("KadokiSpatialMode"),
                                            object: nil, userInfo: ["on": spatialOn])
        }
        // Video title active in audio mode → the transport ornament shows the
        // cube (AI-3D) button there too, not just in card mode.
        if let videoOn = call.getBool("videoOn") {
            NotificationCenter.default.post(name: Notification.Name("KadokiVideoMode"),
                                            object: nil, userInfo: ["on": videoOn])
        }
        if let dictOn = call.getBool("dictOn") {
            NotificationCenter.default.post(name: Notification.Name("KadokiDictMode"),
                                            object: nil, userInfo: ["on": dictOn])
        }
        if let mode = call.getString("mode") {
            NotificationCenter.default.post(name: Notification.Name("KadokiUiMode"),
                                            object: nil, userInfo: ["mode": mode])
        }
        call.resolve()
    }

    // Device identity probes for the JS layer's platform adaptations.
    // "Designed for iPad" compatibility mode on visionOS masquerades hard:
    // utsname.machine reports a fake iPad (verified on device: "iPad13,4"),
    // as do UA/idiom/UIDevice. So we return several deeper signals and let
    // JS match ANY of them: the real system's SystemVersion.plist ProductName
    // (the file is the host OS's), low-level sysctl targets, and a probe for
    // a visionOS-only UIKit class.
    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    /// Full duration of an audio file WITHOUT loading it into the player —
    /// the reader's uncovered-region estimate (set-playhead past the
    /// transcription frontier) needs it the moment a title opens.
    @objc func probeDuration(_ call: CAPPluginCall) {
        let raw = call.getString("path") ?? ""
        guard !raw.isEmpty else { call.resolve(["durationMs": 0]); return }
        let url: URL = raw.hasPrefix("file://") ? (URL(string: raw) ?? URL(fileURLWithPath: raw)) : URL(fileURLWithPath: raw)
        let asset = AVURLAsset(url: url)
        asset.loadValuesAsynchronously(forKeys: ["duration"]) {
            let d = asset.duration
            let ms = d.isNumeric ? Int(CMTimeGetSeconds(d) * 1000.0) : 0
            call.resolve(["durationMs": max(0, ms)])
        }
    }

    /// Charging / thermal / Low-Power state — the on-device transcriber uses
    /// it to decide whether it may keep working (it is by far the heaviest
    /// thing the app runs).
    @objc func powerState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIDevice.current.isBatteryMonitoringEnabled = true
            let st = UIDevice.current.batteryState
            let thermal: String
            switch ProcessInfo.processInfo.thermalState {
            case .nominal:  thermal = "nominal"
            case .fair:     thermal = "fair"
            case .serious:  thermal = "serious"
            case .critical: thermal = "critical"
            @unknown default: thermal = "nominal"
            }
            call.resolve([
                "charging": st == .charging || st == .full,
                "level":    Double(UIDevice.current.batteryLevel),
                "thermal":  thermal,
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
            ])
        }
    }

    /// The window's REAL safe-area insets plus the device idiom. CSS
    /// env(safe-area-inset-*) proved unreliable here (the reader's blackout
    /// stayed on the left in both landscape orientations), and the reader has
    /// to know which side the Dynamic Island is actually on.
    @objc func safeAreaInsets(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var win: UIWindow? = nil
            var oName = "unknown"
            for scene in UIApplication.shared.connectedScenes {
                guard let ws = scene as? UIWindowScene else { continue }
                switch ws.interfaceOrientation {
                case .portrait:           oName = "portrait"
                case .portraitUpsideDown: oName = "portraitUpsideDown"
                case .landscapeLeft:      oName = "landscapeLeft"
                case .landscapeRight:     oName = "landscapeRight"
                default:                  oName = "unknown"
                }
                if let k = ws.windows.first(where: { $0.isKeyWindow }) { win = k; break }
                if win == nil { win = ws.windows.first }
            }
            let i = win?.safeAreaInsets ?? .zero
            let idiom: String
            switch UIDevice.current.userInterfaceIdiom {
            case .phone: idiom = "phone"
            case .pad:   idiom = "pad"
            default:     idiom = "other"
            }
            call.resolve([
                "top": Double(i.top), "left": Double(i.left),
                "bottom": Double(i.bottom), "right": Double(i.right),
                "idiom": idiom, "orientation": oName,
            ])
        }
    }

    @objc func deviceModel(_ call: CAPPluginCall) {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(validatingUTF8: $0) }
        } ?? "unknown"
        func sysctlStr(_ name: String) -> String {
            var size = 0
            guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
            var buf = [CChar](repeating: 0, count: size)
            guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return "" }
            return String(cString: buf)
        }
        let sv = NSDictionary(contentsOfFile: "/System/Library/CoreServices/SystemVersion.plist")
        var model = machine
        var simDemo = false
        var demoDir = ""
        #if targetEnvironment(simulator)
        // The simulator's utsname is the host Mac's — report the simulated
        // device so KADOKI_VISION_NATIVE detection works there too.
        model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine
        // Dev harness: SIMCTL_CHILD_KADOKI_SIM_DEMO=1 seeds a bundled demo
        // video+SRT into Documents so the video player is testable in the
        // simulator with zero manual imports.
        if ProcessInfo.processInfo.environment["KADOKI_SIM_DEMO"] == "1" {
            simDemo = true
            if let host = ProcessInfo.processInfo.environment["KADOKI_SIM_DEMO_DIR"],
               FileManager.default.fileExists(atPath: host + "/demo-video.mp4") {
                // Simulator processes can read host paths — a HOST directory is
                // container-rotation-proof (Documents paths go stale on every
                // reinstall and poisoned the seeded title).
                demoDir = host
            } else {
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                demoDir = docs.path
                for f in ["demo-video.mp4", "demo-video.srt"] {
                    let dst = docs.appendingPathComponent(f)
                    if !FileManager.default.fileExists(atPath: dst.path),
                       let src = Bundle.main.url(forResource: (f as NSString).deletingPathExtension,
                                                 withExtension: (f as NSString).pathExtension) {
                        try? FileManager.default.copyItem(at: src, to: dst)
                    }
                }
            }
        }
        #endif
        call.resolve([
            "model": model,
            "hwTarget": sysctlStr("hw.target"),
            "hwProduct": sysctlStr("hw.product"),
            "productName": (sv?["ProductName"] as? String) ?? "",
            "visionClass": NSClassFromString("UIWindowSceneGeometryPreferencesVision") != nil,
            "debugBuild": Self.isDebugBuild,
            "simDemo": simDemo,
            "demoDir": demoDir,
            "sim3d": ProcessInfo.processInfo.environment["KADOKI_SIM_3D"] == "1",
            "simSeries": !demoDir.isEmpty && FileManager.default.fileExists(atPath: demoDir + "/demo-ep1.mp4"),
            "simAdv": ProcessInfo.processInfo.environment["KADOKI_SIM_ADV"] == "1",
            "simBrowse": ProcessInfo.processInfo.environment["KADOKI_SIM_BROWSE"] == "1",
            "simAnki": ProcessInfo.processInfo.environment["KADOKI_SIM_ANKI"] == "1",
            "simFold": ProcessInfo.processInfo.environment["KADOKI_SIM_FOLD"] == "1",
            "simCard": ProcessInfo.processInfo.environment["KADOKI_SIM_CARD"] == "1",
            "simMenu": ProcessInfo.processInfo.environment["KADOKI_SIM_MENU"] == "1",
            "simBrowsePreview": ProcessInfo.processInfo.environment["KADOKI_SIM_BROWSE_PREVIEW"] == "1",
            "simBrowseCommit": ProcessInfo.processInfo.environment["KADOKI_SIM_BROWSE_COMMIT"] == "1",
            "simBrowseResume": ProcessInfo.processInfo.environment["KADOKI_SIM_BROWSE_RESUME"] == "1",
            "simAnkiHost": ProcessInfo.processInfo.environment["KADOKI_SIM_ANKI_HOST"] ?? "",
        ])
    }

    // MARK: - Durable position store (BookPlayer-style: the player layer owns the
    // save). We persist {url, ms} to UserDefaults from THIS process ~every 5s
    // while playing + on background/pause, independent of the WebView. iOS
    // suspends the WebView (freezing the JS saver) for the whole background
    // listen, so without this the saved place could be minutes behind; this keeps
    // it within ~5s. JS reads it via getLastSavedPosition() as a forward-only floor.
    private static let posKeyUrl = "kadoki.audio.lastUrl"
    private static let posKeyMs  = "kadoki.audio.lastMs"
    private static let posKeyTs  = "kadoki.audio.lastTs"   // wall-clock (epoch ms) of the save — JS stamps recovered spots with it
    /// Foreground/visible flag — the 150ms position emit slows to ~1s in the
    /// background/screen-off (nobody sees it), the biggest battery win for long
    /// listens. The lock screen is driven by Now Playing, not this emit.
    private var uiVisible = true
    /// Throttle for the in-timer durable save (~5s).
    private var lastDurableSaveAt: TimeInterval = 0

    // MARK: - Constants

    /// Default fade duration in ms for play / pause / resume. 20 ms —
    /// long enough to fully mask the amplitude-discontinuity click
    /// (5 ms was too short: on iOS the hardware ramp barely engaged, on
    /// Android it collapsed to a single hard step), still well below a
    /// perceptible "delay". This default also governs the dictionary
    /// pause/resume (it calls pause()/resume() with no fadeMs). Callers
    /// can override via `fadeMs` in the call (0 disables entirely).
    static let defaultFadeMs: Double = 20

    // MARK: - State

    // Engine slot: AVAudioPlayer for audio files, KadokiVideoPlayer (AVPlayer)
    // for video files standing as audiobook attachments. Every consumer below
    // drives it through the KadokiPlayback protocol, so transport / fades /
    // durable floors / remote commands / chapter repeat are engine-agnostic.
    private var player: KadokiPlayback?
    // The exact `url` string JS last asked us to play. Exposed via getState so JS
    // can confirm "same audio" before adopting the native playhead as truth on a
    // resume (the backwards-place-jump fix). Stored raw so it matches what JS sent.
    private var currentUrlStr: String = ""
    private var positionTimer: Timer?
    private var currentRate: Float = 1.0
    private var nowPlayingTitle: String = "Audiobook"
    private var nowPlayingSubtitle: String = ""
    private var nowPlayingArtwork: MPMediaItemArtwork?
    /// Decoded cover image (from setMetadata's artwork), kept so the subtitle
    /// renderer can composite serif text over a dimmed copy of it.
    private var nowPlayingCoverImage: UIImage?
    private var remoteCommandsConfigured = false
    /// Bumped on every pause/resume/play so a faded pause's deferred
    /// pause() closure can detect that a resume/play raced in during the
    /// fade window and abort — otherwise a quick dictionary close (resume)
    /// right after open (pause) would be undone by the still-pending
    /// asyncAfter pause. (Android's cancelFade already handles this.)
    private var fadeGeneration = 0
    /// True while a faded pause waits out its ramp (the player still reports
    /// isPlaying). A toggle / play that lands then means "keep playing", and a
    /// faded seek skips its own dip (the pause already owns the volume). Any
    /// later fadeGeneration bump (play, resume, scrub, engine switch) clears it.
    private var pauseFadeGen = -1
    private var pauseFadePending: Bool { pauseFadeGen == fadeGeneration }
    /// Bumped by EVERY seek (JS seek, lock-screen scrub, scrub end, chapter skip /
    /// repeat, a new play). A faded seek lands its target only if nothing newer
    /// superseded it, so an older delayed callback never overwrites a newer spot.
    private var seekGeneration = 0
    /// Bumped by every explicit user transport command (play / resume / pause /
    /// toggle / stop). Deferred automatic work captured before it — a chapter-
    /// repeat announcement's completion — yields to the newer user intent.
    private var transportGen = 0
    // Scrub session (reader drag-scrub): grains are short audible slices at
    // the finger position. scrubGen cancels a grain's scheduled fade-out/
    // pause when a newer grain (or scrubEnd) supersedes it.
    private var scrubGen = 0
    private var scrubActive = false
    private var scrubWasPlaying = false

    // MARK: - Native chapter-repeat
    // Detect natural chapter boundary crossings from inside the position Timer
    // (which keeps firing backgrounded/screen-off under UIBackgroundModes:audio),
    // pause → speak the chapter title via AVSpeechSynthesizer through the still-
    // active session → seek back to the chapter start → resume. Repeats each
    // chapter ONCE, then advances. All of it works while suspended/locked.
    private struct ChapterBound { let idx: Int; let startMs: Int; let endMs: Int; let announce: String }
    private var chapters: [ChapterBound] = []
    private var chapterRepeatOn = false
    private var repeatPassIdx = -1
    private var repeatedChapters = Set<Int>()   // chapters whose ONE repeat is done — never repeat again (skip-back safe)
    private var repeatBusy = false
    private var lastTickMs = -1
    private var lastChapterIdx = -1
    private var repeatGuardUntil: TimeInterval = 0
    private let speechSynth = AVSpeechSynthesizer()
    private var speakGen = 0
    private var failsafeTimer: Timer?
    private var pendingSpeechCompletion: (() -> Void)?

    // MARK: - Lifecycle

    override public func load() {
        configureAudioSession()
        setupRemoteCommands()
        speechSynth.delegate = self
        // Foreground/background transitions: throttle the position emit and flush
        // a durable position snapshot when we background (so a background kill
        // keeps place even though the JS saver is suspended).
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(appDidBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(appWillForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(appWillTerminate),
                       name: UIApplication.willTerminateNotification, object: nil)
    }

    @objc private func appDidBackground() {
        uiVisible = false
        saveLastPositionNow()
        if positionTimer != nil { startPositionTimer() }   // re-arm at the slow cadence
    }
    @objc private func appWillForeground() {
        uiVisible = true
        if positionTimer != nil { startPositionTimer() }   // re-arm at the fast cadence
    }
    @objc private func appWillTerminate() { saveLastPositionNow() }

    // MARK: - Audio session

    /// Configure the playback category. `.spokenAudio` mode hints to the OS that
    /// this is dialogue/narration (better behavior with Bluetooth, AirPods, etc.).
    /// We do NOT activate here — activation is lazy (first play) and the session
    /// is deactivated on stop(), so iOS can suspend the app when nothing plays
    /// (an always-active .playback session kept the process resident).
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        // `.longFormAudio` marks Kadoki as a long-form player (the policy Music /
        // Podcasts / Books use): starting playback then routes to the user's
        // long-form output and lets AirPods auto-switch over from a Mac/iPad,
        // instead of staying on whatever the default route happens to be.
        do {
            try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio, options: [])
        } catch {
            NSLog("[BackgroundAudio] longFormAudio category failed: \(error.localizedDescription)")
            do { try session.setCategory(.playback, mode: .spokenAudio, options: []) }
            catch { NSLog("[BackgroundAudio] AudioSession category failed: \(error.localizedDescription)") }
        }
    }

    #if !os(visionOS)
    private var routePicker: AVRoutePickerView?
    #endif
    /// Present the system audio-output sheet (AirPods / speaker / AirPlay) —
    /// the manual grab for when the AirPods stayed on another device. iOS has
    /// no public API to pick a Bluetooth output directly; this sheet is it.
    @objc func showRoutePicker(_ call: CAPPluginCall) {
        #if os(visionOS)
        call.resolve(["shown": false])
        #else
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController?.view else {
                call.resolve(["shown": false]); return
            }
            let picker = self.routePicker ?? {
                let p = AVRoutePickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
                p.alpha = 0.011; p.isUserInteractionEnabled = false
                host.addSubview(p)
                self.routePicker = p
                return p
            }()
            let button = picker.subviews.compactMap { $0 as? UIButton }.first
            button?.sendActions(for: .touchUpInside)
            call.resolve(["shown": button != nil])
        }
        #endif
    }

    /// Activate the audio session right before playback (lazy). Safe to call
    /// repeatedly — AVAudioSession.setActive(true) is idempotent.
    private func ensureSessionActive() {
        do { try AVAudioSession.sharedInstance().setActive(true) }
        catch { NSLog("[BackgroundAudio] session activate failed: \(error.localizedDescription)") }
    }

    // MARK: - Durable position

    /// Persist the live playhead now (url + ms) to UserDefaults.
    private func saveLastPositionNow() {
        guard let p = player, !currentUrlStr.isEmpty else { return }
        let ms = Int(p.currentTime * 1000)
        let d = UserDefaults.standard
        d.set(currentUrlStr, forKey: Self.posKeyUrl)
        d.set(ms, forKey: Self.posKeyMs)
        d.set(Int(Date().timeIntervalSince1970 * 1000), forKey: Self.posKeyTs)
        lastDurableSaveAt = Date().timeIntervalSince1970
    }

    /// Persist an EXPLICIT playhead ms (url + ms). A chapter repeat pauses at a
    /// boundary (or at EOF for the final chapter) before announcing; saving the SEEK
    /// TARGET here — not the live playhead — means a kill during the announce restores
    /// to the chapter being repeated, never to end-of-book.
    private func saveDurablePositionMs(_ ms: Int) {
        guard !currentUrlStr.isEmpty else { return }
        let d = UserDefaults.standard
        d.set(currentUrlStr, forKey: Self.posKeyUrl)
        d.set(max(0, ms), forKey: Self.posKeyMs)
        d.set(Int(Date().timeIntervalSince1970 * 1000), forKey: Self.posKeyTs)
        lastDurableSaveAt = Date().timeIntervalSince1970
    }

    /// The natural end-of-book path: stop the timer, emit ended, release the audio
    /// session (so a finished overnight book doesn't hold the app resident — battery
    /// audit 2026-06-10). Extracted so the EOF delegate AND a repeat-cancel-at-EOF
    /// both finish cleanly. Caller runs on main.
    private func finishBookAtEof() {
        stopPositionTimer()
        emitState(playing: false)
        postLiveTick(ms: Int((player?.currentTime ?? 0) * 1000), playing: false)   // watch must stop too
        self.notifyListeners("ended", data: [:])
        updateNowPlaying()
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { NSLog("[BackgroundAudio] EOF session deactivate failed: \(error.localizedDescription)") }
    }

    /// The last durably-saved {url, ms} — readable even with no live player
    /// (cold launch). JS applies it as a forward-only, url-matched floor.
    @objc func getLastSavedPosition(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        let url = d.string(forKey: Self.posKeyUrl) ?? ""
        let ms = d.object(forKey: Self.posKeyMs) != nil ? d.integer(forKey: Self.posKeyMs) : -1
        // Wall-clock (epoch ms) of the save; 0 = unknown/older build.
        let ts = d.object(forKey: Self.posKeyTs) != nil ? d.integer(forKey: Self.posKeyTs) : 0
        call.resolve([
            "url": url,
            "positionMs": max(0, ms),
            "hasSaved": ms >= 0 && !url.isEmpty,
            "ts": max(0, ts)
        ])
    }

    // MARK: - Remote commands (lock screen / Control Center / headphones)

    private func setupRemoteCommands() {
        guard !remoteCommandsConfigured else { return }
        remoteCommandsConfigured = true
        let cmd = MPRemoteCommandCenter.shared()

        cmd.playCommand.addTarget { [weak self] _ in
            guard let p = self?.player else { return .commandFailed }
            self?.noteUserTransport()
            self?.ensureSessionActive()
            self?.startFaded(p)
            self?.startPositionTimer()
            self?.emitState(playing: true)
            self?.postLiveTick(ms: Int(p.currentTime * 1000), playing: true)
            self?.updateNowPlaying()
            // Tell JS this play came from the lock screen / Control Center, so
            // it can disarm a card clip's end boundary. JS never changes mode
            // for it — playback simply resumes in place.
            // ts: lets JS drop this command if it thaws out of a suspended
            // WebView minutes later (stale-replay guard).
            self?.notifyListeners("remoteCommand", data: ["action": "play", "ts": Int(Date().timeIntervalSince1970 * 1000)])
            return .success
        }
        cmd.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .success }
            self.noteUserTransport()
            let finish: () -> Void = { [weak self] in
                guard let self = self else { return }
                let ms = Int((self.player?.currentTime ?? 0) * 1000)
                self.stopPositionTimer()
                self.saveLastPositionNow()   // durable: a paused suspended app can be jetsam-killed with no further save
                self.emitState(playing: false)
                self.postLiveTick(ms: ms, playing: false)
                self.updateNowPlaying()
            }
            // Faded like JS pause(); the saves/emits run once the ramp lands.
            if let p = self.player { self.pauseFaded(p, after: finish) } else { finish() }
            return .success
        }
        cmd.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.performTogglePlayPause()
            return .success
        }
        // Phase B: the watch's "On iPhone" live view taps to remote-toggle
        // playback — same native path as the lock-screen toggle above, kept
        // in sync via WatchBridgePlugin posting this notification (mirrors
        // BackgroundAudio → WatchBridge's own .kadokiPositionTick, just in
        // the opposite direction).
        NotificationCenter.default.addObserver(
            forName: .kadokiRemoteToggleRequest, object: nil, queue: .main
        ) { [weak self] _ in
            self?.performTogglePlayPause()
        }
        // Watch left/right swipe pages subtitles — emit the SAME event the
        // lock-screen ⏮⏭ buttons emit, so the watch rides the exact JS path
        // (app.js remoteCommand → lockScreenCueJump) already proven to work
        // during locked background playback, staleness guard included.
        NotificationCenter.default.addObserver(
            forName: .kadokiRemoteCueJumpRequest, object: nil, queue: .main
        ) { [weak self] note in
            guard let dir = note.userInfo?["dir"] as? Int, dir != 0 else { return }
            self?.notifyListeners("remoteCommand", data: [
                "action": dir > 0 ? "nextCue" : "prevCue",
                "ts": Int(Date().timeIntervalSince1970 * 1000),
            ])
        }
        // Prev/next-track (⏮⏭) jump by SUBTITLE CUE. JS owns cue boundaries, so
        // these just notify it; the ±30 s skip buttons are disabled in favor of
        // cue navigation (more useful for sentence-level immersion).
        cmd.skipForwardCommand.isEnabled = false
        cmd.skipBackwardCommand.isEnabled = false
        cmd.nextTrackCommand.isEnabled = true
        cmd.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "nextCue", "ts": Int(Date().timeIntervalSince1970 * 1000)])
            return .success
        }
        cmd.previousTrackCommand.isEnabled = true
        cmd.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "prevCue", "ts": Int(Date().timeIntervalSince1970 * 1000)])
            return .success
        }
        cmd.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent,
                  let p = self?.player else { return .commandFailed }
            p.currentTime = event.positionTime
            self?.seekGeneration += 1
            // External seek: keep the chapter-repeat detector from reading this
            // lock-screen scrub as a natural boundary crossing.
            self?.repeatGuardUntil = Date().timeIntervalSince1970 + 0.6
            self?.lastTickMs = -1; self?.lastChapterIdx = -1
            // Durable: a PAUSED lock-screen scrub had no other writer (timer
            // stopped, no JS event) — a jetsam kill discarded it entirely.
            self?.saveLastPositionNow()
            self?.updateNowPlaying()
            return .success
        }
        cmd.changePlaybackRateCommand.supportedPlaybackRates = [0.75, 1.0, 1.25, 1.5, 1.75]
        cmd.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackRateCommandEvent,
                  let p = self?.player else { return .commandFailed }
            p.rate = event.playbackRate
            self?.currentRate = event.playbackRate
            self?.updateNowPlaying()
            return .success
        }
    }

    /// Record an explicit user transport command. Also cuts a chapter-repeat
    /// announcement short, so its completion runs now and honours this intent
    /// instead of seeking/resuming over it seconds later.
    private func noteUserTransport() {
        transportGen += 1
        DispatchQueue.main.async { [weak self] in   // the synth lives on main
            guard let self = self, self.repeatBusy, self.speechSynth.isSpeaking else { return }
            self.speechSynth.stopSpeaking(at: .immediate)
        }
    }

    // MARK: - Click-free transport helpers
    //
    // Rule: audio never starts or stops with a click. Every start ramps up from
    // silence and every stop ramps down first (defaultFadeMs). Position is never
    // touched here: a faded pause reads the playhead for its saves/emits AFTER
    // the ramp, exactly where the audio actually stopped.

    /// Start (or keep) `p` playing with a fade-in. A start that lands during a
    /// pending faded pause ramps back up from the current level instead of
    /// snapping to 0, and supersedes that pause.
    private func startFaded(_ p: KadokiPlayback, fadeMs: Double = BackgroundAudioPlugin.defaultFadeMs) {
        fadeGeneration += 1
        if fadeMs <= 0 { p.volume = 1.0; p.play(); return }
        if !p.isPlaying { p.volume = 0.0; p.play() }
        p.setVolume(1.0, fadeDuration: fadeMs / 1000.0)
    }

    /// Fade `p` out, THEN pause it, then run `after` (state emits + durable save,
    /// which read the playhead where the sound actually stopped). A play /
    /// resume / stop / scrub that races in bumps fadeGeneration and cancels it.
    private func pauseFaded(_ p: KadokiPlayback, fadeMs: Double = BackgroundAudioPlugin.defaultFadeMs,
                            after: @escaping () -> Void) {
        fadeGeneration += 1
        let gen = fadeGeneration
        guard fadeMs > 0, p.isPlaying else {
            p.volume = 0.0; p.pause(); p.volume = 1.0
            after()
            return
        }
        pauseFadeGen = gen
        p.setVolume(0.0, fadeDuration: fadeMs / 1000.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + fadeMs / 1000.0) { [weak self] in
            guard let self = self, self.fadeGeneration == gen else { return }
            self.pauseFadeGen = -1
            p.pause()
            p.volume = 1.0 // restore for next play
            after()
        }
    }

    /// Retire a player that is being replaced or stopped: detach its end/error
    /// callbacks (it is no longer the plugin's player), ramp it to silence, then
    /// stop it. The caller has already swapped `player`, so every position/state
    /// read sees the new state at once; only the sound lingers for the ramp.
    private func retireFaded(_ old: KadokiPlayback, fadeMs: Double = BackgroundAudioPlugin.defaultFadeMs,
                             completion: (() -> Void)? = nil) {
        if let a = old as? AVAudioPlayer { a.delegate = nil }
        if let e = old as? KadokiReadEngine { e.onEnded = nil; e.onError = nil }
        if let v = old as? KadokiVideoPlayer { v.onEnded = nil; v.onError = nil }
        guard fadeMs > 0, old.isPlaying else { old.stop(); completion?(); return }
        old.setVolume(0.0, fadeDuration: fadeMs / 1000.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + fadeMs / 1000.0 + 0.005) {
            old.stop()
            completion?()
        }
    }

    // Shared by the lock-screen toggle button and the watch's tap-to-toggle
    // (Phase B) — both are "remote, no context on current state" triggers.
    private func performTogglePlayPause() {
        guard let p = player else { NSLog("[BackgroundAudio] performTogglePlayPause: no active player"); return }
        noteUserTransport()
        if p.isPlaying && !pauseFadePending {
            pauseFaded(p) { [weak self] in
                guard let self = self else { return }
                self.stopPositionTimer()
                self.saveLastPositionNow()
                self.emitState(playing: false)
                self.postLiveTick(ms: Int(p.currentTime * 1000), playing: false)
                self.updateNowPlaying()
            }
            return
        } else {
            ensureSessionActive()
            startFaded(p)
            startPositionTimer()
            emitState(playing: true)
            postLiveTick(ms: Int(p.currentTime * 1000), playing: true)
            notifyListeners("remoteCommand", data: ["action": "play", "ts": Int(Date().timeIntervalSince1970 * 1000)])
        }
        updateNowPlaying()
    }

    // MARK: - JS methods

    @objc func play(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), !urlStr.isEmpty else {
            call.reject("url required")
            return
        }
        currentUrlStr = urlStr   // remember what JS asked us to play (for getState "same audio" check)
        noteUserTransport()      // a new start supersedes any deferred automatic resume
        seekGeneration += 1      // …and any seek still waiting out its fade
        stopRateRamp()
        ensureSessionActive()    // lazy activation (session is deactivated on stop)
        // call.getInt/getDouble — getDouble is reliable for fractional JSON Numbers.
        let startMs = call.getDouble("startMs") ?? 0
        let rate = Float(call.getDouble("rate") ?? 1.0)

        // Accept both bare paths and file:// URIs.
        let url: URL
        if urlStr.hasPrefix("file://") {
            url = URL(string: urlStr) ?? URL(fileURLWithPath: String(urlStr.dropFirst(7)))
        } else {
            url = URL(fileURLWithPath: urlStr)
        }

        // Video files (mp4/m4v/mov/3gp standing as the audiobook attachment)
        // play through an AVPlayer engine — AVAudioPlayer can't open a file
        // with a video track. Same events, fades, floors and timer as audio.
        if KadokiVideoPlayer.isVideoUrl(url) {
            stopPositionTimer()
            if let old = player { retireFaded(old) }   // fade the outgoing voice out (no click on a switch)
            player = nil

            let v = KadokiVideoPlayer(url: url)
            v.onEnded = { [weak self] in self?.handleNaturalEnd() }
            v.onError = { [weak self] msg in self?.handlePlaybackError(message: msg) }
            v.rate = rate
            v.currentTime = max(0, startMs / 1000.0)
            fadeGeneration += 1
            let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
            if fadeMs > 0 {
                v.volume = 0.0
                v.play()
                v.setVolume(1.0, fadeDuration: fadeMs / 1000.0)
            } else {
                v.volume = 1.0
                v.play()
            }
            self.player = v
            self.currentRate = rate
            startPositionTimer()
            emitState(playing: true)
            updateNowPlaying()
            #if os(visionOS)
            Task { @MainActor in KadokiVideoModel.shared.adopt(v) }
            #elseif os(iOS)
            DispatchQueue.main.async { KadokiVideoIOSHost.shared.adopt(v.avPlayer) }
            #endif
            call.resolve()
            return
        }

        do {
            // Tear down any prior player. Doing this synchronously avoids the
            // late-state-event race the Android plugin had.
            stopPositionTimer()
            // Click-free: a still-playing previous player (title switch, card
            // replay) ramps out while the new one ramps in — a ~20 ms cross-fade.
            // `player` is swapped at once, so position/state reads never see it.
            if let old = player { retireFaded(old) }
            player = nil
            #if os(visionOS)
            Task { @MainActor in KadokiVideoModel.shared.clear() }
            #elseif os(iOS)
            DispatchQueue.main.async { KadokiVideoIOSHost.shared.clear() }
            #endif

            if preferredEngine == "speech", let e = makeReadEngine(url: url) {
                e.rate = rate
                e.currentTime = max(0, startMs / 1000.0)
                fadeGeneration += 1
                let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
                if fadeMs > 0 {
                    e.volume = 0.0
                    e.play()
                    e.setVolume(1.0, fadeDuration: fadeMs / 1000.0)
                } else {
                    e.volume = 1.0
                    e.play()
                }
                self.player = e
                self.currentRate = rate
                startPositionTimer()
                emitState(playing: true)
                updateNowPlaying()
                call.resolve()
                return
            }
            let p = try AVAudioPlayer(contentsOf: url)
            p.enableRate = true
            p.rate = rate
            p.delegate = self
            p.prepareToPlay()
            // currentTime in seconds. Clamp to [0, duration].
            let startSec = max(0, min(p.duration, startMs / 1000.0))
            p.currentTime = startSec
            // Fade-in (opt-in via fadeMs param, default off). When
            // fadeMs > 0 we start muted and ramp via
            // AVAudioPlayer.setVolume(_:fadeDuration:) which does the
            // ramp on a private dispatch source so it survives the
            // play() handoff. When fadeMs == 0 (current default) we
            // just play at full volume — the audio buffer was empty
            // so there's no amplitude discontinuity to click on.
            // New playback supersedes any pending faded-pause.
            fadeGeneration += 1
            let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
            if fadeMs > 0 {
                p.volume = 0.0
                p.play()
                p.setVolume(1.0, fadeDuration: fadeMs / 1000.0)
            } else {
                p.volume = 1.0
                p.play()
            }

            self.player = p
            self.currentRate = rate
            startPositionTimer()
            emitState(playing: true)
            updateNowPlaying()
            call.resolve()
        } catch {
            call.reject("play failed: \(error.localizedDescription)")
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        // Fade-out then pause. setVolume(_:fadeDuration:) returns immediately
        // and schedules the ramp; we asyncAfter the actual pause() so the fade
        // audibly completes first (otherwise the source clips on the pause
        // boundary). The fadeGeneration token lets a resume/play that races in
        // during the fade window — e.g. a quick dictionary close — cancel this
        // pending pause instead of stopping the freshly-resumed audio.
        // fadeMs 0 (no caller passes it today) still silences the player right
        // before pause so the buffer flushes with zero amplitude; a very faint
        // click can slip through there — the trade for instant response.
        noteUserTransport()
        let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
        let finish: () -> Void = { [weak self] in
            guard let self = self else { return }
            self.stopPositionTimer()
            self.saveLastPositionNow()   // durable on every pause (parity with Android ACTION_PAUSE)
            self.emitState(playing: false)
            self.postLiveTick(ms: Int((self.player?.currentTime ?? 0) * 1000), playing: false)
            self.updateNowPlaying()
        }
        if let p = player { pauseFaded(p, fadeMs: fadeMs, after: finish) } else { fadeGeneration += 1; finish() }
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) {
        guard let p = player else { call.resolve(); return }
        noteUserTransport()
        ensureSessionActive()   // re-activate if a prior stop() deactivated it
        // Supersedes any pending faded-pause so it doesn't stop us; mid-fade it
        // ramps back up from the current level (no snap to 0).
        startFaded(p, fadeMs: call.getDouble("fadeMs") ?? Self.defaultFadeMs)
        startPositionTimer()
        emitState(playing: true)
        postLiveTick(ms: Int(p.currentTime * 1000), playing: true)
        updateNowPlaying()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        noteUserTransport()
        stopPositionTimer()
        saveLastPositionNow()   // before the player/url are cleared (parity with Android ACTION_STOP)
        let msAtStop = Int((player?.currentTime ?? 0) * 1000)
        fadeGeneration += 1          // a pending faded pause must not emit for a player we're dropping
        let old = player
        player = nil
        currentUrlStr = ""
        #if os(visionOS)
        Task { @MainActor in KadokiVideoModel.shared.clear() }
        #endif
        emitState(playing: false)
        postLiveTick(ms: msAtStop, playing: false)
        clearNowPlaying()
        // Deactivate the session so iOS can suspend the app when nothing is
        // playing (an always-active .playback session kept the process resident
        // and Doze-resistant). .notifyOthersOnDeactivation lets other apps' audio
        // resume. Re-activated lazily on the next play()/resume().
        // State is cleared above at once; only the sound fades out (click-free
        // stop), and the session goes down after it — unless a new play() took
        // the session meanwhile.
        let deactivate: () -> Void = { [weak self] in
            guard let self = self, self.player == nil else { return }
            do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
            catch { NSLog("[BackgroundAudio] session deactivate failed: \(error.localizedDescription)") }
        }
        if let old = old { retireFaded(old, completion: deactivate) } else { deactivate() }
        call.resolve()
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let p = player else { call.resolve(); return }
        // External seek: don't let the chapter-repeat detector read this jump as a
        // natural boundary crossing. Guard for a beat and reset the tick history.
        repeatGuardUntil = Date().timeIntervalSince1970 + 0.6; lastTickMs = -1; lastChapterIdx = -1
        let ms = call.getDouble("ms") ?? 0
        let target = max(0, min(p.duration, ms / 1000.0))
        // Opt-in CLICK-FREE seek: callers that pass `fadeMs` > 0 (subtitle
        // swipes, lock-screen prev/next) get a brief volume dip — fade out, jump
        // the playhead while silent, fade back in — to mask the amplitude-
        // discontinuity click an abrupt currentTime change makes mid-playback.
        // No `fadeMs` (or while paused → nothing audible) seeks immediately, so
        // continuous scrub-bar dragging stays instant. Mirrors the play/pause
        // ramp; the same fadeGeneration token defers the fade-in to a pause/play
        // that races in. A pause does not cancel the seek — but a newer seek or a
        // replaced player does (seekGeneration + player identity).
        let fadeMs = call.getDouble("fadeMs") ?? 0
        let rampFrom = Float(call.getDouble("rampFrom") ?? 0)
        let wantRamp = p.isPlaying && rampFrom > 0 && currentRate > rampFrom + 0.03
        let preMs = p.currentTime * 1000          // where the listener WAS: hold 1× until back here
        seekGeneration += 1
        let seekGen = seekGeneration
        // A faded pause already ramping down owns the volume: jump immediately
        // under it (it saves the landing once the pause lands).
        if p.isPlaying && fadeMs > 0 && !pauseFadePending {
            fadeGeneration += 1
            let gen = fadeGeneration
            let secs = fadeMs / 1000.0
            p.setVolume(0.0, fadeDuration: secs)
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) { [weak self] in
                // Only the player this seek was issued against: a play() / title
                // switch during the fade replaced it, and the old target must never
                // land on the new one.
                guard let self = self, let cur = self.player, cur === p else { return }
                // A newer seek owns the position; this one still hands the volume back.
                if self.seekGeneration == seekGen {
                    p.currentTime = target
                    if wantRamp { self.startRateRamp(from: rampFrom, to: self.currentRate, seconds: Self.RAMP_SECONDS, holdUntilMs: preMs) }
                    self.updateNowPlaying()
                    self.postLiveTick(ms: Int(target * 1000), playing: p.isPlaying)
                    // A pause that raced in saved the pre-seek spot — persist the landing.
                    if !p.isPlaying { self.saveLastPositionNow() }
                }
                guard self.fadeGeneration == gen else { return } // a pause/play raced in — it owns the volume
                p.setVolume(1.0, fadeDuration: secs)
            }
        } else {
            p.currentTime = target
            if wantRamp { startRateRamp(from: rampFrom, to: currentRate, seconds: Self.RAMP_SECONDS, holdUntilMs: preMs) }
            updateNowPlaying()
            postLiveTick(ms: Int(target * 1000), playing: p.isPlaying)
            // Durable while paused: no position timer runs and no pause save follows,
            // so a kill right after a paused seek used to restore the old spot.
            if !p.isPlaying { saveLastPositionNow() }
        }
        call.resolve()
    }

    // MARK: - Drag scrub (reader) — turntable engine
    //
    // A scrub session hands the voice to KadokiScrubEngine (AVAudioEngine +
    // AVAudioSourceNode over a decoded PCM window): the finger sets a TARGET
    // position and the render callback chases it with platter-like inertia,
    // resampling continuously (Hermite) at whatever signed speed that implies.
    // No seeks, no fades, no grains — reverse and slow-motion are free, and
    // a resting finger is silence. The main AVAudioPlayer is muted+paused for
    // the session and re-armed at the landing position on scrubEnd.
    private var scrubEngine: KadokiScrubEngine?
    private var scrubLastEmitTs: TimeInterval = 0
    private var scrubPrimeGen = 0

    // MARK: - Rate ramp (re-listen at 1× → back up to the listening speed)
    //
    // After a scrub release or a backward subtitle swipe the user is re-hearing
    // something they missed: start at `from` (1×) and ease back up to the
    // listening rate over a few seconds. Small steps on the main runloop —
    // AVAudioPlayer's time-pitch unit and Sonic both take rate changes without
    // clicks. Any explicit setRate / new play cancels the ramp.
    private var rateRampTimer: Timer?
    private var scrubAnchorMs: Double = -1      // playhead when the scrub began (the span being re-heard ends here)
    private static let RAMP_SECONDS = 4.0
    private static let HOLD_MAX_SECONDS = 45.0
    private func stopRateRamp() { rateRampTimer?.invalidate(); rateRampTimer = nil }
    /// Hold `from` (1×) until the playhead passes `holdUntilMs` — i.e. the
    /// whole re-heard span plays at 1× — THEN ease up to `to` over RAMP_SECONDS.
    /// holdUntilMs ≤ 0 (or already behind) → ramp right away.
    private func startRateRamp(from: Float, to: Float, seconds: Double, holdUntilMs: Double = -1) {
        stopRateRamp()
        guard let p = player, to > from + 0.03 else { return }
        p.rate = from
        let started = Date()
        var rampT0: Date? = (holdUntilMs > 0 && p.currentTime * 1000 < holdUntilMs - 200) ? nil : Date()
        let timer = Timer(timeInterval: 0.08, repeats: true) { [weak self] tm in
            guard let self = self, let p = self.player else { tm.invalidate(); return }
            if rampT0 == nil {
                let pos = p.currentTime * 1000
                let waited = Date().timeIntervalSince(started)
                if pos >= holdUntilMs - 200 || waited > Self.HOLD_MAX_SECONDS || !p.isPlaying && waited > 2 {
                    rampT0 = Date()
                } else {
                    p.rate = from
                    return
                }
            }
            let x = min(1.0, Date().timeIntervalSince(rampT0!) / seconds)
            let e = Float(x * x * (3 - 2 * x))              // smoothstep: gentle start and finish
            p.rate = from + (to - from) * e
            if x >= 1.0 { tm.invalidate(); self.rateRampTimer = nil; p.rate = to }
        }
        RunLoop.main.add(timer, forMode: .common)
        rateRampTimer = timer
    }

    // Finger-down warm-up: create/start the engine and decode a small window
    // around the live playhead BEFORE the drag commits, so scrubBegin has
    // nothing left to do on the critical path. Idles out if no drag follows.
    @objc func scrubPrime(_ call: CAPPluginCall) {
        guard let p = player, !scrubActive, let url = Self.fileURL(from: currentUrlStr) else { call.resolve(["ok": false]); return }
        let ms = call.getDouble("ms") ?? (p.currentTime * 1000)
        if scrubEngine == nil || scrubEngine?.url != url { scrubEngine = KadokiScrubEngine(url: url) }
        guard let e = scrubEngine else { call.resolve(["ok": false]); return }
        ensureSessionActive()
        let ok = e.prime(atMs: ms)
        scrubPrimeGen += 1
        let gen = scrubPrimeGen
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self = self, !self.scrubActive, self.scrubPrimeGen == gen else { return }
            self.scrubEngine?.end()
        }
        call.resolve(["ok": ok])
    }

    // MARK: - Engine selection (read-mode Sonic vs AVAudioPlayer)
    //
    // "speech" = KadokiReadEngine (Sonic time-stretch, foreground read mode);
    // "default" = AVAudioPlayer. JS keeps this in step with the shell mode and
    // visibility (app.js _readEngineSync); switching with a file loaded hands
    // off at the current position with a short cross-fade. Video always uses
    // the AVPlayer engine.
    private var preferredEngine = "default"
    private var preferredNonlinear = false   // Speedy on top of Sonic
    private func activeEngineName() -> String {
        if player is KadokiReadEngine { return "speech" }
        if player is KadokiVideoPlayer { return "video" }
        return player == nil ? "none" : "default"
    }

    @objc func setEngine(_ call: CAPPluginCall) {
        let want = (call.getString("engine") ?? "default") == "speech" ? "speech" : "default"
        let changed = want != preferredEngine
        preferredEngine = want
        preferredNonlinear = call.getBool("nonlinear") ?? preferredNonlinear
        if let e = player as? KadokiReadEngine, e.nonlinear != preferredNonlinear { e.nonlinear = preferredNonlinear }
        var switched = false
        if changed, let p = player, let url = Self.fileURL(from: currentUrlStr), !KadokiVideoPlayer.isVideoUrl(url) {
            let isRead = p is KadokiReadEngine
            if isRead != (want == "speech") { switched = switchEngine(toRead: want == "speech", url: url) }
        }
        call.resolve(["engine": preferredEngine, "nonlinear": preferredNonlinear, "switched": switched, "active": activeEngineName()])
    }

    private func makeReadEngine(url: URL) -> KadokiReadEngine? {
        guard let e = KadokiReadEngine(url: url) else { return nil }
        e.nonlinear = preferredNonlinear
        e.onEnded = { [weak self] in self?.handleNaturalEnd() }
        e.onError = { [weak self] msg in self?.handlePlaybackError(message: msg) }
        return e
    }

    private func switchEngine(toRead: Bool, url: URL) -> Bool {
        guard let old = player, !scrubActive else { return false }
        let pos = old.currentTime
        let wasPlaying = old.isPlaying
        let rate = currentRate
        var newP: KadokiPlayback
        if toRead {
            guard let e = makeReadEngine(url: url) else { return false }
            e.rate = rate
            e.currentTime = pos
            newP = e
        } else {
            guard let p = try? AVAudioPlayer(contentsOf: url) else { return false }
            p.enableRate = true
            p.rate = rate
            p.delegate = self
            p.prepareToPlay()
            p.currentTime = max(0, min(p.duration, pos))
            newP = p
        }
        fadeGeneration += 1
        stopPositionTimer()
        if wasPlaying {
            old.setVolume(0.0, fadeDuration: 0.03)
            newP.volume = 0.0
            newP.play()
            newP.setVolume(1.0, fadeDuration: 0.06)
        } else {
            newP.volume = 1.0
        }
        player = newP
        let retiring = old
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { retiring.stop() }
        if wasPlaying { startPositionTimer() }
        updateNowPlaying()
        NSLog("[BackgroundAudio] engine → %@ at %.2fs playing=%d", toRead ? "speech" : "default", pos, wasPlaying ? 1 : 0)
        return true
    }

    // MARK: - Spectrum (toolbar bars)

    private var fftSetup: FFTSetup?
    private var meterPhase: Float = 0

    /// `bands` levels 0…1 for the toolbar's spectrum bars, or nil when nothing
    /// is playing. The read engine yields a real spectrum (FFT of its output);
    /// AVAudioPlayer only meters loudness, so there the bars follow the
    /// narration's level with a gentle per-band variation.
    func spectrum(bands: Int) -> [Float]? {
        guard let p = player, p.isPlaying, bands > 0 else { return nil }
        if let e = p as? KadokiReadEngine {
            let x = e.recentSamples()
            let n = 512, log2n: vDSP_Length = 9
            if fftSetup == nil { fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) }
            guard let setup = fftSetup, x.count >= n else { return nil }
            var window = [Float](repeating: 0, count: n)
            vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
            var seg = Array(x.suffix(n))
            vDSP_vmul(seg, 1, window, 1, &seg, 1, vDSP_Length(n))
            var re = [Float](repeating: 0, count: n / 2), im = [Float](repeating: 0, count: n / 2)
            var mags = [Float](repeating: 0, count: n / 2)
            re.withUnsafeMutableBufferPointer { rp in
                im.withUnsafeMutableBufferPointer { ip in
                    var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                    seg.withUnsafeBufferPointer { sp in
                        sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                            vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                        }
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(n / 2))
                }
            }
            // Log-spaced bands across the voice range (~100 Hz – 6 kHz).
            let sr = e.scopeSampleRate, binHz = sr / Double(n)
            var out = [Float]()
            for b in 0..<bands {
                let lo = 100.0 * pow(60.0, Double(b) / Double(bands))
                let hi = 100.0 * pow(60.0, Double(b + 1) / Double(bands))
                let i0 = max(1, Int(lo / binHz)), i1 = max(i0 + 1, min(n / 2, Int(hi / binHz)))
                var m: Float = 0
                for i in i0..<i1 { m = max(m, mags[i]) }
                let db = 20 * log10(max(m, 1e-6))
                out.append(max(0, min(1, (db + 10) / 50)))
            }
            return out
        }
        if let a = p as? AVAudioPlayer {
            if !a.isMeteringEnabled { a.isMeteringEnabled = true }
            a.updateMeters()
            let db = a.averagePower(forChannel: 0)
            let level = max(0, min(1, (db + 45) / 40))
            meterPhase += 0.37
            return (0..<bands).map { b in
                // Voice-like tilt: strongest in the low-mids, tapering up.
                let x = (Float(b) + 0.5) / Float(bands)
                let shape: Float = 0.45 + 0.55 * sin(Float.pi * min(1, x * 1.4))
                let wobble = 0.85 + 0.15 * sin(meterPhase * (1.3 + Float(b) * 0.7))
                return max(0, min(1, level * shape * wobble))
            }
        }
        return nil
    }

    @objc func scrubBegin(_ call: CAPPluginCall) {
        guard let p = player else { call.resolve(["ok": false]); return }
        let anchorMs = call.getDouble("ms") ?? (p.currentTime * 1000)
        scrubActive = true
        scrubWasPlaying = p.isPlaying
        scrubAnchorMs = p.currentTime * 1000
        stopRateRamp()
        fadeGeneration += 1          // supersede any pending faded pause/seek
        scrubGen += 1
        let gen = scrubGen
        stopPositionTimer()
        // The engine is the voice now: dip + pause the main player.
        if p.isPlaying {
            p.setVolume(0.0, fadeDuration: 0.012)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.018) { [weak self] in
                guard let self = self, self.scrubActive, self.scrubGen == gen else { return }
                self.player?.pause()
            }
        }
        var engineOk = false
        if let url = Self.fileURL(from: currentUrlStr) {
            if scrubEngine == nil || scrubEngine?.url != url { scrubEngine = KadokiScrubEngine(url: url) }
            if let e = scrubEngine {
                ensureSessionActive()
                engineOk = e.begin(atMs: anchorMs)
            }
        }
        NSLog("[BackgroundAudio] scrubBegin anchor=%.0fms engine=%d wasPlaying=%d", anchorMs, engineOk ? 1 : 0, scrubWasPlaying ? 1 : 0)
        call.resolve([
            "ok": true,
            "engine": engineOk,
            "wasPlaying": scrubWasPlaying,
            "positionMs": Int(p.currentTime * 1000),
            "durationMs": Int(p.duration * 1000)
        ])
    }

    // Finger position update — called at touch-event rate. `snap` lands the
    // read head exactly on the target (first audible update of a drag) instead
    // of chasing it from the anchor.
    private var scrubVideoSeekTs: TimeInterval = 0
    @objc func scrub(_ call: CAPPluginCall) {
        guard scrubActive, let p = player else { call.resolve(); return }
        let ms = max(0, min(p.duration * 1000, call.getDouble("ms") ?? 0))
        let snap = call.getBool("snap") ?? false
        scrubEngine?.setTarget(ms: ms, snap: snap)
        // Video Titles: scrub the PICTURE too — seek the (paused) AVPlayer to
        // the finger at ~12 Hz so frames follow; the engine carries the sound.
        if let v = p as? KadokiVideoPlayer {
            let now = Date().timeIntervalSince1970
            if now - scrubVideoSeekTs > 0.08 {
                scrubVideoSeekTs = now
                v.currentTime = ms / 1000.0
            }
        }
        repeatGuardUntil = Date().timeIntervalSince1970 + 0.6; lastTickMs = -1; lastChapterIdx = -1
        // Position events at a sane cadence for the JS follow (which ignores
        // them mid-scrub anyway) and the watch/lock-screen mirrors.
        let now = Date().timeIntervalSince1970
        if now - scrubLastEmitTs > 0.12 {
            scrubLastEmitTs = now
            emitPosition(positionMs: Int(ms), durationMs: Int(p.duration * 1000), playing: true)
        }
        call.resolve()
    }

    @objc func scrubEnd(_ call: CAPPluginCall) {
        scrubGen += 1
        let wasActive = scrubActive
        scrubActive = false
        scrubEngine?.end()
        guard let p = player else { call.resolve(); return }
        let resume = call.getBool("resume") ?? scrubWasPlaying
        let rampFrom = Float(call.getDouble("rampFrom") ?? 0)
        if let ms = call.getDouble("ms") {
            p.currentTime = max(0, min(p.duration, ms / 1000.0))
        }
        fadeGeneration += 1
        seekGeneration += 1          // the scrub landing supersedes any seek still fading
        repeatGuardUntil = Date().timeIntervalSince1970 + 0.6; lastTickMs = -1; lastChapterIdx = -1
        let posMs = Int(p.currentTime * 1000)
        if resume {
            // The scrub engine is still fading out (12 ms ramp) at the FINGER
            // position; starting the player at the LANDING position underneath
            // it was a two-voice blip. Let the engine go silent first.
            let gen = scrubGen
            let tEnd = Date().timeIntervalSince1970
            NSLog("[scrub] end: resume requested at %d ms", posMs)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
                guard let self = self, self.scrubGen == gen, !self.scrubActive, let p = self.player else { return }
                self.ensureSessionActive()
                p.volume = 0.0
                p.play()
                NSLog("[scrub] player.play() %.0f ms after end", (Date().timeIntervalSince1970 - tEnd) * 1000)
                p.setVolume(1.0, fadeDuration: 0.05)
                if rampFrom > 0 && self.currentRate > rampFrom + 0.03 {
                    // Re-hear the scrubbed-over span at 1×, then ease back up.
                    self.startRateRamp(from: rampFrom, to: self.currentRate, seconds: Self.RAMP_SECONDS, holdUntilMs: self.scrubAnchorMs)
                }
                self.startPositionTimer()
                self.emitState(playing: true)
                self.emitPosition(positionMs: Int(p.currentTime * 1000), durationMs: Int(p.duration * 1000), playing: true)
                self.updateNowPlaying()
            }
        } else {
            p.pause()
            p.volume = 1.0
            stopPositionTimer()
            saveLastPositionNow()
            emitState(playing: false)
            emitPosition(positionMs: posMs, durationMs: Int(p.duration * 1000), playing: false)
            updateNowPlaying()
        }
        call.resolve(["ok": wasActive, "positionMs": posMs, "playing": resume])
    }

    private static func fileURL(from urlStr: String) -> URL? {
        if urlStr.isEmpty { return nil }
        if urlStr.hasPrefix("file://") {
            return URL(string: urlStr) ?? URL(fileURLWithPath: String(urlStr.dropFirst(7)))
        }
        return URL(fileURLWithPath: urlStr)
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1.0)
        guard rate > 0 else { call.reject("rate must be > 0"); return }
        stopRateRamp()
        currentRate = rate
        player?.rate = rate
        updateNowPlaying()
        call.resolve()
    }

    /// Display-only: toggle the system idle timer so the screen won't dim/sleep
    /// while reading (keep-awake.js owns the on/off policy + inactivity timer).
    /// Must run on the main thread. No audio/playback/position side effects.
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
        }
        call.resolve()
    }

    /// Enable/disable native chapter-repeat and (re)load the chapter table.
    /// `chapters`: [{idx, startMs, endMs, announce}]. Turning it OFF aborts any
    /// in-flight announcement and guarantees playback resumes.
    @objc func setChapterRepeat(_ call: CAPPluginCall) {
        // Capacitor calls this on a BACKGROUND queue, but the repeat machinery (the
        // position Timer, the main-installed failsafe Timer, AVSpeechSynthesizer, and
        // all the chapter state) runs on MAIN. Marshal onto main so we never race the
        // timer's reads of `chapters`/lastTickMs nor touch the synth off-thread.
        let enabled = call.getBool("enabled") ?? false
        let raw = call.getArray("chapters")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            let wasOn = self.chapterRepeatOn
            let oldCount = self.chapters.count
            self.chapterRepeatOn = enabled
            if let raw = raw {
                var list: [ChapterBound] = []
                for item in raw {
                    guard let o = item as? JSObject else { continue }
                    let idx = (o["idx"] as? Int) ?? Int((o["idx"] as? Double) ?? -1)
                    let s   = (o["startMs"] as? Int) ?? Int((o["startMs"] as? Double) ?? -1)
                    let e   = (o["endMs"] as? Int) ?? Int((o["endMs"] as? Double) ?? -1)
                    let a   = (o["announce"] as? String) ?? ""
                    if idx >= 0, s >= 0, e >= s { list.append(ChapterBound(idx: idx, startMs: s, endMs: e, announce: a)) }
                }
                list.sort { $0.startMs < $1.startMs }
                self.chapters = list
            }
            // Fresh arm (off→on) or a re-segment (chapter count changed) starts the
            // "once each" budget over. A benign re-send with the SAME chapters (e.g. the
            // kai:ai-data map refresh that fires while listening) preserves what's done.
            if enabled && (!wasOn || self.chapters.count != oldCount) { self.repeatedChapters.removeAll() }
            self.lastTickMs = -1; self.lastChapterIdx = -1
            // Disable: cancel any in-flight announce, but only RESUME if WE paused for
            // it (repeatBusy). abortSpeechAndEnsurePlaying gates the resume on that, so a
            // user-paused book is left paused (don't spuriously un-pause).
            if !self.chapterRepeatOn { self.repeatPassIdx = -1; self.abortSpeechAndEnsurePlaying() }
            call.resolve()
        }
    }

    /// Jump to the start of the next chapter (skips any pending repeat/announce).
    /// Always ends playing.
    @objc func skipToNextChapter(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in   // main: shared repeat state + synth + timers live here
            guard let self = self, let p = self.player else { call.resolve(); return }
            let curIdx = self.chapterIndexForMs(Int(p.currentTime * 1000))
            // We're skipping out of this chapter (whether mid-repeat or not) → mark it
            // done so re-entering it later won't repeat it again.
            let leaving = self.repeatPassIdx >= 0 ? self.repeatPassIdx : curIdx
            if leaving >= 0 { self.repeatedChapters.insert(leaving) }
            self.repeatPassIdx = -1
            self.speakGen += 1; self.failsafeTimer?.invalidate(); self.failsafeTimer = nil; self.pendingSpeechCompletion = nil
            if self.speechSynth.isSpeaking { self.speechSynth.stopSpeaking(at: .immediate) }
            if let next = self.chapters.first(where: { $0.idx == curIdx + 1 }) {
                self.seekGeneration += 1
                p.currentTime = max(0, min(p.duration, TimeInterval(next.startMs) / 1000.0))
                self.repeatGuardUntil = Date().timeIntervalSince1970 + 0.6
                self.lastTickMs = Int(p.currentTime * 1000); self.lastChapterIdx = next.idx
                self.saveLastPositionNow()
                self.notifyChapter(idx: next.idx, repeating: false, reason: "skip")
            } else { self.notifyChapter(idx: curIdx, repeating: false, reason: "skip") }
            self.ensureSessionActive(); self.startFaded(p)
            self.startPositionTimer(); self.emitState(playing: true); self.updateNowPlaying()
            self.repeatBusy = false; call.resolve()
        }
    }

    /// Cancel any in-flight announcement/failsafe. Resume the book ONLY if WE paused
    /// it for an announce (repeatBusy) — never un-pause a book the USER paused.
    /// Caller runs this on the main thread (timer machinery lives there).
    private func abortSpeechAndEnsurePlaying() {
        speakGen += 1; failsafeTimer?.invalidate(); failsafeTimer = nil; pendingSpeechCompletion = nil
        if speechSynth.isSpeaking { speechSynth.stopSpeaking(at: .immediate) }
        let wasBusy = repeatBusy
        repeatBusy = false
        // A repeat pause still fading out counts as paused (startFaded cancels it).
        guard wasBusy, let p = player, !p.isPlaying || pauseFadePending else { return }
        // If we paused for the FINAL chapter's EOF announce, the playhead sits at end —
        // play() there can restart the file from 0 (place jump). End the book cleanly.
        if p.duration > 0, p.currentTime >= p.duration - 0.05 { finishBookAtEof(); return }
        ensureSessionActive(); startFaded(p); startPositionTimer(); emitState(playing: true); updateNowPlaying()
    }

    private func notifyChapter(idx: Int, repeating: Bool, reason: String) {
        notifyListeners("chapterRepeat", data: ["idx": idx, "repeating": repeating, "reason": reason, "ts": Int(Date().timeIntervalSince1970 * 1000)])
    }

    @objc func getState(_ call: CAPPluginCall) {
        let p = player
        let positionMs: Int = Int((p?.currentTime ?? 0) * 1000)
        let durationMs: Int = Int((p?.duration ?? 0) * 1000)
        call.resolve([
            "playing":    p?.isPlaying ?? false,
            "ready":      p != nil,
            "positionMs": positionMs,
            "durationMs": durationMs,
            "url":        (p != nil) ? currentUrlStr : "",
            "engine":     activeEngineName()
        ])
    }

    @objc func setMetadata(_ call: CAPPluginCall) {
        if let t = call.getString("title"),    !t.isEmpty { nowPlayingTitle = t }
        if let s = call.getString("subtitle")             { nowPlayingSubtitle = s }
        // Cover art for the lock screen / Control Center. Accepts a data URI
        // ("data:image/...;base64,XXXX") or raw base64. Empty string clears it.
        if let art = call.getString("artwork") { setArtwork(from: art) }
        updateNowPlaying()
        call.resolve()
    }

    private func setArtwork(from s: String) {
        if s.isEmpty { nowPlayingArtwork = nil; nowPlayingCoverImage = nil; return }
        var b64 = s
        if s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") {
            b64 = String(s[s.index(after: comma)...])
        }
        guard let data = Data(base64Encoded: b64), let img = UIImage(data: data) else {
            return // decode failed — keep whatever artwork we had
        }
        nowPlayingCoverImage = img
        nowPlayingArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
    }

    // MARK: - Subtitle artwork (serif sentence over the dimmed cover)

    /// Render the current subtitle as the Now Playing artwork: the book cover
    /// (aspect-filled + darkened) behind large centered SERIF text. Called on
    /// each cue change from JS. Runs on the plugin's background queue, which is
    /// fine — UIGraphicsImageRenderer is safe off the main thread and this keeps
    /// the per-sentence render off the audio/UI path.
    @objc func setSubtitleArt(_ call: CAPPluginCall) {
        renderSubtitleArtwork(text: call.getString("text") ?? "")
        call.resolve()
    }

    private func renderSubtitleArtwork(text: String) {
        guard player != nil else { return }   // a setSubtitleArt racing stop() teardown — skip the raster
        let clean = text
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let side: CGFloat = 600
        let size = CGSize(width: side, height: side)
        let pad: CGFloat = 48
        let maxW = side - pad * 2
        let maxH = side - pad * 2

        // Serif (mincho) face that renders Japanese. Hiragino Mincho first; if a
        // weight isn't instantiable by name, fall back to the system SERIF design
        // (still serif + CJK cascade), NOT sans-serif San Francisco.
        func serifFont(_ pt: CGFloat) -> UIFont {
            if let f = UIFont(name: "HiraMinProN-W6", size: pt) { return f }
            if let f = UIFont(name: "HiraMinProN-W3", size: pt) { return f }
            let base = UIFont.systemFont(ofSize: pt, weight: .semibold)
            if let d = base.fontDescriptor.withDesign(.serif) { return UIFont(descriptor: d, size: pt) }
            return base
        }
        // scale=1 (a 600x600 @1x is ample for lock-screen art) keeps each render
        // ~1.4 MB instead of ~12 MB at the default @3x, and avoids the default
        // format's main-thread UIScreen.scale lookup (we run on a background queue).
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: fmt)
        let img = renderer.image { ctx in
            let rect = CGRect(origin: .zero, size: size)
            // Black base + the book cover aspect-FILLED on top at 35% alpha —
            // drawing an image at alpha over an opaque black base is exactly
            // equivalent to a 65%-opaque black scrim over the full image, the
            // usual "dim a photo for text overlay" technique. Falls back to
            // the old near-black radial vignette when there's no cover (e.g.
            // a title with no artwork yet) — a blank cover would otherwise
            // just render as a flat 35%-black square.
            UIColor.black.setFill()
            ctx.fill(rect)
            if let cover = nowPlayingCoverImage, cover.size.width > 0, cover.size.height > 0 {
                let scale = max(side / cover.size.width, side / cover.size.height)
                let drawW = cover.size.width * scale
                let drawH = cover.size.height * scale
                let drawRect = CGRect(x: (side - drawW) / 2, y: (side - drawH) / 2, width: drawW, height: drawH)
                cover.draw(in: drawRect, blendMode: .normal, alpha: 0.35)
            } else {
                let colors = [UIColor(red: 0.14, green: 0.14, blue: 0.14, alpha: 1).cgColor,
                              UIColor(red: 0.02, green: 0.02, blue: 0.02, alpha: 1).cgColor] as CFArray
                if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                         colors: colors, locations: [0, 1]) {
                    let c = CGPoint(x: side / 2, y: side / 2)
                    ctx.cgContext.drawRadialGradient(
                        grad, startCenter: c, startRadius: 0,
                        endCenter: c, endRadius: side * 0.70,
                        options: [.drawsAfterEndLocation])
                }
            }
            guard !clean.isEmpty else { return }

            let para = NSMutableParagraphStyle()
            para.alignment = .center
            para.lineBreakMode = .byCharWrapping   // Japanese has no spaces to break on

            // A cover background is far less predictable than the old flat
            // near-black one (bright/busy art under any given line of text),
            // so the shadow needs to carry legibility on its own now — bigger
            // blur + darker + a touch more offset than the old subtle version.
            let shadow = NSShadow()
            shadow.shadowColor = UIColor(white: 0, alpha: 0.95)
            shadow.shadowBlurRadius = 10
            shadow.shadowOffset = CGSize(width: 0, height: 2)

            // Largest font (80→24 pt) whose wrapped text fits the padded box.
            // Capture the winning wrapped height so we don't re-measure for
            // vertical centering (boundingRect ignores .shadow, so it matches).
            var chosen = serifFont(24)
            var fitH = maxH
            var pt: CGFloat = 80
            while pt >= 24 {
                let f = serifFont(pt)
                let h = (clean as NSString).boundingRect(
                    with: CGSize(width: maxW, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin, .usesFontLeading],
                    attributes: [.font: f, .paragraphStyle: para],
                    context: nil).height
                chosen = f
                fitH = h
                if h <= maxH { break }
                pt -= 4
            }

            let attrs: [NSAttributedString.Key: Any] = [
                .font: chosen,
                .foregroundColor: UIColor.white,
                .paragraphStyle: para,
                .shadow: shadow
            ]
            let y = pad + max(0, (maxH - min(fitH, maxH)) / 2)
            (clean as NSString).draw(
                with: CGRect(x: pad, y: y, width: maxW, height: maxH),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: attrs, context: nil)
        }

        nowPlayingArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        updateNowPlaying()
    }

    // MARK: - Position events

    private func startPositionTimer() {
        stopPositionTimer()
        // 150 ms matches the Android polling cadence so cue tracking + the
        // waveform editor's playhead behave identically across platforms.
        //
        // CRITICAL: schedule on the MAIN runloop in .common mode. Capacitor
        // plugin methods run on a background dispatch queue whose runloop
        // doesn't pump scheduled timers; using Timer.scheduledTimer from
        // there silently never fires. .common mode keeps the timer alive
        // during scrolling / modal presentation. This is the bug that made
        // cues / subtitles / reader-follow appear frozen while audio still
        // played fine.
        // 150ms while visible (instant cue tracking); ~1s backgrounded/screen-off
        // where nobody sees it (battery). updateNowPlaying keeps the lock screen
        // correct via the playbackRate-extrapolated scrubber regardless.
        let interval: TimeInterval = uiVisible ? 0.15 : 1.0
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            guard let self = self, let p = self.player else { return }
            self.emitPosition(positionMs: Int(p.currentTime * 1000),
                              durationMs: Int(p.duration * 1000),
                              playing: p.isPlaying)
            // Native chapter-repeat boundary detection (works backgrounded/locked).
            self.maybeChapterRepeat(currentMs: Int(p.currentTime * 1000))
            // Durable place snapshot ~every 5s while playing (BookPlayer-style).
            let now = Date().timeIntervalSince1970
            if p.isPlaying && now - self.lastDurableSaveAt >= 5 { self.saveLastPositionNow() }
            if !p.isPlaying {
                self.stopPositionTimer()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        positionTimer = timer
    }

    private func stopPositionTimer() {
        positionTimer?.invalidate()
        positionTimer = nil
    }

    // MARK: - Chapter-repeat detection + machinery

    /// Index of the chapter whose [startMs..) contains `ms` (chapters sorted by
    /// startMs). Returns -1 before the first chapter start.
    private func chapterIndexForMs(_ ms: Int) -> Int {
        var idx = -1
        for c in chapters { if c.startMs <= ms { idx = c.idx } else { break } }
        return idx
    }

    /// Called every position tick. Detects a NATURAL forward crossing from one
    /// chapter into the next (small positive delta = real playback, not a scrub),
    /// repeats the just-ended chapter once, then lets the next crossing advance.
    private func maybeChapterRepeat(currentMs ms: Int) {
        guard chapterRepeatOn, !repeatBusy, !chapters.isEmpty else { return }
        let curIdx = chapterIndexForMs(ms)
        let prevMs = lastTickMs, prevIdx = lastChapterIdx
        lastTickMs = ms; lastChapterIdx = curIdx
        if repeatGuardUntil > 0, Date().timeIntervalSince1970 < repeatGuardUntil { return }
        guard prevMs >= 0, prevIdx >= 0, curIdx >= 0 else { return }
        let delta = ms - prevMs
        let cap = Int((uiVisible ? 0.15 : 1.0) * Double(max(1.0, currentRate)) * 1000.0) + 1500
        guard delta > 0, delta < cap else { return }
        guard curIdx == prevIdx + 1 else { return }
        // The repeat pass for prevIdx just ended → mark it done so it never repeats
        // again (e.g. if the user later scrubs back into it), then advance.
        if repeatPassIdx == prevIdx { repeatedChapters.insert(prevIdx); repeatPassIdx = -1; notifyChapter(idx: curIdx, repeating: false, reason: "advance"); return }
        // Already repeated once this session → don't repeat again (skip-back safe).
        if repeatedChapters.contains(prevIdx) { return }
        guard let ended = chapters.first(where: { $0.idx == prevIdx }) else { return }
        repeatPassIdx = prevIdx
        doChapterRepeat(ended)
    }

    /// Pause → announce → (on speech finish/failsafe) seek back to chapter start →
    /// resume. Ends playing — unless the user paused, stopped, seeked or switched
    /// title during the announcement, in which case their newer intent wins.
    private func doChapterRepeat(_ ch: ChapterBound, isFinal: Bool = false) {
        guard let p = player, !repeatBusy else { return }
        repeatBusy = true
        let target = TimeInterval(ch.startMs) / 1000.0
        notifyChapter(idx: ch.idx, repeating: true, reason: "repeat")
        pauseFaded(p) {}   // click-free: the boundary's sound ramps out before the announce
        // Save the SEEK TARGET (chapter start), not the live playhead — which at a
        // boundary is the NEXT chapter's start and at EOF is end-of-book — so a kill
        // mid-announce restores to the chapter being repeated, never ahead of it.
        stopPositionTimer(); saveDurablePositionMs(ch.startMs); emitState(playing: false); updateNowPlaying()
        postLiveTick(ms: ch.startMs, playing: false)   // watch karaoke parks at the chapter start during the announce
        let transport = transportGen, seek = seekGeneration
        speakAnnounce(ch.announce) { [weak self] in
            self?.finishRepeat(seekTo: target, passIdx: ch.idx, isFinal: isFinal, owner: p, transport: transport, seek: seek)
        }
    }

    private func finishRepeat(seekTo target: TimeInterval, passIdx: Int, isFinal: Bool,
                              owner: KadokiPlayback, transport: Int, seek: Int) {
        // Only the player this repeat paused: a title switch replaced it, and this
        // completion must never seek or start the new title.
        guard let p = player, p === owner else { repeatBusy = false; return }
        let userSeeked = seekGeneration != seek          // they chose a position mid-announce
        let userTransport = transportGen != transport    // they paused / resumed / stopped mid-announce
        let passLive = chapterRepeatOn && repeatPassIdx == passIdx
        // Land the chapter start — the spot doChapterRepeat already saved — unless a
        // user seek chose another, or the user already resumed from where it was.
        if passLive && !userSeeked && !(userTransport && p.isPlaying) {
            p.currentTime = max(0, min(p.duration, target))
            seekGeneration += 1
            saveLastPositionNow()
            repeatGuardUntil = Date().timeIntervalSince1970 + 0.6
            lastTickMs = Int(p.currentTime * 1000); lastChapterIdx = passIdx
        }
        // The final chapter has no next crossing to clear the pass — clear it here
        // so a later skipToNextChapter doesn't mis-mark this idx as the one left.
        if passLive && isFinal { repeatPassIdx = -1 }
        repeatBusy = false
        if userTransport {
            // Newest explicit intent wins: leave play/pause exactly as the user set it.
            if !p.isPlaying { saveLastPositionNow() }
            updateNowPlaying()
            return
        }
        ensureSessionActive(); startFaded(p)
        startPositionTimer(); emitState(playing: true); updateNowPlaying()
    }

    /// Speak `text` (ja-JP) through the active session; the single-fire completion
    /// runs on didFinish/didCancel OR a 6s failsafe Timer — whichever first — so a
    /// dropped/blocked synth never leaves the book paused.
    private func speakAnnounce(_ text: String, completion: @escaping () -> Void) {
        speakGen += 1; let gen = speakGen
        let fire: () -> Void = { [weak self] in
            guard let self = self, self.speakGen == gen else { return }
            self.speakGen += 1
            self.failsafeTimer?.invalidate(); self.failsafeTimer = nil
            self.pendingSpeechCompletion = nil
            completion()
        }
        pendingSpeechCompletion = fire
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { fire(); return }
        let u = AVSpeechUtterance(string: clean)
        u.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        u.rate = AVSpeechUtteranceDefaultSpeechRate; u.postUtteranceDelay = 0.1
        let t = Timer(timeInterval: 6.0, repeats: false) { _ in fire() }
        RunLoop.main.add(t, forMode: .common); failsafeTimer = t
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.speakGen == gen else { return }
            self.speechSynth.speak(u)
        }
    }

    // ts: emit-time stamp (epoch ms, same convention as the remoteCommand
    // events above) so JS can drop events that queued while the WebView was
    // suspended and replay in a stale burst on foreground — the rapid
    // card-scroll / stale-restart guards key off it.
    private func emitPosition(positionMs: Int, durationMs: Int, playing: Bool) {
        self.notifyListeners("position", data: [
            "positionMs": positionMs,
            "durationMs": durationMs,
            "playing":    playing,
            "ts":         Int(Date().timeIntervalSince1970 * 1000)
        ])
        postLiveTick(ms: positionMs, playing: playing)
        #if os(visionOS)
        // Feed the transport ornament's video progress row.
        NotificationCenter.default.post(name: Notification.Name("KadokiAudioProgress"),
                                        object: nil, userInfo: ["pos": positionMs, "dur": durationMs])
        #endif
    }

    // Pure notification post — no playback side effects — safe to call from
    // any state transition. The position TIMER stops while paused, so
    // pause()/seek() call this directly too; otherwise the watch's cached
    // frame would keep showing "playing" from before the pause indefinitely.
    private func postLiveTick(ms: Int, playing: Bool) {
        NotificationCenter.default.post(name: .kadokiPositionTick, object: nil, userInfo: [
            "ms": ms, "playing": playing, "rate": currentRate,
            "ts": Int(Date().timeIntervalSince1970 * 1000)
        ])
    }

    private func emitState(playing: Bool) {
        self.notifyListeners("state", data: [
            "playing": playing,
            "ts":      Int(Date().timeIntervalSince1970 * 1000)
        ])
        // Native transport surfaces (the visionOS ornament) mirror play state
        // through NotificationCenter — no-op elsewhere (no observers).
        NotificationCenter.default.post(name: Notification.Name("KadokiAudioState"),
                                        object: nil, userInfo: ["playing": playing])
    }

    // MARK: - Now Playing (lock screen + Control Center)

    private func updateNowPlaying() {
        guard let p = player else { clearNowPlaying(); return }
        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle]              = nowPlayingTitle
        info[MPMediaItemPropertyArtist]             = nowPlayingSubtitle
        info[MPMediaItemPropertyPlaybackDuration]   = p.duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime
        // Rate 0 means paused; the system shows a play icon then.
        info[MPNowPlayingInfoPropertyPlaybackRate]  = p.isPlaying ? Double(currentRate) : 0.0
        if let art = nowPlayingArtwork { info[MPMediaItemPropertyArtwork] = art }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}

// MARK: - AVAudioPlayerDelegate

extension BackgroundAudioPlugin: AVAudioPlayerDelegate {
    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        handleNaturalEnd()
    }
    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        handlePlaybackError(message: error?.localizedDescription ?? "unknown decode error")
    }
}

// MARK: - Engine-agnostic end / error paths (audio delegate + video observers)

extension BackgroundAudioPlugin {
    func handleNaturalEnd() {
        // The audio delegate can arrive off-main (playback was started on the plugin's
        // background queue), but the repeat machinery — the main-RunLoop position +
        // failsafe timers and the synth — must run on main. Marshal, then recapture
        // all repeat state inside the hop (it may have changed e.g. via stop()).
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Last-chapter repeat: the final chapter has no "next" to cross INTO, so the
            // crossing detector never fires for it. Trigger its one repeat here at EOF
            // instead of ending. Mark it done first so the SECOND EOF ends normally.
            // Gate on >=2 chapters (a 1-chapter "book" would replay the whole thing) and
            // on a live player (a concurrent stop() may have nil'd it).
            if self.chapterRepeatOn, !self.repeatBusy, self.chapters.count >= 2,
               let last = self.chapters.last, !self.repeatedChapters.contains(last.idx),
               let p = self.player, p.duration > 0 {
                self.repeatedChapters.insert(last.idx)
                self.repeatPassIdx = last.idx   // finishRepeat seeks back to last.startMs only when repeatPassIdx == passIdx
                self.doChapterRepeat(last, isFinal: true)
                return
            }
            self.finishBookAtEof()
        }
    }
    func handlePlaybackError(message: String) {
        stopPositionTimer()
        // Order matters: 'error' BEFORE the state(false) — the JS error
        // handler captures _bgPlaying at entry to decide whether to restart
        // playback after the self-heal (matches the Android onPlayerError).
        // ts lets JS tell a live error from one replayed from the suspended
        // bridge backlog (a stale error must not auto-restart playback).
        self.notifyListeners("error", data: [
            "message": message,
            "ts":      Int(Date().timeIntervalSince1970 * 1000)
        ])
        // Playback is dead: tell JS explicitly so window._bgPlaying can't
        // stay stale-true (the position poll above just stops silently).
        emitState(playing: false)
        postLiveTick(ms: Int((player?.currentTime ?? 0) * 1000), playing: false)
        updateNowPlaying()
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension BackgroundAudioPlugin: AVSpeechSynthesizerDelegate {
    // AVSpeechSynthesizer delivers delegate callbacks on an undocumented (often
    // non-main) thread. Hop to main so the completion's Timer.invalidate /
    // RunLoop.main.add(positionTimer) / speakGen dedup all run on the install thread
    // (this file's timer discipline) — otherwise the post-repeat position timer can
    // silently never fire.
    public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { DispatchQueue.main.async { [weak self] in self?.pendingSpeechCompletion?() } }
    public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { DispatchQueue.main.async { [weak self] in self?.pendingSpeechCompletion?() } }
}


// MARK: - KadokiScrubEngine
//
// Turntable-style scrub: a decoded float-PCM window around the anchor, read
// by an AVAudioSourceNode at a fractional position that advances by a signed
// velocity every sample (4-point Hermite interpolation). The finger sets
// `target`; each render buffer computes the velocity that would close the
// gap in TAU seconds (platter inertia), ramps to it across the buffer (no
// zipper), and integrates. Speed and direction are therefore continuous —
// reverse playback and slow motion fall out for free, pitch follows speed
// like vinyl, and a resting finger converges and goes silent. Gain ramps in
// on the first target and out on end(), so start/stop never click.
//
// Window: `begin` decodes ±INITIAL_SEC synchronously (hardware AAC decode ≈
// tens of ms), then a background queue grows it to ±GROW_SEC in stages and
// re-centres it if the finger runs past an edge. Buffers are swapped by
// reference under a short lock (Swift arrays are COW), so the render thread
// never waits on a decode. Graph: source → mainMixer → output; an AUv3
// effect could be inserted between source and mixer later.
final class KadokiScrubEngine {
    let url: URL
    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode!
    private let file: AVAudioFile
    let sampleRate: Double
    private let totalFrames: Int64
    private let lock = NSLock()
    private var bufL: [Float] = []
    private var bufR: [Float] = []
    // Previous window kept alive until the NEXT swap so the render thread's
    // reference is never the last one (a multi-MB free on the audio thread
    // would glitch).
    private var retiredL: [Float] = []
    private var retiredR: [Float] = []
    private var winStart: Int64 = 0
    private var pos: Double = 0
    private var target: Double = 0
    private var vel: Double = 0
    private var gain: Float = 0
    private var gainTarget: Float = 0
    private var snapPending = false
    private let decodeQ = DispatchQueue(label: "kadoki.scrub.decode", qos: .userInteractive)
    private var decodeGen = 0
    private var decodeBusy = false
    private var lastEnsureAt: TimeInterval = 0
    private static let PRIME_SEC = 3.0            // synchronous: ready in a few ms
    private static let INITIAL_SEC = 12.0
    // A NEW area mid-drag: seed a SMALL window first (±1.5 s ≈ a few ms of
    // decode) and grow behind it — reloading ±INITIAL_SEC (24 s of audio) at
    // every jump was the 100-300 ms of silence before the scrub sound came back.
    private static let RELOAD_SEC = 1.5
    private static let GROW_SEC: [Double] = [12, 40, 80]
    private static let TAU_SEC = 0.032
    // Speed cap: beyond this the sound is a squeal, not scrubbing. A gap the
    // cap couldn't close quickly SNAPS instead (SNAP_SEC), with a 12 ms gain
    // dip, so a fast throw never leaves the head chasing at full squeal for
    // seconds after the finger has stopped.
    private static let MAX_SPEED = 8.0
    // Scrub audio is pitched DOWN two octaves (Sonic pitch shift, speed 1×)
    // so the doubled travel per swipe keeps the turntable "effect" without
    // the squeal (user, 2026-09-10).
    private static let SCRUB_PITCH: Float = 0.5   // one octave (user, 2026-09-10; two was too dark)
    private var pitchStream: sonicStream? = nil
    private var pitchTmp: [Float] = []
    private var pitchOut: [Float] = []
    // Output queue after the pitch stage: Sonic emits in pitch-period bursts,
    // so a per-call read came back short or empty at random — zero-filling
    // those was the "clicks when scrubbing". Prime ~1 buffer, then steady.
    private static let FIFO_CAP = 16384
    private var pitchFifo: [Float] = []
    private var fifoHead = 0, fifoCount = 0
    private var fifoPrimed = false
    private var fifoUnderruns = 0
    private var fifoFade = 0, fifoFadeTotal = 1     // short fade-in after (re)priming — no step from silence
    private var pitchSpeed: Float = 1.0             // ±3 % steering keeps the queue at its setpoint (Sonic's in/out drift)
    // Session gain applied AFTER the pitch stage: end() silences the actual
    // output at once instead of leaving a Sonic-latency tail under the
    // resumed player (the "short latency when starting").
    private var masterGain: Float = 0
    private static let SNAP_SEC = 0.7
    // Fast passes are where the squeal lives: duck the level as |speed| rises
    // (full ≤1.5×, ~0.2 by ~6×) and roll off the top end with a one-pole
    // low-pass whose cutoff falls with speed — the scratch keeps its texture,
    // the shriek goes. Both ramp per buffer (no zipper).
    private var vGain: Float = 1
    private var lpL: Float = 0, lpR: Float = 0
    private var snapArmed = false     // jump the head once the gain has ramped to zero
    private static let GAIN_RAMP_SEC = 0.012

    init?(url: URL) {
        self.url = url
        guard let f = try? AVAudioFile(forReading: url) else { return nil }
        file = f
        sampleRate = f.processingFormat.sampleRate
        totalFrames = KadokiReadEngine.trustedLength(url: url, file: f)   // VBR-safe (see there)
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else { return nil }
        source = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, abl -> OSStatus in
            self?.render(frameCount, abl)
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 1.0
        if let ps = sonicCreateStream(Int32(sampleRate), 2) {
            sonicIntSetQuality(ps, 1)   // full pitch-period search: the fast search glitched on resampled (unnatural-pitch) input
            sonicSetSpeed(ps, 1.0)
            sonicIntSetPitch(ps, Self.SCRUB_PITCH)
            pitchStream = ps
        }
    }
    deinit { if let ps = pitchStream { sonicDestroyStream(ps) } }

    var currentMs: Double { lock.lock(); defer { lock.unlock() }; return pos / sampleRate * 1000 }

    // True when the running engine already holds decoded audio around `frame`.
    private func isWarm(at frame: Int64) -> Bool {
        guard engine.isRunning else { return false }
        lock.lock(); let ws = winStart, len = Int64(bufL.count); lock.unlock()
        let m = Int64(1.5 * sampleRate)
        return frame - m >= ws && frame + m <= ws + len
    }

    /// Finger-down warm-up: silent, started, PRIME_SEC decoded around `ms`,
    /// growing in the background. Cheap to call repeatedly.
    @discardableResult
    func prime(atMs ms: Double) -> Bool {
        let anchor = Int64(max(0, min(Double(totalFrames), ms / 1000 * sampleRate)))
        if isWarm(at: anchor) {
            lock.lock(); gainTarget = 0; decodeGen += 1; lock.unlock()
            return true
        }
        // Seed only (±PRIME_SEC, a few ms). Growing the window here cost up to
        // 160 s of MP3 decode on EVERY touch in the reader (page turns
        // included) — a measurable share of a long session's heat. The
        // window grows once a drag actually begins (begin()).
        return start(anchor: anchor, grow: false)
    }

    private var everBegan = false   // a real drag happened this session (vs prime-only touch)
    @discardableResult
    func begin(atMs ms: Double) -> Bool {
        everBegan = true
        let anchor = Int64(max(0, min(Double(totalFrames), ms / 1000 * sampleRate)))
        if isWarm(at: anchor) {
            // Primed: just re-aim. No decode, no engine start.
            lock.lock()
            pos = Double(anchor); target = Double(anchor); vel = 0; gain = 0; gainTarget = 0; snapPending = false
            decodeGen += 1
            let gen = decodeGen
            lock.unlock()
            decodeQ.async { [weak self] in
                guard let self = self else { return }
                for h in Self.GROW_SEC { if !self.grow(toHalfSec: h, gen: gen) { break } }
            }
            return true
        }
        return start(anchor: anchor, grow: true)
    }

    private func start(anchor: Int64, grow: Bool) -> Bool {
        lock.lock()
        pos = Double(anchor); target = Double(anchor); vel = 0; gain = 0; gainTarget = 0; snapPending = false
        lpL = 0; lpR = 0; vGain = 1; snapArmed = false
        decodeGen += 1
        let gen = decodeGen
        lock.unlock()
        let t0 = Date()
        loadWindow(center: anchor, halfSec: Self.PRIME_SEC, gen: gen)
        NSLog("[ScrubEngine] prime window %.0f ms", Date().timeIntervalSince(t0) * 1000)
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch {
                NSLog("[ScrubEngine] engine start failed: %@", error.localizedDescription)
                return false
            }
        }
        if grow {
            decodeQ.async { [weak self] in
                guard let self = self else { return }
                for h in Self.GROW_SEC { if !self.grow(toHalfSec: h, gen: gen) { break } }
            }
        }
        return true
    }

    func setTarget(ms: Double, snap: Bool) {
        let f = max(0, min(Double(totalFrames), ms / 1000 * sampleRate))
        lock.lock()
        target = f
        if snap { snapPending = true }
        gainTarget = 1.0
        let ws = winStart, len = bufL.count, gen = decodeGen
        lock.unlock()
        // Re-centre when the finger nears an edge of the decoded window.
        let margin = 2.0 * sampleRate
        let now = Date().timeIntervalSince1970
        if (f < Double(ws) + margin || f > Double(ws + Int64(len)) - margin) && !decodeBusy && now - lastEnsureAt > 0.06 {
            lastEnsureAt = now
            let inside = f >= Double(ws) && f < Double(ws + Int64(len))
            decodeQ.async { [weak self] in
                guard let self = self else { return }
                if inside { _ = self.grow(toHalfSec: Self.GROW_SEC.last ?? 60, gen: gen) }
                else { self.loadWindow(center: Int64(f), halfSec: Self.RELOAD_SEC, gen: gen)
                       for h in [Self.PRIME_SEC] + Self.GROW_SEC { if !self.grow(toHalfSec: h, gen: gen) { break } } }
            }
        }
    }

    func end() {
        lock.lock(); gainTarget = 0; decodeGen += 1; let endGen = decodeGen; lock.unlock()
        // Stay running (silent) for a while: consecutive swipes reuse the live
        // engine and never pay an audio-unit stop/start, which can pop. A
        // prime-only touch (page turn, tap) never made a sound — stop it soon.
        let keep: Double = everBegan ? 6.0 : 1.2
        DispatchQueue.main.asyncAfter(deadline: .now() + keep) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let stillEnded = (self.decodeGen == endGen)
            self.lock.unlock()
            guard stillEnded else { return }     // a new prime()/begin() raced in
            self.engine.stop()
            self.everBegan = false
            // Release on THIS (main) thread, after the render callback is gone.
            self.lock.lock()
            let dropL = self.bufL, dropR = self.bufR, dropRL = self.retiredL, dropRR = self.retiredR
            self.bufL = []; self.bufR = []; self.retiredL = []; self.retiredR = []
            self.lock.unlock()
            _ = (dropL.count, dropR.count, dropRL.count, dropRR.count)
        }
    }

    // MARK: decode

    private func readFrames(from start: Int64, count: Int) -> ([Float], [Float])? {
        guard count > 0, start >= 0, start < totalFrames else { return nil }
        let n = AVAudioFrameCount(min(Int64(count), totalFrames - start))
        guard let pcm = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: n) else { return nil }
        do {
            file.framePosition = start
            try file.read(into: pcm, frameCount: n)
        } catch {
            NSLog("[ScrubEngine] read failed @%lld: %@", start, error.localizedDescription)
            return nil
        }
        let got = Int(pcm.frameLength)
        guard got > 0, let ch = pcm.floatChannelData else { return nil }
        let l = Array(UnsafeBufferPointer(start: ch[0], count: got))
        let r = pcm.format.channelCount > 1 ? Array(UnsafeBufferPointer(start: ch[1], count: got)) : l
        return (l, r)
    }

    private func loadWindow(center: Int64, halfSec: Double, gen: Int) {
        decodeBusy = true; defer { decodeBusy = false }
        let half = Int64(halfSec * sampleRate)
        let start = max(0, center - half)
        let end = min(totalFrames, center + half)
        guard let (l, r) = readFrames(from: start, count: Int(end - start)) else { return }
        lock.lock()
        if gen == decodeGen { retiredL = bufL; retiredR = bufR; bufL = l; bufR = r; winStart = start }
        lock.unlock()
    }

    // Grow the window symmetrically around the CURRENT read position to
    // ±halfSec. Returns false when cancelled (a newer session began).
    private func grow(toHalfSec halfSec: Double, gen: Int) -> Bool {
        decodeBusy = true; defer { decodeBusy = false }
        lock.lock()
        guard gen == decodeGen else { lock.unlock(); return false }
        let curL = bufL, curR = bufR, ws = winStart, p = Int64(pos)
        lock.unlock()
        let half = Int64(halfSec * sampleRate)
        let wantStart = max(0, p - half), wantEnd = min(totalFrames, p + half)
        let curEnd = ws + Int64(curL.count)
        var back: ([Float], [Float])? = nil, fwd: ([Float], [Float])? = nil
        if wantStart < ws { back = readFrames(from: wantStart, count: Int(ws - wantStart)) }
        if wantEnd > curEnd { fwd = readFrames(from: curEnd, count: Int(wantEnd - curEnd)) }
        if back == nil && fwd == nil { return true }
        var nl: [Float] = [], nr: [Float] = []
        nl.reserveCapacity((back?.0.count ?? 0) + curL.count + (fwd?.0.count ?? 0))
        nr.reserveCapacity(nl.capacity)
        var newStart = ws
        if let b = back, b.0.count == Int(ws - wantStart) { nl.append(contentsOf: b.0); nr.append(contentsOf: b.1); newStart = wantStart }
        nl.append(contentsOf: curL); nr.append(contentsOf: curR)
        if let f = fwd { nl.append(contentsOf: f.0); nr.append(contentsOf: f.1) }
        lock.lock()
        // Only swap if nothing replaced the window meanwhile (same start/len).
        let same = (gen == decodeGen) && winStart == ws && bufL.count == curL.count
        if same { retiredL = bufL; retiredR = bufR; bufL = nl; bufR = nr; winStart = newStart }
        lock.unlock()
        return same
    }

    // MARK: render (audio thread)

    private func render(_ n: AVAudioFrameCount, _ abl: UnsafeMutablePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        guard buffers.count >= 1, let m0 = buffers[0].mData else { return }
        let outL = m0.assumingMemoryBound(to: Float.self)
        let outR = (buffers.count > 1 && buffers[1].mData != nil) ? buffers[1].mData!.assumingMemoryBound(to: Float.self) : outL
        let count = Int(n)
        lock.lock()
        let l = bufL, r = bufR, ws = Double(winStart), tgt = target, gT = gainTarget
        let snap = snapPending; snapPending = false
        lock.unlock()
        let len = l.count
        var g = gain
        // A jump is never instantaneous: arm it, ramp the gain to zero, THEN
        // move the head, then ramp back — an immediate jump with g=0 in the
        // same sample was a step (click) at the end of every fast throw.
        if snap || abs(tgt - pos) > Self.SNAP_SEC * sampleRate { snapArmed = true }
        var desired = (tgt - pos) / (Self.TAU_SEC * sampleRate)
        if desired > Self.MAX_SPEED { desired = Self.MAX_SPEED } else if desired < -Self.MAX_SPEED { desired = -Self.MAX_SPEED }
        if abs(tgt - pos) < 0.75 { desired = 0 }
        let v0 = vel
        let dv = (desired - v0) / Double(count)
        let gStep = Float(1.0 / (Self.GAIN_RAMP_SEC * sampleRate))
        // Speed-dependent duck + low-pass, ramped across this buffer.
        let sp = abs(desired)
        let vgTarget: Float = sp <= 1.5 ? 1.0 : Float(max(0.2, 1.0 - (sp - 1.5) / 5.5))
        let vg0 = vGain
        let dvg = (vgTarget - vg0) / Float(count)
        // Lighter low-pass than before: the two-octave pitch drop below already
        // tames the fast-scrub harshness.
        let fc = min(18000.0, max(3000.0, 12000.0 / max(1.0, sp * 0.5)))
        let a = Float(1.0 - exp(-2.0 * Double.pi * fc / sampleRate))
        var yl = lpL, yr = lpR
        l.withUnsafeBufferPointer { lp in
            r.withUnsafeBufferPointer { rp in
                for i in 0..<count {
                    if snapArmed && g <= 0.0005 { pos = tgt; vel = 0; snapArmed = false }
                    else { vel = v0 + dv * Double(i + 1); pos += vel }
                    var sl: Float = 0, sr: Float = 0
                    let rel = pos - ws
                    let avail = len >= 4 && rel >= 1 && rel < Double(len - 2)
                    if avail {
                        let i0 = Int(rel)
                        let f = Float(rel - Double(i0))
                        sl = Self.hermite(lp[i0 - 1], lp[i0], lp[i0 + 1], lp[i0 + 2], f)
                        sr = Self.hermite(rp[i0 - 1], rp[i0], rp[i0 + 1], rp[i0 + 2], f)
                    }
                    yl += a * (sl - yl)
                    yr += a * (sr - yr)
                    // Ramp toward silence while a jump is armed or the head has run
                    // off the decoded window (was an abrupt cut = click), else
                    // toward the session gain.
                    let wantG: Float = (snapArmed || !avail) ? 0 : 1   // session gain is applied post-pitch (masterGain)
                    if g < wantG { g = min(wantG, g + gStep) } else if g > wantG { g = max(wantG, g - gStep) }
                    let vg = vg0 + dvg * Float(i + 1)
                    outL[i] = yl * g * vg
                    outR[i] = yr * g * vg
                }
            }
        }
        lpL = yl; lpR = yr
        vGain = vgTarget
        gain = g
        // Keep the read head inside the file.
        if pos < 0 { pos = 0; vel = 0 }
        if pos > Double(totalFrames) { pos = Double(totalFrames); vel = 0 }
        // Idle (primed but never dragged, or faded out after end): nothing is
        // audible, so skip the pitch stage — Sonic's pitch search on silence
        // was steady CPU for every keep-alive window (every page-turn touch).
        if gT <= 0 && masterGain <= 0.0005 {
            if fifoPrimed || fifoCount > 0 { fifoPrimed = false; fifoCount = 0; fifoHead = 0 }
            for i in 0..<count { outL[i] = 0; outR[i] = 0 }
            return
        }
        // Pitch stage: interleave → Sonic (pitch 0.5, speed 1) → de-interleave.
        // Sonic buffers a few pitch periods, so the first buffers after start
        // come back short — the remainder is zero-filled (tens of ms once).
        if let ps = pitchStream {
            if pitchTmp.count < count * 2 { pitchTmp = [Float](repeating: 0, count: count * 2) }
            if pitchOut.isEmpty { pitchOut = [Float](repeating: 0, count: 4096 * 2) }
            if pitchFifo.isEmpty { pitchFifo = [Float](repeating: 0, count: Self.FIFO_CAP * 2) }
            for i in 0..<count { pitchTmp[2 * i] = outL[i]; pitchTmp[2 * i + 1] = outR[i] }
            pitchTmp.withUnsafeBufferPointer { p in _ = sonicWriteFloatToStream(ps, p.baseAddress, Int32(count)) }
            // Drain everything Sonic has into the queue.
            var guardIters = 0
            while guardIters < 8 {
                guardIters += 1
                let avail = Int(sonicIntSamplesAvailable(ps))
                let room = Self.FIFO_CAP - fifoCount
                if avail <= 0 || room <= 0 { break }
                let want = min(avail, min(room, pitchOut.count / 2))
                var got: Int32 = 0
                pitchOut.withUnsafeMutableBufferPointer { p in got = sonicReadFloatFromStream(ps, p.baseAddress, Int32(want)) }
                let gi = max(0, Int(got))
                if gi == 0 { break }
                var w = (fifoHead + fifoCount) % Self.FIFO_CAP
                for i in 0..<gi { pitchFifo[2 * w] = pitchOut[2 * i]; pitchFifo[2 * w + 1] = pitchOut[2 * i + 1]; w += 1; if w == Self.FIFO_CAP { w = 0 } }
                fifoCount += gi
            }
            // Steer Sonic's speed by a few percent to hold the queue near its
            // setpoint: pitch shifting's in/out ratio isn't exactly 1, so a
            // fixed queue drifted into underruns (gaps) or ever-growing latency.
            let setpoint = count + 2048
            let dev = fifoCount - setpoint
            let wantSpd: Float = dev > 1024 ? 1.03 : (dev < -1024 ? 0.97 : 1.0)
            if wantSpd != pitchSpeed { pitchSpeed = wantSpd; sonicSetSpeed(ps, wantSpd) }
            if fifoCount > Self.FIFO_CAP - 2048 {   // safety: drop the excess (silence-only in practice)
                let drop = fifoCount - setpoint
                fifoHead = (fifoHead + drop) % Self.FIFO_CAP; fifoCount -= drop
            }
            if !fifoPrimed && fifoCount >= setpoint { fifoPrimed = true; fifoFadeTotal = max(1, Int(0.008 * sampleRate)); fifoFade = fifoFadeTotal }
            if fifoPrimed && fifoCount >= count {
                var h = fifoHead
                for i in 0..<count {
                    var k: Float = 1
                    if fifoFade > 0 { k = 1 - Float(fifoFade) / Float(fifoFadeTotal); fifoFade -= 1 }
                    outL[i] = pitchFifo[2 * h] * k; outR[i] = pitchFifo[2 * h + 1] * k
                    h += 1; if h == Self.FIFO_CAP { h = 0 }
                }
                fifoHead = h; fifoCount -= count
            } else {
                if fifoPrimed { fifoUnderruns += 1; if fifoUnderruns % 4 == 1 { NSLog("[scrub] pitch queue underrun #%d (have %d, need %d)", fifoUnderruns, fifoCount, count) } }
                fifoPrimed = false
                for i in 0..<count { outL[i] = 0; outR[i] = 0 }
            }
        }
        // Session gain (begin → 1, end/prime → 0) on the ACTUAL output.
        var mg = masterGain
        for i in 0..<count {
            if mg < gT { mg = min(gT, mg + gStep) } else if mg > gT { mg = max(gT, mg - gStep) }
            outL[i] *= mg; outR[i] *= mg
        }
        masterGain = mg
    }

    @inline(__always)
    private static func hermite(_ xm1: Float, _ x0: Float, _ x1: Float, _ x2: Float, _ t: Float) -> Float {
        let c = (x1 - xm1) * 0.5
        let v = x0 - x1
        let w = c + v
        let a = w + v + (x2 - x0) * 0.5
        let b = w + a
        return ((((a * t) - b) * t + c) * t + x0)
    }
}
