import Foundation
import Capacitor

/**
 * ArchiveExtractor — stream-parse a .tar file dropped into our Documents
 * directory and unpack it into Documents/<destSubdir>/.
 *
 * Why: the user's yomichan audio archive is ~4 GB across ~334 zip files.
 * Dragging the unpacked form into Finder Files Sharing is slow (per-file
 * handshake overhead); dragging one .tar is fast. We just need a streaming
 * tar reader on-device.
 *
 * Why not .tar.xz directly: Apple's Compression framework's COMPRESSION_LZMA
 * handles raw LZMA1 blocks but NOT the XZ container format that tar.xz uses
 * (XZ wraps LZMA blocks in stream headers / block checks / index records;
 * stripping it correctly is significant code). The user's Mac has `xz` —
 * one shell command does the conversion: `xz -d local-yomichan.tar.xz`.
 * The resulting .tar is what we accept here. Same content; trivially
 * cheaper iOS implementation. We can layer .tar.gz support on later via
 * COMPRESSION_ZLIB if needed.
 *
 * JS API:
 *   extractTar({ srcPath, destSubdir, deleteSrcOnSuccess? })
 *     → { ok, bytesIn, bytesOut, fileCount, destDir }
 *   Events: "progress" { bytesIn, bytesOut, fileCount, totalIn, pct }
 *
 * Approximate time on iPhone 17 Pro Max: 20–40 sec for 4–5 GB of
 * mp3-in-zip data (mostly disk write, CPU is trivial without
 * decompression).
 */
