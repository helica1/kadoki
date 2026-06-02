# Changelog

All notable changes to Kadoki are documented here. Newest first.

<!-- Keep a running list here as changes are made. At release time, rename this
     heading to the version number and start a fresh empty Unreleased section. -->
## v1.1.0 — 2026-06-02

### Added
- **Print…** (hamburger menu): print or share the upcoming reading from your current position as a vertical, right-to-left **paperback-style PDF** — landscape sheets laid out as a two-page spread with a center gutter, the title on top, and the character position in the bottom outer corners. The print ends on a complete sentence, and the EPUB's own furigana is preserved. iOS opens a share sheet (email / Files / AirPrint); Android opens the print dialog (Save as PDF / printers).
- **Log printed reading** (hamburger menu, appears after a Print): enter the minutes you spent reading the printout — added to your reading stats — and the playhead jumps to where the paper left off.
- **Furigana in the dictionary**: per-kanji readings rendered over the headword (e.g. 図書館 → 図[と]書[しょ]館[かん]), from the JmdictFurigana dataset, with an algorithmic fallback.
- **Two-finger swipe to switch modes** — Card → Read → Audio (circular, both directions).

### Changed
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
