// ai-places.js — real-world place-name DB, chapter-grained (places companion
// to ai-characters.js). Storage owner for AIPLACE_V1_<titleId>.
//
// Extraction lives in ai-processor.js (per finished chapter, confidence-gated
// to places the model is SURE are real-world). This module owns the merged-
// current roster the squiggle layer (ai-places-ui.js / ai-places-read.js)
// reads via matcher(). No presence/relationships/spoiler-hold — a real place
// name carries none of the spoiler risk a character reveal does, so it merges
// immediately (never staged behind the reader's position like characters).
// Keyed by exact surface string (not a real-world identity merge): the same
// real place written two different ways in the book becomes two records,
// which is fine — each independently marks + geocodes.
(function () {
  'use strict';

  const KEY_PREFIX = 'AIPLACE_V1_';

  let curTitleId = null;
  let store = null;
  let loading = null;
  let rev = 0;

  function storeKey(id) { return KEY_PREFIX + id; }
  function freshStore() { return { v: 1, places: {} }; }
  function normalizeStore(p) {
    if (!p || p.v !== 1 || typeof p !== 'object') return freshStore();
    if (!p.places || typeof p.places !== 'object') p.places = {};
    return p;
  }
  async function loadRaw(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(storeKey(titleId)) : null;
      if (raw) return normalizeStore(JSON.parse(raw));
    } catch (_) {}
    return freshStore();
  }
  async function ensureLoaded(titleId) {
    if (curTitleId === titleId && (store || loading)) { if (loading) await loading; return; }
    curTitleId = titleId; store = null;
    loading = (async () => {
      let p = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(storeKey(titleId)) : null;
        if (raw) p = JSON.parse(raw);
      } catch (_) {}
      if (curTitleId !== titleId) return;      // title switched while loading
      store = normalizeStore(p);
      rev++; loading = null;
      try { window.dispatchEvent(new CustomEvent('kai:ai-place-data', { detail: { titleId, kind: 'load' } })); } catch (_) {}
    })();
    await loading;
  }
  function save() {
    if (!store || !curTitleId || !window.blobStore) return;
    rev++;
    try { window.blobStore.set(storeKey(curTitleId), JSON.stringify(store)).catch(() => {}); } catch (_) {}
  }

  // ---- merge (called by ai-processor.js) --------------------------------
  // placesList: [{surface, reading}], surface VERBATIM from the text (prompt
  // enforces this — same rule as character surface). First-seen reading wins
  // (a later chapter re-mentioning the place without a clear reading must not
  // blank out an earlier well-attested one).
  async function applyChapterOutput(titleId, chunkIdx, placesList) {
    try {
      if (!titleId || !Number.isFinite(chunkIdx) || !Array.isArray(placesList) || !placesList.length) return true;
      let s = null, persist = null;
      if (titleId === curTitleId || titleId === window._activeTitleId) {
        await ensureLoaded(titleId);
        if (curTitleId === titleId && store) { s = store; persist = save; }
      }
      if (!s) {
        s = await loadRaw(titleId);
        persist = () => {
          try { window.blobStore.set(storeKey(titleId), JSON.stringify(s)).catch(() => {}); } catch (_) {}
        };
      }
      let changed = false;
      for (const p of placesList) {
        const surface = String((p && p.surface) || '').trim();
        if (!surface || surface.length < 2) continue;
        const reading = String((p && p.reading) || '').trim();
        const rec = s.places[surface];
        if (!rec) {
          s.places[surface] = { surface, reading, firstChunkIdx: chunkIdx, lastChunkIdx: chunkIdx };
          changed = true;
        } else {
          if (chunkIdx > rec.lastChunkIdx) { rec.lastChunkIdx = chunkIdx; changed = true; }
          if (!rec.reading && reading) { rec.reading = reading; changed = true; }
        }
      }
      if (changed) persist();
      return true;
    } catch (_) { return false; }
  }

  // ---- read API (squiggle UI modules) ------------------------------------
  // alias(=surface) → record map, cached per store revision. Lazily kicks the
  // store load for the active title (the 1.5s UI poll retries) — same shape
  // as aiCharacters.matcher().
  let _matchCache = null;
  function matcher() {
    const tid = window._activeTitleId;
    if (!tid) return null;
    if (curTitleId !== tid || (!store && !loading)) {
      try { ensureLoaded(tid); } catch (_) {}
    }
    if (curTitleId !== tid || !store) return null;
    const bucket = 'r' + rev;
    if (_matchCache && _matchCache.bucket === bucket) return _matchCache;
    const map = new Map();
    for (const rec of Object.values(store.places)) {
      if (rec.hideMark) continue;
      if (!rec.surface || rec.surface.length < 2) continue;
      if (!map.has(rec.surface)) map.set(rec.surface, rec);
    }
    _matchCache = { bucket, map };
    return _matchCache;
  }

  // Per-place mark suppression (user toggle from the popup), mirrors
  // aiCharacters.setHideSquiggle. `hideMark` is a local UI field never
  // touched by the AI merge.
  async function setHideMark(surface, hide) {
    try {
      const tid = window._activeTitleId; if (!tid || !surface) return;
      await ensureLoaded(tid);
      if (curTitleId !== tid || !store) return;
      const rec = store.places[surface]; if (!rec) return;
      const v = !!hide; if (rec.hideMark === v) return;
      rec.hideMark = v;
      _matchCache = null;
      save();
      try { window.dispatchEvent(new CustomEvent('kai:ai-place-data', { detail: { titleId: tid, kind: 'mark' } })); } catch (_) {}
    } catch (_) {}
  }

  // Wipe a title's place DB (in-memory + blobStore) — used by
  // aiProcessor.reDetectChapters/resetTitle, mirrors aiCharacters.reset.
  async function reset(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return;
      if (curTitleId === id) { store = freshStore(); rev++; }
      try {
        if (window.blobStore && window.blobStore.remove) await window.blobStore.remove(storeKey(id));
        else if (window.blobStore) await window.blobStore.set(storeKey(id), JSON.stringify(freshStore()));
      } catch (_) {}
    } catch (_) {}
  }

  window.aiPlaces = {
    matcher,
    applyChapterOutput,
    setHideMark,
    reset,
    storeRev() { return rev; },
    async getStore(titleId) {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      const s = (id === curTitleId && store) ? store : await loadRaw(id);
      return s ? JSON.parse(JSON.stringify(s)) : null;
    },
  };
})();
