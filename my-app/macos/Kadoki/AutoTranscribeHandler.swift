import Foundation
import AVFoundation
import Speech
import WebKit

/**
 * AutoTranscribeHandler — macOS port of the iOS AutoTranscribePlugin.
 *
 * Wraps SpeechAnalyzer/SpeechTranscriber (macOS 26, on-device, ja) to
 * transcribe a local audiobook file into SRT-style cues, streamed to JS as
 * they finalize. The JS orchestrator (auto-transcribe.js) owns pacing policy,
 * cue caching, and the "write a real .srt on completion" step; this handler
 * only knows how to run ONE feed-paced transcription job at a time.
 *
 * Contract matches the iOS plugin exactly (see AutoTranscribePlugin.swift):
 *   checkAvailability / ensureAssets / start / setTarget / stop / getChapters
 * Events pushed via KadokiEvents as plugin "AutoTranscribe":
 *   "cues" { jobId, cues, fedThroughMs }, "done" { jobId, reason, error?,
 *   fedThroughMs }, "assetProgress" { fraction }
 */
final class AutoTranscribeHandler: NSObject, WKScriptMessageHandlerWithReply {

    private var jobBox: AnyObject?
    private let jobLock = NSLock()

    private func notify(_ event: String, _ data: [String: Any]) {
        KadokiEvents.push?("AutoTranscribe", event, data)
    }

    private static func dnum(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = req["op"] as? String else {
            replyHandler(nil, "bad request")
            return
        }
        let reply: (Any?, String?) -> Void = { value, err in
            DispatchQueue.main.async { replyHandler(value, err) }
        }
        switch op {
        case "checkAvailability": checkAvailability(reply)
        case "ensureAssets":      ensureAssets(reply)
        case "start":             start(req, reply)
        case "setTarget":         setTarget(req, reply)
        case "stop":              stop(req, reply)
        case "getChapters":       getChapters(req, reply)
        default:                  reply(nil, "unknown op \(op)")
        }
    }

    // MARK: - availability

    private func checkAvailability(_ reply: @escaping (Any?, String?) -> Void) {
        if #available(macOS 26.0, *) {
            Task {
                let supported = await Self.findSupportedLocale() != nil
                var installed = false
                if supported {
                    let inst = await SpeechTranscriber.installedLocales
                    installed = inst.contains { Self.isJa($0) }
                }
                reply(["supported": supported, "installed": installed], nil)
            }
        } else {
            reply(["supported": false, "installed": false], nil)
        }
    }

    @available(macOS 26.0, *)
    private static func isJa(_ l: Locale) -> Bool {
        return l.identifier(.bcp47).lowercased().hasPrefix("ja")
    }

    @available(macOS 26.0, *)
    private static func findSupportedLocale() async -> Locale? {
        let locales = await SpeechTranscriber.supportedLocales
        return locales.first { isJa($0) }
    }

    // MARK: - assets

    private func ensureAssets(_ reply: @escaping (Any?, String?) -> Void) {
        guard #available(macOS 26.0, *) else {
            reply(nil, "Requires macOS 26 or later")
            return
        }
        Task {
            guard let locale = await Self.findSupportedLocale() else {
                reply(nil, "Japanese transcription is not supported on this device")
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
                            self?.notify("assetProgress", ["fraction": progress.fractionCompleted])
                            try? await Task.sleep(nanoseconds: 500_000_000)
                        }
                    }
                    defer { poller.cancel() }
                    try await request.downloadAndInstall()
                }
                self.notify("assetProgress", ["fraction": 1.0])
                reply(["installed": true], nil)
            } catch {
                NSLog("[AutoTranscribe] asset install failed: \(error.localizedDescription)")
                reply(nil, "Speech model download failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - job control

    private func start(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard #available(macOS 26.0, *) else {
            reply(nil, "Requires macOS 26 or later")
            return
        }
        guard let jobId = req["jobId"] as? String, !jobId.isEmpty,
              let srcPath = req["srcPath"] as? String, !srcPath.isEmpty else {
            reply(nil, "jobId and srcPath required")
            return
        }
        let startMs = Self.dnum(req["startMs"]) ?? 0
        let targetMs = Self.dnum(req["targetMs"]) ?? startMs
        let aheadMs = Self.dnum(req["aheadMs"]) ?? 600_000

        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            reply(nil, "Audio file not found: \(url.path)")
            return
        }

        // One job at a time — replace any running job.
        stopCurrentJob()

        let job = MacTranscribeJob(
            id: jobId, url: url, baseMs: max(0, startMs), aheadMs: aheadMs,
            onCues: { [weak self] cues, fedMs in
                self?.notify("cues", ["jobId": jobId, "cues": cues, "fedThroughMs": fedMs])
            },
            onDone: { [weak self] reason, errMsg, fedMs in
                self?.clearJob(ifId: jobId)
                var data: [String: Any] = ["jobId": jobId, "reason": reason, "fedThroughMs": fedMs]
                if let e = errMsg { data["error"] = e }
                self?.notify("done", data)
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

        reply(["started": true, "durationMs": durationMs], nil)
    }

    private func setTarget(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard #available(macOS 26.0, *) else { reply([:], nil); return }
        let targetMs = Self.dnum(req["targetMs"]) ?? 0
        let jobId = req["jobId"] as? String
        jobLock.lock()
        let job = jobBox as? MacTranscribeJob
        jobLock.unlock()
        if let job = job, jobId == nil || job.id == jobId {
            job.setTarget(targetMs)
        }
        reply([:], nil)
    }

    private func stop(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        stopCurrentJob(onlyId: req["jobId"] as? String)
        reply([:], nil)
    }

    private func stopCurrentJob(onlyId: String? = nil) {
        guard #available(macOS 26.0, *) else { return }
        jobLock.lock()
        let job = jobBox as? MacTranscribeJob
        jobLock.unlock()
        guard let job = job else { return }
        if let only = onlyId, job.id != only { return }
        job.cancel()
        clearJob(ifId: job.id)
    }

    private func clearJob(ifId: String) {
        guard #available(macOS 26.0, *) else { return }
        jobLock.lock()
        if let current = jobBox as? MacTranscribeJob, current.id == ifId {
            jobBox = nil
        }
        jobLock.unlock()
    }

    private func stripFileScheme(_ s: String) -> String {
        return s.hasPrefix("file://") ? String(s.dropFirst(7)) : s
    }

    // MARK: - embedded chapter markers (m4b / m4a)

    private func getChapters(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let srcPath = req["srcPath"] as? String, !srcPath.isEmpty else {
            reply(nil, "srcPath required")
            return
        }
        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            reply(nil, "Audio file not found: \(url.path)")
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
            reply(["chapters": chapters], nil)
        }
    }
}

// MARK: - MacTranscribeJob (verbatim port of the iOS TranscribeJob)

@available(macOS 26.0, *)
final class MacTranscribeJob: @unchecked Sendable {

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
