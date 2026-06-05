# Android resume: invisible, durable, correct cold-boot — implementation plan

**Created:** 2026-06-04 · **Owner:** solo · **Status:** not started
**Diagnosis:** see memory `project_android_resume_reset_diagnosis.md` (24-agent verified investigation).

## Goal (the three hard requirements)
1. App ALWAYS opens in the mode the user left it in.
2. App ALWAYS opens at the exact spot the user left (read scroll AND audio playhead).
3. ALL restore scrolls happen OFF-SCREEN — the user never sees a wrong position, a mode-switch flash, or a scroll-to-correct.

## Strategy in one line
You cannot stop Android's LMK from reaping the backgrounded WebView process — so make the cold boot **invisible** (cover-until-settled), **durable** (flush on background, don't lose the last page), and **rare** (smaller heap). In that priority.

## Standing rules while implementing
- After ANY `my-app/www` edit: run **both** `npx cap sync android` AND `npx cap sync ios` before `./gradlew installDebug` (memory `feedback_cap_sync_before_install`).
- Never let a change fall back to position 0 / mode card on uncertainty — preserve current place (invariant `project_never_lose_place_invariant`).
- Console logs are gated on Android: set `localStorage.KADOKI_DEBUG=1` before diagnosing (memory `project_android_perf_logging`).
- Every reveal/cover MUST have a timeout fallback so a restore failure can never hang on a black/splash screen.

## File map (paths relative to `my-app/`)
- `www/app.js` — boot/init, splash hide, autoRestoreFromTitles, boot guard, persistence interval.
- `www/shell.js` — mode state + switching, the 1500ms cold-start restore timer.
- `www/reading-mode-paged.js` — paged reader, bookmark save/restore, visibilitychange flush, prewarm, openView reveal.
- `www/reading-mode.js` — audio playhead save (closeAudiobookMode), read-restore IIFE catch.
- `www/title-store.js` — per-title lastMode + cardIndex (Preferences).
- `www/stats.js` — appStateChange/visibilitychange (correct pattern, currently no-op without @capacitor/app).
- `www/index.html` — head styles, default DOM, Library-tap path (skipCardDisplay template), boot scripts.
- `android/app/src/main/java/com/example/app/MainActivity.java` — add onStop flush hook.
- `android/app/src/main/AndroidManifest.xml` — largeHeap.
- `my-app/package.json` — add @capacitor/app.

---

## Sequenced slices

> Order chosen for shippability + safety: durability quick-wins first (immediate value, low risk), then the visible-reveal rework (needs a reliable "settle" signal built first), then kill-frequency, then guard hardening. Each slice is independently shippable + device-testable.

### S0 — Confirm the trigger (no code) · effort: S · risk: none
**Why:** the captured logs are a dev-reinstall transcript, NOT proof of an LMK kill. Confirm before the big rewrite (`feedback_diagnose_first`).
- On device, reproduce the reset (read → lock → wait → unlock). Capture:
  `adb logcat -c` then `adb logcat | grep -iE 'lmkd|am_kill|onTrimMemory|ActivityManager.*com.helica1.yama|empty #|cached #'`
- Confirm a `lmkd` / `am_kill` line names `com.helica1.yama` (or the .dev variant) around the reset.
- Also dump `adb shell dumpsys meminfo com.helica1.yama` while reading to record the resident footprint (feeds S7).
**Accept:** a logcat snippet showing the OS reaping the process (or, if not, re-open this plan — the cause may differ).

---

### S1 — Durability quick-wins (no new deps) · effort: M · risk: low
Closes most of the "spot is an earlier spot" gap with additive, low-risk writes. Ship first.

**S1a — Periodic + background audio-playhead save.**
- `reading-mode.js`: today `saveAudiobookLastPosition` (def ~:141) is called ONLY from `closeAudiobookMode` (~:2874). Add a periodic save every 5–10s while playing, hung off the existing position tick that updates `abPositionRef.ms` (~:2665). Guard: only write when playing and ms advanced.
- Include the live playhead in the background flush built in S1c.
**Accept:** play audio 60s → force-stop the app from recents → reopen → playhead within ~10s of where you were (not minutes back).

