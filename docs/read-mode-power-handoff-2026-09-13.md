# Read-mode power fixes — Codex / Claude Code handoff

Status: implemented locally; automated validation passed; physical-device validation pending. Base commit: a2030fd. See the companion `read-mode-power-audit-2026-09-13.md` for the original findings. The audit's line numbers describe the pre-patch source.

User constraint: preserve on-device transcription, word timings and automatic EPUB alignment with no preprocessing. Preserve RGB follow appearance and Speedy audio quality. This change does not remove legacy SRT support.

Files changed by Codex:

- `my-app/ios/App/App/AutoTranscribePlugin.swift`: native cancellation, serialized replacement and bounded audio input.
- `my-app/www/auto-transcribe.js`: power policy and job lifecycle.
- `my-app/www/word-highlight.js`: reuse geometry while the reading page is stationary.
- Targeted regression tests and these two power documents.
- `CHANGELOG.md`: an Unreleased entry describing these changes.

The working tree had no tracked modifications before this work. No other contributor's tracked changes were observed during it. Changes remain uncommitted for review together with Claude Code's project work. Please inspect the diff before modifying these files concurrently.

## Behavior and implementation

### Native iOS transcription

- `start` adds optional `powerUnlimited` (default false). The JS/native pair should ship together.
- Input uses `AsyncStream(unfolding:)`: the consumer requests one source chunk at a time. There is no unbounded producer-side queue and no dropping buffer policy. The analyzer can still buffer internally, so the feed ceiling remains necessary.
- Battery input is capped at ten minutes ahead of the playhead, including requests from older callers asking for an hour or no ceiling. One source chunk (at most about four seconds) can cross the ceiling. Charging or explicit unlimited work retains the caller's ceiling; current JS requests an hour for those cases.
- The native power monitor checks at startup and every five seconds while analyzing. Serious/critical thermal pressure, or Low Power Mode while unplugged, cancels recognition even without JS or playback callbacks. Explicit unlimited mode keeps its existing policy-bypass meaning. Its native value is captured when a job starts.
- `cancel()` invokes `SpeechAnalyzer.cancelAndFinishNow()`. It also works while normal EOF finalization is awaiting completion. Only normal completion drains/finalizes input; cancellation does not intentionally finish all queued recognition.
- Native replacement jobs wait on the previous job's completion task. A stop request does not clear the current slot before teardown. A replaced/cancelled job that was still waiting never starts analysis.
- Completion waits for native cancellation and the result consumer before emitting `done`. New reason `parked` identifies native power stops; `stopped`, `eof`, and `error` remain.
- Recognition/conversion failures are reported as errors rather than silently treating unfinished audio as fully covered.
- Source positioning follows actual file frames, including short reads. The word-timing parser, timestamp offset convention and EPUB aligner were not changed.

### JavaScript orchestration

- Battery starts pass ten minutes of lookahead instead of an hour. All start paths, including seeks, retries and backfill, obey power policy.
- Running jobs are checked every five seconds and after incoming cues or a fresh power-state response. This includes paused/pre-playback and legacy timing-only jobs. Device power snapshots retain the existing twenty-second cache; native iOS adds its independent five-second safeguard.
- Stopping keeps the job identity until its matching `done`. Already finalized results arriving over the bridge during teardown are merged and persisted, rather than discarded because `job` was cleared too soon. Unfinalized recognition after cancellation is left uncovered for a later pass.
- `powerInfo()` adds `stopping` and reports `parked` only after the stopping job has completed. This distinguishes a requested stop from confirmed teardown.
- Seeks wait for the correct completion event and retain the latest target. Unrelated old `done` events cannot trigger a pending restart. A stale rejected start promise cannot clear a newer title's job.
- A native power stop holds new starts until a fresh power snapshot is available. Paused mid-book work preserves its reading anchor so a power tick does not start at zero.

### Follow geometry

- Character rectangles and beam chunk rectangles are cached per active cue. Duplicate requests within a frame share the same result.
- Stationary geometry refreshes at most every 250 ms as a fallback for changes outside the observed subtree, plus as new characters are encountered.
- Scrolling and scrubbing refresh every frame, still deduplicating repeated measurements within that frame. Text changes, reader ancestor transforms/styles, resize, font loading and root/body appearance changes invalidate the cache. Observers disconnect when the reader is cleared.
- The observed text subtree excludes the follow overlays, avoiding invalidation from the animation's own style writes.
- RGB hues, gradients, movement cadence, paused shimmer, word-follow page-turn timing and Speedy processing are unchanged. No claim is made about a measured battery percentage reduction.

## Validation performed

Commands below run from the repository root (`Anki Deck Reader - Android`).

