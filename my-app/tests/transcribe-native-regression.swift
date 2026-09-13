// Appended to an access-relaxed copy of the production TranscribeJob by
// run-transcribe-native-tests.mjs. No duplicate pacing/cancellation logic.
@main struct NativePowerRegression {
    static func expect(_ ok: Bool, _ message: String) {
        if !ok { fatalError(message) }
    }
    static func fixture() throws -> (URL, AVAudioFormat) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        let format = AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1)!
        let writer = try AVAudioFile(forWriting: url, settings: format.settings)
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 96_000)!
        pcm.frameLength = 96_000
        pcm.floatChannelData![0].initialize(repeating: 0, count: 96_000)
        try writer.write(from: pcm)
        return (url, format)
    }
    static func makeJob(_ url: URL, ahead: Double = 8000, base: Double = 0,
                        done: @escaping (String, String?, Double) -> Void = { _, _, _ in }) -> TranscribeJob {
        TranscribeJob(id: UUID().uuidString, url: url, baseMs: base, aheadMs: ahead,
                      powerUnlimited: false, onCues: { _, _ in }, onDone: done)
    }
    static func main() async throws {
        let (url, format) = try fixture()
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        file.framePosition = 0 // production run() explicitly seeks before input
        let converter = AVAudioConverter(from: file.processingFormat, to: format)!
        let job = makeJob(url, ahead: 4000)

        // Real source-file reads and conversion; the third chunk must wait
        // until the target moves, without dropping/reordering samples.
        let first = await job.nextInput(from: file, converter: converter, format: format)
        let second = await job.nextInput(from: file, converter: converter, format: format)
        expect(first != nil && second != nil, "first two chunks missing")
        // AVAudioPCMBuffer may round capacity down; AVAudioFile can return
        // short reads. Validate actual frames, not an assumed 4,000 ms block.
        var frames = Int64(first!.buffer.frameLength + second!.buffer.frameLength)
        let parkedAt = job.fedThroughMs
        expect(parkedAt == Double(frames) / 8, "source clock disagrees with delivered audio")
        expect(parkedAt >= 4000 && parkedAt <= 8000, "buffer overshoot exceeds one chunk")
        let third = Task { await job.nextInput(from: file, converter: converter, format: format) }
        try await Task.sleep(nanoseconds: 50_000_000)
        expect(job.fedThroughMs == parkedAt, "producer ran past lookahead")
        job.setTarget(8000)
        let next = await third.value
        expect(next != nil && job.fedThroughMs > parkedAt, "resume failed")
        frames += Int64(next!.buffer.frameLength)
        while let tail = await job.nextInput(from: file, converter: converter, format: format) {
            frames += Int64(tail.buffer.frameLength)
        }
        expect(frames == file.length && job.fedThroughMs == 12_000, "resume/EOF lost or duplicated audio")
        print("PASS: bounded input, target resume, source clock, exact-boundary EOF")

        let paused = makeJob(url)
        paused.setFed(8000)
        let pausedFile = try AVAudioFile(forReading: url)
        let waiting = Task { await paused.nextInput(from: pausedFile, converter: converter, format: format) }
        try await Task.sleep(nanoseconds: 50_000_000)
        paused.cancel()
        let stoppedInput = await waiting.value
        expect(stoppedInput == nil && pausedFile.framePosition == 0, "stop must not feed pending audio")
        print("PASS: cancellation interrupts a parked input request without reading audio")

        let bounded = makeJob(url, ahead: 3_600_000)
        expect(bounded.inputAheadMs == 600_000, "old JS hour request must be capped on battery")
        bounded.setCharging(true)
        expect(bounded.inputAheadMs == 3_600_000, "charging lookahead changed")
        let noLimit = makeJob(url, ahead: 0)
        expect(noLimit.inputAheadMs == 600_000, "zero request must not bypass battery cap")
        print("PASS: native battery cap also protects older callers")

        let analyzer = SpeechAnalyzer(modules: [])
        let cancelled = makeJob(url)
        cancelled.installAnalyzer(analyzer)
        cancelled.cancel(forPower: true)
        expect(cancelled.cancellationTask() != nil, "stop did not invoke native analyzer cancellation")
        await cancelled.cancellationTask()?.value
        expect(cancelled.stopReason == "parked", "thermal stop reason lost")
        cancelled.releaseAnalyzer()
        expect(cancelled.cancellationTask() == nil, "teardown retained cancellation task")
        print("PASS: real SpeechAnalyzer immediate cancellation and cleanup")

        // A cancelled replacement still waits for its predecessor. It never
        // starts recognition; its completion cannot overtake old teardown.
        let state = CompletionState()
        let predecessor = Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            state.markPredecessor()
        }
        let replacement = makeJob(url, done: { reason, _, _ in
            expect(reason == "stopped", "queued cancellation reported wrong reason")
            state.markReplacement()
        })
        replacement.cancel()
        await replacement.begin(after: predecessor).value
        expect(state.ordered, "replacement overtook predecessor teardown")
        print("PASS: serialized completion chain with cancellation before start")

        // Use the real Speech attributed-string timing keys and production
        // segmenter: absolute timestamps and UTF-16 offsets remain intact.
        let timed = makeJob(url, base: 5000)
        var text = AttributedString("本")
        text.audioTimeRange = CMTimeRange(start: CMTime(seconds: 1, preferredTimescale: 1000),
                                         duration: CMTime(seconds: 0.5, preferredTimescale: 1000))
        let cues = timed.segmentResult(text)
        expect(cues.count == 1, "timed word missing")
        expect(cues[0]["w"] as? [Int] == [0, 1, 6000, 6500], "absolute word timing changed")
        print("PASS: production word-timing segmentation preserves offsets and timestamps")
    }
}

final class CompletionState: @unchecked Sendable {
    private let lock = NSLock()
    private var predecessor = false
    private var replacement = false
    func markPredecessor() { lock.lock(); predecessor = true; lock.unlock() }
    func markReplacement() { lock.lock(); replacement = predecessor; lock.unlock() }
    var ordered: Bool { lock.lock(); defer { lock.unlock() }; return predecessor && replacement }
}
