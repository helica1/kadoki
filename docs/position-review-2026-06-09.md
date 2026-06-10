# Position-reliability review — 2026-06-09 (v1.4.2, ba409a3)

17 finder agents (7 code-cluster reviewers + 10 scenario tracers) over the audio-playhead /
read-position / card-index persistence and restore paths. 62 raw findings. The planned
adversarial-verification stage did not run (session limits); the three findings marked
**VERIFIED** below were hand-confirmed by direct code reading. Everything else is
agent-reported and unverified — treat severities as provisional.

## Hand-verified root causes (these explain "position jumps back after restart/resume")

1. **VERIFIED — `_norm` URL asymmetry makes BOTH native position floors dead code.**
   `reading-mode.js:3012`: `_norm` strips `file:///` (all slashes) from native URLs ->
   `data/user/0/...`, but `abAudioPath` is a bare absolute path -> `/data/user/0/...` keeps its
   leading slash. The strings can never be equal, so the warm-resume floor (live `getState()`,
   line 3019) and the cold-boot floor (`getLastSavedPosition()`, line 3041) never match and are
   silently skipped. Every restart/resume falls back to the stale JS save (up to 30s stale
   in-session; the WHOLE background listen after a suspend). Fix: strip leading slashes on both
   sides, e.g. strip scheme AND leading '/' before compare, then decode.

2. **VERIFIED — `closeAudiobookMode` can persist 0 (or a stale value) over the real position.**
   `reading-mode.js:3140` saves `abPositionRef.ms` unconditionally; `abPositionRef` starts
   `{ms:0}` (line 2084) and is only seeded by position events (2814) / foreground reconcile
   (2758) — `openAudiobookMode` never seeds it with the restored `startMs`. Leaving audio mode
   before the first position event arrives writes 0 over the good save
   (`saveAudiobookLastPosition` accepts `ms >= 0` — 0 passes). Title-switch variant: the deck
   name flips before close runs, so Title A's playhead can be saved under Title B's key.
   Fix: seed `abPositionRef.ms = startMs` at open + require `ms > 0` (or an explicit
   "position-event-seen" flag) before persisting + capture the deck name at open time.

3. **VERIFIED — `@capacitor/app` is not installed, so every `App.addListener('appStateChange')`
   hook is dead.** Absent from `package.json` and from the runtime plugin list in device logs.
   stats.js `hookCapApp()` never attaches: the Anki-roundtrip auto-clear and the authoritative
   background/foreground signal silently don't exist; only `visibilitychange` paths run.
   Fix: `npm i @capacitor/app` + cap sync (then the existing hooks come alive), or drop them.

## All rescued findings (agent-reported, unverified)

