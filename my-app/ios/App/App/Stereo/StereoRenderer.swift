// Ported from GridPlayer (see /player). visionOS-only: the AI-3D video
// pipeline (Depth Anything V2 -> Metal warp -> per-eye RealityKit texture).
#if os(visionOS)
import AVFoundation
import CoreVideo
import Metal
#if canImport(MetalFX)
import MetalFX
#endif
import Observation
import RealityKit

/// Turns a flat video into a stereo pair in real time: pulls frames from the player,
/// estimates depth on a background queue, and warps each frame into left/right eye
/// textures that a RealityKit material shows to the matching eye.
@Observable
@MainActor
final class StereoRenderer {
    /// A single texture with both eyes packed side-by-side (left in the left half, right in
    /// the right half). One texture + one drawable queue means the two eyes can never come
    /// from different frames — the dual-queue design desynced and shimmered.
    private(set) var packedTexture: TextureResource?
    @ObservationIgnored var loggedFirstFrame = false   // Kadoki diagnostic
    /// Width / height of one eye, for letterboxing the plane.
    private(set) var aspectRatio: CGFloat?
    private(set) var lastError: String?

    /// Size of the hosting view in points; drives the plane layout (set by the view).
    var viewSize: CGSize = .zero

    /// Mono mode shows the same (optionally upscaled) frame to both eyes and skips depth
    /// estimation entirely — used when a 2D tile only wants upscaling.
    var isMono = false

    /// How the source frame packs its eyes (side-by-side / top-bottom for VR stereo).
    var eyeLayout: VideoFormat.EyeLayout = .mono {
        didSet { if eyeLayout != oldValue { outputSize = (0, 0) } }
    }
    /// True while this video is shown in the immersive dome: each eye gets its own half
    /// of the frame and no depth warp is applied. When false, VR-format video shows the
    /// left eye's half to both eyes (a normal flat tile).
    var isImmersive = false {
        didSet { if isImmersive { attachedItemPlayer?.play() } }
    }
    /// The player that owns the attached item, so the dome can keep it playing.
    @ObservationIgnored weak var attachedItemPlayer: AVPlayer?

    /// Subscription used by the immersive dome's RealityView to drive `tick()`.
    @ObservationIgnored var immersiveSubscription: EventSubscription?
    /// Spatial upscale factor applied before the warp (1 = off). Needs MetalFX support.
    var upscaleFactor = 1 {
        didSet { if upscaleFactor != oldValue { outputSize = (0, 0) } }   // rebuild on next frame
    }
    /// Largest per-eye texture dimension. Lower = less decode/GPU work (smoother streaming),
    /// at the cost of sharpness. Drives the environment quality setting. Hard-limited elsewhere
    /// to keep the 2×-packed texture under Metal's 16384 cap.
    var eyeCap = 3840 {
        didSet { if eyeCap != oldValue { outputSize = (0, 0) } }   // rebuild on next frame
    }
    static var supportsUpscaling: Bool {
        #if canImport(MetalFX)
        guard let device = MTLCreateSystemDefaultDevice() else { return false }
        return MTLFXSpatialScalerDescriptor.supportsDevice(device)
        #else
        return false
        #endif
    }

    /// Max disparity as a fraction of width. ~0.02 subtle, 0.05 strong.
    var strength: Float = 0.025
    /// Normalized depth (0 far … 1 near) that sits on the screen plane.
    var convergence: Float = 0.45
    /// Minimum time between depth inferences (the warp still runs every frame).
    var depthInterval: TimeInterval = 1.0 / 60.0   // Kadoki: 60 Hz depth target (inferenceInFlight self-throttles to what the NE sustains)

    @ObservationIgnored var updateSubscription: EventSubscription?

