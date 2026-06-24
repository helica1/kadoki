// event-log.js — per-title reading-session event log (slice 1 of the AI
// reading-companion plan, docs/ai-reading-companion-plan.md §5).
//
// PURE OBSERVER. This module only ever READS positions/mode/title identity and
// writes its own blobStore key (EVLOG_V1_<titleId>). Nothing in the position or
// restore pipeline may ever read from it — the timeline renderer (later slice)
// is its only consumer. Every entry point is try/caught: a failure here must
// never affect playback, reading, or place-keeping.
//
// Event stream (append-only, compact):
//   { t:'o'|'m'|'c'|'b', ts, m:'card'|'read'|'audio', p:{...}|null }
//   o = open/engage (title open, app foregrounded)
//   m = mode shift   (an 'm' replacing an 'm' <60s old collapses it — the
//                     ">1 min to count" rule, applied at write time)
//   c = close        (background / title switch; flushed immediately because
//                     Android LMK kill follows backgrounding)
//   b = bookmark     (p carries the bookmark's own location)
// Sessions are NOT stored — the renderer derives them (split on o/c and on
// >5 min gaps, drop <1 min segments).
(function () {
  'use strict';

  const KEY_PREFIX = 'EVLOG_V1_';
  const COLLAPSE_MS = 60 * 1000;     // 'm' shorter-lived than this didn't "persist"
  const MAX_EVENTS = 4000;           // per title; oldest dropped
  const FLUSH_DEBOUNCE_MS = 3000;

  // ---- per-title log state ------------------------------------------------
  let curTitleId = null;     // title the in-memory log belongs to
  let log = null;            // { v:1, events:[] } — null until loaded
  let loading = null;        // Promise while the blobStore read is in flight
  let pending = [];          // events queued while loading
  let flushTimer = null;
  let dirty = false;

  function storeKey(id) { return KEY_PREFIX + id; }

  function currentMode() {
    try {
      if (window.stats && typeof window.stats.currentMode === 'function') {
        return window.stats.currentMode();
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

  // Best-available position snapshot for the given mode. Read-only accessors,
  // each individually guarded; null when nothing sensible is available.
  function positionSnapshot(mode) {
    try {
      if (mode === 'read' && typeof window.pagedGetReadLocation === 'function') {
        const loc = window.pagedGetReadLocation();
        if (loc && Number.isFinite(loc.jpOff)) {
          return { k: 'read', jpOff: loc.jpOff, chunkIdx: loc.chunkIdx };
        }
      }
      if (mode === 'audio' && Number.isFinite(window._lastAudioCueIdx)) {
        return { k: 'audio', cueIdx: window._lastAudioCueIdx };
      }
      if (mode === 'card' && Number.isFinite(window.currentCardIndex)) {
        return { k: 'card', cardIndex: window.currentCardIndex };
      }
    } catch (_) {}
    return null;
  }

  // ---- load / persist -----------------------------------------------------
  function ensureLoaded(titleId) {
    if (curTitleId === titleId && (log || loading)) return loading || Promise.resolve();
    // Title changed under us: flush the old log synchronously-ish first.
    if (curTitleId && curTitleId !== titleId) flushNow();
    curTitleId = titleId;
    log = null;
    pending = [];
    loading = (async () => {
      let parsed = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(storeKey(titleId)) : null;
        if (raw) parsed = JSON.parse(raw);
      } catch (_) {}
      if (curTitleId !== titleId) return;        // another title won the race
      log = (parsed && parsed.v === 1 && Array.isArray(parsed.events))
        ? parsed : { v: 1, events: [] };
      if (pending.length) {
        for (const ev of pending) appendLoaded(ev);
        pending = [];
        scheduleFlush();
      }
      loading = null;
    })();
    return loading;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DEBOUNCE_MS);
  }

  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty || !log || !curTitleId || !window.blobStore) return;
    dirty = false;
    try {
      window.blobStore.set(storeKey(curTitleId), JSON.stringify(log)).catch(() => {});
    } catch (_) {}
  }

  // ---- append rules -------------------------------------------------------
  function appendLoaded(ev) {
    const evs = log.events;
    const last = evs[evs.length - 1];
    // Mode collapse: an 'm' superseding an 'm' that lived <60s never "persisted".
    if (ev.t === 'm' && last && last.t === 'm' && (ev.ts - last.ts) < COLLAPSE_MS) {
      evs[evs.length - 1] = ev;
      return;
    }
    // Idempotence: no doubled closes/opens (visibilitychange + appStateChange
    // both fire — belt-and-suspenders upstream, dedupe here).
    if ((ev.t === 'c' || ev.t === 'o') && last && last.t === ev.t) {
      evs[evs.length - 1] = ev;
      return;
    }
    // A mode shift with no open session implies engagement: synthesize the 'o'.
    if (ev.t !== 'o' && (!last || last.t === 'c')) {
      evs.push({ t: 'o', ts: ev.ts, m: ev.m, p: ev.p });
    }
    evs.push(ev);
    if (evs.length > MAX_EVENTS) evs.splice(0, evs.length - MAX_EVENTS);
  }

  function record(type, extra) {
    try {
      const titleId = window._activeTitleId;
      if (!titleId) return;
      const mode = (extra && extra.m) || currentMode();
      const ev = {
        t: type,
        ts: Date.now(),
        m: mode || null,
        p: (extra && extra.p !== undefined) ? extra.p : positionSnapshot(mode),
      };
      ensureLoaded(titleId);
      if (!log) { pending.push(ev); return; }   // queued; flushed post-load
      appendLoaded(ev);
      if (type === 'c') flushNow(); else scheduleFlush();
    } catch (_) {}
  }

  // ---- hooks (all passive listeners) --------------------------------------
  window.addEventListener('shell:mode-change', (e) => {
    record('m', { m: e && e.detail && e.detail.mode });
  });

  // Title swap: close out the old title's log (record() resolves the NEW
  // _activeTitleId, so close the old one explicitly before re-binding).
  window.addEventListener('shell:title-change', () => {
    try {
      if (curTitleId && curTitleId !== window._activeTitleId && log) {
        const last = log.events[log.events.length - 1];
        if (last && last.t !== 'c') {
          log.events.push({ t: 'c', ts: Date.now(), m: last.m || null, p: last.p || null });
          dirty = true;
        }
        flushNow();
      }
    } catch (_) {}
    record('o', {});
  });

  function onHidden() { record('c', {}); }
  function onVisible() { record('o', {}); }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHidden(); else onVisible();
  });
  try {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App && typeof App.addListener === 'function') {
      App.addListener('appStateChange', (s) => {
        if (s && s.isActive === false) onHidden();
        else if (s && s.isActive === true) onVisible();
      });
    }
  } catch (_) {}

  // ---- public surface ------------------------------------------------------
  window.eventLog = {
    // Called explicitly from bookmarks.record() — the one source hook.
    noteBookmark(bm) {
      try {
        record('b', {
          m: bm && bm.mode,
          p: bm && bm.location ? Object.assign({ k: bm.mode }, bm.location) : undefined,
        });
      } catch (_) {}
    },
    // Timeline reset: wipe a title's session history (user restarted the
    // book after jumping around). Only the LOG is cleared — summaries,
    // characters, and bookmarks are separate stores and untouched.
    async clear(titleId) {
      const id = titleId || window._activeTitleId;
      if (!id) return;
      if (id === curTitleId) { log = { v: 1, events: [] }; pending = []; dirty = true; flushNow(); }
      else { try { window.blobStore && await window.blobStore.set(KEY_PREFIX + id, JSON.stringify({ v: 1, events: [] })); } catch (_) {} }
    },
    // For the future timeline renderer + debugging. Never used by restore code.
    async getLog(titleId) {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      if (id === curTitleId) {
        if (loading) await loading;
        if (log) return JSON.parse(JSON.stringify(log));
      }
      try {
        const raw = window.blobStore ? await window.blobStore.get(storeKey(id)) : null;
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    },
    _flush: flushNow,
  };
})();
