// ai-timeline.js — Dynamic Timeline v2 (AI plan §8): per-chapter plot cards
// on a mode-colored reading spine.
//
// LEFT: a rounded vertical spine (book start → end; axis = jp chars from the
// chunk map, so it renders cold without the reader DOM) FILLED with the
// persistent mode-coverage colors from modeCoverage (green read / orange card
// / purple audio; unconsumed or pre-tracker stays gray). Chapter nodes sit ON
// the spine:
// ✓ processed+read, pulsing number while processing, ⚠ tap-to-retry on fail.
// RIGHT: one card per chapter anchored near its node (pushed down on
// overlap): bold label, 2-line short summary, positional multi-segment
// progress bar (coverage pieces at their place within the chapter's own
// range), bookmark flag when a bookmark falls in range.
// Pinch (or − / +) zooms; below a density threshold cards collapse to
// label-only rows. Tap a ready card → chapter view (#kchapterView): long
// summary (dict-tappable), 主な出来事, character chips, key passages with
// place-guarded audio playback.
//
// NEVER-LOSE-PLACE: this module is read-only against the position pipeline.
// Key-passage playback snapshots the native playhead BEFORE the first seek
// and ALWAYS restores position + pause state (stop / view close / another
// passage / app background), mirroring ai-summary's place-guard rules:
// same-url only, never seek to 0.
(function () {
  'use strict';

  const COLORS = {
    card:  'var(--accent-card, #ff9550)',
    read:  'var(--accent-read, #4caf50)',
    audio: 'var(--accent-audio, #b794f6)',
  };
  const MAX_ZOOM = 12;
  const SPINE_X = 44;            // spine left edge (gutter to its left = char ruler)
  const SPINE_W = 10;
  const NODE_R = 13;             // chapter node radius
  const COL_X = 76;              // card column left edge
  const FULL_CARD_SLOT_PX = 72;  // px per chapter below which cards collapse
  const ART_PREFIX = 'AICHAP_V1_';

  function BG() {
    try {
      return window.Capacitor && window.Capacitor.Plugins
        && window.Capacitor.Plugins.BackgroundAudio;
    } catch (_) { return null; }
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const hm = (ts) => {
    try {
      const d = new Date(ts);
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
             d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (_) { return ''; }
  };

  function fmtMs(ms) {
    const t = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s));
  }

  // Shared with shell.js (same id guard): small rotating-ring spinner.
  function ensureKaiSpinStyle() {
    if (document.getElementById('kaiSpinStyle')) return;
    try {
      const st = document.createElement('style');
      st.id = 'kaiSpinStyle';
      st.textContent =
        '@keyframes kai-spin{to{transform:rotate(360deg);}}' +
        '.kai-spin{display:inline-block;width:.85em;height:.85em;border:2px solid #555;' +
        'border-top-color:#b794f6;border-radius:50%;animation:kai-spin .8s linear infinite;' +
        'vertical-align:-2px;margin-left:6px;}';
      document.head.appendChild(st);
    } catch (_) {}
  }

  // Pulsing glow for the LIVE current-place marker on the timeline axis.
  function ensureAxisMarkerStyle() {
    if (document.getElementById('kaiAxisMarkStyle')) return;
    try {
      const st = document.createElement('style');
      st.id = 'kaiAxisMarkStyle';
      st.textContent =
        '@keyframes kaiNowGlow{0%,100%{box-shadow:0 0 5px 1px rgba(255,255,255,.55),0 0 10px 2px rgba(255,255,255,.18);}' +
        '50%{box-shadow:0 0 9px 3px rgba(255,255,255,.9),0 0 18px 5px rgba(255,255,255,.4);}}' +
        '.kai-now-mark{animation:kaiNowGlow 1.8s ease-in-out infinite;}';
      document.head.appendChild(st);
    } catch (_) {}
  }

  // Render-time fallback for artifacts stored before the prompt asked for
  // paragraph breaks: only when the stored text has NO newlines, regroup it
  // into ~3-sentence paragraphs split at 。！？ (trailing closing quotes stay
  // attached to their sentence), joined with blank lines.
  function paragraphize(text) {
    try {
      if (typeof text !== 'string' || !text || text.indexOf('\n') >= 0) return text;
      const parts = text.match(/[^。！？]*[。！？]+[」』”"）]*|[^。！？]+$/g);
      if (!parts || parts.length <= 3) return text;
      const out = [];
      for (let i = 0; i < parts.length; i += 3) {
        out.push(parts.slice(i, i + 3).join(''));
      }
      return out.join('\n\n');
    } catch (_) { return text; }
  }

  // ---- axis ---------------------------------------------------------------
  // Map axis: total = chunk-map totals.jp; cue→jp is piecewise-linear per
  // chunk through the (cueStart,jpStart)→(cueEnd+1,jpEnd) anchor pairs.
  function buildMapAxis(map) {
    const total = map.totals.jp;
    const an = [];
    for (const ch of map.chunks) {
      if (Number.isFinite(ch.cueStart) && ch.cueStart >= 0 &&
          Number.isFinite(ch.cueEnd) && ch.cueEnd >= ch.cueStart &&
          Number.isFinite(ch.jpStart) && Number.isFinite(ch.jpEnd)) {
        an.push([ch.cueStart, ch.jpStart], [ch.cueEnd + 1, ch.jpEnd]);
      }
    }
    an.sort((a, b) => a[0] - b[0]);
    const anchors = [];
    for (const a of an) {
      const last = anchors[anchors.length - 1];
      if (last && (a[0] <= last[0] || a[1] < last[1])) continue;   // keep monotonic
      anchors.push(a);
    }
    // raw cue-text scale as the fallback when no chunk carries cue bounds
    let cueCum = null, cueTotal = 0;
    const cues = window._srtCues;
    if (Array.isArray(cues) && cues.length) {
      cueCum = new Array(cues.length + 1);
      cueCum[0] = 0;
      for (let i = 0; i < cues.length; i++) {
        cueCum[i + 1] = cueCum[i] + ((cues[i] && cues[i].text) ? cues[i].text.length : 0);
      }
      cueTotal = cueCum[cues.length];
    }
    const cueScale = cueTotal ? (total / cueTotal) : 1;
    return {
      total, useJp: true, cueCum,
      cueToChars(idx) {
        if (!Number.isFinite(idx)) return null;
        if (anchors.length >= 2) {
          const A = anchors;
          if (idx <= A[0][0]) return A[0][0] > 0 ? (idx / A[0][0]) * A[0][1] : A[0][1];
          const last = A[A.length - 1];
          if (idx >= last[0]) return last[1];
          for (let i = 1; i < A.length; i++) {
            if (idx <= A[i][0]) {
              const c0 = A[i - 1][0], j0 = A[i - 1][1];
              const c1 = A[i][0], j1 = A[i][1];
              return c1 > c0 ? j0 + ((idx - c0) / (c1 - c0)) * (j1 - j0) : j0;
            }
          }
          return last[1];
        }
        if (cueCum) {
          const i = Math.max(0, Math.min(cueCum.length - 1, idx));
          return cueCum[i] * cueScale;
        }
        return null;
      },
      pos(p) {
        if (!p) return null;
        if (p.k === 'read') return Number.isFinite(p.jpOff) ? p.jpOff : null;
        let cue = Number.isFinite(p.cueIdx) ? p.cueIdx : null;
        if (cue === null && Number.isFinite(p.cardIndex)) {
          try {
            cue = (typeof window._srtCardToCueAnchor === 'function')
              ? window._srtCardToCueAnchor(p.cardIndex) : p.cardIndex;
          } catch (_) { cue = p.cardIndex; }
        }
        return (cue !== null) ? this.cueToChars(cue) : null;
      },
      range(space, a, b) {
        if (space === 'jp') return [a, b];
        const r0 = this.cueToChars(a), r1 = this.cueToChars(b + 1);
        return (r0 !== null && r1 !== null) ? [r0, r1] : null;
      },
    };
  }

  // v1 probe axis (DOM .reading-chunk offsets / cue text) — fallback for
  // titles without a chunk map yet.
  function buildProbeAxis() {
    let cueCum = null, cueTotal = 0;
    const cues = window._srtCues;
    if (Array.isArray(cues) && cues.length) {
      cueCum = new Array(cues.length + 1);
      cueCum[0] = 0;
      for (let i = 0; i < cues.length; i++) {
        cueCum[i + 1] = cueCum[i] + ((cues[i] && cues[i].text) ? cues[i].text.length : 0);
      }
      cueTotal = cueCum[cues.length];
    }
    let jpTotal = 0;
    try {
      document.querySelectorAll('.reading-chunk').forEach((el) => {
        const off = parseInt(el.dataset.jpOff, 10);
        const len = parseInt(el.dataset.jpLen, 10) || 0;
        if (Number.isFinite(off)) jpTotal = Math.max(jpTotal, off + len);
      });
    } catch (_) {}
    const useJp = jpTotal > 4000;
    const total = useJp ? jpTotal : cueTotal;
    if (!total) return null;
    const cueScale = (useJp && cueTotal) ? (jpTotal / cueTotal) : 1;
    return {
      total, useJp, cueCum,
      cueToChars(idx) {
        if (!cueCum || !Number.isFinite(idx)) return null;
        const i = Math.max(0, Math.min(cueCum.length - 1, idx));
        return cueCum[i] * cueScale;
      },
      pos(p) {
        if (!p) return null;
        if (p.k === 'read') return (useJp && Number.isFinite(p.jpOff)) ? p.jpOff : null;
        let cue = Number.isFinite(p.cueIdx) ? p.cueIdx : null;
        if (cue === null && Number.isFinite(p.cardIndex)) {
          try {
            cue = (typeof window._srtCardToCueAnchor === 'function')
              ? window._srtCardToCueAnchor(p.cardIndex) : p.cardIndex;
          } catch (_) { cue = p.cardIndex; }
        }
        return (cue !== null) ? this.cueToChars(cue) : null;
      },
      range(space, a, b) {
        if (space === 'jp') return useJp ? [a, b] : null;
        const r0 = this.cueToChars(a), r1 = this.cueToChars(b + 1);
        return (r0 !== null && r1 !== null) ? [r0, r1] : null;
      },
    };
  }

  // ---- coverage segments from modeCoverage (spine fill + chapter bars) -----
  // The store keeps two native spaces: jp char intervals (read) and cue-index
  // intervals (audio/card). Cue intervals convert through axis.cueToChars —
  // piecewise-linear when the chunk map carries cue bounds, raw cue-text
  // scale otherwise. jp intervals are inserted AFTER cue ones with the same
  // overwrite semantics, so where a listened range was later re-read (which
  // the store can't reconcile across spaces) read wins. Result: sorted,
  // non-overlapping [{c0, c1, mode}] on the jp display axis.
  const MODE_NAME = ['read', 'card', 'audio'];

  function covInsert(arr, a, b, mode) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
    let i = 0;
    while (i < arr.length && arr[i].c1 < a) i++;
    let j = i;
    let left = null, right = null;
    while (j < arr.length && arr[j].c0 <= b) {
      const iv = arr[j];
      if (iv.mode === mode) {
        if (iv.c0 < a) a = iv.c0;
        if (iv.c1 > b) b = iv.c1;
      } else {
        if (iv.c0 < a) left = { c0: iv.c0, c1: a, mode: iv.mode };
        if (iv.c1 > b) right = { c0: b, c1: iv.c1, mode: iv.mode };
      }
      j++;
    }
    const repl = [];
    if (left) repl.push(left);
    repl.push({ c0: a, c1: b, mode });
    if (right) repl.push(right);
    arr.splice.apply(arr, [i, j - i].concat(repl));
  }

  async function coverageSegments(titleId, axis) {
    try {
      if (!window.modeCoverage || typeof window.modeCoverage.get !== 'function') return [];
      const cov = await window.modeCoverage.get(titleId);
      if (!cov) return [];
      const segs = [];
      for (const iv of (cov.cue || [])) {
        if (!Array.isArray(iv)) continue;
        const c0 = axis.cueToChars(iv[0]), c1 = axis.cueToChars(iv[1]);
        if (c0 !== null && c1 !== null && c1 > c0) {
          covInsert(segs, c0, c1, MODE_NAME[iv[2]] || 'audio');
        }
      }
      if (axis.useJp) {
        for (const iv of (cov.jp || [])) {
          if (!Array.isArray(iv)) continue;
          covInsert(segs, iv[0], iv[1], MODE_NAME[iv[2]] || 'read');
        }
      }
      return segs;
    } catch (_) { return []; }
  }

  // Re-visited (re-read / re-listened) territory — a separate track from the
  // first-visit coverage above. Same char-axis mapping; colored by the modality
  // of the re-visit so a re-read reads green, a re-listen purple, a re-card orange.
  async function revisitSegments(titleId, axis) {
    try {
      if (!window.modeCoverage || typeof window.modeCoverage.get !== 'function') return [];
      const cov = await window.modeCoverage.get(titleId);
      if (!cov) return [];
      const segs = [];
      for (const iv of (cov.rcue || [])) {
        if (!Array.isArray(iv)) continue;
        const c0 = axis.cueToChars(iv[0]), c1 = axis.cueToChars(iv[1]);
        if (c0 !== null && c1 !== null && c1 > c0) {
          covInsert(segs, c0, c1, MODE_NAME[iv[2]] || 'audio');
        }
      }
      if (axis.useJp) {
        for (const iv of (cov.rjp || [])) {
          if (!Array.isArray(iv)) continue;
          covInsert(segs, iv[0], iv[1], MODE_NAME[iv[2]] || 'read');
        }
      }
      return segs;
    } catch (_) { return []; }
  }

  function currentAxisPos(ax) {
    // The live marker must follow the modality the user is ACTUALLY in: a listener's
    // marker should track the audio playhead, NOT a read frontier that may sit far
    // behind (the bug this fixes), and a reader's marker should track the read
    // frontier. Pick by the active body mode, then fall back across the others.
    let mode = null;
    try {
      const cl = document.body.classList;
      mode = cl.contains('mode-read') ? 'read' : (cl.contains('mode-audio') ? 'audio' : (cl.contains('mode-card') ? 'card' : null));
    } catch (_) {}
    const audioPos = () => (Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0) ? ax.cueToChars(window._lastAudioCueIdx) : null;
    const cardPos = () => {
      if (!Number.isFinite(window.currentCardIndex)) return null;
      try {
        const c = (typeof window._srtCardToCueAnchor === 'function') ? window._srtCardToCueAnchor(window.currentCardIndex) : window.currentCardIndex;
        return ax.cueToChars(c);
      } catch (_) { return null; }
    };
    const readPos = () => {
      try {
        // Prefer the visible read frontier (advances on silent reading) over the
        // audio-playhead-anchored pagedGetReadLocation.
        if (ax.useJp && typeof window.pagedGetReadFrontier === 'function') {
          const fr = window.pagedGetReadFrontier();
          if (Number.isFinite(fr)) return fr;
        }
        const loc = window.pagedGetReadLocation && window.pagedGetReadLocation();
        if (ax.useJp && loc && Number.isFinite(loc.jpOff)) return loc.jpOff;
      } catch (_) {}
      return null;
    };
    const order = (mode === 'audio') ? [audioPos, cardPos, readPos]
                : (mode === 'card') ? [cardPos, audioPos, readPos]
                : [readPos, audioPos, cardPos];   // 'read' or unknown → original preference
    for (const f of order) { const v = f(); if (v !== null && Number.isFinite(v)) return v; }
    return null;
  }

  // ---- data ----------------------------------------------------------------
  async function getMapSafe(titleId) {
    try {
      if (window.aiChunks && typeof window.aiChunks.getMap === 'function') {
        const m = await window.aiChunks.getMap(titleId);
        if (m && Array.isArray(m.chunks) && m.chunks.length &&
            m.totals && Number.isFinite(m.totals.jp) && m.totals.jp > 0) return m;
      }
    } catch (_) {}
    return null;
  }

  async function loadArtifacts(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(ART_PREFIX + titleId) : null;
      const p = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      return (p && typeof p === 'object') ? p : {};
    } catch (_) { return {}; }
  }

  // Artifacts carry the chunk-map fingerprint they were processed against
  // (art.fp); after a map rebuild their boundaries are stale — treat them
  // as absent (no render, no tap). Legacy artifacts without fp pass through.
  function filterArtifacts(arts, map) {
    try {
      if (!arts || !map || !map.fingerprint) return arts || {};
      const out = {};
      for (const k of Object.keys(arts)) {
        const a = arts[k];
        if (a && a.fp && a.fp !== map.fingerprint) continue;
        out[k] = a;
      }
      return out;
    } catch (_) { return arts || {}; }
  }

  // Completion is compared within ONE coordinate space (jp/jp or cue/cue).
  function chapterComplete(map, ch) {
    try {
      if (window.aiChunks && typeof window.aiChunks.isComplete === 'function') {
        return !!window.aiChunks.isComplete(map, ch.idx);
      }
    } catch (_) {}
    const f = (map && map.furthest) || {};
    if (Number.isFinite(f.jp) && Number.isFinite(ch.jpEnd) && f.jp >= ch.jpEnd) return true;
    if (Number.isFinite(ch.cueEnd) && ch.cueEnd >= 0 &&
        Number.isFinite(f.cue) && f.cue >= ch.cueEnd) return true;
    return false;
  }

  // Read % of a chapter (union of coverage segments ∪ furthest watermark) and
  // its dominant mode (most covered chars in range).
  function chapterProgress(ch, segs, furthestJp) {
    const a = ch.jpStart, b = ch.jpEnd;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return { pct: 0, mode: null };
    const len = b - a;
    const ivs = [];
    const modeChars = { read: 0, card: 0, audio: 0 };
    for (const sg of segs) {
      const s = Math.max(a, sg.c0), e = Math.min(b, sg.c1);
      if (e > s) {
        ivs.push([s, e]);
        modeChars[sg.mode] = (modeChars[sg.mode] || 0) + (e - s);
      }
    }
    ivs.sort((x, y) => x[0] - y[0]);
    let cov = 0, cs = null, ce = null;
    for (const iv of ivs) {
      if (ce === null) { cs = iv[0]; ce = iv[1]; }
      else if (iv[0] <= ce) ce = Math.max(ce, iv[1]);
      else { cov += ce - cs; cs = iv[0]; ce = iv[1]; }
    }
    if (ce !== null) cov += ce - cs;
    let pct = cov / len;
    if (Number.isFinite(furthestJp)) {
      if (furthestJp >= b) pct = 1;
      else if (furthestJp > a) pct = Math.max(pct, (furthestJp - a) / len);
    }
    let mode = null, best = 0;
    for (const m of Object.keys(modeChars)) {
      if (modeChars[m] > best) { best = modeChars[m]; mode = m; }
    }
    return { pct: Math.max(0, Math.min(1, pct)), mode };
  }

  // Positional chapter-bar pieces: coverage clipped to [a,b], same-mode
  // neighbors merged, capped at MAX_BAR_SEGS (slivers absorbed into the
  // nearer neighbor) to keep the per-card DOM cheap.
  const MAX_BAR_SEGS = 12;
  function barSegments(segs, a, b) {
    const out = [];
    for (const sg of segs) {
      const s = Math.max(a, sg.c0), e = Math.min(b, sg.c1);
      if (e <= s) continue;
      const last = out[out.length - 1];
      if (last && last[2] === sg.mode && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e, sg.mode]);
    }
    while (out.length > MAX_BAR_SEGS) {
      let bi = 0, bw = Infinity;
      for (let k = 0; k < out.length; k++) {
        const w = out[k][1] - out[k][0];
        if (w < bw) { bw = w; bi = k; }
      }
      const prev = out[bi - 1], next = out[bi + 1];
      const dp = prev ? (out[bi][0] - prev[1]) : Infinity;
      const dn = next ? (next[0] - out[bi][1]) : Infinity;
      if (prev && dp <= dn) prev[1] = out[bi][1];
      else if (next) next[0] = out[bi][0];
      out.splice(bi, 1);
    }
    return out;
  }

  async function resolveChars(titleId, ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    let chars = null;
    try {
      if (window.aiCharacters && typeof window.aiCharacters.getStore === 'function') {
        const st = await window.aiCharacters.getStore(titleId);
        if (st && st.characters) chars = st.characters;
      }
    } catch (_) {}
    if (!chars) {
      try {
        const raw = window.blobStore ? await window.blobStore.get('AICHAR_V2_' + titleId) : null;
        const p = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        if (p && p.characters) chars = p.characters;
      } catch (_) {}
    }
    if (!chars) return [];
    const byId = (id) => Array.isArray(chars)
      ? chars.find(c => c && c.id === id) : chars[id];
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      let rec = byId(id);
      for (let hops = 0; rec && rec.mergedInto && hops < 5; hops++) rec = byId(rec.mergedInto);
      if (rec && rec.surface && !seen.has(rec.id || rec.surface)) {
        seen.add(rec.id || rec.surface);
        out.push({ id: rec.id || id, surface: rec.surface });
      }
    }
    return out;
  }

  // ---- key-passage playback (NEVER-LOSE-PLACE) -------------------------------
  // Snapshot {url, ms, playing} before the FIRST seek; on stop / view close /
  // another passage / background ALWAYS restore. Same-url guard; never seek
  // back to positions ≤1s (mirrors ai-summary's place guard).
  let _pSnap = null, _pPoll = null, _pBtn = null, _pPosHandle = null, _pTimer = null, _pToken = 0;

  function _pStopPoll() {
    if (_pPoll) { clearInterval(_pPoll); _pPoll = null; }
    if (_pPosHandle) { try { _pPosHandle.remove(); } catch (_) {} _pPosHandle = null; }
    if (_pTimer) { clearTimeout(_pTimer); _pTimer = null; }
  }
  function _pResetBtn() {
    if (_pBtn) {
      try { _pBtn.textContent = _pBtn.dataset.plabel || window.i18n.t('tl.listen_scene', '▶ この場面を聴く'); _pBtn.dataset.playing = ''; } catch (_) {}
    }
    _pBtn = null;
  }

  // Dict-lookup pause probe: enhanced-dictionary keeps its pause flag
  // module-private, so a visible #dictPopup (inline display 'block'/'none')
  // is the observable "lookup pause active" signal — the lookup's own
  // dismiss path owns the resume.
  function dictLookupPauseActive() {
    try {
      const p = document.getElementById('dictPopup');
      return !!(p && p.style.display === 'block');
    } catch (_) { return false; }
  }

  async function stopPassage() {
    _pStopPoll();
    _pResetBtn();
    const sn = _pSnap; _pSnap = null;
    if (!sn) { window._kaiPassageActive = false; return; }
    try {
      const bg = BG();
      if (!bg) return;
      let s = null;
      try { s = await bg.getState(); } catch (_) {}
      try { await bg.pause(); } catch (_) {}
      if (s && s.url && sn.url && s.url !== sn.url) return;   // different audio now — leave it
      // ALWAYS restore the exact prior spot (even ≤1s): the excerpt seeked the
      // single shared playhead forward, so not restoring = a forward place change.
      try { await bg.seek({ ms: Math.max(0, sn.ms), fadeMs: 40 }); } catch (_) {}
      // Mid-dict-lookup the pause belongs to the lookup; resuming here would
      // override it — its dismiss resumes at the restored spot. Resume ONLY if
      // the user was actually listening before the excerpt.
      if (sn.playing && !dictLookupPauseActive()) {
        try { await bg.resume({ fadeMs: 120 }); } catch (_) {}
      }
    } catch (_) {} finally {
      window._kaiPassageActive = false;
    }
  }

  // Play ONLY [startMs,endMs] of the active audio and stop precisely at the end
  // via a position listener (a 350ms poll overshot), then ALWAYS restore the
  // user's exact prior position + play-state (never lose place). No 30s default —
  // invalid bounds simply don't play.
  async function playPassage(p, btn) {
    try {
      const bg = BG();
      if (!bg || typeof bg.getState !== 'function') return;
      if (_pBtn === btn && btn && btn.dataset.playing) { await stopPassage(); return; }
      if (_pSnap) { await stopPassage(); await new Promise(r => setTimeout(r, 150)); }
      const startMs = Math.max(0, Math.round(Number(p && p.startMs)));
      const endMs = Math.round(Number(p && p.endMs));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;   // no fabricated bounds
      const s = await bg.getState();
      if (!s || !s.ready || !s.url) return;
      _pSnap = {
        url: s.url,
        ms: Math.max(0, Math.round(Number(s.positionMs) || 0)),
        playing: !!(s.playing !== undefined ? s.playing : s.isPlaying),
      };
      const token = ++_pToken;
      // Passage position events must not raise the never-regress furthest-listened
      // watermark (reading-mode guards on this flag).
      window._kaiPassageActive = true;
      await bg.seek({ ms: startMs, fadeMs: 40 });
      if (!_pSnap.playing) { try { await bg.resume({ fadeMs: 120 }); } catch (_) {} }
      _pBtn = btn;
      try { if (btn && !btn.dataset.plabel) btn.dataset.plabel = btn.textContent; btn.textContent = window.i18n.t('tl.stop', '■ 停止'); btn.dataset.playing = '1'; } catch (_) {}
      const onPos = (d) => {
        if (token !== _pToken) return;   // a newer passage (or stop) superseded this one
        try {
          if ((d && d.url && _pSnap && _pSnap.url && d.url !== _pSnap.url) || Number(d && d.positionMs) >= endMs - 30) {
            stopPassage();
          }
        } catch (_) {}
      };
      try { _pPosHandle = await bg.addListener('position', onPos); } catch (_) {}
      if (token !== _pToken) { try { _pPosHandle && _pPosHandle.remove(); } catch (_) {} _pPosHandle = null; return; }   // stopped during the await
      // Safety backstop (rate-aware) in case the position stream stalls.
      const rate = (Number(window.audioPlaybackRate) > 0) ? Number(window.audioPlaybackRate) : 1;
      _pTimer = setTimeout(() => { if (token === _pToken) stopPassage(); }, Math.max(1500, Math.round((endMs - startMs) / rate) + 2500));
    } catch (_) { try { await stopPassage(); } catch (_) {} }
  }

  // ---- scene-card clip player (audition the Anki clip) ------------------------
  // Plays the trimmed selection through a DEDICATED <audio> element fed the SAME
  // sliced clip used for Anki. This never seeks the book's shared playhead (so the
  // user's place is structurally safe — we only pause/resume the book in place so a
  // clip doesn't overlap it), and the clip simply ENDS on its own (reliable stop —
  // no fighting the continuous-audio engine, which owns the single bg playhead).
  // Bonus: it exercises the exact Anki slice path, so a silent/failed preview tells
  // us the slice is the problem (not the Anki field). _clipBtn shows a ▶ / ❚❚ toggle.
  let _clipAudio = null, _clipKey = '', _clipBtn = null, _clipBusy = false, _clipBookWasPlaying = false;
  let _clipRaf = null, _clipStartMs = 0;   // drive the inline waveform playhead from the <audio> clock
  function _clipIcon(p) { if (_clipBtn) { try { _clipBtn.textContent = p ? '❚❚' : '▶'; } catch (_) {} } }
  // Detach handlers BEFORE clearing src — setting an <audio>.src='' fires its
  // onerror (empty source = MediaError), which otherwise showed a bogus
  // "プレビューを再生できません" toast after retrimming + replaying.
  function _clipDetach(a) { if (!a) return; try { a.onended = a.onpause = a.onplay = a.onerror = null; } catch (_) {} }
  // Sweep the inline waveform cursor from the clip's own currentTime (absolute
  // source-ms = clip start + elapsed); the book engine isn't driving playback.
  function _clipPlayheadTick() {
    if (!_clipAudio || _clipAudio.paused) { _clipRaf = null; return; }
    try { const ms = _clipStartMs + (_clipAudio.currentTime || 0) * 1000; if (window.waveform && window.waveform.setPlayheadMs) window.waveform.setPlayheadMs(ms); } catch (_) {}
    _clipRaf = requestAnimationFrame(_clipPlayheadTick);
  }
  function _clipPlayheadStart() { if (_clipRaf == null) _clipRaf = requestAnimationFrame(_clipPlayheadTick); }
  function _clipPlayheadStop(resetToStart) {
    if (_clipRaf != null) { try { cancelAnimationFrame(_clipRaf); } catch (_) {} _clipRaf = null; }
    if (resetToStart) { try { if (window.waveform && window.waveform.setPlayheadMs) window.waveform.setPlayheadMs(_clipStartMs); } catch (_) {} }
  }
  async function _clipResumeBook() {
    if (!_clipBookWasPlaying) return; _clipBookWasPlaying = false;
    if (dictLookupPauseActive()) return;
    try { const bg = BG(); if (bg) await bg.resume({ fadeMs: 120 }); } catch (_) {}
  }
  let _lastSliceErr = '';   // surfaced in the failure toast so the REAL native reason is visible
  async function _sliceToUri(srcPath, startMs, endMs) {
    _lastSliceErr = '';
    try {
      const slicer = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioSlicer;
      if (!slicer) { _lastSliceErr = window.i18n.t('tl.slice_no_plugin', 'AudioSlicerプラグインなし'); return ''; }
      if (!srcPath) { _lastSliceErr = window.i18n.t('tl.slice_no_src', '音源パスなし'); return ''; }
      if (!window.cacheFileToDataUri) { _lastSliceErr = window.i18n.t('tl.slice_no_cachefn', 'cacheFileToDataUriなし'); return ''; }
      const slice = await slicer.slice({ srcPath, startMs: Math.round(startMs), endMs: Math.round(endMs) });
      if (!slice || !slice.path) { _lastSliceErr = window.i18n.t('tl.slice_no_result_path', 'スライス結果にパスなし'); return ''; }
      const uri = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
      if (!uri) _lastSliceErr = window.i18n.fmt('tl.slice_empty', { size: (slice.sizeBytes != null ? slice.sizeBytes : '?'), mime: (slice.mime || '?') }, 'ファイル読込が空（サイズ ' + (slice.sizeBytes != null ? slice.sizeBytes : '?') + 'B, mime ' + (slice.mime || '?') + '）');
      try { console.log('[scene-slice] ' + Math.round(startMs) + '→' + Math.round(endMs) + ' path=' + (slice && slice.path) + ' size=' + (slice && slice.sizeBytes) + ' mime=' + (slice && slice.mime) + ' uriBytes=' + (uri ? uri.length : 0)); } catch (_) {}
      return uri || '';
    } catch (e) {
      _lastSliceErr = (e && (e.message || e.errorMessage)) || String(e) || window.i18n.t('tl.slice_exception', 'スライス例外');
      try { console.log('[scene-slice] FAILED: ' + _lastSliceErr); } catch (_) {}
      return '';
    }
  }
  function clipStop() { _clipPlayheadStop(false); try { if (_clipAudio) _clipAudio.pause(); } catch (_) {} _clipIcon(false); _clipResumeBook(); }
  function clipDispose() { _clipPlayheadStop(false); try { if (_clipAudio) { _clipDetach(_clipAudio); _clipAudio.pause(); _clipAudio.src = ''; } } catch (_) {} _clipAudio = null; _clipKey = ''; _clipBtn = null; _clipResumeBook(); }
  async function clipPlay(bounds, btn, srcPath) {
    _clipBtn = btn;
    try {
      if (_clipAudio && !_clipAudio.paused) { clipStop(); return; }   // toggle → pause
      if (!bounds || !Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs) || bounds.endMs <= bounds.startMs || !srcPath) return;
      const key = srcPath + '|' + Math.round(bounds.startMs) + '-' + Math.round(bounds.endMs);
      _clipStartMs = Math.round(bounds.startMs);   // absolute source-ms for the playhead sweep
      // Pause the book so the clip doesn't overlap it. POSITION is never touched
      // (no seek) → the user's place is structurally safe; resumed on stop/leave.
      try { const bg = BG(); if (bg && typeof bg.getState === 'function') { const st = await bg.getState(); if (st && (st.playing !== undefined ? st.playing : st.isPlaying)) { _clipBookWasPlaying = true; try { await bg.pause(); } catch (_) {} } } } catch (_) {}
      if (_clipAudio && _clipKey === key && _clipAudio.src) { try { _clipAudio.currentTime = 0; } catch (_) {} try { await _clipAudio.play(); } catch (_) {} return; }
      if (_clipBusy) return; _clipBusy = true;
      if (_clipBtn) { try { _clipBtn.textContent = '…'; } catch (_) {} }
      const uri = await _sliceToUri(srcPath, bounds.startMs, bounds.endMs);
      _clipBusy = false;
      if (!uri) { _clipIcon(false); _clipResumeBook(); try { window.showToast && window.showToast(window.i18n.t('tl.cannot_play_audio', 'この音声を再生できませんでした'), 3500); } catch (_) {} return; }
      if (_clipAudio) { try { _clipDetach(_clipAudio); _clipAudio.pause(); _clipAudio.src = ''; } catch (_) {} }
      _clipAudio = new Audio(uri); _clipKey = key;
      _clipAudio.onended = () => { _clipPlayheadStop(true); _clipIcon(false); _clipResumeBook(); };   // ends on its own → STOP, cursor back to start
      _clipAudio.onpause = () => { _clipPlayheadStop(false); _clipIcon(false); };
      _clipAudio.onplay = () => { _clipPlayheadStart(); _clipIcon(true); };
      _clipAudio.onerror = () => { _clipPlayheadStop(false); _clipIcon(false); _clipResumeBook(); try { window.showToast && window.showToast(window.i18n.t('tl.cannot_play_preview', 'プレビューを再生できません'), 3500); } catch (_) {} };
      try { await _clipAudio.play(); } catch (_) { _clipIcon(false); _clipResumeBook(); }
    } catch (_) { _clipBusy = false; _clipIcon(false); _clipResumeBook(); }
  }

  // Lookup-resume regression guard for the chapter view (ai-summary pattern):
  // a stray seek from a dict lookup inside the view never moves the user back.
  let _lg = null;
  function armLookGuard() {
    _lg = null;
    try {
      const bg = BG();
      if (!bg || typeof bg.getState !== 'function') return;
      bg.getState().then((s) => {
        if (s && s.ready && Number(s.positionMs) > 1000) {
          _lg = { ms: Math.round(s.positionMs), url: s.url || null };
        }
      }).catch(() => {});
    } catch (_) {}
  }
  function checkLookGuard() {
    const g = _lg; _lg = null;
    if (!g) return;
    try {
      const bg = BG();
      if (!bg) return;
      bg.getState().then((s) => {
        if (!s || !s.ready) return;
        if (g.url && s.url && s.url !== g.url) return;
        if (Number(s.positionMs) < g.ms - 4000) bg.seek({ ms: g.ms, fadeMs: 40 });
      }).catch(() => {});
    } catch (_) {}
  }

  // ---- per-scene audio trim store ---------------------------------------------
  // The user's adjusted Anki audio bounds for a scene, keyed by the scene's slot
  // charId ('scene_<idx>_<slot>'). Tiny config → localStorage (synchronous). Seeds
  // the waveform editor on the next send, and the ▶ preview, so a once-trimmed
  // scene keeps its bounds. Never touches the live playhead (place-safe).
  function trimKey(titleId) { return 'AISCENE_TRIM_V1_' + titleId; }
  function sceneTrimAll(titleId) {
    try { return JSON.parse(localStorage.getItem(trimKey(titleId)) || '{}') || {}; } catch (_) { return {}; }
  }
  function sceneTrimGet(titleId, slotId) {
    try { const t = sceneTrimAll(titleId)[slotId]; return (t && Number.isFinite(t.startMs) && Number.isFinite(t.endMs)) ? t : null; } catch (_) { return null; }
  }
  function sceneTrimSet(titleId, slotId, startMs, endMs) {
    try { const all = sceneTrimAll(titleId); all[slotId] = { startMs: Math.round(startMs), endMs: Math.round(endMs) }; localStorage.setItem(trimKey(titleId), JSON.stringify(all)); } catch (_) {}
  }

  // ---- chapter view -----------------------------------------------------------
  // z 9000 (below dict 9999 / toast 9500). The timeline panel is CLOSED before
  // this opens (z-order rule) and reopened via `reopen` on close.
  async function openChapterView(titleId, ch, art, reopen) {
    try {
      const prev = document.getElementById('kchapterView');
      if (prev) {
        // Replaced view never ran close(): drop its visibilitychange
        // listener and AWAIT the passage restore — armLookGuard below must
        // not snapshot the passage position mid-restore (checkLookGuard
        // would later seek the user FORWARD to the passage spot).
        try {
          if (prev._kaiOnVis) document.removeEventListener('visibilitychange', prev._kaiOnVis);
        } catch (_) {}
        // close() never ran on the replaced view → clear its scene poll here, and
        // mark it dead so a late statusFor().then() can't re-arm on the detached node.
        if (prev._scenePoll) { try { clearInterval(prev._scenePoll); } catch (_) {} prev._scenePoll = null; }
        prev._dead = true;
        prev.remove();
        try { await stopPassage(); } catch (_) {}
      }
      armLookGuard();

      const overlay = document.createElement('div');
      overlay.id = 'kchapterView';
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 0 calc(8px + env(safe-area-inset-bottom, 0px));';

      let closed = false;
      function onVis() {
        // Backgrounded mid-passage: restore at once so the app's own durable
        // position saves capture the user's real place, not the passage spot.
        if (document.hidden) { try { stopPassage(); } catch (_) {} }
      }
      async function close() {
        if (closed) return;
        closed = true;
        overlay._dead = true;
        if (overlay._scenePoll) { try { clearInterval(overlay._scenePoll); } catch (_) {} overlay._scenePoll = null; }
        try { await stopPassage(); } catch (_) {}
        checkLookGuard();
        try { document.removeEventListener('visibilitychange', onVis); } catch (_) {}
        // restore the live waveform canvas we idled while open
        try {
          const wf = document.getElementById('liveWaveform');
          if (wf && overlay._kaiWfHidden) wf.style.display = overlay._kaiWfPrev || '';
        } catch (_) {}
        try { overlay.remove(); } catch (_) {}
        if (reopen) { try { reopen(); } catch (_) {} }
      }
      document.addEventListener('visibilitychange', onVis);
      overlay._kaiOnVis = onVis;   // reachable for the view-replacement path
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      const card = document.createElement('div');
      card.style.cssText =
        'background:#141414;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(94vw,720px);height:86vh;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';

      const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: ch.idx + 1 }, '第' + (ch.idx + 1) + '章');
      const lenJp = (Number.isFinite(ch.jpEnd) && Number.isFinite(ch.jpStart))
        ? (ch.jpEnd - ch.jpStart) : 0;

      const head = document.createElement('div');
      head.id = 'kchapterViewHead';   // dict popup positions itself below this
      head.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #242424;';
      const ht = document.createElement('div');
      ht.style.cssText = 'flex:1;min-width:0;';
      ht.innerHTML =
        '<div style="font-weight:600;color:#eee;font-size:1rem;">' + esc(label) + '</div>' +
        '<div style="color:#888;font-size:.72rem;margin-top:2px;">' + esc(window.i18n.fmt('tl.chapter_n', { n: ch.idx + 1 }, '第' + (ch.idx + 1) + '章')) +
        (lenJp > 0 ? (' · ' + window.i18n.fmt('tl.chars', { n: lenJp.toLocaleString() }, lenJp.toLocaleString() + '字')) : '') + '</div>';
      const cp = document.createElement('button');
      cp.textContent = '⧉';
      cp.title = window.i18n.t('tl.copy_chapter_summary', 'Copy chapter summary');
      cp.style.cssText =
        'background:none;border:1px solid #333;border-radius:8px;color:#aab4dd;' +
        'font-size:1rem;padding:4px 12px;cursor:pointer;';
      cp.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (window.aiExport && window.aiExport.chapterText) {
            const ok = await window.aiExport.copyText(window.aiExport.chapterText(art, ch, ch.idx + 1));
            window.aiExport.toast(ok ? window.i18n.t('tl.copied', 'Copied') : window.i18n.t('tl.copy_failed', 'Copy failed'));
          }
        } catch (_) {}
      });
      const xb = document.createElement('button');
      xb.textContent = '✕';
      xb.style.cssText =
        'background:none;border:1px solid #333;border-radius:8px;color:#ccc;' +
        'font-size:1.4rem;padding:6px 14px;cursor:pointer;';
      xb.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      head.appendChild(ht);
      head.appendChild(cp);
      head.appendChild(xb);

      const content = document.createElement('div');
      // Opaque background so the momentum-scroll tiles are solid (iOS caches
      // opaque tiles; a transparent scroll layer over content is costlier).
      content.style.cssText =
        'flex:1;overflow-y:auto;padding:16px 18px;background:#141414;-webkit-overflow-scrolling:touch;';

      // Dict enablement leaves text nodes intact on iOS (lazy caretRangeFromPoint
      // path); the squiggle marker may wrap matched name runs only. So it
      // is applied ONLY to leaf text nodes — never to containers with buttons.
      const dictTargets = [];
      const prose = (text, extra) => {
        const d = document.createElement('div');
        d.className = 'kai-summary-text';   // squiggle-marking poll target
        d.style.cssText =
          'color:#ddd;font-family:var(--font-family-card);font-size:var(--font-size-card);' +
          'line-height:1.7;white-space:pre-wrap;' + (extra || '');
        d.textContent = text || '';
        dictTargets.push(d);
        return d;
      };
      const heading = (txt) => {
        const h = document.createElement('div');
        h.style.cssText =
          'margin:20px 0 8px;color:#8a7fb8;font-size:.78rem;font-weight:700;letter-spacing:.06em;';
        h.textContent = txt;
        return h;
      };

      // Summary: longSummary is now just 2-3 short paragraphs — show it directly.
      // LEGACY artifacts (old 600-1500字 long + mediumSummary) stay behind a
      // 「全文を表示」 expander so they don't dump a wall of text.
      const longText = art ? paragraphize(art.longSummary || '') : '';   // art may be null (scene-only chapter)
      if (longText) {
        if (longText.length > 700 && art.mediumSummary) {
          // legacy long: medium teaser + expander to the full old long text
          content.appendChild(prose(paragraphize(art.mediumSummary)));
          const fullEl = prose(longText, 'display:none;margin-top:12px;');
          const btn = document.createElement('button');
          btn.textContent = window.i18n.t('tl.show_full_text', '全文を表示');
          btn.style.cssText =
            'display:block;margin:10px 0 0;background:#1c1c24;border:1px solid #333;' +
            'border-radius:8px;color:#aab4dd;font-size:.78rem;padding:6px 14px;cursor:pointer;';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = fullEl.style.display === 'none';
            fullEl.style.display = open ? '' : 'none';
            btn.textContent = open ? window.i18n.t('tl.hide_full_text', '全文を閉じる') : window.i18n.t('tl.show_full_text', '全文を表示');
          });
          content.appendChild(btn);
          content.appendChild(fullEl);
        } else {
          content.appendChild(prose(longText));
        }
      }

      // Scene-only chapter (opened to view 新着 images before its summary exists).
      if (!art) {
        content.appendChild(prose(window.i18n.t('tl.chapter_no_summary', 'この章の要約はまだ生成されていません。下に場面画像を表示します。'), 'color:#888;font-size:.82rem;line-height:1.6;'));
      }

      // Continuity: jump from the summary straight to this chapter's scenes (opens the first).
      if (art && Array.isArray(art.scenes) && art.scenes.length && typeof openSceneCard === 'function') {
        const goScenes = document.createElement('button');
        goScenes.textContent = window.i18n.fmt('tl.view_scenes', { n: art.scenes.length }, 'シーンを見る（' + art.scenes.length + '）›');
        goScenes.style.cssText = 'display:block;width:100%;margin-top:16px;background:#1d1830;border:1px solid #463a6b;border-radius:10px;color:#cbbfee;font-size:.88rem;padding:11px 16px;cursor:pointer;';
        goScenes.addEventListener('click', (e) => {
          e.stopPropagation();
          // Restore the live waveform this view idled, so the scene card (which removes
          // this overlay WITHOUT running its close()) captures the real display state.
          try { const wf = document.getElementById('liveWaveform'); if (wf && overlay._kaiWfHidden) { wf.style.display = overlay._kaiWfPrev || ''; overlay._kaiWfHidden = false; } } catch (_) {}
          try { openSceneCard(titleId, ch, art, 0, reopen); } catch (_) {}
        });
        content.appendChild(goScenes);
      }

      // ---- Legacy auto-illustrate strip --------------------------------------------
      // Claude-authored scenes (art.scenes) now live at the TOP LEVEL of the timeline
      // (one row per scene under the chapter summary → tap opens the scene card). The
      // chapter view only keeps the legacy bare 'scene_<idx>' bucket (old position-based
      // auto-illustrate images, now default-off) so nothing already generated is lost.
      // The section reveals only when that bucket has images (buildImageStrip self-hides).
      try {
        if (window.aiImages && window.aiImages.buildImageStrip) {
          const sceneSec = document.createElement('div');
          sceneSec.style.cssText = 'margin-top:12px;'; sceneSec.style.display = 'none';
          sceneSec.appendChild(heading(window.i18n.t('tl.scenes_heading', '場面')));
          const legacy = window.aiImages.buildImageStrip(titleId, 'scene_' + ch.idx, { interactive: true });
          sceneSec.appendChild(legacy);
          content.appendChild(sceneSec);
          (async () => { try { const st = await window.aiImages.statusFor(titleId, 'scene_' + ch.idx); if (st && st.images > 0) sceneSec.style.display = ''; } catch (_) {} })();
        }
      } catch (_) {}

      const events = (art && Array.isArray(art.events))
        ? art.events.filter(ev => ev && (ev.title || ev.description)) : [];
      if (events.length) {
        content.appendChild(heading(window.i18n.t('tl.key_events', '主な出来事')));
        for (const ev of events) {
          const row = document.createElement('div');
          // inset box-shadow (0 blur) = a composited accent strip, NOT a layout
          // border. A partial-side border on a child of the momentum scroller
          // can't tile-cache on iOS → per-frame re-raster (the summary jitter).
          row.style.cssText = 'margin:0 0 10px;padding-left:10px;box-shadow:inset 2px 0 0 #2e2e3a;';
          if (ev.title) {
            row.appendChild(prose(ev.title, 'font-weight:700;font-size:.86rem;line-height:1.5;'));
          }
          if (ev.description) {
            row.appendChild(prose(ev.description, 'font-size:.8rem;color:#999;line-height:1.6;margin-top:2px;'));
          }
          content.appendChild(row);
        }
      }

      // related-character chips (filled async below)
      const charsSec = document.createElement('div');
      charsSec.style.display = 'none';
      const chipRow = document.createElement('div');
      chipRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      charsSec.appendChild(heading(window.i18n.t('tl.characters', '登場人物')));
      charsSec.appendChild(chipRow);
      content.appendChild(charsSec);

      const passages = (art && Array.isArray(art.keyPassages))
        ? art.keyPassages.filter(p => p && p.quote) : [];
      const passBtns = [];
      if (passages.length) {
        content.appendChild(heading(window.i18n.t('tl.memorable_scenes', '印象的な場面')));
        for (const p of passages) {
          const box = document.createElement('div');
          box.style.cssText = 'margin:0 0 14px;';
          // The fill/radius/accent live on an OPAQUE non-text wrapper; the
          // dict-enabled quote text inside stays backgroundless (the Characters
          // screen invariant). Styling bg + asymmetric radius DIRECTLY on the
          // scrolled text was the iOS-only re-raster trigger (line-scan jitter).
          const quoteWrap = document.createElement('div');
          quoteWrap.style.cssText =
            'background:#191722;border-radius:8px;box-shadow:inset 3px 0 0 #6f5fc0;padding:8px 12px;';
          quoteWrap.appendChild(prose(p.quote, 'font-size:.88rem;color:#ccc;'));
          box.appendChild(quoteWrap);
          if (p.why) {
            box.appendChild(prose(p.why, 'font-size:.76rem;color:#8d86a8;line-height:1.6;margin-top:4px;'));
          }
          if (Number.isFinite(p.startMs)) {
            const pb = document.createElement('button');
            pb.textContent = window.i18n.t('tl.listen_scene', '▶ この場面を聴く');
            // hidden until the active title's audio is confirmed loaded
            pb.style.cssText =
              'display:none;margin-top:6px;background:#1d1830;border:1px solid #463a6b;' +
              'border-radius:8px;color:#cbbfee;font-size:.78rem;padding:5px 12px;cursor:pointer;';
            pb.addEventListener('click', (e) => { e.stopPropagation(); playPassage(p, pb); });
            box.appendChild(pb);
            passBtns.push(pb);
          }
          content.appendChild(box);
        }
      }

      const meta = document.createElement('div');
      meta.style.cssText =
        'padding:8px 14px;border-top:1px solid #242424;color:#666;font-size:.7rem;min-height:1em;';
      try {
        const bits = [];
        if (art.model) bits.push(art.model);
        if (Number.isFinite(art.costUsd)) bits.push('~$' + art.costUsd.toFixed(3));
        if (art.ts) bits.push(new Date(art.ts).toLocaleString());
        meta.textContent = bits.join(' · ');
      } catch (_) {}

      card.appendChild(head);
      card.appendChild(content);
      card.appendChild(meta);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Idle the live audio waveform canvas while the chapter view is open: it
      // keeps drawing ~30fps behind this translucent overlay, forcing iOS to
      // recomposite the overlay (and its momentum-scroll text) every frame =
      // scroll jitter. display:none drops it from the render tree; it's
      // occluded anyway and audio playback is unaffected. Restored in close().
      try {
        const wf = document.getElementById('liveWaveform');
        if (wf) { overlay._kaiWfPrev = wf.style.display; overlay._kaiWfHidden = true; wf.style.display = 'none'; }
      } catch (_) {}

      try {
        if (typeof window.dictEnableLookupIn === 'function') {
          for (const el of dictTargets) window.dictEnableLookupIn(el);
        }
      } catch (_) {}

      if (passBtns.length) {
        (async () => {
          try {
            const bg = BG();
            if (!bg || typeof bg.getState !== 'function') return;
            const s = await bg.getState();
            if (s && s.ready && s.url && document.body.contains(overlay)) {
              for (const b of passBtns) b.style.display = 'inline-block';
            }
          } catch (_) {}
        })();
      }

      (async () => {
        try {
          const found = await resolveChars(titleId, art.relatedCharIds);
          if (!found.length || !document.body.contains(overlay)) return;
          for (const c of found) {
            const chip = document.createElement('button');
            chip.textContent = c.surface;
            chip.style.cssText =
              'background:#221d33;border:1px solid #463a6b;border-radius:999px;' +
              'color:#cbbfee;font-size:.78rem;padding:4px 12px;cursor:pointer;';
            chip.addEventListener('click', (e) => {
              e.stopPropagation();
              try {
                if (window.aiCharsUi && typeof window.aiCharsUi.openPopupFor === 'function') {
                  window.aiCharsUi.openPopupFor(c.id);
                }
              } catch (_) {}
            });
            chipRow.appendChild(chip);
          }
          charsSec.style.display = '';
        } catch (_) {}
      })();
    } catch (e) {
      try { console.log('[ai-timeline] chapter view failed: ' + (e && e.message)); } catch (_) {}
    }
  }

  // ---- single-scene card ------------------------------------------------------
  // A dedicated, attractive card for ONE Claude-authored scene (art.scenes[s]):
  //   • the scene image — generate / regenerate / delete (buildImageStrip)
  //   • the ACTUAL book sentence it illustrates (anchorQuote → dict-enabled text)
  //     with a place-safe ▶ preview of the matching book audio
  //   • an INLINE waveform with draggable trim handles (the card-mode editor widget)
  //   • the Japanese caption
  //   • "Ankiに送る" — composite image + the book sentence + the sliced book audio.
  // ▲/▼ navigate to the prev/next scene without closing. z 9000 like the chapter
  // view (shares #kchapterView; only one open at a time). The timeline panel is
  // CLOSED while open and reopened via `reopen`. preEnum/preIdx thread the flat
  // scene list through ▲/▼ nav so it isn't rebuilt each hop.
  async function openSceneCard(titleId, ch, art, s, reopen, preEnum, preIdx, animDir) {
    const reopenSafe = () => { if (reopen) { try { reopen(); } catch (_) {} } };
    try {
      const scenes = (art && Array.isArray(art.scenes)) ? art.scenes : [];
      const sc = scenes[s];
      if (!sc) { reopenSafe(); return; }
      const sCharId = 'scene_' + ch.idx + '_' + s;

      // Flat, reading-order list of every scene across all chapters → ▲/▼ navigation
      // (no close/reopen between scenes). Built once, threaded through nav via preEnum.
      let allScenes = Array.isArray(preEnum) ? preEnum : null;
      if (!allScenes) {
        allScenes = [];
        try {
          const m = await getMapSafe(titleId);
          const aa = filterArtifacts(await loadArtifacts(titleId), m);
          const chs = (m && Array.isArray(m.chunks)) ? m.chunks : [];
          for (const c of chs) { const a = aa ? (aa[c.idx] || null) : null; const sl = (a && Array.isArray(a.scenes)) ? a.scenes : []; for (let k = 0; k < sl.length; k++) allScenes.push({ ch: c, art: a, s: k }); }
        } catch (_) {}
      }
      const curSceneIdx = Number.isFinite(preIdx) ? preIdx : allScenes.findIndex(x => x.ch && x.ch.idx === ch.idx && x.s === s);
      const cloudOn = !!(window.aiImages && window.aiImages.backend && window.aiImages.backend() !== 'local');
      const srcPathOf = (t) => window._srtAbPath || window._pagedAudioPath || (t && t.attachments && t.attachments.audiobook && t.attachments.audiobook.cachePath) || '';

      const prev = document.getElementById('kchapterView');
      if (prev) {
        try { if (prev._kaiOnVis) document.removeEventListener('visibilitychange', prev._kaiOnVis); } catch (_) {}
        if (prev._scenePoll) { try { clearInterval(prev._scenePoll); } catch (_) {} prev._scenePoll = null; }
        prev._dead = true; prev.remove();
        try { await stopPassage(); } catch (_) {}   // a leftover chapter-view passage
        try { clipDispose(); } catch (_) {}          // a leftover scene-card clip (no-op if inactive)
      }
      armLookGuard();

      const overlay = document.createElement('div');
      overlay.id = 'kchapterView';
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 0 calc(8px + env(safe-area-inset-bottom, 0px));';
      // No shieldOverlay (it sets touch-action:none which would kill the inner
      // scroll): #kchapterView is already in app.js's inModal allowlist, so the
      // card-swipe handler bails — same proven path as the chapter view.

      let closed = false, switching = false;
      function onVis() { if (document.hidden) { try { clipDispose(); } catch (_) {} } }
      async function teardown() {
        if (closed) return; closed = true; overlay._dead = true;
        if (overlay._scenePoll) { try { clearInterval(overlay._scenePoll); } catch (_) {} overlay._scenePoll = null; }
        try { clipDispose(); } catch (_) {}   // stop the preview clip + resume the book (book position never moved)
        checkLookGuard();
        try { document.removeEventListener('visibilitychange', onVis); } catch (_) {}
        // Release the shared waveform instance ONLY if we co-opted it (showed one) —
        // else a read-only scene card would needlessly tear down the card-mode
        // waveform. When we did show one, card mode re-shows on its next advance.
        try { if (_wfShown && window.waveform && window.waveform.hide) window.waveform.hide(); } catch (_) {}
        try { const wf = document.getElementById('liveWaveform'); if (wf && overlay._kaiWfHidden) wf.style.display = overlay._kaiWfPrev || ''; } catch (_) {}
        try { overlay.remove(); } catch (_) {}
      }
      async function close() { await teardown(); reopenSafe(); }
      async function navigateScene(dir) {
        if (switching || closed || overlay._dead || curSceneIdx < 0) return;
        const ni = curSceneIdx + dir;
        if (ni < 0 || ni >= allScenes.length) return;
        switching = true;   // claim synchronously so a rapid second ▲/▼ tap can't double-open
        const nx = allScenes[ni];
        try {
          await teardown();   // stop the clip + resume the book (position never moved → place-safe)
          await openSceneCard(titleId, nx.ch, nx.art, nx.s, reopen, allScenes, ni, dir);   // dir → vertical slide-in
        } catch (_) { reopenSafe(); }
        finally { switching = false; }   // (this card is now dead anyway; reset for clarity/safety)
      }
      document.addEventListener('visibilitychange', onVis);
      overlay._kaiOnVis = onVis;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      const card = document.createElement('div');
      card.style.cssText =
        'background:#141414;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(94vw,640px);height:86vh;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';

      // header
      const head = document.createElement('div');
      head.id = 'kchapterViewHead';
      head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #242424;';
      const ht = document.createElement('div');
      ht.style.cssText = 'flex:1;min-width:0;';
      const chLabel = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: ch.idx + 1 }, '第' + (ch.idx + 1) + '章');
      const hasNav = allScenes.length > 1 && curSceneIdx >= 0;
      ht.innerHTML =
        '<div style="font-weight:600;color:#eee;font-size:1rem;">' + esc(window.i18n.t('tl.scene_label', 'シーン')) + (hasNav ? ('　' + (curSceneIdx + 1) + ' / ' + allScenes.length) : (' ' + (s + 1))) + '</div>' +
        '<div style="color:#888;font-size:.72rem;margin-top:2px;">' + esc(chLabel) + '</div>';
      const xb = document.createElement('button');
      xb.textContent = '✕';
      xb.style.cssText = 'background:none;border:1px solid #333;border-radius:8px;color:#ccc;font-size:1.4rem;padding:6px 14px;cursor:pointer;';
      xb.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      head.appendChild(ht);
      head.appendChild(xb);

      const content = document.createElement('div');
      content.style.cssText = 'flex:1;overflow-y:auto;padding:16px 18px;background:#141414;-webkit-overflow-scrolling:touch;';

      const dictTargets = [];
      const prose = (text, extra) => {
        const d = document.createElement('div');
        d.className = 'kai-summary-text';
        d.style.cssText = 'color:#ddd;font-family:var(--font-family-card);font-size:var(--font-size-card);line-height:1.7;white-space:pre-wrap;' + (extra || '');
        d.textContent = text || '';
        return d;
      };
      const heading = (txt) => {
        const h = document.createElement('div');
        h.style.cssText = 'margin:18px 0 8px;color:#8a7fb8;font-size:.78rem;font-weight:700;letter-spacing:.06em;';
        h.textContent = txt;
        return h;
      };

      // status line (shared by generate + anki actions)
      const gst = document.createElement('div');
      gst.style.cssText = 'font-size:.72rem;color:#8a8a96;margin-top:8px;min-height:1em;';

      // ---- image: strip (regenerate/delete) + a first-gen button until one exists ----
      const strip = window.aiImages.buildImageStrip(titleId, sCharId, { interactive: true, hideCaption: true, editablePrompt: sc.prompt || '', onRegenerate: (edited) => doGen(edited) });
      content.appendChild(strip);

      const genWrap = document.createElement('div');
      genWrap.style.cssText = 'margin:6px 0;';
      const genBtn = document.createElement('button');
      genBtn.textContent = window.i18n.t('tl.generate_this_scene', 'この場面を生成');
      genBtn.style.cssText = 'background:#1d1830;border:1px solid #463a6b;border-radius:10px;color:#cbbfee;font-size:.86rem;padding:10px 16px;cursor:pointer;width:100%;';
      genWrap.appendChild(genBtn);
      content.appendChild(genWrap);

      const armScenePoll = () => {
        if (overlay._scenePoll || closed || overlay._dead) return;
        overlay._scenePoll = setInterval(async () => {
          if (closed || overlay._dead || !document.body.contains(overlay)) { clearInterval(overlay._scenePoll); overlay._scenePoll = null; return; }
          try { await window.aiImages.sync(titleId); } catch (_) {}
          try { strip._reload && strip._reload(); } catch (_) {}
          refreshGen();
        }, 9000);
      };
      const refreshGen = async () => {
        try {
          const st = await window.aiImages.statusFor(titleId, sCharId);
          const has = !!(st && st.images > 0);
          genWrap.style.display = has ? 'none' : '';
          if (!has && !cloudOn) { genBtn.disabled = true; genBtn.style.opacity = '.5'; gst.textContent = window.i18n.t('tl.need_cloud_backend', 'ChatGPT/falバックエンドが必要です'); }
        } catch (_) {}
      };
      async function doGen(promptOverride) {
        if (!cloudOn) { gst.textContent = window.i18n.t('tl.need_cloud_backend', 'ChatGPT/falバックエンドが必要です'); return; }
        const edited = (typeof promptOverride === 'string' && promptOverride.trim()) ? promptOverride.trim() : '';
        const usePrompt = edited || sc.prompt;
        genBtn.disabled = true; gst.textContent = window.i18n.t('tl.sending', '送信中…');
        window._kaiImgProgress = (t) => { try { gst.textContent = t; } catch (_) {} };
        try {
          if (edited && edited !== sc.prompt) {
            sc.prompt = edited;   // reflect in this card + future regens, and persist so it sticks
            try { await window.aiProcessor.setScenePrompt(titleId, ch.idx, s, edited); } catch (_) {}
          }
          const q = await window.aiImages.queueSceneFromPrompt(titleId, ch.idx, s, { prompt: usePrompt, caption: sc.caption || '', style: sc.style || '', sceneId: sc.id || ('s' + s), label: chLabel });
          if (!q || q.ok === false) { gst.textContent = (q && q.reason === 'no-prompt') ? window.i18n.t('tl.no_prompt', 'プロンプトがありません') : window.i18n.t('tl.generation_failed', '生成に失敗'); return; }
          const r = await window.aiImages.sync(titleId);
          if (!r || r.ok === false) gst.textContent = (r && r.reason === 'refused') ? (r.refusalMsg || window.i18n.t('tl.refused', '拒否されました')) : (r && r.reason === 'no-key') ? window.i18n.t('tl.set_key', 'キーを設定してください') : (window.i18n.t('tl.failed', '失敗') + (r && r.error ? ('：' + r.error) : ''));
          else gst.textContent = r.ingested ? '' : window.i18n.t('tl.waiting_generation', '生成待ち…');
          try { strip._reload && strip._reload(); } catch (_) {}
          armScenePoll();
        } catch (_) { gst.textContent = window.i18n.t('common.error', 'エラー'); }
        finally { window._kaiImgProgress = null; genBtn.disabled = false; refreshGen(); }
      }
      genBtn.addEventListener('click', (e) => { e.stopPropagation(); doGen(); });
      content.appendChild(gst);
      refreshGen();

      // ---- caption (right under the picture) ----
      if (sc.caption) { const cap = prose(sc.caption, 'color:#cdd;margin-top:8px;'); content.appendChild(cap); dictTargets.push(cap); }

      // ---- book text + clip audio preview + inline waveform trimmer ----
      let loc = null, _wfShown = false, _srcPath = '';
      const playBtn = document.createElement('button');   // plain ▶ / ❚❚ transport toggle, LEFT of the waveform
      playBtn.textContent = '▶';
      playBtn.title = window.i18n.t('tl.play_pause', '再生 / 一時停止');
      playBtn.style.cssText = 'flex:none;background:#1d1830;border:1px solid #463a6b;border-radius:999px;color:#cbbfee;font-size:1.05rem;width:44px;height:44px;line-height:1;cursor:pointer;';
      const wfHost = document.createElement('div');   // inline waveform (draggable trim handles), fills the rest of the row
      wfHost.style.cssText = 'flex:1;min-width:0;';
      const audioRow = document.createElement('div');
      audioRow.style.cssText = 'display:none;align-items:center;gap:12px;margin:12px 0 2px;';
      audioRow.appendChild(playBtn); audioRow.appendChild(wfHost);

      content.appendChild(heading(window.i18n.t('tl.book_text', '本文')));
      const bookTextEl = prose(window.i18n.t('tl.matching_book_text', '本文を照合中…'), 'color:#999;');
      content.appendChild(bookTextEl);
      content.appendChild(audioRow);

      // Current bounds: the LIVE waveform selection while it's shown (handle drag),
      // else the persisted trim, else the auto-located sentence range.
      const curBounds = () => {
        try { if (_wfShown && window.waveform && window.waveform.current) { const c = window.waveform.current(); if (c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs) return { startMs: c.startMs, endMs: c.endMs }; } } catch (_) {}
        const t = sceneTrimGet(titleId, sCharId);
        if (t) return { startMs: t.startMs, endMs: t.endMs };
        if (loc && Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs) && loc.endMs > loc.startMs) return { startMs: loc.startMs, endMs: loc.endMs };
        return null;
      };
      // Clip transport: plays the trimmed selection via a dedicated <audio> element
      // (the sliced clip) — it ENDS on its own (reliable stop) and never moves the
      // book's playhead. The toggle pauses mid-clip.
      playBtn.addEventListener('click', (e) => { e.stopPropagation(); clipPlay(curBounds(), playBtn, _srcPath); });

      // Embed the waveform inline (non-cardMode → draggable handles). onChange (handle
      // drag) persists the trim. The widget's built-in Preview/Reset are hidden (the
      // card's ▶ drives preview; Reset would clobber the trim).
      async function showInlineWaveform() {
        try {
          if (_wfShown || closed || overlay._dead) return;
          const b = curBounds();
          if (!b || !_srcPath || !(window.waveform && window.waveform.show)) return;
          window.waveform.show({
            container: wfHost, srcPath: _srcPath, startMs: b.startMs, endMs: b.endMs,
            onChange: (nb) => { try { if (nb && Number.isFinite(nb.startMs) && Number.isFinite(nb.endMs) && nb.endMs > nb.startMs) sceneTrimSet(titleId, sCharId, nb.startMs, nb.endMs); } catch (_) {} },
          });
          _wfShown = true;
          try { const pv = wfHost.querySelector('[data-role="preview"]'); if (pv) pv.style.display = 'none'; const rs = wfHost.querySelector('[data-role="reset"]'); if (rs) rs.style.display = 'none'; } catch (_) {}
        } catch (_) {}
      }

      (async () => {
        try {
          if (sc.anchorQuote && window.aiChunks && window.aiChunks.cueRangeForQuote) loc = await window.aiChunks.cueRangeForQuote(titleId, ch.idx, sc.anchorQuote);
        } catch (_) {}
        if (closed || overlay._dead) return;
        let t = null; try { t = await window.titleStore.get(titleId); } catch (_) {}
        _srcPath = srcPathOf(t);
        const txt = (loc && loc.expression) || '';
        if (txt) {
          bookTextEl.textContent = txt; bookTextEl.style.color = '#ddd';
          try { if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(bookTextEl); } catch (_) {}
        } else {
          bookTextEl.textContent = sc.anchorQuote ? window.i18n.t('tl.book_text_not_found', '本文が見つかりませんでした。') : window.i18n.t('tl.scene_no_quote', 'この場面には本文の引用がありません（シーン案を作り直すと付きます）。');
          bookTextEl.style.color = '#888';
        }
        // reveal the ▶ + inline waveform once a range AND an audio source exist (the
        // clip is sliced from the file directly — the book engine needn't be loaded)
        if (curBounds() && _srcPath && document.body.contains(overlay) && !closed) {
          audioRow.style.display = 'flex';
          showInlineWaveform();
        }
      })();

      // ---- send to Anki ----
      const ankiBtn = document.createElement('button');
      ankiBtn.textContent = window.i18n.t('tl.send_to_anki', 'Ankiに送る');
      ankiBtn.style.cssText = 'margin-top:18px;background:#16221a;border:1px solid #2f5a3a;border-radius:10px;color:#9fe0b0;font-size:.9rem;padding:11px 16px;cursor:pointer;width:100%;';
      ankiBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); ankiBtn.disabled = true; gst.textContent = window.i18n.t('tl.anki_preparing', 'Anki準備中…');
        try {
          const rows = await window.aiImages.getImages(titleId, sCharId);
          const sceneUri = (rows && rows.length) ? rows[rows.length - 1].dataUri : '';
          if (!sceneUri) { gst.textContent = window.i18n.t('tl.generate_image_first', 'まず画像を生成してください'); return; }
          let t = null; try { t = await window.titleStore.get(titleId); } catch (_) {}
          const cover = (t && t.attachments && t.attachments.cover && t.attachments.cover.dataUri) || '';
          let imageData = '';
          try { imageData = await window.aiImages.compositeScene(sceneUri, cover, (t && t.name) || ''); }
          catch (ce) { gst.textContent = window.i18n.t('tl.composite_failed', '画像の合成に失敗'); try { console.log('[scene] compositeScene failed: ' + (ce && ce.message)); } catch (_) {} return; }
          const expression = (loc && loc.expression) || sc.caption || ('シーン ' + (s + 1));
          let audioData = '';
          let audioNote = '';   // why audio is/ isn't attached → shown to the user (diagnostic)
          const srcPath = srcPathOf(t);
          // Uses the current bounds: the live inline-waveform selection (the user's
          // handle drags), else the persisted trim, else the auto-located range. Same
          // slice path as the ▶ preview (_sliceToUri).
          const bounds = curBounds();
          if (!bounds || !Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs) || bounds.endMs <= bounds.startMs) audioNote = window.i18n.t('tl.no_audio', '音声なし');
          else if (!srcPath) audioNote = window.i18n.t('tl.no_audio', '音声なし');
          else {
            audioData = await _sliceToUri(srcPath, bounds.startMs, bounds.endMs);
            if (!audioData) audioNote = window.i18n.t('tl.no_audio', '音声なし');
          }
          if (!window.sendToAnki) { gst.textContent = window.i18n.t('tl.anki_unsupported', 'Anki未対応'); return; }
          await window.sendToAnki({ expression, imageData, audioData });   // shows its own ✓ Added toast
          gst.textContent = audioData ? window.i18n.t('tl.anki_sent_with_audio', 'Ankiに送信しました（音声付）') : (window.i18n.t('tl.anki_sent', 'Ankiに送信しました') + (audioNote ? ('（' + audioNote + '）') : ''));
        } catch (_) { gst.textContent = window.i18n.t('tl.anki_send_failed', 'Anki送信に失敗'); }
        finally { ankiBtn.disabled = false; }
      });
      content.appendChild(ankiBtn);

      card.appendChild(head); card.appendChild(content);
      // Prev / Next footer (fixed at the card bottom — within thumb reach, not the
      // awkward top). Disabled at the ends.
      if (hasNav) {
        const foot = document.createElement('div');
        foot.style.cssText = 'flex:none;display:flex;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid #242424;background:#141414;';
        const navBtn = (txt, dir, atEdge) => {
          const b = document.createElement('button');
          b.textContent = txt; b.disabled = atEdge;
          b.style.cssText = 'flex:1;background:' + (atEdge ? '#15151b' : '#1c1c24') + ';border:1px solid ' + (atEdge ? '#202028' : '#3a3450') + ';border-radius:10px;color:' + (atEdge ? '#444' : '#cbbfee') + ';font-size:.9rem;padding:11px 12px;cursor:' + (atEdge ? 'default' : 'pointer') + ';';
          if (!atEdge) b.addEventListener('click', (e) => { e.stopPropagation(); navigateScene(dir); });
          return b;
        };
        foot.appendChild(navBtn(window.i18n.t('tl.prev_scene', '‹ 前のシーン'), -1, curSceneIdx <= 0));
        foot.appendChild(navBtn(window.i18n.t('tl.next_scene', '次のシーン ›'), 1, curSceneIdx >= allScenes.length - 1));
        card.appendChild(foot);
      }
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Vertical slide-in when arriving from a ▲/▼ or swipe nav (next from below,
      // prev from above) — gives the "scrolled to the next scene" feel.
      if (animDir) {
        try {
          card.style.transition = 'none';
          card.style.transform = 'translateY(' + (animDir > 0 ? 36 : -36) + 'px)';
          card.style.opacity = '0';
          requestAnimationFrame(() => { try { card.style.transition = 'transform .22s ease-out, opacity .22s ease-out'; card.style.transform = 'translateY(0)'; card.style.opacity = '1'; } catch (_) {} });
        } catch (_) {}
      }

      // idle the live waveform behind the overlay (same as the chapter view)
      try { const wf = document.getElementById('liveWaveform'); if (wf) { overlay._kaiWfPrev = wf.style.display; overlay._kaiWfHidden = true; wf.style.display = 'none'; } } catch (_) {}

      try { if (typeof window.dictEnableLookupIn === 'function') { for (const el of dictTargets) window.dictEnableLookupIn(el); } } catch (_) {}

      // arm the poll if a render is already in flight for this scene
      (async () => { try { const st = await window.aiImages.statusFor(titleId, sCharId); if (st && st.pending) armScenePoll(); } catch (_) {} })();
    } catch (e) {
      try { console.log('[ai-timeline] scene card failed: ' + (e && e.message)); } catch (_) {}
      reopenSafe();
    }
  }

  // Open a chapter view directly (Characters screen links etc.).
  async function openChapter(titleId, idx) {
    try {
      titleId = titleId || window._activeTitleId;
      if (!titleId || !Number.isFinite(idx)) return false;
      const map = await getMapSafe(titleId);
      const arts = filterArtifacts(await loadArtifacts(titleId), map);
      const art = arts[idx];
      if (!art) return false;
      const ch = (map && map.chunks.find(c => c && c.idx === idx)) || { idx, label: null };
      await openChapterView(titleId, ch, art, null);
      return true;
    } catch (_) { return false; }
  }

  // ---- full-screen panel --------------------------------------------------------
  // Returns false when no axis exists (no chunk map AND nothing to probe) —
  // the caller (bookmarks.openMenu) shows its legacy fallback list.
  async function openPanel() {
    try {
      const titleId = window._activeTitleId;
      if (!titleId) return false;

      let map = await getMapSafe(titleId);
      let axis = map ? buildMapAxis(map) : buildProbeAxis();
      if (!axis) return false;

      let arts = map ? filterArtifacts(await loadArtifacts(titleId), map) : {};
      let segs = await coverageSegments(titleId, axis);
      let rsegs = await revisitSegments(titleId, axis);
      let bms = (window.bookmarks && window.bookmarks.list)
        ? window.bookmarks.list().filter(b => b.titleId === titleId) : [];
      let saved = [];
      try {
        saved = (window.aiSummary && window.aiSummary.listSaved)
          ? await window.aiSummary.listSaved(titleId) : [];
      } catch (_) {}
      const furthest = (window.bookmarks && window.bookmarks.getFurthest)
        ? window.bookmarks.getFurthest(titleId) : null;

      try {
        if (window.ai && typeof window.ai.markSeen === 'function') window.ai.markSeen(titleId, 'timeline');
      } catch (_) {}

      const prev = document.getElementById('bookmarksOverlay');
      if (prev) prev.remove();

      let zoom = 1;
      let lastSpineH = 0;
      let refreshTimer = null;
      let _imgPoll = null;   // while open: pull finished scene renders from the server
      let _posTimer = null;  // while open: keep the live current-place marker tracking
      let _nowMarkerEl = null;   // the glowing current-place marker element
      ensureAxisMarkerStyle();
      let _sceneStat = {};   // chapterIdx → {images, unseen}: timeline ✦ / 新着 markers
      let _sceneSlotStat = {};   // 'scene_<idx>_<slot>' → {images, unseen, pending}: per-scene feed rows
      async function refreshSceneHave() {
        if (!document.body.contains(overlay)) { try { window.removeEventListener('kai:img-data', refreshSceneHave); } catch (_) {} return; }
        try {
          if (window.aiImages && window.aiImages.sceneStatusByChapter) _sceneStat = await window.aiImages.sceneStatusByChapter(titleId) || {};
          // per-scene slot status for the inline feed rows (thumbnail vs 生成 button)
          if (window.aiImages && window.aiImages.statusBatch) {
            const ids = [];
            try { for (const [k, a] of Object.entries(arts || {})) { const scns = (a && Array.isArray(a.scenes)) ? a.scenes : []; for (let s = 0; s < scns.length; s++) ids.push('scene_' + k + '_' + s); } } catch (_) {}
            _sceneSlotStat = ids.length ? (await window.aiImages.statusBatch(titleId, ids) || {}) : {};
          }
          scheduleRefresh(60);
        } catch (_) {}
      }

      const overlay = document.createElement('div');
      overlay.id = 'bookmarksOverlay';   // keeps the swipe-block + dismiss conventions
      // Match the Characters screen: a centered card over a dimmed backdrop, inset from
      // the safe area, so on Android it sits BELOW the status bar instead of full-bleed
      // over it (a top-anchored full-screen panel put its header under the status bar).
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 0 calc(8px + env(safe-area-inset-bottom, 0px));';
      const panel = document.createElement('div');
      panel.style.cssText =
        'background:#0d0d12;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(96vw,860px);height:96vh;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';

      function destroy() {
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        if (_imgPoll) { clearInterval(_imgPoll); _imgPoll = null; }
        if (_posTimer) { clearInterval(_posTimer); _posTimer = null; }
        try { window.removeEventListener('kai:ai-data', onData); } catch (_) {}
        try { window.removeEventListener('kai:scenes-changed', onData); } catch (_) {}
        try { window.removeEventListener('kai:img-data', refreshSceneHave); } catch (_) {}
        try { window.removeEventListener('kai:proc-status', onProc); } catch (_) {}
        try { overlay.remove(); } catch (_) {}
      }

      // header
      const head = document.createElement('div');
      head.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #222;';   // card is already inset below the safe area
      const title = document.createElement('div');
      title.style.cssText = 'flex:1;font-weight:600;color:#eee;font-size:1rem;';
      title.innerHTML = esc(window.i18n.t('tl.title', 'Timeline & Scenes')) + ' <span style="color:#666;font-size:.68rem;font-weight:400;">' +
                        window.i18n.fmt('tl.chars', { n: Math.round(axis.total).toLocaleString() }, Math.round(axis.total).toLocaleString() + '字') + '</span>';
      const mkBtn = (txt, fn, dim) => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'background:#1c1c24;border:1px solid #333;border-radius:8px;' +
          'color:' + (dim ? '#777' : '#ccc') + ';font-size:1.4rem;padding:6px 14px;cursor:pointer;';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      head.appendChild(title);
      head.appendChild(mkBtn('✕', () => destroy()));
      panel.appendChild(head);

      // body: a thin DECORATIVE coverage axis (whole-book progress, colored by
      // modality) on the left + the scrollable chapter list on the right.
      const bodyRow = document.createElement('div');
      bodyRow.style.cssText = 'flex:1;min-height:0;display:flex;';
      // axisWrap is NOT clipped (so the glowing current-place marker can spill
      // past the 6px column); axisCol inside it IS clipped (coverage segments).
      const axisWrap = document.createElement('div');
      axisWrap.style.cssText = 'flex:none;width:6px;margin:12px 4px 10px 10px;position:relative;';
      const axisCol = document.createElement('div');
      axisCol.style.cssText = 'position:absolute;inset:0;border-radius:3px;background:#23232a;overflow:hidden;';
      axisWrap.appendChild(axisCol);
      bodyRow.appendChild(axisWrap);
      // Second track: where the user went BACK to re-read/re-listen (hidden when empty).
      const revisitCol = document.createElement('div');
      revisitCol.style.cssText = 'flex:none;width:5px;margin:12px 7px 10px 1px;border-radius:2px;background:transparent;position:relative;overflow:hidden;display:none;';
      bodyRow.appendChild(revisitCol);
      const main = document.createElement('div');
      main.style.cssText =
        'flex:1;min-width:0;position:relative;overflow-y:auto;overflow-x:hidden;' +
        '-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;';
      const inner = document.createElement('div');
      inner.style.cssText = 'position:relative;width:100%;';
      main.appendChild(inner);
      bodyRow.appendChild(main);
      panel.appendChild(bodyRow);

      const foot = document.createElement('div');
      foot.style.cssText =
        'padding:10px 14px;border-top:1px solid #222;display:flex;flex-direction:column;gap:8px;';   // card already clears the home indicator
      panel.appendChild(foot);

      overlay.appendChild(panel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy(); });   // tap outside the card closes (like Characters)
      document.body.appendChild(overlay);

      function offerProcess() {
        try {
          if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) {
            if (typeof window.showToast === 'function') {
              window.showToast(window.i18n.t('tl.enable_ai_first', 'Enable AI in Preferences → AI assistant first'), 3000);
            }
            return;
          }
          if (!window.aiProcessor || typeof window.aiProcessor.updateNow !== 'function') return;
          window.aiProcessor.updateNow(titleId);
          if (typeof window.showToast === 'function') {
            window.showToast(window.i18n.t('tl.processing_toast', 'Processing — chapter cards appear when ready'), 2500);
          }
          scheduleRefresh(900);
        } catch (_) {}
      }

      // A chapter "has a summary" only when shortSummary is present — the SAME
      // condition buildChapterRow uses to print the body text. An artifact that
      // exists but lacks shortSummary (a scenes-only stub, an empty model reply,
      // or a stale-fp entry) must NOT count, or the card would say "tap to
      // generate" while the tap merely opened an empty view (the skipped-chapter bug).
      function hasSummary(a) { return !!(a && a.shortSummary); }

      // Targeted regenerate of one chapter's summary. Routes through the new
      // chapter-targeted processor that bypasses the strict in-order pump (so a
      // stranded mid-book chapter actually fills) while keeping the spoiler guard.
      function regenChapter(ch) {
        try {
          if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) {
            if (typeof window.showToast === 'function') {
              window.showToast(window.i18n.t('tl.enable_ai_first', 'Enable AI in Preferences → AI assistant first'), 3000);
            }
            return;
          }
          if (window.aiProcessor && typeof window.aiProcessor.processChapter === 'function') {
            window.aiProcessor.processChapter(titleId, ch.idx, { force: true });
            if (typeof window.showToast === 'function') window.showToast(window.i18n.t('tl.generating_summary', '要約を生成中…'), 2500);
            scheduleRefresh(900);
          } else {
            offerProcess();   // fallback if the targeted path isn't available
          }
        } catch (_) {}
      }

      function makeChapterTap(ch, art, complete) {
        if (hasSummary(art)) {
          return () => {
            destroy();
            openChapterView(titleId, ch, art, () => { try { openPanel(); } catch (_) {} });
          };
        }
        // No usable summary yet.
        const hasScenes = !!_sceneStat[ch.idx] ||
          !!(window.aiScenes && window.aiScenes.deferredChapters && window.aiScenes.deferredChapters(titleId).has(ch.idx));
        const state = ch.state || 'none';
        // Fully read (or a failed attempt) → the tap GENERATES the missing summary.
        // (Scene rows below carry their own taps, so scenes stay viewable.) This is
        // the fix: the tap used to open an empty view or hit the global in-order
        // pump that could never reach a stranded chapter.
        if (complete || state === 'failed') {
          return () => regenChapter(ch);
        }
        // Not yet read, but it already has scene images → open the card to view them.
        if (hasScenes) {
          return () => {
            destroy();
            openChapterView(titleId, ch, null, () => { try { openPanel(); } catch (_) {} });
          };
        }
        return null;
      }

      // Navigate the book to a chapter's start: seek the audio to its first cue
      // (if mapped + loaded) and jump the reader to its first chunk. Explicit
      // user navigation, so a deliberate position change is fine.
      async function jumpToChapter(ch) {
        try {
          // NEVER-LOSE-PLACE: record where the user is NOW (any mode) into
          // History BEFORE navigating, so this jump is always recoverable.
          try { if (window.bookmarks && window.bookmarks.captureCurrent) window.bookmarks.captureCurrent({ force: true }); } catch (_) {}
          destroy();
          try {
            const cueStart = Number.isFinite(ch.cueStart) ? ch.cueStart : -1;
            if (cueStart >= 0 && Array.isArray(window._srtCues) && window._srtCues[cueStart]) {
              const ms = window._srtCues[cueStart].startMs;
              const bg = BG();
              if (bg && typeof bg.seek === 'function' && Number.isFinite(ms)) {
                bg.seek({ ms: Math.max(0, Math.round(ms)) });
              }
            }
          } catch (_) {}
          try {
            if (typeof window.pagedJumpToBookmark === 'function' && Number.isFinite(ch.startChunk)) {
              await window.pagedJumpToBookmark({ chunkIdx: ch.startChunk, jpOff: ch.jpStart });
            }
          } catch (_) {}
        } catch (_) {}
      }

      function buildChapterCard(ch, art, complete, prog, full, onTap) {
        const idx = ch.idx;
        // A "✦" in the gutter = this chapter HAS scene illustration(s) — OR an unlocked
        // scene awaiting generation (auto-render capped/offline). Tap the chapter to
        // view its 場面 section (or generate). This is how scenes are FOUND.
        const sceneMark = !!_sceneStat[idx] ||
          !!(window.aiScenes && window.aiScenes.deferredChapters && window.aiScenes.deferredChapters(titleId).has(idx));
        const state = ch.state || 'none';
        const unread = !complete && !art && state === 'none';
        const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
        const card = document.createElement('div');
        card.className = 'menu-item';
        let css =
          'position:absolute;left:' + COL_X + 'px;right:10px;background:#16161d;' +
          'border:1px solid #26262e;border-radius:10px;touch-action:pan-y;' +   // a vertical drag on a card scrolls (Android), tap still works
          (onTap ? 'cursor:pointer;' : '') + (unread ? 'opacity:.55;' : '');
        if (!full) {
          // semantic zoom: label-only row
          css += 'padding:6px 10px;display:flex;align-items:center;gap:8px;';
          card.style.cssText = css;
          const n = document.createElement('span');
          n.style.cssText = 'color:#888;font-size:.9rem;font-weight:700;';
          n.textContent = String(idx + 1);
          const l = document.createElement('span');
          l.style.cssText = 'flex:1;min-width:0;color:' + (unread ? '#999' : '#e6e6e6') +
            ';font-size:1.02rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          l.textContent = unread ? ((ch.label || window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章')) + ' · ' + window.i18n.t('tl.unread', '未読')) : label;
          card.appendChild(n);
          card.appendChild(l);
          if (prog.pct > 0) {
            const pc = document.createElement('span');
            pc.style.cssText = 'color:#777;font-size:.72rem;';
            pc.textContent = Math.round(prog.pct * 100) + '%';
            card.appendChild(pc);
          }
        } else {
          css += 'padding:9px 30px 10px 12px;';
          card.style.cssText = css;
          const titleRow = document.createElement('div');
          titleRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;';
          const titleEl = document.createElement('div');
          titleEl.style.cssText =
            'flex:1;min-width:0;font-weight:700;font-size:1.12rem;line-height:1.3;color:' + (unread ? '#aaa' : '#f0f0f0') + ';';
          // chapter NAME: AI label → EPUB chapter name (ch.label) → 第N章
          titleEl.textContent = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
          titleRow.appendChild(titleEl);
          // jump-to-chapter arrow (navigate the book to this chapter's start)
          const jb = document.createElement('button');
          jb.textContent = '➤';
          jb.title = window.i18n.t('tl.go_to_chapter', 'Go to this chapter in the book');
          jb.style.cssText =
            'flex:none;background:none;border:1px solid #3a3450;border-radius:7px;color:#aab4dd;' +
            'font-size:.82rem;padding:2px 9px;cursor:pointer;line-height:1.2;';
          jb.addEventListener('click', (e) => { e.stopPropagation(); jumpToChapter(ch); });
          titleRow.appendChild(jb);
          card.appendChild(titleRow);
          const sub = document.createElement('div');
          if (art && art.shortSummary) {
            sub.style.cssText =
              'margin-top:4px;color:#b8b8b8;font-size:.95rem;line-height:1.5;' +
              'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;';
            sub.textContent = art.shortSummary;
          } else if (state === 'processing') {
            sub.style.cssText = 'margin-top:3px;color:#cbbfee;font-size:.8rem;';
            sub.textContent = window.i18n.t('tl.processing', '処理中…');
          } else if (state === 'queued') {
            sub.style.cssText = 'margin-top:3px;color:#888;font-size:.8rem;';
            sub.textContent = window.i18n.t('tl.queued_waiting', '待機中…');
          } else if (state === 'failed') {
            sub.style.cssText = 'margin-top:3px;color:#e08a8a;font-size:.8rem;';
            sub.textContent = window.i18n.t('tl.failed_tap_retry', '失敗 — タップで再試行');
          } else if (complete) {
            sub.style.cssText = 'margin-top:3px;color:#8a7fb8;font-size:.8rem;';
            sub.textContent = window.i18n.t('tl.tap_to_generate', 'タップして要約を生成');
          } else {
            sub.style.cssText = 'margin-top:3px;color:#666;font-size:.8rem;';
            sub.textContent = prog.pct > 0.02 ? (Math.round(prog.pct * 100) + '%') : window.i18n.t('tl.unread', '未読');
          }
          card.appendChild(sub);
          if (prog.pct > 0) {
            // positional multi-segment bar: each coverage piece sits at its
            // place within the chapter's own [jpStart, jpEnd] range
            const bar = document.createElement('div');
            bar.style.cssText =
              'margin-top:8px;height:3px;background:#26262e;border-radius:2px;' +
              'overflow:hidden;position:relative;';
            const a = ch.jpStart, b = ch.jpEnd;
            const len = (Number.isFinite(a) && Number.isFinite(b) && b > a) ? (b - a) : 0;
            const pieces = len > 0 ? barSegments(segs, a, b) : [];
            if (pieces.length) {
              for (const pc of pieces) {
                const d = document.createElement('div');
                d.style.cssText =
                  'position:absolute;top:0;bottom:0;' +
                  'left:' + (((pc[0] - a) / len) * 100).toFixed(2) + '%;' +
                  'width:' + (((pc[1] - pc[0]) / len) * 100).toFixed(2) + '%;' +
                  'background:' + (COLORS[pc[2]] || '#555') + ';';
                bar.appendChild(d);
              }
            } else {
              // pre-tracker progress (furthest watermark only): gray fill
              const fill = document.createElement('div');
              fill.style.cssText =
                'height:100%;width:' + Math.round(prog.pct * 100) + '%;' +
                'border-radius:2px;background:#3a3a46;';
              bar.appendChild(fill);
            }
            card.appendChild(bar);
          }
        }
        if (sceneMark) {
          const sb = document.createElement('div');
          sb.textContent = '✦';
          sb.title = window.i18n.t('tl.scene_marker_title', 'この章の場面（タップで表示）');
          sb.style.cssText = 'position:absolute;top:50%;left:-15px;transform:translateY(-50%);color:#c8a23a;font-size:.85rem;line-height:1;pointer-events:none;';
          card.appendChild(sb);
        }
        if (onTap) card.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
        return card;
      }

      function renderChapters(chapters, innerH, Y, cx, furthestJp) {
        const full = (innerH / chapters.length) >= FULL_CARD_SLOT_PX;
        let cursor = 0;
        for (const ch of chapters) {
          const idx = ch.idx;
          const art = arts ? (arts[idx] || null) : null;
          const state = ch.state || 'none';
          const complete = chapterComplete(map, ch);
          const prog = chapterProgress(ch, segs, furthestJp);
          const anchor = Math.max(0, Math.min(innerH, Y(ch.jpStart || 0)));
          const nodeY = Math.max(NODE_R, Math.min(innerH - NODE_R, anchor));
          const onTap = makeChapterTap(ch, art, complete);

          // node on the spine
          const node = document.createElement('div');
          let ns =
            'position:absolute;left:' + (cx - NODE_R) + 'px;top:' + (nodeY - NODE_R) + 'px;' +
            'width:' + (NODE_R * 2) + 'px;height:' + (NODE_R * 2) + 'px;border-radius:50%;' +
            'display:flex;align-items:center;justify-content:center;z-index:5;' +
            'font-size:.72rem;font-weight:700;box-sizing:border-box;' +
            (onTap ? 'cursor:pointer;' : '');
          if (art && complete) {
            // done = filled/shaded number (keep the chapter number visible)
            ns += 'background:#6f5fc0;border:2px solid #8d7ee0;color:#fff;';
            node.textContent = String(idx + 1);
          } else if (state === 'failed') {
            ns += 'background:#241317;border:2px solid #7c3a42;color:#e08a8a;font-size:.8rem;';
            node.textContent = '⚠';
          } else if (state === 'processing') {
            ns += 'background:#1d1830;border:2px solid #6a5ca8;color:#cbbfee;';
            node.textContent = String(idx + 1);
            node.classList.add('kai-glow');
          } else if (art) {
            ns += 'background:#1d1830;border:2px solid #6f5fc0;color:#cbbfee;';
            node.textContent = String(idx + 1);
          } else {
            ns += 'background:#15151c;border:2px solid #3a3a44;color:#777;';
            node.textContent = String(idx + 1);
          }
          node.style.cssText = ns;
          if (onTap) node.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
          inner.appendChild(node);

          const card = buildChapterCard(ch, art, complete, prog, full, onTap);
          if (full) {
            // EXACT axis alignment: the card spans the chapter's own char range
            // (top = Y(jpStart), bottom = Y(jpEnd)). Chapters are contiguous, so
            // cards tile the axis perfectly — a long chapter is a tall card, a
            // short one a short card. Content clips (overflow) when the span is
            // tight; a small floor keeps at least the title legible.
            const bot = Y(Number.isFinite(ch.jpEnd) ? ch.jpEnd : ch.jpStart);
            const spanH = Math.max(0, bot - anchor);
            card.style.top = anchor + 'px';
            // Floor at ~one title line + padding so a short / zoomed-out chapter never
            // clips its TITLE (the "text cut off / compressed" artifact). Short cards
            // may slightly overlap the next — legible beats clipped.
            card.style.height = Math.max(46, spanH - 5) + 'px';
            card.style.overflow = 'hidden';
            inner.appendChild(card);
            cursor = Math.max(cursor, anchor + spanH);
          } else {
            // label-only (zoomed out): keep the push-down rows + connector tick
            const tick = document.createElement('div');
            tick.style.cssText =
              'position:absolute;left:' + (cx + NODE_R) + 'px;width:' + (COL_X - cx - NODE_R - 4) + 'px;' +
              'height:1px;background:#2c2c36;top:' + nodeY + 'px;pointer-events:none;';
            inner.appendChild(tick);
            const top = Math.max(anchor - 4, cursor);
            card.style.top = top + 'px';
            inner.appendChild(card);
            cursor = top + (card.offsetHeight || 28) + 8;
          }
        }
        return cursor;
      }

      // No chunk map yet: spine fill + bookmark cards only (legacy-ish view).
      function renderFallback(innerH, Y) {
        const items = [];
        for (const bm of bms) {
          const p = axis.pos(bm.mode === 'read'
            ? { k: 'read', jpOff: bm.location && bm.location.jpOff }
            : { k: 'card', cardIndex: bm.location && bm.location.cardIndex });
          if (p === null || !Number.isFinite(p)) continue;
          items.push({ bm, anchor: Y(p) });
        }
        items.sort((a, b) => a.anchor - b.anchor);
        let cursor = 0;
        for (const it of items) {
          const top = Math.max(it.anchor, cursor);
          const card = document.createElement('div');
          card.className = 'menu-item';
          card.style.cssText =
            'position:absolute;left:' + COL_X + 'px;right:10px;top:' + top + 'px;' +
            'background:#16161d;border:1px solid #26262e;border-left:3px solid #caa84a;' +
            'border-radius:8px;padding:7px 10px;cursor:pointer;';
          card.innerHTML =
            '<div style="font-size:.74rem;color:#caa84a;">◆ ' +
            esc(it.bm.mode === 'read' ? window.i18n.t('tl.read_bookmark', 'Read bookmark') : window.i18n.t('tl.card_bookmark', 'Card bookmark')) + '</div>' +
            '<div style="color:#8a7c4e;font-size:.64rem;margin-top:1px;">' +
            hm(it.bm.ts) + ' · ' + esc(window.i18n.t('tl.tap_to_jump', 'tap to jump')) + '</div>';
          card.addEventListener('click', (e) => {
            e.stopPropagation();
            destroy();
            try { window.bookmarks.jumpTo(it.bm); } catch (_) {}
          });
          inner.appendChild(card);
          cursor = top + (card.offsetHeight || 40) + 6;
        }
        if (!items.length && !segs.length) {
          const empty = document.createElement('div');
          empty.style.cssText =
            'position:absolute;left:' + COL_X + 'px;right:10px;top:14px;color:#666;' +
            'font-size:.78rem;line-height:1.5;';
          empty.textContent = window.i18n.t('tl.empty_help',
            'Reading sessions paint the spine as you read and listen. ' +
            'Chapter cards appear once the book has been processed (AI assistant).');
          inner.appendChild(empty);
        }
        return cursor;
      }

      // ---- Chapter LIST (redesign) -------------------------------------------------
      // A flat, scrollable list — one row per chapter (number + start-char + title +
      // 1-line summary + 新着/✦ scene badge + jump). Tap → the chapter card (which
      // holds the scene images). No proportional spine / pinch-zoom (those clipped
      // text + were awkward); the char-count is printed per row instead of as a scale.
      let _curRowEl = null;
      // Decorative whole-book coverage axis (left column) — modality-colored,
      // proportional to total book length, with a current-position marker. Pure
      // decoration (the list itself is not to scale).
      function renderAxis() {
        try {
          axisCol.innerHTML = '';
          // drop prior markers from the unclipped wrap (keep axisCol intact)
          try { Array.prototype.forEach.call(axisWrap.querySelectorAll('.kai-axis-marker'), n => n.remove()); } catch (_) {}
          _nowMarkerEl = null;
          const total = (axis && axis.total) || 0;
          if (!total) return;
          const pcv = (v) => (Math.max(0, Math.min(total, v)) / total) * 100;
          const collapse = (arr) => {   // collapse sub-pixel neighbors (axis is only ~panel-tall)
            let ss = arr || [];
            if (ss.length > 300) {
              const merged = []; const minC = total / 300;
              for (const sg of ss) { const last = merged[merged.length - 1]; if (last && (sg.c1 - sg.c0) < minC && (sg.c0 - last.c1) < minC) last.c1 = sg.c1; else merged.push({ c0: sg.c0, c1: sg.c1, mode: sg.mode }); }
              ss = merged;
            }
            return ss;
          };
          for (const sg of collapse(segs)) {
            const d = document.createElement('div');
            d.style.cssText = 'position:absolute;left:0;right:0;top:' + pcv(sg.c0).toFixed(2) + '%;height:' + Math.max(0.4, pcv(sg.c1) - pcv(sg.c0)).toFixed(2) + '%;background:' + (COLORS[sg.mode] || COLORS.audio) + ';opacity:.95;';
            axisCol.appendChild(d);
          }
          // second track: re-visited (re-read/re-listened) ranges as clean solid
          // marks colored by the re-visit modality. A min height keeps a short
          // re-visit a readable dash instead of a stray speck. Hidden when empty.
          if (revisitCol) {
            revisitCol.innerHTML = '';
            const rr = collapse(rsegs);
            revisitCol.style.display = (rr && rr.length) ? 'block' : 'none';
            for (const sg of rr) {
              const col = COLORS[sg.mode] || COLORS.audio;
              const d = document.createElement('div');
              d.style.cssText = 'position:absolute;left:0;right:0;top:' + pcv(sg.c0).toFixed(2) + '%;height:' + Math.max(1.2, pcv(sg.c1) - pcv(sg.c0)).toFixed(2) + '%;border-radius:2px;background:' + col + ';opacity:.92;';
              revisitCol.appendChild(d);
            }
          }
          const curP = currentAxisPos(axis);
          // faint furthest-reached tick — only when current is meaningfully behind
          // it, so the user can SEE current place ≠ furthest place.
          let furthestP = null;
          try {
            const f = (map && map.furthest) || {};
            if (axis.useJp && Number.isFinite(f.jp)) furthestP = f.jp;
            else if (Number.isFinite(f.cue)) furthestP = axis.cueToChars(f.cue);
          } catch (_) {}
          if (furthestP !== null && Number.isFinite(furthestP) &&
              (curP === null || furthestP > curP + total * 0.01)) {
            const ft = document.createElement('div');
            ft.className = 'kai-axis-marker';
            ft.style.cssText = 'position:absolute;left:-2px;right:-2px;top:calc(' + pcv(furthestP).toFixed(2) + '% - 0.5px);height:1px;background:rgba(255,255,255,.38);z-index:3;pointer-events:none;';
            axisWrap.appendChild(ft);
          }
          // live, glowing current-place marker (line + center ball); spills past the
          // 6px column because axisWrap is unclipped. Repositioned live by _posTimer.
          if (curP !== null && Number.isFinite(curP)) {
            const wrap = document.createElement('div');
            wrap.className = 'kai-axis-marker kai-now-mark';
            wrap.style.cssText = 'position:absolute;left:-4px;right:-4px;top:calc(' + pcv(curP).toFixed(2) + '% - 1.5px);height:3px;border-radius:2px;background:#fff;z-index:5;pointer-events:none;';
            const ball = document.createElement('div');
            ball.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:9px;height:9px;border-radius:50%;background:#fff;';
            wrap.appendChild(ball);
            axisWrap.appendChild(wrap);
            _nowMarkerEl = wrap;
          }
        } catch (_) {}
      }
      function buildChapterRow(ch, art, complete, prog, onTap, isCur, pos) {
        const idx = ch.idx;
        const state = ch.state || 'none';
        const unread = !complete && !art && state === 'none';
        const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
        const stat = _sceneStat[idx] || null;
        const row = document.createElement('div');
        row.className = 'menu-item';
        row.style.cssText =
          'position:relative;margin:0 0 8px;padding:11px 13px;border-radius:10px;box-sizing:border-box;' +
          'background:' + (isCur ? '#1c1830' : '#16161d') + ';' +
          'border:1px solid ' + (isCur ? '#5a4f8c' : '#26262e') + ';' +
          'touch-action:pan-y;' + (onTap ? 'cursor:pointer;' : '') + (unread ? 'opacity:.6;' : '');
        // meta line (wraps so the current-chapter summary button never overflows)
        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:3px;';
        const num = document.createElement('span');
        num.style.cssText = 'flex:none;color:' + (art && complete ? '#a594e6' : '#888') + ';font-size:.74rem;font-weight:700;';
        num.textContent = window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
        meta.appendChild(num);
        const cc = document.createElement('span');
        cc.style.cssText = 'flex:1;min-width:0;color:#6a6a76;font-size:.68rem;';
        cc.textContent = window.i18n.fmt('tl.chars_from', { n: (Number.isFinite(ch.jpStart) ? ch.jpStart.toLocaleString() : '0') }, (Number.isFinite(ch.jpStart) ? ch.jpStart.toLocaleString() : '0') + '字〜');
        meta.appendChild(cc);
        if (isCur) {
          const now = document.createElement('span');
          now.style.cssText = 'flex:none;background:#2a2440;border:1px solid #5a4f8c;color:#cbbfee;font-size:.62rem;padding:1px 7px;border-radius:8px;';
          now.textContent = window.i18n.t('tl.now', 'いま');
          meta.appendChild(now);
        }
        if (stat && stat.images > 0) {
          const b = document.createElement('span');
          b.style.cssText = 'flex:none;color:#c8a23a;font-size:.82rem;line-height:1;';
          b.textContent = '✦';
          meta.appendChild(b);
        }
        const jb = document.createElement('button');
        jb.textContent = '➤';
        jb.title = window.i18n.t('tl.go_to_chapter', 'Go to this chapter in the book');
        jb.style.cssText = 'flex:none;background:none;border:1px solid #3a3450;border-radius:7px;color:#aab4dd;font-size:.78rem;padding:2px 9px;cursor:pointer;line-height:1.2;';
        jb.addEventListener('click', (e) => { e.stopPropagation(); jumpToChapter(ch); });
        meta.appendChild(jb);
        // CURRENT (partially-read) chapter: summarize from its start to the reading
        // position — sends just the read portion to Claude (spoiler-safe).
        if (isCur && Number.isFinite(pos) && window.aiSummary && window.aiSummary.summarizeRange) {
          const sumBtn = document.createElement('button');
          sumBtn.textContent = window.i18n.t('tl.summarize_to_here', 'ここまで要約');
          sumBtn.title = window.i18n.t('tl.summarize_to_here_title', 'Summarize this chapter up to your current position');
          sumBtn.style.cssText = 'flex:none;background:#191425;border:1px solid #463a6b;border-radius:7px;color:#d6c8ff;font-size:.68rem;padding:2px 9px;cursor:pointer;line-height:1.2;';
          sumBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            destroy();
            const space = (map && map.space === 'cue') ? 'cue' : 'jp';
            const a = (space === 'cue') ? (Number.isFinite(ch.cueStart) ? ch.cueStart : 0) : (ch.jpStart || 0);
            try { window.aiSummary.summarizeRange({ space, a, b: pos, mode: 'read' }); } catch (_) {}
          });
          meta.appendChild(sumBtn);
        }
        row.appendChild(meta);
        // title
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:700;font-size:1.08rem;line-height:1.3;color:' + (unread ? '#aaa' : '#f0f0f0') + ';';
        titleEl.textContent = label;
        row.appendChild(titleEl);
        // 1-line (2-clamped) summary / state
        let sc = '#b0b0b8', stext = '';
        if (art && art.shortSummary) { stext = art.shortSummary; }
        else if (state === 'processing') { stext = window.i18n.t('tl.creating_ai_summary', 'AI要約を作成中…'); sc = '#cbbfee'; }
        else if (state === 'queued') { stext = window.i18n.t('tl.queued_waiting', '待機中…'); sc = '#888'; }
        else if (state === 'failed') {
          // Surface WHY it failed (the request path captures it on the chunk) so a
          // transient API hiccup (rate limit / overload / network) reads clearly
          // instead of a bare "失敗". These are almost always retryable.
          const er = (ch && ch.error) ? String(ch.error) : '';
          let why = '';
          if (/\b429\b|rate.?limit/i.test(er)) why = window.i18n.t('tl.fail_rate_limit', '混雑（429）');
          else if (/\b529\b|overload/i.test(er)) why = window.i18n.t('tl.fail_overload', 'サーバー混雑');
          else if (/network|connection|timeout|timed out/i.test(er)) why = window.i18n.t('tl.fail_network', '接続エラー');
          else if (/\b401\b|api key/i.test(er)) why = window.i18n.t('tl.fail_api_key', 'APIキー要確認');
          else if (/credit|billing|quota|insufficient|balance/i.test(er)) why = window.i18n.t('tl.fail_credit', 'クレジット不足');
          else if (/refus/i.test(er)) why = window.i18n.t('tl.fail_refused', 'モデルが拒否');
          else if (er) why = er.slice(0, 36);
          stext = why ? window.i18n.fmt('tl.failed_reason_tap_retry', { why: why }, '失敗（' + why + '）— タップで再試行') : window.i18n.t('tl.failed_tap_retry', '失敗 — タップで再試行');
          sc = '#e08a8a';
        }
        else if (complete) { stext = window.i18n.t('tl.tap_to_generate', 'タップして要約を生成'); sc = '#8a7fb8'; }
        else { stext = (prog.pct > 0.02 ? window.i18n.fmt('tl.pct_read', { n: Math.round(prog.pct * 100) }, Math.round(prog.pct * 100) + '% 読了') : window.i18n.t('tl.unread', '未読')); sc = '#666'; }
        const sub = document.createElement('div');
        sub.style.cssText = 'margin-top:3px;font-size:.86rem;line-height:1.45;color:' + sc + ';' +
          'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
        sub.textContent = stext;
        row.appendChild(sub);
        // chapter progress bar — coverage within [jpStart,jpEnd], colored by modality
        if (prog && prog.pct > 0) {
          const bar = document.createElement('div');
          bar.style.cssText = 'margin-top:7px;height:3px;background:#26262e;border-radius:2px;overflow:hidden;position:relative;';
          const a = ch.jpStart, b = ch.jpEnd;
          const len = (Number.isFinite(a) && Number.isFinite(b) && b > a) ? (b - a) : 0;
          const pieces = len > 0 ? barSegments(segs, a, b) : [];
          if (pieces.length) {
            for (const pcs of pieces) {
              const d = document.createElement('div');
              d.style.cssText = 'position:absolute;top:0;bottom:0;left:' + (((pcs[0] - a) / len) * 100).toFixed(2) + '%;width:' + (((pcs[1] - pcs[0]) / len) * 100).toFixed(2) + '%;background:' + (COLORS[pcs[2]] || '#555') + ';';
              bar.appendChild(d);
            }
          } else {
            const fill = document.createElement('div');
            fill.style.cssText = 'height:100%;width:' + Math.round(prog.pct * 100) + '%;border-radius:2px;background:#3a3a46;';
            bar.appendChild(fill);
          }
          row.appendChild(bar);
        }
        // ---- scenes (Instagram-style feed under the chapter summary) ----------------
        // Each Claude-authored scene = a 1-line description + a tiny thumbnail (if an
        // image exists) or a 生成 badge; tap → the dedicated scene card. Chapter
        // description stays ABOVE — same layout as before, just inlined here.
        const scenes = (art && Array.isArray(art.scenes)) ? art.scenes : [];
        if (scenes.length) {
          const sceneBox = document.createElement('div');
          sceneBox.style.cssText = 'margin-top:9px;display:flex;flex-direction:column;gap:6px;';
          scenes.forEach((scn, s) => {
            const sCharId = 'scene_' + idx + '_' + s;
            const sst = _sceneSlotStat[sCharId] || null;
            const has = !!(sst && sst.images > 0);
            const pending = !!(sst && sst.pending > 0);
            const sr = document.createElement('div');
            sr.style.cssText = 'display:flex;align-items:center;gap:9px;padding:6px;border-radius:8px;background:#13131a;border:1px solid #20202c;touch-action:pan-y;cursor:pointer;';
            const thumb = document.createElement('div');
            thumb.style.cssText = 'flex:none;width:46px;height:46px;border-radius:7px;overflow:hidden;background:#0c0c12;display:flex;align-items:center;justify-content:center;font-size:.58rem;text-align:center;line-height:1.2;';
            if (has) {
              const im = document.createElement('img');
              im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
              thumb.appendChild(im);
              (async () => { try { const rows = await window.aiImages.getImages(titleId, sCharId); if (rows && rows.length) im.src = rows[rows.length - 1].dataUri; } catch (_) {} })();
            } else {
              thumb.style.border = '1px dashed #463a6b'; thumb.style.color = '#9b8fd0';
              thumb.textContent = pending ? window.i18n.t('tl.generating', '生成中') : window.i18n.t('common.generate', '生成');
            }
            sr.appendChild(thumb);
            const desc = document.createElement('div');
            desc.style.cssText = 'flex:1;min-width:0;font-size:.82rem;line-height:1.4;color:#cdd;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
            desc.textContent = scn.caption || scn.title || window.i18n.fmt('tl.scene_n', { n: s + 1 }, 'シーン ' + (s + 1));
            sr.appendChild(desc);
            sr.addEventListener('click', (e) => { e.stopPropagation(); destroy(); openSceneCard(titleId, ch, art, s, () => { try { openPanel(); } catch (_) {} }); });
            sceneBox.appendChild(sr);
          });
          row.appendChild(sceneBox);
        } else if (art && complete && window.aiProcessor && window.aiProcessor.generateSceneIdeas) {
          // Chapter summarized before scenes existed → offer to author them.
          const mk = document.createElement('button');
          mk.textContent = window.i18n.t('tl.create_scenes', '＋ シーンを作る');
          mk.style.cssText = 'margin-top:9px;align-self:flex-start;background:#1a1622;border:1px solid #3a3450;border-radius:8px;color:#b9a9e0;font-size:.74rem;padding:6px 12px;cursor:pointer;';
          mk.addEventListener('click', async (e) => {
            e.stopPropagation(); mk.disabled = true; mk.textContent = window.i18n.t('tl.thinking', '考え中…');
            try { const r = await window.aiProcessor.generateSceneIdeas(titleId, idx); if (r && r.ok) scheduleRefresh(60); else { mk.disabled = false; mk.textContent = (r && r.reason === 'ai-off') ? window.i18n.t('tl.enable_ai_short', 'AIを有効に') : window.i18n.t('tl.failed_retry', '失敗 — 再試行'); } }
            catch (_) { mk.disabled = false; mk.textContent = window.i18n.t('tl.error_retry', 'エラー — 再試行'); }
          });
          row.appendChild(mk);
        }
        if (onTap) row.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
        return row;
      }

      function render() {
        inner.style.position = 'static';
        inner.style.height = 'auto';
        inner.style.padding = '12px 12px 6px';
        inner.innerHTML = '';
        _curRowEl = null;
        const chapters = (map && Array.isArray(map.chunks)) ? map.chunks : null;
        if (!chapters || !chapters.length) {
          const m = document.createElement('div');
          m.style.cssText = 'color:#888;font-size:.9rem;text-align:center;padding:34px 16px;line-height:1.7;';
          m.textContent = window.i18n.t('tl.no_chapters_yet', 'チャプターはまだありません。読み進めると章ごとのカードが表示されます。');
          inner.appendChild(m);
          renderAxis();
          return;
        }
        const furthestJp = (map.furthest && Number.isFinite(map.furthest.jp)) ? map.furthest.jp : null;
        const curP = currentAxisPos(axis);
        const pos = (curP !== null && Number.isFinite(curP)) ? curP : (furthestJp || 0);
        let curIdx = -1;
        for (const ch of chapters) {
          const a = ch.jpStart || 0, b = Number.isFinite(ch.jpEnd) ? ch.jpEnd : Infinity;
          if (pos >= a && pos < b) { curIdx = ch.idx; break; }
        }
        for (const ch of chapters) {
          const idx = ch.idx;
          const art = arts ? (arts[idx] || null) : null;
          const complete = chapterComplete(map, ch);
          const prog = chapterProgress(ch, segs, furthestJp);
          const onTap = makeChapterTap(ch, art, complete);
          const row = buildChapterRow(ch, art, complete, prog, onTap, idx === curIdx, pos);
          inner.appendChild(row);
          if (idx === curIdx) _curRowEl = row;
        }
        renderAxis();
      }

      const footBtnCss = (bg, bd, col) =>
        'display:block;width:100%;text-align:center;border-radius:8px;padding:9px 12px;cursor:pointer;' +
        'background:' + bg + ';border:1px solid ' + bd + ';color:' + col + ';font-size:.85rem;';

      async function renderFoot() {
        try {
          foot.innerHTML = '';
          const aiOn = !!(window.ai && window.ai.isEnabled && window.ai.isEnabled());

          // manual catch-up (incl. failed retries) with ~$ estimate
          if (aiOn && window.aiProcessor && typeof window.aiProcessor.updateNow === 'function') {
            let usd = 0, count = 0;
            try {
              const o = (typeof window.aiProcessor.owedEstimate === 'function')
                ? await window.aiProcessor.owedEstimate(titleId) : null;
              if (typeof o === 'number') usd = o;
              else if (o) {
                usd = Number(o.usd != null ? o.usd : (o.costUsd != null ? o.costUsd : o.est)) || 0;
                count = Number(o.count != null ? o.count : o.chunks) || 0;
              }
            } catch (_) {}
            if (usd > 0 || count > 0) {
              const b = document.createElement('button');
              b.className = 'menu-item';
              b.style.cssText = footBtnCss('#191425', '#463a6b', '#d6c8ff');
              b.textContent = window.i18n.t('tl.update_timeline', 'タイムラインを更新') +
                (count ? (' · ' + window.i18n.fmt('tl.chapters_count', { n: count }, count + '章')) : '') +
                (usd >= 0.01 ? (' · ~$' + usd.toFixed(2)) : '');
              b.addEventListener('click', (e) => {
                e.stopPropagation();
                b.disabled = true;
                b.textContent = window.i18n.t('tl.processing', '処理中…');
                b.style.color = '#888';
                offerProcess();
              });
              foot.appendChild(b);
            } else {
              // surface in-flight processing so the pulse nodes make sense
              let st = null;
              try {
                st = (typeof window.aiProcessor.status === 'function')
                  ? await window.aiProcessor.status(titleId) : null;
              } catch (_) {}
              const busy = !!(st && (Number.isFinite(st.inflightIdx) ||
                                     (st.counts && st.counts.processing > 0)));
              if (busy) {
                // 0-based chunk idx → 1-based chapter number; fall back to the
                // first 'processing' chunk when the inflight idx isn't local.
                let n = Number.isFinite(st.inflightIdx) ? (st.inflightIdx + 1) : null;
                if (n === null && Array.isArray(st.chunks)) {
                  const pc = st.chunks.find(c => c && c.state === 'processing');
                  if (pc && Number.isFinite(pc.idx)) n = pc.idx + 1;
                }
                const done = (st.counts && Number.isFinite(st.counts.ready)) ? st.counts.ready : 0;
                const total = Number.isFinite(st.total) ? st.total : 0;
                ensureKaiSpinStyle();
                const s = document.createElement('div');
                s.style.cssText =
                  'display:flex;align-items:center;justify-content:center;gap:2px;' +
                  'color:#8a7fb8;font-size:.72rem;';
                const ring = document.createElement('span');
                ring.className = 'kai-spin';
                ring.style.marginLeft = '0';
                const txt = document.createElement('span');
                txt.style.marginLeft = '6px';
                txt.textContent = (n !== null ? window.i18n.fmt('tl.processing_chapter', { n: n }, '第' + n + '章を処理中…') : window.i18n.t('tl.processing', '処理中…')) +
                  (total ? (' (' + done + '/' + total + ')') : '');
                s.appendChild(ring);
                s.appendChild(txt);
                foot.appendChild(s);
              }
            }
          }

          // Re-detect chapters from the book's own chapter numbers whenever the
          // book HAS markers (≥3). Available even when the map is already
          // marker-based: marker detection itself gets corrected over time (e.g.
          // rejecting a colophon year that became "第2007章"), so a stale
          // marker map can still be rebuilt. It's opt-in with a cost confirm.
          try {
            if (aiOn && window.aiProcessor && typeof window.aiProcessor.reDetectChapters === 'function' &&
                window.aiChunks && typeof window.aiChunks.markerCount === 'function' &&
                window.aiChunks.markerCount(titleId) >= 3) {
              const rb = document.createElement('button');
              rb.className = 'menu-item';
              rb.style.cssText = footBtnCss('#1a1622', '#3a3450', '#a99fc8');
              rb.textContent = window.i18n.t('tl.redetect_chapters', '章を再検出（本の章番号に合わせる）');
              rb.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  // keep the panel open — it live-refreshes from the new map via
                  // the emitDataChanged the processor fires.
                  await window.aiProcessor.reDetectChapters(titleId);
                  scheduleRefresh(200);
                } catch (_) {}
              });
              foot.appendChild(rb);
            }
          } catch (_) {}

          if (aiOn && window.aiSummary) {
            const btn = document.createElement('button');
            btn.className = 'menu-item kai-glow';
            btn.style.cssText = footBtnCss('#191425', '#463a6b', '#d6c8ff');
            btn.textContent = window.i18n.t('tl.ai_summary_session', '✦ AI summary — this session');
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              destroy();
              try { window.aiSummary.summarizeRecent(); } catch (_) {}
            });
            foot.appendChild(btn);
          }
        } catch (_) {}
      }

      function scheduleRefresh(delayMs) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
          refreshTimer = null;
          try {
            if (!document.body.contains(overlay)) return;
            const m2 = await getMapSafe(titleId);
            if (m2) {
              map = m2;
              const ax2 = buildMapAxis(m2);
              if (ax2) axis = ax2;
            }
            arts = map ? filterArtifacts(await loadArtifacts(titleId), map) : {};
            segs = await coverageSegments(titleId, axis);
            rsegs = await revisitSegments(titleId, axis);
            try {
              if (window.bookmarks && window.bookmarks.list) {
                bms = window.bookmarks.list().filter(b => b.titleId === titleId);
              }
            } catch (_) {}
            try {
              if (window.aiSummary && window.aiSummary.listSaved) {
                saved = await window.aiSummary.listSaved(titleId);
              }
            } catch (_) {}
            render();
            renderFoot();
            try {
              if (window.ai && typeof window.ai.markSeen === 'function') window.ai.markSeen(titleId, 'timeline');
            } catch (_) {}
          } catch (_) {}
        }, delayMs || 250);
      }

      function onData(e) {
        try {
          if (!document.body.contains(overlay)) {
            window.removeEventListener('kai:ai-data', onData);
            window.removeEventListener('kai:scenes-changed', onData);
            return;
          }
          const d = e && e.detail;
          if (d && d.titleId && d.titleId !== titleId) return;
          scheduleRefresh(250);
        } catch (_) {}
      }
      window.addEventListener('kai:ai-data', onData);
      window.addEventListener('kai:scenes-changed', onData);   // auto-scene unlock/defer badges
      window.addEventListener('kai:img-data', refreshSceneHave);   // a scene rendered → re-mark which chapters have ✦
      refreshSceneHave();   // initial: mark chapters that already have scenes

      // Processing-status broadcasts refresh just the footer (the spine /
      // cards refresh via 'kai:ai-data' when results land).
      function onProc(e) {
        try {
          if (!document.body.contains(overlay)) {
            window.removeEventListener('kai:proc-status', onProc);
            return;
          }
          const d = e && e.detail;
          if (d && d.titleId && d.titleId !== titleId) return;
          renderFoot();
        } catch (_) {}
      }
      window.addEventListener('kai:proc-status', onProc);

      // Open: render the chapter list, scroll to the current chapter, and PULL any
      // finished scene renders from the server. (The panel never synced before, so a
      // scene that finished server-side "never appeared" — this is the ingest fix.)
      requestAnimationFrame(() => {
        try {
          render();
          renderFoot();
          if (_curRowEl && typeof _curRowEl.scrollIntoView === 'function') _curRowEl.scrollIntoView({ block: 'center' });
        } catch (_) {}
      });
      // once on open: submit/reconcile (sync), THEN a full no-`since` catch-up so
      // previously-generated scenes (older than lastSyncAt, or whose local record a
      // reinstall wiped) are refetched and appear.
      try {
        if (window.aiImages && window.aiImages.sync) {
          window.aiImages.sync(titleId)
            .then(() => window.aiImages.refetchDone && window.aiImages.refetchDone(titleId))
            .catch(() => {});
        } else if (window.aiImages && window.aiImages.refetchDone) {
          window.aiImages.refetchDone(titleId);
        }
      } catch (_) {}
      // while open: keep pulling finished renders. Self-terminates if the panel was
      // replaced via prev.remove() (which doesn't call destroy()), so it can't leak.
      _imgPoll = setInterval(() => {
        if (!document.body.contains(overlay)) { clearInterval(_imgPoll); _imgPoll = null; return; }
        try { window.aiImages && window.aiImages.pollPending && window.aiImages.pollPending(titleId); } catch (_) {}
      }, 9000);
      // while open: keep the glowing current-place marker tracking the live position
      // (audio playhead / read frontier). Cheap — it moves ONE element, no re-render.
      _posTimer = setInterval(() => {
        try {
          if (!document.body.contains(overlay)) { clearInterval(_posTimer); _posTimer = null; return; }
          if (document.hidden || !_nowMarkerEl) return;
          const total = (axis && axis.total) || 0;
          if (!total) return;
          const p = currentAxisPos(axis);
          if (p === null || !Number.isFinite(p)) return;
          const pct = (Math.max(0, Math.min(total, p)) / total) * 100;
          _nowMarkerEl.style.top = 'calc(' + pct.toFixed(2) + '% - 1.5px)';
        } catch (_) {}
      }, 800);

      return true;
    } catch (e) {
      try { console.log('[ai-timeline] openPanel failed: ' + (e && e.message)); } catch (_) {}
      return false;
    }
  }

  window.aiTimeline = {
    openPanel,
    openChapter,
    // ai-characters-screen.js calls openChapterView(idx) with no titleId;
    // openChapter defaults a null titleId to window._activeTitleId.
    openChapterView: (idx) => openChapter(null, idx),
  };
})();
