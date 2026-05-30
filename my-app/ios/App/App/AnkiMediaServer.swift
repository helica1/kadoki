import Foundation
import GCDWebServer

/**
 * AnkiMediaServer — tiny embedded HTTP server on 127.0.0.1 that exposes
 * media files we want AnkiMobile to fetch. This is the trick Manatan uses
 * to deliver audio/images to AnkiMobile via `anki://x-callback-url/addnote`
 * field URLs without requiring the user to manually link a folder.
 *
 * Flow:
 *   1. AnkiBridgePlugin.addNote writes media bytes to our temp dir via
 *      writeMedia(_:filename:).
 *   2. The plugin builds an anki:// URL with field values like
 *      `http://127.0.0.1:<port>/<filename>`.
 *   3. iOS hands control to AnkiMobile; AnkiMobile fetches the URLs via
 *      regular HTTP GET to loopback (loopback is not sandboxed across apps
 *      on iOS, so this works without entitlements).
 *   4. After AnkiMobile is done, x-success bounces back to us.
 *
 * The server boots lazily on first writeMedia. We keep it running for the
 * app lifetime — the cost is a small thread + a listening socket on a
 * non-privileged port, which is negligible.
 *
 * Port choice: 4569. Manatan uses 4568, so we pick the next number to be
 * polite to users running both apps. The actual port is reported via
 * `url(for:)` so callers don't have to hardcode it.
 */
final class AnkiMediaServer {

    static let shared = AnkiMediaServer()

    private let server = GCDWebServer()
    private let mediaDir: URL
    private(set) var port: UInt = 4569
    private(set) var isRunning = false

