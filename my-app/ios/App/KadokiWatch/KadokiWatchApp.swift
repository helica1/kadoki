// KadokiWatchApp.swift — Kadoki Apple Watch companion (plan S1: walking
// skeleton). Standalone playback of titles transferred from the iPhone app:
// list transferred titles, play/pause/skip with the audio routed to Bluetooth
// headphones (watchOS long-form audio rule), position checkpointed locally
// and reported back to the phone opportunistically (forward-only merge there).
import SwiftUI

@main
struct KadokiWatchApp: App {
    init() {
        WatchConnectivityManager.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
