import Foundation
import Capacitor
import AVFoundation
import Speech
import UIKit
import os

/**
 * AutoTranscribePlugin — on-device subtitle generation for audio-only titles.
 *
 * Wraps iOS 26's SpeechAnalyzer/SpeechTranscriber (Neural Engine, ja_JP) to
 * transcribe a local audiobook file into SRT-style cues, streamed to JS as
 * they finalize. The JS orchestrator (auto-transcribe.js) owns pacing policy,
 * cue caching, and the "write a real .srt on completion" step; this plugin
 * serializes native jobs and enforces battery/thermal limits independently
 * of JS playback events. Finalized word timings keep their existing format.
 *
 *   checkAvailability()            → { supported, installed }
 *   ensureAssets()                 → { installed }   (emits "assetProgress" {fraction})
 *   start({jobId, srcPath, startMs, targetMs, aheadMs, powerUnlimited?})
 *                                  → { started, durationMs }
 *   setTarget({jobId, targetMs})   → {}   (playhead update for pacing)
 *   stop({jobId})                  → {}
 *
 * Events:
 *   "cues" { jobId, cues: [{startMs, endMs, text, w}], fedThroughMs }
 *          w = flat word-timing array [off, len, startMs, endMs, ...] — one
 *          quad per recognizer token, offsets/lengths in UTF-16 units into
 *          `text`, times ABSOLUTE file ms (JS rebases them cue-relative)
 *   "done" { jobId, reason: "eof" | "stopped" | "parked" | "error", error?, fedThroughMs }
 *
 * Input is pulled one four-second chunk at a time (no unbounded producer
 * queue). Battery input is capped at ten minutes ahead even for older JS.
 * Stop cancels pending analysis; only natural EOF finalizes all input.
 *
 * Timestamps from the analyzer are relative to the FED sequence (we seek the
 * file to startMs before feeding), so every emitted cue adds the job's base
 * offset. Feeding uses AVAudioFile → AVAudioConverter into the analyzer's
 * bestAvailableAudioFormat; a format mismatch produces silent empty output,
 * so the conversion is not optional.
 */
