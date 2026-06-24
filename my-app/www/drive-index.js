// drive-index.js — Whole-library membership index for Google Drive sync.
//
// A single small `library.json` at the sync root lists every synced title (one
// line each): { syncId, titleName, fp[], kinds[], rev, mtime, deviceId,
// hasFiles }. Reading/writing it is ONE cheap Drive op regardless of how many
// titles you own — that is what makes "the whole library appears on every
// device" and "Sync finds the most-recently-synced title" affordable. The heavy
// per-title data (positions, AI, timeline, cover) still lives in per-title
// folders and moves lazily + incrementally via drive-sync.js.
//
// Identity: a title's Drive folder is named by its syncId (never re-derived from
// the display name — that was the silent "device 2 doesn't inherit" bug). Two
// devices recognize the same book by MEDIA FINGERPRINT against this index, with
// a one-time confirm, then bind to the shared syncId.
//
// Deletes are LOCAL-ONLY (user decision): a locally-removed title is added to a
// device-local dismiss set so it doesn't resurrect from the index; its index
// entry stays (other devices keep it). Cloud removal is explicit via Browse.
//
// Depends on: window.driveApi. Logging piggybacks on window.driveSync._slog.

(function () {
  'use strict';

  const INDEX_NAME = 'library.json';
  const DISMISS_KEY = 'GDRIVE_DISMISSED_V1';
  const BINDSKIP_KEY = 'GDRIVE_BINDSKIP_V1';
  const MANIFEST = 'manifest.json';

  function slog(tag, obj) { try { if (window.driveSync && window.driveSync._slog) window.driveSync._slog(tag, obj); } catch (_) {} }

  // ---- dismiss-list prefs (local only) ------------------------------------
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  async function prefGet(k) {
    try { if (CapPrefs()) return (await CapPrefs().get({ key: k })).value; } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function prefSet(k, v) {
    try { if (CapPrefs()) await CapPrefs().set({ key: k, value: String(v) }); } catch (_) {}
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }
  async function dismissed() {
    try { const raw = await prefGet(DISMISS_KEY); const arr = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(arr) ? arr : []); }
    catch (_) { return new Set(); }
  }
  async function dismiss(syncId) {
    if (!syncId) return;
    const s = await dismissed(); s.add(syncId);
    await prefSet(DISMISS_KEY, JSON.stringify([...s]));
    slog('index.dismiss', { syncId });
  }
  async function undismiss(syncId) {
    if (!syncId) return;
    const s = await dismissed(); if (!s.delete(syncId)) return;
    await prefSet(DISMISS_KEY, JSON.stringify([...s]));
    slog('index.undismiss', { syncId });
  }

  // Bind-skip: when the user DECLINES a one-time "same book?" confirm, remember
  // the (localId|syncId) pair so we never nag them about that pairing again.
  function bindKey(localId, syncId) { return localId + '|' + syncId; }
  async function bindSkipped() {
    try { const raw = await prefGet(BINDSKIP_KEY); const arr = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(arr) ? arr : []); }
    catch (_) { return new Set(); }
  }
  async function skipBind(localId, syncId) {
    if (!localId || !syncId) return;
    const s = await bindSkipped(); s.add(bindKey(localId, syncId));
    await prefSet(BINDSKIP_KEY, JSON.stringify([...s]));
  }

  // ---- the index file ------------------------------------------------------
  let _indexFileId = null;
  async function indexFileId(rootId) {
    if (_indexFileId) return _indexFileId;
    try { const f = await window.driveApi.findInFolder(rootId, INDEX_NAME); if (f) { _indexFileId = f.id; return f.id; } } catch (_) {}
    return null;
  }

  // Read the index, or null if it doesn't exist yet.
  async function read(rootId) {
    const fid = await indexFileId(rootId);
    if (!fid) return null;
    try {
      const idx = JSON.parse(await window.driveApi.getText(fid));
      slog('index.read', { titles: Object.keys((idx && idx.titles) || {}).length, by: idx && idx.updatedBy });
      return idx;
    } catch (_) { return null; }
  }

  // Write the index back (create or update in place).
  async function write(rootId, idx, me) {
    idx.v = 1; idx.updatedAt = Date.now(); idx.updatedBy = me || idx.updatedBy || '';
    const body = JSON.stringify(idx);
    let fid = await indexFileId(rootId);
    if (fid) await window.driveApi.updateMedia(fid, 'application/json', body, false);
    else { fid = await window.driveApi.createMultipart(rootId, INDEX_NAME, 'application/json', body, false); _indexFileId = fid; }
    slog('index.write', { titles: Object.keys(idx.titles || {}).length, by: idx.updatedBy });
    return fid;
  }

  // One-time migration: build an index by scanning the existing per-title
  // folders' manifests (installs that synced before the index existed).
  async function buildFromFolders(rootId, me) {
    const idx = { v: 1, updatedAt: Date.now(), updatedBy: me || '', titles: {} };
    let folders = [];
    try { folders = await window.driveApi.listFolders(); } catch (_) {}
    for (const fo of folders) {
      if (fo.name === INDEX_NAME) continue;
      let m = null;
      try { const mf = await window.driveApi.findInFolder(fo.id, MANIFEST); if (mf) m = JSON.parse(await window.driveApi.getText(mf.id)); } catch (_) {}
      if (m && m.syncId) upsertEntry(idx, m);
    }
    slog('index.build', { titles: Object.keys(idx.titles).length });
    return idx;
  }

  // Upsert a title's index entry from its manifest. hasFilesOverride lets the
  // caller assert media presence when it knows (e.g. just uploaded).
  function upsertEntry(idx, manifest, hasFilesOverride) {
    if (!idx.titles) idx.titles = {};
    const media = (manifest.media || []).filter(m => m && m.name);
    // Size handling MUST match localFps() exactly, or a size-0 file would
    // fingerprint as '…|' here but '…|0' locally and never match.
    const fp = media.map(m => m.kind + '|' + String(m.name).trim().toLowerCase() + '|' + (typeof m.size === 'number' ? m.size : ''));
    const kinds = media.map(m => m.kind);
    const hasFiles = (typeof hasFilesOverride === 'boolean') ? hasFilesOverride : media.some(m => m.driveFileId);
    idx.titles[manifest.syncId] = {
      syncId: manifest.syncId,
      titleName: manifest.titleName || '',
      fp, kinds,
      rev: manifest.rev || 0,
      mtime: manifest.snapshotTs || Date.now(),
      deviceId: manifest.deviceId || '',
      hasFiles,
    };
    return idx.titles[manifest.syncId];
  }

  // Media fingerprints of a LOCAL title: ['kind|name|size', ...].
  function localFps(title) {
    const a = (title && title.attachments) || {};
    const out = [];
    for (const kind of ['epub', 'audiobook', 'srt']) {
      const at = a[kind];
      if (at && at.name) out.push(kind + '|' + String(at.name).trim().toLowerCase() + '|' + (typeof at.size === 'number' ? at.size : ''));
    }
    return out;
  }

  // Best match of a local title against index entries not already bound to a
  // local title. Match key is the media NAME; size promotes to an exact match.
  // Returns { entry, exact } or null.
  function matchFingerprint(title, idx, boundSyncIds) {
    const tfps = localFps(title);
    if (!tfps.length || !idx || !idx.titles) return null;
    let nameOnly = null;
    for (const sid of Object.keys(idx.titles)) {
      if (boundSyncIds && boundSyncIds.has(sid)) continue;
      const e = idx.titles[sid];
      for (const efp of (e.fp || [])) {
        const [, en, es] = efp.split('|');
        for (const tfp of tfps) {
          const [, tn, ts] = tfp.split('|');
          if (en !== tn) continue;                  // primary key = media NAME
          if (es && ts && es === ts) return { entry: e, exact: true };
          if (!nameOnly) nameOnly = { entry: e, exact: false };
        }
      }
    }
    return nameOnly;
  }

  // The most-recently-synced entry by wall-clock mtime. Returns {syncId, entry}.
  // `exclude` (a Set of syncIds, e.g. the local dismiss-list) is skipped so
  // Sync ↓ never navigates to a title the user deleted locally.
  function mostRecent(idx, exclude) {
    if (!idx || !idx.titles) return null;
    let best = null;
    for (const sid of Object.keys(idx.titles)) {
      if (exclude && exclude.has && exclude.has(sid)) continue;
      const e = idx.titles[sid];
      if (!best || (e.mtime || 0) > (best.entry.mtime || 0)) best = { syncId: sid, entry: e };
    }
    return best;
  }

  function resetCache() { _indexFileId = null; }

  window.driveIndex = {
    read, write, buildFromFolders, upsertEntry,
    localFps, matchFingerprint, mostRecent,
    dismissed, dismiss, undismiss,
    bindSkipped, skipBind, bindKey,
    resetCache,
  };
})();
