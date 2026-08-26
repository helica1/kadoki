// mode-coverage.js — persistent per-title record of WHICH PARTS of a book
// were consumed in WHICH MODE (read / card / audio). Re-reading a range in a
// different mode OVERWRITES it (insert = clip/split other-mode overlaps,
// merge adjacent same-mode). THREE native spaces are kept side by side:
// read progress in jp chars (`jp`), audio/card progress in MILLISECONDS
// (`ms` — the preferred space, used whenever a title has a live cue-time
// mapping), and a legacy cue-index space (`cue` — used only as a fallback
// for titles with no ms mapping, e.g. plain Anki-deck titles with no linked
// audio timeline). Conversion to one display axis happens at render time
// (ai-timeline.js).
//
// WHY ms, not cue-index: a cue LIST can be regenerated with a different
// segmentation (re-transcription, an SRT→on-device-whisper source swap, or
// even live backfill during one session) — the same audio timestamp keeps
// its meaning forever, but "cue index 137" means a different sentence after
// the list changes shape. Storing raw cue indices made the coverage axis
// look "fragmented" in places that were actually fully listened to, because
// old indices got silently reinterpreted against a newer, differently-
// segmented cue list. ms is a physical quantity immune to that churn.
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
  const MAX_MS_DELTA = 180000;    // 3 real minutes — generous for fast playback speeds
  const MAX_CACHE = 4;            // in-memory stores (active title never evicted)
  const SEED_MIN_JP = 200;        // seeding: min chars per credited pair
  const SEED_MIN_CUE = 5;         // seeding fallback when cue text is unknown

  const M_READ = 0, M_CARD = 1, M_AUDIO = 2;

  // cue index → ms (best-effort; null when cues aren't loaded or idx is bad).
  function cueMs(idx) {
    try {
      const cues = window._srtCues;
      if (!Array.isArray(cues) || !cues.length || !Number.isFinite(idx)) return null;
      const i = Math.max(0, Math.min(cues.length - 1, Math.round(idx)));
      return Number.isFinite(cues[i].startMs) ? Math.round(cues[i].startMs) : null;
    } catch (_) { return null; }
  }

  // One-time conversion of a v1 store's legacy cue-index intervals into the
  // ms space, using WHATEVER cue list is live right now — best-effort (a
  // title whose cue list already drifted since those indices were recorded
  // will convert imperfectly), but permanently self-heals from here since
  // every future credit is written in ms directly. Returns false (no-op,
  // retry later) when cues aren't loaded yet — never guesses against an
  // empty list.
  // TEMP diagnostic (2026-08 coverage-fragmentation investigation) — always
  // logs, not KADOKI_DEBUG-gated, so it shows in Xcode's console without any
  // extra setup. Remove once the fragmentation bug is confirmed fixed.
  function _covLog() { try { console.log.apply(console, ['[KAI-COVDBG]'].concat(Array.prototype.slice.call(arguments))); } catch (_) {} }

  function migrateLegacyCue(store) {
    try {
      const cues = window._srtCues;
      if (!Array.isArray(cues) || !cues.length) {
        _covLog('migrateLegacyCue: NO cues yet, deferring', { hasCues: Array.isArray(cues), cuesLen: cues && cues.length });
        return false;
      }
      _covLog('migrateLegacyCue: converting', { cuesLen: cues.length, cueIvs: (store.cue || []).length, rcueIvs: (store.rcue || []).length });
      const conv = (srcArr, dstArr) => {
        if (!Array.isArray(srcArr)) return;
        for (const iv of srcArr) {
          if (!Array.isArray(iv)) continue;
          const a = cueMs(iv[0]), b = cueMs(iv[1]);
          if (Number.isFinite(a) && Number.isFinite(b) && b > a) insertIv(dstArr, a, b, iv[2]);
        }
      };
      const sumLen = (arr) => (arr || []).reduce((s, iv) => s + Math.max(0, (iv[1] || 0) - (iv[0] || 0)), 0);
      const cueTotal = sumLen(store.cue), rcueTotal = sumLen(store.rcue);
      conv(store.cue, store.ms);
      conv(store.rcue, store.rms);
      store.cue = []; store.rcue = [];   // fresh legacy space, ready for future deck-card-title fallback writes
      _covLog('migrateLegacyCue: done', {
        cueTotalCueUnits: cueTotal, rcueTotalCueUnits: rcueTotal,
        msIvsAfter: store.ms.length, rmsIvsAfter: store.rms.length,
        msTotalMs: sumLen(store.ms), rmsTotalMs: sumLen(store.rms),
      });
      return true;
    } catch (_) { return false; }
  }

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
  // territory in `arr`. Strict (e > s) so continuous forward reading — which only
  // TOUCHES the prior interval's right edge — yields nothing. `arr` is sorted +
  // non-overlapping (invariant of insertIv).
  //
  // NOT sufficient on its own — see credit() below. "Overlaps already-covered
  // territory" is ALSO true of a redundant credit for ground a DIFFERENT writer
  // just covered, and audio has two concurrent writers (this file's 5 s tick and
  // reading-mode-paged.js's event-driven creditRange). Both walk the same
  // listening forward, so whichever ran second used to file the entire listened
  // span as a "re-listen" — which is why the second spine track mirrored the
  // first for a book heard exactly once.
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

  // A re-visit is "THIS writer went BACK over ground it had already passed" —
  // judged against the writer's own monotonic high-water mark, not against the
  // shared coverage array. A second writer duplicating the first writer's span
  // never moves backward relative to ITSELF, so it can no longer manufacture a
  // re-visit; a real rewind-and-relisten does move backward, and every span of
  // it stays below the high-water until it catches up again, so the whole
  // re-listen is still recorded. Keyed per (title, writer, space, mode) so the
  // writers never contaminate each other.
  const revCursor = new Map();
  const MAX_CURSORS = 64;
  // Floor per space, so boundary slivers (a writer re-anchoring a couple of
  // seconds back after a mode switch) don't paint the re-visit track.
  const REVISIT_MIN = { ms: 5000, jp: 200, cue: 3 };

  // The ONE place coverage is written. `origin` names the writer.
  function credit(covArr, rArr, from, to, m, titleId, origin, space) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const key = titleId + '|' + origin + '|' + space + '|' + m;
    const hw = revCursor.get(key);
    // The first span a writer contributes carries no backward evidence.
    if (Number.isFinite(hw) && from < hw && Array.isArray(rArr)) {
      const min = REVISIT_MIN[space] || 0;
      for (const pc of overlapPieces(covArr, from, to)) {
        if ((pc[1] - pc[0]) >= min) insertIv(rArr, pc[0], pc[1], m);
      }
    }
    insertIv(covArr, from, to, m);
    if (revCursor.size >= MAX_CURSORS && !revCursor.has(key)) {
      try { revCursor.delete(revCursor.keys().next().value); } catch (_) {}
    }
    revCursor.set(key, Number.isFinite(hw) ? Math.max(hw, to) : to);
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
        let covArr = (spA === 'jp') ? store.jp : store.cue;
        let rArr = (spA === 'jp') ? store.rjp : store.rcue;
        let wa = a, wb = b;
        if (spA === 'cue') {
          // prefer ms when this cue list can resolve it — same reasoning as tick()
          const ma = cueMs(a), mb = cueMs(b);
          if (Number.isFinite(ma) && Number.isFinite(mb) && mb > ma) { covArr = store.ms; rArr = store.rms; wa = ma; wb = mb; }
        }
        // historical re-reads: recorded when this seeding pass itself walks
        // backward over ground it already laid down (a later session that
        // reopened earlier in the book), never for merely overlapping spans.
        credit(covArr, rArr, wa, wb, m, titleId, 'seed',
               (covArr === store.jp) ? 'jp' : ((covArr === store.ms) ? 'ms' : 'cue'));
      }
    } catch (_) { store.jp = []; store.cue = []; store.ms = []; store.rjp = []; store.rcue = []; store.rms = []; }
    return true;
  }

  // v2 → v3: DISCARD the whole re-visit track once.
  // Every v2 store's rjp/rcue/rms was written under the old "overlaps
  // already-covered territory ⇒ re-visit" rule, which the two concurrent audio
  // writers tripped on every single credit (see overlapPieces / credit). For a
  // book consumed once the second spine track therefore mirrored the first,
  // and there is no way to tell the manufactured entries from the genuine ones
  // after the fact. Clearing is the only honest repair: the COVERAGE track (the
  // one that matters) is untouched, and the re-visit track rebuilds correctly
  // from the next rewind onward.
  function migrateV3(store) {
    try {
      // Strictly v2 → v3. A store still on v1 has its legacy cue→ms migration
      // pending (retryMigration keys off v === 1); stamping it v3 here would
      // strand that data forever. It reaches v2 first, then v3 on a later touch.
      if (store.v !== 2) return false;
      const had = (store.rjp || []).length + (store.rcue || []).length + (store.rms || []).length;
      store.rjp = []; store.rcue = []; store.rms = [];
      store.v = 3;
      _covLog('migrateV3: cleared re-visit track', { discardedIvs: had });
      return true;
    } catch (_) { return false; }
  }

  // A still-v1 store with leftover legacy data gets one more migration
  // attempt whenever it's touched — not just at cold-load — so it self-heals
  // within a few seconds of window._srtCues becoming available (typically
  // moments after title open), not only on the next app relaunch.
  function retryMigration(store, titleId) {
    let changed = false;
    try {
      if (store.v === 1) {
        if (!(store.cue && store.cue.length) && !(store.rcue && store.rcue.length)) { store.v = 2; changed = true; }
        else if (migrateLegacyCue(store)) { store.v = 2; changed = true; }
      }
      if (migrateV3(store)) changed = true;
    } catch (_) {}
    return changed;
  }

  function loadStore(titleId) {
    if (!titleId) return Promise.resolve(null);
    const cached = cache.get(titleId);
    if (cached) {
      cached.lastUse = Date.now();
      const migrated = retryMigration(cached.store, titleId);
      if (migrated) {
        cached.dirty = true; persist(titleId, true);
        _covLog('loadStore: cache-hit retry migrated', { titleId, msIvs: cached.store.ms.length, cueIvs: cached.store.cue.length });
      }
      return Promise.resolve(cached.store);
    }
    let job = loads.get(titleId);
    if (job) return job;
    job = (async () => {
      let store = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(KEY_PREFIX + titleId) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.v === 1 || parsed.v === 2 || parsed.v === 3) &&
              Array.isArray(parsed.jp) && Array.isArray(parsed.cue)) store = parsed;
          _covLog('loadStore: raw blob', {
            titleId, found: !!raw, parsedOk: !!store,
            v: store && store.v, jpIvs: store && store.jp.length, cueIvs: store && store.cue.length,
            msIvs: store && Array.isArray(store.ms) ? store.ms.length : 'n/a',
          });
        } else {
          _covLog('loadStore: NO raw blob for', titleId);
        }
      } catch (_) {}
      let justSeeded = false;
      if (!store) {
        store = { v: 3, jp: [], cue: [], ms: [], rjp: [], rcue: [], rms: [] };
        try { justSeeded = await seed(titleId, store); }
        catch (_) { store.jp = []; store.cue = []; store.ms = []; store.rjp = []; store.rcue = []; store.rms = []; }
        if (justSeeded) store.seeded = true;
      }
      // Back-compat: old blobs (and the seeded default) must carry every
      // array regardless of which vintage produced them.
      if (!Array.isArray(store.rjp)) store.rjp = [];
      if (!Array.isArray(store.rcue)) store.rcue = [];
      if (!Array.isArray(store.ms)) store.ms = [];
      if (!Array.isArray(store.rms)) store.rms = [];
      const justMigrated = retryMigration(store, titleId);
      _covLog('loadStore: cold-load result', {
        titleId, justSeeded, justMigrated, finalV: store.v,
        jpIvs: store.jp.length, cueIvs: store.cue.length, msIvs: store.ms.length,
      });
      const e = admit(titleId, store);
      if (justSeeded || justMigrated) { e.dirty = true; persist(titleId, true); }
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

      // Staleness ("did anything actually move") is always checked against the
      // raw cue-index/card-index globals — cheap, reliable, unaffected by
      // whichever space we go on to credit in. Once past that gate, ms is
      // preferred for the actual credited value; cue-index is the fallback
      // for titles where ms can't be resolved (e.g. plain Anki-deck titles
      // with no linked audio timeline — _srtAnchorMsFor returns null there).
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
        let ms = null;
        try { const ap = window.getAudioProgress && window.getAudioProgress(); if (ap && Number.isFinite(ap.ms) && ap.ms > 0) ms = ap.ms; } catch (_) {}
        if (Number.isFinite(ms)) { space = 'ms'; pos = ms; m = M_AUDIO; }
        else { space = 'cue'; pos = c; m = M_AUDIO; }
      } else if (mode === 'card') {
        const ci = window.currentCardIndex;
        if (!Number.isFinite(ci) || ci === staleCard) return;
        if (typeof window._srtCardToCueAnchor !== 'function') return;
        const c = window._srtCardToCueAnchor(ci);
        if (!Number.isFinite(c)) return;
        const ms = (typeof window._srtAnchorMsFor === 'function') ? window._srtAnchorMsFor(c) : null;
        if (Number.isFinite(ms)) { space = 'ms'; pos = ms; m = M_CARD; }
        else { space = 'cue'; pos = c; m = M_CARD; }
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
      if (space === 'ms') {
        // WALL-CLOCK-RELATIVE plausibility, not a flat cap: a flat MAX_MS_DELTA
        // assumes ticks are always ~POLL_MS apart, but background throttling
        // (iOS/Android both deprioritize backgrounded JS timers) or the app
        // waking from a long suspend can leave many real minutes between two
        // consecutive ticks — during which continuous background listening is
        // completely legitimate. A flat cap silently drops that whole stretch
        // (exactly the bug already fixed once for the audio-chars stats
        // counter — see reading-mode-paged.js __onPagedCueUpdate's identical
        // wall × rate comparison, same 1.5× slack + 2500ms buffer for poll
        // granularity). Falls back to the old flat cap only if wall time
        // itself is degenerate (clock skew, first-ever anchor edge cases).
        const wallAdvance = anchor.ts - prev.ts;
        const rate = parseFloat(window.audioPlaybackRate) || 1;
        const allowed = (wallAdvance > 0) ? (wallAdvance * rate * 1.5 + 2500) : MAX_MS_DELTA;
        if (d > allowed) return;
      } else if (space === 'jp' ? (d > MAX_JP_DELTA) : (d > MAX_CUE_DELTA)) return;
      const covArr = (space === 'jp') ? e.store.jp : (space === 'ms') ? e.store.ms : e.store.cue;
      const rArr = (space === 'jp') ? e.store.rjp : (space === 'ms') ? e.store.rms : e.store.rcue;
      credit(covArr, rArr, prev.pos, pos, m, titleId, 'poll', space);
      e.dirty = true;
      persist(titleId, false);
    } catch (_) {}
  }
  // READ-ONLY PANEL WINDOW (panel-bridge.js): a second webview on the SAME origin
  // shares this storage, so it must never run a second copy of a writer — that
  // is how the user's place gets lost. The module still loads (the panel reads
  // through its public surface); only the crediting/polling clock stands down.
  if (!window.KADOKI_PANEL) setInterval(tick, POLL_MS);

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

  // External credit for a KNOWN [from,to) span the live tick() poll never
  // sees — e.g. Apple Watch listening (ms space), or paper reading logged via
  // "Log printed reading" (jp space) — neither ever touches the phone's live
  // audio/read globals tick() polls, and may not even be for the title
  // that's currently open (or the app may not even be running when it
  // happens). Unlike tick(), this does NOT require titleId ===
  // window._activeTitleId. `space` defaults to 'ms' (audio/card's native
  // space) when omitted; pass 'jp' for read-mode credit — jp needs no cue
  // list either way, so this function never touches window._srtCues.
  // The caller owns continuity/plausibility gating (e.g. watch.js's
  // creditWatchListen already does this via its own checkpoint cursor).
  // `forcePersist` (default true) bypasses the normal WRITE_MIN_MS write
  // throttle — right for watch (~every 2min) and print (once), but a caller
  // that might invoke this on every cue transition during LIVE listening
  // (many times a minute) must pass `false` so it respects the same
  // throttle tick()'s own tick-driven writes already do.
  // `origin` names the writer for re-visit bookkeeping (see credit()) — pass a
  // stable, distinct string per call site, so one writer's forward progress is
  // never mistaken for another writer's rewind.
  async function creditRange(titleId, from, to, modeName, space, forcePersist, origin) {
    try {
      if (!titleId || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
      const m = modeName === 'read' ? M_READ : (modeName === 'card' ? M_CARD : M_AUDIO);
      const store = await loadStore(titleId);
      if (!store) return false;
      const covKey = (space === 'jp') ? 'jp' : 'ms';
      const rKey = (space === 'jp') ? 'rjp' : 'rms';
      if (!Array.isArray(store[covKey])) store[covKey] = [];
      if (!Array.isArray(store[rKey])) store[rKey] = [];
      credit(store[covKey], store[rKey], from, to, m, titleId, origin || 'ext', covKey);
      const e = cache.get(titleId);
      if (e) { e.dirty = true; persist(titleId, forcePersist !== false); }
      return true;
    } catch (_) { return false; }
  }

  // ---- public surface ---------------------------------------------------------
  window.modeCoverage = {
    get(titleId) {
      try { return loadStore(titleId); } catch (_) { return Promise.resolve(null); }
    },
    flush() { try { flushAll(); } catch (_) {} },
    creditRange,
    _tick: tick,
  };
})();
