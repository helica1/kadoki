// reading-mode-paged.js — vertical-rl Japanese EPUB reader.
//
// Architecture: TTU continuous-vertical pattern. CSS multi-column under
// writing-mode: vertical-rl was removed from the CSS spec (moved to
// css-fragmentation, never implemented in WebKit) so paginating vertical
// text via columns is impossible. The working pattern, used by TTU,
// jidoujisho, and immersion_reader, is:
//
//   - One tall `writing-mode: vertical-rl` div for content
//   - Native horizontal scroll on the container (overflow-x: scroll)
//   - scroll-snap-type: x mandatory + scroll-snap-align: start on chunks
//     gives "page" feel without manual pagination
//   - "Next page" = container.scrollBy({left: -clientWidth}) (negative
//     for vertical-rl with default direction: ltr in WebKit; works on
//     iOS today)
//   - Position tracked by scrollLeft, persisted per book
//
// Side benefits:
//   - Native scroll = native momentum + rubber-band + WKWebView's own
//     handling. We never transform/translate content ourselves, so we
//     can't trigger the backing-store corruption that broke the legacy
//     reader.
//   - Free-scroll feels good for skimming; snap pulls back to a
//     paragraph boundary when finger releases.
//
// References researched 2026-05-28:
//   ttu-ttu/ebook-reader book-reader-continuous component;
//   webkit.org/b/65917, /b/116413, /b/135275;
//   Yuedu reader's WebView→CoreText migration writeup.

