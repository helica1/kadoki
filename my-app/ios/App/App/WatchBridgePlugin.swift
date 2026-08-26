// WatchBridgePlugin.swift — phone side of the Apple Watch companion (plan S1).
//
// Sends a title bundle to the watch (cues.json + the audio file, both stamped
// with titleId/name/durMs metadata; WCSession queues the transfers and ships
// them opportunistically — can take a long time for a big m4b) and receives
// position checkpoints back via updateApplicationContext, which are forwarded
// to JS as 'watchPosition' events (ingested there forward-only, so a stale
// watch value can never regress the phone's place — never-lose-place).
//
// Registered manually in MainViewController.capacitorDidLoad (Capacitor 7
// does not auto-discover app-target plugins).
import Foundation
import Capacitor
import WatchConnectivity

@objc(WatchBridgePlugin)
public class WatchBridgePlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {

    public let identifier = "WatchBridgePlugin"
    public let jsName = "WatchBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendTitle",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateContext",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flushPending",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLiveContext", returnType: CAPPluginReturnPromise),
    ]

    private var progressTimer: Timer?

    // MARK: - Live subtitle streaming (Phase B)
    //
    // NATIVE-to-native by design: iOS suspends the WebView while the phone is
    // locked, so a JS-side streamer would die in exactly the pocket-listening
    // case this exists for. BackgroundAudioPlugin posts .kadokiPositionTick on
    // every position change (periodic tick + pause/resume/seek); this plugin
    // just relays a throttled subset to the watch over WCSession. The watch
    // already holds cues + word timings locally (Phase C) and computes the
    // cue/karaoke display itself off the tiny {ms, ts, playing, rate} frame.
    private var liveTitleId: String?
    private var lastFrame: (ms: Int, playing: Bool, rate: Float, ts: Int)?
    private var lastLiveSendAt: TimeInterval = 0
    private var lastSentMs: Int?
    private var positionObserver: NSObjectProtocol?

    // Events can arrive (queued userInfo replays, receivedApplicationContext at
    // activation) BEFORE the JS side has attached its listeners — buffer until
    // JS calls flushPending() after wiring, else those records are lost.
    private var jsReady = false
    private var pendingEvents: [(String, [String: Any])] = []
    private func emit(_ name: String, _ data: [String: Any]) {
        DispatchQueue.main.async {
            if self.jsReady {
                self.notifyListeners(name, data: data)
            } else {
                self.pendingEvents.append((name, data))
            }
        }
    }

    @objc func flushPending(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.jsReady = true
            for (n, d) in self.pendingEvents { self.notifyListeners(n, data: d) }
            self.pendingEvents.removeAll()
            call.resolve()
        }
    }

    public override func load() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        positionObserver = NotificationCenter.default.addObserver(
            forName: .kadokiPositionTick, object: nil, queue: nil
        ) { [weak self] note in
            self?.handlePositionTick(note)
        }
    }

    // titleId nil/empty clears the live stream (JS calls this on title
    // close/switch) — handlePositionTick then simply stops relaying frames.
    @objc func setLiveContext(_ call: CAPPluginCall) {
        let tid = call.getString("titleId")
        liveTitleId = (tid?.isEmpty ?? true) ? nil : tid
        // Force the next tick through immediately rather than waiting out the
        // 1 Hz throttle against a PREVIOUS title's send history.
        lastLiveSendAt = 0
        lastSentMs = nil
        call.resolve()
    }

    private func handlePositionTick(_ note: Notification) {
        guard let info = note.userInfo,
              let ms = info["ms"] as? Int,
              let playing = info["playing"] as? Bool,
              let rate = info["rate"] as? Float,
              let ts = info["ts"] as? Int else { return }
        // A play/pause STATE CHANGE must never be throttled: pause() stops the
        // position timer right after this tick, so if this particular frame
        // gets dropped by the 1 Hz gate, no later tick will ever correct the
        // watch — it would extrapolate "still playing" from the stale frame
        // forever (this was exactly the reported "keeps going after phone
        // stopped" bug).
        let playingChanged = lastFrame?.playing != playing
        lastFrame = (ms, playing, rate, ts)
        guard let tid = liveTitleId else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        // Regular ticks need a reachable watch; a STATE CHANGE is sent
        // regardless — sendMessage may fail, but the applicationContext copy
        // below lands whenever the watch app next runs.
        guard playingChanged || s.isReachable else { return }
        let now = Date().timeIntervalSince1970
        let jumped = lastSentMs != nil && abs(ms - lastSentMs!) > 2000
        guard jumped || playingChanged || now - lastLiveSendAt >= 1.0 else { return }
        lastLiveSendAt = now
        lastSentMs = ms
        sendLiveFrame(titleId: tid, ms: ms, ts: ts, playing: playing, rate: rate,
                      stateChange: playingChanged)
    }

    private func sendLiveFrame(titleId: String, ms: Int, ts: Int, playing: Bool, rate: Float,
                               stateChange: Bool = false, attempt: Int = 0) {
        let payload: [String: Any] = [
            "t": "live", "titleId": titleId, "ms": ms, "ts": ts,
            "playing": playing, "rate": Double(rate),
        ]
        let s = WCSession.default
        if stateChange {
            // A play/pause flip is the one frame that must not be lost: the
            // watch extrapolates "still playing" from the last frame it has,
            // so a dropped pause = subtitles scrolling on forever (reported).
            // (1) Also publish it as applicationContext — WCSession's
            // latest-state channel, delivered even when the watch app is
            // not reachable right now (merge: the context also carries
            // phonePositions). (2) Retry the live message a couple of times.
            var ctx = s.applicationContext
            ctx["live"] = payload
            try? s.updateApplicationContext(ctx)
        }
        guard stateChange || s.isReachable else { return }
        s.sendMessage(payload, replyHandler: nil, errorHandler: { [weak self] _ in
            guard stateChange, attempt < 2 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 0.4 : 1.2)) {
                // Only if this is still the latest state (a resume may have
                // superseded the pause by now).
                guard let self = self, let f = self.lastFrame, f.playing == playing, f.ts == ts else { return }
                self.sendLiveFrame(titleId: titleId, ms: ms, ts: ts, playing: playing, rate: rate,
                                   stateChange: true, attempt: attempt + 1)
            }
        })
    }

    // The watch app coming to the foreground is exactly when its live view
    // wants a frame RIGHT NOW rather than waiting up to 1s for the next tick.
    public func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable, let tid = liveTitleId, let f = lastFrame else { return }
        lastLiveSendAt = Date().timeIntervalSince1970
        lastSentMs = f.ms
        sendLiveFrame(titleId: tid, ms: f.ms, ts: f.ts, playing: f.playing, rate: f.rate)
    }

    // MARK: - state

    @objc func getState(_ call: CAPPluginCall) {
        guard WCSession.isSupported() else {
            call.resolve(["supported": false])
            return
        }
        let s = WCSession.default
        call.resolve([
            "supported": true,
            "paired": s.isPaired,
            "installed": s.isWatchAppInstalled,
            "reachable": s.isReachable,
            "pendingTransfers": s.outstandingFileTransfers.count,
        ])
    }

    // MARK: - phone → watch positions (latest-wins context)

    // positions = { titleId: { ms, ts } } — the watch adopts fresher-listen-wins.
    @objc func updateContext(_ call: CAPPluginCall) {
        guard WCSession.isSupported() else { call.reject("not supported"); return }
        let s = WCSession.default
        guard s.activationState == .activated else { call.reject("session not activated"); return }
        let positions = call.getObject("positions") ?? [:]
        do {
            try s.updateApplicationContext(["phonePositions": positions])
            call.resolve()
        } catch {
            call.reject("updateApplicationContext failed: \(error.localizedDescription)")
        }
    }

    // MARK: - send a title bundle

    @objc func sendTitle(_ call: CAPPluginCall) {
        guard WCSession.isSupported() else { call.reject("Watch connectivity not supported"); return }
        let s = WCSession.default
        guard s.activationState == .activated else { call.reject("Session not activated"); return }
        guard s.isPaired else { call.reject("No paired Apple Watch"); return }
        // isWatchAppInstalled is notoriously STALE-FALSE after a watch-app
        // update/reinstall until the iPhone app relaunches (sometimes until
        // re-pair) — while transfers still work fine. Never hard-block on it:
        // if the app truly isn't there, the file transfer itself reports the
        // failure through watchTransferDone.
        guard let titleId = call.getString("titleId"), !titleId.isEmpty else { call.reject("titleId required"); return }
        guard let audioPath = call.getString("audioPath"), !audioPath.isEmpty else { call.reject("audioPath required"); return }
        let name = call.getString("name") ?? "Untitled"
        let durMs = call.getDouble("durMs") ?? 0
        let cues = call.getArray("cues") ?? []

        let audioURL = URL(fileURLWithPath: audioPath.replacingOccurrences(of: "file://", with: ""))
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            call.reject("Audio file not found")
            return
        }

        var meta: [String: Any] = ["titleId": titleId, "name": name, "durMs": durMs]

        // cues.json — tiny, send first so the watch shows the title promptly.
        do {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("watch_cues_\(titleId).json")
            let data = try JSONSerialization.data(withJSONObject: cues)
            try data.write(to: tmp)
            meta["role"] = "cues"
            s.transferFile(tmp, metadata: meta)
        } catch {
            call.reject("Failed to write cues: \(error.localizedDescription)")
            return
        }

        // Cover art (small) — rides on every send, incl. cuesOnly refreshes.
        if let cover = call.getString("cover"), !cover.isEmpty {
            let b64 = cover.contains(",") ? String(cover.split(separator: ",").last ?? "") : cover
            if let data = Data(base64Encoded: b64) {
                let tmpC = FileManager.default.temporaryDirectory
                    .appendingPathComponent("watch_cover_\(titleId).jpg")
                try? data.write(to: tmpC)
                meta["role"] = "cover"
                s.transferFile(tmpC, metadata: meta)
            }
        }

        // cuesOnly: refresh subtitles/word-timings without re-shipping the
        // multi-hundred-MB audio the watch already has.
        if !(call.getBool("cuesOnly") ?? false) {
            meta["role"] = "audio"
            meta["ext"] = audioURL.pathExtension
            s.transferFile(audioURL, metadata: meta)
        }
        startProgressTimer()
        call.resolve(["queued": true, "pendingTransfers": s.outstandingFileTransfers.count])
    }

    // Poll outstanding transfers ~1 Hz while any exist → 'watchTransfer' events.
    private func startProgressTimer() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.progressTimer == nil else { return }
            self.progressTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                guard let self else { return }
                let transfers = WCSession.default.outstandingFileTransfers
                if transfers.isEmpty {
                    self.progressTimer?.invalidate()
                    self.progressTimer = nil
                    return
                }
                var items: [[String: Any]] = []
                for t in transfers {
                    items.append([
                        "titleId": (t.file.metadata?["titleId"] as? String) ?? "",
                        "role": (t.file.metadata?["role"] as? String) ?? "",
                        "fraction": t.progress.fractionCompleted,
                    ])
                }
                self.notifyListeners("watchTransfer", data: ["transfers": items])
            }
        }
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                        error: Error?) {
        // Context delivered while this app was CLOSED never triggers the
        // didReceive callback — read the stored copy at activation.
        guard activationState == .activated else { return }
        let ctx = session.receivedApplicationContext
        if !ctx.isEmpty { deliverPositions(from: ctx) }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    // Watch → phone remote commands (Phase B tap-to-toggle + cue paging).
    // The watch sends WITH a replyHandler (ack → the with-reply delegate
    // below); this NO-reply variant stays for older watch builds. Both funnel
    // into handleLiveCmd.
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard (message["t"] as? String) == "liveCmd" else { return }
        handleLiveCmd(message)
    }

    // Dedupe ring for liveCmd retries: the watch retries a failed send with
    // the SAME id, so a delivered-but-error-reported first attempt must not
    // double-toggle. WCSession delegate callbacks arrive on a serial queue,
    // so plain array access is safe here.
    private var seenLiveCmdIds: [String] = []

    private func handleLiveCmd(_ message: [String: Any]) {
        NSLog("[WatchBridge] liveCmd received: \(message)")
        if let id = message["id"] as? String, !id.isEmpty {
            if seenLiveCmdIds.contains(id) { return }   // retry duplicate — already acted
            seenLiveCmdIds.append(id)
            if seenLiveCmdIds.count > 16 { seenLiveCmdIds.removeFirst() }
        }
        // Stale guard: these are live gestures — a command that somehow
        // arrives long after the tap (queued across an unreachable gap) must
        // not yank playback. Commands without ts (older watch build) pass.
        if let ts = message["ts"] as? Double, ts > 0,
           Date().timeIntervalSince1970 * 1000 - ts > 8000 { return }
        switch message["action"] as? String {
        case "togglePlayPause":
            NotificationCenter.default.post(name: .kadokiRemoteToggleRequest, object: nil)
        case "nextCue":
            NotificationCenter.default.post(name: .kadokiRemoteCueJumpRequest, object: nil,
                                            userInfo: ["dir": 1])
        case "prevCue":
            NotificationCenter.default.post(name: .kadokiRemoteCueJumpRequest, object: nil,
                                            userInfo: ["dir": -1])
        default:
            break
        }
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let md = fileTransfer.file.metadata ?? [:]
        notifyListeners("watchTransferDone", data: [
            "titleId": (md["titleId"] as? String) ?? "",
            "role": (md["role"] as? String) ?? "",
            "ok": error == nil,
            "error": error?.localizedDescription ?? "",
        ])
    }

    // Manual sync request from the watch (reachable round-trip): reply with
    // the last positions we pushed so the watch ingests instantly, and ask JS
    // to push FRESH positions right behind it. Also handles the live-view's
    // "liveSubStart" request (Phase B): reply with whatever frame we have
    // RIGHT NOW — even paused, even if playback hasn't ticked since the watch
    // app came foreground — so the view doesn't sit blank for up to 1s.
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                        replyHandler: @escaping ([String: Any]) -> Void) {
        // Remote command with ack: reply FIRST (the watch only needs delivery
        // confirmation, and the id-dedupe makes acting after the ack safe).
        if (message["t"] as? String) == "liveCmd" {
            replyHandler(["ok": true])
            handleLiveCmd(message)
            return
        }
        switch message["type"] as? String {
        case "syncRequest":
            emit("watchSyncRequest", [:])
            replyHandler(["phonePositions": session.applicationContext["phonePositions"] ?? [:]])
        case "liveSubStart":
            if let tid = liveTitleId, let f = lastFrame {
                replyHandler([
                    "t": "live", "titleId": tid, "ms": f.ms, "ts": f.ts,
                    "playing": f.playing, "rate": Double(f.rate),
                ])
            } else {
                replyHandler([:])
            }
        default:
            replyHandler([:])
        }
    }

    // Reliable queued records from the watch: listen-time deltas (stats) and
    // word flags (lookup history). Forwarded to JS by type.
    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let type = userInfo["type"] as? String else { return }
        var data: [String: Any] = [:]
        for (k, v) in userInfo where k != "type" { data[k] = v }
        if type == "listen" {
            emit("watchListen", data)
        } else if type == "flag" {
            emit("watchFlag", data)
        }
    }

    // Position checkpoints from the watch (latest-wins context). Forwarded to
    // JS, which merges FORWARD-ONLY into the furthest/resume machinery.
    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        deliverPositions(from: applicationContext)
    }

    private func deliverPositions(from applicationContext: [String: Any]) {
        guard let positions = applicationContext["positions"] as? [String: [String: Double]] else { return }
        var out: [[String: Any]] = []
        for (tid, p) in positions {
            out.append(["titleId": tid,
                        "ms": p["ms"] ?? 0,
                        "furthestMs": p["furthestMs"] ?? 0,
                        "ts": p["ts"] ?? 0])
        }
        if !out.isEmpty { emit("watchPosition", ["positions": out]) }
    }
}
