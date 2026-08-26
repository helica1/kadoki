import Foundation
import WebKit
import UniformTypeIdentifiers

/// Serves kadoki://localhost so the page gets a stable origin (persistent
/// localStorage + IndexedDB), mirroring how Capacitor serves
/// capacitor://localhost on iOS. Two route families:
///   /<path>          → the bundled www/ folder (app assets)
///   /__abs?p=<path>  → an absolute filesystem path (imported media, slices),
///                      gated by FileStoreHandler's grant list, streamed with
///                      HTTP Range support so <audio> can seek multi-hour
///                      audiobooks without loading them into memory.
final class KadokiSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "kadoki"

    private let wwwRoot: URL
    private var stoppedTasks = Set<ObjectIdentifier>()
    private let stoppedLock = NSLock()

    override init() {
        // Debug builds serve www LIVE from the repo so any edit made for the
        // mobile apps is immediately the Mac app's content too (relaunch or
        // ⌘R — no rebuild, no sync step). #filePath is baked in at compile
        // time: macos/Kadoki/SchemeHandler.swift → ../../../www. Release
        // builds (or a moved repo) fall back to the bundled snapshot.
        var root = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true)
        #if DEBUG
        let devRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Kadoki/
            .deletingLastPathComponent()   // macos/
            .deletingLastPathComponent()   // my-app/
            .appendingPathComponent("www", isDirectory: true)
        if FileManager.default.fileExists(atPath: devRoot.appendingPathComponent("index.html").path) {
            root = devRoot
        }
        #endif
        guard let resolved = root else {
            fatalError("www folder missing from bundle resources")
        }
        self.wwwRoot = resolved
        super.init()
    }

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        stoppedLock.lock()
        defer { stoppedLock.unlock() }
        return stoppedTasks.contains(ObjectIdentifier(task))
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }

        if url.path == "/__abs" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let absPath = comps?.queryItems?.first(where: { $0.name == "p" })?.value ?? ""
            serveAbsolute(path: absPath, task: urlSchemeTask)
            return
        }

        var relPath = url.path
        if relPath.isEmpty || relPath == "/" { relPath = "/index.html" }
        let fileURL = wwwRoot.appendingPathComponent(String(relPath.dropFirst())).standardizedFileURL
        guard fileURL.path.hasPrefix(wwwRoot.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive(Data("Not found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let mime = Self.mimeType(for: fileURL.pathExtension.lowercased())
        // Serve the requested byte range when asked (apkg-reader probes this).
        if let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           let range = Self.parseRange(rangeHeader, total: data.count) {
            let slice = data.subdata(in: range)
            let headers = [
                "Content-Type": mime,
                "Content-Length": "\(slice.count)",
                "Content-Range": "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)",
                "Accept-Ranges": "bytes",
            ]
            let resp = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive(slice)
        } else {
            let headers = [
                "Content-Type": mime,
                "Content-Length": "\(data.count)",
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            ]
            let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive(data)
        }
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stoppedLock.lock()
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
        stoppedLock.unlock()
    }

    // MARK: - Absolute-path media serving (chunk-streamed, Range-aware)

    private func serveAbsolute(path rawPath: String, task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = (rawPath as NSString).standardizingPath
        guard !path.isEmpty, FileStoreHandler.shared.isPathAllowed(path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let total = attrs[.size] as? Int, total >= 0 else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(resp)
            task.didReceive(Data("Not found".utf8))
            task.didFinish()
            return
        }

        let mime = Self.mimeType(for: (path as NSString).pathExtension.lowercased())
        let rangeHeader = task.request.value(forHTTPHeaderField: "Range")
        let parsed = rangeHeader.flatMap { Self.parseRange($0, total: total) }
        let range = parsed ?? 0..<total

        var headers = [
            "Content-Type": mime,
            "Content-Length": "\(range.count)",
            "Accept-Ranges": "bytes",
        ]
        var status = 200
        if parsed != nil {
            status = 206
            headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(total)"
        }
        guard let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self, !self.isStopped(task) else { return }
            guard let fh = FileHandle(forReadingAtPath: path) else {
                DispatchQueue.main.async {
                    if !self.isStopped(task) { task.didFailWithError(URLError(.cannotOpenFile)) }
                }
                return
            }
            defer { try? fh.close() }
            DispatchQueue.main.sync {
                if !self.isStopped(task) { task.didReceive(resp) }
            }
            var remaining = range.count
            var offset = UInt64(range.lowerBound)
            let CHUNK = 4 * 1024 * 1024
            while remaining > 0 {
                if self.isStopped(task) { return }
                let toRead = min(CHUNK, remaining)
                guard (try? fh.seek(toOffset: offset)) != nil,
                      let data = try? fh.read(upToCount: toRead), !data.isEmpty else { break }
                DispatchQueue.main.sync {
                    if !self.isStopped(task) { task.didReceive(data) }
                }
                offset += UInt64(data.count)
                remaining -= data.count
            }
            DispatchQueue.main.sync {
                if !self.isStopped(task) { task.didFinish() }
            }
        }
    }

    private static func parseRange(_ header: String, total: Int) -> Range<Int>? {
        // "bytes=start-end" or "bytes=start-"
        guard header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",")[0]
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, let start = Int(parts[0]) else { return nil }
        let end = Int(parts[1]).map { min($0, total - 1) } ?? (total - 1)
        guard start >= 0, start <= end, start < total else { return nil }
        return start..<(end + 1)
    }

    private static func mimeType(for ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "txt": return "text/plain"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "mp3": return "audio/mpeg"
        case "m4a", "m4b": return "audio/mp4"
        case "aac": return "audio/aac"
        case "ogg", "oga": return "audio/ogg"
        case "opus": return "audio/ogg"
        case "flac": return "audio/flac"
        case "wav": return "audio/wav"
        case "mp4", "m4v": return "video/mp4"
        case "pdf": return "application/pdf"
        case "epub": return "application/epub+zip"
        case "srt", "vtt": return "text/plain"
        case "xml": return "application/xml"
        default:
            if let ut = UTType(filenameExtension: ext), let mime = ut.preferredMIMEType { return mime }
            return "application/octet-stream"
        }
    }
}
