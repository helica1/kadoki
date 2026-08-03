// WatchConnectivityManager.swift — WCSession plumbing on the WATCH side.
//
// Receives: title bundles (two file transfers: role=cues then role=audio) into
// Library/Titles/<titleId>/, and the phone's per-title positions via
// applicationContext ("phonePositions": {tid: {ms, ts}}) → UserDefaults, used
// by WatchPlayer's fresher-listen-wins resume adoption.
//
// Sends: position checkpoints via updateApplicationContext (latest-wins), and
// RELIABLE queued records via transferUserInfo — listen-time deltas (type
// 'listen': fed into the phone's stats) and word flags (type 'flag': fed into
// the phone's lookup history). Queued records survive unreachability and
// deliver in order when the phone is next available.
import Foundation
import WatchConnectivity

final class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchConnectivityManager()

    @Published var lastEvent: String = ""

    func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
    }

    // MARK: - receiving title bundles

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let meta = file.metadata ?? [:]
        guard let role = meta["role"] as? String,
              let titleId = meta["titleId"] as? String, !titleId.isEmpty else { return }
        let name = (meta["name"] as? String) ?? "Untitled"
        let durMs = (meta["durMs"] as? Double) ?? 0

        let dir = WatchTitleStore.titleDir(titleId)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest: URL
            if role == "audio" {
                let ext = (meta["ext"] as? String) ?? file.fileURL.pathExtension
                dest = dir.appendingPathComponent("audio." + (ext.isEmpty ? "m4b" : ext))
            } else if role == "cues" {
                dest = dir.appendingPathComponent("cues.json")
            } else if role == "cover" {
                dest = dir.appendingPathComponent("cover.jpg")
            } else {
                return
            }
            // didReceive's fileURL is deleted when this method returns — MOVE it.
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: file.fileURL, to: dest)
            let metaURL = dir.appendingPathComponent("meta.json")
            let obj: [String: Any] = ["id": titleId, "name": name, "durMs": durMs,
                                      "receivedTs": Date().timeIntervalSince1970 * 1000]
            if let data = try? JSONSerialization.data(withJSONObject: obj) {
                try? data.write(to: metaURL)
            }
            DispatchQueue.main.async {
                self.lastEvent = "received \(role) for \(name)"
                WatchTitleStore.shared.reload()
                // A cues refresh for the CURRENTLY LOADED title applies live
                // (karaoke word timings appear without relaunching).
                if role == "cues", WatchPlayer.shared.current?.id == titleId {
                    WatchPlayer.shared.refreshCues()
                }
            }
        } catch {
            DispatchQueue.main.async { self.lastEvent = "receive failed: \(error.localizedDescription)" }
        }
    }

    // MARK: - phone → watch positions (fresher-listen-wins resume adoption)

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        ingestPhonePositions(applicationContext)
    }

    private func ingestPhonePositions(_ applicationContext: [String: Any]) {
        guard let pp = applicationContext["phonePositions"] as? [String: [String: Any]] else { return }
        let d = UserDefaults.standard
        var any = false
        for (tid, v) in pp {
            let ms = (v["ms"] as? Double) ?? Double((v["ms"] as? Int) ?? 0)
            let ts = (v["ts"] as? Double) ?? Double((v["ts"] as? Int) ?? 0)
            guard ms > 0, ts > 0 else { continue }
            d.set(ms / 1000.0, forKey: "phonePos_" + tid)
            d.set(ts, forKey: "phonePosTs_" + tid)
            any = true
        }
        guard any else { return }
        DispatchQueue.main.async {
            self.lastEvent = "positions from phone ✓"
            // Live adoption: if the affected title is loaded and PAUSED, the
            // position visibly jumps to the phone's fresher spot right away.
            WatchPlayer.shared.adoptPhonePositionIfIdle()
            WatchTitleStore.shared.reload()   // list rows show the resume spot
        }
    }

    // Manual sync (list toolbar): re-ingest stored context, push our
    // checkpoints, and — when the phone is reachable — ask it to reply with
    // its latest positions and push fresh ones.
    func manualSync() {
        let s = WCSession.default
        guard s.activationState == .activated else { activate(); return }
        ingestPhonePositions(s.receivedApplicationContext)
        WatchPlayer.shared.pushCheckpointNow()
        DispatchQueue.main.async { self.lastEvent = "syncing…" }
        // ALWAYS attempt the round-trip: isReachable is an unreliable
        // pre-check, and sendMessage itself can WAKE the phone app in the
        // background — gating on reachability produced false "not reachable"
        // reports with both devices unlocked side by side.
        s.sendMessage(["type": "syncRequest"], replyHandler: { [weak self] reply in
            self?.ingestPhonePositions(reply)
            DispatchQueue.main.async { self?.lastEvent = "synced with phone ✓" }
        }, errorHandler: { [weak self] err in
            DispatchQueue.main.async {
                self?.lastEvent = "phone unreachable (\(err.localizedDescription)) — queued; will apply when in range"
            }
        })
    }

    // MARK: - watch → phone

    // Latest-wins resume/furthest snapshot (cheap; adopted by the phone's
    // fresher-ts external-position path).
    func sendPositionCheckpoint(titleId: String, positionMs: Double, furthestMs: Double) {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        var ctx = s.applicationContext
        var positions = (ctx["positions"] as? [String: [String: Double]]) ?? [:]
        positions[titleId] = ["ms": positionMs, "furthestMs": furthestMs,
                              "ts": Date().timeIntervalSince1970 * 1000]
        ctx["positions"] = positions
        try? s.updateApplicationContext(ctx)
    }

    // Reliable queued listen-time delta (phone stats: watch category).
    func sendListenDelta(titleId: String, sec: Double, positionMs: Double, furthestMs: Double) {
        guard sec >= 1, WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        s.transferUserInfo([
            "type": "listen", "titleId": titleId, "sec": sec,
            "ms": positionMs, "furthestMs": furthestMs,
            "ts": Date().timeIntervalSince1970 * 1000,
        ])
    }

    // Reliable queued word flag (phone lookup history, source 'watch').
    func sendWordFlag(titleId: String, word: String, cueText: String, sMs: Double, eMs: Double) {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        s.transferUserInfo([
            "type": "flag", "titleId": titleId, "word": word, "cueText": cueText,
            "s": sMs, "e": eMs,
            "ts": Date().timeIntervalSince1970 * 1000,
        ])
        DispatchQueue.main.async { self.lastEvent = "flagged \(word)" }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        // Context sent while this app wasn't running never fires the
        // didReceive callback — ingest the stored copy at activation.
        guard activationState == .activated else { return }
        ingestPhonePositions(session.receivedApplicationContext)
    }
}
