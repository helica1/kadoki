// place-diag.js — tiny persistent trail for place-loss reports.
//
// PURE OBSERVER: records every pause / seek / play request made from JS (with
// the calling code's location), every native play-state change and every mode
// switch, with the mode, title and playhead at that moment. The last 60
// entries live in localStorage PLACE_DIAG_V1, readable from a pulled device
// copy. Nothing reads it back; every hook is try/caught.
(function () {
  'use strict';
  const KEY = 'PLACE_DIAG_V1', MAX = 60;
  let buf = null, flushT = 0;
  function load() {
    if (buf) return buf;
    try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { buf = []; }
    if (!Array.isArray(buf)) buf = [];
    return buf;
  }
  function mode() { const m = document.body && document.body.className.match(/\bmode-(\w+)/); return m ? m[1] : ''; }
  function caller() {
    try {
      const lines = String(new Error().stack || '').split("\n").slice(2, 6);
      return lines.map(l => l.replace(/^.*\/(www\/)?/, '').replace(/^\s+|\s+$/g, '').slice(0, 60)).join(' < ');
    } catch (_) { return ''; }
  }
  function note(ev, extra) {
    try {
      const b = load();
      b.push(Object.assign({ ts: Date.now(), ev, m: mode(), t: window._activeTitleId || '', ms: Math.round(window._lastBgPosMs || 0) }, extra || {}));
      if (b.length > MAX) b.splice(0, b.length - MAX);
      clearTimeout(flushT);
      flushT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch (_) {} }, 400);
    } catch (_) {}
  }
  window.placeDiag = { note };

  function wrap() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg || bg._kDiag) return !!bg;
    bg._kDiag = true;
    for (const fn of ['pause', 'resume', 'play', 'seek', 'stop']) {
      const orig = bg[fn];
      if (typeof orig !== 'function') continue;
      bg[fn] = function (o) {
        note(fn, { by: caller(), to: o && Number.isFinite(o.ms) ? Math.round(o.ms) : (o && Number.isFinite(o.startMs) ? Math.round(o.startMs) : undefined) });
        return orig.apply(this, arguments);
      };
    }
    try { bg.addListener('state', (d) => { note('state', { playing: !!(d && d.playing) }); }); } catch (_) {}
    return true;
  }
  if (!wrap()) { const iv = setInterval(() => { if (wrap()) clearInterval(iv); }, 500); setTimeout(() => clearInterval(iv), 15000); }
  window.addEventListener('shell:mode-change', (e) => note('mode', { to: e && e.detail && e.detail.mode }));
  document.addEventListener('visibilitychange', () => {
    note(document.hidden ? 'hidden' : 'visible');
    if (document.hidden) { try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (_) {} }
  });
})();
