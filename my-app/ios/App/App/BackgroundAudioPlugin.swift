import Foundation
import Network
import Capacitor
import UIKit
import AVFoundation
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
        CAPPluginMethod(name: "setRate",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLastSavedPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleArt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setChapterRepeat",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToNextChapter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceModel",       returnType: CAPPluginReturnPromise),
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
            "simDemo": simDemo,
            "demoDir": demoDir,
            "sim3d": ProcessInfo.processInfo.environment["KADOKI_SIM_3D"] == "1",
            "simSeries": !demoDir.isEmpty && FileManager.default.fileExists(atPath: demoDir + "/demo-ep1.mp4"),
            "simAdv": ProcessInfo.processInfo.environment["KADOKI_SIM_ADV"] == "1",
            "simBrowse": ProcessInfo.processInfo.environment["KADOKI_SIM_BROWSE"] == "1",
            "simAnki": ProcessInfo.processInfo.environment["KADOKI_SIM_ANKI"] == "1",
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
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
        } catch {
            NSLog("[BackgroundAudio] AudioSession category failed: \(error.localizedDescription)")
        }
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
            self?.ensureSessionActive()
            p.play()
            self?.startPositionTimer()
            self?.emitState(playing: true)
            self?.postLiveTick(ms: Int(p.currentTime * 1000), playing: true)
            self?.updateNowPlaying()
            // Tell JS this play came from the lock screen / Control Center, so
            // it can force AUDIO mode (audiobook + audio timer) regardless of
            // whatever mode the app was in.
            // ts: lets JS drop this command if it thaws out of a suspended
            // WebView minutes later (stale-replay guard).
            self?.notifyListeners("remoteCommand", data: ["action": "play", "ts": Int(Date().timeIntervalSince1970 * 1000)])
            return .success
        }
        cmd.pauseCommand.addTarget { [weak self] _ in
            let ms = Int((self?.player?.currentTime ?? 0) * 1000)
            self?.player?.pause()
            self?.stopPositionTimer()
            self?.saveLastPositionNow()   // durable: a paused suspended app can be jetsam-killed with no further save
            self?.emitState(playing: false)
            self?.postLiveTick(ms: ms, playing: false)
            self?.updateNowPlaying()
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

    // Shared by the lock-screen toggle button and the watch's tap-to-toggle
    // (Phase B) — both are "remote, no context on current state" triggers.
    private func performTogglePlayPause() {
        guard let p = player else { NSLog("[BackgroundAudio] performTogglePlayPause: no active player"); return }
        if p.isPlaying {
            p.pause()
            stopPositionTimer()
            saveLastPositionNow()
            emitState(playing: false)
            postLiveTick(ms: Int(p.currentTime * 1000), playing: false)
        } else {
            ensureSessionActive()
            p.play()
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
            player?.stop()
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
            #endif
            call.resolve()
            return
        }

        do {
            // Tear down any prior player. Doing this synchronously avoids the
            // late-state-event race the Android plugin had.
            stopPositionTimer()
            player?.stop()
            player = nil
            #if os(visionOS)
            Task { @MainActor in KadokiVideoModel.shared.clear() }
            #endif

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
        let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
        fadeGeneration += 1
        let gen = fadeGeneration
        if let p = player, fadeMs > 0 {
            p.setVolume(0.0, fadeDuration: fadeMs / 1000.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + fadeMs / 1000.0) { [weak self] in
                guard let self = self else { return }
                guard self.fadeGeneration == gen else { return } // resume/play raced in — keep playing
                self.player?.pause()
                self.player?.volume = 1.0 // restore for next play
                self.stopPositionTimer()
                self.saveLastPositionNow()   // durable on every pause (parity with Android ACTION_PAUSE)
                self.emitState(playing: false)
                self.postLiveTick(ms: Int((self.player?.currentTime ?? 0) * 1000), playing: false)
                self.updateNowPlaying()
            }
        } else {
            // No fade — but still silence the player right before
            // pause so the buffer flushes with zero amplitude,
            // suppressing the click. The setter may not take effect
            // for all samples already in the hardware buffer, so a
            // very faint click can still slip through; that's the
            // trade for instant response. Restore volume so the next
            // play / resume starts at full level.
            player?.volume = 0.0
            player?.pause()
            player?.volume = 1.0
            stopPositionTimer()
            saveLastPositionNow()   // durable on every pause (parity with Android ACTION_PAUSE)
            emitState(playing: false)
            postLiveTick(ms: Int((player?.currentTime ?? 0) * 1000), playing: false)
            updateNowPlaying()
        }
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) {
        guard let p = player else { call.resolve(); return }
        ensureSessionActive()   // re-activate if a prior stop() deactivated it
        fadeGeneration += 1 // supersede any pending faded-pause so it doesn't stop us
        let fadeMs = call.getDouble("fadeMs") ?? Self.defaultFadeMs
        if fadeMs > 0 {
            p.volume = 0.0
            p.play()
            p.setVolume(1.0, fadeDuration: fadeMs / 1000.0)
        } else {
            p.volume = 1.0
            p.play()
        }
        startPositionTimer()
        emitState(playing: true)
        postLiveTick(ms: Int(p.currentTime * 1000), playing: true)
        updateNowPlaying()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopPositionTimer()
        saveLastPositionNow()   // before the player/url are cleared (parity with Android ACTION_STOP)
        let msAtStop = Int((player?.currentTime ?? 0) * 1000)
        player?.stop()
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
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { NSLog("[BackgroundAudio] session deactivate failed: \(error.localizedDescription)") }
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
        // that races in, but the seek itself always lands.
        let fadeMs = call.getDouble("fadeMs") ?? 0
        if p.isPlaying && fadeMs > 0 {
            fadeGeneration += 1
            let gen = fadeGeneration
            let secs = fadeMs / 1000.0
            p.setVolume(0.0, fadeDuration: secs)
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) { [weak self] in
                guard let self = self, let p = self.player else { return }
                p.currentTime = target               // always land the seek
                self.updateNowPlaying()
                self.postLiveTick(ms: Int(target * 1000), playing: p.isPlaying)
                guard self.fadeGeneration == gen else { return } // a pause/play raced in — it owns the volume
                p.setVolume(1.0, fadeDuration: secs)
            }
        } else {
            p.currentTime = target
            updateNowPlaying()
            postLiveTick(ms: Int(target * 1000), playing: p.isPlaying)
        }
        call.resolve()
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1.0)
        guard rate > 0 else { call.reject("rate must be > 0"); return }
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
                p.currentTime = max(0, min(p.duration, TimeInterval(next.startMs) / 1000.0))
                self.repeatGuardUntil = Date().timeIntervalSince1970 + 0.6
                self.lastTickMs = Int(p.currentTime * 1000); self.lastChapterIdx = next.idx
                self.saveLastPositionNow()
                self.notifyChapter(idx: next.idx, repeating: false, reason: "skip")
            } else { self.notifyChapter(idx: curIdx, repeating: false, reason: "skip") }
            self.ensureSessionActive(); p.volume = 1.0; p.play()
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
        guard wasBusy, let p = player, !p.isPlaying else { return }
        // If we paused for the FINAL chapter's EOF announce, the playhead sits at end —
        // play() there can restart the file from 0 (place jump). End the book cleanly.
        if p.duration > 0, p.currentTime >= p.duration - 0.05 { finishBookAtEof(); return }
        ensureSessionActive(); p.volume = 1.0; p.play(); startPositionTimer(); emitState(playing: true); updateNowPlaying()
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
            "url":        (p != nil) ? currentUrlStr : ""
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
    /// resume. ALWAYS ends playing — never strands the book paused.
    private func doChapterRepeat(_ ch: ChapterBound, isFinal: Bool = false) {
        guard let p = player, !repeatBusy else { return }
        repeatBusy = true
        let target = TimeInterval(ch.startMs) / 1000.0
        notifyChapter(idx: ch.idx, repeating: true, reason: "repeat")
        p.volume = 1.0; p.pause()
        // Save the SEEK TARGET (chapter start), not the live playhead — which at a
        // boundary is the NEXT chapter's start and at EOF is end-of-book — so a kill
        // mid-announce restores to the chapter being repeated, never ahead of it.
        stopPositionTimer(); saveDurablePositionMs(ch.startMs); emitState(playing: false); updateNowPlaying()
        postLiveTick(ms: ch.startMs, playing: false)   // watch karaoke parks at the chapter start during the announce
        speakAnnounce(ch.announce) { [weak self] in self?.finishRepeat(seekTo: target, passIdx: ch.idx, isFinal: isFinal) }
    }

    private func finishRepeat(seekTo target: TimeInterval, passIdx: Int, isFinal: Bool = false) {
        guard let p = player else { repeatBusy = false; return }
        if chapterRepeatOn && repeatPassIdx == passIdx {
            p.currentTime = max(0, min(p.duration, target))
            saveLastPositionNow()
            repeatGuardUntil = Date().timeIntervalSince1970 + 0.6
            lastTickMs = Int(p.currentTime * 1000); lastChapterIdx = passIdx
            // The final chapter has no next crossing to clear the pass — clear it here
            // so a later skipToNextChapter doesn't mis-mark this idx as the one left.
            if isFinal { repeatPassIdx = -1 }
        }
        ensureSessionActive(); p.volume = 1.0; p.play()
        startPositionTimer(); emitState(playing: true); updateNowPlaying()
        repeatBusy = false
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
