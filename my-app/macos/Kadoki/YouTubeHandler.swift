import Foundation
import AVFoundation
import WebKit

#if KADOKI_YT
/// YouTube Collections (Mac only, never in App Store builds — guideline 5.2.3).
///
/// Runs the bundled yt-dlp folder build (Contents/Resources/yt-dlp, signed with
/// the sandbox-inherit entitlement by the build phase) and joins downloaded
/// audio with AVFoundation, so no ffmpeg is needed.
///
/// One {op, ...} request/reply contract (like kadokiCloud). Progress events go
/// out through KadokiEvents as plugin "YouTube".
///   probe    {urls:[String]}            → {entries:[{id,title,duration,url}]}
///   download {id, dir, subs:Bool}       → {audio, subs?}   (events "progress")
///   thumb    {id, dest}                 → {path, dataUri}
///   concat   {inputs:[path], output}    → {output, durationsMs:[Int]}
///   remove   {path}                     → {ok}
final class YouTubeHandler: NSObject, WKScriptMessageHandlerWithReply {
    private let queue = DispatchQueue(label: "kadoki.youtube", qos: .userInitiated, attributes: .concurrent)

    override init() {
        super.init()
        #if DEBUG
        if ProcessInfo.processInfo.environment["KADOKI_YT_SELFTEST"] == "1" { selfTest() }
        #endif
    }

    private struct YTError: LocalizedError {
        let errorDescription: String?
        init(_ s: String) { errorDescription = s }
    }

    static var ytdlp: URL? {
        let u = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/yt-dlp/yt-dlp_macos")
        return FileManager.default.isExecutableFile(atPath: u.path) ? u : nil
    }

    static var ffmpeg: URL? {
        let u = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/ffmpeg/ffmpeg")
        return FileManager.default.isExecutableFile(atPath: u.path) ? u : nil
    }

