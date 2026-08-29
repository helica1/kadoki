import Foundation
import AVFoundation

/// The playback interface BackgroundAudioPlugin actually uses. AVAudioPlayer
/// satisfies every member natively (see the extension below); KadokiVideoPlayer
/// adapts an AVPlayer to the same shape so the plugin's transport, fade,
/// durable-floor, remote-command and chapter-repeat machinery drive video
/// files without a single branched call site.
protocol KadokiPlayback: AnyObject {
    var currentTime: TimeInterval { get set }
    var duration: TimeInterval { get }
    var isPlaying: Bool { get }
    var rate: Float { get set }
    var volume: Float { get set }
    @discardableResult func play() -> Bool
    func pause()
    func stop()
    func setVolume(_ volume: Float, fadeDuration duration: TimeInterval)
}

extension AVAudioPlayer: KadokiPlayback {}

/// AVPlayer-backed engine for video files (mp4 / m4v / mov / 3gp) standing as
/// audiobook attachments. Cross-platform: on iPhone the audio track plays with
/// no picture; on visionOS KadokiVideoLayer shows the frames on a RealityKit
/// plane (flat VideoMaterial or AI-3D stereo).
final class KadokiVideoPlayer: NSObject, KadokiPlayback {

    let avPlayer: AVPlayer
    let item: AVPlayerItem
    /// Natural video size, filled asynchronously after load (0×0 until known).
    private(set) var videoSize: CGSize = .zero

    var onEnded: (() -> Void)?
    var onError: ((String) -> Void)?
    var onVideoSize: ((CGSize) -> Void)?

    private var desiredRate: Float = 1.0
    private var endObs: NSObjectProtocol?
    private var failObs: NSObjectProtocol?
    private var fadeTimer: DispatchSourceTimer?

    init(url: URL) {
        // Precise timing: VBR sources otherwise report drifting durations and
        // land seeks off-target (the iOS audio engine learned this the hard
        // way — AVURLAssetPreferPreciseDurationAndTimingKey).
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        item = AVPlayerItem(asset: asset)
        // Audiobook-style rate changes (0.5–2.0) with intelligible speech.
        item.audioTimePitchAlgorithm = .timeDomain
        avPlayer = AVPlayer(playerItem: item)
        avPlayer.actionAtItemEnd = .pause
        super.init()

        endObs = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in self?.onEnded?() }
        failObs = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { [weak self] note in
            let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.onError?(err?.localizedDescription ?? "video playback failed")
        }

        // Natural size only matters for the visionOS display layer; the async
        // loaders it uses need iOS 15+, older iPhones just skip it (audio-only
        // playback there anyway).
        if #available(iOS 15.0, *) {
            Task { [weak self] in
                guard let self else { return }
                if let track = try? await asset.loadTracks(withMediaType: .video).first,
                   let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) {
                    let r = CGRect(origin: .zero, size: size).applying(transform)
                    let sz = CGSize(width: abs(r.width), height: abs(r.height))
                    await MainActor.run {
                        self.videoSize = sz
                        self.onVideoSize?(sz)
                    }
                }
            }
        }
    }

    deinit {
        if let o = endObs { NotificationCenter.default.removeObserver(o) }
        if let o = failObs { NotificationCenter.default.removeObserver(o) }
        fadeTimer?.cancel()
    }

    // MARK: KadokiPlayback

    var currentTime: TimeInterval {
        get {
            let s = item.currentTime().seconds
            return s.isFinite ? max(0, s) : 0
        }
        set {
            let t = CMTime(seconds: max(0, newValue), preferredTimescale: 600)
            avPlayer.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
        }
    }

    var duration: TimeInterval {
        let s = item.duration.seconds
        return s.isFinite ? max(0, s) : 0
    }

    // AVAudioPlayer semantics: "playing" == the transport is running.
    // AVPlayer.rate stays at the requested value while buffering, so this is
    // stable through short stalls.
    var isPlaying: Bool { avPlayer.rate != 0 }

    var rate: Float {
        get { desiredRate }
        set {
            desiredRate = newValue
            // Only push while running: setting AVPlayer.rate on a paused
            // player RESUMES it (unlike AVAudioPlayer.rate).
            if avPlayer.rate != 0 { avPlayer.rate = newValue }
        }
    }

    var volume: Float {
        get { avPlayer.volume }
        set { cancelFade(); avPlayer.volume = newValue }
    }

    @discardableResult func play() -> Bool {
        avPlayer.playImmediately(atRate: desiredRate)
        return true
    }

    func pause() { avPlayer.pause() }

    func stop() { avPlayer.pause() }

    /// AVAudioPlayer.setVolume(_:fadeDuration:)-compatible ramp; AVPlayer has
    /// no built-in fade, so step the volume on a short timer. Fades here are
    /// 20–150 ms UI ramps — 20 ms steps are inaudible.
    func setVolume(_ target: Float, fadeDuration duration: TimeInterval) {
        cancelFade()
        guard duration > 0.01 else { avPlayer.volume = target; return }
        let start = avPlayer.volume
        let stepMs = 20.0
        let steps = max(1, Int(duration * 1000.0 / stepMs))
        var i = 0
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(Int(stepMs)),
                       repeating: .milliseconds(Int(stepMs)))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            i += 1
            let f = Float(i) / Float(steps)
            self.avPlayer.volume = start + (target - start) * min(1, f)
            if i >= steps { self.cancelFade() }
        }
        fadeTimer = timer
        timer.resume()
    }

    private func cancelFade() {
        fadeTimer?.cancel()
        fadeTimer = nil
    }

    /// Video file sniff for the plugin's play() branch.
    static func isVideoUrl(_ url: URL) -> Bool {
        // mkv reaches playback only as a remuxed .mp4 cache file; listed here
        // so a stray raw path still routes to AVPlayer (clear error) rather
        // than AVAudioPlayer.
        ["mp4", "m4v", "mov", "3gp", "mkv"].contains(url.pathExtension.lowercased())
    }
}