@objc(AutoTranscribePlugin)
public class AutoTranscribePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "AutoTranscribePlugin"
    public let jsName = "AutoTranscribe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ensureAssets",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start",             returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTarget",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getChapters",       returnType: CAPPluginReturnPromise),
    ]

    private var jobBox: AnyObject?
    private let jobLock = NSLock()
    private var jobTail: Task<Void, Never>?

    private static let localeId = "ja_JP"

    // MARK: - availability

    @objc func checkAvailability(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            Task {
                let locale = await Self.findSupportedLocale()
                var installed = false
                if let locale {
                    installed = await AssetInventory.status(forModules: [Self.makeTranscriber(locale)]) == .installed
                }
                call.resolve(["supported": locale != nil, "installed": installed])
            }
        } else {
            call.resolve(["supported": false, "installed": false])
        }
    }

    @available(iOS 26.0, *)
    private static func isJa(_ l: Locale) -> Bool {
        return l.identifier(.bcp47).lowercased().hasPrefix("ja")
    }

    @available(iOS 26.0, *)
    private static func findSupportedLocale() async -> Locale? {
        let locales = await SpeechTranscriber.supportedLocales
        return locales.first { isJa($0) }
    }

    // MARK: - assets

    @objc func ensureAssets(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.reject("Requires iOS 26 or later")
            return
        }
        Task {
            guard let locale = await Self.findSupportedLocale() else {
                call.reject("Japanese transcription is not supported on this device")
                return
            }
            do {
                try await Self.installAssets(locale: locale) { [weak self] f in
                    self?.notifyListeners("assetProgress", data: ["fraction": f])
                }
                self.notifyListeners("assetProgress", data: ["fraction": 1.0])
                call.resolve(["installed": true])
            } catch {
                atLog("asset install failed: \(error.localizedDescription)")
                call.reject("Speech model download failed: \(error.localizedDescription)")
            }
        }
    }

    @available(iOS 26.0, *)
    static func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                          attributeOptions: [.audioTimeRange])
    }

    /// Reserve the locale, download its model if needed, and wait until the
    /// system reports it installed (a fresh device can lag the download's
    /// completion by a few seconds). Throws if it never becomes usable.
    @available(iOS 26.0, *)
    static func installAssets(locale: Locale, progress: ((Double) -> Void)? = nil) async throws {
        let modules: [any SpeechModule] = [makeTranscriber(locale)]
        let st0 = await AssetInventory.status(forModules: modules)
        atLog("model status: \(st0)")
        if st0 == .installed { return }
        if !(await AssetInventory.reservedLocales).contains(where: { isJa($0) }) {
            do { _ = try await AssetInventory.reserve(locale: locale) }
            catch { atLog("reserve failed: \(error.localizedDescription)") }
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            let p = request.progress
            let poller = Task {
                while !Task.isCancelled {
                    progress?(p.fractionCompleted)
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            defer { poller.cancel() }
            atLog("downloading speech model")
            try await request.downloadAndInstall()
            atLog("download finished")
        }
        for _ in 0..<40 {
            let st = await AssetInventory.status(forModules: modules)
            if st == .installed { return }
            atLog("waiting for speech model: \(st)")
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw NSError(domain: "AutoTranscribe", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Japanese speech model is not installed"])
    }

    // MARK: - job control

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else {
            call.reject("Requires iOS 26 or later")
            return
        }
        guard let jobId = call.getString("jobId"), !jobId.isEmpty,
              let srcPath = call.getString("srcPath"), !srcPath.isEmpty else {
            call.reject("jobId and srcPath required")
            return
        }
        let startMs  = call.getDouble("startMs") ?? 0
        let targetMs = call.getDouble("targetMs") ?? startMs
        let aheadMs  = call.getDouble("aheadMs") ?? 600_000
        let powerUnlimited = call.getBool("powerUnlimited") ?? false

        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("Audio file not found: \(url.path)")
            return
        }

        let job = TranscribeJob(
            id: jobId, url: url, baseMs: max(0, startMs), aheadMs: aheadMs,
            powerUnlimited: powerUnlimited,
            onCues: { [weak self] cues, fedMs in
                self?.notifyListeners("cues", data: [
                    "jobId": jobId, "cues": cues, "fedThroughMs": fedMs
                ])
            },
            onDone: { [weak self] reason, errMsg, fedMs in
                self?.clearJob(job: nil, ifId: jobId)
                var data: [String: Any] = ["jobId": jobId, "reason": reason, "fedThroughMs": fedMs]
                if let e = errMsg { data["error"] = e }
                self?.notifyListeners("done", data: data)
            }
        )
        job.setTarget(targetMs)

        // Probe duration up front so JS learns it even before playback starts.
        var durationMs: Double = 0
        if let f = try? AVAudioFile(forReading: url), f.processingFormat.sampleRate > 0 {
            durationMs = Double(f.length) / f.processingFormat.sampleRate * 1000.0
        }

        jobLock.lock()
        // Keep a completion chain even when stop has been requested: an old
        // analyzer must finish teardown before its replacement can start.
        (jobBox as? TranscribeJob)?.cancel()
        jobBox = job
        jobTail = job.begin(after: jobTail)
        jobLock.unlock()

        call.resolve(["started": true, "durationMs": durationMs])
    }

    @objc func setTarget(_ call: CAPPluginCall) {
        guard #available(iOS 26.0, *) else { call.resolve(); return }
        let targetMs = call.getDouble("targetMs") ?? 0
        let jobId = call.getString("jobId")
        jobLock.lock()
        let job = jobBox as? TranscribeJob
        jobLock.unlock()
        if let job = job, jobId == nil || job.id == jobId {
            job.setTarget(targetMs)
        }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopCurrentJob(onlyId: call.getString("jobId"))
        call.resolve()
    }

    private func stopCurrentJob(onlyId: String? = nil) {
        guard #available(iOS 26.0, *) else { return }
        jobLock.lock()
        let job = jobBox as? TranscribeJob
        jobLock.unlock()
        guard let job = job else { return }
        if let only = onlyId, job.id != only { return }
        job.cancel()
        // onDone clears the slot only after native teardown is complete.
    }

    private func clearJob(job: AnyObject?, ifId: String) {
        guard #available(iOS 26.0, *) else { return }
        jobLock.lock()
        if let current = jobBox as? TranscribeJob, current.id == ifId {
            jobBox = nil
        }
        jobLock.unlock()
    }

    private func stripFileScheme(_ s: String) -> String {
        return s.hasPrefix("file://") ? String(s.dropFirst(7)) : s
    }

    // MARK: - embedded chapter markers (m4b / m4a)
    //
    // Reads the file's chapter list via AVAsset chapter metadata (handles
    // both QuickTime chapter tracks and Nero chpl atoms). Not tied to the
    // iOS 26 speech stack — works on any supported iOS. Returns
    // { chapters: [{startMs, title}] }; an empty list is a normal result
    // (file simply has no chapter markers).
    @objc func getChapters(_ call: CAPPluginCall) {
        guard let srcPath = call.getString("srcPath"), !srcPath.isEmpty else {
            call.reject("srcPath required")
            return
        }
        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("Audio file not found: \(url.path)")
            return
        }
        guard #available(iOS 15.0, *) else {
            call.resolve(["chapters": [] as [[String: Any]]])
            return
        }
        let asset = AVURLAsset(url: url)
        Task.detached(priority: .utility) {
            var chapters: [[String: Any]] = []
            do {
                let locales = try await asset.load(.availableChapterLocales)
                let languages = Locale.preferredLanguages + locales.map { $0.identifier }
                let groups = try await asset.loadChapterMetadataGroups(
                    bestMatchingPreferredLanguages: languages
                )
                for group in groups {
                    let startMs = group.timeRange.start.seconds * 1000.0
                    guard startMs.isFinite, startMs >= 0 else { continue }
                    var title = ""
                    for item in group.items where item.commonKey == .commonKeyTitle {
                        if let s = try? await item.load(.stringValue), !s.isEmpty { title = s; break }
                    }
                    chapters.append(["startMs": Int(startMs.rounded()), "title": title])
                }
            } catch {
                atLog("getChapters failed: \(error.localizedDescription)")
            }
            call.resolve(["chapters": chapters])
        }
    }
}