    private init() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("anki-media-server", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        mediaDir = dir

        // GCDWebServer matches handlers in LIFO order — last-registered
        // tries first. We want the regex file-server to be the FALLBACK,
        // so register __ping AFTER it. The __ping handler returns "pong"
        // (used by AnkiBridge.addNote to verify the server is reachable
        // before handing AnkiMobile loopback URLs to fetch).
        server.addHandler(forMethod: "GET",
                          pathRegex: "^/(?!__ping$).+$",
                          request: GCDWebServerRequest.self) { [weak self] request in
            guard let self = self else {
                return GCDWebServerErrorResponse(statusCode: 500)
            }
            let raw = request.path
            let trimmed = raw.hasPrefix("/") ? String(raw.dropFirst()) : raw
            if trimmed.contains("..") || trimmed.contains("\\") {
                return GCDWebServerErrorResponse(statusCode: 403)
            }
            if trimmed.isEmpty { return GCDWebServerErrorResponse(statusCode: 404) }
            let fileURL = self.mediaDir.appendingPathComponent(trimmed)
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                NSLog("[AnkiMediaServer] 404 for %{public}@ (mediaDir=%{public}@)", trimmed, self.mediaDir.path)
                return GCDWebServerErrorResponse(statusCode: 404)
            }
            return GCDWebServerFileResponse(file: fileURL.path, byteRange: request.byteRange)
        }
        server.addHandler(forMethod: "GET",
                          path: "/__ping",
                          request: GCDWebServerRequest.self) { _ in
            return GCDWebServerDataResponse(text: "pong")
        }
    }

    /// Boot the server if not already running. MUST be called on the main
    /// thread — GCDWebServer asserts main-thread in -startWithOptions:.
    /// We call this from MainViewController.capacitorDidLoad() at launch,
    /// so by the time AnkiBridge.addNote runs, the server is already up
    /// and addNote doesn't have to dispatch anywhere.
    @discardableResult
    func start() -> Bool {
        if isRunning { return true }
        // Belt and suspenders: if anyone ever calls this off-main, bail out
        // rather than deadlock via DispatchQueue.main.sync (which caused a
        // 40-second freeze on the bridge queue when WebKit's IPC was busy).
        guard Thread.isMainThread else {
            NSLog("[AnkiMediaServer] start() called off-main — refusing to boot")
            return false
        }
        // AutomaticallySuspendInBackground defaults to YES — that would
        // suspend the listening socket the instant we go to background
        // (i.e., the moment AnkiMobile takes over to fetch our media URLs).
        // We need to STAY responsive during the handoff window, so disable.
        // The audio UIBackgroundMode in Info.plist gives us the CPU time;
        // GCDWebServer just needs permission to keep its socket open.
        let options: [String: Any] = [
            GCDWebServerOption_Port: NSNumber(value: self.port),
            GCDWebServerOption_BindToLocalhost: NSNumber(value: true),
            GCDWebServerOption_AutomaticallySuspendInBackground: NSNumber(value: false)
        ]
        do {
            try server.start(options: options)
            isRunning = true
            port = server.port
            NSLog("[AnkiMediaServer] started on http://127.0.0.1:\(server.port)/")
            return true
        } catch {
            NSLog("[AnkiMediaServer] start failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Write bytes to a uniquely-named file in our media dir and return the
    /// HTTP URL AnkiMobile can fetch it from. Returns nil on I/O failure.
    func writeMedia(_ data: Data, suggestedName: String) -> (filename: String, url: URL)? {
        if !isRunning { _ = start() }
        // Sanitize the suggested name + uniquify with a timestamp so two
        // adds in the same session don't collide.
        let ext = (suggestedName as NSString).pathExtension.isEmpty
            ? "bin"
            : (suggestedName as NSString).pathExtension
        let base = ((suggestedName as NSString).deletingPathExtension)
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let filename = "\(stamp)_\(base).\(ext)"
        let fileURL = mediaDir.appendingPathComponent(filename)
        do {
            try data.write(to: fileURL, options: .atomic)
        } catch {
            NSLog("[AnkiMediaServer] write failed: \(error.localizedDescription)")
            return nil
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)/\(filename)") else {
            return nil
        }
        return (filename: filename, url: url)
    }

    /// Tear down the server and re-boot it. iOS sometimes invalidates a
    /// loopback listening socket after long backgrounding (memory pressure,
    /// network condition changes) even when AutomaticallySuspendInBackground
    /// is NO. `isRunning` stays true because we never observed a stop event
    /// — so `start()` short-circuits and returns success while the socket
    /// is actually dead. That's the "Could not connect to server" path
    /// AnkiMobile reports. This method blows away the stale state and
    /// re-runs the boot sequence. Main-thread only (same constraint as
    /// `start()`).
    @discardableResult
    func forceRestart() -> Bool {
        guard Thread.isMainThread else {
            NSLog("[AnkiMediaServer] forceRestart called off-main — refusing")
            return false
        }
        if server.isRunning { server.stop() }
        // Even if isRunning was true but the socket was actually dead,
        // calling stop() is the only safe way to get GCDWebServer back
        // into a re-startable state. Reset the flag either way.
        isRunning = false
        return start()
    }

    /// Block-wait until the server responds to `/__ping` (or timeout).
    /// Returns true on success. Useful as a sanity check from addNote —
    /// if this fails, opening anki:// will produce AnkiMobile's "connection
    /// timed out" error because our server isn't actually reachable.
    func selfPing(timeoutSeconds: TimeInterval = 1.0) -> Bool {
        guard isRunning, let url = URL(string: "http://127.0.0.1:\(port)/__ping") else {
            return false
        }
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: url) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let body = data.flatMap({ String(data: $0, encoding: .utf8) }),
               body == "pong" {
                ok = true
            }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + timeoutSeconds)
        task.cancel()
        if !ok { NSLog("[AnkiMediaServer] selfPing FAILED (port \(port))") }
        return ok
    }

    /// Sweep media files older than `olderThan` seconds. AnkiMobile fetches
    /// almost immediately, so anything older than a minute or two is safe
    /// to drop. Call this periodically or on app foreground.
    func sweepOldFiles(olderThan seconds: TimeInterval = 300) {
        let cutoff = Date().addingTimeInterval(-seconds)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: mediaDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in entries {
            if let attrs = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
               let mod = attrs.contentModificationDate,
               mod < cutoff {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }
}