1. `node --test my-app/tests/read-mode-power.test.mjs` — **11/11 passed**. Runs production JS functions in a VM with fake bridge/DOM boundaries. Covers lookahead policy; paused thermal enforcement; in-flight timing retention/persistence; matching completion and latest seek; stale promises; native thermal hold; paused mid-book anchors; stationary geometry reuse; scrolling; mutation/font/resize/scrub invalidation; observer cleanup. In the controlled two-character/60-frame fixture, 300 requests require at most eight range measurements. This is a regression fixture, not an iPhone benchmark.
2. `node my-app/tests/run-transcribe-native-tests.mjs` — **six native check groups passed** on macOS 26.6.1 / Xcode 26.6. Extracts the actual production TranscribeJob, exposes private methods in the temporary test copy, and compiles against Apple Speech/AVFoundation. Only UIKit battery state is shimmed. Tests real audio-file reads/conversion, buffer wait/resume, short reads without lost/duplicated frames, EOF exactly at the ceiling, stop while awaiting input, native battery limits, real SpeechAnalyzer cancellation with no modules, predecessor completion ordering, and real attributed-string word timing segmentation. No speech model download or inference is performed. Test code resides in `my-app/tests/transcribe-native-regression.swift`.
3. `node --check my-app/www/auto-transcribe.js` and `node --check my-app/www/word-highlight.js` — passed.
4. `git diff --check` — passed.
5. Full unsigned **iOS Release build passed**, including a final build after the completed native edits and copied JS assets:

```sh
xcodebuild -workspace my-app/ios/App/App.xcworkspace -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/kadoki-power-derived CODE_SIGNING_ALLOWED=NO build
```

Final build log: `/tmp/kadoki-power-build-final.log`. Build product: `/tmp/kadoki-power-derived/Build/Products/Release-iphoneos/App.app`. The build is unsigned and was not installed or uploaded. Existing project/dependency warnings include missing Metal toolchain search paths, AppIntents metadata extraction and CocoaPods script outputs; the initial clean build also reports existing CoreML minimum-deployment warnings. No compilation errors remain.

The initial sandboxed Xcode invocation could not access Xcode services; the successful builds used the approved escalation. Build caches and native test fixtures live under temporary directories.

## Bundled assets and compatibility

- Copied **only** `auto-transcribe.js` and `word-highlight.js` from `my-app/www` to `my-app/ios/App/App/public`. Checked that each destination still matched the original source (or this patch) before overwriting it. These generated assets are ignored by Git; they will not appear in the tracked diff. No full Capacitor sync was run.
- The shared JS changes also affect Android after its next asset copy, but Android native code and generated Android assets were not changed or built. The extra start option is optional and Android continues to emit its existing completion reasons. Test Android stopping/resuming before releasing there.
- Source `my-app/www` is authoritative. Anyone building from another checkout must copy web assets through the project's usual Capacitor workflow.
- Legacy SRT attachment/export behavior remains for compatibility. This patch does not require users to supply SRT or preprocess audio. Removing that legacy path is separate work.
- No version bump, commit, signed build, device install, or deployment was performed.

## Physical iPhone validation still required

Use a Release build on the iPhone 17 Pro Max, fixed brightness/volume/audio route, unplugged, with comparable starting temperature. Keep Speedy and RGB follow enabled for the primary before/after comparison.

1. Open an EPUB + audiobook with uncached on-device timings. Check accurate word-follow and EPUB matching; let the buffer fill, then verify native speech activity falls when parked. Continue until the buffer drops below four minutes and verify seamless refill.
2. Pause before playback and during recognition. Check buffer and thermal limits still apply; Low Power Mode should stop recognition while unplugged and preserve existing timings. Resume after cooling/disabling Low Power Mode.
3. Seek repeatedly while recognition is active, then change titles. Confirm no overlapping recognizers, no old-title results displayed, and correct resume location.
4. Reopen the same passage to confirm cached word timings are reused. At natural EOF, confirm final words/coverage persist; cancellation must never claim queued-but-unrecognized audio as covered.
5. Test RGB follow across horizontal/vertical layout, furigana, page turns, drag-scrubbing, font-size/font changes and orientation changes. Check that cached rectangles do not visibly lag or drift.
6. Compare a thirty-minute session against the prior build, recording native CPU/speech activity, WebView layout/compositing, thermal state and battery change. Separately compare already cached passages to isolate animation/audio from initial transcription.

Remaining limitations: no end-to-end speech inference or real iPhone visual/energy trace was collected here; native tests use an empty SpeechAnalyzer for cancellation and a battery shim. Recognition of previously unseen audio and Speedy still have necessary processing costs. Background JS can be throttled; native iOS enforces its own input and power safeguards, while JS resume bookkeeping catches up when callbacks return.
