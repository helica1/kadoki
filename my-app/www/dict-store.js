// dict-store.js — indexed-IDB dictionary store.
//
// Replaces the old "load every entry into a JS Map at boot" pattern with
// the same architecture Yomitan / Jidoujisho use: keep entries
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

  // Distinct dictName values that actually have ENTRIES records, with counts.
  // Used to surface ORPHANS: entries whose DICTS meta row was lost (e.g. an
  // interrupted delete) — lookups still serve them but the manager (which lists
  // only DICTS meta) otherwise can't show or delete them. Walks the by_dict
  // index one distinct key at a time (nextunique), then counts each.
  async function listEntryDicts() {
    let db;
    try { db = await openDb(); } catch (e) { return []; }
    const names = await new Promise((resolve) => {
      const out = [];
      try {
        const tx = db.transaction(ENTRIES, 'readonly');
        const req = tx.objectStore(ENTRIES).index('by_dict').openKeyCursor(null, 'nextunique');
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push(c.key); c.continue(); }
          else { resolve(out); }
        };
        req.onerror = () => resolve(out);
      } catch (e) { resolve(out); }
    });
    const result = [];
    for (const name of names) {
      const count = await new Promise((resolve) => {
        try {
          const tx = db.transaction(ENTRIES, 'readonly');
          const req = tx.objectStore(ENTRIES).index('by_dict').count(IDBKeyRange.only(name));
          req.onsuccess = () => resolve(req.result || 0);
          req.onerror = () => resolve(0);
        } catch (e) { resolve(0); }
      });
      result.push({ dictName: name, entryCount: count });
    }
    return result;
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

  async function removeInner(db, dictName, onProgress) {
    const report = (deleted, total, done) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress({ deleted, total, pct: total ? Math.min(1, deleted / total) : 1, done: !!done }); } catch (e) {}
    };
    // Count first so the caller can render a real progress bar (a large dict is
    // 100k+ records and the delete is genuinely O(n) IDB ops).
    let total = 0;
    try {
      total = await new Promise((resolve) => {
        try {
          const tx = db.transaction(ENTRIES, 'readonly');
          const req = tx.objectStore(ENTRIES).index('by_dict').count(IDBKeyRange.only(dictName));
          req.onsuccess = () => resolve(req.result || 0);
          req.onerror   = () => resolve(0);
        } catch (e) { resolve(0); }
      });
    } catch (e) {}
    report(0, total, false);
    // Delete in bounded batches so a large dict never holds ONE giant transaction
    // — that locks the store for minutes and, if the OS kills the app mid-delete,
    // leaves a half-deleted dict. Each batch is its own tx; the DICTS meta row is
    // deleted LAST so an interrupted delete is resumable.
    let deleted = 0;
    for (;;) {
      const n = await new Promise((resolve) => {
        let count = 0;
        try {
          const tx = db.transaction(ENTRIES, 'readwrite');
          const store = tx.objectStore(ENTRIES);
          const req = store.index('by_dict').openKeyCursor(IDBKeyRange.only(dictName));
          req.onsuccess = (e) => {
            const c = e.target.result;
            if (c && count < 5000) { store.delete(c.primaryKey); count++; c.continue(); }
            // else: stop advancing — this batch's tx commits
          };
          tx.oncomplete = () => resolve(count);
          tx.onerror    = () => resolve(-1);
          tx.onabort    = () => resolve(-1);
        } catch (e) { resolve(-1); }
      });
      if (n <= 0) break;                        // 0 = nothing left, -1 = error/abort
      deleted += n;
      report(deleted, total, false);
      await new Promise(r => setTimeout(r, 0));  // yield so deletes never block lookups
    }
    // Remove the meta row LAST (list/isPopulated report 'gone' only when done).
    const ok = await new Promise((resolve) => {
      try {
        const tx = db.transaction(DICTS, 'readwrite');
        tx.objectStore(DICTS).delete(dictName);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
        tx.onabort    = () => resolve(false);
      } catch (e) { resolve(false); }
    });
    report(total, total, true);
    return ok;
  }

  async function remove(dictName, onProgress) {
    const db = await openDb();
    return removeInner(db, dictName, onProgress);
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

  // --------- bulk existence oracle (deinflector) ---------
  //
  // The deinflector generates many candidate base forms per tap and needs to
  // know which ones actually exist in a dictionary. Instead of a whole-store
  // term Set built by a multi-second boot cursor scan (the old buildTermSet),
  // we answer existence on demand: ONE readonly transaction, one indexed
  // `count` per candidate term. No boot cost, no resident Set, and per-tap
  // cost scales with the candidate count, NOT the corpus size — so startup is
  // instant at any dictionary size. This is the Yomitan model (existence == an
  // index query). Kana readings resolve directly because the importer stores
  // each entry under both its expression AND its reading as `term` records.
  async function existsBulk(terms) {
    const out = new Set();
    const uniq = Array.from(new Set(terms || [])).filter(t => t != null && t !== '');
    if (!uniq.length) return out;
    let db;
    try { db = await openDb(); } catch (e) { return out; }
    return new Promise((resolve) => {
      // This is awaited on the lookup hot path with no timeout, so it MUST
      // always resolve — a non-resolve would reintroduce the "Initializing
      // Dictionaries… forever" hang. finish() is idempotent; we resolve on the
      // last request, on tx abort/error, OR via a watchdog as a last resort.
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(wd); resolve(out); };
      const wd = setTimeout(finish, 4000);
      try {
        const tx = db.transaction(ENTRIES, 'readonly');
        const idx = tx.objectStore(ENTRIES).index('by_term');
        let pending = uniq.length;
        const tick = () => { if (--pending === 0) finish(); };
        for (const t of uniq) {
          const req = idx.count(IDBKeyRange.only(t));
          req.onsuccess = () => { if (req.result > 0) out.add(t); tick(); };
          req.onerror = () => { tick(); };
        }
        tx.onabort = finish;
        tx.onerror = finish;
      } catch (e) { finish(); }
    });
  }

  // Wrap import/remove to invalidate the set automatically.
  const _origImportFromMap = importFromMap;
  async function importFromMapWrapped(...args) {
    const r = await _origImportFromMap(...args);
    return r;
  }
  const _origRemove = remove;
  async function removeWrapped(name, onProgress) {
    const r = await _origRemove(name, onProgress);
    return r;
  }

  window.dictStore = {
    isPopulated,
    list,
    listEntryDicts,
    lookup,
    importFromMap: importFromMapWrapped,
    importFromCache,
    remove: removeWrapped,
    // Deinflector existence oracle (bulk, on-demand — replaces the term Set).
    existsBulk
  };
})();
