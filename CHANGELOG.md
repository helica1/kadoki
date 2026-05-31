# Changelog

All notable changes to Kadoki are documented here. Newest first.

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
