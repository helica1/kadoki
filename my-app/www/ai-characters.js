// ai-characters.js — character DB v2, chapter-grained (AI plan v2 §7,
// docs/ai-reading-companion-plan.md). Storage owner for AICHAR_V2_<titleId>.
//
// Extraction no longer lives here: ai-processor.js processes each FINISHED
// chapter (spoiler safety is structural — it only ever sends consumed text)
// and hands the structured character payload to applyChapterOutput(), the
// single merge entry point. This module owns:
//   - the merged-current `characters` view (matcher/squiggles/Characters
//     screen read this; "a squiggle, once earned, stays glued"),
//   - per-chunk `presence` ({imp, reveal} per character per chapter),
//   - WRITE-ONCE per-chunk `snapshots` (full record set as of that chapter —
//     powers future per-position views; also the re-merge guard).
//
// matcher()/visibleState()/contextText() keep their v1 shapes so
// ai-characters-ui.js / ai-characters-read.js work unchanged.
(function () {
  'use strict';

  const KEY_PREFIX = 'AICHAR_V2_';
  const LEGACY_PREFIX = 'AICHAR_V1_';     // abandoned unshipped v1 store — GC'd on load
  const PROMPT_CAP = 4000;                // compactForPrompt budget (chars)

  // Fields an update's `set` may overwrite (superset of the §6 schema —
  // extras are harmless repairs the model sometimes routes through set).
  const SET_FIELDS = ['surface', 'rubyReading', 'standardReading', 'role',
                      'description', 'personality', 'appearance',
                      'motivations', 'secrets', 'isCommonWord', 'mergedInto'];

  // ---- per-title store -------------------------------------------------------
  let curTitleId = null;
  let store = null;
  let loading = null;
  let rev = 0;               // bumped on every mutation (UI cache key)

  function storeKey(id) { return KEY_PREFIX + id; }
  function freshStore() {
    return { v: 2, nextId: 1, characters: {}, presence: {}, snapshots: [] };
  }
  function normalizeStore(p) {
    if (!p || p.v !== 2 || typeof p !== 'object') return freshStore();
    if (!p.characters || typeof p.characters !== 'object') p.characters = {};
    if (!p.presence || typeof p.presence !== 'object') p.presence = {};
    if (!Array.isArray(p.snapshots)) p.snapshots = [];
    if (!Number.isFinite(p.nextId)) p.nextId = 1;
    return p;
  }
  async function loadRaw(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(storeKey(titleId)) : null;
      if (raw) return normalizeStore(JSON.parse(raw));
    } catch (_) {}
    return freshStore();
  }
  async function ensureLoaded(titleId) {
    if (curTitleId === titleId && (store || loading)) { if (loading) await loading; return; }
    curTitleId = titleId; store = null;
    loading = (async () => {
      let p = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(storeKey(titleId)) : null;
        if (raw) p = JSON.parse(raw);
      } catch (_) {}
      if (curTitleId !== titleId) return;          // title switched while loading
      store = normalizeStore(p);
      rev++; loading = null;
      // GC the abandoned v1 key for this title (fire-and-forget).
      try {
        if (window.blobStore && window.blobStore.remove) {
          window.blobStore.remove(LEGACY_PREFIX + titleId).catch(() => {});
        }
      } catch (_) {}
      // Store ready (matcher() now non-null) → let the squiggle layer re-mark
      // immediately instead of waiting up to 1.5s for its poll.
      try { window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId, kind: 'load' } })); } catch (_) {}
    })();
    await loading;
  }
  function save() {
    if (!store || !curTitleId || !window.blobStore) return;
    rev++;
    try { window.blobStore.set(storeKey(curTitleId), JSON.stringify(store)).catch(() => {}); } catch (_) {}
  }

  // ---- merge (called by ai-processor.js) --------------------------------------
  function normRels(rels) {
    const out = [];
    if (Array.isArray(rels)) {
      for (const r of rels) {
        if (r && typeof r.to === 'string' && r.to && r.rel) out.push({ to: r.to, rel: String(r.rel) });
      }
    }
    return out;
  }
  function devTexts(src) {
    const out = [];
    if (Array.isArray(src)) {
      for (const d of src) {
        const text = (typeof d === 'string') ? d : (d && d.text);
        if (text) out.push(String(text));
      }
    }
    return out;
  }
  // Drop placeholder "readings" the model sometimes emits when it can't infer
  // one (古いデータ救済 + 新規取り込みの両方で). A real reading is kana, never
  // these words.
  function cleanReading(r) {
    const v = String(r || '').trim();
    if (!v) return '';
    if (v === 'なし' || v === '無し' || v === '不明' || v === '？' || v === '?' || v === '-') return '';
    return v;
  }
  function normRecord(c, id, chunkIdx) {
    return {
      id,
      surface: String(c.surface || ''),
      rubyReading: cleanReading(c.rubyReading),
      standardReading: cleanReading(c.standardReading),
      aliases: Array.isArray(c.aliases) ? c.aliases.filter(a => a && a.length) : [],
      isCommonWord: !!c.isCommonWord,
      role: c.role || '',
      description: c.description || '',
      personality: c.personality || '',
      appearance: c.appearance || '',
      motivations: c.motivations || '',
      secrets: c.secrets || '',
      relationships: normRels(c.relationships),
      developments: devTexts(c.developments || c.newDevelopments)
        .map(t => ({ chunkIdx, text: t })),
      firstChunkIdx: chunkIdx, lastChunkIdx: chunkIdx,
      mergedInto: (typeof c.mergedInto === 'string' && c.mergedInto) ? c.mergedInto : null,
    };
  }
  function pickSetFields(c) {
    const set = {};
    for (const k of SET_FIELDS) if (c[k] !== undefined && c[k] !== null && c[k] !== '') set[k] = c[k];
    delete set.surface;        // never let a re-emitted "new" rename an existing record
    return set;
  }

  function applyUpdate(s, chunkIdx, u, resolveId) {
    const id = resolveId(typeof u.id === 'string' ? u.id : '');
    const rec = s.characters[id];
    if (!rec) return;
    const set = (u.set && typeof u.set === 'object') ? u.set : {};
    for (const k of SET_FIELDS) {
      if (set[k] === undefined || set[k] === null) continue;
      if (k === 'isCommonWord') rec.isCommonWord = !!set[k];
      else if (k === 'mergedInto') rec.mergedInto = set[k] ? resolveId(String(set[k])) : null;
      else rec[k] = String(set[k]);
    }
    const extraAliases = [].concat(
      Array.isArray(set.aliases) ? set.aliases : [],
      Array.isArray(u.addAliases) ? u.addAliases : []);
    for (const a of extraAliases) {
      if (a && a.length && !rec.aliases.includes(a)) rec.aliases.push(a);
    }
    // newDevelopments PREPEND (newest first); per-(chunk,text) dedupe keeps
    // re-application harmless.
    const devs = [];
    for (const t of devTexts(u.newDevelopments)) {
      if (rec.developments.some(e => e.chunkIdx === chunkIdx && e.text === t)) continue;
      devs.push({ chunkIdx, text: t });
    }
    if (devs.length) rec.developments = devs.concat(rec.developments);
    // relationships replaced per `to` pair
    for (const r of normRels(u.relationshipChanges)) {
      const to = resolveId(r.to);
      const i = rec.relationships.findIndex(x => x.to === to);
      if (i >= 0) rec.relationships[i].rel = r.rel;
      else rec.relationships.push({ to, rel: r.rel });
    }
    if (chunkIdx > rec.lastChunkIdx) rec.lastChunkIdx = chunkIdx;
    if (!Number.isFinite(rec.firstChunkIdx) || chunkIdx < rec.firstChunkIdx) rec.firstChunkIdx = chunkIdx;
  }

  function mergePayload(s, chunkIdx, payload) {
    const remap = new Map();   // model-emitted id → final id (this payload only)
    const resolveId = (id) => (id && remap.has(id)) ? remap.get(id) : id;
    const updates = [];

    // Pass 1 — new records. Id repair (ported from v1): a model id is kept
    // only when it's a clean unused c<N>; an id that already EXISTS in the DB
    // means the model re-emitted a known character — fold onto it as an
    // update instead of duplicating; anything else gets a fresh c<nextId>.
    for (const c of (Array.isArray(payload.new) ? payload.new : [])) {
      if (!c || !c.surface) continue;
      let id = (typeof c.id === 'string') ? c.id : '';
      if (id && s.characters[id]) {
        remap.set(id, id);
        updates.push({ id, set: pickSetFields(c),
                       newDevelopments: devTexts(c.developments || c.newDevelopments),
                       relationshipChanges: c.relationships, addAliases: c.aliases });
        continue;
      }
      if (!id || remap.has(id) || !/^c\d+$/.test(id)) {
        const fresh = 'c' + (s.nextId++);
        if (id) remap.set(id, fresh);
        id = fresh;
      } else {
        remap.set(id, id);
        const n = parseInt(id.slice(1), 10);
        if (Number.isFinite(n) && n >= s.nextId) s.nextId = n + 1;
      }
      s.characters[id] = normRecord(c, id, chunkIdx);
    }
    // Pass 2 — fix relationship/merge targets inside the records added above
    // (a new record may reference another new record by its model id).
    for (const finalId of remap.values()) {
      const rec = s.characters[finalId];
      if (!rec || rec.firstChunkIdx !== chunkIdx) continue;
      for (const r of rec.relationships) r.to = resolveId(r.to);
      if (rec.mergedInto) rec.mergedInto = resolveId(rec.mergedInto);
    }
    // Pass 3 — updates (folded re-emits first, then the model's own).
    for (const u of updates) applyUpdate(s, chunkIdx, u, resolveId);
    for (const u of (Array.isArray(payload.updates) ? payload.updates : [])) {
      if (u) applyUpdate(s, chunkIdx, u, resolveId);
    }
    // Pass 4 — presence.
    for (const p of (Array.isArray(payload.presence) ? payload.presence : [])) {
      if (!p || typeof p.id !== 'string') continue;
      const id = resolveId(p.id);
      const rec = s.characters[id];
      if (!rec) continue;
      if (!s.presence[id]) s.presence[id] = {};
      const imp = Math.max(0, Math.min(3, Math.round(Number(p.importance) || 0)));
      s.presence[id][String(chunkIdx)] = { imp, reveal: !!p.reveal };
      if (chunkIdx > rec.lastChunkIdx) rec.lastChunkIdx = chunkIdx;
    }
  }

  // THE merge entry point (ai-processor.js). payload per §6:
  // { new:[full records], updates:[{id,newDevelopments,set,relationshipChanges}],
  //   presence:[{id,importance,reveal}] }. Returns true when the chunk's
  // output is in the store (freshly merged OR already applied).
  async function applyChapterOutput(titleId, chunkIdx, payload) {
    try {
      if (!titleId || !Number.isFinite(chunkIdx) || !payload) return false;
      // Use the module store when this is the active title (UI sees the merge
      // live); otherwise an isolated read-modify-write — a title switch
      // mid-flight must never repoint the squiggle state at another book.
      let s = null, persist = null;
      if (titleId === curTitleId || titleId === window._activeTitleId) {
        await ensureLoaded(titleId);
        if (curTitleId === titleId && store) { s = store; persist = save; }
      }
      if (!s) {
        s = await loadRaw(titleId);
        persist = () => {
          try { window.blobStore.set(storeKey(titleId), JSON.stringify(s)).catch(() => {}); } catch (_) {}
        };
      }
      // Write-once per chunk: an existing snapshot means this chunk's output
      // was already merged — re-merging could duplicate repaired-id records.
      if (s.snapshots.some(sn => sn && sn.chunkIdx === chunkIdx)) return true;
      mergePayload(s, chunkIdx, payload);
      s.snapshots.push({
        chunkIdx, ts: Date.now(),
        characters: JSON.parse(JSON.stringify(Object.values(s.characters))),
      });
      persist();
      return true;
    } catch (_) { return false; }
  }

  // ---- positions & text gathering (for contextText) ----------------------------
  function currentMode() {
    try { if (window.stats && window.stats.currentMode) return window.stats.currentMode(); } catch (_) {}
    const cl = document.body.classList;
    return cl.contains('mode-read') ? 'read' : (cl.contains('mode-audio') ? 'audio' : 'card');
  }
  function curJp() {
    try {
      const loc = window.pagedGetReadLocation && window.pagedGetReadLocation();
      if (loc && Number.isFinite(loc.jpOff)) return loc.jpOff;
    } catch (_) {}
    return null;
  }
  function curCue() {
    if (Number.isFinite(window._lastAudioCueIdx)) return window._lastAudioCueIdx;
    if (Number.isFinite(window.currentCardIndex)) {
      try {
        if (typeof window._srtCardToCueAnchor === 'function') {
          const c = window._srtCardToCueAnchor(window.currentCardIndex);
          if (Number.isFinite(c)) return c;
        }
      } catch (_) {}
      return window.currentCardIndex;
    }
    return null;
  }

  // Read-mode chunk text with ruby serialized as 漢字(よみ) so analyses can
  // cite authentic readings (incl. the katakana-ruby fantasy convention).
  function chunkTextWithRuby(el) {
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('ruby').forEach((r) => {
        const rt = r.querySelector('rt');
        const reading = rt ? rt.textContent : '';
        if (rt) rt.remove();
        const base = r.textContent;
        r.replaceWith(document.createTextNode(reading ? base + '(' + reading + ')' : base));
      });
      return (clone.textContent || '').trim();
    } catch (_) { return ''; }
  }

  // Consumed text up to the current position in the current mode's space,
  // tail-capped at maxChars. Grounding context for the deep dive (and later
  // the chat panel). Read-only; never looks ahead.
  function contextText(maxChars) {
    const cap = maxChars || 60000;
    let text = '';
    if (currentMode() === 'read') {
      const cur = curJp();
      if (cur === null) return '';
      try {
        const nodes = Array.from(document.querySelectorAll('.reading-chunk'))
          .map(el => ({ el, off: parseInt(el.dataset.jpOff, 10), len: parseInt(el.dataset.jpLen, 10) || 0 }))
          .filter(c => Number.isFinite(c.off))
          .sort((a, b) => a.off - b.off);
        for (const c of nodes) {
          if (c.off + c.len > cur) break;
          const t = chunkTextWithRuby(c.el);
          if (t) text += t + '\n';
        }
      } catch (_) {}
    } else {
      const cues = window._srtCues;
      const cur = curCue();
      if (!Array.isArray(cues) || cur === null) return '';
      for (let i = 0; i <= Math.min(cur, cues.length - 1); i++) {
        const t = (cues[i] && cues[i].text) ? cues[i].text.replace(/\n+/g, ' ') : '';
        if (t) text += t + '\n';
      }
    }
    if (text.length > cap) text = text.slice(text.length - cap);
    return text;
  }

  // ---- read API (squiggle UI modules) -------------------------------------------
  // The merged-current view gates on the FURTHEST-consumed position by
  // construction (the processor only handles finished chapters), so records
  // are always visible — kept from v1.
  function visibleState() {
    if (!store) return null;
    const chars = new Map();
    for (const id of Object.keys(store.characters)) chars.set(id, store.characters[id]);
    const last = store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null;
    return { characters: chars, rev, chunkIdx: last ? last.chunkIdx : -1 };
  }

  // alias → record map for highlight matching. Resolves merges (record whose
  // mergedInto points at a visible record maps to the merge target) and skips
  // collision-prone aliases. Cached per store revision. Lazily kicks the
  // store load for the active title (the 1.5s UI poll retries).
  let _matchCache = null;
  function matcher() {
    const tid = window._activeTitleId;
    if (!tid) return null;
    if (curTitleId !== tid || (!store && !loading)) {
      try { ensureLoaded(tid); } catch (_) {}
    }
    if (curTitleId !== tid || !store) return null;
    const bucket = 'r' + rev;
    if (_matchCache && _matchCache.bucket === bucket) return _matchCache;
    const st = visibleState();
    if (!st) return null;
    const map = new Map();
    const addAlias = (alias, rec) => {
      if (!alias || alias.length < 2) return;       // 1-char names collide too hard
      // Spurious-highlight guard: all-hiragana strings are usually verbs the
      // model mis-extracted (うなずいた…), not names. An all-hiragana alias is
      // accepted only when it IS the character's name or reading — conjugated
      // verbs never equal those.
      if (/^[ぁ-んー]+$/.test(alias)) {
        const isNameItself = alias === rec.surface ||
          alias === rec.rubyReading || alias === rec.standardReading;
        if (!isNameItself || alias.length > 6) return;
      }
      if (!map.has(alias)) map.set(alias, rec);
    };
    for (const c of st.characters.values()) {
      let target = c;
      if (c.mergedInto && st.characters.has(c.mergedInto)) target = st.characters.get(c.mergedInto);
      if (target.hideSquiggle) continue;   // user hid this character's squiggles (aliases of records merged into a hidden target are hidden too)
      if (!c.isCommonWord) { addAlias(c.surface, target); }
      for (const a of (c.aliases || [])) { if (!c.isCommonWord || a !== c.surface) addAlias(a, target); }
    }
    _matchCache = { bucket, map, state: st };
    return _matchCache;
  }

  // ---- Characters screen state ----------------------------------------------------
  async function storeFor(titleId) {
    if (titleId === window._activeTitleId) {
      await ensureLoaded(titleId);
      if (curTitleId === titleId && store) return store;
    }
    if (titleId === curTitleId && store) return store;
    return loadRaw(titleId);
  }

  // openState(titleId) → { list, presence, chunkCount, surfaceOf } for the
  // Characters screen. list = non-merged records sorted by recency
  // (lastChunkIdx desc) then total presence importance; surfaceOf resolves
  // any id (incl. merged) to its display surface.
  async function openState(titleId) {
    const tid = titleId || window._activeTitleId;
    if (!tid) return null;
    const s = await storeFor(tid);
    const totalImp = (id) => {
      let t = 0;
      const p = s.presence[id];
      if (p) for (const k of Object.keys(p)) t += (p[k] && p[k].imp) || 0;
      return t;
    };
    const surfaceOf = {};
    for (const c of Object.values(s.characters)) {
      let t = c;
      if (c.mergedInto && s.characters[c.mergedInto]) t = s.characters[c.mergedInto];
      surfaceOf[c.id] = t.surface;
    }
    const list = Object.values(s.characters)
      .filter(c => !c.mergedInto)
      .map(c => JSON.parse(JSON.stringify(c)));
    for (const c of list) c.totalImportance = totalImp(c.id);
    list.sort((a, b) => (b.lastChunkIdx - a.lastChunkIdx) || (b.totalImportance - a.totalImportance));
    let chunkCount = 0;
    try {
      const m = window.aiChunks && window.aiChunks.getMap && window.aiChunks.getMap(tid);
      const mp = (m && typeof m.then === 'function') ? await m : m;
      if (mp && Array.isArray(mp.chunks)) chunkCount = mp.chunks.length;
    } catch (_) {}
    for (const sn of s.snapshots) {
      if (sn && Number.isFinite(sn.chunkIdx)) chunkCount = Math.max(chunkCount, sn.chunkIdx + 1);
    }
    return { list, presence: JSON.parse(JSON.stringify(s.presence)), chunkCount, surfaceOf };
  }

  // Compact JSON of the current DB for the processor's prompt context
  // (id/surface/reading/aliases/role/1-line description/relationships),
  // budgeted to PROMPT_CAP chars — degrades detail, then drops the oldest.
  async function compactForPrompt(titleId) {
    try {
      const tid = titleId || window._activeTitleId;
      if (!tid) return '';
      const s = await storeFor(tid);
      const recs = Object.values(s.characters)
        .sort((a, b) => (b.lastChunkIdx - a.lastChunkIdx));
      if (!recs.length) return '';
      const trunc = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n) + '…' : t; };
      const oneLine = (t) => String(t || '').replace(/\s*\n+\s*/g, ' ').trim();
      const compact = (c, lvl) => {
        if (c.mergedInto) return { id: c.id, surface: c.surface, mergedInto: c.mergedInto };
        const o = { id: c.id, surface: c.surface };
        const reading = c.rubyReading || c.standardReading;
        if (reading) o.reading = reading;
        const aliases = (c.aliases || []).filter(a => a !== c.surface).slice(0, lvl >= 1 ? 3 : 8);
        if (aliases.length) o.aliases = aliases;
        if (c.role) o.role = trunc(c.role, 24);
        const desc = oneLine(c.description);
        if (desc) o.desc = trunc(desc, lvl >= 1 ? 40 : 90);
        if (lvl < 2 && c.relationships && c.relationships.length) {
          o.rel = c.relationships.slice(0, 6).map(r => ({ to: r.to, rel: trunc(r.rel, 16) }));
        }
        return o;
      };
      for (let lvl = 0; lvl <= 2; lvl++) {
        const arr = recs.map(c => compact(c, lvl));
        if (JSON.stringify(arr).length <= PROMPT_CAP) return JSON.stringify(arr);
        if (lvl === 2) {
          while (arr.length > 1 && JSON.stringify(arr).length > PROMPT_CAP) arr.pop();
          return JSON.stringify(arr);
        }
      }
    } catch (_) {}
    return '';
  }

  // Wipe a title's character DB (in-memory + blobStore) so a re-segment can
  // rebuild it from chunk 0. Used by aiProcessor.reDetectChapters.
  async function reset(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) return;
      if (curTitleId === id) { store = freshStore(); rev++; }
      try {
        if (window.blobStore && window.blobStore.remove) await window.blobStore.remove(storeKey(id));
        else if (window.blobStore) await window.blobStore.set(storeKey(id), JSON.stringify(freshStore()));
      } catch (_) {}
    } catch (_) {}
  }

  // Per-character squiggle suppression (user toggle from the popup / Characters
  // screen). `hideSquiggle` is OUTSIDE SET_FIELDS, so AI merges never touch it;
  // the whole blob syncs last-writer-wins by rev. matcher() skips records whose
  // (merge) target has it set.
  async function setHideSquiggle(charId, hide) {
    try {
      const tid = window._activeTitleId; if (!tid || !charId) return;
      await ensureLoaded(tid);
      if (curTitleId !== tid || !store) return;
      const rec = store.characters[charId]; if (!rec) return;
      const v = !!hide; if (rec.hideSquiggle === v) return;
      rec.hideSquiggle = v;
      _matchCache = null;
      save();
      try { window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId: tid, kind: 'squiggle' } })); } catch (_) {}
    } catch (_) {}
  }

  window.aiCharacters = {
    matcher,
    setHideSquiggle,
    visibleState,
    contextText,
    cleanReading,
    storeRev() { return rev; },
    applyChapterOutput,
    openState,
    compactForPrompt,
    reset,
    // diagnostics / timeline
    async getStore(titleId) {
      const id = titleId || window._activeTitleId;
      if (!id) return null;
      const s = await storeFor(id);
      return s ? JSON.parse(JSON.stringify(s)) : null;
    },
  };
})();
