#include <metal_stdlib>
using namespace metal;

/// Parameters for the depth-based stereo synthesis pass.
struct StereoParams {
    float strength;      // max disparity as a fraction of image width (e.g. 0.03)
    float convergence;   // normalized depth (0…1) that sits exactly on the screen plane
    float depthMin;      // raw depth value mapped to 0 (far)
    float depthMax;      // raw depth value mapped to 1 (near)
    float eye;           // -1 = left eye, +1 = right eye
    float2 cropOrigin;   // sub-rectangle of the source this eye reads (normalized)
    float2 cropSize;
    float2 cleanScale;   // fraction of the coded buffer that is real picture (crops padding)
    float gamma;         // depth→disparity curve exponent (splat path; 1 = linear)
    float fill;          // 1 = temporal history available for hole filling
};

/// Synthesizes one eye's view of a 2D frame from its estimated depth map.
///
/// Depth Anything produces *relative inverse depth* (bigger = nearer). Objects nearer
/// than the convergence plane pop out of the screen: in the left-eye image they shift
/// right, in the right-eye image they shift left. This is a gather (inverse) warp with
/// a two-step fixed-point refinement so the depth is sampled close to where the source
/// pixel actually comes from, which hides most of the edge smearing a naive gather has.
kernel void stereoWarp(texture2d<float, access::sample> color [[texture(0)]],
                       texture2d<float, access::sample> depth [[texture(1)]],
                       texture2d<float, access::write>  out   [[texture(2)]],
                       constant StereoParams &p [[buffer(0)]],
                       uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= out.get_width() || gid.y >= out.get_height()) { return; }

    constexpr sampler linear(coord::normalized, address::clamp_to_edge, filter::linear);
    float2 uv = (float2(gid) + 0.5) / float2(out.get_width(), out.get_height());

    float range = max(p.depthMax - p.depthMin, 1e-4);
    // Taper parallax to zero within a margin of the left/right edges, so the boundary
    // columns match the original frame instead of smearing when the gather clamps.
    const float edgeMargin = 0.07;
    float edgeFade = smoothstep(0.0, edgeMargin, uv.x) * smoothstep(1.0, 1.0 - edgeMargin, uv.x);

    float dCenter = clamp((depth.sample(linear, uv).r - p.depthMin) / range, 0.0, 1.0);

    // Reduce disparity across steep depth edges. A gather warp tears/streaks exactly where
    // depth changes fast (object boundaries); flattening the parallax there — while keeping
    // it on smooth surfaces — removes the artifact that shimmers when foveated.
    float texel = 1.0 / float(depth.get_width());
    float dL = clamp((depth.sample(linear, uv - float2(2.0 * texel, 0)).r - p.depthMin) / range, 0.0, 1.0);
    float dR = clamp((depth.sample(linear, uv + float2(2.0 * texel, 0)).r - p.depthMin) / range, 0.0, 1.0);
    float grad = max(abs(dCenter - dL), abs(dCenter - dR));
    float gradFade = 1.0 - smoothstep(0.04, 0.20, grad);

    // Single gather: iterating the inverse warp diverges at depth edges and amplifies streaks.
    float disparity = p.strength * (dCenter - p.convergence) * edgeFade * gradFade;
    float2 src = clamp(float2(uv.x + p.eye * disparity, uv.y), 0.0, 1.0);
    // Map into this eye's crop of the source (whole frame for flat video, one half for
    // side-by-side / top-bottom stereo), then scale to the clean aperture so the decoder's
    // edge padding on the right/bottom of the coded buffer isn't sampled.
    float2 crop = (p.cropOrigin + src * p.cropSize) * p.cleanScale;
    out.write(float4(color.sample(linear, crop).rgb, 1.0), gid);
}

/// Separable Gaussian blur of the depth map, radius 10 (21 taps, sigma ~3.5), used to
/// soften depth discontinuities so the warp bends edges gently instead of tearing them.
constant float kGauss[11] = {
    0.11426, 0.10969, 0.09701, 0.07930, 0.05965, 0.04125,
    0.02628, 0.01543, 0.00834, 0.00411, 0.00183
};

kernel void depthBlurH(texture2d<float, access::read>  src [[texture(0)]],
                       texture2d<float, access::write> dst [[texture(1)]],
                       uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) { return; }
    int w = int(src.get_width());
    float sum = 0.0;
    for (int i = -10; i <= 10; i++) {
        int x = clamp(int(gid.x) + i, 0, w - 1);
        sum += src.read(uint2(x, gid.y)).r * kGauss[abs(i)];
    }
    dst.write(float4(sum, 0, 0, 1), gid);
}

