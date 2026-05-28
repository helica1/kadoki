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
  // Shared Highlight instance for the 'cue-active' key. Reused across
  // every paint so WebKit's invalidator sees a single object whose
  // range set changes, instead of a fresh Highlight per cue (which left
  // ghost paints in iOS WKWebView during scroll animations).
  let activeCueHighlight = null;
  let progressEl = null;
  let totalChars = 0;
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
      /* Tiny progress label that sits in the top safe-area strip, to
         the LEFT of the Dynamic Island. Vertically centered in the band
         between the top of the display and the appHeader (which starts
         at env(safe-area-inset-top)), so the rounded display corner
         doesn't clip it. */
      #readingPagedProgress {
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) / 2);
        transform: translateY(-50%);
        left: calc(env(safe-area-inset-left, 0px) + 12px);
        padding: 10px 12px;
        font: 10px/1 var(--font-sans, system-ui);
        color: #aaa;
        letter-spacing: .03em;
        background: transparent;
        z-index: 9001;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        direction: ltr;
        white-space: nowrap;
        transition: opacity .18s ease;
      }
      #readingPagedProgress:active { opacity: .55; }
      body.chrome-hidden #readingPagedProgress {
        opacity: 0;
        pointer-events: none;
      }
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
         popup-close handler clears it via window._clearReaderDictHighlight.
         Uses the user's READ-mode accent color (set via Preferences →
         Mode colors). Heavy translucent fill + thick wavy underline so
         it remains conspicuous even when sitting on top of cue-active
         text. ::highlight() only supports background-color + text-
         decoration; no borders, no box-shadow. Text color intentionally
         NOT set so the underlying cue-active / normal text color stays. */
      ::highlight(reader-dict-lookup) {
        background: color-mix(in srgb, var(--accent-read, #4caf50) 60%, transparent);
        text-decoration: underline wavy var(--accent-read, #4caf50) 3px;
        text-underline-offset: 5px;
        text-decoration-skip-ink: none;
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
    ensureProgressStrip();

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
    let dismissedPopupOnStart = false;
    scrollEl.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      tStart = Date.now(); canTap = true;
      touchStartTarget = e.target;
      // Track whether THIS tap dismissed an open popup so touchend can
      // choose the right follow-up: tap on TEXT → run a new lookup
      // (replace popup), tap on EMPTY space → just dismiss (no chrome
      // toggle either, since the user's intent was clearly "close it").
      dismissedPopupOnStart = false;
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        popup.style.display = 'none';
        popup.innerHTML = '';
        try { window._clearReaderDictHighlight?.(); } catch (er) {}
        dismissedPopupOnStart = true;
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
      const chunk = chunkAtTapPoint(t.clientX, t.clientY);
      if (chunk) {
        // Always look up text taps — even if this tap just dismissed an
        // open popup. Without this, tapping a new word with an open
        // popup only dismissed the popup and never ran a new lookup,
        // forcing the user to tap-then-tap-again. That's what the
        // "flashing, never shows definition" symptom traced back to.
        lookupAt(t.clientX, t.clientY);
      } else if (!dismissedPopupOnStart) {
        // Empty-space tap with NO open popup → toggle chrome. If this
        // tap dismissed a popup, the user's intent was "close" — don't
        // also toggle the chrome.
        toggleChrome();
      }
      // Also stamp the global so enhanced-dictionary's legacy reader
      // dismiss path (which still listens) knows we just handled it.
      if (dismissedPopupOnStart) window._dictPopupDismissedTs = Date.now();
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

  // Find the SRT cue whose text covers the tapped charIndex inside `chunk`.
  // Locates each candidate cue's normalized text inside the chunk's
  // normalized text, picks the one whose range contains the tap. If no
  // cue maps to this chunk, returns null.
  function findCueForTap(chunk, flatText, charIndex) {
    if (!pagedCues?.length || !chunks?.length) return null;
    const chunkIdx = chunks.indexOf(chunk);
    if (chunkIdx < 0) return null;
    // Build the normalized version of the chunk text + a raw-to-norm
    // position map. We need to translate the raw `charIndex` into a
    // normalized index so we can compare against normalized cue text.
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let normIdx = 0;
    for (let i = 0; i < charIndex && i < flatText.length; i++) {
      if (!STRIP.test(flatText[i])) normIdx++;
    }
    const normFlat = normalizeJP(flatText);
    // Look at every cue mapped to this chunk; if no map, fall back to
    // scanning all cues for ones whose normalized text appears in the
    // chunk (slower but works without prebuilt map).
    const candidateIdxs = [];
    if (pagedCueToChunk) {
      for (let i = 0; i < pagedCueToChunk.length; i++) {
        if (pagedCueToChunk[i] === chunkIdx) candidateIdxs.push(i);
      }
    }
    if (!candidateIdxs.length) {
      for (let i = 0; i < pagedCues.length; i++) candidateIdxs.push(i);
    }
    // Strict containment only — return the cue whose text range covers
    // the tap. NO fallback to "closest cue", because that produced the
    // "Anki got the wrong sentence" symptom: tap on a kanji in cue N,
    // findCue returns cue N+1 because the tap landed on a normalized
    // index that's slightly past N's end but close to N+1's start.
    for (const ci of candidateIdxs) {
      const cue = pagedCues[ci];
      const normCue = normalizeJP(cue?.text || '');
      if (!normCue) continue;
      const start = normFlat.indexOf(normCue);
      if (start < 0) continue;
      const end = start + normCue.length;
      if (normIdx >= start && normIdx < end) {
        return { cue, idx: ci, normStart: start, normEnd: end };
      }
    }
    return null;
  }

  function bindCueLookupContext(chunk, flatText, charIndex) {
    try {
      const sentence = chunk?.textContent?.trim?.() || flatText.trim();
      const found = findCueForTap(chunk, flatText, charIndex);
      if (found?.cue) {
        const cueText = String(found.cue.text || '').trim();
        window.lookupContext = {
          source: 'paged-reader',
          sentence: cueText || sentence,
          card: null,
          cueAudioPath: pagedAudioPath || null,
          cueStartMs:   Number.isFinite(found.cue.startMs) ? found.cue.startMs : null,
          cueEndMs:     Number.isFinite(found.cue.endMs)   ? found.cue.endMs   : null,
          cueIndex:     found.idx,
          cues:         null
        };
      } else {
        // No cue mapping — still bind sentence so Anki gets the chunk's
        // text. Audio fields stay null; sendToAnki will skip audio if
        // nothing's there.
        window.lookupContext = {
          source: 'paged-reader',
          sentence,
          card: null,
          cueAudioPath: null,
          cueStartMs:   null,
          cueEndMs:     null
        };
      }
    } catch (e) { log('bindCueLookupContext error:', e.message); }
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
      const range = setCueRangeHighlight(chunk, card.expression);
      // Then scroll if any part of the highlight overflows the viewport,
      // respecting the user-scroll grace period (5 s = "they're reading
      // independently, don't yank back"). openView resets
      // lastUserScrollTime so the initial enter always centers correctly.
      if (Date.now() - lastUserScrollTime < 5000) return;
      // For the initial center-on-card we want full-on centering even if
      // the chunk itself is partly off-screen with no highlight overflow
      // yet. Fall back to chunk-based scroll if range overflow is zero
      // but the chunk isn't visible.
      const rangeRect = range?.getBoundingClientRect();
      const sr = scrollEl?.getBoundingClientRect();
      const rangeOverflows = !!(range && rangeRect && sr &&
        (rangeRect.left < sr.left || rangeRect.right > sr.right));
      if (rangeOverflows) {
        autoScrollForRange(range);
      } else if (!isChunkVisible(chunk)) {
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

  // Create the progress strip once and keep it as a sibling of body so
  // it survives across paged-view rebuilds. Click AND touchend both
  // trigger the jump prompt — Capacitor WKWebView sometimes drops the
  // synthetic click after touchend, so wiring both is the reliable
  // pattern (same one shell-menu items use).
  function ensureProgressStrip() {
    if (progressEl) return;
    progressEl = document.createElement('div');
    progressEl.id = 'readingPagedProgress';
    progressEl.textContent = '–';
    let firing = false;
    const fire = (e) => {
      if (firing) return;
      firing = true;
      try { e.stopPropagation(); } catch (_) {}
      try { if (e.cancelable) e.preventDefault(); } catch (_) {}
      openJumpModal();
      setTimeout(() => { firing = false; }, 500);
    };
    progressEl.addEventListener('click', fire);
    progressEl.addEventListener('touchend', fire, { passive: false });
    document.body.appendChild(progressEl);
  }

  // Custom in-app modal — Capacitor's WKWebView doesn't reliably show
  // native window.prompt() dialogs (silently dropped), so we render a
  // styled dialog inside the document instead.
  function openJumpModal() {
    if (!scrollEl || !totalChars) return;
    const sw = scrollEl.scrollWidth - scrollEl.clientWidth;
    if (sw <= 0) return;
    if (document.getElementById('pagedJumpModal')) return;
    const curFrac = Math.min(1, Math.max(0, Math.abs(scrollEl.scrollLeft) / sw));
    const curPct = (curFrac * 100).toFixed(1);
    const modal = document.createElement('div');
    modal.id = 'pagedJumpModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:24px;direction:ltr;';
    modal.innerHTML = `
      <div style="background:#161616;border:1px solid #333;border-radius:14px;padding:20px;width:100%;max-width:340px;box-shadow:0 12px 36px rgba(0,0,0,.6);">
        <div style="font:600 13px/1.3 var(--font-sans,system-ui);color:#ddd;margin-bottom:6px;">Jump to location</div>
        <div style="font:11px/1.4 var(--font-sans,system-ui);color:#888;margin-bottom:12px;">Percent (0–100) or character count. Currently ${curPct}%.</div>
        <input id="pagedJumpInput" type="text" inputmode="decimal" autocomplete="off"
          value="${curPct}"
          style="width:100%;background:#0c0c0c;border:1px solid #333;border-radius:8px;padding:10px 12px;font:14px var(--font-sans,system-ui);color:#eee;box-sizing:border-box;" />
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
          <button id="pagedJumpCancel" style="background:transparent;border:1px solid #444;color:#bbb;padding:8px 14px;border-radius:8px;font:600 12px var(--font-sans,system-ui);cursor:pointer;">Cancel</button>
          <button id="pagedJumpGo" style="background:var(--accent-read,#4caf50);border:none;color:#000;padding:8px 16px;border-radius:8px;font:700 12px var(--font-sans,system-ui);cursor:pointer;">Go</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#pagedJumpInput');
    const close = () => modal.remove();
    const submit = () => {
      const n = parseFloat(String(input.value || '').trim().replace(/[, %]/g, ''));
      close();
      if (!Number.isFinite(n) || n < 0) return;
      const frac = Math.min(1, Math.max(0, n <= 100 ? n / 100 : n / totalChars));
      const target = frac * sw;
      const sign = scrollEl.scrollLeft < 0 ? -1 : 1;
      lastUserScrollTime = Date.now();
      scrollEl.scrollTo({ left: sign * target, behavior: 'smooth' });
    };
    modal.querySelector('#pagedJumpCancel').addEventListener('click', close);
    modal.querySelector('#pagedJumpGo').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 60);
  }

  // Update the progress strip. Reads the scroll fraction and multiplies
  // by totalChars. Cheap enough to run on every scroll event.
  function updateProgress() {
    if (!progressEl || !scrollEl || !totalChars) return;
    const sw = scrollEl.scrollWidth - scrollEl.clientWidth;
    if (sw <= 0) { progressEl.textContent = '–'; return; }
    // scrollLeft can be negative (vertical-rl in some WebKit builds) or
    // positive (with direction:rtl on the scroll container). Use the
    // absolute value for the fraction.
    const frac = Math.min(1, Math.max(0, Math.abs(scrollEl.scrollLeft) / sw));
    const cur = Math.round(totalChars * frac);
    const pct = Math.round(frac * 1000) / 10;
    progressEl.textContent = `${cur.toLocaleString()} / ${totalChars.toLocaleString()} · ${pct}%`;
  }

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

    // Bind window.lookupContext to the cue containing the tapped position
    // BEFORE handing off to performDictLookupAtPosition — the dict popup's
    // "+ Anki" button reads from this. We want the SENTENCE field on the
    // resulting Anki card to be the sentence the tapped word lives in,
    // not the currently-playing cue or the legacy reader's stale state.
    // Audio fields follow the same cue so they always match the sentence.
    bindCueLookupContext(chunk, flatText, charIndex);

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
        // Mutate-in-place: reuse one Highlight via clear()+add(). With
        // `new Highlight(r)` + set(), iOS WKWebView in vertical-rl leaks
        // ghost paints from the previous range until the next layout
        // pass — same bug class as the cue-active highlight. Forcing
        // a layout read after add() flushes the invalidation.
        if (!window._dictLookupHl) window._dictLookupHl = new Highlight();
        window._dictLookupHl.clear();
        window._dictLookupHl.add(r);
        CSS.highlights.set('reader-dict-lookup', window._dictLookupHl);
        if (scrollEl) void scrollEl.offsetWidth;
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
      // Also accumulate per-chunk char offsets for the bottom progress
      // indicator (treat ruby <rt>/<rp> as zero-cost — count base text only).
      let chunkCount = 0;
      let charAcc = 0;
      innerEl.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6').forEach(el => {
        if (el.textContent.trim().length < 2) return;
        const onlyBlockKids = Array.from(el.children).every(c =>
          ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName));
        if (onlyBlockKids && el.children.length > 0) return;
        el.classList.add('reading-chunk');
        // Count visible text length (strip ruby readings).
        let txt = el.textContent || '';
        el.querySelectorAll('rt, rp').forEach(r => {
          txt = txt.replace(r.textContent, '');
        });
        const len = txt.length;
        el.dataset.charOffset = String(charAcc);
        el.dataset.charLen = String(len);
        charAcc += len;
        chunkCount++;
      });
      totalChars = charAcc;

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
    // No-op now that highlight sync is driven by the legacy reader's
    // 'position' handler via the window.__onPagedCueUpdate hook. Keeping
    // a stub so the call site in openView still works. We intentionally
    // do NOT register a second listener — two listeners both painted
    // 'cue-active' with potentially different cue indices (legacy's
    // abCues vs paged's pagedCues can map differently), producing the
    // multi-highlight artifact the user reported.
    log('attachBgListener: deferring to legacy position handler + __onPagedCueUpdate hook');
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
    try { activeCueHighlight?.clear?.(); } catch (e) {}
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
    const range = setCueRangeHighlight(chunk, cue.text);
    if (Date.now() - lastUserScrollTime < 5000) return;
    autoScrollForRange(range);
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
    // Two off-by-ones to avoid:
    //  1. rawStart must skip LEADING strip chars — when normStart lands at
    //     a sentence boundary, the previous sentence's trailing 。 occupies
    //     the same normalized position as the current sentence's first
    //     char, and setting rawStart there paints the previous period.
    //  2. rawEnd must EXTEND OVER trailing strip chars — the cue text from
    //     the SRT includes the closing 。/、 but normalizeJP strips them,
    //     so the loop stops one char early and the closing punctuation
    //     stays unhighlighted.
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let rawStart = -1, rawEnd = flat.length, np = 0;
    for (let i = 0; i < flat.length; i++) {
      if (rawStart < 0 && np >= normStart && !STRIP.test(flat[i])) rawStart = i;
      if (np >= normEnd) { rawEnd = i; break; }
      if (!STRIP.test(flat[i])) np++;
    }
    if (rawStart < 0) { clearCueHighlight(); return; }
    while (rawEnd < flat.length && STRIP.test(flat[rawEnd])) rawEnd++;
    // Convert raw index → (text node, offset).
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const tn of textNodes) {
      const next = acc + tn.nodeValue.length;
      if (sNode === null && rawStart < next) { sNode = tn; sOff = rawStart - acc; }
      if (rawEnd <= next) { eNode = tn; eOff = rawEnd - acc; break; }
      acc = next;
    }
    if (!sNode) return null;
    if (!eNode) { eNode = textNodes[textNodes.length - 1]; eOff = eNode.nodeValue.length; }
    try {
      const r = new Range();
      r.setStart(sNode, sOff);
      r.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      // Reuse a single Highlight across all paints — clear its range
      // set, then add the new one, then re-set on the registry. Creating
      // a fresh Highlight via `new Highlight(r)` + replace caused
      // residual "ghost" green ranges to linger in iOS WKWebView, as if
      // the previous Highlight's painted region was never invalidated.
      // Mutating an existing Highlight via clear()+add() forces WebKit
      // to recompute the painted area against the new range set.
      if (!activeCueHighlight) {
        activeCueHighlight = new Highlight();
      }
      activeCueHighlight.clear();
      activeCueHighlight.add(r);
      // Re-set on the registry to ensure the registry knows the highlight
      // is current (set-after-mutate is the documented pattern; some
      // browsers paint immediately on add, others need the registry
      // re-publish to trigger invalidation).
      CSS.highlights.set('cue-active', activeCueHighlight);
      document.body.classList.add('has-cue-highlight');
      // Force a synchronous layout read so the new highlight invalidation
      // is flushed before any subsequent paint queues up. Without this,
      // rapid back-to-back paints during a smooth scroll animation could
      // batch and the older range's paint would survive to the next
      // frame.
      void scrollEl.offsetWidth;
      return r;
    } catch (e) { return null; }
  }

  // Decide whether to scroll based on the painted range's actual extent.
  // - Fully visible → no scroll.
  // - Range wider than the viewport → too long to fit; skip auto-scroll
  //   and let the user pan freely until the NEXT cue lands somewhere
  //   that fits.
  // - Otherwise → scroll by exactly the overflow amount. Signs are
  //   determined empirically: in this WKWebView with vertical-rl content
  //   and direction:rtl on the scroll container, a NEGATIVE scrollBy.left
  //   advances forward (= leftward in screen space, which is the natural
  //   reading direction for vertical Japanese). A POSITIVE scrollBy.left
  //   scrolls backward (= rightward, toward earlier text).
  function autoScrollForRange(range) {
    if (!range || !scrollEl) return;
    const rangeRect = range.getBoundingClientRect();
    const sr = scrollEl.getBoundingClientRect();
    if (!rangeRect.width || !sr.width) return;
    // Oversized cue — won't fit on a single page even after scrolling.
    // Skip and let the user pan; the NEXT cue gets another chance.
    if (rangeRect.width > sr.width * 0.95) return;
    // Don't scroll if the entire cue is already visible. The point of
    // auto-scroll is to bring an off-screen / clipped cue back into view,
    // not to nudge to a different position each line. The user explicitly
    // wants the page to stay put while a cue is fully readable, and only
    // shift when the cue runs off the edge.
    const fullyVisible = rangeRect.left >= sr.left && rangeRect.right <= sr.right;
    if (fullyVisible) return;
    // Cue overflows on one side (or is entirely off-screen). Right-justify
    // the cue's BEGINNING at the viewport's right edge (= top-right of
    // the first vertical column = where reading starts in vertical-rl).
    const pad = Math.min(24, sr.width * 0.05);
    const targetX = sr.right - pad;
    // Positive delta = scroll backward (= rightward in screen space).
    // Negative delta = scroll forward (= leftward, reading direction).
    const delta = rangeRect.right - targetX;
    if (Math.abs(delta) < 4) return;
    lastProgrammaticScrollTime = Date.now();
    scrollEl.scrollBy({ left: delta, behavior: 'smooth' });
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
    document.body.classList.add('has-paged-progress');
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
  function closeView() {
    if (viewEl) viewEl.style.display = 'none';
    document.body.classList.remove('has-paged-progress');
  }

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
      const pagedShown = viewEl.style.display !== 'none';
      if (mode === 'read') {
        // Show progress strip only when paged reader is the active view.
        if (pagedShown) document.body.classList.add('has-paged-progress');
      } else {
        if (pagedShown) viewEl.style.display = 'none';
        document.body.classList.remove('has-paged-progress');
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

  // Hook invoked by the legacy reading-mode.js position handler on every
  // audio cue change. Legacy already owns the BackgroundAudio 'position'
  // listener and computes the active cue index against `abCues`; rather
  // than register a second listener (which fought legacy for the same
  // CSS.highlights 'cue-active' key and lost the race), we piggyback.
  // Receives (idx, cue) — `cue` may be null when idx<0.
  window.__onPagedCueUpdate = function (idx, cue) {
    if (!viewEl || viewEl.style.display === 'none') return;
    if (idx === lastHighlightedCue) return;
    lastHighlightedCue = idx;
    if (idx < 0 || !cue?.text) { clearCueHighlight(); return; }
    // Locate the chunk by cue text. Reuse findChunkForText fallback so
    // this works even when `loadAudiobookCues` hasn't populated our own
    // pagedCueToChunk map yet.
    let chunk = null;
    if (pagedCueToChunk && pagedCueToChunk[idx] >= 0) {
      chunk = chunks[pagedCueToChunk[idx]] || null;
    }
    if (!chunk) chunk = findChunkForText(cue.text);
    if (!chunk) return;
    const range = setCueRangeHighlight(chunk, cue.text);
    if (!range || !scrollEl) return;
    // No user-scroll grace gate here — this hook only fires when the
    // cue INDEX changes (the earlier `idx === lastHighlightedCue` early
    // return guarantees that). Every new cue is a fresh chance to snap,
    // and autoScrollForRange itself returns early when the cue is fully
    // visible, so cues that DO fit on the current page never trigger a
    // scroll regardless of grace. The grace check used to swallow new
    // cues that landed partially off-screen right after a manual pan,
    // which the user perceived as "doesn't snap until later."
    autoScrollForRange(range);
  };

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
