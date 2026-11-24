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
  function isPublished(title) { return cloudPaths(title).length > 0; }

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
    // title.json last: another device that sees it finds the media folder in place.
    await kc().writeJSON(`${base}/title.json`, {
      v: 1, syncId: sid, name: t.name, author: t.author || '', folder: t.folder || '',
      createdAt: t.createdAt || Date.now(), updatedAt: Date.now(), media, hasCover: !!cover,
    });
    if (Object.keys(patch).length) t = await ts().update(titleId, { attachments: patch });
    const seen = jget(SEEN_KEY, {}); seen[sid] = Date.now(); jset(SEEN_KEY, seen);
    log('published ' + t.name + ' → ' + base + ' (' + kinds.join(',') + ')');
    return t;
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
          const attachments = {};
          for (const k of MEDIA_KINDS) if (info.media[k]) attachments[k] = attFromMedia(base, info.media[k]);
          if (info.hasCover) {
            try { const c = await kc().readJSON(`${base}/cover.json`); if (c && c.dataUri) attachments.cover = { dataUri: c.dataUri }; } catch (_) {}
          }
          const nt = await ts().create({ syncId: sid, name: info.name || 'Untitled', author: info.author || '', attachments });
          if (info.folder) { try { await ts().update(nt.id, { folder: info.folder }); } catch (_) {} }
          log('added ' + nt.name + ' from iCloud');
          changed++;
        } else {
          // Same Title already here: only fill in what it lacks. A local file
          // is never replaced, and the name never changes (positions key on it).
          const patch = {};
          for (const k of MEDIA_KINDS) {
            if (info.media[k] && !local.attachments?.[k]) patch[k] = attFromMedia(base, info.media[k]);
          }
          if (Object.keys(patch).length) { await ts().update(local.id, { attachments: patch }); changed++; log('filled ' + Object.keys(patch).join(',') + ' for ' + local.name); }
        }
        seen[sid] = e.mtime || Date.now();
      }
      jset(SEEN_KEY, seen);
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
  function hookRemove() {
    const store = ts();
    if (!store || store._icloudHooked) return;
    const orig = store.remove;
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
    _scanTimer = setTimeout(() => { scan(reason).catch(() => {}); }, ms == null ? 1500 : ms);
  }

  function boot() {
    if (!kc() || !kc().supported) return;   // Android / web: nothing to do
    hookRemove();
    scanSoon('boot', 4000);
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
    available, publish, removeDownload, download, downloadState, isPublished, scan,
    isICloudUri, _fromUri: fromUri,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
