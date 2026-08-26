import AppKit
import WebKit

/// Menu item that carries the JavaScript expression it triggers in the web app.
final class JSMenuItem: NSMenuItem {
    var js: String = ""
    convenience init(_ title: String, js: String, key: String = "", modifiers: NSEvent.ModifierFlags = [.command]) {
        self.init(title: title, action: #selector(AppDelegate.runMenuJS(_:)), keyEquivalent: key)
        self.js = js
        self.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
    }
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }

    private var window: NSWindow!
    private(set) var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWebView()
        buildWindow()
        buildMenus()
        // Native → web event push (transcription cues, OAuth redirects, …).
        KadokiEvents.push = { [weak self] plugin, event, payload in
            guard let self = self,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            let js = "window.__kadokiNativeEvent && window.__kadokiNativeEvent('\(plugin)', '\(event)', \(json));"
            DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
        }
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: URL(string: "\(KadokiSchemeHandler.scheme)://localhost/index.html")!))
    }

    // Custom URL scheme callbacks (Google OAuth redirect) → the web layer's
    // App-plugin appUrlOpen listeners.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            KadokiEvents.push?("App", "appUrlOpen", ["url": url.absoluteString])
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - WebView

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(KadokiSchemeHandler(), forURLScheme: KadokiSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let ucc = config.userContentController
        // Flag the platform before any app script runs.
        let boot = """
        window.KADOKI_MAC = true;
        """
        ucc.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Capacitor compatibility shim (FileAccess / BackgroundAudio / AnkiBridge / AudioSlicer).
        if let shimURL = Bundle.main.url(forResource: "mac-shim", withExtension: "js"),
           let shim = try? String(contentsOf: shimURL, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // AnkiConnect proxy — the shim posts a JSON body string; we forward it
        // to the local AnkiConnect server so page-origin CORS never applies.
        ucc.addScriptMessageHandler(AnkiConnectProxy(), contentWorld: .page, name: "kadokiAnkiConnect")
        // Native file store: real on-disk files (pick/stat/read/write) so audio
        // slicing and transcription can operate on actual paths.
        ucc.addScriptMessageHandler(FileStoreHandler.shared, contentWorld: .page, name: "kadokiFile")
        // AVFoundation clip slicing / waveform decoding (AudioSlicer port).
        ucc.addScriptMessageHandler(AudioSlicerHandler(), contentWorld: .page, name: "kadokiSlicer")
        // On-device SpeechAnalyzer transcription (AutoTranscribe port).
        ucc.addScriptMessageHandler(AutoTranscribeHandler(), contentWorld: .page, name: "kadokiTranscribe")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Kadoki"
        window.minSize = NSSize(width: 480, height: 400)
        window.contentView = webView
        window.setFrameAutosaveName("KadokiMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        // Keyboard events (space/arrows) need the web view as first responder
        // from the start — without this they only work after a click.
        window.initialFirstResponder = webView
        window.makeFirstResponder(webView)
        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification,
                                               object: window, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.window.makeFirstResponder(self.webView)
        }
    }

    // MARK: - Menu actions

    @objc func runMenuJS(_ sender: Any?) {
        guard let item = sender as? JSMenuItem, !item.js.isEmpty else { return }
        webView.evaluateJavaScript(item.js, completionHandler: nil)
    }

    @objc func reloadWebView() {
        webView.reload()
    }

    private func buildMenus() {
        let mainMenu = NSMenu()

        // App menu
        let appItem = NSMenuItem(); mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Kadoki", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(JSMenuItem("Preferences…", js: "window.openPreferences && window.openPreferences();", key: ","))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Kadoki", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Kadoki", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // File
        let fileItem = NSMenuItem(); mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(JSMenuItem("Library…", js: "typeof openLibrary==='function' && openLibrary();", key: "l"))
        fileMenu.addItem(JSMenuItem("New Title…", js: "typeof createNewTitle==='function' && createNewTitle();", key: "n"))
        fileMenu.addItem(JSMenuItem("Import Folder…", js: "typeof importFolder==='function' && importFolder();", key: "o"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(JSMenuItem("Print…", js: "window.openPrintDialog && window.openPrintDialog();", key: "p"))
        fileMenu.addItem(JSMenuItem("Log Printed Reading…", js: "window.openLogPrintedReadingDialog && window.openLogPrintedReadingDialog();"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        // Edit (standard responder-chain actions so copy/paste work in the web view)
        let editItem = NSMenuItem(); mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        // View
        let viewItem = NSMenuItem(); mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(JSMenuItem("Timeline & Scenes…", js: "window.bookmarks && window.bookmarks.openMenu && window.bookmarks.openMenu();", key: "t", modifiers: [.command, .shift]))
        viewMenu.addItem(JSMenuItem("Characters…", js: "window.aiCharsScreen && window.aiCharsScreen.open && window.aiCharsScreen.open();", key: "k", modifiers: [.command, .shift]))
        viewMenu.addItem(JSMenuItem("History…", js: "window.bookmarks && window.bookmarks.openHistory && window.bookmarks.openHistory();", key: "y"))
        viewMenu.addItem(JSMenuItem("Lookup History…", js: "window.lookupLog && window.lookupLog.openScreen && window.lookupLog.openScreen();"))
        viewMenu.addItem(JSMenuItem("Stats…", js: "window.openReadingStats && window.openReadingStats();", key: "i"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenu.addItem(.separator())
        viewMenu.addItem(JSMenuItem("Card Mode", js: "window.setShellMode && window.setShellMode('card');", key: "1"))
        viewMenu.addItem(JSMenuItem("Read Mode", js: "window.setShellMode && window.setShellMode('read');", key: "2"))
        viewMenu.addItem(JSMenuItem("Audio Mode", js: "window.setShellMode && window.setShellMode('audio');", key: "3"))
        viewItem.submenu = viewMenu

        // Playback
        let playItem = NSMenuItem(); mainMenu.addItem(playItem)
        let playMenu = NSMenu(title: "Playback")
        playMenu.addItem(JSMenuItem("Play / Pause", js: "window.shellTogglePlay && window.shellTogglePlay();", key: "p", modifiers: [.command, .option]))
        playMenu.addItem(JSMenuItem("Playback Speed…", js: "window.openPlaybackSpeedDialog && window.openPlaybackSpeedDialog();", key: "s", modifiers: [.command, .shift]))
        playMenu.addItem(.separator())
        playMenu.addItem(JSMenuItem("Toggle Reading Timer", js: "window.toggleReadingTimer && window.toggleReadingTimer();"))
        playItem.submenu = playMenu

        // Sync
        let syncItem = NSMenuItem(); mainMenu.addItem(syncItem)
        let syncMenu = NSMenu(title: "Sync")
        syncMenu.addItem(JSMenuItem("Sync Up (Push This Title)", js: "window.driveSyncUI && window.driveSyncUI.syncUp && window.driveSyncUI.syncUp();"))
        syncMenu.addItem(JSMenuItem("Sync Down (Get Latest)", js: "window.driveSyncUI && window.driveSyncUI.syncDown && window.driveSyncUI.syncDown();"))
        syncMenu.addItem(.separator())
        syncMenu.addItem(JSMenuItem("Manage Drive Files…", js: "window.driveSyncUI && window.driveSyncUI.browseDrive && window.driveSyncUI.browseDrive();"))
        syncItem.submenu = syncMenu

        // Window
        let winItem = NSMenuItem(); mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        NSApp.windowsMenu = winMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - WKUIDelegate

    // <input type="file"> (and folder import) → NSOpenPanel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // window.open / target=_blank → default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // JS alert/confirm/prompt need native panels on macOS WKWebView.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { resp in completionHandler(resp == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { resp in
            completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // MARK: - WKNavigationDelegate

    // Top-level navigations to external sites open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           navigationAction.targetFrame?.isMainFrame != false,
           url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
