# Changelog

All notable changes to Kadoki are documented here. Newest first.

<!-- Keep a running list here as changes are made. At release time, rename this
     heading to the version number and start a fresh empty Unreleased section. -->
## v1.4.2 — 2026-06-08

### Fixed
- **Android: the playback notification can now be dismissed.** The media notification (lock screen / notification shade) used to stay pinned forever once you'd played anything — even while paused — with no close button, so force-stopping the app was the only way to clear it. It now behaves like a normal media app: pinned while playing, and **swipe-to-dismiss when paused** (swiping it stops playback and clears it).

## v1.4.1 — 2026-06-08

### Changed
- **Card mode shows one card per subtitle.** The number of cards now always equals the number of subtitles and never changes with screen size, font, or whether the waveform is shown — multiple subtitles still appear on screen at once (the current one highlighted), and a left/right swipe moves **exactly one subtitle**. Subtitles that don't fit fade out at the bottom, and the text no longer overflows into the waveform.

### Added
- **Read mode — swipe to move one subtitle.** In an audiobook + subtitle title, a horizontal swipe in the **top two-thirds** of the page jumps back/forward one subtitle (with the same brief audio fade as the other modes); the **bottom third** still turns the page. EPUB-only books keep full-page swipes everywhere.
- **Dictionary popup font.** Pick the popup's font — System, Serif, Sans-serif, or any font you've imported — in **Preferences → Appearance → Dictionary popup**.

### Fixed
- **Reader dictionary lookups could miss the first character of a word** (you had to tap a little higher in vertical text / to the left in horizontal). Taps now reliably select the character under your finger.
- **Dictionary popup placement in Card mode.** The popup now appears next to the word you tapped — above or below, whichever has room — instead of always at the bottom, so it no longer covers the surrounding text when the word is low on the screen.
- **Your place is kept, more reliably.** The listening position is now saved by the audio player itself, so resuming after the app has been closed or backgrounded for a long time lands within a few seconds of where you were — including on Android.

### Performance
- **Lower battery use.** Waveforms animate more efficiently, off-screen animations idle instead of running, redundant background polling was removed, and the audio position updates less frequently while the screen is off.

## v1.4.0 — 2026-06-07

### Fixed
- **Your place is kept.** Fixed cases where the reading/listening position could jump *backwards* (or reset) after a resume, a mode switch, or the app refreshing in the background — your spot is now preserved. Switching titles also reliably refreshes the cards, so you never get stuck on the previous book's cards.

