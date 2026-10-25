import Foundation
import AVFoundation

/// Read-mode speech engine: AVAudioEngine source node fed by a streaming
/// AVAudioFile decode passed through Sonic (Bill Cox's PICOLA-style
/// pitch-synchronous time-scale modification, Apache 2.0 — sonic.c/h) via
/// Google's Speedy shim (speedy/, Apache 2.0; KISS FFT, BSD-3): with
/// `nonlinear` on, Speedy's MACH1-style tension analysis compresses vowels
/// and pauses harder than consonant transitions while holding the requested
/// AVERAGE speed (duration feedback 0.1). Speech stays intelligible and
/// pitch-preserved at 1.5–3× where AVAudioPlayer's generic stretcher smears.
/// Implements KadokiPlayback so the plugin drives it exactly like
/// AVAudioPlayer (play/pause/seek/rate/volume/fades/timer).
///
/// Foreground-only by policy (audio mode / background stay on AVAudioPlayer;
/// the plugin hands off between engines at the current position), so this
/// deliberately does NOT try to be a background player.
///
/// Threads: the audio thread only touches the ring under a short lock; a
/// dedicated producer thread decodes + runs Sonic (procLock guards the
/// file/Sonic state, which seek() also takes). Playhead = source frames of
/// the audio actually rendered, reconstructed from per-chunk markers
/// (output-frame index → source-frame index at the chunk's end, at that
/// chunk's speed), so the reader follow sees the true position at any rate.
final class KadokiReadEngine: NSObject, KadokiPlayback {

    var onEnded: (() -> Void)?
    var onError: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode!
    private let file: AVAudioFile
    private let sampleRate: Double
    private let channels: Int            // Sonic/ring channel count (1 or 2)
    private let totalFrames: Int64
    private var sonic: sonicStream?
    private var readBuf: AVAudioPCMBuffer
    private var interleave: [Float]      // scratch: chunk × channels
    private var sonicOut: [Float]        // scratch: drained output

    // Ring of INTERLEAVED processed frames.
    private let ringLock = NSLock()
    // The last 1024 output samples (mono), for the toolbar's spectrum bars.
    private var scope = [Float](repeating: 0, count: 1024)
    private var scopeAt = 0
    private var ring: [Float]
    private let ringCap: Int             // frames
    private var ringHead = 0             // read index (frames)
    private var ringCount = 0            // frames available
    private struct Marker { let outEnd: Int64; let srcEnd: Int64; let speed: Double }
    private var markers: [Marker] = []
    private var outWritten: Int64 = 0
    private var outRendered: Int64 = 0
    private var playingFlag = false
    private var gain: Float = 1
    private var gainTarget: Float = 1
    private var gainStep: Float = 1      // per-frame ramp (0 = instant)
    private var drainedAll = false       // producer: EOF reached, Sonic flushed and emptied
    private var endedFired = false

    // Producer state (procLock).
    private let procLock = NSLock()
    private var srcFrame: Int64 = 0      // next source frame to decode
    private var eof = false
    private var flushed = false
    private var rateValue: Float = 1
    private var seekGen = 0              // bumped by seek(); a chunk decoded before it is dropped
    private var producer: Thread?
    private let sem = DispatchSemaphore(value: 0)
    private var stopProducer = false
    private var lastTimeWhenIdle: Double = 0   // seconds, for currentTime while nothing is queued

    private static let CHUNK = 1024      // ≈23 ms @44.1k: finer playhead markers = smoother follow
    // Speedy holds ~14 analysis frames (10 ms each) of input before Sonic sees
    // them; markers subtract that so the reported playhead tracks the audio.
    private static let SPEEDY_LATENCY_SEC = 0.14
    private var nonlinearOn = false
    private static let HIGH_WATER_SEC = 0.22
    private static let RING_SEC = 1.6

    init?(url: URL) {
        guard let f = try? AVAudioFile(forReading: url) else { return nil }
        file = f
        sampleRate = f.processingFormat.sampleRate
        channels = min(2, max(1, Int(f.processingFormat.channelCount)))
        totalFrames = Self.trustedLength(url: url, file: f)
        guard let rb = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(Self.CHUNK)) else { return nil }
        readBuf = rb
        interleave = [Float](repeating: 0, count: Self.CHUNK * channels)
        sonicOut = [Float](repeating: 0, count: Self.CHUNK * 8 * channels)
        ringCap = Int(Self.RING_SEC * sampleRate)
        ring = [Float](repeating: 0, count: ringCap * channels)
        super.init()
        guard let st = sonicCreateStream(Int32(sampleRate), Int32(channels)) else { return nil }
        sonicIntSetQuality(st, 0)       // default (downsampled pitch search): quality 1 ran several× the CPU — noticeable heat over an hour
        sonic = st
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else { return nil }
        source = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, abl -> OSStatus in
            self?.render(frameCount, abl)
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 1.0
        startProducer()
        NotificationCenter.default.addObserver(self, selector: #selector(onConfigChange),
                                               name: .AVAudioEngineConfigurationChange, object: engine)
        NotificationCenter.default.addObserver(self, selector: #selector(onInterruption),
                                               name: AVAudioSession.interruptionNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        stopProducer = true; sem.signal()
        engine.stop()
        if let st = sonic { sonicDestroyStream(st) }
    }

