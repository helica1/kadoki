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
  // Android: the same menu model, shown as a native Material bottom sheet
  // (KadokiChromePlugin) when the web hamburger is tapped; the web button
  // stays (no overlay button, no anchor tracking there).
  const ANDROID = !window.KADOKI_NATIVE_MENU && !window.KADOKI_MAC && !window.KADOKI_VISION &&
    window.Capacitor?.getPlatform?.() === 'android' && !!window.Capacitor?.Plugins?.KadokiChrome;
  if (!window.KADOKI_NATIVE_MENU && !ANDROID) return;
  if (!ANDROID) document.documentElement.classList.add('kadoki-native-menu');
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativeMenu.postMessage(msg); } catch (_) {} };

  let actions = new Map();

  // Pinned titles at the head of the menu: a title switch without opening the
  // Library (same set as the Library's pinned row: up to 3, most recently
  // opened first). Covers as small thumbnails, cached.
  const pinThumbs = new Map();
  function pinThumb(t) {
    const src = t.attachments?.cover?.dataUri;
    if (!src) return Promise.resolve('');
    const key = t.id + ':' + src.length;
    if (pinThumbs.has(key)) return pinThumbs.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const h = 96, w = Math.max(1, Math.round(img.width * h / img.height));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (_) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
    pinThumbs.set(key, p);
    return p;
  }
  async function pinnedRows() {
    let all = [];
    try { all = await window.titleStore.list(); } catch (_) { return []; }
    let pins = all.filter(t => t.pinnedAt && !t.cloudOnly)
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)).slice(0, 3);
    // Nothing pinned (pins are per device): the three most recently opened
    // titles, so the quick switch is always there.
    if (!pins.length) {
      pins = all.filter(t => !t.cloudOnly && t.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)).slice(0, 3);
    }
    const rows = [];
    for (const t of pins) {
      const id = 'pin:' + t.id;
      actions.set(id, () => {
        if (t.id === window._activeTitleId) return;
        try { window.loadTitleFromLibrary(t); } catch (e) { console.warn('pinned open:', e); }
      });
      rows.push({ id, label: t.name || 'Untitled', subtitle: t.author || '', image: await pinThumb(t),
                  checked: t.id === window._activeTitleId });
    }
    return rows;
  }

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
    const rows = window.shellMenuEntries().map(conv);
    const pins = await pinnedRows();
    return JSON.stringify(pins.length ? [...pins, { divider: true }, ...rows] : rows);
  };

  window.__kadokiMenuSelect = function (id) {
    const fn = actions.get(id);
    if (!fn) return;
    try { fn(); } catch (e) { console.warn('menu action:', e); }
  };

  if (ANDROID) {
    let busy = 0;
    const wrapOpen = () => {
      const orig = window.openShellMoreMenu;
      if (typeof orig !== 'function' || orig._kNat) return;
      const nat = async function () {
        // The button fires twice per tap (inline onclick + shell.js listener).
        if (Date.now() - busy < 600) return;
        busy = Date.now();
        try {
          const rows = JSON.parse(await window.__kadokiMenuModel());
          busy = Date.now();
          const br = document.getElementById('shellMoreBtn')?.getBoundingClientRect();
          const anchor = br ? { x: br.left, y: br.top, w: br.width, h: br.height } : null;
          const r = await window.Capacitor.Plugins.KadokiChrome.showMenu({ rows, anchor });
          if (r && r.id) window.__kadokiMenuSelect(r.id);
        } catch (e) {
          console.warn('native menu failed, web menu instead:', e);
          busy = 0;
          return orig.apply(this, arguments);
        }
      };
      nat._kNat = true;
      window.openShellMoreMenu = nat;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapOpen);
    else wrapOpen();
    setTimeout(wrapOpen, 1500);
    return;
  }

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
        // The native button is a 40 pt circle centred here — larger than the
        // web button — so test its whole footprint: anything but the toolbar
        // under any part of it (the dictionary popup's corner) hides it.
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = 16;
        const head = btn.closest('#appHeader') || btn.parentElement;
        const top = [[0, 0], [-d, -d], [d, -d], [-d, d], [d, d], [-d, 0], [d, 0]].every(([dx, dy]) => {
          const hit = document.elementFromPoint(cx + dx, cy + dy);
          return !!hit && (hit === btn || btn.contains(hit) || (head && head.contains(hit)) || (dy !== 0 && hit === document.documentElement));
        });
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
      // The dictionary popup is created once and then shown / hidden through
      // its own style, which the body observer doesn't see.
      const popObs = new MutationObserver(schedule);
      let popWatched = null;
      const watchPopup = () => {
        const p = document.getElementById('dictPopup');
        if (p && p !== popWatched) { popWatched = p; popObs.observe(p, { attributes: true, attributeFilter: ['class', 'style'] }); }
      };
      new MutationObserver(() => { watchPopup(); schedule(); }).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
      watchPopup();
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
