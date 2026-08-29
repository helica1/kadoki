// Ported from GridPlayer (see /player). visionOS-only: curved video panel mesh.
#if os(visionOS)
import RealityKit

extension MeshResource {
    /// A unit-size cylindrical panel (like a curved ultrawide monitor): 1×1 in X/Y, its left
    /// and right edges bowed toward the viewer. Scale the hosting entity by [width, height,
    /// width] so the curve depth stays proportional to the width. UVs map the video across it.
    /// - Parameter arc: total horizontal arc angle in radians (bigger = more curve).
    static func curvedPanel(arc: Float = 0.85, columns: Int = 64) -> MeshResource {
        let cols = max(2, columns)
        let radius = 0.5 / sin(arc / 2)          // so x spans ±0.5
        var positions: [SIMD3<Float>] = []
        var uvs: [SIMD2<Float>] = []
        var indices: [UInt32] = []

        for i in 0...cols {
            let u = Float(i) / Float(cols)
            let t = (u - 0.5) * arc
            let x = radius * sin(t)
            let z = radius * (1 - cos(t))        // center at 0, edges bow toward viewer (+z)
            // Two vertices per column (bottom, top); the panel is flat vertically.
            // v: bottom = 0, top = 1 to match RealityKit's plane UV orientation (else the
            // video renders upside down).
            positions.append([x, -0.5, z]); uvs.append([u, 0])
            positions.append([x,  0.5, z]); uvs.append([u, 1])
        }
        for i in 0..<cols {
            let a = UInt32(i * 2)
            let b = a + 1, c = a + 2, d = a + 3
            // Faces toward -z (the viewer looks along -z at the concave side).
            indices += [a, c, b, b, c, d]
        }

        var desc = MeshDescriptor(name: "curvedPanel")
        desc.positions = MeshBuffer(positions)
        desc.textureCoordinates = MeshBuffer(uvs)
        desc.primitives = .triangles(indices)
        return (try? MeshResource.generate(from: [desc])) ?? .generatePlane(width: 1, height: 1)
    }
}

/// Shared meshes for the stereo tile (a generic view can't hold static stored properties).
@MainActor
enum StereoPanelMeshes {
    static let flat: MeshResource = .generatePlane(width: 1, height: 1)
    private static var cachedArc: Float = -1
    private static var cachedMesh: MeshResource = .generatePlane(width: 1, height: 1)
    /// Curved panel mesh for the given arc, regenerated only when the arc changes.
    static func curved(arc: Float) -> MeshResource {
        if abs(arc - cachedArc) > 0.005 {
            cachedMesh = .curvedPanel(arc: max(0.05, arc))
            cachedArc = arc
        }
        return cachedMesh
    }
}
#endif
