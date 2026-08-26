// LiveView.swift — "On iPhone": mirrors whatever is currently playing on the
// phone, computed from tiny streamed clock frames (Phase B). Reuses the same
// karaoke rendering and adaptive-tick contract as PlayerView (local
// playback), but is DISPLAY-ONLY: it never writes pos_<id> — the phone owns
// the playhead. The only watch→phone write here is the flag gesture.
//
//   tap / swipe DOWN = remote-toggle play/pause on the phone
//   swipe UP          = flag the CURRENT SUBTITLE → phone lookup history
//   swipe LEFT/RIGHT  = previous/next subtitle cue (phone-side seek — the
//                       phone still owns the playhead; this just asks it to
//                       jump, same as the lock-screen ⏮⏭ buttons)
import SwiftUI
import UIKit
import WatchKit

struct LiveView: View {
    @ObservedObject var live = LiveSessionModel.shared
    @State private var flash: String?
    @Environment(\.isLuminanceReduced) private var lowLum

    private let accent = Color(red: 0.72, green: 0.58, blue: 0.96)   // Kadoki audio lavender

    private var isPlaying: Bool { live.frame?.playing ?? false }

    // Same adaptive tick contract as PlayerView: display-rate while active,
    // 1 Hz in Always-On, effectively idle when nothing is playing.
    private var tickInterval: Double {
        guard isPlaying else { return 3600 }
        return lowLum ? 1.0 : 0.08
    }

    var body: some View {
        VStack(spacing: 6) {
            TimelineView(.periodic(from: .now, by: tickInterval)) { context in
                subtitleView(now: context.date)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 6) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(live.frame == nil ? "" : (isPlaying ? "Playing" : "Paused"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let f = flash {
                Text(f)
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .gesture(tapAndSwipeGesture)
        .navigationTitle(live.titleName.isEmpty ? "On iPhone" : live.titleName)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { WatchConnectivityManager.shared.requestLiveSubStart() }
    }

    // A DragGesture with a non-zero minimumDistance claims a touch the
    // instant it begins, and never calls onEnded if the touch doesn't reach
    // that distance — so a genuine stationary tap gets silently swallowed
    // rather than falling through to a separate TapGesture (confirmed: even
    // .simultaneousGesture(TapGesture()) didn't help, since the touch was
    // already claimed). One minimumDistance:0 DragGesture, discriminating in
    // onEnded, avoids the competition entirely.
    //
    // Classify by testing for a clear directional swipe FIRST and treating
    // everything else (including down-swipes) as a tap/toggle — a real tap
    // on a small watch screen carries more incidental jitter than a tight
    // distance threshold allows for, so a "must be nearly still" check left
    // a dead zone where a real tap matched no branch and did nothing
    // (confirmed: swipe worked, tap silently did not).
    //   clear horizontal swipe → previous/next subtitle cue (phone-side seek)
    //   clear upward swipe     → flag the current subtitle
    //   anything else          → tap/down-swipe: remote-toggle play/pause
    private var tapAndSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onEnded { v in
                let dx = v.translation.width, dy = v.translation.height
                let horizontalDominant = abs(dx) > abs(dy)
                if horizontalDominant, abs(dx) > 24 {
                    jumpCue(dx > 0 ? 1 : -1)
                } else if !horizontalDominant, dy < -24 {
                    flagCurrentSubtitle()
                } else {
                    togglePlayPause()
                }
            }
    }

    private func togglePlayPause() {
        WKInterfaceDevice.current().play(.click)
        WatchConnectivityManager.shared.sendLiveCommand("togglePlayPause") { reason in
            showFlash("Toggle failed: " + reason)
        }
    }

    // dir: 1 = next cue, -1 = previous cue. The phone still owns the
    // playhead — this just asks it to jump, same as the lock-screen ⏮⏭
    // buttons (WatchBridgePlugin relays into BackgroundAudio's own
    // "remoteCommand" nextCue/prevCue channel, so the watch rides the exact
    // lock-screen JS path — no duplicate seek logic here).
    private func jumpCue(_ dir: Int) {
        WKInterfaceDevice.current().play(.click)
        WatchConnectivityManager.shared.sendLiveCommand(dir > 0 ? "nextCue" : "prevCue") { reason in
            showFlash("Jump failed: " + reason)
        }
    }

    private func flagCurrentSubtitle() {
        guard let f = live.frame else { showFlash("Nothing playing"); return }
        let ms = LiveSessionModel.displayMs(for: f)
        guard let idx = WatchKaraoke.cueIndex(atMs: ms, in: live.cues) else {
            showFlash("No subtitle here")
            return
        }
        let cue = live.cues[idx]
        WatchConnectivityManager.shared.sendWordFlag(
            titleId: f.titleId, word: "", cueText: cue.text, sMs: cue.s, eMs: cue.e)
        WKInterfaceDevice.current().play(.success)
        showFlash("Flagged ✓")
    }

    private func showFlash(_ text: String) {
        withAnimation { flash = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation { flash = nil }
        }
    }

    @ViewBuilder
    private func subtitleView(now: Date) -> some View {
        if let f = live.frame {
            let ms = LiveSessionModel.displayMs(for: f, now: now)
            if live.cues.isEmpty {
                Text("Syncing subtitles…")
                    .foregroundStyle(.tertiary)
                    .font(.footnote)
            } else if let idx = WatchKaraoke.cueIndex(atMs: ms, in: live.cues) {
                let cue = live.cues[idx]
                if lowLum {
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
                        .shadow(color: .black, radius: 3, x: 0, y: 1)
                        .shadow(color: .black.opacity(0.7), radius: 8, x: 0, y: 2)
                        .shadow(color: accent.opacity(isPlaying && !lowLum ? 0.55 : 0.0), radius: 8)
                        .shadow(color: accent.opacity(isPlaying && !lowLum ? 0.25 : 0.0), radius: 16)
                }
            } else {
                Text("…").foregroundStyle(.tertiary)
            }
        } else {
            Text("Nothing playing on iPhone")
                .foregroundStyle(.tertiary)
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
    }
}
