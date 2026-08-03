# Drive Sync Re-Architecture Plan (2026-06-16)

Status: **approved, implementing**. Supersedes the per-open-title sync model in
`drive-sync.js` / `drive-sync-ui.js`. Keeps the proven plumbing (OAuth, Drive
REST + `no-store`, blob incremental hashing, chunked media transfer, forward-only
position guards). Reworks only the **decision + identity + navigation + UX layer**.

See `memory/project_drive_sync.md` for the failure history (≈8 rounds of
hypothesis-driven fixes with no device logs). This time: clean model + gated
logging baked in + a device repro matrix to validate before declaring done.

---

## 1. Agreed behavior (from the user)

- **Sequential handoff** is the usage model: read on one device, continue on the
  other; rarely both at once. → last-writer-wins, positions forward-only.
- **One manual Sync button.** No background auto-sync (that's where today's races
  live — the open-hook auto-pull and the background auto-push are removed).
  Plus an **advanced Force upload / Force download** override per title.
- **Whole library, incremental.** Every title's *membership* (a line in a small
  index) syncs cheaply; each title's *heavy data* (position, AI, timeline, cover)
  moves lazily, only for titles you actually touch. Sync cost ∝ what changed,
  never ∝ library size.
- **Auto-navigate**: pressing Sync finds the most-recently-synced title and, if
  it isn't the one open, **silently switches** to it (when present locally) or
  **offers to download** it (bandwidth → confirm first).
- **Hybrid-confirm pairing**: recognize "same book" automatically by media
  name / size / content; confirm once; fall back to pick-from-library or download.
- **Deletes are local-only** (never propagated). A local **dismiss-list** stops a
  deleted title from resurrecting itself from the index. Cloud cleanup stays
  explicit via Browse → Delete.

Invariant that MUST hold: `memory/project_never_lose_place_invariant.md` — never
move a position backward; max-guard every adopt.

---

## 2. Storage model on Drive

```
Kadoki Sync Files/                  (root; id cached in GDRIVE_ROOT_ID)
├── library.json                    (THE INDEX — cheap whole-library membership)
├── <syncId>/                       (one folder per title, named by syncId)
│   ├── manifest.json               (heavy-data manifest: positions, blob hashes, …)
│   ├── blob_AITEXT_V1 …            (AI/timeline/etc. blobs — incremental)
│   ├── img_<imgId> …
│   ├── cover
│   └── <media files>               (epub/srt/audiobook — opt-in / on-demand)
└── …
```

### `library.json` (NEW — the index)

```jsonc
{
  "v": 1,
  "updatedAt": <ms>, "updatedBy": "<deviceId>",
  "titles": {
    "<syncId>": {
      "syncId": "<syncId>",
      "titleName": "…",
      "fp": ["epub|name|size", "audiobook|name|size", …],  // for fingerprint matching
      "kinds": ["epub","srt","audiobook"],                 // media kinds present
      "rev": <n>,            // per-title monotonic counter (direction)
      "mtime": <ms>,         // wall-clock of last data change (recency / auto-navigate)
      "deviceId": "<who last wrote>",
      "hasFiles": <bool>     // does the Drive folder carry media bytes
    }, …
  }
}
```

- One line per title → reading/writing the whole index is one small Drive op.
- **No tombstones** (deletes are local-only; the index only grows). A title once
  registered stays in the index until removed via Browse → Delete on some device.

### Per-title `manifest.json` (unchanged shape, kept)

`{ v, syncId, rev, deviceId, snapshotTs(=mtime), titleName, monotonic:{audioFurthestMs,
cardIndex}, audioResume:{ms,chunkIdx,ts}, readBookmark:{chunkIdx,epubName}, lastMode,
aiActivation, blobs[], images[], cover, blobHashes{}, bookmarks[], media[] }`

---

## 3. Identity & pairing (fixes the silent-divergence bug)

**Drop the name-hash folder key** (`'k_'+djb2(title.name)`). Today two devices
only share a folder if their *display names* hash identically — a slightly
different name → two folders forever → "device 2 never inherits". That is suspect #1.