// MARK: - TranscribeJob

private let atLogger = Logger(subsystem: "com.helica1.yama", category: "AutoTranscribe")
func atLog(_ msg: String) { atLogger.notice("\(msg, privacy: .public)") }

/// Runs `op`, but stops waiting after `seconds` (throws). The operation itself
/// may not honour cancellation (asset downloads, a wedged predecessor), so the
/// wait is abandoned rather than joined — a hang can never stall the caller.
func atWithTimeout(_ seconds: Double, _ what: String,
                   _ op: @escaping @Sendable () async throws -> Void) async throws {
    final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var settled = false
        func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if settled { return false }; settled = true; return true }
    }
    let once = Once()
    let claim: @Sendable () -> Bool = { once.claim() }
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        let work = Task {
            do { try await op(); if claim() { cont.resume() } }
            catch { if claim() { cont.resume(throwing: error) } }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if claim() {
                work.cancel()
                cont.resume(throwing: NSError(domain: "AutoTranscribe", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "\(what) timed out"]))
            }
        }
    }
}

@available(iOS 26.0, *)
final class TranscribeJob: @unchecked Sendable {

    let id: String
    private let url: URL
    private let baseMs: Double
    private let aheadMs: Double
    private let powerUnlimited: Bool
    private let onCues: ([[String: Any]], Double) -> Void
    private let onDone: (String, String?, Double) -> Void

    private let stateLock = NSLock()
    private var _targetMs: Double = 0
    private var _cancelled = false
    private var _fedThroughMs: Double = 0
    private var _analyzer: SpeechAnalyzer?
    private var _cancelTask: Task<Void, Never>?
    private var _powerStopped = false
    private var _charging = false
    private var _feedError: String?

    // Cue segmentation tuning (Japanese subtitle conventions: short lines,
    // splits preferred at speech gaps or sentence punctuation).
    private static let gapSplitSec = 0.75
    private static let softMaxChars = 42
    private static let hardMaxChars = 84
    private static let sentenceEnders: Set<Character> = ["。", "！", "？", "!", "?", "…", "」", "』"]

    init(id: String, url: URL, baseMs: Double, aheadMs: Double, powerUnlimited: Bool,
         onCues: @escaping ([[String: Any]], Double) -> Void,
         onDone: @escaping (String, String?, Double) -> Void) {
        self.id = id
        self.url = url
        self.baseMs = baseMs
        self.aheadMs = aheadMs
        self.powerUnlimited = powerUnlimited
        self.onCues = onCues
        self.onDone = onDone
    }

