// blob-store.js — IndexedDB key→string store for LARGE persisted blobs
// (cover images, cue-alignment caches), plus a one-time sweep that moves
// those blobs OUT of Capacitor Preferences.
//
// WHY (battery audit 2026-06-10, top remaining finding): Capacitor
// Preferences is one SharedPreferences XML on Android / one UserDefaults
// plist domain on iOS — EVERY Preferences.set() rewrites the WHOLE file.
// With multi-MB blobs living there (TITLE_COVERS_V1 base64 covers,
// CUE_ALIGN_v*_<titleId> alignment caches), each tiny position save —
// every 1-5 s for an entire listening session — was a multi-MB flash
// rewrite. IndexedDB stores records individually, so big blobs stop
// taxing every small write. Same store family the app already trusts for
// fonts (font-store-v1) and dictionaries.
//
// API (all Promise-based; values are strings):
//   blobStore.get(key)    → string | null
//   blobStore.set(key, v) → resolves when committed (waits for the sweep)
//   blobStore.remove(key)
//
// DURABILITY (adversarial review 2026-06-10, all addressed here):
//   • navigator.storage.persist() requested once at boot — asks the
//     WebView's quota manager not to evict this origin's IndexedDB.
//   • db() never caches a failed open; a dead connection (WKWebView's
//     "connection to Indexed Database server lost" class) is retried once
//     on a fresh open per operation.
//   • Consumer set()/remove() WAIT for the sweep to finish, so a live
//     write can never interleave with the migration (no TOCTOU). The
//     sweep runs immediately at parse time — consumers (title-store,
//     cue-alignment) only write well after boot, and the wait is
//     milliseconds except on the one boot that actually migrates.
//   • COVERS are user data and are MERGED, never assumed: if both a
//     Preferences copy and an IndexedDB copy exist and differ, the maps
//     are merged per-title with the Preferences entry winning a conflict
//     — the only realistic both-exist-and-differ state is "IndexedDB was
//     broken last session and the consumer's fallback wrote fresher data
//     to Preferences" (post-sweep the Preferences key doesn't otherwise
//     exist). Only after a read-back-verified IndexedDB write is the
//     Preferences copy deleted; on verify failure the bad IndexedDB copy
//     is removed so it can't shadow the good Preferences one.
//   • Alignment caches are REGENERABLE (recomputed in seconds), so an
//     existing IndexedDB copy simply wins and stale-schema keys
//     (CUE_ALIGN_v1_*) are deleted outright, not migrated.
(function () {
  'use strict';
  const DB_NAME = 'kadoki-blob-store-v1';
  const STORE = 'kv';

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
    // A transient open failure must not poison the whole session — the next
    // operation retries the open.
    _dbp.catch(() => { _dbp = null; });
    return _dbp;
  }
  function idbDo(mode, fn, _retried) {
    return db().then(d => new Promise((res, rej) => {
      let tx;
      try { tx = d.transaction(STORE, mode); } catch (e) { rej(e); return; }
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    })).catch(e => {
      // Dead cached connection → drop it and retry ONCE on a fresh open.
      const name = e && e.name;
      if (!_retried && (name === 'InvalidStateError' || name === 'UnknownError' || name === 'TransactionInactiveError')) {
        _dbp = null;
        return idbDo(mode, fn, true);
      }
      throw e;
    });
  }
  const _get = (k) => idbDo('readonly', s => s.get(k)).then(v => (v === undefined || v === null) ? null : String(v));
  const _set = (k, v) => idbDo('readwrite', s => s.put(String(v), k));
  const _remove = (k) => idbDo('readwrite', s => s.delete(k));

  let _sweepResolve;
  const _sweepDone = new Promise(r => { _sweepResolve = r; });

  window.blobStore = {
    get: _get,   // reads are live: pre-sweep misses fall back to Preferences in the consumers
    set: async (k, v) => { await _sweepDone; return _set(k, v); },
    remove: async (k) => { await _sweepDone; return _remove(k); },
  };

  const COVERS_KEY = 'TITLE_COVERS_V1';
  const ALIGN_ANY = /^CUE_ALIGN_v\d+_/;
  // Keep in sync with cue-alignment.js SCHEMA_VERSION.
  const ALIGN_CURRENT = /^CUE_ALIGN_v2_/;

  // Merge two covers JSON maps ({titleId: dataUri}). Per-title conflicts go
  // to the PREFERENCES side (see header). Unparseable sides degrade to {}.
  function mergeCovers(idbJson, prefJson) {
    let a = {}, b = {};
    try { a = JSON.parse(idbJson) || {}; } catch (_) {}
    try { b = JSON.parse(prefJson) || {}; } catch (_) {}
    return JSON.stringify(Object.assign(a, b));
  }

  async function sweep() {
    const P = window.Capacitor?.Plugins?.Preferences;
    if (!P || typeof P.keys !== 'function') return;
    let keys = [];
    try { keys = (await P.keys()).keys || []; } catch (_) { return; }
    let migrated = 0, dropped = 0;
    for (const k of keys) {
      const isCovers = k === COVERS_KEY;
      if (!isCovers && !ALIGN_ANY.test(k)) continue;
      try {
        if (isCovers) {
          const prefVal = (await P.get({ key: k })).value;
          if (!prefVal) { await P.remove({ key: k }); continue; }
          const idbVal = await _get(k);
          const target = (idbVal && idbVal !== prefVal) ? mergeCovers(idbVal, prefVal) : prefVal;
          if (idbVal !== target) {
            await _set(k, target);
            const back = await _get(k);
            if (back !== target) {
              // Verify failed: make sure a corrupt partial write can't shadow
              // the (kept) Preferences copy, then retry next boot.
              try { if (back !== idbVal) await _remove(k); } catch (_) {}
              continue;
            }
            migrated++;
          }
          await P.remove({ key: k });
        } else if (ALIGN_CURRENT.test(k)) {
          const existing = await _get(k);
          if (existing === null) {
            const r = await P.get({ key: k });
            if (r && r.value) {
              await _set(k, r.value);
              const back = await _get(k);
              if (back !== r.value) {
                try { await _remove(k); } catch (_) {}
                continue;
              }
              migrated++;
            }
          }
          await P.remove({ key: k });
        } else {
          // Old-schema alignment cache: already invalidated by the version
          // bump, regenerated on demand — just stop it taxing every write.
          await P.remove({ key: k });
          dropped++;
        }
      } catch (_) { /* leave it; retried on next boot */ }
    }
    if (migrated || dropped) {
      try { console.log('[blobStore] migrated ' + migrated + ' blob(s) out of Preferences, dropped ' + dropped + ' stale cache(s)'); } catch (_) {}
    }
  }

  (async () => {
    // Ask the WebView not to evict this origin's storage (auto-granted in
    // app WebViews; harmless no-op elsewhere). The dictionary + font stores
    // benefit too.
    try { await navigator.storage?.persist?.(); } catch (_) {}
    try { await sweep(); } catch (_) {}
    _sweepResolve();
  })();
})();
