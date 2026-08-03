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
        CAPPluginMethod(name: "getState",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendTitle",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flushPending",  returnType: CAPPluginReturnPromise),
    ]

    private var progressTimer: Timer?

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
        guard s.isWatchAppInstalled else { call.reject("Kadoki watch app not installed"); return }
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
    // to push FRESH positions right behind it.
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                        replyHandler: @escaping ([String: Any]) -> Void) {
        guard (message["type"] as? String) == "syncRequest" else { replyHandler([:]); return }
        emit("watchSyncRequest", [:])
        replyHandler(["phonePositions": session.applicationContext["phonePositions"] ?? [:]])
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
