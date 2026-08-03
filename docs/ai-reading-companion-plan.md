# AI Reading Companion v2 — Dynamic Timeline + Characters

*v2 agreed 2026-06-12 (supersedes the 2026-06-11 v1 doc). v1 slices 1–4 shipped as code
(event log, ai.js transport+ledger, two-speed Haiku character pipeline, squiggles) but are
UNCOMMITTED; v2 reworks the pipeline + timeline wholesale before anything ships. Clean
schema break — no migration of AICHAR_V1 data.*

The product framing: two headline AI features, processed quietly in the background as the
user reads, surfaced with red-dot notifications:

- **Dynamic Timeline** — per-chapter plot cards on a mode-colored reading spine.
- **Characters** — a living character database, newest developments first.

---

## 1. Core principles (kept from v1, two carve-outs added)

1. **No vector RAG.** Context = chunk text + accumulated state. No embeddings.
2. **Spoiler safety is structural** — the model only ever processes text the reader has
   finished — with exactly TWO carve-outs the user explicitly approved:
   - **Segmentation carve-out:** small windows around candidate boundaries anywhere in the
     book may be sent to Haiku for *offsets-only* pseudo-chapter segmentation. The output
     is never prose, only boundary positions + neutral labels.
   - **First-chapter carve-out:** chunk 0 is processed at title open, before reading
     starts (the opening is not a meaningful spoiler; it seeds the character DB/timeline).
   - Everything else: chunk N is processed only after the reader's furthest position
     passes its end. Prompts still ban outside knowledge of the work and predictions.
