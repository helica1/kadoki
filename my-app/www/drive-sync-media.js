// drive-sync-media.js — Large-media (epub/srt/audiobook) transfer for Drive
// sync (P3). Loaded only as an optional add-on; drive-sync.js calls these
// hooks when the user enabled "include media".
//
// Upload: materialize the attachment to a real cache PATH, then stream it to a
// Drive resumable session in 8 MB chunks read via FileAccess.readChunk (so a
// 300 MB audiobook never lands in JS memory whole). Download: ranged GETs
// assembled with Filesystem.appendFile into a cache file, then attached.
//
// Incremental: an unchanged media file (same kind/name/size already uploaded)
// reuses its prior driveFileId — no re-transfer.

(function () {
  'use strict';

  const CHUNK = 8 * 1024 * 1024;   // 8 MB — a multiple of 256 KB (Drive resumable requirement)

  function FA() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileAccess; }
  function FS() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem; }

  function mimeFor(kind) {
    if (kind === 'epub') return 'application/epub+zip';
    if (kind === 'srt') return 'text/plain';
    return 'application/octet-stream';   // audiobook: codec varies (m4b/mp3/…)
  }
  function sanitize(name) { return String(name || 'media').replace(/[^\w.\-]+/g, '_'); }

  async function fileSize(path) {
    const fs = FS();
    if (!fs) return 0;
    const p = path.indexOf('file://') === 0 ? path : 'file://' + path;
    try { const s = await fs.stat({ path: p }); if (s && s.size) return s.size; } catch (_) {}
    try { const s = await fs.stat({ path }); if (s && s.size) return s.size; } catch (_) {}
    return 0;
  }

  // Resolve a real filesystem path + size for a title attachment. Prefers an
  // existing cachePath; else materializes the uri (which also yields size).
  async function resolvePath(title, kind) {
    const at = (title.attachments || {})[kind];
    if (!at) return null;
    if (at.cachePath) {
      const size = await fileSize(at.cachePath);
      return { path: at.cachePath, size };
    }
    if (at.uri && FA() && FA().materializeToCache) {
      try {
        const r = await FA().materializeToCache({ uri: at.uri });
        if (r && r.path) return { path: r.path, size: r.size || (await fileSize(r.path)) };
      } catch (_) {}
    }
    return null;
  }

  // Upload all media; returns the media manifest array
  // [{kind,name,size,driveFileId}]. priorMedia lets unchanged files be reused.
  async function uploadMedia(folderId, title, mediaList, priorMedia, onProgress) {
    const onP = onProgress || function () {};
    const prior = priorMedia || [];
    const out = [];
    for (const m of (mediaList || [])) {
      // The 3 core files (epub/srt/audiobook) are IMMUTABLE once imported — never
      // re-upload. If this kind+name is already on Drive, reuse its id, full stop.
      const same = prior.find(p => p.kind === m.kind && p.name === m.name && p.driveFileId);
      if (same) { out.push(same); continue; }
      const resolved = await resolvePath(title, m.kind);
      if (!resolved || !resolved.path) { out.push({ kind: m.kind, name: m.name, size: m.size || null, driveFileId: null }); continue; }
      const size = resolved.size || m.size || 0;
      if (!size) { out.push({ kind: m.kind, name: m.name, size: null, driveFileId: null }); continue; }

      const driveName = 'media_' + m.kind + '_' + sanitize(m.name);
      const uploadUrl = await window.driveApi.createResumable(folderId, driveName, mimeFor(m.kind), size);
      let offset = 0, fileId = null;
      while (offset < size) {
        const len = Math.min(CHUNK, size - offset);
        const chunk = await FA().readChunk({ path: resolved.path, offset, length: len });
        const res = await window.driveApi.putChunk(uploadUrl, chunk.data, offset, size);
        offset += (chunk.bytesRead || len);
        onP({ phase: 'media', dir: 'up', kind: m.kind, current: offset, total: size });
        if (res && res.done) { fileId = res.fileId; break; }
      }
      out.push({ kind: m.kind, name: m.name, size, driveFileId: fileId });
    }
    return out;
  }

  // Download one media entry into a cache file and attach it to the title.
  async function downloadMedia(localId, m, onProgress) {
    const onP = onProgress || function () {};
    if (!m || !m.driveFileId || !m.size) return false;
    const fs = FS();
    if (!fs) return false;
    const fname = 'synced_' + localId + '_' + m.kind + '_' + sanitize(m.name);
    const dir = 'CACHE';

    // Truncate/create the target, then append ranged chunks (bounded memory).
    try { await fs.writeFile({ path: fname, directory: dir, data: '' }); } catch (_) {}
    let offset = 0;
    while (offset < m.size) {
      const len = Math.min(CHUNK, m.size - offset);
      const b64 = await window.driveApi.downloadRange(m.driveFileId, offset, len);
      await fs.appendFile({ path: fname, directory: dir, data: b64 });   // no encoding ⇒ base64 → binary
      offset += len;
      onP({ phase: 'media', dir: 'down', kind: m.kind, current: offset, total: m.size });
    }

    // Resolve to a real path and attach (keep the ORIGINAL name so codec
    // detection / slicing works, per the iOS-audio-naming lesson).
    let cachePath = null;
    try {
      const u = await fs.getUri({ path: fname, directory: dir });
      cachePath = (u && u.uri ? u.uri : '').replace(/^file:\/\//, '');
    } catch (_) {}
    if (!cachePath) return false;
    if (window.titleStore && window.titleStore.attach) {
      // Keep the Drive id + size on the attachment so a later cache eviction can be
      // self-healed by re-downloading (synced media lives in CACHE, which the OS may
      // evict; Drive is the durable source of truth). attach() replaces the whole
      // object, so all fields the loaders need must be set here.
      await window.titleStore.attach(localId, m.kind, { cachePath, name: m.name, driveFileId: m.driveFileId, size: m.size || null });
    }
    // If we just replaced the READ source of a title the reader already rendered,
    // invalidate its loaded copy so re-entering read mode shows the NEW content
    // (otherwise the "don't reload the same book" guard keeps the stale one).
    if (m.kind === 'epub') { try { window.pagedInvalidateLoadedTitle && window.pagedInvalidateLoadedTitle(localId); } catch (_) {} }
    return true;
  }

  // Container-safe resolver for a SYNCED media attachment. iOS rotates the app's
  // Data-container UUID on REINSTALL (and wipes its cache), so the absolute
  // cachePath stored before is stale and its file is gone. The file's name is
  // deterministic, so recompute the CURRENT-container path from it; if the file is
  // missing, re-download from Drive. opts.background=true → kick the (large) audio
  // download off without awaiting (so the title open / card isn't blocked) and fire
  // `kai:synced-media-ready` when it lands. Returns the current-container path.
  const _dlInFlight = {};   // fname → in-flight download promise (dedup concurrent callers)
  function _dedupDownload(localId, kind, att, fname) {
    if (_dlInFlight[fname]) return _dlInFlight[fname];
    const p = downloadMedia(localId, { kind, name: att.name, size: att.size, driveFileId: att.driveFileId })
      .catch(() => false)
      .finally(() => { delete _dlInFlight[fname]; });
    _dlInFlight[fname] = p;
    return p;
  }
  async function ensureLocalPath(localId, kind, att, opts) {
    opts = opts || {};
    const fs = FS();
    if (!fs || !localId || !att || !att.name) return (att && att.cachePath) || '';
    const fname = 'synced_' + localId + '_' + kind + '_' + sanitize(att.name);
    let cur = '';
    try { const u = await fs.getUri({ path: fname, directory: 'CACHE' }); cur = (u && u.uri ? u.uri : '').replace(/^file:\/\//, ''); } catch (_) {}
    if (!cur) return att.cachePath || '';
    // Present AND complete? A backgrounded/killed/dropped download leaves a NON-empty
    // but truncated file; compare against the known size so a partial isn't mistaken
    // for done (which would never recover). att.size is the manifest byte count.
    if ((await fileSize(cur)) >= (att.size || 1)) return cur;           // present + complete in the CURRENT container → done (free)
    if (!(att.driveFileId && att.size)) return cur;                     // can't re-download → hand back current path anyway
    const dl = _dedupDownload(localId, kind, att, fname);
    if (opts.background) {
      dl.then(() => { try { window.dispatchEvent(new CustomEvent('kai:synced-media-ready', { detail: { localId, kind } })); } catch (_) {} });
      return cur;                                                       // path is current; file fills in shortly
    }
    try { await dl; const u2 = await fs.getUri({ path: fname, directory: 'CACHE' }); const p2 = (u2 && u2.uri ? u2.uri : '').replace(/^file:\/\//, ''); if (p2) return p2; } catch (_) {}
    return cur;
  }

  // [{kind,name,size}] for a title's local media, sizes resolved cheaply from
  // an existing cache file (no materialize). size may be 0 if not yet cached.
  async function localMediaInfo(title) {
    const a = (title && title.attachments) || {};
    const out = [];
    for (const kind of ['epub', 'srt', 'audiobook']) {
      const at = a[kind];
      if (!at || !at.name) continue;
      let size = (typeof at.size === 'number' && at.size > 0) ? at.size : 0;
      if (!size && at.cachePath) size = await fileSize(at.cachePath);
      out.push({ kind, name: at.name, size });
    }
    return out;
  }

  window.driveSyncMedia = { uploadMedia, downloadMedia, localMediaInfo, ensureLocalPath };
})();
