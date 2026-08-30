# Video Playback Passoff — how Kadoki plays video (including mkv, which "iOS doesn't support")

Written 2026-08-29. Covers the visionOS video player shipped on `main` (feature
commit `894ca8a`). This is the "how did we get files to actually play" story;
the 3D/stereo rendering and subtitle systems have their own notes
(`3D_QUALITY_HANDOFF.md`, `docs/vision-immersive-theatre-plan.md`, memory
`project_video_titles.md`).

---

## 1. The core trick: a video is just an audiobook with pictures

There is no separate "video pipeline" in the app layer. A video file is stored
as the Title's `attachments.audiobook` with an `isVideo: true` flag. That one
decision meant the entire existing audio stack came along for free:

- SRT cue engine, cue-per-card model, karaoke highlighting
- Resume floors / never-lose-place guards
- AudioSlicer (for clip export)
- The transport, stats, history — everything keyed off "the audiobook"

The web layer (`my-app/www/video-mode.js`) detects a video Title, tags
`body.kadoki-video-title`, and streams the layout geometry to native via a
`videoSurface` bridge call (600ms tick). Native positions an actual video
layer where the page says the screen should be.

### Native playback abstraction

`BackgroundAudioPlugin` used to hold an `AVAudioPlayer` directly. It now holds
a `player: KadokiPlayback?` protocol
(`currentTime / duration / isPlaying / rate / volume / play / pause / stop /
setVolume(fadeDuration:)`):

- `AVAudioPlayer` conforms via a bare extension (audio path unchanged).
- `KadokiVideoPlayer` (new) wraps `AVPlayer` and conforms too.

So the plugin's whole state machine — interruptions, Now Playing, position
ticks, natural-end handling — drives video without knowing it's video.

`KadokiVideoPlayer` gotchas learned the hard way:

- Setting `AVPlayer.rate` on a *paused* player **starts playback**. Cache the
  rate and apply it only while playing.
- `AVPlayer` has no volume fade — implemented a `DispatchSourceTimer` ramp to
  match `setVolume(fadeDuration:)`.
- `AVURLAssetPreferPreciseDurationAndTimingKey: true` — same VBR-seek lesson
  as audio (memory `project_audio_vbr_mp3_fix`).
- `audioTimePitchAlgorithm = .timeDomain` for pitch-correct speed changes.

### Rendering (one paragraph, see memory for the saga)

Two hosts: **flat 2D** = SwiftUI `AVPlayerLayer` host inserted *under* the
WKWebView (the cinema page is transparent, so DOM subtitles + WebKit's native
gaze highlighting sit on top for free). **Stereo 3D** = RealityKit host
*above* the webview (RealityKit draws over it regardless of UIKit order
anyway), wrapped in a hitTest-gated box so only the subtitle region steals
input. Platform law that cost three attempts: RealityKit **drawing** ignores
UIKit z-order but **input** strictly follows it.

---

## 2. The mkv problem — "iOS doesn't support them"

First attempt at the user's real library (mkv anime rips): the folder import
reported *no playable files*, because `.mkv` wasn't in `VIDEO_EXTS` — and it
wasn't there because **AVFoundation genuinely cannot open a Matroska
container**. `AVPlayer`/`AVURLAsset` fail on `.mkv` no matter what's inside.
This is the "iOS doesn't support them" moment.

The key realization (and why Moon Player / Skybox play them "perfectly"):
**the container is unsupported, not the content.** Anime mkvs are almost
always H.264 or HEVC video + AAC/AC3/FLAC audio — codecs Apple decodes in
hardware. Those players ship their own demuxer. We don't need to *decode*
anything, just re-wrap the bitstreams into an MP4 container:

> mkv → mp4 **lossless remux**. No transcoding, no quality loss, no thermal
> cost — it runs at disk speed (GB file in a few seconds).

### Implementation: embedded minimal ffmpeg

`my-app/ios/App/App/Remux/`:

- **`build-remux.sh`** — cross-compiles ffmpeg 7.1's `libavformat` +
  `libavcodec` + `libavutil` as static libs for `arm64-apple-xros2.0`
  (also a macOS target for testing). Configured with `--disable-everything`
  and then enabling *only*: matroska demuxer, mp4/mov muxers, file protocol,
  h264/hevc/aac/ac3 parsers, `extract_extradata` bsf. Result:
  **`libkadokiremux-xros.a`, ~2.1 MB** — not the usual 30MB+ ffmpeg blob.
