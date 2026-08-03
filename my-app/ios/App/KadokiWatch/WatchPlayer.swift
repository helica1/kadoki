// WatchPlayer.swift — local audiobook playback on the watch.
//
// AVAudioPlayer over the transferred file; AVAudioSession .playback with the
// .longFormAudio policy (routes to Bluetooth headphones OR — on current
// watchOS — the watch speaker; the user LIKES the speaker, so this session
// config is deliberately left as-is). Position is checkpointed with a
// TIMESTAMP every 5s while playing + on pause; resume adoption is
// fresher-listen-wins between the local checkpoint and the phone-sent
// position (phonePos_<id>, delivered via applicationContext) — respecting a
// deliberate scrub-back on either device. Listened seconds accumulate and
// flush to the phone as reliable queued deltas (stats: watch category).
// Cues (with word timings when present) load from cues.json for the subtitle
// display + karaoke fill + word flagging.
import Foundation
import AVFoundation
import MediaPlayer
import WidgetKit

struct WatchCue {
    let s: Double        // ms
    let e: Double        // ms
    let text: String
    let w: [Double]?     // flat [utf16Off, len, relStartMs, relEndMs] quads
}

final class WatchPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    static let shared = WatchPlayer()

    @Published var current: WatchTitle?
    @Published var isPlaying = false
    @Published var positionSec: Double = 0
    @Published var durationSec: Double = 0
    @Published var statusText = ""
    @Published private(set) var cues: [WatchCue] = []

    private var player: AVAudioPlayer?
    private var tick: Timer?
    private var lastPersist = Date.distantPast
    private var listenAccSec: Double = 0
    private var lastTickDate: Date?

    // MARK: - load / transport

    func load(_ title: WatchTitle) {
        guard let url = title.audioURL else { statusText = "No audio"; return }
        if current?.id == title.id, let p = player {
            // Same title re-entered: REFRESH rather than early-return — a
            // cues-only re-send may have landed (word timings for karaoke),
            // and the phone may have reported a fresher listen position.
            // Adoption only while paused (live local playback wins).
            loadCues(title)
            if !p.isPlaying { adoptResume(into: p, titleId: title.id) }
            positionSec = p.currentTime
            return
        }
        flushListenDelta()
        persistNow()                                            // previous title's spot
        player?.stop()
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.delegate = self
            player = p
            current = title
            durationSec = p.duration
            loadCues(title)
            adoptResume(into: p, titleId: title.id)
            positionSec = p.currentTime
            statusText = ""
            updateWidgetSnapshot(reload: true)
        } catch {
            statusText = "Load failed: \(error.localizedDescription)"
        }
    }

    // Resume adoption: fresher-listen-wins between the LOCAL checkpoint and
    // the PHONE's reported position (never 0 unless both are unknown).
    private func adoptResume(into p: AVAudioPlayer, titleId: String) {
        let d = UserDefaults.standard
        let localPos = d.double(forKey: "pos_" + titleId)
        let localTs = d.double(forKey: "posTs_" + titleId)
        let phonePos = d.double(forKey: "phonePos_" + titleId)
        let phoneTs = d.double(forKey: "phonePosTs_" + titleId)
        var resume = localPos
        if phonePos > 0, phoneTs > localTs { resume = phonePos }
        if resume > 0, resume < p.duration - 1 { p.currentTime = resume }
    }

    // Cues file replaced (cues-only re-send) while this title is loaded.
    func refreshCues() {
        if let t = current { loadCues(t) }
    }

    // Phone context just arrived: re-run resume adoption for the loaded title
    // while paused (live playback wins).
    func adoptPhonePositionIfIdle() {
        guard let t = current, let p = player, !p.isPlaying else { return }
        adoptResume(into: p, titleId: t.id)
        positionSec = p.currentTime
    }

    // Manual-sync: push the current checkpoint immediately.
    func pushCheckpointNow() { persistNow() }

    private func loadCues(_ title: WatchTitle) {
        cues = []
        let url = WatchTitleStore.titleDir(title.id).appendingPathComponent("cues.json")
        guard let data = try? Data(contentsOf: url),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        var out: [WatchCue] = []
        out.reserveCapacity(arr.count)
        for o in arr {
            let s = (o["s"] as? Double) ?? Double((o["s"] as? Int) ?? -1)
            let e = (o["e"] as? Double) ?? Double((o["e"] as? Int) ?? -1)
            guard s >= 0, e >= s, let text = o["text"] as? String, !text.isEmpty else { continue }
            var w: [Double]? = nil
            if let raw = o["w"] as? [Any], !raw.isEmpty, raw.count % 4 == 0 {
                w = raw.compactMap { ($0 as? Double) ?? Double(($0 as? Int) ?? 0) }
            }
            out.append(WatchCue(s: s, e: e, text: text, w: w))
        }
        out.sort { $0.s < $1.s }
        cues = out
    }

    // Live position straight from the player (finer than the 0.5s tick — the
    // karaoke view reads this per frame).
    func liveSec() -> Double { player?.currentTime ?? positionSec }

    // Binary search: index of the cue containing (or last starting before) ms.
    func cueIndex(atMs ms: Double) -> Int? {
        guard !cues.isEmpty else { return nil }
        var lo = 0, hi = cues.count - 1, best = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cues[mid].s <= ms { best = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        guard best >= 0 else { return nil }
        return ms <= cues[best].e + 1500 ? best : best   // linger through short gaps
    }

    func togglePlay() {
        guard let p = player else { return }
        if p.isPlaying {
            p.pause()
            isPlaying = false
            persistNow()
            flushListenDelta()
            stopTick()
            updateNowPlaying()
            updateWidgetSnapshot(reload: true)
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        } catch {
            statusText = "Session: \(error.localizedDescription)"
            return
        }
        session.activate(options: []) { [weak self] ok, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err { self.statusText = "Route: \(err.localizedDescription)"; return }
                guard ok, let p = self.player else { return }
                p.play()
                self.isPlaying = true
                self.statusText = ""
                self.lastTickDate = Date()
                self.startTick()
                self.setupRemoteCommands()
                self.updateNowPlaying()
            }
        }
    }

    // Jump one subtitle back/forward (the Kadoki swipe convention). Falls back
    // to a 15s skip when no cues exist.
    func jumpCue(_ dir: Int) {
        guard let p = player else { return }
        let ms = p.currentTime * 1000
        guard !cues.isEmpty, let idx = cueIndex(atMs: ms) else {
            skip(dir > 0 ? 15 : -15)
            return
        }
        let t = max(0, min(cues.count - 1, idx + dir))
        p.currentTime = max(0, min(p.duration - 0.5, cues[t].s / 1000 + 0.01))
        positionSec = p.currentTime
        persistNow()
        updateNowPlaying()
    }

    func skip(_ seconds: Double) {
        guard let p = player else { return }
        p.currentTime = max(0, min(p.duration - 0.5, p.currentTime + seconds))
        positionSec = p.currentTime
        persistNow()
        updateNowPlaying()
    }

    func seek(toSec sec: Double) {
        guard let p = player else { return }
        p.currentTime = max(0, min(p.duration - 0.5, sec))
        positionSec = p.currentTime
    }

    // MARK: - ticking + persistence + listen accumulation

    private func startTick() {
        stopTick()
        tick = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let p = self.player else { return }
            self.positionSec = p.currentTime
            // Listened-time accumulation (wall time while actually playing).
            if p.isPlaying, let last = self.lastTickDate {
                self.listenAccSec += Date().timeIntervalSince(last)
            }
            self.lastTickDate = Date()
            if Date().timeIntervalSince(self.lastPersist) >= 5 { self.persistNow() }
            // Periodic flush so a very long session still reaches the phone.
            if self.listenAccSec >= 120 { self.flushListenDelta() }
        }
    }
    private func stopTick() { tick?.invalidate(); tick = nil; lastTickDate = nil }

    private func persistNow() {
        guard let t = current, let p = player else { return }
        lastPersist = Date()
        let d = UserDefaults.standard
        d.set(p.currentTime, forKey: "pos_" + t.id)
        d.set(Date().timeIntervalSince1970 * 1000, forKey: "posTs_" + t.id)
        let fKey = "furthest_" + t.id
        let furthest = max(d.double(forKey: fKey), p.currentTime)
        d.set(furthest, forKey: fKey)
        WatchConnectivityManager.shared.sendPositionCheckpoint(
            titleId: t.id, positionMs: p.currentTime * 1000, furthestMs: furthest * 1000)
        updateWidgetSnapshot(reload: false)
    }

    // Complication data (App Group). Snapshot written on every checkpoint;
    // timeline reloads only on meaningful transitions (pause/load/finish) —
    // WidgetKit reload budget is limited.
    private func updateWidgetSnapshot(reload: Bool) {
        guard let t = current, let p = player,
              let g = UserDefaults(suiteName: "group.com.helica1.yama") else { return }
        g.set(t.name, forKey: "wTitle")
        g.set(p.currentTime, forKey: "wPos")
        g.set(p.duration, forKey: "wDur")
        g.set(Date().timeIntervalSince1970, forKey: "wUpdated")
        if reload { WidgetCenter.shared.reloadTimelines(ofKind: "KadokiProgress") }
    }

    // Queued reliable listen delta → phone stats (watch category).
    func flushListenDelta() {
        guard let t = current, listenAccSec >= 1 else { listenAccSec = max(0, listenAccSec); return }
        let sec = listenAccSec
        listenAccSec = 0
        let d = UserDefaults.standard
        WatchConnectivityManager.shared.sendListenDelta(
            titleId: t.id, sec: sec.rounded(),
            positionMs: (player?.currentTime ?? 0) * 1000,
            furthestMs: d.double(forKey: "furthest_" + t.id) * 1000)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        isPlaying = false
        persistNow()
        flushListenDelta()
        stopTick()
        updateWidgetSnapshot(reload: true)
    }

    // MARK: - Now Playing / remote commands

    private var commandsWired = false
    private func setupRemoteCommands() {
        guard !commandsWired else { return }
        commandsWired = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            guard let self, let p = self.player, !p.isPlaying else { return .commandFailed }
            self.togglePlay(); return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            guard let self, let p = self.player, p.isPlaying else { return .commandFailed }
            self.togglePlay(); return .success
        }
        c.skipForwardCommand.preferredIntervals = [15]
        c.skipForwardCommand.addTarget { [weak self] _ in self?.skip(15); return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] _ in self?.skip(-15); return .success }
    }

    private func updateNowPlaying() {
        guard let t = current, let p = player else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.name,
            MPMediaItemPropertyPlaybackDuration: p.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: p.currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: p.isPlaying ? 1.0 : 0.0,
        ]
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
