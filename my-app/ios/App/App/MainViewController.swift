import UIKit
import Capacitor

/**
 * Capacitor 7 does NOT auto-discover plugins compiled into the app target —
 * only ones installed via CocoaPods. To wire our four in-app Swift plugins
 * (BackgroundAudio, AudioSlicer, AnkiBridge, FileAccess) into the bridge,
 * we subclass CAPBridgeViewController and register them in capacitorDidLoad().
 *
 * Main.storyboard's root view controller is set to this class (customModule=App).
 */
class MainViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        guard let bridge = self.bridge else {
            NSLog("[MainViewController] bridge nil at capacitorDidLoad — cannot register plugins")
            return
        }
        bridge.registerPluginInstance(BackgroundAudioPlugin())
        bridge.registerPluginInstance(AudioSlicerPlugin())
        bridge.registerPluginInstance(AnkiBridgePlugin())
        bridge.registerPluginInstance(FileAccessNativePlugin())
        bridge.registerPluginInstance(ArchiveExtractorPlugin())
        NSLog("[MainViewController] registered 5 app-target plugins")

        // Boot the AnkiMediaServer eagerly while we're guaranteed to be on
        // the main thread (CAPBridgeViewController lifecycle). GCDWebServer
        // asserts main-thread in -startWithOptions:, so doing this lazily
        // from the AnkiBridge plugin queue would either SIGABRT (no wrap)
        // or freeze for many seconds (DispatchQueue.main.sync deadlock with
        // WebKit's IPC). Starting at launch sidesteps both.
        AnkiMediaServer.shared.start()
    }
}
