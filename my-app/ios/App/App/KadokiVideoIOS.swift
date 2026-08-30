// iOS (iPhone/iPad) flat video host — the phone/tablet counterpart of the
// visionOS FLAT path: an AVPlayerLayer view inserted UNDER the Capacitor
// webview, positioned by the JS videoSurface stream. The cinema page is
// transparent while a video Title plays, so the picture shows through with
// the DOM subtitle panel + touch dictionary on top. No RealityKit, no
// stereo — 2D obeys plain UIKit z-order, which is all iOS needs.
//
// Background listening: AVPlayer pauses a VIDEO track when the app
// backgrounds unless the layer stops displaying it — detach the player from
// the layer on didEnterBackground and re-attach on foreground, so the
// audiobook-style "screen off, keep listening" behavior carries over.
#if os(iOS)
import UIKit
import WebKit
import AVFoundation

final class KadokiVideoIOSHost {
    static let shared = KadokiVideoIOSHost()

    private weak var webView: WKWebView?
    private let videoView = UIView()
    private let playerLayer = AVPlayerLayer()
    private weak var player: AVPlayer?
    private var installed = false
    private var chromeOn = false
    private var savedOpaque = true
    private var savedWebBg: UIColor?
    private var savedContainerBg: UIColor?

    private init() {
        playerLayer.videoGravity = .resizeAspect
        playerLayer.cornerRadius = 14
        playerLayer.masksToBounds = true
        videoView.layer.addSublayer(playerLayer)
        videoView.backgroundColor = .clear
        videoView.isUserInteractionEnabled = false   // all input belongs to the webview
        videoView.isHidden = true
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.playerLayer.player = nil           // keep the audio running
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            guard let self, let p = self.player else { return }
            self.playerLayer.player = p
        }
    }

    func install(webView: WKWebView) {
        self.webView = webView
        attemptInsert()
    }

    // capacitorDidLoad runs before the webview joins the view hierarchy
    // (superview nil there) — retry the insert on every update until it lands.
    private func attemptInsert() {
        guard !installed, let wv = webView, let container = wv.superview else { return }
        installed = true
        container.insertSubview(videoView, belowSubview: wv)
    }

    func adopt(_ p: AVPlayer) {
        player = p
        if playerLayer.player !== p { playerLayer.player = p }
    }

    func clear() {
        player = nil
        playerLayer.player = nil
        videoView.isHidden = true
        applyChrome(false)   // FULL exit — always restore the page's real background here
    }

    /// Apply the JS-streamed anchor rect; returns the CONTAINED video rect
    /// (true aspect from the loaded track) for the DOM subtitle panel.
    /// `visible` shows/hides the actual picture (cheap, instant — flips for
    /// every temporary overlay too). `cinema` is coarser: "still conceptually
    /// in the video layout", used ONLY to decide whether the webview stays
    /// transparent+black — decoupled from `visible` so a menu/modal
    /// temporarily covering the picture doesn't revert the page to its
    /// pre-cinema (e.g. plain white) background.
    /// landscape: true drops the corner rounding — the anchor fills nearly
    /// the whole screen there (cinema/theater layout), where a rounded
    /// frame would read as a floating card instead of true fullscreen.
    /// videoGravity briefly went to resizeAspectFill (crop) in landscape to
    /// close the side pillarbox gap, per feedback that wanted true
    /// edge-to-edge — reverted the SAME day per follow-up feedback ("can we
    /// do it that the video isn't cropped"): back to aspect-FIT
    /// (resizeAspect) in BOTH orientations, so a 16:9 track pillarboxes on
    /// the sides in landscape (screen is wider than 16:9) rather than
    /// losing any picture content.
    func update(frame: CGRect, visible: Bool, cinema: Bool, landscape: Bool = false) -> CGRect {
        attemptInsert()
        if visible {
            if videoView.frame != frame { videoView.frame = frame }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            playerLayer.frame = videoView.bounds
            playerLayer.videoGravity = .resizeAspect
            playerLayer.cornerRadius = landscape ? 0 : 14
            CATransaction.commit()
        }
        videoView.isHidden = !visible
        applyChrome(cinema)
        return containedFrame(in: frame)
    }

    private func containedFrame(in frame: CGRect) -> CGRect {
        var ps = player?.currentItem?.presentationSize ?? .zero
        if !(ps.width > 0 && ps.height > 0) { ps = CGSize(width: 16, height: 9) }
        let s = min(frame.width / ps.width, frame.height / ps.height)
        let w = ps.width * s, h = ps.height * s
        return CGRect(x: frame.midX - w / 2, y: frame.midY - h / 2, width: w, height: h)
    }

    // Cinema chrome: webview transparent (the page's body already goes
    // transparent via the .kadoki-video-title CSS) over a black stage.
    // Restored exactly when the video hides, so every other screen keeps the
    // opaque webview it has always had.
    private func applyChrome(_ on: Bool) {
        guard chromeOn != on, let wv = webView else { return }
        chromeOn = on
        if on {
            savedOpaque = wv.isOpaque
            savedWebBg = wv.backgroundColor
            savedContainerBg = wv.superview?.backgroundColor
            wv.isOpaque = false
            wv.backgroundColor = .clear
            wv.scrollView.backgroundColor = .clear
            wv.superview?.backgroundColor = .black
        } else {
            wv.isOpaque = savedOpaque
            wv.backgroundColor = savedWebBg
            wv.scrollView.backgroundColor = savedWebBg
            wv.superview?.backgroundColor = savedContainerBg
        }
    }
}
#endif
