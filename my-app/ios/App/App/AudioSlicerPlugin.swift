import Foundation
import Capacitor
import AVFoundation

/**
 * AudioSlicerPlugin — iOS port of the Android AudioSlicerPlugin.
 *
 * Two operations, both matching the Android plugin's JS contract:
 *
 *   slice({srcPath, startMs, endMs})
 *     → { path, sizeBytes, mime }
 *     Produces a short audio file containing [startMs, endMs] of the
 *     source. Uses AVAssetExportSession with the AppleM4A preset which
 *     transcodes to AAC in an MP4 container. Fast on Apple Silicon
 *     (hardware-accelerated AAC encoder) and AnkiMobile accepts .m4a
 *     for [sound:...] fields without complaint.
 *
 *   getWaveform({srcPath, startMs, endMs, samples})
 *     → { samples: float[] }
 *     Decodes PCM in the requested range via AVAssetReader, downsamples
 *     to N peak-amplitude buckets in [0, 1]. The waveform editor's
 *     bucket count is typically 200.
 *
 * Architectural notes vs. Android:
 *   - No MP3-vs-AAC branching needed. iOS AVFoundation reads both, and
 *     we always emit AAC/m4a — sidesteps the MediaMuxer-can't-write-MP3
 *     problem the Android plugin had to work around with raw frame copy.
 *   - Capacitor's getInt has the same JSON-number quirk as Android, so
 *     numeric params come through getDouble.
 */
