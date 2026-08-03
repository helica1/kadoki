# Apple Watch companion — plan

Goal: listen to a title's audiobook on Apple Watch **without the phone present**
(AirPods), see the current subtitle like a mini audio mode, flag words for
dictionary study from the wrist, and review those lookups later on the phone —
with context — to send to Anki. Positions must obey the app-wide
never-lose-place invariant across both devices.

Status: PLAN ONLY (nothing built). Companion feature S0 (phone lookup history)
is standalone and can ship before any watch work.

---

## Architecture overview

- **watchOS target** added to `ios/App/App.xcodeproj` (SwiftUI, watchOS 10+).
  Pure native Swift — Capacitor has no watchOS story. The watch app ships
  inside the iOS bundle; TestFlight picks it up automatically. Bundle id
  `com.helica1.yama.watchkitapp` under the same team/provisioning.
  NOTE (lesson from PdfExport): `cap sync` never touches Xcode targets — the
  watch target, its files, and its capabilities are maintained by hand in Xcode.
- **WCSession** is the entire phone↔watch data plane. Three channels, each for
  a distinct payload class:
  - `transferFile` — the big stuff: audio + cue bundle per title (queued,
    survives app restarts, opportunistic BT/Wi-Fi).
  - `transferUserInfo` — queued small records that must not be lost: word
    flags from the watch, position checkpoints. Delivered in order when the
    counterpart is reachable.
  - `updateApplicationContext` — latest-wins state snapshot: per-title resume
    positions + furthest, so both sides can adopt on wake without a round trip.
- **Watch storage**: bundles live in the watch app's container. A storage
  screen lists transferred titles with sizes + delete. Expect 100–500 MB per
  m4b; watch capacity is fine for a handful of books.

## Title bundle (phone → watch)

Built on demand from the title editor ("Send to Watch" button; progress UI —
transfers can take tens of minutes to hours; recommend overnight/charger):

```
bundle/
  meta.json    { syncId|titleId, name, durMs, coverThumbB64 (small), sentTs }
  audio.m4b    (the audiobook attachment, as-is — AVFoundation plays what iOS plays)
  cues.json    [ {s, e, text} ... ]  cue times ms + display text
  chapters.json [ {startMs, title} ... ]  (m4b markers, already extracted)
```

- Cues come from the parsed SRT or the AUTO_CUES cache. **Auto-transcribed
  titles: only cues up to the transcription frontier exist** — the bundle
  carries what's there and meta records `cueCoverageMs`; the watch shows
  "no subtitles yet" past it. Transcription itself never runs on watch.
- Word-timing `w` quads deliberately excluded v1 (karaoke on AOD isn't
  practical); revisit later.

## Watch playback engine

- `AVAudioPlayer` over the local file. `AVAudioSession` category `.playback`,
  policy `.longFormAudio`, activated with the async route-picker API — watchOS
  **requires Bluetooth headphones for long-form audio** (watch speaker is not
  available for media). This is a platform rule, not a choice.
- Remote commands + `MPNowPlayingInfoCenter` (cover, title, cue text as the
  now-playing line). Digital crown = scrub; ±1-cue buttons mirror the phone's
  subtitle swipe.
- Position persistence: local UserDefaults checkpoint every 5s while playing
  (same durable-save pattern as BackgroundAudioService) + on pause/route
  change. Watch-side furthest high-water, forward-only.

## Subtitles on watch

- SwiftUI view bound to a 0.5–1 Hz timer (TimelineView) → binary-search cue at
  position → current cue text large, previous cue dimmed above. Always-On
  display updates at 1 Hz — fine for cue granularity.
- Tap the cue → **word picker**: segment the cue with `NLTokenizer`
  (Natural Language framework, on-device, works on watchOS — no dictionary
  needed for segmentation) → tappable word chips.

## Dictionary story (the key design decision)

Full dictionaries stay on the phone (194 MB IndexedDB + deinflection engine —
not portable to watch cheaply). The watch **flags** words; the phone
**resolves** them:

- Tapping a word chip records a flag:
  `{ word, cueText, titleId/syncId, cueStartMs, cueEndMs, ts }` → queued via
  `transferUserInfo` (works offline; delivers on next reachability).
- Phone receives flags → appends to the **lookup history** store (below) with
  `source: 'watch'`.