/// Vertical pass, blended with the previous smoothed depth for temporal stability.
kernel void depthBlurV(texture2d<float, access::read>  src  [[texture(0)]],
                       texture2d<float, access::read>  prev [[texture(1)]],
                       texture2d<float, access::write> dst  [[texture(2)]],
                       constant float &blend [[buffer(0)]],   // weight of the new frame, 0…1
                       uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) { return; }
    int h = int(src.get_height());
    float sum = 0.0;
    for (int i = -10; i <= 10; i++) {
        int y = clamp(int(gid.y) + i, 0, h - 1);
        sum += src.read(uint2(gid.x, y)).r * kGauss[abs(i)];
    }
    float previous = prev.read(gid).r;
    dst.write(float4(mix(previous, sum, blend), 0, 0, 1), gid);
}

// ---------------------------------------------------------------------------
// Forward-splat stereo (Kadoki, after the StereoCrafter/Moon-Player pipeline
// notes): instead of the single inverse gather — which STRETCHES foreground
// edge pixels across newly exposed background (halos, rubber edges) — each
// source pixel is pushed to its disparity-shifted position with a z-buffer
// (near wins), and disoccluded holes are filled from the BACKGROUND side.
//
// Pass 1 (stereoSplat): per source pixel, compute shaped disparity and
// atomic-max a key of (quantized-nearness << 12 | source-x) into the target
// column. Two-tap (floor/ceil) for subpixel coverage.
// Pass 2 (stereoResolve): winner's source column is sampled for color; holes
// scan sideways and take the FARTHER (background) neighbor's source — the
// perceptually correct fill per the notes ("do not stretch pixels into newly
// exposed regions"); anything still empty falls back to the classic gather.
// ---------------------------------------------------------------------------

inline float kadokiShapedDepth(texture2d<float, access::sample> depth,
                               float2 uv, constant StereoParams &p,
                               sampler linear)
{
    float range = max(p.depthMax - p.depthMin, 1e-4);
    float t = clamp((depth.sample(linear, uv).r - p.depthMin) / range, 0.0, 1.0);
    // Nonlinear shaping (notes §4): gamma expands near/mid separation
    // (γ<1 fights the cardboard look), smoothstep stabilizes the extremes.
    t = pow(t, max(p.gamma, 0.1));
    return t * t * (3.0 - 2.0 * t);
}

inline float kadokiDisparity(texture2d<float, access::sample> depth,
                             float2 uv, constant StereoParams &p,
                             sampler linear, float dCenter)
{
    // NO gradient fade here (unlike the classic gather): flattening disparity
    // at depth edges glues foreground to background — the cardboard look. The
    // splat pipeline handles edges properly (z-buffer + background fill), so
    // silhouettes keep their full separation.
    const float edgeMargin = 0.07;
    float edgeFade = smoothstep(0.0, edgeMargin, uv.x) * smoothstep(1.0, 1.0 - edgeMargin, uv.x);
    return p.strength * (dCenter - p.convergence) * edgeFade;
}

kernel void stereoSplat(texture2d<float, access::sample> depth [[texture(0)]],
                        device atomic_uint *zbuf [[buffer(1)]],
                        constant StereoParams &p [[buffer(0)]],
                        constant uint2 &dims [[buffer(2)]],
                        uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    constexpr sampler linear(coord::normalized, address::clamp_to_edge, filter::linear);
    float2 uv = (float2(gid) + 0.5) / float2(dims);
    float d = kadokiShapedDepth(depth, uv, p, linear);
    float disparity = kadokiDisparity(depth, uv, p, linear, d);
    float xt = (uv.x + p.eye * disparity) * float(dims.x) - 0.5;
    int xi = int(floor(xt));
    // key: nearness in the high 20 bits (atomic_max → nearest wins), source
    // x in the low 12 (eye widths are capped at 3840 < 4096).
    uint key = (uint(d * 1048575.0) << 12) | (uint(gid.x) & 0xFFFu);
    for (int k = 0; k <= 1; k++) {
        int x = xi + k;
        if (x >= 0 && x < int(dims.x)) {
            atomic_fetch_max_explicit(&zbuf[gid.y * dims.x + x], key, memory_order_relaxed);
        }
    }
}