@objc(AudioSlicerPlugin)
public class AudioSlicerPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "AudioSlicerPlugin"
    public let jsName = "AudioSlicer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "slice",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWaveform", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - slice

    @objc func slice(_ call: CAPPluginCall) {
        guard let srcPath = call.getString("srcPath"), !srcPath.isEmpty else {
            call.reject("srcPath required")
            return
        }
        let startMs = call.getDouble("startMs") ?? 0
        let endMs   = call.getDouble("endMs")   ?? 0
        guard endMs > startMs else {
            call.reject("endMs must be > startMs")
            return
        }

        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        let asset = AVURLAsset(url: url)

        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let outURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("slice_\(stamp).m4a")
        try? FileManager.default.removeItem(at: outURL)

        guard let exporter = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetAppleM4A
        ) else {
            call.reject("AVAssetExportSession could not be created (asset unsupported?)")
            return
        }
        exporter.outputURL = outURL
        exporter.outputFileType = .m4a
        // High-precision timescale so cue boundaries don't drift on
        // shorter clips. 1 ms granularity is plenty.
        let startTime = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)
        let duration  = CMTime(seconds: (endMs - startMs) / 1000.0, preferredTimescale: 1000)
        exporter.timeRange = CMTimeRange(start: startTime, duration: duration)

        exporter.exportAsynchronously {
            DispatchQueue.main.async { [weak self] in
                guard self != nil else { return }
                switch exporter.status {
                case .completed:
                    let attrs = try? FileManager.default.attributesOfItem(atPath: outURL.path)
                    let size = (attrs?[.size] as? Int) ?? 0
                    NSLog("[AudioSlicer] slice OK: \(outURL.lastPathComponent) bytes=\(size)")
                    call.resolve([
                        "path":      outURL.path,
                        "sizeBytes": size,
                        "mime":      "audio/mp4"
                    ])
                case .failed:
                    let msg = exporter.error?.localizedDescription ?? "unknown"
                    NSLog("[AudioSlicer] slice failed: \(msg)")
                    call.reject("slice failed: \(msg)")
                case .cancelled:
                    call.reject("slice cancelled")
                default:
                    call.reject("slice ended in unexpected state: \(exporter.status.rawValue)")
                }
            }
        }
    }

    // MARK: - getWaveform

    @objc func getWaveform(_ call: CAPPluginCall) {
        guard let srcPath = call.getString("srcPath"), !srcPath.isEmpty else {
            call.reject("srcPath required")
            return
        }
        let startMs = call.getDouble("startMs") ?? 0
        let endMs   = call.getDouble("endMs")   ?? 0
        let bucketCount = call.getInt("samples") ?? 200
        guard endMs > startMs else {
            call.reject("endMs must be > startMs")
            return
        }
        guard bucketCount > 0 else {
            call.reject("samples must be > 0")
            return
        }

        let url = URL(fileURLWithPath: stripFileScheme(srcPath))
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else {
            call.reject("no audio track in source")
            return
        }

        // Decode in the background — for a 30 s clip at 22 kHz this is ~10 ms
        // on M-series and ~50 ms on older iPhones. Either way too long to
        // run on the main thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let buckets = try self.decodePeaks(
                    asset: asset, track: track,
                    startMs: startMs, endMs: endMs,
                    bucketCount: bucketCount
                )
                let nonZero = buckets.filter { $0 > 0 }.count
                let peak = buckets.max() ?? 0
                NSLog("[AudioSlicer] decoded: \(nonZero)/\(bucketCount) non-zero buckets, peak=\(peak)")
                DispatchQueue.main.async {
                    call.resolve(["samples": buckets])
                }
            } catch {
                DispatchQueue.main.async {
                    NSLog("[AudioSlicer] getWaveform failed: \(error.localizedDescription)")
                    call.reject("getWaveform failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Read PCM in the time range, downsample to peak-amplitude buckets
    /// in [0, 1]. Handles mono or stereo (interleaved); we just walk every
    /// Int16 sample regardless of channel layout.
    private func decodePeaks(
        asset: AVAsset, track: AVAssetTrack,
        startMs: Double, endMs: Double, bucketCount: Int
    ) throws -> [Float] {
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start:    CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000),
            duration: CMTime(seconds: (endMs - startMs) / 1000.0, preferredTimescale: 1000)
        )

        let outputSettings: [String: Any] = [
            AVFormatIDKey:             NSNumber(value: kAudioFormatLinearPCM),
            AVLinearPCMBitDepthKey:    16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey:     false,
            AVLinearPCMIsNonInterleaved: false
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: track, outputSettings: outputSettings)
        trackOutput.alwaysCopiesSampleData = false
        reader.add(trackOutput)

        guard reader.startReading() else {
            throw NSError(domain: "AudioSlicer", code: 1, userInfo: [
                NSLocalizedDescriptionKey: reader.error?.localizedDescription ?? "AVAssetReader.startReading returned false"
            ])
        }

        var allSamples = [Int16]()
        // Reserve a reasonable amount up front to avoid reallocation thrash.
        // Estimate: (endMs-startMs)/1000 * 22050 * 2 channels.
        let approxSamples = Int(((endMs - startMs) / 1000.0) * 22050 * 2)
        allSamples.reserveCapacity(approxSamples)

        while let sampleBuffer = trackOutput.copyNextSampleBuffer() {
            if let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) {
                var length = 0
                var dataPointer: UnsafeMutablePointer<Int8>? = nil
                CMBlockBufferGetDataPointer(
                    blockBuffer, atOffset: 0,
                    lengthAtOffsetOut: nil, totalLengthOut: &length,
                    dataPointerOut: &dataPointer
                )
                if let dp = dataPointer, length > 0 {
                    let int16Count = length / 2
                    dp.withMemoryRebound(to: Int16.self, capacity: int16Count) { p in
                        for i in 0..<int16Count {
                            allSamples.append(p[i])
                        }
                    }
                }
            }
            CMSampleBufferInvalidate(sampleBuffer)
        }
        if reader.status == .failed {
            throw NSError(domain: "AudioSlicer", code: 2, userInfo: [
                NSLocalizedDescriptionKey: reader.error?.localizedDescription ?? "read failed mid-stream"
            ])
        }

        var buckets = [Float](repeating: 0, count: bucketCount)
        guard !allSamples.isEmpty else { return buckets }
        // Floor-of-float to avoid an empty last bucket on small inputs.
        let bucketSize = max(1, allSamples.count / bucketCount)
        for b in 0..<bucketCount {
            let start = b * bucketSize
            let end = min(allSamples.count, start + bucketSize)
            if start >= end { continue }
            var peakAbs: Int32 = 0
            for i in start..<end {
                // Cast to Int32 before abs so INT16_MIN doesn't overflow.
                let v = Int32(allSamples[i])
                let a = v < 0 ? -v : v
                if a > peakAbs { peakAbs = a }
            }
            buckets[b] = Float(peakAbs) / 32768.0
        }
        return buckets
    }

    // MARK: - util

    private func stripFileScheme(_ s: String) -> String {
        return s.hasPrefix("file://") ? String(s.dropFirst(7)) : s
    }
}