- **`kadoki_remux.c`** (~200 lines) — the actual remuxer, exposed to Swift
  through the bridging header as
  `kadoki_remux(src, dst, errbuf, errlen, progress_cb, opaque)`.

### The three non-obvious problems `kadoki_remux.c` solves

1. **DTS synthesis.** Matroska stores *presentation* timestamps only; packets
   arrive in decode order with `dts = AV_NOPTS_VALUE`, and the mp4 muxer
   refuses packets without dts. Fix: a reorder buffer of depth 6 for video —
   hold 6 packets, and when one leaves the buffer its dts = the smallest pts
   still buffered (classic pts→dts assignment, exact whenever depth ≥ the
   stream's true B-frame reorder depth). Guards clamp `dts ≤ pts` and force
   strict dts monotonicity so a pathological stream still muxes. Audio has no
   reordering: `dts = pts`.
2. **HEVC must be tagged `hvc1`.** The mp4 muxer's default HEVC sample entry
   is `hev1`, which Apple players refuse. Force
   `codec_tag = MKTAG('h','v','c','1')`; the parameter sets from Matroska's
   CodecPrivate land in the `hvcC` box, which is exactly the form AVFoundation
   plays.
3. **Skip the junk tracks.** Subtitle/attachment streams are dropped (Kadoki
   uses external SRTs), and `AV_DISPOSITION_ATTACHED_PIC` cover-art "video"
   streams are skipped — they'd become a broken second video track.

Also: `strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL` so FLAC/Opus audio
tracks (standardized in mp4, but still gated by ffmpeg) remux instead of
failing. If a track truly can't live in mp4 (e.g. DTS audio), the error
surfaces as "mp4 cannot carry a track (codec unsupported)".

### Where it hooks in: the materialize cache

No new import path. `FileAccessPlugin.materializeToCache` (the same call that
copies any attachment to the playable cache) special-cases mkv on visionOS
device builds (`FileAccessPlugin.swift:294`):

- Cache filename becomes `deck_<hash>.mp4` instead of `.mkv`, so everything
  downstream (AVPlayer, AudioSlicer, resume keys) just sees an mp4.
- Cache-hit validation: normal copies require `cacheSize == srcSize`, but a
  remux legitimately differs in size — so remuxed entries are validated by
  mtime + a `> 64KB` sanity check instead. (Size-match was originally added to
  reject truncated iCloud-placeholder copies; don't regress that for
  non-remux files.)
- On remux failure the partial output is deleted and the error string from
  `av_strerror` is surfaced to the web layer.
- Simulator and non-visionOS builds skip remux (`remuxMkv = false`) — the
  static lib is xros-only.

### What stayed unsupported, on purpose

`.avi` / `.wmv` are recognized in `folder-import.js` only so the import can
say *"convert to mp4"* instead of the baffling "no books found". Their codecs
(DivX/Xvid/WMV) have no Apple hardware decoder, so a remux wouldn't help —
that would need real transcoding, which we deliberately did not build.

---

## 3. Rebuilding the remux lib (fresh machine)

ffmpeg 7.1 sources + build outputs live in the session scratchpad (ephemeral);
the compiled `libkadokiremux-xros.a` is **checked into the repo**, so normal
clones need nothing. To rebuild (new ffmpeg, new SDK, or adding codecs):

```sh
# get ffmpeg 7.1 source, place it next to build-remux.sh expectations,
# then from the Remux dir:
./build-remux.sh xros     # → out-xros/lib/*.a
# compile kadoki_remux.c against out-xros/include, ar the .o together with
# libavformat/libavcodec/libavutil into libkadokiremux-xros.a
```

The Xcode target links the `.a` + `libz` (zlib is the only external dep
enabled). `kadoki_remux.h` is in the bridging header.

---

## 4. Chronology / lessons (short version)

1. Video-as-audiobook-attachment made 90% of the feature free — reuse the
   pipeline, don't build a sibling.
2. mp4/mov played immediately via `KadokiVideoPlayer`; mkv looked like a
   dead end ("iOS doesn't support mkv").
3. Distinguishing **container support from codec support** turned "iOS can't
   play it" into a ~200-line, 2MB, disk-speed remux with zero quality loss.
4. The remux slotted into the existing cache layer, so no other code knows
   mkv ever existed.
5. Boundary honestly drawn: remux fixes containers, not codecs — avi/wmv get
   a clear message instead of a false promise.
