import AVFoundation
import Foundation
import WebKit

/// Native audiobook transport (`kadokiAudio`) behind the shim's
/// BackgroundAudio. The web <audio> element it replaces seeks VBR MP3s by
/// estimation — measured 12-18 s off on a long Audible MP3 — so a resume
/// landed in the wrong place and the read highlight trailed the voice for the
/// rest of the session. Cue times come from AVAudioFile (the transcriber), so
/// playback uses AVAudioPlayer: the same Core Audio file layer, exactly what
/// the iOS BackgroundAudio plugin does (where sync is exact).
///
/// Ops (JSON {op,...}): play {path,startMs,rate}, pause, resume, stop,
/// seek {ms}, setRate {rate}, getState → {playing,ready,positionMs,durationMs}.
/// Events via KadokiEvents: BackgroundAudio position (150 ms while playing),
/// state, ended, error.
final class AudioPlayerHandler: NSObject, WKScriptMessageHandlerWithReply, AVAudioPlayerDelegate {

    private var player: AVAudioPlayer?
    private var path: String?
    private var rate: Float = 1.0
    private var timer: Timer?
    private var awakeToken: NSObjectProtocol?

    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
    private var positionMs: Double { (player?.currentTime ?? 0) * 1000 }
    private var durationMs: Double { (player?.duration ?? 0) * 1000 }
    private var isPlaying: Bool { player?.isPlaying ?? false }

    private func emitPosition() {
        KadokiEvents.push?("BackgroundAudio", "position", [
            "positionMs": positionMs.rounded(), "durationMs": durationMs.rounded(),
            "playing": isPlaying, "ts": Self.nowMs(),
        ])
    }
    private func emitState() {
        KadokiEvents.push?("BackgroundAudio", "state", ["playing": isPlaying, "ts": Self.nowMs()])
        emitPosition()
    }
    private func startTimer() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
            guard let self = self, self.isPlaying else { return }
            self.emitPosition()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }
    private func stopTimer() { timer?.invalidate(); timer = nil }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = req["op"] as? String else {
            replyHandler(nil, "bad request"); return
        }
        let reply: (Any?, String?) -> Void = { v, e in DispatchQueue.main.async { replyHandler(v, e) } }
        switch op {
        case "play":
            play(req, reply)
        case "pause", "stop":
            player?.pause(); stopTimer(); emitState(); reply([:], nil)
        case "resume":
            player?.play(); startTimer(); emitState(); reply([:], nil)
        case "seek":
            if let p = player {
                let ms = max(0, (req["ms"] as? Double) ?? 0)
                p.currentTime = min(p.duration, ms / 1000)
                emitPosition()
            }
            reply([:], nil)
        case "setRate":
            rate = Float((req["rate"] as? Double) ?? 1.0)
            player?.rate = rate
            reply([:], nil)
        case "keepAwake":
            // Overnight batch work: no idle system sleep, no App Nap.
            let on = (req["on"] as? Bool) ?? false
            if on, awakeToken == nil {
                awakeToken = ProcessInfo.processInfo.beginActivity(
                    options: [.idleSystemSleepDisabled, .userInitiated],
                    reason: "Kadoki is transcribing and proofreading books")
            } else if !on, let t = awakeToken {
                ProcessInfo.processInfo.endActivity(t); awakeToken = nil
            }
            reply(["on": awakeToken != nil], nil)
        case "getState":
            reply(["playing": isPlaying, "ready": player != nil,
                   "positionMs": positionMs.rounded(), "durationMs": durationMs.rounded()], nil)
        default:
            reply(nil, "unknown op \(op)")
        }
    }

    private func play(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard var p = req["path"] as? String, !p.isEmpty else { reply(nil, "path required"); return }
        if p.hasPrefix("file://") { p = String(p.dropFirst(7)).removingPercentEncoding ?? String(p.dropFirst(7)) }
        guard FileManager.default.fileExists(atPath: p) else { reply(nil, "file not found"); return }
        rate = Float((req["rate"] as? Double) ?? 1.0)
        let startMs = req["startMs"] as? Double
        let begin = { [weak self] (pl: AVAudioPlayer) in
            guard let self = self else { return }
            pl.rate = self.rate
            if let s = startMs { pl.currentTime = max(0, min(pl.duration, s / 1000)) }
            pl.play()
            self.startTimer()
            self.emitState()
            reply([:], nil)
        }
        if path == p, let pl = player { begin(pl); return }

        // Opening a long VBR MP3 scans it for its packet table; do it off the
        // main thread.
        player?.stop(); stopTimer()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let pl = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: p))
                pl.enableRate = true
                pl.prepareToPlay()
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    pl.delegate = self
                    self.player = pl
                    self.path = p
                    begin(pl)
                }
            } catch {
                reply(nil, "could not open audio: \(error.localizedDescription)")
            }
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        stopTimer()
        emitState()
        KadokiEvents.push?("BackgroundAudio", "ended", [:])
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        KadokiEvents.push?("BackgroundAudio", "error", ["message": "audio error: \(error?.localizedDescription ?? "")"])
    }
}
