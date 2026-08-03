// ai-chunks.js — flat-text store, pseudo-chapter chunk map, Haiku
// segmentation, and the progress/completion observer (AI plan v2 §2 + §5,
// docs/ai-reading-companion-plan.md). Foundation module: everything in the
// AI layer gates on the map this file builds.
//
// PURE OBSERVER on the position side: reads the same accessors as event-log
// (pagedGetReadLocation / _lastAudioCueIdx / currentCardIndex) and writes
// ONLY its own blobStore keys (AITEXT_V1_<titleId>, AICHUNKS_V1_<titleId>).
// Nothing in the restore/position pipeline ever reads from this module.
//
// Coordinate spaces (§2 — the landmine): every chunk boundary stores
//   rawStart/rawEnd — flat text, ruby stripped, whitespace kept; identical
//                     to the reader's dataset.charOffset space.
//   jpStart/jpEnd   — JP-only chars (window.jpCharCount); read progress.
//   cueStart/cueEnd — SRT cue indices via CUE_ALIGN_v2 when available; -1
//                     when unmapped. SRT-only titles live in cue space
//                     directly (map.space === 'cue'; "raw" = cue concat).
// Boundaries always snap to .reading-chunk starts (or cue starts), so all
// spaces are exact per boundary and completion gating never converts.
//
// SPOILER CARVE-OUT (user-approved, §1): segmentation may send small windows
// around candidate boundaries from ANYWHERE in the book to Haiku — offsets +
// neutral labels only, never prose back.
(function () {
  'use strict';

  const TEXT_PREFIX = 'AITEXT_V1_';
  const MAP_PREFIX = 'AICHUNKS_V1_';
  const RUBY_CAP = 4000;             // max base→reading pairs kept per title (glossary)
  const KANJI_RE = /[㐀-鿿豈-﫿々〆ヶ]/;
  const PROLOGUE_MIN_JP = 4000;  // pre-chapter-1 region ≥ this = prologue (keep); below = front matter (drop)
  const MERGE_MIN_JP = 5000;     // spine sections smaller than this merge forward
  const SPLIT_MAX_JP = 30000;    // sections larger than this get split…
  const TARGET_JP = 12000;       // …into ~this-sized pieces (also rule spacing)
  const SPLIT_TARGET_DEFAULT_K = 22; // default ×1000 chars for the universal oversized-chapter split (settable via Preferences → AICHUNK_SPLIT_K)
  // UNIVERSAL split threshold (jp chars): any chapter bigger than this — incl. marker
  // chapters, which never split otherwise — is divided into roughly-even parts. 0/off
  // → Infinity (never split). Floored at 8k so it can't over-split absurdly.
  function splitTargetJp() {
    try {
      const raw = localStorage.getItem('AICHUNK_SPLIT_K');
      const v = (raw === null || raw === '') ? SPLIT_TARGET_DEFAULT_K : parseInt(raw, 10);
      if (!Number.isFinite(v) || v <= 0) return (v === 0 ? Infinity : SPLIT_TARGET_DEFAULT_K * 1000);
      return Math.max(8, v) * 1000;
    } catch (_) { return SPLIT_TARGET_DEFAULT_K * 1000; }
  }
  const NATURAL_RATIO = 0.6;     // ≥60% of jp text in 5–30k sections → 'chapters'
  const WIN_HALF = 1500;         // ±chars sent to Haiku around each candidate
  const MAX_SEG_WINDOWS = 100;   // cap on boundaries refined in the ONE call
  const MAX_SEG_CHARS = 180000;  // payload cap; windows shrink to fit
  const HEAD_SNAP_JP = 2500;     // heading-chunk preference radius when splitting
  const POLL_MS = 5000;
  const PERSIST_MIN_MS = 15000;  // furthest-only writes throttled to this

  const SEG_SYSTEM =
    'あなたは長編テキストを擬似的な章に分割する作業を行います。本文の断片が複数与えられます。' +
    '各断片の中で最も自然な区切り(場面転換・時間や場所の変化・話題の切れ目)を1つ選び、' +
    '断片先頭からの文字数 offset と、区切りの直後から始まる部分を表す12文字以内の中立的な見出し label を返してください。\n' +
    '厳守事項:\n' +
    '- この作品に関する外部知識を使わない。今後の展開の推測を書かない。\n' +
    '- label は内容のネタバレを避けた中立的なもの。\n' +
    '- offset は 0 以上、断片の文字数以下。良い区切りが無ければ断片中央付近の段落境界を選ぶ。\n' +
    '- すべての断片 i について必ず1つ結果を返す。';
  const SEG_SCHEMA = {
    type: 'object',
    properties: {
      boundaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            offset: { type: 'integer' },
            label: { type: 'string' },
          },
          required: ['i', 'offset', 'label'],
          additionalProperties: false,
        },
      },
    },
    required: ['boundaries'],
    additionalProperties: false,
  };

  // ---- storage ---------------------------------------------------------------
  async function bsGet(key) {
    try { return window.blobStore ? await window.blobStore.get(key) : null; }
    catch (_) { return null; }
  }
  async function bsSet(key, val) {
    try { if (window.blobStore) await window.blobStore.set(key, val); } catch (_) {}
  }

  // In-memory caches. The map instance per title is SINGULAR (poll mutates the
  // same object getMap returns); raw texts are large, keep at most 2.
  const _maps = new Map();
  const _texts = new Map();
  const _mapMiss = new Set();     // titleIds whose store read already came back empty
  const _building = new Map();    // titleId → in-flight build promise
  let _lastLoad = null;           // { titleId, bookName, chunks, sections } from the loader hook
  let _loadGen = 0;
  let _textVerified = new Set();  // titles whose AITEXT was confirmed this session

  function _cacheMap(titleId, map) {
    _maps.set(titleId, map);
    if (_maps.size > 4) {
      for (const k of _maps.keys()) {
        if (k !== window._activeTitleId && k !== titleId) {
          if (k === _dirtyTitle) _flushDirty();   // don't drop a throttled write
          _maps.delete(k);
          break;
        }
      }
    }
  }
  function _cacheText(titleId, text) {
    _texts.set(titleId, text);
    if (_texts.size > 2) {
      for (const k of _texts.keys()) {
        if (k !== window._activeTitleId && k !== titleId) { _texts.delete(k); break; }
      }
    }
  }

  // ---- persist (throttled for furthest-only churn; forced on transitions) ----
  // All writers (the poll, refreshCueBounds, and ai-processor via mutate())
  // operate on the SAME cached instance, so a serialized dump of that instance
  // can never roll back another writer's fields. Never write any other copy.
  let _dirtyTitle = null;
  let _lastWrite = 0;
  let _writeChain = Promise.resolve();
  function _queueWrite(titleId, map) {
    _writeChain = _writeChain
      .then(() => bsSet(MAP_PREFIX + titleId, JSON.stringify(map)))
      .catch(() => {});
  }
  function persistMap(titleId, map, force) {
    try {
      const now = Date.now();
      if (!force && now - _lastWrite < PERSIST_MIN_MS) { _dirtyTitle = titleId; return; }
      _lastWrite = now;
      if (_dirtyTitle === titleId) _dirtyTitle = null;
      _queueWrite(titleId, map);
    } catch (_) {}
  }
  function _flushDirty() {
    try {
      if (!_dirtyTitle) return;
      const map = _maps.get(_dirtyTitle);
      if (map) _queueWrite(_dirtyTitle, map);
      _dirtyTitle = null;
    } catch (_) {}
  }

  // Serialized mutate on the canonical cached instance — the ONLY legal way
  // for other modules (ai-processor) to write their fields (state/attempts/
  // error/processedTs/synopsis/unresolved). fn returning false skips persist.
  async function mutate(titleId, fn) {
    try {
      if (!titleId || typeof fn !== 'function') return null;
      const map = await getMap(titleId);
      if (!map) return null;
      let keep = true;
      try { keep = fn(map) !== false; } catch (_) { return null; }
      if (keep) persistMap(titleId, map, true);
      return map;
    } catch (_) { return null; }
  }

  // ---- text helpers ------------------------------------------------------------
  function jpLen(s) {
    try { return window.jpCharCount ? window.jpCharCount(s) : (s ? s.length : 0); }
    catch (_) { return s ? s.length : 0; }
  }
  // Ruby-stripped flat text of chunk elements — char-identical to the
  // dataset.charOffset space (works on detached nodes too).
  function flatTextOf(els) {
    try {
      if (window.cueAlignment && window.cueAlignment.extractFlatText) {
        return window.cueAlignment.extractFlatText(els);
      }
    } catch (_) {}
    let acc = '';
    for (const el of (els || [])) {
      try {
        const c = el.cloneNode(true);
        c.querySelectorAll('rt, rp').forEach(r => r.remove());
        acc += c.textContent || '';
      } catch (_) {}
    }
    return acc;
  }

  // Author-given furigana glossary: kanji base → reading, harvested from the
  // SAME chunk DOM as the flat text. The raw text deliberately strips ruby (its
  // offsets coordinate with the reader + keyPassage quote search), so character
  // readings (e.g. 藻奈美→もなみ) would otherwise be invisible to the processor.
  // Stored separately and fed to the prompt so those readings survive.
  function rubyGlossaryOf(els) {
    const counts = new Map();   // base → Map(reading → count)
    for (const el of (els || [])) {
      let rubies = null;
      try { rubies = el.querySelectorAll ? el.querySelectorAll('ruby') : null; } catch (_) {}
      if (!rubies || !rubies.length) continue;
      for (const ruby of rubies) {
        try {
          const clone = ruby.cloneNode(true);
          let reading = '';
          clone.querySelectorAll('rt').forEach((rt) => { reading += rt.textContent || ''; });
          clone.querySelectorAll('rt, rp').forEach((r) => r.remove());
          const base = (clone.textContent || '').trim();
          reading = reading.trim();
          if (!base || !reading || base === reading) continue;
          if (base.length > 24 || reading.length > 24) continue;
          if (!KANJI_RE.test(base)) continue;            // kana bases are already readable
          let m = counts.get(base);
          if (!m) { m = new Map(); counts.set(base, m); }
          m.set(reading, (m.get(reading) || 0) + 1);
        } catch (_) {}
      }
    }
    const out = {};
    let n = 0;
    for (const [base, m] of counts) {
      if (n >= RUBY_CAP) break;
      let best = '', bestc = -1;                          // most frequent reading wins
      for (const [r, c] of m) { if (c > bestc) { best = r; bestc = c; } }
      out[base] = best;
      n++;
    }
    return out;
  }

  // Fingerprint = total raw chars + head/tail samples, always computed from
  // chunk texts (NOT raw.slice) so the cheap no-extraction check and the full
  // build agree even when the last chunk is shorter than the sample.
  function fpFromChunks(chunks) {
    const last = chunks[chunks.length - 1];
    const totalRaw = (parseInt(last.dataset.charOffset, 10) || 0) +
                     (parseInt(last.dataset.charLen, 10) || 0);
    const head = flatTextOf([chunks[0]]).slice(0, 32);
    const tail = flatTextOf([last]).slice(-32);
    return 'v1|tc=' + totalRaw + '|h=' + head + '|t=' + tail;
  }
  function fpFromCues(cues) {
    const n = cues.length;
    let tc = 0;
    for (const c of cues) tc += (c && c.text) ? c.text.length : 0;
    const h = ((cues[0] && cues[0].text) || '').slice(0, 24);
    const t = ((cues[n - 1] && cues[n - 1].text) || '').slice(0, 24);
    return 'v1|cues|cc=' + n + '|tc=' + tc + '|h=' + h + '|t=' + t;
  }

  function infoFromChunks(chunks) {
    return chunks.map((el, i) => ({
      i,
      raw: parseInt(el.dataset.charOffset, 10) || 0,
      jp: parseInt(el.dataset.jpOff, 10) || 0,
      jpLast: (parseInt(el.dataset.jpOff, 10) || 0) + (parseInt(el.dataset.jpLen, 10) || 0),
      head: /^H[1-6]$/.test(el.tagName || ''),
    }));
  }

  // Canonical cue-space text: one line per cue, internal newlines → space.
  // chunkText() slices the SAME construction, so rawStart/rawEnd stay valid.
  // Memoized by the cues array REFERENCE (window._srtCues is stable per title and
  // replaced on title switch): scene-card opens were re-running this O(n) build each
  // time over the whole cue list.
  let _ccCache = null;
  function cueConcat(cues) {
    if (_ccCache && _ccCache.cues === cues) return _ccCache.result;
    const offsets = new Array(cues.length);
    const jpOffs = new Array(cues.length);
    let acc = '', jp = 0;
    for (let i = 0; i < cues.length; i++) {
      offsets[i] = acc.length;
      jpOffs[i] = jp;
      const t = ((cues[i] && cues[i].text) ? String(cues[i].text) : '').replace(/\n+/g, ' ');
      acc += t + '\n';
      jp += jpLen(t);
    }
    const result = { text: acc, offsets, jpOffs, totalJp: jp };
    _ccCache = { cues, result };
    return result;
  }

  // ---- store reads ---------------------------------------------------------------
  async function getText(titleId) {
    if (!titleId) return null;
    if (_texts.has(titleId)) return _texts.get(titleId);
    const raw = await bsGet(TEXT_PREFIX + titleId);
    if (_texts.has(titleId)) return _texts.get(titleId);
    if (!raw) return null;
    let t = null;
    try { t = JSON.parse(raw); } catch (_) {}
    if (!t || t.v !== 1 || typeof t.raw !== 'string') return null;
    _cacheText(titleId, t);
    return t;
  }

  // base→reading furigana glossary for a title's processor prompt. Self-heals
  // from the last-loaded chunk DOM when an older AITEXT lacks it.
  async function rubyGlossary(titleId) {
    const text = await getText(titleId);
    if (!text) return {};
    if (text.ruby) return text.ruby;
    try {
      if (_lastLoad && _lastLoad.titleId === titleId && Array.isArray(_lastLoad.chunks)) {
        const ruby = rubyGlossaryOf(_lastLoad.chunks);
        text.ruby = ruby;
        _cacheText(titleId, text);
        bsSet(TEXT_PREFIX + titleId, JSON.stringify(text));
        return ruby;
      }
    } catch (_) {}
    return {};
  }

  // Sync accessor for render-time callers (character-name furigana): returns the
  // already-cached author-ruby glossary { base: reading } or null. Does NOT load —
  // callers fall back and can warm it via the async rubyGlossary().
  function rubyGlossarySync(titleId) {
    try { const t = _texts.get(titleId); return (t && t.ruby) ? t.ruby : null; } catch (_) { return null; }
  }

  async function getMap(titleId) {
    try {
      if (!titleId) return null;
      if (_maps.has(titleId)) return _maps.get(titleId);
      if (_mapMiss.has(titleId)) return null;
      const raw = await bsGet(MAP_PREFIX + titleId);
      if (_maps.has(titleId)) return _maps.get(titleId);   // a build won the race
      if (!raw) { _mapMiss.add(titleId); return null; }
      let m = null;
      try { m = JSON.parse(raw); } catch (_) {}
      if (!m || m.v !== 1 || !Array.isArray(m.chunks) || !m.chunks.length) {
        _mapMiss.add(titleId);
        return null;
      }
      if (!m.furthest) m.furthest = { jp: 0, cue: -1 };
      if (!m.totals) m.totals = { raw: 0, jp: 0, cues: 0 };
      _cacheMap(titleId, m);
      return m;
    } catch (_) { return null; }
  }

  // ---- loader hook (called by reading-mode-paged.js, fire-and-forget) -----------
  function _onBookLoaded(p) {
    try {
      if (!p || !p.titleId || !Array.isArray(p.chunks) || !p.chunks.length) return;
      // Section→chunk anchors need the LIVE DOM (marker elements); resolve
      // synchronously now — cheap, attribute reads + compareDocumentPosition.
      // Everything heavy runs deferred off the (then possibly detached, but
      // still self-contained) chunk elements.
      const sections = _resolveSections(p.chunks, p.sectionLabels || []);
      const gen = ++_loadGen;
      _lastLoad = { titleId: p.titleId, bookName: p.bookName || null, chunks: p.chunks, sections,
                    markers: Array.isArray(p.chapterMarkers) ? p.chapterMarkers : [] };
      setTimeout(() => {
        try {
          if (gen !== _loadGen) return;   // superseded by a newer book load
          _ensureFromDom(p.titleId, p.bookName || null, p.chunks, sections).catch(() => {});
        } catch (_) {}
      }, 300);
    } catch (_) {}
  }

  // Map each [data-kadoki-section] marker to the first .reading-chunk at, in,
  // or after it (markers may be wrapper divs, or text-less cover pages whose
  // section collapses into the next). Returns [{chunkIdx, label}], chunkIdx 0
  // always covered.
  function _resolveSections(chunks, labels) {
    const out = [];
    try {
      const markers = document.querySelectorAll('[data-kadoki-section]');
      let ci = 0;
      for (const m of markers) {
        const si = parseInt(m.getAttribute('data-kadoki-section'), 10);
        const label = (Number.isFinite(si) && labels[si]) ? labels[si] : null;
        while (ci < chunks.length) {
          const c = chunks[ci];
          // 4 = DOCUMENT_POSITION_FOLLOWING (set for contained nodes too)
          if (c === m || (m.compareDocumentPosition(c) & 4)) break;
          ci++;
        }
        if (ci >= chunks.length) break;
        const prev = out[out.length - 1];
        if (prev && prev.chunkIdx === ci) {            // empty section collapsed
          if (!prev.label && label) prev.label = label;
          continue;
        }
        out.push({ chunkIdx: ci, label });
      }
    } catch (_) {}
    if (!out.length) out.push({ chunkIdx: 0, label: null });
    else if (out[0].chunkIdx !== 0) out.unshift({ chunkIdx: 0, label: null });
    return out;
  }

  async function _ensureFromDom(titleId, bookName, chunks, sections) {
    if (_building.has(titleId)) return _building.get(titleId);
    const job = (async () => {
      // Guard against the legacy manual pickEpub flow loading a book that
      // does NOT belong to the active title: verify the attachment name when
      // both sides are known.
      try {
        if (bookName && window.titleStore && window.titleStore.list) {
          const titles = await window.titleStore.list();
          const t = titles && titles.find && titles.find(x => x.id === titleId);
          const epName = t && t.attachments && t.attachments.epub && t.attachments.epub.name;
          if (epName && epName !== bookName) {
            // foreign book — also drop the DOM-ownership stamp so the poll
            // can't credit this book's positions to the active title
            if (_lastLoad && _lastLoad.titleId === titleId && _lastLoad.bookName === bookName) _lastLoad = null;
            return null;
          }
        }
      } catch (_) {}

      const fp = fpFromChunks(chunks);

      let map = await getMap(titleId);
      const mapFresh = !!(map && map.fingerprint === fp);
      const aiOn = !!(window.ai && window.ai.isEnabled && window.ai.isEnabled());

      // AITEXT: build/refresh on fingerprint mismatch. When the map is fresh,
      // only verify AITEXT once per session and only if AI is enabled (the
      // verify costs a multi-MB IndexedDB read; the processor needs the text
      // anyway, so it's not wasted).
      if (!mapFresh || (aiOn && !_textVerified.has(titleId))) {
        let text = await getText(titleId);
        if (!text || text.fingerprint !== fp) {
          const raw = flatTextOf(chunks);
          const last = chunks[chunks.length - 1];
          const jpTotal = (parseInt(last.dataset.jpOff, 10) || 0) +
                          (parseInt(last.dataset.jpLen, 10) || 0);
          text = {
            v: 1,
            fingerprint: fp,
            raw,
            ruby: rubyGlossaryOf(chunks),
            totals: { raw: raw.length, jp: jpTotal },
            sections: sections.map((s, i) => ({
              idx: i,
              rawStart: parseInt(chunks[s.chunkIdx].dataset.charOffset, 10) || 0,
              jpStart: parseInt(chunks[s.chunkIdx].dataset.jpOff, 10) || 0,
              label: s.label || null,
            })),
          };
          _cacheText(titleId, text);
          await bsSet(TEXT_PREFIX + titleId, JSON.stringify(text));
        } else if (!text.ruby) {
          // Backfill the glossary onto an AITEXT built before this feature
          // existed (raw + offsets unchanged, so the fingerprint still holds).
          try {
            text.ruby = rubyGlossaryOf(chunks);
            _cacheText(titleId, text);
            await bsSet(TEXT_PREFIX + titleId, JSON.stringify(text));
          } catch (_) {}
        }
        _textVerified.add(titleId);
      }

      if (mapFresh) {
        await refreshCueBounds(titleId);
        return map;
      }

      const built = await _buildMapFromDom(titleId, chunks, sections, fp);
      if (built) {
        _cacheMap(titleId, built);
        _mapMiss.delete(titleId);
        persistMap(titleId, built, true);
        await refreshCueBounds(titleId);
      }
      return built;
    })().catch(() => null).finally(() => { _building.delete(titleId); });
    _building.set(titleId, job);
    return job;
  }

  // ---- map building (doc §5 heuristic) -------------------------------------------
  async function _buildMapFromDom(titleId, chunks, sections, fp) {
    const info = infoFromChunks(chunks);
    const last = info[info.length - 1];
    const totalRaw = (parseInt(chunks[chunks.length - 1].dataset.charOffset, 10) || 0) +
                     (parseInt(chunks[chunks.length - 1].dataset.charLen, 10) || 0);
    const totalJp = last.jpLast;

    let bounds = null, labels = null, source = 'rule';
    // The book's OWN chapter markers (standalone numbers / 第N章) are the most
    // reliable signal — captured by the loader, free, no Haiku. Try first.
    const markers = (_lastLoad && _lastLoad.titleId === titleId) ? (_lastLoad.markers || []) : [];
    const mb = _markerBounds(markers, info, totalJp);
    if (mb) { bounds = mb.bounds; labels = mb.labels; source = 'markers'; }
    if (!bounds && sections.length > 1) {
      const nat = _naturalBounds(sections, info, totalJp);
      if (nat) { bounds = nat.bounds; labels = nat.labels; source = 'chapters'; }
    }
    if (!bounds) {
      bounds = _ruleBounds(info, totalJp);
      labels = bounds.map(() => null);
      source = 'rule';
      const text = _texts.get(titleId);
      const raw = (text && text.fingerprint === fp) ? text.raw : flatTextOf(chunks);
      const refined = await _haikuRefine(raw, info, bounds);
      if (refined) { bounds = refined.bounds; labels = refined.labels; source = 'haiku'; }
    }
    return _assembleMap(titleId, fp, bounds, labels, source, info, totalRaw, totalJp, 'raw');
  }

  // Chapter boundaries from the book's own markers. Each marker.jpOff is a
  // chunk's jpOff (the chapter's first real paragraph). Requires ≥3 markers and
  // a sane average chapter size (guards against false-positive numeric lines).
  function _snapChunkAtJp(info, jp) {
    for (let i = 0; i < info.length; i++) if (info[i].jp >= jp) return i;
    return info.length - 1;
  }
  function _markerBounds(markers, info, totalJp) {
    try {
      if (!Array.isArray(markers) || markers.length < 3 || !info.length || !totalJp) return null;
      // Chapter 1 starts at the first marker. The region before it is either
      // front matter (cover/TOC/copyright — drop) OR a prologue (substantial
      // narrative — keep as chunk 0). Distinguish by size: small = front matter.
      const bounds = [], labels = [];
      // Books split into 部 (parts) restart their section numbers at 1 each part
      // (Part 2's "第2章" follows Part 1's "第4章"), which reads as a broken
      // sequence in a flat timeline. Prefix each section with its owning part so
      // the reset is self-explanatory ("第二部　第2章"). curPart only advances on
      // a REAL emitted boundary, so a 目次/TOC page (which lists 第一部…第五部
      // close together, all dropped by the spacing guard) can't poison it.
      const partRe = /^第[一二三四五六七八九十百0-9０-９]+部/;
      let curPart = null;
      for (const m of markers) {
        const ci = _snapChunkAtJp(info, m.jpOff || 0);
        const isPart = !!(m.label && partRe.test(m.label));
        const lbl = (!isPart && curPart && m.label) ? (curPart + '　' + m.label) : (m.label || null);
        if (!bounds.length) { bounds.push(ci); labels.push(lbl); if (isPart) curPart = m.label; continue; }
        const last = bounds[bounds.length - 1];
        if (ci <= last) continue;   // non-increasing → skip dup
        // Spacing guard: chapter markers that are very close together are almost
        // always a TABLE OF CONTENTS (第一章/第二章/… listed on one page), not
        // real chapters. Require ≥2000 jp between consecutive boundaries.
        if (info[ci] && info[last] && (info[ci].jp - info[last].jp) < 2000) {
          // A part's section 1 sits right after its part heading and would be
          // dropped here, leaving a bare "第二部" card that looks like it's
          // missing 第1章. Fold the section into that part-heading label instead.
          if (!isPart && curPart && labels[labels.length - 1] === curPart) labels[labels.length - 1] = lbl;
          continue;
        }
        bounds.push(ci); labels.push(lbl);
        if (isPart) curPart = m.label;   // only a real, emitted part updates context
      }
      if (bounds.length < 3) return null;
      const firstCi = bounds[0];
      if (firstCi > 0) {
        const preJp = info[firstCi] ? info[firstCi].jp : 0;   // jp chars before chapter 1
        if (preJp >= PROLOGUE_MIN_JP) { bounds.unshift(0); labels.unshift('序章'); }  // prologue → keep
        // else: front matter → left out (no card, never summarized)
      }
      if (totalJp / bounds.length < 2500) return null;    // too many → not real chapters
      return { bounds, labels };
    } catch (_) { return null; }
  }

  // Step 1: merge spine sections <5k jp forward, evaluate naturalness, split
  // oversized sections at ~12k targets on chunk starts (preferring headings).
  function _naturalBounds(sections, info, totalJp) {
    const secs = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const start = info[s.chunkIdx] ? info[s.chunkIdx].jp : 0;
      const next = sections[i + 1];
      const end = (next && info[next.chunkIdx]) ? info[next.chunkIdx].jp : totalJp;
      if (end > start) secs.push({ chunkIdx: s.chunkIdx, label: s.label, jpStart: start, jpEnd: end });
    }
    if (!secs.length) return null;
    // front matter (empty/dropped leading sections) belongs to chapter 1
    secs[0].chunkIdx = 0;
    secs[0].jpStart = 0;

    const merged = [];
    let cur = null;
    for (const s of secs) {
      if (!cur) { cur = { chunkIdx: s.chunkIdx, label: s.label, jpStart: s.jpStart, jpEnd: s.jpEnd }; continue; }
      if (cur.jpEnd - cur.jpStart < MERGE_MIN_JP) {
        cur.jpEnd = s.jpEnd;
        if (!cur.label) cur.label = s.label;
      } else {
        merged.push(cur);
        cur = { chunkIdx: s.chunkIdx, label: s.label, jpStart: s.jpStart, jpEnd: s.jpEnd };
      }
    }
    if (cur) {
      if (merged.length && cur.jpEnd - cur.jpStart < MERGE_MIN_JP) {
        merged[merged.length - 1].jpEnd = cur.jpEnd;
        if (!merged[merged.length - 1].label && cur.label) merged[merged.length - 1].label = cur.label;
      } else merged.push(cur);
    }

    let naturalJp = 0;
    for (const s of merged) {
      const len = s.jpEnd - s.jpStart;
      if (len >= MERGE_MIN_JP && len <= SPLIT_MAX_JP) naturalJp += len;
    }
    if (!totalJp || naturalJp / totalJp < NATURAL_RATIO) return null;

    const bounds = [], labels = [];
    for (const s of merged) {
      if (!bounds.length || s.chunkIdx > bounds[bounds.length - 1]) {
        bounds.push(s.chunkIdx);
        labels.push(s.label || null);
      }
      const len = s.jpEnd - s.jpStart;
      if (len > SPLIT_MAX_JP) {
        const parts = Math.max(2, Math.round(len / TARGET_JP));
        for (let k = 1; k < parts; k++) {
          const targetJp = s.jpStart + (len * k) / parts;
          const ci = _snapChunkToJp(info, targetJp, bounds[bounds.length - 1], s.jpEnd);
          if (ci > bounds[bounds.length - 1]) { bounds.push(ci); labels.push(null); }
        }
      }
    }
    if (!bounds.length) return null;
    return { bounds, labels };
  }

  function _snapChunkToJp(info, targetJp, minChunkIdx, jpLimit) {
    let best = -1, bestD = Infinity, bestHead = -1, bestHeadD = Infinity;
    for (let i = minChunkIdx + 1; i < info.length; i++) {
      const c = info[i];
      if (c.jp >= jpLimit) break;
      const d = Math.abs(c.jp - targetJp);
      if (d < bestD) { bestD = d; best = i; }
      if (c.head && d < HEAD_SNAP_JP && d < bestHeadD) { bestHeadD = d; bestHead = i; }
      if (c.jp > targetJp + HEAD_SNAP_JP) break;
    }
    return bestHead >= 0 ? bestHead : best;
  }

  // Step 2 provisional: boundaries every ~12k jp on chunk/cue starts; a runt
  // tail (<5k) merges back into the previous piece.
  function _ruleBounds(info, totalJp) {
    const bounds = [0];
    let lastJp = 0;
    for (let i = 1; i < info.length; i++) {
      if (info[i].jp - lastJp >= TARGET_JP) { bounds.push(i); lastJp = info[i].jp; }
    }
    if (bounds.length > 1 && totalJp - lastJp < MERGE_MIN_JP) bounds.pop();
    return bounds;
  }

  // ONE structured-output Haiku call: per provisional boundary, a ±WIN_HALF
  // window of raw text goes up; offsets + ≤12-char neutral labels come back.
  // Result boundaries snap to chunk starts inside each window. Any failure →
  // null (caller keeps the provisional 'rule' map; never blocks).
  async function _haikuRefine(raw, info, bounds) {
    try {
      if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) return null;
      // Opt-in per book: no PAID segmentation until the title is activated.
      // (The programmatic rule/chapters map still builds for free, so the
      // timeline shows structure; activate() then runs _retrySegmentation.)
      if (window.ai.activatedSync && !window.ai.activatedSync(window._activeTitleId)) return null;
      if (!window.ai.request || bounds.length < 2 || !raw) return null;
      const inner = bounds.slice(1, 1 + MAX_SEG_WINDOWS);
      let half = WIN_HALF;
      while (inner.length * half * 2 > MAX_SEG_CHARS && half > 400) half = (half / 2) | 0;
      const wins = inner.map((ci, k) => {
        const center = info[ci].raw;
        const lo = Math.max(0, center - half);
        const hi = Math.min(raw.length, center + half);
        return { k, ci, lo, hi };
      });
      let content =
        '長編テキストの境界候補ごとに、その前後の本文の断片を示します。各断片について、' +
        '最も自然な章の切れ目の位置(offset)と中立的な見出し(label)を返してください。\n';
      for (const w of wins) content += '\n【断片' + w.k + '】\n' + raw.slice(w.lo, w.hi) + '\n';

      const model = (window.ai.modelFor ? window.ai.modelFor('segment') : null) ||
                    (window.ai.MODELS && window.ai.MODELS.cheap) || undefined;
      const r = await window.ai.request({
        feature: 'segment',
        model,
        system: SEG_SYSTEM,
        maxTokens: Math.min(8000, 200 + wins.length * 60),
        outputSchema: SEG_SCHEMA,
        retryable: true,
        messages: [{ role: 'user', content }],
      });
      const parsed = JSON.parse(r.text);
      if (!parsed || !Array.isArray(parsed.boundaries)) return null;
      const byK = new Map();
      for (const it of parsed.boundaries) {
        if (it && Number.isFinite(it.i)) byK.set(it.i, it);
      }
      const outBounds = [0];
      const outLabels = [null];
      for (const w of wins) {
        let ci = w.ci;
        let label = null;
        const it = byK.get(w.k);
        if (it) {
          if (typeof it.label === 'string') label = it.label.trim().slice(0, 12) || null;
          if (Number.isFinite(it.offset)) {
            const rawPos = w.lo + Math.max(0, Math.min(w.hi - w.lo, it.offset));
            const snapped = _snapChunkToRaw(info, rawPos, w.lo, w.hi);
            if (snapped >= 0) ci = snapped;
          }
        }
        if (ci > outBounds[outBounds.length - 1]) { outBounds.push(ci); outLabels.push(label); }
      }
      // boundaries beyond the window cap keep their provisional spots
      for (let k = 1 + MAX_SEG_WINDOWS; k < bounds.length; k++) {
        if (bounds[k] > outBounds[outBounds.length - 1]) { outBounds.push(bounds[k]); outLabels.push(null); }
      }
      if (outBounds.length < 2) return null;
      return { bounds: outBounds, labels: outLabels };
    } catch (_) { return null; }
  }

  // Nearest chunk start to rawPos constrained to [lo, hi]; -1 when none.
  function _snapChunkToRaw(info, rawPos, lo, hi) {
    let a = 0, b = info.length - 1;
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if (info[m].raw <= rawPos) a = m; else b = m - 1;
    }
    let best = -1, bestD = Infinity;
    for (let i = Math.max(0, a - 1); i <= Math.min(info.length - 1, a + 2); i++) {
      const r = info[i].raw;
      if (r < lo || r > hi) continue;
      const d = Math.abs(r - rawPos);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Universal post-split: divide any chapter whose jp span exceeds SPLIT_TARGET_JP
  // into roughly-even parts, snapped to chunk starts, labeled "<base>（k/n）" — so a
  // book whose markers yield just 2 huge chapters becomes readable parts. Applies to
  // ALL bound sources (markers / natural / rule / haiku); the marker path in
  // particular never split. Best-effort: a chapter with no internal chunk boundary
  // to split on stays whole. Never returns FEWER bounds than it got (safety).
  function _splitOversized(bounds, labels, info, totalJp) {
    try {
      if (!Array.isArray(bounds) || !bounds.length || !info || !info.length) return { bounds, labels };
      const SPLIT_TARGET_JP = splitTargetJp();   // settable (Preferences); Infinity = off
      if (!Number.isFinite(SPLIT_TARGET_JP)) return { bounds, labels };   // off → no split
      const outB = [], outL = [];
      let chapterNum = 0;
      for (let i = 0; i < bounds.length; i++) {
        const startCi = bounds[i];
        const startJp = info[startCi] ? info[startCi].jp : 0;
        const endJp = (i + 1 < bounds.length && info[bounds[i + 1]]) ? info[bounds[i + 1]].jp : totalJp;
        const span = endJp - startJp;
        chapterNum++;
        if (!(span > SPLIT_TARGET_JP)) { outB.push(startCi); outL.push(labels[i] || null); continue; }
        const base = (labels[i] && String(labels[i]).trim()) ? String(labels[i]).trim() : ('第' + chapterNum + '章');
        const n = Math.max(2, Math.round(span / TARGET_JP));
        let prevCi = startCi;
        outB.push(startCi); outL.push(base + '（1/' + n + '）');
        for (let k = 1; k < n; k++) {
          const tJp = startJp + (span * k) / n;
          const ci = _snapChunkToJp(info, tJp, prevCi, endJp);
          if (ci > prevCi) { outB.push(ci); outL.push(base + '（' + (k + 1) + '/' + n + '）'); prevCi = ci; }
        }
      }
      return (outB.length >= bounds.length) ? { bounds: outB, labels: outL } : { bounds, labels };
    } catch (_) { return { bounds, labels }; }
  }

  function _assembleMap(titleId, fp, bounds, labels, source, info, totalRaw, totalJp, space) {
    // Split oversized chapters in RAW/read space only. The cue path's caller derives
    // cueStart/cueEnd from its own (unsplit) bounds after this returns, so re-splitting
    // there would desync chunk↔cue; cue rule-bounds are already ~TARGET_JP anyway.
    if (space !== 'cue') {
      const sp = _splitOversized(bounds, labels, info, totalJp);
      bounds = sp.bounds; labels = sp.labels;
    }
    const old = _maps.get(titleId);
    const chunksOut = [];
    for (let k = 0; k < bounds.length; k++) {
      const ci = bounds[k];
      const next = (k + 1 < bounds.length) ? bounds[k + 1] : -1;
      chunksOut.push({
        idx: k,
        startChunk: ci,                                    // DOM chunk / cue idx at build time
        // chunk 0's start is its real offset (0 for every source except
        // 'markers', where front matter before chapter 1 is excluded).
        rawStart: info[ci] ? info[ci].raw : 0,
        rawEnd: next >= 0 ? info[next].raw : totalRaw,
        jpStart: info[ci] ? info[ci].jp : 0,
        jpEnd: next >= 0 ? info[next].jp : totalJp,
        cueStart: -1,
        cueEnd: -1,
        label: labels[k] || null,
        state: 'none',
        attempts: 0,
        error: null,
        processedTs: null,
      });
    }
    return {
      v: 1,
      fingerprint: fp,
      source,
      space,                                               // 'raw' | 'cue' (gating axis)
      totals: { raw: totalRaw, jp: totalJp, cues: 0 },
      // User progress survives a same-space rebuild (renamed file etc.).
      furthest: (old && old.space === space && old.furthest)
        ? { jp: old.furthest.jp || 0, cue: Number.isFinite(old.furthest.cue) ? old.furthest.cue : -1 }
        : { jp: 0, cue: -1 },
      synopsis: '',
      unresolved: [],
      chunks: chunksOut,
    };
  }

  // ---- SRT-only titles (no EPUB/TXT — map lives in cue space, §2) -----------------

  // First cue index whose startMs >= ms (== cues.length past the last cue).
  function _cueIdxAtMs(cues, ms) {
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].startMs < ms) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // TIME-anchored cue maps (chunks carry msStart): derive every per-chunk
  // range (cue/raw/jp) + totals from the CURRENT cue list. Bound times never
  // move, so a growing auto-transcription only ever refines the derived
  // fields — chapters wholly beyond the transcribed frontier hold empty
  // ranges (cueStart > cueEnd) until their cues arrive. Returns true when
  // anything changed.
  function _applyCueTimeRanges(map, cues, cc) {
    let changed = false;
    const n = map.chunks.length;
    for (let k = 0; k < n; k++) {
      const ch = map.chunks[k];
      const cs = _cueIdxAtMs(cues, ch.msStart);
      const ceExcl = (k + 1 < n) ? _cueIdxAtMs(cues, map.chunks[k + 1].msStart) : cues.length;
      const rawStart = cs < cues.length ? cc.offsets[cs] : cc.text.length;
      const rawEnd = ceExcl < cues.length ? cc.offsets[ceExcl] : cc.text.length;
      const jpStart = cs < cues.length ? cc.jpOffs[cs] : cc.totalJp;
      const jpEnd = ceExcl < cues.length ? cc.jpOffs[ceExcl] : cc.totalJp;
      if (ch.cueStart !== cs || ch.cueEnd !== ceExcl - 1 || ch.rawStart !== rawStart ||
          ch.rawEnd !== rawEnd || ch.jpStart !== jpStart || ch.jpEnd !== jpEnd) {
        ch.cueStart = cs; ch.cueEnd = ceExcl - 1; ch.startChunk = cs;
        ch.rawStart = rawStart; ch.rawEnd = rawEnd; ch.jpStart = jpStart; ch.jpEnd = jpEnd;
        changed = true;
      }
    }
    if (map.totals.raw !== cc.text.length || map.totals.jp !== cc.totalJp || map.totals.cues !== cues.length) {
      map.totals.raw = cc.text.length; map.totals.jp = cc.totalJp; map.totals.cues = cues.length;
      changed = true;
    }
    return changed;
  }

  // autocues fingerprints ('autocues|<name>|<size>') compare name-only when
  // either side carries size 0: a transient Filesystem.stat failure stamps
  // size 0, and treating that as a DIFFERENT audio file would rebuild the
  // map and orphan every chapter artifact (mirrors auto-transcribe's
  // sigMatches tolerance).
  function _autoFpEq(a, b) {
    if (a === b) return true;
    if (!a || !b || a.indexOf('autocues|') !== 0 || b.indexOf('autocues|') !== 0) return false;
    const split = (s) => { const i = s.lastIndexOf('|'); return [s.slice(9, i), s.slice(i + 1)]; };
    const [na, sa] = split(a), [nb, sb] = split(b);
    return na === nb && (sa === '0' || sb === '0');
  }

  async function _ensureFromCues(titleId, cues, force) {
    if (_building.has(titleId)) return _building.get(titleId);
    const job = (async () => {
      // Auto-transcribed titles get a STABLE fingerprint keyed to the audio
      // file — the cue list is still growing, and fpFromCues would churn on
      // every batch, orphaning all chapter artifacts (filterArtifacts).
      let autoFp = null;
      try { autoFp = await (window.autoTranscribe && window.autoTranscribe.stableFp && window.autoTranscribe.stableFp(titleId)); } catch (_) {}
      const fp = autoFp || fpFromCues(cues);
      const existing = await getMap(titleId);
      if (!force && existing && (existing.space !== 'cue' || _autoFpEq(existing.fingerprint, fp))) return existing;
      const cc = cueConcat(cues);
      const info = cues.map((c, i) => ({ i, raw: cc.offsets[i], jp: cc.jpOffs[i], head: false }));
      // Chapter bounds, best source first:
      //   1. embedded audio chapter markers (m4b, native read) — real titles
      //   2. 30-minute time slices for audiobooks without markers
      //   3. legacy ~12k-jp rule (+ Haiku refine) for time-less cue sets
      let bounds = null, labels = null, msBounds = null;
      const timed = !!(cues[0] && Number.isFinite(cues[0].startMs));
      if (timed) {
        let markers = [];
        try { markers = (await (window.autoTranscribe && window.autoTranscribe.getAudioChapters && window.autoTranscribe.getAudioChapters(titleId))) || []; } catch (_) {}
        markers = (markers || []).filter(m => m && Number.isFinite(m.startMs));
        // FULL audio duration, not the transcribed frontier: mid-transcription
        // the last cue is only minutes in, and gating the 30-min slices on it
        // built a time-less rule map that then froze forever (no msStart →
        // refreshCueMap can't re-derive it).
        let fullDur = 0;
        try { fullDur = (await (window.autoTranscribe && window.autoTranscribe.durationFor && window.autoTranscribe.durationFor(titleId))) || 0; } catch (_) {}
        const durMs = Math.max(fullDur, cues[cues.length - 1].endMs || 0);
        if (markers.length >= 2) {
          msBounds = []; labels = [];
          if (markers[0].startMs > 60000) { msBounds.push(0); labels.push(null); }
          for (const m of markers) {
            const last = msBounds.length ? msBounds[msBounds.length - 1] : -Infinity;
            if (m.startMs - last < 60000) continue;   // micro-chapter guard
            msBounds.push(m.startMs); labels.push(m.title || null);
          }
        } else if (durMs >= 40 * 60 * 1000) {
          msBounds = []; labels = [];
          for (let ms = 0; ms < durMs - 5 * 60 * 1000; ms += 30 * 60 * 1000) {
            msBounds.push(ms); labels.push(null);
          }
        }
        if (msBounds && msBounds.length >= 2) {
          bounds = msBounds.map(ms => Math.min(_cueIdxAtMs(cues, ms), cues.length - 1));
        } else {
          msBounds = null; labels = null;
        }
      }
      if (!bounds) {
        bounds = _ruleBounds(info, cc.totalJp);
        labels = bounds.map(() => null);
        const refined = await _haikuRefine(cc.text, info, bounds);
        if (refined) { bounds = refined.bounds; labels = refined.labels; }
      }
      const map = _assembleMap(titleId, fp, bounds, labels, 'cues', info, cc.text.length, cc.totalJp, 'cue');
      map.totals.cues = cues.length;
      for (let k = 0; k < map.chunks.length; k++) {
        map.chunks[k].cueStart = bounds[k];
        map.chunks[k].cueEnd = (k + 1 < bounds.length) ? bounds[k + 1] - 1 : cues.length - 1;
        if (msBounds) map.chunks[k].msStart = msBounds[k];
      }
      // Time-anchored bounds: derive the real ranges (incl. empty ranges for
      // chapters past the transcribed frontier) from the anchor times, and
      // record the FULL audio duration so the timeline axis spans the whole
      // book (last-cue end only reaches the transcription frontier).
      if (msBounds) {
        _applyCueTimeRanges(map, cues, cc);
        let durMs = 0;
        try { durMs = (await (window.autoTranscribe && window.autoTranscribe.durationFor && window.autoTranscribe.durationFor(titleId))) || 0; } catch (_) {}
        map.durMs = Math.max(durMs, cues[cues.length - 1].endMs || 0);
      }
      _cacheMap(titleId, map);
      _mapMiss.delete(titleId);
      persistMap(titleId, map, true);
      return map;
    })().catch(() => null).finally(() => { _building.delete(titleId); });
    _building.set(titleId, job);
    return job;
  }

  // Public: re-derive a TIME-anchored cue map from the live (growing) cue
  // list — called by auto-transcribe.js as new cues finalize. Also serves as
  // the build retry for titles whose cues arrived after the one-shot
  // title-change build window.
  async function refreshCueMap(titleId) {
    try {
      if (!titleId || titleId !== window._activeTitleId) return;
      const cues = window._srtCues;
      if (!Array.isArray(cues) || !cues.length) return;
      const map = await getMap(titleId);
      if (!map) {
        if (await _isSrtOnly(titleId)) await _ensureFromCues(titleId, cues);
        return;
      }
      if (map.space !== 'cue' || !map.chunks.length) return;
      if (!Number.isFinite(map.chunks[0].msStart)) {
        // Time-less rule map (built before duration/markers were known, or
        // pre-fix). It can never re-derive ranges, so with today's data it
        // is a trap: phrase-split re-indexing leaves its saved cue/raw
        // bounds pointing at wrong text. Upgrade ONCE per session by force-
        // rebuilding — same stable fingerprint, so artifacts keyed to it
        // survive; if bounds still can't be timed it just rebuilds the rule
        // map with fresh indices, which is strictly better than stale ones.
        if (!_msUpgradeTried.has(titleId)) {
          _msUpgradeTried.add(titleId);
          await _ensureFromCues(titleId, cues, true);
        }
        return;
      }
      _ccCache = null;   // cues grow by IN-PLACE mutation — bust the ref-keyed memo
      const cc = cueConcat(cues);
      let changed = _applyCueTimeRanges(map, cues, cc);
      let durMs = 0;
      try { durMs = (await (window.autoTranscribe && window.autoTranscribe.durationFor && window.autoTranscribe.durationFor(titleId))) || 0; } catch (_) {}
      const bestDur = Math.max(durMs, cues[cues.length - 1].endMs || 0, map.durMs || 0);
      if (bestDur > (map.durMs || 0)) { map.durMs = bestDur; changed = true; }
      if (changed) persistMap(titleId, map, true);
    } catch (_) {}
  }

  // True when the title has NO book-text attachment (epub key also carries
  // .txt books) — those titles get a cue-space map; the reader-DOM path owns
  // everything else. Unknowable (no titleStore) → false, build nothing.
  async function _isSrtOnly(titleId) {
    try {
      if (!window.titleStore || !window.titleStore.list) return false;
      const titles = await window.titleStore.list();
      const t = titles && titles.find && titles.find(x => x.id === titleId);
      if (!t) return false;
      const at = t.attachments || {};
      // A SYNTHETIC book (auto:true, generated from the transcription) does
      // not flip the title to the reader-DOM map: the cue-space map stays
      // canonical so its chapter summaries/characters/scenes survive.
      if (at.epub && !at.epub.auto && (at.epub.uri || at.epub.name)) return false;
      return !!at.srt || (Array.isArray(window._srtCues) && window._srtCues.length > 0);
    } catch (_) { return false; }
  }

  const _msUpgradeTried = new Set();   // one force-rebuild attempt per title/session

  async function _maybeCueBuild() {
    try {
      const titleId = window._activeTitleId;
      if (!titleId) return;
      const cues = window._srtCues;
      if (!Array.isArray(cues) || !cues.length) return;
      if (!(await _isSrtOnly(titleId))) return;
      if (titleId !== window._activeTitleId || cues !== window._srtCues) return; // switched mid-await
      await _ensureFromCues(titleId, cues);
      // ALWAYS re-derive ranges against the CURRENT cue list on open. The
      // stable fingerprint returns the existing map untouched, but its saved
      // cue/raw ranges were computed against an older cue indexing (live
      // growth, phrase re-splitting) — and after the title finalizes its SRT
      // the transcriber never refreshes again, so this open-time pass is the
      // only thing that unfreezes chapters left with empty ranges mid-
      // transcription (they wedged the processing pump).
      await refreshCueMap(titleId);
    } catch (_) {}
  }

  // ---- progress & completion (5s foreground poll, pure observer) -----------------
  let _staleCue;        // _lastAudioCueIdx / currentCardIndex snapshots at
  let _staleCard;       // title-change: a value that hasn't CHANGED since the
                        // switch may belong to the previous title and must not
                        // raise furthest.cue (permanent false completions).
  let _pollTitle;       // poll-level title ownership: deck-based opens never
                        // fire shell:title-change, so the poll re-arms itself.
  let _pollLoading = false;
  let _pollTicks = 0;

  function _armStale() {
    _staleCue = window._lastAudioCueIdx;
    _staleCard = window.currentCardIndex;
  }

  function _currentCue() {
    let cue = -1;
    try {
      const a = window._lastAudioCueIdx;
      if (Number.isFinite(a) && a !== _staleCue) cue = a;
    } catch (_) {}
    try {
      if (Number.isFinite(window.currentCardIndex) &&
          window.currentCardIndex !== _staleCard &&
          typeof window._srtCardToCueAnchor === 'function' &&
          Array.isArray(window.allNotes) && window.allNotes.length) {
        const c = window._srtCardToCueAnchor(window.currentCardIndex);
        if (Number.isFinite(c)) cue = Math.max(cue, c);
      }
    } catch (_) {}
    return cue;
  }

  function _completeAt(map, ch, jp, cue) {
    // ONE space per comparison (§2): jp vs jp, cue vs cue — never converted.
    // A time-anchored chapter past the transcribed frontier has an EMPTY cue
    // range (cueStart > cueEnd) — it can't be complete, its text isn't there.
    if (map.space === 'cue' && ch.cueStart > ch.cueEnd) return false;
    if (map.space !== 'cue' && ch.jpEnd > ch.jpStart && jp >= ch.jpEnd) return true;
    if (ch.cueEnd >= 0 && cue >= ch.cueEnd) return true;
    return false;
  }

  function isComplete(map, idx) {
    try {
      if (!map || !Array.isArray(map.chunks) || !map.chunks[idx]) return false;
      const f = map.furthest || { jp: 0, cue: -1 };
      return _completeAt(map, map.chunks[idx], f.jp || 0, Number.isFinite(f.cue) ? f.cue : -1);
    } catch (_) { return false; }
  }

  function _pollTick() {
    try {
      _pollTicks++;
      if (window._kaiAiPaused) return;        // perf-probe kill switch
      if (document.hidden) return;
      const titleId = window._activeTitleId;
      if (!titleId) return;
      if (titleId !== _pollTitle) {
        // title changed under us — re-arm staleness and skip this tick so the
        // OLD title's cue/card cursors can't be credited to the NEW map
        _pollTitle = titleId;
        _armStale();
        return;
      }
      const map = _maps.get(titleId);
      if (!map) {
        if (!_mapMiss.has(titleId) && !_pollLoading) {
          _pollLoading = true;   // async warm; the next tick sees the cache
          getMap(titleId).catch(() => {}).finally(() => { _pollLoading = false; });
        }
        return;
      }
      if (!map.furthest) map.furthest = { jp: 0, cue: -1 };
      const f = map.furthest;
      const prevJp = f.jp || 0;
      const prevCue = Number.isFinite(f.cue) ? f.cue : -1;

      let jp = -1;
      // jp progress is only trustworthy when the reader DOM holds THIS
      // title's book (the loader hook stamps ownership).
      if (map.space !== 'cue' && _lastLoad && _lastLoad.titleId === titleId) {
        // PREFER the deepest VISIBLE read frontier — pagedGetReadLocation is
        // only the audio playhead, so silent reading would never advance it
        // (chapters read without read-along audio went unprocessed).
        try {
          if (typeof window.pagedGetReadFrontier === 'function') {
            const fr = window.pagedGetReadFrontier();
            if (Number.isFinite(fr)) jp = fr;
          }
        } catch (_) {}
        if (typeof window.pagedGetReadLocation === 'function') {
          const loc = window.pagedGetReadLocation();
          if (loc && Number.isFinite(loc.jpOff)) {
            let ploc = loc.jpOff;
            // jpOff is the highlighted chunk's START, so the book's FINAL
            // chapter could otherwise never reach jpEnd — credit the last
            // chunk's own length once the highlight lands on it.
            try {
              const chs = _lastLoad.chunks;
              if (Number.isFinite(loc.chunkIdx) && loc.chunkIdx === chs.length - 1) {
                ploc = loc.jpOff + (parseInt(chs[loc.chunkIdx].dataset.jpLen, 10) || 0);
              }
            } catch (_) {}
            if (ploc > jp) jp = ploc;
          }
        }
      }
      const cue = _currentCue();
      // Cue-space maps: derive the jp frontier from the current cue so the
      // read-frontier event fires and ai-scenes can unlock for audio titles.
      if (map.space === 'cue' && cue >= 0 &&
          Array.isArray(window._srtCues) && window._srtCues.length) {
        try {
          const cc = cueConcat(window._srtCues);
          const ci = Math.min(cue, cc.jpOffs.length - 1);
          if (ci >= 0 && cc.jpOffs[ci] > jp) jp = cc.jpOffs[ci];
        } catch (_) {}
      }

      let changed = false, jpAdvanced = false;
      if (jp > prevJp) { f.jp = jp; changed = true; jpAdvanced = true; }
      if (cue > prevCue) { f.cue = cue; changed = true; }

      // Lazy cue-bound re-check (~60s) while an alignment may still be missing.
      if (map.space !== 'cue' && (_pollTicks % 12) === 0 &&
          map.chunks.some(c => c.cueEnd < 0) &&
          Array.isArray(window._srtCues) && window._srtCues.length) {
        refreshCueBounds(titleId).catch(() => {});
      }
      if (!changed) return;

      const fired = [];
      for (let k = 0; k < map.chunks.length; k++) {
        const ch = map.chunks[k];
        if (!_completeAt(map, ch, prevJp, prevCue) && _completeAt(map, ch, f.jp, f.cue)) fired.push(k);
      }
      persistMap(titleId, map, fired.length > 0);
      for (const k of fired) {
        try {
          window.dispatchEvent(new CustomEvent('kai:chunk-completed', { detail: { titleId, idx: k } }));
        } catch (_) {}
      }
      // Read frontier advanced → let ai-scenes.js unlock any 6k boundaries crossed.
      if (jpAdvanced) { try { window.dispatchEvent(new CustomEvent('kai:read-frontier', { detail: { titleId, jp: f.jp } })); } catch (_) {} }
    } catch (_) {}
  }
  setInterval(_pollTick, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    try { if (document.hidden) _flushDirty(); } catch (_) {}
  });
  window.addEventListener('shell:title-change', () => {
    try {
      _armStale();
      _flushDirty();
      // cue arrays land slightly after the event on some paths; small defer
      setTimeout(() => { _maybeCueBuild(); }, 1200);
    } catch (_) {}
  });

  // ---- cue bounds from CUE_ALIGN (lazy; tolerant of absence — never builds) ------
  async function refreshCueBounds(titleId) {
    try {
      const map = await getMap(titleId);
      if (!map || map.space === 'cue' || !map.chunks.length) return;
      if (!window.cueAlignment || !window.cueAlignment.loadAlignment) return;
      const a = await window.cueAlignment.loadAlignment(titleId, null);
      if (!a || !a.cueCount || !a.ranges) return;
      // the alignment must describe the same flat text this map was built on
      if (map.totals && map.totals.raw && a.totalChars && a.totalChars !== map.totals.raw) return;
      const ms = [];   // matched cues; rs AND re ascend (forward-only matcher)
      for (let i = 0; i < a.cueCount; i++) {
        const rs = a.ranges[2 * i];
        if (rs >= 0) ms.push({ i, rs, re: a.ranges[2 * i + 1] });
      }
      if (!ms.length) return;
      let changed = false;
      for (const ch of map.chunks) {
        // §2: cueStart = first cue starting ≥ rawStart; cueEnd = last cue
        // whose rawEnd ≤ rawEnd.
        let lo = 0, hi = ms.length - 1, start = -1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (ms[m].rs >= ch.rawStart) { start = m; hi = m - 1; } else lo = m + 1;
        }
        lo = 0; hi = ms.length - 1;
        let end = -1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (ms[m].re <= ch.rawEnd) { end = m; lo = m + 1; } else hi = m - 1;
        }
        let cs = -1, ce = -1;
        if (start >= 0 && end >= 0 && ms[start].i <= ms[end].i) { cs = ms[start].i; ce = ms[end].i; }
        if (ch.cueStart !== cs || ch.cueEnd !== ce) { ch.cueStart = cs; ch.cueEnd = ce; changed = true; }
      }
      if (map.totals.cues !== a.cueCount) { map.totals.cues = a.cueCount; changed = true; }
      if (changed) persistMap(titleId, map, true);
    } catch (_) {}
  }

  // ---- public builds --------------------------------------------------------------
  async function ensure(titleId) {
    try {
      if (!titleId) return null;
      const existing = await getMap(titleId);
      if (existing) return existing;
      if (titleId !== window._activeTitleId) return null;   // builds need live data
      if (_lastLoad && _lastLoad.titleId === titleId) {
        return await _ensureFromDom(titleId, _lastLoad.bookName, _lastLoad.chunks, _lastLoad.sections);
      }
      const cues = window._srtCues;
      if (Array.isArray(cues) && cues.length && (await _isSrtOnly(titleId))) {
        // switched mid-await → _srtCues may still be the PREVIOUS title's
        if (titleId !== window._activeTitleId || cues !== window._srtCues) return null;
        return await _ensureFromCues(titleId, cues);
      }
      return null;
    } catch (_) { return null; }
  }

  async function chunkText(titleId, idx) {
    try {
      const map = await getMap(titleId);
      if (!map || !map.chunks[idx]) return null;
      const ch = map.chunks[idx];
      if (map.space === 'cue') {
        if (titleId !== window._activeTitleId) return null;
        const cues = window._srtCues;
        if (!Array.isArray(cues) || !cues.length) return null;
        // autocues| maps are audio-keyed (stable across cue growth) — their
        // offsets are kept current by refreshCueMap, not by fp equality.
        if (map.fingerprint.indexOf('autocues|') !== 0 && map.fingerprint !== fpFromCues(cues)) return null;
        return cueConcat(cues).text.slice(ch.rawStart, ch.rawEnd);
      }
      const text = await getText(titleId);
      if (!text || typeof text.raw !== 'string') return null;
      if (text.fingerprint !== map.fingerprint) return null;
      return text.raw.slice(ch.rawStart, ch.rawEnd);
    } catch (_) { return null; }
  }

  // Spoiler-safe variant for AUTO scenes: a chapter's text truncated to the read
  // frontier (jp). Returns only what the reader has actually passed, so a server
  // scene-pick can never draw on unread text. jp→raw is interpolated within the
  // chapter and trimmed CONSERVATIVELY (×0.97 + to the last paragraph break) so a
  // jp/raw-count mismatch can't leak ahead. Read (jp-space) titles use the
  // AITEXT cache; audio-only (cue-space) titles slice the live cue concat —
  // their jp frontier comes from the current audio cue (_pollTick), so the
  // same jp cut applies (this used to hard-reject cue maps, which silently
  // disabled auto-scenes for every audio-only title).
  async function chunkTextUpToJp(titleId, idx, frontierJp) {
    try {
      const map = await getMap(titleId);
      if (!map || !map.chunks || !map.chunks[idx]) return null;
      const ch = map.chunks[idx];
      let raw = null;
      if (map.space === 'cue') {
        if (map.chunks[idx].cueStart > map.chunks[idx].cueEnd) return null;   // untranscribed chapter
        const cues = window._srtCues;
        if (!Array.isArray(cues) || !cues.length || !(ch.rawEnd > ch.rawStart)) return null;
        raw = cueConcat(cues).text;
        if (ch.rawEnd > raw.length) return null;   // stale ranges — refresh hasn't run yet
      } else {
        const text = await getText(titleId);
        if (!text || typeof text.raw !== 'string' || text.fingerprint !== map.fingerprint) return null;
        raw = text.raw;
      }
      let end = ch.rawEnd;
      const targetJp = Number.isFinite(frontierJp) ? (frontierJp - ch.jpStart) : Infinity;
      if (targetJp < (ch.jpEnd - ch.jpStart)) {
        if (typeof window.jpCharCount === 'function') {
          // EXACT cut, not a linear estimate: jp EXCLUDES punctuation/whitespace/
          // furigana, so jp-density varies within a chapter and interpolation can land
          // PAST the real read frontier (leaking unread text). Binary-search the
          // largest raw end whose in-chapter jp-count is still ≤ what's been read.
          let lo = ch.rawStart, hi = ch.rawEnd;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (window.jpCharCount(raw.slice(ch.rawStart, mid)) <= targetJp) lo = mid; else hi = mid - 1;
          }
          end = lo;
        } else {
          // jpCharCount unavailable → conservative linear fallback (never send full text)
          const frac = Math.max(0, Math.min(1, targetJp / (ch.jpEnd - ch.jpStart)));
          end = ch.rawStart + Math.floor((ch.rawEnd - ch.rawStart) * frac * 0.9);
        }
      }
      let s = raw.slice(ch.rawStart, Math.max(ch.rawStart, end));
      const nl = s.lastIndexOf('\n');
      if (nl > s.length * 0.5) s = s.slice(0, nl);   // don't end mid-sentence
      return s;
    } catch (_) { return null; }
  }

  // Manual retry of the segmentation carve-out (Update Timeline), only while
  // the map is still pristine — once any chunk has been processed, moving
  // boundaries would orphan artifacts, so it's a no-op.
  async function _retrySegmentation(titleId) {
    try {
      if (!titleId || !window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) return null;
      const map = await getMap(titleId);
      if (!map) return null;
      const pristine = map.chunks.every(c => !c.state || c.state === 'none') &&
                       map.chunks.every(c => !c.label);
      if (!pristine) return map;
      if (map.space === 'cue') {
        if (titleId !== window._activeTitleId) return map;
        const cues = window._srtCues;
        if (!Array.isArray(cues) || !cues.length || map.fingerprint !== fpFromCues(cues)) return map;
        const cc = cueConcat(cues);
        const info = cues.map((c, i) => ({ i, raw: cc.offsets[i], jp: cc.jpOffs[i], head: false }));
        const bounds = map.chunks.map(c => c.startChunk);
        if (!bounds.every(n => Number.isFinite(n))) return map;
        const refined = await _haikuRefine(cc.text, info, bounds);
        if (!refined) return map;
        const next = _assembleMap(titleId, map.fingerprint, refined.bounds, refined.labels, 'cues', info, cc.text.length, cc.totalJp, 'cue');
        next.totals.cues = cues.length;
        for (let k = 0; k < next.chunks.length; k++) {
          next.chunks[k].cueStart = refined.bounds[k];
          next.chunks[k].cueEnd = (k + 1 < refined.bounds.length) ? refined.bounds[k + 1] - 1 : cues.length - 1;
        }
        next.furthest = map.furthest;
        _cacheMap(titleId, next);
        persistMap(titleId, next, true);
        return next;
      }
      if (map.source !== 'rule') return map;
      if (!_lastLoad || _lastLoad.titleId !== titleId) return map;
      const text = await getText(titleId);
      if (!text || text.fingerprint !== map.fingerprint) return map;
      const info = infoFromChunks(_lastLoad.chunks);
      const bounds = map.chunks.map(c => c.startChunk);
      if (!bounds.every(n => Number.isFinite(n) && info[n])) return map;
      const refined = await _haikuRefine(text.raw, info, bounds);
      if (!refined) return map;
      const next = _assembleMap(titleId, map.fingerprint, refined.bounds, refined.labels, 'haiku', info, text.totals.raw, text.totals.jp, 'raw');
      next.furthest = map.furthest;
      _cacheMap(titleId, next);
      persistMap(titleId, next, true);
      await refreshCueBounds(titleId);
      return _maps.get(titleId) || next;
    } catch (_) { return null; }
  }

  // How many chapter markers the loader found for the active title (the UI uses
  // this to decide whether to offer "re-detect chapters").
  function markerCount(titleId) {
    try { return (_lastLoad && _lastLoad.titleId === titleId) ? (_lastLoad.markers || []).length : 0; }
    catch (_) { return 0; }
  }

  // FORCE a rebuild using the book's chapter markers, discarding the current
  // (rule/haiku) map. Returns the new map only when markers produced real
  // chapters (source 'markers'), else null (and leaves the old map intact).
  // Caller is responsible for clearing the now-orphaned per-chunk artifacts.
  async function reSegment(titleId) {
    try {
      if (!titleId || titleId !== window._activeTitleId) return null;
      if (!_lastLoad || _lastLoad.titleId !== titleId) return null;
      if (markerCount(titleId) < 3) return null;
      const chunks = _lastLoad.chunks, sections = _lastLoad.sections || [];
      if (!chunks || !chunks.length) return null;
      const fp = fpFromChunks(chunks);
      const old = _maps.get(titleId) || await getMap(titleId);
      const built = await _buildMapFromDom(titleId, chunks, sections, fp);
      if (!built || built.source !== 'markers') return null;
      if (old && old.furthest) built.furthest = old.furthest;
      _cacheMap(titleId, built);
      _mapMiss.delete(titleId);
      persistMap(titleId, built, true);
      await refreshCueBounds(titleId);
      return built;
    } catch (_) { return null; }
  }

  // Wipe a title's chunk map + flat text (in-memory + blobStore). Used by the
  // per-title AI reset. _lastLoad is kept so a re-activate can rebuild from the
  // live reader DOM without a reload.
  async function clearTitle(titleId) {
    try {
      if (!titleId) return;
      _maps.delete(titleId);
      _texts.delete(titleId);
      _mapMiss.delete(titleId);
      _textVerified.delete(titleId);
      if (_dirtyTitle === titleId) _dirtyTitle = null;
      if (window.blobStore && window.blobStore.remove) {
        try { await window.blobStore.remove(MAP_PREFIX + titleId); } catch (_) {}
        try { await window.blobStore.remove(TEXT_PREFIX + titleId); } catch (_) {}
      }
    } catch (_) {}
  }

  // Drop the in-memory caches for a title WITHOUT touching blobStore — so the
  // next read reloads from disk. Used after Drive sync overwrites a title's
  // AICHUNKS/AITEXT blobs: otherwise the stale canonical instance keeps serving
  // (and a later mutate() would write it back, undoing the pull). Also drops a
  // pending throttled write for this title so it can't clobber the fresh data.
  function invalidateCache(titleId) {
    try {
      if (!titleId) return;
      _maps.delete(titleId);
      _texts.delete(titleId);
      _mapMiss.delete(titleId);
      _textVerified.delete(titleId);
      if (_dirtyTitle === titleId) _dirtyTitle = null;
    } catch (_) {}
  }

  // Locate a scene's anchor quote in a chapter, expand it to its sentence, and (if the
  // title has an aligned audiobook) resolve the matching audio ms range. Returns
  // { expression, startMs?, endMs? } or null. Audio only when titleId is the active
  // title (window._srtCues/alignment describe THIS title) and a quote is located.
  async function cueRangeForQuote(titleId, chapterIdx, quote, opts) {
    try {
      const q = String(quote || '').trim();
      if (!q) return null;
      const map = await getMap(titleId);
      if (!map || !Array.isArray(map.chunks) || !map.chunks[chapterIdx]) return null;
      const chunk = map.chunks[chapterIdx];
      const chTxt = await chunkText(titleId, chapterIdx);
      if (!chTxt) return null;
      // Locate ALL occurrences (exact, else whitespace-insensitive with an index map
      // back), then pick the one NEAREST the persisted anchorOff hint. A chapter with
      // a duplicate/similar passage otherwise resolved to the wrong (usually first)
      // occurrence → audio bounds far off even though the cues are accurate.
      const anchorOff = (opts && Number.isFinite(opts.anchorOff)) ? opts.anchorOff : null;
      const qS0 = q.replace(/\s+/g, '');
      const hits = [];
      { let from = 0, k; while ((k = chTxt.indexOf(q, from)) >= 0) { hits.push({ i: k, qlen: q.length }); from = k + 1; } }
      if (!hits.length && qS0) {
        const stripped = [], idxMap = [];
        for (let k = 0; k < chTxt.length; k++) { if (!/\s/.test(chTxt[k])) { stripped.push(chTxt[k]); idxMap.push(k); } }
        const flatS = stripped.join('');
        let from = 0, j;
        while ((j = flatS.indexOf(qS0, from)) >= 0) { const ci = idxMap[j]; hits.push({ i: ci, qlen: (idxMap[j + qS0.length - 1] - ci) + 1 }); from = j + 1; }
      }
      if (!hits.length) return null;   // not found → caller falls back to caption, no audio
      let best = hits[0];
      if (anchorOff != null && hits.length > 1) best = hits.reduce((a, b) => Math.abs(b.i - anchorOff) < Math.abs(a.i - anchorOff) ? b : a, hits[0]);
      const i = best.i, qlen = best.qlen;
      // Ambiguous → DON'T trust the audio window (a wrong clip is worse than none —
      // the expression text still shows). Omit bounds when there are multiple matches
      // AND either the quote is too short to be distinctive or there's no anchorOff
      // hint to disambiguate. A single match keeps full behavior.
      const audioAmbiguous = (hits.length > 1) && (anchorOff == null || qS0.length < 8);
      // expand to the containing sentence (cap ~180 chars so it stays card-sized)
      const TERM = '。！？!?\n';
      let sStart = i;
      while (sStart > 0 && TERM.indexOf(chTxt[sStart - 1]) < 0 && (i - sStart) < 180) sStart--;
      let sEnd = i + qlen;
      while (sEnd < chTxt.length && TERM.indexOf(chTxt[sEnd - 1]) < 0 && (sEnd - i) < 180) sEnd++;
      if (sEnd < chTxt.length && TERM.indexOf(chTxt[sEnd]) >= 0) sEnd++;   // include the terminator
      const out = { expression: chTxt.slice(sStart, sEnd).trim() };
      if (audioAmbiguous) return out;   // expression only — ambiguous anchor, no reliable audio window
      // ---- audio ms (best-effort; skipped gracefully) ----
      if (titleId !== window._activeTitleId) return out;   // globals describe the active read title only
      const cues = window._srtCues;
      if (!Array.isArray(cues) || !cues.length) return out;
      // Cue-space map (audiobook+SRT): the chunk text IS cueConcat(cues).text sliced
      // by rawStart/rawEnd, so the sentence's char range maps DIRECTLY to cue indices
      // through the cueConcat offsets — no cueAlignment needed (that path is for
      // raw/jp text). Without this branch audiobook titles never get scene audio.
      if (map.space === 'cue') {
        const cc = cueConcat(cues);
        const off = cc.offsets;
        const gStart = chunk.rawStart + sStart, gEnd1 = Math.max(chunk.rawStart + sStart, chunk.rawStart + sEnd - 1);
        let lo = 0, hi = off.length - 1, cs = 0;   // start cue = last whose offset ≤ gStart
        while (lo <= hi) { const m = (lo + hi) >> 1; if (off[m] <= gStart) { cs = m; lo = m + 1; } else hi = m - 1; }
        let ce = cs; lo = 0; hi = off.length - 1;   // end cue = last whose offset ≤ the last char
        while (lo <= hi) { const m = (lo + hi) >> 1; if (off[m] <= gEnd1) { ce = m; lo = m + 1; } else hi = m - 1; }
        if (Number.isFinite(chunk.cueStart) && chunk.cueStart >= 0 && cs < chunk.cueStart) cs = chunk.cueStart;   // never bleed past the chapter
        if (Number.isFinite(chunk.cueEnd) && chunk.cueEnd >= 0 && ce > chunk.cueEnd) ce = chunk.cueEnd;
        if (cs <= ce && cues[cs] && cues[ce]) {
          const startMs = cues[cs].startMs, endMs = cues[ce].endMs;
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) { out.startMs = startMs; out.endMs = endMs; out.cueStart = cs; out.cueEnd = ce; }
        }
        return out;
      }
      if (!window.cueAlignment || !window.cueAlignment.loadAlignment) return out;
      const a = await window.cueAlignment.loadAlignment(titleId, null);
      if (!a || !a.cueCount || !a.ranges) return out;
      if (map.totals && map.totals.raw && a.totalChars && a.totalChars !== map.totals.raw) return out;   // alignment ≠ this text
      const rawStart = chunk.rawStart + sStart, rawEnd = chunk.rawStart + sEnd;
      const ms = [];
      for (let k = 0; k < a.cueCount; k++) { const rs = a.ranges[2 * k]; if (rs >= 0) ms.push({ i: k, rs, re: a.ranges[2 * k + 1] }); }
      if (!ms.length) return out;
      let lo = 0, hi = ms.length - 1, sp = -1;   // start cue = last matched with rs ≤ rawStart (covers the sentence start)
      while (lo <= hi) { const m = (lo + hi) >> 1; if (ms[m].rs <= rawStart) { sp = m; lo = m + 1; } else hi = m - 1; }
      if (sp < 0) sp = 0;
      lo = 0; hi = ms.length - 1; let ep = -1;   // end cue = first matched with re ≥ rawEnd (covers the sentence end)
      while (lo <= hi) { const m = (lo + hi) >> 1; if (ms[m].re >= rawEnd) { ep = m; hi = m - 1; } else lo = m + 1; }
      if (ep < 0) ep = ms.length - 1;
      let cs = ms[sp].i, ce = ms[ep].i;
      if (Number.isFinite(chunk.cueStart) && chunk.cueStart >= 0 && cs < chunk.cueStart) cs = chunk.cueStart;   // never bleed past the chapter
      if (Number.isFinite(chunk.cueEnd) && chunk.cueEnd >= 0 && ce > chunk.cueEnd) ce = chunk.cueEnd;
      if (cs > ce || !cues[cs] || !cues[ce]) return out;
      const startMs = cues[cs].startMs, endMs = cues[ce].endMs;
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) { out.startMs = startMs; out.endMs = endMs; out.cueStart = cs; out.cueEnd = ce; }
      return out;
    } catch (_) { return null; }
  }

  // ---- public surface ---------------------------------------------------------------
  window.aiChunks = {
    chunkTextUpToJp,
    cueRangeForQuote,
    ensure,
    getMap,
    mutate,
    chunkText,
    rubyGlossary,
    rubyGlossarySync,
    isComplete,
    refreshCueBounds,
    refreshCueMap,
    markerCount,
    reSegment,
    clearTitle,
    invalidateCache,
    _onBookLoaded,
    _retrySegmentation,
  };
})();
