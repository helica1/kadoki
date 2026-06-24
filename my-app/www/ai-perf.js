// ai-perf.js — LIGHT always-on perf probe for diagnosing UI lag on device
// (no Safari Inspector needed). Trimmed after diagnosis: the heavy
// instrumentation (getBoundingClientRect/offset/event/MutationObserver
// prototype patches, a document-wide observer, a CPU busy-loop, a continuous
// rAF beat) was itself overhead + a confound and has been REMOVED.
//
// What remains is cheap:
//   - a 500ms interval stall sampler (event-loop drift)
//   - slow setInterval/setTimeout callbacks (>20ms)  [~2 perf.now/callback]
//   - blobStore IndexedDB ops (>30ms or >200KB)
//   - manual marks via window.kperf.mark(label, ms, extra)
//   - window._kaiAiPaused kill switch (toggled from the viewer) — gates the
//     AI loops so we can A/B whether they're the cause.
// View/copy via Preferences → AI assistant → "Perf log", or window.kperf.show().
(function () {
  'use strict';

  const BUF_MAX = 600;
  const buf = [];
  const t0 = Date.now();

  function push(kind, label, ms, extra) {
    try {
      buf.push({
        t: Date.now() - t0,
        kind,
        label: String(label || '?').replace(/\s+/g, ' ').slice(0, 90),
        ms: Math.round(ms * 10) / 10,
        x: extra == null ? '' : String(extra).slice(0, 40),
      });
      if (buf.length > BUF_MAX) buf.splice(0, 150);
    } catch (_) {}
  }

  const nativeSetInterval = window.setInterval.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);

  // ---- 1) event-loop stall sampler (interval based, cheap) ------------------------
  const SAMPLE_MS = 500;
  let last = performance.now();
  nativeSetInterval(function kperfSampler() {
    const now = performance.now();
    const lag = now - last - SAMPLE_MS;
    if (lag > 150 && !document.hidden) push('stall', 'event-loop stall', lag);
    last = now;
  }, SAMPLE_MS);

  // ---- 2) slow timer-callback wrapping (lightweight) ------------------------------
  function wrapFn(fn, kind) {
    if (typeof fn !== 'function') return fn;
    let label = fn.name;
    if (!label) { try { label = String(fn).slice(0, 60); } catch (_) { label = '?'; } }
    return function () {
      const a = performance.now();
      try { return fn.apply(this, arguments); }
      finally {
        const d = performance.now() - a;
        if (d > 20) push(kind, label, d);
      }
    };
  }
  window.setInterval = function (fn, ms) {
    const rest = Array.prototype.slice.call(arguments, 2);
    return nativeSetInterval.apply(window, [wrapFn(fn, 'interval'), ms].concat(rest));
  };
  window.setTimeout = function (fn, ms) {
    const rest = Array.prototype.slice.call(arguments, 2);
    return nativeSetTimeout.apply(window, [wrapFn(fn, 'timeout'), ms].concat(rest));
  };

  // ---- 3) blobStore wrapper (lazy — blob-store.js loads after us) -------------------
  let wrappedBS = false;
  nativeSetInterval(function kperfWrapBS() {
    try {
      if (wrappedBS || !window.blobStore) return;
      wrappedBS = true;
      ['get', 'set', 'remove'].forEach(function (op) {
        const orig = window.blobStore[op];
        if (typeof orig !== 'function') return;
        window.blobStore[op] = function (key, val) {
          const a = performance.now();
          const p = orig.apply(this, arguments);
          try {
            if (p && p.then) {
              p.then(function (r) {
                const d = performance.now() - a;
                const size = op === 'set'
                  ? (val ? String(val).length : 0)
                  : (typeof r === 'string' ? r.length : 0);
                if (d > 30 || size > 200000) {
                  push('idb', op + ' ' + key, d, size ? Math.round(size / 1024) + 'KB' : '');
                }
              }, function () {});
            }
          } catch (_) {}
          return p;
        };
      });
    } catch (_) {}
  }, 2000);

  // ---- report / overlay --------------------------------------------------------------
  function aggregate(kinds) {
    const agg = {};
    for (const e of buf) {
      if (kinds.indexOf(e.kind) < 0) continue;
      const k = e.kind + '|' + e.label;
      const a = agg[k] || (agg[k] = { kind: e.kind, label: e.label, n: 0, total: 0, max: 0, x: e.x });
      a.n++; a.total += e.ms; if (e.ms > a.max) { a.max = e.ms; a.x = e.x; }
    }
    return Object.values(agg).sort((a, b) => b.total - a.total);
  }

  function dump() {
    const lines = [];
    const up = Math.round((Date.now() - t0) / 1000);
    lines.push('kadoki perf log — up ' + up + 's — AI loops ' +
               (window._kaiAiPaused ? 'PAUSED' : 'running') + ' — ' + navigator.userAgent);
    const stalls = buf.filter(e => e.kind === 'stall');
    const stTotal = Math.round(stalls.reduce((s, e) => s + e.ms, 0));
    lines.push('');
    lines.push('== STALLS: ' + stalls.length + ' (' + stTotal + 'ms total) — worst recent ==');
    stalls.slice(-15).forEach(e => lines.push('  +' + Math.round(e.t / 1000) + 's  ' + Math.round(e.ms) + 'ms'));
    lines.push('');
    lines.push('== SLOW TIMER CALLBACKS / MARKS (aggregated) ==');
    aggregate(['interval', 'timeout', 'mark']).slice(0, 20).forEach(a =>
      lines.push('  ' + a.kind + '  ×' + a.n + '  total ' + Math.round(a.total) + 'ms  max ' +
                 Math.round(a.max) + 'ms  ' + a.label + (a.x ? ('  [' + a.x + ']') : '')));
    lines.push('');
    lines.push('== SLOW / BIG IndexedDB OPS ==');
    aggregate(['idb']).slice(0, 18).forEach(a =>
      lines.push('  ×' + a.n + '  total ' + Math.round(a.total) + 'ms  max ' + Math.round(a.max) +
                 'ms  ' + a.label + (a.x ? ('  [' + a.x + ']') : '')));
    lines.push('');
    lines.push('== RUNNING ANIMATIONS (right now) ==');
    try {
      const anims = (document.getAnimations && document.getAnimations()) || [];
      const agg = {};
      for (const an of anims) {
        try {
          const name = an.animationName || (an.transitionProperty ? ('transition:' + an.transitionProperty) : 'anim');
          let tgt = '?';
          try {
            const el = an.effect && an.effect.target;
            if (el) tgt = el.id ? ('#' + el.id) : (el.tagName.toLowerCase() +
              (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''));
          } catch (_) {}
          const k = name + ' on ' + tgt + (an.playState === 'running' ? '' : ' (' + an.playState + ')');
          agg[k] = (agg[k] || 0) + 1;
        } catch (_) {}
      }
      const keys = Object.keys(agg);
      if (!keys.length) lines.push('  (none)');
      keys.slice(0, 20).forEach(k => lines.push('  ×' + agg[k] + '  ' + k));
    } catch (e) { lines.push('  (getAnimations unavailable)'); }
    lines.push('');
    lines.push('== OPEN AI OVERLAYS ==');
    ['aiSummaryOverlay', 'kchapterView', 'kcharsScreen', 'bookmarksOverlay', 'kcharPopup']
      .forEach(id => { if (document.getElementById(id)) lines.push('  #' + id); });
    return lines.join('\n');
  }

  function show() {
    try {
      const old = document.getElementById('kperfOverlay');
      if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'kperfOverlay';
      ov.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:100002;display:flex;' +
        'flex-direction:column;padding:calc(10px + env(safe-area-inset-top,0px)) 10px ' +
        'calc(10px + env(safe-area-inset-bottom,0px));box-sizing:border-box;';
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;';
      const mkB = (txt, fn) => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'background:#1c1c24;border:1px solid #333;border-radius:8px;' +
          'color:#aaa;font-size:.8rem;padding:6px 14px;cursor:pointer;';
        b.addEventListener('click', fn);
        return b;
      };
      const ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = dump();
      ta.style.cssText =
        'flex:1;background:#0d0d12;color:#9c9;border:1px solid #2a2a2a;border-radius:8px;' +
        'font-family:monospace;font-size:10px;line-height:1.5;padding:8px;white-space:pre;' +
        'overflow:auto;-webkit-overflow-scrolling:touch;';
      const aiBtn = mkB(window._kaiAiPaused ? 'AI: paused' : 'AI: running', () => {
        window._kaiAiPaused = !window._kaiAiPaused;
        aiBtn.textContent = window._kaiAiPaused ? 'AI: paused' : 'AI: running';
        aiBtn.style.color = window._kaiAiPaused ? '#e08a8a' : '#aaa';
        try { if (window._kaiAiPaused && window.aiCharsRead) window.aiCharsRead.clear(); } catch (_) {}
        push('mark', 'AI loops ' + (window._kaiAiPaused ? 'PAUSED' : 'RESUMED'), 0);
      });
      if (window._kaiAiPaused) aiBtn.style.color = '#e08a8a';
      bar.appendChild(aiBtn);
      bar.appendChild(mkB('Copy', () => {
        try {
          ta.select(); ta.setSelectionRange(0, ta.value.length);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(ta.value);
          } else { document.execCommand('copy'); }
        } catch (_) {}
      }));
      bar.appendChild(mkB('Refresh', () => { ta.value = dump(); }));
      bar.appendChild(mkB('Clear', () => { buf.length = 0; ta.value = dump(); }));
      bar.appendChild(mkB('Close', () => ov.remove()));
      ov.appendChild(bar);
      ov.appendChild(ta);
      document.body.appendChild(ov);
    } catch (_) {}
  }

  window.kperf = {
    mark(label, ms, extra) { push('mark', label, ms, extra); },
    show,
    dump,
  };
})();