(function () {
  'use strict';

  const PREF = (window.Capacitor?.Plugins?.Preferences) || null;
  const KEY_LAST_NAME = 'PAGED_LAST_EPUB_NAME';
  const KEY_LAST_SCROLL_PREFIX = 'PAGED_LAST_SCROLL_';
  const KEY_USE_PAGED = 'READER_USE_PAGED';

  let viewEl = null;
  let scrollEl = null;       // #readingPagedContent — the horizontal scroll container
  let innerEl = null;        // #readingPagedInner   — the vertical-rl content
  let currentName = '';
  let cw = 0;                // cached clientWidth of scrollEl
  let sw = 0;                // cached scrollWidth of innerEl
  let chunks = [];           // .reading-chunk elements for dict / cue-sync
  let suppressScrollSave = false;
  // Audio sync state.
  let pagedCues = [];        // SRT cues for the active book's audiobook
  let pagedAudioPath = null;
  let pagedCueToChunk = null;// cue index → paged chunk index
  let lastHighlightedCue = -1;
  let bgListenerHandle = null;
  // Auto-scroll grace period: don't yank the view back if the user
  // manually scrolled within the last 5 seconds.
  let lastUserScrollTime = 0;
  let lastProgrammaticScrollTime = 0;

  async function setPref(k, v) {
    if (PREF) try { await PREF.set({ key: k, value: String(v) }); } catch (e) {}
  }
  async function getPref(k) {
    if (PREF) try { const r = await PREF.get({ key: k }); return r.value; } catch (e) {}
    return null;
  }
  const log = (...a) => console.log('[paged]', ...a);

  function ensureStylesheet() {
    if (document.getElementById('readingPagedStyles')) return;
    const s = document.createElement('style');
    s.id = 'readingPagedStyles';
    s.textContent = `
      #readingPagedContent {
        position: relative;
        width: 100vw !important;
        height: 100% !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        -webkit-overflow-scrolling: touch;
        background: #000;
        direction: rtl;
        /* Flex layout so innerEl stretches to full height — without this,
           display: inline-block aligns to baseline (effectively bottom)
           and short text appears bottom-aligned within the column. */
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
      }
      #readingPagedToolbar, #readingPagedBottomBar {
        direction: ltr;
      }
      #readingPagedContent::-webkit-scrollbar { display: none; }
      #readingPagedInner {
        writing-mode: vertical-rl !important;
        -webkit-writing-mode: vertical-rl !important;
        text-orientation: mixed !important;
        -webkit-text-orientation: mixed !important;
        /* CRITICAL: force direction: ltr on innerEl. The scroll container
           uses direction: rtl to flip the scroll axis (so swipe-LEFT
           advances forward in vertical-rl). But the direction property
           is inherited, and on a vertical-rl element direction:rtl
           REVERSES the inline axis from top-to-bottom to bottom-to-top.
           That made
           text read upward from the bottom of each column — exactly the
           "bottom-justified, period at top of next column" pattern the
           user has been seeing. Forcing direction:ltr here resets the
           inline axis to normal top-to-bottom inside vertical-rl. */
        direction: ltr !important;
        flex: 0 0 auto !important;
        display: block !important;
        color: #e8e8e8;
        font-size: var(--reader-font-size, 1.5rem);
        line-height: 1.8;
        padding: 16px 24px;
        box-sizing: border-box;
        vertical-align: top !important;
      }
      /* THE REAL FIX for "punctuation at top of line" — Japanese
         kinsoku-shori rules. Without line-break:strict, WebKit lets
         periods hang at the start of a new vertical line, leaving
         empty space at the bottom of the previous line. That is what
         the screenshots showed: period at top of column, empty space
         below the previous column. line-break:strict forces 、 。 「 」
         to stay at line-end instead of wrapping to line-start.
         Plus font + vertical glyph setup so 「 」 use proper vertical
         glyph variants from Hiragino (built into iOS). */
      #readingPagedInner,
      #readingPagedInner * {
        font-family: "Hiragino Mincho ProN", "Hiragino Mincho Pro",
                     "YuMincho", "Yu Mincho", serif !important;
        font-feature-settings: "vert" 1, "vrt2" 1, "vkrn" 1 !important;
        -webkit-font-feature-settings: "vert" 1, "vrt2" 1, "vkrn" 1 !important;
        text-orientation: mixed !important;
        -webkit-text-orientation: mixed !important;
        text-combine-upright: none !important;
        /* THE FIX for "bottom-aligned justification": kill text-align
           justify on every descendant. EPUB stylesheets routinely set
           text-align: justify on p elements — in vertical-rl that
           spreads characters along the column HEIGHT, producing the
           gaps we saw (text at top, gap in middle, more text at bottom,
           looked like the column was bottom-aligned). Force start
           everywhere AND override the last-line behavior too. */
        text-align: start !important;
        text-align-last: start !important;
        text-justify: none !important;
        vertical-align: top !important;
        line-break: strict !important;
        -webkit-line-break: strict !important;
        word-break: normal !important;
        overflow-wrap: normal !important;
        hanging-punctuation: allow-end last !important;
        /* Zero ALL margins and paddings on descendants. EPUB stylesheets
           commonly set padding-top / margin-top on paragraphs, which in
           vertical-rl translates to space AT THE TOP of each column —
           producing the descending-text-start the user saw across
           columns (col 1 top, col 2 a bit lower, col 6 way lower). Kill
           both physical and logical padding/margin properties. */
        margin: 0 !important;
        padding: 0 !important;
        margin-block-start: 0 !important;
        margin-block-end: 0 !important;
        margin-inline-start: 0 !important;
        margin-inline-end: 0 !important;
        padding-block-start: 0 !important;
        padding-block-end: 0 !important;
        padding-inline-start: 0 !important;
        padding-inline-end: 0 !important;
        text-indent: 0 !important;
        column-count: auto !important;
        column-width: auto !important;
        columns: auto !important;
      }
      #readingPagedInner img,
      #readingPagedInner svg,
      #readingPagedInner figure,
      #readingPagedInner table {
        max-width: 100% !important;
        max-height: 100% !important;
        break-inside: avoid;
      }
      /* Highlight for dict lookup — same key as the legacy reader so the
         popup-close handler clears it via window._clearReaderDictHighlight. */
      ::highlight(reader-dict-lookup) {
        background: var(--reader-highlight-bg, rgba(76, 175, 80, 0.28));
        text-decoration: underline solid var(--accent-read, #4caf50) 2px;
      }
    `;
    document.head.appendChild(s);
  }

  function ensureView() {
    if (viewEl) return viewEl;
    ensureStylesheet();
    viewEl = document.createElement('div');
    viewEl.id = 'readingPagedView';
    Object.assign(viewEl.style, {
      display: 'none',
      position: 'fixed',
      // Top inset = safe-area + 48px clears the shell header (which is
      // fixed at top: safe-area, height: 48px, z-index 9000). With this,
      // mode tabs and shell controls are visible AND tappable above the
      // paged reader, restoring mode switching.
      top: 'calc(env(safe-area-inset-top, 0px) + 48px)',
      left: '0', right: '0', bottom: '0',
      background: '#000', zIndex: '2800', flexDirection: 'column',
      transition: 'transform .22s ease, opacity .18s ease'
    });
    // No custom top/bottom bars — shell header above (mode tabs, timer,
    // play, menu) is the only chrome. Tap empty space toggles it.
    viewEl.innerHTML = `
      <div id="readingPagedContent" style="
        flex:1;
        padding: 16px 0;
        box-sizing: border-box;
      ">
        <div id="readingPagedInner">
          <div style="font-size:.9rem;color:#888;text-align:center;margin-top:30vh;">
            Loading…
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(viewEl);

    scrollEl = viewEl.querySelector('#readingPagedContent');
    innerEl  = viewEl.querySelector('#readingPagedInner');

    setupTouch();
    setupScrollTracking();
    setupResize();
    return viewEl;
  }

  // Page navigation. With `direction: rtl` on the scroll container,
  // scrollLeft = 0 at the rightmost edge (= start of vertical-rl
  // content). scrollBy({left: +cw}) advances forward (view moves left
  // through content).
  //
  //   dir = +1  → next page (forward in book)  → scrollBy({left: +cw})
  //   dir = -1  → prev page (back in book)     → scrollBy({left: -cw})
  function pageNav(dir) {
    if (!scrollEl) return;
    cw = scrollEl.clientWidth;
    scrollEl.scrollBy({ left: dir * cw, behavior: 'smooth' });
  }

  // Tap empty space toggles the shell header (mode tabs / timer / play
  // / menu). The paged reader has no chrome of its own anymore.
  function toggleChrome() {
    document.body.classList.toggle('chrome-hidden');
  }

  // Is the tap point ON actual chunk text (vs empty margin / between
  // chunks)? Uses elementFromPoint to find what's directly under finger.
  // Returns the chunk if the tap hit chunk text, otherwise null.
  function chunkAtTapPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // Walk up looking for .reading-chunk; if we hit innerEl first, not on a chunk.
    let cur = el;
    while (cur && cur !== innerEl && cur !== document.body) {
      if (cur.classList?.contains('reading-chunk')) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function setupTouch() {
    let sx = 0, sy = 0, tStart = 0, canTap = true;
    let touchStartTarget = null;
    scrollEl.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      tStart = Date.now(); canTap = true;
      touchStartTarget = e.target;
      // Outside-tap dismisses dict popup (always, even if it's a swipe).
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        popup.style.display = 'none';
        popup.innerHTML = '';
        try { window._clearReaderDictHighlight?.(); } catch (er) {}
        canTap = false;
      }
    }, { passive: true });
    scrollEl.addEventListener('touchmove', (e) => {
      if (!e.touches?.[0]) return;
      const dx = Math.abs(e.touches[0].clientX - sx);
      const dy = Math.abs(e.touches[0].clientY - sy);
      if (dx > 14 || dy > 14) canTap = false;
    }, { passive: true });
    scrollEl.addEventListener('touchend', (e) => {
      const t = e.changedTouches?.[0];
      if (!t) return;
      // Up-swipe-to-Anki removed — that gesture is for CARD mode only.
      // Native horizontal scroll handles all page navigation. We only
      // act on TAPS (no motion).
      if (!canTap) return;
      if (Date.now() - tStart > 400) return;
      // Tap on text → dict lookup. Tap on empty space → toggle chrome.
      const chunk = chunkAtTapPoint(t.clientX, t.clientY);
      if (chunk) lookupAt(t.clientX, t.clientY);
      else       toggleChrome();
    }, { passive: true });
  }

  // "Add the touched sentence to Anki." Builds the same lookupContext the
  // legacy reader uses, then calls window.sendToAnki. Without an audiobook
  // cue mapping yet, we send the chunk's plain text as the sentence and
  // omit audio range. Cover image still attaches via the existing
  // window.sendToAnki pipeline (cover-extract.js).
  async function sendChunkToAnki(chunk) {
    if (!chunk || typeof window.sendToAnki !== 'function') return;
    const sentence = chunk.textContent.trim();
    if (!sentence) return;
    // Cover image: pull from the active title if available.
    let imageData = null;
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        if (t?.attachments?.cover?.dataUri) imageData = t.attachments.cover.dataUri;
      }
    } catch (e) {}
    window.lookupContext = {
      source: 'paged-reader',
      sentence,
      card: null,
      cueAudioPath: null,
      cueStartMs: null,
      cueEndMs: null
    };
    await window.sendToAnki({ expression: sentence, imageData });
  }

  // Normalize Japanese text for fuzzy matching: NFKC + strip whitespace +
  // strip punctuation. Used to find the chunk containing a card's text.
  function normalizeJP(s) {
    if (!s) return '';
    return s.normalize('NFKC')
      .replace(/[\s　「」『』、。・…！？!?,.;:""'']/g, '');
  }

  // Find the first chunk whose normalized text CONTAINS the normalized
  // target. Returns the chunk DOM node or null.
  function findChunkForText(target) {
    const t = normalizeJP(target);
    if (!t) return null;
    for (const c of chunks) {
      const ct = normalizeJP(c.textContent);
      if (ct.includes(t)) return c;
    }
    return null;
  }

  // Scroll the chunk into view. In vertical-rl, that means aligning the
  // chunk's right edge with the viewport's right edge (where new content
  // appears in our scroll model). scrollIntoView({block: 'start'}) honors
  // writing-mode-aware logical axes in modern WebKit.
  function scrollChunkIntoView(chunk) {
    if (!chunk) return;
    try {
      chunk.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } catch (e) {
      // Fallback for older WebKit: compute scrollLeft manually.
      const cr = chunk.getBoundingClientRect();
      const sr = scrollEl.getBoundingClientRect();
      const delta = cr.right - sr.right;
      scrollEl.scrollBy({ left: delta, behavior: 'smooth' });
    }
  }

  // Center the view on the active card AND highlight that card's exact
  // text within the matched chunk. Uses the same CSS Custom Highlight
  // key (cue-active) the legacy reader uses, so the existing
  // ::highlight(cue-active) rule in theme.css recolors the text green
  // without us writing any extra CSS.
  function centerOnActiveCard() {
    try {
      const idx = window.currentCardIndex;
      if (!Number.isFinite(idx) || !Array.isArray(window.allNotes)) return;
      const card = window.allNotes[idx];
      if (!card?.expression) {
        // No active card to highlight; clear any stale highlight.
        clearCueHighlight();
        return;
      }
      const chunk = findChunkForText(card.expression);
      if (!chunk) {
        log(`centerOnActiveCard: no chunk match for "${card.expression.slice(0, 20)}..."`);
        clearCueHighlight();
        return;
      }
      log(`centerOnActiveCard: card ${idx}, chunk found, highlighting`);
      // Paint the highlight FIRST so the user sees the new active sentence
      // immediately, even before any scroll animation completes.
      setCueRangeHighlight(chunk, card.expression);
      // Then scroll if needed, respecting user-scroll grace period (5 s
      // since user manually scrolled = "they're reading independently,
      // don't yank back"). openView resets lastUserScrollTime so the
      // initial enter always centers correctly.
      if (Date.now() - lastUserScrollTime < 5000) return;
      if (!isChunkVisible(chunk)) {
        lastProgrammaticScrollTime = Date.now();
        scrollChunkIntoView(chunk);
      }
    } catch (e) { log('centerOnActiveCard error:', e.message); }
  }

  function setupScrollTracking() {
    let pendingSave = null;
    scrollEl.addEventListener('scroll', () => {
      // Distinguish user-initiated scroll from programmatic (audio-follow)
      // scroll. Anything not within 800ms of our last programmatic call
      // counts as the user actively reading.
      if (Date.now() - lastProgrammaticScrollTime > 800) {
        lastUserScrollTime = Date.now();
      }
      updateProgress();
      if (suppressScrollSave) return;
      if (pendingSave) clearTimeout(pendingSave);
      pendingSave = setTimeout(() => {
        if (currentName) {
          setPref(KEY_LAST_SCROLL_PREFIX + currentName, scrollEl.scrollLeft);
        }
      }, 400);
    }, { passive: true });
  }

  function setupResize() {
    let t;
    let lastWidth = 0;
    window.addEventListener('resize', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!viewEl || viewEl.style.display === 'none') return;
        // CRITICAL: only react to WIDTH changes. iOS Safari fires resize
        // events constantly as the URL bar hides/shows on scroll — if we
        // re-scroll on every event, the view fights the user's swipe.
        // That was the "snapping back" the user reported.
        const newW = scrollEl.clientWidth;
        if (newW === lastWidth || newW === cw) return;
        lastWidth = newW;
        const frac = sw > 0 ? Math.abs(scrollEl.scrollLeft) / sw : 0;
        recompute();
        scrollEl.scrollTo({ left: Math.round(frac * sw), behavior: 'instant' });
      }, 220);
    });
  }

  function recompute() {
    if (!scrollEl || !innerEl) return;
    cw = scrollEl.clientWidth;
    sw = innerEl.scrollWidth;
    chunks = Array.from(innerEl.querySelectorAll('.reading-chunk'));
    log(`recompute: clientW=${cw}, scrollW=${sw}, chunks=${chunks.length}`);
    updateProgress();
  }

  // No-op: no custom chrome to update. Stats / progress (if needed
  // later) would go through the shell header.
  function updateProgress() {}

  // Dict lookup via caretRangeFromPoint + CSS Custom Highlight API. No
  // DOM mutation, no scroll-state corruption.
  async function lookupAt(x, y) {
    if (typeof window.performDictLookupAtPosition !== 'function') {
      log('performDictLookupAtPosition missing');
      return;
    }
    let caret = document.caretRangeFromPoint?.(x, y) ||
                document.caretPositionFromPoint?.(x, y);
    if (!caret) return;
    let node = caret.startContainer || caret.offsetNode;
    let offset = (caret.startContainer ? caret.startOffset : caret.offset) | 0;
    if (!node) return;
    if (node.nodeType !== 3) {
      const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const t = tw.nextNode();
      if (t) { node = t; offset = 0; } else return;
    }
    if (!innerEl.contains(node)) return;
    // Walk up to nearest reading-chunk (or block-level ancestor).
    let cur = node.parentNode, chunk = null;
    while (cur && cur !== innerEl) {
      if (cur.classList?.contains('reading-chunk')) { chunk = cur; break; }
      cur = cur.parentNode;
    }
    if (!chunk) {
      cur = node.parentNode;
      while (cur && cur !== innerEl &&
             cur.tagName !== 'P' && cur.tagName !== 'DIV') {
        cur = cur.parentNode;
      }
      chunk = (cur && cur !== innerEl) ? cur : node.parentNode;
    }
    if (!chunk) return;
    // Skip if on ruby reading.
    let p = node.parentNode;
    while (p && p !== chunk) {
      if (p.tagName === 'RT' || p.tagName === 'RP') return;
      p = p.parentNode;
    }
    // Flatten chunk text (skip rt/rp), compute charIndex.
    const textNodes = [];
    let flatText = '';
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        let pp = n.parentNode;
        while (pp && pp !== chunk) {
          if (pp.tagName === 'RT' || pp.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          pp = pp.parentNode;
        }
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let nn;
    while ((nn = walker.nextNode())) { textNodes.push(nn); flatText += nn.nodeValue; }
    if (!textNodes.length) return;
    let acc = 0, charIndex = -1;
    for (const tn of textNodes) {
      if (tn === node) { charIndex = acc + offset; break; }
      acc += tn.nodeValue.length;
    }
    if (charIndex < 0 || charIndex >= flatText.length) charIndex = 0;

    const paintFn = (_ch, tns, start, len) => {
      if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
      let a = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
      const end = start + len;
      for (const t of tns) {
        const next = a + t.nodeValue.length;
        if (sNode === null && start < next) { sNode = t; sOff = start - a; }
        if (end <= next) { eNode = t; eOff = end - a; break; }
        a = next;
      }
      if (!sNode) return;
      if (!eNode) { eNode = tns[tns.length - 1]; eOff = eNode.nodeValue.length; }
      try {
        const r = new Range();
        r.setStart(sNode, sOff);
        r.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
        CSS.highlights.set('reader-dict-lookup', new Highlight(r));
      } catch (e) {}
    };

    try {
      await window.performDictLookupAtPosition(chunk, textNodes, flatText, charIndex, paintFn);
    } catch (e) { log('lookup error:', e.message); }
  }

  async function pickEpub() {
    try {
      if (!window.Capacitor?.Plugins?.FileAccess?.pickFileWithUri) {
        alert('FileAccess plugin not available — install / rebuild');
        return;
      }
      const r = await window.Capacitor.Plugins.FileAccess.pickFileWithUri({
        mime: 'application/epub+zip,*/*'
      });
      if (!r?.uri) return;
      await loadEpubFromUri(r.uri, r.name || 'book.epub');
    } catch (e) { log('pickEpub error:', e.message); }
  }

  async function loadEpubFromUri(uri, name) {
    try {
      ensureView();
      innerEl.innerHTML = `<p style="color:#888;text-align:center;margin-top:30vh;">Loading ${name}…</p>`;

      const { path } = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri });
      const response = await fetch(window.Capacitor.convertFileSrc(path));
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      const blob = await response.blob();
      const zip = await JSZip.loadAsync(blob);

      const containerXml = await zip.file('META-INF/container.xml')?.async('string');
      if (!containerXml) throw new Error('Not a valid EPUB');
      const opfPath = new DOMParser()
        .parseFromString(containerXml, 'application/xml')
        .querySelector('rootfile')?.getAttribute('full-path');
      if (!opfPath) throw new Error('No OPF rootfile');

      const opfXml = await zip.file(opfPath).async('string');
      const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
      const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';

      const manifest = {};
      opfDoc.querySelectorAll('manifest > item').forEach(item => {
        manifest[item.getAttribute('id')] = item.getAttribute('href');
      });
      const spineOrder = [...opfDoc.querySelectorAll('spine > itemref')]
        .map(ref => manifest[ref.getAttribute('idref')])
        .filter(Boolean);

      const sections = [];
      for (const href of spineOrder) {
        const fullPath = (opfDir + href).replace(/^\//, '');
        const file = zip.file(fullPath);
        if (!file) continue;
        const html = await file.async('string');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, link').forEach(el => el.remove());
        doc.querySelectorAll('img, image').forEach(el => el.remove());
        if (doc.body) sections.push(doc.body.innerHTML);
      }

      innerEl.innerHTML = sections.join('\n');

      // Tag block-level descendants as .reading-chunk for dict / scroll-snap.
      let chunkCount = 0;
      innerEl.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6').forEach(el => {
        if (el.textContent.trim().length < 2) return;
        const onlyBlockKids = Array.from(el.children).every(c =>
          ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName));
        if (onlyBlockKids && el.children.length > 0) return;
        el.classList.add('reading-chunk');
        chunkCount++;
      });

      currentName = name;
      log(`Loaded ${name}: ${sections.length} sections, ${chunkCount} chunks`);

      // Layout settles over 2 RAFs on iOS.
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      recompute();
      // Re-load SRT cues for this book and rebuild cue→chunk mapping.
      // Fire-and-forget; failures just disable audio-follow.
      Promise.resolve().then(async () => {
        try {
          await loadAudiobookCues();
          attachBgListener();
        } catch (e) {}
      });

      // Restore scrollLeft if same book; otherwise start at page 0.
      const savedName = await getPref(KEY_LAST_NAME);
      let resumeLeft = 0;
      if (savedName === name) {
        const sl = parseFloat(await getPref(KEY_LAST_SCROLL_PREFIX + name) || '0');
        if (Number.isFinite(sl)) resumeLeft = sl;
      }
      await setPref(KEY_LAST_NAME, name);
      suppressScrollSave = true;
      scrollEl.scrollTo({ left: resumeLeft, behavior: 'instant' });
      setTimeout(() => { suppressScrollSave = false; }, 200);
    } catch (e) {
      log('loadEpub error:', e);
      if (innerEl) innerEl.innerHTML =
        `<p style="color:#f66;text-align:center;margin-top:30vh;padding:0 20px;">Failed to load: ${e.message}</p>`;
    }
  }

  // ===================== AUDIO CUE FOLLOW =====================
  // Loads the SRT for the active deck/title, parses cues, builds a
  // cue → paged-chunk mapping (text fuzzy match via window.srtParser),
  // attaches a BackgroundAudio position listener. On every position
  // update, finds the matching cue and paints a CSS Custom Highlight on
  // the cue's exact text range within the chunk. Auto-scrolls if the
  // chunk is off-screen.

  async function loadAudiobookCues() {
    pagedCues = []; pagedCueToChunk = null; pagedAudioPath = null;
    if (!window.srtParser?.parseSrt) { log('srtParser missing'); return false; }

    // Get audio + SRT paths. Try title-store first (newer), fall back to
    // deck-based legacy pairings.
    let audio = null, srt = null;
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        if (t?.attachments?.audio?.path) audio = { path: t.attachments.audio.path, name: t.attachments.audio.name };
        if (t?.attachments?.srt?.path)   srt   = { path: t.attachments.srt.path,   name: t.attachments.srt.name };
      }
    } catch (e) {}
    if ((!audio || !srt) && window.getAudiobookPairingForDeck && window.getSrtPairingForDeck) {
      const deck = (typeof window.currentDeckName === 'function')
        ? window.currentDeckName() : null;
      if (deck) {
        audio = audio || await window.getAudiobookPairingForDeck(deck);
        srt   = srt   || await window.getSrtPairingForDeck(deck);
      }
    }
    if (!audio || !srt) { log('No audio/srt context for paged reader'); return false; }
    pagedAudioPath = audio.path;

    try {
      const url = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(srt.path) : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch SRT ${res.status}`);
      const text = await res.text();
      pagedCues = window.srtParser.parseSrt(text);
      log(`Loaded ${pagedCues.length} SRT cues for paged reader`);
    } catch (e) { log('SRT load failed:', e.message); return false; }

    // Build cue→chunk mapping using srtParser's helper. Each chunk needs
    // a `dataset.norm` containing normalized text — buildCueChunkMaps
    // reads it.
    for (const c of chunks) c.dataset.norm = normalizeJP(c.textContent);
    if (chunks.length && pagedCues.length && window.srtParser?.buildCueChunkMaps) {
      const maps = window.srtParser.buildCueChunkMaps(pagedCues, chunks, normalizeJP);
      pagedCueToChunk = maps.cueToChunk;
      let matched = 0;
      for (let i = 0; i < pagedCueToChunk.length; i++) if (pagedCueToChunk[i] >= 0) matched++;
      log(`Paged cue→chunk: ${matched}/${pagedCues.length} mapped`);
    }
    return true;
  }

  async function attachBgListener() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg?.addListener) { log('attachBgListener: no BackgroundAudio plugin'); return; }
    if (!bgListenerHandle) {
      try {
        await bg.addListener('position', (d) => {
          if (!viewEl || viewEl.style.display === 'none') return;
          onPositionUpdate(d?.positionMs || 0);
        });
        bgListenerHandle = true;
        log('Paged reader: BG audio listener attached');
      } catch (e) {
        log('attachBgListener: addListener failed:', e?.message);
      }
    }
    // Initial paint based on current state.
    try {
      if (typeof bg.getState === 'function') {
        const s = await bg.getState();
        log(`attachBgListener: initial getState positionMs=${s?.positionMs}`);
        if (s && Number.isFinite(s.positionMs)) {
          lastHighlightedCue = -1;
          onPositionUpdate(s.positionMs);
        }
      }
    } catch (e) { log('attachBgListener: getState failed:', e?.message); }

  }

  function onPositionUpdate(positionMs) {
    if (!pagedCues.length || !window.srtParser?.findCueAtTime) {
      // Log once-per-context to avoid spam; only when state changes.
      if (!window._pagedAudioWarned) {
        log(`onPositionUpdate: cues=${pagedCues.length}, parser=${!!window.srtParser?.findCueAtTime}`);
        window._pagedAudioWarned = true;
      }
      return;
    }
    const idx = window.srtParser.findCueAtTime(pagedCues, positionMs);
    if (idx === lastHighlightedCue) return;
    lastHighlightedCue = idx;
    log(`onPositionUpdate: cue ${idx} @ ${positionMs}ms`);
    if (idx < 0) { clearCueHighlight(); return; }
    paintCueHighlight(idx);
  }

  function clearCueHighlight() {
    try { CSS.highlights?.delete?.('cue-active'); } catch (e) {}
    try { CSS.highlights?.delete?.('cue-pending'); } catch (e) {}
    document.body.classList.remove('has-cue-highlight');
  }

  function paintCueHighlight(cueIdx) {
    const cue = pagedCues[cueIdx];
    if (!cue?.text) return;
    // Try the pre-built cue→chunk map first; fall back to live text
    // search if the map missed (e.g. buildCueChunkMaps' forward-cursor
    // skipped past a chunk, or the map wasn't fully populated when this
    // event fired).
    let chunkIdx = pagedCueToChunk ? pagedCueToChunk[cueIdx] : -1;
    let chunk = (chunkIdx >= 0) ? chunks[chunkIdx] : null;
    if (!chunk) chunk = findChunkForText(cue.text);
    if (!chunk) {
      log(`paintCueHighlight: no chunk for cue ${cueIdx} "${cue.text.slice(0, 20)}"`);
      return;
    }
    setCueRangeHighlight(chunk, cue.text);
    // Auto-scroll only when the cue's chunk has left the viewport
    // entirely. Within a paragraph (same chunk, multiple cues), the
    // highlight moves but the chunk stays visible and we don't scroll.
    // 5-second user-scroll grace period prevents yank-back during
    // manual reading.
    if (Date.now() - lastUserScrollTime < 5000) return;
    if (!isChunkVisible(chunk)) {
      lastProgrammaticScrollTime = Date.now();
      scrollChunkIntoView(chunk);
    }
  }

  // Set a CSS Custom Highlight on the exact cue text within the chunk.
  // Mirrors the legacy reader's setCueHighlightFor logic: walks text
  // nodes (skip rt/rp), normalizes, locates the cue's normalized index
  // in the chunk's normalized text, maps back to raw offsets and finally
  // (node, offset) pairs for a Range.
  function setCueRangeHighlight(chunk, cueText) {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    const textNodes = [];
    let flat = '';
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        let p = n.parentNode;
        while (p && p !== chunk) {
          if (p.tagName === 'RT' || p.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) { textNodes.push(n); flat += n.nodeValue; }
    if (!flat) return;
    const normCue = normalizeJP(cueText);
    if (!normCue) { clearCueHighlight(); return; }
    const normFlat = normalizeJP(flat);
    const normStart = normFlat.indexOf(normCue);
    if (normStart < 0) { clearCueHighlight(); return; }
    const normEnd = normStart + normCue.length;
    // Map normalized indices back to raw indices in `flat`.
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let rawStart = -1, rawEnd = flat.length, np = 0;
    for (let i = 0; i < flat.length; i++) {
      if (rawStart < 0 && np >= normStart) rawStart = i;
      if (np >= normEnd) { rawEnd = i; break; }
      if (!STRIP.test(flat[i])) np++;
    }
    if (rawStart < 0) { clearCueHighlight(); return; }
    // Convert raw index → (text node, offset).
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const tn of textNodes) {
      const next = acc + tn.nodeValue.length;
      if (sNode === null && rawStart < next) { sNode = tn; sOff = rawStart - acc; }
      if (rawEnd <= next) { eNode = tn; eOff = rawEnd - acc; break; }
      acc = next;
    }
    if (!sNode) return;
    if (!eNode) { eNode = textNodes[textNodes.length - 1]; eOff = eNode.nodeValue.length; }
    try {
      const r = new Range();
      r.setStart(sNode, sOff);
      r.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      CSS.highlights.set('cue-active', new Highlight(r));
      document.body.classList.add('has-cue-highlight');
    } catch (e) {}
  }

  function isChunkVisible(chunk) {
    const cr = chunk.getBoundingClientRect();
    const sr = scrollEl.getBoundingClientRect();
    // Vertical-rl content: visible means the chunk's bounding rect
    // intersects the viewport horizontally.
    return cr.right > sr.left && cr.left < sr.right;
  }

  // Load the EPUB attached to the currently active title, if we haven't
  // already loaded that title. Returns true if a load was attempted.
  let currentTitleId = null;
  async function tryLoadFromActiveTitle() {
    try {
      if (!window.titleStore || !window._activeTitleId) return false;
      // Don't reload the same book we already have.
      if (window._activeTitleId === currentTitleId &&
          innerEl.querySelector('.reading-chunk')) return false;
      const titles = await window.titleStore.list();
      const t = titles.find(x => x.id === window._activeTitleId);
      const ep = t?.attachments?.epub;
      if (!ep?.uri || !ep?.name) return false;
      currentTitleId = window._activeTitleId;
      log(`Auto-load from active title: ${ep.name}`);
      await loadEpubFromUri(ep.uri, ep.name);
      return true;
    } catch (e) {
      log('tryLoadFromActiveTitle error:', e.message);
      return false;
    }
  }

  async function openView() {
    ensureView();
    viewEl.style.display = 'flex';
    // CRITICAL: hide the LEGACY reader so it doesn't run audio sync
    // underneath us.
    const legacyView = document.getElementById('readingModeView');
    if (legacyView) legacyView.style.display = 'none';
    document.body.classList.remove('chrome-hidden');
    setPref(KEY_USE_PAGED, '1');
    installReadingRouteOverride();

    // Reset user-scroll timestamp so the initial center-on-card always
    // fires regardless of whether the user scrolled in a prior session.
    lastUserScrollTime = 0;

    // Auto-load EPUB from the active title.
    await tryLoadFromActiveTitle();

    if (innerEl.querySelector('.reading-chunk')) {
      setTimeout(async () => {
        recompute();
        centerOnActiveCard();
        await loadAudiobookCues();
        attachBgListener();
      }, 80);
    }
  }
  function closeView() { if (viewEl) viewEl.style.display = 'none'; }

  // Re-enable card-change sync: when the active card changes (via swipe
  // in card mode, or audio-driven cue→card mapping), update the reader's
  // highlight + position. The 5-second user-scroll grace period inside
  // centerOnActiveCard prevents this from yanking the view when the user
  // is reading independently.
  function hookCardSync() {
    const original = window.notifyCardIndexChanged;
    window.notifyCardIndexChanged = function (idx) {
      try { if (typeof original === 'function') original(idx); } catch (e) {}
      if (viewEl && viewEl.style.display !== 'none') {
        try { centerOnActiveCard(); } catch (e) {}
      }
    };
  }

  // Mode-switch handler. Shell fires `shell:mode-change` with detail.mode
  // ∈ {card, read, audio}. The paged reader is a free-floating view, not
  // managed by shell — so we hide it whenever the user switches away,
  // and re-show on read. Without this, the paged reader stayed visible
  // covering the card/audio views.
  function hookModeSwitch() {
    window.addEventListener('shell:mode-change', (e) => {
      const mode = e?.detail?.mode;
      if (!viewEl) return;
      if (mode === 'read') {
        // Only show if user has paged enabled (the route override
        // already takes care of opening it; this is defensive).
        // Don't re-show if user hasn't activated paged this session.
      } else if (viewEl.style.display !== 'none') {
        viewEl.style.display = 'none';
      }
    });
  }

  // Hook into READ-tab routing: override window.openReadingMode so tapping
  // the READ tab opens the paged reader instead of the legacy scroll reader.
  // Idempotent (guarded via window._openReadingModeLegacy) so we can call
  // it both at boot (if pref already set) AND the moment the user opts in
  // mid-session (so they don't have to relaunch).
  function installReadingRouteOverride() {
    if (window._openReadingModeLegacy) return; // already installed
    const legacy = window.openReadingMode;
    if (typeof legacy !== 'function') return;
    window._openReadingModeLegacy = legacy;
    window.openReadingMode = async function () {
      openView();
    };
    log('Paged reader override active');
  }

  async function maybeInstallReadingRouteOverride() {
    if (!PREF) return;
    try {
      const r = await PREF.get({ key: KEY_USE_PAGED });
      if (r?.value !== '1') return;
      installReadingRouteOverride();
    } catch (e) {}
  }

  // Allow Preferences to flip the switch back to the legacy reader.
  async function disablePagedReader() {
    await setPref(KEY_USE_PAGED, '0');
    if (window._openReadingModeLegacy) {
      window.openReadingMode = window._openReadingModeLegacy;
    }
    closeView();
  }

  window.openPagedReader     = openView;
  window.closePagedReader    = closeView;
  window.disablePagedReader  = disablePagedReader;

  // Boot-time setup. Each hook is wrapped in its own try/catch so a
  // failure in one doesn't break the others (and doesn't break the
  // whole app boot). A kill switch via localStorage["PAGED_DISABLE"]="1"
  // lets the user (or us) disable the route override entirely if the
  // paged reader is misbehaving — they can still open it manually from
  // Preferences.
  function safeBoot() {
    try { hookCardSync(); } catch (e) { console.warn('[paged] hookCardSync failed:', e); }
    try { hookModeSwitch(); } catch (e) { console.warn('[paged] hookModeSwitch failed:', e); }
    let killed = false;
    try { killed = localStorage.getItem('PAGED_DISABLE') === '1'; } catch (e) {}
    if (killed) {
      console.warn('[paged] route override disabled via PAGED_DISABLE=1');
      return;
    }
    try { maybeInstallReadingRouteOverride(); } catch (e) {
      console.warn('[paged] maybeInstallReadingRouteOverride failed:', e);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeBoot);
  } else {
    safeBoot();
  }
})();