- OPTIONAL later slice: a mini on-watch dictionary — frequency-trimmed JMdict
  subset (~top 50k entries, SQLite, ~15 MB) + a small Swift deinflector for
  instant definitions on the wrist. Nice-to-have; flags don't need it.

## Phone: dictionary lookup history (S0 — standalone, ships first)

Valuable with or without the watch, and it's the receiving end of watch flags:

- **Store**: `LOOKUP_LOG_V1` (blobStore) — ring buffer (~500 entries):
  `{ term, base, sentence, titleId, titleName, cueStartMs, cueEndMs, ts,
  source: 'phone'|'watch', ankiSentTs? }`.
- **Logging hook**: `_performLookupInner` (enhanced-dictionary.js) already has
  the term + `window.lookupContext` (sentence, cue range, audio path) — one
  append call. Watch flags ingest into the same store.
- **UI**: menu → "Lookup history" (i18n; .kai-modal overlay like Bookmarks):
  rows = word + context sentence (word highlighted) + title + relative time +
  source glyph (⌚ text label for watch — no emoji, use "W" chip or ◷).
  - Tap row → run the normal dictionary popup on that term with
    `window.lookupContext` bound to the stored sentence + cue range — the
    existing **Add to Anki** flow then works unchanged, including the
    waveform editor + audio slice from the original cue times.
  - Delete-swipe rows; "clear all".
- Anki-sent entries get stamped (`ankiSentTs`) so the list shows what's
  already been made into cards (✓).

## Position sync (never-lose-place across devices)

- Watch → phone: furthest + resume checkpoints ride `transferUserInfo` /
  `applicationContext`. Phone ingests via `bookmarks.updateFurthest(titleId,
  ms)` — **already forward-only**, so a stale watch value can never regress
  the phone. A watch listen that advanced past the phone's furthest surfaces
  the same way background listens do today (furthest pin + History entry via
  the existing `_abSynthHistoryEntry` pattern).
- Phone → watch: applicationContext carries per-title `{resumeMs, furthestMs,
  ts}`; watch adopts forward-only on launch/wake, exactly mirroring the
  cold-boot floor rules. Deliberate scrub-backs stay local until fresher-ts,
  same two-guard rule as the phone's furthest floor.
- No cue-index anything crosses devices — **ms only** (the Ring lesson).

## Slices

| # | Slice | Scope | Size |
|---|---|---|---|
| S0 | Phone lookup history | store + logging hook + history screen + re-lookup/Anki | S (ships alone) |
| S1 | Walking skeleton | watch target, WCSession handshake, one-title bundle transfer w/ progress, title list, play/pause/scrub, local position persist | L (the big one) |
| S2 | Subtitles + chapters | cue view, ±cue, chapter list, Now Playing text | M |
| S3 | Position sync | checkpoints + furthest merge both directions, History surfacing | M |
| S4 | Word flagging | NLTokenizer word picker → transferUserInfo → history ingest | M |
| S5 | Mini watch dictionary (optional) | trimmed JMdict SQLite + Swift deinflector | M–L |
| S6 | Polish | storage manager, complication, AOD tuning, transfer retries | M |

Recommended order: **S0 now** (standalone phone value), then S1 → S2 → S3 →
S4. S5/S6 by appetite. S1–S4 together are comparable in scope to the
auto-transcription line; everything is device-test-only (paired watch;
simulator pairing exists but audio/WC behavior differs).

## Risks / gotchas

- **Transfer time + flakiness**: WCSession file transfers are opportunistic
  and can stall; must queue, show progress, resume after app restarts (the
  API does persist queues — surface state honestly in UI).
- **watchOS long-form audio**: activation presents a route picker if no BT
  headphones are connected; playback cannot fall back to the watch speaker.
- **Auto-transcribed titles**: subtitle coverage ends at the frontier at
  send-time; re-sending updates cues (cheap — cues.json only, keep audio).
- **Battery**: hours of BT playback is what the Music app does — acceptable;
  the subtitle screen should not keep a timer running with wrist down.
- **Build system**: watch target lives outside Capacitor's world; document a
  README section so `cap sync` habits don't create confusion.
- **Versioning**: watch app version must track MARKETING_VERSION; TestFlight
  rejects mismatches.
