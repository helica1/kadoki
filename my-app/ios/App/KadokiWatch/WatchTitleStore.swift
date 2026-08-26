// WatchTitleStore.swift — local index of transferred titles on the watch.
// Titles live in Library/Titles/<titleId>/ { audio.<ext>, cues.json, meta.json }.
import Foundation

struct WatchTitle: Identifiable, Equatable {
    let id: String
    let name: String
    let durMs: Double
    let audioURL: URL?
    let coverURL: URL?
    let sizeBytes: Int64

    static func == (a: WatchTitle, b: WatchTitle) -> Bool { a.id == b.id }
}

final class WatchTitleStore: ObservableObject {
    static let shared = WatchTitleStore()

    @Published var titles: [WatchTitle] = []

    static func titlesRoot() -> URL {
        let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return lib.appendingPathComponent("Titles", isDirectory: true)
    }
    static func titleDir(_ id: String) -> URL {
        titlesRoot().appendingPathComponent(id, isDirectory: true)
    }

    init() { reload() }

    func reload() {
        let fm = FileManager.default
        var out: [WatchTitle] = []
        let root = Self.titlesRoot()
        let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let id = dir.lastPathComponent
            var name = id
            var durMs: Double = 0
            if let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                name = (obj["name"] as? String) ?? id
                durMs = (obj["durMs"] as? Double) ?? 0
            }
            var audioURL: URL? = nil
            var size: Int64 = 0
            let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
            for f in files where f.lastPathComponent.hasPrefix("audio.") {
                audioURL = f
                size = Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            }
            // Phase C (automatic cues sync) can deliver a title dir that holds
            // only cues.json — no audio.* — for titles never explicitly sent
            // to the watch. Those aren't playable here; keep the directory on
            // disk (a future live-view feature reads it) but leave it out of
            // the playback list.
            guard audioURL != nil else { continue }
            let coverURL = dir.appendingPathComponent("cover.jpg")
            let cover = fm.fileExists(atPath: coverURL.path) ? coverURL : nil
            out.append(WatchTitle(id: id, name: name, durMs: durMs, audioURL: audioURL, coverURL: cover, sizeBytes: size))
        }
        out.sort { $0.name < $1.name }
        titles = out
    }

    func delete(_ title: WatchTitle) {
        try? FileManager.default.removeItem(at: Self.titleDir(title.id))
        reload()
    }
}
