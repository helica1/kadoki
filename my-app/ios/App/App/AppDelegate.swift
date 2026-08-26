import UIKit
import Capacitor
#if os(visionOS)
import SwiftUI

// URL opens under the SCENE lifecycle. Opting into scenes (see
// configurationForConnecting) means iOS delivers incoming URLs to
// scene(_:openURLContexts:) / connectionOptions.urlContexts and NEVER to
// application(_:open:options:) — which is where AnkiMobile's x-success /
// x-error / anki-info bounces were handled. On Vision every Anki send
// therefore ended in "No reply from AnkiMobile" even though the note was
// added. Every scene delegate forwards here.
func kadokiSceneOpenURLs(_ contexts: Set<UIOpenURLContext>) {
    for ctx in contexts { AppDelegate.routeIncomingURL(ctx.url) }
}
/// Cold launch via URL: the bridge (and AnkiBridgePlugin's observer) doesn't
/// exist yet, so stash it exactly as the legacy didFinishLaunching path does;
/// AnkiBridgePlugin.load() drains it.
func kadokiStashLaunchURLs(_ options: UIScene.ConnectionOptions) {
    if let u = options.urlContexts.first?.url {
        NSLog("[AppDelegate] scene cold-launch url: \(u.absoluteString)")
        AppDelegate.pendingLaunchUrl = u.absoluteString
    }
}

// Scene delegates (visionOS ONLY — iOS keeps the legacy AppDelegate window
// lifecycle untouched). The main scene recreates the storyboard boot that
// the legacy path performed; the dict scene hosts the undocked dictionary
// window (system-moveable + resizable).
class KadokiMainSceneDelegate: NSObject, UIWindowSceneDelegate {
    static weak var currentScene: UIWindowScene?
    var window: UIWindow?
    private var lastGeoRequest: TimeInterval = 0
    // Geometry sanity: normalize an absurd restored size (e.g. a stale
    // dict-window-sized 480pt main) back to a proper reading window, and
    // keep the webview's frame glued to the scene bounds. Timer-based
    // rechecks kept LOSING the race with restoration (the system applies
    // restored geometry whenever it pleases after connect), so this also
    // runs from didUpdateCoordinateSpace — every geometry change the system
    // makes flows through there, however late it lands.
    private func normalizeIfCrushed(_ ws: UIWindowScene) {
        let sz = ws.coordinateSpace.bounds.size
        let now = Date().timeIntervalSince1970
        if sz.width > 0 && (sz.width < 750 || sz.height < 550) && now - lastGeoRequest > 1.0 {
            lastGeoRequest = now
            ws.requestGeometryUpdate(UIWindowScene.GeometryPreferences.Vision(size: CGSize(width: 1180, height: 860)))
        }
        // Belt-and-suspenders: the webview must always match the window.
        if let w = self.window, w.frame.size != ws.coordinateSpace.bounds.size {
            w.frame = ws.coordinateSpace.bounds
        }
    }
    func windowScene(_ windowScene: UIWindowScene, didUpdate previousCoordinateSpace: UICoordinateSpace, interfaceOrientation previousInterfaceOrientation: UIInterfaceOrientation, traitCollection previousTraitCollection: UITraitCollection) {
        normalizeIfCrushed(windowScene)
    }
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        // SINGLE main window, ever. Scene restoration after a multi-window
        // session can resurrect a second main scene (the "two Kadokis, one in
        // the background" boot) — two webviews would fight over storage and
        // audio. First one wins; extras are destroyed on arrival.
        if KadokiMainSceneDelegate.currentScene != nil {
            UIApplication.shared.requestSceneSessionDestruction(session, options: nil, errorHandler: nil)
            return
        }
        KadokiMainSceneDelegate.currentScene = ws
        kadokiStashLaunchURLs(connectionOptions)   // BEFORE the bridge boots
        let w = UIWindow(windowScene: ws)
        w.rootViewController = UIStoryboard(name: "Main", bundle: nil).instantiateInitialViewController()
        window = w
        w.makeKeyAndVisible()
        // Floor the size so menus/tabs can never be crushed out of view.
        ws.sizeRestrictions?.minimumSize = CGSize(width: 760, height: 560)
        normalizeIfCrushed(ws)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.normalizeIfCrushed(ws) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in self?.normalizeIfCrushed(ws) }
    }
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) { kadokiSceneOpenURLs(URLContexts) }
    // Closing the MAIN window takes the floating dictionary with it — the two
    // always live and die together (also prevents a lone dict window from
    // being the last scene standing and getting restored at next launch).
    func sceneDidDisconnect(_ scene: UIScene) {
        NSLog("[KadokiPanel] MAIN scene disconnected (isCurrent=\(KadokiMainSceneDelegate.currentScene === scene))")
        if KadokiMainSceneDelegate.currentScene === scene { KadokiMainSceneDelegate.currentScene = nil }
        if let s = KadokiDictSceneDelegate.session {
            UIApplication.shared.requestSceneSessionDestruction(s, options: nil, errorHandler: nil)
        }
        for (_, s) in KadokiPanelSceneDelegate.sessions {
            UIApplication.shared.requestSceneSessionDestruction(s, options: nil, errorHandler: nil)
        }
    }
}

