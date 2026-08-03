// ai-scenes.js — AUTO scene illustration. As the reader's frontier advances, every
// ~6k JP chars "unlocks" a scene for the chapter at that boundary: a spoiler-safe
// (truncated-to-frontier) scene job is queued + a "シーン解放" notification fires.
//
// Offline-safe by construction: unlocks queue into the persistent image OUTBOX and
// submit when the server is reachable (on app foreground + the timeline/Characters
// polls). To avoid flooding the GPU after a long offline read, only the ~10
// most-recent in-flight auto scenes render; older unlocks become "tappable" badges
// on the timeline (the manual generate button still makes them). Read (jp-space) titles only.
//
// Reuses ai-images.js entirely: scenes are stored under charId scene_<chapterIdx>,
// so the gallery/crop/delete/sync all work unchanged.

(function () {
  'use strict';

  const SEG = 6000;                                  // JP chars per scene-unlock boundary
  const CAP = 3;                                     // max auto scenes rendering at once (kept light)
  const MAX_PER_PASS = 8;                            // bound a huge frontier jump per tick
  const HWM_KEY = (t) => 'AISCENE_HWM_' + t;         // boundaries already unlocked
  const DEFER_KEY = (t) => 'AISCENE_DEFER_' + t;     // chapter idxs with deferred (tappable) unlocks
  const PREF = 'AISCENE_AUTO';                       // '1' on / '0' off (default OFF)

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return (v == null || v === '') ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (_) {}
    try { window.Capacitor?.Plugins?.Preferences?.set({ key: k, value: String(v) }); } catch (_) {}
  }
  function enabled() { return lsGet(PREF, '0') === '1'; }   // default OFF — user-picked timeline scenes are the model now (no per-6k auto-spend)
  function setEnabled(on) { lsSet(PREF, on ? '1' : '0'); }
  function dbg() { try { return localStorage.getItem('KADOKI_DEBUG') === '1'; } catch (_) { return false; } }
  function slog() { if (!dbg()) return; try { console.log.apply(console, ['[aiScenes]'].concat([].slice.call(arguments))); } catch (_) {} }

  function hwmGet(t) { return parseInt(lsGet(HWM_KEY(t), '0'), 10) || 0; }
  function hwmSet(t, n) { lsSet(HWM_KEY(t), n); }
  function deferGet(t) { try { return JSON.parse(lsGet(DEFER_KEY(t), '[]')) || []; } catch (_) { return []; } }
  function deferSet(t, arr) { lsSet(DEFER_KEY(t), JSON.stringify(Array.from(new Set(arr)).slice(-300))); }
  function deferAdd(t, idx) { if (!Number.isFinite(idx)) return; const a = deferGet(t); if (!a.includes(idx)) { a.push(idx); deferSet(t, a); } }
  function clearDeferred(t, idx) { deferSet(t, deferGet(t).filter(x => x !== idx)); emit(t); }
  function deferredChapters(t) { return new Set(deferGet(t)); }

  function emit(titleId) { try { window.dispatchEvent(new CustomEvent('kai:scenes-changed', { detail: { titleId: titleId || null } })); } catch (_) {} }

  let _busy = false;
  async function onFrontier(titleId, jp) {
    try {
      if (!enabled() || _busy || !titleId || !Number.isFinite(jp)) return;
      if (!window.aiImages || !window.aiImages.queueScene) return;
      // Cloud backend: position-driven auto-illustrate is OFF (it would spend per
      // 6k chars). On OpenAI, generation is on-demand + the daily scheduler only.
      try { if (window.aiImages.backend && window.aiImages.backend() === 'openai') return; } catch (_) {}
      if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) return;   // scenes are part of the AI feature set
      const target = Math.floor(jp / SEG);           // boundaries the frontier has now passed
      if (target <= hwmGet(titleId)) return;         // nothing new (fast path — most ticks)
      _busy = true;
      const map = (window.aiChunks && window.aiChunks.getMap) ? await window.aiChunks.getMap(titleId) : null;
      if (!map || !Array.isArray(map.chunks) || !map.chunks.length) return;   // no map yet → retry next tick (don't lose boundaries)
      // Cue-space (audio-only) maps unlock like read maps: the cue-map poll
      // now derives a jp frontier from the current cue, and the processor's
      // cue branch (locatePassages/cueRangeForQuote) anchors scene audio.
      let did = 0;
      for (let b = hwmGet(titleId) + 1; b <= target && did < MAX_PER_PASS; b++) {
        const bj = b * SEG;
        const ch = map.chunks.find(c => bj >= c.jpStart && bj < c.jpEnd) || map.chunks[map.chunks.length - 1];
        const idx = Number.isFinite(ch && ch.idx) ? ch.idx : map.chunks.indexOf(ch);
        await unlockOne(titleId, idx, bj);
        hwmSet(titleId, b);
        did++;
      }
      if (did > 0) {
        emit(titleId);                                  // refresh timeline badges once
        try { window.aiImages.sync(titleId); } catch (_) {}   // one submit pass (no-op offline)
      }
      // Hit the per-pass cap with more boundaries pending → continue next tick.
      if (did >= MAX_PER_PASS && hwmGet(titleId) < target) { try { setTimeout(() => onFrontier(titleId, jp), 60); } catch (_) {} }
    } catch (e) { slog('onFrontier error', e && e.message); }
    finally { _busy = false; }
  }

  // Returns true if a scene was queued to RENDER, false if it became a tappable
  // badge (no text yet / cap saturated / queue failed). Does NOT sync/emit — the
  // caller batches those once per pass.
  async function unlockOne(titleId, chapterIdx, boundaryJp) {
    if (!Number.isFinite(chapterIdx) || chapterIdx < 0) return false;
    // Spoiler-safe text: only what's been read up to this boundary.
    let txt = null;
    try { if (window.aiChunks && window.aiChunks.chunkTextUpToJp) txt = await window.aiChunks.chunkTextUpToJp(titleId, chapterIdx, boundaryJp); } catch (_) {}
    if (!txt || txt.trim().length < 400) { deferAdd(titleId, chapterIdx); slog('too little read text → tappable badge', chapterIdx); return false; }
    let r = null;
    try { r = await window.aiImages.queueScene(titleId, chapterIdx, { chapterText: txt, scenes: 1, multi: true, auto: true, label: '第' + (chapterIdx + 1) + '章' }); } catch (_) {}
    // 'suppressed' = the user deleted this chapter's scenes on the server → respect it
    // (no defer/badge, no retry); HWM already advanced so this boundary won't re-fire.
    if (r && r.ok === false && r.reason === 'suppressed') { slog('scene suppressed (deleted) — skipping', chapterIdx); return false; }
    if (!r || r.ok === false) { deferAdd(titleId, chapterIdx); slog('queue failed → tappable badge', chapterIdx); return false; }
    // Cap in-flight auto scenes; evicted ones (oldest) become tappable badges.
    let dropped = [];
    try { dropped = (await window.aiImages.capAutoScenes(titleId, CAP)) || []; } catch (_) {}
    for (const di of dropped) deferAdd(titleId, di);
    if (dropped.includes(chapterIdx)) { slog('unlock capped → tappable badge', chapterIdx); return false; }   // this very unlock didn't make the cut
    clearDeferred(titleId, chapterIdx);                 // it's rendering → not a tappable-only badge
    try { if (typeof window.showToast === 'function') window.showToast('シーン解放 — 第' + (chapterIdx + 1) + '章', 2200); } catch (_) {}
    return true;
  }

  // Catch-up: on app foreground / tab-visible, push any pending scenes (sync() self-
  // checks reachability and is a cheap no-op when offline or nothing is pending).
  // NOTE: ai-images.js now owns an UNCONDITIONAL foreground catch-up (sync + a no-
  // `since` refetchDone, NOT gated on AISCENE_AUTO) that covers manually-queued
  // images too. This auto-scenes listener is kept (it self-guards via sync's
  // _syncing busy-return) and stays gated on enabled() so it only auto-pushes when
  // auto-scenes is on.
  function foregroundCatchUp() {
    try {
      const tid = window._activeTitleId;
      // Cloud backends bill per render — NEVER auto-sync them on foreground (it would
      // re-render any still-pending entry and re-bill). Local server only.
      if (window.aiImages && window.aiImages.backend && window.aiImages.backend() !== 'local') return;
      if (tid && enabled() && window.aiImages && window.aiImages.sync) window.aiImages.sync(tid);
    } catch (_) {}
  }
  try { window.Capacitor?.Plugins?.App?.addListener('appStateChange', (s) => { if (s && s.isActive) foregroundCatchUp(); }); } catch (_) {}
  document.addEventListener('visibilitychange', () => { if (!document.hidden) foregroundCatchUp(); });
  window.addEventListener('kai:read-frontier', (e) => { if (e && e.detail) onFrontier(e.detail.titleId, e.detail.jp); });

  window.aiScenes = { onFrontier, enabled, setEnabled, deferredChapters, clearDeferred, SEG, CAP };
})();
