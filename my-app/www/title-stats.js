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

  // Same 3 AM day boundary as the daily totals (stats.js statsDay), so a
  // title's day lines up with the day's totals in the copied report.
  function dayKey(ts) {
    const d = new Date((ts || Date.now()) - 3 * 3600 * 1000);
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

  // Time spent, per mode, ADDITIVE (fed whole seconds by stats.js: card/read from
  // the same elapsed intervals as the daily totals, audio from playhead samples).
  // Stored per day as t: { c, r, a, v, w } seconds (card/read/audio/video/watch).
  function noteTime(tid, mode, sec) {
    if (!tid || !Number.isFinite(sec) || sec <= 0) return;
    const f = mode === 'card' ? 'c' : mode === 'read' ? 'r' : mode === 'audio' ? 'a' : mode === 'video' ? 'v' : mode === 'watch' ? 'w' : null;
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

  // Characters credited per mode (the same increments the daily totals get),
  // per day: ch: { c, r, a } (card / read / audio).
  function noteChars(tid, mode, n) {
    if (!tid || !Number.isFinite(n) || n <= 0) return;
    const f = mode === 'card' ? 'c' : mode === 'read' ? 'r' : (mode === 'audio' || mode === 'video') ? 'a' : null;
    if (!f) return;
    load(tid).then((o) => {
      const d = o.days[dayKey()] || (o.days[dayKey()] = {});
      const ch = d.ch || (d.ch = {});
      ch[f] = (ch[f] || 0) + Math.round(n);
      if (!o.firstTs) o.firstTs = Date.now();
      dirty.add(tid);
    }).catch(() => {});
  }

  // Read forward progress (jp-char position + the book's jp total). The total
  // follows the book as it is now (not a high-water mark), so a total once
  // recorded from another book during a title switch corrects itself.
  function noteRead(tid, jpPos, jpTotal) {
    note(tid, 'rCh', jpPos);
    if (Number.isFinite(jpTotal) && jpTotal > 0) {
      load(tid).then((o) => {
        const n = Math.round(jpTotal);
        if (n !== (o.tCh || 0)) { o.tCh = n; dirty.add(tid); }
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
    const timeSec = { card: 0, read: 0, audio: 0, video: 0, watch: 0 };
    for (const k of keys) {
      const t = o.days[k].t;
      if (t) { timeSec.card += t.c || 0; timeSec.read += t.r || 0; timeSec.audio += t.a || 0; timeSec.video += t.v || 0; timeSec.watch += t.w || 0; }
    }
    const active = days.filter((d) => d.aDelta > 0 || d.rDelta > 0 ||
      (o.days[d.day].t && ((o.days[d.day].t.c || 0) + (o.days[d.day].t.r || 0) + (o.days[d.day].t.a || 0) + (o.days[d.day].t.v || 0) + (o.days[d.day].t.w || 0) > 60)));
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

  // ---- Copyable daily report (2026-11-24, user: "copy statistics for the
  // day … to give to an agent to put in a spreadsheet") ----
  // which: 'today' | 'yesterday'. Day totals come from stats.js (today live,
  // yesterday from its rollover snapshot); the per-title rows from the
  // per-title daily logs above. Plain text: a short summary, then CSV.
  function _hm(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60; return h + ':' + String(m).padStart(2, '0'); }
  function _rate(chars, sec) { return sec >= 60 && chars > 0 ? Math.round(chars / (sec / 3600)) : ''; }
  function _csv(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  async function dayReport(which) {
    flush();
    const today = dayKey();
    let day = today, totals = null;
    const S = window.stats;
    if (which === 'yesterday') {
      const y = S && S.getYesterday && S.getYesterday();
      day = (y && y.day) || dayKey(Date.now() - 86400000);
      if (y && y.modes) totals = y.modes;
    } else if (S) {
      totals = {
        card: { sec: S.getCardSec(), chars: S.getCardChars(), cards: S.getCardCount() },
        read: { sec: S.getReadSec(), chars: S.getReadChars() },
        audio: { sec: S.getAudioSec(), chars: S.getAudioChars() },
        video: { sec: S.getVideoSec(), chars: S.getVideoChars() },
        ai: { sec: S.getAiSec() }, srs: { sec: S.getSrsSec() },
      };
    }
    const rows = [];
    let list = [];
    try { list = (await window.titleStore?.list()) || []; } catch (_) {}
    for (const t of list) {
      const o = await load(t.id);
      const d = o.days && o.days[day];
      if (!d) continue;
      const tm = d.t || {}, ch = d.ch || {};
      // Progress made that day: today's high-water minus the best before it.
      let prevA = 0, prevR = 0;
      for (const k of Object.keys(o.days)) {
        if (k >= day) continue;
        prevA = Math.max(prevA, Number(o.days[k].aMs) || 0);
        prevR = Math.max(prevR, Number(o.days[k].rCh) || 0);
      }
      const aAdv = Math.max(0, (Number(d.aMs) || 0) - prevA), rAdv = Math.max(0, (Number(d.rCh) || 0) - prevR);
      const pct = (o.durMs > 0 && d.aMs) ? Math.round(100 * d.aMs / o.durMs) : (o.tCh > 0 && d.rCh ? Math.round(100 * d.rCh / o.tCh) : '');
      const kind = t.attachments?.audiobook?.isVideo ? 'video' : (t.attachments?.audiobook ? 'audiobook' : (t.attachments?.epub ? 'book' : (t.attachments?.deck ? 'deck' : '')));
      const add = (mode, sec, chars) => {
        if (!(sec >= 30) && !(chars > 0)) return;
        rows.push([day, t.name || 'Untitled', t.author || '', kind, mode, Math.round(sec / 60), chars || 0, _rate(chars, sec),
          mode === 'listen' ? Math.round(aAdv / 60000) : '', mode === 'read' ? rAdv : '', pct]);
      };
      add('read', tm.r || 0, ch.r || 0);
      add('listen', (tm.a || 0) + (tm.v || 0) + (tm.w || 0), ch.a || 0);
      add('card', tm.c || 0, ch.c || 0);
    }
    rows.sort((a, b) => (b[5] - a[5]));
    const L = [];
    L.push('Kadoki daily stats — ' + day + (which === 'yesterday' ? ' (yesterday)' : ' (today, so far)'));
    if (totals) {
      const line = (label, m) => {
        if (!m || !(m.sec >= 1)) return;
        const r = _rate(m.chars || 0, m.sec);
        L.push(label + ': ' + _hm(m.sec) + (m.chars ? ' · ' + m.chars.toLocaleString() + ' chars' : '') + (r ? ' · ' + r.toLocaleString() + ' chars/h' : '') + (m.cards ? ' · ' + m.cards + ' cards' : ''));
      };
      line('Read', totals.read); line('Listen', totals.audio); line('Video', totals.video); line('Card', totals.card);
      line('AI material', totals.ai); line('Vocab review', totals.srs);
      const all = ['read', 'audio', 'video', 'card'].reduce((s, k) => s + ((totals[k] && totals[k].sec) || 0), 0);
      L.push('Total immersion: ' + _hm(all));
    }
    L.push('');
    L.push('CSV (one row per title and mode):');
    L.push(['date', 'title', 'author', 'type', 'mode', 'minutes', 'chars', 'chars_per_hour', 'listened_ahead_min', 'read_ahead_chars', 'percent_through'].join(','));
    for (const r of rows) L.push(r.map(_csv).join(','));
    if (!rows.length) L.push('(no per-title activity recorded for this day)');
    return L.join('\n');
  }
  async function copyDayReport(which) {
    const text = await dayReport(which);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch (_) {}
    }
    try { window.showToast?.(ok ? 'Stats copied' : 'Copy failed', 1800); } catch (_) {}
    return ok;
  }

  window.titleStats = { noteAudio, noteRead, noteTime, noteChars, getStats, flush, dayReport, copyDayReport };
})();
