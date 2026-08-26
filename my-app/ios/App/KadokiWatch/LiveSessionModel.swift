// LiveSessionModel.swift — Phase B: receives phone-pushed live-playback
// frames ({t:"live", titleId, ms, ts, playing, rate}, sendMessage, no reply)
// and derives an extrapolated clock the view samples each tick.
//
// DISPLAY-ONLY: this model must NEVER write pos_<id>/posTs_<id> — the phone
// owns the playhead while a live session is active. The only watch→phone
// write LiveView may perform is the flag gesture (place-loss invariant).
//
// There is no independent watch-side "which title" selection here — the
// view always mirrors whatever titleId the phone's most recent frame names,
// swapping cues/name automatically when the phone switches titles.
import Foundation

final class LiveSessionModel: ObservableObject {
    static let shared = LiveSessionModel()

    struct Frame {
        let titleId: String
        let ms: Double
        let ts: Double     // epoch ms at phone send time
        let playing: Bool
        let rate: Double
    }

    @Published private(set) var frame: Frame?
    @Published private(set) var cues: [WatchCue] = []
    @Published private(set) var titleName: String = ""

    private var cuesLoadedFor: String?

    // Called from WCSessionDelegate callbacks — caller dispatches to main.
    func ingest(_ message: [String: Any]) {
        guard (message["t"] as? String) == "live",
              let titleId = message["titleId"] as? String, !titleId.isEmpty else { return }
        let ms = (message["ms"] as? Double) ?? Double((message["ms"] as? Int) ?? 0)
        let ts = (message["ts"] as? Double) ?? Double((message["ts"] as? Int) ?? 0)
        let playing = (message["playing"] as? Bool) ?? false
        let rate = (message["rate"] as? Double) ?? 1.0
        // Ordering, not age, decides: a frame older than the one on screen
        // is a replay and is dropped; a NEWER frame is always taken, however
        // late WCSession delivers it — a late pause frame must still pause
        // (the old 3 s age cut-off threw exactly those away and left the
        // karaoke scrolling on the stale playing frame). displayMs
        // extrapolates from the frame's own ts, so an old-but-newest
        // playing frame still positions correctly; only a truly ancient one
        // (>30 s) says nothing useful about the present.
        if let cur = frame, ts > 0, cur.ts > 0, ts < cur.ts { return }
        if playing, ts > 0, Date().timeIntervalSince1970 * 1000 - ts > 30000 { return }
        if cuesLoadedFor != titleId {
            cues = WatchKaraoke.loadCues(titleId: titleId)
            // titleName() falls back to the raw id when meta.json hasn't
            // landed yet (e.g. cues transfer still in flight) — never show
            // that raw id in the UI; LiveView falls back to "On iPhone".
            let name = WatchKaraoke.titleName(titleId: titleId)
            titleName = (name == titleId) ? "" : name
            cuesLoadedFor = titleId
        }
        frame = Frame(titleId: titleId, ms: ms, ts: ts, playing: playing, rate: rate)
        armStaleTimer()
    }

    // Safety net: while the phone plays it sends a frame at least once a
    // second. If a "playing" frame is not followed by another within
    // STALE_S, the phone has stopped and we never heard — park the karaoke
    // where the extrapolation got to instead of scrolling on forever.
    static let STALE_S: TimeInterval = 5.5
    private var staleTimer: Timer?
    private func armStaleTimer() {
        staleTimer?.invalidate(); staleTimer = nil
        guard let f = frame, f.playing else { return }
        staleTimer = Timer.scheduledTimer(withTimeInterval: Self.STALE_S, repeats: false) { [weak self] _ in
            guard let self = self, let cur = self.frame, cur.playing, cur.ts == f.ts else { return }
            let nowMs = Date().timeIntervalSince1970 * 1000
            let parked = Self.displayMs(for: cur, now: Date())
            self.frame = Frame(titleId: cur.titleId, ms: parked, ts: nowMs, playing: false, rate: cur.rate)
        }
    }

    // A Phase C cues transfer landed for the title currently shown live —
    // mirrors WatchPlayer.refreshCues() for local playback.
    func refreshCuesIfNeeded(titleId: String) {
        guard cuesLoadedFor == titleId else { return }
        cues = WatchKaraoke.loadCues(titleId: titleId)
    }

    func clear() {
        staleTimer?.invalidate(); staleTimer = nil
        frame = nil
        cues = []
        cuesLoadedFor = nil
        titleName = ""
    }

    // Extrapolated display position (ms) for a frame at `now`.
    static func displayMs(for f: Frame, now: Date = Date()) -> Double {
        guard f.playing else { return f.ms }
        let elapsed = now.timeIntervalSince1970 * 1000 - f.ts
        guard elapsed > 0 else { return f.ms }
        return f.ms + elapsed * f.rate
    }
}
