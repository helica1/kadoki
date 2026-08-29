# visionOS Immersive Theatre — implementation plan

Goal: a "cinema" button in the video player. The room fades to black and the
episode plays on a huge curved screen floating in darkness — no window, no
glass — with the existing subtitle panel (word gaze-glow + dictionary) and
in-space transport. This is the true resolution of "kill the frame".

## Phase 0 — space-opening prototype (the only uncertain piece)
- Open an ImmersiveSpace from the UIKit/Capacitor app. Primary route: the
  XROS 26 SDK's UIKit↔SwiftUI scene bridging (UIHostingSceneDelegate-style);
  fallback: the scene-delegate tricks already proven in this app (dict
  window, volumetric scene role).
- Rules: ONE immersive space per app (currently unused in Kadoki ✓).
  Mixed immersion first (windows stay visible), full immersion behind a
  setting.
- Exit paths: cinema button toggles; Digital Crown always exits — handle
  onImmersionChange so playback state survives.

## Phase 1 — the cinema (one focused session)
- Port GridPlayer's ImmersiveView structure (/player, working reference):
  space lifecycle, video-on-geometry, RealityKit attachment controls.
- Screen: our existing curvedPanel mesh at theatre scale (~5–6 m wide at
  ~4 m), same materials — flat VideoMaterial / stereo packedTexture. The
  whole 2D/3D pipeline (incl. splat + settings) carries over unchanged.
- Environment: darkness is 90% of the effect — black surround, optional
  subtle floor reflection + vignette (Apple-TV-cinema style). No modeled
  theatre assets in this phase.
- Subtitles: the existing KadokiSubsPanel attachment under/over the screen,
  scaled up. Inside an immersive space attachments get gaze/pinch through
  RealityKit routing — none of the window-era UIKit-layering fights.
- Transport: minimal in-space attachment bar (play/pause, prev/next cue,
  replay, exit) — GridPlayer's tile-bar pattern.
- Dictionary v1: mixed immersion keeps the ornament panel usable; in full
  immersion, pause-and-peek (temporary).

## Phase 2 — polish (second session)
- Dictionary fully in-space: point the existing ghost-DOM → native panel
  mirror (kvMirrorPopupToPanel pipeline) at an in-space attachment.
- Screen size / distance / curvature controls on the settings card;
  persistence of theatre preferences.
- Episode/subtitle browser reachable in-space (attachment or auto-drop to
  mixed immersion).
- Optional set dressing: low-poly seat silhouettes / licensed USDZ; skip
  unless it earns its keep.

## Risks / gotchas to carry in
- UIKit→ImmersiveSpace bridge is the one genuine unknown — prototype FIRST.
- Simulator harness works for immersive spaces (GridPlayer develops there);
  keep using KADOKI_SIM_* flags + screenshots before device rounds.
- Audio session/backgrounding: entering/leaving the space must not disturb
  the place-invariant machinery (positions save through it).
- The window app keeps running underneath — videoSurface/cinema chrome must
  disable while the space owns playback display.

## Sibling milestone (queued alongside): Anki export via AnkiConnect-over-LAN
Plan recorded in memory (project_visionos_plan.md): Mac runs desktop Anki +
AnkiConnect (webBindAddress 0.0.0.0, CORS capacitor://localhost); Kadoki adds
a configurable host setting; export = storeMediaFile (video-frame screenshot
via AVAssetImageGenerator + AudioSlicer clip) + addNote; deck/model/field
pickers via AnkiConnect endpoints. Est. one evening.
