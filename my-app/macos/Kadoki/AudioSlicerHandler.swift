import AVFoundation
import Foundation
import WebKit

/// Port of the iOS AudioSlicerPlugin (slice + getWaveform) as a script message
/// handler. Contract matches the iOS plugin exactly so the JS layer needs no
/// changes:
///   slice({srcPath, startMs, endMs})            → {path, sizeBytes, mime:"audio/mp4"}
///   getWaveform({srcPath, startMs, endMs, samples}) → {samples: [0..1 floats]}
final class AudioSlicerHandler: NSObject, WKScriptMessageHandlerWithReply {

    /// VBR MP3s have no frame index; without precise timing AVFoundation seeks
    /// by average-bitrate estimation and lands minutes off on long audiobooks.
    /// The precise scan is expensive → single-entry cache keyed by path (the
    /// live waveform re-calls getWaveform on the same file every ~10-20 s).
    private static var cachedAsset: AVURLAsset?
    private static var cachedPath: String?
    private static let cacheLock = NSLock()

    private static func preciseAsset(for url: URL) -> AVURLAsset {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let a = cachedAsset, cachedPath == url.path { return a }
        let a = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        cachedAsset = a
        cachedPath = url.path
        return a
    }

    private static func stripFileScheme(_ p: String) -> String {
        p.hasPrefix("file://") ? String(p.dropFirst(7)) : p
    }

    /// Slices are written under the media root so the scheme handler can serve
    /// them back to the web layer (cacheFileToDataUri fetches convertFileSrc).
    private var sliceDir: URL {
        let d = FileStoreHandler.shared.mediaRoot.appendingPathComponent("slices", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
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
        case "slice":       slice(req, reply)
        case "getWaveform": getWaveform(req, reply)
        default:            reply(nil, "unknown op \(op)")
        }
    }

    // MARK: - slice

    private func slice(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let rawPath = req["srcPath"] as? String, !rawPath.isEmpty else {
            reply(nil, "srcPath required"); return
        }
        let startMs = (req["startMs"] as? Double) ?? 0
        let endMs = (req["endMs"] as? Double) ?? 0
        guard endMs > startMs else { reply(nil, "endMs must be > startMs"); return }

        let srcURL = URL(fileURLWithPath: Self.stripFileScheme(rawPath))
        let outURL = sliceDir.appendingPathComponent("slice_\(Int(Date().timeIntervalSince1970 * 1000)).m4a")
        try? FileManager.default.removeItem(at: outURL)

        let asset = Self.preciseAsset(for: srcURL)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            reply(nil, "AVAssetExportSession could not be created (asset unsupported?)"); return
        }
        exporter.outputURL = outURL
        exporter.outputFileType = .m4a
        let start = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)
        let duration = CMTime(seconds: (endMs - startMs) / 1000.0, preferredTimescale: 1000)
        exporter.timeRange = CMTimeRange(start: start, duration: duration)
        exporter.exportAsynchronously {
            switch exporter.status {
            case .completed:
                let size = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
                reply(["path": outURL.path, "sizeBytes": size ?? 0, "mime": "audio/mp4"], nil)
            case .failed:
                reply(nil, "slice failed: \(exporter.error?.localizedDescription ?? "unknown")")
            case .cancelled:
                reply(nil, "slice cancelled")
            default:
                reply(nil, "slice ended in unexpected state: \(exporter.status.rawValue)")
            }
        }
    }

    // MARK: - getWaveform

    private func getWaveform(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let rawPath = req["srcPath"] as? String, !rawPath.isEmpty else {
            reply(nil, "srcPath required"); return
        }
        let startMs = (req["startMs"] as? Double) ?? 0
        let endMs = (req["endMs"] as? Double) ?? 0
        guard endMs > startMs else { reply(nil, "endMs must be > startMs"); return }
        let bucketCount = (req["samples"] as? Int) ?? Int((req["samples"] as? Double) ?? 200)
        guard bucketCount > 0 else { reply(nil, "samples must be > 0"); return }

        let srcURL = URL(fileURLWithPath: Self.stripFileScheme(rawPath))
        DispatchQueue.global(qos: .userInitiated).async {
            let asset = Self.preciseAsset(for: srcURL)
            guard let track = asset.tracks(withMediaType: .audio).first else {
                reply(nil, "no audio track in source"); return
            }
            do {
                let reader = try AVAssetReader(asset: asset)
                let start = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)
                let duration = CMTime(seconds: (endMs - startMs) / 1000.0, preferredTimescale: 1000)
                reader.timeRange = CMTimeRange(start: start, duration: duration)
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsBigEndianKey: false,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsNonInterleaved: false,
                ])
                output.alwaysCopiesSampleData = false
                reader.add(output)
                guard reader.startReading() else {
                    reply(nil, "getWaveform failed: \(reader.error?.localizedDescription ?? "cannot start reader")")
                    return
                }
                var allSamples: [Int16] = []
                while let sample = output.copyNextSampleBuffer() {
                    guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
                    let length = CMBlockBufferGetDataLength(block)
                    var bytes = [UInt8](repeating: 0, count: length)
                    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes)
                    bytes.withUnsafeBytes { raw in
                        allSamples.append(contentsOf: raw.bindMemory(to: Int16.self))
                    }
                }
                if reader.status == .failed {
                    reply(nil, "getWaveform failed: \(reader.error?.localizedDescription ?? "unknown")")
                    return
                }
                var buckets = [Float](repeating: 0, count: bucketCount)
                if !allSamples.isEmpty {
                    let bucketSize = max(1, allSamples.count / bucketCount)
                    for b in 0..<bucketCount {
                        let lo = b * bucketSize
                        let hi = min(allSamples.count, lo + bucketSize)
                        guard lo < hi else { break }
                        var peak: Int32 = 0
                        for i in lo..<hi {
                            let v = abs(Int32(allSamples[i]))   // Int32 first: abs(INT16_MIN) overflows
                            if v > peak { peak = v }
                        }
                        buckets[b] = Float(peak) / 32768.0
                    }
                }
                reply(["samples": buckets], nil)
            } catch {
                reply(nil, "getWaveform failed: \(error.localizedDescription)")
            }
        }
    }
}
