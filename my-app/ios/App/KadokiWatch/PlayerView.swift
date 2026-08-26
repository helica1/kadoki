// PlayerView.swift — watch playback screen, Kadoki-gesture edition.
//
//   swipe DOWN  = play / pause
//   swipe LEFT  = back one subtitle      swipe RIGHT = forward one subtitle
//   swipe UP    = flag the CURRENT SUBTITLE → phone lookup history (the user
//                 picks the word to look up there, with full dictionary)
//   crown       = scrub
//
// No button row — the subtitle owns the screen: large glowing text with
// word-by-word karaoke fill from the transferred word timings.
import SwiftUI
import UIKit
import WatchKit

struct PlayerView: View {
    let title: WatchTitle
    @ObservedObject var player = WatchPlayer.shared
    @State private var crownSec: Double = 0
    @State private var crownActive = false
    @State private var flash: String?
    // Always-On (wrist-down) dimmed state: the .animation TimelineView schedule
    // SUSPENDS there, freezing the subtitle entirely. Use a periodic schedule
    // whose interval adapts: display-rate while active, 1 Hz in AOD (the
    // system's AOD budget), effectively idle while paused.
    @Environment(\.isLuminanceReduced) private var lowLum

    private let accent = Color(red: 0.72, green: 0.58, blue: 0.96)   // Kadoki audio lavender

    private var tickInterval: Double {
        guard player.isPlaying else { return 3600 }
        return lowLum ? 1.0 : 0.08
    }

    var body: some View {
        ZStack {
            // Book cover backdrop at 50% opacity (per design), with a dark
            // gradient keeping the subtitle readable over busy art.
            if let cu = title.coverURL, let img = UIImage(contentsOfFile: cu.path) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .opacity(lowLum ? 0.12 : 0.35)
                    .ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.25), .black.opacity(0.65)],
                               startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
            }
            playerContent
        }
    }

    private var playerContent: some View {
        VStack(spacing: 6) {
            // Subtitle — karaoke-filled at display refresh while playing, with
            // a soft accent glow that breathes only during playback.
            TimelineView(.periodic(from: .now, by: tickInterval)) { _ in
                subtitleView()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 6) {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(clock(player.positionSec) + " / " + clock(player.durationSec))
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if let f = flash {
                Text(f)
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .transition(.opacity)
            }
            if !player.statusText.isEmpty {
                Text(player.statusText)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            player.togglePlay()
            WKInterfaceDevice.current().play(.click)
        }
        .gesture(swipeGesture)
        .navigationTitle(title.name)
        .navigationBarTitleDisplayMode(.inline)
        .focusable(true)
        .digitalCrownRotation(
            $crownSec,
            from: 0,
            through: max(1, player.durationSec),
            by: 15,
            sensitivity: .medium,
            isContinuous: false,
            isHapticFeedbackEnabled: true
        )
        .onChange(of: crownSec) { _, v in
            if crownActive { player.seek(toSec: v) }
            crownActive = true
        }
        .onChange(of: player.positionSec) { _, v in
            crownActive = false
            crownSec = v
        }
        .onAppear {
            player.load(title)
            crownActive = false
            crownSec = player.positionSec
        }
    }

    // MARK: - gestures (Kadoki conventions)

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { v in
                let dx = v.translation.width, dy = v.translation.height
                if abs(dy) > abs(dx) {
                    if dy > 0 {
                        player.togglePlay()                      // down = play/pause
                        WKInterfaceDevice.current().play(.click)
                    } else {
                        flagCurrentSubtitle()                    // up = flag subtitle
                    }
                } else {
                    player.jumpCue(dx > 0 ? 1 : -1)              // right = next, left = back
                    WKInterfaceDevice.current().play(.click)
                }
            }
    }

    private func flagCurrentSubtitle() {
        let ms = player.liveSec() * 1000
        guard let idx = player.cueIndex(atMs: ms) else {
            showFlash("No subtitle here")
            return
        }
        let cue = player.cues[idx]
        WatchConnectivityManager.shared.sendWordFlag(
            titleId: title.id, word: "", cueText: cue.text, sMs: cue.s, eMs: cue.e)
        WKInterfaceDevice.current().play(.success)
        showFlash("Flagged ✓")
    }

    private func showFlash(_ text: String) {
        withAnimation { flash = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation { flash = nil }
        }
    }

    // MARK: - subtitle + karaoke

    @ViewBuilder
    private func subtitleView() -> some View {
        let ms = player.liveSec() * 1000
        if let idx = player.cueIndex(atMs: ms) {
            let cue = player.cues[idx]
            if lowLum {
                // Always-On dim state: plain white text (no karaoke attributed
                // rebuild, no glow) — cheapest possible AOD frame.
                Text(cue.text)
                    .foregroundStyle(.white)
                    .font(.system(size: 23, weight: .bold))
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.5)
                    .shadow(color: .black, radius: 3, x: 0, y: 1)
            } else {
            Text(WatchKaraoke.karaokeText(cue: cue, relMs: ms - cue.s))
                .font(.system(size: 23, weight: .bold))
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.5)
                // Drop shadow first (readability over cover art), glow on top.
                .shadow(color: .black, radius: 3, x: 0, y: 1)
                .shadow(color: .black.opacity(0.7), radius: 8, x: 0, y: 2)
                .shadow(color: accent.opacity(player.isPlaying && !lowLum ? 0.55 : 0.0), radius: 8)
                .shadow(color: accent.opacity(player.isPlaying && !lowLum ? 0.25 : 0.0), radius: 16)
            }
        } else {
            Text(player.cues.isEmpty ? "" : "…")
                .foregroundStyle(.tertiary)
        }
    }

    private func clock(_ sec: Double) -> String {
        let t = Int(max(0, sec))
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
