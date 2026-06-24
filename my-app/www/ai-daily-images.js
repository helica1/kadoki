// ai-daily-images.js — the SEMI-RANDOM "X images/day" scheduler (window.aiDailyImages).
//
// The user's alternative to auto-illustrating every character: set a daily image
// budget (Preferences → AI Image) and, as you read, the app randomly picks an
// eligible CHARACTER (one with enough description, already introduced by the
// read frontier) or a SCENE (a read chapter without an image yet) and generates
// ONE image — up to the budget per day, with a $ safety cap.
//
// ONLY runs on the OpenAI/ChatGPT backend (the local server auto-illustrates by
// position via ai-scenes.js instead) and only with a budget > 0 (default 0 =
// off → no surprise spend). Spoiler-safe: candidates are gated to the read
// frontier and scene text is truncated to it (window.aiChunks.chunkTextUpToJp).
// It reuses the same triggers as ai-scenes.js (kai:read-frontier + foreground).
(function () {
  'use strict';

  const CT_KEY = 'AIIMG_DAILYCT_V1';       // { day:'Y-M-D', count, ts0 } — reset on day rollover
  const COOLDOWN_MS = 45 * 1000;           // spacing between auto-generations (spread the spend out)
  const MIN_DESC = 40;                     // a character needs at least this much description text

  function dbg() { try { return localStorage.getItem('KADOKI_DEBUG') === '1'; } catch (_) { return false; } }
  function slog() { if (!dbg()) return; try { console.log.apply(console, ['[aiDailyImg]'].concat([].slice.call(arguments))); } catch (_) {} }

  function todayStr() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function startOfDayTs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

  let _ct = null;
  function loadCount() {
    if (!_ct) { try { _ct = JSON.parse(localStorage.getItem(CT_KEY) || 'null'); } catch (_) { _ct = null; } }
    const day = todayStr();
    if (!_ct || _ct.day !== day) { _ct = { day, count: 0, ts0: startOfDayTs() }; save(); }
    return _ct;
  }
  function bumpCount() { const ct = loadCount(); ct.count = (ct.count || 0) + 1; save(); }
  function save() { try { localStorage.setItem(CT_KEY, JSON.stringify(_ct)); } catch (_) {} }

  // last known read frontier (jp char offset) per title — so the foreground
  // catch-up can run without a fresh event and still respect spoiler gating.
  const _frontier = {};

  let _busy = false, _lastGen = 0;

  // Pick ONE eligible candidate at random, or null. frontierIdx gates spoilers
  // (only characters introduced / chapters read up to the frontier are eligible).
  // Subjects already imaged, queued, OR terminally refused are excluded. Status is
  // read in ONE batched idx+outbox read (statusBatch) rather than per subject.
  async function pickCandidate(titleId, jp) {
    const map = (window.aiChunks && window.aiChunks.getMap) ? await window.aiChunks.getMap(titleId) : null;
    if (!map || !Array.isArray(map.chunks) || !map.chunks.length) return null;
    if (map.space === 'cue') return null;                 // read (jp-space) titles only
    if (!Number.isFinite(jp)) return null;                // need a frontier for spoiler safety
    const fch = map.chunks.find(c => jp >= c.jpStart && jp < c.jpEnd) || map.chunks[map.chunks.length - 1];
    const frontierIdx = Number.isFinite(fch && fch.idx) ? fch.idx : map.chunks.indexOf(fch);

    // gather eligible subjects (cheap, no per-item IndexedDB reads)
    const charRecs = [];
    try {
      const st = await window.aiCharacters.openState(titleId);
      for (const rec of ((st && st.list) || [])) {
        if (!rec || rec.mergedInto || rec.isCommonWord) continue;
        const desc = String((rec.appearance || '') + (rec.description || '') + (rec.personality || ''));
        if (desc.length < MIN_DESC) continue;                            // "enough description"
        if (!Number.isFinite(rec.firstChunkIdx) || rec.firstChunkIdx > frontierIdx) continue;   // not yet introduced (fail-closed on unknown)
        charRecs.push(rec);
      }
    } catch (_) {}
    const sceneIdxs = [];
    try {
      const have = await window.aiImages.sceneStatusByChapter(titleId);
      for (const c of map.chunks) {
        const idx = Number.isFinite(c.idx) ? c.idx : map.chunks.indexOf(c);
        if (idx > frontierIdx) continue;                                 // not read yet
        if (have[idx] && have[idx].images > 0) continue;
        sceneIdxs.push(idx);
      }
    } catch (_) {}

    // ONE batched status read for everything, then filter out has-image/pending/refused
    const ids = charRecs.map(r => r.id).concat(sceneIdxs.map(i => 'scene_' + i));
    let stat = {};
    try { stat = (window.aiImages.statusBatch ? await window.aiImages.statusBatch(titleId, ids) : {}) || {}; } catch (_) {}
    const free = (id) => { const s = stat[id] || {}; return !((s.images || 0) > 0 || (s.pending || 0) > 0 || (s.refused || 0) > 0); };
    const cands = [];
    for (const rec of charRecs) if (free(rec.id)) cands.push({ kind: 'char', rec });
    for (const idx of sceneIdxs) if (free('scene_' + idx)) cands.push({ kind: 'scene', idx });
    if (!cands.length) return null;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  async function tick(titleId, jp) {
    if (_busy) return;                                                    // re-entrancy bounce OUTSIDE try (finally must not clear it)
    if (!window.aiImages || !window.aiImages.backend || window.aiImages.backend() !== 'openai') return;
    const budget = window.aiImages.dailyBudget ? window.aiImages.dailyBudget() : 0;
    if (budget <= 0) return;                                              // feature off
    if (!window.aiOpenai || !window.aiOpenai.hasKey()) return;            // no key → nothing to spend
    titleId = titleId || window._activeTitleId; if (!titleId) return;
    if (Number.isFinite(jp)) _frontier[titleId] = jp; else jp = _frontier[titleId];
    if (!Number.isFinite(jp)) return;                                     // no known frontier → skip (spoiler-safe)
    const ct = loadCount();
    if (ct.count >= budget) return;                                       // hit today's image budget
    if (Date.now() - _lastGen < COOLDOWN_MS) return;                      // spacing — cheap gate BEFORE the heavy scan
    _busy = true;
    _lastGen = Date.now();                                                // reserve the slot synchronously: even a fruitless scan is throttled to 45s
    try {
      // $ safety cap for today
      try { const spent = await window.aiOpenai.spendSinceUsd(ct.ts0); if (spent >= (window.aiImages.dailyUsd ? window.aiImages.dailyUsd() : Infinity)) { slog('daily $ cap reached', spent); return; } } catch (_) {}
      const cand = await pickCandidate(titleId, jp);
      if (!cand) return;
      // Only consume a daily slot when something was actually QUEUED (a <200-char
      // near-frontier scene queues nothing; offline still queues into the outbox).
      let queued = false;
      if (cand.kind === 'char') {
        queued = !!(await window.aiImages.queueCharacter(titleId, cand.rec));
      } else {
        let txt = null;
        try { if (window.aiChunks && window.aiChunks.chunkTextUpToJp) txt = await window.aiChunks.chunkTextUpToJp(titleId, cand.idx, jp); } catch (_) {}
        if (txt && txt.trim().length >= 200) { const r = await window.aiImages.queueScene(titleId, cand.idx, { chapterText: txt, scenes: 1, auto: true, label: '第' + (cand.idx + 1) + '章' }); queued = !!(r && r.ok !== false); }
      }
      if (!queued) return;
      bumpCount();
      slog('generating', cand.kind, cand.kind === 'char' ? (cand.rec && cand.rec.surface) : ('ch' + cand.idx), '— count', loadCount().count, '/', budget);
      await window.aiImages.sync(titleId);
    } catch (e) { slog('tick error', e && e.message); }
    finally { _busy = false; }
  }

  function fg() { try { tick(window._activeTitleId, undefined); } catch (_) {} }

  try { window.Capacitor?.Plugins?.App?.addListener('appStateChange', (s) => { if (s && s.isActive) fg(); }); } catch (_) {}
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fg(); });
  window.addEventListener('kai:read-frontier', (e) => { if (e && e.detail) tick(e.detail.titleId, e.detail.jp); });

  window.aiDailyImages = { tick, loadCount };
})();
