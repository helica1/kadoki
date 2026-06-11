import Foundation
import Capacitor
import UIKit
import AVFoundation
import MediaPlayer

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
    ]

    // MARK: - Durable position store (BookPlayer-style: the player layer owns the
    // save). We persist {url, ms} to UserDefaults from THIS process ~every 5s
    // while playing + on background/pause, independent of the WebView. iOS
    // suspends the WebView (freezing the JS saver) for the whole background
    // listen, so without this the saved place could be minutes behind; this keeps
    // it within ~5s. JS reads it via getLastSavedPosition() as a forward-only floor.
    private static let posKeyUrl = "kadoki.audio.lastUrl"
    private static let posKeyMs  = "kadoki.audio.lastMs"
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

    private var player: AVAudioPlayer?
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

    // MARK: - Lifecycle

    override public func load() {
        configureAudioSession()
        setupRemoteCommands()
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
        lastDurableSaveAt = Date().timeIntervalSince1970
    }

    /// The last durably-saved {url, ms} — readable even with no live player
    /// (cold launch). JS applies it as a forward-only, url-matched floor.
    @objc func getLastSavedPosition(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        let url = d.string(forKey: Self.posKeyUrl) ?? ""
        let ms = d.object(forKey: Self.posKeyMs) != nil ? d.integer(forKey: Self.posKeyMs) : -1
        call.resolve([
            "url": url,
            "positionMs": max(0, ms),
            "hasSaved": ms >= 0 && !url.isEmpty
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
            self?.player?.pause()
            self?.stopPositionTimer()
            self?.saveLastPositionNow()   // durable: a paused suspended app can be jetsam-killed with no further save
            self?.emitState(playing: false)
            self?.updateNowPlaying()
            return .success
        }
        cmd.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let p = self?.player else { return .commandFailed }
            if p.isPlaying {
                p.pause()
                self?.stopPositionTimer()
                self?.saveLastPositionNow()
                self?.emitState(playing: false)
            } else {
                self?.ensureSessionActive()
                p.play()
                self?.startPositionTimer()
                self?.emitState(playing: true)
                self?.notifyListeners("remoteCommand", data: ["action": "play", "ts": Int(Date().timeIntervalSince1970 * 1000)])
            }
            self?.updateNowPlaying()
            return .success
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

        do {
            // Tear down any prior player. Doing this synchronously avoids the
            // late-state-event race the Android plugin had.
            stopPositionTimer()
            player?.stop()
            player = nil

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
        updateNowPlaying()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopPositionTimer()
        saveLastPositionNow()   // before the player/url are cleared (parity with Android ACTION_STOP)
        player?.stop()
        player = nil
        currentUrlStr = ""
        emitState(playing: false)
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
                guard self.fadeGeneration == gen else { return } // a pause/play raced in — it owns the volume
                p.setVolume(1.0, fadeDuration: secs)
            }
        } else {
            p.currentTime = target
            updateNowPlaying()
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
            // Near-black background with a subtle radial vignette — a touch
            // lighter at the centre, darkening toward the edges — for a soft
            // shadow/depth effect behind the text.
            UIColor(white: 0.06, alpha: 1).setFill()
            ctx.fill(rect)
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
            guard !clean.isEmpty else { return }

            let para = NSMutableParagraphStyle()
            para.alignment = .center
            para.lineBreakMode = .byCharWrapping   // Japanese has no spaces to break on

            let shadow = NSShadow()
            shadow.shadowColor = UIColor(white: 0, alpha: 0.9)
            shadow.shadowBlurRadius = 4
            shadow.shadowOffset = CGSize(width: 0, height: 1)

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
    }

    private func emitState(playing: Bool) {
        self.notifyListeners("state", data: [
            "playing": playing,
            "ts":      Int(Date().timeIntervalSince1970 * 1000)
        ])
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
        stopPositionTimer()
        emitState(playing: false)
        self.notifyListeners("ended", data: [:])
        updateNowPlaying()
        // Natural end-of-file: release the audio session like stop() does —
        // a finished overnight book otherwise kept the .playback session
        // active, holding the app resident and unsuspendable for hours
        // (battery audit 2026-06-10). play()/resume() re-activate lazily.
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { NSLog("[BackgroundAudio] EOF session deactivate failed: \(error.localizedDescription)") }
    }
    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        stopPositionTimer()
        // Order matters: 'error' BEFORE the state(false) — the JS error
        // handler captures _bgPlaying at entry to decide whether to restart
        // playback after the self-heal (matches the Android onPlayerError).
        // ts lets JS tell a live error from one replayed from the suspended
        // bridge backlog (a stale error must not auto-restart playback).
        self.notifyListeners("error", data: [
            "message": error?.localizedDescription ?? "unknown decode error",
            "ts":      Int(Date().timeIntervalSince1970 * 1000)
        ])
        // Playback is dead: tell JS explicitly so window._bgPlaying can't
        // stay stale-true (the position poll above just stops silently).
        emitState(playing: false)
        updateNowPlaying()
    }
}
