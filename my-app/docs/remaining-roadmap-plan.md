# Remaining roadmap — implementation plan

Written 2026-08-08 for handoff. Four items — **recommended execution order: A → C → B → D** (C before B because B's live view depends on cues already being on the watch, which C guarantees; D last because it rides a TestFlight/App Store cycle):

- **Phase A — Fonts in settings transfer** (extends the shipped settings export/import)
- **Phase C — Watch: automatic subtitle sync** (mostly broadening an existing auto-refresh path)
- **Phase B — Watch: live subtitle streaming with word karaoke + flag-for-review**
- **Phase D — iOS-on-Mac ("Designed for iPhone" build replaces the custom Mac shell for end users)**

Everything below was verified against the actual source (file:line refs) on 2026-08-08.

---

## Ground rules (project invariants — violating these is a regression)

1. **NEVER lose the user's place.** No code path may reset or jump a read position or audio playhead. Unknown position → do nothing, never fall back to 0. (See memory `project_never_lose_place_invariant`; `lockScreenCueJump`'s `cur < 0 → return` guard at `www/app.js:4129` is the canonical example.)
2. **After ANY `my-app/www` edit**: run `npx cap sync android` AND `npx cap sync ios`. The macOS shell needs NOTHING (debug builds serve `www` live from source; user presses ⌘R).
3. **No pictographic emoji in UI.** Monochrome dingbats (✦ ✕ ➤ − + ⟲ ◇ △ ▽) are fine.
4. **Every overlay/modal must block background gestures**: add class `kai-modal` to the overlay root (shell.js's `inModal` machinery), or swipes leak through and send cards to Anki.
5. **Card-mode layout is byte-identical-sensitive** (`computeCardLineBudget`, `www/app.js:~4430`). Never change card HTML/CSS shape on mobile. Mac-only display changes gate on `body.kadoki-mac`.
6. **Mac-only behavior gates on `window.KADOKI_MAC === true`** (set by the Mac shell at documentStart; Phase D makes the iOS build set it too when on a Mac). Mobile never has it.
7. **All AICHUNKS writes go through `aiChunks.mutate`** (not relevant to these phases, but do not touch that subsystem casually).
8. Diagnose before rewriting. Keep refactors out of user-facing release notes.
9. Verification workflow: the developer (user) rebuilds/tests on device and reports back. Mac app: `cd my-app/macos && xcodebuild -project Kadoki.xcodeproj -scheme Kadoki -configuration Debug -derivedDataPath build build` then `open build/Build/Products/Debug/Kadoki.app`. iOS/watch builds happen in Xcode by the user. Android needs `export JAVA_HOME=$(/usr/libexec/java_home -v 21)`.

Context you must know about the already-shipped settings transfer (Phase 1):
- `www/settings-transfer.js` — curated ALLOWLIST manifest (~75 exact keys + `fieldMapping_*` prefix). Importer refuses non-manifest keys (protects positions/caches/stats/sync identity/OAuth tokens — the excluded-pattern inventory is in that file's header and in memory `project-settings-transfer`).
- Exporter reads localStorage-first-then-Capacitor-Preferences; importer writes BOTH stores, then `location.reload()`.
- UI: Preferences → "Backup & transfer settings" section (index.html, after the Drive sync section); modals built in settings-transfer.js; i18n keys `ph.sec_transfer` etc. (i18n-strings-prefs-html.js) and `pj.st_*` (i18n-strings-prefs-js.js), EN+JA both present.
- `window.settingsTransfer = { buildBundle, importBundle }`.

---

## Phase A — Fonts in the settings bundle

### Current architecture (verified)

- `www/fonts.js` (104 lines). IndexedDB db `font-store-v1`, store `fonts`, **out-of-line keys**: key = font id string, value = the raw Blob/File. `idbPut(id, blob)` at fonts.js:38.
- Metadata: `localStorage["FONTS_V1"]` = JSON array of `{ id, name, family }` (fonts.js:80-83). `family` is always `'kfont-' + id` (`familyFor`, fonts.js:48). `name` = filename sans extension, ≤60 chars.
- Id minting (fonts.js:75): `'f' + Date.now().toString(36) + random` — **no dedupe, no content hash**. Re-importing the same TTF mints a new id.
- Boot: `loadAll()` (fonts.js:62-69) iterates FONTS_V1, `idbGet(id)`, `new FontFace('kfont-'+id, await blob.arrayBuffer())` → `document.fonts.add` → `window.appearance.refresh()`. Registration reads ONLY `blob.arrayBuffer()` — blob `type` is irrelevant; a plain reconstructed Blob works.
- Per-mode picks: `APPEARANCE_V1` stores `fontFamily: 'custom:<id>'` per mode (+ `dict` font). Resolution (appearance.js:65-72) falls back to the serif stack if the id is missing — safe degradation, but the user must re-pick, which is what we're eliminating.
- `window.fonts` exposes `list/familyFor/importFile/remove/loadAll/isRegistered` — **no restore-by-id API exists**; `importFile` always mints a new id.

### Design

Preserve ids. That is the whole game: if `id` survives, `APPEARANCE_V1`'s `custom:<id>` picks keep working on the new device with zero user action.

1. **Add `fonts.restore(id, name, blob)` to `www/fonts.js`** and export it on `window.fonts`:
   - `idbPut(id, blob)` under the SAME id.
   - Merge `{id, name, family: 'kfont-'+id}` into FONTS_V1 **only if the id is not already present** (this dedupe-by-id is the idempotency the codebase otherwise lacks).
   - Then `register(id, blob)` (idempotent via the `_registered` Set, fonts.js:50-52) and `window.appearance.refresh()`.
2. **Exporter** (settings-transfer.js `buildBundle`): add a `fonts` array. For each FONTS_V1 entry: `{ id, name, dataBase64 }` where dataBase64 = base64 of `(await idbGet(id)).arrayBuffer()`. Reuse the chunked `String.fromCharCode` base64 helper pattern (see `bufToB64` in `macos/Kadoki/mac-shim.js` — copy the implementation, don't import across bundles). Build base64 **one font at a time**; do not hold all decoded copies simultaneously.
3. **Importer** (`importBundle`): for each `fonts[]` entry, decode base64 → `new Blob([bytes])` → `window.fonts.restore(id, name, blob)`. Count separately in the summary ("Imported N settings, M fonts").
4. **Size handling — the real pitfall.** Full CJK faces are 15–25 MB; base64 inflates ×4/3; a bundle with 2 CJK fonts can exceed 60 MB of JSON:
   - The export TEXTAREA must NOT be populated with a giant string (it will jank/crash the WebView). When the serialized bundle exceeds ~2 MB, show a placeholder line ("Bundle is {size} — use Download / Copy") instead of the JSON text, and keep Copy/Download working from the in-memory string.
   - Add an **"Include fonts" checkbox** to the export dialog (default ON when fonts exist, but show the computed size next to it). Small bundles stay paste-friendly; users can opt out.
   - Clipboard on iOS can fail on very large strings — treat Copy failure as non-fatal (button already shows "Copy failed").
   - Import via file input reads with `file.text()` — fine at these sizes. `JSON.parse` of 60 MB is ~1-2 s on desktop, several seconds on old phones: show a "Importing…" state before parsing (synchronous parse blocks paint — set the status text, then `setTimeout(parse, 50)`).
5. **Manifest hygiene**: `fonts` rides as a top-level bundle field (like `dictionaries`), NOT through the `keys` allowlist — do not add FONTS_V1 to `EXACT_KEYS` (importing the metadata without blobs is exactly the ghost-entry failure mode we're avoiding; the restore path rebuilds FONTS_V1 itself).
6. Bump bundle `version` to 2; importer accepts 1 (no fonts field) and 2.

### Pitfalls checklist (Phase A)

- [ ] Never populate the visible textarea with >2 MB of JSON.
- [ ] Per-font sequential base64 encode (memory spike otherwise).
- [ ] `restore()` must be id-idempotent (skip existing ids) — repeated imports must not duplicate picker entries.
- [ ] FONTS_V1 stays OUT of `EXACT_KEYS`.
- [ ] After font restore, call `loadAll()`/`appearance.refresh()` so a no-reload preview works, but the reload flow remains the source of truth.
- [ ] iOS Capacitor WebView: `blob.arrayBuffer()` on IDB-restored File objects is fine (boot already does it); reconstructed Blobs equally fine.

### Test plan (Phase A)

1. Mac: import a font, pick it for READ mode, export (fonts on) → wipe site data or use second profile → import → font renders in READ without re-picking.
2. Export with fonts OFF → bundle has no `fonts` field, version still parses on import.
3. Import same bundle twice → font list shows ONE entry.
4. Bundle with 2 large CJK fonts → export dialog shows size note instead of JSON; Download works; import shows progress state and completes.

---

## Phases B & C — Watch (build order: **C first, then B** — B's live view depends on cues already being on the watch, which C guarantees)

### Current watch architecture (verified 2026-08-08; all refs real)

**Watch app** = `ios/App/KadokiWatch/` (target "Kadoki Watch App", bundle `com.helica1.yama.watchkitapp`, watchOS 10.0):
- Files arrive ONLY via `WCSession transferFile` with metadata `{role: "cues"|"audio"|"cover", titleId, name, durMs, ext?}` — handler `session(_:didReceive file:)` at `KadokiWatch/WatchConnectivityManager.swift:30-72`. Files MUST be moved before the callback returns (the temp URL dies). Storage: `Library/Titles/<titleId>/{audio.<ext>, cues.json, cover.jpg, meta.json}` (`WatchTitleStore.swift`). Positions in UserDefaults `pos_<id>/posTs_<id>/furthest_<id>` + phone-sent `phonePos_<id>/phonePosTs_<id>`.
- **A cues.json refresh for the currently-loaded title applies LIVE** (`WatchConnectivityManager.swift:63-67` → `WatchPlayer.shared.refreshCues()`).
- Cue model `WatchCue {s, e, text, w?}` (`WatchPlayer.swift:19-24`) — the karaoke stack ALREADY consumes the `w` quads (`[utf16Off, len, relStartMs, relEndMs]`, ms relative to cue start). Rendering: `PlayerView.swift` `TimelineView(.periodic)` with adaptive tick (0.08 s active / 1 Hz Always-On via `isLuminanceReduced` / 3600 s paused — battery contract, lines 22-32); `karaokeText(cue:relMs:)` at `PlayerView.swift:193-218` paints read=accent / speaking=white / upcoming=dim; AOD renders plain text (no attributed rebuild).
- **Flag UI exists**: swipe-up flags the current subtitle (`PlayerView.swift:119-148` `flagCurrentSubtitle`) → `sendWordFlag(titleId, word:"", cueText, sMs, eMs)` via `transferUserInfo {type:"flag", ...}` (`WatchConnectivityManager.swift:154-164`).
- Watch→phone channels: `updateApplicationContext` position checkpoints (`{positions: {tid: {ms, furthestMs, ts}}}`, latest-wins, every ~5 s), `transferUserInfo` listen deltas (`{type:"listen", titleId, sec, ms, furthestMs, ts}`, ~120 s) and flags, `sendMessage {type:"syncRequest"}` (can WAKE the phone app; reachability deliberately not pre-checked).
- **LANDMINE: the watch implements NO `didReceiveMessage`, NO `didReceiveUserInfo`, NO `sessionReachabilityDidChange`** — any phone→watch live channel needs receivers added.

**Phone native** = `ios/App/App/WatchBridgePlugin.swift` (248 lines; registered in `MainViewController.swift:26`). JS methods: `getState`, `sendTitle({titleId,name,audioPath,durMs,cues,cuesOnly,cover})` (cues→temp JSON→transferFile FIRST, then cover, then audio unless cuesOnly), `updateContext({positions})`, `flushPending`. Events to JS: `watchTransfer` (1 Hz progress), `watchTransferDone`, `watchSyncRequest`, `watchListen`, `watchFlag`, `watchPosition`. Pre-listener events are buffered until JS calls `flushPending()` (lines 32-43).
- **LANDMINE:** `updateContext` REPLACES the whole outgoing applicationContext with only `phonePositions` (line 87) — any new context key must merge, or ride a different channel.

**Phone JS** = `www/watch.js` (296 lines). `bundleCues()` (:15-25) → wire schema `[{s,e,text,w?}]` from `window.__abCues` || `window._srtCues`. Manual send `sendTitleToWatch` (:27-73) requires the title OPEN (cues live in memory only then). **`autoRefreshWatchCues()` (:111-143) already auto-resends cues every 60 s check** when: `WATCH_SENT_<tid>` exists (audio already on watch) AND ≥180 s since last send AND cues grew by ≥150. Position push `pushPositionsToWatch` (:79-109; ≥30 s apart). Flags land in `www/lookup-log.js` (`watchFlag` listener → `lookupLog.add({term:'', source:'watch', ctx:{sentence, cueStartMs, cueEndMs}})`, watch.js:267-284) — **the entire review pipeline (list UI with WATCH badge, word-pick viewer, Anki send) already exists and needs ZERO changes.**

**The decisive constraint for B:** iOS suspends the WebView while the phone is locked (`BackgroundAudioPlugin.swift:60-64`) — a JS-side streamer dies exactly in the pocket-listening case this feature exists for. Native `BackgroundAudioPlugin` keeps ticking (position emit 150 ms foreground / ~1 s background, ts-stamped, lines 68-71, 897-908). **Therefore: the live stream is NATIVE-to-native** (BackgroundAudio → WatchBridge → WCSession), and the watch — which already holds cues + `w` locally — receives only tiny clock frames and computes cue + karaoke itself.

---

### Phase C — Automatic subtitle sync (do this first)

Goal: any title whose cues exist on the phone gets its `cues.json` on the watch automatically and kept fresh — no manual "Send to Watch" for subtitles. Audio stays manual (multi-hundred-MB over Bluetooth is a deliberate user decision).

Design (mostly broadening `autoRefreshWatchCues`):
1. **New auto-send gates** in `www/watch.js`: on title open (once cues finish loading — hook where `WATCH_CUES_SENT_` is consulted) and on auto-transcribe growth, send `cuesOnly:true` when: watch `getState()` says `supported && paired` (do NOT trust `installed` — it is documented stale-false, WatchBridgePlugin.swift:101-105), AND (no `WATCH_CUES_SENT_<tid>` yet, OR cue count grew ≥50, OR last send >180 s with any growth). Keep the existing 60 s poll as backstop; add a `kai:` event hook from auto-transcribe finalize if one exists (search `maybeFinalize` in auto-transcribe.js) for promptness.
2. **Fingerprint instead of raw count** for the staleness compare: `count + '|' + lastCueEndMs` stored in `WATCH_CUES_SENT_<tid>` (backward compatible: existing numeric values parse as count-only).
3. **Watch-side title listing**: cues-only titles now appear in `Library/Titles/` without `audio.*`. The watch library list must filter to titles WITH audio for playback (check `WatchTitleStore` listing code), while keeping cues-only dirs on disk for Phase B's live view. Small change; verify the list doesn't crash on audio-less dirs today.
4. **Idempotency**: cues.json overwrite + `refreshCues()` live-apply already work (WatchConnectivityManager.swift:63-67). transferFile queue delivers with apps closed — no reachability logic needed for C.
5. Do NOT auto-send covers/audio. Do NOT touch `updateApplicationContext` for this.

Pitfalls (C): `sendTitleToWatch` currently REQUIRES the title open — auto path must reuse its cues-only inner send with the same guard (cues exist in memory only for the open title; for non-open titles with cached cues, blobStore `SRT_CUES_V1_<tid>` could be a source later — NOT in scope now). Don't spam transfers: WCSession queues persist across launches; always fingerprint-gate. Test: open audio title with watch paired → cues arrive with no button press; long transcription session → watch cues grow without manual sends; watch playback title list unchanged.

---

### Phase B — Live subtitle streaming + flag (after C)

Wire protocol (phone→watch, `sendMessage`, fire-and-forget, ONLY when `session.isReachable` — watch app foreground —, ~1 Hz while playing plus one immediate frame on cue boundary or seek):

```
{ t: "live", titleId, ms, ts (epoch ms at send), playing, rate }
```

No cue text/w over the wire — the watch reads `Library/Titles/<titleId>/cues.json` (guaranteed fresh by Phase C) and runs its existing `cueIndex` + `karaokeText` machinery off an extrapolated clock: `displayMs = frame.ms + (now - frame.ts) * rate` while playing; snap if a new frame differs >250 ms, else slew (mirror the clock model constants in `www/word-highlight.js:189-205`).

Implementation steps:
1. **Native position tap**: `BackgroundAudioPlugin` posts a `NotificationCenter` notification (e.g. `.kadokiPositionTick`, userInfo `{ms, playing, rate, ts}`) inside its existing emit path (both the 150 ms foreground and ~1 s background timers — around BackgroundAudioPlugin.swift:897-908). Keep it dumb; no new timers.
2. **WatchBridgePlugin streamer**: observes the notification; keeps `liveTitleId` (set from JS — new plugin method `setLiveContext({titleId})` called by watch.js on title open/switch, cleared on close; the mapping is set while the screen is on and survives WebView suspension in native memory); throttles to 1 Hz (allow immediate send when `ms` jumps >2000 — seek); sends via `session.sendMessage(_:replyHandler:nil, errorHandler: {_ in})` ONLY when `isReachable`. Implement `sessionReachabilityDidChange` on the phone to send one fresh frame the moment the watch app comes to the foreground.
3. **Watch receiver**: implement `session(_:didReceiveMessage:)` in `KadokiWatch/WatchConnectivityManager.swift` — dispatch to main; drop frames with `Date.now - ts > 3000` (WCSession can queue; same staleness convention as the phone's position listeners) and frames whose `titleId` ≠ the live view's title. Publish to a small `LiveSessionModel` (ObservableObject: titleId, lastFrame, derived clock).
4. **Watch live view**: new SwiftUI screen "On iPhone" — appears in the watch root list when a live frame arrived <10 s ago (or always listed, showing "nothing playing"). Reuses: `WatchTitleStore` cue loading, `cueIndex(atMs:)`, `karaokeText(cue:relMs:)` (refactor those two out of `WatchPlayer`/`PlayerView` into a shared helper rather than duplicating), the same adaptive `TimelineView` tick contract (0.08 s / 1 Hz AOD / idle when `!playing`), and the same gesture map: **swipe up = flag** → `sendWordFlag(titleId, word:"", cueText: streamedCue.text, sMs: cue.s, eMs: cue.e)` — carrying s/e/text (NOT an index: phone/watch cue vintages can differ; identity is by startMs±150+text throughout the codebase). Phone pipeline is untouched.
   - Optional (recommend v2, not v1): swipe left/right on the live view sending `{t:"liveCmd", action:"prevCue"|"nextCue"}` phone-ward via sendMessage → phone WatchBridge maps to the same native seek `lockScreenCueJump` uses. Keep v1 display+flag only.
5. **When the watch requests the stream**: on live-view appear, watch sends `sendMessage {type:"liveSubStart"}` (phone already has a message handler for `syncRequest` — extend it) → phone replies with an immediate frame even while paused, so the view populates instantly.
6. **JS side**: `watch.js` calls `setLiveContext` on title open (where `pushPositionsToWatch` hooks already are) and on `_titleSwitchInFlight`/title close clears it. No JS involvement in the frame stream itself.

Pitfalls (B):
- NEVER use `updateApplicationContext` for frames (whole-context replace clobbers `phonePositions`, and it coalesces). NEVER `transferUserInfo` for frames (queued replay flood of stale frames on reconnect).
- `sendMessage` phone→watch errors when unreachable — swallow errors, never retry-loop; reachability change event triggers the fresh frame.
- All WCSession delegate callbacks arrive on background threads — dispatch to main before touching published state (existing convention both sides).
- The watch live view must not write positions (`pos_<id>`) — display-only; the phone owns the playhead. The flag path is the ONLY watch→phone write it may perform. (Place-loss invariant: a stale streamed frame must never become a stored position anywhere.)
- Frames for a title whose cues.json is absent (C not yet delivered): show text-less "syncing subtitles…" state; do not crash; cues arrive via C's transfer and `refreshCues()`-equivalent should re-check.
- Battery: 1 Hz native sendMessage only while reachable AND playing is negligible on both sides; the watch view obeys the existing AOD tick contract.

Test plan (B): phone playing + watch view open → subtitle + karaoke advance in sync (±300 ms perceived); lock the phone, keep listening → stream continues (native path proof); seek on phone → watch snaps within ~1 s; swipe-up on watch → entry appears in phone Lookup history with WATCH badge and correct sentence; switch titles on phone → watch view swaps or clears (no cross-title frames); watch app backgrounded → phone stops sending (reachability), no error spam in console.

### Status as of 2026-08-08 (hands-on device testing)

**Confirmed working**, on real hardware (iPhone + paired Apple Watch, after resolving an unrelated stale-provisioning-profile install issue — fixed by restarting the watch):
- Live subtitle streaming (karaoke text tracks phone playback, ±300ms feel).
- Subtitles correctly freeze when the phone pauses/stops (this needed a real fix: `WatchBridgePlugin`'s 1Hz throttle was dropping the "just paused" frame when it landed <1s after the last regular tick, and since `pause()` stops the position timer right after, nothing ever corrected it — fixed by letting a `playing` state change always bypass the throttle; see `handlePositionTick` in `WatchBridgePlugin.swift`).
- Phase C auto cues-sync (confirmed working; also hardened with a 24h unconditional heartbeat resync in `watch.js` to recover from a watch-app reinstall wiping `Library/Titles/*` without the phone's dedup state knowing).

**UNRESOLVED — watch→phone remote control (tap/swipe on the live view) — the whole control PATH is implemented but never fires on device:**
- Symptom: tapping (or swiping in any direction other than up) `LiveView` on the physical watch produces **zero response** — no haptic click, nothing. Swipe-UP-to-flag on the SAME gesture recognizer works correctly every time.
- This was root-caused once (a `DragGesture(minimumDistance: 24)` claims a touch the instant it begins and only calls `.onEnded` if the touch crosses that distance, so a near-still tap gets silently swallowed with nothing ever firing — confirmed by the fact `.simultaneousGesture(TapGesture())` didn't help either, since the touch was already claimed) and "fixed" by merging everything into one `DragGesture(minimumDistance: 0)` in `LiveView.swift`, classifying tap vs. swipe by translation in a single `.onEnded` — but **the tap branch still never fires** even after that rewrite, while the swipe-up branch (in the exact same gesture, same closure) keeps working. This is confusing: same recognizer, same `.onEnded`, one branch reliably fires and the other reliably doesn't.
- Ruled out: stale build (title-name fix from the same round is confirmed visible on device, so rebuilds ARE reaching the watch), naive tap/swipe gesture competition (already reworked into one recognizer).
- NOT yet tried: adding an `NSLog`/on-screen flash of the raw `v.translation` values on EVERY `.onEnded` call (not just the branches) to see whether the tap case is even reaching `.onEnded` at all with near-zero values, or whether it's not reaching `.onEnded` in that case at all (which would point back at something claiming/absorbing the touch before release rather than a classification-logic bug); also worth trying: swap `NavigationLink(destination: LiveView())` (used for this screen) for the value-based `.navigationDestination(for:)` pattern `PlayerView` reaches, in case eager vs. lazy destination construction affects gesture attachment/hit-testing on watchOS; also worth trying isolating with ONLY a bare `.onTapGesture` (no competing gesture at all) on a trivial test view to confirm taps work on this device/watchOS version/screen at all.
- The rest of the control pipeline (phone-side) is implemented and untested-but-presumed-fine, ready to re-verify once the watch-side gesture issue is solved: `WatchConnectivityManager.sendLiveCommand` → `WatchBridgePlugin`'s no-reply `didReceiveMessage` → `.kadokiRemoteToggleRequest` notification → `BackgroundAudioPlugin.performTogglePlayPause()` (toggle), and a `watchCueJump` plugin event → `window.lockScreenCueJump(dir)` in `watch.js` (cue paging, reuses the existing lock-screen ⏮⏭ path — no new seek logic).

---

## Phase D — iOS-on-Mac ("Designed for iPhone" build) — DEAD END, see status below

**Status as of 2026-08-08: implemented (D1/D2/D4-1 all done, see git history) and then abandoned after hands-on testing on a real Mac.** Two problems surfaced:
1. **Fixed-size window — unfixable, not a bug.** "Designed for iPhone" apps run the literal iOS binary via Apple's `iOSSupport` framework and are locked to iPhone-shaped window dimensions by the OS itself; the user only gets a couple of discrete zoom-level presets (right-click the title bar), never free arbitrary resizing. This is a hard platform restriction of this specific technology, not something any app-side code can change. (Mac Catalyst *can* get a real resizable window, but Catalyst is a fundamentally different build target — effectively a separate app — not reachable via the `isiOSAppOnMac` flag approach this phase used.) This alone makes the feature not feel like a real Mac app and was judged a dealbreaker.
2. The app also froze after adding a title during testing — never root-caused, abandoned before investigating once (1) was already a dealbreaker on its own.

**Conclusion: the custom `my-app/macos/` shell (real AppKit window, genuinely resizable) is the permanent solution for Mac users, not a "temporary dev tool" as this phase's goal originally assumed.** Do not re-attempt Phase D for the window-resizing reason unless Apple changes this platform restriction or the plan shifts to a Mac Catalyst / native rewrite (a much bigger undertaking, effectively a new app target).

The D1/D2/D4-1 code (KADOKI_MAC flag injection, AnkiBridge→AnkiConnect Mac branch, mac-input.js) is left in place — it's inert everywhere except when actually launched via the "My Mac (Designed for iPhone)" Xcode destination, so it's harmless dead weight rather than something that needs reverting. D3/D4 (App Store Connect settings, iPhone regression pass) were never reached.

Original goal (not pursued further): the App Store / TestFlight iOS build runs natively on Apple Silicon Macs with the full real plugin set (no shim), and all the Mac UX adaptations already in `www` light up via the `KADOKI_MAC` flag. The custom shell at `my-app/macos/` remains a dev tool only.

### D1. Set the flag (verified injection point)

`ios/App/App/MainViewController.swift` — subclass of `CAPBridgeViewController`, all 8 plugins register in `capacitorDidLoad()` (MainViewController.swift:14-36). Capacitor 7 load order (verified in `node_modules/@capacitor/ios/.../CAPBridgeViewController.swift`): `loadView()` → `prepareWebView` → `capacitorDidLoad()` → `viewDidLoad()` → `loadWebView()` — so user scripts added in `capacitorDidLoad()` land **before the page loads**. Add at the top of `capacitorDidLoad()`:

```swift
import WebKit  // at file top

if ProcessInfo.processInfo.isiOSAppOnMac {
    let script = WKUserScript(source: "window.KADOKI_MAC = true;",
                              injectionTime: .atDocumentStart, forMainFrameOnly: true)
    self.webView?.configuration.userContentController.addUserScript(script)
}
```

**Trap:** do NOT try this inside `webViewConfiguration(for:)` — `prepareWebView` REPLACES the userContentController afterward (`CAPBridgeViewController.swift:304`).

What lights up automatically once the flag is set (all already shipped in `www`, all `KADOKI_MAC`-gated): click-to-lookup in reader/card/AI overlays + CMD-held text selection (reading-mode-paged.js `setupMouse` + boot shim; enhanced-dictionary.js span/lazy click handlers), chrome click-toggle incl. empty-header-area (shell.js `installChromeClickHandler`), card image `object-fit: scale-down` (theme.css), blob-URL card media + blob→dataURI Anki conversion (app.js), reader dict-highlight overlay painting (reading-mode-paged.js paintFn gate `ios || KADOKI_MAC` — NOTE on iOS-on-Mac `getPlatform()` returns `'ios'` so this was already correct).

What does NOT exist on iOS-on-Mac and needs deciding (recommend: defer all to a later pass):
- Trackpad wheel gestures + keyboard transport + ESC/interior-click popup dismiss + first-responder handling live in the SHELL's `mac-shim.js`, not in `www`. Decision: port the input-adapter block of mac-shim.js (trackpad gestures IIFE + keyboard + popup escape hatches, ~150 lines, pure JS, no native deps) into a new `www/mac-input.js` loaded from index.html and gated on `KADOKI_MAC`, and DELETE that block from mac-shim.js so there is one copy. This benefits both the shell and iOS-on-Mac. Wheel/keyboard events do arrive in WKWebView under iOS-on-Mac (indirect pointer events are synthesized; verify empirically — if wheel events do NOT arrive, gestures simply stay dead without harm).
- The native menu bar (shell-only) — iOS-on-Mac gets the standard minimal menu; acceptable.

### D2. AnkiBridge → AnkiConnect on Mac (the one REQUIRED native change)

`ios/App/App/AnkiBridgePlugin.swift` (612 lines). Today: AnkiMobile x-callback-url + clipboard round-trip + loopback `AnkiMediaServer`. On a Mac there is no AnkiMobile; desktop Anki + AnkiConnect (port 8765) is the target. Branch every method on `ProcessInfo.processInfo.isiOSAppOnMac`:

| Method (line) | Mac branch |
|---|---|
| `isAvailable` (:154-163, uses `canOpenURL("anki://")` — returns false on Mac) | POST `{"action":"version","version":6}` to `http://127.0.0.1:8765` with ~1.5 s timeout via URLSession; `available` = 200 OK. |
| `requestPermission` | Call AnkiConnect's real `requestPermission` action; `granted` = result.permission == "granted". |
| `deckNames`/`modelNames`/`modelFieldNames` (:170-172, iOS stubs returning []) | Map 1:1 to the AnkiConnect actions of the same names. JS already consumes these via the Android-style flow. |
| `fetchInfo` (:180-200, app-switch + clipboard) | Compose natively: deckNames + modelNames + N× modelFieldNames → `notifyListeners("ankiInfo", {decks, notetypes:[{name, fields}]})` (EXACT same payload shape — JS listener then works unchanged) and set `lastAnkiInfo`. |
| `getLastInfo` (:141-143) | Unchanged. |
| `addNote` (:243-427) | Single POST `addNote` with `note: {deckName, modelName, fields, tags, options:{allowDuplicate:true}, audio:[{data:<base64>, filename, fields:[field]}], picture:[...]}`. Reuse the existing `dataBase64`/`srcPath` decode (:494-505). SKIP the entire AnkiMediaServer ping/restart block (:264-267, :377-403) and bookmark-folder path. Resolve with the real returned `noteId`. After success, ALSO post the notification that fires the `ankiCallbackUrl` event with an `anki-success` URL (see below). |
| `linkMediaFolder`/`getMediaFolderStatus` (:204-218) | Return `{linked:false, mode:"ankiconnect"}`; Preferences can hide the link prompt. |

**x-callback resolution pitfall:** `www/sendToAnkiConnect.js` on non-Android platforms awaits `waitForAnkiCallback(8000)` after addNote, resolved by an `ankiCallbackUrl` event containing the substring `anki-success`/`anki-error` (sendToAnkiConnect.js:54-59, 75-91). On Mac no URL callback ever arrives → every send would show the bogus "No reply from AnkiMobile" timeout. Fix natively: after a successful AnkiConnect addNote, `notifyListeners("ankiCallbackUrl", ["url": "ankideckreader://anki-success"])`; on error, `.../anki-error?errorMessage=<pct-encoded>` then reject. (The shell's mac-shim.js AnkiBridge does exactly this — copy the semantics.)

**ATS: nothing to add.** `NSAllowsLocalNetworking=true` is already in Info.plist (:89-93), IP literals are ATS-exempt anyway, and `capacitor.config.json` already lists `http://127.0.0.1:8765` in `allowNavigation`. Native URLSession sidesteps webview CORS entirely.

### D3. Known-different-on-Mac inventory (no action required, verify once)

- WatchBridgePlugin: `WCSession.isSupported()` false → `load()` early-returns (:55), `getState` → `{supported:false}`, watch.js shows "This device has no watch support." — clean.
- BackgroundAudio: MPRemoteCommandCenter/NowPlaying work (menu-bar Now Playing + media keys). `isIdleTimerDisabled` (keep-awake, :516) is a silent no-op on Mac — acceptable.
- App is NOT suspended when occluded on Mac — the whole background-restore machinery is exercised less; no change needed.
- Document pickers present as macOS open panels; security-scoped bookmarks behave identically.
- Info.plist fullscreen/orientation keys are ignored; the app runs in a resizable window — the `www` layout already handles arbitrary window sizes (proven by the shell).
- `AnkiMediaServer.start()` (MainViewController.swift:35): harmless to leave running; optionally skip under `isiOSAppOnMac`.
- Haptics: no-ops, already guarded.

### D4. Distribution + order of work

1. Port mac-shim input adapters → `www/mac-input.js` (guarded `if (!window.KADOKI_MAC) return;`), remove from mac-shim.js, add `<script src="mac-input.js">` to index.html, `cap sync` both, verify the SHELL still behaves identically (⌘R + rebuild shell since shim changed).
2. MainViewController flag injection (D1).
3. AnkiBridgePlugin Mac branch (D2). Test rig: run desktop Anki + AnkiConnect on the Mac, build the iOS app "My Mac (Designed for iPhone)" destination in Xcode, exercise deck pickers + addNote with image/audio.
4. App Store Connect: ensure "Make available on Apple Silicon Macs" stays enabled (default). TestFlight builds offer the Mac install automatically.
5. Regression pass on a REAL iPhone (the branches must be inert there: `isiOSAppOnMac == false`).

### Pitfalls checklist (Phase D)

- [ ] User script must go in `capacitorDidLoad()`, not `webViewConfiguration(for:)`.
- [ ] `isiOSAppOnMac`, NOT `isMacCatalystApp` (the latter is also true for Catalyst apps and broader).
- [ ] `ankiCallbackUrl` anki-success event after AnkiConnect addNote, or every send reports a timeout.
- [ ] `getPlatform()` still returns `'ios'` on iOS-on-Mac — audit any `platform === 'ios'` branch that assumes AnkiMobile exists: the ONLY such load-bearing branch is `isIOSPlatform()` in sendToAnkiConnect.js (routes deck/model listing to `_iosAnkiInfo` from `fetchInfo` — which the Mac branch feeds identically, so it keeps working; verify empirically).
- [ ] Keep the `iphoneos` (device) build unaffected — all Mac branches behind `isiOSAppOnMac` runtime checks, no build-config changes.
- [ ] Do not remove the mac-shim.js AnkiBridge/plugins — the custom shell still uses them (`if (window.Capacitor) return;` guard keeps the shim inert under real Capacitor).

---