kernel void stereoResolve(texture2d<float, access::sample> color [[texture(0)]],
                          texture2d<float, access::sample> depth [[texture(1)]],
                          texture2d<float, access::write>  out   [[texture(2)]],
                          texture2d<float, access::sample> history [[texture(3)]],
                          device const uint *zbuf [[buffer(1)]],
                          constant StereoParams &p [[buffer(0)]],
                          uint2 gid [[thread_position_in_grid]])
{
    uint W = out.get_width(), H = out.get_height();
    if (gid.x >= W || gid.y >= H) { return; }
    constexpr sampler linear(coord::normalized, address::clamp_to_edge, filter::linear);

    uint key = zbuf[gid.y * W + gid.x];
    uint srcX = key & 0xFFFu;
    if (key == 0u) {
        // Disocclusion. Fill order (StereoCrafter's structure, real-time
        // stand-ins for its diffusion inpainting):
        //   1. previous OUTPUT frame at the same position — for static or
        //      slowly-moving backgrounds this IS the revealed content
        //      ("recover background from nearby frames", notes §3);
        //   2. the FARTHER (background) side's winner within a small scan —
        //      extending background never halos;
        //   3. classic gather as the last resort.
        if (p.fill > 0.5) {
            float2 uv = (float2(gid) + 0.5) / float2(W, H);
            out.write(float4(history.sample(linear, uv).rgb, 1.0), gid);
            return;
        }
        uint bestKey = 0u;
        for (uint r = 1; r <= 16; r++) {
            uint kl = (gid.x >= r) ? zbuf[gid.y * W + gid.x - r] : 0u;
            uint kr = (gid.x + r < W) ? zbuf[gid.y * W + gid.x + r] : 0u;
            uint cand = 0u;
            if (kl != 0u && kr != 0u) { cand = min(kl, kr); }       // farther wins
            else { cand = max(kl, kr); }
            if (cand != 0u) { bestKey = cand; break; }
        }
        if (bestKey != 0u) {
            srcX = bestKey & 0xFFFu;
        } else {
            float2 uv = (float2(gid) + 0.5) / float2(W, H);
            float d = kadokiShapedDepth(depth, uv, p, linear);
            float disparity = kadokiDisparity(depth, uv, p, linear, d);
            float2 src = clamp(float2(uv.x + p.eye * disparity, uv.y), 0.0, 1.0);
            float2 crop = (p.cropOrigin + src * p.cropSize) * p.cleanScale;
            out.write(float4(color.sample(linear, crop).rgb, 1.0), gid);
            return;
        }
    }
    float2 src = float2((float(srcX) + 0.5) / float(W), (float(gid.y) + 0.5) / float(H));
    float2 crop = (p.cropOrigin + src * p.cropSize) * p.cleanScale;
    out.write(float4(color.sample(linear, crop).rgb, 1.0), gid);
}


// Image-guided (joint bilateral) depth refinement, upsampling to the output
// texture's resolution. Spatial Gaussian × guide-luma range Gaussian: depth
// edges snap to IMAGE silhouettes (hair wisps included) instead of bleeding
// ~15px like the pure Gaussian — lab-verified on real footage. Splat path
// only; the classic gather keeps the reference Gaussian pipeline.
kernel void depthBilateral(texture2d<float, access::sample> depthIn [[texture(0)]],
                           texture2d<float, access::sample> guide  [[texture(1)]],
                           texture2d<float, access::write>  outT   [[texture(2)]],
                           constant float &sigmaRange [[buffer(0)]],
                           uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= outT.get_width() || gid.y >= outT.get_height()) { return; }
    constexpr sampler linear(coord::normalized, address::clamp_to_edge, filter::linear);
    float2 dims = float2(outT.get_width(), outT.get_height());
    float2 uv = (float2(gid) + 0.5) / dims;
    float3 g0 = guide.sample(linear, uv).rgb;
    float l0 = dot(g0, float3(0.299, 0.587, 0.114));
    float sum = 0.0, wsum = 0.0;
    const int R = 6;
    for (int dy = -R; dy <= R; dy++) {
        for (int dx = -R; dx <= R; dx++) {
            float2 o = float2(dx, dy);
            float2 suv = uv + o / dims;
            float d = depthIn.sample(linear, suv).r;
            float lc = dot(guide.sample(linear, suv).rgb, float3(0.299, 0.587, 0.114));
            float ws = exp(-dot(o, o) / (2.0 * 9.0));
            float wr = exp(-pow(lc - l0, 2.0) / (2.0 * sigmaRange * sigmaRange));
            sum += d * ws * wr;
            wsum += ws * wr;
        }
    }
    outT.write(float4(sum / max(wsum, 1e-6), 0, 0, 1), gid);
}

// Plain temporal blend (the bilateral path's replacement for depthBlurV's
// built-in mix): out = mix(previous, current, blend).
kernel void depthTemporalBlend(texture2d<float, access::sample> cur  [[texture(0)]],
                               texture2d<float, access::sample> prev [[texture(1)]],
                               texture2d<float, access::write>  outT [[texture(2)]],
                               constant float &blend [[buffer(0)]],
                               uint2 gid [[thread_position_in_grid]])
{
    if (gid.x >= outT.get_width() || gid.y >= outT.get_height()) { return; }
    constexpr sampler linear(coord::normalized, address::clamp_to_edge, filter::linear);
    float2 uv = (float2(gid) + 0.5) / float2(outT.get_width(), outT.get_height());
    float c = cur.sample(linear, uv).r;
    float p = prev.sample(linear, uv).r;
    outT.write(float4(mix(p, c, blend), 0, 0, 1), gid);
}
