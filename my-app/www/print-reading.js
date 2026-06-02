// print-reading.js — "Print…" + "Log printed reading" (⋯ menu).
//
// Print: takes the EPUB text from the current reading position (native ruby
// preserved — furigana shows only where the EPUB has it), lays it out as a
// landscape US-Letter paperback spread (two vertical-tategaki pages with a
// center gutter, title on top, page numbers at the bottom outer corners), and
// hands it to the system print sheet (physical printer OR Save as PDF).
//
// Log printed reading: the user reads the printout away from the screen, then
// enters the minutes spent — credited to read-mode stats — and the playhead
// jumps to the cue just past the printed segment so they resume where the
// paper left off.
(function () {
  'use strict';

  // Last printed segment (persisted): how far to advance the playhead + how
  // many characters to credit when the user logs the session. Persisted because
  // they read the printout away from the device — possibly across an app
  // restart — and cleared once logged. Its presence also gates the
  // "Log printed reading…" menu item (only shown when a print is pending).
  const PENDING_KEY = 'PRINTED_READING_PENDING';
  let _lastPrint = null; // { endCue, chars }
  function loadPending() {
    try { const v = localStorage.getItem(PENDING_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; }
  }
  function savePending(p) {
    _lastPrint = p;
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (_) {}
  }
  function clearPending() {
    _lastPrint = null;
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }
  _lastPrint = loadPending();
  window.hasPendingPrintedReading = () => !!_lastPrint;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function activeTitleName() {
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        return t?.name || t?.title || 'Reading';
      }
    } catch (_) {}
    return 'Reading';
  }

  const PR_FONT = '"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP",serif';
  const PR_LINE_HEIGHT = 1.85;
  const PR_PAGE_MX = 1.2;   // @page left/right margin (cm)
  const PR_PAGE_MY = 1.0;   // @page top/bottom margin (cm)

  // The print stylesheet, shared by the real document and the off-screen
  // measurement probe so they lay out identically. `mode` differs the .pr-text/
  // .pr-flow rules: iOS uses 'windowed' (one shared flow translated/clipped per
  // page — WKWebView measure == its print render, so it's pixel-exact and full
  // density); Android uses 'extracted' (each page holds its own content, no
  // translate/clip — robust to its separate print WebView, which the windowed
  // path can't be).
  function printCss(fontPt, mode) {
    const flowBox = mode === 'extracted'
      ? `  /* Android: each page holds its OWN extracted content; .pr-flow lays it
     out naturally, vertical-rl filling from the right (reading) edge. */
  .pr-text { flex:1 1 auto; min-height:0; overflow:hidden; }
  .pr-flow { width:100%; height:100%;
    writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl;
    font-size:${fontPt}pt; line-height:${PR_LINE_HEIGHT}; letter-spacing:.02em; text-align:justify; }`
      : `  /* iOS: one shared flow pinned to the right edge, translated/clipped per
     page (set inline). font-size on .pr-text so the clip em matches the flow. */
  .pr-text { flex:1 1 auto; min-height:0; position:relative; overflow:hidden; font-size:${fontPt}pt; }
  .pr-flow { position:absolute; top:0; right:0; height:100%;
    writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl;
    font-size:${fontPt}pt; line-height:${PR_LINE_HEIGHT}; letter-spacing:.02em; text-align:justify; }`;
    return `
  @page { size: letter landscape; margin: 0.12in; }
  html, body { margin:0; padding:0; background:#fff; color:#000; font-family:${PR_FONT}; }
  /* Sheet kept a touch SMALLER than the printable area (page is 11×8.5in; with
     0.12in margins the box is ~10.76×8.26in). A sheet sized exactly to the page
     plus a forced page-break spilled a sub-pixel onto an extra blank page — the
     alternating text/blank pages. The slack also absorbs printer rounding. */
  .pr-sheet { width:10.6in; height:8.0in; box-sizing:border-box; padding:0.8cm 1.0cm 0.9cm;
    display:flex; flex-direction:column; overflow:hidden; page-break-after:always; break-after:page; }
  .pr-sheet:last-child { page-break-after:auto; break-after:auto; }
  .pr-title { text-align:center; font-size:10pt; color:#444; margin:0 0 5mm 0; flex:0 0 auto; }
  .pr-spread { flex:1 1 auto; display:flex; flex-direction:row-reverse; min-height:0; }
  /* Each page is a flex COLUMN: a text region that stretches to a real width
     (an empty vertical-rl block would otherwise collapse to ~0 width) above a
     footer row for the char location (so they never overlap). */
  .pr-page { flex:1 1 0; min-width:0; box-sizing:border-box; overflow:hidden;
    display:flex; flex-direction:column; }
  .pr-right { border-left:1px solid #cfcfcf; padding-left:1.0cm; }  /* center gutter rule */
  .pr-left  { padding-right:1.0cm; }
${flowBox}
  /* Book-style paragraphs: 1-em first-line indent, no inter-paragraph gap. */
  .pr-flow p { margin:0; text-indent:1em; }
  .pr-flow ruby rt { font-size:.5em; font-weight:400; }
  .pr-flow img, .pr-flow svg { display:none; }
  .pr-no { flex:0 0 auto; font-size:8.5pt; color:#999; padding-top:2.5mm; }
  .pr-right .pr-no { text-align:right; }   /* outer corner */
  .pr-left  .pr-no { text-align:left; }`;
  }

  // The continuous reading flow: chunks wrapped in marker spans (carrying char
  // offset), grouped into <p> at paragraph boundaries so breaks survive. The
  // browser lays this out ONCE; each printed half-page is a fixed-width window
  // onto it, so paragraphs span the gutter and sheets naturally (no manual
  // splitting). Only the END is trimmed to a whole chunk.
  function flowHtml(chunks) {
    let html = '', open = false;
    for (const c of chunks) {
      // Inline margin:0 so the OFF-SCREEN measurement flow lays out paragraphs
      // exactly like the rendered .pr-flow (without it, the measurement <p> gets
      // the UA default block margin → the column grid drifts vs the print).
      if (c.para || !open) { if (open) html += '</p>'; html += '<p style="margin:0;text-indent:1em">'; open = true; }
      html += `<span class="prc" data-co="${c.charOffset || 0}">${c.html}</span>`;
    }
    if (open) html += '</p>';
    return html;
  }

  // Plan the print by EXTRACTING each page's own content from the laid-out flow
  // (Range.cloneContents — which keeps <ruby> intact) and laying it out
  // naturally: no translate, no clip. So a column is never cut — each page's
  // text just starts at the reading edge and ends where its columns end. Each
  // page holds one fewer column than fits, so a slightly different print pitch
  // (Android prints in a separate WebView) can't overflow an edge either. The
  // measured pitch is used ONLY to choose split points (tolerant — an off-by-a-
  // character split is harmless). Returns per-window HTML + char labels + range.
  // ANDROID pathway (robust to its separate print WebView).
  function planExtracted(chunks, fontPt, maxHalves) {
    // Half-page box from the flex-sized page (robust), minus padding; H from the
    // flex:1 text region (page height minus the footer row).
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    probe.innerHTML = `<style>${printCss(fontPt, 'extracted')}</style>` +
      `<div class="pr-sheet"><div class="pr-title">　</div><div class="pr-spread">` +
      `<div class="pr-page pr-right"><div class="pr-text" data-probe="1"></div><div class="pr-no">000,000</div></div>` +
      `<div class="pr-page pr-left"><div class="pr-text"></div><div class="pr-no">000,000</div></div></div></div>`;
    document.body.appendChild(probe);
    const pageEl = probe.querySelector('.pr-right');
    const cs = getComputedStyle(pageEl);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const W = Math.max(120, (pageEl.clientWidth || 0) - padX);
    const H = Math.max(120, (probe.querySelector('[data-probe="1"]').clientHeight) || 0);
    probe.remove();

    // Render the whole flow off-screen and KEEP it live (we read Ranges from it).
    const flow = document.createElement('div');
    flow.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
      `height:${H}px;display:inline-block;width:auto;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;` +
      `font-family:${PR_FONT};font-size:${fontPt}pt;line-height:${PR_LINE_HEIGHT};letter-spacing:.02em;text-align:justify;`;
    flow.innerHTML = flowHtml(chunks);
    document.body.appendChild(flow);
    const cleanup = () => { try { flow.remove(); } catch (_) {} };
    const flowRight = flow.getBoundingClientRect().right;

    const spans = Array.from(flow.querySelectorAll('.prc'));
    if (!spans.length) { cleanup(); return null; }
    const spanIdx = new Map(spans.map((s, i) => [s, i]));

    // Column pitch AND chars-per-column from a plain ruby-free sample.
    let pitch = PR_LINE_HEIGHT * fontPt * 96 / 72;
    let cpcFull = H / (fontPt * 96 / 72);            // fallback chars/column (full-width)
    try {
      const samp = document.createElement('div');
      samp.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        `height:${H}px;display:inline-block;width:auto;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;` +
        `font-family:${PR_FONT};font-size:${fontPt}pt;line-height:${PR_LINE_HEIGHT};letter-spacing:.02em;`;
      samp.textContent = 'あ'.repeat(800);
      document.body.appendChild(samp);
      const rng = document.createRange(); rng.selectNodeContents(samp);
      const n = rng.getClientRects().length, w = samp.getBoundingClientRect().width;
      samp.remove();
      if (n > 0 && w > 0) { pitch = w / n; cpcFull = 800 / n; }
    } catch (_) {}
    const K = Math.max(1, Math.floor(W / pitch));     // columns per page
    const cpc = Math.max(4, Math.round(cpcFull));     // full-width chars per column
    // Conservative chars-per-page. The print WebView can fit ONE FEWER column
    // (different pitch) AND one fewer char per column (different glyph height)
    // than we measure here — integer rounding at its DPI. Budgeting for both
    // (K-1)·(cpc-1) guarantees a page's text never overflows and gets swallowed.
    const budget = Math.max(cpc, (K - 1) * (cpc - 1));

    // Flat BASE-text index (skip <rt>), tagging each text node with its chunk.
    const texts = []; let cum = 0; const chunkFirst = new Map();
    const tw = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT, {
      acceptNode(nd) { for (let p = nd.parentNode; p && p !== flow; p = p.parentNode) { if (p.nodeName === 'RT') return NodeFilter.FILTER_REJECT; } return NodeFilter.FILTER_ACCEPT; }
    });
    for (let nd; (nd = tw.nextNode());) {
      let prc = nd.parentNode;
      while (prc && prc !== flow && !(prc.classList && prc.classList.contains('prc'))) prc = prc.parentNode;
      const sidx = spanIdx.has(prc) ? spanIdx.get(prc) : -1;
      const co = (prc && prc.getAttribute) ? (parseInt(prc.getAttribute('data-co')) || 0) : 0;
      if (sidx >= 0 && !chunkFirst.has(sidx)) chunkFirst.set(sidx, cum);
      texts.push({ node: nd, start: cum, len: nd.nodeValue.length, sidx, co });
      cum += nd.nodeValue.length;
    }
    const totalChars = cum;
    if (!totalChars) { cleanup(); return null; }

    const posAt = (idx) => {
      idx = Math.max(0, Math.min(totalChars, idx));
      for (const t of texts) { if (idx <= t.start + t.len) return { node: t.node, offset: idx - t.start, t }; }
      const last = texts[texts.length - 1]; return { node: last.node, offset: last.len, t: last };
    };
    const mr = document.createRange();
    const colsUpTo = (idx) => {
      if (idx <= 0) return 0;
      const p = posAt(idx);
      mr.setStart(texts[0].node, 0); mr.setEnd(p.node, p.offset);
      return mr.getBoundingClientRect().width / pitch;
    };
    const idxForCols = (target) => {
      let lo = 0, hi = totalChars;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (colsUpTo(mid) < target) lo = mid + 1; else hi = mid; }
      return lo;
    };
    // If a split lands inside a <ruby>, return the element so the Range can be
    // set BEFORE it (never split furigana).
    const rubyAncestor = (node) => { for (let x = node; x && x !== flow; x = x.parentNode) { if (x.nodeName === 'RUBY') return x; } return null; };

    // Total chars to print (budget × pages), trimmed to end on a WHOLE chunk so
    // the print finishes on a complete sentence.
    const chunkStart = [];
    for (let i = 0; i < spans.length; i++) chunkStart.push(chunkFirst.has(i) ? chunkFirst.get(i) : (i > 0 ? chunkStart[i - 1] : 0));
    const totalBudget = Math.min(totalChars, maxHalves * budget);
    let endChars = totalBudget, endIdx = 0, wholeEnd = 0;
    for (let i = 0; i < spans.length; i++) {
      const cend = (i + 1 < spans.length) ? chunkStart[i + 1] : totalChars;
      if (cend <= totalBudget + 0.5) { endIdx = i; wholeEnd = cend; } else break;
    }
    if (wholeEnd >= Math.min(totalBudget, cpc)) endChars = wholeEnd;   // else a giant first chunk → cut mid-chunk

    // A boundary descriptor is {node,offset} or {before: rubyEl} (so a Range can
    // be set BEFORE a <ruby> — never split furigana).
    const descAt = (idx) => {
      const p = posAt(idx);
      const ruby = rubyAncestor(p.node);
      return ruby ? { before: ruby, idx } : { node: p.node, offset: p.offset, idx };
    };
    // One page per `budget` chars (≤ maxHalves pages); last page ends on the chunk.
    const bnds = [{ node: texts[0].node, offset: 0, idx: 0 }];
    for (let b = budget; bnds.length < maxHalves; b += budget) {
      if (b >= endChars) break;
      let idx = b;
      if (idx <= bnds[bnds.length - 1].idx) idx = bnds[bnds.length - 1].idx + 1;
      if (idx >= endChars) break;
      bnds.push(descAt(idx));
    }
    bnds.push(descAt(endChars));

    const setBoundary = (range, which, d) => {
      if (d.before) range[which === 'start' ? 'setStartBefore' : 'setEndBefore'](d.before);
      else range[which === 'start' ? 'setStart' : 'setEnd'](d.node, d.offset);
    };
    const labelFor = (d) => {
      const p = posAt(d.idx); const t = p.t;
      const base = (t.sidx >= 0 && chunkFirst.has(t.sidx)) ? chunkFirst.get(t.sidx) : t.start;
      return (t.co || 0) + Math.max(0, (t.start + p.offset) - base);
    };
    const startsMidParagraph = (d) => {
      const t = posAt(d.idx).t;
      const cf = (t.sidx >= 0 && chunkFirst.has(t.sidx)) ? chunkFirst.get(t.sidx) : 0;
      return d.idx > cf + 0.5;   // boundary is past this chunk's first character
    };

    const windows = [];
    for (let h = 0; h + 1 < bnds.length; h++) {
      const range = document.createRange();
      try { setBoundary(range, 'start', bnds[h]); setBoundary(range, 'end', bnds[h + 1]); }
      catch (_) { continue; }
      const tmp = document.createElement('div');
      tmp.appendChild(range.cloneContents());
      if (h > 0 && startsMidParagraph(bnds[h])) { const fp = tmp.querySelector('p'); if (fp) fp.style.textIndent = '0'; }
      windows.push({ html: tmp.innerHTML, label: labelFor(bnds[h]) });
    }

    const startChar = labelFor(bnds[0]);
    const endP = posAt(endChars).t;
    const endChar = (endP.co || 0) + Math.max(0, endChars - ((endP.sidx >= 0 && chunkFirst.has(endP.sidx)) ? chunkFirst.get(endP.sidx) : endP.start));
    const endChunk = chunks[Math.min(endIdx, chunks.length - 1)] || chunks[chunks.length - 1];
    cleanup();
    if (!windows.length) return null;
    return {
      windows,
      startChar, endChar,
      endCue: endChunk.cue,
      chars: Math.max(0, endChars)
    };
  }

  // ---- shared dark modal ---------------------------------------------------
  function buildModal(innerHtml) {
    const back = document.createElement('div');
    back.className = 'print-modal-back';
    back.style.cssText =
      'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);padding:20px;';
    const card = document.createElement('div');
    card.style.cssText =
      'background:rgba(24,24,27,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:16px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,0.6);color:#f1f1f3;width:min(420px,92vw);padding:20px 20px 16px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;';
    card.innerHTML = innerHtml;
    back.appendChild(card);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return { back, card };
  }

  // ---- Print dialog --------------------------------------------------------
  window.openPrintDialog = function () {
    const { back, card } = buildModal(`
      <div style="font-size:17px;font-weight:700;margin-bottom:14px;">Print reading</div>
      <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0;font-size:14px;">
        <span>Sheets <span style="color:#999;font-weight:400;">(2 book pages each)</span></span>
        <input id="prSheets" type="number" min="1" max="40" value="1"
          style="width:74px;background:#161618;border:1px solid #333;color:#f1f1f3;border-radius:8px;padding:7px 9px;font-size:15px;text-align:center;">
      </label>
      <label style="display:block;margin:16px 0 6px;font-size:14px;">
        Font size: <span id="prFontVal" style="color:#b794f6;font-weight:600;">11pt</span>
      </label>
      <input id="prFont" type="range" min="8" max="16" step="0.5" value="11" style="width:100%;">
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button id="prCancel" style="background:transparent;color:#bbb;border:1px solid #333;border-radius:9px;padding:9px 16px;font-size:14px;cursor:pointer;">Cancel</button>
        <button id="prGo" style="background:#b794f6;color:#15121c;border:none;border-radius:9px;padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;">Print</button>
      </div>
      <div style="color:#888;font-size:11.5px;margin-top:12px;line-height:1.5;">
        Prints the upcoming text from your current position (vertical, right-to-left, like a paperback). Choose your printer or “Save as PDF.”
      </div>
    `);
    const fontEl = card.querySelector('#prFont');
    const fontVal = card.querySelector('#prFontVal');
    fontEl.addEventListener('input', () => { fontVal.textContent = fontEl.value + 'pt'; });
    card.querySelector('#prCancel').addEventListener('click', () => back.remove());
    card.querySelector('#prGo').addEventListener('click', async () => {
      const sheets = Math.max(1, Math.min(40, parseInt(card.querySelector('#prSheets').value, 10) || 4));
      const fontPt = parseFloat(fontEl.value) || 11;
      back.remove();
      await doPrint(sheets, fontPt);
    });
  };

  // ROBUST pathway (both platforms): ONE continuous vertical-rl flow. The print
  // engine paginates it natively across landscape pages, breaking only between
  // columns (a line is never cut at a page edge — that's native fragmentation
  // behaviour). No manual windows, no clipping, no per-page re-layout → it
  // cannot cut a line and cannot skip text. Verified in Blink (Android's print
  // engine) via headless Chrome. The two-page gutter is gone — each landscape
  // page is one full-width column region.
  function planNatural(chunks, fontPt, pages) {
    const cmPx = (cm) => cm / 2.54 * 96;
    const contentW = Math.max(200, 11 * 96 - 2 * cmPx(PR_PAGE_MX));   // landscape letter content box
    const contentH = Math.max(200, 8.5 * 96 - 2 * cmPx(PR_PAGE_MY));
    // pitch (column width) + chars-per-column from a plain sample at the page
    // content height; full-width chars under-estimate real capacity (real text
    // has some narrow glyphs), so the budget fits within `pages` pages.
    let pitch = PR_LINE_HEIGHT * fontPt * 96 / 72, cpc = contentH / (fontPt * 96 / 72);
    try {
      const s = document.createElement('div');
      s.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        `height:${contentH}px;display:inline-block;width:auto;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;` +
        `font-family:${PR_FONT};font-size:${fontPt}pt;line-height:${PR_LINE_HEIGHT};letter-spacing:.02em;`;
      s.textContent = 'あ'.repeat(800);
      document.body.appendChild(s);
      const rng = document.createRange(); rng.selectNodeContents(s);
      const n = rng.getClientRects().length, w = s.getBoundingClientRect().width;
      s.remove();
      if (n > 0 && w > 0) { pitch = w / n; cpc = 800 / n; }
    } catch (_) {}
    const perPage = Math.max(1, Math.floor(contentW / pitch)) * Math.max(1, cpc);
    const budget = Math.max(cpc, Math.round(pages * perPage));

    // Accumulate WHOLE chunks up to ~budget chars (so the print ends on a
    // complete sentence).
    const used = []; let total = 0;
    for (const c of chunks) { used.push(c); total += (c.len || 0); if (total >= budget) break; }
    if (!used.length) return null;
    const first = used[0], last = used[used.length - 1];
    return {
      flow: flowHtml(used),
      startChar: first.charOffset || 0,
      endChar: (last.charOffset || 0) + (last.charLen || last.len || 0),
      endCue: last.cue,
      chars: total
    };
  }

  function buildNaturalDoc(flowHtml, fontPt, title) {
    const css = `
  @page { size: letter landscape; margin: ${PR_PAGE_MY}cm ${PR_PAGE_MX}cm; }
  html, body { margin:0; padding:0; height:100%; background:#fff; color:#000; font-family:${PR_FONT}; }
  /* height:100% makes the flow exactly one page-content tall, so columns fill
     the page and the block fragments across pages (one page = a slice of
     columns). The engine never splits a column across a page → no cut line. */
  .pr-flow { height:100%; writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl;
    font-size:${fontPt}pt; line-height:${PR_LINE_HEIGHT}; letter-spacing:.02em; text-align:justify; }
  .pr-flow p { margin:0; text-indent:1em; }
  .pr-flow p.pr-title { text-indent:0; font-weight:700; }
  .pr-flow ruby rt { font-size:.5em; font-weight:400; }
  .pr-flow img, .pr-flow svg { display:none; }`;
    const titleP = title ? `<p class="pr-title">${esc(title)}</p>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
      `<body><div class="pr-flow">${titleP}${flowHtml}</div></body></html>`;
  }

  async function doPrint(sheets, fontPt) {
    if (typeof window.printGetReadingSegment !== 'function') {
      window.showToast?.('Open a book in Read mode first', 2600); return;
    }
    // Natural pagination was a dead end: it works in Blink (Android) but iOS's
    // UIMarkupTextPrintFormatter does NOT paginate a vertical-rl flow — it
    // crushes the whole thing onto ONE page (tiny text). So we keep the WINDOWED
    // two-page-spread layout. iOS uses the exact inline em values (its print
    // render == WKWebView); Android adds the in-print-WebView corrector that
    // snaps each window's clip to the real measured column pitch.
    const budget = sheets * 2 * 1600;
    const seg = window.printGetReadingSegment(budget);
    if (!seg || !(seg.chunks && seg.chunks.length)) {
      window.showToast?.('Nothing to print from the current position', 2800); return;
    }
    const title = await activeTitleName();
    const isIOS = (window.Capacitor?.getPlatform?.() === 'ios');
    const plan = planWindowed(seg.chunks, fontPt, sheets * 2);
    if (!plan) { window.showToast?.('Nothing to print from the current position', 2800); return; }
    savePending({ endCue: (plan.endCue != null ? plan.endCue : seg.endCue), chars: plan.chars });
    const fileName = `${title} ${plan.startChar}-${plan.endChar}`.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 90) || 'reading';
    shareDoc(buildPrintDoc(buildWindowed(plan, title), fontPt, 'windowed', !isIOS), fileName);
  }

  // ANDROID builder: each page holds its OWN extracted content, laid out
  // naturally (vertical-rl fills from the reading/right edge). No translate, no
  // clip → no column can be cut, on any page, in any WebView.
  function buildExtracted(plan, title) {
    const { windows } = plan;
    const win = (w) => w ? `<div class="pr-text"><div class="pr-flow">${w.html}</div></div>` : '<div class="pr-text"></div>';
    const loc = (w) => (w && w.label != null ? Math.round(w.label).toLocaleString() : '');
    let out = '';
    for (let h = 0; h < windows.length; h += 2) {
      const r = windows[h], l = windows[h + 1];
      out += `<div class="pr-sheet">
  <div class="pr-title">${esc(title)}</div>
  <div class="pr-spread">
    <div class="pr-page pr-right">${win(r)}<div class="pr-no">${loc(r)}</div></div>
    <div class="pr-page pr-left">${l ? win(l) : '<div class="pr-text"></div>'}<div class="pr-no">${l ? loc(l) : ''}</div></div>
  </div>
</div>`;
    }
    return out;
  }

  // iOS pathway: one shared flow, translated/clipped per page in `em` (the
  // measured line-box ratio). WKWebView's measure matches its UIMarkup print
  // render, so this is pixel-exact AND full density on iOS. (Android's separate
  // print WebView drifts here — it uses planExtracted instead.)
  function planWindowed(chunks, fontPt, maxHalves) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    probe.innerHTML = `<style>${printCss(fontPt, 'windowed')}</style>` +
      `<div class="pr-sheet"><div class="pr-title">　</div><div class="pr-spread">` +
      `<div class="pr-page pr-right"><div class="pr-text" data-probe="1"></div><div class="pr-no">000,000</div></div>` +
      `<div class="pr-page pr-left"><div class="pr-text"></div><div class="pr-no">000,000</div></div></div></div>`;
    document.body.appendChild(probe);
    const pageEl = probe.querySelector('.pr-right');
    const cs = getComputedStyle(pageEl);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const W = Math.max(120, (pageEl.clientWidth || 0) - padX);
    const H = Math.max(120, (probe.querySelector('[data-probe="1"]').clientHeight) || 0);
    probe.remove();

    const flow = document.createElement('div');
    flow.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
      `height:${H}px;display:inline-block;width:auto;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;` +
      `font-family:${PR_FONT};font-size:${fontPt}pt;line-height:${PR_LINE_HEIGHT};letter-spacing:.02em;text-align:justify;`;
    flow.innerHTML = flowHtml(chunks);
    document.body.appendChild(flow);
    const flowRight = flow.getBoundingClientRect().right;
    const marks = Array.from(flow.querySelectorAll('.prc')).map((s) => {
      const r = s.getBoundingClientRect();
      return { co: parseInt(s.getAttribute('data-co')) || 0, start: flowRight - r.right, end: flowRight - r.left };
    });
    let pitch = PR_LINE_HEIGHT * fontPt * 96 / 72;
    try {
      const samp = document.createElement('div');
      samp.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;' +
        `height:${H}px;display:inline-block;width:auto;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;` +
        `font-family:${PR_FONT};font-size:${fontPt}pt;line-height:${PR_LINE_HEIGHT};letter-spacing:.02em;`;
      samp.textContent = 'あ'.repeat(800);
      document.body.appendChild(samp);
      const rng = document.createRange(); rng.selectNodeContents(samp);
      const n = rng.getClientRects().length, w = samp.getBoundingClientRect().width;
      samp.remove();
      if (n > 0 && w > 0) pitch = w / n;
    } catch (_) {}
    flow.remove();
    if (!marks.length) return null;

    const pitchEm = pitch / (fontPt * 96 / 72);
    const K = Math.max(1, Math.floor(W / pitch));
    const maxCols = maxHalves * K;
    let endIdx = 0;
    for (let k = 0; k < marks.length; k++) { if (Math.round(marks[k].end / pitch) <= maxCols) endIdx = k; else break; }
    const used = chunks.slice(0, endIdx + 1);
    const totalCols = Math.max(1, Math.round(marks[endIdx].end / pitch));
    const numHalf = Math.max(1, Math.min(maxHalves, Math.ceil(totalCols / K)));
    const labelAt = (x) => { let l = marks[0].co; for (const m of marks) { if (m.start <= x + 1) l = m.co; else break; } return l; };
    const wins = [];
    for (let h = 0; h < numHalf; h++) {
      const startCol = h * K;
      const colsHere = Math.min(K, totalCols - startCol);
      if (colsHere <= 0) break;
      wins.push({ startCol, colsHere, label: labelAt(startCol * pitch) });
    }
    const lastChunk = used[used.length - 1];
    return {
      flow: flowHtml(used), wins, totalCols, pitchEm,
      startChar: used[0].charOffset || 0,
      endChar: (lastChunk.charOffset || 0) + (lastChunk.charLen || lastChunk.len || 0),
      endCue: lastChunk.cue,
      chars: used.reduce((s, c) => s + (c.len || 0), 0)
    };
  }

  function buildWindowed(plan, title) {
    const { flow, wins, totalCols } = plan;
    const colEm = plan.pitchEm || PR_LINE_HEIGHT;
    const flowEm = ((totalCols + 2) * colEm).toFixed(3);
    const lastIdx = wins.length - 1;
    const win = (w, isLast) => {
      const trans = (w.startCol * colEm).toFixed(3);
      const clipEm = (w.colsHere * colEm).toFixed(3);
      const clip = isLast ? '' :
        `clip-path:inset(0 0 0 calc(100% - ${clipEm}em));-webkit-clip-path:inset(0 0 0 calc(100% - ${clipEm}em));`;
      // Inline em values are what iOS uses (exact there). data-* lets Android's
      // in-print-WebView corrector re-derive translate/clip in PX from the REAL
      // measured flow, eliminating the app↔print pitch mismatch that cut a line.
      return `<div class="pr-text" style="${clip}"><div class="pr-flow" ` +
        `data-sc="${w.startCol}" data-ch="${w.colsHere}" data-last="${isLast ? 1 : 0}" data-tc="${totalCols}" ` +
        `style="width:${flowEm}em;transform:translateX(${trans}em);">${flow}</div></div>`;
    };
    const loc = (w) => (w && w.label != null ? w.label.toLocaleString() : '');
    let out = '';
    for (let h = 0; h < wins.length; h += 2) {
      const r = wins[h], l = wins[h + 1];
      out += `<div class="pr-sheet">
  <div class="pr-title">${esc(title)}</div>
  <div class="pr-spread">
    <div class="pr-page pr-right">${win(r, h === lastIdx)}<div class="pr-no">${loc(r)}</div></div>
    <div class="pr-page pr-left">${l ? win(l, (h + 1) === lastIdx) : '<div class="pr-text"></div>'}<div class="pr-no">${l ? loc(l) : ''}</div></div>
  </div>
</div>`;
    }
    return out;
  }

  function buildPrintDoc(sheetsHtml, fontPt, mode, withCorrector) {
    // ANDROID corrector: runs in the print WebView (JS enabled there; iOS's
    // markup renderer ignores scripts and keeps the exact inline em values).
    // It measures the ACTUAL rendered flow's column pitch in PX — content width
    // ÷ total columns — and rewrites every page's translate/clip from it. Since
    // it measures the very layout that prints, the clips fall exactly on column
    // boundaries → no cut. And it's still ONE shared flow per page (a window),
    // never a re-layout → no skipped text. (Measuring a synthetic sample / using
    // em drifted; measuring the real flow does not.)
    const corrector = !withCorrector ? '' : `<script>(function(){try{
      var fl=document.querySelectorAll('.pr-flow'); if(!fl.length) return;
      var rng=document.createRange(); rng.selectNodeContents(fl[0]);
      var rects=rng.getClientRects(); if(!rects.length) return;
      // pitch = median spacing between adjacent COLUMN line-boxes (full-height
      // rects; short ruby rects filtered). Measured from the real rendered flow,
      // so it needs no column count (a width÷count estimate could be off by one
      // column → ~1% error → a clipped line on the densest page).
      var mh=0,i; for(i=0;i<rects.length;i++) if(rects[i].height>mh) mh=rects[i].height;
      var xs=[]; for(i=0;i<rects.length;i++){ var r=rects[i]; if(r.height>=0.5*mh && r.width>0.5) xs.push(r.left); }
      xs.sort(function(a,b){return a-b;});
      var ux=[]; for(i=0;i<xs.length;i++){ if(!ux.length||xs[i]-ux[ux.length-1]>1) ux.push(xs[i]); }
      if(ux.length<2) return;
      var d=[]; for(i=1;i<ux.length;i++) d.push(ux[i]-ux[i-1]);
      d.sort(function(a,b){return a-b;});
      var pitch=d[d.length>>1]; if(!(pitch>0)) return;
      for(var j=0;j<fl.length;j++){
        var e=fl[j], sc=+e.getAttribute('data-sc')||0, ch=+e.getAttribute('data-ch')||0, last=e.getAttribute('data-last')==='1', box=e.parentNode;
        e.style.transform='translateX('+(sc*pitch).toFixed(2)+'px)';
        if(last){ box.style.clipPath='none'; box.style.webkitClipPath='none'; }
        else { var ins='inset(0 0 0 calc(100% - '+(ch*pitch).toFixed(2)+'px))'; box.style.clipPath=ins; box.style.webkitClipPath=ins; }
      }
    }catch(e){}})();<\/script>`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${printCss(fontPt, mode)}</style></head><body>${sheetsHtml}${corrector}</body></html>`;
  }

  function shareDoc(doc, fileName) {
    fileName = fileName || 'reading';
    const Pdf = window.Capacitor?.Plugins?.PdfExport;
    // window.print() does nothing in a Capacitor WebView, so render natively to
    // a PDF and open the system share / print sheet.
    if (Pdf && typeof Pdf.share === 'function') {
      Pdf.share({ html: doc, fileName, title: fileName }).catch(e => {
        console.warn('[print] PdfExport.share failed:', e?.message || e);
        window.showToast?.('Could not generate PDF: ' + (e?.message || e), 4200);
      });
      return;
    }
    if (window.Capacitor?.isNativePlatform?.()) {
      window.showToast?.('PDF export plugin not loaded — rebuild/reinstall the app', 4800);
      return;
    }
    try {
      const w = window.open('', '_blank');
      if (w) { w.document.write(doc); w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (_) {} }, 350); }
      else window.showToast?.('Allow pop-ups to export the PDF', 3200);
    } catch (_) { window.showToast?.('PDF export not available here', 3200); }
  }

  // ---- Log printed reading -------------------------------------------------
  window.openLogPrintedReadingDialog = function () {
    const known = _lastPrint && Number.isFinite(_lastPrint.endCue);
    const { back, card } = buildModal(`
      <div style="font-size:17px;font-weight:700;margin-bottom:6px;">Log printed reading</div>
      <div style="color:#999;font-size:12.5px;margin-bottom:16px;line-height:1.5;">
        Add the time you spent reading the printout to your stats${known ? ', and jump the playhead to where the paper left off' : ''}.
      </div>
      <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;">
        <span>Minutes read</span>
        <input id="prMin" type="number" min="1" max="600" value="20" inputmode="numeric"
          style="width:84px;background:#161618;border:1px solid #333;color:#f1f1f3;border-radius:8px;padding:7px 9px;font-size:15px;text-align:center;">
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button id="prlCancel" style="background:transparent;color:#bbb;border:1px solid #333;border-radius:9px;padding:9px 16px;font-size:14px;cursor:pointer;">Cancel</button>
        <button id="prlGo" style="background:#4caf50;color:#0c1a0d;border:none;border-radius:9px;padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;">Log it</button>
      </div>
    `);
    card.querySelector('#prlCancel').addEventListener('click', () => back.remove());
    card.querySelector('#prlGo').addEventListener('click', () => {
      const mins = Math.max(0, parseFloat(card.querySelector('#prMin').value) || 0);
      back.remove();
      if (mins <= 0) return;
      const chars = (_lastPrint && _lastPrint.chars) || 0;
      try { window.stats?.addPrintedReading?.(mins * 60, chars); } catch (_) {}
      // Advance the playhead to just past the printed segment.
      let advanced = false;
      if (known && typeof window.updateCardIndex === 'function' && Array.isArray(window.allNotes)) {
        const next = _lastPrint.endCue + 1;
        if (next > 0 && next < window.allNotes.length) { try { window.updateCardIndex(next); advanced = true; } catch (_) {} }
      }
      clearPending(); // logged — hide the menu item until the next print
      window.showToast?.(`✓ Logged ${Math.round(mins)} min of reading${advanced ? ' · advanced to where you left off' : ''}`, 3200);
    });
  };
})();
