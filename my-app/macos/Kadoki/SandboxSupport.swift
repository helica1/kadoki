import AppKit
import Foundation

/// App Sandbox support (Mac App Store build).
///
/// Sandboxed, the app's home is its container (~/Library/Containers/<id>/Data),
/// so three things move:
///  - Library data. container-migration.plist has the system move the
///    pre-sandbox folders into the container on first launch; migrate() then
///    puts the web data where a sandboxed WKWebView looks for it.
///  - Paths saved by the pre-sandbox app point at the REAL home
///    (/Users/<u>/Library/Application Support/Kadoki/…). local() rebases them
///    onto the container so the library keeps finding its media.
///  - Files outside the container are reachable only through security-scoped
///    bookmarks (FileStoreHandler keeps them).
enum KadokiSandbox {
    static let isSandboxed: Bool = ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil

    /// The user's real home folder (NSHomeDirectory() is the container when sandboxed).
    static let realHome: String = {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }()

    /// The pre-sandbox (Developer ID) build's bundle id: its data is migrated in.
    static let legacyBundleId = "com.helica1.kadoki.mac"

    /// Rebase a path the pre-sandbox app saved under the real
    /// ~/Library/Application Support/Kadoki onto the container's copy (same
    /// relative layout after migration). Only Kadoki's own folder: other
    /// ~/Library paths (iCloud Drive's Mobile Documents) are real user files.
    static func local(_ path: String) -> String {
        guard isSandboxed else { return path }
        let legacy = realHome + "/Library/Application Support/Kadoki/"
        guard path.hasPrefix(legacy) else { return path }
        return NSHomeDirectory() + "/Library/Application Support/Kadoki/" + path.dropFirst(legacy.count)
    }

    /// Runs before the web view exists. The system has already moved the legacy
    /// folders into the container (container-migration.plist); slot the legacy
    /// web data in as this app's own (a sandboxed WKWebView keeps its data at
    /// Library/WebKit/WebsiteData, the unsandboxed one under the bundle id).
    static func migrate() {
        guard isSandboxed else { return }
        let fm = FileManager.default
        let lib = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library", isDirectory: true)
        let legacyWeb = lib.appendingPathComponent("WebKit/\(legacyBundleId)/WebsiteData", isDirectory: true)
        let web = lib.appendingPathComponent("WebKit/WebsiteData", isDirectory: true)
        if fm.fileExists(atPath: legacyWeb.path) {
            let hasOwn = fm.fileExists(atPath: web.appendingPathComponent("Default").path)
            if !hasOwn {
                try? fm.createDirectory(at: web.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: web.path) { try? fm.removeItem(at: web) }
                do {
                    try fm.moveItem(at: legacyWeb, to: web)
                    try? fm.removeItem(at: legacyWeb.deletingLastPathComponent())
                    NSLog("[Sandbox] migrated legacy web data")
                } catch {
                    NSLog("[Sandbox] web data migration failed: \(error.localizedDescription)")
                }
            }
        }
        // Legacy UserDefaults (file grants) — read through its own suite.
        let ud = UserDefaults.standard
        if ud.object(forKey: "KadokiLegacyDefaultsMerged") == nil {
            if let old = UserDefaults(suiteName: legacyBundleId)?.stringArray(forKey: "KadokiGrantedPaths"), !old.isEmpty {
                let cur = Set(ud.stringArray(forKey: "KadokiGrantedPaths") ?? [])
                ud.set(Array(cur.union(old)), forKey: "KadokiGrantedPaths")
            }
            ud.set(true, forKey: "KadokiLegacyDefaultsMerged")
        }
    }
}
