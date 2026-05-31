# Kadoki

A sideload reader for Japanese learners. Read EPUBs with a synced audiobook + subtitles (SRT), tap any word for an instant dictionary lookup, and send sentence + audio cards to Anki. Built with [Capacitor](https://capacitorjs.com/) for Android and iOS.

> Personal project, shared for anyone who finds it useful. The Android build below is a **debug** build — fine for sideloading, not from the Play Store.

## Features

- **Three modes over one position** — Card, Read, and Audio all share the same place in the story; switch any time without losing your spot.
- **Paged reader** — vertical Japanese (tategaki) with furigana, satisfying page-turn physics, and clean column rendering (no half-shown lines).
- **Synced audiobook** — SRT ↔ EPUB alignment; the current line follows the narrator, and you can jump the narrator to any line.
- **Tap-to-lookup dictionary** — JMdict / Yomitan dictionaries with deinflection.
- **Anki export** — sentence + sliced audio to AnkiDroid (Android) or AnkiMobile (iOS).
- **In-app audio dictionary import** — point it at a `.tar` / `.tar.gz` / `.tar.xz` of pronunciation audio.

## How to use

### Getting started
1. Open the **library** and add a title. Attach an **EPUB**, and optionally an **audiobook** (an audio file + a matching **`.srt`** subtitle) and/or an Anki **`.apkg`** deck.
2. Open the title. It remembers which mode you last used it in.
3. Switch modes with the **Card / Read / Audio** tabs at the top.

> **Chrome (the top bar) auto-hides.** Tap an empty area to toggle it back. Controls are text, not icons.

### 📇 Card mode — study flashcards
For an Anki deck, or for an SRT used as line-by-line cards.
- **Tap** the card → flip between front and back.
- **Swipe left / right** → move between cards.
- **Swipe up** → play the card's audio.
- **Long-press a word** → dictionary lookup.

### 📖 Read mode — paged reader
Vertical Japanese text; reading flows **right-to-left**.
- **Quick horizontal flick** → turn the page (whole columns; no line is ever cut in half).
- **Slow horizontal drag** → "peek" ahead/back with a rubber-band that **springs back** to your spot when you let go.
- **Tap a word** → dictionary popup.
- **Swipe up on a line** → set the audiobook playhead to that line and play from there.
- **Tap an empty area** → toggle the top bar.
- While audio plays, the current line is **highlighted green** and the page follows along automatically.

### 🎧 Audio mode — listen
- **Tap the center** → play / pause.
- **Swipe left / right** → previous / next line (seek).
- **Long-press** → dictionary lookup on the current line.
- Lock-screen / notification controls (play, pause, skip) are supported.

### 📚 Dictionary popup & sending to Anki
Opens when you tap (Read) or long-press (Card/Audio) a word:
- Shows readings and definitions; use the **arrows** to page through entries.
- **Set playhead** (when the title has audio) → jump the narrator to this line.
- **+ Anki** → sends the sentence **and** the matching audio slice to your Anki deck.

For Anki on Android: open **AnkiDroid → Settings → Advanced → Enable API**, then restart AnkiDroid.

## Install (Android)

1. Download the latest `Kadoki-*.apk` from the [**Releases**](../../releases) page.
2. On your phone, allow installing from your browser/files app (Settings → Apps → *your browser* → **Install unknown apps**).
3. Open the downloaded APK and install.

## Install (iOS)

iOS isn't sideloadable the same way. It's distributed via **TestFlight** (invite only) or built from source in Xcode with your own Apple Developer account.

## Build from source

```sh
cd my-app
npm install
# Android:
npm run cap:copy:android          # copies web assets + strips the bundled audio/dicts
cd android && ./gradlew installDebug
# iOS:
npm run cap:copy:ios              # then open my-app/ios/App/App.xcworkspace in Xcode and Run
```

Requirements: Node.js, and Android Studio (Android) / Xcode (iOS). The big pronunciation-audio archive is **not** bundled — import it in-app (Preferences → Audio archive).

## License

No license granted yet — all rights reserved by the author. Ask before redistributing.
