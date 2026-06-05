# Continuous-mode + pixel-perfect restore + Bookmarks + legacy removal — plan

**Created:** 2026-06-05 · **Status:** not started (design approved pending the open questions below)
**Companion:** `docs/android-resume-restore-plan.md` (restore slices S0–S7; goals 2/3 build on S3–S5).
**Invariants:** never lose the user's place (fall back to the chunk-index landing, never to 0); paged reader stays `display:flex`, only `visibility` toggles (Android relayout lag).

## The four goals
1. Mode switching FAST + 100% accurate, audio **never** stops → make **continuous mode the only mode**, remove non-continuous.
2. **Char/line-exact** EPUB restore on iOS+Android on restart/reopen (+ exact scroll-offset when layout is unchanged; true pixel-perfect only within identical layout).
3. App restore FAST, **no visible redraws or EPUB scrolling**, always lands in the **same mode**.
4. **Bookmarks** (hamburger menu): last 3 spots in Card OR Read where the user read ≥1 min; row shows mode · date/time · location (char-offset for read, card# for card); tap to jump back. Replaces the audio-reentry dialog as the "playhead ran ahead" recovery.
5. (Added) **Remove all legacy/dead code** as we go.

## The one thing that makes this hard
There is **no single playhead today** — three positions are conflated and the live audio engine runs through the *legacy* file:
- **Audio cue** = `abCurrentCueIdx` (`reading-mode.js:2005`), driven by the BackgroundAudio `position` event via `abUpdateCueDisplay` (`reading-mode.js:2524`).
- **Read cursor** = `lastReadCueIdx` (`reading-mode-paged.js:52`), advanced only by user scroll (`_creditReadCharsFromVisible`, `:1748`).
- **`_lastAudioCueIdx`** = an overloaded global written by read-scroll (`reading-mode-paged.js:1783`), audio-follow, card-sync, swipe, and lock-screen — it **conflates** the read cursor and the audio playhead.
- The paged reader's own audio path is a deliberate **no-op / dead** (`reading-mode-paged.js:3111`, `:3122`, `:3146`).

⚠️ **Burned before:** a prior attempt to prefer `_lastAudioCueIdx` over the M1 bookmark for read-entry "landed every Android open 1–2 lines backwards, blank card mode + lag" and was reverted (memory `project_m2_playhead_split`). The playhead split (B3) is the single highest-risk slice — heavy device testing, behind a flag.

---

## Workstream A — Bookmarks (Goal 4) · do FIRST
Self-contained, low-risk, and it **must exist before** we delete the reentry dialog (it's the replacement recovery path).

- **A1 — storage module** (`bookmarks.js` or a `window.bookmarks` block): `record(bm)` / `list()`. Persist a GLOBAL rolling array (last 3) under `BOOKMARKS_V1` via the title-store Preferences helper (`title-store.js:21-34`), mirrored to `localStorage` for a sync read at menu-open. Dedup: drop an existing same-`{mode,titleId}` entry within ~N chars / same card before unshifting + slicing to 3. *(small / low)*
- **A2 — capture hook** (`stats.js`): per-session `_bookmarked` flag on `timers.card`/`timers.read`; in `tick()` (`stats.js:299-330`) when `runningSince && !_bookmarked && (now-runningSince) >= 60000` → `captureBookmark(mode)`; reset `_bookmarked` in `stopMode` (`:170`). **Guard out audio mode.** Continuous-session dwell (`now-runningSince`) is correct: background/inactivity zeroes `runningSince`. *(medium / medium)*
- **A3 — location getters:** add `window.pagedGetReadLocation()` (`reading-mode-paged.js`, reuse `_visibleReadAnchors()` `:1810`, return `{chunkIdx, jpOff, bookName}`); card location = `window.currentCardIndex`. *(trivial / low)*
- **A4 — restore calls:** `window.pagedJumpToBookmark(loc)` (read: reuse `scrollChunkNearRightWithContext` `:2884`; map `jpOff→chunk` if `chunkIdx` invalid after relayout); card: `updateCardIndex(n)` same-title, or `pendingCardIndex` cross-title. *(medium / medium)*
- **A5 — menu UI** (`shell.js`): add `mkItem('Bookmarks…', …)` in `openShellMoreMenu` (`:812`); submenu lists `list()` newest-first, row = `${Read|Card} · ${date} · ${jpOff+' chars'|'Card '+n}`; tap → (if other title) open it (expose `loadTitleFromLibrary`, `index.html:2001`) → `setShellMode(mode)` → restore call. *(medium / medium)*

**Data model:** `{mode:'card'|'read', ts, titleId, titleName, location: read?{chunkIdx,jpOff,bookName}:{cardIndex}}`.
**Accept:** read ≥1 min on a line → it appears in Bookmarks with the right time/char; tap returns there (same and cross title), card and read both.

---

## Workstream B — Continuous-only + playhead split + reentry removal (Goal 1) · after A
- **B1 — make continuous permanent.** Inline `continuous=true` in `switchMode` (`shell.js:446`); DELETE the `triggerDialog` block (`shell.js:448-461`), `isContinuousMode`/`setContinuousMode` (`shell.js:26-41`) + the hamburger toggle (`:820`) + the Preferences checkbox (`preferences.js:534,594,1040`). *(small / medium)*
- **B2 — audio never pauses on switch.** In `closeAudiobookMode` drop `if (bg && !opts.keepPlaying) await bg.pause()` (`reading-mode.js:2868-2870`); pause only on explicit user Pause. Keep the position save (`:2874`). Always arm `audioAutoAdvance` when `_bgPlaying` + audiobook active (`shell.js:447`). *(trivial / medium)*
- **B3 — playhead split (M2 increment 2) ⚠ highest risk.** Introduce `window.audioPlayhead` written ONLY by the audio path (`__onPagedCueUpdate` `reading-mode-paged.js:3983`, swipe `reading-mode.js:2353`, lock-screen `app.js:3518`), reset in `resetCrossTitlePositionState` (`app.js:3532`). Replace the unconditional read-scroll clobber `window._lastAudioCueIdx = lastReadCueIdx` (`reading-mode-paged.js:1783`) with a **guarded drag** (advance audio only when it has caught up to read). Behind a flag; device-test against the known regression. *(large / high)*
- **B4 — delete the reentry dialog** (superseded by Bookmarks): `maybeShowAudioReentryDialog` + `reentryChoose` (`reading-mode.js:2896-3157`), the `#audiobookReentryModal` DOM (`index.html:1078-1090`), and the `_audioPositionUnresolved`/`_priorReaderCursorIdx`/`_priorCardIdx` machinery (`shell.js:386-403`, resets in `app.js`). *(medium / medium)*
- **B5 — delete dead paged-audio code:** `onPositionUpdate` (`reading-mode-paged.js:3122-3137`), `paintCueHighlight` (`:3146-3160`), the no-op `attachBgListener` stub. *(small / low)*

**Accept:** switching card↔read↔audio while playing never pauses audio and never shows a dialog; card auto-advances with the playhead; entering audio never rewinds. Position saved on every switch.

---

## Workstream C — Restore overhaul (Goals 2 & 3) · on the simplified model
This is `docs/android-resume-restore-plan.md` **S3–S5** plus char-exact. Do it after B so it's built on the single, simplified switch path.
- **C1 (S3) — deterministic same-mode restore:** delete the `setTimeout(…,1500)` (`shell.js:1050-1087`); `await setShellMode(targetMode,{force,titleOpen})` from `autoRestoreFromTitles` once `_activeTitleId`+`lastMode` are known. Pre-paint mode stamp: sync `<head>` script reads `localStorage.LAST_MODE_V1` → stamps `mode-*` before first paint. *(medium / medium)*
- **C2 (S4) — cover-until-settled reveal:** remove parse-time `SplashScreen.hide()` (`app.js:3467,2705`); add `revealApp()` called only after mode applied AND (for read) the paged reader confirms its anchor landed offscreen; opaque overlay + 4 s timeout safety. *(medium / medium)*
- **C3 (S5) — off-screen restore:** move `viewEl.style.visibility='visible'` (`reading-mode-paged.js:3378`) to AFTER the scroll lands; keep `pv` hidden in `switchMode` (`shell.js:345`) for launch restore; on `_waitForPagedLayout` timeout / zero-rect, **retry next rAF** instead of landing raw/0 (`:2887`); port `skipCardDisplay` to cold-start read restore. **Keep `display:flex`; gate only `visibility`.** *(medium / high)*
- **C4 (Goal 2) — char-exact + same-layout pixel-exact:** persist `{chunkIdx, jpOff, scrollLeft, layoutSig:{clientWidth,scrollWidth,fontSizePx,chunkCount}, ts}`; restore resolves the chunk from `jpOff` (survives re-pagination), and applies raw `scrollLeft` directly when `layoutSig` matches (pixel-exact). Always fall back to the chunk landing on any uncertainty. **Unify this anchor schema with the Bookmarks location (A1) in `title-store.js`** — one persistence model. *(large / medium)*

**Accept:** cold restart and reopen land char-exact in the same mode with zero visible redraw/scroll on both platforms; same-layout reopen is pixel-identical.

---

## Workstream D — Legacy / dead-code sweep (Goal 5) · interleave + final pass
- Dead files never loaded by `index.html`: **`deinflector.js`, `dictionary.js`, `dict_test.js`** (dict relics — confirmed not in the script list).
- The continuous toggle + reentry dialog + dead paged-audio (covered by B1/B4/B5).
- `lastMatchedIdx` (third legacy chunk cursor the active paged reader never advances) and any other dead cursors surfaced by B3.
- **Bigger, separate milestone (note, not now):** the live audio engine still runs through legacy `reading-mode.js` while the paged reader's audio path is dead. Fully moving the engine into the paged reader and deleting `reading-mode.js` is the "M2 S7 delete legacy" milestone — large, do last, on its own.
- Re-audit the legacy in-memory `dictionaries` Map fallback now that `dictStore` is authoritative (careful: pre-migration fallback — keep until proven unused).

---

## Sequencing
1. **A (Bookmarks)** — self-contained, must precede the reentry-dialog deletion.
2. **B (continuous-only + playhead split)** — B1/B2/B4/B5 are mechanical; **B3 is the gated, device-tested risk.**
3. **C (restore overhaul)** — S3→S4→S5→char-exact, on the simplified model.
4. **D (legacy sweep)** — delete the dead files early (free), the engine-move milestone last.

## Top risks
- **B3 playhead split has regressed before** (1–2 lines back, blank card, lag). Flag + device test; keep M1 chunk bookmark as the guaranteed read-entry anchor.
- **Two BackgroundAudio `position` listeners** (`reading-mode.js:2664` highlight vs `app.js:3639` card/lock-screen) must both be reconciled in B3.
- **Visibility-layout regression** (C3): keep `display:flex`; only gate `visibility`, or Android re-lays-out the vertical-rl canvas.
- **Removing the reentry dialog before Bookmarks ships** leaves no recovery — A before B (hard ordering).
- **Char-exact must never fall back to 0** — chunk-index landing is the floor (never-lose-place invariant).

## Open questions (need your call before C4/A finalize)
1. **Dwell = one continuous 60 s session** (clean, matches `runningSince`) vs 60 s cumulative across interruptions? *(Recommend: continuous session.)*
2. **Bookmark dedup:** allow two of the three rows in the same title if far apart? *(Recommend: yes, dedup only near-identical spots.)*
3. **Char-exact scope:** must read restore survive a **font-size re-pagination** (needs `jpOff→chunk`), or is same-layout pixel-exact enough? *(Recommend: store both; jpOff gives cross-layout for free.)*
4. **Unify** the restore anchor and the Bookmarks location into one `title-store` schema? *(Recommend: yes — avoids two parallel persistence models.)*
5. **Capture feedback:** silent, or a toast (distinct wording from the existing per-book "Location bookmarked")? *(Recommend: brief distinct toast.)*