// One window per panel KIND (timeline / summary / characters) — each hosts its
// own WKWebView on the app's own origin (see KadokiPanelHost). Sessions are
// tracked by kind so re-tapping "pop out" focuses the existing window instead of
// stacking duplicates.
class KadokiPanelSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) { kadokiSceneOpenURLs(URLContexts) }
    static var sessions: [String: UISceneSession] = [:]
    var window: UIWindow?
    private var kind = ""
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        // RESTORED panel session (a cold relaunch resurrecting a popped-out
        // panel as the app's only scene): same "orphaned window" hazard the
        // dictionary window guards against. A real pop-out always arrives with
        // a FRESH activity carrying its kind.
        let act = connectionOptions.userActivities.first { $0.activityType == "com.helica1.yama.panelwin" }
        guard let act = act, let k = act.userInfo?["kind"] as? String, !k.isEmpty else {
            UIApplication.shared.requestSceneSessionDestruction(session, options: nil, errorHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                if KadokiMainSceneDelegate.currentScene == nil {
                    UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil, errorHandler: nil)
                }
            }
            return
        }
        kind = k
        KadokiPanelSceneDelegate.sessions[k] = session
        NSLog("[KadokiPanel] scene connected: \(k); main=\(KadokiMainSceneDelegate.currentScene != nil)")
        let w = UIWindow(windowScene: ws)
        w.rootViewController = UIHostingController(rootView: KadokiPanelWindowView(kind: k))
        window = w
        w.makeKeyAndVisible()
        ws.sizeRestrictions?.minimumSize = CGSize(width: 420, height: 480)
        ws.requestGeometryUpdate(UIWindowScene.GeometryPreferences.Vision(
            size: CGSize(width: k == "timeline" ? 900 : 640, height: 900)))
    }
    func sceneDidDisconnect(_ scene: UIScene) {
        guard !kind.isEmpty else { return }
        let k = kind
        KadokiPanelSceneDelegate.sessions.removeValue(forKey: k)
        NSLog("[KadokiPanel] scene disconnected: \(k); main=\(KadokiMainSceneDelegate.currentScene != nil)")
        // DEFERRED off this call stack on purpose. Everything downstream of this
        // notification touches WebKit and the Capacitor bridge; doing that
        // synchronously while the system is tearing the scene down is unsafe.
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Notification.Name("KadokiPanelClosed"),
                                            object: nil, userInfo: ["kind": k])
            // Never let closing a panel leave the app with no scene at all —
            // that is what terminates it. If the main window somehow isn't
            // around any more, summon one instead of going away.
            if KadokiMainSceneDelegate.currentScene == nil {
                NSLog("[KadokiPanel] no main scene after closing \(k) — reactivating one")
                UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil, errorHandler: nil)
            }
        }
    }
}

/// DIAGNOSTIC (temporary): hosts the volumetric-scene test for spatial card
/// pictures. See KadokiSpatialVolumeView.
class KadokiSpatialVolumeSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) { kadokiSceneOpenURLs(URLContexts) }
    static var session: UISceneSession?
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        KadokiSpatialVolumeSceneDelegate.session = session
        let w = UIWindow(windowScene: ws)
        w.rootViewController = UIHostingController(rootView: KadokiSpatialVolumeView())
        window = w
        w.makeKeyAndVisible()
        NSLog("[KadokiSpatial] VOLUME scene connected role=\(session.role.rawValue)")
    }
    func sceneDidDisconnect(_ scene: UIScene) {
        KadokiSpatialVolumeSceneDelegate.session = nil
    }
}

class KadokiDictSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) { kadokiSceneOpenURLs(URLContexts) }
    static weak var session: UISceneSession?
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        // RESTORED dict session (cold relaunch resurrecting the floating
        // window as the app's only scene — the "orphaned dictionary" boot):
        // a legitimate undock always arrives with a FRESH user activity.
        // Discard the stale session and make sure a MAIN window exists.
        let fresh = connectionOptions.userActivities.contains { $0.activityType == "com.helica1.yama.dictwin" }
        if !fresh {
            UIApplication.shared.requestSceneSessionDestruction(session, options: nil, errorHandler: nil)
            // Summon a main window ONLY if none exists (racing the restored
            // main scene here is what produced a duplicate Kadoki).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                if KadokiMainSceneDelegate.currentScene == nil {
                    UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil, errorHandler: nil)
                }
            }
            return
        }
        KadokiDictSceneDelegate.session = session
        KadokiDictModel.shared.docked = false   // the window EXISTS now — ornament may let go
        let w = UIWindow(windowScene: ws)
        w.rootViewController = UIHostingController(rootView: KadokiDictWindowView())
        window = w
        w.makeKeyAndVisible()
        ws.sizeRestrictions?.minimumSize = CGSize(width: 340, height: 360)
        ws.requestGeometryUpdate(UIWindowScene.GeometryPreferences.Vision(size: CGSize(width: 480, height: 640)))
    }
    func sceneDidDisconnect(_ scene: UIScene) {
        // Window closed by the user (or re-dock) → dictionary returns to the
        // docked ornament on the next lookup.
        KadokiDictModel.shared.docked = true
    }
}
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // If a URL COLD-LAUNCHES us (e.g. AnkiMobile's infoForAdding x-success after
    // iOS evicted us), the AnkiBridge plugin's AnkiBridgeAppUrlOpen observer
    // isn't attached yet, so the open-url notification would be lost. Stash the
    // launch URL here; AnkiBridgePlugin.load() drains it once the observer exists.
    static var pendingLaunchUrl: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if let url = launchOptions?[.url] as? URL {
            AppDelegate.pendingLaunchUrl = url.absoluteString
        }
        return true
    }

    #if os(visionOS)
    // Present ONLY on visionOS: implementing this opts the app into the scene
    // lifecycle (required for the second dictionary window). iOS never sees
    // it and keeps the legacy single-window boot.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if options.userActivities.contains(where: { $0.activityType == "com.helica1.yama.panelwin" }) {
            let cfg = UISceneConfiguration(name: "KadokiPanel", sessionRole: connectingSceneSession.role)
            cfg.delegateClass = KadokiPanelSceneDelegate.self
            return cfg
        }
        if options.userActivities.contains(where: { $0.activityType == "com.helica1.yama.spatialvol" }) {
            let cfg = UISceneConfiguration(name: "KadokiSpatialVolume", sessionRole: connectingSceneSession.role)
            cfg.delegateClass = KadokiSpatialVolumeSceneDelegate.self
            return cfg
        }
        if options.userActivities.contains(where: { $0.activityType == "com.helica1.yama.dictwin" }) {
            let cfg = UISceneConfiguration(name: "KadokiDict", sessionRole: connectingSceneSession.role)
            cfg.delegateClass = KadokiDictSceneDelegate.self
            return cfg
        }
        let cfg = UISceneConfiguration(name: "KadokiMain", sessionRole: connectingSceneSession.role)
        cfg.delegateClass = KadokiMainSceneDelegate.self
        return cfg
    }
    #endif

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    /// One router for every way a URL can reach us (legacy app delegate on
    /// iOS, scene delegates on visionOS). Posts the notification AnkiBridgePlugin
    /// listens for — it avoids the @capacitor/app dependency, which isn't
    /// installed — then lets Capacitor's proxy see it too.
    @discardableResult
    static func routeIncomingURL(_ url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        NSLog("[AppDelegate] open url: \(url.absoluteString)")
        NotificationCenter.default.post(
            name: Notification.Name("AnkiBridgeAppUrlOpen"),
            object: nil,
            userInfo: ["url": url.absoluteString]
        )
        return ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: options)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return AppDelegate.routeIncomingURL(url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
