// Tiny IndexedDB wrapper for caching parsed dictionary indices.
//
// JMDict is a 108 MB JSON file; the original load path fetches + parses +
// rebuilds a 125k-entry kanji/kana → entries Map every launch. We persist the
// final Map via structured clone (IDB handles Map natively) so subsequent
// launches are near-instant.
//
// Cache key includes a version string; bump DICT_VERSIONS to invalidate.

(function () {
  const DB_NAME = 'dict-cache';
  const DB_VERSION = 1;
  const STORE = 'dicts';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
    });
  }

  async function idbGet(key) {
    let db;
    try { db = await openDb(); } catch (e) { console.warn('[dict-cache] open failed', e); return null; }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result == null ? null : req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  async function idbPut(key, value) {
    let db;
    try { db = await openDb(); } catch (e) { console.warn('[dict-cache] open failed', e); return false; }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        tx.oncomplete = () => { /* ok */ };
      } catch (e) { resolve(false); }
    });
  }

  async function idbDelete(key) {
    let db;
    try { db = await openDb(); } catch (e) { return false; }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  /**
   * Try to load a cached parsed dictionary index from IDB.
   * Returns { version, data } if found AND version matches, else null.
   */
  async function loadCachedDict(name, expectedVersion) {
    const rec = await idbGet(name);
    if (!rec || !rec.version || rec.version !== expectedVersion) return null;
    if (!rec.data) return null;
    console.log(`[dict-cache] hit "${name}" v${expectedVersion}`);
    return rec.data;
  }

  /**
   * Save the parsed dictionary index to IDB. `data` can be a Map (preferred,
   * stored via structured clone) or any structured-cloneable value.
   */
  async function saveCachedDict(name, version, data) {
    const ok = await idbPut(name, { version, data, savedAt: Date.now() });
    console.log(`[dict-cache] save "${name}" v${version}: ${ok ? 'ok' : 'fail'}`);
    return ok;
  }

  async function clearCachedDict(name) {
    return idbDelete(name);
  }

  window.dictCache = {
    load: loadCachedDict,
    save: saveCachedDict,
    clear: clearCachedDict
  };
})();
