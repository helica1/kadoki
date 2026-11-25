// icloud-library.js — window.iCloudLib: Titles stored in iCloud Drive › Kadoki.
//
// Layout (one folder per Title, named by its cross-device syncId):
//   Library/<syncId>/title.json   name, author, folder, media descriptors
//   Library/<syncId>/cover.json   {dataUri} (only when the Title has a cover)
//   Library/<syncId>/media/<file> the EPUB / audiobook / SRT, original names
//
// A published attachment keeps its name and gains
//   uri: "icloud://Library/<syncId>/media/<file>"
// FileAccess.materializeToCache resolves that natively: downloads the file if
// it's only in iCloud, then uses it where it sits (no second copy). So every
// existing open path (rehydrateTitleCachePaths, the EPUB loaders) works as-is.
//
// Step 2 scope: explicit "Upload to iCloud" per Title, the Library picking up
// Titles other devices published, and "Remove download". Positions, AI data
// and the move-everything migration come in later steps.
//
// Place safety: a Title's NAME and attachment NAMES are never changed here —
// positions and bookmarks are keyed by them.
(function () {
  'use strict';
  const LIB = 'Library';
  const MEDIA_KINDS = ['epub', 'srt', 'audiobook'];
  const DISMISSED_KEY = 'ICLOUD_DISMISSED_V1';   // syncIds deleted on this device
  const SEEN_KEY = 'ICLOUD_SEEN_V1';             // syncId → title.json mtime last applied
  const DERIVED_KEY = 'ICLOUD_DERIVED_V1';       // syncId → {kind: size} of generated files last copied up
  const COLL_THUMBS = 'YTCOLL_THUMBS_V1_';       // blobStore + titleId → {videoId: dataUri}

  const log = (m) => { try { window.debugLog ? window.debugLog('[iCloudLib] ' + m) : console.log('[iCloudLib] ' + m); } catch (_) {} };
  const kc = () => window.kCloud;
  const ts = () => window.titleStore;
  const FA = () => window.Capacitor?.Plugins?.FileAccess;

  function jget(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (_) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  const isICloudUri = (u) => typeof u === 'string' && u.startsWith('icloud://');
  const toUri = (path) => 'icloud://' + path.split('/').map(encodeURIComponent).join('/');
  const fromUri = (u) => decodeURIComponent(String(u).slice('icloud://'.length));
  // A file name that is safe as one path component; keeps the extension
  // (codec detection depends on it).
  const safeName = (n) => String(n || 'file').replace(/[\/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file';

  async function available() {
    if (!kc() || !kc().supported) return false;
    try { return !!(await kc().status()).available; } catch (_) { return false; }
  }

  /** Media paths ("Library/<sid>/media/x") of a Title's iCloud attachments. */
  function cloudPaths(title) {
    const a = (title && title.attachments) || {};
    return MEDIA_KINDS.map(k => a[k] && isICloudUri(a[k].uri) ? fromUri(a[k].uri) : null).filter(Boolean);
  }
  // Published = has iCloud media, or is a local copy LINKED to an iCloud title
  // (same book already on this device: it keeps its own files and data).
  function isPublished(title) { return !!(title && (title.icloudLinked || cloudPaths(title).length > 0)); }
  // Every media attachment is an iCloud one (a title created from iCloud).
  function cloudOnlyMedia(title) {
    const a = (title && title.attachments) || {};
    const ks = MEDIA_KINDS.filter(k => a[k]);
    return ks.length > 0 && ks.every(k => isICloudUri(a[k].uri));
  }

  // Is `t` this device's own copy of the book described by `media`? Same EPUB
  // or audiobook file name, and the same size whenever both sizes are known.
  function sameBook(t, media) {
    const a = (t && t.attachments) || {};
    let hit = false;
    for (const k of ['epub', 'audiobook']) {
      const m = media && media[k], la = a[k];
      if (!m || !la || !m.name || !la.name) continue;
      if (String(m.name).trim().toLowerCase() !== String(la.name).trim().toLowerCase()) return false;
      const ls = Number(la.size) || 0, rs = Number(m.size) || 0;
      if (ls && rs && ls !== rs) return false;
      hit = true;
    }
    return hit;
  }
  async function findLocalTwin(media, exceptId) {
    const all = (await ts().list()) || [];
    return all.find(t => t.id !== exceptId && !isPublished(t) && sameBook(t, media)) || null;
  }
  // Link a local copy to an iCloud title: it takes the iCloud syncId (so
  // positions and later AI data sync) and keeps its own files and data.
  async function linkTwin(twin, sid) {
    await ts().update(twin.id, { syncId: sid, icloudLinked: true });
    log('linked local copy ' + twin.name + ' → ' + sid);
  }
  function mediaOf(t) {
    const a = (t && t.attachments) || {}, out = {};
    for (const k of MEDIA_KINDS) if (a[k]) out[k] = { name: a[k].name, size: a[k].size };
    return out;
  }

  /** 'local' (all on this device) | 'cloud' (some only in iCloud) | null (not an iCloud title). */
  async function downloadState(title) {
    const paths = cloudPaths(title);
    if (!paths.length) return null;
    for (const p of paths) {
      try { const st = await kc().stat(p); if (st.exists && st.status && st.status !== 'current') return 'cloud'; }
      catch (_) { return 'cloud'; }
    }
    return 'local';
  }

  // The Title that's loaded right now (reader/audio) — never pull its files
  // out from under it.
  function isLoaded(title) {
    try { return !!title && window._loadedContentTitleId === title.id; } catch (_) { return false; }
  }

  async function localSourcePath(att) {
    if (att.cachePath) {
      try { const r = await FA()?.materializeToCache?.({ uri: 'file://' + att.cachePath }); if (r?.path) return r.path; } catch (_) {}
    }
    if (att.uri) {
      const r = await FA().materializeToCache({ uri: att.uri });
      if (r?.path) return r.path;
    }
    if (att.cachePath) return att.cachePath;
    throw new Error('no local file for ' + (att.name || 'attachment'));
  }

  /**
   * Copy a Title's media into its iCloud folder and point the Title at it.
   * The local originals are left alone (the move-everything migration is a
   * later step). onProgress({kind, index, total}).
   */
  async function publish(titleId, onProgress) {
    if (!(await available())) throw new Error('iCloud Drive is not available');
    let t = await ts().get(titleId);
    if (!t) throw new Error('title not found');
    const a = t.attachments || {};
    if (Array.isArray(a.series) && a.series.length > 1) throw new Error('Series titles can’t be uploaded to iCloud yet.');
    const kinds = MEDIA_KINDS.filter(k => a[k] && (a[k].uri || a[k].cachePath));
    if (!kinds.length) throw new Error('This title has no files to upload.');
    const sid = await ts().ensureSyncId(titleId);
    const base = `${LIB}/${sid}`;
    const used = new Set();
    const patch = {};
    const media = {};
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i], att = a[kind];
      try { onProgress && onProgress({ kind, index: i, total: kinds.length }); } catch (_) {}
      let dest;
      if (isICloudUri(att.uri)) {
        dest = fromUri(att.uri);
      } else if (att.auto) {
        // Generated here (transcript SRT / generated book): it keeps changing
        // on this device (transcription, 校正), so the local file stays the
        // source and iCloud gets a copy, refreshed by syncDerived().
        let fname = safeName(att.name);
        if (used.has(fname)) fname = kind + '-' + fname;
        dest = `${base}/media/${fname}`;
        const src = await localSourcePath(att);
        await kc().importFile(src, dest, { move: false, overwrite: true });
        const st = await kc().stat(dest).catch(() => ({}));
        derivedSeen(sid, kind, st.size || 0);
        media[kind] = { file: dest.slice(base.length + 1), name: att.name, size: Number(st.size) || null, auto: att.auto };
        used.add(dest.split('/').pop());
        continue;
      } else {
        let fname = safeName(att.name);
        if (used.has(fname)) fname = kind + '-' + fname;
        dest = `${base}/media/${fname}`;
        const src = await localSourcePath(att);
        let need = true;
        try {
          const st = await kc().stat(dest);
          const srcSize = Number(att.size) || 0;
          if (st.exists && srcSize && st.size === srcSize) need = false;
        } catch (_) {}
        if (need) await kc().importFile(src, dest, { move: false, overwrite: true });
        const next = Object.assign({}, att, { uri: toUri(dest) });
        try { const st = await kc().stat(dest); if (st.size) next.size = st.size; } catch (_) {}
        if (kind !== 'epub') delete next.cachePath;   // re-resolved on open (rehydrateTitleCachePaths)
        patch[kind] = next;
      }
      used.add(dest.split('/').pop());
      const fin = patch[kind] || att;
      media[kind] = { file: dest.slice(base.length + 1), name: att.name, size: Number(fin.size) || null, auto: att.auto || undefined };
    }
    const cover = a.cover && a.cover.dataUri;
    if (cover) await kc().writeJSON(`${base}/cover.json`, { dataUri: cover });
    // YouTube Collection: the parts list rides in title.json; the per-part
    // thumbnails (big) in their own collection.json.
    const coll = t.collection && Array.isArray(t.collection.parts) ? t.collection : null;
    if (coll) {
      let thumbs = {};
      try { thumbs = JSON.parse((await window.blobStore?.get(COLL_THUMBS + titleId)) || '{}') || {}; } catch (_) {}
      await kc().writeJSON(`${base}/collection.json`, { thumbs });
    }
    // title.json last: another device that sees it finds the media folder in place.
    await kc().writeJSON(`${base}/title.json`, {
      v: 1, syncId: sid, name: t.name, author: t.author || '', folder: t.folder || '',
      createdAt: t.createdAt || Date.now(), updatedAt: Date.now(), media, hasCover: !!cover,
      collection: coll || undefined,
    });
    t = await ts().update(titleId, Object.keys(patch).length ? { attachments: patch, icloudLinked: true } : { icloudLinked: true });
    const seen = jget(SEEN_KEY, {}); seen[sid] = Date.now(); jset(SEEN_KEY, seen);
    log('published ' + t.name + ' → ' + base + ' (' + kinds.join(',') + ')');
    try { window.iCloudPos?.push(titleId, 'published'); } catch (_) {}
    return t;
  }

  function derivedSeen(sid, kind, size) {
    const m = jget(DERIVED_KEY, {}); (m[sid] = m[sid] || {})[kind] = size; jset(DERIVED_KEY, m);
  }
  async function localSize(att) {
    try {
      const FS = window.Capacitor?.Plugins?.Filesystem;
      const p = att.cachePath || (att.uri && !isICloudUri(att.uri) ? att.uri : '');
      if (!FS || !p) return 0;
      const st = await FS.stat({ path: p.startsWith('file://') || p.includes('://') ? p : 'file://' + p });
      return Number(st && st.size) || 0;
    } catch (_) { return 0; }
  }
  /**
   * Generated files (transcript SRT, generated book) of titles this device
   * published keep changing here — transcription, 校正, furigana. Re-copy any
   * that changed so other devices get the current version.
   */
  let _derivedBusy = false;
  async function syncDerived() {
    if (_derivedBusy || !(await available())) return 0;
    _derivedBusy = true;
    let n = 0;
    try {
      const m = jget(DERIVED_KEY, {});
      for (const t of (await ts().list()) || []) {
        if (!t.syncId || !isPublished(t) || isLoaded(t) && window._titleSwitchInFlight) continue;
        const a = t.attachments || {};
        const auto = MEDIA_KINDS.filter(k => a[k] && a[k].auto && !isICloudUri(a[k].uri));
        if (!auto.length) continue;
        let changed = false;
        for (const k of auto) {
          const sz = await localSize(a[k]);
          if (sz && sz !== (m[t.syncId] || {})[k]) { changed = true; break; }
        }
        if (changed) {
          try { await publish(t.id); n++; log('refreshed generated files of ' + t.name); }
          catch (e) { log('refresh failed for ' + t.name + ': ' + (e?.message || e)); }
        }
      }
    } finally { _derivedBusy = false; }
    return n;
  }

  /** "Remove download": the files stay in iCloud; this device frees its copy. */
  async function removeDownload(titleId) {
    const t = await ts().get(titleId);
    if (!t) return 0;
    if (isLoaded(t)) throw new Error('Close this title first — it’s open right now.');
    let n = 0;
    for (const p of cloudPaths(t)) { try { n += (await kc().evict(p)).evicted || 0; } catch (_) {} }
    return n;
  }

  /** Start downloading a Title's files in the background. */
  async function download(titleId) {
    const t = await ts().get(titleId);
    if (!t) return;
    for (const p of cloudPaths(t)) { try { await kc().download(p); } catch (_) {} }
  }

  // ---- Picking up Titles other devices published ---------------------------

  function attFromMedia(base, m) {
    const att = { uri: toUri(`${base}/${m.file}`), name: m.name || m.file.split('/').pop() };
    if (m.size) att.size = m.size;
    if (m.auto) att.auto = m.auto;
    return att;
  }

  async function pullCollectionThumbs(titleId, base) {
    try {
      const c = await kc().readJSON(`${base}/collection.json`, 120000);
      if (c && c.thumbs) await window.blobStore?.set(COLL_THUMBS + titleId, JSON.stringify(c.thumbs));
    } catch (_) {}
  }

  let _scanning = null;
  async function scan(reason) {
    if (_scanning) return _scanning;
    _scanning = (async () => {
      if (!(await available())) return 0;
      let entries;
      try { entries = await kc().list(LIB, true); } catch (_) { return 0; }
      const jsons = entries.filter(e => !e.isDir && /^Library\/[^/]+\/title\.json$/.test(e.path));
      if (!jsons.length) return 0;
      const seen = jget(SEEN_KEY, {});
      const dismissed = new Set(jget(DISMISSED_KEY, []));
      let changed = 0;
      // Repair duplicates made before twin-linking existed: a title created
      // from iCloud next to this device's own copy of the same book. Keep the
      // local copy (its AI data, cover, stats), link it, drop the iCloud one.
      try {
        const all = (await ts().list()) || [];
        for (const dup of all) {
          if (!dup.syncId || !cloudOnlyMedia(dup) || dup.icloudLinked) continue;
          if (dup.id === window._activeTitleId || dup.id === window._loadedContentTitleId) continue;
          const twin = await findLocalTwin(mediaOf(dup), dup.id);
          if (!twin) continue;
          await linkTwin(twin, dup.syncId);
          await _origRemove(dup.id);
          log('removed duplicate iCloud entry for ' + dup.name);
          changed++;
        }
      } catch (err) { log('duplicate repair failed: ' + (err?.message || err)); }
      for (const e of jsons) {
        const sid = e.path.split('/')[1];
        if (dismissed.has(sid)) continue;
        const local = await ts().findBySyncId(sid);
        if (local && seen[sid] && seen[sid] >= (e.mtime || 0)) continue;
        let info;
        try { info = await kc().readJSON(e.path); } catch (err) { log('read ' + e.path + ' failed: ' + (err?.message || err)); continue; }
        if (!info || !info.media) continue;
        const base = `${LIB}/${sid}`;
        if (!local) {
          // This device may already have the same book (its own import, with a
          // different syncId): link that copy instead of adding a second one.
          const twin = await findLocalTwin(info.media, null);
          if (twin) { await linkTwin(twin, sid); seen[sid] = e.mtime || Date.now(); changed++; continue; }
          const attachments = {};
          for (const k of MEDIA_KINDS) if (info.media[k]) attachments[k] = attFromMedia(base, info.media[k]);
          if (info.hasCover) {
            try { const c = await kc().readJSON(`${base}/cover.json`); if (c && c.dataUri) attachments.cover = { dataUri: c.dataUri }; } catch (_) {}
          }
          const nt = await ts().create({ syncId: sid, name: info.name || 'Untitled', author: info.author || '', attachments });
          const extra = {};
          if (info.folder) extra.folder = info.folder;
          if (info.collection) extra.collection = info.collection;
          if (Object.keys(extra).length) { try { await ts().update(nt.id, extra); } catch (_) {} }
          if (info.collection) await pullCollectionThumbs(nt.id, base);
          log('added ' + nt.name + ' from iCloud');
          changed++;
        } else {
          // Same Title already here: only fill in what it lacks. A local file
          // is never replaced, and the name never changes (positions key on it).
          const patch = {};
          for (const k of MEDIA_KINDS) {
            const m = info.media[k], la = local.attachments?.[k];
            if (m && !la) patch[k] = attFromMedia(base, m);
            // Same iCloud file, new content (generated files refreshed, a
            // Collection grown): the size change re-keys this device's caches.
            else if (m && la && isICloudUri(la.uri) && fromUri(la.uri) === `${base}/${m.file}` && m.size && Number(la.size) !== m.size) {
              patch[k] = Object.assign({}, la, { size: m.size });
              if (k === 'epub') { try { window.pagedInvalidateLoadedTitle?.(local.id); } catch (_) {} }
            }
          }
          const upd = {};
          if (Object.keys(patch).length) upd.attachments = patch;
          if (info.collection && !local.icloudLinked) upd.collection = info.collection;
          if (Object.keys(upd).length) { await ts().update(local.id, upd); changed++; log('updated ' + Object.keys(patch).join(',') + (upd.collection ? ' +collection' : '') + ' for ' + local.name); }
          if (info.collection) await pullCollectionThumbs(local.id, base);
        }
        seen[sid] = e.mtime || Date.now();
      }
      jset(SEEN_KEY, seen);
      // YouTube Collections made on the Mac download to the phone by
      // themselves (2026-11-24, user: "download seamlessly on the phone") —
      // iOS fetches in the background, even with the app closed. Only starts
      // files not already here, so repeating it every scan costs nothing; a
      // grown or re-encoded Collection is picked up the same way.
      if (!window.KADOKI_MAC) {
        try {
          for (const t of (await ts().list()) || []) {
            if (t.collection && t.syncId) await download(t.id);
          }
        } catch (_) {}
      }
      // Part thumbnails missing here (the first pull can fail while
      // collection.json is still downloading, and that title.json is then
      // marked seen): fetch them again until every part has one.
      try {
        for (const t of (await ts().list()) || []) {
          const parts = t.collection && t.collection.parts;
          if (!t.syncId || !Array.isArray(parts) || !parts.length) continue;
          let have = {};
          try { have = JSON.parse((await window.blobStore?.get(COLL_THUMBS + t.id)) || '{}') || {}; } catch (_) {}
          if (parts.every(p => have[p.id])) continue;
          await pullCollectionThumbs(t.id, `${LIB}/${t.syncId}`);
          let now = {};
          try { now = JSON.parse((await window.blobStore?.get(COLL_THUMBS + t.id)) || '{}') || {}; } catch (_) {}
          if (Object.keys(now).length > Object.keys(have).length) { log('pulled part thumbnails for ' + t.name); changed++; }
        }
      } catch (_) {}
      if (changed) {
        log('scan (' + (reason || '') + '): ' + changed + ' title(s) changed');
        try { if (typeof window.populateLibrary === 'function') window.populateLibrary(); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('kai:icloud-library', { detail: { changed } })); } catch (_) {}
      }
      return changed;
    })().finally(() => { _scanning = null; });
    return _scanning;
  }

  // Deleting a Title on this device doesn't delete it from iCloud (yet), so
  // remember its syncId — otherwise the next scan would bring it straight back.
  let _origRemove = (id) => ts().remove(id);   // remove WITHOUT recording a dismissal
  function hookRemove() {
    const store = ts();
    if (!store || store._icloudHooked) return;
    const orig = store.remove;
    _origRemove = (id) => orig.call(store, id);
    store.remove = async function (id) {
      try {
        const t = await store.get(id);
        if (t && t.syncId && isPublished(t)) {
          const d = new Set(jget(DISMISSED_KEY, [])); d.add(t.syncId); jset(DISMISSED_KEY, [...d]);
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    store._icloudHooked = true;
  }

  let _scanTimer = null;
  function scanSoon(reason, ms) {
    clearTimeout(_scanTimer);
    _scanTimer = setTimeout(() => { scan(reason).catch(() => {}).then(() => syncDerived().catch(() => {})); }, ms == null ? 1500 : ms);
  }

  function boot() {
    if (!kc() || !kc().supported) return;   // Android / web: nothing to do
    hookRemove();
    scanSoon('boot', 4000);
    // Generated files keep changing with nobody touching the app (overnight
    // proofreading, furigana): re-copy changed ones every 2 minutes. Cheap —
    // one file-size check per iCloud title with generated files.
    setInterval(() => { if (!document.hidden || window.KADOKI_MAC) syncDerived().catch(() => {}); }, 120000);
    kc().onChange((ev) => {
      const paths = (ev && ev.changed || []).map(c => c.path || '');
      if (ev && ev.initial || paths.some(p => /\/title\.json$/.test(p))) scanSoon('change');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scanSoon('resume', 2000); });
  }

  // One entry point for the Library buttons (web and native iOS).
  const _busy = new Set();
  const toast = (m, ms) => { try { window.showToast ? window.showToast(m, ms || 2200) : log(m); } catch (_) {} };
  const T = (k, d) => { try { return window.i18n ? window.i18n.t(k, d) : d; } catch (_) { return d; } };
  async function action(kind, titleId) {
    if (_busy.has(titleId)) { toast(T('lib.icloud_busy', 'Already working on this title…')); return; }
    _busy.add(titleId);
    try {
      if (kind === 'icloudUpload') {
        toast(T('lib.icloud_uploading', 'Uploading to iCloud…'));
        await publish(titleId);
        toast(T('lib.icloud_uploaded', 'Saved to iCloud. It uploads in the background.'), 3000);
      } else if (kind === 'icloudDownload') {
        await download(titleId);
        toast(T('lib.icloud_downloading', 'Downloading from iCloud…'));
      } else if (kind === 'icloudEvict') {
        await removeDownload(titleId);
        toast(T('lib.icloud_evicted', 'Download removed. The title stays in iCloud.'));
      }
    } catch (e) {
      try { alert(String(e && e.message || e)); } catch (_) {}
    } finally {
      _busy.delete(titleId);
      try { if (typeof window.populateLibrary === 'function') window.populateLibrary(); } catch (_) {}
    }
  }
  window.iCloudAction = action;

  window.iCloudLib = {
    available, publish, removeDownload, download, downloadState, isPublished, scan, syncDerived,
    COLL_THUMBS, toUri,
    isICloudUri, _fromUri: fromUri,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
