import Foundation
import Capacitor
import AVFoundation
import Speech

/**
 * AutoTranscribePlugin — on-device subtitle generation for audio-only titles.
 *
 * Wraps iOS 26's SpeechAnalyzer/SpeechTranscriber (Neural Engine, ja_JP) to
 * transcribe a local audiobook file into SRT-style cues, streamed to JS as
 * they finalize. The JS orchestrator (auto-transcribe.js) owns pacing policy,
 * cue caching, and the "write a real .srt on completion" step; this plugin
 * only knows how to run ONE feed-paced transcription job at a time.
 *
 *   checkAvailability()            → { supported, installed }
 *   ensureAssets()                 → { installed }   (emits "assetProgress" {fraction})
 *   start({jobId, srcPath, startMs, targetMs, aheadMs})
 *                                  → { started, durationMs }
 *   setTarget({jobId, targetMs})   → {}   (playhead update for pacing)
 *   stop({jobId})                  → {}
 *
 * Events:
 *   "cues" { jobId, cues: [{startMs, endMs, text, w}], fedThroughMs }
 *          w = flat word-timing array [off, len, startMs, endMs, ...] — one
 *          quad per recognizer token, offsets/lengths in UTF-16 units into
 *          `text`, times ABSOLUTE file ms (JS rebases them cue-relative)
 *   "done" { jobId, reason: "eof" | "stopped" | "error", error?, fedThroughMs }
 *
 * Pacing: the feed loop stops yielding buffers while
 * fedThroughMs > targetMs + aheadMs, polling once a second. A backfill job
 * (region behind the playhead) therefore runs at full speed automatically —
 * its frontier is below target — and a lookahead job idles once it is
 * aheadMs ahead. aheadMs <= 0 disables pacing entirely.
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

    private static let localeId = "ja_JP"

    // MARK: - availability

    @objc func checkAvailability(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            Task {
                let supported = await Self.findSupportedLocale() != nil
                var installed = false
                if supported {
                    let inst = await SpeechTranscriber.installedLocales
                    installed = inst.contains { Self.isJa($0) }
                }
                call.resolve(["supported": supported, "installed": installed])
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
            let transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: [.audioTimeRange]
            )
            do {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    let progress = request.progress
                    let poller = Task { [weak self] in
                        while !Task.isCancelled {
                            self?.notifyListeners("assetProgress", data: ["fraction": progress.fractionCompleted])
                            try? await Task.sleep(nanoseconds: 500_000_000)
                        }
                    }
                    defer { poller.cancel() }
                    try await request.downloadAndInstall()
                }
                self.notifyListeners("assetProgress", data: ["fraction": 1.0])
                call.resolve(["installed": true])
            } catch {
                NSLog("[AutoTranscribe] asset install failed: \(error.localizedDescription)")
                call.reject("Speech model download failed: \(error.localizedDescription)")
            }
        }
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

        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("Audio file not found: \(url.path)")
            return
        }

        // One job at a time — replace any running job.
        stopCurrentJob()

        let job = TranscribeJob(
            id: jobId, url: url, baseMs: max(0, startMs), aheadMs: aheadMs,
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
        jobBox = job
        jobLock.unlock()
        job.begin()

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
        clearJob(job: job, ifId: job.id)
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
                NSLog("[AutoTranscribe] getChapters failed: \(error.localizedDescription)")
            }
            call.resolve(["chapters": chapters])
        }
    }
}

// MARK: - TranscribeJob

@available(iOS 26.0, *)
final class TranscribeJob: @unchecked Sendable {

    let id: String
    private let url: URL
    private let baseMs: Double
    private let aheadMs: Double
    private let onCues: ([[String: Any]], Double) -> Void
    private let onDone: (String, String?, Double) -> Void

    private let stateLock = NSLock()
    private var _targetMs: Double = 0
    private var _cancelled = false
    private var _fedThroughMs: Double = 0

    private var task: Task<Void, Never>?

    // Cue segmentation tuning (Japanese subtitle conventions: short lines,
    // splits preferred at speech gaps or sentence punctuation).
    private static let gapSplitSec = 0.75
    private static let softMaxChars = 42
    private static let hardMaxChars = 84
    private static let sentenceEnders: Set<Character> = ["。", "！", "？", "!", "?", "…", "」", "』"]

    init(id: String, url: URL, baseMs: Double, aheadMs: Double,
         onCues: @escaping ([[String: Any]], Double) -> Void,
         onDone: @escaping (String, String?, Double) -> Void) {
        self.id = id
        self.url = url
        self.baseMs = baseMs
        self.aheadMs = aheadMs
        self.onCues = onCues
        self.onDone = onDone
    }

    func setTarget(_ ms: Double) {
        stateLock.lock(); _targetMs = ms; stateLock.unlock()
    }
    private var targetMs: Double {
        stateLock.lock(); defer { stateLock.unlock() }; return _targetMs
    }
    func cancel() {
        stateLock.lock(); _cancelled = true; stateLock.unlock()
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

    func begin() {
        task = Task.detached(priority: .utility) { [self] in
            await run()
        }
    }

    private func run() async {
        setFed(baseMs)
        guard let locale = await firstJaLocale() else {
            onDone("error", "Japanese locale unavailable", fedThroughMs)
            return
        }
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],          // finalized results only — no volatile churn
            attributeOptions: [.audioTimeRange]
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])

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

        let (inputSequence, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)

        // Results consumer — collects finalized phrases, segments them into
        // subtitle-sized cues, emits batches to JS.
        let resultsTask = Task { [self] in
            do {
                for try await result in transcriber.results {
                    if Task.isCancelled { break }
                    guard result.isFinal else { continue }
                    let cues = segmentResult(result.text)
                    if !cues.isEmpty {
                        onCues(cues, fedThroughMs)
                    }
                }
            } catch {
                NSLog("[AutoTranscribe] results stream error: \(error.localizedDescription)")
            }
        }

        do {
            try await analyzer.start(inputSequence: inputSequence)
        } catch {
            inputBuilder.finish()
            resultsTask.cancel()
            onDone("error", "Analyzer start failed: \(error.localizedDescription)", fedThroughMs)
            return
        }

        // Feed loop — 4 s source chunks, paced against the playhead target.
        let chunkFrames = AVAudioFrameCount(sampleRate * 4.0)
        var fedSourceFrames: AVAudioFramePosition = 0
        var feedError: String? = nil

        while !cancelled {
            if aheadMs > 0 && fedThroughMs > targetMs + aheadMs {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                continue
            }
            let remaining = audioFile.length - audioFile.framePosition
            if remaining <= 0 { break }
            let toRead = AVAudioFrameCount(min(AVAudioFramePosition(chunkFrames), remaining))
            guard let buf = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: toRead) else {
                feedError = "Buffer allocation failed"
                break
            }
            do {
                try audioFile.read(into: buf, frameCount: toRead)
            } catch {
                feedError = "Audio read failed: \(error.localizedDescription)"
                break
            }
            if buf.frameLength == 0 { break }
            guard let converted = Self.convert(buf, with: converter, to: analyzerFormat) else {
                feedError = "Audio conversion failed"
                break
            }
            inputBuilder.yield(AnalyzerInput(buffer: converted))
            fedSourceFrames += AVAudioFramePosition(buf.frameLength)
            setFed(baseMs + Double(fedSourceFrames) / sampleRate * 1000.0)
        }

        inputBuilder.finish()
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            NSLog("[AutoTranscribe] finalize error: \(error.localizedDescription)")
        }
        _ = await resultsTask.result

        if let err = feedError {
            onDone("error", err, fedThroughMs)
        } else if cancelled {
            onDone("stopped", nil, fedThroughMs)
        } else {
            onDone("eof", nil, fedThroughMs)
        }
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
