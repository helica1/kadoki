// panel-bridge.js — detachable panel windows (visionOS).
//
// Timeline & Scenes, the chapter summary and the Characters screen can each be
// popped OUT of the main window into a real, system-placeable window, the way
// the dictionary already can. Unlike the dictionary — whose small, static popup
// HTML is MIRRORED into a shared webview — a panel window hosts its own webview
// on the SAME capacitor://localhost origin (KadokiPanelHost, MainViewController
// .swift), so it renders the genuine panel off the genuine shared IndexedDB:
// images, dictionary lookups, scroll position and live refresh all intact.
//
// ONE file, TWO roles, chosen by window.KADOKI_PANEL (set only by panel.html):
//   • main-window role  — exposes kadokiPanel.popOut(kind), answers the panel's
//     requests, and pushes the live playhead/mode so the panel's "now" marker
//     tracks the book.
//   • panel-window role — installs read-only shims for the globals the panels
//     expect from the app shell (they are all typeof-guarded call sites, so an
//     absent one degrades rather than throws), then mounts the requested panel.
//
// Transport is a NATIVE RELAY, not BroadcastChannel: both directions hop through
// KadokiPanelHost (panel → webkit.messageHandlers.kadokiPanel → main webview,
// main → BackgroundAudio.panelWindow{action:'post'} → panel webview). That is
// fully under our control and does not depend on WebKit routing a channel
// between two separate web content processes.
//
// PURE READER (never-lose-place invariant): the panel window must never write
// position, stats or coverage state — see the KADOKI_PANEL guards in stats.js,
// mode-coverage.js, event-log.js, ai-chunks.js and ai-processor.js.
(function () {
  'use strict';

  const KIND = window.KADOKI_PANEL || null;
  const IS_PANEL = !!KIND;
  const KINDS = ['timeline', 'summary', 'characters'];

  function BG() {
    try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio; }
    catch (_) { return null; }
  }

  // ---------------------------------------------------------------- main side
  if (!IS_PANEL) {
    const detached = new Set();
    let liveTimer = null;

    // Vision only: everywhere else the panels stay in-window overlays and the
    // pop-out affordance never renders.
    function available() { return !!window.KADOKI_VISION && !!BG() && typeof BG().panelWindow === 'function'; }

    function post(kind, obj) {
      try { BG().panelWindow({ action: 'post', kind, msg: JSON.stringify(obj) }); } catch (_) {}
    }

    // Everything the panel needs to render against the book the user is
    // actually in. Cheap enough to push on a slow timer.
    function liveState() {
      const st = { t: 'live' };
      try {
        st.titleId = window._activeTitleId || null;
        const cl = document.body.classList;
        st.mode = cl.contains('mode-read') ? 'read' : (cl.contains('mode-audio') ? 'audio' : (cl.contains('mode-card') ? 'card' : null));
        st.cueIdx = Number.isFinite(window._lastAudioCueIdx) ? window._lastAudioCueIdx : null;
        st.cardIndex = Number.isFinite(window.currentCardIndex) ? window.currentCardIndex : null;
        st.abPath = window._srtAbPath || window._pagedAudioPath || '';
        st.rate = Number(window.audioPlaybackRate) || 1;
        st.playing = !!window._bgPlaying;
        try { const ap = window.getAudioProgress && window.getAudioProgress(); if (ap && Number.isFinite(ap.ms)) st.audioMs = ap.ms; } catch (_) {}
        try { const loc = window.pagedGetReadLocation && window.pagedGetReadLocation(); if (loc && Number.isFinite(loc.jpOff)) st.jpOff = loc.jpOff; } catch (_) {}
      } catch (_) {}
      return st;
    }

    function pushLive() {
      if (!detached.size) return;
      const st = liveState();
      for (const k of detached) post(k, st);
    }

    function armLive() {
      if (liveTimer || !detached.size) return;
      liveTimer = setInterval(() => { try { if (!document.hidden) pushLive(); } catch (_) {} }, 2000);
    }
    function disarmLive() {
      if (liveTimer && !detached.size) { clearInterval(liveTimer); liveTimer = null; }
    }

    // Actions a panel cannot perform itself — they need the audio engine, the
    // reader, or a Capacitor plugin, all of which live here.
    const API = {
      state() { return liveState(); },
      // Jump the BOOK to a chapter (the panel's own row/▶ affordance).
      async goToChapter(a) {
        const o = a || {};
        try {
          if (Number.isFinite(o.ms)) {
            const bg = BG();
            if (bg && typeof bg.seek === 'function') {
              window._audioStatsSeekTs = Date.now();   // jumped-over span wasn't heard
              await bg.seek({ ms: Math.max(0, Math.round(o.ms)) });
            }
          }
        } catch (_) {}
        try {
          if (typeof window.pagedJumpToBookmark === 'function' && Number.isFinite(o.chunkIdx)) {
            await window.pagedJumpToBookmark({ chunkIdx: o.chunkIdx, jpOff: o.jpOff });
          }
        } catch (_) {}
        return true;
      },
      async bgGetState() {
        try { const bg = BG(); if (bg && bg.getState) return await bg.getState(); } catch (_) {}
        return null;
      },
      async sendToAnki(a) {
        try { if (typeof window.sendToAnki === 'function') return await window.sendToAnki.apply(null, (a && a.args) || []); } catch (_) {}
        return false;
      },
      toast(a) {
        try { if (typeof window.showToast === 'function') window.showToast((a && a.msg) || '', (a && a.ms) || 2000); } catch (_) {}
        return true;
      },
    };

    // panel → main (KadokiPanelHost relays into this)
    window.__kadokiPanelFromWindow = function (json) {
      let m = null;
      try { m = JSON.parse(json); } catch (_) { return; }
      if (!m || m.t !== 'req') return;
      const fn = API[m.fn];
      Promise.resolve()
        .then(() => (typeof fn === 'function' ? fn(m.args) : null))
        .then((val) => post(m.kind || KINDS[0], { t: 'res', id: m.id, ok: true, val: val === undefined ? null : val }))
        .catch((e) => post(m.kind || KINDS[0], { t: 'res', id: m.id, ok: false, err: String((e && e.message) || e) }));
    };

    // Native tells us a panel window closed (the user closed it, or the main
    // window is going away). We do NOT re-open the panel in-window: the user
    // closed it, so it stays closed — the next tap on Timeline / Characters /
    // the summary button opens an in-window overlay again as normal.
    window.addEventListener('kadokiPanelClosed', (e) => {
      let d = e && e.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
      const kind = (e && e.kind) || (d && d.kind) || '';
      if (!kind) return;
      detached.delete(kind);
      disarmLive();
      try { window.dispatchEvent(new CustomEvent('kai:panel-docked', { detail: { kind } })); } catch (_) {}
    });

    window.kadokiPanel = {
      available,
      isDetached: (kind) => detached.has(kind),
      // Pop a panel out. The caller closes its own in-window overlay — this
      // only asks native for the window and starts feeding it.
      popOut(kind) {
        if (!available() || KINDS.indexOf(kind) < 0) return false;
        try { BG().panelWindow({ action: 'open', kind }); } catch (_) { return false; }
        detached.add(kind);
        armLive();
        setTimeout(pushLive, 400);   // the window boots and asks for state itself; this just warms it
        return true;
      },
      dock(kind) {
        try { BG().panelWindow({ action: 'close', kind }); } catch (_) {}
        detached.delete(kind);
        disarmLive();
        return true;
      },
      // Header button for a panel that can be popped out. Returns null off
      // Vision (or when the plugin method is missing), so call sites just skip it.
      makeButton(kind, onBeforePop) {
        if (!available()) return null;
        const b = document.createElement('button');
        b.textContent = '⤢';
        b.title = window.i18n.t('tl.pop_out_window', 'Open in its own window');
        b.style.cssText =
          'background:none;border:1px solid #333;border-radius:8px;color:#aab4dd;' +
          'font-size:1.1rem;padding:7px 13px;cursor:pointer;line-height:1.1;';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!window.kadokiPanel.popOut(kind)) return;
          try { if (typeof onBeforePop === 'function') onBeforePop(); } catch (_) {}
        });
        return b;
      },
    };
    return;
  }

  // --------------------------------------------------------------- panel side
  document.body.classList.add('kadoki-panel-window');

  let _seq = 0;
  const _pending = new Map();

  function send(obj) {
    try {
      window.webkit.messageHandlers.kadokiPanel.postMessage({ kind: KIND, msg: JSON.stringify(obj) });
      return true;
    } catch (_) { return false; }
  }
  function req(fn, args) {
    return new Promise((resolve) => {
      const id = ++_seq;
      _pending.set(id, resolve);
      // Never hang a UI action on a main window that didn't answer.
      setTimeout(() => { if (_pending.has(id)) { _pending.delete(id); resolve(null); } }, 6000);
      if (!send({ t: 'req', id, kind: KIND, fn, args })) { _pending.delete(id); resolve(null); }
    });
  }
  function closeWindow() { try { window.webkit.messageHandlers.kadokiPanel.postMessage({ kind: KIND, action: 'close' }); } catch (_) {} }

  // Adopt the main window's live position/mode so the panel's "now" marker,
  // current-chapter resolution and mode-colored spine track the real book.
  function applyLive(st) {
    try {
      if (st.titleId) window._activeTitleId = st.titleId;
      if (Number.isFinite(st.cueIdx)) window._lastAudioCueIdx = st.cueIdx;
      if (Number.isFinite(st.cardIndex)) window.currentCardIndex = st.cardIndex;
      if (st.abPath) { window._srtAbPath = st.abPath; window._pagedAudioPath = st.abPath; }
      if (Number.isFinite(st.rate)) window.audioPlaybackRate = st.rate;
      window._bgPlaying = !!st.playing;
      _liveMs = Number.isFinite(st.audioMs) ? st.audioMs : _liveMs;
      _liveJp = Number.isFinite(st.jpOff) ? st.jpOff : _liveJp;
      const cl = document.body.classList;
      for (const m of ['mode-read', 'mode-audio', 'mode-card']) cl.remove(m);
      if (st.mode) cl.add('mode-' + st.mode);
    } catch (_) {}
  }
  let _liveMs = null, _liveJp = null;

  window.__kadokiPanelRecv = function (json) {
    let m = null;
    try { m = JSON.parse(json); } catch (_) { return; }
    if (!m) return;
    if (m.t === 'res') {
      const r = _pending.get(m.id);
      if (r) { _pending.delete(m.id); r(m.ok ? m.val : null); }
      return;
    }
    if (m.t === 'live') applyLive(m);
  };

  // ---- read-only shims for the app-shell globals the panels reach for -------
  // Every one of these is a typeof-guarded call site in the panels, so an absent
  // shim degrades that affordance rather than throwing. The ones defined here
  // are the ones worth routing back to the main window.
  window.showToast = window.showToast || function (msg, ms) {
    try { req('toast', { msg: String(msg || ''), ms: ms || 2000 }); } catch (_) {}
  };
  window.getAudioProgress = function () { return { ms: _liveMs }; };
  window.pagedGetReadLocation = function () { return Number.isFinite(_liveJp) ? { jpOff: _liveJp } : null; };
  window.pagedJumpToBookmark = function (o) { return req('goToChapter', o || {}); };
  window.sendToAnki = function () { return req('sendToAnki', { args: Array.prototype.slice.call(arguments) }); };
  // A minimal BackgroundAudio face: seeking the book and probing whether audio
  // is loaded both belong to the main window. play/pause are deliberately NOT
  // offered — a read-only panel must not take over the book's playback.
  window.Capacitor = window.Capacitor || { Plugins: {} };
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.Capacitor.Plugins.BackgroundAudio = {
    seek: (o) => req('goToChapter', { ms: (o && o.ms) }),
    getState: () => req('bgGetState', {}),
  };

  // ---- mount ---------------------------------------------------------------
  function bootMsg(text) {
    try { const el = document.getElementById('panelBoot'); if (el) el.textContent = text; } catch (_) {}
  }
  function clearBoot() {
    try { const el = document.getElementById('panelBoot'); if (el) el.remove(); } catch (_) {}
  }

  // The panels' axis math reads window._srtCues. The main window populates it at
  // title-open; here it comes from the SAME per-title cache the watch and the
  // chunk mapper already read (SRT_CUES_V1_<titleId>), so an audio-anchored
  // spine works without the app shell ever running.
  async function loadCues(titleId) {
    try {
      if (Array.isArray(window._srtCues) && window._srtCues.length) return;
      const raw = window.blobStore ? await window.blobStore.get('SRT_CUES_V1_' + titleId) : null;
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && Array.isArray(obj.cues) && obj.cues.length) {
        obj.cues.forEach((c, k) => { if (c && c.index == null) c.index = k; });
        window._srtCues = obj.cues;
      }
    } catch (_) {}
  }

  // A panel closing itself (its own ✕, or an outside tap it still honors) should
  // close the WINDOW — otherwise the window would sit there empty. Generic
  // observer rather than patching three separate teardown paths.
  //
  // RE-CHECKED after a beat, never on the first removal: chapter-to-chapter
  // navigation REPLACES #kchapterView (remove, then await, then re-append), and
  // the Timeline panel replaces itself the same way. Reacting to the removal
  // alone would slam the window shut every time the user pressed ‹ or ›.
  function watchForClose(id) {
    try {
      let pending = null;
      const obs = new MutationObserver(() => {
        if (document.getElementById(id)) { if (pending) { clearTimeout(pending); pending = null; } return; }
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          if (!document.getElementById(id)) { obs.disconnect(); closeWindow(); }
        }, 600);
      });
      obs.observe(document.body, { childList: true });
    } catch (_) {}
  }

  async function mount() {
    const st = await req('state', {});
    if (st) applyLive(st);
    const titleId = window._activeTitleId;
    if (!titleId) {
      bootMsg(window.i18n.t('tl.panel_no_title', 'No book is open in the main window.'));
      return;
    }
    await loadCues(titleId);
    try { if (window.i18n && window.i18n.applyStatic) window.i18n.applyStatic(); } catch (_) {}
    let ok = false;
    try {
      if (KIND === 'timeline' && window.aiTimeline && window.aiTimeline.openPanel) {
        ok = (await window.aiTimeline.openPanel()) !== false;
        watchForClose('bookmarksOverlay');
      } else if (KIND === 'summary' && window.aiTimeline && window.aiTimeline.openCurrentChapter) {
        ok = await window.aiTimeline.openCurrentChapter(titleId);
        watchForClose('kchapterView');
      } else if (KIND === 'characters' && window.aiCharsScreen && window.aiCharsScreen.open) {
        ok = (await window.aiCharsScreen.open()) !== false;
        watchForClose('kcharsScreen');
      }
    } catch (e) {
      try { console.log('[panel] mount failed: ' + (e && e.message)); } catch (_) {}
    }
    if (ok) clearBoot();
    else bootMsg(window.i18n.t('tl.panel_mount_failed', 'Nothing to show here yet.'));
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(mount, 60);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(mount, 60));
})();