    // MARK: KadokiPlayback

    var currentTime: TimeInterval {
        get {
            ringLock.lock()
            let rendered = outRendered
            var src: Double? = nil
            // Oldest marker whose chunk is still (partly) unrendered: its source
            // end minus the unrendered remainder scaled by that chunk's speed.
            if let m = markers.first(where: { $0.outEnd > rendered }) {
                src = Double(m.srcEnd) - Double(m.outEnd - rendered) * m.speed
            }
            let cnt = ringCount, playing = playingFlag
            ringLock.unlock()
            if let s = src { let t = max(0, s / sampleRate); lastTimeWhenIdle = t; return t }
            if cnt == 0 && !playing { return lastTimeWhenIdle }
            procLock.lock(); let sf = srcFrame; procLock.unlock()
            return max(0, Double(sf) / sampleRate)
        }
        set { seek(toSeconds: newValue) }
    }

    var duration: TimeInterval { Double(totalFrames) / sampleRate }

    /// AVAudioFile.length is an ESTIMATE for VBR MP3s without a packet table
    /// (bitrate × size) and can run SHORT by a large margin. Clamping seeks to
    /// it — and treating the clamp as end-of-file — threw a reader from 75k
    /// chars back to 62k and then saved that as the place (PLACE-LOSS,
    /// 2026-09-08). AVAudioPlayer's duration is what every other path in the
    /// app trusts; take the LONGER of the two so a seek is never clamped
    /// short. The decoder itself signals the true end by returning 0 frames.
    static func trustedLength(url: URL, file f: AVAudioFile) -> Int64 {
        var frames = f.length
        if let ref = try? AVAudioPlayer(contentsOf: url), ref.duration > 0 {
            let refFrames = Int64(ref.duration * f.processingFormat.sampleRate)
            if refFrames > frames {
                NSLog("[ReadEngine] length: AVAudioFile %lld frames vs AVAudioPlayer %lld — using the longer (VBR estimate)", frames, refFrames)
                frames = refFrames
            }
        }
        return frames
    }

    var isPlaying: Bool { playingFlag }

    var rate: Float {
        get { rateValue }
        set {
            let r = max(0.25, min(6.0, newValue))
            procLock.lock()
            rateValue = r
            if let st = sonic { sonicSetSpeed(st, r) }
            procLock.unlock()
        }
    }

    /// Speedy nonlinear (MACH1-style) compression on top of Sonic.
    var nonlinear: Bool {
        get { nonlinearOn }
        set {
            procLock.lock()
            nonlinearOn = newValue
            if let st = sonic { sonicEnableNonlinearSpeedup(st, newValue ? 1.0 : 0.0) }
            procLock.unlock()
        }
    }

    var volume: Float {
        get { gainTarget }
        set { ringLock.lock(); gain = newValue; gainTarget = newValue; gainStep = 1; ringLock.unlock() }
    }

    func setVolume(_ v: Float, fadeDuration duration: TimeInterval) {
        ringLock.lock()
        gainTarget = v
        gainStep = duration > 0 ? Float(1.0 / (duration * sampleRate)) : 1
        ringLock.unlock()
    }

