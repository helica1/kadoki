// Native iOS menu for the hamburger button.
//
// On iOS the app shell (NativeChrome.swift) lays a transparent UIButton over
// #shellMoreBtn whose tap opens a real UIMenu. This file is the web half:
//  - window.__kadokiMenuModel() hands Swift the rows of shellMenuEntries()
//    (shell.js — the same list the web menu draws), with live badge counts;
//  - window.__kadokiMenuSelect(id) runs the chosen row;
//  - the hamburger's position is reported whenever it may have moved, and the
//    native button is live ONLY while the hamburger is the top-most thing at
//    that spot, so it can never swallow a tap meant for a popup over it.
// Inert unless native injected window.KADOKI_NATIVE_MENU (iOS only; Android,
// the Mac and Vision keep the web menu).
(function () {
  'use strict';
  if (!window.KADOKI_NATIVE_MENU) return;
  document.documentElement.classList.add('kadoki-native-menu');
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativeMenu.postMessage(msg); } catch (_) {} };

  let actions = new Map();

  window.__kadokiMenuModel = async function () {
    // Video Titles: freeze on the current frame while the menu is up (same as
    // the web menu's open).
    try {
      if (window.kadokiVideoMode?.isVideoTitle?.()) {
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        const s = await bg?.getState?.();
        if (s?.playing) bg.pause({ fadeMs: 80 });
      }
    } catch (_) {}
    let unseen = null, srsDue = 0;
    try { unseen = await window.aiUnseenForActiveTitle(); } catch (_) {}
    try { const c = await window.vocabSrs?.counts?.(); srsDue = (c && c.due) || 0; } catch (_) {}
    const busy = (() => {
      try {
        const st = window._kaiProcStatus;
        return !!(st && st.busy && st.titleId === window._activeTitleId);
      } catch (_) { return false; }
    })();
    actions = new Map();
    const conv = (it) => {
      if (it.divider) return { divider: true };
      const o = { id: it.id, label: it.label, icon: it.icon || '', top: !!it.top };
      if (it.children) o.children = it.children.map(conv);
      else actions.set(it.id, it.fn);
      let n = 0;
      if (it.countKey) n = Number(unseen && unseen[it.countKey]) || 0;
      if (it.id === 'srs') n = srsDue;
      if (n > 0) o.badge = String(n);
      if (it.procRow && busy) o.subtitle = window.i18n.t('menu.processing', 'Processing…');
      return o;
    };
    return JSON.stringify(window.shellMenuEntries().map(conv));
  };

  window.__kadokiMenuSelect = function (id) {
    const fn = actions.get(id);
    if (!fn) return;
    try { fn(); } catch (e) { console.warn('menu action:', e); }
  };

  // ---- anchor tracking ----
  let last = '';
  let queued = false;
  // While the header slides (chrome hide / show) the button is mid-flight;
  // native runs the same slide itself, so keep reporting the resting spot.
  let resting = null;
  const headerMoving = () => {
    const h = document.getElementById('appHeader');
    const t = h ? getComputedStyle(h).transform : 'none';
    return !!t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
  };
  function report() {
    queued = false;
    const btn = document.getElementById('shellMoreBtn');
    const chrome = !document.body.classList.contains('chrome-hidden');
    let msg = { visible: false, chrome };
    // A native Preferences / Library screen covers the hamburger, but the web
    // page under it doesn't know (the web panels stay invisible or closed).
    const cl = document.body.classList;
    if (btn && !document.hidden && !cl.contains('prefs-open') && !cl.contains('native-library-open')) {
      const r = btn.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const top = !!(hit && (hit === btn || btn.contains(hit)));
        msg = { visible: top, x: r.left, y: r.top, w: r.width, h: r.height, dot: !!btn.querySelector('.kai-reddot-btn'), chrome };
      }
      if (resting && (!chrome || headerMoving())) msg = { ...resting, chrome };
      else if (msg.visible) resting = msg;
    }
    const key = JSON.stringify(msg);
    if (key !== last) { last = key; post(msg); }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  }
  window.__kadokiMenuAnchorCheck = schedule;
  // Popups are appended to <body>; chrome hide/show and modes flip body
  // classes; the toolbar can reflow on resize and rotation.
  const start = () => {
    try {
      new MutationObserver(schedule).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
      const bar = document.getElementById('shellMoreBtn')?.parentElement;
      if (bar) new MutationObserver(schedule).observe(bar, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style'] });
    } catch (_) {}
    window.addEventListener('resize', schedule);
    window.addEventListener('shell:mode-change', schedule);
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('transitionend', schedule, true);
    // Safety net for changes no event covers (a popup shown by toggling a
    // pre-existing element's display deep in the tree).
    setInterval(() => { if (!document.hidden) schedule(); }, 1500);
    schedule();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