@objc(ArchiveExtractorPlugin)
public class ArchiveExtractorPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ArchiveExtractorPlugin"
    public let jsName = "ArchiveExtractor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "extractTar", returnType: CAPPluginReturnPromise),
    ]

    private let workQueue = DispatchQueue(label: "ArchiveExtractor.work", qos: .userInitiated)

    @objc func extractTar(_ call: CAPPluginCall) {
        let srcPath = call.getString("srcPath")
        let srcUri  = call.getString("srcUri")
        NSLog("[ArchiveExtractor] extractTar called srcPath=\(srcPath ?? "nil")[len=\(srcPath?.count ?? 0)] srcUri=\(srcUri?.prefix(80) ?? "nil")")
        guard (srcPath != nil && !srcPath!.isEmpty)
           || (srcUri  != nil && !srcUri!.isEmpty)
        else {
            NSLog("[ArchiveExtractor] rejecting: no srcPath/srcUri")
            call.reject("srcPath or srcUri required"); return
        }
        let destSubdir = call.getString("destSubdir") ?? "yomichan-audio"
        let deleteSrcOnSuccess = call.getBool("deleteSrcOnSuccess") ?? false

        guard let docsURL = try? FileManager.default.url(
            for: .documentDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ) else {
            call.reject("Could not resolve Documents directory"); return
        }
        let destDir = docsURL.appendingPathComponent(destSubdir, isDirectory: true)

        workQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                try FileManager.default.createDirectory(at: destDir,
                                                        withIntermediateDirectories: true)
                // Resolve source URL + claim security-scoped access if the
                // file lives outside our sandbox.
                var sourceURL: URL
                var scopedURL: URL? = nil
                var startedScope = false
                if let path = srcPath, !path.isEmpty {
                    sourceURL = URL(fileURLWithPath: path)
                } else if let uri = srcUri, !uri.isEmpty,
                          let resolved = self.resolveBookmarkedURI(uri) {
                    sourceURL = resolved
                    scopedURL = resolved
                    startedScope = resolved.startAccessingSecurityScopedResource()
                } else {
                    throw NSError(domain: "ArchiveExtractor", code: 5,
                                  userInfo: [NSLocalizedDescriptionKey: "Could not resolve source URL"])
                }
                defer {
                    if startedScope, let s = scopedURL {
                        s.stopAccessingSecurityScopedResource()
                    }
                }
                let result = try self.streamExtractTar(src: sourceURL, destDir: destDir)
                if deleteSrcOnSuccess {
                    try? FileManager.default.removeItem(at: sourceURL)
                }
                call.resolve([
                    "ok":        true,
                    "bytesIn":   result.bytesIn,
                    "bytesOut":  result.bytesOut,
                    "fileCount": result.fileCount,
                    "destDir":   destDir.path
                ])
            } catch {
                NSLog("[ArchiveExtractor] failed: \(error.localizedDescription)")
                call.reject("Extract failed: \(error.localizedDescription)")
            }
        }
    }

    /// Look up a previously-picked URI in the FileAccessNativePlugin's
    /// bookmark store and resolve it to a URL. Cross-plugin coupling is
    /// awkward but acceptable here — both plugins live in the App target
    /// and we want to avoid duplicating the bookmark logic.
    private func resolveBookmarkedURI(_ uri: String) -> URL? {
        let key = "FileAccess.bookmarks.v1"
        guard let data = UserDefaults.standard.data(forKey: key),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            NSLog("[ArchiveExtractor] no FileAccess bookmarks stored")
            return nil
        }
        guard let entry = array.first(where: { ($0["uri"] as? String) == uri }),
              let bmStr = entry["bookmark"] as? String,
              let bm    = Data(base64Encoded: bmStr) else {
            NSLog("[ArchiveExtractor] no bookmark for uri \(uri.prefix(80))")
            return nil
        }
        var stale = false
        do {
            let url = try URL(resolvingBookmarkData: bm, options: [],
                              relativeTo: nil, bookmarkDataIsStale: &stale)
            return url
        } catch {
            NSLog("[ArchiveExtractor] bookmark resolve failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Streaming pipeline

    private struct ExtractResult {
        let bytesIn: Int
        let bytesOut: Int
        let fileCount: Int
    }

    private func streamExtractTar(src: URL, destDir: URL) throws -> ExtractResult {
        // Read directly from the input FileHandle in deterministic chunks.
        // The earlier implementation accumulated bytes into a growing Data
        // buffer and used `removeFirst(...)` to consume the front — that is
        // O(remaining_count) per call, so for an archive with hundreds of
        // thousands of entries the cost becomes O(n²) and the extract
        // never finishes. Now we read exactly what we need each time:
        // 512 B for the header, then the entry body, then the padding.
        let inputFH = try FileHandle(forReadingFrom: src)
        defer { try? inputFH.close() }
        let totalIn = (try? FileManager.default.attributesOfItem(atPath: src.path)[.size] as? Int) ?? 0

        NSLog("[ArchiveExtractor] streaming start, totalIn=\(totalIn)")

        var bytesIn = 0
        var bytesOut = 0
        var fileCount = 0
        var lastProgressBytesIn = 0
        // Progress every ~50 MB or 50 events, whichever's coarser. Each
        // event hops the Capacitor bridge to JS; flooding it backed up
        // memory on the previous run.
        let progressBytesEvery = max(50_000_000, totalIn / 50)
        let bodyChunk = 256 * 1024  // 256 KB body read

        // Resident-memory probe. Lets us spot accumulation early instead
        // of waiting for jetsam to kick in.
        func residentMB() -> Int {
            var info = mach_task_basic_info()
            var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
            let kerr: kern_return_t = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                    task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
                }
            }
            return kerr == KERN_SUCCESS ? Int(info.resident_size) / (1024 * 1024) : -1
        }

        // Helper: read EXACTLY n bytes or throw. Returns nil if EOF.
        func readExactly(_ n: Int) throws -> Data? {
            var collected = Data()
            collected.reserveCapacity(n)
            while collected.count < n {
                let want = n - collected.count
                let chunk = try inputFH.read(upToCount: want) ?? Data()
                if chunk.isEmpty { return collected.isEmpty ? nil : collected }
                collected.append(chunk)
            }
            return collected
        }

        // Wrap the outer loop in autoreleasepool so the Foundation NSData
        // objects produced by FileHandle.read get released every iteration.
        // Without this they accumulate in the thread's autorelease pool
        // until iOS jetsam fires (the user hit this on a 4 GB archive).
        var aborted = false
        while !aborted {
            try autoreleasepool {
                guard let header = try readExactly(512) else {
                    aborted = true
                    return
                }
                bytesIn += header.count
                if header.allSatisfy({ $0 == 0 }) {
                    NSLog("[ArchiveExtractor] done — fileCount=\(fileCount) bytesIn=\(bytesIn) bytesOut=\(bytesOut)")
                    aborted = true
                    return
                }
                guard let entry = TarEntry.parse(header) else {
                    NSLog("[ArchiveExtractor] malformed header at \(bytesIn), aborting")
                    throw NSError(domain: "ArchiveExtractor", code: 3,
                                  userInfo: [NSLocalizedDescriptionKey: "Malformed tar header at byte \(bytesIn)"])
                }

                var pendingFH: FileHandle? = nil
                switch entry.type {
                case .directory:
                    let dirURL = destDir.appendingPathComponent(entry.safeName, isDirectory: true)
                    try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
                case .regularFile:
                    let fileURL = destDir.appendingPathComponent(entry.safeName)
                    let parent = fileURL.deletingLastPathComponent()
                    try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                    FileManager.default.createFile(atPath: fileURL.path, contents: nil)
                    pendingFH = try? FileHandle(forWritingTo: fileURL)
                    if pendingFH == nil {
                        throw NSError(domain: "ArchiveExtractor", code: 4,
                                      userInfo: [NSLocalizedDescriptionKey: "Could not open output file: \(entry.safeName)"])
                    }
                    fileCount += 1
                case .other:
                    pendingFH = nil
                }

                // Stream the entry body. Each chunk's autorelease scope is
                // bounded by the inner autoreleasepool below.
                var remaining = entry.size
                while remaining > 0 {
                    try autoreleasepool {
                        let want = min(remaining, bodyChunk)
                        guard let chunk = try inputFH.read(upToCount: want), !chunk.isEmpty else {
                            throw NSError(domain: "ArchiveExtractor", code: 6,
                                          userInfo: [NSLocalizedDescriptionKey: "Unexpected EOF inside entry \(entry.safeName)"])
                        }
                        bytesIn += chunk.count
                        if let fh = pendingFH {
                            try fh.write(contentsOf: chunk)
                            bytesOut += chunk.count
                        }
                        remaining -= chunk.count

                        if bytesIn - lastProgressBytesIn >= progressBytesEvery {
                            lastProgressBytesIn = bytesIn
                            let pct = totalIn > 0 ? Double(bytesIn) / Double(totalIn) : 0.0
                            let rss = residentMB()
                            NSLog("[ArchiveExtractor] progress %.1f%% bytesIn=%d files=%d residentMB=%d",
                                  pct * 100, bytesIn, fileCount, rss)
                            notifyListeners("progress", data: [
                                "bytesIn":   bytesIn,
                                "bytesOut":  bytesOut,
                                "fileCount": fileCount,
                                "totalIn":   totalIn,
                                "pct":       pct
                            ])
                        }
                    }
                }

                if entry.padding > 0 {
                    _ = try inputFH.read(upToCount: entry.padding)
                    bytesIn += entry.padding
                }
                // Force the bytes we just wrote to disk before moving on.
                // Without synchronize(), iOS may keep the writes cached in
                // memory across many files and trigger jetsam.
                try? pendingFH?.synchronize()
                try? pendingFH?.close()
            }
        }
        return ExtractResult(bytesIn: bytesIn, bytesOut: bytesOut, fileCount: fileCount)
    }
}

