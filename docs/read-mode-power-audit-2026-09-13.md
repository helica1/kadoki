# Read-mode power audit — September 13, 2026

Follow-up: the fixes have now been implemented locally. See [implementation, tests and Claude Code handoff](read-mode-power-handoff-2026-09-13.md). The findings below preserve the original pre-patch audit; they are not a claim that these defects remain in the updated source.

Static review of commit a2030fd. No application behavior changed and no physical-device energy trace was collected. The reported 15% battery loss in 30 minutes cannot be apportioned quantitatively from source alone. The two inspected iOS public assets (auto-transcribe.js and word-highlight.js) match www byte-for-byte; the version installed on the user's phone is unknown.

Product constraint confirmed during review: on-device transcription is the intended primary workflow, supplying word timings and automatic EPUB matching without user preprocessing. Optimization must preserve that workflow. Cached results below mean previously generated on-device transcripts and timings; turning recognition off temporarily is an attribution experiment, not a proposed user workflow. Removing legacy SRT support is outside this audit.

## 1. Highest-priority defect: stopping transcription drains queued work

Evidence:

- `www/auto-transcribe.js:56` sets a ten-minute high-water threshold and a four-minute resume threshold, but `startJob` at line 669 still sends the native recognizer `LOOKAHEAD_MS`, one hour.
- `ios/App/App/AutoTranscribePlugin.swift:379` creates an AsyncStream with default buffering. Its feed loop at line 410 reads, converts and yields four-second audio chunks without awaiting consumption. It paces against audio **fed**, not audio recognized, so it can enqueue approximately an hour ahead of the target (or the remaining file if shorter).
- `TranscribeJob.cancel()` at line 315 only sets a Boolean. It does not cancel the analyzer or task.
- On leaving the feed loop, including cancellation, line 445 calls `finalizeAndFinishThroughEndOfInput()`. That explicitly finishes consuming the queued input and finalizing results.
- `maybeParkForPower` in JS at line 711 clears `job` immediately and requests stop. Subsequent results from the old job are rejected by `onCuesEvent` at line 751 because the job no longer matches. A later start can also replace a job without awaiting its native completion.

Implication: a parked UI is not evidence of idle speech recognition. Native recognition can continue processing queued audio after parking; useful results can be discarded, and replacement jobs may overlap the old work. The impact depends on how much input is queued when the stop occurs. This is a concrete control-flow defect, not a measured attribution of the user's battery loss.

Apple documents default AsyncStream buffering as unbounded and distinguishes immediate cancellation from finishing all input:

