// Native iOS toolbar controls (NativeToolbar in NativeChrome.swift): the mode
// tabs as a UISegmentedControl and play / pause as a native button, laid over
// the web controls (which stay in place, invisible, so layout and hit tests
// don't change). Every tap is forwarded to the web control itself, so mode
// switching and playback run exactly the code they always did.
// This file reports where the controls are, whether each is the top-most
// thing at its spot (never steal a tap meant for a popup over it), which tabs
// the title shows, the selected one, its accent and the play state.
// Inert unless native injected window.KADOKI_NATIVE_TOOLBAR (iPhone / iPad).
(function () {
  'use strict';
  if (!window.KADOKI_NATIVE_TOOLBAR) return;
  document.documentElement.classList.add('kadoki-native-toolbar');
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativeToolbar.postMessage(msg); } catch (_) {} };

  const root = () => getComputedStyle(document.documentElement);
  const accent = (mode) => {
    const v = { card: '--accent-card', read: '--accent-read', audio: '--accent-audio', video: '--accent-audio' }[mode] || '--accent-read';
    return root().getPropertyValue(v).trim() || '#4caf50';
  };
  // The native control may be larger than the web one (the play capsule
  // grows leftward), so `area` (offsets from the web rect) is checked too:
  // only the control itself or the toolbar may be under it, never a popup.
  const onTop = (el, area) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const head = document.getElementById('appHeader');
    const ok = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || (!!area && !!head && head.contains(hit)));
    };
    if (!ok(r.left + r.width / 2, r.top + r.height / 2)) return null;
    if (area) {
      const y0 = r.top + r.height / 2;
      for (const [x, dy] of area(r)) if (!ok(x, y0 + dy)) return null;
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const covered = () => {
    const cl = document.body.classList;
    return document.hidden || cl.contains('prefs-open') || cl.contains('native-library-open');
  };

  // While the header slides (chrome hide / show) its controls are mid-flight:
  // native runs the same slide itself, so keep reporting the resting state.
  const chromeShown = () => !document.body.classList.contains('chrome-hidden');
  const headerMoving = () => {
    const h = document.getElementById('appHeader');
    const t = h ? getComputedStyle(h).transform : 'none';
    return !!t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
  };
  let resting = null;

  function state() {
    const out = { tabs: { visible: false }, play: { visible: false }, chrome: chromeShown() };
    if (covered()) return out;
    if (resting && (!out.chrome || headerMoving())) return { ...resting, chrome: out.chrome };
    const bar = document.getElementById('shellModeTabs');
    if (bar) {
      const tabs = [...bar.querySelectorAll('.mode-tab')].filter(t => t.dataset.hidden !== '1' && getComputedStyle(t).display !== 'none');
      const rect = tabs.length ? onTop(bar) : null;
      if (rect) {
        const sel = tabs.findIndex(t => t.dataset.active === '1');
        out.tabs = {
          visible: true, ...rect,
          items: tabs.map(t => ({ mode: t.dataset.mode, label: t.textContent.trim(), disabled: t.dataset.empty === '1' })),
          selected: sel,
          accent: accent(sel >= 0 ? tabs[sel].dataset.mode : ''),
          accents: Object.fromEntries(tabs.map(t => [t.dataset.mode, accent(t.dataset.mode)])),
        };
      }
    }
    const play = document.getElementById('shellPlayBtn');
    if (play && getComputedStyle(play).display !== 'none') {
      // Native capsule: x from right−76 to right−14, ±17 tall (NativeChrome.swift).
      const rect = onTop(play, (r) => [[r.right - 72, -13], [r.right - 72, 13], [r.right - 18, -13], [r.right - 18, 13]]);
      if (rect) {
        const pause = play.querySelector('[data-role="pause"]');
        const active = document.querySelector('#shellModeTabs .mode-tab[data-active="1"]');
        out.play = { visible: true, ...rect, playing: !!(pause && getComputedStyle(pause).display !== 'none'), accent: accent(active ? active.dataset.mode : '') };
      }
    }
    if (out.chrome && !headerMoving()) resting = { tabs: out.tabs, play: out.play };
    return out;
  }

  let last = '', queued = false;
  function report() {
    queued = false;
    const s = state();
    const k = JSON.stringify(s);
    if (k !== last) { last = k; post(s); }
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(report); } }

  window.__kadokiToolbarTab = (mode) => {
    const tab = document.querySelector('#shellModeTabs .mode-tab[data-mode="' + mode + '"]');
    if (tab) tab.click();
    schedule();
  };
  window.__kadokiToolbarPlay = () => { document.getElementById('shellPlayBtn')?.click(); schedule(); };
  window.__kadokiToolbarChooser = () => { try { window.openTabChooser?.(); } catch (_) {} };

  const start = () => {
    try {
      const head = document.getElementById('appHeader');
      if (head) new MutationObserver(schedule).observe(head, { subtree: true, attributes: true, childList: true, characterData: true });
      // The dictionary popup shows / hides through its own style.
      const popObs = new MutationObserver(schedule);
      let popWatched = null;
      const watchPopup = () => {
        const p = document.getElementById('dictPopup');
        if (p && p !== popWatched) { popWatched = p; popObs.observe(p, { attributes: true, attributeFilter: ['class', 'style'] }); }
      };
      new MutationObserver(() => { watchPopup(); schedule(); }).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
      watchPopup();
    } catch (_) {}
    window.addEventListener('resize', schedule);
    window.addEventListener('shell:mode-change', schedule);
    window.addEventListener('kai:lang', schedule);
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('transitionend', schedule, true);
    setInterval(() => { if (!document.hidden) schedule(); }, 1500);
    schedule();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
