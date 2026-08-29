// Ported from GridPlayer (see /player). visionOS-only: the AI-3D video
// pipeline (Depth Anything V2 -> Metal warp -> per-eye RealityKit texture).
#if os(visionOS)
import Foundation

/// How the pixels of a video are laid out for stereo, and how wide the picture is.
enum VideoFormat: String, CaseIterable, Identifiable {
    case flat
    case vr180SBS, vr180TB
    case vr360Mono, vr360SBS, vr360TB

    var id: String { rawValue }

    enum EyeLayout { case mono, sideBySide, topBottom }

    var label: String {
        switch self {
        case .flat: "Flat"
        case .vr180SBS: "VR 180° side-by-side"
        case .vr180TB: "VR 180° top-bottom"
        case .vr360Mono: "VR 360° mono"
        case .vr360SBS: "VR 360° side-by-side"
        case .vr360TB: "VR 360° top-bottom"
        }
    }

    var isVR: Bool { self != .flat }

    /// Horizontal field of view of the picture in degrees.
    var fieldOfView: Float {
        switch self {
        case .flat: 0
        case .vr180SBS, .vr180TB: 180
        case .vr360Mono, .vr360SBS, .vr360TB: 360
        }
    }

    var eyeLayout: EyeLayout {
        switch self {
        case .flat, .vr360Mono: .mono
        case .vr180SBS, .vr360SBS: .sideBySide
        case .vr180TB, .vr360TB: .topBottom
        }
    }

    /// Best guess from the file name, e.g. `beach_180_sbs.mp4`, `tour360.mp4`, `clip_LR_180.mp4`.
    static func detect(from url: URL) -> VideoFormat {
        let name = url.deletingPathExtension().lastPathComponent.lowercased()
        // Split on anything that isn't a letter or digit so "vr180" and "180_sbs" both work.
        let tokens = name.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        func has(_ candidates: [String]) -> Bool {
            tokens.contains { token in
                candidates.contains { token == $0 || token.hasSuffix($0) || token.hasPrefix($0) }
            }
        }
        let is360 = has(["360"])
        let is180 = !is360 && has(["180", "vr180"])
        guard is360 || is180 else { return .flat }
        let sbs = has(["sbs", "lr", "3dh", "sidebyside"])
        let tb = has(["tb", "ou", "3dv", "overunder", "topbottom"])
        if is360 {
            return sbs ? .vr360SBS : (tb ? .vr360TB : .vr360Mono)
        }
        return tb ? .vr180TB : .vr180SBS   // 180° is nearly always stereo; SBS is the common layout
    }
}

#endif