    func setTarget(_ ms: Double) {
        stateLock.lock(); _targetMs = ms; stateLock.unlock()
    }
    private var targetMs: Double {
        stateLock.lock(); defer { stateLock.unlock() }; return _targetMs
    }
    func cancel(forPower: Bool = false) {
        stateLock.lock()
        _cancelled = true
        _powerStopped = _powerStopped || forPower
        cancelAnalyzerLocked()
        stateLock.unlock()
    }
    // Called only with stateLock held. Cancellation also interrupts EOF
    // finalization; setting a flag in the input loop alone cannot do that.
    private func cancelAnalyzerLocked() {
        if let analyzer = _analyzer, _cancelTask == nil {
            _cancelTask = Task { await analyzer.cancelAndFinishNow() }
        }
    }
    private func installAnalyzer(_ analyzer: SpeechAnalyzer) {
        stateLock.lock()
        _analyzer = analyzer
        if _cancelled { cancelAnalyzerLocked() }
        stateLock.unlock()
    }
    private func cancellationTask() -> Task<Void, Never>? {
        stateLock.lock(); defer { stateLock.unlock() }; return _cancelTask
    }
    private func releaseAnalyzer() {
        stateLock.lock(); _analyzer = nil; _cancelTask = nil; stateLock.unlock()
    }
    private var stopReason: String {
        stateLock.lock(); defer { stateLock.unlock() }; return _powerStopped ? "parked" : "stopped"
    }
    private func setFeedError(_ message: String) {
        stateLock.lock(); _feedError = message; stateLock.unlock()
    }
    private var feedError: String? {
        stateLock.lock(); defer { stateLock.unlock() }; return _feedError
    }
    private func setCharging(_ charging: Bool) {
        stateLock.lock(); _charging = charging; stateLock.unlock()
    }
    private var inputAheadMs: Double {
        stateLock.lock(); defer { stateLock.unlock() }
        if powerUnlimited || _charging { return aheadMs }
        return aheadMs > 0 ? min(aheadMs, 600_000) : 600_000
    }
    private func checkPower() async {
        guard !powerUnlimited else { return }
        let charging = await MainActor.run {
            UIDevice.current.isBatteryMonitoringEnabled = true
            let state = UIDevice.current.batteryState
            return state == .charging || state == .full
        }
        setCharging(charging)
        let thermal = ProcessInfo.processInfo.thermalState
        if thermal == .serious || thermal == .critical ||
            (ProcessInfo.processInfo.isLowPowerModeEnabled && !charging) {
            cancel(forPower: true)
        }
    }
    private var cancelled: Bool {
        stateLock.lock(); defer { stateLock.unlock() }; return _cancelled
    }
    private func setFed(_ ms: Double) {
        stateLock.lock(); _fedThroughMs = ms; stateLock.unlock()
    }
    private var fedThroughMs: Double {
        stateLock.lock(); defer { stateLock.unlock() }; return _fedThroughMs
    }

    func begin(after predecessor: Task<Void, Never>?) -> Task<Void, Never> {
        Task.detached(priority: .utility) { [self] in
            // An earlier job must finish its teardown first — but never wait
            // forever: one wedged job used to block every later title's
            // subtitles until the app was restarted.
            if let predecessor {
                do { try await atWithTimeout(15, "previous job") { await predecessor.value } }
                catch { atLog("job \(id): previous job still busy after 15 s — starting anyway") }
            }
            atLog("job \(id) begins, cancelled=\(cancelled)")
            if cancelled { onDone(stopReason, nil, baseMs); return }
            await run()
            atLog("job \(id) finished")
        }
    }

