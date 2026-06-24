// ai-characters-read.js — character-name squiggles in the PAGED READER
// (AI plan slice 4, read-mode surface). Follows the reader's proven
// element-geometry overlay pattern (the iOS ::highlight ruby fix):
// position:fixed divs appended to #readingPagedView, z-index 2600,
// pointer-events:none, cleared on scroll and repainted when the page
// settles. Ruby-contained characters use the proportional-slice math
// (rt rects lie OUTSIDE the ruby rect — never measure ranges through ruby).
//
// Marks are drawn as a thin wavy line along the RIGHT edge of the character
// run (the 傍線 position for vertical-rl text). Taps are resolved by
// coordinate hit-test from ai-characters-ui.js via window.aiCharsRead.hitTest.
(function () {
  'use strict';

  const WAVE_BG =
    'url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%224%22 height=%228%22>' +
    '<path d=%22M2 0 Q 3.6 2 2 4 Q 0.4 6 2 8%22 fill=%22none%22 stroke=%22rgba(150,165,255,0.55)%22 stroke-width=%221.2%22/></svg>")';
  const SETTLE_MS = 220;       // repaint this long after the last scroll event
  const MAX_MARKS = 60;        // per repaint — viewport only, so plenty

  let overlays = [];
  let hits = [];               // [{l,t,r,b, rec}] viewport coords, current paint
  let repaintTimer = null;
  let wired = false;
  let lastMatcher = null;

  const viewEl = () => document.getElementById('readingPagedView');
  const scrollEl = () => document.getElementById('readingPagedContent');

  function readerVisible() {
    const v = viewEl();
    if (!v) return false;
    // visibility-based hiding (NOT display) — the reader stays display:flex.
    if (v.style.display === 'none' || v.style.visibility === 'hidden') return false;
    return document.body.classList.contains('mode-read');
  }

  function clear() {
    for (const d of overlays) { try { d.remove(); } catch (_) {} }
    overlays = [];
    hits = [];
  }

  function scheduleRepaint(delay) {
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(repaint, delay || SETTLE_MS);
  }

  function wire() {
    if (wired) return;
    const sc = scrollEl();
    if (!sc) return;
    wired = true;
    sc.addEventListener('scroll', () => { clear(); scheduleRepaint(SETTLE_MS); }, { passive: true });
    window.addEventListener('resize', () => { clear(); scheduleRepaint(380); });
  }

  // Per-char map of a chunk's BASE text (rt/rp skipped — same walker the
  // reader's own highlight code uses), with the containing <ruby> noted.
  function chunkCharMap(chunk) {
    const map = [];
    let flat = '';
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        let p = n.parentNode;
        while (p && p !== chunk) {
          if (p.tagName === 'RT' || p.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      let ruby = null, p = n.parentNode;
      while (p && p !== chunk) { if (p.tagName === 'RUBY') { ruby = p; break; } p = p.parentNode; }
      const s = n.nodeValue;
      for (let i = 0; i < s.length; i++) map.push({ node: n, off: i, ruby });
      flat += s;
    }
    return { flat, map };
  }

  // Viewport box for ONE character. Plain text → 1-char Range rect; inside
  // ruby → proportional slice of the ruby element's rect along its height
  // (range rects through ruby bases are unreliable — the R4 probe facts).
  function charBox(entry) {
    try {
      if (entry.ruby) {
        const er = entry.ruby.getBoundingClientRect();
        if (!er || !er.height) return null;
        let total = 0, before = 0, found = false;
        const w = document.createTreeWalker(entry.ruby, NodeFilter.SHOW_TEXT, {
          acceptNode(n) {
            let p = n.parentNode;
            while (p && p !== entry.ruby) {
              if (p.tagName === 'RT' || p.tagName === 'RP') return NodeFilter.FILTER_REJECT;
              p = p.parentNode;
            }
            return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });
        let nn;
        while ((nn = w.nextNode())) {
          if (nn === entry.node && !found) { before = total + entry.off; found = true; }
          total += nn.nodeValue.length;
        }
        if (!total) return null;
        const f0 = before / total, f1 = (before + 1) / total;
        return { left: er.left, top: er.top + er.height * f0,
                 width: er.width, height: er.height * (f1 - f0) };
      }
      const r = document.createRange();
      r.setStart(entry.node, entry.off);
      r.setEnd(entry.node, entry.off + 1);
      const rc = r.getBoundingClientRect();
      if (!rc || (!rc.width && !rc.height)) return null;
      return { left: rc.left, top: rc.top, width: rc.width, height: rc.height };
    } catch (_) { return null; }
  }

  // Pure: merge per-char boxes that share a column (≈ same left edge) and
  // touch vertically into runs. No DOM access — paints happen later in one
  // write batch so rect reads never interleave with writes (layout thrash).
  function computeRuns(boxes) {
    boxes.sort((a, b) => (a.left - b.left) || (a.top - b.top));
    const runs = [];
    for (const b of boxes) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(last.left - b.left) < 3 && b.top <= last.top + last.height + 3) {
        const bottom = Math.max(last.top + last.height, b.top + b.height);
        last.height = bottom - last.top;
        last.width = Math.max(last.width, b.width);
      } else {
        runs.push({ left: b.left, top: b.top, width: b.width, height: b.height });
      }
    }
    return runs;
  }

  function paintRuns(pending) {
    const host = viewEl() || document.body;
    for (const { runs, rec } of pending) {
      for (const run of runs) {
        const d = document.createElement('div');
        d.style.cssText =
          'position:fixed;left:' + (run.left + run.width + 1) + 'px;top:' + run.top + 'px;' +
          'width:4px;height:' + run.height + 'px;background-image:' + WAVE_BG + ';' +
          'background-repeat:repeat-y;pointer-events:none;z-index:2600;';
        host.appendChild(d);
        overlays.push(d);
        hits.push({ l: run.left - 4, t: run.top - 3,
                    r: run.left + run.width + 8, b: run.top + run.height + 3, rec });
      }
    }
  }

  // chunkCharMap is pure text-walking over content that never changes after
  // book load — cache per element (new load = new elements = fresh cache).
  const _mapCache = new WeakMap();
  function chunkCharMapCached(chunk) {
    let v = _mapCache.get(chunk);
    if (!v) { v = chunkCharMap(chunk); _mapCache.set(chunk, v); }
    return v;
  }

  // Viewport chunk window WITHOUT measuring the whole book: chunks flow in
  // document order right→left (vertical-rl), so rect.left decreases with
  // index. Binary-search both edges (~2·log n rect reads), tolerating
  // zero-size chunks by probing nearby siblings.
  function sizedRect(els, i) {
    for (let k = i; k < Math.min(els.length, i + 4); k++) {
      const r = els[k].getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return null;
  }
  function chunkWindow(els, vw, margin) {
    const n = els.length;
    // first index with rect.left <= vw + margin (entered from the right)
    let lo = 0, hi = n - 1, start = n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = sizedRect(els, mid);
      if (!r || r.left <= vw + margin) { start = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    // last index with rect.right >= -margin (not yet past the left edge)
    lo = start; hi = n - 1;
    let end = start - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = sizedRect(els, mid);
      if (!r || r.right >= -margin) { end = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return [Math.max(0, start - 2), Math.min(n - 1, end + 2)];  // slack for monotonicity wobble
  }

  function dictPopupOpen() {
    try {
      const p = document.getElementById('dictPopup');
      return !!(p && p.style.display === 'block');
    } catch (_) { return false; }
  }

  function repaint() {
    try {
      clear();
      if (window._kaiAiPaused) return;        // perf-probe kill switch
      if (!readerVisible()) return;
      if (dictPopupOpen()) { scheduleRepaint(600); return; }  // don't compete with a lookup
      wire();
      const t0 = performance.now();
      const m = (window.aiCharacters && window.aiCharacters.matcher())
             || lastMatcher;
      if (!m || !m.map.size) return;
      lastMatcher = m;
      const vw = window.innerWidth;
      const margin = vw;                       // current page ± one page width
      const aliases = Array.from(m.map.keys()).sort((a, b) => b.length - a.length);
      let painted = 0;
      const chunkEls = document.querySelectorAll('.reading-chunk');
      const [wStart, wEnd] = chunkWindow(chunkEls, vw, margin);
      const pending = [];                      // ALL reads first, ONE write batch after
      for (let ci = wStart; ci <= wEnd; ci++) {
        if (painted >= MAX_MARKS) break;
        const chunk = chunkEls[ci];
        const cr = chunk.getBoundingClientRect();
        if (!cr.width && !cr.height) continue;
        if (cr.right < -margin || cr.left > vw + margin) continue;   // off-page
        const { flat, map } = chunkCharMapCached(chunk);
        if (!flat) continue;
        const taken = new Array(flat.length).fill(false);
        for (const alias of aliases) {
          if (painted >= MAX_MARKS) break;
          let from = 0, at;
          while ((at = flat.indexOf(alias, from)) >= 0 && painted < MAX_MARKS) {
            from = at + 1;
            let free = true;
            for (let i = at; i < at + alias.length; i++) if (taken[i]) { free = false; break; }
            if (!free) continue;
            const boxes = [];
            for (let i = at; i < at + alias.length; i++) {
              taken[i] = true;
              const bx = charBox(map[i]);
              if (bx) boxes.push(bx);
            }
            if (boxes.length) { pending.push({ runs: computeRuns(boxes), rec: m.map.get(alias) }); painted++; }
          }
        }
      }
      paintRuns(pending);
      try {
        const d = performance.now() - t0;
        if (d > 15 && window.kperf) window.kperf.mark('reader-squiggle repaint', d, painted + ' marks');
      } catch (_) {}
    } catch (_) {}
  }

  window.aiCharsRead = {
    // Called from ai-characters-ui's poll when the matcher state changes,
    // and used by its tap handler for coordinate hit-testing.
    refresh() { if (readerVisible()) scheduleRepaint(60); else clear(); },
    hitTest(x, y) {
      for (const h of hits) {
        if (x >= h.l && x <= h.r && y >= h.t && y <= h.b) return h.rec;
      }
      return null;
    },
    clear,
  };
})();
