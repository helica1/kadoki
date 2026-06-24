// mode-coverage.js — persistent per-title record of WHICH PARTS of a book
// were consumed in WHICH MODE (read / card / audio). Re-reading a range in a
// different mode OVERWRITES it (insert = clip/split other-mode overlaps,
// merge adjacent same-mode). Two native spaces are kept side by side:
// read progress in jp chars, audio/card progress in cue indices — conversion
// to one display axis happens at render time (ai-timeline.js).
//
// PURE OBSERVER (never-lose-place invariant): reads positions only, never
// touches position/restore state, writes only MODECOV_V1_* blobStore keys.
// Every entry point is try/caught — a failure here must never break the app.
(function () {
  'use strict';

  const KEY_PREFIX = 'MODECOV_V1_';
  const POLL_MS = 5000;
  const WRITE_MIN_MS = 20000;     // persist throttle per title
  const MAX_IVS = 1200;           // per space; smallest-gap merge beyond this
  const MAX_JP_DELTA = 3000;      // plausible forward movement per 5s tick
  const MAX_CUE_DELTA = 40;
  const MAX_CACHE = 4;            // in-memory stores (active title never evicted)
  const SEED_MIN_JP = 200;        // seeding: min chars per credited pair
  const SEED_MIN_CUE = 5;         // seeding fallback when cue text is unknown

  const M_READ = 0, M_CARD = 1, M_AUDIO = 2;

  // titleId → { store, dirty, lastWrite, lastUse }
  const cache = new Map();
  const loads = new Map();

  // ---- interval list (sorted, non-overlapping; entries [a, b, m]) ----------
  // INSERT = OVERWRITE: same-mode neighbors (touching included) are absorbed
  // into [a,b]; different-mode overlaps are clipped, an enclosing one splits.
  // Only the first window entry can spill left of `a` and only the last can
  // spill right of `b` (sorted + disjoint), so one left/right piece suffices.
  function insertIv(arr, a, b, m) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
    let i = 0;
    while (i < arr.length && arr[i][1] < a) i++;
    let j = i;
    let left = null, right = null;
    while (j < arr.length && arr[j][0] <= b) {
      const iv = arr[j];
      if (iv[2] === m) {
        if (iv[0] < a) a = iv[0];
        if (iv[1] > b) b = iv[1];
      } else {
        if (iv[0] < a) left = [iv[0], a, iv[2]];
        if (iv[1] > b) right = [b, iv[1], iv[2]];
      }
      j++;
    }
    if (left && right) arr.splice(i, j - i, left, [a, b, m], right);
    else if (left) arr.splice(i, j - i, left, [a, b, m]);
    else if (right) arr.splice(i, j - i, [a, b, m], right);
    else arr.splice(i, j - i, [a, b, m]);
    if (arr.length > MAX_IVS) capMerge(arr);
  }

  // Cap: merge the pair separated by the smallest gap, absorbing the gap; the
  // combined interval takes the longer member's mode (display loss only).
  function capMerge(arr) {
    while (arr.length > MAX_IVS) {
      let bi = 1, bg = Infinity;
      for (let k = 1; k < arr.length; k++) {
        const g = arr[k][0] - arr[k - 1][1];
        if (g < bg) { bg = g; bi = k; }
      }
      const A = arr[bi - 1], B = arr[bi];
      A[2] = (A[1] - A[0]) >= (B[1] - B[0]) ? A[2] : B[2];
      A[1] = B[1];
      arr.splice(bi, 1);
      // re-establish the "adjacent same-mode are merged" invariant locally
      if (bi < arr.length && arr[bi][2] === A[2] && arr[bi][0] <= A[1]) {
        A[1] = Math.max(A[1], arr[bi][1]);
        arr.splice(bi, 1);
      }
      if (bi - 2 >= 0 && arr[bi - 2][2] === A[2] && arr[bi - 2][1] >= A[0]) {
        arr[bi - 2][1] = Math.max(arr[bi - 2][1], A[1]);
        arr.splice(bi - 1, 1);
      }
    }
  }

  // Re-visit detection: the sub-intervals of [a,b] that intersect ALREADY-covered
  // territory in `arr`. Used to record a second "you went back over this" track.
  // Strict (e > s) so continuous forward reading — which only TOUCHES the prior
  // interval's right edge — yields nothing; only backward-then-forward over
  // covered text counts. `arr` is sorted + non-overlapping (invariant of insertIv).
  function overlapPieces(arr, a, b) {
    const out = [];
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return out;
    for (const iv of arr) {
      if (iv[1] <= a) continue;       // entirely left of [a,b]
      if (iv[0] >= b) break;          // entirely right (sorted → done)
      const s = Math.max(a, iv[0]);
      const e = Math.min(b, iv[1]);
      if (e > s) out.push([s, e]);
    }
    return out;
  }

  // ---- persistence ----------------------------------------------------------
  function persist(titleId, force) {
    try {
      const e = cache.get(titleId);
      if (!e || !e.dirty) return;
      const now = Date.now();
      if (!force && (now - e.lastWrite) < WRITE_MIN_MS) return;
      e.dirty = false;
      e.lastWrite = now;
      if (window.blobStore) {
        window.blobStore.set(KEY_PREFIX + titleId, JSON.stringify(e.store)).catch(() => {});
      }
    } catch (_) {}
  }

  function flushAll() {
    try {
      for (const id of cache.keys()) persist(id, true);
    } catch (_) {}
  }

  function admit(titleId, store) {
    const existing = cache.get(titleId);
    if (existing) { existing.lastUse = Date.now(); return existing; }
    if (cache.size >= MAX_CACHE) {
      let oldest = null, oldestUse = Infinity;
      for (const [id, e] of cache) {
        if (id === window._activeTitleId) continue;
        if (e.lastUse < oldestUse) { oldestUse = e.lastUse; oldest = id; }
      }
      if (oldest) { persist(oldest, true); cache.delete(oldest); }
    }
    const e = { store, dirty: false, lastWrite: 0, lastUse: Date.now() };
    cache.set(titleId, e);
    return e;
  }

  // ---- one-time seeding from the pre-tracker event log -----------------------
  // Mirrors ai-timeline's deriveSegments rules: consecutive position-bearing
  // pairs, same space only, forward-only, ≥60s apart, ≥200 chars (cue pairs
  // measure cue text when the title is live, else a ≥5-cue proxy). Card
  // events map through _srtCardToCueAnchor ONLY when the title is active.
  // Returns true when an event log existed (even if it yielded no intervals).
  async function seed(titleId, store) {
    if (!window.eventLog || typeof window.eventLog.getLog !== 'function') return false;
    const lg = await window.eventLog.getLog(titleId);
    const evs = (lg && Array.isArray(lg.events)) ? lg.events : null;
    if (!evs || !evs.length) return false;
    try {
      const active = (titleId === window._activeTitleId);
      const pts = [];
      for (const ev of evs) { if (ev && ev.p) pts.push(ev); }
      let cueCum = null;
      if (active && Array.isArray(window._srtCues) && window._srtCues.length) {
        const cues = window._srtCues;
        cueCum = new Array(cues.length + 1);
        cueCum[0] = 0;
        for (let i = 0; i < cues.length; i++) {
          cueCum[i + 1] = cueCum[i] + ((cues[i] && cues[i].text) ? cues[i].text.length : 0);
        }
      }
      const toV = (p, sp) => {
        if (sp === 'jp') return Number.isFinite(p.jpOff) ? p.jpOff : null;
        if (Number.isFinite(p.cueIdx)) return p.cueIdx;
        if (Number.isFinite(p.cardIndex)) {
          if (!active || typeof window._srtCardToCueAnchor !== 'function') return null;
          try {
            const c = window._srtCardToCueAnchor(p.cardIndex);
            return Number.isFinite(c) ? c : null;
          } catch (_) { return null; }
        }
        return null;
      };
      for (let i = 0; i + 1 < pts.length; i++) {
        const A = pts[i], B = pts[i + 1];
        if ((B.ts - A.ts) < 60000) continue;
        const spA = (A.p.k === 'read') ? 'jp' : 'cue';
        const spB = (B.p.k === 'read') ? 'jp' : 'cue';
        if (spA !== spB) continue;
        const a = toV(A.p, spA), b = toV(B.p, spA);
        if (a === null || b === null || b <= a) continue;
        if (spA === 'jp') {
          if ((b - a) < SEED_MIN_JP) continue;
        } else if (cueCum) {
          const ca = Math.max(0, Math.min(cueCum.length - 1, Math.round(a)));
          const cb = Math.max(0, Math.min(cueCum.length - 1, Math.round(b)));
          if ((cueCum[cb] - cueCum[ca]) < SEED_MIN_JP) continue;
        } else if ((b - a) < SEED_MIN_CUE) continue;
        const name = A.m || (spA === 'jp' ? 'read' : 'audio');
        const m = (name === 'read') ? M_READ : ((name === 'card') ? M_CARD : M_AUDIO);
        const covArr = (spA === 'jp') ? store.jp : store.cue;
        const rArr = (spA === 'jp') ? store.rjp : store.rcue;
        // historical re-reads: the overlap with what's already covered, BEFORE merging
        for (const pc of overlapPieces(covArr, a, b)) insertIv(rArr, pc[0], pc[1], m);
        insertIv(covArr, a, b, m);
      }
    } catch (_) { store.jp = []; store.cue = []; store.rjp = []; store.rcue = []; }
    return true;
  }

  function loadStore(titleId) {
    if (!titleId) return Promise.resolve(null);
    const cached = cache.get(titleId);
    if (cached) { cached.lastUse = Date.now(); return Promise.resolve(cached.store); }
    let job = loads.get(titleId);
    if (job) return job;
    job = (async () => {
      let store = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(KEY_PREFIX + titleId) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.v === 1 &&
              Array.isArray(parsed.jp) && Array.isArray(parsed.cue)) store = parsed;
        }
      } catch (_) {}
      let justSeeded = false;
      if (!store) {
        store = { v: 1, jp: [], cue: [], rjp: [], rcue: [] };
        try { justSeeded = await seed(titleId, store); }
        catch (_) { store.jp = []; store.cue = []; store.rjp = []; store.rcue = []; }
        if (justSeeded) store.seeded = true;
      }
      // Back-compat: old blobs (and the seeded default) must carry the re-visit
      // lists. Additive — store stays v:1, so a downgrade just ignores rjp/rcue.
      if (!Array.isArray(store.rjp)) store.rjp = [];
      if (!Array.isArray(store.rcue)) store.rcue = [];
      const e = admit(titleId, store);
      if (justSeeded) { e.dirty = true; persist(titleId, true); }
      return store;
    })().catch(() => null);
    loads.set(titleId, job);
    job.then(() => loads.delete(titleId), () => loads.delete(titleId));
    return job;
  }

  // ---- crediting poll ---------------------------------------------------------
  // Featherweight 5s tick. Title change → re-arm staleness snapshots and skip
  // (ai-chunks pattern: an unchanged cursor may still belong to the previous
  // title). When document.hidden ONLY the audio branch runs — background
  // listening counts; read/card need the screen.
  let pollTitle;
  let staleJp, staleCue, staleCard;
  let anchor = null;          // { space, pos, mode, ts } for pollTitle
  let pollLoading = false;

  function armStale() {
    staleCue = window._lastAudioCueIdx;
    staleCard = window.currentCardIndex;
    staleJp = undefined;
    try {
      if (typeof window.pagedGetReadLocation === 'function') {
        const loc = window.pagedGetReadLocation();
        if (loc && Number.isFinite(loc.jpOff)) staleJp = loc.jpOff;
      }
    } catch (_) {}
  }

  function currentMode() {
    try {
      if (window.stats && typeof window.stats.currentMode === 'function') {
        const m = window.stats.currentMode();
        if (m) return m;
      }
    } catch (_) {}
    try {
      const cl = document.body.classList;
      if (cl.contains('mode-read')) return 'read';
      if (cl.contains('mode-audio')) return 'audio';
      if (cl.contains('mode-card')) return 'card';
    } catch (_) {}
    return null;
  }

  function tick() {
    try {
      if (window._kaiAiPaused) return;        // perf-probe kill switch
      const titleId = window._activeTitleId;
      if (!titleId) return;
      if (titleId !== pollTitle) {
        pollTitle = titleId;
        anchor = null;
        armStale();
        return;
      }
      const mode = currentMode();
      if (!mode) return;
      if (document.hidden && mode !== 'audio') return;

      let space = null, pos = null, m = -1;
      if (mode === 'read') {
        if (!document.body.classList.contains('mode-read')) return;
        if (typeof window.pagedGetReadLocation !== 'function') return;
        const loc = window.pagedGetReadLocation();
        if (!loc || !Number.isFinite(loc.jpOff) || loc.jpOff === staleJp) return;
        space = 'jp'; pos = loc.jpOff; m = M_READ;
      } else if (mode === 'audio') {
        const c = window._lastAudioCueIdx;
        if (!Number.isFinite(c) || c === staleCue) return;
        space = 'cue'; pos = c; m = M_AUDIO;
      } else if (mode === 'card') {
        const ci = window.currentCardIndex;
        if (!Number.isFinite(ci) || ci === staleCard) return;
        if (typeof window._srtCardToCueAnchor !== 'function') return;
        const c = window._srtCardToCueAnchor(ci);
        if (!Number.isFinite(c)) return;
        space = 'cue'; pos = c; m = M_CARD;
      } else return;

      const e = cache.get(titleId);
      if (!e) {
        if (!pollLoading) {
          pollLoading = true;   // async warm; the next tick can credit
          loadStore(titleId).catch(() => {}).finally(() => { pollLoading = false; });
        }
        anchor = { space, pos, mode: m, ts: Date.now() };
        return;
      }
      e.lastUse = Date.now();
      const prev = anchor;
      anchor = { space, pos, mode: m, ts: Date.now() };
      if (!prev || prev.space !== space || prev.mode !== m) return;
      const d = pos - prev.pos;
      // backward / implausible jump: anchor moved above, credit nothing
      if (d <= 0) return;
      if (space === 'jp' ? (d > MAX_JP_DELTA) : (d > MAX_CUE_DELTA)) return;
      const covArr = (space === 'jp') ? e.store.jp : e.store.cue;
      const rArr = (space === 'jp') ? e.store.rjp : e.store.rcue;
      // Record re-visited territory (the overlap with prior coverage) BEFORE
      // merging this segment in — that's how we tell a re-read from a first read.
      if (Array.isArray(rArr)) {
        for (const pc of overlapPieces(covArr, prev.pos, pos)) insertIv(rArr, pc[0], pc[1], m);
      }
      insertIv(covArr, prev.pos, pos, m);
      e.dirty = true;
      persist(titleId, false);
    } catch (_) {}
  }
  setInterval(tick, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    try { if (document.hidden) flushAll(); } catch (_) {}
  });
  window.addEventListener('shell:title-change', () => {
    try {
      flushAll();
      pollTitle = undefined;   // next tick re-arms staleness for the new title
      anchor = null;
    } catch (_) {}
  });

  // ---- public surface ---------------------------------------------------------
  window.modeCoverage = {
    get(titleId) {
      try { return loadStore(titleId); } catch (_) { return Promise.resolve(null); }
    },
    flush() { try { flushAll(); } catch (_) {} },
    _tick: tick,
  };
})();