    @ObservationIgnored private let device: MTLDevice
    @ObservationIgnored private let commandQueue: MTLCommandQueue
    @ObservationIgnored private let pipeline: MTLComputePipelineState
    @ObservationIgnored private let blurH: MTLComputePipelineState
    @ObservationIgnored private let blurV: MTLComputePipelineState
    @ObservationIgnored private let splatPipeline: MTLComputePipelineState?
    @ObservationIgnored private let resolvePipeline: MTLComputePipelineState?
    @ObservationIgnored private let bilateralPipeline: MTLComputePipelineState?
    @ObservationIgnored private let tblendPipeline: MTLComputePipelineState?
    /// Bilateral-path depth buffers at 2× model resolution (joint bilateral
    /// UPSAMPLING — edges snap to the image at finer granularity).
    @ObservationIgnored private var depthHiTemp: MTLTexture?
    @ObservationIgnored private var depthHiSmooth: [MTLTexture] = []
    /// Kadoki: forward-splat renderer (z-buffered, background-biased hole
    /// fill — the StereoCrafter-style pipeline) vs the classic single gather.
    @ObservationIgnored var useSplat = true
    /// Depth→disparity curve exponent (splat path).
    @ObservationIgnored var depthGamma: Float = 0.85
    /// Bilateral edge sigma (splat path depth refinement).
    @ObservationIgnored var edgeSigma: Float = 0.08
    @ObservationIgnored private var zbuf: MTLBuffer?
    /// Previous frame's eye outputs — temporal fill source for disocclusions.
    @ObservationIgnored private var history: (left: MTLTexture, right: MTLTexture)?
    @ObservationIgnored private var historyValid = false
    @ObservationIgnored private var textureCache: CVMetalTextureCache?
    // A fresh output is made for each item — reusing one across items can stop delivering
    // frames after a switch, leaving the new clip frozen on the previous frame.
    @ObservationIgnored private var videoOutput: AVPlayerItemVideoOutput?
    @ObservationIgnored private let estimator: DepthEstimator?
    @ObservationIgnored private weak var attachedItem: AVPlayerItem?

    @ObservationIgnored private var packedQueue: TextureResource.DrawableQueue?
    @ObservationIgnored private var scratch: (left: MTLTexture, right: MTLTexture)?
    @ObservationIgnored private var eyeSize = (width: 0, height: 0)
    @ObservationIgnored private var outputSize = (width: 0, height: 0)
    #if canImport(MetalFX)
    @ObservationIgnored private var scaler: MTLFXSpatialScaler?
    #endif
    @ObservationIgnored private var upscaled: MTLTexture?
    @ObservationIgnored private var scalerInput: MTLTexture?   // frame blitted here, shaderRead for MetalFX

    @ObservationIgnored private var frameTexture: MTLTexture?
    @ObservationIgnored private var frameTextureRef: CVMetalTexture?   // keeps the frame alive
    @ObservationIgnored private var depthRaw: MTLTexture?        // straight from the model
    @ObservationIgnored private var depthTemp: MTLTexture?       // after horizontal blur
    @ObservationIgnored private var depthSmooth: [MTLTexture] = [] // ping-pong, temporally blended
    @ObservationIgnored private var smoothIndex = 0
    @ObservationIgnored private var hasSmoothed = false
    @ObservationIgnored private var depthMin: Float = 0
    @ObservationIgnored private var depthMax: Float = 1
    @ObservationIgnored private var inferenceInFlight = false
    @ObservationIgnored private var lastInferenceTime: TimeInterval = 0
    @ObservationIgnored private var needsRender = false

    enum Error: Swift.Error { case noMetal, noKernel }

    init(estimator: DepthEstimator?) throws {
        guard let device = MTLCreateSystemDefaultDevice(),
              let commandQueue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary(),
              let function = library.makeFunction(name: "stereoWarp"),
              let blurHFunction = library.makeFunction(name: "depthBlurH"),
              let blurVFunction = library.makeFunction(name: "depthBlurV") else {
            throw Error.noMetal
        }
        self.device = device
        self.commandQueue = commandQueue
        self.pipeline = try device.makeComputePipelineState(function: function)
        self.blurH = try device.makeComputePipelineState(function: blurHFunction)
        self.blurV = try device.makeComputePipelineState(function: blurVFunction)
        if let sf = library.makeFunction(name: "stereoSplat"),
           let rf = library.makeFunction(name: "stereoResolve") {
            self.splatPipeline = try? device.makeComputePipelineState(function: sf)
            self.resolvePipeline = try? device.makeComputePipelineState(function: rf)
        } else {
            self.splatPipeline = nil
            self.resolvePipeline = nil
        }
        if let bf = library.makeFunction(name: "depthBilateral"),
           let tf = library.makeFunction(name: "depthTemporalBlend") {
            self.bilateralPipeline = try? device.makeComputePipelineState(function: bf)
            self.tblendPipeline = try? device.makeComputePipelineState(function: tf)
        } else {
            self.bilateralPipeline = nil
            self.tblendPipeline = nil
        }
        self.estimator = estimator
        CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)

