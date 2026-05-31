# Kadoki

A sideload reader for Japanese learners. Read EPUBs with a synced audiobook + subtitles (SRT), tap any word for an instant dictionary lookup, and send sentence + audio cards to Anki. Built with [Capacitor](https://capacitorjs.com/) for Android and iOS.

> Personal project, shared for anyone who finds it useful. The Android build below is a **debug** build — fine for sideloading, not from the Play Store.

## Features

- **Three modes over one position** — Card, Read, and Audio modes share the same place in the story.
- **Paged reader** — vertical-rl (tategaki) with furigana, satisfying page-turn physics, and clean column rendering (no half-shown lines).
- **Synced audiobook** — SRT ↔ EPUB alignment; the current line follows the narrator (and vice-versa).
- **Tap-to-lookup dictionary** — JMdict / Yomitan dictionaries with deinflection.
- **Anki export** — sentence + sliced audio to AnkiDroid (Android) or AnkiMobile (iOS).
- **In-app audio dictionary import** — point it at a `.tar` / `.tar.gz` / `.tar.xz` of pronunciation audio.

## Install (Android)

1. Download the latest `Kadoki-*.apk` from the [**Releases**](../../releases) page.
2. On your phone, allow installing from your browser/files app (Settings → Apps → *your browser* → **Install unknown apps**).
3. Open the downloaded APK and install.
4. For Anki export: open **AnkiDroid → Settings → Advanced → Enable API**, then restart AnkiDroid.

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
npm run cap:copy:ios              # then open my-app/ios/App in Xcode and Run
```

Requirements: Node.js, and Android Studio (Android) / Xcode (iOS). The big pronunciation-audio archive is **not** bundled — import it in-app (Preferences → Audio archive).

## License

No license granted yet — all rights reserved by the author. Ask before redistributing.
