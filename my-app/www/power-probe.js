// power-probe.js — on-device CPU attribution for the heat/battery hunt.
//
// Patches rAF, timers, and the Capacitor bridge at load and reports, every
// REPORT_MS, who actually spent the wall time: total JS ms per second, the
// worst callbacks by source, layout-forcing measurement calls, and which
// background passes are alive. Off unless localStorage KADOKI_POWER=1 (or a
// debug build), and the patches are a timestamp pair per callback.
(function () {
  'use strict';
  let on = false;
  try { on = !!localStorage.getItem('KADOKI_POWER'); } catch (_) {}
  const REPORT_MS = 10000;

  const buckets = new Map();   // label → {n, ms, lay}
  const layByOwner = new Map(); // label → count (layout calls made while it ran)
  let rafN = 0, rafMs = 0, layoutN = 0, bridgeN = 0, styleN = 0, t0 = performance.now();
  let cur = null;              // label of the callback currently on the stack

  function bump(label, ms, lay) {
    let b = buckets.get(label);
    if (!b) { b = { n: 0, ms: 0, lay: 0 }; buckets.set(label, b); }
    b.n++; b.ms += ms; b.lay += lay || 0;
  }
  function countLayout() {
    layoutN++;
    const k = cur || 'outside-callback';
    layByOwner.set(k, (layByOwner.get(k) || 0) + 1);
  }
  // A short, stable label for a callback: its name, else a hash of its source.
  const labelCache = new WeakMap();
  function labelOf(fn, kind) {
    let l = labelCache.get(fn);
    if (l) return l;
    let name = (fn && fn.name) || '';
    if (!name) {
      let src = '';
      try { src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 90); } catch (_) {}
      name = src || 'anon';
    }
    l = kind + ':' + name;
    labelCache.set(fn, l);
    return l;
  }

  function start() {
    // ---- rAF ----
    const rawRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return rawRaf(function (ts) {
        const a = performance.now(), l0 = layoutN, prev = cur;
        cur = labelOf(cb, 'raf');
        try { return cb(ts); }
        finally { const d = performance.now() - a; rafN++; rafMs += d; bump(cur, d, layoutN - l0); cur = prev; }
      });
    };
    // ---- timers ----
    for (const kind of ['setInterval', 'setTimeout']) {
      const raw = window[kind].bind(window);
      window[kind] = function (cb, ms) {
        if (typeof cb !== 'function') return raw.apply(null, arguments);
        const rest = Array.prototype.slice.call(arguments, 2);
        const label = labelOf(cb, kind === 'setInterval' ? 'int' : 'to');
        return raw(function () {
          const a = performance.now(), l0 = layoutN, prev = cur;
          cur = label;
          try { return cb.apply(null, arguments); }
          finally { bump(label, performance.now() - a, layoutN - l0); cur = prev; }
        }, ms, ...rest);
      };
    }
    // ---- layout-forcing measurement ----
    const rawRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { countLayout(); return rawRects.apply(this, arguments); };
    const rawBox = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { countLayout(); return rawBox.apply(this, arguments); };
    const rawRangeBox = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function () { countLayout(); return rawRangeBox.apply(this, arguments); };
    const rawGCS = window.getComputedStyle.bind(window);
    window.getComputedStyle = function () { styleN++; return rawGCS.apply(null, arguments); };
    // ---- native bridge ----
    try {
      const cap = window.Capacitor;
      if (cap && typeof cap.nativeCallback === 'function') {
        const rawCb = cap.nativeCallback.bind(cap);
        cap.nativeCallback = function () { bridgeN++; return rawCb.apply(null, arguments); };
      }
      if (cap && typeof cap.toNative === 'function') {
        const rawTo = cap.toNative.bind(cap);
        cap.toNative = function () { bridgeN++; return rawTo.apply(null, arguments); };
      }
    } catch (_) {}

    setInterval(report, REPORT_MS);
    try { console.warn('[power] probe on — reporting every ' + (REPORT_MS / 1000) + 's'); } catch (_) {}
  }

  function activeWork() {
    const w = [];
    try { if (window.libraryBlurb?.status?.()) { const s = window.libraryBlurb.status(); w.push('blurbQueue ' + s.done + '/' + s.total); } } catch (_) {}
    try {
      if (window.autoTranscribe?.isActiveFor?.(window._activeTitleId)) {
        const st = window.autoTranscribe.progressState?.();
        const pw = window.autoTranscribe.powerInfo?.();
        const tag = pw ? (' [' + (pw.parked ? 'PARKED' : 'run') + ' ahead=' + Math.round((pw.aheadMs || 0) / 60000) + 'm ' + pw.thermal + (pw.charging ? ' charging' : '') + (pw.lowPower ? ' lowPower' : '') + (pw.unlimited ? ' unlimited' : '') + ']') : '';
        w.push((st ? ('TRANSCRIBING ' + Math.round((st.progress || 0) * 100) + '% cov' + st.coveragePct + '%') : 'transcribe-idle') + tag);
      }
    } catch (_) {}
    try { if (window._bgPlaying) w.push('audio'); } catch (_) {}
    try { const b = document.body.classList; w.push(b.contains('mode-read') ? 'read' : b.contains('mode-audio') ? 'audio-mode' : b.contains('mode-card') ? 'card' : '?'); } catch (_) {}
    try { if (document.hidden) w.push('hidden'); } catch (_) {}
    return w.join(' ');
  }

  function report() {
    const dt = (performance.now() - t0) / 1000;
    if (dt < 1) return;
    let total = 0; for (const b of buckets.values()) total += b.ms;
    // Rank by JS ms, but show layout counts — a cheap-in-JS callback that
    // forces hundreds of layouts is the expensive one on this engine.
    const rows = [...buckets.entries()].sort((a, b) => (b[1].ms + b[1].lay * 0.05) - (a[1].ms + a[1].lay * 0.05)).slice(0, 6)
      .map(([l, b]) => l.slice(0, 42) + ' ' + Math.round(b.ms / dt) + 'ms/s ×' + Math.round(b.n / dt) + (b.lay ? ' lay=' + Math.round(b.lay / dt) : ''));
    const layRows = [...layByOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([l, n]) => l.slice(0, 42) + '=' + Math.round(n / dt));
    try {
      console.warn('[power] busy=' + Math.round(total / dt) + 'ms/s (' + Math.round(100 * total / (dt * 1000)) + '% cpu) fps=' + Math.round(rafN / dt) +
        ' rafMs/s=' + Math.round(rafMs / dt) + ' layout/s=' + Math.round(layoutN / dt) + ' style/s=' + Math.round(styleN / dt) + ' bridge/s=' + Math.round(bridgeN / dt) + ' | ' + activeWork());
      for (const r of rows) console.warn('[power]   ' + r);
      if (layRows.length) console.warn('[power]   layout by: ' + layRows.join('  '));
    } catch (_) {}
    buckets.clear(); layByOwner.clear(); rafN = 0; rafMs = 0; layoutN = 0; bridgeN = 0; styleN = 0; t0 = performance.now();
  }

  // Debug builds turn it on without the flag.
  try {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!on && bg?.deviceModel) bg.deviceModel().then((r) => { if (r && r.debugBuild && !on) { on = true; start(); } }).catch(() => {});
  } catch (_) {}
  if (on) start();
  window.kpower = { report, on: () => on };
})();
