import AppKit
import Foundation
import WebKit
import UniformTypeIdentifiers

/// Native file operations for the web layer. Files picked here stay IN PLACE
/// (real absolute paths, no copying at import — matching the mobile lazy-import
/// contract). The scheme handler serves any granted path with Range support so
/// the web audio element can stream/seek multi-hour audiobooks efficiently.
///
/// Ops (JSON string in → JSON dictionary out):
///   pickFile   {kind|accept}                 → {path, name, size} | {canceled}
///   pickFolder {}                            → {rootPath, rootName, files:[{path,name,relPath,dir,ext,size}]} | {canceled}
///   stat       {path}                        → {exists, size}
///   readChunk  {path, offset, length}        → {data(base64), bytesRead}
///   writeChunk {path, dataBase64, append}    → {ok, size}   (restricted to the media root)
///   mediaRoot  {}                            → {path}
final class FileStoreHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = FileStoreHandler()

    private let grantedKey = "KadokiGrantedPaths"
    private(set) var grantedPaths: Set<String>

    let mediaRoot: URL

    override init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kadoki", isDirectory: true)
            .appendingPathComponent("media", isDirectory: true)
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        self.mediaRoot = appSupport
        self.grantedPaths = Set(UserDefaults.standard.stringArray(forKey: grantedKey) ?? [])
        super.init()
    }

    /// The scheme handler consults this before serving an absolute path.
    func isPathAllowed(_ path: String) -> Bool {
        let p = (path as NSString).standardizingPath
        if p.hasPrefix(mediaRoot.path) { return true }
        return grantedPaths.contains { p == $0 || p.hasPrefix($0 + "/") }
    }

    private func grant(_ path: String) {
        grantedPaths.insert((path as NSString).standardizingPath)
        UserDefaults.standard.set(Array(grantedPaths), forKey: grantedKey)
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
        switch op {
        case "pickFile":   pickFile(req, replyHandler)
        case "pickFolder": pickFolder(replyHandler)
        case "stat":       stat(req, replyHandler)
        case "readChunk":  readChunk(req, replyHandler)
        case "writeChunk": writeChunk(req, replyHandler)
        case "mediaRoot":  replyHandler(["path": mediaRoot.path], nil)
        case "granted":    replyHandler(["paths": Array(grantedPaths)], nil)
        default:           replyHandler(nil, "unknown op \(op)")
        }
    }

    // MARK: - Pickers

    private func contentTypes(forKind kind: String?) -> [UTType]? {
        let exts: [String]
        switch kind {
        case "epub":  exts = ["epub", "txt", "apkg"]
        case "audio": exts = ["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "flac"]
        case "image": exts = ["png", "jpg", "jpeg", "webp", "gif"]
        default:      return nil // any file
        }
        return exts.compactMap { UTType(filenameExtension: $0) }
    }

    private func pickFile(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            if let types = self.contentTypes(forKind: req["kind"] as? String), !types.isEmpty {
                panel.allowedContentTypes = types
                panel.allowsOtherFileTypes = true
            }
            panel.begin { result in
                guard result == .OK, let url = panel.urls.first else {
                    reply(["canceled": true], nil)
                    return
                }
                self.grant(url.path)
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
                reply(["path": url.path, "name": url.lastPathComponent, "size": size], nil)
            }
        }
    }

    private func pickFolder(_ reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.begin { result in
                guard result == .OK, let root = panel.urls.first else {
                    reply(["canceled": true], nil)
                    return
                }
                self.grant(root.path)
                var files: [[String: Any]] = []
                let fm = FileManager.default
                if let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                                          options: [.skipsHiddenFiles]) {
                    for case let url as URL in en {
                        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                        let rel = String(url.path.dropFirst(root.path.count + 1))
                        let dir = (rel as NSString).deletingLastPathComponent
                        files.append([
                            "path": url.path,
                            "name": url.lastPathComponent,
                            "relPath": rel,
                            "dir": dir,
                            "ext": url.pathExtension.lowercased(),
                            "size": (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0,
                        ])
                    }
                }
                reply(["rootPath": root.path, "rootName": root.lastPathComponent, "files": files], nil)
            }
        }
    }

    // MARK: - IO

    private func stat(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let path = req["path"] as? String else { reply(nil, "stat: no path"); return }
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
        let size = exists ? ((try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0) : 0
        reply(["exists": exists, "size": size], nil)
    }

    private func readChunk(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let path = req["path"] as? String,
              let offset = req["offset"] as? Int,
              let length = req["length"] as? Int else { reply(nil, "readChunk: bad args"); return }
        guard isPathAllowed(path) else { reply(nil, "readChunk: path not granted"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let fh = FileHandle(forReadingAtPath: path) else {
                DispatchQueue.main.async { reply(nil, "readChunk: cannot open") }
                return
            }
            defer { try? fh.close() }
            do {
                try fh.seek(toOffset: UInt64(offset))
                let data = try fh.read(upToCount: length) ?? Data()
                DispatchQueue.main.async {
                    reply(["data": data.base64EncodedString(), "bytesRead": data.count], nil)
                }
            } catch {
                DispatchQueue.main.async { reply(nil, "readChunk: \(error.localizedDescription)") }
            }
        }
    }

    private func writeChunk(_ req: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let path = req["path"] as? String,
              let b64 = req["dataBase64"] as? String,
              let data = Data(base64Encoded: b64) else { reply(nil, "writeChunk: bad args"); return }
        let append = (req["append"] as? Bool) ?? false
        // Writes only land inside the app's media root.
        let std = (path as NSString).standardizingPath
        guard std.hasPrefix(mediaRoot.path) else { reply(nil, "writeChunk: outside media root"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let url = URL(fileURLWithPath: std)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if append, FileManager.default.fileExists(atPath: std) {
                    let fh = try FileHandle(forWritingTo: url)
                    defer { try? fh.close() }
                    try fh.seekToEnd()
                    try fh.write(contentsOf: data)
                } else {
                    try data.write(to: url)
                }
                let size = (try? FileManager.default.attributesOfItem(atPath: std)[.size] as? Int) ?? 0
                DispatchQueue.main.async { reply(["ok": true, "size": size], nil) }
            } catch {
                DispatchQueue.main.async { reply(nil, "writeChunk: \(error.localizedDescription)") }
            }
        }
    }
}
