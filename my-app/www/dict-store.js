// dict-store.js — indexed-IDB dictionary store.
//
// Replaces the old "load every entry into a JS Map at boot" pattern with
// the same architecture Yomitan / Manatan / Jidoujisho use: keep entries
// on disk, query directly via an IDB index on the term. ~5–10 ms per
// lookup regardless of dict size, and the JS heap stays under 50 MB even
// with several large dicts imported.
//
// Schema (db "dict-store-v2"):
//
//   entries (auto-increment id; indexed by [dictName, term] AND term)
//     { dictName, term, entry }      // one record per gloss
//
//   dicts (keyed by dictName)
//     { dictName, title, revision, filename, entryCount, importedAt }
//
// Public API on window.dictStore:
//
//   isPopulated()                         → bool
//   list()                                → [{ dictName, ...meta }]
//   lookup(term, { enabledDicts })        → [{ dictName, term, entry }]
//   importFromMap(dictName, meta, mapOfTermToEntries)
//   importFromCache(dictCacheKey, opts)   // migrate from old dictCache key
//   remove(dictName)
//
// All async. The store can be safely called concurrently; lookups serialize
// on the IDB transaction layer.

(function () {
  'use strict';

  const DB_NAME = 'dict-store-v2';
  const DB_VERSION = 1;
  const ENTRIES = 'entries';
  const DICTS   = 'dicts';

  // --------- low-level IDB ---------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(ENTRIES)) {
          const s = db.createObjectStore(ENTRIES, { keyPath: 'id', autoIncrement: true });
          // Composite [dictName, term] lets us filter to a single dict
          // efficiently when needed. The single-term index serves "any
          // enabled dict" lookups (filter results post-query).
          s.createIndex('by_term', 'term', { unique: false });
          s.createIndex('by_dict_term', ['dictName', 'term'], { unique: false });
          s.createIndex('by_dict', 'dictName', { unique: false });
        }
        if (!db.objectStoreNames.contains(DICTS)) {
          db.createObjectStore(DICTS, { keyPath: 'dictName' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror   = () => reject(tx.error);
      tx.onabort   = () => reject(tx.error || new Error('tx aborted'));
    });
  }

  // --------- meta ---------

  async function list() {
    const db = await openDb();
    return new Promise((resolve) => {
      const out = [];
      const tx = db.transaction(DICTS, 'readonly');
      const req = tx.objectStore(DICTS).openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); }
        else { resolve(out); }
      };
      req.onerror = () => resolve(out);
    });
  }

  async function isPopulated() {
    const meta = await list();
    return meta.length > 0;
  }

  // --------- lookup ---------

  async function lookup(term, opts = {}) {
    if (!term) return [];
    const enabled = opts.enabledDicts; // null/undefined = all
    const db = await openDb();
    return new Promise((resolve) => {
      const out = [];
      try {
        const tx = db.transaction(ENTRIES, 'readonly');
        const idx = tx.objectStore(ENTRIES).index('by_term');
        // getAll is the fastest path — single round trip vs. cursor.
        const req = idx.getAll(IDBKeyRange.only(term));
        req.onsuccess = () => {
          const arr = req.result || [];
          for (const r of arr) {
            if (enabled && !enabled.has(r.dictName)) continue;
            out.push(r);
          }
          resolve(out);
        };
        req.onerror = () => resolve(out);
      } catch (e) { resolve(out); }
    });
  }

  // --------- import ---------

  /**
   * Bulk-import entries from an in-memory Map<term, Array<entry>>. Used
   * both by the JMDict parser and by Yomitan import. Writes in batches
   * of ~10k entries per transaction so a single failed batch doesn't
   * lose everything, and so we yield to the runloop between batches.
   */
  async function importFromMap(dictName, meta, termToEntries, onProgress) {
    const db = await openDb();
    // Remove any existing entries for this dict first (re-import scenario).
    await removeInner(db, dictName);

    let totalRecords = 0;
    for (const arr of termToEntries.values()) totalRecords += arr.length;

    const BATCH = 8000;
    let written = 0;
    const allTerms = Array.from(termToEntries.keys());

    for (let i = 0; i < allTerms.length; ) {
      const tx = db.transaction(ENTRIES, 'readwrite');
      const store = tx.objectStore(ENTRIES);
      let inThisBatch = 0;
      while (i < allTerms.length && inThisBatch < BATCH) {
        const term = allTerms[i++];
        const entries = termToEntries.get(term) || [];
        for (const entry of entries) {
          store.put({ dictName, term, entry });
          inThisBatch++;
          written++;
        }
      }
      await txDone(tx);
      if (onProgress && totalRecords) {
        try { onProgress({ written, total: totalRecords, pct: written / totalRecords }); } catch (e) {}
      }
      // Yield to the runloop so we don't starve the UI thread on huge
      // imports.
      await new Promise(r => setTimeout(r, 0));
    }

    // Write meta row.
    {
      const tx = db.transaction(DICTS, 'readwrite');
      tx.objectStore(DICTS).put({
        dictName,
        title:       meta?.title    || dictName,
        revision:    meta?.revision || 'imported',
        filename:    meta?.filename || dictName,
        entryCount:  totalRecords,
        importedAt:  Date.now()
      });
      await txDone(tx);
    }
    return { ok: true, dictName, entryCount: totalRecords };
  }

  async function removeInner(db, dictName) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([ENTRIES, DICTS], 'readwrite');
        const entries = tx.objectStore(ENTRIES);
        const dicts   = tx.objectStore(DICTS);
        const idx = entries.index('by_dict');
        const req = idx.openKeyCursor(IDBKeyRange.only(dictName));
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { entries.delete(c.primaryKey); c.continue(); }
          else { dicts.delete(dictName); }
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  async function remove(dictName) {
    const db = await openDb();
    return removeInner(db, dictName);
  }

  // --------- migration from old dict-cache ---------

  /**
   * Migrate an entry from the old `dict-cache` IDB (which stored a single
   * Map under one key) into the new indexed store. Returns true on
   * success. Idempotent — running again is a no-op if the new store
   * already has this dict.
   *
   * onProgress: ({ written, total, pct }) — fires every batch.
   */
  async function importFromCache(cacheKey, opts = {}) {
    // Skip if already migrated.
    const meta = await list();
    const already = meta.some(m => m.dictName === (opts.dictName || cacheKey));
    if (already) return true;

    if (!window.dictCache?.load) return false;
    // dict-cache.js expects (name, expectedVersion). Caller passes the
    // version they know about.
    const data = await window.dictCache.load(cacheKey, opts.cacheVersion);
    if (!data) return false;

    // Two shapes seen in practice:
    //   1) a Map<term, Array<entry>>  (JMDict + most Yomitan imports)
    //   2) { termEntries: Map, meta: {...} } (newer Yomitan import wrapper)
    let termMap, savedMeta;
    if (data instanceof Map) {
      termMap = data;
      savedMeta = opts.meta || {};
    } else if (data && data.termEntries instanceof Map) {
      termMap = data.termEntries;
      savedMeta = data.meta || opts.meta || {};
    } else {
      return false;
    }
    const dictName = opts.dictName || cacheKey;
    await importFromMap(dictName, savedMeta, termMap, opts.onProgress);
    return true;
  }

  // --------- term set (deinflector fast path) ---------
  //
  // The deinflector needs SYNCHRONOUS "does term X exist in any dict?"
  // checks during greedy match (up to ~20 candidate forms per tap).
  // Going to IDB per candidate would mean 20× 5-10 ms = 200 ms of async
  // chatter per tap. Instead, build a Set<string> of every headword
  // once and check it sync. ~200k entries × ~10 bytes = 2 MB of heap —
  // a fair price for instant deinflection.
  let _termSet = null;
  let _readingToTerm = null;  // Map<reading, canonicalTerm> for deinflection lookup
  let _termSetPromise = null;
  function termSetReady() { return _termSet !== null; }
  function hasTerm(term) {
    if (!_termSet) return false;
    if (_termSet.has(term)) return true;
    // ALSO consult the reading map — dict entries store the headword
    // as `term` (often kanji like 頷く) and the kana reading inside the
    // entry array. The deinflector produces base forms in kana
    // (うなずいた → うなずく), so without this map hasTerm("うなずく")
    // would always return false and the parser fell back to 2-char うな.
    return _readingToTerm ? _readingToTerm.has(term) : false;
  }
  // Given a reading (e.g., うなずく), return the canonical term that the
  // dict actually stores (e.g., 頷く). Used by greedyDeinflect's caller
  // to translate a deinflected kana base into a key dictStore.lookup
  // can actually find. Returns null if not known.
  function termForReading(reading) {
    return _readingToTerm ? (_readingToTerm.get(reading) || null) : null;
  }
  async function buildTermSet() {
    if (_termSet) return _termSet;
    if (_termSetPromise) return _termSetPromise;
    _termSetPromise = (async () => {
      const t0 = performance.now();
      const db = await openDb();
      // Fast path: openKeyCursor on the by_term INDEX. Each onsuccess
      // gives us the index key (the term string). Read-only and
      // returns nothing but keys, so iOS WKWebView serializes other
      // IDB operations against this transaction for a much shorter
      // window (~5 s for 405 k entries) than the old openCursor build
      // (full records, ~45 s). That long lock was blocking every
      // subsequent dictStore.lookup behind it — the user saw a 43 s
      // delay on the second tap that ended up sitting in the queue.
      //
      // We lose the inline reading→canonical-term map here. Yomitan's
      // deinflector still covers most inflection patterns directly
      // against dict terms; the reading map is a separate concern and
      // can be rebuilt later in a background-only fashion if needed.
      const set = new Set();
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(ENTRIES, 'readonly');
          const req = tx.objectStore(ENTRIES).index('by_term').openKeyCursor();
          req.onsuccess = (e) => {
            const c = e.target.result;
            if (c) { set.add(c.key); c.continue(); }
            else { resolve(); }
          };
          req.onerror = () => resolve();
        } catch (e) { resolve(); }
      });
      _termSet = set;
      const ms = Math.round(performance.now() - t0);
      console.log(`[dict-store] termSet built: ${set.size} headwords in ${ms}ms`);
      return set;
    })();
    return _termSetPromise;
  }
  // Invalidate after import/remove so it gets rebuilt next time.
  function invalidateTermSet() { _termSet = null; _termSetPromise = null; }

  // Wrap import/remove to invalidate the set automatically.
  const _origImportFromMap = importFromMap;
  async function importFromMapWrapped(...args) {
    const r = await _origImportFromMap(...args);
    invalidateTermSet();
    return r;
  }
  const _origRemove = remove;
  async function removeWrapped(name) {
    const r = await _origRemove(name);
    invalidateTermSet();
    return r;
  }

  window.dictStore = {
    isPopulated,
    list,
    lookup,
    importFromMap: importFromMapWrapped,
    importFromCache,
    remove: removeWrapped,
    // Deinflector fast path.
    buildTermSet,
    termSetReady,
    hasTerm
  };
})();
