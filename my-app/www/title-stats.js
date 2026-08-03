// title-stats.js — per-title daily progress log powering the library's
// "Stats" card (first started, progress per day, estimated time to finish).
//
// Model: per title, per LOCAL calendar day, the daily HIGH-WATER of the two
// progress axes — audio playhead ms (aMs) and read jp-char position (rCh).
// Day-over-day deltas of those maxima = forward progress per day. High-water
// semantics make it scrub-proof (re-listening an earlier section adds 0 —
// honest "progress toward finishing") and idempotent under any save cadence.
// Totals (durMs / tCh) are recorded opportunistically for the ETA math.
//
// Storage: blobStore 'TSTATS_V1_<titleId>' → { v:1, firstTs, durMs, tCh,
// days: { 'YYYY-MM-DD': { aMs, rCh } } }. In-memory cache; dirty titles
// flushed every 30s and on app background. Writes are tiny (one small JSON).
//
// Hooks (never block, never throw): bookmarks.updateFurthest → noteAudio
// (fires only on genuine forward audio progress); the paged reader's
// read-credit paths → noteRead.
(function () {
  'use strict';

  const KEY = (tid) => 'TSTATS_V1_' + tid;
  const cache = {};          // tid → obj (loaded or fresh)
  const loading = {};        // tid → Promise (single-flight)
  const dirty = new Set();

  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fresh() { return { v: 1, firstTs: 0, durMs: 0, tCh: 0, days: {} }; }

  function load(tid) {
    if (cache[tid]) return Promise.resolve(cache[tid]);
    if (loading[tid]) return loading[tid];
    loading[tid] = (async () => {
      let o = null;
      try {
        const raw = await window.blobStore?.get(KEY(tid));
        o = raw ? JSON.parse(raw) : null;
      } catch (_) {}
      if (!o || o.v !== 1 || typeof o.days !== 'object') o = fresh();
      cache[tid] = o;
      delete loading[tid];
      return o;
    })();
    return loading[tid];
  }

  function flush() {
    for (const tid of dirty) {
      const o = cache[tid];
      if (!o) continue;
      try { window.blobStore?.set(KEY(tid), JSON.stringify(o)); } catch (_) {}
    }
    dirty.clear();
  }
  setInterval(flush, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  function note(tid, field, val) {
    if (!tid || !Number.isFinite(val) || val <= 0) return;
    load(tid).then((o) => {
      const dk = dayKey();
      const d = o.days[dk] || (o.days[dk] = {});
      if (!(d[field] >= val)) {
        d[field] = Math.round(val);
        if (!o.firstTs) o.firstTs = Date.now();
        dirty.add(tid);
      }
    }).catch(() => {});
  }

  // Audio forward progress. Duration comes along for the ride when the live
  // engine has it (callers are ownership-gated, so the live engine IS this
  // title's audio at call time).
  function noteAudio(tid, ms) {
    note(tid, 'aMs', ms);
    try {
      const g = window.getAudioProgress?.();
      if (g && Number(g.dur) > 60000) {
        load(tid).then((o) => {
          if (Number(g.dur) > (o.durMs || 0)) { o.durMs = Math.round(g.dur); dirty.add(tid); }
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // Time spent, per mode, ADDITIVE (fed 1s at a time by stats.js's tick while
  // that mode's timer runs — 1 tick = 1 real second, so no idempotency needed).
  // Stored per day as t: { c, r, a } seconds.
  function noteTime(tid, mode, sec) {
    if (!tid || !Number.isFinite(sec) || sec <= 0) return;
    const f = mode === 'card' ? 'c' : mode === 'read' ? 'r' : mode === 'audio' ? 'a' : mode === 'watch' ? 'w' : null;
    if (!f) return;
    load(tid).then((o) => {
      const dk = dayKey();
      const d = o.days[dk] || (o.days[dk] = {});
      const t = d.t || (d.t = {});
      t[f] = (t[f] || 0) + sec;
      if (!o.firstTs) o.firstTs = Date.now();
      dirty.add(tid);
    }).catch(() => {});
  }

  // Read forward progress (jp-char position + the book's jp total).
  function noteRead(tid, jpPos, jpTotal) {
    note(tid, 'rCh', jpPos);
    if (Number.isFinite(jpTotal) && jpTotal > 0) {
      load(tid).then((o) => {
        if (jpTotal > (o.tCh || 0)) { o.tCh = Math.round(jpTotal); dirty.add(tid); }
      }).catch(() => {});
    }
  }

  // Computed summary for the stats card. Returns:
  // { firstTs, durMs, tCh, days: [{day, aMs, rCh, aDelta, rDelta}] (sorted),
  //   curAMs, curRCh, activeDays, paceAMs, paceRCh } — pace = mean daily
  // forward progress over the last ≤7 ACTIVE days (days with any progress).
  async function getStats(tid) {
    const o = await load(tid);
    const keys = Object.keys(o.days).sort();
    const days = [];
    let maxA = 0, maxR = 0;
    for (const k of keys) {
      const d = o.days[k];
      const aMs = Number(d.aMs) || 0, rCh = Number(d.rCh) || 0;
      const aDelta = Math.max(0, aMs - maxA), rDelta = Math.max(0, rCh - maxR);
      if (aMs > maxA) maxA = aMs;
      if (rCh > maxR) maxR = rCh;
      days.push({ day: k, aMs, rCh, aDelta, rDelta });
    }
    // Per-mode time totals (seconds) across all days.
    const timeSec = { card: 0, read: 0, audio: 0, watch: 0 };
    for (const k of keys) {
      const t = o.days[k].t;
      if (t) { timeSec.card += t.c || 0; timeSec.read += t.r || 0; timeSec.audio += t.a || 0; timeSec.watch += t.w || 0; }
    }
    const active = days.filter((d) => d.aDelta > 0 || d.rDelta > 0 ||
      (o.days[d.day].t && ((o.days[d.day].t.c || 0) + (o.days[d.day].t.r || 0) + (o.days[d.day].t.a || 0) + (o.days[d.day].t.w || 0) > 60)));
    const recent = active.slice(-7);
    const mean = (arr, f) => {
      const v = arr.map(f).filter((x) => x > 0);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    };
    return {
      firstTs: o.firstTs || 0,
      durMs: o.durMs || 0,
      tCh: o.tCh || 0,
      days,
      curAMs: maxA,
      curRCh: maxR,
      activeDays: active.length,
      paceAMs: mean(recent, (d) => d.aDelta),
      paceRCh: mean(recent, (d) => d.rDelta),
      timeSec,
    };
  }

  window.titleStats = { noteAudio, noteRead, noteTime, getStats, flush };
})();