### find:Android native
- **[HIGH/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:277` — onPlayerError never resets prepared/currentUrl, so every later same-url play()/resume() runs the fast path on an IDLE errored player without prepare() — playback dead, JS told 'playing', playhead frozen
  - Scenario: User is listening mid-book; a transient ExoPlayer error fires (e.g. file briefly unreadable). They dismiss the alert and tap PLAY (or lock-screen play). The notification flips to 'Playing', JS receives onPlayingStateChanged(true) and starts the position poll, but the player is IDLE: audio is silent and positionMs is frozen at the error point forever. Scrubbing also appears dead (seekTo in IDLE just stores a pending position). wantPlaying=true additionally re-pins the notification and makes durableSaveTick re-save the frozen ms every 5s. The user sees a stuck playhead/'playing nothing' until th
- **[MEDIUM/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:724` — Lock-screen scrub (MediaSession onSeekTo) is never durably saved; combined with the v1.4.2 paused-demote (service now reapable while paused), a paused lock-screen scrub is lost on process kill and the position jumps back to the pre-scrub pause point
  - Scenario: User pauses from the lock screen (durable save lands at pause point P1, service demotes from foreground). Still on the lock screen, they drag the media-notification scrub bar forward 10 minutes to P2 and pocket the phone. Hours later Android kills the now-demoted, non-foreground service process (no onDestroy). On next app open, both the durable slot and the frozen JS save hold P1 -> audio restores 10 minutes behind where the user left the scrubber, a user-visible backward jump.
- **[LOW/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:736` — MediaSession onStop tears down without saveLastPositionNow; the onDestroy fallback save then no-ops because stopPlayback already wiped currentUrl
  - Scenario: User listens screen-off via a Bluetooth headset / car head unit (WebView suspended, so the JS 30s saver is frozen at the moment the app was backgrounded). They press the controller's STOP button -> MediaSessionCompat.Callback.onStop -> playback torn down with the durable {url,ms} slot left at the last 5s heartbeat. On next app open, the cold-boot floor (the only fresh save in this flow) restores up to ~5s behind the real stop point, and if the JS save was older the user resumes from the heartbeat value instead of the exact stop position — a small but real backward jump on every controller-stop
- **[LOW/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:291` — Switching titles (bg.play with a different url) wipes the previous title's durable slot state without a final save: startPlayback() calls stopPlayback() before any saveLastPositionNow()
  - Scenario: User is playing Title A (durable slot ~<=5s stale), then opens Title B which issues bg.play(urlB) -> full rebuild path. Title A's final seconds are never captured natively and the global slot soon belongs to Title B. Normally the JS per-deck save covers Title A, but in the known windows where the JS save for A is wrong (e.g. the closeAudiobookMode 0-write before the first position event, or a frozen background save), the native slot was the only rescue and it is gone -> reopening Title A restores from the stale/0 JS value, a backward jump or reset for that title.

### find:Cold-boot restore chain
- **[HIGH/certain]** `www/reading-mode.js:3140` — closeAudiobookMode persists unseeded abPositionRef (0) over the real saved audio position during boot-restore audio spin-up
  - Scenario: Cold boot with lastMode='audio' on an .m4b title saved at e.g. 45:00 → openAudiobookMode resolves startMs=45:00 (cold-boot floor works) and issues bg.play, but abPositionRef stays {ms:0} for the seconds-long native prepare (or forever, if play errors). User taps READ or CARD inside that window → setShellMode awaits closeAudiobookMode → READING_AUDIO_LAST_POS_<deck> is overwritten with 0. It is silently masked while the single global native slot (kadoki_audio_pos) still holds THIS title's url; the moment the user listens to any other title (startPlayback overwrites the slot within 5s) and later
- **[HIGH/likely]** `www/app.js:3961` — abPositionRef is never reset on title switch — previous title's playhead gets saved under the NEW title's position key
  - Scenario: User listens to title A up to 2:00:00, then opens title B from the Library (loadTitleAsSrtCards → resetCrossTitlePositionState → bg.stop()). abPositionRef.ms is still 7,200,000. User enters B's audio mode; before the first native position event arrives (seconds for a big file), they background the app (visibilitychange→hidden → flushAudioPositionNow) or tap back out of audio (closeAudiobookMode) → READING_AUDIO_LAST_POS_<B> = 2:00:00, title A's position. Next audio open of B seeks deep into the wrong place (the native floor is forward-only and url-matched, so it cannot lower the bogus value ba
- **[HIGH/likely]** `www/app.js:2489` — Deferred deck card-index restore (saved index ≥ 20): boot signals content-ready while currentCardIndex is still 0, and the late jump never notifies the reader — read mode opens at the book start and can durably overwrite the bookmark
  - Scenario: Deck+EPUB title, last read deep in the book (saved card 2000, lastMode='read'). Cold boot: reader (pre-warmed at +250ms) opens before the background processor reaches card 2000 → centerOnActiveCard anchors on card 0 → the reader visibly opens at the BOOK START instead of the saved line. The later background jump calls displayCard() only, so the reader is never re-centered. If the user backgrounds the app or switches modes while it shows the start, _saveBookmarkNow overwrites PAGED_BOOKMARK_<book> with the book-start chunk → the read place is durably lost.
- **[MEDIUM/certain]** `www/shell.js:523` — shell.js sets _reentryCardCueIdx on titleOpen/boot restores into READ despite the comment claiming it doesn't — bookmark (M1) restore path is bypassed on every launch into read mode
  - Scenario: Any cold boot or library title-open that restores into READ runs the card-anchored positioner instead of the per-book line bookmark. For SRT titles the cue anchor is usually close (cue space ≈ read line), but whenever currentCardIndex is stale relative to the bookmark — the deferred deck restore (finding above), or a deck+SRT title where the user last advanced cards rather than reading — the reader opens on the card's line, not the line the user was reading, and the wrong line can then be re-persisted as the new bookmark.
- **[MEDIUM/certain]** `www/app.js:3702` — Safe-boot treats any process death during a deck load (including LMK/user-kill during BOOT auto-restore) as a crash: wipes the legacy pointer, quarantines the title, and suppresses ALL auto-restore until a manual Library open
  - Scenario: User launches the app; boot auto-restore starts loading their big deck; they background it (or swipe it away) before the load finishes and Android kills the process. Next launch: safe boot → no title auto-opens, deck name shows 'No file chosen', the title is quarantined, and EVERY later launch also boots empty until they manually reopen from the Library. To the user this reads as 'the app reset and forgot my book/position' (the place data survives in TITLES_V1 but is never applied).
- **[MEDIUM/certain]** `www/reading-mode.js:144` — Audio position key is the title's display name — renaming a title orphans READING_AUDIO_LAST_POS_<old> with no titleStore fallback, so audio restore eventually lands at 0
  - Scenario: User renames a title in the Library, then listens to any other title (the global native {url,ms} slot is overwritten), then cold-boots or reopens the renamed title in audio mode → getAudiobookLastPosition reads the new-name key (missing) → startMs = 0, both floors fail (getState not ready; getLastSavedPosition url = the other title) → the audiobook restarts from 0:00.
- **[MEDIUM/likely]** `www/app.js:468` — Boot fallback to legacy deck restore after an SRT-title load failure keeps the failed title's _activeTitleId — another deck's card index then gets persisted into the wrong title
  - Scenario: iOS evicts the cached SRT of the user's current audiobook title; cold boot: loadTitleAsSrtCards alerts and returns false → the app silently auto-restores some OLD Anki deck from the legacy ankiDeck* keys. The user swipes a few cards in that old deck → titleStore.setCardIndex writes that deck's card indices into the AUDIOBOOK title's lastCardIndex (cue space) → when the audiobook title later loads correctly, its card/read position restores to a wrong cue — the saved place was corrupted by another title's cursor.
- **[LOW/certain]** `www/shell.js:935` — LAST_MODE_V1 global mode fallback is clobbered to 'card' at every boot before restoreActiveTitleMode reads it
  - Scenario: A title that has never been mode-switched since per-title lastMode shipped (t.lastMode missing) was last used in READ mode. On relaunch the global fallback should reopen read, but it has already been overwritten to 'card' → the app reopens in card mode showing the card cursor instead of the user's reading position (the wrong cursor domain is presented; per-mode positions themselves survive).
- **[LOW/certain]** `ios/App/App/BackgroundAudioPlugin.swift:381` — iOS stop() never durably saves before wiping the player (Android ACTION_STOP does) — boot-time bg.stop() after a WebView content-process reload, or any in-session title switch, discards the final native progress
  - Scenario: iOS: user is listening in the background; iOS kills the WKWebView content process (memory pressure) while the native player keeps playing; reopening the app reloads JS → boot calls bg.stop() which silently drops the playhead without a final durable save → the subsequent audio restore falls back to the last 5s-tick value (or, if the app is then jetsamed before any new save, the JS pref frozen at background time) → playback resumes up to ~5s (worst case much more) behind where the user actually was.
- **[LOW/certain]** `ios/App/App/BackgroundAudioPlugin.swift:239` — iOS paused lock-screen scrub is invisible and never persisted: position set directly on the player with no save, no event, and no timer running
  - Scenario: iOS: user pauses from the lock screen, scrubs the lock-screen slider to a new spot (e.g. back 10 minutes to re-listen tomorrow), and doesn't reopen the app; iOS later jetsams the suspended process → the durable slot still holds the pre-scrub position → on the next cold boot the audiobook restores to the pre-scrub spot, discarding the user's deliberately chosen position (forward-only floor logic can even jump them AHEAD of the spot they scrubbed back to).

### find:Mode-switch handoffs + cursor conversion
- **[HIGH/certain]** `www/reading-mode.js:1321` — READ→CARD snaps card to stale paused-audio cue: syncCardToCurrentCue trusts abCurrentCueIdx unconditionally (and it is never reset on pause or title switch)
  - Scenario: Within a title: user listens in audio mode to cue 500, pauses, switches to READ, reads forward to cue 520 (page-turns update lastReadCueIdx; flushReadPosition→persistReadCue sets currentCardIndex=520 and titleStore.lastCardIndex=520 on the switch). Tapping CARD then runs syncCardToCurrentCue AFTER the flush → updateCardIndex(500) → card view shows cue 500 (20 subtitles BACKWARD from where the user just read) and updateCardIndex durably persists 500 to titleStore (app.js:1041-1043), so an app restart in card mode also restores 500. The function's own header comment promises 'audio cue if playin
- **[HIGH/certain]** `www/reading-mode-paged.js:1645` — Read-mode subtitle swipe (readerCueSwipe) never updates lastReadCueIdx — the 400ms scroll-debounce save then reverts the just-persisted cue (and currentCardIndex) to the pre-swipe value
  - Scenario: Read mode, enriched SRT title, audio paused; the user last manually page-turned at cue 200 (lastReadCueIdx=200). User swipes the top-2/3 zone forward 10 times → each swipe seeks audio forward and persistReadCue(210) correctly saves cue 210. The final ensureGreenOnEnter smooth scroll fires scroll events; 400ms after they settle, the debounce callback runs persistReadCue(lastReadCueIdx=200) → titleStore.lastCardIndex and currentCardIndex silently revert 10 subtitles BACK while the screen still shows cue 210 highlighted. Consequences: tapping AUDIO seeks to allNotes[currentCardIndex].audiobookSta
- **[HIGH/certain]** `www/reading-mode-paged.js:2082` — CARD→READ entry: centerOnActiveCard's programmatic scroll triggers the debounced persistReadCue with a stale lastReadCueIdx from the previous read session — silently regressing the persisted cue anchor below the card the user navigated to
  - Scenario: SRT title. User reads in READ mode to cue 100 (manual page-turns set lastReadCueIdx=100). Switches to CARD mode and swipes forward to cue 150 (updateCardIndex persists titleStore.lastCardIndex=150). Taps READ: shell sets _reentryCardCueIdx=150 and the reader correctly lands on cue 150's line — but lastReadCueIdx is still 100, and centerOnActiveCard's scroll arms the 400ms debounce, which then runs persistReadCue(100): currentCardIndex 150→100 and titleStore.lastCardIndex 150→100, while the user is looking at cue 150. Backgrounding the app, or tapping CARD again (flushReadPosition, 3754-3755), 
- **[HIGH/likely]** `www/app.js:3940` — Lock-screen ⏮⏭ navigates relative to the READ/CARD cursor, not the audio playhead: _lastAudioCueIdx is overwritten by read scrolling, reader entry, and card renders
  - Scenario: Continuous mode (always on). User listens to cue 500, pauses from the lock screen (notification stays, dismissible-when-paused per v1.4.2). They open READ mode and scroll back to re-read around cue 100 — the scroll sets _lastAudioCueIdx=100. Screen off; they press ⏭ on the media notification expecting 'next subtitle from where I was listening': lockScreenCueJump(+1) seeks the audiobook to cue 101's startMs — a backward jump of ~400 cues (potentially an hour of audio). The subsequent pause/background native durable save (BackgroundAudioService ACTION_PAUSE / handleOnPause) and the JS 30s saver 
- **[MEDIUM/likely]** `www/reading-mode.js:2399` — Audio-mode cue swipe before the first position event seeks to the book start: navByDx falls back to posMs=0 when abCurrentCueIdx/abPositionRef are not yet populated
  - Scenario: Cold app start restores into AUDIO mode at a saved 45:00; openAudiobookMode issues bg.play({startMs:45min}) but ExoPlayer is still parsing a large .m4b (no position event for seconds — the loading dots are showing). The user swipes left to skip to the next subtitle during that window: abCurrentCueIdx=-1, posMs=0 → target = cue 0 → bg.seek(~0) overrides the pending 45-minute start and playback begins at the book start. The JS 30s position saver (reading-mode.js:2830-2838, not forward-only by design) and closeAudiobookMode (reading-mode.js:3137-3141) then persist ~0 over the 45-minute save, and 

### find:Paged reader place persistence
- **[HIGH/likely]** `www/reading-mode-paged.js:2082` — Title switch clobbers the NEW title's saved place with the OLD title's read cue (stale lastReadCueIdx persisted by the unguarded scroll-debounce during EPUB load/prewarm)
  - Scenario: Session: user reads title A in READ mode to subtitle ~4200 (lastReadCueIdx=4200). They open title B (audiobook+SRT+EPUB, saved at cue 120) from the Library; B's cards restore to 120 and shell's title watcher fires pagedPrewarm → loadEpubFromUri(B) replaces the reader DOM → scrollLeft clamps → scroll event → 400ms later persistReadCue(4200) runs with _activeTitleId=B (B has >4200 cues, so the bound check passes) → TITLES_V1[B].lastCardIndex becomes 4200 AND window.currentCardIndex silently flips to 4200. User-visible: B's card view jumps to card ~4201 on the next swipe/re-render, and after an a
- **[HIGH/likely]** `www/reading-mode-paged.js:3718` — Deck+EPUB read re-entry always re-anchors to the active CARD and ignores the saved paged bookmark — read-ahead is lost and the deep bookmark gets overwritten
  - Scenario: Deck+EPUB title, active card 50. User reads ahead 20 pages past card 50 in READ mode (the 5s settle bookmarks the deep line). They switch to CARD mode (or close/reopen the app with lastMode=read). On the next READ entry the reader scrolls back to card 50's sentence instead of the bookmarked deep line; after the user sits 5 seconds on that page, _settleBookmark overwrites PAGED_BOOKMARK_<book> with the card-50 chunk → the 20 pages of read-ahead position are permanently lost.
- **[HIGH/likely]** `www/app.js:2489` — Boot restore of a deck title with saved card ≥ 20 centers the reader on card 0; the deferred index jump never re-centers (no notifyCardIndexChanged) and the book-start position then gets persisted
  - Scenario: Deck+EPUB title, saved card index 150, lastMode='read'. Cold boot: autoRestoreFromTitles mirrors 150 into pendingCardIndex; the first 20 notes render at card 0; shell restores READ; runReaderEnterSetup's centerOnActiveCard runs while currentCardIndex is still 0 (background processor hasn't reached note 150) → reader opens at the BOOK START instead of card 150's line. The later background jump sets the index and re-renders the (hidden) card view but never re-centers the reader. If the user then backgrounds the app or pauses 5s, _saveBookmarkNow/_settleBookmark persist the book-start line over t
- **[MEDIUM/certain]** `www/shell.js:373` — Read-exit position flush is dead code: shell hides the paged view BEFORE dispatching shell:mode-change, so flushReadPosition never runs on any read→card/audio switch
  - Scenario: SRT or deck+EPUB title: user turns 2-3 pages quickly (each <5s apart, so the settle never fires) in READ mode, then taps AUDIO or CARD. The bookmark anchor stays several pages back and — because the reader is hidden for the rest of the session — is never freshened again (the visibilitychange flush at 2094-2102 requires the reader visible). If the process then dies without a clean read-mode exit (crash, force-stop, swipe-away without visibilitychange), the next cold boot / plain reopen into READ lands on the stale bookmark (ensureGreenOnEnter(bmCue) at 3711-3737 has top priority on plain reopen
- **[MEDIUM/likely]** `www/reading-mode-paged.js:3084` — loadEpub restore window not fully guarded: raw-fallback scroll counts as a USER scroll (arming the 5s settle at a clamped near-0 position) and suppressScrollSave starts only after several awaits
  - Scenario: Slow Android cold boot straight into READ of a large EPUB-only/deck+EPUB book bookmarked deep: vertical-rl layout takes >2.5s, _waitForPagedLayout times out, the bookmark chunk has no rect → raw scrollTo clamps to ~page 1 and is mis-classified as a user scroll → the 5s settle fires and overwrites PAGED_BOOKMARK_<book> with a near-0 chunk → the book now durably reopens at the start instead of the deep position (the one anchor that was supposed to be layout-proof). Variant: backgrounding the app in the ~10-50ms pref-read gap during a visible read-entry load persists bookmark ≈ 0 the same way.

### find:Persistence durability + key hygiene
- **[CRITICAL/certain]** `www/reading-mode.js:3140` — closeAudiobookMode persists stale/zero abPositionRef under the CURRENT deck name — deterministically writes title A's playhead (or 0) into title B's saved audio position
  - Scenario: Scenario 1 (cross-title overwrite): user listens to title A in AUDIO mode (abPositionRef.ms = e.g. 2:00:00), opens the Library and taps title B → loadTitleAsSrtCards sets #deckName to B, then setShellMode (prevMode='audio') calls closeAudiobookMode → READING_AUDIO_LAST_POS_B is overwritten with A's 2:00:00. Next time the user enters AUDIO on B (or cold-boots into it), openAudiobookMode (reading-mode.js:2994-2995) seeks B's audiobook to A's timestamp — B's real place is durably gone. Scenario 2 (restart-to-zero, the R2 class): cold boot restores into audio at a saved deep position; the .m4b is 
- **[HIGH/certain]** `www/reading-mode.js:144` — Audio playhead is keyed by the mutable, non-unique title DISPLAY NAME — renaming a title orphans its saved position (restores at 0:00); duplicate names share one position key
  - Scenario: User renames a title in Edit Title (e.g. fixes a typo), later cold-boots or reopens the title and taps AUDIO → getAudiobookLastPosition reads READING_AUDIO_LAST_POS_<newName> = unset → startMs = 0; the native url-matched floors rescue only if the global durable slot still holds this exact title's audio file — after listening to anything else, playback auto-starts at 0:00 instead of e.g. 5:12:00. Conversely, two titles that end up with the SAME name (two imports of the same book, two un-renamed 'New title' entries, same-named files from folder import) silently SHARE one position key: listening 
- **[HIGH/likely]** `www/title-store.js:78` — TITLES_V1 parse/read failure triggers a destructive rebuild that is immediately persisted — one bad read permanently wipes all per-title positions, modes, and non-deck titles
  - Scenario: Process is killed mid-write of the TITLES_V1 SharedPreferences value (or any one-off Preferences.get bridge failure at boot) → next launch, load() catches the failure, rebuilds from the legacy deck list, and persists it over the real data → the user's library reopens missing titles, every surviving title restored to the stale legacy cardIndex (or 0), lastMode gone (all open in card), and the furthest-listened recovery anchors orphaned. The safe behavior would be to NOT persist the rebuilt list until a real write happens (or to keep the corrupt blob aside); persisting immediately makes a transi
- **[MEDIUM/certain]** `www/reading-mode-paged.js:1839` — Read position keys PAGED_BOOKMARK_/PAGED_LAST_SCROLL_ are keyed by EPUB FILENAME — two titles whose books share a filename overwrite each other's reading place
  - Scenario: User folder-imports two different books whose EPUB files share a name (e.g. '01.epub' or '本文.epub' in different folders), or attaches same-named epubs to two titles. Reading deep into book X persists PAGED_BOOKMARK_01.epub = chunk 4200; opening book Y (also '01.epub') restores chunk 4200 OF BOOK Y — an arbitrary wrong page (or clamped/no-rect fallback to raw scrollLeft from X's layout). Reading a few pages in Y then overwrites X's anchor, so X's place is also lost. The 5s settle + close flush make the cross-write durable within one short session.
- **[MEDIUM/certain]** `www/bookmarks.js:72` — BOOKMARKS_V1 and AUDIO_FURTHEST_V1: the Capacitor Preferences 'durability mirror' is write-only — reads use localStorage only, and the first write after a localStorage wipe destroys the surviving mirror too
  - Scenario: iOS evicts WKWebView website data under storage pressure (or the user clears browsing/site data on Android) while Capacitor Preferences (UserDefaults/SharedPreferences) survive. On next launch the Bookmarks menu is empty and 'Furthest listened' is gone — exactly the recovery anchors meant to survive such a wipe — even though intact copies sit unread in Preferences; 20 seconds into the next listen, updateFurthest overwrites the Preferences copy with the rebuilt map, making the loss permanent. Combined with findings 1/2 (primary audio key zeroed/orphaned), the user's last line of place-recovery 
- **[MEDIUM/likely]** `www/index.html:2085` — Furthest-listened high-water gets permanently polluted with the PREVIOUS title's playhead: _activeTitleId is switched to the new title while the old title's audio is still emitting position events
  - Scenario: User is listening to title A at 7:30:00 (audio keeps playing while browsing the Library — continuous mode never pauses), taps title B → for the seconds until bg.stop() lands, every position tick writes updateFurthest(B, 7:30:00). B's AUDIO_FURTHEST_V1 entry now permanently claims 7:30:00. Later the user opens Bookmarks in title B to recover their place and taps the pinned 'Furthest listened · 7:30:00' → jumpToFurthest seeks B's audiobook to A's timestamp (possibly past B's end) — the dedicated place-recovery feature itself causes a huge wrong jump, and because the map never regresses, B's real
- **[LOW/certain]** `www/shell.js:72` — LAST_MODE_V1 is clobbered to 'card' on every boot before the mode restore reads it — the global last-mode fallback is dead, so titles without a per-title lastMode always reopen in card mode
  - Scenario: A title whose titleStore.lastMode was never written (or was lost via finding 'TITLES_V1 destructive rebuild') relies on the global fallback: user was reading in READ mode, app is killed overnight, relaunch → boot writes LAST_MODE_V1='card' before restoreActiveTitleMode reads it → app reopens in CARD mode at the card cursor instead of READ at the reading line. Wrong cursor domain is restored (mode-level place loss); the comment at shell.js:380-382 ('localStorage LAST_MODE_V1 ... stays as the global fallback') describes behavior that cannot occur.
- **[LOW/likely]** `ios/App/App/BackgroundAudioPlugin.swift:163` — iOS durable {url,ms} resume slot stores an absolute NSTemporaryDirectory path — an app update (data-container relocation) makes the saved url unmatchable, silently disabling the cold-boot floor
  - Scenario: User is killed mid-listen (durable slot = the only sub-30s-accurate save), then installs an app update before reopening. On launch the audio file is re-materialized under the NEW container path; openAudiobookMode's cold-boot floor compares the new path against the old-container url and rejects it → restore falls back to the JS READING_AUDIO_LAST_POS save, which is up to ~30s stale (or, combined with the closeAudiobookMode zero-write finding, 0) → audio resumes behind where the user actually was. Every iOS app update silently burns the durable slot once.

### find:iOS native
- **[HIGH/likely]** `ios/App/App/BackgroundAudioPlugin.swift:653` — Natural end-of-file rewinds AVAudioPlayer to 0; every iOS position store then adopts/persists 0 (restart-at-start + durable-slot poisoning after a fell-asleep listen)
  - Scenario: User falls asleep listening on the lock screen; the chapter/book audio file plays to its natural end overnight (WebView suspended, JS per-deck pref frozen at the backgrounding-time position M, possibly hours behind). AVAudioPlayer rewinds to 0 and the lock screen shows 0:00. Next morning: (a) user taps play on the lock screen or the in-app PLAY button → bg.resume()/p.play() restarts at 0:00 — book start — and within ~30s the JS 30s-throttled saver plus the native 5s tick overwrite READING_AUDIO_LAST_POS_<deck> and the durable {url,ms} slot with near-0 values, durably destroying the place (only
- **[MEDIUM/certain]** `ios/App/App/BackgroundAudioPlugin.swift:239` — iOS never durably saves on pause or on paused lock-screen scrub (Android saves on every pause) — a paused scrub or final pre-pause seconds are lost if iOS kills the suspended app
  - Scenario: User pauses from the lock screen mid-background-listen, then drags the lock-screen scrubber forward 10 minutes while paused (p.currentTime is set natively; the position timer is stopped and JS is suspended, so neither the durable slot nor any JS store ever learns of it). Hours later iOS jetsams the suspended app (no willTerminate for suspended apps). Next launch: cold-boot restore uses the JS pref (flushed at backgrounding) floored by getLastSavedPosition — both hold the pre-scrub position → the user's deliberately-set position is silently lost, a 10-minute backward jump from where they left t
- **[MEDIUM/likely]** `ios/App/App/BackgroundAudioPlugin.swift:230` — iOS lock-screen prev/next-cue (⏮⏭) executes in suspended JS — queued remoteCommand replays on foreground as a large backward seek (or the buttons are simply dead)
  - Scenario: User listens on the lock screen; at minute 10 they tap ⏭ (or ⏮) — nothing happens audibly because JS is suspended, so they give up and keep listening to minute 30. They then unlock and open Kadoki → the queued remoteCommand replays → lockScreenCueJump seeks to (cue-at-minute-10 ± 1) → audio audibly jumps ~20 minutes backward the moment the app foregrounds, and the subsequent position events save that regressed position to READING_AUDIO_LAST_POS_<deck> and the durable slot. (If WebKit instead drops the queued eval, the lock-screen cue buttons are silently non-functional on iOS — no position dam

### trace:S10-ios-longbg
- **[CRITICAL/certain]** `www/reading-mode.js:3012` — URL normalization is asymmetric — the warm getState floor AND the cold-boot getLastSavedPosition floor NEVER match, so every restart restores the stale JS save (whole background listen lost)
  - Scenario: iOS: user plays in AUDIO mode at 14:00:00 into the book, backgrounds the app, listens 2 more hours on the lock screen (JS frozen — the only JS save is flushAudioPositionNow at background-entry = 14:00:00; the native 5s tick keeps UserDefaults at ~16:00:00), then force-quits from the app switcher and relaunches. Boot restores lastMode='audio' → openAudiobookMode reads getAudiobookLastPosition = 14:00:00; warm floor breaks immediately (player nil, ready=false); cold-boot floor reads the durable {url, 16:00:00} but _norm(url) never equals _mine → NOT adopted → bg.play({startMs: 14:00:00 - 150}) —
- **[HIGH/certain]** `www/reading-mode.js:2745` — Foreground after a background listen reconciles only abPositionRef — cue cursors (abCurrentCueIdx, _lastAudioCueIdx) and the audio-mode UI stay hours stale while paused; one cue swipe then seeks the playhead hours backward
  - Scenario: iOS: user listens in AUDIO mode, backgrounds, listens 2h, pauses from the lock screen (very common before pocketing the phone), later opens the app. The audio view still shows the subtitle/time from 2 hours ago (user-visible wrong position), even though reconcileAudioFromNative fixed abPositionRef. User swipes left on the subtitle to 'go to the next sentence' → navByDx steps from the 2h-old abCurrentCueIdx → bg.seek lands 2 HOURS back; the next save (first position event after >30s gap saves immediately, reading-mode.js:2830-2838, plus the native 5s tick) persists the regression. Same for lock
- **[MEDIUM/likely]** `ios/App/App/FileAccessPlugin.swift:260` — iOS durable url is an absolute container path — every app UPDATE (TestFlight build install) changes the container UUID, so the cold-boot floor can never match across updates even once the _norm bug is fixed
  - Scenario: TestFlight user (the actual dev/user workflow) listens 2h in the background, the app is killed without another foreground (JS save = background-entry), then installs the next build and relaunches. rehydrateTitleCachePaths re-materializes the audio under the NEW container UUID; the durable slot still holds the OLD-UUID url → url match fails → cold-boot floor skipped → restore falls back to the hours-stale JS save = backward jump of the whole background listen, recurring on every update. Fix needs a path-stable comparison (e.g. compare only the deck_<hash>.<ext> tail) or storing a container-rela
- **[LOW/certain]** `ios/App/App/BackgroundAudioPlugin.swift:323` — iOS native pause paths and the paused lock-screen scrub never write the durable {url,ms} slot — a jetsam kill after them restores up to 5s back, or discards the user's deliberate scrub entirely
  - Scenario: User listens 2h in background, pauses from the lock screen, then scrubs the lock-screen slider forward 10 minutes to skip a recap (changePlaybackPositionCommand sets p.currentTime, nothing is saved anywhere, no JS event — JS is frozen). The suspended app is later jetsam-killed overnight. On relaunch the durable slot still holds the pre-scrub ms (itself up to 5s behind the pause point), so (once the Finding-1 url match is fixed) the restored position silently drops the scrub — the position the user last saw on the lock screen is not the one restored. Without a scrub the loss is bounded at ~5s b
- **[LOW/likely]** `ios/App/App/BackgroundAudioPlugin.swift:654` — Book finishing during a background listen rewinds AVAudioPlayer to 0; the next play tap restarts at 0 and the immediate-save path overwrites the per-deck position with ~0
  - Scenario: User backgrounds in AUDIO mode and the audiobook plays to the end during the 2h background (or they fall asleep). On foreground the UI still shows the last position; user taps PLAY (audiobookTogglePlay → getState playing=false → bg.resume()) → the book audibly restarts at 0:00, and within ~150ms-30s both the per-deck JS save and the native durable slot are overwritten with ~0 — the 'end of book' place is reset to the start (only the forward-only AUDIO_FURTHEST_V1 bookmark survives). Violates the never-reset-to-0 invariant on a natural end-of-file.

### trace:S2-lmk-coldboot
- **[HIGH/certain]** `www/reading-mode.js:3140` — Post-cold-boot exit from audio mode persists READING_AUDIO_LAST_POS = 0 (abPositionRef never seeded with the restored startMs; closeAudiobookMode lacks the >0 guard its sibling flushAudioPositionNow has)
  - Scenario: Android LMK kills the app mid-listen at 45:00 (durable native slot = {thisUrl, ~45:00}). User reopens → cold boot restores into AUDIO (lastMode='audio') and the cold-boot floor correctly issues bg.play({startMs:~45:00-150}). While the .m4b is still preparing (multi-second window — no position event has arrived, abPositionRef.ms is still the boot default 0), the user taps the CARD or READ tab → closeAudiobookMode writes READING_AUDIO_LAST_POS_<title> = 0, clobbering the ~45:00 JS save. This is masked while the native slot still holds this title's url (floors repair the next entry), but if the s
- **[MEDIUM/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:724` — Android: lock-screen/notification seek while PAUSED is never durably saved — the demoted (reapable) service loses the scrub on LMK kill, so cold boot restores the pre-scrub position
  - Scenario: User pauses from the media notification while the app is backgrounded (durable slot saved at P, FGS demoted → process is now LMK-reapable by design). User drags the notification/lock-screen seek bar forward 10 minutes to P+10 (seekToMs updates only the in-memory cachedPositionMs), intending to resume there later. Hours later Android LMK reaps the process (no callbacks fire). On the next app open, getLastSavedPosition returns {url, P} → audio restores at P, 10 minutes behind where the user deliberately placed the playhead (a backward scrub is likewise reverted forward — either way the user's ch

### trace:S3-lockscreen-pause
- **[CRITICAL/certain]** `www/reading-mode.js:3012` — Audio restore url-match never matches on Android: _norm strips the path's root slash from file:/// urls but not from bare abAudioPath, so BOTH the warm getState floor and the cold-boot getLastSavedPosition floor are dead code — restart/resume replays from the stale JS save (backward jump), never the exact native save
  - Scenario: Android: user listens in AUDIO mode to 45:00, locks the screen (JS flush at lock; 30s-throttled saves continue while playing screen-off, so READING_AUDIO_LAST_POS_<deck> ends ≤30s behind, e.g. 44:38), pauses from the lock-screen controls (MediaSession onPause durably saves the EXACT 45:00 to kadoki_audio_pos, Service:721). Process is killed during the hour (likely — the v1.4.2 demote dropped the process out of foreground-service priority). User reopens the app → cold boot restores into audio → openAudiobookMode: startMs = 44:38 from the JS pref; warm floor: service dead (ready=false) → skipped
- **[HIGH/likely]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:222` — v1.4.2 demote-while-paused lets Android's background-execution limits stop the service within minutes; reopening the app and pressing PLAY then silently no-ops (bg.resume on a fresh unprepared service), pins a stuck foreground notification, and the only recovery paths replay through the dead floor (backward jump)
  - Scenario: Android: user playing in AUDIO mode, locks screen, pauses via lock-screen controls (demote), waits an hour with the process surviving. The OS stopped the demoted service minutes after the pause (notification disappeared). User unlocks, opens the app (reconcileAudioFromNative no-ops: getState ready=false), presses PLAY → silence; a pinned 'Playing' notification appears with no audio; repeated presses do nothing; scrub and ±skip also do nothing. To get audio back the user must switch modes and re-enter audio (closeAudiobookMode→openAudiobookMode) or restart the app — both replay via bg.play(star
- **[LOW/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:736` — MediaSession onStop tears down playback without saveLastPositionNow (unlike the ACTION_STOP intent handler), losing up to 5s of the durable native position when a media-controls STOP arrives while playing
  - Scenario: User is listening with the screen locked; a STOP transport command arrives via the media session (Bluetooth headset/car unit stop button, system media panel stop) instead of pause. Native teardown skips the final exact save. If the process then dies before the user reopens the app, the next restore starts from the last 5s-heartbeat value (and the JS pref may be ~30s older) → resumes up to several seconds (JS-path: up to ~30s) before where playback actually stopped.
- **[LOW/likely]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:724` — Lock-screen seek while PAUSED is not durably saved on Android (onSeekTo has no saveLastPositionNow) — a hard kill before the graceful service stop restores the pre-scrub position
  - Scenario: Android: user pauses from the lock screen (durable slot = pause position), then drags the lock-screen scrub bar forward 10 minutes while still paused (notification controls remain for ~a minute post-demote). cachedPositionMs moves, but the durable slot still holds the pre-scrub value. If the process is then SIGKILLed (LMK) before the system's graceful service stop (whose onDestroy would have saved the post-scrub value), reopening the app restores audio to the pre-scrub pause point — the lock-screen scrub is silently lost (position comes back 10 minutes behind where the user set it).

### trace:S4-read-audio-restart
- **[CRITICAL/certain]** `www/reading-mode.js:3012` — URL normalizer strips the path's leading slash asymmetrically, so BOTH native position floors (warm getState + cold getLastSavedPosition) never match — every restart/resume restores from the stale JS save
  - Scenario: S4 + the common background variant: user listens in AUDIO mode, locks the screen / switches apps and keeps listening 30 min (iOS suspends the WebView, so the JS saver — flushAudioPositionNow at visibilitychange-hidden, reading-mode.js:2777-2786 — froze at the lock moment; the NATIVE durable {url,ms} kept tracking every 5s, Swift:605 / Service:152-157). User force-quits (or iOS kills the app), reopens. Boot restores into audio: startMs = the frozen JS save; the cold-boot floor that was built to rescue exactly this case rejects its own saved value because "file:///var/..." normalizes to "var/...
- **[HIGH/certain]** `www/reading-mode.js:3140` — closeAudiobookMode persists unseeded abPositionRef.ms (0) — quick mode-switch right after a cold-boot audio restore durably overwrites the good saved position with 0
  - Scenario: User force-quits at 50:00, reopens. Boot auto-restores into AUDIO (lastMode='audio') and bg.play({startMs≈50:00}) is issued; the big .m4b is still preparing (no position event yet, abPositionRef.ms still 0). User immediately taps CARD/READ to check something → setShellMode → closeAudiobookMode → READING_AUDIO_LAST_POS_<deck> = 0. Next AUDIO entry: startMs = 0; the native floors that should rescue it (service is alive, ready, SAME url, positionMs≈50:00 ahead) never match (finding 1) → bg.play(startMs 0) → same-url fast path seeks to 0 (Service:206-208) → book restarts from the beginning, and th
- **[MEDIUM/certain]** `www/reading-mode-paged.js:3812` — Read-exit flush is dead code: shell hides the paged view BEFORE dispatching shell:mode-change, so the 'leaving read → flushReadPosition' branch never runs on any read→card/audio switch
  - Scenario: S4 step 1: user is in READ mode, turns a page (or the audio-follow turns it), and within ~5s taps the AUDIO tab, listens, force-quits, reopens, later re-enters READ. The exit flush that should capture the exact line (bookmark chunk anchor + scrollLeft + persistReadCue) never ran: the bookmark anchor is stuck at the last 5s-stillness settle and the cue/scrollLeft at the last 400ms scroll-debounce. Reader reopens one page / a few lines BEHIND the line the user was actually on — precisely the regression the _saveBookmarkNow(force) comment ('exit flush would otherwise ... reopen a few lines behind
- **[MEDIUM/likely]** `www/reading-mode-paged.js:2058` — During read-along (audio playing in READ mode) the persisted read cursor never advances: audio-follow scrolls are programmatic-gated, so lastReadCueIdx, the bookmark anchor, and titleStore.lastCardIndex stay frozen at the session-entry line
  - Scenario: S4 exactly: user enters READ mode at cue 100 with audio playing and reads along hands-off for 20 minutes while the reader auto-scrolls to cue 250. User switches to AUDIO (read cursor persisted = cue 100), listens 5 more minutes, force-quits, reopens. Audio restores correctly (modulo finding 1), but the title's lastCardIndex / bookmark anchor / read restore target are all still cue 100 — re-entering READ (or CARD) after the restart lands ~20 minutes of text backward, recoverable only by accepting the audio-ahead reentry dialog or continuous-mode jump. (Sporadic exceptions when a long smooth-scr

### trace:S5-card-swipe-kill
- **[HIGH/certain]** `www/reading-mode.js:3140` — closeAudiobookMode persists abPositionRef.ms=0 over the real saved audio position when leaving audio mode before the first position event (flush-guard fix is incomplete)
  - Scenario: S5 tail: user swipes through ~20 cues in card mode (place persisted at cue 20, JS audio save ≈ cue-20 ms from the hidden-flush), force-kills, reopens — card correctly restores at cue 20. User taps AUDIO; bg.play() is issued for a cold service (an Audible .m4b takes seconds to prepare per the service's own comment, so no position event arrives) and the user taps back to CARD before the first position event → closeAudiobookMode writes READING_AUDIO_LAST_POS_<title> = 0, destroying the cue-20 save. The 0 is masked while the native durable {url,ms} slot still holds this title, but after the user l
- **[MEDIUM/likely]** `www/reading-mode.js:2399` — Audio-mode cue swipe (navByDx) treats the unseeded abPositionRef.ms=0 as a real playhead during audio-entry spin-up — swipe seeks to the book start (the 'stay put when playhead unknown' guard from lockScreenCueJump was never applied here)
  - Scenario: Continuing S5: after the restart at card/cue 20 the user taps AUDIO (bg.play at cue-20 issued) and immediately swipes left on the audio view to nudge to the next subtitle before the first position event arrives (a sub-300ms window on small files, but the swipe can also race the READY edge on a slow-preparing m4b). navByDx derives the position from abPositionRef.ms=0 → seeks the audiobook to cue 0 (the book start) instead of cue 21; the first position events then report ~0, the first 30s-throttle save fires immediately (reading-mode.js:2828-2836, _abLastSaveAt starts 0) writing READING_AUDIO_LA

### trace:S6-title-switch
- **[HIGH/certain]** `www/shell.js:527` — Title-open into card mode applies the PREVIOUS title's stale audio cue (abCurrentCueIdx) to the new title's card index and persists it
  - Scenario: User listens to Title A in AUDIO mode (audio cue ~500). Opens Library, taps Title B (B.lastMode='card'; B was correctly saved at cue 80). loadTitleAsSrtCards restores currentCardIndex=80, then setShellMode('card',{titleOpen:true}) runs its async tail: prevMode='audio' + continuous=true → syncCardToCurrentCue() → updateCardIndex(500) → B opens on card 501 instead of 81, and titleStore.setCardIndex(B, 500) makes it durable — B's place is gone (read mode and the next audio entry, which seeks to the current card's audiobookStartMs, both follow the corrupted anchor). The identical corruption hits A
- **[HIGH/certain]** `www/reading-mode.js:3137` — Title switch saves Title A's audio playhead under Title B's key (closeAudiobookMode + flushAudioPositionNow run after #deckName flips, abPositionRef never reset) and never flushes it under A's own key
  - Scenario: Round trip: listen to A (audio mode, 2h10m in), open B from Library (B.lastMode='read' or 'card') → READING_AUDIO_LAST_POS_<B> is overwritten with 2h10m (A's playhead). (1) B-side: next time openAudiobookMode resolves startMs from the saved pref — cold-boot restore with lastMode='audio', the deck/EPUB card→audio entry where _pagedReadCueStartMs() is null (reading-mode.js:2988-2995), or resumeOnly with a dead service — B's audio starts at A's 2h10m, an arbitrary forward or backward jump, and B's true value is permanently overwritten (only the furthest-listened bookmark remains as recovery). (2)
- **[MEDIUM/likely]** `www/reading-mode.js:3038` — Cold-boot durable-position floor is defeated when the audio cachePath changes between sessions (exact-path url match) — restore falls back to the frozen JS save, losing the whole background listen
  - Scenario: User listens to A on the lock screen for an hour with the app backgrounded (JS suspended, so READING_AUDIO_LAST_POS_A is frozen at the background-entry value; only the native {url,ms} slot tracks the real playhead). iOS kills the app; the user installs an app update (container path changes), or the cache file is evicted and re-materialized to a different path. Next launch into A's audio: getLastSavedPosition returns the correct ms but with the OLD path → `_norm(_ls.url) === _mine` is false → startMs falls back to the hour-old JS save → playback resumes a full hour backward.
- **[MEDIUM/likely]** `www/reading-mode.js:141` — All audio position/pairing state is keyed by title display NAME — two titles with the same name share one position slot and even each other's audio file
  - Scenario: User imports two volumes that end up with the same display name (e.g., re-importing the same audiobook, or two files named identically). Listen to copy A to 3h, then open copy B and enter audio mode: openAudiobookMode resolves the pairing under the shared name → it may load A's audio FILE and will read A's 3h saved position; listening to B then overwrites A's slot, so A later restores to B's position. The two titles' audio playheads permanently overwrite each other on every alternation.

### trace:S7-anki-roundtrip
- **[HIGH/likely]** `www/stats.js:441` — Every Anki send opens a >=30s window where backgrounding does NOT pause card/read audio (foreground auto-clear of the roundtrip flag is dead code — @capacitor/app not installed) → unattended playback runs away and persists an unrecoverable forward place-loss
  - Scenario: User listens in read mode (whispersync) or card-mode continuous play. They mine a word and send it to Anki (dict popup or swipe-up), then within 30 seconds lock the phone / press home — the natural "added the card, done for now" gesture. The designed card/read background pause (stats.js:440) is suppressed by the still-active roundtrip flag, so the audiobook keeps playing unattended with the screen off — on iOS potentially until the end of the book (the 30s clear-timer is frozen with the WebView; nothing ever pauses). When the user reopens the app, the audio playhead, READING_AUDIO_LAST_POS_<de
- **[MEDIUM/likely]** `www/reading-mode-paged.js:2099` — Anki-hop hidden flush persists a STALE lastReadCueIdx as the title's card index during hands-free read-along (read cue cursor never follows audio auto-scroll) → card position restores far backward after a background kill
  - Scenario: Audiobook+SRT+EPUB title, read mode: user scrolls to their line (lastReadCueIdx = cue 100), presses play, and reads along hands-free for 40 minutes (audio auto-scroll only; playhead now at cue 400). They long-press a word and send it to AnkiMobile -> the URL hop backgrounds the app -> the hidden flush writes TITLES_V1.lastCardIndex = cue 100 (40 min old) while the bookmark and audio-ms saves correctly record cue 400. iOS jetsams Kadoki while AnkiMobile is frontmost (or the user restarts later). On relaunch, read mode reopens correctly at cue 400 via the bookmark — but the boot restore set curr

### trace:S8-audio-focus
- **[HIGH/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:304` — No audio-focus handling anywhere: phone call never pauses playback, playhead runs away forward and every durable store (incl. never-regress furthest mark) commits the runaway
  - Scenario: User is listening in AUDIO mode (screen off or app foreground). A phone call arrives and the user answers; the InCallUI takes over for 10 minutes. Because the app holds no audio focus and registers no focus/phone-state listener, ExoPlayer never pauses — the playhead advances through the entire call (the media stream is typically muted by telephony routing, so the user hears none of it). Every 5s the native durable slot {url, ms} and every 30s the JS per-deck pref absorb the advancing position; AUDIO_FURTHEST_V1 ratchets forward and can never be corrected. After the call the user returns to the
- **[MEDIUM/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:298` — No ACTION_AUDIO_BECOMING_NOISY handling: Bluetooth headphone disconnect keeps playing (on speaker), position over-runs and is durably committed before the user can pause
  - Scenario: User listens via Bluetooth headphones in audio mode; the headphones power off / walk out of range mid-playback. Android broadcasts ACTION_AUDIO_BECOMING_NOISY, which the app ignores, so playback re-routes to the phone speaker and keeps running. The user fumbles to pause from the notification (or doesn't notice for a while, e.g. phone in another room when the BT range dropped); meanwhile the playhead advances and the 5s native heartbeat + furthest-listened high-water commit it. When they reconnect and tap play on the notification, audio resumes correctly in place (that path is clean) — but in p

### trace:S9-dismiss-notification
- **[MEDIUM/certain]** `www/reading-mode.js:3146` — Audio-mode PLAY is dead after dismissing the paused notification: bg.resume() on the destroyed service has no bg.play fallback, so the user cannot resume from their place
  - Scenario: Android: user listens at 45:00, pauses (in-app or lock screen), swipes the now-dismissible notification away (v1.4.2 deleteIntent -> ACTION_STOP destroys the service; position 45:00 IS durably saved at BackgroundAudioService.java:244 before currentUrl is wiped). Later the user reopens the still-alive app (audio mode view still showing 45:00) and presses the PLAY button -> shellTogglePlay (shell.js:743) -> audiobookTogglePlay -> bg.resume() on a player-less service -> silence. Every subsequent press repeats the same dead resume (the new instance reports ready:false forever), so playback can nev
- **[MEDIUM/certain]** `android/app/src/main/java/com/example/app/BackgroundAudioService.java:222` — ACTION_RESUME on an empty (post-dismiss) service promotes a pinned, non-dismissible 'Playing' notification that reports position 0:00 — regression of the v1.4.2 stuck-notification fix class (display only; it can never SAVE 0)
  - Scenario: Android: user pauses at 45:00, dismisses the notification (service destroyed, position durably saved), reopens the app and presses PLAY (finding 1's dead resume). A NEW foreground service appears with a pinned, non-swipeable 'Anki Deck Reader / Playing' media notification whose seekbar reads 0:00 — the user sees their position 'reset to 0' on the notification/lock screen while nothing plays, and cannot swipe it away (exactly the stuck-notification class v1.4.2 shipped to fix; only tapping the notification's pause button, which routes through MediaSession onPause -> showPausedNotification demot


---

# Feature map: smart rewind (30s back after >10 min break, audio mode only)

# Smart Rewind (-30s after >=10min idle) — Implementation Map

All JS paths under `/Users/jacobmandell/Desktop/Android Anki/Anki Deck Reader - Android/my-app/www/`, Android under `.../my-app/android/app/src/main/java/com/example/app/`, iOS under `.../my-app/ios/App/App/`. Remember to `npx cap sync android` + `npx cap sync ios` after www edits.

---

## (1) Every path where AUDIO-mode playback starts/resumes

### A. In-audio-mode resume of a paused, loaded player (the common "come back after a break" gesture) — REWIND APPLIES
| # | Trigger | Path | Final native call |
|---|---|---|---|
| A1 | Shell play pill (audio mode) | `index.html:755` `shellPlayBtn` → `shellTogglePlay` `shell.js:735-744` → `audiobookTogglePlay` `reading-mode.js:3146-3152` | `bg.resume()` at `reading-mode.js:3151` (`else await bg.resume();`) |
| A2 | Down-swipe on audiobook view | `onAudiobookSwipeEnd` `reading-mode.js:2483-2490`: `bg.getState().then(s => { if (s?.playing) bg.pause(); else if (s?.ready) bg.resume(); })` | `bg.resume()` at `reading-mode.js:2488` |

### B. Audio-mode entry that starts playback (`openAudiobookMode`, `reading-mode.js:2899-3123`) — REWIND APPLIES ONLY ON THE SAVED-POSITION BRANCH, AND ONLY IF NOT CURRENTLY PLAYING
All shell entries funnel through `setShellMode` async tail `shell.js:485-506` → `openAudiobookMode({seekToCurrentPosition, resumeOnly})`. Inside, startMs resolution order:
- **B1 — Bookmarks/furthest one-shot** `_pendingAudioStartMs` (`reading-mode.js:2970-2978`, stamped by `bookmarks.js:118-119`): deliberate jump → **never rewind**.
- **B2 — `seekToCurrentPosition`** (card/read cursor seek, `reading-mode.js:2979-2991`): deliberate cursor-follow → **never rewind**.
- **B3 — saved-position fallback** (`startMs == null` branch, `reading-mode.js:2993-3048`): `getAudiobookLastPosition` + warm `getState()` floor (`:3014-3030`) + cold-boot `getLastSavedPosition()` floor (`:3038-3046`) → `bg.play({url, startMs: adjStart})` at `reading-mode.js:3096` (`adjStart = startMs − AUDIO_START_OFFSET_MS(150)`, `:3058`). **This is the cold-boot-restore-into-audio path (auto-plays!) and the plain tab-into-audio path → rewind applies here**, but only when native isn't already playing.
- **B4 — `resumeOnly` branch** `reading-mode.js:3071-3078` → `bg.resume()` at `:3075` (tab-dismiss reentry, lock-screen follow-up, continuous-mode entry per `shell.js:494-495`). Rewind applies **only if `s.playing === false`** (continuous mode arrives here with audio running — must not touch it).
- **B5 — `_floorRaised` branch** `reading-mode.js:3079-3094` → `bg.resume()` at `:3087`. `_floorRaised` requires `ready && url match && ahead` but NOT playing — native can be paused-warm here. Same rule: rewind only if `!s.playing`.

### C. Native-direct resumes (JS not in the loop at the moment of `play()`) — NEEDS NATIVE-SIDE HOOK OR IS EXCLUDED
| # | Trigger | Code |
|---|---|---|
| C1 | Android lock-screen / media-notification PLAY | `BackgroundAudioService.java:700-713` `MediaSessionCompat.Callback.onPlay()`: `exo.play()` directly, then `listener.onRemoteCommand("play")` |
| C2 | iOS lock-screen / Control Center play | `BackgroundAudioPlugin.swift:188-199` `playCommand`: `p.play()` directly, then `notifyListeners("remoteCommand", ["action":"play"])` |
| C3 | iOS toggle (headphones etc.) | `BackgroundAudioPlugin.swift:208-223` `togglePlayPauseCommand` play branch |
| C4 | JS follow-up to C1/C2 | `app.js:4061-4072` remoteCommand `'play'` → `setShellMode('audio', {force:true, resumeOnly:true})` → B4 with `s.playing === true` → plain `bg.resume()` (idempotent). **Do NOT rewind here** — see Risk R-iOS-deferred below. |

### D. Out-of-scope plays (must NOT get the rewind — verify the implementation can't reach them)
- Card mode: `playCardFromStart` `app.js:1294`, dict "Set playhead" `app.js:1316`, `displayCard` SRT seek/play `app.js:3144/3155-3158`, card swipe-down transport `app.js:3440/3445-3449`, SRT PLAY toggle `app.js:4637-4649`.
- Read mode: `toggleReadingPlayback` `app.js:4616-4630`, `pagedSetPlayheadFromView` `reading-mode-paged.js:3924-3927`, `pagedPlayFromCue` `:4146`, `playFromSelection` `:818`, `readerCueSwipe` `:1642`.
- Any mode: dictionary auto-pause/resume `enhanced-dictionary.js:1673-1698` (`maybeResumeAfterLookup` → `bg.resume({fadeMs:140})` at `:1694`) — fires in audio mode too when a cue word is tapped; a 12-minute dictionary study session would otherwise rewind on popup close. Recommend excluding (it's a continuation of an interactive session, not "coming back"); flag to the user as a policy choice.
- Waveform preview `waveform.js:906`; seeks (`bg.seek` sites: scrub `reading-mode.js:2893`, `audiobookSkip` `:3159`, `navByDx` `:2417`, `jumpAudioToMs` `:1352-1356` from `openAudioSeekDialog` `app.js:1420`, `lockScreenCueJump` `app.js:3950`).
- **There is NO focus-regain auto-resume**: `stats.js:396` "On foreground, we do NOT auto-resume", and `reconcileAudioFromNative` (`reading-mode.js:2745-2772`) only adopts position, never plays. Nothing to hook there.

---

## (2) Deriving "last time the user was listening"

**Existing candidates (all inadequate — verified):**
- `AUDIO_FURTHEST_V1[titleId].ts` (`bookmarks.js:87` — `map[titleId] = { ms: Math.floor(ms), ts: Date.now() }`): only stamped when the high-water ADVANCES (`:86` `if (... ms <= cur.ms) return;`). Freezes whenever the user re-listens behind the high-water → false ">=10min idle" while actively listening → spurious rewinds. Reject.
- Native durable slot has **no timestamp**: Android `saveLastPositionNow()` stores only `lastUrl`/`lastMs` (`BackgroundAudioService.java:161-168`); iOS only `posKeyUrl`/`posKeyMs` (`BackgroundAudioPlugin.swift:159-166`). 
- `window._audiobookSessionStartedAt` (`reading-mode.js:3064`) = session START, in-memory only. `TITLES_V1.lastOpenedAt` is bumped by card/read too. Reject both.

**New state needed — recommend stamping it in the native durable slot (one new key per platform) + an in-memory JS mirror:**
- **Android**: volatile `lastListenWallMs` in `BackgroundAudioService`, persisted as a third key (e.g. `POS_KEY_TS = "lastListenTs"`) inside `saveLastPositionNow()` (`:161-168`) **only when it represents playing-time**. Write points (all already exist):
  - 5s heartbeat while playing — `durableSaveTick` `:152-157` (`wantPlaying` gated already).
  - ACTION_PAUSE `:221` — runs while `wantPlaying` is still true (fade pending) → stamps correctly.
  - **Gotcha**: media-session `onPause` `:714-723` sets `wantPlaying = false` (`:717`) BEFORE `saveLastPositionNow()` (`:721`) — a naive `if (wantPlaying) stamp` misses the lock-screen pause. Stamp the volatile explicitly inside the pause-transition blocks (`onPause` `:716-720`, `fadeOutThenPause` runnables `:492/:512`) instead of inferring from `wantPlaying` at save time.
  - Also stamp on `seekToMs` (`:608-639`) — any deliberate seek = user engagement, prevents rewinding on top of a fresh scrub.
  - Initialize the volatile from prefs in `onCreate` (`:140-146`) so a service restart keeps it.
- **iOS**: `lastListenWallMs` property; stamp in the position timer while `p.isPlaying` (`swift:598-609`, piggyback the existing 5s `saveLastPositionNow` at `:605`), in every pause transition (`pause()` `:333-358`, `pauseCommand` `:201-207`, toggle pause branch `:210-213` — note iOS pause does NOT currently call `saveLastPositionNow`, the known gap), in `seek()` `:397-427`, persisted to UserDefaults in `appDidBackground` `:122-126` / `appWillTerminate` `:131`.
- **Expose to JS**: add `lastListenAt` to `getLastSavedPosition` (`BackgroundAudioPlugin.java:273-281`, `swift:170-179`). JS keeps a cheap in-memory mirror: stamp `window._lastListenWallMs = Date.now()` in the `position` listener (`reading-mode.js:2813-2815` — the Android poll `BackgroundAudioPlugin.java:137` and iOS timer only run while playing, so every event = listening) and in `flushAudioPositionNow` `:2777-2786`.
- **Gap rule**: `gap = now − (window._lastListenWallMs || native lastListenAt)`. **Unknown timestamp (neither exists) → NO rewind.** Safe default is "don't move".

---

## (3) Recommended choke points

There is no literal single choke point — resume happens in three layers (JS `play({startMs})`, JS `resume()`, native-direct remote play). Minimal-surface design = **2 JS spots + 1 native helper per platform**:

**JS spot 1 — `openAudiobookMode` saved-position branch (covers B3 incl. cold boot).** After the floors finish (i.e., after `reading-mode.js:3047`, before `:3058`), and only when `startMs` came from the `startMs == null` branch AND `!_floorRaisedWithPlaying`:
```js
if (gap >= 10*60*1000 && !nativeIsPlaying) startMs = Math.max(0, startMs - 30000);
```
Ordering is critical: the floors are **forward-only** — applied after a rewind they would raise `startMs` right back and silently cancel it; applied before (correct), they first establish the true spot, then you subtract. Never implement via `_pendingAudioStartMs` (it's consumed at `:2970-2975` BEFORE the floors, so a rewind smuggled through it would subtract 30s from a possibly-stale JS save instead of the floored truth — a real backward jump beyond 30s).

**JS spot 2 — a tiny shared helper for the resume sites (covers A1, A2, B4, B5).** E.g. `async function maybeSmartRewindBeforeResume(bg)`: `getState()`; if `!s.playing && s.ready && gap >= 10min` → `await bg.seek({ms: Math.max(0, s.positionMs - 30000)})`, stamp `window._lastListenWallMs = Date.now()` (one-shot latch), then caller proceeds with `bg.resume()`. Insert before `bg.resume()` at `reading-mode.js:3151` (audiobookTogglePlay), `:2488` (down-swipe), `:3075` (resumeOnly), `:3087` (_floorRaised). All four are in reading-mode.js, so the helper lives there. The `mode-audio` body-class check is implicit for A1/A2 (audio-mode-only UI) and B4/B5 (entering audio); do NOT call it from any section-D site.

**Native spot — media-session play (covers C1–C3, the notification/lock-screen play).** Android `onPlay` (`BackgroundAudioService.java:700-713`): before `exo.play()`, if `prepared && now − lastListenWallMs >= 10min` → `exo.seekTo(Math.max(0, exo.getCurrentPosition() − 30000))`, stamp `lastListenWallMs = now`. iOS `playCommand`/toggle play branch (`swift:188-199, 215-219`): same before `p.play()`. **Do NOT also hook ACTION_RESUME / the plugin `resume()`** — JS owns those (spot 2), keeping policy (audio-mode-only, dict exclusion) in JS and guaranteeing no double-apply: JS resume → ACTION_RESUME (no native rewind); lock-screen play → native rewind → remoteCommand → `app.js:4071` resumeOnly → B4 sees `s.playing === true` → JS skips. If you'd rather defer all native work (it's the UNTESTED v1.4.2 surface), shipping JS-only is coherent — lock-screen resumes simply don't rewind (the `!playing` gate makes C4 a safe no-op).

**One-shot / no-double-apply mechanics:** stamping `lastListenWallMs = now` at the instant a rewind is applied makes it self-latching — a second resume 2s later sees gap ≈ 0. The only cumulative-drift case is "resume → rewind → instant pause → wait 10min → repeat" (each cycle −30s); it's user-driven, bounded per event, and clamped at 0 — acceptable, but if you want to cap it, skip the rewind when `s.positionMs` is already ≥30s behind `bookmarks.getFurthest(titleId).ms` (`bookmarks.js:97-101`).

---

## (4) Never-lose-place invariant — risks + safe-by-construction rules

- **Rule 1 — rewind only at a paused→playing transition you are about to perform.** Gate every JS application on `getState().playing === false`. Never seek backward on already-running audio.
- **R-iOS-deferred (the trap that WILL violate the invariant if missed):** iOS suspends the WebView in background; `notifyListeners("remoteCommand")` from a lock-screen play (`swift:198`) is processed only when the app foregrounds — possibly **minutes into fresh listening**. If the JS remoteCommand handler (`app.js:4063-4072`) applied a gap-based rewind, it would compute the gap from a pre-suspension stamp and yank the live playhead back mid-listen. Rule 1 kills this (playing===true by then). Same reasoning forbids rewinding inside `reconcileAudioFromNative` (`reading-mode.js:2745`) — it runs on every focus/pageshow and must stay adopt-only.
- **Persisted truth is never rewound while paused.** With spot 2's `seek(paused) → resume()` there is a millisecond window where the playhead sits at pos−30s before play. Audit of writers in that window: Android durable save fires on pause/heartbeat-while-playing only (`Service:152-157, 221, 721`) — not on seek — safe; JS `saveAudiobookLastPosition` writers (`reading-mode.js:2764, 2784, 2836, 3140`) fire on position events (playing), hide, and audio-exit — a `visibilitychange→hidden` landing exactly between seek and resume could persist pos−30s while paused, but the very next play continues from there, so worst case = re-hearing ≤30s, never losing forward place. The forward-only `AUDIO_FURTHEST_V1` high-water (`bookmarks.js:86` never-regress guard) is structurally immune — confirm no new code writes it. Once actually playing, the 5s native heartbeat / 30s JS saver persisting the rewound live position is the explicitly-accepted behavior (it IS the playhead).
- **Recommended answer to the "is saving the rewound live position OK" question: yes, and don't fight it.** Treat the rewind as a real seek the user could have made: a kill 2s after resume restores at pos−28s (re-listen, bounded, forward of nothing). Trying to keep a shadow "un-rewound" position would reintroduce exactly the dual-cursor divergence class that caused the historical backwards-jump bugs.
- **Clamp + cross-title safety:** `Math.max(0, …)` everywhere; the rewind always derives from the just-floored/url-matched position or `exo.getCurrentPosition()` of the loaded item, never from a raw pref, so it can't cross titles or amplify a stale save.
- **Threading (Android):** the native seek in `onPlay` runs on the main looper (media-session callbacks do) — same thread as ExoPlayer per the single-thread invariant (`Service:43-49`); use `exo.seekTo` directly, not `seekToMs(…, fadeMs)` (whose fade path defers the seek `:614-633` and could land it AFTER `exo.play()` started at the old spot).
- **Threshold constants:** define once in JS (`SMART_REWIND_IDLE_MS = 600000`, `SMART_REWIND_MS = 30000`) and mirror in the two native files; native uses them only for the lock-screen path.

Files to touch: `www/reading-mode.js` (helper + 5 call-site edits), `www/app.js` (none required; do NOT touch the remoteCommand handler), `android/.../BackgroundAudioService.java` (ts tracking + onPlay rewind), `android/.../BackgroundAudioPlugin.java` (`getLastSavedPosition` +`lastListenAt`), `ios/.../BackgroundAudioPlugin.swift` (ts tracking + playCommand/toggle rewind + `getLastSavedPosition`).

---

# Feature map: background/screen-off in read/card -> switch to audio mode

# Implementation Map: Auto-switch to AUDIO mode on background (read/card + audio playing)

All JS paths relative to `/Users/jacobmandell/Desktop/Android Anki/Anki Deck Reader - Android/my-app/www/`, native to `.../my-app/android/app/src/main/java/com/example/app/` and `.../my-app/ios/App/App/`.

## (1) Current lifecycle handlers (verified)

**CRITICAL FACT: `@capacitor/app` is NOT installed** (verified in `my-app/package.json` deps: only core/filesystem/preferences/splash-screen/file-access). So `window.Capacitor.Plugins.App` is undefined, and stats.js's `hookCapApp` (stats.js:463-481) silently never attaches — the `appStateChange` listener and its `markAnkiRoundtripDone`-on-foreground are **dead code**. `document.visibilitychange` is the ONLY live background/foreground signal in JS (reading-mode.js:2788-2791 comment confirms this is deliberate). All three listeners, in registration order (stats registers at parse; the other two lazily, so later):

1. **stats.js:447-454** — hidden → `pauseAudioForBackgroundIfInteractive()` (440-445: **immediately pauses BackgroundAudio if NOT `mode-audio` && `window._bgPlaying` && no Anki round-trip**) + `scheduleBackgroundStop()` (422-428: 10s grace → `stopInteractiveTimersForBackground()` 399-409, stops card/read timers `{byBackground:true}`, suppressed by `_ankiRoundtripActive`). visible → `cancelBackgroundStop()` (429-434).
2. **reading-mode.js:2794-2805** (`abAttachForegroundHooksOnce`) — visible/`pageshow`/`focus` → `reconcileAudioFromNative()` (2745-2772: adopts native `getState().positionMs` into `abPositionRef.ms` both directions, saves per-deck pref + furthest-listened). hidden → `flushAudioPositionNow()` (2777-2786).
3. **reading-mode-paged.js:2092-2103** — hidden → `_saveBookmarkNow()` + raw scrollLeft save + `persistReadCue(lastReadCueIdx)`, only while the reader is the live view (`_readerHidden()` gate at 2096).

Native (fire regardless of JS): Android `BackgroundAudioPlugin.java:82-85` `handleOnResume` (poll 150ms), `:90-94` `handleOnPause` (poll 1000ms + `service.saveLastPositionNow()`); iOS `BackgroundAudioPlugin.swift:122-126` `appDidBackground` (durable save + slow timer), `:127-130` `willEnterForeground`, `:131` `willTerminate`.

## (2) The mode-switch function and background-safety

**`window.setShellMode(mode, opts)` — shell.js:274-548.** Anatomy:

- **Synchronous (guaranteed even if JS freezes right after):** force/refusal gate (281-282), `_switchInFlight` guard (303), same-mode early-return (305-326), bookmarks capture on card/read→audio (335-338, ~55s throttled), view flips (352-374: paged reader hidden via `visibility` not display), `currentMode = mode; updateTabsUI(mode)` (376-377). `updateTabsUI` (55-73) sets the **body `mode-` class**, dispatches **`shell:mode-change`** (70) — which runs stats `reconcileMode` synchronously in the same dispatch (stats.js:343-345) AND the paged reader's leave-read flush (`hookModeSwitch`, reading-mode-paged.js:3796-3815: `flushReadPosition()` at 3812 **before** hiding — bookmark + scrollLeft + persistReadCue all persisted) — and writes `LAST_MODE_V1` (72). Then `titleStore.setMode(id, mode)` is fired (383-387 → title-store.js:329-337, persists `lastMode` into TITLES_V1).
- **Async tail (429-547):** `isContinuousMode()` is hardcoded `true` (shell.js:29), so the reentry dialog is dead and: prevMode read → `await window.closeReadingMode()` (legacy stub, reading-mode.js:3995-4002 — harmless); →audio: `openAudiobookMode({resumeOnly})` where `resumeOnly = ... || (continuous && !!window._bgPlaying)` (494-495) — with audio playing this takes the resume-in-place branch (reading-mode.js:3071-3078): `await bg.getState()` → `await bg.resume()`. **No seek, no play({startMs}) — the playhead is untouched.** `bg.resume()` on an already-playing player is a no-op-ish re-`play()` on both platforms (iOS Swift:362-379; Android ACTION_RESUME).

**Backgrounded-execution difference:**
- **Android:** WebView JS keeps executing while backgrounded (this is how the existing 30s position save works in background). The full setShellMode incl. async tail and plugin bridge calls completes. Safe.
- **iOS:** WKWebView JS **freezes** shortly after backgrounding even while native audio plays (established in the place-regression diagnosis: the JS save freezes for the whole background listen). Only the synchronous part of the visibilitychange handler is guaranteed; the async tail parks at its first `await` and **resumes on thaw**. That's acceptable here because: the body class/timer/flushes are synchronous, audio is already playing natively, and the parked tail's eventual `bg.resume()` is harmless. **Gotcha:** `_switchInFlight` stays `true` until the tail's `finally` (544-546) runs at thaw — a foreground switch-back issued in the same tick would be **silently dropped** by line 303. The foreground handler must retry until `_switchInFlight` clears (or sequence after a microtask/timeout).

## (3) Stats timer attribution — instant + freeze-proof

Timers are wall-clock based: `runningSince` timestamp (stats.js:70-83); `stopMode` credits `endTs - runningSince` (168), `liveTotal` computes at read time (486-490). **So state set synchronously at hidden-time stays correct even if JS freezes 1ms later** — no ticks needed.

- Stopping read/card instantly: `reconcileMode('audio')` (stats.js:289-302) → `handleModeChange` (278-282) → `stopMode(lastMode)` — already fired synchronously by the `shell:mode-change` event inside `updateTabsUI`. Credit is exact (stop happens at the real hide moment, no cap needed).
- Starting audio attribution instantly: reconcileMode:294 `if (window._bgPlaying && inAudio && !timers.audio.runningSince) startMode('audio')` — true immediately after the body class flips. Audio has **no inactivity timeout** (160-162: `timeoutSec=0`), so the whole background listen accrues correctly across an iOS freeze; the bg `state` listener (356-369) stops it when playback genuinely pauses/ends.
- The existing 10s `scheduleBackgroundStop` becomes a no-op for this path (card/read already stopped) — harmless to leave.
- Pre-existing iOS caveat (unchanged by this feature, just wider exposure): if audio ENDS mid-background, the `state` event is frozen until thaw, so `stopMode('audio')` runs at thaw and credits the gap between audio-end and foreground as audio time. Same as today's genuine audio mode.

## (4) Anki send bracket (the exclusion)

The flag **already exists**: `_ankiRoundtripActive` (stats.js:260-274), set via `window.stats.markAnkiRoundtripActive(timeoutMs=30000)` / cleared by `markAnkiRoundtripDone` (exported stats.js:608). Already consulted by `_shouldIgnoreBump` (219), `stopInteractiveTimersForBackground` (400-403), `pauseAudioForBackgroundIfInteractive` (441).

Send sites that already set it **before** the handoff:
- `sendToAnkiConnect.js:492` — swipe-up `sendToAnki`, immediately before `ab.addNote(params)` at :507.
- `enhanced-dictionary.js:2725` — dict-popup send, same pattern.

Because `appStateChange` is dead, the flag clears **only via the 30s timeout** (stats.js:265) — and iOS freezes `setTimeout` in background, so in practice it expires shortly after return. For a <1s Anki hop the flag is reliably active when `visibilitychange:hidden` fires. **The flag is module-private** — the new trigger must either live inside stats.js (recommended) or you must add a getter (`isAnkiRoundtripActive()`) to the `window.stats` export (592-612). Android note: AnkiBridge is a synchronous ContentProvider insert, no backgrounding occurs (sendToAnkiConnect.js:497-503), so the exclusion is effectively an iOS concern but costs nothing on Android.

## (5) Previous-mode memory + foreground restore synced to audio

**Memory:** no existing slot — add e.g. `window._autoAudioPrevMode` (+ timestamp). **Durability decision:** during the auto-switch, `setShellMode` would persist `titleStore.setMode(id,'audio')` (shell.js:383-387). Recommend passing `opts.autoSwitch` and **skipping that persist** — then `TITLES_V1.lastMode` durably stays 'read'/'card', so process-death-in-background cold-boots into the prior mode at the position flushed at hidden-time (`persistReadCue`/bookmark from step 2's flush; the audio ms is independently safe in the native durable slot + per-deck pref). That makes the durable memory "free" via existing restore machinery (shell.js:1088-1135). `LAST_MODE_V1` (written unconditionally in updateTabsUI:72) can be ignored — it's clobbered to 'card' at every boot before being read anyway (shell.js:935 → :72; only read at :1113-1116).

**Foreground sync paths (already exist, both keyed off the live audio cue):**
- **→read:** `setShellMode('read')` with `prevMode==='audio'` + continuous sets `window._reentryAudioJumpCueIdx = window._lastAudioCueIdx` (shell.js:512-515) → paged `openView` → `runReaderEnterSetup` consumes it as `jumpCue`/`preferred` → `ensureGreenOnEnter(preferred)` (reading-mode-paged.js:3690-3737).
- **→card:** `setShellMode('card')` with `prevMode==='audio'` + continuous → `syncCardToCurrentCue()` (shell.js:527-535; reading-mode.js:1315-1344) maps `abCurrentCueIdx`→card, sets `_skipNextCardAudioRestart` so `displayCard` is silent (app.js:3129-3135 — no seek/restart).
- **Audio-ms adoption:** `reconcileAudioFromNative` (reading-mode.js:2745) fires automatically on visible/pageshow/focus — that's the existing HISTORY-1 adoption path.

**Cue-freshness sequencing (the one real race):** the sync sources `_lastAudioCueIdx`/`abCurrentCueIdx` are updated by `abUpdateCueDisplay` (reading-mode.js:2586-2675) from `position` events; verified the writes happen even with the reader hidden (`window._lastAudioCueIdx = idx` at reading-mode-paged.js:4244 runs BEFORE the `_readerHidden()` paint guard at 4247, and `__onPagedCueUpdate` is invoked regardless of paged visibility, reading-mode.js:2663-2674). On Android they stay fresh in background (1000ms poll). On iOS they are **frozen at the pre-background value** until the first post-thaw position event (~150ms-1s). So the switch-back must NOT run in the same tick as `visibilitychange:visible`. Sequence: (a) let `reconcileAudioFromNative` run, (b) `await bg.getState()` and feed the cue recompute — `abUpdateCueDisplay` is module-private, so expose a one-liner in reading-mode.js (e.g. `window.abResyncCueFromMs = (ms) => abUpdateCueDisplay(ms)`), or simply wait one `position` event / ~400ms, (c) then `setShellMode(prevMode, {force:true})`, retrying while `_switchInFlight` is true (see §2 gotcha).

## (6) What happens to read/card audio on background TODAY

**It is paused immediately, by design.** `pauseAudioForBackgroundIfInteractive` (stats.js:440-445) runs synchronously on hidden (447-449): `if (mode-audio) return; if (!_bgPlaying) return; bg.pause()`. So audio playing under read/card dies the moment the screen locks (Anki round-trip exempt). The pause also triggers Android's durable native save (ACTION_PAUSE → BackgroundAudioService.java:221). **This call is the exact thing the new feature replaces** — and conveniently, if the auto-switch flips the body class to `mode-audio` first, this guard self-disarms. Ordering is guaranteed if the trigger is implemented **inside stats.js's own visibilitychange handler** (replace/precede the pause call) — also where `_ankiRoundtripActive` is visible. The other two hidden-handlers are safe in any order: reading-mode's flush saves the (correct) audio ms; the paged flush either runs (reader still visible) or has already been superseded by `flushReadPosition()` from the switch's leave-read hook.

## Recommended design

**Trigger (in stats.js, hidden branch, replacing the unconditional pause):**
```
hidden:
  if (_ankiRoundtripActive) → nothing (existing exclusion; flag already set pre-addNote by both send sites)
  else if (window._bgPlaying && (mode-read || mode-card)):
      window._autoAudioPrevMode = currentMode(); window._autoAudioSwitchAt = Date.now();
      window.setShellMode('audio', { force:true, resumeOnly:true, autoSwitch:true });
      // synchronous part: views flip, read flush runs, card/read timer stops,
      // audio timer starts (reconcileMode via shell:mode-change), audio untouched
  else:
      pauseAudioForBackgroundIfInteractive(); scheduleBackgroundStop();  // existing behavior
```
**shell.js:** accept `opts.autoSwitch` → skip `titleStore.setMode` (383-387) only. Keep `bookmarks.capture` (335-338) — it snapshots the reading spot before audio runs ahead, which is exactly right here.

**Return (in the same stats.js listener, visible branch):**
```
visible:
  cancelBackgroundStop();
  if (window._autoAudioPrevMode):
      const prev = window._autoAudioPrevMode; window._autoAudioPrevMode = null;
      // wait for cue freshness (iOS thaw): bg.getState() → abResyncCueFromMs(s.positionMs)
      // (or one position event / ~400ms), then:
      retryUntilNotInFlight(() => window.setShellMode(prev, { force:true }));
      // continuous-mode machinery does the rest: read → _reentryAudioJumpCueIdx jump;
      // card → syncCardToCurrentCue (silent, no audio restart)
```

**Edge cases:**
- **Audio not playing at hidden:** no switch; existing 10s-grace timer stop + (no-op) pause — unchanged.
- **Anki round trip (<1s):** flag active → no switch, no pause, timers keep running — exactly today's behavior.
- **Process death in background:** durable state is already correct — read place flushed at hidden (paged flush/`flushReadPosition`), audio ms in native `{url,ms}` slot (Android 5s heartbeat + `handleOnPause`; iOS `appDidBackground`), and with the `autoSwitch` setMode-skip, `TITLES_V1.lastMode` still says read/card → cold boot restores prior mode at the flushed position. Without the skip, boot lands in audio mode at the saved playhead — also safe, just not "previous mode".
- **iOS freeze mid-switch:** sync part done; parked async tail resumes at thaw and ends in a harmless `bg.resume()` on playing audio. The switch-back MUST retry past `_switchInFlight` (shell.js:303) or it gets swallowed.
- **Rapid hidden→visible churn:** switch-to-audio is idempotent (same-mode early return shell.js:305); clear `_autoAudioPrevMode` on consume; consider ignoring a hidden that arrives while a return-switch retry is pending (re-arm prevMode instead of overwriting with 'audio').
- **Audio pauses/ends during background:** lock-screen pause already durably saves (Service:721 / iOS gap noted in MAP 1 #4); on foreground still return to prevMode — `_bgPlaying` false just means no jump-target update beyond the last cue, and the bookmark/stay logic biases backward, never to 0.
- **User backgrounds while a user-initiated switch is in flight:** if target is already audio, same-mode return handles it; otherwise the auto-switch may be dropped by `_switchInFlight` — acceptable (timers then stop via the 10s grace), or retry once at +100ms.
- **Side benefit:** after the switch, the card auto-advance (app.js:4100-4101 gates on `mode-card`) and reader audio-follow (paged:4247) stop doing background DOM work on Android — only `_lastAudioCueIdx` bookkeeping continues, which is exactly what the return-sync needs.

---

# Verification pass + priority ranking (2026-06-09, after the day's fixes)

4 adversarial verification agents re-checked all 59 open findings against CURRENT code
(post _norm/closeAudiobookMode/@capacitor-app fixes + features). Index numbers refer to the
findings list above. FIXED-TODAY: 0-3, 5, 11-13, 15(close-path), 24, 26, 41, 47, 60.
REFUTED/overstated: 42 (suppressScrollSave covers the raw-fallback window).
REGRESSION FOUND & FIXED SAME DAY: the auto-switch hid the reader before the paged
visibilitychange flush ran; together with the pre-existing dead leave-read flush (31/36),
fixed by shell.js flushing window.flushReadPosition() BEFORE the visibility flip.

## Tier 1 — next fixes (place-loss, frequent)
1. [31/36] Leave-read + background read flush dead — FIXED 2026-06-09 (shell pre-hide flush).
2. [46+50] Read-along never advances the persisted read cursor (audio-follow scrolls are
   programmatic-gated) -> kill/Anki-hop flush restores the session-ENTRY line after an hour
   of whispersync. daily, impact 3-4, M.
3. [7] readerCueSwipe never updates lastReadCueIdx -> 400ms debounce reverts the swiped-to cue. daily, S.
   [8] CARD->READ centerOnActiveCard persists stale lastReadCueIdx from the previous read session. daily, S.
4. Title-switch contamination cluster: [14] title-open into card applies PREVIOUS title's cue
   and persists; [17] flushAudioPositionNow/reconcile/30s-saver still key to live currentDeckName()
   (closeAudiobookMode now owns its deck, these three don't); [20] EPUB-load DOM collapse fires the
   scroll-debounce with title A's cue under title B's id; [43] _activeTitleId flips while old
   title's audio still emits position events -> furthest polluted; [6] syncCardToCurrentCue trusts
   stale abCurrentCueIdx unconditionally. weekly, impact 4, M.
5. [18/22] Deferred deck restore (saved card >=20): reader anchors at card 0, late jump never
   notifies reader, book-start can persist over the bookmark. impact 4, S-M.
   [28] Boot into READ sets _reentryCardCueIdx despite comment, bypassing the M1 bookmark. weekly, S.

## Tier 2 — Android playback reliability (new v1.4.2 surface)
6. [25/37] PLAY dead after dismissing the paused notification: audiobookTogglePlay bg.resume()
   has no bg.play() fallback on a fresh service (resumeOnly path has one). S.
   [38] ACTION_RESUME on empty service pins a non-dismissible 0:00 'Playing' notification (display only). S.
7. [4] onPlayerError never resets prepared/currentUrl -> same-url replays no-op on IDLE player
   until a title switch; playhead frozen while JS thinks it's playing. weekly, S.
8. [16] handleAudioFocus=false + no focus request: phone call doesn't pause, position runs away
   FORWARD and the never-regress furthest mark commits it. [35] no ACTION_AUDIO_BECOMING_NOISY:
   BT disconnect -> speaker playback + runaway. M.

## Tier 3 — iOS durability + stale-cursor seeks
9. [34/55/57/54] iOS never durably saves on pause/scrub/stop (Android does on pause) -> jetsam
   after pause loses <=5s or a deliberate lock-screen scrub. S (Swift).
10. [44] iOS lock-screen prev/next queue-replays into thawed JS with no freshness guard ->
    big backward seek minutes later. [19] lockScreenCueJump seeks from _lastAudioCueIdx that
    read-scroll/reader-entry/card-renders overwrite. [10] reconcileAudioFromNative refreshes
    abPositionRef but never the cue cursors (abResyncCueFromMs exists now — call it there). S-M.
11. [45/59/48] Durable {url,ms} stores an absolute container path; every iOS app update changes
    the container UUID so the cold-boot floor is dead until the next save. Store/compare a
    container-relative suffix. S.

## Tier 4 — rare but high damage, or cheap hygiene
12. [23] TITLES_V1 parse failure -> destructive rebuild persisted immediately (wipes all per-title
    positions/modes). impact 5 / rare. Cheap mitigation: keep a last-good backup + don't persist a
    rebuild triggered by a parse error. S-M mitigation, L full fix.
13. [9/30/49/32] Positions keyed by mutable display NAME (audio) / EPUB FILENAME (paged bookmark):
    rename orphans the position; duplicates collide. Migrate keys to titleId with legacy fallback. M.
14. [33] AUDIO_FURTHEST_V1/BOOKMARKS_V1 Preferences mirror is write-only — read it back when
    localStorage is empty. S.
15. [29] Safe-boot treats LMK-during-boot-load as a crash (quarantine + restore suppression). M.
    [40] SRT-load-failure fallback keeps failed title's _activeTitleId -> wrong-title persist. M.
16. [39/51/52/58/61/27] <=5s durable-save gaps (MediaSession onStop/onSeekTo, title-switch
    stopPlayback-before-save). S batch.
17. [53/56] LAST_MODE_V1 clobbered to 'card' at boot — global mode fallback dead. S, cosmetic.