    @discardableResult
    func play() -> Bool {
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch {
                NSLog("[ReadEngine] start failed: %@", error.localizedDescription)
                onError?("read engine start failed: \(error.localizedDescription)")
                return false
            }
        }
        ringLock.lock(); playingFlag = true; endedFired = false; ringLock.unlock()
        sem.signal()
        return true
    }

    func pause() {
        ringLock.lock()
        playingFlag = false
        // Remember where we are for currentTime while idle.
        ringLock.unlock()
        lastTimeWhenIdle = currentTime
        // Let the fade the plugin scheduled finish, then stop the I/O.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self = self, !self.playingFlag else { return }
            self.engine.pause()
        }
    }

    func stop() {
        ringLock.lock(); playingFlag = false; ringLock.unlock()
        stopProducer = true; sem.signal()
        engine.stop()
    }

    // MARK: seek

    private func seek(toSeconds sec: TimeInterval) {
        let f = Int64(max(0, min(Double(totalFrames), sec * sampleRate)))
        procLock.lock()
        seekGen += 1
        srcFrame = f
        eof = false                    // only a real 0-frame read ends the file — never a clamp
        flushed = false
        file.framePosition = f
        if let st = sonic { sonicDestroyStream(st) }
        sonic = sonicCreateStream(Int32(sampleRate), Int32(channels))
        if let st = sonic {
            sonicIntSetQuality(st, 0)
            sonicSetSpeed(st, rateValue)
            sonicEnableNonlinearSpeedup(st, nonlinearOn ? 1.0 : 0.0)
        }
        procLock.unlock()
        ringLock.lock()
        ringHead = 0; ringCount = 0; markers.removeAll(keepingCapacity: true)
        outWritten = 0; outRendered = 0; drainedAll = false; endedFired = false
        // Click-free: dip the gain and ramp back over ~10 ms.
        if playingFlag { gain = 0; gainStep = Float(1.0 / (0.010 * sampleRate)) }
        ringLock.unlock()
        lastTimeWhenIdle = Double(f) / sampleRate
        seekAt = Date().timeIntervalSince1970; firstAfterSeekLogged = false
        sem.signal()
    }
    private var seekAt: Double = 0
    private var firstAfterSeekLogged = true

    // MARK: producer

    private func startProducer() {
        let t = Thread { [weak self] in
            while let self = self, !self.stopProducer {
                self.sem.wait()
                if self.stopProducer { break }
                var guardIters = 0
                while self.needsFill() && guardIters < 64 { self.fillOnce(); guardIters += 1 }
            }
        }
        t.name = "kadoki.readengine.producer"
        t.qualityOfService = .userInteractive
        producer = t
        t.start()
    }

    private func needsFill() -> Bool {
        ringLock.lock(); let cnt = ringCount; let done = drainedAll; ringLock.unlock()
        if done { return false }
        return cnt < Int(Self.HIGH_WATER_SEC * sampleRate)
    }

    private func fillOnce() {
        procLock.lock()
        guard let st = sonic else { procLock.unlock(); return }
        let genAtStart = seekGen
        if !eof {
            readBuf.frameLength = 0
            do { try file.read(into: readBuf, frameCount: AVAudioFrameCount(Self.CHUNK)) }
            catch { NSLog("[ReadEngine] read failed: %@", error.localizedDescription); eof = true }
            let got = Int(readBuf.frameLength)
            if got == 0 { eof = true }
            else if let ch = readBuf.floatChannelData {
                // 0.9999: the Speedy shim converts float→short as *32768 with no
                // clamp, so a full-scale sample would wrap to -32768 (a click).
                let k: Float = 0.9999
                if channels == 1 {
                    interleave.withUnsafeMutableBufferPointer { dst in
                        for i in 0..<got { dst[i] = ch[0][i] * k }
                    }
                } else {
                    interleave.withUnsafeMutableBufferPointer { dst in
                        for i in 0..<got { dst[2 * i] = ch[0][i] * k; dst[2 * i + 1] = ch[1][i] * k }
                    }
                }
                interleave.withUnsafeBufferPointer { p in _ = sonicWriteFloatToStream(st, p.baseAddress, Int32(got)) }
                srcFrame += Int64(got)
            }
        }
        if eof && !flushed { _ = sonicFlushStream(st); flushed = true }
        // Drain whatever Sonic has produced.
        let avail = Int(sonicIntSamplesAvailable(st))
        let lat = (nonlinearOn && !flushed) ? Int64(Self.SPEEDY_LATENCY_SEC * sampleRate) : 0
        let srcEnd = max(0, srcFrame - lat), speed = Double(rateValue)
        var drained = 0
        if avail > 0 {
            let want = min(avail, sonicOut.count / channels)
            drained = Int(sonicOut.withUnsafeMutableBufferPointer { p in sonicReadFloatFromStream(st, p.baseAddress, Int32(want)) })
        }
        let finished = eof && flushed && Int(sonicIntSamplesAvailable(st)) == 0
        procLock.unlock()
        if drained > 0 { appendToRing(frames: drained, srcEnd: srcEnd, speed: speed, gen: genAtStart) }
        if finished { ringLock.lock(); if seekGenSnapshot() == genAtStart { drainedAll = true }; ringLock.unlock() }
    }

    private func seekGenSnapshot() -> Int { procLock.lock(); defer { procLock.unlock() }; return seekGen }

    private func appendToRing(frames: Int, srcEnd: Int64, speed: Double, gen: Int) {
        // A seek landed while this chunk was being produced → it belongs to
        // the old position; never let it into the (already cleared) ring.
        if seekGenSnapshot() != gen { return }
        ringLock.lock()
        let free = ringCap - ringCount
        let n = min(frames, free)
        if n > 0 {
            var w = (ringHead + ringCount) % ringCap
            var srcIdx = 0
            var left = n
            ring.withUnsafeMutableBufferPointer { dst in
                sonicOut.withUnsafeBufferPointer { src in
                    while left > 0 {
                        let run = min(left, ringCap - w)
                        let dstOff = w * channels, srcOff = srcIdx * channels, cnt = run * channels
                        for k in 0..<cnt { dst[dstOff + k] = src[srcOff + k] }
                        w = (w + run) % ringCap; srcIdx += run; left -= run
                    }
                }
            }
            ringCount += n
            outWritten += Int64(n)
            markers.append(Marker(outEnd: outWritten, srcEnd: srcEnd, speed: speed))
            if markers.count > 4096 { markers.removeFirst(markers.count - 2048) }
        }
        ringLock.unlock()
        if n < frames { NSLog("[ReadEngine] ring overflow dropped %d frames", frames - n) }
    }

    // MARK: render (audio thread)

    private func render(_ n: AVAudioFrameCount, _ abl: UnsafeMutablePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        guard buffers.count >= 1, let m0 = buffers[0].mData else { return }
        let outL = m0.assumingMemoryBound(to: Float.self)
        let outR = (buffers.count > 1 && buffers[1].mData != nil) ? buffers[1].mData!.assumingMemoryBound(to: Float.self) : outL
        let count = Int(n)
        ringLock.lock()
        let playing = playingFlag
        var avail = ringCount
        let done = drainedAll
        if !playing || avail == 0 {
            for i in 0..<count { outL[i] = 0; outR[i] = 0 }
            if playing && avail == 0 && done && !endedFired {
                endedFired = true
                playingFlag = false
                DispatchQueue.main.async { [weak self] in self?.onEnded?() }
            }
            ringLock.unlock()
            if playing && !done { sem.signal() }   // underrun — poke the producer
            return
        }
        let take = min(count, avail)
        if !firstAfterSeekLogged { firstAfterSeekLogged = true; NSLog("[ReadEngine] first audio %.0f ms after seek", (Date().timeIntervalSince1970 - seekAt) * 1000) }
        var h = ringHead
        var g = gain
        let gT = gainTarget, gS = gainStep
        ring.withUnsafeBufferPointer { src in
            for i in 0..<take {
                let base = h * channels
                let l = src[base]
                let r = channels > 1 ? src[base + 1] : l
                if g != gT { g = (g < gT) ? min(gT, g + gS) : max(gT, g - gS) }
                outL[i] = l * g
                outR[i] = r * g
                scope[scopeAt] = (l + r) * 0.5 * g
                scopeAt = (scopeAt + 1) & 1023
                h += 1; if h == ringCap { h = 0 }
            }
        }
        gain = g
        ringHead = h
        ringCount -= take
        outRendered += Int64(take)
        avail = ringCount
        // Drop markers fully behind the playhead (keep one for currentTime).
        if markers.count > 8 {
            var drop = 0
            while drop + 1 < markers.count && markers[drop + 1].outEnd <= outRendered { drop += 1 }
            if drop > 0 { markers.removeFirst(drop) }
        }
        ringLock.unlock()
        if take < count { for i in take..<count { outL[i] = 0; outR[i] = 0 } }
        if avail < Int(Self.HIGH_WATER_SEC * sampleRate) { sem.signal() }
    }

    /// The most recent output samples, oldest first (spectrum display).
    var scopeSampleRate: Double { sampleRate }
    func recentSamples() -> [Float] {
        ringLock.lock(); defer { ringLock.unlock() }
        return Array(scope[scopeAt...] + scope[..<scopeAt])
    }

    // MARK: notifications

    @objc private func onConfigChange(_ n: Notification) {
        // Route/format change stopped the engine; restart if we were playing.
        guard playingFlag else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.playingFlag, !self.engine.isRunning else { return }
            self.engine.prepare()
            try? self.engine.start()
        }
    }

    @objc private func onInterruption(_ n: Notification) {
        guard let info = n.userInfo,
              let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeVal) else { return }
        if type == .began {
            // Mirror AVAudioPlayer: an interruption pauses us; the plugin's
            // timer notices isPlaying == false.
            ringLock.lock(); playingFlag = false; ringLock.unlock()
        }
    }
}