    /// Working folder inside the container: downloads land here before they
    /// are joined and moved into the iCloud library.
    static var workDir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kadoki/youtube", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            replyHandler(nil, "bad request"); return
        }
        handle(req) { v, e in DispatchQueue.main.async { replyHandler(v, e) } }
    }

    func handle(_ req: [String: Any], reply: @escaping ([String: Any]?, String?) -> Void) {
        let op = req["op"] as? String ?? ""
        queue.async {
            do {
                switch op {
                case "available": reply(["available": Self.ytdlp != nil && Self.ffmpeg != nil, "workDir": Self.workDir.path], nil)
                case "probe":     reply(try self.probe(req["urls"] as? [String] ?? []), nil)
                case "download":  reply(try self.download(req), nil)
                case "thumb":     reply(try self.thumb(req), nil)
                case "concat":    reply(try self.concat(req), nil)
                case "shrink":    reply(try self.shrink(req), nil)
                case "remove":
                    if let p = req["path"] as? String, p.hasPrefix(Self.workDir.path) { try? FileManager.default.removeItem(atPath: p) }
                    reply(["ok": true], nil)
                default: throw YTError("unknown op \(op)")
                }
            } catch {
                reply(nil, error.localizedDescription)
            }
        }
    }

    // MARK: - yt-dlp

    /// Runs yt-dlp; `onLine` gets each stdout line as it arrives.
    @discardableResult
    private func run(_ args: [String], exe: URL? = YouTubeHandler.ytdlp, onLine: ((String) -> Void)? = nil) throws -> (out: String, err: String) {
        guard let exe = exe else { throw YTError("yt-dlp/ffmpeg is not bundled in this build") }
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["TMPDIR"] = FileManager.default.temporaryDirectory.path   // the onefile build unpacks here
        p.environment = env
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        var out = Data(), err = Data()
        let lock = NSLock()
        var pending = ""
        outPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { return }
            lock.lock(); out.append(d); lock.unlock()
            if let onLine = onLine, let s = String(data: d, encoding: .utf8) {
                pending += s
                while let r = pending.range(of: "\n") {
                    let line = String(pending[..<r.lowerBound]); pending = String(pending[r.upperBound...])
                    onLine(line)
                }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { lock.lock(); err.append(d); lock.unlock() }
        }
        try p.run()
        p.waitUntilExit()
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        out.append(outPipe.fileHandleForReading.readDataToEndOfFile())
        err.append(errPipe.fileHandleForReading.readDataToEndOfFile())
        let o = String(data: out, encoding: .utf8) ?? "", e = String(data: err, encoding: .utf8) ?? ""
        if p.terminationStatus != 0 {
            let msg = e.split(separator: "\n").last(where: { $0.contains("ERROR") }).map(String.init) ?? e.suffix(400).description
            throw YTError("\(exe.lastPathComponent) failed: \(msg)")
        }
        return (o, e)
    }

    /// Videos behind each URL (a playlist expands to its entries, in order).
    private func probe(_ urls: [String]) throws -> [String: Any] {
        var entries: [[String: Any]] = []
        for raw in urls {
            let url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if url.isEmpty { continue }
            let r = try run(["--flat-playlist", "-J", "--no-warnings", url])
            guard let d = r.out.data(using: .utf8),
                  let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            let list = (j["entries"] as? [[String: Any]]) ?? [j]
            for e in list {
                guard let id = e["id"] as? String else { continue }
                entries.append([
                    "id": id,
                    "title": e["title"] as? String ?? id,
                    "duration": (e["duration"] as? Double) ?? 0,
                    "url": "https://www.youtube.com/watch?v=\(id)",
                    "playlist": j["entries"] != nil ? (j["title"] as? String ?? "") : "",
                ])
            }
        }
        return ["entries": entries]
    }

    /// One video, ready to join: audio-only → <id>.m4a (AAC, remuxed out of
    /// YouTube's DASH packaging by yt-dlp's ffmpeg fixup); video → <id>.mp4,
    /// re-encoded ONCE to the Collection format (videoFormat: HEVC 480p by
    /// default), so every part is identical and joins without re-encoding.
    /// Plus YouTube's Japanese subtitles (manual "ja" if any, else automatic).
    private func download(_ req: [String: Any]) throws -> [String: Any] {
        guard let id = req["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{6,20}$", options: .regularExpression) != nil
        else { throw YTError("bad video id") }
        guard let ff = Self.ffmpeg else { throw YTError("ffmpeg is not bundled in this build") }
        let dir = Self.workDir.appendingPathComponent((req["dir"] as? String ?? "misc").replacingOccurrences(of: "/", with: "_"), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let wantVideo = req["video"] as? Bool == true
        let fmt = Self.videoFormat(req)
        let url = "https://www.youtube.com/watch?v=\(id)"
        func push(_ stage: String, _ pct: Double) {
            DispatchQueue.main.async { KadokiEvents.push?("YouTube", "progress", ["id": id, "stage": stage, "percent": pct]) }
        }
        var args = ["--no-playlist", "--newline", "--no-warnings", "--ffmpeg-location", ff.path,
                    "--progress-template", "download:PCT %(progress._percent_str)s",
                    "-o", dir.appendingPathComponent("\(id).src.%(ext)s").path]
        if wantVideo {
            // H.264 + AAC, ≤1080p; yt-dlp merges them (a remux, no re-encode).
            // Source: the smallest H.264 stream at or above the target height
            // (it's re-encoded anyway) — less to download, same result.
            let H = fmt.height
            args = ["-f", "bv*[vcodec^=avc1][height>=\(H)][height<=\(max(H, 720))]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[vcodec^=avc1][ext=mp4]",
                    "-S", "+res", "--merge-output-format", "mp4"] + args
        } else {
            args = ["-f", "ba[ext=m4a]/140"] + args
        }
        if req["subs"] as? Bool == true {
            args += ["--write-subs", "--write-auto-subs", "--sub-langs", "ja,ja-orig", "--sub-format", "json3"]
        }
        try run(args + [url]) { line in
            guard let r = line.range(of: "PCT ") else { return }
            let pct = Double(line[r.upperBound...].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "%", with: "")) ?? 0
            push("download", pct)
        }
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        guard let src = files.first(where: { $0.hasPrefix(id + ".src.") && ($0.hasSuffix(".mp4") || $0.hasSuffix(".m4a")) }) else {
            throw YTError("no usable \(wantVideo ? "H.264 video" : "M4A audio") for \(id)")
        }
        let srcURL = dir.appendingPathComponent(src)
        let outURL = dir.appendingPathComponent("\(id).\(wantVideo ? "mp4" : "m4a")")
        try? FileManager.default.removeItem(at: outURL)
        if wantVideo {
            try encode(srcURL, to: outURL, fmt) { pct in push("encode", pct) }
        } else {
            try FileManager.default.moveItem(at: srcURL, to: outURL)
        }
        try? FileManager.default.removeItem(at: srcURL)
        var out: [String: Any] = ["media": outURL.path, "durationMs": Self.durationMs(outURL)]
        let subs = files.filter { $0.hasPrefix(id + ".src.") && $0.hasSuffix(".json3") }
        if let s = subs.first(where: { $0.hasSuffix(".ja.json3") }) ?? subs.first {
            out["subs"] = dir.appendingPathComponent(s).path
            out["subsText"] = (try? String(contentsOf: dir.appendingPathComponent(s), encoding: .utf8)) ?? ""
        }
        return out
    }

    /// A Collection's video format — every part is encoded exactly like this
    /// so the parts join without re-encoding. codec "hevc" (default: half
    /// the size of H.264 for the same picture; every iPhone since the 7
    /// decodes it in hardware) or "h264" (Collections made before HEVC).
    struct VideoFormat { let codec: String; let height: Int; let width: Int; let kbps: Int }
    static func videoFormat(_ req: [String: Any]) -> VideoFormat {
        let codec = (req["codec"] as? String) == "h264" ? "h264" : "hevc"
        let h = (req["height"] as? Int) ?? 480
        let H = h >= 1080 ? 1080 : (h >= 720 ? 720 : 480)
        let W = H == 1080 ? 1920 : (H == 720 ? 1280 : 854)
        // Talking-head / podcast video: these rates look clean in HEVC.
        let hevc = H == 1080 ? 1500 : (H == 720 ? 800 : 450)
        let h264 = H == 1080 ? 5000 : (H == 720 ? 2500 : 1000)
        return VideoFormat(codec: codec, height: H, width: W, kbps: codec == "hevc" ? hevc : h264)
    }
    /// Re-encode to the Collection format: W×H letterboxed, 30 fps, fixed
    /// GOP, hardware encoder; audio copied untouched (same length to the
    /// millisecond, so every saved position stays valid).
    private func encode(_ src: URL, to out: URL, _ f: VideoFormat, progress: @escaping (Double) -> Void) throws {
        guard let ff = Self.ffmpeg else { throw YTError("ffmpeg is not bundled in this build") }
        let durMs = Self.durationMs(src)
        let vf = "scale=\(f.width):\(f.height):force_original_aspect_ratio=decrease,pad=\(f.width):\(f.height):(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
        var v: [String]
        if f.codec == "hevc" {
            v = ["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1", "-profile:v", "main"]
        } else {
            v = ["-c:v", "h264_videotoolbox", "-profile:v", "high"]
        }
        v += ["-b:v", "\(f.kbps)k", "-maxrate", "\(f.kbps * 2)k", "-bufsize", "\(f.kbps * 4)k", "-g", "60"]
        try? FileManager.default.removeItem(at: out)
        try run(["-hide_banner", "-nostdin", "-y", "-i", src.path, "-map", "0:v:0", "-map", "0:a:0", "-vf", vf] + v +
                ["-c:a", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out.path],
                exe: ff) { line in
            if line.hasPrefix("out_time_ms="), durMs > 0, let us = Double(line.dropFirst(12)) { progress(min(100, us / 1000 / durMs * 100)) }
        }
    }
    /// Shrink an existing Collection file to another format (in = its iCloud
    /// file, out = the work folder; the caller moves it back).
    private func shrink(_ req: [String: Any]) throws -> [String: Any] {
        guard let input = req["input"] as? String, let output = req["output"] as? String, output.hasPrefix(Self.workDir.path) else {
            throw YTError("input and an output in the work folder are required")
        }
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: output).deletingLastPathComponent(), withIntermediateDirectories: true)
        let f = Self.videoFormat(req)
        try encode(URL(fileURLWithPath: input), to: URL(fileURLWithPath: output), f) { pct in
            DispatchQueue.main.async { KadokiEvents.push?("YouTube", "progress", ["stage": "encode", "percent": pct]) }
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: output)
        return ["output": output, "durationMs": Self.durationMs(URL(fileURLWithPath: output)),
                "inputMs": Self.durationMs(URL(fileURLWithPath: input)), "size": (attrs?[.size] as? Int) ?? 0]
    }

    static func durationMs(_ u: URL) -> Double {
        let a = AVURLAsset(url: u, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let d = CMTimeGetSeconds(a.duration)
        return d.isFinite ? d * 1000 : 0
    }

    /// The video's thumbnail (hqdefault always exists; maxres often doesn't).
    private func thumb(_ req: [String: Any]) throws -> [String: Any] {
        guard let id = req["id"] as? String else { throw YTError("id required") }
        var data: Data?
        for q in ["maxresdefault", "sddefault", "hqdefault"] {
            guard let u = URL(string: "https://i.ytimg.com/vi/\(id)/\(q).jpg") else { continue }
            let sem = DispatchSemaphore(value: 0)
            var got: Data?
            URLSession.shared.dataTask(with: u) { d, resp, _ in
                if (resp as? HTTPURLResponse)?.statusCode == 200, let d = d, d.count > 2000 { got = d }
                sem.signal()
            }.resume()
            _ = sem.wait(timeout: .now() + 20)
            if let g = got { data = g; break }
        }
        guard let jpg = data else { throw YTError("no thumbnail for \(id)") }
        return ["dataUri": "data:image/jpeg;base64," + jpg.base64EncodedString()]
    }

    /// Joins parts end to end into one file with ffmpeg's concat demuxer —
    /// a stream copy (no re-encode): every part is already in the same
    /// format (download() normalizes video; YouTube's AAC is uniform). For an
    /// append, inputs[0] is the existing Collection file. Returns each
    /// input's duration (the timeline positions are measured on).
    private func concat(_ req: [String: Any]) throws -> [String: Any] {
        let inputs = (req["inputs"] as? [String]) ?? []
        guard !inputs.isEmpty, let output = req["output"] as? String, output.hasPrefix(Self.workDir.path) else {
            throw YTError("inputs and an output in the work folder are required")
        }
        guard let ff = Self.ffmpeg else { throw YTError("ffmpeg is not bundled in this build") }
        let outURL = URL(fileURLWithPath: output)
        let list = outURL.deletingPathExtension().appendingPathExtension("txt")
        let esc = { (p: String) in "file '" + p.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        try inputs.map(esc).joined(separator: "\n").write(to: list, atomically: true, encoding: .utf8)
        let durations = inputs.map { Int(Self.durationMs(URL(fileURLWithPath: $0)).rounded()) }
        let total = Double(durations.reduce(0, +))
        try? FileManager.default.removeItem(at: outURL)
        try run(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list.path,
                 "-map", "0", "-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outURL.path],
                exe: ff) { line in
            if line.hasPrefix("out_time_ms="), total > 0, let us = Double(line.dropFirst(12)) {
                let pct = min(100, us / 1000 / total * 100)
                DispatchQueue.main.async { KadokiEvents.push?("YouTube", "progress", ["stage": "join", "percent": pct]) }
            }
        }
        try? FileManager.default.removeItem(at: list)
        let video = !AVURLAsset(url: outURL).tracks(withMediaType: .video).isEmpty
        return ["output": output, "durationsMs": durations, "video": video, "totalMs": Int(Self.durationMs(outURL).rounded())]
    }

    #if DEBUG
    /// KADOKI_YT_SELFTEST=1: two different short videos → download (audio +
    /// video + subs) → thumb → join → "[YTTest]" lines. KADOKI_YT_URL /
    /// KADOKI_YT_URL2 override the videos.
    private func selfTest() {
        let env = ProcessInfo.processInfo.environment
        let urls = [env["KADOKI_YT_URL"] ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    env["KADOKI_YT_URL2"] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
        queue.async {
            NSLog("[YTTest] ytdlp=%@", Self.ytdlp?.path ?? "MISSING")
            do {
                let p = try self.probe(urls)
                let entries = p["entries"] as? [[String: Any]] ?? []
                NSLog("[YTTest] probe → %d entries: %@", entries.count, entries.map { $0["title"] as? String ?? "?" }.joined(separator: " | "))
                var parts: [String] = [], auds: [String] = []
                for e in entries {
                    guard let id = e["id"] as? String else { continue }
                    let d = try self.download(["id": id, "dir": "selftest", "subs": true, "video": true, "height": 480])
                    parts.append(d["media"] as? String ?? "")
                    NSLog("[YTTest] download %@ → %@ %.0f ms, subs=%@", id, ((d["media"] as? String) ?? "-") as NSString, (d["durationMs"] as? Double) ?? 0, (d["subs"] as? String).map { ($0 as NSString).lastPathComponent } ?? "none")
                    let a = try self.download(["id": id, "dir": "selftest", "subs": false, "video": false])
                    auds.append(a["media"] as? String ?? "")
                    let t = try self.thumb(["id": id])
                    NSLog("[YTTest] thumb %@ → %d chars", id, (t["dataUri"] as? String)?.count ?? 0)
                }
                let out = Self.workDir.appendingPathComponent("selftest/joined.mp4").path
                let c = try self.concat(["inputs": parts, "output": out])
                NSLog("[YTTest] concat → %@ total=%@", String(describing: c["durationsMs"] ?? "-"), String(describing: c["totalMs"] ?? "-"))
                let a2 = Self.workDir.appendingPathComponent("selftest/joined.m4a").path
                let c2 = try self.concat(["inputs": auds, "output": a2])
                NSLog("[YTTest] concat audio-only → %@ total=%@", String(describing: c2["durationsMs"] ?? "-"), String(describing: c2["totalMs"] ?? "-"))
                NSLog("[YTTest] done")
            } catch {
                NSLog("[YTTest] FAILED: %@", error.localizedDescription)
            }
        }
    }
    #endif
}
#endif