3. **Enhanced info is a REWARD for finishing a chapter** (user's words). No semi-realtime
   mid-chapter extraction — the v1 fast stub lane is DELETED.
4. **BYOK** Anthropic key, `anthropic-dangerous-direct-browser-access` / CapacitorHttp.
5. **Never-lose-place invariant untouchable.** Nothing in the AI layer is read by the
   restore pipeline. Key-passage audio playback must snapshot and restore the playhead.
6. **AI failures are invisible** — degrade to "feature absent", never a broken app.
   Every module is an IIFE with try/caught entry points (match existing codebase style:
   plain scripts on `window.*`, no build step, no modules).
7. **All data per `titleId` in blobStore (IndexedDB).**
8. **All AI-generated content is Japanese.** Prompts instruct: 本文の文体・語彙にできる
   だけ忠実に (follow the book's style and vocabulary closely); summaries include short
   exact quotes from the text. Rendered AI prose is always dict-tappable
   (`window.dictEnableLookupIn`) and squiggle-marked (class `kai-summary-text`).

## 2. Coordinate spaces (the landmine — read first)

Three coexisting position spaces. The chunk map stores ALL of them per boundary so no
runtime conversion is ever needed for gating:

| Space | What | Who uses it |
|---|---|---|
| raw `charOffset` | flat text, ruby stripped, whitespace kept | cue-alignment, key-passage quote matching |
| `jpOff` | JP-only chars (`window.jpCharCount`) | read progress, event log, stats, timeline axis |
| cue index | SRT cue order; cards map via `_srtCardToCueAnchor` | audio/card progress |

Rules:
- Chunk boundaries are always snapped to `.reading-chunk` starts (block elements), so each
  boundary has exact `rawStart` AND `jpStart` from the chunk dataset. Paragraphs are never
  split by construction.
- `cueStart`/`cueEnd` per chunk come from `CUE_ALIGN_v2` (per-cue raw ranges): cueEnd =
  last cue whose rawEnd ≤ chunk.rawEnd. Only for titles with an SRT; -1 when unmapped.
- SRT-only titles (no EPUB/TXT): the chunk map lives in cue space directly; "text" =
  concatenated cue text; rawStart = cumulative cue-text offset; jp fields = jpCharCount of
  the same.
- The timeline axis is jp chars (totals persisted in the chunk map → renders without the
  reader DOM). Cue→jp display mapping is piecewise-linear per chunk using
  (cueStart,jpStart)→(cueEnd,jpEnd) — better than v1's single cueScale ratio.

## 3. Module map & file ownership

| File | Status | Role |
|---|---|---|
| `www/ai.js` | extend | transport, tiers, retry, notify bus |
| `www/ai-chunks.js` | NEW | flat-text store, chunk map, segmentation, progress/completion observer |
| `www/ai-processor.js` | NEW | per-chunk state machine, prompts, merge, catch-up |
| `www/ai-characters.js` | REWRITE | character DB v2 (chapter-grained), matcher |
| `www/ai-characters-screen.js` | NEW | Characters list screen |
| `www/ai-characters-ui.js` | tweak | squiggles+popup keep working on v2 store; expose `openPopupFor` |
| `www/ai-characters-read.js` | keep | paged-reader squiggle overlay (unchanged) |
| `www/ai-timeline.js` | REWRITE | chapter-card timeline per mockups |
| `www/ai-summary.js` | keep | session/range summaries stay as a secondary feature |
| `www/event-log.js` | keep | unchanged; spine coloring source |
| shell/prefs/index.html/app.js/enhanced-dictionary.js | tweak | menu items, red dots, prefs, exclusions |

Script order in index.html: `event-log.js, ai.js, ai-chunks.js, ai-processor.js,
ai-summary.js, ai-timeline.js, ai-characters.js, ai-characters-screen.js,
ai-characters-read.js, ai-characters-ui.js` (ai.js before all other ai-*).

## 4. ai.js extensions (transport)

- `MODELS = { high:'claude-opus-4-8', default:'claude-sonnet-4-6', cheap:'claude-haiku-4-5' }`.
- Quality pref `AI_QUALITY` ∈ `economy|balanced|high`, default `balanced`, dual-stored
  (Preferences+localStorage like AI_ENABLED). Exposed: `ai.getQuality()/setQuality(q)`.
- `ai.modelFor(task)`: `'segment'` → cheap always; `'chapter'|'finished'|'deep'` →
  economy=cheap, balanced=default, high=high.
- Retry/backoff for unattended background use: on 429/529/overloaded, honor
  `retry-after` if present else 60s, max 2 retries inside `request()` ONLY when the new
  opt `opts.retryable` is true (background callers); interactive callers keep fail-fast.
- `opts.maxTokens` already overridable — chapter processing passes 8000.
- Notify bus: `ai.emitDataChanged(titleId, kind)` dispatches window CustomEvent
  `'kai:ai-data'` `{detail:{titleId, kind:'timeline'|'characters'}}` and bumps a rev in
  blobStore `AISEEN_V1` = `{ [titleId]: { timelineRev, charsRev, seenTimelineRev,
  seenCharsRev } }`; `ai.unseen(titleId)` → `{timeline:bool, characters:bool}`;
  `ai.markSeen(titleId, kind)`. (Tiny, lives in ai.js so all modules share it.)
- Cost estimate helper `ai.estimateCostUsd(model, inChars, outTokens)` using PRICES
  (replaces ai-summary's hard-coded Sonnet math; ai-summary updated to call it).

## 5. ai-chunks.js (NEW) — text + structure + progress

**Flat text capture.** After the paged loader finishes chunk tagging (and on prewarm —
which runs at every title open), if `AITEXT_V1_<titleId>` is missing or fingerprint
mismatched: `raw = cueAlignment.extractFlatText(chunks)`, persist
`{v:1, fingerprint, raw, totals:{raw,jp}, sections:[{idx, rawStart, jpStart, label}]}`.
Fingerprint = totalChars + head/tail samples (same spirit as cue-alignment's
computeFingerprint). Section boundaries: reading-mode-paged.js's spine loop tags each
spine-section's first block element `data-kadoki-section="<i>"` (+ best-effort label from
a leading h1-h6's text); after the chunk-offset pass these markers are read off the DOM.
TXT → 1 section. SRT-only → no AITEXT; cue text is the source.

**Chunk map** `AICHUNKS_V1_<titleId>`:
```json
{ "v":1, "fingerprint":"…", "source":"chapters|haiku|rule|cues",
  "totals":{"raw":0,"jp":0,"cues":0},
  "furthest":{"jp":0,"cue":-1},
  "synopsis":"",  "unresolved":[],
  "chunks":[{ "idx":0, "rawStart":0,"rawEnd":0,"jpStart":0,"jpEnd":0,
              "cueStart":-1,"cueEnd":-1, "label":null,
              "state":"none|queued|processing|ready|failed",
              "attempts":0, "error":null, "processedTs":null }] }
```
Build heuristic (jp-char lengths):
1. If >1 spine section: merge adjacent sections <5k jp; split sections >30k at ~12k
   targets on `.reading-chunk` boundaries (prefer blank-ish gaps / heading chunks). If
   ≥60% of text ends up in natural 5–30k sections → `source:'chapters'`, labels kept.
2. Else (monolithic EPUB, TXT, SRT-only): provisional boundaries every ~12k jp chars on
   chunk starts → ONE Haiku call (`feature:'segment'`, structured output) containing, per
   boundary, a ±1.5k-char window; model returns for each the best scene-break offset
   within its window + a ≤12-char neutral label. `source:'haiku'`. On failure keep the
   provisional map (`source:'rule'`, labels null) — segmentation failure never blocks;
   a later manual Update Timeline may retry. (This window design avoids ever sending the
   whole book in one >200k-token call.)
3. cueStart/cueEnd filled from CUE_ALIGN when/if alignment exists (re-checked lazily).

**Progress & completion.** A 5s foreground poll (single observer, try/caught) reads the
same accessors as event-log (`pagedGetReadLocation().jpOff`, `_lastAudioCueIdx`,
`currentCardIndex`→cue) and monotonically raises `furthest.jp` / `furthest.cue`.
Chunk K is **complete** when `furthest.jp ≥ jpEnd` OR (`cueEnd ≥ 0` AND `furthest.cue ≥
cueEnd`). On completion transition: persist + dispatch `'kai:chunk-completed'`
`{detail:{titleId, idx}}`. The poll NEVER writes to any restore/position store.

Public: `window.aiChunks = { ensure(titleId) → Promise<map|null> (build if possible),
getMap(titleId), chunkText(titleId, idx) → Promise<string> (raw slice or cue concat),
isComplete(map, idx), refreshCueBounds(titleId), onReady hooks }`.

## 6. ai-processor.js (NEW) — the state machine

States: `none → queued → processing → ready | failed(attempts<3 → re-queueable)`.
Sequential by chunk idx (character DB is cumulative): never process K until all <K are
`ready` (or user-skipped `failed`). Single inflight. Foreground-only (document.hidden
gate). 15s tick + kicks from `'kai:chunk-completed'`, title open, manual button.

Triggers:
- **Title open** (after `aiChunks.ensure`): chunk 0 not ready → queue it (no confirm —
  the first-chapter carve-out).
- **Chunk completed** → queue it (if predecessors ready).
- **Catch-up** (title open or manual Update Timeline): owed = all complete-but-unready
  chunks. If estimated cost > $0.50 → ONE confirm dialog (Japanese, shows ~$est, chunk
  count, model); declined → owed chunks stay `none`, re-offered only via the manual
  button. Else process silently in order.
- **Manual Update Timeline** (timeline footer): re-runs catch-up incl. retrying `failed`.

Per-chunk call: model `ai.modelFor('chapter')`, `feature:'chapter'`, `retryable:true`,
maxTokens 8000, structured output schema:
```json
{ "label":"≤12字の章タイトル", "shortSummary":"1–2文", "longSummary":"600–1500字、本文の文体・語彙に忠実、短い原文引用を含む",
  "events":[{"title":"…","description":"…"}],
  "keyPassages":[{"quote":"本文からの正確な抜粋(40–120字)","why":"…"}],
  "characters":{
    "new":[{full record, see §7}],
    "updates":[{"id":"c01","newDevelopments":["…"],"set":{"role":"…","personality":"…","appearance":"…","motivations":"…","secrets":"…","description":"…"},"relationshipChanges":[{"to":"c02","rel":"…"}]}],
    "presence":[{"id":"c01","importance":0–3,"reveal":false}] },
  "unresolved":["…"] }
```
Prompt context (in order, for cache-friendliness): system prompt (Japanese: no outside
knowledge of this work, no predictions, style/vocab fidelity, quote requirements) →
synopsis-so-far → current character DB (compact JSON) → unresolved threads → the chunk
text → instructions. Input cap ~60k chars (tail-kept with a note if a chunk is insane).

Post-processing (client, all try/caught):
- Quote→offset: exact `indexOf` in the chunk's raw slice; fallback whitespace-stripped
  match; located → `{rawStart,rawEnd}` → cue via CUE_ALIGN → `{cueIdx,startMs,endMs}`;
  unlocated → passage kept without audio/jump anchors.
- Merge character output into the DB (§7). Append `synopsis` (model also returns an
  updated rolling synopsis? NO — keep client-side: synopsis = concat of shortSummaries,
  tail-capped 4k chars. Simpler, deterministic).
- Write artifact `AICHAP_V1_<titleId>` (object keyed by idx — NOT a capped list):
  `{ [idx]: {label, shortSummary, longSummary, events, keyPassages[], relatedCharIds[],
  model, costUsd, ts} }`. relatedCharIds = presence importance ≥2.
- Set chunk `ready`, `ai.emitDataChanged(titleId,'timeline')` and `'characters'`.
Failure → `failed`, error string stored, backoff 3 attempts then waits for manual retry.

## 7. Character DB v2 — `AICHAR_V2_<titleId>`

```json
{ "v":2, "nextId":1,
  "characters":{ "c01":{ "id":"c01","surface":"黒鉄","rubyReading":"クロガネ",
     "standardReading":"…","aliases":["…"],"isCommonWord":false,
     "role":"…","description":"…","personality":"…","appearance":"…",
     "motivations":"…","secrets":"…",
     "relationships":[{"to":"c02","rel":"妹"}],
     "developments":[{"chunkIdx":4,"text":"…"}],   // newest first
     "firstChunkIdx":0,"lastChunkIdx":4,"mergedInto":null } },
  "presence":{ "c01":{"4":{"imp":2,"reveal":false}} },
  "snapshots":[{ "chunkIdx":0, "characters":[…full records…] }] }
```
- `characters` is the merged-current view (what the matcher and Characters screen use —
  display stays furthest-based: "a squiggle, once earned, stays glued", kept from v1).
- `snapshots` are write-once per chunk (the full record set as of that chunk) — powers
  future per-position views and the timeline's character lines; storage is fine.
- Merge semantics: `set` fields overwrite, `newDevelopments` PREPEND (newest first),
  relationships replaced per (to) pair, presence recorded per chunk. Model never returns
  the whole DB — patch-only (the §6 schema), client owns the merge. v1's prompt rules
  carry over: stable c-ids, mergedInto only on in-text reveal, alias hygiene,
  isCommonWord, ruby capture.
- `motivations`/`secrets` are now stored fields (user decision) — prompt requires them
  grounded in already-read text only (本文中に根拠のあるものに限る), no speculation
  about future events.
- matcher() keeps its v1 shape (alias→record Map, mergedInto redirects, hiragana/common-
  word guards) so ai-characters-ui/-read need only the store swap (stubs deleted).
- New: `window.aiCharacters.openState()` → {characters sorted by recency/importance} for
  the Characters screen; `aiCharsUi.openPopupFor(idOrAlias)` exposed for chips.
- Deep-dive cache key becomes `<charId>@<chunkIdx>` (AIDEEP_V1 unchanged otherwise).

## 8. Dynamic Timeline UI (rewrite, per the user's mockups)

Full-screen overlay (keeps `bookmarksOverlay` id + swipe-block conventions). Layout:
- **Left spine** (~10px rounded vertical bar), axis = jp chars from the chunk map (NOT
  the DOM — renders cold). Spine FILL is the reading-mode coverage: event-log segments
  painted green=read / orange=card / purple=listen (`--accent-read/card/audio`; audio
  default is already #b794f6 purple via mode-colors.js); unvisited = dark gray. Segment
  data = v1 deriveSegments (kept), drawn as the spine background per the mockups, not as
  side bars.
- **Chapter nodes** on the spine: circled number; ✓ filled check when `ready`+read,
  number+subtle pulse when `processing`, number+dim when `none/queued`, ⚠ tap-to-retry
  when `failed`. Current-position marker line + initial scroll centers it.
- **Cards** (right column, anchored to node y): bold `label` (or 「第N章」 when no label
  yet), `shortSummary` (2 lines, only when ready), thin per-chapter read-progress bar
  colored by the chapter's dominant mode, bookmark-flag icon when a BOOKMARKS_V1 entry
  falls inside the chapter range (tap flag = jump via bookmarks.jumpTo — explicit, never
  automatic). Chapters beyond `furthest`: number + label-less muted card (「未読」) — no
  content leak, but structure visible (matches mockups).
- **Zoom**: pinch + −/+ buttons (geometric, kept) with TWO semantic densities: below
  threshold cards collapse to label-only rows; above, label+shortSummary cards. (The
  "full summary" level is the chapter view, not inline.)
- **Tap card (ready)** → **Chapter view**: closes the timeline panel first (dict popup
  z 9999 must stay on top; reopen timeline when the view closes), new overlay
  `#kchapterView` at z 9000 styled like the AI-summary overlay: title, longSummary
  (dict-tappable, squiggle-marked via `kai-summary-text`), events list, related-character
  chips (→ `aiCharsUi.openPopupFor`), key passages — each with 「▶ この場面を聴く」 when
  `startMs` exists.
- **Key-passage playback (never-lose-place!):** snapshot `BackgroundAudio.getState()`
  before seeking; play passage; on stop/close/another-passage ALWAYS restore the original
  position+pause-state (place-guard pattern from ai-summary.js). Never write any resume
  key. If audio isn't loaded for this title, hide the button.
- **Footer**: 「タイムラインを更新」 manual catch-up button with ~$ estimate when chunks
  are owed; the v1 "summarize selection" multi-select is DROPPED (chapter cards subsume
  it); keep the session-summary button (`aiSummary.summarizeRecent`).
- **Character lines (slice T2, stretch):** thin vertical lines beside the spine for the
  top ~5 characters by total importance, opacity per presence `imp`, dot pulse at
  `reveal` chunks, hidden when zoomed out. Data (presence per chunk) is collected from
  day 1 regardless.
- Open marks seen: `ai.markSeen(titleId,'timeline')`.

## 9. Characters screen (NEW)

Hamburger → 「Characters」. Full-screen overlay `#kcharsScreen` (z 9000, below dict).
List sorted by recent importance (presence-weighted, lastChunkIdx desc): per card —
ruby-annotated name, role chip, 最新の動き = `developments` newest-first (latest 2-3),
expandable 背景 section (older developments + description/personality/appearance/
motivations/relationships resolved to surfaces), 初登場/直近 chapter links (open the
chapter view), the existing deep-dive button. Mergedinto records hidden. All text
dict-tappable + squiggled. Footer disclaimer: 現在の読書位置までの情報のみ. Open marks
seen (`'characters'`). Empty state explains processing happens per finished chapter.

## 10. Notifications (red dots)

- `AISEEN_V1` revs (§4). Hamburger ICON gets a small dot when any kind unseen for the
  ACTIVE title; menu rows 「Dynamic Timeline」/「Characters」 each get a dot; rebuilt per
  menu open (shell.js) + live update on `'kai:ai-data'`.
- Opening the respective surface clears its dot. No OS notifications.

## 11. Preferences (rework the AI section)

- Keep: enable toggle, API key, monthly usage line.
- ADD: 処理品質 select — エコノミー(Haiku)/バランス(Sonnet, default)/高品質(Opus) with
  rough per-book cost hints (~$0.5 / ~$2–3 / ~$6–8).
- REPLACE `AI_CHAR_TRACK` with `AI_AUTO_PROCESS` (default ON): "finished chapters are
  processed automatically in the background". OFF → only manual Update Timeline.
- UPDATE the disclosure copy (it currently promises "never past current position"):
  must now disclose the two carve-outs — structure detection may send small excerpts
  from anywhere in the book (offsets only), and the first chapter is processed at open.

## 12. Cost model (for confirms & hints)

estimate per chunk = (chunkChars×1.2 + stateOverhead≈6k tokens)×inPrice + 3k×outPrice.
~20-chapter book: economy ≈$0.5, balanced ≈$2–3, high ≈$6–8. Segmentation ≈$0.10 once.
Catch-up confirm threshold $0.50. Ledger (AILEDGER_V1) unchanged; features tagged
`segment|chapter|deep|summary|finished`.

## 13. Invariant checklists (every reviewer checks these)

- **Place-loss:** no AI module writes any position/restore key; passage playback restores
  playhead ALWAYS (incl. error paths); timeline jumps only via explicit bookmark taps
  through bookmarks.jumpTo; chunk poll is read-only.
- **Dict-dismiss exclusions:** `#kchapterView`, `#kcharsScreen` (and existing
  `#kcharPopup`, `#aiSummaryOverlay`, `#bookmarksOverlay`) must appear in (a) enhanced-
  dictionary outside-tap dismiss exclusions (3 places — the waveformEditorOverlay
  lesson), (b) app.js `inModal()` swipe suppression, (c) dict-popup positioning branch.
- **z-order:** dict 9999 > toast 9500 > char popup 9400 > chapter view / chars screen /
  summary 9000. Timeline (100000) never hosts dict content directly — it closes before
  opening content views.
- **Coordinate gating:** chunk completion compares within ONE space (jp vs jp, cue vs
  cue) — never cross-space without CUE_ALIGN. No cueScale approximations in gating.
- **Failures invisible:** missing key/offline/segmentation failure → app behaves as if
  the feature doesn't exist; chunk states recover via manual retry.
- **JP output:** all stored AI prose Japanese; UI chrome may stay English (app
  convention: menu items English, content Japanese).

## 14. Slices

- **T1 (this build):** ai-chunks + processor + character DB v2 + timeline rework +
  Characters screen + red dots + prefs/tiers + carve-out disclosures.
- **T2:** character lines on the spine (data already collected); per-position character
  history view.
- **T3:** 完読モード finished-book analysis: `ai.modelFor('finished')`, web_search +
  web_fetch server tools (needs `tools` passthrough + `pause_turn` loop in ai.js),
  themes/arcs/ending/critique grounded in the accumulated artifacts.
- **T4:** chat panel (T1/T2 context tiers from v1 doc), insights pack.
- **T5+:** voice, location garnish, portraits (unchanged from v1).

## 15. Storage key registry (v2 full set)

| Key | Contents |
|---|---|
| `AITEXT_V1_<titleId>` | flat raw text + sections + totals + fingerprint |
| `AICHUNKS_V1_<titleId>` | chunk map + states + furthest + synopsis + unresolved |
| `AICHAP_V1_<titleId>` | per-chunk artifacts keyed by idx |
| `AICHAR_V2_<titleId>` | character DB v2 (merged + presence + snapshots) |
| `AIDEEP_V1_<titleId>` | deep dives, key `<charId>@<chunkIdx>` |
| `AISUM_V1_<titleId>` | session summaries (kept, secondary) |
| `AISEEN_V1` | red-dot revs per title |
| `AILEDGER_V1` | cost ledger (kept) |
| `EVLOG_V1_<titleId>` | event log (kept, untouched) |
| Preferences `AI_API_KEY` / `AI_ENABLED` / `AI_QUALITY` / `AI_AUTO_PROCESS` | settings |
| dead: `AICHAR_V1_<titleId>` | abandoned (unshipped); ignore, optionally GC |