        let w = estimator?.width ?? DepthEstimator.modelWidth, h = estimator?.height ?? DepthEstimator.modelHeight
        depthRaw = Self.makeTexture(device: device, width: w, height: h, format: .r16Float,
                                    usage: [.shaderRead], shared: true)
        depthTemp = Self.makeTexture(device: device, width: w, height: h, format: .r16Float,
                                     usage: [.shaderRead, .shaderWrite])
        depthSmooth = (0..<2).compactMap { _ in
            Self.makeTexture(device: device, width: w, height: h, format: .r16Float,
                             usage: [.shaderRead, .shaderWrite])
        }
        depthHiTemp = Self.makeTexture(device: device, width: w * 2, height: h * 2, format: .r16Float,
                                       usage: [.shaderRead, .shaderWrite])
        depthHiSmooth = (0..<2).compactMap { _ in
            Self.makeTexture(device: device, width: w * 2, height: h * 2, format: .r16Float,
                             usage: [.shaderRead, .shaderWrite])
        }
    }

    // MARK: Player hookup

    /// Point the renderer at the item currently playing. Call again whenever the item changes.
    func attach(to item: AVPlayerItem?) {
        if let attachedItem, let videoOutput, attachedItem.outputs.contains(videoOutput) {
            attachedItem.remove(videoOutput)
        }
        attachedItem = item
        if let item {
            let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ])
            item.add(output)
            videoOutput = output
        } else {
            videoOutput = nil
        }
        // Reset all per-clip state so a newly-loaded video starts the pipeline clean —
        // otherwise the old clip's depth range and textures linger and it renders wrong
        // until 3D is toggled off and back on (which recreated the renderer from scratch).
        frameTexture = nil
        frameTextureRef = nil
        hasSmoothed = false
        smoothIndex = 0
        depthMin = 0
        depthMax = 1
        inferenceInFlight = false
        lastInferenceTime = 0
        cleanScale = SIMD2(1, 1)
    }

    func detach() {
        attach(to: nil)
    }

    // MARK: Per-frame work (driven by RealityKit's scene update)

    func tick() {
        let hostTime = CACurrentMediaTime()
        if videoOutput == nil, !loggedFirstFrame {
            loggedFirstFrame = true
            NSLog("[KadokiVideo] stereo: tick with NO videoOutput — attach() never ran or detach() cleared it")
        }
        if let videoOutput {
            let itemTime = videoOutput.itemTime(forHostTime: hostTime)
            if videoOutput.hasNewPixelBuffer(forItemTime: itemTime),
               let pixelBuffer = videoOutput.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) {
                if !loggedFirstFrame {
                    loggedFirstFrame = true
                    NSLog("[KadokiVideo] stereo: first frame ingested \(CVPixelBufferGetWidth(pixelBuffer))x\(CVPixelBufferGetHeight(pixelBuffer))")
                }
                ingest(pixelBuffer, hostTime: hostTime)
            }
        }

        if needsRender {
            render()
        }
    }

    /// Fraction of the coded buffer that is real picture (the rest is edge padding the
    /// decoder added to reach a macroblock multiple). AVPlayerLayer crops this; we must too,
    /// or the padding shows as garbage along the right/bottom edge in both eyes.
    @ObservationIgnored private var cleanScale = SIMD2<Float>(1, 1)

    private func ingest(_ pixelBuffer: CVPixelBuffer, hostTime: TimeInterval) {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0, let textureCache else { return }

        var ref: CVMetalTexture?
        CVMetalTextureCacheCreateTextureFromImage(nil, textureCache, pixelBuffer, nil,
                                                  .bgra8Unorm, width, height, 0, &ref)
        guard let ref, let texture = CVMetalTextureGetTexture(ref) else { return }
        frameTexture = texture
        frameTextureRef = ref
        needsRender = true

        // Clean aperture: the decoder pads the coded buffer up to a macroblock multiple
        // (extra pixels on the right/bottom). The texture spans the whole coded buffer, so
        // scale sampling to the display region to avoid reading that padding as garbage.
        let display = CVImageBufferGetDisplaySize(pixelBuffer)
        let texW = texture.width, texH = texture.height
        cleanScale = SIMD2(
            display.width > 0 ? min(1, Float(display.width) / Float(texW)) : 1,
            display.height > 0 ? min(1, Float(display.height) / Float(texH)) : 1
        )
        updateAspect(codedWidth: texW, codedHeight: texH)

        if outputSize.width != width || outputSize.height != height {
            rebuildOutputs(width: width, height: height)
        }

        if !isMono, !inferenceInFlight, hostTime - lastInferenceTime >= depthInterval {
            inferenceInFlight = true
            lastInferenceTime = hostTime
            guard let estimator else { return }
            Task.detached(priority: .userInitiated) { [estimator] in
                let result = try? await estimator.estimate(pixelBuffer)
                await MainActor.run { self.receiveDepth(result) }
            }
        }
    }

    private func receiveDepth(_ depth: CVPixelBuffer?) {
        inferenceInFlight = false
        guard let depth, let depthRaw, let depthTemp, depthSmooth.count == 2 else { return }
        Self.upload(depth, into: depthRaw, minOut: &depthMin, maxOut: &depthMax, smoothing: 0.7)

        // Blur + temporal blend into the other ping-pong buffer.
        guard let commandBuffer = commandQueue.makeCommandBuffer() else { return }
        // Splat path: image-guided bilateral refinement at 2× (edges snap to
        // the frame's silhouettes) + plain temporal blend — replaces the
        // reference Gaussian pipeline, which bled depth ~15px past contours.
        if useSplat, let bilateral = bilateralPipeline, let tblend = tblendPipeline,
           let hiTemp = depthHiTemp, depthHiSmooth.count == 2, let guide = frameTexture {
            let hiPrev = depthHiSmooth[smoothIndex]
            let hiNext = depthHiSmooth[1 - smoothIndex]
            let hiGrid = MTLSize(width: hiTemp.width, height: hiTemp.height, depth: 1)
            let group = MTLSize(width: 16, height: 16, depth: 1)
            if let enc = commandBuffer.makeComputeCommandEncoder() {
                var sigmaRange: Float = edgeSigma
                enc.setComputePipelineState(bilateral)
                enc.setTexture(depthRaw, index: 0)
                enc.setTexture(guide, index: 1)
                enc.setTexture(hiTemp, index: 2)
                enc.setBytes(&sigmaRange, length: 4, index: 0)
                enc.dispatchThreads(hiGrid, threadsPerThreadgroup: group)
                enc.endEncoding()
            }
            if let enc = commandBuffer.makeComputeCommandEncoder() {
                var blend: Float = hasSmoothed ? 0.5 : 1.0
                enc.setComputePipelineState(tblend)
                enc.setTexture(hiTemp, index: 0)
                enc.setTexture(hiPrev, index: 1)
                enc.setTexture(hiNext, index: 2)
                enc.setBytes(&blend, length: 4, index: 0)
                enc.dispatchThreads(hiGrid, threadsPerThreadgroup: group)
                enc.endEncoding()
            }
            commandBuffer.commit()
            smoothIndex = 1 - smoothIndex
            hasSmoothed = true
            needsRender = true
            return
        }
        let previous = depthSmooth[smoothIndex]
        let next = depthSmooth[1 - smoothIndex]
        let grid = MTLSize(width: depthRaw.width, height: depthRaw.height, depth: 1)
        let group = MTLSize(width: 16, height: 16, depth: 1)
        if let encoder = commandBuffer.makeComputeCommandEncoder() {
            encoder.setComputePipelineState(blurH)
            encoder.setTexture(depthRaw, index: 0)
            encoder.setTexture(depthTemp, index: 1)
            encoder.dispatchThreads(grid, threadsPerThreadgroup: group)
            encoder.endEncoding()
        }
        if let encoder = commandBuffer.makeComputeCommandEncoder() {
            var blend: Float = hasSmoothed ? 0.5 : 1.0   // first frame: take it as-is (0.5 = the reference recipe in 3D_QUALITY_HANDOFF.md — quality-critical, do not retune)
            encoder.setComputePipelineState(blurV)
            encoder.setTexture(depthTemp, index: 0)
            encoder.setTexture(previous, index: 1)
            encoder.setTexture(next, index: 2)
            encoder.setBytes(&blend, length: MemoryLayout<Float>.size, index: 0)
            encoder.dispatchThreads(grid, threadsPerThreadgroup: group)
            encoder.endEncoding()
        }
        commandBuffer.commit()
        smoothIndex = 1 - smoothIndex
        hasSmoothed = true
        needsRender = true
    }

    /// Normalized source rectangle for one eye given the packing layout.
    private func crop(forEye eye: Float) -> (origin: SIMD2<Float>, size: SIMD2<Float>) {
        let right = isImmersive && eye > 0
        switch eyeLayout {
        case .mono: return ([0, 0], [1, 1])
        case .sideBySide: return ([right ? 0.5 : 0, 0], [0.5, 1])
        case .topBottom: return ([0, right ? 0.5 : 0], [1, 0.5])
        }
    }

    /// Letterbox aspect for one eye, from the clean (display) dimensions and packing.
    private func updateAspect(codedWidth: Int, codedHeight: Int) {
        var w = CGFloat(codedWidth) * CGFloat(cleanScale.x)
        var h = CGFloat(codedHeight) * CGFloat(cleanScale.y)
        switch eyeLayout {
        case .mono: break
        case .sideBySide: w /= 2
        case .topBottom: h /= 2
        }
        if w > 0, h > 0 { aspectRatio = w / h }
    }

    private func rebuildOutputs(width frameWidth: Int, height frameHeight: Int) {
        outputSize = (frameWidth, frameHeight)
        // One eye's share of the frame is what each output texture holds.
        var inputWidth = frameWidth, inputHeight = frameHeight
        switch eyeLayout {
        case .mono: break
        case .sideBySide: inputWidth = max(1, frameWidth / 2)
        case .topBottom: inputHeight = max(1, frameHeight / 2)
        }
        updateAspect(codedWidth: frameWidth, codedHeight: frameHeight)

        // Optional MetalFX spatial upscale, capped at 4K wide.
        upscaled = nil
        scalerInput = nil
        var width = inputWidth, height = inputHeight
        #if canImport(MetalFX)
        scaler = nil
        if upscaleFactor > 1, MTLFXSpatialScalerDescriptor.supportsDevice(device) {
            let factor = min(upscaleFactor, max(1, 3840 / inputWidth))
            if factor > 1 {
                let descriptor = MTLFXSpatialScalerDescriptor()
                descriptor.inputWidth = inputWidth
                descriptor.inputHeight = inputHeight
                descriptor.outputWidth = inputWidth * factor
                descriptor.outputHeight = inputHeight * factor
                descriptor.colorTextureFormat = .bgra8Unorm
                descriptor.outputTextureFormat = .bgra8Unorm
                descriptor.colorProcessingMode = .perceptual
                if let scaler = descriptor.makeSpatialScaler(device: device),
                   let target = Self.makeTexture(device: device, width: inputWidth * factor,
                                                 height: inputHeight * factor, format: .bgra8Unorm,
                                                 usage: [.shaderRead, .shaderWrite, .renderTarget]),
                   let input = Self.makeTexture(device: device, width: inputWidth, height: inputHeight,
                                                format: .bgra8Unorm, usage: [.shaderRead]) {
                    self.scaler = scaler
                    self.upscaled = target
                    self.scalerInput = input
                    width = inputWidth * factor
                    height = inputHeight * factor
                }
            }
        }
        #endif

        // Cap the eye texture: the packed texture is 2× wide, so a large source (e.g. an 8K
        // 360) would exceed Metal's 16384-pixel texture limit and fail to allocate — which
        // showed as an all-white dome. The warp downscales via sampling, so this just limits
        // internal resolution, not the source. (Other players don't pack 2× so don't hit this.)
        let eyeCap = max(640, min(3840, self.eyeCap))
        if width > eyeCap {
            let s = Double(eyeCap) / Double(width)
            width = eyeCap; height = max(1, Int((Double(height) * s).rounded()))
        }
        if height > eyeCap {
            let s = Double(eyeCap) / Double(height)
            height = eyeCap; width = max(1, Int((Double(width) * s).rounded()))
        }

        eyeSize = (width, height)
        do {
            // One packed texture, both eyes side-by-side: width = 2× one eye. Video frames
            // are sRGB-encoded, so tag it sRGB (else RealityKit treats it as linear and the
            // colours wash out). No mipmaps — they caused a checkerboard on DrawableQueues.
            let descriptor = TextureResource.DrawableQueue.Descriptor(
                pixelFormat: .bgra8Unorm_srgb, width: width * 2, height: height,
                usage: [.shaderRead], mipmapsMode: .none)
            let queue = try TextureResource.DrawableQueue(descriptor)
            let packed = try Self.makePlaceholder(width: width * 2, height: height)
            packed.replace(withDrawables: queue)
            packedQueue = queue
            scratch = (
                Self.makeTexture(device: device, width: width, height: height,
                                 format: .bgra8Unorm, usage: [.shaderRead, .shaderWrite])!,
                Self.makeTexture(device: device, width: width, height: height,
                                 format: .bgra8Unorm, usage: [.shaderRead, .shaderWrite])!
            )
            zbuf = device.makeBuffer(length: width * height * 4, options: .storageModePrivate)
            history = (
                Self.makeTexture(device: device, width: width, height: height,
                                 format: .bgra8Unorm, usage: [.shaderRead, .shaderWrite])!,
                Self.makeTexture(device: device, width: width, height: height,
                                 format: .bgra8Unorm, usage: [.shaderRead, .shaderWrite])!
            )
            historyValid = false
            packedTexture = packed
        } catch {
            lastError = "Couldn't create stereo texture: \(error.localizedDescription)"
        }
    }

    private func render() {
        guard let frameTexture, let scratch,
              let packedQueue,
              let commandBuffer = commandQueue.makeCommandBuffer() else { return }
        // Show the frame the moment it arrives; if depth isn't ready yet it renders flat
        // (disparity 0) and pops into 3D once the first depth result lands — so a freshly
        // switched clip never sits frozen on the previous frame.
        let depthReady = hasSmoothed
        needsRender = false
        guard let drawable = try? packedQueue.nextDrawable() else { return }
        let depthTexture = (useSplat && depthHiSmooth.count == 2) ? depthHiSmooth[smoothIndex] : depthSmooth[smoothIndex]

        var source = frameTexture
        #if canImport(MetalFX)
        if let scaler, let upscaled, let scalerInput,
           scalerInput.width == frameTexture.width, scalerInput.height == frameTexture.height {
            // Copy the frame into a shader-readable texture, then MetalFX-upscale it.
            if let blit = commandBuffer.makeBlitCommandEncoder() {
                blit.copy(from: frameTexture, to: scalerInput)
                blit.endEncoding()
            }
            scaler.colorTexture = scalerInput
            scaler.outputTexture = upscaled
            scaler.encode(commandBuffer: commandBuffer)
            source = upscaled
        }
        #endif

        // Warp each eye into its scratch texture.
        let eyes: [(eye: Float, target: MTLTexture)] = [(-1, scratch.left), (1, scratch.right)]
        let flat = isMono || isImmersive || !depthReady
        // Forward-splat path (z-buffered, background-biased fill). Falls back
        // to the classic gather whenever the splat pipelines are unavailable
        // or disparity is zero anyway.
        let splatting = useSplat && !flat && splatPipeline != nil && resolvePipeline != nil && zbuf != nil
        for eye in eyes {
            let crop = crop(forEye: eye.eye)
            var params = StereoParams(strength: flat ? 0 : strength,
                                      convergence: convergence,
                                      depthMin: depthMin, depthMax: depthMax, eye: eye.eye,
                                      cropOrigin: crop.origin, cropSize: crop.size,
                                      cleanScale: cleanScale,
                                      gamma: depthGamma,
                                      fill: (historyValid && useSplat) ? 1 : 0)
            let grid = MTLSize(width: eye.target.width, height: eye.target.height, depth: 1)
            if splatting, let splat = splatPipeline, let resolve = resolvePipeline, let zbuf {
                if let blit = commandBuffer.makeBlitCommandEncoder() {
                    blit.fill(buffer: zbuf, range: 0..<(eye.target.width * eye.target.height * 4), value: 0)
                    blit.endEncoding()
                }
                var dims = SIMD2<UInt32>(UInt32(eye.target.width), UInt32(eye.target.height))
                if let enc = commandBuffer.makeComputeCommandEncoder() {
                    enc.setComputePipelineState(splat)
                    enc.setTexture(depthTexture, index: 0)
                    enc.setBytes(&params, length: MemoryLayout<StereoParams>.stride, index: 0)
                    enc.setBuffer(zbuf, offset: 0, index: 1)
                    enc.setBytes(&dims, length: MemoryLayout<SIMD2<UInt32>>.stride, index: 2)
                    let w = splat.threadExecutionWidth
                    let h = max(1, splat.maxTotalThreadsPerThreadgroup / w)
                    enc.dispatchThreads(grid, threadsPerThreadgroup: MTLSize(width: w, height: h, depth: 1))
                    enc.endEncoding()
                }
                if let enc = commandBuffer.makeComputeCommandEncoder() {
                    enc.setComputePipelineState(resolve)
                    enc.setTexture(source, index: 0)
                    enc.setTexture(depthTexture, index: 1)
                    enc.setTexture(eye.target, index: 2)
                    enc.setTexture(eye.eye < 0 ? history?.left : history?.right, index: 3)
                    enc.setBytes(&params, length: MemoryLayout<StereoParams>.stride, index: 0)
                    enc.setBuffer(zbuf, offset: 0, index: 1)
                    let w = resolve.threadExecutionWidth
                    let h = max(1, resolve.maxTotalThreadsPerThreadgroup / w)
                    enc.dispatchThreads(grid, threadsPerThreadgroup: MTLSize(width: w, height: h, depth: 1))
                    enc.endEncoding()
                }
                continue
            }
            guard let encoder = commandBuffer.makeComputeCommandEncoder() else { continue }
            encoder.setComputePipelineState(pipeline)
            encoder.setTexture(source, index: 0)
            encoder.setTexture(depthTexture, index: 1)
            encoder.setTexture(eye.target, index: 2)
            encoder.setBytes(&params, length: MemoryLayout<StereoParams>.stride, index: 0)
            let w = pipeline.threadExecutionWidth
            let h = max(1, pipeline.maxTotalThreadsPerThreadgroup / w)
            let threadsPerGroup = MTLSize(width: w, height: h, depth: 1)
            encoder.dispatchThreads(grid, threadsPerThreadgroup: threadsPerGroup)
            encoder.endEncoding()
        }
        // Pack both eyes into one drawable: left in the left half, right in the right half.
        // A single drawable presented once guarantees the eyes are always from one frame.
        if let blit = commandBuffer.makeBlitCommandEncoder() {
            blit.copy(from: scratch.left, sourceSlice: 0, sourceLevel: 0,
                      sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                      sourceSize: MTLSize(width: scratch.left.width, height: scratch.left.height, depth: 1),
                      to: drawable.texture, destinationSlice: 0, destinationLevel: 0,
                      destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0))
            blit.copy(from: scratch.right, sourceSlice: 0, sourceLevel: 0,
                      sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                      sourceSize: MTLSize(width: scratch.right.width, height: scratch.right.height, depth: 1),
                      to: drawable.texture, destinationSlice: 0, destinationLevel: 0,
                      destinationOrigin: MTLOrigin(x: eyeSize.width, y: 0, z: 0))
            blit.endEncoding()
        }
        // Refresh the temporal-fill history with this frame's outputs.
        if splatting, let history {
            if let blit = commandBuffer.makeBlitCommandEncoder() {
                blit.copy(from: scratch.left, to: history.left)
                blit.copy(from: scratch.right, to: history.right)
                blit.endEncoding()
            }
            historyValid = true
        }
        commandBuffer.addCompletedHandler { _ in drawable.present() }
        commandBuffer.commit()
    }

    // MARK: Helpers

    /// Mirrors `StereoParams` in Stereo.metal.
    struct StereoParams {
        var strength: Float
        var convergence: Float
        var depthMin: Float
        var depthMax: Float
        var eye: Float
        var cropOrigin: SIMD2<Float>
        var cropSize: SIMD2<Float>
        var cleanScale: SIMD2<Float>
        var gamma: Float
        var fill: Float
    }

    static func makeTexture(device: MTLDevice, width: Int, height: Int,
                            format: MTLPixelFormat, usage: MTLTextureUsage,
                            shared: Bool = false) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: format, width: width, height: height, mipmapped: false)
        descriptor.usage = usage
        descriptor.storageMode = shared ? .shared : .private
        return device.makeTexture(descriptor: descriptor)
    }

    private static func makePlaceholder(width: Int, height: Int) throws -> TextureResource {
        let bytes = Data(count: width * height * 4)
        return try TextureResource(
            dimensions: .dimensions(width: width, height: height),
            format: .raw(pixelFormat: .bgra8Unorm_srgb),
            contents: .init(mipmapLevels: [.mip(data: bytes, bytesPerRow: width * 4)])
        )
    }

    /// Copies a 16-bit-float depth buffer into `texture` and tracks its (smoothed) range.
    static func upload(_ depth: CVPixelBuffer, into texture: MTLTexture,
                       minOut: inout Float, maxOut: inout Float, smoothing: Float) {
        CVPixelBufferLockBaseAddress(depth, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(depth) else { return }
        let width = min(CVPixelBufferGetWidth(depth), texture.width)
        let height = min(CVPixelBufferGetHeight(depth), texture.height)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(depth)

        var rawLo = Float.greatestFiniteMagnitude
        var rawHi = -Float.greatestFiniteMagnitude
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float16.self)
            for x in 0..<width {
                let v = Float(row[x])
                if v < rawLo { rawLo = v }
                if v > rawHi { rawHi = v }
            }
        }
        var lo = rawLo, hi = rawHi
        // Robust 2–98% percentile range (pipeline notes §4): a few outlier
        // pixels otherwise own the normalization and the whole scene's depth
        // pumps when they come and go.
        if rawLo.isFinite, rawHi.isFinite, rawHi > rawLo {
            var hist = [Int](repeating: 0, count: 256)
            let scale = 255.0 / (rawHi - rawLo)
            for y in 0..<height {
                let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float16.self)
                for x in 0..<width {
                    let b = Int((Float(row[x]) - rawLo) * scale)
                    hist[min(255, max(0, b))] += 1
                }
            }
            let total = width * height
            let loCount = Int(Double(total) * 0.02), hiCount = Int(Double(total) * 0.98)
            var acc = 0
            for b in 0..<256 {
                acc += hist[b]
                if acc >= loCount { lo = rawLo + Float(b) / scale; break }
            }
            acc = 0
            for b in 0..<256 {
                acc += hist[b]
                if acc >= hiCount { hi = rawLo + Float(b) / scale; break }
            }
            if hi <= lo { lo = rawLo; hi = rawHi }
        }
        if lo.isFinite, hi.isFinite, hi > lo {
            // Exponential smoothing keeps the range from jittering frame to frame.
            let firstFrame = (minOut == 0 && maxOut == 1)
            minOut = firstFrame ? lo : smoothing * minOut + (1 - smoothing) * lo
            maxOut = firstFrame ? hi : smoothing * maxOut + (1 - smoothing) * hi
        }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0,
                        withBytes: base, bytesPerRow: bytesPerRow)
    }
}

#endif
