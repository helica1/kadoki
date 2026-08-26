// ai-timeline.js — Dynamic Timeline v3: one continuous scrollable feed.
//
// The panel is a single scroller: every summarized chapter renders as a feed
// section — chapter header, the FULL summary text (dict-tappable), and its
// scene images inline at full width. Nothing opens a separate window from the
// feed; tapping a scene image stacks the scene card OVER the still-open panel
// (Anki send / trim / regenerate live there), so closing it never rebuilds or
// re-scrolls the list. Unsummarized chapters stay compact rows (processing /
// queued / failed / tap-to-generate). A chapter is marked read by SCROLLING
// past it (sentinel + IntersectionObserver), not by opening anything.
// LEFT: a thin decorative coverage axis (green read / orange card / purple
// audio) with a live glowing current-place marker.
// The subtler chapter analysis (主な出来事, key passages, character chips)
// stays out of the feed for now — #kchapterView still renders it for the
// Characters-screen deep link.
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
  // Panel-level CSS for the pictures show/hide toggle: frames vanish, captions
  // and quotes stay (the "captions only" mode).
  function ensureTlPicsStyle() {
    if (document.getElementById('kaiTlPicsStyle')) return;
    const st = document.createElement('style');
    st.id = 'kaiTlPicsStyle';
    st.textContent = '#bookmarksOverlay.tl-nopics .tl-imgframe{display:none !important;}' +
      '#bookmarksOverlay.tl-nopics .tl-legacyfig{display:none !important;}';   // legacy figs have no standalone caption
    document.head.appendChild(st);
  }
  function ensureAxisMarkerStyle() {
    if (document.getElementById('kaiAxisMarkStyle')) return;
    try {
      const st = document.createElement('style');
      st.id = 'kaiAxisMarkStyle';
      st.textContent =
        // Pulse via opacity+transform (both GPU-composited) on a glow layer whose
        // box-shadow is rasterized ONCE — animating box-shadow itself forced a
        // per-frame main-thread repaint that made the whole timeline scroll janky.
        '@keyframes kaiNowGlow{0%,100%{opacity:.5;transform:translate(-50%,-50%) scale(.82);}' +
        '50%{opacity:1;transform:translate(-50%,-50%) scale(1);}}' +
        '.kai-now-glow{box-shadow:0 0 9px 3px rgba(255,255,255,.9),0 0 18px 5px rgba(255,255,255,.4);' +
        'animation:kaiNowGlow 1.8s ease-in-out infinite;will-change:opacity,transform;}';
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

  // H:MM:SS (or M:SS) for the time axis.
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? (h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'))
                 : (m + ':' + String(ss).padStart(2, '0'));
  }

  // ---- axis ---------------------------------------------------------------
  // ms → axis-chars via the raw cue-text cumulative scale, binary-searched
  // over cues[].startMs (cues are chronological) then linearly interpolated
  // — the ms equivalent of the idx-indexed cueCum lookup below. Shared by
  // both the jp-map axis's fallback and the probe axis.
  function msCumLookup(cues, cueCum, cueScale, ms) {
    if (!cueCum || !Array.isArray(cues) || !cues.length || !Number.isFinite(ms)) return null;
    const n = cues.length;
    const m0start = cues[0].startMs || 0, mLstart = cues[n - 1].startMs || 0;
    if (ms <= m0start) return cueCum[0] * cueScale;
    if (ms >= mLstart) return cueCum[n] * cueScale;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((cues[mid].startMs || 0) <= ms) lo = mid; else hi = mid - 1;
    }
    const i0 = lo, i1 = Math.min(n - 1, lo + 1);
    const m0 = cues[i0].startMs || 0, m1 = cues[i1].startMs || 0;
    const c0 = cueCum[i0], c1 = cueCum[i1];
    const frac = (m1 > m0) ? (ms - m0) / (m1 - m0) : 0;
    return (c0 + frac * (c1 - c0)) * cueScale;
  }

  // Map axis: total = chunk-map totals.jp; cue→jp is piecewise-linear per
  // chunk through the (cueStart,jpStart)→(cueEnd+1,jpEnd) anchor pairs.
  function buildMapAxis(map) {
    // STRICTLY TIME-BASED axis for audio-anchored cue maps (auto-transcribed
    // audiobooks; chunks carry msStart). Their jp totals only cover what has
    // been transcribed so far, so a char scale reads near-complete minutes
    // into the book and every future chapter shows the same start offset.
    const tCues = window._srtCues;
    if (map.space === 'cue' && map.chunks.length && Number.isFinite(map.chunks[0].msStart) &&
        Array.isArray(tCues) && tCues.length && Number.isFinite(tCues[0].startMs)) {
      const lastCh = map.chunks[map.chunks.length - 1];
      const lastCueEnd = tCues[tCues.length - 1].endMs || 0;
      let durMs = (Number.isFinite(map.durMs) && map.durMs > 0) ? map.durMs : 0;
      if (!durMs) durMs = Math.max(lastCueEnd, (lastCh.msStart || 0) + 60000);
      const chunks = map.chunks;
      return {
        total: durMs, useJp: false, isTime: true, cueCum: null, canMapCues: true,
        chStart(ch) { return Number.isFinite(ch.msStart) ? ch.msStart : 0; },
        chEnd(ch) {
          const i = chunks.indexOf(ch);
          const nx = chunks[i + 1];
          return (nx && Number.isFinite(nx.msStart)) ? nx.msStart : durMs;
        },
        cueToChars(idx) {   // axis units are MILLISECONDS on this axis
          const cues = window._srtCues;
          if (!Number.isFinite(idx) || !Array.isArray(cues) || !cues.length) return null;
          if (idx >= cues.length) return cues[cues.length - 1].endMs || durMs;
          return cues[Math.max(0, idx)].startMs;
        },
        msToChars(ms) {   // this axis's native unit already IS ms — identity
          if (!Number.isFinite(ms)) return null;
          return Math.max(0, Math.min(durMs, ms));
        },
        pos(p) {
          if (!p) return null;
          if (p.k === 'read') return null;
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
          if (space === 'jp') return null;
          const r0 = this.cueToChars(a), r1 = this.cueToChars(b + 1);
          return (r0 !== null && r1 !== null) ? [r0, r1] : null;
        },
      };
    }
    const total = map.totals.jp;
    const cues = window._srtCues;
    const an = [], anMs = [];
    for (const ch of map.chunks) {
      if (Number.isFinite(ch.cueStart) && ch.cueStart >= 0 &&
          Number.isFinite(ch.cueEnd) && ch.cueEnd >= ch.cueStart &&
          Number.isFinite(ch.jpStart) && Number.isFinite(ch.jpEnd)) {
        an.push([ch.cueStart, ch.jpStart], [ch.cueEnd + 1, ch.jpEnd]);
        // ms-anchors mirror the SAME chunk boundaries, keyed by the live cue
        // list's own startMs — a physical quantity, so this stays correct
        // even after the cue list is later regenerated (unlike a raw index).
        if (Array.isArray(cues) && cues.length) {
          const i0 = Math.min(ch.cueStart, cues.length - 1);
          const i1 = Math.min(ch.cueEnd + 1, cues.length - 1);
          const m0 = cues[i0] && cues[i0].startMs, m1 = cues[i1] && cues[i1].startMs;
          if (Number.isFinite(m0)) anMs.push([m0, ch.jpStart]);
          if (Number.isFinite(m1)) anMs.push([m1, ch.jpEnd]);
        }
      }
    }
    an.sort((a, b) => a[0] - b[0]);
    const anchors = [];
    for (const a of an) {
      const last = anchors[anchors.length - 1];
      if (last && (a[0] <= last[0] || a[1] < last[1])) continue;   // keep monotonic
      anchors.push(a);
    }
    anMs.sort((a, b) => a[0] - b[0]);
    const anchorsMs = [];
    for (const a of anMs) {
      const last = anchorsMs[anchorsMs.length - 1];
      if (last && (a[0] <= last[0] || a[1] < last[1])) continue;   // keep monotonic
      anchorsMs.push(a);
    }
    // raw cue-text scale as the fallback when no chunk carries cue bounds
    let cueCum = null, cueTotal = 0;
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
      // false when NEITHER chunk cue-anchors nor a live cue list exist — a
      // transient state while transcription churns; such an axis drops every
      // audio coverage segment, so refreshes must not adopt it over a good one
      canMapCues: (anchors.length >= 2 || !!cueCum),
      chStart(ch) { return ch.jpStart || 0; },
      chEnd(ch) { return Number.isFinite(ch.jpEnd) ? ch.jpEnd : (ch.jpStart || 0); },
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
      msToChars(ms) {
        if (!Number.isFinite(ms)) return null;
        if (anchorsMs.length >= 2) {
          const A = anchorsMs;
          if (ms <= A[0][0]) return A[0][0] > 0 ? (ms / A[0][0]) * A[0][1] : A[0][1];
          const last = A[A.length - 1];
          if (ms >= last[0]) return last[1];
          for (let i = 1; i < A.length; i++) {
            if (ms <= A[i][0]) {
              const m0 = A[i - 1][0], j0 = A[i - 1][1];
              const m1 = A[i][0], j1 = A[i][1];
              return m1 > m0 ? j0 + ((ms - m0) / (m1 - m0)) * (j1 - j0) : j0;
            }
          }
          return last[1];
        }
        return msCumLookup(cues, cueCum, cueScale, ms);
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
      msToChars(ms) { return msCumLookup(cues, cueCum, cueScale, ms); },
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

  // ms is the modern, cue-list-generation-agnostic space; cue is a legacy
  // fallback still written for titles where ms can't be resolved (deck-card
  // titles with no linked audio timeline) — both can hold real data at once,
  // so both always render, never either/or.
  async function coverageSegments(titleId, axis) {
    try {
      if (!window.modeCoverage || typeof window.modeCoverage.get !== 'function') return [];
      const cov = await window.modeCoverage.get(titleId);
      if (!cov) return [];
      const segs = [];
      let msDropped = 0, msUsed = 0, cueUsed = 0;
      if (typeof axis.msToChars === 'function') {
        for (const iv of (cov.ms || [])) {
          if (!Array.isArray(iv)) continue;
          const c0 = axis.msToChars(iv[0]), c1 = axis.msToChars(iv[1]);
          if (c0 !== null && c1 !== null && c1 > c0) { covInsert(segs, c0, c1, MODE_NAME[iv[2]] || 'audio'); msUsed++; }
          else msDropped++;
        }
      }
      for (const iv of (cov.cue || [])) {
        if (!Array.isArray(iv)) continue;
        const c0 = axis.cueToChars(iv[0]), c1 = axis.cueToChars(iv[1]);
        if (c0 !== null && c1 !== null && c1 > c0) {
          covInsert(segs, c0, c1, MODE_NAME[iv[2]] || 'audio');
          cueUsed++;
        }
      }
      if (axis.useJp) {
        for (const iv of (cov.jp || [])) {
          if (!Array.isArray(iv)) continue;
          covInsert(segs, iv[0], iv[1], MODE_NAME[iv[2]] || 'read');
        }
      }
      try {
        const coveredChars = segs.reduce((s, sg) => s + Math.max(0, sg.c1 - sg.c0), 0);
        console.log('[KAI-COVDBG] coverageSegments', {
          titleId, msIvsIn: (cov.ms || []).length, msUsed, msDropped, cueIvsIn: (cov.cue || []).length, cueUsed,
          jpIvsIn: axis.useJp ? (cov.jp || []).length : 'n/a', axisTotal: axis.total, axisUseJp: axis.useJp, axisIsTime: !!axis.isTime,
          finalSegs: segs.length, coveredChars, pct: axis.total ? Math.round(1000 * coveredChars / axis.total) / 10 : null,
        });
      } catch (_) {}
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
      if (typeof axis.msToChars === 'function') {
        for (const iv of (cov.rms || [])) {
          if (!Array.isArray(iv)) continue;
          const c0 = axis.msToChars(iv[0]), c1 = axis.msToChars(iv[1]);
          if (c0 !== null && c1 !== null && c1 > c0) covInsert(segs, c0, c1, MODE_NAME[iv[2]] || 'audio');
        }
      }
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
    const audioPos = () => {
      // The live playhead is finer than cue granularity AND immune to cue-list
      // regeneration — prefer it on every axis flavor now that msToChars maps
      // ms uniformly (identity on the time axis, interpolated elsewhere).
      try {
        const ms = window.getAudioProgress && window.getAudioProgress().ms;
        if (Number.isFinite(ms) && ms > 0 && typeof ax.msToChars === 'function') {
          const v = ax.msToChars(ms);
          if (v !== null && Number.isFinite(v)) return v;
        }
      } catch (_) {}
      return (Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0) ? ax.cueToChars(window._lastAudioCueIdx) : null;
    };
    const cardPos = () => {
      if (!Number.isFinite(window.currentCardIndex)) return null;
      try {
        const c = (typeof window._srtCardToCueAnchor === 'function') ? window._srtCardToCueAnchor(window.currentCardIndex) : window.currentCardIndex;
        const ms = (typeof window._srtAnchorMsFor === 'function') ? window._srtAnchorMsFor(c) : null;
        if (Number.isFinite(ms) && typeof ax.msToChars === 'function') {
          const v = ax.msToChars(ms);
          if (v !== null && Number.isFinite(v)) return v;
        }
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

  // Has the reader ENTERED this chapter? This is the reveal gate for
  // ahead-generated summaries: a summary shows up when you arrive in its
  // chapter, not when you finish it. Falls back to the completion gate when
  // aiChunks isn't loaded — strictly more conservative, so a fallback can only
  // delay a reveal, never leak an unreached chapter.
  function chapterReached(map, ch) {
    try {
      if (ch && window.aiChunks && typeof window.aiChunks.isReached === 'function') {
        return !!window.aiChunks.isReached(map, ch.idx);
      }
    } catch (_) {}
    return chapterComplete(map, ch);
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
    // Prefer f.ms (generation-agnostic) re-derived against the CURRENT cue
    // list over the legacy f.cue index; this branch only runs when
    // aiChunks.isComplete itself is unavailable.
    let cue = Number.isFinite(f.cue) ? f.cue : -1;
    if (map && map.space === 'cue' && Number.isFinite(f.ms)) {
      try {
        const cues = window._srtCues;
        if (Array.isArray(cues) && cues.length) {
          let lo = 0, hi = cues.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].startMs <= f.ms) lo = mid + 1; else hi = mid; }
          cue = lo - 1;
        }
      } catch (_) {}
    }
    if (Number.isFinite(ch.cueEnd) && ch.cueEnd >= 0 && cue >= ch.cueEnd) return true;
    return false;
  }

  // Read % of a chapter (union of coverage segments ∪ furthest watermark) and
  // its dominant mode (most covered chars in range).
  function chapterProgress(axis, ch, segs, furthestJp) {
    // Ranges and segs are in AXIS units (jp chars, or ms on the time axis).
    const a = axis.chStart(ch), b = axis.chEnd(ch);
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
      window._audioStatsSeekTs = Date.now();   // jumped-over span wasn't heard — stats anchor, don't credit
      try { await bg.seek({ ms: Math.max(0, sn.ms), fadeMs: 40 }); } catch (_) {}
      // Leave the book PAUSED at the restored spot — never auto-resume, even if
      // the user was listening before the excerpt. Resuming here read as "the
      // quote never stops" (the book seamlessly continued after the excerpt);
      // an excerpt should end in silence, with the user resuming when ready.
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
      window._audioStatsSeekTs = Date.now();   // jumped-over span wasn't heard — stats anchor, don't credit
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

  // ---- summaryBlocks renderer (new-format chapter narrative) ------------------
  // para / quote / subhead blocks authored by the model (ai-processor sanitizes
  // them and resolves each quote's audio bounds at build time). `prose` is the
  // call site's OWN leaf-text builder so font scale + dict/squiggle class stay
  // site-local; dict-enabled divs remain leaf-only (the chapter-view invariant)
  // — attribution and the ▶ chip live in sibling elements, never inside one.
  // Quote audio plays through the SLICED-CLIP player (clipPlay), NEVER the
  // book's shared playhead: seeking the single bg engine for an excerpt moved
  // the user's amber place marker and resumed the book afterwards — the clip
  // player is structurally detached (dedicated <audio>, book paused in place).
  // Returns null when the artifact has no usable blocks (caller falls back to
  // the longSummary prose path, so legacy artifacts render exactly as before).
  // ---- mini-waveform helpers (quote/vocab cards) ------------------------------
  // Amplitude buckets come from the native AudioSlicer.getWaveform (no slicing,
  // no WebAudio decode). The same buckets serve double duty: they DRAW the
  // little waveform and they SNAP the interpolated clip bounds to the actual
  // speech energy — cue interpolation says roughly where the quote starts;
  // the nearest silence trough says exactly where.
  function waveEnergySnap(samples, w0, w1, b) {
    const n = samples.length;
    if (!n || !(w1 > w0)) return null;
    const step = (w1 - w0) / n;
    const amp = samples.map(v => Math.abs(Number(v) || 0));
    const max = Math.max.apply(null, amp);
    if (!(max > 0)) return null;
    const th = max * 0.14;
    const idxOf = (ms) => Math.max(0, Math.min(n - 1, Math.round((ms - w0) / step)));
    // START: mid-speech → back off to the nearest quiet trough (≤600ms);
    // in silence → advance to the last quiet bucket before the onset (≤800ms).
    let si = idxOf(b.startMs);
    if (amp[si] >= th) {
      let k = si, moved = 0; const lim = Math.round(600 / step);
      while (k > 0 && moved < lim && amp[k] >= th) { k--; moved++; }
      if (amp[k] < th) si = k;
    } else {
      let k = si, moved = 0; const lim = Math.round(800 / step);
      while (k < n - 1 && moved < lim && amp[k + 1] < th) { k++; moved++; }
      si = k;
    }
    // END: mirror.
    let ei = idxOf(b.endMs);
    if (amp[ei] >= th) {
      let k = ei, moved = 0; const lim = Math.round(500 / step);
      while (k < n - 1 && moved < lim && amp[k] >= th) { k++; moved++; }
      if (amp[k] < th) ei = k;
    } else {
      let k = ei, moved = 0; const lim = Math.round(800 / step);
      while (k > 0 && moved < lim && amp[k - 1] < th) { k--; moved++; }
      ei = k;
    }
    let sMs = w0 + si * step - 60;      // a breath before the onset
    let eMs = w0 + ei * step + 70;      // a short decay — the clip fades out over 20 ms anyway
    if (!(eMs - sMs >= 400)) { sMs = b.startMs; eMs = b.endMs; }   // degenerate snap → keep interpolation
    const s2 = idxOf(sMs), e2 = Math.max(idxOf(eMs), s2 + 1);
    return { bounds: { startMs: Math.max(0, Math.round(sMs)), endMs: Math.round(eMs) },
             peaks: amp.slice(s2, e2 + 1) };
  }
  function waveDrawPeaks(cv, peaks, bounds, absMs) {
    try {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 300;
      const h = 26;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.round(h * dpr);
      if (cv.width !== pw) { cv.width = pw; cv.height = ph; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      const n = peaks.length;
      if (!n) return;
      let max = 0; for (let k = 0; k < n; k++) if (peaks[k] > max) max = peaks[k];
      if (!(max > 0)) max = 1;
      const playedFrac = (absMs == null) ? -1 :
        Math.max(0, Math.min(1, (absMs - bounds.startMs) / Math.max(1, bounds.endMs - bounds.startMs)));
      const bw = cv.width / n;
      for (let k = 0; k < n; k++) {
        const v = Math.max(0.07, peaks[k] / max);
        const bh = v * cv.height * 0.92;
        ctx.fillStyle = (playedFrac >= 0 && (k + 0.5) / n <= playedFrac) ? '#8f7ddb' : '#3d3654';
        ctx.fillRect(k * bw + bw * 0.18, (cv.height - bh) / 2, bw * 0.64, bh);
      }
    } catch (_) {}
  }

  function buildSummaryBlocks(art, prose, titleId, chIdx, chObj) {
    const blocks = (art && Array.isArray(art.summaryBlocks)) ? art.summaryBlocks : null;
    if (!blocks || !blocks.some(b => b && b.type === 'para' && b.text)) return null;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:13px;';

    const sectionHead = (txt) => {
      const h = document.createElement('div');
      h.style.cssText = 'margin-top:12px;color:#8a7fb8;font-size:.9rem;font-weight:700;letter-spacing:.14em;';
      h.textContent = txt;
      return h;
    };

    // ---- shared clip/waveform state for THIS build ---------------------------
    const wave = { srcPath: undefined, activeDraw: null, queue: [], running: false };
    const resolveSrc = async () => {
      if (wave.srcPath !== undefined) return wave.srcPath;
      // Same source resolution as sceneClipInfo: live audio path first, else
      // the title's cached audiobook attachment.
      let p = window._srtAbPath || window._pagedAudioPath || '';
      if (!p && titleId) {
        try {
          const t = await window.titleStore.get(titleId);
          p = (t && t.attachments && t.attachments.audiobook && t.attachments.audiobook.cachePath) || '';
        } catch (_) {}
      }
      wave.srcPath = p || '';
      return wave.srcPath;
    };
    // Resolve an excerpt to its FULL cue range at need (the scene path —
    // sentence-expanded, anchorOff-disambiguated), with tight sub-cue
    // interpolation; generation-time bounds are the fallback. The waveform
    // pass below REFINES q._resolvedBounds again via energy snapping.
    const resolveBounds = async (q) => {
      if (q._resolvedBounds) return q._resolvedBounds;
      let b = null;
      try {
        if (window.aiChunks && window.aiChunks.cueRangeForQuote) {
          const loc = await window.aiChunks.cueRangeForQuote(titleId, chIdx, q.quote, { anchorOff: q.anchorOff, tight: true });
          if (loc && Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs) && loc.endMs > loc.startMs) {
            b = { startMs: loc.startMs, endMs: loc.endMs };
            if (loc.wordTimed) q._wordTimed = true;   // exact token times — don't energy-snap
          }
        }
      } catch (_) {}
      if (!b && Number.isFinite(q.startMs) && Number.isFinite(q.endMs) && q.endMs > q.startMs) {
        b = { startMs: q.startMs, endMs: q.endMs };
      }
      if (b) q._resolvedBounds = b;
      return b;
    };
    const pumpWave = () => {
      if (wave.running) return;
      const job = wave.queue.shift();
      if (!job) return;
      wave.running = true;
      Promise.resolve().then(job).catch(() => {}).then(() => { wave.running = false; pumpWave(); });
    };
    // Mini waveform under an excerpt: fetch amplitude buckets over the bounds
    // (+margins), energy-snap the bounds, draw. Jobs run one at a time, and
    // only once the card actually scrolls near the viewport — the timeline
    // feed renders these blocks for EVERY summarized chapter, and decoding
    // every quote's audio on panel open would hammer the native decoder.
    const attachWave = (q, host) => {
      const cv = document.createElement('canvas');
      cv.style.cssText = 'display:none;width:100%;height:26px;margin-top:7px;';
      host.appendChild(cv);
      const job = async () => {
        try {
          const slicer = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioSlicer;
          if (!slicer || !slicer.getWaveform) return;
          const src = await resolveSrc();
          if (!src) return;
          const b = await resolveBounds(q);
          if (!b) return;
          // Word-timed bounds (auto-transcribed titles) are already exact —
          // fetch buckets for the clip itself and draw. Otherwise fetch with
          // margins and energy-snap the interpolated bounds to the audio.
          const precise = !!q._wordTimed;
          const w0 = Math.max(0, b.startMs - (precise ? 0 : 700)), w1 = b.endMs + (precise ? 0 : 500);
          let samples = [];
          try {
            const r = await slicer.getWaveform({ srcPath: src, startMs: Math.round(w0), endMs: Math.round(w1), samples: 220 });
            samples = (r && Array.isArray(r.samples)) ? r.samples : [];
          } catch (_) {}
          if (!samples.length) return;
          let snap;
          if (precise) {
            snap = { bounds: b, peaks: samples.map(v => Math.abs(Number(v) || 0)) };
          } else {
            snap = waveEnergySnap(samples, w0, w1, b);
            if (!snap) return;
          }
          q._resolvedBounds = snap.bounds;   // the ▶ chip plays the SNAPPED clip
          if (!document.body.contains(cv)) return;
          cv.style.display = 'block';
          q._waveDraw = (absMs) => waveDrawPeaks(cv, snap.peaks, snap.bounds, absMs);
          q._waveDraw(null);
        } catch (_) {}
      };
      if ('IntersectionObserver' in window) {
        if (!wave.io) {
          wave.io = new IntersectionObserver((entries) => {
            for (const en of entries) {
              if (!en.isIntersecting) continue;
              wave.io.unobserve(en.target);
              const j = en.target._waveJob;
              if (j) { en.target._waveJob = null; wave.queue.push(j); pumpWave(); }
            }
          }, { rootMargin: '250px' });
        }
        cv._waveJob = job;
        wave.io.observe(cv);
      } else {
        wave.queue.push(job);
        pumpWave();
      }
    };

    // ▶ clip chip for any verbatim-excerpt record `q` ({quote, anchorOff,
    // startMs, endMs}) — quote blocks and vocab context sentences share it.
    // Chip always renders: bounds resolve at TAP time via cueRangeForQuote,
    // so audio can work even when generation ran without cues loaded; an
    // unresolvable excerpt just toasts 音声なし. Playback drives the card's
    // mini-waveform progress (and clears the previously active one).
    const clipChip = (q) => {
      const pb = document.createElement('button');
      pb.textContent = '▶';
      pb.title = window.i18n.t('tl.listen_scene', '▶ この場面を聴く');
      pb.style.cssText = 'flex:none;background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;font-size:.78rem;padding:4px 13px;cursor:pointer;';
      // Long-press: resolution diagnostic toast (path / bounds / failure
      // stage) — tells us in one tap which resolver tier produced a clip
      // instead of inferring it from symptoms. "r4" doubles as a build stamp.
      let _lpTimer = 0, _lpFired = false;
      const diag = async () => {
        _lpFired = true;
        let msg = 'r6';
        try {
          const src = await resolveSrc();
          msg += src ? ' src✓' : ' src✕';
          let loc = null;
          try {
            loc = await window.aiChunks?.cueRangeForQuote?.(titleId, chIdx, q.quote, { anchorOff: q.anchorOff, tight: true });
          } catch (e2) { msg += ' resolveERR:' + ((e2 && e2.message) || e2); }
          if (!loc) msg += ' loc:null';
          else {
            msg += ' path:' + (loc.path || '?');
            msg += Number.isFinite(loc.startMs)
              ? (' ' + (loc.startMs / 1000).toFixed(1) + '→' + (loc.endMs / 1000).toFixed(1) + 's' + (loc.wordTimed ? ' word' : ''))
              : ' noMs';
          }
          if (!loc || !Number.isFinite(loc && loc.startMs)) {
            msg += Number.isFinite(q.startMs) ? ' gen✓' : ' gen✕';
          }
        } catch (e3) { msg += ' ERR:' + ((e3 && e3.message) || e3); }
        try { window.showToast && window.showToast(msg, 7000); } catch (_) {}
      };
      pb.addEventListener('touchstart', () => { _lpFired = false; clearTimeout(_lpTimer); _lpTimer = setTimeout(diag, 600); }, { passive: true });
      pb.addEventListener('touchend', () => clearTimeout(_lpTimer), { passive: true });
      pb.addEventListener('touchmove', () => clearTimeout(_lpTimer), { passive: true });
      pb.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (_lpFired) { _lpFired = false; return; }   // long-press showed the diagnostic — don't also play
        try {
          const srcPath = await resolveSrc();
          if (!srcPath) {
            try { window.showToast && window.showToast(window.i18n.t('tl.no_audio', '音声なし') + ' (src)', 2500); } catch (_) {}
            return;
          }
          const bounds = await resolveBounds(q);
          if (!bounds) {
            try { window.showToast && window.showToast(window.i18n.t('tl.no_audio', '音声なし') + ' (loc)', 2500); } catch (_) {}
            return;
          }
          if (wave.activeDraw && wave.activeDraw !== q._waveDraw) {
            try { wave.activeDraw(null); } catch (_) {}
          }
          wave.activeDraw = q._waveDraw || null;
          clipPlay(bounds, pb, srcPath, q._waveDraw || null);
        } catch (_) {}
      });
      return pb;
    };

    const quoteCard = (b) => {
      // The fill/accent live on an OPAQUE non-text wrapper — styling bg
      // directly on scrolled dict-enabled text is the iOS re-raster trigger.
      const box = document.createElement('div');
      box.style.cssText = 'background:#191722;border-radius:10px;box-shadow:inset 3px 0 0 #6f5fc0;padding:11px 14px 10px;';
      box.appendChild(prose(b.quote, 'color:#e4dff2;'));
      const attText = (b.speaker ? ('— ' + b.speaker) : '') +
                      (b.speaker && b.context ? '　' : '') + (b.context || '');
      const foot = document.createElement('div');
      foot.style.cssText = 'margin-top:7px;display:flex;align-items:flex-end;gap:10px;';
      const att = document.createElement('div');
      att.style.cssText = 'flex:1;min-width:0;font-size:calc(var(--font-size-card, 1rem) * .82);color:#9d96b8;line-height:1.5;';
      att.textContent = attText;
      foot.appendChild(att);
      foot.appendChild(clipChip(b));
      box.appendChild(foot);
      attachWave(b, box);
      return box;
    };

    // sbv>=2 artifacts are authored (and sanitize-normalized) as narrative
    // first, quotes last — give the quote run its own section heading.
    // Legacy artifacts interleave quotes into the flow; no heading there.
    const sectioned = ((art.sbv | 0) >= 2);
    let quoteHeadDone = false;
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'para' && b.text) {
        wrap.appendChild(prose(b.text));
      } else if (b.type === 'subhead' && b.text) {
        wrap.appendChild(sectionHead(b.text));
      } else if (b.type === 'quote' && b.quote) {
        if (sectioned && !quoteHeadDone) {
          quoteHeadDone = true;
          wrap.appendChild(sectionHead(window.i18n.t('tl.quotes_heading', '引用')));
        }
        wrap.appendChild(quoteCard(b));
      }
    }

    // No quote blocks came back (a model can under-deliver them even though
    // the prompt demands 3-6) — the quotes section must not just vanish: fall
    // back to keyPassages, which the schema REQUIRES (2-5 verbatim quotes)
    // and which already carry located audio bounds. Attribution shows the
    // passage's "why" line.
    if (sectioned && !quoteHeadDone) {
      const kps = Array.isArray(art.keyPassages) ? art.keyPassages.filter(p => p && p.quote) : [];
      if (kps.length) {
        wrap.appendChild(sectionHead(window.i18n.t('tl.quotes_heading', '引用')));
        for (const p of kps) {
          // keyPassages' rawStart is GLOBAL text space; cueRangeForQuote's
          // hint is chunk-local — convert through the chunk's own rawStart
          // when both are known (cue-space passages carry no rawStart; the
          // relaxed long-quote ambiguity rule covers them).
          if (!p._qb) {
            const aoff = (Number.isFinite(p.rawStart) && chObj && Number.isFinite(chObj.rawStart) &&
                          p.rawStart >= chObj.rawStart) ? (p.rawStart - chObj.rawStart) : undefined;
            p._qb = { quote: p.quote, context: p.why || '', anchorOff: aoff,
                      startMs: p.startMs, endMs: p.endMs };
          }
          wrap.appendChild(quoteCard(p._qb));
        }
      }
    }

    // Vocab section (N1+ picks with verbatim context) — new-format artifacts
    // only. Word div is dict-enabled (leaf-only invariant: reading/note and
    // the ▶ chip are siblings, never inside the dict leaf).
    const vocab = Array.isArray(art.vocab)
      ? art.vocab.filter(v => v && v.word && v.context) : [];
    if (vocab.length) {
      wrap.appendChild(sectionHead(window.i18n.t('tl.vocab_heading', '語彙')));
      for (const v of vocab) {
        const row = document.createElement('div');
        row.style.cssText = 'background:#161522;border-radius:10px;padding:10px 14px 9px;display:flex;flex-direction:column;gap:6px;';
        // Word with per-kanji furigana (JmdictFurigana via buildFuriganaRuby,
        // okurigana-distribution fallback) — replaces the old （ひらがな）
        // paren reading. NOT dict-enabled: ruby markup confuses the lazy
        // char-index dict path, and the bolded word in the context sentence
        // below is already tappable.
        if (!document.getElementById('kaiVocabStyles')) {
          const st = document.createElement('style');
          st.id = 'kaiVocabStyles';
          // Furigana starts HIDDEN (self-test first — tap the word to check
          // yourself); visibility (not display) so the ruby space is reserved
          // and toggling never reflows the card.
          st.textContent =
            '.kai-vocab-word ruby rt { color:var(--accent-card, #ff9550); font-size:.5em; font-weight:600; visibility:hidden; }' +
            '.kai-vocab-word.kai-furi-show ruby rt { visibility:visible; }';
          document.head.appendChild(st);
        }
        const wordEl = document.createElement('div');
        wordEl.className = 'kai-vocab-word';
        wordEl.style.cssText = 'font-weight:700;color:#e2d9f5;font-family:var(--font-family-card);' +
          'font-size:calc(var(--font-size-card, 1rem) * 1.12);line-height:1.9;';
        let rubyOk = false;
        try {
          const rb = (typeof window.buildFuriganaRuby === 'function')
            ? window.buildFuriganaRuby(v.word, v.reading || '') : null;
          if (rb && rb.html) { wordEl.innerHTML = rb.html; rubyOk = rb.hasRuby; }
        } catch (_) {}
        if (!wordEl.innerHTML) wordEl.textContent = v.word;
        // Ruby present → the word is a BUTTON that toggles the furigana.
        if (rubyOk) {
          wordEl.style.cssText += 'display:inline-block;background:#221d33;' +
            'border:1px solid #463a6b;border-radius:10px;padding:3px 14px 4px;cursor:pointer;';
          wordEl.addEventListener('click', (e) => {
            e.stopPropagation();
            wordEl.classList.toggle('kai-furi-show');
          });
        }
        // Word line: word on the left, ＋ save-to-review pinned to the RIGHT
        // edge (fat thumb target; in-app SRS — deliberately distinct from any
        // Anki send). Resolved audio bounds are stored AT ADD TIME while this
        // title is active, so review can play the clip from any book later.
        const wordRow = document.createElement('div');
        wordRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
        const wordWrap = document.createElement('div');
        wordWrap.style.cssText = 'flex:1;min-width:0;';
        wordWrap.appendChild(wordEl);
        wordRow.appendChild(wordWrap);
        const srsBtn = document.createElement('button');
        srsBtn.style.cssText = 'flex:none;background:#1d1830;border:1px solid #463a6b;border-radius:10px;' +
          'color:#cbbfee;font-size:1.05rem;padding:9px 20px;cursor:pointer;line-height:1.1;';
        let srsIn = false;
        const paintSrs = () => {
          srsBtn.textContent = srsIn ? '✓' : '＋';
          srsBtn.title = srsIn ? window.i18n.t('vs.remove', '復習から削除') : window.i18n.t('vs.add', '復習に追加');
          srsBtn.style.color = srsIn ? '#8fd8b0' : '#cbbfee';
          srsBtn.style.borderColor = srsIn ? '#2e5b47' : '#463a6b';
        };
        paintSrs();
        (async () => { try { srsIn = !!(await window.vocabSrs?.has?.(titleId, chIdx, v.word)); paintSrs(); } catch (_) {} })();
        srsBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (!window.vocabSrs) return;
            if (srsIn) {
              await window.vocabSrs.remove(titleId, chIdx, v.word);
              srsIn = false; paintSrs();
              try { window.showToast && window.showToast(window.i18n.t('vs.removed', '復習から削除しました'), 1600); } catch (_) {}
              return;
            }
            let b = v._chip && v._chip._resolvedBounds || null;
            if (!b && v._chip) { try { b = await resolveBounds(v._chip); } catch (_) {} }
            await window.vocabSrs.add({
              titleId, chapterIdx: chIdx, word: v.word, reading: v.reading || '',
              note: v.note || '', context: v.context, anchorOff: v.anchorOff,
              startMs: b ? b.startMs : v.startMs, endMs: b ? b.endMs : v.endMs,
            });
            srsIn = true; paintSrs();
            try { window.showToast && window.showToast(window.i18n.t('vs.added', '復習に追加しました'), 1600); } catch (_) {}
          } catch (_) {}
        });
        wordRow.appendChild(srsBtn);
        row.appendChild(wordRow);
        // Definition as an inset block (accent bar, like key-event rows) —
        // reading text only reappears here if the ruby build had nothing to
        // attach (kana-only word carries no ruby and needs no reading).
        const noteTxt = (v.note || '') +
          (!rubyOk && v.reading && v.reading !== v.word ? (v.note ? '（' + v.reading + '）' : v.reading) : '');
        if (noteTxt) {
          const noteEl = document.createElement('div');
          noteEl.style.cssText = 'margin:2px 0 2px 2px;padding:5px 11px;background:#1c1930;border-radius:8px;' +
            'box-shadow:inset 2px 0 0 #6f5fc0;color:#aea7c9;' +
            'font-size:calc(var(--font-size-card, 1rem) * .85);line-height:1.5;';
          noteEl.textContent = noteTxt;
          row.appendChild(noteEl);
        }
        const ctxRow = document.createElement('div');
        ctxRow.style.cssText = 'display:flex;align-items:flex-end;gap:10px;';
        const ctx = prose(v.context, 'color:#b9b2cf;');
        // Bold the vocab word inside its context sentence — bold (not a color
        // highlight) so it can't be confused with the dictionary tap
        // highlight. Longest-prefix fallback catches conjugated forms (拾い続け
        // for 拾い続ける). Inline markup is safe here: the squiggle marker
        // already wraps runs inside these dict-enabled divs.
        try {
          const t = ctx.textContent, w = String(v.word || '');
          let hit = '';
          for (let L = w.length; L >= 2; L--) { const p = w.slice(0, L); if (t.indexOf(p) >= 0) { hit = p; break; } }
          if (hit) {
            const escH = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            ctx.innerHTML = t.split(hit).map(escH)
              .join('<b style="font-weight:800;color:#efe9fb;">' + escH(hit) + '</b>');
          }
        } catch (_) {}
        ctx.style.flex = '1'; ctx.style.minWidth = '0';
        ctxRow.appendChild(ctx);
        if (!v._chip) v._chip = { quote: v.context, anchorOff: v.anchorOff, startMs: v.startMs, endMs: v.endMs };
        ctxRow.appendChild(clipChip(v._chip));
        row.appendChild(ctxRow);
        attachWave(v._chip, row);
        wrap.appendChild(row);
      }
    }
    return wrap;
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
  // Optional per-clip progress sink (the quote/vocab mini-waveforms): called
  // with the absolute source-ms while playing, and with null on reset-to-start.
  let _clipTimeCb = null;
  function _clipPlayheadTick() {
    if (!_clipAudio || _clipAudio.paused) { _clipRaf = null; return; }
    try { const ms = _clipStartMs + (_clipAudio.currentTime || 0) * 1000; if (window.waveform && window.waveform.setPlayheadMs) window.waveform.setPlayheadMs(ms); if (_clipTimeCb) _clipTimeCb(ms); } catch (_) {}
    _clipRaf = requestAnimationFrame(_clipPlayheadTick);
  }
  function _clipPlayheadStart() { if (_clipRaf == null) _clipRaf = requestAnimationFrame(_clipPlayheadTick); }
  function _clipPlayheadStop(resetToStart) {
    if (_clipRaf != null) { try { cancelAnimationFrame(_clipRaf); } catch (_) {} _clipRaf = null; }
    if (resetToStart) {
      try { if (window.waveform && window.waveform.setPlayheadMs) window.waveform.setPlayheadMs(_clipStartMs); } catch (_) {}
      try { if (_clipTimeCb) _clipTimeCb(null); } catch (_) {}
    }
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
      // 20 ms fade in/out baked into the slice (iOS ignores <audio>.volume,
      // so the ramp has to be in the file): no click at the cut points.
      const slice = await slicer.slice({ srcPath, startMs: Math.round(startMs), endMs: Math.round(endMs), fadeInMs: 20, fadeOutMs: 20 });
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
  async function clipPlay(bounds, btn, srcPath, onTime) {
    _clipBtn = btn;
    try {
      if (_clipAudio && !_clipAudio.paused) { clipStop(); return; }   // toggle → pause
      _clipTimeCb = (typeof onTime === 'function') ? onTime : null;
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
      if (!uri) { _clipIcon(false); _clipResumeBook(); try { window.showToast && window.showToast(window.i18n.t('tl.cannot_play_audio', 'この音声を再生できませんでした') + (_lastSliceErr ? ' — ' + _lastSliceErr : ''), 4500); } catch (_) {} return; }
      if (_clipAudio) { try { _clipDetach(_clipAudio); _clipAudio.pause(); _clipAudio.src = ''; } catch (_) {} }
      _clipAudio = new Audio(uri); _clipKey = key;
      _clipAudio.onended = () => { _clipPlayheadStop(true); _clipIcon(false); _clipResumeBook(); };   // ends on its own → STOP, cursor back to start
      _clipAudio.onpause = () => { _clipPlayheadStop(false); _clipIcon(false); };
      _clipAudio.onplay = () => { _clipPlayheadStart(); _clipIcon(true); };
      _clipAudio.onerror = () => { _clipPlayheadStop(false); _clipIcon(false); _clipResumeBook(); try { window.showToast && window.showToast(window.i18n.t('tl.cannot_play_preview', 'プレビューを再生できません'), 3500); } catch (_) {} };
      try { await _clipAudio.play(); } catch (_) { _clipIcon(false); _clipResumeBook(); }
    } catch (_) { _clipBusy = false; _clipIcon(false); _clipResumeBook(); }
  }

  // ---- feed scene clip (▶ straight from the timeline feed) ---------------------
  // Locate the scene's book passage (expression + cue-range bounds) once and
  // cache SUCCESS only — a transient miss (cues still loading) must retry, not
  // stick as "no audio". Shared by the feed ▶, the book-text display, and Anki.
  const _locCache = {};
  async function sceneLoc(titleId, ch, sc, sCharId) {
    const ck = titleId + '|' + sCharId;
    if (_locCache[ck]) return _locCache[ck];
    let loc = null;
    try {
      if (sc.anchorQuote && window.aiChunks && window.aiChunks.cueRangeForQuote) {
        loc = await window.aiChunks.cueRangeForQuote(titleId, ch.idx, sc.anchorQuote, { anchorOff: sc.anchorOff });
      }
    } catch (_) {}
    if (loc) _locCache[ck] = loc;
    return loc;
  }
  // Bounds: the user's saved trim wins, else the located range. Same clipPlay/
  // slice path as the scene card, so place-safety is identical (no seek, book
  // paused/resumed).
  async function sceneClipInfo(titleId, ch, sc, sCharId) {
    let bounds = null;
    try { const tr = sceneTrimGet(titleId, sCharId); if (tr) bounds = { startMs: tr.startMs, endMs: tr.endMs }; } catch (_) {}
    if (!bounds) {
      let loc = await sceneLoc(titleId, ch, sc, sCharId);
      if (loc && !(Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs))) {
        // expression-only may be stale — cues/transcription can arrive after the
        // first locate. Drop the cached entry and try once more, fresh.
        try { delete _locCache[titleId + '|' + sCharId]; } catch (_) {}
        loc = await sceneLoc(titleId, ch, sc, sCharId);
      }
      if (loc && Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs) && loc.endMs > loc.startMs) bounds = { startMs: loc.startMs, endMs: loc.endMs };
    }
    let srcPath = window._srtAbPath || window._pagedAudioPath || '';
    if (!srcPath) { try { const t = await window.titleStore.get(titleId); srcPath = (t && t.attachments && t.attachments.audiobook && t.attachments.audiobook.cachePath) || ''; } catch (_) {} }
    return { bounds, srcPath };
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
        if (Number(s.positionMs) < g.ms - 4000) { window._audioStatsSeekTs = Date.now(); bg.seek({ ms: g.ms, fadeMs: 40 }); }
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

  // ---- AI-content read tracking (Timeline/Scenes) -----------------------------
  // Which chapter summaries + scene cards the USER has actually OPENED, per
  // title: AIREAD_V1_<tid> = { ch: {idx: ts}, sc: {'idx_slot': ts} }. Drives
  // the ✓ (read) / ○ (unread) / ▸続きから (continue here) markers so it's
  // visible where to pick up reading the AI content. In-memory cache; persists
  // on each new mark (marks are rare — one per card open).
  const _aiReadCache = {};
  async function aiReadLoad(tid) {
    if (!tid) return { ch: {}, sc: {} };
    if (_aiReadCache[tid]) return _aiReadCache[tid];
    let o = null;
    try { const raw = await window.blobStore?.get('AIREAD_V1_' + tid); o = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!o || typeof o !== 'object' || typeof o.ch !== 'object' || typeof o.sc !== 'object') o = { ch: {}, sc: {} };
    _aiReadCache[tid] = o;
    return o;
  }
  function _aiReadPersist(tid) {
    const o = _aiReadCache[tid];
    if (!o) return;
    try { window.blobStore?.set('AIREAD_V1_' + tid, JSON.stringify(o)); } catch (_) {}
  }
  async function aiReadMarkChapter(tid, idx) {
    const o = await aiReadLoad(tid);
    if (!o.ch[idx]) { o.ch[idx] = Date.now(); _aiReadPersist(tid); }
  }
  async function aiReadMarkScene(tid, idx, slot) {
    const o = await aiReadLoad(tid);
    const k = idx + '_' + slot;
    if (!o.sc[k]) { o.sc[k] = Date.now(); _aiReadPersist(tid); }
  }

  // ---- chapter view -----------------------------------------------------------
  // z 9000 (below dict 9999 / toast 9500). No longer reachable from the feed
  // (the panel inlines everything); still the Characters-screen deep link
  // (aiTimeline.openChapterView), where `reopen` is null.
  // Is this artifact showable as a summary right now? (exists, has a summary,
  // and isn't an ahead generation for a chapter the reader hasn't arrived in)
  function showableArt(map, ch, a) {
    if (!a || !a.shortSummary) return null;
    if (a.ahead && !chapterReached(map, ch)) return null;
    return a;
  }

  // The chapters immediately either side, whether or not they have a summary —
  // a neighbour WITHOUT one turns its arrow into a generate action rather than
  // vanishing, so paging never dead-ends.
  // Returns { prev, next }, each { ch, art (may be null), complete, reached } or null.
  async function chapterNeighbors(titleId, idx) {
    const out = { prev: null, next: null };
    try {
      const map = await getMapSafe(titleId);
      if (!map || !Array.isArray(map.chunks)) return out;
      const arts = filterArtifacts(await loadArtifacts(titleId), map);
      const list = map.chunks.filter(c => c && Number.isFinite(c.idx)).slice().sort((a, b) => a.idx - b.idx);
      const at = list.findIndex(c => c.idx === idx);
      if (at < 0) return out;
      const wrap = (c) => c ? {
        ch: c,
        art: showableArt(map, c, arts[c.idx]),
        complete: chapterComplete(map, c),
        reached: chapterReached(map, c),
      } : null;
      out.prev = wrap(list[at - 1]);
      out.next = wrap(list[at + 1]);
    } catch (_) {}
    return out;
  }

  // Open chapter `idx` in the standalone view, resolving its chapter + artifact
  // fresh. Returns false when it still has no showable summary.
  async function openChapterViewByIdx(titleId, idx, reopen, opts) {
    try {
      const map = await getMapSafe(titleId);
      const arts = filterArtifacts(await loadArtifacts(titleId), map);
      const ch = (map && Array.isArray(map.chunks) && map.chunks.find(c => c && c.idx === idx)) || { idx, label: null };
      const art = showableArt(map, ch, arts[idx]);
      // allowEmpty: open the chapter view anyway with a BLANK body — an empty
      // state carrying its own "generate this summary" button plus the usual
      // ‹ › footer, so paging never dead-ends on an unsummarized chapter.
      if (!art && !(opts && opts.allowEmpty)) return false;
      await openChapterView(titleId, ch, art || null, reopen);
      return true;
    } catch (_) { return false; }
  }

  // Generate a chapter's summary on demand — the arrows' fallback, and what the
  // audio-mode button offers when the chapter you're in has none yet. Mirrors
  // the feed row's ✦ 生成 flow (spoiler confirm when the chapter isn't finished,
  // then an awaited forced processChapter).
  async function generateChapterSummary(titleId, ch, complete) {
    try {
      if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) {
        try { window.showToast && window.showToast(window.i18n.t('tl.enable_ai_first', 'Enable AI in Preferences → AI assistant first'), 3000); } catch (_) {}
        return false;
      }
      if (!window.aiProcessor || typeof window.aiProcessor.processChapter !== 'function') return false;
      const msg = complete
        ? window.i18n.t('tl.gen_summary_confirm', 'この章の要約をAIで生成しますか？（API利用料がかかります）')
        : window.i18n.t('tl.spoiler_confirm', 'この章はまだ読み終えていません。要約にはネタバレが含まれる可能性があります。生成しますか？');
      if (!window.confirm(msg)) return false;
      const r = await window.aiProcessor.processChapter(titleId, ch.idx, { force: true, forceUnread: true });
      return !!(r && r.ok !== false);
    } catch (_) { return false; }
  }

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
        try { clipDispose(); } catch (_) {}   // a quote clip must not outlive the view it was started from
      }
      armLookGuard();
      // Opening a chapter WITH a summary counts as reading its AI content.
      if (art) { try { aiReadMarkChapter(titleId, ch.idx); } catch (_) {} }

      const overlay = document.createElement('div');
      overlay.id = 'kchapterView';
      overlay.classList.add('kai-ai-page');   // stats.js: AI-material time tracking
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(5px + env(safe-area-inset-top, 0px)) 0 calc(5px + env(safe-area-inset-bottom, 0px));';

      let closed = false;
      function onVis() {
        // Backgrounded mid-passage: restore at once so the app's own durable
        // position saves capture the user's real place, not the passage spot.
        // Quote clips (dedicated <audio>) are disposed too so they don't keep
        // sounding over whatever the user backgrounds into.
        if (document.hidden) { try { stopPassage(); } catch (_) {} try { clipDispose(); } catch (_) {} }
      }
      async function close() {
        if (closed) return;
        closed = true;
        overlay._dead = true;
        if (overlay._scenePoll) { try { clearInterval(overlay._scenePoll); } catch (_) {} overlay._scenePoll = null; }
        try { await stopPassage(); } catch (_) {}
        try { clipDispose(); } catch (_) {}   // a quote clip must not outlive the view
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
      // Fill the overlay's whole content box (its padding already carries the
      // safe-area insets) instead of 86vh — the leftover 14 % was showing up as
      // dead black bands above and below the card on a phone.
      card.style.cssText =
        'background:#141414;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(96vw,720px);height:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';
      // Vision: the window is generously sized by the user — let the chapter
      // view use ALL of it instead of the phone-tuned 720px column.
      if (window.KADOKI_VISION) { card.style.width = '100%'; card.style.maxWidth = 'none'; }

      const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: ch.idx + 1 }, '第' + (ch.idx + 1) + '章');
      const chIsTime = Number.isFinite(ch.msStart);
      const lenJp = (!chIsTime && Number.isFinite(ch.jpEnd) && Number.isFinite(ch.jpStart))
        ? (ch.jpEnd - ch.jpStart) : 0;

      const head = document.createElement('div');
      head.id = 'kchapterViewHead';   // dict popup positions itself below this
      head.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #242424;';
      const ht = document.createElement('div');
      ht.style.cssText = 'flex:1;min-width:0;';
      // Sub-line kept to ONE line (the short "from {n}" form, then the total) —
      // in English the long form wrapped and cost a whole extra header row.
      ht.innerHTML =
        '<div style="font-weight:600;color:#eee;font-size:.98rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(label) + '</div>' +
        '<div style="color:#999;font-size:.78rem;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(window.i18n.fmt('tl.chapter_n', { n: ch.idx + 1 }, '第' + (ch.idx + 1) + '章')) +
        (chIsTime ? (' · ' + esc(window.i18n.fmt('tl.time_from', { t: fmtDur(ch.msStart) }, fmtDur(ch.msStart) + '〜')))
                  : (lenJp > 0 ? (' · ' + esc(window.i18n.fmt('tl.chars_from_short', { n: ch.jpStart.toLocaleString() }, ch.jpStart.toLocaleString() + '字〜')) +
                                  ' · ' + esc(window.i18n.fmt('tl.chars', { n: lenJp.toLocaleString() }, lenJp.toLocaleString() + '字'))) : '')) + '</div>';
      const cp = document.createElement('button');
      cp.textContent = '⧉';
      cp.title = window.i18n.t('tl.copy_chapter_summary', 'Copy chapter summary');
      cp.style.cssText =
        'background:none;border:1px solid #333;border-radius:8px;color:#aab4dd;' +
        'font-size:.95rem;padding:6px 12px;cursor:pointer;line-height:1.1;';
      cp.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (window.aiExport && window.aiExport.chapterText) {
            const ok = await window.aiExport.copyText(window.aiExport.chapterText(art, ch, ch.idx + 1));
            window.aiExport.toast(ok ? window.i18n.t('tl.copied', 'Copied') : window.i18n.t('tl.copy_failed', 'Copy failed'));
          }
        } catch (_) {}
      });
      // Rebuild — same forceUnread/discard/force flow as the feed row's ⟲.
      // processChapter is awaited (not fire-and-forget), so on success the
      // artifact is already updated by the time we get here: close this view
      // and reopen it fresh rather than trying to patch the built DOM in place.
      let rb = null;
      if (art) {
        rb = document.createElement('button');
        rb.textContent = '⟲';
        rb.title = window.i18n.t('tl.regen_summary', 'Rebuild this chapter summary');
        rb.style.cssText =
          'background:none;border:1px solid #333;border-radius:8px;color:#aab4dd;' +
          'font-size:1.25rem;padding:8px 15px;cursor:pointer;line-height:1.1;';
        rb.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!window.confirm(window.i18n.t('tl.regen_summary_confirm', 'この章の要約をAIで作り直しますか？（API利用料がかかります）'))) return;
          rb.disabled = true;
          try {
            if (window.aiProcessor && typeof window.aiProcessor.processChapter === 'function') {
              const r = await window.aiProcessor.processChapter(titleId, ch.idx, { force: true, discard: true, forceUnread: true });
              if (r && r.ok !== false) { await close(); await openChapter(titleId, ch.idx); }
              else rb.disabled = false;
            }
          } catch (_) { rb.disabled = false; }
        });
      }
      const xb = document.createElement('button');
      xb.textContent = '✕';
      xb.style.cssText =
        'background:none;border:1px solid #333;border-radius:8px;color:#ccc;' +
        'font-size:1.25rem;padding:8px 15px;cursor:pointer;line-height:1.1;';
      xb.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      head.appendChild(ht);
      // visionOS: pop this panel out into its own window (panel-bridge.js).
      // Null off Vision, so the header is unchanged everywhere else. Popping
      // out tears the in-window copy down — the window IS the panel now.
      try {
        const po = window.kadokiPanel && window.kadokiPanel.makeButton
          ? window.kadokiPanel.makeButton('summary', () => close()) : null;
        if (po) head.appendChild(po);
      } catch (_) {}
      if (art) head.appendChild(cp);   // nothing to copy on a blank (unsummarized) page
      if (rb) head.appendChild(rb);
      head.appendChild(xb);

      const content = document.createElement('div');
      // Opaque background so the momentum-scroll tiles are solid (iOS caches
      // opaque tiles; a transparent scroll layer over content is costlier).
      // overflow-x:hidden is NOT redundant here: `overflow-y:auto` alone makes
      // overflow-x compute to AUTO, so a single too-wide child (a long quote, a
      // wide chip row) lets the whole summary pan sideways. Barely noticeable
      // with a thumb, blatant with a Vision Pro trackpad. Same fix the
      // Characters list already carries.
      content.style.cssText =
        'flex:1;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;touch-action:pan-y;' +
        'padding:12px 14px;background:#141414;';   // no -webkit-overflow-scrolling:touch (deprecated; forces iOS legacy re-rastering scroll layer = summary lag)

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
          'margin:20px 0 8px;color:#8a7fb8;font-size:.92rem;font-weight:700;letter-spacing:.06em;';
        h.textContent = txt;
        return h;
      };

      // Summary: new-format artifacts render the summaryBlocks narrative flow
      // (paragraphs + pull-quotes with audio + optional subheads); pre-blocks
      // artifacts fall back to the flat longSummary prose. LEGACY artifacts
      // (old 600-1500字 long + mediumSummary) stay behind a 「全文を表示」
      // expander so they don't dump a wall of text.
      const blocksEl = art ? buildSummaryBlocks(art, prose, titleId, ch.idx, ch) : null;
      if (blocksEl) content.appendChild(blocksEl);
      const longText = (art && !blocksEl) ? paragraphize(art.longSummary || '') : '';   // art may be null (scene-only chapter)
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
      // Model attribution: a small dim line at the END of the summary text showing
      // which model produced it (claude-* or an OpenRouter id). Hidden when empty.
      if ((blocksEl || longText) && art && art.model) {
        const mb = document.createElement('div');
        mb.style.cssText = 'margin-top:8px;font-size:.62rem;color:#667;';
        mb.textContent = window.i18n.fmt('or.model_by', { id: art.model }, 'model: ' + art.model);
        content.appendChild(mb);
      }

      // No summary yet: a real, navigable BLANK page rather than a refusal —
      // its own "generate this chapter's summary" call to action, with the
      // ‹ › footer below still paging to the neighbouring chapters. Any scene
      // images the chapter already has still render underneath.
      if (!art) {
        const empty = document.createElement('div');
        empty.style.cssText =
          'display:flex;flex-direction:column;align-items:center;gap:14px;' +
          'padding:44px 18px 26px;text-align:center;';
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#8b8b96;font-size:.92rem;line-height:1.7;';
        msg.textContent = window.i18n.t('tl.chapter_no_summary_yet', 'この章の要約はまだ生成されていません');
        empty.appendChild(msg);
        const genLabel = window.i18n.t('tl.gen_summary_cta', '✦ 要約を生成');
        const gen = document.createElement('button');
        gen.textContent = genLabel;
        gen.style.cssText =
          'background:#1d1830;border:1px solid #463a6b;border-radius:11px;color:#cbbfee;' +
          'font-size:.98rem;font-weight:700;padding:13px 26px;cursor:pointer;line-height:1.2;';
        gen.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (gen.disabled) return;
          gen.disabled = true;
          gen.textContent = window.i18n.t('tl.thinking', '考え中…');
          try {
            // Spoiler confirm keys off whether the chapter is finished, exactly
            // like the feed row's ✦ 生成 and the footer arrows.
            let complete = true;
            try { const m2 = await getMapSafe(titleId); complete = chapterComplete(m2, ch); } catch (_) {}
            const ok = await generateChapterSummary(titleId, ch, complete);
            // Success REPLACES this view in place (openChapterView tears down an
            // existing #kchapterView) and carries `reopen` forward, so closing
            // afterwards still returns wherever the user came from.
            if (ok && !overlay._dead && !closed &&
                await openChapterViewByIdx(titleId, ch.idx, reopen)) return;
          } catch (_) {}
          gen.textContent = genLabel;
          gen.disabled = false;
        });
        empty.appendChild(gen);
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#5f5f6a;font-size:.72rem;line-height:1.6;max-width:26em;';
        hint.textContent = window.i18n.t('tl.blank_page_hint', '下の ‹ › で他の章の要約に移動できます。');
        empty.appendChild(hint);
        content.appendChild(empty);
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
            // Full card font size (same as the summary paragraphs) — fixed-rem
            // sizes here read tiny next to the user's scaled prose.
            row.appendChild(prose(ev.title, 'font-weight:700;line-height:1.5;'));
          }
          if (ev.description) {
            row.appendChild(prose(ev.description, 'font-size:calc(var(--font-size-card, 1rem) * .92);color:#aaa;line-height:1.6;margin-top:2px;'));
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

      // Real-world places (chips like Characters; tap opens the map popup —
      // aiPlacesUi sits at z 9400, above this view). New artifacts carry the
      // chapter's own model-extracted list (art.places); older ones fall back
      // to place-DB records whose chapter span covers this chapter.
      const placesSec = document.createElement('div');
      placesSec.style.display = 'none';
      const placeRow = document.createElement('div');
      placeRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      placesSec.appendChild(heading(window.i18n.t('tl.places', '場所')));
      placesSec.appendChild(placeRow);
      content.appendChild(placesSec);
      (async () => {
        try {
          let names = (art && Array.isArray(art.places))
            ? art.places.map(p => p && p.surface).filter(Boolean) : [];
          if (!names.length && window.aiPlaces && window.aiPlaces.getStore) {
            const st = await window.aiPlaces.getStore(titleId);
            if (st && st.places) {
              names = Object.values(st.places)
                .filter(r => r && Number.isFinite(r.firstChunkIdx) &&
                        r.firstChunkIdx <= ch.idx && ch.idx <= (r.lastChunkIdx ?? r.firstChunkIdx))
                .map(r => r.surface).filter(Boolean);
            }
          }
          names = Array.from(new Set(names)).slice(0, 12);
          if (!names.length || !document.body.contains(overlay)) return;
          for (const surface of names) {
            const chip = document.createElement('button');
            chip.textContent = surface;
            chip.style.cssText =
              'background:#16241f;border:1px solid #2e5b47;border-radius:999px;' +
              'color:#a9dcc3;font-size:.92rem;padding:7px 15px;cursor:pointer;';
            chip.addEventListener('click', (e) => {
              e.stopPropagation();
              try {
                const ok = window.aiPlacesUi && window.aiPlacesUi.openPopupFor &&
                           window.aiPlacesUi.openPopupFor(surface);
                if (!ok && window.showToast) window.showToast(surface, 1600);
              } catch (_) {}
            });
            placeRow.appendChild(chip);
          }
          placesSec.style.display = '';
        } catch (_) {}
      })();

      // 印象的な場面: redundant when the blocks narrative already carries its
      // quotes inline — shown only for pre-blocks artifacts.
      const passages = (art && !blocksEl && Array.isArray(art.keyPassages))
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
            // Sliced-clip player, same as the quote chips — never seek the
            // book's shared playhead for an excerpt.
            pb.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                let srcPath = window._srtAbPath || window._pagedAudioPath || '';
                if (!srcPath) {
                  try {
                    const t = await window.titleStore.get(titleId);
                    srcPath = (t && t.attachments && t.attachments.audiobook && t.attachments.audiobook.cachePath) || '';
                  } catch (_) {}
                }
                if (!srcPath) {
                  try { window.showToast && window.showToast(window.i18n.t('tl.no_audio', '音声なし'), 2500); } catch (_) {}
                  return;
                }
                // Full-range resolve at tap time (stored bounds = first cue only).
                let bounds = null;
                try {
                  if (window.aiChunks && window.aiChunks.cueRangeForQuote) {
                    const loc = await window.aiChunks.cueRangeForQuote(titleId, ch.idx, p.quote, {});
                    if (loc && Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs) && loc.endMs > loc.startMs) {
                      bounds = { startMs: loc.startMs, endMs: loc.endMs };
                    }
                  }
                } catch (_) {}
                if (!bounds) bounds = { startMs: p.startMs, endMs: p.endMs };
                clipPlay(bounds, pb, srcPath);
              } catch (_) {}
            });
            box.appendChild(pb);
            passBtns.push(pb);
          }
          content.appendChild(box);
        }
      }

      // Cost/date line — shares the footer row with the nav arrows rather than
      // owning a band of its own.
      const meta = document.createElement('div');
      meta.style.cssText =
        'flex:1;min-width:0;color:#666;font-size:.64rem;text-align:center;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      try {
        const bits = [];   // model id is shown inline at the end of the summary, not here
        if (art && Number.isFinite(art.costUsd)) bits.push('~$' + art.costUsd.toFixed(3));
        if (art && art.ts) bits.push(new Date(art.ts).toLocaleString());
        meta.textContent = bits.join(' · ');
      } catch (_) {}

      // ---- prev / next chapter nav ----
      // Big footer arrows, so paging between chapters never has to go through
      // the Timeline panel — this view is deliberately self-contained (routing
      // through the panel throws away the user's scroll place in Timeline and
      // Scenes, which is the whole reason the audio-mode button opens a popup).
      // A pinned footer rather than more header buttons: the header already
      // carries ⧉ / ⟲ / ✕ and a chapter label. Buttons render disabled and fill
      // in once the neighbour lookup resolves, so opening is never blocked on
      // it. Navigation REPLACES the view in place (openChapterView handles an
      // existing #kchapterView) and carries `reopen` forward, so closing after
      // paging still returns wherever you came from.
      const nav = document.createElement('div');
      nav.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 10px;' +
        'border-top:1px solid #242424;background:#141414;';
      const mkNav = () => {
        const b = document.createElement('button');
        b.disabled = true;
        b.style.cssText =
          'flex:0 1 auto;min-width:0;background:#191425;border:1px solid #2e2e2e;border-radius:9px;' +
          'color:#aab4dd;font-size:.86rem;padding:10px 14px;cursor:pointer;line-height:1.2;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.3;';
        return b;
      };
      const navPrev = mkNav(), navNext = mkNav();
      // Both arrows always NAVIGATE, whether or not the neighbour has a summary:
      // a neighbour without one opens as the blank page above, which carries its
      // own ✦ generate button. (Generating straight from the arrow was the old
      // behavior; it put a confirm dialog on a plain navigation control and made
      // an unsummarized chapter feel like a dead end.) The ✦ on the label marks
      // the destination as still empty. No neighbour at all (start/end of the
      // book) hides the button.
      const wireNav = (btn, target, isPrev) => {
        const arrow = isPrev ? '‹ ' : ' ›';
        const chapLabel = window.i18n.t(isPrev ? 'tl.prev_chapter' : 'tl.next_chapter', isPrev ? '前の章' : '次の章');
        if (!target) { btn.style.display = 'none'; return; }
        const hasSum = !!target.art;
        const label = hasSum
          ? (isPrev ? arrow + chapLabel : chapLabel + arrow)
          : (isPrev ? arrow + '✦ ' + chapLabel : '✦ ' + chapLabel + arrow);
        btn.textContent = label;
        btn.disabled = false;
        btn.style.opacity = '1';
        if (!hasSum) { btn.style.borderColor = '#463a6b'; btn.style.color = '#d6c8ff'; }
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            await openChapterView(titleId, target.ch, target.art || null, reopen);
            return;
          } catch (_) {}
          btn.textContent = label;
          btn.disabled = false;
        });
      };
      nav.appendChild(navPrev);
      nav.appendChild(meta);
      nav.appendChild(navNext);
      chapterNeighbors(titleId, ch.idx).then((n) => {
        if (overlay._dead || closed) return;
        wireNav(navPrev, n.prev, true);
        wireNav(navNext, n.next, false);
      }).catch(() => {});

      card.appendChild(head);
      card.appendChild(content);
      card.appendChild(nav);
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
          if (!art) return;   // blank page — no artifact, no related-character chips
          const found = await resolveChars(titleId, art.relatedCharIds);
          if (!found.length || !document.body.contains(overlay)) return;
          for (const c of found) {
            const chip = document.createElement('button');
            chip.textContent = c.surface;
            chip.style.cssText =
              'background:#221d33;border:1px solid #463a6b;border-radius:999px;' +
              'color:#cbbfee;font-size:.92rem;padding:7px 15px;cursor:pointer;';
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
  // view (shares #kchapterView; only one open at a time). The timeline panel now
  // STAYS OPEN underneath (this card is a later body child at the same z, so it
  // stacks above); `reopen` is just a light status refresh, never a rebuild.
  // preEnum/preIdx thread the flat scene list through ▲/▼ nav so it isn't
  // rebuilt each hop.
  async function openSceneCard(titleId, ch, art, s, reopen, preEnum, preIdx, animDir) {
    // Viewing a scene card counts as reading that scene's AI content.
    try { aiReadMarkScene(titleId, ch.idx, s); } catch (_) {}
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
          for (const c of chs) { const a = aa ? (aa[c.idx] || null) : null; if (a && a.ahead && m && !chapterReached(m, c)) continue; const sl = (a && Array.isArray(a.scenes)) ? a.scenes : []; for (let k = 0; k < sl.length; k++) allScenes.push({ ch: c, art: a, s: k }); }
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
      overlay.classList.add('kai-ai-page');   // stats.js: AI-material time tracking
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
      content.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;' +
        'touch-action:pan-y;padding:16px 18px;background:#141414;';   // overflow-x: see the chapter-view note

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
          if (!r || r.ok === false) gst.textContent = (r && r.reason === 'refused') ? (r.refusalMsg || window.i18n.t('tl.refused', '拒否されました')) : (r && r.reason === 'no-key') ? window.i18n.t('tl.set_key', 'キーを設定してください') : (r && (r.reason === 'busy' || r.reason === 'rate-limited' || r.queued)) ? window.i18n.t('tl.waiting_generation', '生成待ち…') : (window.i18n.t('tl.failed', '失敗') + (r && r.error ? ('：' + r.error) : ''));
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
          try { const pp = wfHost.querySelector('[data-role="playpause"]'); if (pp) pp.style.display = 'none'; } catch (_) {}   // scene card has its own ▶/❚❚ clip player
        } catch (_) {}
      }

      (async () => {
        try {
          if (sc.anchorQuote && window.aiChunks && window.aiChunks.cueRangeForQuote) loc = await window.aiChunks.cueRangeForQuote(titleId, ch.idx, sc.anchorQuote, { anchorOff: sc.anchorOff });
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

  // Resolve the CURRENT chapter idx — same "いま" position logic the feed uses
  // to pick curIdx (currentAxisPos against each chapter's axis bounds). Shared
  // by openCurrentChapter (audio-mode button tap) and currentChapterStatus
  // (audio-mode badge/toast poll) so the two never disagree on "which chapter".
  // Returns { map, idx } or null (no chunk map yet).
  async function resolveCurrentChapter(titleId) {
    const map = await getMapSafe(titleId);
    if (!map || !Array.isArray(map.chunks) || !map.chunks.length) return null;
    const axis = buildMapAxis(map);
    const furthestJp = axis.isTime
      ? ((map.furthest && Number.isFinite(map.furthest.ms) && typeof axis.msToChars === 'function')
          ? axis.msToChars(map.furthest.ms)
          : ((map.furthest && Number.isFinite(map.furthest.cue) && map.furthest.cue >= 0) ? axis.cueToChars(map.furthest.cue) : null))
      : ((map.furthest && Number.isFinite(map.furthest.jp)) ? map.furthest.jp : null);
    const curP = currentAxisPos(axis);
    const pos = (curP !== null && Number.isFinite(curP)) ? curP : (furthestJp || 0);
    let idx = -1;
    for (const ch of map.chunks) {
      const a = axis.chStart(ch), b = axis.chEnd(ch);
      if (pos >= a && pos < (b > a ? b : Infinity)) { idx = ch.idx; break; }
    }
    // pos landed exactly on a boundary/gap the range check above didn't catch
    // (e.g. right at the book's end) — fall back to the closest preceding
    // chapter rather than giving up.
    if (idx < 0) {
      for (const ch of map.chunks) { if (axis.chStart(ch) <= pos) idx = ch.idx; }
    }
    if (idx < 0) idx = 0;
    return { map, idx };
  }

  // Open the current chapter's view directly. Entry point for the audio-mode
  // (and visionOS transport-bar) "go to this chapter's summary" button. A
  // chapter with no summary yet opens BLANK rather than complaining — see
  // openChapter's allowEmpty.
  async function openCurrentChapter(titleId) {
    try {
      titleId = titleId || window._activeTitleId;
      if (!titleId) return false;
      // visionOS: the summary opens in its OWN window by default rather than as
      // an overlay covering the book — that is the whole point of having it
      // beside you while you listen. popOut focuses the window if it already
      // exists. Guarded on !KADOKI_PANEL so the panel window's own mount (which
      // calls straight through to here) doesn't ask for a window recursively.
      if (!window.KADOKI_PANEL && window.kadokiPanel && window.kadokiPanel.available()) {
        if (window.kadokiPanel.popOut('summary')) return true;
      }
      const r = await resolveCurrentChapter(titleId);
      if (!r) {
        try { if (window.showToast) window.showToast(window.i18n.t('tl.no_chapters_yet', 'チャプターはまだありません。読み進めると章ごとのカードが表示されます。'), 2500); } catch (_) {}
        return false;
      }
      // allowEmpty: a chapter with no summary yet opens as the BLANK page —
      // the empty state carries its own ✦ generate button and the ‹ › footer
      // pages to the neighbouring chapters' summaries. Never a bare complaint,
      // and never a fall back to the Timeline panel: this button's whole point
      // is a self-contained popup, and routing through the panel discards the
      // user's scroll place in Timeline and Scenes.
      return await openChapter(titleId, r.idx, { allowEmpty: true });
    } catch (_) { return false; }
  }

  // Status of the CURRENT chapter's AI summary, for the audio-mode button's
  // badge/toast (reading-mode.js polls this — see abCheckSummaryStatus).
  // Returns { idx, label, hasSummary, unread } or null. `unread` reuses the
  // SAME AIREAD_V1 state the ✓/●/続きから feed markers are driven by — opening
  // the chapter view (openChapterView → aiReadMarkChapter) is what clears it,
  // so the badge/toast and the feed's own markers can never disagree.
  async function currentChapterStatus(titleId) {
    try {
      titleId = titleId || window._activeTitleId;
      if (!titleId) return null;
      const r = await resolveCurrentChapter(titleId);
      if (!r) return null;
      const ch = r.map.chunks.find(c => c && c.idx === r.idx) || { idx: r.idx };
      const arts = filterArtifacts(await loadArtifacts(titleId), r.map);
      let art = arts[r.idx] || null;
      if (art && art.ahead && !chapterReached(r.map, ch)) art = null;   // generated ahead — not arrived at yet
      const hasSum = !!(art && art.shortSummary);
      const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: r.idx + 1 }, '第' + (r.idx + 1) + '章');
      if (!hasSum) return { idx: r.idx, label, hasSummary: false, unread: false };
      const readState = await aiReadLoad(titleId);
      const unread = !readState.ch[r.idx];
      return { idx: r.idx, label, hasSummary: true, unread };
    } catch (_) { return null; }
  }

  // Open a chapter view directly (Characters screen links etc.).
  async function openChapter(titleId, idx, opts) {
    try {
      titleId = titleId || window._activeTitleId;
      if (!titleId || !Number.isFinite(idx)) return false;
      const map = await getMapSafe(titleId);
      const arts = filterArtifacts(await loadArtifacts(titleId), map);
      const ch = (map && map.chunks.find(c => c && c.idx === idx)) || { idx, label: null };
      let art = arts[idx] || null;
      if (art && art.ahead && map && !chapterReached(map, ch)) art = null;   // generated ahead — not arrived at yet, keep hidden
      // allowEmpty: open the blank page (its own ✦ generate button + the ‹ ›
      // footer) instead of refusing, so the caller's tap always lands somewhere.
      if (!art && !(opts && opts.allowEmpty)) return false;
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

      // window._srtCues (the cue list this panel's axis/coverage math is built
      // on — buildMapAxis, coverageSegments/revisitSegments, migrateLegacyCue)
      // is populated ONLY by loadTitleAsSrtCards at title-open, or by live
      // auto-transcription while it's actively running. loadTitleAsSrtCards
      // has several silent bail points (a stale cache-path signature, a fetch/
      // parse failure) that can leave it permanently empty for the rest of the
      // session — with NO retry unless the user enters card mode (shell.js
      // calls window.ensureCardRenderedForActiveTitle "on every entry into
      // card mode"). Audio/read mode have their OWN separate cue arrays
      // (pagedCues/abCues) and work fine regardless, so an audio-primary
      // listener who rarely visits card mode would see NO symptom there while
      // this panel's coverage axis silently degrades to near-empty (every
      // cueToChars/msToChars call returns null with no cue list to map
      // against) — confirmed live on-device: title open, _activeTitleId set,
      // yet window._srtCues undefined. Run the SAME self-heal card-mode entry
      // already relies on, so opening the Timeline recovers it too.
      try {
        if ((!Array.isArray(window._srtCues) || !window._srtCues.length) &&
            typeof window.ensureCardRenderedForActiveTitle === 'function') {
          window.ensureCardRenderedForActiveTitle();
          // the heal is fire-and-forget async (file/transcription I/O) — give
          // it a moment, then let the normal refresh path pick up fresh cues
          // (scheduleRefresh's own axis rebuild re-derives everything from
          // whatever window._srtCues is AT THAT TIME; a no-op if still empty).
          setTimeout(() => { try { if (document.body.contains(overlay)) scheduleRefresh(60); } catch (_) {} }, 2200);
        }
      } catch (_) {}

      let map = await getMapSafe(titleId);
      let axis = map ? buildMapAxis(map) : buildProbeAxis();
      if (!axis) return false;

      let arts = map ? filterArtifacts(await loadArtifacts(titleId), map) : {};
      let segs = await coverageSegments(titleId, axis);
      let rsegs = await revisitSegments(titleId, axis);
      // TEMP diagnostic (2026-08 spine investigation: "coverage reaches further
      // than I've listened / there's a gap in a continuous listen"). Prints the
      // spine EXACTLY as drawn — every band and hole as a % of the axis, the
      // live marker's %, and the raw store extents it was mapped from — so a
      // wrong band can be traced to either the stored intervals or the ms→char
      // mapping. Always on (no KADOKI_DEBUG gate) so it shows in the Xcode /
      // chrome://inspect console with no setup. Remove once resolved.
      try {
        const T = axis.total || 0;
        const pctOf = (v) => (T ? Math.round(1000 * Math.max(0, Math.min(T, v)) / T) / 10 : null);
        const band = (a) => (a || []).map(sg => pctOf(sg.c0) + '–' + pctOf(sg.c1) + '%' + (sg.mode ? (' ' + sg.mode) : ''));
        const holes = [];
        let cur = 0;
        for (const sg of (segs || [])) { if (sg.c0 > cur + T * 0.005) holes.push(pctOf(cur) + '–' + pctOf(sg.c0) + '%'); cur = Math.max(cur, sg.c1); }
        const cov = await window.modeCoverage.get(titleId);
        const ext = (arr) => (arr && arr.length) ? [arr[0][0], arr[arr.length - 1][1]] : null;
        console.log('[KAI-SPINEDBG]', {
          titleId,
          axis: { total: T, useJp: !!axis.useJp, isTime: !!axis.isTime, canMapCues: !!axis.canMapCues },
          nowPct: pctOf(currentAxisPos(axis)),
          furthest: (map && map.furthest) || null,
          coverBands: band(segs), coverHoles: holes,
          revisitBands: band(rsegs),
          storeV: cov && cov.v,
          storeIvs: cov ? { ms: (cov.ms || []).length, cue: (cov.cue || []).length, jp: (cov.jp || []).length,
                            rms: (cov.rms || []).length, rcue: (cov.rcue || []).length, rjp: (cov.rjp || []).length } : null,
          storeExtent: cov ? { ms: ext(cov.ms), cue: ext(cov.cue), jp: ext(cov.jp) } : null,
          msIvs: cov ? (cov.ms || []).slice(0, 40) : null,
        });
      } catch (_) {}
      // Read-state of the AI content (✓ / ○ / ▸続きから markers).
      let _aiRead = await aiReadLoad(titleId);

      try {
        if (window.ai && typeof window.ai.markSeen === 'function') window.ai.markSeen(titleId, 'timeline');
      } catch (_) {}

      const prev = document.getElementById('bookmarksOverlay');
      if (prev) { try { if (prev._kaiDestroy) prev._kaiDestroy(); else prev.remove(); } catch (_) { try { prev.remove(); } catch (_) {} } }

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
          _aiRead = await aiReadLoad(titleId);
          if (window.aiImages && window.aiImages.sceneStatusByChapter) _sceneStat = await window.aiImages.sceneStatusByChapter(titleId) || {};
          // per-scene slot status for the inline feed rows (thumbnail vs 生成 button)
          if (window.aiImages && window.aiImages.statusBatch) {
            const ids = [];
            try { for (const [k, a] of Object.entries(arts || {})) { const scns = (a && Array.isArray(a.scenes)) ? a.scenes : []; for (let s = 0; s < scns.length; s++) ids.push('scene_' + k + '_' + s); } } catch (_) {}
            // bare per-chapter buckets too (legacy auto-illustrate images): the
            // feed needs their COUNT up front to reserve fixed-size figures
            try { const chs = (map && Array.isArray(map.chunks)) ? map.chunks : []; for (const c of chs) if (c && Number.isFinite(c.idx)) ids.push('scene_' + c.idx); } catch (_) {}
            _sceneSlotStat = ids.length ? (await window.aiImages.statusBatch(titleId, ids) || {}) : {};
          }
          scheduleRefresh(60);
        } catch (_) {}
      }

      const overlay = document.createElement('div');
      overlay.id = 'bookmarksOverlay';   // keeps the swipe-block + dismiss conventions
      overlay.classList.add('kai-ai-page');   // stats.js: AI-material time tracking (Timeline & Scenes panel)
      // Match the Characters screen: a centered card over a dimmed backdrop, inset from
      // the safe area, so on Android it sits BELOW the status bar instead of full-bleed
      // over it (a top-anchored full-screen panel put its header under the status bar).
      // z 9000 (NOT higher): the feed's summary text is dict-tappable and the dict
      // popup sits at 9999 — the panel must stay below it. The scene card
      // (#kchapterView, also 9000) stacks above as a later body child.
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 0 calc(8px + env(safe-area-inset-bottom, 0px));';
      const panel = document.createElement('div');
      panel.style.cssText =
        'background:#0d0d12;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(96vw,860px);height:96vh;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';

      const tlScrollKey = 'TL_SCROLL_V1_' + titleId;   // per-title reopen spot
      function destroy() {
        // Remember the spot for next open (row idx + offset within it) — the
        // panel used to reopen centered on the CURRENT chapter, dumping the
        // user far from where they were reading the feed.
        try {
          const a = captureScrollAnchor();
          if (a) localStorage.setItem(tlScrollKey, JSON.stringify(a));
          else localStorage.removeItem(tlScrollKey);
        } catch (_) {}
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        if (_imgPoll) { clearInterval(_imgPoll); _imgPoll = null; }
        if (_posTimer) { clearInterval(_posTimer); _posTimer = null; }
        try { if (_readObs) { _readObs.disconnect(); _readObs = null; } } catch (_) {}
        try { if (_imgObs) { _imgObs.disconnect(); _imgObs = null; } } catch (_) {}
        try { if (_smRaf != null) { cancelAnimationFrame(_smRaf); _smRaf = null; } } catch (_) {}
        // a feed-started scene clip must not outlive the panel (stops + resumes the book)
        try { clipDispose(); } catch (_) {}
        // a feed-started quote passage must not outlive the panel either — it
        // moved the SHARED playhead, so skipping its snapshot restore here
        // would strand the book at the quote's position (place loss).
        try { stopPassage(); } catch (_) {}
        // release the shared trim waveform if a feed scene holds it (never touch
        // a scene card's — _feedWfHost is null whenever the card owns it)
        try { if (_feedWfHost && !document.getElementById('kchapterView')) { window.waveform && window.waveform.hide && window.waveform.hide(); } _feedWfHost = null; } catch (_) {}
        try { document.removeEventListener('visibilitychange', onPanelVis); } catch (_) {}
        try { window.removeEventListener('kai:ai-data', onData); } catch (_) {}
        try { window.removeEventListener('kai:scenes-changed', onData); } catch (_) {}
        try { window.removeEventListener('kai:img-data', refreshSceneHave); } catch (_) {}
        try { const wf = document.getElementById('liveWaveform'); if (wf && overlay._kaiWfHidden) wf.style.display = overlay._kaiWfPrev || ''; } catch (_) {}
        try { overlay.remove(); } catch (_) {}
      }

      // Feed summary font scale (persisted, global): multiplies the card font
      // size. Default slightly smaller than card mode; − / + in the header.
      let _fontScale = parseFloat(localStorage.getItem('TL_FONT_SCALE_V1'));
      if (!Number.isFinite(_fontScale) || _fontScale <= 0) _fontScale = 0.85;
      // Pictures show/hide (persisted, global). Hidden = frames display:none via
      // CSS (captions/quotes stay) AND image bytes aren't fetched — pending
      // loads run when toggled back on.
      let _picsHidden = false;
      try { _picsHidden = localStorage.getItem('TL_PICS_HIDDEN_V1') === '1'; } catch (_) {}
      ensureTlPicsStyle();

      // header
      const head = document.createElement('div');
      head.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #222;';   // card is already inset below the safe area
      const title = document.createElement('div');
      title.style.cssText = 'flex:1;min-width:0;font-weight:600;color:#eee;font-size:1rem;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      title.textContent = window.i18n.t('tl.title', 'Timeline & Scenes');
      const mkBtn = (txt, fn, dim) => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'background:#1c1c24;border:1px solid #333;border-radius:8px;' +
          'color:' + (dim ? '#777' : '#ccc') + ';font-size:1.4rem;padding:6px 14px;cursor:pointer;';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      head.appendChild(title);
      // pictures on/off (dimmed label = hidden)
      const picsBtn = document.createElement('button');
      const paintPicsBtn = () => {
        picsBtn.textContent = window.i18n.t('tl.pics', '画像');
        picsBtn.style.cssText = 'background:#1c1c24;border:1px solid #333;border-radius:8px;' +
          'color:' + (_picsHidden ? '#666' : '#ccc') + ';font-size:.9rem;padding:11px 12px;cursor:pointer;line-height:1.2;' +
          (_picsHidden ? 'text-decoration:line-through;' : '');
      };
      paintPicsBtn();
      picsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _picsHidden = !_picsHidden;
        try { localStorage.setItem('TL_PICS_HIDDEN_V1', _picsHidden ? '1' : '0'); } catch (_) {}
        overlay.classList.toggle('tl-nopics', _picsHidden);
        paintPicsBtn();
        if (!_picsHidden) {
          // frames are visible again — fetch the bytes deferred while hidden
          try {
            for (const f of inner.querySelectorAll('.kai-img-lazy')) {
              if (f._kaiImgPending) { const fn = f._kaiImgPending; f._kaiImgPending = null; try { fn(); } catch (_) {} }
            }
          } catch (_) {}
        }
      });
      head.appendChild(picsBtn);
      // Vocab review (in-app SRS) — label carries the due count when > 0.
      const srsHdrBtn = document.createElement('button');
      srsHdrBtn.style.cssText = 'background:#1c1c24;border:1px solid #333;border-radius:8px;' +
        'color:#cbbfee;font-size:.9rem;padding:11px 12px;cursor:pointer;line-height:1.2;';
      srsHdrBtn.textContent = window.i18n.t('vs.review_btn', '語彙');
      srsHdrBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        try { window.vocabSrs && window.vocabSrs.openHub(); } catch (_) {}
      });
      (async () => {
        try {
          const c = await window.vocabSrs?.counts?.();
          if (c && c.due > 0) {
            srsHdrBtn.textContent = window.i18n.t('vs.review_btn', '語彙') + ' ' + c.due;
            srsHdrBtn.style.borderColor = '#463a6b';
          }
        } catch (_) {}
      })();
      head.appendChild(srsHdrBtn);
      // − / + adjust the summary text size (anchor-preserving re-render)
      const setScale = (d) => {
        _fontScale = Math.max(0.6, Math.min(1.3, Math.round((_fontScale + d) * 100) / 100));
        try { localStorage.setItem('TL_FONT_SCALE_V1', String(_fontScale)); } catch (_) {}
        render();
      };
      const mkSmBtn = (txt, fn) => { const b = mkBtn(txt, fn); b.style.padding = '6px 11px'; return b; };
      head.appendChild(mkSmBtn('−', () => setScale(-0.08)));
      head.appendChild(mkSmBtn('+', () => setScale(0.08)));
      // visionOS: pop this panel out into its own window (panel-bridge.js).
      // Null off Vision, so the header is unchanged everywhere else. Popping
      // out tears the in-window copy down — the window IS the panel now.
      try {
        const po = window.kadokiPanel && window.kadokiPanel.makeButton
          ? window.kadokiPanel.makeButton('timeline', () => destroy()) : null;
        if (po) head.appendChild(po);
      } catch (_) {}
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
        'touch-action:pan-y;overscroll-behavior:contain;';   // dropped -webkit-overflow-scrolling:touch (iOS legacy re-rastering scroll layer)
      // Stamp scroll activity: the live-marker timer (and the img-data re-render)
      // must not force a synchronous layout read while the finger is moving — on
      // iOS that stalls the separate momentum-scroll thread = a hitch every tick.
      let _lastScrollTs = 0;
      // _kaiTlScrollTs: ai-processor's uiBusy() reads this to defer the chapter
      // pump while the user is actively reading/scrolling the feed. TOUCH-driven
      // (not scroll events) so programmatic scrolls don't count as user activity.
      let _userTouchTs = 0;
      let _smRaf = null;
      main.addEventListener('scroll', () => {
        _lastScrollTs = Date.now();
        // live axis marker follows the feed scroll (one rAF-throttled style write)
        if (_smRaf == null) _smRaf = requestAnimationFrame(() => { _smRaf = null; updateScrollMarker(); });
      }, { passive: true });
      main.addEventListener('touchstart', () => { _userTouchTs = Date.now(); window._kaiTlScrollTs = _userTouchTs; }, { passive: true });
      main.addEventListener('touchmove', () => { _userTouchTs = Date.now(); window._kaiTlScrollTs = _userTouchTs; }, { passive: true });
      const inner = document.createElement('div');
      inner.style.cssText = 'position:relative;width:100%;';
      main.appendChild(inner);
      bodyRow.appendChild(main);
      panel.appendChild(bodyRow);


      overlay.appendChild(panel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy(); });   // tap outside the card closes (like Characters)
      overlay._kaiDestroy = destroy;   // replace-path teardown (openPanel over an open panel)
      overlay.classList.toggle('tl-nopics', _picsHidden);
      document.body.appendChild(overlay);

      // Backgrounded mid-clip (feed ▶): dispose at once so the durable position
      // saves capture the user's real place, not a dangling clip player.
      // Backgrounded mid-clip/mid-passage: restore at once so the app's durable
      // position saves capture the user's real place, not the excerpt spot.
      function onPanelVis() { if (document.hidden) { try { clipDispose(); } catch (_) {} try { stopPassage(); } catch (_) {} } }
      document.addEventListener('visibilitychange', onPanelVis);

      // Idle the live audio waveform canvas while this list is open — SAME iOS jank
      // fix the chapter view and scene card already use: it keeps redrawing behind
      // the translucent overlay, forcing iOS to recomposite the momentum-scroll list
      // every frame. Occluded anyway; audio playback/playhead untouched. Restored in destroy().
      try {
        const wf = document.getElementById('liveWaveform');
        if (wf) { overlay._kaiWfPrev = wf.style.display; overlay._kaiWfHidden = true; wf.style.display = 'none'; }
      } catch (_) {}

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
      // Lowest chapter idx whose summary exists but hasn't been opened — the
      // "continue reading here" marker. O(chapters) scan, trivial at list size.
      function aiFirstUnreadIdx() {
        try {
          const idxs = Object.keys(arts || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
          for (const i of idxs) {
            const a = arts[i];
            if (!hasSummary(a)) continue;
            if (a.ahead) {   // generated ahead — hidden until reached, never "unread"
              const ch = (map && Array.isArray(map.chunks)) ? map.chunks.find(c => c && c.idx === i) : null;
              if (ch && !chapterReached(map, ch)) continue;
            }
            if (!_aiRead.ch[i]) return i;
          }
        } catch (_) {}
        return -1;
      }
      // 'read' | 'next' (continue here) | 'unread' | null (no summary yet).
      function aiReadMarkFor(idx, art) {
        if (!hasSummary(art)) return null;
        if (_aiRead.ch[idx]) return 'read';
        return idx === aiFirstUnreadIdx() ? 'next' : 'unread';
      }
      // Small marker element for a chapter row/card meta line. Email-style:
      // unread = conspicuous BLUE dot (+ blue "continue" pill on the first
      // unread); read = quiet green check. Titles bold/dim to match (the
      // builders read the mark via aiReadMarkFor).
      function aiReadMarkEl(mark) {
        if (!mark) return null;
        const el = document.createElement('span');
        if (mark === 'read') {
          el.textContent = '✓';
          el.style.cssText = 'flex:none;color:#5f8f6a;font-size:.8rem;font-weight:700;line-height:1;';
        } else if (mark === 'next') {
          el.textContent = '● ' + window.i18n.t('tl.continue', '続きから');
          el.style.cssText = 'flex:none;color:#cfe4ff;font-size:.68rem;font-weight:800;' +
            'background:rgba(61,132,255,.24);border:1px solid #3d84ff;border-radius:999px;padding:1px 9px;';
        } else {
          el.textContent = '●';
          el.style.cssText = 'flex:none;color:#3d9bff;font-size:.9rem;line-height:1;';
        }
        return el;
      }
      const aiUnreadMark = (mark) => mark === 'next' || mark === 'unread';

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

      // Feed model: a summarized chapter shows EVERYTHING inline (full summary +
      // scene images), so its row has no tap at all — nothing opens, nothing
      // destroys the panel. The only remaining tap is generate/retry on a fully
      // read (or failed) chapter that lacks a summary.
      function makeChapterTap(ch, art, complete, reached) {
        if (hasSummary(art)) return null;
        const state = ch.state || 'none';
        // Generatable once ARRIVED at, matching processChapter's own gate. The
        // spoiler confirm inside the row still keys off `complete`, so building
        // a summary for the chapter you're mid-way through asks first.
        if (complete || reached || state === 'failed') {
          return () => regenChapter(ch);
        }
        return null;
      }

      // Navigate the book to a chapter's start: seek the audio to its first cue
      // (if mapped + loaded) and jump the reader to its first chunk. Explicit
      // user navigation, so a deliberate position change is fine.
      async function jumpToChapter(ch) {
        try {
          // reused rows capture an old chunk object — resolve the live one
          try { const live = _chById && _chById.get(String(ch.idx)); if (live) ch = live; } catch (_) {}
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
                window._audioStatsSeekTs = Date.now();   // jumped-over span wasn't heard — stats anchor, don't credit
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

      // ---- Chapter LIST (redesign) -------------------------------------------------
      // A flat, scrollable list — one row per chapter (number + start-char + title +
      // 1-line summary + 新着/✦ scene badge + jump). Tap → the chapter card (which
      // holds the scene images). No proportional spine / pinch-zoom (those clipped
      // text + were awkward); the char-count is printed per row instead of as a scale.
      let _curRowEl = null;
      let _chById = null;          // chIdx (string) → chunk, for the axis scroll marker
      let _scrollMarkerEl = null;  // amber viewport marker on the coverage axis
      let _feedWfHost = null;      // the ONE feed scene currently holding the shared trim waveform
      // Per-title collapsed chapters (▸/▾ triangle). A collapsed section hides
      // its body AND its read sentinel — scrolling past it never marks it read.
      const collKey = 'TL_COLLAPSED_V1_' + titleId;
      let _collapsed = new Set();
      try { const a = JSON.parse(localStorage.getItem(collKey) || '[]'); if (Array.isArray(a)) _collapsed = new Set(a.map(Number)); } catch (_) {}
      const saveCollapsed = () => { try { localStorage.setItem(collKey, JSON.stringify(Array.from(_collapsed))); } catch (_) {} };
      // Row reconciliation cache: idx → {sig, el}. Background refreshes rebuild
      // ONLY rows whose data changed; reused rows keep their decoded images,
      // filled quote boxes and expander state — the fix for the feed "flowing
      // in"/shifting under the reader on every kai:ai-data / img event.
      const _rowCache = new Map();
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
            else if (Number.isFinite(f.ms) && typeof axis.msToChars === 'function') furthestP = axis.msToChars(f.ms);
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
            wrap.className = 'kai-axis-marker';
            wrap.style.cssText = 'position:absolute;left:-4px;right:-4px;top:calc(' + pcv(curP).toFixed(2) + '% - 1.5px);height:3px;border-radius:2px;background:#fff;z-index:5;pointer-events:none;';
            const ball = document.createElement('div');
            ball.className = 'kai-now-glow';   // box-shadow glow + composited opacity/scale pulse
            ball.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:9px;height:9px;border-radius:50%;background:#fff;';
            wrap.appendChild(ball);
            axisWrap.appendChild(wrap);
            _nowMarkerEl = wrap;
          }
          // amber viewport marker: where the feed section you're LOOKING AT
          // sits in the book — tracks the scroll live (updateScrollMarker)
          const sm = document.createElement('div');
          sm.className = 'kai-axis-marker';
          sm.style.cssText =
            'position:absolute;left:-3px;right:-3px;height:11px;margin-top:-5.5px;' +
            'border:1.5px solid rgba(200,162,58,.95);border-radius:4px;background:rgba(200,162,58,.16);' +
            'z-index:4;pointer-events:none;top:0;display:none;box-sizing:border-box;';
          axisWrap.appendChild(sm);
          _scrollMarkerEl = sm;
          updateScrollMarker();
        } catch (_) {}
      }

      // Map the row under the viewport's upper focus point (plus the fraction
      // scrolled through it) to book-axis units and move the amber marker there.
      // One style write per scroll frame; offsetTop reads are cheap mid-scroll
      // (layout is clean).
      function updateScrollMarker() {
        try {
          if (!_scrollMarkerEl || !axis || !axis.total) return;
          const focusY = main.scrollTop + Math.min(140, main.clientHeight * 0.3);
          let row = null;
          for (const r of inner.children) {
            if (!r.dataset || r.dataset.chIdx == null) continue;
            if (r.offsetTop + r.offsetHeight > focusY) { row = r; break; }
          }
          const ch = (row && _chById) ? _chById.get(row.dataset.chIdx) : null;
          if (!ch) { _scrollMarkerEl.style.display = 'none'; return; }
          const a = axis.chStart(ch), b = axis.chEnd(ch);
          const frac = Math.max(0, Math.min(1, (focusY - row.offsetTop) / Math.max(1, row.offsetHeight)));
          const p = (Number.isFinite(a) && Number.isFinite(b) && b > a) ? (a + frac * (b - a)) : a;
          if (!Number.isFinite(p)) { _scrollMarkerEl.style.display = 'none'; return; }
          const pct = (Math.max(0, Math.min(axis.total, p)) / axis.total) * 100;
          _scrollMarkerEl.style.display = 'block';
          _scrollMarkerEl.style.top = pct.toFixed(2) + '%';
        } catch (_) {}
      }
      function buildChapterRow(ch, art, complete, prog, onTap, isCur, pos) {
        const idx = ch.idx;
        const state = ch.state || 'none';
        const unread = !complete && !art && state === 'none';
        const hasSum = hasSummary(art);
        const label = (art && art.label) || ch.label || window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
        const stat = _sceneStat[idx] || null;
        const row = document.createElement('div');
        row.className = 'menu-item';
        row.dataset.chIdx = String(idx);   // scroll-anchor + read-sentinel key
        row.style.cssText =
          'position:relative;margin:0 0 ' + (hasSum ? '18px' : '8px') + ';padding:11px 13px;border-radius:10px;box-sizing:border-box;' +
          'background:' + (isCur ? '#1c1830' : '#16161d') + ';' +
          'border:1px solid ' + (isCur ? '#5a4f8c' : '#26262e') + ';' +
          // NO content-visibility on feed sections OR any row carrying images:
          // their real height dwarfs any estimate, and the late materialization
          // was the scroll jitter + reopen jump around pictures. Layout cost is
          // one-time at open; image DECODE stays lazy via the feed image
          // observer. Plain compact rows keep the cheap skip (they match their
          // estimate).
          ((hasSum || ((_sceneSlotStat['scene_' + idx] || {}).images || 0) > 0) ? '' : 'content-visibility:auto;contain-intrinsic-size:auto 88px;') +
          'touch-action:pan-y;' + (onTap ? 'cursor:pointer;' : '') + (unread ? 'opacity:.6;' : '');
        const isColl = hasSum && _collapsed.has(idx);
        // IN-PLACE collapse: assigned at the end of this builder (needs body/
        // preview). No re-render and no scroll writes — the tapped point
        // physically cannot move; only content BELOW the card reflows.
        let toggleColl = () => {};
        // meta line (wraps so the current-chapter summary button never overflows)
        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:3px;';
        let tri = null;
        if (hasSum) {
          // collapse triangle — collapsed sections show only their header and
          // are exempt from scroll-to-read marking
          tri = document.createElement('button');
          tri.textContent = isColl ? '▸' : '▾';
          tri.style.cssText = 'flex:none;background:none;border:none;color:#b0aacb;font-size:1.9rem;padding:8px 18px 8px 4px;cursor:pointer;line-height:1;';
          tri.addEventListener('click', (e) => { e.stopPropagation(); toggleColl(); });
          meta.appendChild(tri);
        }
        const num = document.createElement('span');
        num.style.cssText = 'flex:none;color:' + (art && complete ? '#a594e6' : '#888') + ';font-size:' + (hasSum ? '.86rem' : '.74rem') + ';font-weight:800;';
        num.textContent = window.i18n.fmt('tl.chapter_n', { n: idx + 1 }, '第' + (idx + 1) + '章');
        meta.appendChild(num);
        // AI-content read state: ✓ read / ● unread (blue) / ●続きから first-unread.
        const _aiMark = aiReadMarkFor(idx, art);
        const _rm = aiReadMarkEl(_aiMark);
        if (_rm) { meta.appendChild(_rm); row._kaiMarkEl = _rm; }   // swapped in place when the read sentinel fires
        const cc = document.createElement('span');
        cc.style.cssText = 'flex:1;min-width:0;color:#6a6a76;font-size:.68rem;';
        cc.textContent = (axis && axis.isTime)
          ? window.i18n.fmt('tl.time_from', { t: fmtDur(axis.chStart(ch)) }, fmtDur(axis.chStart(ch)) + '〜')
          : window.i18n.fmt('tl.chars_from', { n: (Number.isFinite(ch.jpStart) ? ch.jpStart.toLocaleString() : '0') }, (Number.isFinite(ch.jpStart) ? ch.jpStart.toLocaleString() : '0') + '字〜');
        meta.appendChild(cc);
        if (isCur) {
          const now = document.createElement('span');
          now.style.cssText = 'flex:none;background:#2a2440;border:1px solid #5a4f8c;color:#cbbfee;font-size:.62rem;padding:1px 7px;border-radius:8px;';
          now.textContent = window.i18n.t('tl.now', 'いま');
          meta.appendChild(now);
        }
        if (!hasSum && stat && stat.images > 0) {
          const b = document.createElement('span');
          b.style.cssText = 'flex:none;color:#c8a23a;font-size:.82rem;line-height:1;';
          b.textContent = '✦';
          meta.appendChild(b);
        }
        if (hasSum && window.aiExport && window.aiExport.chapterText) {
          const cp = document.createElement('button');
          cp.textContent = '⧉';
          cp.title = window.i18n.t('tl.copy_chapter_summary', 'Copy chapter summary');
          cp.style.cssText = 'flex:none;background:none;border:1px solid #3a3450;border-radius:8px;color:#aab4dd;font-size:1.05rem;padding:6px 13px;cursor:pointer;line-height:1.2;';
          cp.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const ok = await window.aiExport.copyText(window.aiExport.chapterText(art, ch, idx + 1));
              window.aiExport.toast(ok ? window.i18n.t('tl.copied', 'Copied') : window.i18n.t('tl.copy_failed', 'Copy failed'));
            } catch (_) {}
          });
          meta.appendChild(cp);
        }
        // Rebuild: regenerate an EXISTING summary (e.g. into the new narrative-
        // blocks format). Explicit confirm — it re-bills the chapter. discard
        // strips the old summary so the billing backstop can't re-adopt it;
        // scenes + their images are preserved (processChunk regen guard).
        if (hasSum && window.aiProcessor && typeof window.aiProcessor.processChapter === 'function') {
          const rb = document.createElement('button');
          rb.textContent = '⟲';
          rb.title = window.i18n.t('tl.regen_summary', 'Rebuild this chapter summary');
          rb.style.cssText = 'flex:none;background:none;border:1px solid #3a3450;border-radius:8px;color:#aab4dd;font-size:1.05rem;padding:6px 13px;cursor:pointer;line-height:1.2;';
          rb.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm(window.i18n.t('tl.regen_summary_confirm', 'この章の要約をAIで作り直しますか？（API利用料がかかります）'))) return;
            rb.disabled = true;
            try {
              // forceUnread: the spoiler was accepted when this summary was first
              // generated; without it a previously force-generated chapter would
              // bounce off the completeness guard.
              const r = await window.aiProcessor.processChapter(titleId, ch.idx, { force: true, discard: true, forceUnread: true });
              if (r && r.ok !== false) {
                try { window.showToast && window.showToast(window.i18n.t('tl.generating_summary', '要約を生成中…'), 2500); } catch (_) {}
                scheduleRefresh(600);
              } else rb.disabled = false;
            } catch (_) { rb.disabled = false; }
          });
          meta.appendChild(rb);
        }
        // Force-generate: summarize this chapter NOW even if it doesn't register
        // as read (watch listening advances the book without painting coverage).
        // Explicit spoiler confirm when the tracker says it's unfinished.
        if (!hasSum && state !== 'processing' && state !== 'queued' &&
            window.aiProcessor && typeof window.aiProcessor.processChapter === 'function') {
          const gb = document.createElement('button');
          const gbLabel = '✦ ' + window.i18n.t('common.generate', '生成');
          gb.textContent = gbLabel;
          gb.style.cssText = 'flex:none;background:#191425;border:1px solid #463a6b;border-radius:7px;color:#d6c8ff;font-size:.68rem;padding:2px 9px;cursor:pointer;line-height:1.2;';
          gb.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!complete && !window.confirm(window.i18n.t('tl.spoiler_confirm', 'この章はまだ読み終えていません。要約にはネタバレが含まれる可能性があります。生成しますか？'))) return;
            gb.disabled = true;
            gb.textContent = window.i18n.t('tl.thinking', '考え中…');
            try {
              const r = await window.aiProcessor.processChapter(titleId, ch.idx, { force: true, forceUnread: true });
              if (r && r.ok !== false) {
                try { window.showToast && window.showToast(window.i18n.t('tl.generating_summary', '要約を生成中…'), 2500); } catch (_) {}
                scheduleRefresh(600);
              } else {
                gb.disabled = false;
                gb.textContent = gbLabel;
              }
            } catch (_) { gb.disabled = false; gb.textContent = gbLabel; }
          });
          meta.appendChild(gb);
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
            // live position — a reused row's closure `pos` can be stale
            try { const lp = currentAxisPos(axis); if (lp !== null && Number.isFinite(lp)) pos = lp; } catch (_) {}
            // Cue space: b must be a CUE INDEX like a — derive it from the
            // live cue cursor, never from the axis position (axis units are
            // chars/ms, not indices).
            let bPos = pos;
            if (space === 'cue') {
              bPos = (Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0)
                ? window._lastAudioCueIdx
                : ((typeof window._srtCardToCueAnchor === 'function' && Number.isFinite(window.currentCardIndex))
                    ? window._srtCardToCueAnchor(window.currentCardIndex) : null);
              if (!Number.isFinite(bPos)) bPos = Number.isFinite(ch.cueEnd) && ch.cueEnd >= 0 ? ch.cueEnd : a;
            }
            try { window.aiSummary.summarizeRange({ space, a, b: bPos, mode: 'read' }); } catch (_) {}
          });
          meta.appendChild(sumBtn);
        }
        row.appendChild(meta);
        // title — email-style weight: unread AI content bold+bright, read dimmed.
        // Feed sections get a LARGE title (the chapter boundary must read at a
        // glance while scrolling one continuous feed).
        const titleEl = document.createElement('div');
        const _tw = aiUnreadMark(_aiMark) ? 800 : (_aiMark === 'read' ? 600 : 700);
        const _tc = aiUnreadMark(_aiMark) ? '#ffffff' : (_aiMark === 'read' ? '#b4b4c0' : (unread ? '#aaa' : '#f0f0f0'));
        titleEl.style.cssText = 'font-weight:' + _tw + ';font-size:' + (hasSum ? '1.34rem' : '1.08rem') + ';line-height:1.28;color:' + _tc + ';' +
          (hasSum ? 'margin-top:2px;' : '');   // underline/padding applied by applyColl (expanded only)
        titleEl.textContent = label;
        if (hasSum) {
          // the TITLE toggles collapse in BOTH directions (triangle works too)
          titleEl.style.cursor = 'pointer';
          titleEl.addEventListener('click', (e) => { e.stopPropagation(); toggleColl(); });
        }
        row.appendChild(titleEl);
        // hasSum rows render BOTH forms and toggle visibility in place:
        // preview = the collapsed 2-line teaser; body = the full feed section.
        let body = null, preview = null;
        if (hasSum) {
          preview = document.createElement('div');
          preview.style.cssText = 'margin-top:3px;font-size:.86rem;line-height:1.45;color:#b0b0b8;' +
            'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
          preview.textContent = (art && art.shortSummary) || '';
          row.appendChild(preview);
          body = document.createElement('div');
          row.appendChild(body);
        }
        if (hasSum) {
          // FULL summary text — the feed IS the chapter view now. Dict enablement
          // happens in render() and is applied ONLY to these leaf text divs (the
          // chapter-view invariant: never containers with buttons).
          const prose = (text, extra) => {
            const d = document.createElement('div');
            d.className = 'kai-summary-text';   // squiggle-marking + dict target
            d.style.cssText =
              'color:#d6d6de;font-family:var(--font-family-card);' +
              'font-size:calc(var(--font-size-card) * ' + _fontScale + ');' +
              'line-height:1.7;white-space:pre-wrap;' + (extra || '');
            d.textContent = text || '';
            return d;
          };
          const blocksEl = buildSummaryBlocks(art, prose, titleId, ch.idx, ch);
          const longText = blocksEl ? '' : (paragraphize(art.longSummary || '') || art.shortSummary || '');
          if (blocksEl) {
            blocksEl.style.marginTop = '10px';
            body.appendChild(blocksEl);
          } else if (longText.length > 700 && art.mediumSummary) {
            // legacy artifact (old 600-1500字 long): medium teaser + expander so
            // one chapter doesn't dump a wall of text into the feed
            body.appendChild(prose(paragraphize(art.mediumSummary), 'margin-top:6px;'));
            const fullEl = prose(longText, 'display:none;margin-top:10px;');
            const btn = document.createElement('button');
            btn.textContent = window.i18n.t('tl.show_full_text', '全文を表示');
            btn.style.cssText =
              'display:block;margin:8px 0 0;background:#1c1c24;border:1px solid #333;' +
              'border-radius:8px;color:#aab4dd;font-size:.78rem;padding:6px 14px;cursor:pointer;';
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const open = fullEl.style.display === 'none';
              fullEl.style.display = open ? '' : 'none';
              btn.textContent = open ? window.i18n.t('tl.hide_full_text', '全文を閉じる') : window.i18n.t('tl.show_full_text', '全文を表示');
            });
            body.appendChild(btn);
            body.appendChild(fullEl);
          } else {
            body.appendChild(prose(longText, 'margin-top:6px;'));
          }
        } else {
          // compact row (unsummarized chapter, or a COLLAPSED section): 2-line clamp.
          // A collapsed section previews its own summary — never a state prompt.
          let sc = '#b0b0b8', stext = '';
          if (art && art.shortSummary) { stext = art.shortSummary; }
          else if (state === 'processing') { stext = window.i18n.t('tl.creating_ai_summary', 'AI要約を作成中…'); sc = '#cbbfee'; }
          else if (state === 'queued') { stext = window.i18n.t('tl.queued_waiting', '待機中…'); sc = '#888'; }
          else if (state === 'failed') {
            // While the bounded auto-retry is still armed for this transient
            // failure, say so honestly instead of asking for a tap.
            const autoRetrying = !!(window.aiProcessor && window.aiProcessor.autoRetryState &&
                                    window.aiProcessor.autoRetryState(titleId, ch) === 'retrying');
            if (autoRetrying) {
              stext = window.i18n.t('tl.failed_retrying', '失敗 — 自動再試行中');
            } else {
              // Surface WHY it failed (the request path captures it on the chunk) so a
              // transient API hiccup (rate limit / overload / network) reads clearly
              // instead of a bare "失敗".
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
            }
            sc = '#e08a8a';
          }
          else if (complete) { stext = window.i18n.t('tl.tap_to_generate', 'タップして要約を生成'); sc = '#8a7fb8'; }
          else { stext = (prog.pct > 0.02 ? window.i18n.fmt('tl.pct_read', { n: Math.round(prog.pct * 100) }, Math.round(prog.pct * 100) + '% 読了') : window.i18n.t('tl.unread', '未読')); sc = '#666'; }
          const sub = document.createElement('div');
          sub.style.cssText = 'margin-top:3px;font-size:.86rem;line-height:1.45;color:' + sc + ';' +
            'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
          sub.textContent = stext;
          row.appendChild(sub);
        }
        // chapter progress bar — coverage within [jpStart,jpEnd], colored by
        // modality. COMPACT rows only: inside a full feed section it read as a
        // stray "fragmented dashed line" floating between text and pictures.
        if (!hasSum && prog && prog.pct > 0) {
          const bar = document.createElement('div');
          bar.style.cssText = 'margin-top:7px;height:3px;background:#26262e;border-radius:2px;overflow:hidden;position:relative;';
          const a = axis.chStart(ch), b = axis.chEnd(ch);
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
        // ---- scenes: full-width images inline in the feed ---------------------------
        // A rendered scene shows as a full-width image + caption; tap stacks the
        // scene card OVER the still-open panel (Anki send / trim / regenerate),
        // so closing it lands back on the untouched, un-scrolled feed. A scene
        // without an image stays a compact 生成 row.
        const scenes = (art && Array.isArray(art.scenes)) ? art.scenes : [];
        if (scenes.length) {
          const sceneBox = document.createElement('div');
          sceneBox.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:10px;';
          scenes.forEach((scn, s) => {
            const sCharId = 'scene_' + idx + '_' + s;
            const sst = _sceneSlotStat[sCharId] || null;
            const has = !!(sst && sst.images > 0);
            const pending = !!(sst && sst.pending > 0);
            const capText = scn.caption || scn.title || window.i18n.fmt('tl.scene_n', { n: s + 1 }, 'シーン ' + (s + 1));
            // Everything scene-related lives inline now — tapping the image
            // opens the full-screen VIEWER (pinch-zoom lightbox) with delete /
            // regenerate / OpenRouter model picker, not the old scene card.
            const buildViewerFooter = (ctx, commitRef) => {
              const bar = document.createElement('div');
              bar.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;width:min(94vw,660px);max-height:34vh;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 6px 2px;';
              // ---- book passage + trim waveform + ▶ / Send-to-Anki ----------
              // Moved INTO the viewer (feed rows are caption-only now): the
              // passage is the actual book text the scene's audio plays.
              const qwrap = document.createElement('div');
              qwrap.style.cssText = 'display:none;width:100%;box-sizing:border-box;background:#191722;border-radius:8px;box-shadow:inset 3px 0 0 #6f5fc0;padding:9px 12px;max-height:16vh;overflow-y:auto;-webkit-overflow-scrolling:touch;';
              qwrap.addEventListener('click', (e2) => { e2.stopPropagation(); });
              const qt = document.createElement('div');
              qt.className = 'kai-summary-text';
              qt.style.cssText = 'color:#cfcbdd;font-family:var(--font-family-card);' +
                'font-size:calc(var(--font-size-card) * ' + (_fontScale * 0.95) + ');line-height:1.7;white-space:pre-wrap;text-align:left;';
              qwrap.appendChild(qt);
              bar.appendChild(qwrap);
              (async () => {
                try {
                  const loc = await sceneLoc(titleId, ch, scn, sCharId);
                  if (loc && loc.expression && qt.isConnected) {
                    qt.textContent = loc.expression;
                    qwrap.style.display = '';
                    try { if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(qt); } catch (_) {}
                  }
                } catch (_) {}
              })();
              const wfHost = document.createElement('div');
              wfHost.style.cssText = 'display:none;width:100%;';
              wfHost.addEventListener('click', (e2) => { e2.stopPropagation(); });
              bar.appendChild(wfHost);
              const showWf = async () => {
                const info = await sceneClipInfo(titleId, ch, scn, sCharId);
                if (!info.bounds || !info.srcPath || !(window.waveform && window.waveform.show)) return info;
                if (_feedWfHost === wfHost) return info;   // already ours
                try { window.waveform.hide(); } catch (_) {}
                if (_feedWfHost) { try { _feedWfHost.style.display = 'none'; } catch (_) {} }
                window.waveform.show({
                  container: wfHost, srcPath: info.srcPath, startMs: info.bounds.startMs, endMs: info.bounds.endMs,
                  onChange: (nb) => { try { if (nb && Number.isFinite(nb.startMs) && Number.isFinite(nb.endMs) && nb.endMs > nb.startMs) sceneTrimSet(titleId, sCharId, nb.startMs, nb.endMs); } catch (_) {} },
                });
                try { const pp = wfHost.querySelector('[data-role="playpause"]'); if (pp) pp.style.display = 'none'; } catch (_) {}   // ▶ below drives playback
                wfHost.style.display = '';
                _feedWfHost = wfHost;
                return info;
              };
              // live handle drags win over the persisted trim / located range
              const liveBounds = (info) => {
                try { if (_feedWfHost === wfHost && window.waveform && window.waveform.current) { const c = window.waveform.current(); if (c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs) return { startMs: c.startMs, endMs: c.endMs }; } } catch (_) {}
                return info && info.bounds;
              };
              showWf().catch(() => {});   // trim waveform visible on open (no audio → stays hidden)
              const act = document.createElement('div');
              act.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;';
              const pb = document.createElement('button');
              pb.textContent = '▶';
              pb.title = window.i18n.t('tl.listen_scene', '▶ この場面を聴く');
              pb.style.cssText = 'flex:none;background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;font-size:.84rem;padding:6px 13px;cursor:pointer;';
              pb.addEventListener('click', async (e2) => {
                e2.stopPropagation();
                try {
                  const info = await showWf();
                  if (!info.bounds || !info.srcPath) {
                    const msg = !scn.anchorQuote
                      ? window.i18n.t('tl.scene_no_quote', 'この場面には本文の引用がありません（シーン案を作り直すと付きます）。')
                      : window.i18n.t('tl.no_audio', '音声なし');
                    try { window.showToast && window.showToast(msg, 3000); } catch (_) {}
                    return;
                  }
                  clipPlay(liveBounds(info), pb, info.srcPath);
                } catch (_) {}
              });
              act.appendChild(pb);
              const ab = document.createElement('button');
              ab.textContent = window.i18n.t('tl.send_to_anki', 'Ankiに送る');
              ab.style.cssText = 'flex:none;background:#16221a;border:1px solid #2f5a3a;border-radius:8px;color:#9fe0b0;font-size:.8rem;padding:6px 12px;cursor:pointer;';
              ab.addEventListener('click', async (e2) => {
                e2.stopPropagation();
                if (ab.disabled) return;
                ab.disabled = true;
                const orig = ab.textContent;
                ab.textContent = window.i18n.t('tl.anki_preparing', 'Anki準備中…');
                try {
                  // send the image being VIEWED, not blindly the latest one
                  const cur = ctx.current();
                  const sceneUri = (cur && cur.row && cur.row.dataUri) || '';
                  if (!sceneUri) { try { window.showToast && window.showToast(window.i18n.t('tl.generate_image_first', 'まず画像を生成してください'), 3000); } catch (_) {} return; }
                  let t = null; try { t = await window.titleStore.get(titleId); } catch (_) {}
                  const cover = (t && t.attachments && t.attachments.cover && t.attachments.cover.dataUri) || '';
                  let imageData = '';
                  try { imageData = await window.aiImages.compositeScene(sceneUri, cover, (t && t.name) || ''); }
                  catch (_) { try { window.showToast && window.showToast(window.i18n.t('tl.composite_failed', '画像の合成に失敗'), 3000); } catch (_) {} return; }
                  const loc = await sceneLoc(titleId, ch, scn, sCharId);
                  const expression = (loc && loc.expression) || scn.caption || (window.i18n.fmt('tl.scene_n', { n: s + 1 }, 'シーン ' + (s + 1)));
                  let audioData = '', audioNote = '';
                  const info = await sceneClipInfo(titleId, ch, scn, sCharId);
                  const bounds = liveBounds(info);
                  if (!bounds || !info.srcPath) audioNote = window.i18n.t('tl.no_audio', '音声なし');
                  else {
                    audioData = await _sliceToUri(info.srcPath, bounds.startMs, bounds.endMs);
                    if (!audioData) audioNote = window.i18n.t('tl.no_audio', '音声なし');
                  }
                  if (!window.sendToAnki) { try { window.showToast && window.showToast(window.i18n.t('tl.anki_unsupported', 'Anki未対応'), 3000); } catch (_) {} return; }
                  await window.sendToAnki({ expression, imageData, audioData });   // shows its own ✓ Added toast
                  if (!audioData && audioNote) { try { window.showToast && window.showToast(window.i18n.t('tl.anki_sent', 'Ankiに送信しました') + '（' + audioNote + '）', 3000); } catch (_) {} }
                } catch (_) {
                  try { window.showToast && window.showToast(window.i18n.t('tl.anki_send_failed', 'Anki送信に失敗'), 3000); } catch (_) {}
                } finally { ab.disabled = false; ab.textContent = orig; }
              });
              act.appendChild(ab);
              bar.appendChild(act);
              // Delete / Regenerate render as small overlay buttons in the image's
              // own TOP corners (see openLightbox's `corner` return) — kept out of
              // the scrollable footer, and out of the picture's bottom (where the
              // actual scene content usually sits) so they don't obscure it.
              const isOR = !!(window.aiImages.backend && window.aiImages.backend() === 'openrouter');
              let sel = null, alwaysCb = null;
              const prevDefault = (isOR && window.aiImages.openrouterImageModel) ? window.aiImages.openrouterImageModel() : null;
              // "always use this model" → persist as the default. Committed on
              // regenerate AND on viewer close (opts.onClose → commitRef).
              const commitModelPref = () => {
                try {
                  if (!isOR || !sel || !sel.value || !alwaysCb || !alwaysCb.checked) return;
                  const m = (sel._models || []).find(x => x.id === sel.value);
                  if (!prevDefault || prevDefault.id !== sel.value || m) {
                    window.aiImages.setOpenrouterImageModel(m || { id: sel.value, name: sel.value });
                  }
                } catch (_) {}
              };
              commitRef.fn = commitModelPref;
              const del = document.createElement('button');
              del.textContent = window.i18n.t('common.delete', 'Delete');
              del.style.cssText = 'background:rgba(36,19,23,.88);border:1px solid #7c3a42;border-radius:7px;color:#e08a8a;font-size:.7rem;padding:5px 10px;cursor:pointer;';
              del.addEventListener('click', async (e2) => {
                e2.stopPropagation();
                try {
                  const cur = ctx.current();
                  if (!cur || !cur.row) return;
                  if (!window.confirm(window.i18n.t('tl.delete_image_confirm', 'この画像を削除しますか？'))) return;
                  await window.aiImages.deleteImage(titleId, sCharId, cur.row.imgId);
                  ctx.close();
                  scheduleRefresh(120);
                } catch (_) {}
              });
              const rg = document.createElement('button');
              rg.textContent = window.i18n.t('tl.regenerate_image', '再生成');
              rg.style.cssText = 'background:rgba(29,24,48,.88);border:1px solid #463a6b;border-radius:7px;color:#cbbfee;font-size:.7rem;padding:5px 10px;cursor:pointer;';
              rg.addEventListener('click', async (e2) => {
                e2.stopPropagation();
                if (rg.disabled) return;
                rg.disabled = true;
                try {
                  commitModelPref();
                  const r = await window.aiImages.queueSceneFromPrompt(titleId, ch.idx, s, {
                    prompt: scn.prompt, caption: capText, style: scn.style || '', sceneId: scn.id, label: label, force: true,
                    orModel: (isOR && sel && sel.value) ? sel.value : null,
                  });
                  if (r && r.ok) {
                    try { window.aiImages.sync(titleId); } catch (_) {}
                    try { window.showToast && window.showToast(window.i18n.t('tl.generating', '生成中'), 2500); } catch (_) {}
                    ctx.close();
                    scheduleRefresh(200);
                  } else rg.disabled = false;
                } catch (_) { rg.disabled = false; }
              });
              // Model picker groups with Delete/Regenerate (all "regenerate"
              // controls) — rendered as a compact overlay bar centered just
              // above them, not down in the scrollable footer.
              let mrow = null;
              if (isOR) {
                mrow = document.createElement('div');
                mrow.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px 8px;align-items:center;justify-content:center;background:rgba(10,9,16,.78);border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:6px 8px;box-sizing:border-box;';
                mrow.addEventListener('click', (e2) => e2.stopPropagation());
                sel = document.createElement('select');
                sel.style.cssText = 'flex:1;min-width:120px;background:#15151d;border:1px solid #333;border-radius:7px;color:#ddd;font-size:.72rem;padding:5px 6px;';
                const opt0 = document.createElement('option');
                opt0.value = prevDefault ? prevDefault.id : '';
                opt0.textContent = prevDefault ? (prevDefault.name || prevDefault.id) : window.i18n.t('tl.loading_models', 'モデルを読み込み中…');
                sel.appendChild(opt0);
                (async () => {
                  try {
                    const models = await window.aiImages.fetchOpenRouterImageModels();
                    if (!Array.isArray(models) || !models.length || !sel.isConnected) return;
                    sel.innerHTML = '';
                    sel._models = models;
                    for (const m of models) {
                      const o = document.createElement('option');
                      o.value = m.id; o.textContent = m.name || m.id;
                      sel.appendChild(o);
                    }
                    if (prevDefault && models.some(m => m.id === prevDefault.id)) sel.value = prevDefault.id;
                  } catch (_) {}
                })();
                sel.addEventListener('click', (e2) => e2.stopPropagation());
                // Opening/dismissing the native <select> picker sheet can bounce a
                // real tap back onto the image underneath (a genuine tap-to-dismiss-
                // the-sheet that also lands on the page) — suppress the viewer's
                // close-on-tap for a moment around that interaction, the same way
                // the dictionary popup ignores taps that originate from its own
                // pickers, so choosing a model doesn't also close the image window.
                const guardSel = () => { try { ctx.suppressClose && ctx.suppressClose(900); } catch (_) {} };
                sel.addEventListener('pointerdown', guardSel);
                sel.addEventListener('focus', guardSel);
                sel.addEventListener('change', guardSel);
                const lab = document.createElement('label');
                lab.style.cssText = 'display:flex;align-items:center;gap:5px;color:#aab;font-size:.66rem;cursor:pointer;white-space:nowrap;';
                lab.addEventListener('click', (e2) => e2.stopPropagation());
                alwaysCb = document.createElement('input');
                alwaysCb.type = 'checkbox';
                alwaysCb.checked = true;
                alwaysCb.addEventListener('pointerdown', guardSel);
                lab.appendChild(alwaysCb);
                const lt = document.createElement('span');
                lt.textContent = window.i18n.t('tl.always_use_model', 'Always use this model');
                lab.appendChild(lt);
                mrow.appendChild(sel);
                mrow.appendChild(lab);
              }
              return { footer: bar, corner: { left: del, right: rg, below: mrow } };
            };
            const openViewer = async (e) => {
              e.stopPropagation();
              try {
                const rows = await window.aiImages.getImages(titleId, sCharId);
                if (!rows || !rows.length) return;
                const commitRef = { fn: null };
                window.aiImages.openLightbox(rows, rows.length - 1, {
                  titleId, charId: sCharId, interactive: true, fitH: 0.42,
                  onChange: () => { try { scheduleRefresh(150); } catch (_) {} },
                  onClose: () => {
                    try { if (commitRef.fn) commitRef.fn(); } catch (_) {}
                    try { clipStop(); } catch (_) {}
                    // the viewer's waveform host left the DOM with the overlay
                    try { if (_feedWfHost && !_feedWfHost.isConnected) { window.waveform && window.waveform.hide && window.waveform.hide(); _feedWfHost = null; } } catch (_) {}
                  },
                  buildFooter: (ctx) => buildViewerFooter(ctx, commitRef),
                });
              } catch (_) {}
            };
            if (has) {
              const fig = document.createElement('div');
              fig.style.cssText = 'touch-action:pan-y;';
              // fixed aspect frame: the image popping in never reflows the feed
              const frame = document.createElement('div');
              frame.style.cssText = 'width:100%;aspect-ratio:3/2;border-radius:10px;overflow:hidden;background:#0c0c12;border:1px solid #20202c;cursor:pointer;';
              const im = document.createElement('img');
              im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
              im.decoding = 'async';
              frame.appendChild(im);
              frame.addEventListener('click', openViewer);   // full-screen viewer (pinch-zoom / delete / regenerate / model)
              fig.appendChild(frame);
              // caption directly under the image
              const cap = document.createElement('div');
              cap.style.cssText = 'margin-top:5px;font-size:.9rem;line-height:1.55;color:#8f88ab;cursor:pointer;';
              cap.textContent = capText;
              cap.addEventListener('click', openViewer);
              fig.appendChild(cap);
              // Quote / waveform / ▶ / Anki live in the full-screen VIEWER now
              // (buildViewerFooter) — the feed row is just frame + caption, and
              // the caption stays clickable even with pictures hidden. Observed
              // on the FIG (it keeps geometry when the pics toggle hides the
              // frame); image bytes are deferred while pictures are hidden.
              frame.classList.add('tl-imgframe');
              fig.classList.add('kai-img-lazy');
              fig._kaiLoad = async () => {
                const loadImg = async () => { try { const r = await window.aiImages.getLatestImage(titleId, sCharId); if (r) im.src = r.dataUri; } catch (_) {} };
                if (_picsHidden) fig._kaiImgPending = loadImg; else loadImg();
              };
              sceneBox.appendChild(fig);
            } else {
              const sr = document.createElement('div');
              sr.style.cssText = 'display:flex;align-items:center;gap:9px;padding:6px;border-radius:8px;background:#13131a;border:1px solid #20202c;touch-action:pan-y;cursor:pointer;';
              const thumb = document.createElement('div');
              thumb.style.cssText = 'flex:none;width:46px;height:46px;border-radius:7px;background:#0c0c12;display:flex;align-items:center;justify-content:center;font-size:.58rem;text-align:center;line-height:1.2;border:1px dashed #463a6b;color:#9b8fd0;';
              thumb.textContent = pending ? window.i18n.t('tl.generating', '生成中') : window.i18n.t('common.generate', '生成');
              sr.appendChild(thumb);
              const desc = document.createElement('div');
              desc.style.cssText = 'flex:1;min-width:0;font-size:.82rem;line-height:1.4;color:#cdd;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
              desc.textContent = capText;
              sr.appendChild(desc);
              sr.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (pending) return;
                try {
                  const r = await window.aiImages.queueSceneFromPrompt(titleId, ch.idx, s, {
                    prompt: scn.prompt, caption: capText, style: scn.style || '', sceneId: scn.id, label: label,
                  });
                  if (r && r.ok) {
                    thumb.textContent = window.i18n.t('tl.generating', '生成中');
                    try { window.aiImages.sync(titleId); } catch (_) {}
                    try { window.showToast && window.showToast(window.i18n.t('tl.generating', '生成中'), 2000); } catch (_) {}
                  }
                } catch (_) {}
              });
              sceneBox.appendChild(sr);
            }
          });
          (body || row).appendChild(sceneBox);
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
          (body || row).appendChild(mk);
        }
        // Legacy 'scene_<idx>' bucket (old position-based auto-illustrate images):
        // rendered as the SAME fixed-aspect figures as authored scenes — the old
        // buildImageStrip had its own clashing chrome (Delete / model line /
        // "Image caption") AND variable image heights, which was the residual
        // scroll jitter. Count comes from the batched status so placeholders
        // reserve exact space; bytes + captions load on approach.
        const bareN = (_sceneSlotStat['scene_' + idx] && _sceneSlotStat['scene_' + idx].images) || 0;
        if (bareN > 0 && window.aiImages && window.aiImages.getImages) {
          const legacyBox = document.createElement('div');
          legacyBox.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:10px;';
          let rowsP = null;
          const getRows = () => rowsP || (rowsP = window.aiImages.getImages(titleId, 'scene_' + idx).catch(() => []));
          for (let li = 0; li < bareN; li++) {
            const lfig = document.createElement('div');
            lfig.className = 'tl-legacyfig';
            const frame = document.createElement('div');
            frame.className = 'tl-imgframe';
            frame.style.cssText = 'width:100%;aspect-ratio:3/2;border-radius:10px;overflow:hidden;background:#0c0c12;border:1px solid #20202c;';
            const im = document.createElement('img');
            im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
            im.decoding = 'async';
            frame.appendChild(im);
            const lcap = document.createElement('div');
            // fixed 2-line box: the caption arrives async — space is reserved, no reflow
            lcap.style.cssText = 'margin-top:4px;font-size:.92rem;line-height:1.5;color:#a89fc6;height:3em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
            lfig.classList.add('kai-img-lazy');
            lfig._kaiLoad = async () => {
              const loadImg = async () => {
                try {
                  const rows = await getRows();
                  const r = rows && rows[li];
                  if (r) { im.src = r.dataUri; lcap.textContent = r.caption || ''; }
                } catch (_) {}
              };
              if (_picsHidden) lfig._kaiImgPending = loadImg; else loadImg();
            };
            lfig.appendChild(frame);
            lfig.appendChild(lcap);
            legacyBox.appendChild(lfig);
          }
          (body || row).appendChild(legacyBox);
        }
        // Read sentinel: the chapter counts as read once the END of its section
        // has been scrolled into view (observed by render() via _readObs).
        if (hasSum && _aiMark && _aiMark !== 'read') {
          const sent = document.createElement('div');
          sent.className = 'kai-read-sentinel';
          sent.dataset.chIdx = String(idx);
          sent.style.cssText = 'position:absolute;bottom:0;left:0;width:1px;height:1px;pointer-events:none;';
          sent._kaiRow = row;
          body.appendChild(sent);   // collapsed body = display:none = never intersects = never marks read
        }
        if (onTap) row.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
        if (hasSum) {
          const applyColl = (coll) => {
            try {
              if (tri) tri.textContent = coll ? '▸' : '▾';
              if (body) body.style.display = coll ? 'none' : '';
              if (preview) preview.style.display = coll ? '' : 'none';
              titleEl.style.paddingBottom = coll ? '0px' : '7px';
              titleEl.style.borderBottom = coll ? 'none' : '1px solid #2c2c38';
            } catch (_) {}
          };
          toggleColl = () => {
            const coll = !_collapsed.has(idx);
            if (coll) _collapsed.add(idx); else _collapsed.delete(idx);
            saveCollapsed();
            applyColl(coll);
            _rowCache.delete(idx);   // background renders rebuild this row to match
          };
          applyColl(isColl);
          // tap anywhere on a COLLAPSED card to expand (no-op while expanded;
          // inner buttons stopPropagation)
          row.style.cursor = 'pointer';
          row.addEventListener('click', (e) => {
            if (!_collapsed.has(idx)) return;
            e.stopPropagation();
            toggleColl();
          });
        }
        return row;
      }

      // Scroll anchoring: a re-render rebuilds `inner`, which momentarily zeroes
      // the scroll height and CLAMPS main.scrollTop to 0 — the "list jumps to
      // the top when an image lands" jank. Anchor to the row under the viewport
      // top (by chapter idx) instead of a raw pixel offset, so height changes
      // in rows far above don't shift the reading spot either.
      function captureScrollAnchor() {
        // Must succeed for ANY real scroll position, including the very top
        // (st==0 is a legitimate spot to restore, not "nothing to save") and
        // past the last row (iOS rubber-band overscroll can leave scrollTop
        // briefly beyond the scrollable extent — a close tapped right after a
        // scroll/fling, common while reading through consecutive summaries,
        // used to land here). A null return here CLEARS the saved spot
        // entirely (see destroy()) and falls back to centering on the
        // CURRENT audio/read chapter — which, deep into a book, can be far
        // from the feed position the user actually closed at. That fallback
        // mismatch is exactly the "reopens at a different spot, near the
        // end" bug — so this only returns null for a genuinely empty feed.
        try {
          const st = Math.max(0, main.scrollTop);
          let lastRow = null;
          for (const r of inner.children) {
            if (!r.dataset || r.dataset.chIdx == null) continue;
            lastRow = r;
            if (r.offsetTop + r.offsetHeight > st) {
              return { idx: r.dataset.chIdx, delta: Math.max(0, st - r.offsetTop) };
            }
          }
          // scrolled past every row (bottom overscroll) → anchor to the last one
          if (lastRow) return { idx: lastRow.dataset.chIdx, delta: Math.max(0, st - lastRow.offsetTop) };
        } catch (_) {}
        return null;
      }
      function restoreScrollAnchor(a) {
        if (!a || a.idx == null) return false;
        try {
          let row = null;
          for (const r of inner.children) {
            if (r.dataset && r.dataset.chIdx === String(a.idx)) { row = r; break; }
          }
          if (!row) return false;
          // Feed sections render at REAL height (no content-visibility), so a
          // single exact scrollTop set restores the spot — no phased correction
          // (a phased pass was visible as "lands, then jumps").
          const delta = Math.min(Number(a.delta) || 0, Math.max(0, row.offsetHeight - 60));
          main.scrollTop = Math.max(0, row.offsetTop + Math.max(0, delta));
          return true;
        } catch (_) {}
        return false;
      }

      function render() {
        const anchor = captureScrollAnchor();
        // a refresh may destroy the node hosting the shared waveform
        try { if (_feedWfHost) { window.waveform && window.waveform.hide && window.waveform.hide(); _feedWfHost.style.display = 'none'; _feedWfHost = null; } } catch (_) {}
        inner.style.position = 'static';
        inner.style.height = 'auto';
        inner.style.padding = '12px 12px 6px';
        _curRowEl = null;
        const chapters = (map && Array.isArray(map.chunks)) ? map.chunks : null;
        if (!chapters || !chapters.length) {
          const m = document.createElement('div');
          m.style.cssText = 'color:#888;font-size:.9rem;text-align:center;padding:34px 16px;line-height:1.7;';
          m.textContent = window.i18n.t('tl.no_chapters_yet', 'チャプターはまだありません。読み進めると章ごとのカードが表示されます。');
          _rowCache.clear();
          inner.replaceChildren(m);
          renderAxis();
          return;
        }
        // Furthest watermark in AXIS units: jp for char axes, ms for the time
        // axis — prefer the durable furthest.ms (generation-agnostic) over
        // the legacy furthest.cue index.
        const furthestJp = axis.isTime
          ? ((map.furthest && Number.isFinite(map.furthest.ms) && typeof axis.msToChars === 'function')
              ? axis.msToChars(map.furthest.ms)
              : ((map.furthest && Number.isFinite(map.furthest.cue) && map.furthest.cue >= 0) ? axis.cueToChars(map.furthest.cue) : null))
          : ((map.furthest && Number.isFinite(map.furthest.jp)) ? map.furthest.jp : null);
        const curP = currentAxisPos(axis);
        const pos = (curP !== null && Number.isFinite(curP)) ? curP : (furthestJp || 0);
        let curIdx = -1;
        for (const ch of chapters) {
          const a = axis.chStart(ch), b = axis.chEnd(ch);
          if (pos >= a && pos < (b > a ? b : Infinity)) { curIdx = ch.idx; break; }
        }
        _chById = new Map(chapters.map(c => [String(c.idx), c]));   // axis scroll-marker lookup
        const rows = [];
        for (const ch of chapters) {
          const idx = ch.idx;
          let art = arts ? (arts[idx] || null) : null;
          const complete = chapterComplete(map, ch);
          const reached = chapterReached(map, ch);
          // Generate-ahead gate: an artifact produced BEFORE the user reached
          // the chapter stays hidden (compact unread row) until they ARRIVE in
          // it — arriving, not finishing, is what reveals it.
          if (art && art.ahead && !reached) art = null;
          const prog = chapterProgress(axis, ch, segs, furthestJp);
          // change signature — everything a row renders from
          let scSig = '';
          try {
            const scn = (art && Array.isArray(art.scenes)) ? art.scenes : [];
            for (let s2 = 0; s2 < scn.length; s2++) { const st2 = _sceneSlotStat['scene_' + idx + '_' + s2] || {}; scSig += (st2.images || 0) + '.' + (st2.pending || 0) + ';'; }
          } catch (_) {}
          const sig = [
            ch.state || 'none', complete ? 1 : 0, reached ? 1 : 0, (art && art.ts) || 0, (art && art.fp) || '',
            (art && art.label) || ch.label || '', idx === curIdx ? 1 : 0, aiReadMarkFor(idx, art) || '',
            _collapsed.has(idx) ? 1 : 0, _fontScale, scSig,
            (_sceneSlotStat['scene_' + idx] && _sceneSlotStat['scene_' + idx].images) || 0,
            hasSummary(art) ? -1 : Math.round(((prog && prog.pct) || 0) * 100),
            (ch.error || ''), (ch.attempts | 0),
            (_sceneStat[idx] && _sceneStat[idx].images) || 0,
            (art && Array.isArray(art.scenes)) ? art.scenes.reduce((t, x) => t + ((x && x.prompt) ? x.prompt.length : 0), 0) : 0,
          ].join('|');
          const cached = _rowCache.get(idx);
          let row;
          if (cached && cached.sig === sig && cached.el) {
            row = cached.el;
          } else {
            const onTap = makeChapterTap(ch, art, complete, reached);
            row = buildChapterRow(ch, art, complete, prog, onTap, idx === curIdx, pos);
            _rowCache.set(idx, { sig, el: row });
          }
          rows.push(row);
          if (idx === curIdx) _curRowEl = row;
        }
        for (const k of Array.from(_rowCache.keys())) { if (!chapters.some(c => c && c.idx === k)) _rowCache.delete(k); }
        inner.replaceChildren.apply(inner, rows);
        renderAxis();
        restoreScrollAnchor(anchor);
        // Dict lookups on the feed's summary text — leaf text divs only (the
        // chapter-view invariant). Idempotent per element; rows are fresh here.
        try {
          if (typeof window.dictEnableLookupIn === 'function') {
            for (const el of inner.querySelectorAll('.kai-summary-text')) {
              if (el.dataset.kaiDict === '1') continue;   // reused row — already enabled
              el.dataset.kaiDict = '1';
              window.dictEnableLookupIn(el);
            }
          }
        } catch (_) {}
        armReadObserver();
        armImgObserver();
      }

      // Feed image pre-loader: set img.src well BEFORE the frame scrolls into
      // view so the async IndexedDB read + data-URI decode finish off-screen.
      let _imgObs = null;
      function armImgObserver() {
        try {
          if (_imgObs) _imgObs.disconnect();
          else {
            _imgObs = new IntersectionObserver((ents) => {
              for (const en of ents) {
                if (!en.isIntersecting) continue;
                const t = en.target;
                try { _imgObs.unobserve(t); } catch (_) {}
                if (t._kaiLoad) { const f = t._kaiLoad; t._kaiLoad = null; try { f(); } catch (_) {} }
              }
            }, { root: main, rootMargin: '2200px 0px' });
          }
          for (const f of inner.querySelectorAll('.kai-img-lazy')) _imgObs.observe(f);
        } catch (_) {}
      }

      // ---- scroll-to-read marking ---------------------------------------------------
      // A chapter's AI content counts as read once the user has scrolled to the
      // END of its feed section and it stayed in view for a moment (dwell guards
      // fast fling-throughs). Replaces the old "opened the chapter window" mark.
      let _readObs = null;
      function armReadObserver() {
        try {
          if (_readObs) { _readObs.disconnect(); }
          else {
            _readObs = new IntersectionObserver((ents) => {
              for (const en of ents) {
                const t = en.target;
                if (!en.isIntersecting) {
                  if (t._kaiTm) { clearTimeout(t._kaiTm); t._kaiTm = null; }
                  continue;
                }
                if (t._kaiTm || t._kaiDone) continue;
                t._kaiTm = setTimeout(() => {
                  t._kaiTm = null;
                  if (t._kaiDone || !document.body.contains(t)) return;
                  t._kaiDone = true;
                  const idx = Number(t.dataset.chIdx);
                  if (!Number.isFinite(idx)) return;
                  try { aiReadMarkChapter(titleId, idx); } catch (_) {}
                  try { if (!_aiRead.ch[idx]) _aiRead.ch[idx] = Date.now(); } catch (_) {}
                  // scenes are visible inline in the section → they're read too
                  try {
                    const a = arts ? arts[idx] : null;
                    const scn = (a && Array.isArray(a.scenes)) ? a.scenes : [];
                    for (let s = 0; s < scn.length; s++) {
                      aiReadMarkScene(titleId, idx, s);
                      if (!_aiRead.sc[idx + '_' + s]) _aiRead.sc[idx + '_' + s] = Date.now();
                    }
                  } catch (_) {}
                  // quiet in-place ● → ✓ swap; the 続きから pill migrates on the
                  // next natural re-render (no full rebuild for a read mark)
                  try {
                    const row = t._kaiRow;
                    if (row && row._kaiMarkEl) {
                      const nm = aiReadMarkEl('read');
                      if (nm) { row._kaiMarkEl.replaceWith(nm); row._kaiMarkEl = nm; }
                    }
                  } catch (_) {}
                }, 1000);
              }
            }, { root: main, threshold: 0 });
          }
          for (const s of inner.querySelectorAll('.kai-read-sentinel')) _readObs.observe(s);
        } catch (_) {}
      }

      function scheduleRefresh(delayMs) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
          refreshTimer = null;
          try {
            if (!document.body.contains(overlay)) return;
            // A full inner.innerHTML rebuild mid-scroll is a big layout/paint spike
            // (and can jump the scroll offset) — wait until the finger lifts.
            if (Date.now() - _lastScrollTs < 400) { scheduleRefresh(400); return; }
            const m2 = await getMapSafe(titleId);
            if (m2) {
              map = m2;
              const ax2 = buildMapAxis(m2);
              // Never swap a cue-mappable axis for a degraded one: while
              // transcription churns, _srtCues / chunk cue-bounds are briefly
              // unavailable and the fresh axis maps every audio interval to
              // null — the coverage spine "disappearing then reappearing".
              if (ax2 && (ax2.canMapCues || !(axis && axis.canMapCues))) axis = ax2;
            }
            arts = map ? filterArtifacts(await loadArtifacts(titleId), map) : {};
            // Same shield on the data side: coverage never legitimately shrinks
            // to NOTHING between two refreshes — treat a transient empty read as
            // a miss and keep the last good paint.
            const s2 = await coverageSegments(titleId, axis);
            if (s2.length || !segs.length) segs = s2;
            const r2 = await revisitSegments(titleId, axis);
            if (r2.length || !rsegs.length) rsegs = r2;
            render();
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


      // Open: render the chapter list, scroll to the current chapter, and PULL any
      // finished scene renders from the server. (The panel never synced before, so a
      // scene that finished server-side "never appeared" — this is the ingest fix.)
      requestAnimationFrame(() => {
        try {
          render();
          // Reopen at the REMEMBERED spot (saved per title on close); only a
          // first-ever open (or a vanished anchor row) centers the current
          // chapter instead.
          let savedSpot = null;
          try { savedSpot = JSON.parse(localStorage.getItem(tlScrollKey) || 'null'); } catch (_) {}
          const land = () => {
            if (savedSpot && restoreScrollAnchor(savedSpot)) return;
            if (_curRowEl && typeof _curRowEl.scrollIntoView === 'function') _curRowEl.scrollIntoView({ block: 'center' });
          };
          land();
          // content-visibility placeholder heights (rows are estimated until
          // first paint) resolve right after — land once more so the spot
          // doesn't drift. Gated on USER touch, not scroll events (the first
          // landing + size resolution fire scroll events themselves, which
          // would self-defeat the pass).
          setTimeout(() => {
            try { if (document.body.contains(overlay) && !_userTouchTs) land(); } catch (_) {}
          }, 350);
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
        // A stacked scene card (#kchapterView over this panel) runs its own 9s
        // sync poll — skip ours while it's up instead of doubling the churn.
        if (document.getElementById('kchapterView')) return;
        try { window.aiImages && window.aiImages.pollPending && window.aiImages.pollPending(titleId); } catch (_) {}
      }, 9000);
      // while open: keep the glowing current-place marker tracking the live position
      // (audio playhead / read frontier). Cheap — it moves ONE element, no re-render.
      _posTimer = setInterval(() => {
        try {
          if (!document.body.contains(overlay)) { clearInterval(_posTimer); _posTimer = null; return; }
          if (document.hidden || !_nowMarkerEl) return;
          if (Date.now() - _lastScrollTs < 350) return;   // mid-scroll: skip the layout read (currentAxisPos can force a full reflow in read mode)
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

  // Place-safe clip player for other modules (vocab-srs review): dedicated
  // <audio> on a native slice; the book is paused in place and NEVER seeked.
  window.aiTimelineClip = { play: clipPlay, stop: clipStop, dispose: clipDispose };
  window.aiTimeline = {
    openPanel,
    openChapter,
    openCurrentChapter,
    currentChapterStatus,
    // ai-characters-screen.js calls openChapterView(idx) with no titleId;
    // openChapter defaults a null titleId to window._activeTitleId.
    openChapterView: (idx) => openChapter(null, idx, { allowEmpty: true }),
  };
})();