### Added
- **Combine short subtitles (Card mode).** Short subtitle fragments are merged into one card — fragments of a sentence and whole quotes stay together, and separate short sentences pack onto a card with line breaks. The currently-narrated subtitle is highlighted, and cards are sized to fit your screen (no scrolling unless a single subtitle is exceptionally long). Toggle in **Preferences → Card subtitles**.
- **Redesigned card-mode controls.** The waveform sits at the bottom with a row beneath it: **Play card** (play from the card's start), **Copy SRT** (the current subtitle), **Copy Card** (the whole card), and an **Auto-advance** toggle.
- **"Set playhead" in Card mode.** Open a word in the dictionary and jump the audio to the start of that subtitle (previously Read mode only).
- **Picture position** (Top / Centered / Bottom) for Anki deck card images — **Preferences → Appearance**.

### Changed
- Smoother card transitions (the upcoming subtitle scrolls up into the active position) and reader highlighting; the upcoming subtitle no longer crowds the waveform; various Card/Read polish.

## v1.3.3 — 2026-06-06

### Added
- **Audible-style `.m4b` audiobooks now play on Android.** Long, chaptered `.m4b` files that previously failed with a playback error now work in all modes — including the card-mode waveform and sending a card's audio to Anki.

### Fixed
- **iOS — a title could fail to load after the app refreshed in the background** ("Resolved path escapes the imported folder"). Titles whose media is linked from a folder now reopen reliably, without needing to re-pick the files.
- **Severe card-swipe lag** (Anki decks and audiobook card mode) that could freeze for a second or more on each card — swiping is fast again.
- **Card mode flickered the subtitle** back and forth when you swiped while the audio playhead was running; swipes are clean now.

### Changed
- **Anki deck card images are centered** vertically instead of pinned to the top under the subtitle.

## v1.3.2 — 2026-06-05

### Added
- **Plain-text (`.txt`) books** — the reader now opens a `.txt` file as well as an EPUB. Each line becomes a paragraph, and Aozora-Bunko ruby (e.g. 漢字《かんじ》) is rendered as furigana. Add one via **📁 Import folder**, or a title's **"EPUB / TXT"** read-source slot.
- **Audiobook + SRT Titles** (no book) — a Title can be just an audiobook + SRT, which enables **Card** and **Audio** modes (Read is hidden). Create one via **📁 Import folder** on a folder of audio + `.srt`, or **+ New title** → attach an audiobook + SRT.

## v1.3.1 — 2026-06-05

### Fixed
- **Audiobook position lost on restart** — if the app was closed (or reaped by Android) while you were listening, it resumed back at your *reading* spot instead of where you'd listened to. The audio playhead is now saved continuously during playback and the restore resumes from it (loses at most ~30s).
- **Send-to-Anki audio editor** — the draggable range handles could disappear while audio played, and the preview could play past the selection. The handles now stay put and grabbable, Preview stops at the selection end, and the audiobook pauses while you adjust the bounds (resuming when you close the dialog).

### Changed
- **The dictionary now pauses narration in Card mode too** (previously Read / Audio only): opening the dictionary pauses the audio and dismissing it resumes, in all three modes.
- **Gentler audio transitions** — a brief fade when the dictionary pauses/resumes playback, and when a card swipe jumps the playhead, instead of an abrupt click.

## v1.3.0 — 2026-06-05

### Added
- **Bookmarks** (hamburger menu): each time you switch from Card or Read into Audio, Kadoki silently saves the spot you were on. The menu keeps your last few spots (spaced about a minute apart) — tap one to jump straight back to that mode and exact position; a Read-mode bookmark briefly flashes the line you'd reached.
- **Custom fonts, per mode**: Preferences → Appearance → **Font family** now lets you **import your own TTF/OTF** font and pick a different one for Card, Read, and Audio. Imported fonts are listed (with delete) in the same section, and Japanese fallbacks are kept so a Latin-only font still renders kana/kanji.
- **Per-mode appearance toggles**: show/hide the **card background image**, show/hide the **waveform** (Card and Audio), and an optional **upcoming-subtitle** preview — the next line shown greyed below the current one (Card and Audio).

### Changed
- **Continuous mode is now the only mode.** Audio never stops when you switch between Card, Read, and Audio, and every view stays locked to the same playhead. The old "continue from the audiobook / resume from your reading position?" prompt and the continuous-mode toggle are gone — use **Bookmarks** to jump back to where you were reading.
- **Card-mode waveform redesigned**: each card now shows a full-width waveform spanning the line plus the silence up to the next one, with a smooth playhead that visibly advances through the gap; the draggable trim handles appear only when paused.
- **Faster, cleaner launch**: the app reopens straight into the mode and position you left — behind a brief loading cover instead of a flash of the wrong screen or a visible scroll into place.
- **Smaller app, faster dictionaries**: the bundled fallback dictionary was removed (Kadoki only uses the dictionaries you import), so the app is much smaller and lookups + startup stay near-instant even with several large dictionaries. Deconjugation was reworked to a Yomitan-style approach.

### Fixed
- **Card-mode timer didn't run during playback** — switching into Card mode while audio is playing now counts the time, like the other modes.
- **Reopening could land a few lines behind** your saved reading position, or briefly flash Card mode / scroll into place on launch — restore now lands cleanly in the same mode and spot.
- **iOS — "Failed to read SRT" on first open** of a title (a manual reload used to fix it) now self-heals automatically.
- **Android — the app would frequently cold-restart** when reopened, losing your place; it now restores reliably to the same mode and position.
- **Dictionary management**: duplicate/stale dictionary entries are cleaned up and removable, with a progress bar on import and removal.

## v1.2.1 — 2026-06-03

### Added
- **Audiobook subtitles on the lock screen** (iOS): while you listen, the current sentence shows large and centered — serif, on a soft dark backdrop — in the lock-screen / Always-On Display Now Playing artwork, updating line-by-line as the audio plays.

### Fixed
- **Reading position could be lost or jump** — a cluster of place-keeping fixes: choosing **"resume from your reading position"** when switching from Audio back to Read now reliably keeps your line instead of jumping into the middle of the book; reopening a book returns to the exact spot you left off; and EPUB-only titles now save their position reliably (even if you close right after turning a page).
- **Audio mode — left/right swipe now moves exactly one subtitle.** It previously jumped to the very start of the book; each swipe now steps one subtitle from the line you're hearing, with a brief fade across the jump so it doesn't click.
- **Read-mode character counter stuck at 0** — it now advances as you read.
- **Lock-screen ⏮ / ⏭ could jump to the start of the book** — they now move one subtitle relative to the current position.

## v1.2.0 — 2026-06-03

### Added
- **Import folder** (Library → **📁 Import folder**): pick a folder and Kadoki imports every book inside in one step. A folder can hold a single book's **epub / audio / SRT**, or contain many such sub-folders — each becomes its own Library title, with the epub paired to its matching audio and subtitles by filename. Files are **linked, not copied**, so even a large library imports instantly; each book's media is pulled into the cache the first time you open it, and re-importing skips books already in your library. Embedded cover art (epub cover / audio tag) is filled in shortly after import. Available on Android and iOS.
- **Continuous mode** (Preferences → Playback, with a quick toggle in the hamburger menu): keeps Card, Read & Audio synced to one playhead — audio keeps playing as you switch modes and each view snaps to the live position, with no "where to resume?" prompt. When off, switching out of Audio still prompts as before. Applies to audiobook / SRT titles.
- **Richer Anki dictionary cards** (optional): two new field mappings in Preferences → Anki: dictionary add-word — **Glossary** (the full multi-sense definition HTML — numbered senses, part-of-speech + dictionary pills, gloss list, identical to the in-app popup) and **Furigana** (per-kanji ruby over the headword). Both off by default; leave them unmapped to keep the plain `Meaning` behavior. Ships with a Kadoki-styled card template (front/back/styling).
- **Furigana in the dictionary**: per-kanji readings rendered over the headword (e.g. 図書館 → 図[と]書[しょ]館[かん]), from the bundled JmdictFurigana dataset, with an algorithmic fallback.

### Changed
- **A title that contains an EPUB now opens directly in Read mode** instead of Card mode — straight to the book, with no card-mode initialization flash (the brief font/color flicker). You can still switch to Card or Audio, and whichever mode you last used for a title is remembered.

### Fixed
- **Inflated book character count**: an EPUB's reported total counted punctuation and whitespace, so it read well above the real Japanese character count (e.g. ~223k instead of ~201k). Counts now use the TTU Reader Japanese-only standard (kana/kanji/ideographs only; punctuation, spaces, Latin, and furigana excluded), applied consistently across Read, Card, and Audio — so the book total, location indicator, and chars/hr all match each other and the desktop TTU reader.
- **A freshly-opened title could start partway through the book**: when another book was already loaded, opening a different title showed the previous book at its old scroll position. Opening a title now always reloads the correct book from the beginning.

## v1.1.0 — 2026-06-02

### Added
- **Print…** (hamburger menu): print or share the upcoming reading from your current position as a vertical, right-to-left **paperback-style PDF** — landscape sheets laid out as a two-page spread with a center gutter, the title on top, and the character position in the bottom outer corners. The print ends on a complete sentence, and the EPUB's own furigana is preserved. iOS opens a share sheet (email / Files / AirPrint); Android opens the print dialog (Save as PDF / printers).
- **Log printed reading** (hamburger menu, appears after a Print): enter the minutes you spent reading the printout — added to your reading stats — and the playhead jumps to where the paper left off.
- **Two-finger swipe to switch modes** — Card → Read → Audio (circular, both directions).

### Changed
- **Tap the timer to pause/resume it** — the timer pill now toggles the timer directly instead of opening a menu. **Stats…** moved to the hamburger menu.
- **Read mode resumes the timer on a slight scroll** — once the reading timer has auto-paused, a small page jiggle counts as activity and restarts it.
- **Continuous play in Card mode**: pressing play now plays straight through the silences between sentences (like Audio mode) and advances the cards as it goes, instead of skipping the gaps clip-by-clip.
- **Card/Read audio pauses when the screen turns off** — only Audio mode keeps playing in the background.
- **Audio-mode left/right swipes** (previous/next subtitle) now fire instantly during the swipe instead of waiting for your finger to lift.
- **Toasts** restyled: a dark, softly-shaded, blurred panel that fades in and out (no more green outline).
- **Splash screen** now shows the Kadoki mark on black instead of the default Capacitor logo.

### Fixed
- **iOS — audio sent to Anki wouldn't play** ("a file iOS doesn't support" / "mp3 incorrectly named"): delivered audio is now named to match its real codec so AnkiMobile accepts it (it played on Android because Android sniffs the content).
- **iOS — misleading "model/deck doesn't exist"** on send: now shows AnkiMobile's actual error message.
- **iOS — left/right swipes in Audio mode did nothing**: the scrollable container was swallowing the horizontal gesture.
- **Card-mode waveform playhead jitter** (a per-event jump that snapped back each frame), including during continuous play.
- **High battery use in Audio mode**: the waveform was redrawing ~60×/second even while paused; it now idles when paused.

## v1.0.1

### Fixed
- Removed the "Recovered from a crash" message that appeared on ordinary app starts. (Crash protection still works silently in the background.)
- The dictionary now says **"No dictionaries loaded — add one in Preferences"** when no dictionaries are installed, instead of the misleading "No definition found."

## v1.0.0

First public release.

### Reading
- **Paged reader** for vertical Japanese (tategaki) with furigana.
- **Page-turn physics** — flick to turn a page; slow drag "peeks" with a rubber-band that springs back to your spot.
- **Clean columns** — no line is ever cut in half at a page edge, on either side.
- **Synced audiobook** — the current line is highlighted green and the page follows the narrator; jump the narrator to any line.

### Three modes
- **Card / Read / Audio** all share the same position in the story; switch any time.
- Each title reopens in the mode you last used.

### Dictionary & Anki
- Tap (Read) or long-press (Card/Audio) any word for an instant lookup with deinflection.
- Send the sentence **and** the matching audio slice to Anki (AnkiDroid on Android, AnkiMobile on iOS).

### Audio
- 20 ms fade on play/pause/resume to remove clicks.
- Lock-screen / notification playback controls.

### Platform
- Android and iOS (iPhone + iPad).
- In-app import of a pronunciation-audio archive (`.tar` / `.tar.gz` / `.tar.xz`).