- [AsyncStream](https://developer.apple.com/documentation/swift/asyncstream)
- [SpeechAnalyzer.cancelAndFinishNow](https://developer.apple.com/documentation/speech/speechanalyzer/cancelandfinishnow())

Fix direction: enforce the intended lookahead natively, use consumption-aware pacing without dropping audio, cancel pending analyzer work on an actual stop, and serialize teardown/restart. Preserve already accepted subtitles. Simply changing the stream to a dropping bounded buffer would lose speech and is not an adequate fix.

## 2. Power enforcement depends on playback position callbacks

`maybeParkForPower` is called from `onPosition` (`www/auto-transcribe.js:841`). It is not called from incoming subtitle results. The thirty-second power timer at line 87 immediately returns while a job exists. Therefore an active recognition job without continuing playback events has no independent JS thermal/buffer enforcement. Native code has the hour-long feed ceiling but no equivalent battery/thermal policy.

Fix direction: native power enforcement should work while paused, during background transitions and when JS callbacks are throttled. Validate both normal subtitle generation and timing-only jobs.

## 3. RGB follow still performs continuous geometry work

`www/word-highlight.js:1545` schedules requestAnimationFrame continuously while following. A 14 ms gate limits full updates to approximately 60 Hz, but skipped frames still reschedule rAF at the browser's delivered cadence.

Each ordinary twin-beam update calls `_charRect` for the hot character, calls it again from `_hotPoint`, generally measures the next character, measures lookahead characters for the beam, and reads the chunk bounding rectangle. That is commonly around five text-range measurements plus one element measurement per full update: roughly hundreds of geometry queries per second at 60 updates/s. These calls can force style/layout synchronization; a query is not proof that a complete layout occurred.

The existing optimizations are real: moving nodes use transforms; gradient colors change only every 500 ms; line styles are cached. The remaining cost is repeated geometry plus ongoing compositing, not the former per-frame gradient rebuild. The paused twin band also has an infinite opacity animation (`kw-paused`).

Fix direction: cache character and line geometry while the page is stationary, invalidate on layout/content/font/viewport changes, handle scrolling with an offset or fresh geometry, and interpolate movement separately. Compare 30 and 60 Hz motion on-device before choosing a default. Preserve word-follow page-turn behavior.

## 4. Speedy adds sustained processing, but its share needs measurement

`ios/App/App/KadokiReadEngine.swift` decodes source-rate audio in 1,024-frame blocks, passes it through Sonic/Speedy, and supplies an AVAudioSourceNode. The producer uses userInteractive QoS and a 220 ms refill threshold. It waits on a semaphore rather than intentionally busy-spinning.

`ios/App/App/speedy/soniclib.c:457` bypasses Speedy analysis only when the nonlinear factor is zero. Otherwise it performs sample conversion, spectral/tension analysis and time stretching. Selecting 1× alone does not disable that analysis. Source already sets Sonic quality to zero, so recommending that existing optimization again would not help.

Fix direction: measure default playback, Sonic without nonlinear analysis, and Speedy at the same rate, on cached subtitles with identical follow visuals. Investigate audio block size/QoS only with underrun and seek-latency validation.

## 5. Confounders and smaller costs

- Imported SRT does not guarantee no recognition. `www/reading-mode.js:3048` activates timing-only recognition when word timing is requested; autogenerated SRT is explicitly excluded there. Check active native work, not just whether subtitles are visible.
- Xcode Debug uses C optimization level 0 and Swift -Onone (`App.xcodeproj/project.pbxproj:817`). If the phone is running a Debug build, the hot audio loops are less optimized. The installed build configuration is unknown.
- Native position events run every 150 ms while visible and every second when hidden (`BackgroundAudioPlugin.swift:1681`). JS also has play-state and follow-watchdog polls. These are secondary candidates compared with recognition and frame-by-frame geometry; reducing them blindly risks sync regressions.
- `www/power-probe.js` can report JS callback time, geometry-call counts and bridge traffic. It cannot measure native speech/audio CPU or GPU energy. Its “% cpu” is callback wall time, not an OS CPU measurement; async work is not fully attributed. Its “parked” label reflects JS state and can hide the native stop defect above.

## Device validation needed

Use the same Release build, book section, brightness, audio route, volume and playback rate, unplugged and starting from a comparable cool state. Capture native recognition/audio activity and WebView rendering, then compare:

1. Cached subtitles and cached word timings, recognition confirmed inactive, default audio engine, static follow marker.
2. Same state with RGB follow enabled.
3. Same state with Sonic, then Speedy, at the same playback rate.
4. Same playback with uncached recognition active; capture before and after the ten-minute park threshold.
5. Pause, seek and change titles during recognition; verify the old analyzer promptly stops, does not overlap a replacement, and does not continue consuming queued audio.

Prioritize transcription cancellation/pacing first, follow geometry caching second, and measured audio-engine tuning third. Keep subtitle synchronization and the visual design; eliminate unnecessary work underneath them.

For the intended transcription-first workflow, retain finalized words and their timestamps across sessions, reuse them for EPUB alignment, and produce only the missing near-future audio window while on battery. Treat queue size, recognition completion and native teardown as separate states. Resume before the buffer runs low, accounting for playback speed and measured recognition throughput. Longer ahead-of-time processing can run while charging. Recognition still has a necessary energy cost on first encounter with audio; the goal is to prevent excess work, discarded results and repeated recognition, not eliminate the feature.