// MARK: - Tar entry header parsing

private struct TarEntry {
    enum EntryType { case regularFile, directory, other }
    let safeName: String
    let size: Int
    let type: EntryType
    var padding: Int { (512 - (size % 512)) % 512 }

    static func parse(_ header: Data) -> TarEntry? {
        // Tar header (USTAR variant): name 0..100, size 124..136 (octal text),
        // typeflag at 156, prefix 345..500 (USTAR long names).
        let name = readASCIIz(header, offset: 0, length: 100)
        let sizeStr = readASCIIz(header, offset: 124, length: 12)
            .trimmingCharacters(in: .whitespaces)
        guard let size = Int(sizeStr, radix: 8) else { return nil }
        let typeFlag = header[156]
        let prefix = readASCIIz(header, offset: 345, length: 155)
        var full = name
        if !prefix.isEmpty { full = prefix + "/" + name }
        // Refuse any path that tries to escape destDir via ../ — simplest
        // protection that matches what tar(1) does by default.
        if full.contains("..") || full.hasPrefix("/") {
            return nil
        }
        let type: EntryType
        switch typeFlag {
        case 0x30, 0x00: type = .regularFile   // '0' or null
        case 0x35:       type = .directory     // '5'
        default:         type = .other
        }
        return TarEntry(safeName: full, size: size, type: type)
    }

    private static func readASCIIz(_ data: Data, offset: Int, length: Int) -> String {
        let slice = data.subdata(in: offset..<(offset + length))
        let nullIdx = slice.firstIndex(of: 0) ?? slice.endIndex
        let upToNull = slice.subdata(in: 0..<nullIdx)
        return String(data: upToNull, encoding: .utf8)
            ?? String(data: upToNull, encoding: .ascii)
            ?? ""
    }
}
