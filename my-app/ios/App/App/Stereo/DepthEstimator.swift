// Ported from GridPlayer (see /player), extended for Kadoki: the depth model
// is selectable — Depth Anything V2 Small (Apple CoreML, 518×392, grayscale
// image output) or Depth Anything 3 Base (community CoreML 504×504, Float16
// multiarray output; ~3× the weights, visibly finer depth). visionOS-only.
#if os(visionOS)
import CoreML
import CoreVideo
import Foundation
import Vision

/// Monocular depth estimation. Output is relative inverse depth (bigger =
/// nearer) as a width×height 16-bit float grayscale pixel buffer.
final class DepthEstimator: @unchecked Sendable {
    static let modelWidth = 518    // V2-small defaults (kept for callers)
    static let modelHeight = 392

    /// The active model's raster size — StereoRenderer sizes its depth
    /// textures from these.
    let width: Int
    let height: Int
    /// DA3 predicts DEPTH (bigger = farther); V2 predicts disparity (bigger =
    /// nearer, which is what the warp expects). Negate DA3's values so the
    /// downstream normalization sees a consistent convention. (Measured on a
    /// test photo: V2↔DA3 correlation −0.82 before inversion.)
    let invertOutput: Bool

    private let model: VNCoreMLModel
    private let queue = DispatchQueue(label: "GridPlayer.depth", qos: .userInitiated)

    enum Error: Swift.Error { case modelMissing, noResult }

    init(modelURL: URL? = nil, width: Int = DepthEstimator.modelWidth, height: Int = DepthEstimator.modelHeight, invertOutput: Bool = false) throws {
        let url = modelURL ?? Bundle.main.url(forResource: "DepthAnythingV2SmallF16", withExtension: "mlmodelc")
        guard let url else { throw Error.modelMissing }
        let config = MLModelConfiguration()
        config.computeUnits = .all   // Neural Engine when available
        model = try VNCoreMLModel(for: MLModel(contentsOf: url, configuration: config))
        self.width = width
        self.height = height
        self.invertOutput = invertOutput
    }

    /// kind: "base" = Depth Anything 3 Base (504×504), anything else = V2 Small.
    convenience init(kind: String) throws {
        if kind == "base",
           let url = Bundle.main.url(forResource: "DepthAnythingV3_base_504", withExtension: "mlmodelc") {
            try self.init(modelURL: url, width: 504, height: 504, invertOutput: true)
        } else {
            try self.init()
        }
    }

    func estimate(_ pixelBuffer: CVPixelBuffer) async throws -> CVPixelBuffer {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                let request = VNCoreMLRequest(model: self.model)
                request.imageCropAndScaleOption = .scaleFill
                let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
                do {
                    try handler.perform([request])
                    // V2 Small: grayscale image output → Vision hands back a
                    // pixel buffer directly.
                    if let observation = request.results?.first as? VNPixelBufferObservation {
                        continuation.resume(returning: observation.pixelBuffer)
                        return
                    }
                    // DA3 Base: MultiArray outputs (depth + confidence) →
                    // repack the fp16 "depth" array as a OneComponent16Half
                    // pixel buffer so the downstream Metal path is unchanged.
                    if let fv = (request.results as? [VNCoreMLFeatureValueObservation])?
                        .first(where: { $0.featureName == "depth" }),
                       let arr = fv.featureValue.multiArrayValue,
                       let pb = self.pixelBuffer(fromFloat16: arr) {
                        continuation.resume(returning: pb)
                        return
                    }
                    throw Error.noResult
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// [1, H, W] Float16 MLMultiArray → OneComponent16Half CVPixelBuffer.
    /// STRIDE-AWARE: converted models pad rows (DA3 base: row stride 512 for
    /// width 504) — assuming contiguous rows skews every row and reads as
    /// diagonal "waves" in the stereo warp. Honors invertOutput (negation
    /// flips the depth ordering; the renderer's min/max normalization adapts).
    private func pixelBuffer(fromFloat16 arr: MLMultiArray) -> CVPixelBuffer? {
        guard arr.dataType == .float16, arr.count >= width * height else { return nil }
        let nd = arr.strides.count
        let sRow = nd >= 2 ? arr.strides[nd - 2].intValue : width
        let sCol = nd >= 1 ? arr.strides[nd - 1].intValue : 1
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                            kCVPixelFormatType_OneComponent16Half, nil, &pb)
        guard let out = pb else { return nil }
        CVPixelBufferLockBaseAddress(out, [])
        defer { CVPixelBufferUnlockBaseAddress(out, []) }
        guard let dstBase = CVPixelBufferGetBaseAddress(out) else { return nil }
        let dstBPR = CVPixelBufferGetBytesPerRow(out)
        let invert = invertOutput
        arr.withUnsafeBytes { src in
            guard let base = src.baseAddress else { return }
            let s = base.assumingMemoryBound(to: Float16.self)
            for row in 0..<height {
                let dst = (dstBase + row * dstBPR).assumingMemoryBound(to: Float16.self)
                let srcRow = row * sRow
                if sCol == 1 && !invert {
                    memcpy(dst, s + srcRow, width * MemoryLayout<Float16>.size)
                } else {
                    for col in 0..<width {
                        let v = s[srcRow + col * sCol]
                        dst[col] = invert ? -v : v
                    }
                }
            }
        }
        return out
    }
}

#endif