    private func run() async {
        setFed(baseMs)
        await checkPower()
        if cancelled { onDone(stopReason, nil, fedThroughMs); return }
        guard let locale = await firstJaLocale() else {
            onDone("error", "Japanese locale unavailable", fedThroughMs)
            return
        }
        // The model must be installed before the analyzer starts; fetch it
        // here too, so a job never fails just because JS thought it was there.
        do { try await atWithTimeout(120, "Speech model setup") { try await AutoTranscribePlugin.installAssets(locale: locale) } }
        catch {
            onDone("error", "Speech model unavailable: \(error.localizedDescription)", fedThroughMs)
            return
        }
        if cancelled { onDone(stopReason, nil, fedThroughMs); return }
        // Finalized results only — no volatile churn.
        let transcriber = AutoTranscribePlugin.makeTranscriber(locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        atLog("job \(id) model ready, analyzer created")

        let audioFile: AVAudioFile
        do {
            audioFile = try AVAudioFile(forReading: url)
        } catch {
            onDone("error", "Cannot open audio: \(error.localizedDescription)", fedThroughMs)
            return
        }
        let srcFormat = audioFile.processingFormat
        let sampleRate = srcFormat.sampleRate
        guard sampleRate > 0, audioFile.length > 0 else {
            onDone("error", "Empty or unreadable audio file", fedThroughMs)
            return
        }
        let startFrame = AVAudioFramePosition((baseMs / 1000.0) * sampleRate)
        if startFrame >= audioFile.length {
            onDone("eof", nil, fedThroughMs)
            return
        }
        audioFile.framePosition = max(0, startFrame)

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            onDone("error", "No compatible analyzer audio format", fedThroughMs)
            return
        }
        guard let converter = AVAudioConverter(from: srcFormat, to: analyzerFormat) else {
            onDone("error", "Audio format conversion unavailable", fedThroughMs)
            return
        }

        if cancelled { onDone(stopReason, nil, fedThroughMs); return }
        installAnalyzer(analyzer)
        // The analyzer requests each chunk. Never yield a whole hour into an
        // unbounded AsyncStream: stop would otherwise leave a large backlog.
        let inputSequence = AsyncStream<AnalyzerInput>(unfolding: { [self] in
            await nextInput(from: audioFile, converter: converter, format: analyzerFormat)
        })
        let powerTask = Task { [self] in
            while !Task.isCancelled && !cancelled {
                await checkPower()
                do { try await Task.sleep(nanoseconds: 5_000_000_000) }
                catch { break }
            }
        }

        // Results consumer — collects finalized phrases, segments them into
        // subtitle-sized cues, emits batches to JS.
        let resultsTask = Task { [self] in
            do {
                for try await result in transcriber.results {
                    if Task.isCancelled || cancelled { break }
                    guard result.isFinal else { continue }
                    let cues = segmentResult(result.text)
                    if !cues.isEmpty {
                        onCues(cues, fedThroughMs)
                    }
                }
            } catch {
                if !cancelled {
                    setFeedError("Speech results failed: \(error.localizedDescription)")
                    await analyzer.cancelAndFinishNow()
                }
            }
        }

        do {
            if !cancelled {
                try await analyzer.start(inputSequence: inputSequence)
                // Cancellation calls cancelAndFinishNow concurrently, so a
                // stop during this await discards pending analysis promptly.
                if !cancelled { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            }
        } catch {
            if !cancelled { setFeedError("Speech analysis failed: \(error.localizedDescription)") }
            await analyzer.cancelAndFinishNow()
        }
        atLog("job \(id) analysis ended, cancelled=\(cancelled) err=\(feedError ?? "-")")
        powerTask.cancel()
        await powerTask.value
        await cancellationTask()?.value
        if cancelled || feedError != nil { resultsTask.cancel() }
        _ = await resultsTask.result
        releaseAnalyzer()
        if cancelled { onDone(stopReason, nil, fedThroughMs) }
        else if let err = feedError { onDone("error", err, fedThroughMs) }
        else { onDone("eof", nil, fedThroughMs) }
    }

    // AsyncStream invokes this serially. Backpressure never drops audio or
    // changes the sequence-relative clock used by the word-timing parser.
    private func nextInput(from audioFile: AVAudioFile, converter: AVAudioConverter,
                           format: AVAudioFormat) async -> AnalyzerInput? {
        while !cancelled && feedError == nil {
            // EOF must terminate even when it lands exactly on the buffer
            // ceiling; otherwise a paused book never finalizes its last words.
            let remaining = audioFile.length - audioFile.framePosition
            if remaining <= 0 { return nil }
            let ahead = inputAheadMs
            if ahead > 0 && fedThroughMs >= targetMs + ahead {
                do { try await Task.sleep(nanoseconds: 500_000_000) }
                catch { return nil }
                continue
            }
            let sampleRate = audioFile.processingFormat.sampleRate
            let chunkFrames = AVAudioFrameCount(sampleRate * 4.0)
            let toRead = AVAudioFrameCount(min(AVAudioFramePosition(chunkFrames), remaining))
            guard let buf = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: toRead) else {
                setFeedError("Buffer allocation failed")
                return nil
            }
            do {
                try audioFile.read(into: buf, frameCount: toRead)
            } catch {
                setFeedError("Audio read failed: \(error.localizedDescription)")
                return nil
            }
            if buf.frameLength == 0 {
                // Short of the end this is a read stall, not EOF (it used to mark
                // the rest of the book as transcribed). JS restarts from here.
                if remaining > AVAudioFramePosition(sampleRate) {
                    setFeedError("Audio read stalled at \(Int(Double(audioFile.framePosition) / sampleRate * 1000)) ms")
                }
                return nil
            }
            guard let converted = Self.convert(buf, with: converter, to: format) else {
                setFeedError("Audio conversion failed")
                return nil
            }
            if cancelled { return nil }
            setFed(Double(audioFile.framePosition) / sampleRate * 1000.0)
            return AnalyzerInput(buffer: converted)
        }
        return nil
    }

