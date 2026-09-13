// word-freq.js — the imported Yomitan FREQUENCY list (blobStore FREQ_V1,
// written by the dictionary importer for term_meta_bank zips such as JPDB
// v2.2). Loaded lazily into a Map when the library's difficulty profile
// needs it, released afterwards. rank(term) → number (1 = most common) or
// null when the word is not in the list.
(function () {
  'use strict';
  let map = null, loading = null;
  function info() {
    try { const raw = localStorage.getItem('FREQ_NAME_V1'); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  async function load() {
    if (map) return map;
    if (loading) return loading;
    loading = (async () => {
      try {
        const raw = await window.blobStore?.get('FREQ_V1');
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || !o.ranks) return null;
        map = new Map(Object.entries(o.ranks));
        return map;
      } catch (_) { return null; }
      finally { loading = null; }
    })();
    return loading;
  }
  function rank(term) { return map ? (map.get(term) ?? null) : null; }
  function release() { map = null; }
  async function remove() {
    release();
    try { await window.blobStore?.remove('FREQ_V1'); } catch (_) {}
    try { localStorage.removeItem('FREQ_NAME_V1'); } catch (_) {}
  }
  window.wordFreq = { info, load, rank, release, remove, available: () => !!info() };
})();