New rules:
- A title's `syncId` is its own stable id. New titles mint `s_<uuid>`
  (`genSyncId`). The Drive folder is named by `syncId` verbatim — never re-derived
  from the name.
- **Cross-device recognition is via the index + media fingerprint**, with a
  one-time confirm:
  1. On Sync, for each local title not yet matched to an index entry, compute its
     media fingerprints and look for an index entry whose `fp` matches (name+size
     exact, or name-only).
  2. Exact match → bind silently. Name-only match → **confirm once**
     ("Same book as the one on your other device?"). If declined → leave unbound
     (user can pick-from-library or download via Browse).
  3. Binding = set `localTitle.syncId = entry.syncId` (re-key); thereafter both
     devices push/pull to the same folder.
- **Migration is graceful**: titles already synced under the old `k_<hash>` id
  keep that id (it's stored in `title.syncId` and is the existing folder name) —
  they continue to share that folder. Only *new* titles use random ids + index
  binding. First run with no `library.json` builds it from the existing per-title
  folders (`listFolders` → read each `manifest.json`), one time.

---

## 4. The Sync flow

> **REVISION 2026-06-16 — two explicit buttons.** The single auto-direction
> `syncLibrary()` below was split (user decision, for clarity over guessed
> intent) into **`syncUp()`** = push the CURRENT open title's state, and
> **`syncDown()`** = pull every title Drive has newer (forward-only), surface
> remote-only titles as cloud entries, then open the most-recently-synced title
> (switch if present / download file(s) if not / "already on latest" no-op).
> Shared helpers: `syncCtx` (read index + local state, build-from-folders once),
> `bindTitles` (fingerprint bind, only marked bound after the write persists),
> `surfaceCloudEntries`. Menu: **Sync ↑** (only with a title open) · **Sync ↓**
> (always) · **Browse Drive…**. The step-numbered flow below still describes the
> underlying pull/push/bind/surface/navigate mechanics — they're just invoked by
> two buttons instead of one.

### (original) library-level single button

`driveSyncUI.syncLibrary()` — replaces the per-title `syncTitle()`:

```
1. ensureConnected.
2. remoteIndex = driveIndex.read()            // 1 cheap call; {} if none yet.
   If empty AND Drive has legacy per-title folders → build index from them once.
3. local = titleStore.list(); dismissed = driveIndex.dismissed().
4. BIND: for each local title without a syncId present in remoteIndex,
   fingerprint-match against remoteIndex; exact → bind; name-only → confirm once.
5. RECONCILE each title (delta, incremental):
     entry = remoteIndex[title.syncId]
     if entry && entry.rev > title.syncRev && entry.deviceId != me   → PULL
     else if !entry || localChangedSinceLastSync(title)              → PUSH
     else                                                            → noop
   PUSH/PULL move only changed blobs (existing blobHashes incremental path) and
   the manifest; then update the title's index entry. Untouched titles = compare
   numbers only, zero transfer.
6. SURFACE remote-only: for each index entry not present locally and not
   dismissed → create a lightweight cloud-placeholder title (syncId, name, fp,
   hasFiles, cloudOnly:true). Heavy data + media download lazily on open.
7. AUTO-NAVIGATE: pick the title with max mtime across the merged view.
     - if it's already the open title → stay, just ensure its position is adopted.
     - else if present locally & openable → switch silently (loadTitleFromLibrary).
     - else (cloud placeholder / media missing) → confirm download, then open.
8. driveIndex.write(updatedIndex).
```

### Direction = `rev`; recency = `mtime`
- **`rev`** is per-title and monotonic (`push` sets `rev = max(remote.rev,
  local.syncRev)+1`); it decides PULL vs PUSH and is **immune to clock skew**.
- **`mtime`** (wall-clock) only ranks titles for auto-navigate. Small phone clock
  skew can only mis-pick which title to open, never corrupt a position (positions
  are forward-only).

### Change detection that is idempotent (kills the spurious-push bug)
Today `lightSig` reads the **live** audio playhead, which keeps moving, so the
playing device always "has changes" → perpetual rev inflation. Fix:
**flush-then-snapshot-durable.** Before snapshotting, if the title owns the active
engine, flush live → durable (`flushAudioPositionNow`, `_saveBookmarkNow`, card
persist), then read the **durable** persisted anchors for both the snapshot and
the change signature. Durable values are stable between syncs → a no-op sync is
truly a no-op.

### Position snapshot (durable, ownership-gated)
- card: `title.lastCardIndex` (already stored in **cue space** via
  `_srtCardToCueAnchor`).
- audio resume: `READING_AUDIO_LAST_POS_/_CHUNK_/_TS_<title.name>`.
- audio furthest: `bookmarks.getFurthest(titleId)`.
- read: `PAGED_BOOKMARK_<epubName>` (the durable read anchor; `pagedGetReadLocation`
  is null without an audio-cue highlight).
- Live override only when `srcId===_activeTitleId && headerName===title.name`
  and per-mode ownership holds (`abEngineOwnsActiveDeck()` for audio,
  `pagedGetReadLocation().bookName===epubName` for read) — and we flushed first,
  so durable already equals live.
- All adopts forward-only (max-guard); never write a smaller position.

### Force override (determinism on demand)
- `driveSync.forcePush(titleId)` — push local → Drive regardless of rev (bumps rev
  above remote). `driveSync.forcePull(titleId)` — adopt Drive → local regardless of
  rev (still forward-only on positions, so it can't rewind your furthest).
- Surfaced in Browse Drive per-row (and/or a title sub-menu), not as primary.

---

## 5. Deletes (local-only) + dismiss-list

- Deleting a title locally (`titleStore.remove`) is unchanged and **never** writes
  a tombstone or removes the index entry → other devices keep the title.
- To stop the deleted title resurrecting from the index on *this* device, add its
  `syncId` to a local-only `GDRIVE_DISMISSED_V1` set (a pref array). Step 6 of the
  sync flow skips dismissed entries.
- Browse → Delete still removes the Drive folder + index entry explicitly (the
  user's "remove from cloud" action). Browse → Get can re-add a dismissed title
  (un-dismisses it).

---

## 6. Cloud-placeholder titles in the library

- A cloud placeholder is a normal title row with `syncId`, `name`, `fp`,
  `hasFiles`, and `cloudOnly:true`, and no openable local media.
- `populateLibrary` (index.html:1742) renders it with a cloud badge + a "Download"
  affordance; tapping it (or opening) triggers `driveSyncUI.getEntry`-style
  download (heavy data always; media on confirm), then opens.
- Once downloaded/bound, the `cloudOnly` flag clears and it's a normal title.

---

## 7. Files to change

- **NEW `drive-index.js`** (`window.driveIndex`): `read()`, `write(index)`,
  `buildFromFolders()` (one-time migration), `matchFingerprint(title, index)`,
  `mostRecent(index, localTitles)`, `dismissed()`/`dismiss(syncId)`/`undismiss`,
  `upsertEntry(index, manifest, hasFiles)`. Script tag after `title-store.js`,
  before `drive-sync.js`, in index.html (+ ios/android public copies via cap sync).
- **`drive-sync.js`**: stop name-hash `folderKey`; trust stored `syncId`; mint
  random for new; `planSync`/`push`/`pull` update the index entry; add
  `flushLivePositions` + durable snapshot; add `forcePush`/`forcePull`; add gated
  `slog()` logging across planSync/push/pull/readPositions/index ops. Remove
  `autoPush`/`autoPull` export usage (keep functions dead or delete).
- **`drive-sync-ui.js`**: `syncLibrary()` (the new everyday button) doing §4; keep
  `browseDrive()` (+ Force/Get rows); **remove** the background auto-save listeners
  and the `loadTitleFromLibrary` auto-pull open-hook. Cloud-entry download helper.
- **`title-store.js`**: support `cloudOnly` titles; nothing else structurally
  (sync fields already persisted as dynamic props). Dismiss-list lives in
  `drive-index.js` prefs (no schema change needed).
- **`index.html populateLibrary`**: render cloud-only entries + download action.
- **`shell.js openShellMoreMenu`**: "Sync" item **always** shown (not gated on an
  active title) → `driveSyncUI.syncLibrary()`; keep "Browse Drive…".

---

## 8. Instrumentation (KADOKI_DEBUG)

Gated `slog(tag, obj)` (only when `localStorage.KADOKI_DEBUG`, per
`memory/project_android_perf_logging.md`). Log:
- `index.read/write` {titleCount, updatedBy}
- `bind` {localId, titleName, matchedSyncId, kind: exact|name-only|none, confirmed}
- `plan` {syncId, titleName, localRev, remoteRev, localMtime, remoteMtime,
  deviceId, direction, reason}
- `push` {syncId, rev, mtime, changedBlobs, cardIndex, audioMs, readChunk,
  liveOwns, flushed}
- `pull` {syncId, rev, adoptedCard, adoptedAudioMs, adoptedReadChunk, guardResults}
- `navigate` {chosenSyncId, present|cloud, switched|downloaded|stay}

---

## 9. Device repro matrix (validate before "done")

Run with `KADOKI_DEBUG=1`, capture adb logcat (Android) + Safari Web Inspector
(iOS) on BOTH devices:

- (a) A: read to page P → Sync. B: Sync → B lands on P.
- (b) B: advance to P2 → Sync. A: Sync → A lands on P2.
- (c) B: switch to a different title, then Sync → captures the right title;
  auto-navigates to the globally most-recent.
- (d) A: import a brand-new title → Sync. B: Sync → it appears as a cloud entry;
  open → downloads + lands correctly.
- (e) Rapid A↔B trading of the same title → monotonic rev, no backward jump,
  converges.
- (f) A: delete a title → stays on B; A's next Sync does not resurrect it.

Each failing step must be pinpointed in the logs before any further change.

---

## 10. Risks / open points

- Clock skew vs `mtime` auto-navigate: acceptable (only affects which title opens,
  never a position). `rev` carries correctness.
- Drive read-after-write propagation: `no-store` kills the WebView cache; if a
  fresh push isn't visible on an immediate cross-device Sync, add a one-shot
  recheck (note in logs first).
- First-run index build for users with many legacy folders: one-time O(folders)
  manifest reads; show the existing "Checking Drive…" progress.
- Native config unchanged (no OAuth scheme change) → `cap sync` suffices; no
  Gradle/Xcode rebuild needed for this work.
- **Accepted limitation — concurrent index writes.** `library.json` is a single
  read-modify-write file. If two devices push *different* titles in the exact
  same window (both read the index before either writes), the later write can
  drop the other's just-added entry. Benign for sequential handoff (manual, one
  device at a time) and self-healing: each title's folder is the source of truth,
  the per-title reconcile uses the title's own `syncFolderId`, and the next push
  from either device re-adds the entry (or first-run `buildFromFolders` rebuilds
  it). If concurrent use becomes common, switch the index to a merge-on-write.

## 11. Review pass (2026-06-16)

4-lens adversarial review (never-lose-place / direction-convergence / identity /
code-bugs). Never-lose-place lens: **no findings** — all position adopts are
forward-only/max-guarded (`updateFurthest` confirmed max-only). Fixed: undismiss
on re-download (Browse Get + cloud-tap), size-0 fingerprint consistency
(`upsertEntry` ↔ `localFps`), awaited `dismiss` on delete (resurrect race),
bind-skip list so a declined "same book?" isn't re-asked, logged index-write
failure, defensive flush in the dead `sync()`. Verified non-issues: index isn't
(and shouldn't be) rewritten after pure pulls (the pusher owns the entry);
`downloadCloudTitle` already passes `targetLocalId`; auto-navigate already
try/caught with the spinner closed first. Still device-untested (the user's step).
