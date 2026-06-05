// fonts.js — user-imported custom fonts (TTF / OTF / WOFF), usable per mode.
//
// Font BLOBS live in IndexedDB (they can be a few MB — too big for
// localStorage); lightweight METADATA ({id,name,family}) lives in
// localStorage[FONTS_V1]. On boot every stored font is registered as a
// FontFace under a stable family name (kfont-<id>) so appearance.js /
// preferences.js can offer it in the per-mode font picker.
(function () {
  'use strict';
  const DB_NAME = 'font-store-v1';
  const STORE = 'fonts';
  const META_KEY = 'FONTS_V1';

  let _dbp = null;
  function db() {
    if (_dbp) return _dbp;
    _dbp = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbp;
  }
  function idbDo(mode, fn) {
    return db().then(d => new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    }));
  }
  const idbPut = (id, blob) => idbDo('readwrite', s => s.put(blob, id));
  const idbGet = (id) => idbDo('readonly', s => s.get(id));
  const idbDel = (id) => idbDo('readwrite', s => s.delete(id));

  function loadMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveMeta(list) {
    try { localStorage.setItem(META_KEY, JSON.stringify(list)); } catch (_) {}
  }
  function familyFor(id) { return 'kfont-' + id; }

  const _registered = new Set();
  async function register(id, blob) {
    if (_registered.has(id) || !blob || typeof FontFace === 'undefined') return;
    try {
      const buf = await blob.arrayBuffer();
      const ff = new FontFace(familyFor(id), buf);
      await ff.load();
      document.fonts.add(ff);
      _registered.add(id);
    } catch (e) { console.warn('[fonts] register failed', id, e && e.message || e); }
  }

  async function loadAll() {
    for (const f of loadMeta()) {
      try { const blob = await idbGet(f.id); if (blob) await register(f.id, blob); } catch (_) {}
    }
    // Re-apply appearance so any mode already set to a custom font swaps from
    // its fallback to the real face now that it's registered.
    try { window.appearance && window.appearance.refresh && window.appearance.refresh(); } catch (_) {}
  }

  // Import a picked File (TTF/OTF/WOFF). Stores it, registers the FontFace,
  // records metadata, and returns {id, name, family}.
  async function importFile(file) {
    if (!file) throw new Error('No file');
    const id = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    let name = (file.name || 'Font').replace(/\.(ttf|otf|ttc|woff2?)$/i, '').trim().slice(0, 60);
    if (!name) name = 'Font';
    await idbPut(id, file);                 // a File is a Blob
    await register(id, file);
    const meta = loadMeta();
    meta.push({ id, name, family: familyFor(id) });
    saveMeta(meta);
    return { id, name, family: familyFor(id) };
  }

  async function remove(id) {
    try { await idbDel(id); } catch (_) {}
    saveMeta(loadMeta().filter(f => f.id !== id));
    // The already-added FontFace can't be cleanly un-added cross-browser; it
    // simply stops being referenced and is gone after the next reload.
  }

  window.fonts = {
    list: loadMeta,
    familyFor,
    importFile,
    remove,
    loadAll,
    isRegistered: (id) => _registered.has(id)
  };

  if (document.readyState !== 'loading') loadAll();
  else document.addEventListener('DOMContentLoaded', loadAll);
})();