    private func firstJaLocale() async -> Locale? {
        let locales = await SpeechTranscriber.supportedLocales
        return locales.first { $0.identifier(.bcp47).lowercased().hasPrefix("ja") }
    }

    // Convert one source chunk into the analyzer's format. One-shot input
    // block per call; the converter keeps resampler state across calls.
    private static func convert(_ input: AVAudioPCMBuffer,
                                with converter: AVAudioConverter,
                                to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var served = false
        var convError: NSError?
        let status = converter.convert(to: out, error: &convError) { _, outStatus in
            if served {
                outStatus.pointee = .noDataNow
                return nil
            }
            served = true
            outStatus.pointee = .haveData
            return input
        }
        if convError != nil || status == .error { return nil }
        return out
    }

    // Split one finalized phrase into subtitle-sized cues. Boundaries prefer
    // real speech gaps (audioTimeRange discontinuities), then sentence-ending
    // punctuation once a soft length is reached, with a hard length cap.
    // Runs without a time range (rare — punctuation-only) inherit the
    // running cue. All times are offset into ABSOLUTE file ms by baseMs
    // (the analyzer clock starts at 0 for the first fed buffer).
    //
    // Each cue also carries `w`: one [off, len, startMs, endMs] quad per
    // timed recognizer token, for word-level (karaoke) highlighting in JS.
    // Offsets are UTF-16 units (JS string indexing); a timeless run extends
    // the previous token's length so every char belongs to some token.
    private func segmentResult(_ attr: AttributedString) -> [[String: Any]] {
        var cues: [[String: Any]] = []
        var text = ""
        var startSec = -1.0
        var endSec = -1.0
        var words: [Int] = []   // flat quads, offsets in UTF-16 units into `text`

        func push() {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty && startSec >= 0 && endSec > startSec {
                let s = baseMs + startSec * 1000.0
                let e = baseMs + max(endSec * 1000.0, startSec * 1000.0 + 300.0)
                var cue: [String: Any] = ["startMs": Int(s.rounded()), "endMs": Int(e.rounded()), "text": t]
                // Adjust token offsets for the leading trim, clamp to the
                // trimmed length, and drop tokens that vanished entirely.
                if !words.isEmpty {
                    let lead = text.utf16.count - String(text.drop(while: { $0.isWhitespace || $0.isNewline })).utf16.count
                    let tLen = t.utf16.count
                    var adjusted: [Int] = []
                    var q = 0
                    while q + 3 < words.count {
                        var off = words[q] - lead
                        var len = words[q + 1]
                        if off < 0 { len += off; off = 0 }
                        if off < tLen && len > 0 {
                            adjusted.append(contentsOf: [off, min(len, tLen - off), words[q + 2], words[q + 3]])
                        }
                        q += 4
                    }
                    if !adjusted.isEmpty { cue["w"] = adjusted }
                }
                cues.append(cue)
            }
            text = ""; startSec = -1; endSec = -1; words = []
        }

        for run in attr.runs {
            let piece = String(attr.characters[run.range])
            if piece.isEmpty { continue }
            let range = run.audioTimeRange
            if let r = range {
                let rs = r.start.seconds
                let re = r.end.seconds
                if !text.isEmpty {
                    let gap = endSec >= 0 ? rs - endSec : 0
                    let lastCh = text.last
                    let shouldSplit =
                        gap > Self.gapSplitSec ||
                        text.count >= Self.hardMaxChars ||
                        (text.count >= Self.softMaxChars && lastCh != nil && Self.sentenceEnders.contains(lastCh!))
                    if shouldSplit { push() }
                }
                if startSec < 0 { startSec = rs }
                words.append(contentsOf: [
                    text.utf16.count, piece.utf16.count,
                    Int((baseMs + rs * 1000.0).rounded()), Int((baseMs + re * 1000.0).rounded())
                ])
                text += piece
                endSec = max(endSec, re)
            } else {
                // Timeless run (punctuation attached by the model) — append to
                // the current cue so characters are never dropped, and extend
                // the previous token over it so `w` stays gap-free.
                if !text.isEmpty {
                    if words.count >= 4 { words[words.count - 3] += piece.utf16.count }
                    text += piece
                }
            }
        }
        push()
        return cues
    }
}