**S1b — Mirror the reopen anchor to SYNCHRONOUS localStorage.**
- Wherever the M1 chunk bookmark is persisted (`reading-mode-paged.js` `_persistBookmark` ~:1854) and the per-title mode (`title-store.js setMode` ~:259, `shell.js` LAST_MODE_V1 ~:72), ALSO write a synchronous mirror to `localStorage` (e.g. `KADOKI_RESUME_<titleId>` = `{mode, chunkIdx, scrollLeft, audioMs, ts}`). localStorage is synchronous → durable the instant it's set, immune to the `apply()` flush window.
- Restore reads the localStorage mirror first (it's the most-recent durable value), falls back to Preferences. Keep Preferences as the cross-launch source of truth; localStorage is the crash-durable shadow.
**Accept:** scroll to a deep line → immediately force-stop → reopen lands on that line (not 5s/30s back).

**S1c — Make the background flush mode-agnostic + awaited.**
- Replace the read-mode-only, no-`await` visibilitychange handler (`reading-mode-paged.js:1975-1986`) with ONE central `window.flushResumeState()` that: (a) is NOT gated by `_readerHidden()`/mode, (b) writes read bookmark+scroll, card index, AND audio playhead, (c) writes the synchronous localStorage mirror (S1b) FIRST (guaranteed), then fires the Preferences writes.
- Wire it to `document.addEventListener('visibilitychange', () => { if (hidden) flushResumeState(); })` AND `pagehide`.
**Accept:** from card mode AND audio mode (not just read), background→kill→reopen preserves position.

**S1d — Shorten the structural lag.**
- Lower `BOOKMARK_SETTLE_MS` (`reading-mode-paged.js:1801`) or call `_persistBookmark()` immediately on each page-turn settle (the physics engine knows when a turn completes). Shorten the 400ms raw-scroll debounce (~:1958). The localStorage mirror (S1b) makes these cheap.
**Accept:** a normal page-turn then immediate sleep loses ≤1 line.

---

### S2 — Real native background flush (@capacitor/app + onStop) · effort: M · risk: medium
Belt-and-suspenders durability with a native guarantee.
- `my-app/package.json`: add `@capacitor/app` (matching Capacitor 7.x). `npm i`, then `npx cap sync android && npx cap sync ios`.
- `stats.js` already has the `appStateChange` hook (`hookCapApp` ~:457) — once the plugin exists it activates. Point its `isActive:false` branch at `window.flushResumeState()` (S1c).
- Native guarantee: in `MainActivity.java` add `onStop()` that calls `bridge.eval("window.flushResumeState && window.flushResumeState()", ...)` (or `evaluateJavascript`) synchronously BEFORE `super.onStop()`, so the write is queued before the Activity is torn down. Consider switching the on-background Preferences write to `commit()` (synchronous) instead of `apply()` — either by a small native Preferences shim or by relying on the localStorage mirror.
**Accept:** with `KADOKI_DEBUG=1`, logcat shows the flush firing on every home-press/lock; reopen after a real kill is exact.

---

### S3 — Deterministic mode restore (kill the card-first + manual-switch) · effort: M · risk: medium
Replace the fragile timer with an awaited handoff so the correct mode is known BEFORE reveal (this also produces the "settle" signal S4 needs).
- DELETE the one-shot `setTimeout(..., 1500)` cold-start restore in `shell.js:1050-1087`.
- Instead, have the restore path call mode-switch DIRECTLY once it has the title object: in `app.js` `autoRestoreFromTitles`, after `_activeTitleId` is set and `lastMode` is read from the title it already loaded, compute `targetMode` (clamp to enabledModes) and `await window.setShellMode(targetMode, {force:true, titleOpen:true})`. No fixed delay, no retry race.
- Apply mode PRE-PAINT: add a tiny synchronous `<head>` script in `index.html` (before body renders) that reads `localStorage.LAST_MODE_V1` (sync, `shell.js:72`) / the S1b mirror and stamps `document.documentElement`/`body` with `mode-read|mode-card|mode-audio` so first paint is already the right theme (serif/orange), not card.
- Expose `window._resumeSettled` (a resolved Promise) when mode + position restore complete — S4 gates the reveal on this.
**Accept:** cold-boot a read title → it comes up in READ mode with no manual switch, on the first paint after the cover lifts. Repeat 10×: 10/10 read mode.

---

### S4 — Cover-until-settled reveal (kill the FOUC + visible mode-switch) · effort: M · risk: medium
Hold an opaque cover over the whole boot; lift only when restore is settled.
- REMOVE the parse-time `SplashScreen.hide()` at `app.js:3467-3469` and the redundant one at `app.js:2705-2707`.
- Add `window.revealApp()` = the single place that calls `SplashScreen.hide()` AND fades out an in-app opaque overlay. Call it from `await _resumeSettled` (S3) — i.e. after mode is applied and (for read) the paged reader has restored its chunk anchor offscreen (S5).
- Add a fixed, full-screen, opaque black overlay div in `index.html` (matches `index.html:15` bg), visible by default, faded by `revealApp()`. This covers the warm-resume/visibilitychange path the native splash can't, and any in-session mode transition.
- **Safety:** `revealApp()` also fires on a hard timeout (e.g. 4s) so a restore hang never leaves a black screen. Log if the timeout path is hit (it shouldn't be).
**Accept:** lock/unlock 10× → never see the green sans-serif card flash or a mode-switch; the app appears already-settled in read mode. No black-screen hangs.

---

### S5 — Off-screen position restore + skipCardDisplay (kill the visible mis-scroll) · effort: M · risk: medium
Restore the scroll while hidden, verify the landing, then reveal — and don't render a card first for read titles.
- In `reading-mode-paged.js`, do the bookmark-chunk restore while the reader is `visibility:hidden` (as `pagedPrewarm` already does, ~:2567), and only flip visible after `_waitForPagedLayout` succeeds AND the bookmark chunk reports a non-zero rect. Move the `viewEl.style.visibility='visible'` in `openView` (~:3375) to AFTER `centerOnActiveCard`/scroll lands (~:3417). For launch/title-open restore, do NOT set `pv.style.visibility='visible'` synchronously in `shell.js switchMode` (~:345) — keep hidden until openView confirms the landing.
- Harden the cold-WebView layout wait: if `_waitForPagedLayout(2500)` (~:2876) times out or the chunk rect is zero-width (~:2880), retry on the next rAF batch rather than falling back to raw scroll/0 (~:2888) — never reveal at the wrong spot.
- Port the Library path's `skipCardDisplay` (`index.html:2076`) to the cold-start deck-restore path: when `targetMode==='read'`, load the deck/cards WITHOUT calling `displayCard()` (gate the displayCard calls reached via `loadDeckState`'s progressive load), so a read title never renders a card first.
**Accept:** entering a restored read title shows the correct line immediately with NO visible scroll-from-top; no card frame appears before the reader.

---

### S6 — Stop self-inflicted place loss · effort: S–M · risk: medium
- **Boot guard:** `evaluateBootGuard` (`app.js:3308-3361`) treats a still-set in-progress flag as a crash and WIPES `FILE_URI`/`CARD_INDEX`. An OS background-kill mid-load looks identical. Distinguish them: snapshot the resume anchor BEFORE clearing the flag, and on safe-boot restore FROM the localStorage mirror (S1b) instead of wiping. Narrow the guard window to only the genuinely-unsafe parse step.
- **Read-restore catch:** `reading-mode.js:3888` swallows any exception and strands the app in card mode. In the catch, after logging, still attempt `window.openReadingMode()` if `KEYS.MODE_OPEN==='true'` and notes are present — so a util/logging throw can never strand read mode.
**Accept:** force-kill DURING a deck load → next launch still restores the title + place (no empty card screen).

---

### S7 — Hard-remove bundled JMdict + largeHeap (make resets rare) · effort: M · risk: low-med
**DECISION 2026-06-04:** the user imports a comprehensive JP→EN dict, so the bundled `JMdict_english.json` is redundant → **hard remove it.** This is the **single highest LMK lever** (kills the 108MB resident Map that makes the process a top kill target) and is **independently shippable — can be done FIRST**, before the S1–S6 correctness work, for an immediate frequency drop.

> Context (why this is safe but was worth checking): JMdict is NOT dead code — `ensureJM()` (`enhanced-dictionary.js:801`) loads it unconditionally as the merged English *fallback* (`:812-813`), and `multiDictionaryLookup` (`:666`) deliberately merges it so conjugated/uncommon words (`高かった→高い`, `:672-674`) resolve when imported dicts miss. Removing it is safe ONLY because this user's imports cover JP→EN. Hence the safety guard below for other release users.

**Edits — `enhanced-dictionary.js`:**
- Delete `loadJMDict()` (def `~:500-605`, including the `testEntries` fallback `~:597`).
- Remove BOTH call sites in `ensureJM()`: the main `await loadJMDict()` (`~:813`) AND the catch-path fallback (`~:825`) — so neither the try nor the catch references the deleted function.
- Remove `JMDICT_CACHE_VERSION` + the dictCache `'JMDict'` load/save (`~:496`, `~:508-516`, `~:578-579`).
- Remove the debug HEAD fetch of `JMdict_english.json` (`~:33`).
- Update the `"Using JMDict only"` progress strings (`~:212-213`, `:245`, `:824`) to reference imported dicts.
- The lookup branches keyed on `dictName === 'JMDict'` (`~:694`, `~:745`) become harmless no-ops once JMDict never loads — leave them or clean them.

**Asset:**
- Delete `www/assets/dictionaries/JMdict_english.json` (108MB). www drops from ~198MB toward ~90MB.
- **DO NOT delete `JmdictFurigana.txt`** — that's furigana rendering data and must stay bundled (`reference_release_process`). Only the English dict goes.
- Add a one-time `dictCache` cleanup that deletes the now-orphaned `'JMDict'` IDB entry to reclaim cache space.

**Safety guard (cheap, closes the only hard-remove footgun for release users):**
- In `ensureJM()`, after loading imported dicts, if the dict count is 0 (no imported dict AND no `dictStore` entries), show a non-blocking notice: *"No dictionary loaded — import one in Preferences → Dictionaries."* So a fresh install isn't left with silent zero-coverage.

**Also:**
- `AndroidManifest.xml:3-11`: add `android:largeHeap="true"` (cheap; but removing the 108MB Map likely makes it near-moot).
- **Optional follow-up (separate slice):** imported dicts are ALSO held resident in the `dictionaries` Map and it's never freed after the `dictStore`/IDB migration (`:647`, no `.clear()`). Query imported dicts from `dictStore` on-demand and free the Map to reclaim the remaining resident cost.
- Optional, weigh against battery/Play-policy: a short-lived foreground service on entering read mode. Only if S1–S6 + this don't make resets acceptably invisible.

**Accept:** a conjugated lookup (e.g. `高かった`) still resolves via the imported dict; boot no longer parses/holds JMdict; `dumpsys meminfo` resident drops ~100MB+; www ~108MB smaller; reset frequency observably lower. cap sync BOTH after the edit.

---

## Suggested execution order for tomorrow
0. **S7 first (JMdict hard-remove)** — independent, low-risk, and the single biggest reduction in how often Android reaps the process. Ship + device-test on its own; it may make several later mitigations less urgent.
1. **S0** (confirm, ~15 min) → **S1** (durability quick-wins; ship + device-test) → **S2** (native flush).
2. **S3 → S4 → S5** as one coherent "restore fully, then reveal" push (test together on device).
3. **S6** (guard hardening). The optional "free the resident dict Map after IDB migration" follow-up can ride alongside S7 or wait.

Note: even with S7, S1–S6 are still required — they fix *correctness and invisibility* (right mode, right spot, no flash). S7 only makes the reset *rarer*, not invisible.

## Per-slice test loop
1. Edit `www/...` (and native if applicable).
2. `npx cap sync android && npx cap sync ios`.
3. `cd android && ./gradlew installDebug`.
4. `localStorage.KADOKI_DEBUG=1` in the WebView console; reproduce read→lock→wait→unlock.
5. Verify the slice's Accept criterion. For kill simulation without waiting for LMK: swipe the app from recents, or `adb shell am kill com.helica1.yama`.

## Done = all three goals hold across 10 lock/unlock cycles
Same mode (10/10), same spot (±1 line / ±10s audio), zero visible flash or scroll.
