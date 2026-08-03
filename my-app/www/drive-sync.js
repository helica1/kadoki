// drive-sync.js — Single-title cross-device sync orchestration (Google Drive).
//
// Packages ONE title's full state (AI timeline/chunks, character DB + images,
// coverage/stats/event-log, cue alignment, cover, bookmarks, positions) into a
// per-syncId Drive folder, and adopts it on another device by RE-KEYING every
// device-local titleId into the local one. Media bytes (epub/srt/audiobook)
// are handled by drive-sync-media.js (P3); here we only record their
// descriptors so import can skip what's already present.
//
// Conflict model (user decision): the device that initiates INHERITS the other
// device's state — newest `rev` wins on a pull. Monotonic positions are guarded
// so a stale pull can never rewind the audio high-water (bookmarks.updateFurthest
// is itself max-only). A single sync() converges: pull when Drive is newer,
// else push when local content changed, else no-op.
//
// Depends on: window.driveApi, window.gdriveAuth, window.titleStore,
// window.blobStore, window.bookmarks.

(function () {
  'use strict';

  // logicalKey -> storage key prefix (trailing underscore + titleId appended).
  // All are blobStore keys. Order is stable for hashing/upload determinism.
  const KEY_PREFIXES = {
    AITEXT_V1: 'AITEXT_V1_',
    AICHUNKS_V1: 'AICHUNKS_V1_',
    AICHAR_V2: 'AICHAR_V2_',
    AICHAP_V1: 'AICHAP_V1_',
    AIDEEP_V1: 'AIDEEP_V1_',
    AISUM_V1: 'AISUM_V1_',
    AICHAR_IMGIDX_V1: 'AICHAR_IMGIDX_V1_',
    CUE_ALIGN_v2: 'CUE_ALIGN_v2_',
    MODECOV_V1: 'MODECOV_V1_',
    EVLOG_V1: 'EVLOG_V1_',
    STATS_V1: 'STATS_V1_',
  };
  const LOGICAL_KEYS = Object.keys(KEY_PREFIXES);
  const IMG_PREFIX = 'AICHAR_IMG_V1_';       // + titleId + '_' + imgId
  const MANIFEST = 'manifest.json';
  const DEVICE_KEY = 'GDRIVE_DEVICE_ID';
  // Audio resume position (the live playhead / "white ball"), keyed in
  // reading-mode.js by the title's DISPLAY NAME (== title.name when opened from
  // the library). Distinct from AUDIO_FURTHEST_V1 (the high-water "purple").
  const AUDIO_POS_PREFIX = 'READING_AUDIO_LAST_POS_';
  const AUDIO_CHUNK_PREFIX = 'READING_AUDIO_LAST_CHUNK_';
  const AUDIO_TS_PREFIX = 'READING_AUDIO_LAST_TS_';
  // Read-mode green-line anchor (reading-mode-paged.js), keyed by the EPUB
  // attachment name (== the loader's bookName / currentName).
  const READ_BOOKMARK_PREFIX = 'PAGED_BOOKMARK_';

  function srcKey(logicalKey, id) { return KEY_PREFIXES[logicalKey] + id; }
  function imgKey(id, imgId) { return IMG_PREFIX + id + '_' + imgId; }
  function blobFileName(logicalKey) { return 'blob_' + logicalKey; }
  function imgFileName(imgId) { return 'img_' + imgId; }

  // ---- small prefs (device id) --------------------------------------------
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  async function prefGet(k) {
    try { if (CapPrefs()) return (await CapPrefs().get({ key: k })).value; } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function prefSet(k, v) {
    try { if (CapPrefs()) await CapPrefs().set({ key: k, value: String(v) }); } catch (_) {}
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }
  async function deviceId() {
    let v = await prefGet(DEVICE_KEY);
    if (!v) { v = 'd_' + Math.random().toString(36).slice(2, 10); await prefSet(DEVICE_KEY, v); }
    return v;
  }

  // Parent folder so per-title folders don't litter Drive root. Cached
  // in-memory + Preferences so it's resolved at most once per install.
  const ROOT_NAME = 'Kadoki Sync Files';
  const ROOT_KEY = 'GDRIVE_ROOT_ID';
  let _rootId = null;
  async function rootFolderId() {
    if (_rootId) return _rootId;
    try { const cached = await prefGet(ROOT_KEY); if (cached) { _rootId = cached; return _rootId; } } catch (_) {}
    let id = null;
    try { const fo = await window.driveApi.findFolder(ROOT_NAME); if (fo) id = fo.id; } catch (_) {}
    if (!id) id = await window.driveApi.ensureFolder(ROOT_NAME);
    _rootId = id;
    try { await prefSet(ROOT_KEY, id); } catch (_) {}
    return id;
  }

  // ---- blobStore helpers ---------------------------------------------------
  async function bget(k) { try { return await window.blobStore.get(k); } catch (_) { return null; } }
  async function bset(k, v) { try { await window.blobStore.set(k, v); } catch (_) {} }

  // ---- gated logging (KADOKI_DEBUG) ---------------------------------------
  // Whole-path instrumentation for diagnosing sync on-device, per
  // memory/project_android_perf_logging.md. Silent unless KADOKI_DEBUG is set.
  function slog(tag, obj) {
    try {
      if (!(typeof localStorage !== 'undefined' && localStorage.getItem('KADOKI_DEBUG'))) return;
      console.log('[sync] ' + tag + (obj ? ' ' + JSON.stringify(obj) : ''));
    } catch (_) {}
  }

  // The on-screen title name (deckName header), restore suffixes stripped. Used
  // to confirm the running reader/audio belongs to the title we snapshot.
  function currentHeaderName() {
    try { const el = document.getElementById('deckName'); return (el && el.textContent || '').replace(/\s*\((Tap to reopen|Auto-restoring\.\.\.)\)\s*$/i, '').trim(); }
    catch (_) { return ''; }
  }
  // Does the on-screen header reflect THIS title? Deck titles show the filename
  // WITH extension ("X.apkg") while title.name strips it ("X"), so also accept
  // the deck attachment name and an extension-stripped header — otherwise a deck
  // title's live card position is never captured (liveOwns would be false).
  function headerMatchesTitle(hn, title) {
    if (!hn || !title) return false;
    const n = title.name || '';
    if (hn === n) return true;
    const a = title.attachments || {};
    if (a.deck && a.deck.name && hn === a.deck.name) return true;
    return hn.replace(/\.[A-Za-z0-9]{1,5}$/, '') === n;   // strip a trailing extension
  }
  function liveOwnsTitle(srcId, title) {
    return (srcId === window._activeTitleId) && headerMatchesTitle(currentHeaderName(), title);
  }

  // Flush the LIVE on-screen position into the DURABLE persisted layer before a
  // snapshot. Makes the change-signature idempotent (the live audio playhead
  // would otherwise keep drifting and make every sync look "changed") and keeps
  // the freshest place if the app dies right after Sync. Acts only when the
  // running engine genuinely belongs to this title; each underlying flush is
  // itself ownership-gated and forward-only.
  async function flushLivePositions(srcId, title) {
    try {
      if (!liveOwnsTitle(srcId, title)) return false;
      const a = (title && title.attachments) || {};
      try {
        if (Number.isFinite(window.currentCardIndex) && window.titleStore && window.titleStore.setCardIndex) {
          const anchor = (typeof window._srtCardToCueAnchor === 'function') ? window._srtCardToCueAnchor(window.currentCardIndex) : window.currentCardIndex;
          const anchorMs = (typeof window._srtAnchorMsFor === 'function') ? window._srtAnchorMsFor(anchor) : null;
          if (Number.isFinite(anchor)) await window.titleStore.setCardIndex(srcId, anchor, anchorMs);
        }
      } catch (_) {}
      try { if (a.audiobook && typeof window.flushAudioPositionNow === 'function') window.flushAudioPositionNow(); } catch (_) {}
      try { if (a.epub && typeof window.flushReadPosition === 'function') window.flushReadPosition(); } catch (_) {}
      slog('flush', { srcId });
      return true;
    } catch (_) { return false; }
  }

  // Cheap content signature (djb2 over key lengths + scalar values) — detects
  // whether local content changed since the last push, so a no-op sync doesn't
  // inflate the rev and make the other device think it's behind.
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Cheap O(1)-ish change fingerprint: length + a hash of head/tail samples.
  // The big blobs (AITEXT ~MBs, cue alignment) are immutable after creation and
  // the append-mostly JSON ones change length when they grow, so this detects
  // real changes without hashing megabytes on every sync.
  function fingerprint(s) {
    s = s || '';
    return s.length + '.' + djb2(s.slice(0, 256) + '|' + s.slice(-256));
  }

  // NOTE: title identity is the stable per-title syncId (the Drive folder name),
  // never derived from the display name. The old name-hash 'k_' folderKey is
  // gone — it silently sent two devices with slightly different display names to
  // different folders ("device 2 doesn't inherit"). Cross-device "same book"
  // recognition is now via the library index + media fingerprint (drive-index.js).

  // Keys whose CHANGE matters for "did local data change since last sync".
  // AITEXT_V1 + CUE_ALIGN_v2 are IMMUTABLE (book text / alignment) and large, so
  // excluding them lets the change-check skip multi-MB blobStore reads.
  const SIG_KEYS = LOGICAL_KEYS.filter(k => k !== 'AITEXT_V1' && k !== 'CUE_ALIGN_v2');

  // Change signature from a {blobs, ...positions} object. Image changes are
  // captured via AICHAR_IMGIDX_V1's length (in SIG_KEYS), so we never read the
  // image blobs here. sigOf(fullSnap) and lightSig() produce identical strings.
  function sigOf(snap) {
    const parts = [];
    for (const k of SIG_KEYS) parts.push(k + ':' + (snap.blobs[k] ? snap.blobs[k].length : 0));
    parts.push('fur:' + snap.audioFurthestMs);
    parts.push('pos:' + (snap.audioResume ? snap.audioResume.ms : 0));
    parts.push('read:' + (snap.readBookmark ? snap.readBookmark.chunkIdx : -1));
    parts.push('card:' + snap.cardIndex);
    parts.push('mode:' + (snap.lastMode || ''));
    parts.push('act:' + (snap.aiActivation ? snap.aiActivation.mode : ''));
    parts.push('bm:' + (snap.bookmarks ? snap.bookmarks.length : 0));
    parts.push('cover:' + (snap.cover ? snap.cover.length : 0));
    return djb2(parts.join('|'));
  }

  // Position + small metadata, with a LIVE override for the OPEN title (the
  // persisted anchors lag the on-screen position). Shared by gatherSnapshot +
  // lightSig so the two never disagree.
  async function readPositions(srcId, title) {
    const a = (title && title.attachments) || {};
    const bms = (window.bookmarks && window.bookmarks.list ? window.bookmarks.list() : [])
      .filter(b => b && b.titleId === srcId);
    const audioFurthestMs = (window.bookmarks && window.bookmarks.getFurthest)
      ? (window.bookmarks.getFurthest(srcId) || 0) : 0;
    let aiActivation = null;
    try { const info = window.ai && window.ai.activationInfo && window.ai.activationInfo(srcId); if (info && info.activated) aiActivation = { mode: info.mode || 'new' }; } catch (_) {}
    let audioResume = null;
    try {
      const dn = title.name || '';
      const ms = parseInt(await prefGet(AUDIO_POS_PREFIX + dn), 10);
      if (dn && Number.isFinite(ms) && ms > 0) {
        const ci = parseInt(await prefGet(AUDIO_CHUNK_PREFIX + dn), 10);
        const ts = parseInt(await prefGet(AUDIO_TS_PREFIX + dn), 10);
        audioResume = { ms, chunkIdx: Number.isFinite(ci) ? ci : -1, ts: Number.isFinite(ts) ? ts : 0 };
      }
    } catch (_) {}
    let readBookmark = null;
    try {
      const en = a.epub && a.epub.name;
      if (en) { const ci = parseInt(await prefGet(READ_BOOKMARK_PREFIX + en), 10); if (Number.isFinite(ci) && ci >= 0) readBookmark = { chunkIdx: ci, epubName: en }; }
    } catch (_) {}
    let cardIndex = (typeof title.lastCardIndex === 'number') ? title.lastCardIndex : 0;
    // TIME twin of cardIndex (auto-transcribed titles restore by time — their
    // cue INDICES aren't comparable across devices/sessions; see setCardIndex).
    let cardMs = Number.isFinite(title.lastCardMs) ? title.lastCardMs : null;
    // LIVE override — ONLY when the running reader/audio genuinely belongs to
    // THIS title. _activeTitleId flips immediately on a title switch, but the
    // live getters (currentCardIndex / getAudioProgress / pagedGetReadLocation)
    // keep the PREVIOUS title's values until the new one finishes loading — so
    // a sync right after switching would otherwise capture the wrong title's
    // position. Guard with the on-screen title name + per-mode identity checks.
    const liveOwns = liveOwnsTitle(srcId, title);   // deck-aware header match
    if (liveOwns) {
      try { if (Number.isFinite(window.currentCardIndex)) { const anchor = (typeof window._srtCardToCueAnchor === 'function') ? window._srtCardToCueAnchor(window.currentCardIndex) : window.currentCardIndex; if (Number.isFinite(anchor)) { cardIndex = anchor; const lms = (typeof window._srtAnchorMsFor === 'function') ? window._srtAnchorMsFor(anchor) : null; if (Number.isFinite(lms)) cardMs = lms; } } } catch (_) {}
      // Audio: only when the audio engine is actually loaded FOR THIS TITLE
      // (abEngineOwnsActiveDeck), else getAudioProgress is the previous title's
      // leftover playhead. Falls back to the persisted value otherwise.
      try {
        const audioOwned = a.audiobook && typeof window.abEngineOwnsActiveDeck === 'function' && window.abEngineOwnsActiveDeck();
        if (audioOwned && typeof window.getAudioProgress === 'function') {
          const ap = window.getAudioProgress();
          const liveMs = ap && ap.ms ? Math.round(ap.ms) : 0;
          if (liveMs > 0) audioResume = { ms: liveMs, chunkIdx: (audioResume ? audioResume.chunkIdx : -1), ts: Date.now() };
        }
      } catch (_) {}
      // Read: capture the live on-screen reading chunk for THIS title's epub.
      // Prefer pagedGetReadChunkLive (the SILENT-reading line, works for no-audio
      // epubs and reads synchronously — no dependency on the async PAGED_BOOKMARK
      // write); fall back to pagedGetReadLocation (the audio-cue chunk). Either
      // way require bookName === this title's epub so a just-switched title can't
      // contaminate. If neither is live, the persisted PAGED_BOOKMARK above holds.
      try {
        if (a.epub && a.epub.name) {
          let liveChunk = null;
          if (typeof window.pagedGetReadChunkLive === 'function') { const lc = window.pagedGetReadChunkLive(); if (lc && lc.bookName === a.epub.name && Number.isFinite(lc.chunkIdx) && lc.chunkIdx >= 0) liveChunk = lc.chunkIdx; }
          if (liveChunk == null && typeof window.pagedGetReadLocation === 'function') { const loc = window.pagedGetReadLocation(); if (loc && loc.bookName === a.epub.name && Number.isFinite(loc.chunkIdx) && loc.chunkIdx >= 0) liveChunk = loc.chunkIdx; }
          if (Number.isFinite(liveChunk) && liveChunk >= 0) readBookmark = { chunkIdx: liveChunk, epubName: a.epub.name };
        }
      } catch (_) {}
    }
    return {
      cardIndex, cardMs, audioResume, readBookmark, audioFurthestMs, aiActivation,
      cover: (a.cover && a.cover.dataUri) || null,
      bookmarks: bms,
      lastMode: title.lastMode || null,
    };
  }

  // Fast change signature for the "Checking Drive" decision: reads ONLY the
  // small mutable blobs + positions, skipping the multi-MB AITEXT/CUE_ALIGN.
  async function lightSig(srcId, title) {
    const blobs = {};
    for (const k of SIG_KEYS) { const v = await bget(srcKey(k, srcId)); if (v != null) blobs[k] = v; }
    const pos = await readPositions(srcId, title);
    return sigOf(Object.assign({ blobs }, pos));
  }

  // ---- snapshot (export side) ---------------------------------------------
  async function gatherSnapshot(srcId, title) {
    const blobs = {};
    for (const k of LOGICAL_KEYS) {
      const v = await bget(srcKey(k, srcId));
      if (v != null) blobs[k] = v;
    }
    // Character images: enumerate imgIds from the index (blobStore has no
    // key-listing, so the index is the source of truth).
    const images = {};
    if (blobs.AICHAR_IMGIDX_V1) {
      try {
        const idx = JSON.parse(blobs.AICHAR_IMGIDX_V1);
        const chars = (idx && idx.chars) || {};
        for (const charId of Object.keys(chars)) {
          const imgs = (chars[charId] && chars[charId].images) || [];
          for (const im of imgs) {
            if (!im || !im.imgId) continue;
            const dataUri = await bget(imgKey(srcId, im.imgId));
            if (dataUri != null) images[im.imgId] = dataUri;
          }
        }
      } catch (_) {}
    }
    const a = (title && title.attachments) || {};
    const media = [];
    for (const kind of ['epub', 'srt', 'audiobook']) {
      const at = a[kind];
      if (at && at.name) media.push({ kind, name: at.name, size: (typeof at.size === 'number' ? at.size : null) });
    }
    const pos = await readPositions(srcId, title);
    return Object.assign({ blobs, images, media }, pos);
  }

  // ---- remote manifest -----------------------------------------------------
  async function readRemoteManifest(folderId) {
    const f = await window.driveApi.findInFolder(folderId, MANIFEST);
    if (!f) return null;
    try { return JSON.parse(await window.driveApi.getText(f.id)); } catch (_) { return null; }
  }

  // List every synced title in Drive (for a picker): reads each folder's
  // manifest for a human-readable name. Folders are named by syncId.
  async function listRemote() {
    await window.gdriveAuth.getAccessToken();
    const folders = await window.driveApi.listFolders();
    const out = [];
    for (const fo of folders) {
      const m = await readRemoteManifest(fo.id);
      if (m && m.syncId) out.push({
        folderId: fo.id, syncId: m.syncId, titleName: m.titleName || fo.name,
        rev: m.rev || 0, deviceId: m.deviceId || '', snapshotTs: m.snapshotTs || 0,
        hasMedia: Array.isArray(m.media) ? m.media : [],
        manifest: m,
      });
    }
    return out;
  }

  // ---- push (export) -------------------------------------------------------
  async function push(srcId, opts) {
    opts = opts || {};
    const onP = opts.onProgress || function () {};
    await window.gdriveAuth.getAccessToken();
    const title = await window.titleStore.get(srcId);
    if (!title) throw new Error('Title not found');
    // The Drive folder is named by the title's stable syncId — never derived
    // from the display name. Mint one if missing; an already-synced title (incl.
    // legacy 'k_' ids) keeps its id, so its folder is unchanged.
    const syncId = await window.titleStore.ensureSyncId(srcId);

    // Flush the live on-screen position into the durable layer so the snapshot
    // is exact and the change-signature is idempotent.
    await flushLivePositions(srcId, title);
    onP({ phase: 'gather' });
    const snap = await gatherSnapshot(srcId, title);

    // Resolve folder + manifest file from cached ids when possible (a position-
    // only re-sync then costs ~2 Drive calls: read manifest + write manifest).
    let folderId = title.syncFolderId || null;
    let manifestId = title.syncManifestId || null;
    let remote = null;
    if (manifestId) {
      try { remote = JSON.parse(await window.driveApi.getText(manifestId)); }
      catch (_) { manifestId = null; }       // stale/deleted — fall back below
    }
    if (!folderId || !remote) {
      folderId = await window.driveApi.ensureFolder(syncId, await rootFolderId());
      const mf = await window.driveApi.findInFolder(folderId, MANIFEST);
      if (mf) { manifestId = mf.id; try { remote = JSON.parse(await window.driveApi.getText(mf.id)); } catch (_) {} }
    }
    const me = await deviceId();
    const rev = Math.max((remote && remote.rev) || 0, title.syncRev || 0) + 1;
    const remoteHashes = (remote && remote.blobHashes) || {};

    // Compute cheap fingerprints; collect only the blobs that actually changed.
    const blobHashes = {};
    const changed = [];   // { name, mime, content, isB64 }
    const consider = (name, mime, content, isB64, hkey) => {
      const h = fingerprint(content);
      blobHashes[hkey] = h;
      if (remoteHashes[hkey] !== h) changed.push({ name, mime, content, isB64 });
    };
    const blobKeys = Object.keys(snap.blobs);
    for (const k of blobKeys) consider(blobFileName(k), 'application/json', snap.blobs[k], false, k);
    for (const imgId of Object.keys(snap.images)) consider(imgFileName(imgId), 'text/plain', snap.images[imgId], false, 'img:' + imgId);
    if (snap.cover) consider('cover', 'text/plain', snap.cover, false, 'cover');

    // Upload changed blobs only. List the folder ONCE, lazily — skipped entirely
    // for a position-only sync (changed.length === 0).
    const total = changed.length + 1;
    let done = 0;
    if (changed.length) {
      const files = await window.driveApi.listFiles(folderId);
      const byName = {};
      for (const f of files) byName[f.name] = f;
      for (const c of changed) {
        onP({ phase: 'upload', current: ++done, total });
        const ex = byName[c.name];
        if (ex) await window.driveApi.updateMedia(ex.id, c.mime, c.content, c.isB64);
        else await window.driveApi.createMultipart(folderId, c.name, c.mime, c.content, c.isB64);
      }
    }

    // Media bytes (drive-sync-media). Record descriptors either way; with
    // includeMedia, stream them and reuse unchanged files from the prior manifest.
    let mediaManifest = snap.media.map(m => ({ kind: m.kind, name: m.name, size: m.size, driveFileId: null }));
    if (opts.includeMedia && window.driveSyncMedia && window.driveSyncMedia.uploadMedia) {
      if (!folderId) folderId = await window.driveApi.ensureFolder(syncId, await rootFolderId());   // lazy path may not have listed yet
      mediaManifest = await window.driveSyncMedia.uploadMedia(folderId, title, snap.media, (remote && remote.media) || [], onP);
    }

    const manifest = {
      v: 1,
      syncId,
      rev,
      deviceId: me,
      snapshotTs: Date.now(),
      titleName: title.name,
      monotonic: { audioFurthestMs: snap.audioFurthestMs, cardIndex: snap.cardIndex, cardMs: snap.cardMs },
      audioResume: snap.audioResume,
      readBookmark: snap.readBookmark,
      lastMode: snap.lastMode,
      aiActivation: snap.aiActivation,
      blobs: blobKeys,
      images: Object.keys(snap.images),
      cover: !!snap.cover,
      blobHashes,                 // logicalKey|'img:'+id|'cover' -> djb2 hash (incremental sync)
      bookmarks: snap.bookmarks,
      media: mediaManifest,
    };
    // Write the manifest by cached id when we have it (1 call), else create it.
    if (manifestId) await window.driveApi.updateMedia(manifestId, 'application/json', JSON.stringify(manifest), false);
    else manifestId = await window.driveApi.createMultipart(folderId, MANIFEST, 'application/json', JSON.stringify(manifest), false);
    onP({ phase: 'upload', current: total, total });

    await window.titleStore.update(srcId, {
      syncRev: rev, syncSig: sigOf(snap), syncTs: manifest.snapshotTs,
      syncFolderId: folderId, syncManifestId: manifestId,   // cache for fast subsequent syncs
      cloudOnly: false,                                     // we now hold real data
    });

    // Update the library index (membership + rev/mtime/hasFiles). When the
    // caller passes an in-memory index (syncUp/syncDown), mutate it and let the
    // caller write once; otherwise read-modify-write here.
    const hasFiles = mediaManifest.some(m => m && m.driveFileId);
    try {
      if (window.driveIndex) {
        if (opts.index) {
          window.driveIndex.upsertEntry(opts.index, manifest, hasFiles);
        } else {
          const root = await rootFolderId();
          const idx = (await window.driveIndex.read(root)) || { v: 1, titles: {} };
          window.driveIndex.upsertEntry(idx, manifest, hasFiles);
          await window.driveIndex.write(root, idx, me);
        }
      }
    } catch (e) { slog('index.write-fail-after-push', { syncId, err: e && e.message }); }
    slog('push', { syncId, rev, changed: changed.length, card: snap.cardIndex, audioMs: snap.audioResume ? snap.audioResume.ms : 0, readChunk: snap.readBookmark ? snap.readBookmark.chunkIdx : -1, hasFiles });
    return { action: 'push', rev, syncId, uploaded: changed.length, manifest, hasFiles };
  }

  // ---- pull (import + adopt) ----------------------------------------------
  async function pullFromFolder(folderId, manifest, opts) {
    opts = opts || {};
    const onP = opts.onProgress || function () {};

    // Resolve the local target title. A known target (auto-pull on open) skips
    // matching/creation so we adopt into exactly that title, never a duplicate.
    let localId = null;
    if (opts.targetLocalId) {
      localId = opts.targetLocalId;
      await window.titleStore.update(localId, { syncId: manifest.syncId });
    } else {
    const bySync = await window.titleStore.findBySyncId(manifest.syncId);
    if (bySync) {
      localId = bySync.id;
    } else {
      // Try media fingerprint (primary media name+size).
      const primary = (manifest.media || []).find(m => m.kind === 'epub') ||
                      (manifest.media || []).find(m => m.kind === 'audiobook') ||
                      (manifest.media || [])[0];
      let matched = null;
      if (primary) {
        const fp = String(primary.name).trim().toLowerCase() + '|' + (primary.size || '');
        matched = await window.titleStore.findByMediaFingerprint(fp);
      }
      if (matched && (matched.exact || (opts.confirmNameMatch && await opts.confirmNameMatch(matched.title)))) {
        localId = matched.title.id;
        await window.titleStore.update(localId, { syncId: manifest.syncId });
      } else {
        const created = await window.titleStore.create({ name: manifest.titleName || 'Synced title', syncId: manifest.syncId });
        localId = created.id;
      }
    }
    }

    // Skip any blob whose local content fingerprint already matches the manifest
    // — a position-only re-pull moves nothing. The folder is listed LAZILY (only
    // once a blob genuinely needs downloading), so the common case is 0 calls.
    const remoteHashes = manifest.blobHashes || {};
    let byName = null;
    async function ensureFiles() {
      if (!byName) {
        byName = {};
        const files = await window.driveApi.listFiles(folderId);
        for (const f of files) byName[f.name] = f;
      }
      return byName;
    }
    const total = (manifest.blobs || []).length + (manifest.images || []).length + (manifest.cover ? 1 : 0);
    let done = 0;
    // Returns the downloaded text, or null when skipped/absent.
    async function fetchIfChanged(name, hkey, localContent) {
      onP({ phase: 'download', current: ++done, total });
      const lh = (localContent != null) ? fingerprint(localContent) : null;
      if (remoteHashes[hkey] && lh === remoteHashes[hkey]) return null;   // already identical
      const map = await ensureFiles();
      const f = map[name];
      if (!f) return null;
      return await window.driveApi.getText(f.id);
    }
    // Character images that are NEWER locally (e.g. a crop made here that hasn't
    // been pushed yet) — their BYTES must not be overwritten by the remote's
    // older copy. Populated by the AICHAR_IMGIDX_V1 union-merge below.
    let imgKeepLocal = new Set();
    for (const k of (manifest.blobs || [])) {
      if (!KEY_PREFIXES[k]) continue;                 // unknown logical key — skip safely
      const dk = srcKey(k, localId);
      const content = await fetchIfChanged(blobFileName(k), k, await bget(dk));
      if (content == null) continue;
      // The character-image INDEX is UNION-MERGED, never overwritten, so images
      // generated/cropped on either device are never lost (deletions tombstoned).
      if (k === 'AICHAR_IMGIDX_V1' && window.aiImages && window.aiImages.mergeIndexBlob) {
        // NEVER overwrite the index on merge failure — that would drop local
        // images/crops (the exact loss we're preventing). Keep local; the next
        // sync retries the merge.
        try { const r = await window.aiImages.mergeIndexBlob(localId, content); if (r && Array.isArray(r.localNewer)) imgKeepLocal = new Set(r.localNewer); }
        catch (e) { slog('img-merge-fail', { err: e && e.message }); }
      } else {
        await bset(dk, content);                       // KEY rewrite to local id; value verbatim
      }
    }
    for (const imgId of (manifest.images || [])) {
      if (imgKeepLocal.has(imgId)) { onP({ phase: 'download', current: ++done, total }); continue; }   // local crop is newer → keep it
      const dk = imgKey(localId, imgId);
      const dataUri = await fetchIfChanged(imgFileName(imgId), 'img:' + imgId, await bget(dk));
      if (dataUri != null) await bset(dk, dataUri);
    }
    if (manifest.cover) {
      // Cover lives on the title record, not blobStore; compare against current.
      const lt = await window.titleStore.get(localId);
      const cur = (lt && lt.attachments && lt.attachments.cover && lt.attachments.cover.dataUri) || null;
      const dataUri = await fetchIfChanged('cover', 'cover', cur);
      if (dataUri != null) await window.titleStore.attach(localId, 'cover', { dataUri });
    }

    // Global value rewrites.
    // Audio furthest: max-merge (updateFurthest never regresses).
    const mono = manifest.monotonic || {};
    if (window.bookmarks && window.bookmarks.updateFurthest && mono.audioFurthestMs) {
      window.bookmarks.updateFurthest(localId, mono.audioFurthestMs);
    }
    // Audio resume playhead (the "white ball"): adopt forward, never regress.
    // Keyed by the LOCAL title's display name (reading-mode reads it on open).
    try {
      const ar = manifest.audioResume;
      const lt0 = await window.titleStore.get(localId);
      const dn = (lt0 && lt0.name) || manifest.titleName || '';
      if (ar && ar.ms > 0 && dn) {
        const localMs = parseInt(await prefGet(AUDIO_POS_PREFIX + dn), 10) || 0;
        if (ar.ms > localMs) {                              // never go backwards
          await prefSet(AUDIO_POS_PREFIX + dn, Math.floor(ar.ms));
          if (ar.chunkIdx >= 0) await prefSet(AUDIO_CHUNK_PREFIX + dn, ar.chunkIdx);
          if (ar.ts > 0) await prefSet(AUDIO_TS_PREFIX + dn, Math.floor(ar.ts));
        }
      }
    } catch (_) {}
    // Read-mode green-line anchor: adopt forward, never regress. Keyed by the
    // LOCAL title's epub name (reading-mode-paged reads it on open).
    try {
      const rb = manifest.readBookmark;
      const lt1 = await window.titleStore.get(localId);
      const en = lt1 && lt1.attachments && lt1.attachments.epub && lt1.attachments.epub.name;
      // Only adopt a read chunk that came from the SAME epub — a chunk index is
      // book-specific, so a different/replaced epub would land at the wrong line.
      // (Legacy manifests without rb.epubName are trusted, as before.)
      const sameEpub = rb && (!rb.epubName || rb.epubName === en);
      if (rb && sameEpub && Number.isFinite(rb.chunkIdx) && rb.chunkIdx >= 0 && en) {
        const localCi = parseInt(await prefGet(READ_BOOKMARK_PREFIX + en), 10);
        if (rb.chunkIdx > (Number.isFinite(localCi) ? localCi : -1)) {
          await prefSet(READ_BOOKMARK_PREFIX + en, String(rb.chunkIdx));
        }
      }
    } catch (_) {}
    // Bookmarks: rewrite titleId/name and record (oldest first so newest ends on top).
    if (Array.isArray(manifest.bookmarks) && window.bookmarks && window.bookmarks.record) {
      const local = await window.titleStore.get(localId);
      const nm = (local && local.name) || manifest.titleName;
      const incoming = manifest.bookmarks.slice().reverse();
      for (const bm of incoming) {
        try { window.bookmarks.record(Object.assign({}, bm, { titleId: localId, titleName: nm })); } catch (_) {}
      }
    }

    // Media (skip if present). Bytes are P3.
    const missingMedia = [];
    const local = await window.titleStore.get(localId);
    const la = (local && local.attachments) || {};
    for (const m of (manifest.media || [])) {
      const have = la[m.kind] && la[m.kind].name === m.name;
      if (have) continue;
      if (opts.includeMedia && m.driveFileId && window.driveSyncMedia && window.driveSyncMedia.downloadMedia) {
        await window.driveSyncMedia.downloadMedia(localId, m, onP);
      } else {
        missingMedia.push(m);
      }
    }

    // AI activation: mirror the source so this device doesn't prompt to
    // "Activate AI" for a book that already carries AI data.
    try {
      if (manifest.aiActivation && window.ai && window.ai.setActivated) {
        await window.ai.setActivated(localId, manifest.aiActivation.mode || 'new');
      }
    } catch (_) {}

    // We just overwrote this title's AI blobs (timeline/chunks, characters,
    // images) in blobStore. The running app holds an in-memory CANONICAL
    // AICHUNKS instance per title — drop it so the next read reloads the pulled
    // data (else the stale instance keeps serving AND a later mutate() would
    // write it back, silently undoing the pull — e.g. a deleted char image
    // reappearing). Then fire the refresh events so any open Characters/Timeline
    // UI re-renders from the freshly-pulled state.
    try { if (window.aiChunks && window.aiChunks.invalidateCache) window.aiChunks.invalidateCache(localId); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId: localId } })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('kai:img-data', { detail: { titleId: localId } })); } catch (_) {}
    // Re-arm AI auto-progression: re-queue read-complete-but-unprocessed chapters
    // the source device left behind, so the timeline/characters keep advancing
    // here instead of idling after the pull. (No-op unless AI is activated.)
    try { if (window.aiProcessor && window.aiProcessor.resync) window.aiProcessor.resync(localId); } catch (_) {}

    // Adopt position scalars — cardIndex never-regress (max), lastMode inherited.
    // Cache the folder id so a subsequent Save on this device is fast too.
    const patch = { syncId: manifest.syncId, syncRev: manifest.rev, syncTs: manifest.snapshotTs, syncFolderId: folderId };
    if (typeof mono.cardIndex === 'number') {
      const ltc = await window.titleStore.get(localId);
      const localCard = (ltc && typeof ltc.lastCardIndex === 'number') ? ltc.lastCardIndex : 0;
      patch.lastCardIndex = Math.max(localCard, mono.cardIndex);
      // TIME twin, merged monotonically too (auto-transcribed titles restore
      // by lastCardMs; indices aren't comparable across devices). When neither
      // side has a time, clear it so restore falls back to the merged index.
      const localMs = (ltc && Number.isFinite(ltc.lastCardMs)) ? ltc.lastCardMs : -1;
      const remoteMs = Number.isFinite(mono.cardMs) ? mono.cardMs : -1;
      patch.lastCardMs = Math.max(localMs, remoteMs) >= 0 ? Math.max(localMs, remoteMs) : null;
    }
    if (manifest.lastMode) patch.lastMode = manifest.lastMode;
    await window.titleStore.update(localId, patch);
    // Recompute and store the signature so a follow-up sync is a no-op.
    try {
      const t2 = await window.titleStore.get(localId);
      await window.titleStore.update(localId, { syncSig: await lightSig(localId, t2) });
    } catch (_) {}

    slog('pull', { syncId: manifest.syncId, rev: manifest.rev, localId, card: patch.lastCardIndex, audioMs: manifest.audioResume ? manifest.audioResume.ms : 0, readChunk: manifest.readBookmark ? manifest.readBookmark.chunkIdx : -1, missingMedia: missingMedia.length });
    return { action: 'pull', localId, rev: manifest.rev, missingMedia };
  }

  // ---- convergence ---------------------------------------------------------

  // Decide and run. Returns { action:'push'|'pull'|'insync', ... }.
  // opts: { includeMedia, onProgress, confirmPull(info), confirmNameMatch(title) }
  async function sync(srcId, opts) {
    opts = opts || {};
    await window.gdriveAuth.getAccessToken();
    const title = await window.titleStore.get(srcId);
    if (!title) throw new Error('Title not found');
    const syncId = await window.titleStore.ensureSyncId(srcId);
    const me = await deviceId();
    // Flush live → durable so the change-check below is exact + idempotent.
    await flushLivePositions(srcId, title);

    const folder = await window.driveApi.findFolder(syncId, await rootFolderId());
    const remote = folder ? await readRemoteManifest(folder.id) : null;
    const remoteRev = (remote && remote.rev) || 0;
    const localRev = title.syncRev || 0;

    // Pull when Drive is strictly newer and from another device.
    if (remote && remoteRev > localRev && remote.deviceId !== me) {
      if (opts.confirmPull) {
        const ok = await opts.confirmPull({
          titleName: remote.titleName, rev: remoteRev, deviceId: remote.deviceId,
          snapshotTs: remote.snapshotTs, media: remote.media || [],
        });
        if (!ok) return { action: 'cancelled' };
      }
      return await pullFromFolder(folder.id, remote, opts);
    }

    // Otherwise push, but only if local content actually changed (or no remote)
    // — avoids rev inflation that would make the other device think it's behind.
    const snap = await gatherSnapshot(srcId, title);
    const localSig = sigOf(snap);
    if (remote && remoteRev >= localRev && localSig === title.syncSig) {
      return { action: 'insync', rev: remoteRev };
    }
    return await push(srcId, opts);
  }

  // ---- automatic sync (background save / open pull) ------------------------
  // Both are gated on: connected + the title has synced at least once
  // (title.syncFolderId, set by the first manual Save or Get). That keeps the
  // first link explicit and avoids per-open network on titles you never sync.

  // Push the active title only if its content actually changed since last sync.
  async function autoPush(titleId) {
    try {
      if (!titleId) return { pushed: false };
      const title = await window.titleStore.get(titleId);
      if (!title || !title.syncFolderId) return { pushed: false };   // not opted-in
      if (!(await window.gdriveAuth.isConnected())) return { pushed: false };
      // CRITICAL: use the same direction logic as manual Sync so a background
      // push can NEVER overwrite a newer version another device pushed (that
      // would lose its position). Only push when WE are genuinely ahead.
      const plan = await planSync(titleId);
      if (plan.direction !== 'push') return { pushed: false };
      await push(titleId, { includeMedia: false });   // background NEVER uploads files (stays fast)
      return { pushed: true };
    } catch (_) { return { pushed: false }; }
  }

  // Adopt a newer Drive version of THIS title (from another device) silently.
  async function autoPull(titleId) {
    try {
      if (!titleId) return { pulled: false };
      const title = await window.titleStore.get(titleId);
      if (!title || !title.syncFolderId) return { pulled: false };   // not opted-in
      if (!(await window.gdriveAuth.isConnected())) return { pulled: false };
      const syncId = await window.titleStore.ensureSyncId(titleId);
      const me = await deviceId();
      let folderId = title.syncFolderId;
      let manifestId = title.syncManifestId;
      let remote = null;
      if (manifestId) { try { remote = JSON.parse(await window.driveApi.getText(manifestId)); } catch (_) { manifestId = null; } }
      if (!remote) {
        if (!folderId) { const fo = await window.driveApi.findFolder(syncId, await rootFolderId()); if (!fo) return { pulled: false }; folderId = fo.id; }
        const mf = await window.driveApi.findInFolder(folderId, MANIFEST);
        if (!mf) return { pulled: false };
        try { remote = JSON.parse(await window.driveApi.getText(mf.id)); } catch (_) { return { pulled: false }; }
      }
      if (!remote) return { pulled: false };
      if (!folderId) { const fo = await window.driveApi.findFolder(syncId, await rootFolderId()); if (!fo) return { pulled: false }; folderId = fo.id; }
      if (!(remote.rev > (title.syncRev || 0) && remote.deviceId !== me)) return { pulled: false };  // not newer / our own
      await pullFromFolder(folderId, remote, { targetLocalId: titleId });
      return { pulled: true };
    } catch (_) { return { pulled: false }; }
  }

  // Decide the sync direction for a title WITHOUT acting, so the UI can prompt
  // (e.g. first-time file opt-in) before doing work. Direction by monotonic rev:
  // Drive newer than what we last saw (and from another device) → pull; local
  // changed since last sync → push; else nothing. Returns the context the UI
  // hands back to push()/pull().
  async function planSync(titleId) {
    await window.gdriveAuth.getAccessToken();
    const title = await window.titleStore.get(titleId);
    if (!title) throw new Error('Title not found');
    const syncId = await window.titleStore.ensureSyncId(titleId);
    const me = await deviceId();
    // Flush live → durable first so the change-check below is exact + idempotent.
    await flushLivePositions(titleId, title);
    let folderId = title.syncFolderId || null;
    let manifestId = title.syncManifestId || null;
    let remote = null;
    if (manifestId) { try { remote = JSON.parse(await window.driveApi.getText(manifestId)); } catch (_) { manifestId = null; } }
    if (!remote) {
      if (!folderId) { const fo = await window.driveApi.findFolder(syncId, await rootFolderId()); folderId = fo ? fo.id : null; }
      if (folderId) {
        const mf = await window.driveApi.findInFolder(folderId, MANIFEST);
        if (mf) { manifestId = mf.id; try { remote = JSON.parse(await window.driveApi.getText(mf.id)); } catch (_) {} }
      }
    }
    let direction = 'noop';
    if (remote && (remote.rev || 0) > (title.syncRev || 0) && remote.deviceId !== me) {
      direction = 'pull';
    } else {
      // Fast change-check: lightSig skips the multi-MB immutable blobs.
      const sig = await lightSig(titleId, title);
      if (!remote || sig !== title.syncSig) direction = 'push';
    }
    slog('plan', { syncId, titleName: title.name, localRev: title.syncRev || 0, remoteRev: (remote && remote.rev) || 0, remoteDevice: remote && remote.deviceId, me, direction });
    return { direction, folderId, manifestId, remote, me, syncId, title };
  }

  // ---- Force override (determinism on demand) ------------------------------
  // Push this device's state up regardless of rev (Force Upload). push() already
  // bumps rev above the remote, so this is just an unconditional push.
  async function forcePush(titleId) {
    const title = await window.titleStore.get(titleId);
    slog('forcePush', { titleId });
    return await push(titleId, { includeMedia: !!(title && title.syncIncludeMedia) });
  }
  // Adopt the Drive copy regardless of rev (Force Download). Positions stay
  // forward-only, so this can never rewind your furthest place.
  async function forcePull(titleId) {
    await window.gdriveAuth.getAccessToken();
    const title = await window.titleStore.get(titleId);
    if (!title) throw new Error('Title not found');
    const syncId = await window.titleStore.ensureSyncId(titleId);
    const fo = await window.driveApi.findFolder(syncId, await rootFolderId());
    if (!fo) return { action: 'noremote' };
    const remote = await readRemoteManifest(fo.id);
    if (!remote) return { action: 'noremote' };
    slog('forcePull', { titleId, rev: remote.rev });
    return await pullFromFolder(fo.id, remote, { targetLocalId: titleId, includeMedia: !!title.syncIncludeMedia });
  }

  window.driveSync = {
    sync,
    push,
    pull: pullFromFolder,
    autoPush,
    autoPull,
    planSync,
    forcePush,
    forcePull,
    listRemote,
    deviceId,
    rootFolderId,
    flushLivePositions,
    readRemoteManifest,
    // exposed for tests / UI / cross-module logging
    _slog: slog,
    lightSig,
    sigOf, gatherSnapshot, srcKey, imgKey, KEY_PREFIXES, LOGICAL_KEYS,
  };
})();
