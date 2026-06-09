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
  let pagedChunkToCue = null;// paged chunk index → first cue index (for read-position tracking)
  let lastReadCueIdx = -1;   // current reading location as a cue (reset per book in loadAudiobookCues)
  let savedReadScrollLeft = null; // cached saved scrollLeft for the current book (sync restore)
  // True when the current pagedCueToChunk came from the preprocessing
  // module (cue-alignment.js). When true, an unmatched cue (idx -1)
  // is treated as "no painting, no scrolling" instead of falling back
  // to findChunkForText — see __onPagedCueUpdate below for why that
  // matters. False = legacy srtParser.buildCueChunkMaps was used, so
  // the conservative fallback chain stays active for safety.
  let pagedCueMapFromAlignment = false;
  // True once the initial alignment-based scroll-to-first-match has
  // happened for the active book. Prevents repeated overrides if the
  // alignment is rebuilt mid-session (e.g., audio/srt repaired).
  let pagedInitialScrollDone = false;
  let lastHighlightedCue = -1;
  // Index in chunks[] of the chunk currently painted green — the anchor for
  // bounded local searches when a cue isn't in the alignment map, so the
  // highlight keeps following the subtitle locally instead of skipping lines.
  let lastHighlightedChunkIdx = -1;
  let bgListenerHandle = null;
  // Shared Highlight instance for the 'cue-active' key. Reused across
  // every paint so WebKit's invalidator sees a single object whose
  // range set changes, instead of a fresh Highlight per cue (which left
  // ghost paints in iOS WKWebView during scroll animations).
  let activeCueHighlight = null;
  let selectionHighlight = null;  // shared Highlight for 'reader-selection'
  let selectedCue = null;          // { cue, idx, chunk } when a swipe-up selected a sentence
  let progressEl = null;
  let totalChars = 0;     // RAW char total — flat-text coordinate (cue align / highlight)
  let totalJpChars = 0;   // Japanese-only total (ttu standard) — what we DISPLAY
  // Auto-scroll grace period: don't yank the view back if the user
  // manually scrolled within the last 5 seconds.
  let lastUserScrollTime = 0;
  // Monotonic scroll id: each scrollChunkNearRightWithContext bumps it; a pending
  // 600ms verifier re-forces scrollLeft ONLY if it's still the newest scroll, so
  // two scrolls within 600ms can't ping-pong (the card<->read oscillation).
  let _scrollSeq = 0;
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
      /* Wide layouts — landscape, OR a wide foldable/tablet (≥600px) in any
         orientation: the standalone top-left strip wastes the extra horizontal
         room (and in landscape gets cut off by the rotated Dynamic Island), so
         swap to the inline copy injected inside #appHeader between the mode
         tabs and the timer. Mirrors the iPhone landscape position. Narrow
         phones keep the top-left strip. */
      #readingPagedProgressInline { display: none; }
      @media (orientation: landscape), (min-width: 600px) {
        #readingPagedProgress { display: none !important; }
        #readingPagedProgressInline { display: inline-block !important; }
      }
      body.chrome-hidden #readingPagedProgressInline {
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
        /* Prefer the appearance-system var (--font-size-read) so the
           preferences slider takes effect; fall back to the older
           --reader-font-size var which earlier builds set, then to a
           literal default. */
        font-size: var(--font-size-read, var(--reader-font-size, 1.5rem));
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
        /* Honour the appearance font picker (--font-family-read, incl. imported
           custom fonts); fall back to the vertical-capable Hiragino mincho
           stack when unset. This rule's !important also overrides the EPUB's
           own fonts so the reader font wins. */
        font-family: var(--font-family-read, "Hiragino Mincho ProN", "Hiragino Mincho Pro",
                     "YuMincho", "Yu Mincho", serif) !important;
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
      /* Cue selected by user swipe-up — clean mode-color tinted text,
         NO background fill. Wins over cue-active because it's set after
         cue-active in the stylesheet. */
      ::highlight(reader-selection) {
        color: var(--accent-read, #4caf50);
      }
      /* Floating action menu that appears next to the selected cue. */
      #pagedSelectionMenu {
        position: fixed;
        z-index: 9100;
        display: flex;
        gap: 6px;
        padding: 6px;
        background: rgba(20, 22, 26, .96);
        border: 1px solid #2a2f36;
        border-radius: 10px;
        box-shadow: 0 6px 22px rgba(0,0,0,.55);
        font: 12px var(--font-sans, system-ui);
      }
      #pagedSelectionMenu button {
        background: transparent;
        color: #ddd;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 6px 10px;
        font: 600 11px var(--font-sans, system-ui);
        letter-spacing: .04em;
        cursor: pointer;
        white-space: nowrap;
      }
      #pagedSelectionMenu button:active { background: rgba(255,255,255,.07); }
      /* Play-from-here button — positioned ABOVE the shell's play/pause
         icon, in the safe-area band right of the Dynamic Island. Top
         offset is computed directly (no transform) because translateY
         on iOS WKWebView can shift the hit-test region away from the
         visual region for fixed elements. Horizontal left is set
         imperatively in positionPlayheadBtn to track #shellPlayBtn. */
      #pagedPlayheadBtn {
        position: fixed !important;
        top: calc(env(safe-area-inset-top, 0px) / 2 - 20px);
        width: 40px !important;
        height: 40px !important;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 !important;
        margin: 0 !important;
        color: var(--accent-read, #4caf50);
        background: rgba(13, 13, 13, 0.94);
        border: 1px solid var(--accent-read, #4caf50);
        border-radius: 999px;
        z-index: 99999 !important;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: auto !important;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        transition: opacity .18s ease;
      }
      #pagedPlayheadBtn:active { opacity: .55; }
      #pagedPlayheadBtn svg { width: 20px; height: 20px; display: block; pointer-events: none; }
      body.chrome-hidden #pagedPlayheadBtn,
      body:not(.mode-read) #pagedPlayheadBtn {
        opacity: 0;
        pointer-events: none;
      }
      ::highlight(reader-dict-lookup) {
        background: color-mix(in srgb, var(--accent-read, #4caf50) 60%, transparent);
        text-decoration: underline wavy var(--accent-read, #4caf50) 3px;
        text-underline-offset: 5px;
        text-decoration-skip-ink: none;
      }
    `;
    document.head.appendChild(s);
  }

  // The reader view stays display:flex once created; show/hide toggles VISIBILITY
  // + pointerEvents, NOT display — so the heavy vertical-rl layout (thousands of
  // chunks over a huge canvas) is computed ONCE and never re-run on a mode switch.
  // display:none was discarding the layout and re-running it on every read-entry —
  // the Android "settling" lag (iOS renders horizontal, so it was cheap there).
  // "Hidden" = no view yet, or visibility:hidden (display:none kept for back-compat).
  function _readerHidden() {
    return !viewEl || viewEl.style.visibility === 'hidden' || viewEl.style.display === 'none';
  }

  function ensureView() {
    if (viewEl) return viewEl;
    ensureStylesheet();
    viewEl = document.createElement('div');
    viewEl.id = 'readingPagedView';
    Object.assign(viewEl.style, {
      // Created hidden + non-interactive, but display:flex so layout computes once.
      display: 'flex',
      visibility: 'hidden',
      pointerEvents: 'none',
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
    // ensurePlayheadBtn() removed 2026-05-29 — replaced by the dict
    // popup's "Set playhead" section.

    setupTouch();
    setupScrollTracking();
    setupResize();
    // Floating playhead button removed 2026-05-29 — its functionality
    // now lives in the dict popup's "Set playhead" section in reader
    // mode (see setupPlayheadHandler in enhanced-dictionary.js).
    // Tearing down any prior instance in case a hot-reload leaves one
    // behind in the DOM.
    document.getElementById('pagedPlayheadBtn')?.remove();
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
    let sx = 0, sy = 0, tStart = 0;
    let dismissedPopupOnStart = false;
    let dismissedSelectionOnStart = false;
    // iOS WKWebView with `-webkit-overflow-scrolling: touch` on a
    // horizontal-scroll container consumes vertical drag gestures —
    // the native scroll engine takes the touch and touchend never
    // fires for the gesture (only touchstart + bouncy touchmoves).
    // So we can't detect down-swipes in touchend; we have to spot
    // them mid-gesture in touchmove and act immediately. swipeFired
    // is a per-gesture latch so a single down-swipe doesn't fire
    // togglePlayPause N times across consecutive touchmove events.
    let swipeFired = false;
    scrollEl.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      tStart = Date.now();
      dismissedPopupOnStart = false;
      dismissedSelectionOnStart = false;
      swipeFired = false;
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        // Route through enhanced-dictionary's hidePopup so its
        // maybeResumeAfterLookup() hook fires — dismissing the popup
        // by setting display:none directly skipped the resume-audio
        // side-effect. Falls back to the inline nuke if the global
        // helper isn't present (shouldn't happen, but safe).
        try {
          if (typeof window.hideDictPopup === 'function') {
            window.hideDictPopup();
          } else {
            popup.style.display = 'none';
            popup.innerHTML = '';
            try { window._clearReaderDictHighlight?.(); } catch (er) {}
          }
        } catch (er) {
          popup.style.display = 'none';
          popup.innerHTML = '';
        }
        dismissedPopupOnStart = true;
      }
      // If a sentence is selected and this tap is OUTSIDE the menu, clear
      // the selection (and don't also fire a lookup).
      const menu = document.getElementById('pagedSelectionMenu');
      if (selectedCue && (!menu || !menu.contains(e.target))) {
        clearSelection();
        dismissedSelectionOnStart = true;
      }
      // Long-press / swipe-up gestures removed — they conflicted with
      // iOS system text selection (long-press is the OS handle for
      // copy/translate) and with card-mode's up-swipe-to-Anki. The
      // playhead-from-here button in the shell header is now the
      // dedicated way to set the play position from the reader view.
    }, { passive: true });
    // Mid-gesture down-swipe detection. On Android this fires
    // reliably; on iOS WKWebView the legacy scroll engine consumes
    // touchmove on horizontally-scrollable containers before JS
    // sees it (confirmed 2026-05-29 — touch-action: pan-x,
    // removing -webkit-overflow-scrolling: touch, and a document
    // capture-phase fallback all failed to engage). Leaving the
    // detection in place for Android + future iOS WebKit
    // improvements; iOS users use the header PLAY button.
    scrollEl.addEventListener('touchmove', (e) => {
      if (swipeFired || physDragging) return;
      const t = e.touches?.[0];
      if (!t) return;
      const dxRaw = t.clientX - sx, dyRaw = t.clientY - sy;
      const adx = Math.abs(dxRaw), ady = Math.abs(dyRaw);
      // Ignore down-swipes that BEGAN in the OS notification-shade zone (top
      // edge) so pulling down the shade doesn't also toggle playback.
      if (dyRaw > 30 && ady > adx * 1.5 && adx < 50 && !window._inSystemGestureZone?.(sy)) {
        swipeFired = true;
        log('[swipe] down dy=' + Math.round(dyRaw) + ' dx=' + Math.round(dxRaw));
        try { handleSwipeDown(); } catch (err) { log('[swipe] handler error:', err?.message); }
      }
    }, { passive: true });

    scrollEl.addEventListener('touchend', (e) => {
      if (swipeFired || physDragging) return; // swipe / physics drag owns the gesture
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dxRaw = t.clientX - sx, dyRaw = t.clientY - sy;
      const adx = Math.abs(dxRaw), ady = Math.abs(dyRaw);
      const elapsed = Date.now() - tStart;
      // Treat any motion as scroll/abort the tap path below.
      if (ady > 14 || adx > 14) return;
      if (elapsed > 400) return;
      // Tap path. Check the caret at the tap point to know if we hit
      // actual text. elementFromPoint returns the chunk container even
      // for whitespace between glyphs, which produced the "dictionary
      // looks up a blank result" bug. Use caretRangeFromPoint and
      // inspect the character actually under the finger.
      if (dismissedPopupOnStart || dismissedSelectionOnStart) {
        if (dismissedPopupOnStart) window._dictPopupDismissedTs = Date.now();
        return; // dismiss-only tap; no chrome toggle, no lookup
      }
      if (hitTextChar(t.clientX, t.clientY)) {
        lookupAt(t.clientX, t.clientY);
      } else {
        toggleChrome();
      }
    }, { passive: true });
  }

  // True when the caret at (x,y) lands on a non-whitespace/non-punctuation
  // character inside a reading chunk. Used to reject empty-space taps
  // before they trigger a dict lookup of "" or " " or "「".
  function hitTextChar(x, y) {
    let caret = document.caretRangeFromPoint?.(x, y) ||
                document.caretPositionFromPoint?.(x, y);
    if (!caret) return false;
    const node = caret.startContainer || caret.offsetNode;
    const off  = (caret.startContainer ? caret.startOffset : caret.offset) | 0;
    if (!node || node.nodeType !== 3) return false;
    if (!innerEl.contains(node)) return false;
    // Confirm we're inside a chunk (rejects taps that fall on the
    // padding region between chunks).
    let cur = node.parentNode, inChunk = false;
    while (cur && cur !== innerEl) {
      if (cur.classList?.contains('reading-chunk')) { inChunk = true; break; }
      cur = cur.parentNode;
    }
    if (!inChunk) return false;
    // Check the character AT the caret position (or just before, for
    // end-of-text-node caret positions).
    const txt = node.nodeValue || '';
    let ch = txt[off] || txt[off - 1] || '';
    // Whitespace, full-width space, punctuation, brackets → not text.
    return ch && !/[\s　「」『』、。・…！？!?,.;:""'']/u.test(ch);
  }

  // ---------- Swipe gestures ----------

  function handleSwipeUp(x, y) {
    log(`handleSwipeUp: cues=${pagedCues?.length || 0} mapsReady=${!!pagedCueToChunk}`);
    // Select the cue under the swipe origin.
    const caret = document.caretRangeFromPoint?.(x, y) ||
                  document.caretPositionFromPoint?.(x, y);
    if (!caret) { log('handleSwipeUp: no caret'); return; }
    const node = caret.startContainer || caret.offsetNode;
    if (!node || !innerEl.contains(node)) { log('handleSwipeUp: node not in innerEl'); return; }
    let cur = node.parentNode, chunk = null;
    while (cur && cur !== innerEl) {
      if (cur.classList?.contains('reading-chunk')) { chunk = cur; break; }
      cur = cur.parentNode;
    }
    if (!chunk) return;
    const offset = (caret.startContainer ? caret.startOffset : caret.offset) | 0;
    // Build flatText + charIndex for findCueForTap.
    const tns = [];
    let flat = '';
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) { tns.push(n); flat += n.nodeValue; }
    let acc = 0, charIndex = -1;
    for (const tn of tns) {
      if (tn === node) { charIndex = acc + offset; break; }
      acc += tn.nodeValue.length;
    }
    if (charIndex < 0) charIndex = 0;
    const found = findCueForTap(chunk, flat, charIndex);
    if (!found?.cue) {
      log('handleSwipeUp: no cue at swipe point');
      return;
    }
    selectCue(found.cue, found.idx, chunk);
  }

  function handleSwipeDown() {
    if (selectedCue) {
      playFromSelection();
      return;
    }
    // Match the shell PLAY button exactly. shellTogglePlay → in read
    // mode → toggleReadingPlayback, which has the full fallback chain
    // for audiobook source + startMs + state-based pause/resume/play.
    // Don't duplicate that logic here — any drift between the two
    // paths becomes "play button works but down-swipe doesn't".
    if (typeof window.shellTogglePlay === 'function') {
      try { window.shellTogglePlay(); return; } catch (_) {}
    }
    if (typeof window.toggleReadingPlayback === 'function') {
      try { window.toggleReadingPlayback(); return; } catch (_) {}
    }
    // Last-resort local fallback in case the shell helpers aren't
    // loaded for some reason.
    togglePlayPause();
  }

  // ---------- Selection state + visual ----------

  function selectCue(cue, idx, chunk) {
    selectedCue = { cue, idx, chunk };
    // Paint the cue's text in mode-color (no bg) via a separate highlight
    // key from cue-active.
    paintSelectionHighlight(chunk, cue.text);
    showSelectionMenu();
    // Stash the lookupContext so the global "+ Anki" path picks up the
    // cue when the user taps the menu's Anki button (and so the down-
    // swipe play-from-selection knows the cue).
    try {
      window.lookupContext = {
        source: 'paged-reader',
        sentence: String(cue.text || '').trim(),
        card: null,
        cueAudioPath: pagedAudioPath || null,
        cueStartMs:   Number.isFinite(cue.startMs) ? cue.startMs : null,
        cueEndMs:     Number.isFinite(cue.endMs)   ? cue.endMs   : null,
        cueIndex:     idx
      };
    } catch (e) {}
  }

  function paintSelectionHighlight(chunk, text) {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    // Reuse setCueRangeHighlight's text-walk by inlining a similar mapping.
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
    const normCue = normalizeJP(text);
    if (!normCue) return;
    const normFlat = normalizeJP(flat);
    const normStart = normFlat.indexOf(normCue);
    if (normStart < 0) return;
    const normEnd = normStart + normCue.length;
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let rawStart = -1, rawEnd = flat.length, np = 0;
    for (let i = 0; i < flat.length; i++) {
      if (rawStart < 0 && np >= normStart && !STRIP.test(flat[i])) rawStart = i;
      if (np >= normEnd) { rawEnd = i; break; }
      if (!STRIP.test(flat[i])) np++;
    }
    if (rawStart < 0) return;
    while (rawEnd < flat.length && STRIP.test(flat[rawEnd])) rawEnd++;
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
      if (!selectionHighlight) selectionHighlight = new Highlight();
      selectionHighlight.clear();
      selectionHighlight.add(r);
      CSS.highlights.set('reader-selection', selectionHighlight);
      if (scrollEl) void scrollEl.offsetWidth;
    } catch (e) {}
  }

  function clearSelection() {
    selectedCue = null;
    try { selectionHighlight?.clear?.(); } catch (_) {}
    try { CSS.highlights?.delete?.('reader-selection'); } catch (_) {}
    hideSelectionMenu();
  }

  // ---------- Selection menu (COPY / Anki / Play) ----------

  function showSelectionMenu() {
    if (!selectedCue) return;
    let menu = document.getElementById('pagedSelectionMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'pagedSelectionMenu';
      // ANKI button intentionally removed — the dict popup's "+ Anki"
      // is the only correct path because that's where the waveform-
      // editor → slice → send pipeline lives. Tap a word in the
      // selected cue → dict popup → + Anki, and you get the same
      // sentence + audio range as a Card-mode send.
      menu.innerHTML = `
        <button data-action="copy">COPY</button>
        <button data-action="play">▶ PLAY</button>
      `;
      document.body.appendChild(menu);
      menu.addEventListener('click', onSelectionMenuClick);
      menu.addEventListener('touchend', onSelectionMenuClick, { passive: false });
    }
    // Position near the selected text — use the highlight's bbox.
    const hl = window.CSS?.highlights?.get?.('reader-selection');
    let rect = null;
    if (hl) for (const r of hl) { rect = r.getBoundingClientRect(); break; }
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.display = 'flex';
    const mw = menu.offsetWidth || 220, mh = menu.offsetHeight || 36;
    let left, top;
    if (rect && rect.width) {
      // Center horizontally on the rect; place above unless no room.
      left = Math.max(8, Math.min(vw - mw - 8, rect.left + rect.width / 2 - mw / 2));
      top = (rect.top - mh - 8 >= 8) ? rect.top - mh - 8 : Math.min(vh - mh - 8, rect.bottom + 8);
    } else {
      left = (vw - mw) / 2;
      top = vh - mh - 32;
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function hideSelectionMenu() {
    const menu = document.getElementById('pagedSelectionMenu');
    if (menu) menu.style.display = 'none';
  }

  let _menuFiring = false;
  function onSelectionMenuClick(e) {
    if (_menuFiring) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    _menuFiring = true;
    try { if (e.cancelable) e.preventDefault(); } catch (_) {}
    e.stopPropagation();
    const action = btn.dataset.action;
    const cue = selectedCue?.cue;
    setTimeout(() => { _menuFiring = false; }, 400);
    if (!cue) return;
    if (action === 'copy') {
      try { navigator.clipboard?.writeText?.(cue.text || ''); } catch (_) {}
    } else if (action === 'anki') {
      sendSelectionToAnki();
    } else if (action === 'play') {
      playFromSelection();
    }
  }

  async function sendSelectionToAnki() {
    if (!selectedCue || typeof window.sendToAnki !== 'function') return;
    const cue = selectedCue.cue;
    let imageData = '';
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === window._activeTitleId);
        if (t?.attachments?.cover?.dataUri) imageData = t.attachments.cover.dataUri;
      }
    } catch (_) {}
    await window.sendToAnki({ expression: cue.text || '', imageData });
  }

  // ---------- Play from selection ----------

  async function getCurrentPlayMs() {
    try {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      const s = await bg?.getState?.();
      return Number.isFinite(s?.positionMs) ? s.positionMs : null;
    } catch (_) { return null; }
  }

  async function playFromSelection() {
    if (!selectedCue) return;
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    const cue = selectedCue.cue;
    if (!Number.isFinite(cue?.startMs)) return;
    try { await bg.seek({ ms: Math.round(cue.startMs) }); } catch (_) {}
    try { await bg.play?.(); } catch (_) {}
    // Selection is consumed.
    clearSelection();
  }

  // Last-resort local fallback used by handleSwipeDown if the shell
  // helpers (window.shellTogglePlay / window.toggleReadingPlayback)
  // somehow aren't loaded. The shell path is the canonical one — it
  // knows about audiobook source resolution, cue startMs, and the
  // pause/resume/fresh-play branching that the PLAY button uses.
  async function togglePlayPause() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    try {
      const s = await bg.getState?.();
      if (s?.playing) await bg.pause?.();
      else await bg.play?.();
    } catch (_) {}
  }

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
    // Strict containment first.
    let best = null, bestDist = Infinity;
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
      // Track nearest by distance for tight-window fallback.
      const dist = Math.min(Math.abs(normIdx - start), Math.abs(normIdx - end - 1));
      if (dist < bestDist) {
        best = { cue, idx: ci, normStart: start, normEnd: end };
        bestDist = dist;
      }
    }
    // Tight fallback: tap landed on punctuation/whitespace between cues.
    // Within 6 normalized chars of a cue boundary → use it. Beyond that,
    // give up — but caller will still get a one-sentence fallback (not
    // the whole chunk) via bindCueLookupContext.
    if (best && bestDist <= 6) return best;
    return null;
  }

  // Extract just the sentence around `charIndex` from `flatText`. Used as
  // a last-ditch fallback when no cue can be matched: we'd rather send
  // Anki one sentence than the whole multi-paragraph chunk.
  function extractSentenceAround(text, idx) {
    if (!text) return '';
    const punct = /[。！？!?\n]/;
    let start = 0, end = text.length;
    for (let i = Math.min(idx, text.length) - 1; i >= 0; i--) {
      if (punct.test(text[i])) { start = i + 1; break; }
    }
    for (let i = Math.max(idx, 0); i < text.length; i++) {
      if (punct.test(text[i])) { end = i + 1; break; }
    }
    return text.slice(start, end).trim();
  }

  function bindCueLookupContext(chunk, flatText, charIndex) {
    try {
      const found = findCueForTap(chunk, flatText, charIndex);
      if (found?.cue) {
        const cueText = String(found.cue.text || '').trim();
        window.lookupContext = {
          source: 'paged-reader',
          sentence: cueText,
          card: null,
          cueAudioPath: pagedAudioPath || window.__abAudioPath || null,
          cueStartMs:   Number.isFinite(found.cue.startMs) ? found.cue.startMs : null,
          cueEndMs:     Number.isFinite(found.cue.endMs)   ? found.cue.endMs   : null,
          cueIndex:     found.idx,
          cues:         null
        };
        log(`bindCueLookupContext: cue#${found.idx} "${cueText.slice(0,30)}…"`);
      } else {
        // No cue match by text containment. TEXT comes from sentence-
        // around-tap so we don't glob a chunk. AUDIO comes from the
        // nearest chunk-mapped cue so Anki still gets audio that lines
        // up with what's visible. Without this, the global fallback
        // (_currentReadingCueStartMs from the PLAYING cue) wins, giving
        // the "Anki audio is from where the audiobook was last playing,
        // not the tapped sentence" bug.
        const sentence = extractSentenceAround(flatText, charIndex) ||
                         (chunk?.textContent || '').slice(0, 200).trim();
        const nearest = findNearestChunkCue(chunk, flatText, charIndex);
        window.lookupContext = {
          source: 'paged-reader',
          sentence,
          card: null,
          cueAudioPath: nearest ? (pagedAudioPath || window.__abAudioPath || null) : null,
          cueStartMs:   nearest?.startMs ?? null,
          cueEndMs:     nearest?.endMs   ?? null
        };
        log(`bindCueLookupContext: no cue — sentence-fallback "${sentence.slice(0,30)}…"` +
            (nearest ? ` audio=cue${nearest.idx}` : ' audio=NONE'));
      }
    } catch (e) { log('bindCueLookupContext error:', e.message); }
  }

  // Best-effort cue for a chunk. NEVER returns null when we can reach
  // ANY cue source — the waveform editor must open so the user can
  // fine-tune. Strategy chain (BUILD MARKER: v4):
  //   1. text search: any cue whose normalized text appears in chunk
  //   2. pagedCueToChunk distance (when chunk is in chunks array)
  //   3. proportional by chunk index in chunks
  //   4. currently-playing cue (when audio is following)
  //   5. first cue with finite times (last resort)
  function findNearestChunkCue(chunk, flatText, charIndex) {
    // Source of truth for cues: our own pagedCues, OR — when our load
    // failed silently — the legacy reader's abCues exposed via window.
    const cues = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    const cuesSource = (pagedCues?.length ? 'paged' : (cues.length ? 'legacy' : 'none'));
    const hasTap = Number.isFinite(charIndex) && typeof flatText === 'string';
    log('findNearestChunkCue v6 entered: pagedCues=' + (pagedCues?.length||0) +
        ' abCues=' + (window.__abCues?.length||0) +
        ' chunks=' + (chunks?.length||0) +
        ' source=' + cuesSource +
        ' charIndex=' + (hasTap ? charIndex : 'n/a'));
    if (!cues.length) { log('findNearestChunkCue: NO cues from any source'); return null; }

    // --- Strategy 1: best cue whose text appears in this chunk ---
    // Algorithm (v6):
    //   For each cue, find ALL its occurrences in the normalized chunk
    //   text (a cue text like "そして" can appear many times). For each
    //   (cue, occurrence) pair, compute distance to the tap. Then:
    //     A. Among pairs that CONTAIN the tap (dist=0), prefer the one
    //        whose cue text is LONGEST — that's the most-specific match.
    //        A short common cue like "そう" trivially contains many
    //        taps; a full-sentence cue containing the same tap is the
    //        right answer.
    //     B. If no pair contains the tap, pick the smallest distance.
    const normChunk = chunk ? normalizeJP(chunk.textContent || '') : '';
    if (normChunk) {
      let tapNormIdx = -1;
      if (hasTap) {
        const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
        tapNormIdx = 0;
        for (let i = 0; i < charIndex && i < flatText.length; i++) {
          if (!STRIP.test(flatText[i])) tapNormIdx++;
        }
      }
      let bestContain = null, bestContainLen = -1;
      let bestNearby  = null, bestNearbyDist = Infinity;
      let matchCount = 0;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (!Number.isFinite(c?.startMs) || !Number.isFinite(c?.endMs)) continue;
        const norm = normalizeJP(c?.text || '');
        if (!norm || norm.length < 3) continue;
        // Walk all occurrences of this cue's text in the chunk.
        let from = 0;
        while (from <= normChunk.length) {
          const pos = normChunk.indexOf(norm, from);
          if (pos < 0) break;
          matchCount++;
          if (!hasTap) {
            log('findNearestChunkCue: text-match cue#' + i + ' (no tap, first match)');
            return { idx: i, startMs: c.startMs, endMs: c.endMs };
          }
          const end = pos + norm.length;
          if (tapNormIdx >= pos && tapNormIdx < end) {
            // Contains tap — keep the longest cue text among contains.
            if (norm.length > bestContainLen) {
              bestContain = { idx: i, startMs: c.startMs, endMs: c.endMs, normLen: norm.length };
              bestContainLen = norm.length;
            }
          } else {
            const dist = Math.min(Math.abs(tapNormIdx - pos), Math.abs(tapNormIdx - end));
            if (dist < bestNearbyDist) {
              bestNearby = { idx: i, startMs: c.startMs, endMs: c.endMs };
              bestNearbyDist = dist;
            }
          }
          from = pos + 1; // next occurrence
        }
      }
      const winner = bestContain || bestNearby;
      if (winner) {
        const kind = bestContain ? ('contains, len=' + bestContainLen) : ('nearby, dist=' + bestNearbyDist);
        log('findNearestChunkCue: text-match cue#' + winner.idx +
            ' (best of ' + matchCount + ' candidates, ' + kind + ')');
        return winner;
      }
    }

    // --- Strategy 2: pagedCueToChunk distance (only valid when paged source) ---
    const targetIdx = (chunk && chunks) ? chunks.indexOf(chunk) : -1;
    if (cuesSource === 'paged' && targetIdx >= 0 && pagedCueToChunk) {
      let best = null, bestDist = Infinity;
      for (let i = 0; i < pagedCueToChunk.length; i++) {
        const ci = pagedCueToChunk[i];
        if (ci == null || ci < 0) continue;
        const c = cues[i];
        if (!Number.isFinite(c?.startMs) || !Number.isFinite(c?.endMs)) continue;
        const dist = Math.abs(ci - targetIdx);
        if (dist < bestDist) {
          best = { idx: i, startMs: c.startMs, endMs: c.endMs };
          bestDist = dist;
          if (dist === 0) break;
        }
      }
      if (best) { log('findNearestChunkCue: cueToChunk cue#' + best.idx + ' dist=' + bestDist); return best; }
    }

    // --- Strategy 3: proportional ---
    if (targetIdx >= 0 && chunks?.length) {
      const ratio = targetIdx / Math.max(1, chunks.length);
      const guessIdx = Math.min(cues.length - 1, Math.max(0, Math.round(ratio * cues.length)));
      for (let off = 0; off < cues.length; off++) {
        for (const sign of [1, -1]) {
          const idx = guessIdx + sign * off;
          if (idx < 0 || idx >= cues.length) continue;
          const c = cues[idx];
          if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs)) {
            log('findNearestChunkCue: proportional cue#' + idx);
            return { idx, startMs: c.startMs, endMs: c.endMs };
          }
        }
      }
    }

    // --- Strategy 4: currently-playing cue ---
    const playStart = window._currentReadingCueStartMs;
    if (Number.isFinite(playStart)) {
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs) &&
            playStart >= c.startMs && playStart < c.endMs) {
          log('findNearestChunkCue: playing cue#' + i);
          return { idx: i, startMs: c.startMs, endMs: c.endMs };
        }
      }
    }

    // --- Strategy 5: first cue with finite times ---
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs)) {
        log('findNearestChunkCue: first-cue fallback cue#' + i);
        return { idx: i, startMs: c.startMs, endMs: c.endMs };
      }
    }
    log('findNearestChunkCue: ALL strategies failed (no finite cues at all)');
    return null;
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

  // Bounded local search: find the cue text within ±radius chunks of an
  // anchor, preferring the chunk closest to the anchor (forward ties win,
  // since cues advance forward). This avoids findChunkForText's book-wide
  // first-match far-jumps while still tracking the line locally — the fix
  // for the "highlight skips a line or two" symptom on unmatched cues.
  function findChunkForTextNear(target, anchorIdx, radius) {
    const t = normalizeJP(target);
    if (!t || !chunks.length) return null;
    if (!Number.isFinite(anchorIdx) || anchorIdx < 0) anchorIdx = 0;
    const lo = Math.max(0, anchorIdx - radius);
    const hi = Math.min(chunks.length - 1, anchorIdx + radius);
    let best = null, bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      if (normalizeJP(chunks[i].textContent).includes(t)) {
        const d = (i >= anchorIdx) ? (i - anchorIdx) : (anchorIdx - i) + 0.5;
        if (d < bestDist) { bestDist = d; best = chunks[i]; }
      }
    }
    return best;
  }

  // Resolve the chunk for a cue: alignment map → bounded local search around
  // the current green chunk → (only if allowGlobal) a book-wide search.
  // allowGlobal is FALSE for passive audio-follow (a book-wide first-match
  // could fling the view a chapter away) and TRUE for deliberate navigation
  // (reader enter, explicit jumps) where showing SOMETHING beats showing
  // nothing.
  function resolveCueChunk(cueIdx, cueText, allowGlobal) {
    if (pagedCueToChunk && cueIdx >= 0 && cueIdx < pagedCueToChunk.length &&
        pagedCueToChunk[cueIdx] >= 0) {
      const c = chunks[pagedCueToChunk[cueIdx]];
      if (c) return c;
    }
    const near = findChunkForTextNear(cueText, lastHighlightedChunkIdx, 8);
    if (near) return near;
    return allowGlobal ? findChunkForText(cueText) : null;
  }

  // Nearest cue index to `target` whose alignment entry is MATCHED (has a
  // real chunk), so setCueRangeHighlight can paint its exact text green.
  // Searches outward by index, biased BACKWARD first — in vertical-rl older
  // text sits to the right, so landing on a matched line at-or-before the
  // intended cue keeps unread content to the left and never reveals
  // upcoming text as "already here". Returns -1 if no cue is matched at all.
  function nearestMatchedCue(target) {
    if (!pagedCueToChunk || !pagedCueToChunk.length) return -1;
    const n = pagedCueToChunk.length;
    if (!Number.isFinite(target)) target = 0;
    target = Math.max(0, Math.min(n - 1, target));
    if (pagedCueToChunk[target] >= 0) return target;
    for (let d = 1; d < n; d++) {
      const lo = target - d, hi = target + d;
      if (lo >= 0 && pagedCueToChunk[lo] >= 0) return lo;
      if (hi < n && pagedCueToChunk[hi] >= 0) return hi;
    }
    return -1;
  }

  // GUARANTEE a green, right-justified highlight whenever the user enters /
  // switches into the reader. The user's hard requirement: NEVER a blank
  // viewport and NEVER white text with nothing colored — there must always
  // be a green line near the right edge with 2-3 lines of prior context.
  //
  // Intended "current" cue priority: explicit reentry jump → synced
  // _lastAudioCueIdx (audio playhead) → last-read cue → active card's cue →
  // first cue. We then snap to the nearest MATCHED cue (so the exact text
  // paints green even if the intended cue happens to be alignment-unmatched)
  // and scroll it near-right-with-context. Falls back to a book-wide text
  // resolve if the alignment map is empty (legacy matcher), so SOMETHING
  // always shows. Returns true if a highlight was painted.
  function ensureGreenOnEnter(preferredCueIdx) {
    try {
      // Only act while the paged reader is actually the visible view. openView
      // schedules this on untracked 60ms/260ms timeouts; a fast READ→AUDIO
      // switch could otherwise let a leftover pass run against the hidden view
      // and clobber the shared _lastAudioCueIdx (corrupting lock-screen
      // cue-jump's relative base). Mirrors pagedCenterOnCue's guard.
      if (_readerHidden()) return false;
      const cues = (pagedCues?.length ? pagedCues : (window.__abCues || []));
      if (!cues.length || !chunks.length) return false;
      // 1. choose the intended current cue
      let want = (Number.isFinite(preferredCueIdx) && preferredCueIdx >= 0) ? preferredCueIdx : -1;
      if (want < 0 && Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0) {
        want = window._lastAudioCueIdx;
      }
      if (want < 0 && Number.isFinite(lastReadCueIdx) && lastReadCueIdx >= 0) {
        want = lastReadCueIdx;
      }
      if (want < 0) {
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci) && ci >= 0 && cues[ci]?.text &&
            window.allNotes?.[ci]?.expression === cues[ci].text) want = ci;
      }
      // NEVER fall back to cue 0 here. That was the worst place-loss bug:
      // on a cold/post-wipe enter with no resolvable cursor it painted cue 0,
      // scrolled to the book START, and clobbered the shared playhead to 0 —
      // discarding the scroll position loadEpub/centerOnActiveCard restored.
      // Instead, paint nothing and leave the user exactly where they are. (The
      // retry loop in runReaderEnterSetup just no-ops; the next user scroll
      // sets lastReadCueIdx via _creditReadCharsFromVisible, so a later enter
      // paints correctly.)
      if (want < 0) return false;
      // 2. Snap to the nearest MATCHED cue so exact green text paints even when
      //    the intended cue is alignment-unmatched. Bias STRICTLY BACKWARD: on
      //    reopen we must never paint the line AHEAD of where the user stopped
      //    (skipping a subtitle is a small place-loss; re-reading one is safe).
      //    Prefer the matched cue at-or-before `want`; only if NONE exists
      //    behind do we fall back to the symmetric search, purely so the
      //    viewport is never left blank. (want is >=0 here — guarded above.)
      let matchCue = -1;
      if (pagedCueToChunk && pagedCueToChunk.length) {
        for (let i = Math.min(want, pagedCueToChunk.length - 1); i >= 0; i--) {
          if (pagedCueToChunk[i] >= 0) { matchCue = i; break; }
        }
      }
      if (matchCue < 0) matchCue = nearestMatchedCue(want);
      let chunk = (matchCue >= 0) ? chunks[pagedCueToChunk[matchCue]] : null;
      let paintText = (matchCue >= 0) ? cues[matchCue].text : (cues[want]?.text || '');
      // 3. absolute fallback — no matched cue (alignment empty / legacy map):
      //    resolve via book-wide text search so the viewport is never blank.
      if (!chunk) {
        chunk = resolveCueChunk(want, cues[want]?.text || '', true);
        paintText = cues[want]?.text || '';
      }
      if (!chunk) { log('ensureGreenOnEnter: no chunk for want=' + want); return false; }
      // Paint. setCueRangeHighlight now spans paragraph boundaries, so a
      // matched cue should always paint; but if it still comes back falsy
      // (e.g. the nearest matched cue's text genuinely isn't locatable),
      // try a book-wide resolve of the INTENDED cue before giving up, so we
      // never leave the viewport uncolored.
      let r = setCueRangeHighlight(chunk, paintText);
      if (!r) {
        const alt = resolveCueChunk(want, cues[want]?.text || '', true);
        if (alt && alt !== chunk) {
          const r2 = setCueRangeHighlight(alt, cues[want]?.text || '');
          if (r2) { chunk = alt; r = r2; }
        }
      }
      if (!r) { log('ensureGreenOnEnter: paint failed want=' + want); return false; }
      lastHighlightedCue = -1;             // let the next live audio-follow paint fire
      window._lastAudioCueIdx = want;      // keep the shared cursor at the intended cue
      lastProgrammaticScrollTime = Date.now();
      try { scrollChunkNearRightWithContext(chunk, 3, { allowFarJump: true }); } catch (_) {}
      log('[scroll-trace] ensureGreenOnEnter want=' + want + ' matchCue=' + matchCue + ' painted=' + !!r);
      return !!r;
    } catch (e) { log('ensureGreenOnEnter err: ' + e.message); return false; }
  }
  window.pagedEnsureGreenOnEnter = ensureGreenOnEnter;
  // Expose the paged reader's live read cursor so the reentry dialog can
  // capture a "stay at read position" anchor BEFORE loadAudiobookCues wipes it.
  window._pagedReadCueIdx = function () { return lastReadCueIdx; };
  // Resolve the read cursor's audio START TIME (ms) from the PAGED cue array, so
  // audio-mode entry and read-mode PLAY seek to the line the user actually read
  // — WITHOUT indexing the paged cursor into the legacy abCues array (which can
  // be a different indexing). Returns null when there is no valid read cue, so
  // callers fall back to the saved position and NEVER coerce to book start.
  window._pagedReadCueStartMs = function () {
    try {
      // lastReadCueIdx is ALWAYS a pagedCues index — never index it into a
      // different array. When pagedCues is transiently empty (mid-reload), return
      // null so callers fall back to the saved audio position (invariant-safe).
      const rc = lastReadCueIdx;
      if (pagedCues?.length && rc >= 0 && rc < pagedCues.length && Number.isFinite(pagedCues[rc]?.startMs)) {
        return pagedCues[rc].startMs;
      }
    } catch (_) {}
    return null;
  };

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
  // Re-apply the saved per-book scroll position for EPUB-only titles (no card
  // to anchor to). Fire-and-forget; skips while the user is actively scrolling
  // so it never yanks them mid-read.
  // SYNCHRONOUS (uses the value cached by loadEpub, not an async getPref) so it
  // can't lose a race with the prewarm's own scroll save.
  function restoreReadScrollIfNoCard() {
    if (!scrollEl) return;
    if (Array.isArray(window.allNotes) && window.allNotes.length > 0) return; // has cards → centerOnActiveCard handles it
    if (Date.now() - lastUserScrollTime < 5000) return; // actively reading — don't yank
    // EPUB-only reopen: prefer the bookmark LINE (engine-agnostic, line-exact);
    // fall back to the saved raw scrollLeft only when there's no bookmark.
    if (_bookmarkChunkIdx >= 0 && _bookmarkChunkIdx < chunks.length &&
        (chunks[_bookmarkChunkIdx].getBoundingClientRect().width || 0) > 0) {
      // Only take the line-exact path when the chunk is actually laid out;
      // otherwise the relative scroll silently no-ops — fall THROUGH to the raw
      // savedReadScrollLeft fallback below instead of returning to a dead no-op.
      suppressScrollSave = true;
      lastProgrammaticScrollTime = Date.now();
      try { scrollChunkNearRightWithContext(chunks[_bookmarkChunkIdx], 3, { allowFarJump: true }); } catch (_) {}
      setTimeout(() => { suppressScrollSave = false; }, 200);
      log('restoreReadScrollIfNoCard → bookmark chunk ' + _bookmarkChunkIdx);
      return;
    }
    const sl = savedReadScrollLeft;
    if (Number.isFinite(sl) && Math.abs(sl) > 1 && Math.abs(scrollEl.scrollLeft - sl) > 2) {
      suppressScrollSave = true;
      lastProgrammaticScrollTime = Date.now(); // don't let this restore count as reading
      scrollEl.scrollTo({ left: sl, behavior: 'instant' });
      setTimeout(() => { suppressScrollSave = false; }, 200);
      log('restoreReadScrollIfNoCard → ' + sl);
    }
  }

  function centerOnActiveCard() {
    try {
      const idx = window.currentCardIndex;
      const card = (Number.isFinite(idx) && Array.isArray(window.allNotes)) ? window.allNotes[idx] : null;
      if (!card?.expression) {
        // EPUB-only (or no active card): there's no card to anchor to, so
        // instead of leaving the reader at the start, re-apply the user's
        // saved scroll position. loadEpub's initial scrollTo runs before
        // vertical-rl layout settles and snaps back to 0; this restores it.
        clearCueHighlight();
        restoreReadScrollIfNoCard();
        return;
      }
      // Resolve the (chunk, cueText) for the active card. The alignment
      // map (cue→chunk) is the reliable path when available — short
      // common card text like "うん" would false-match the wrong chunk
      // via findChunkForText (which returns the FIRST chunk whose
      // normalized text contains the target). When the active card IS
      // a cue (SRT-only titles, currentCardIndex IS the cue index),
      // the map lands exactly. For deck-derived cards whose expression
      // isn't a cue, fall back to text search.
      let chunk = null;
      let highlightText = card.expression;
      // SRT-cards titles: the active card IS a cue (card index === cue index).
      // Use the robust resolver (map → bounded local → book-wide) so short
      // common text doesn't false-match a far chunk and the highlight is
      // always placed.
      // Combined/grouper cards carry cueIndices; resolve via the card's FIRST
      // (anchor) cue rather than indexing pagedCues by the card index (which is
      // wrong once a card holds many cues, and card.expression is joined text).
      const _hasCueArr = Array.isArray(card.cueIndices) && card.cueIndices.length;
      const _aCueIdx = _hasCueArr ? card.cueIndices[0] : idx;
      if (pagedCues[_aCueIdx]?.text && (_hasCueArr || pagedCues[_aCueIdx].text === card.expression)) {
        chunk = resolveCueChunk(_aCueIdx, pagedCues[_aCueIdx].text, true);
        if (chunk) highlightText = pagedCues[_aCueIdx].text;
      }
      // Deck-derived card whose expression isn't a cue → search near the
      // current position first, then book-wide.
      if (!chunk) {
        chunk = findChunkForTextNear(card.expression, lastHighlightedChunkIdx, 12) ||
                findChunkForText(card.expression);
      }
      if (!chunk) {
        log(`centerOnActiveCard: no chunk match for "${card.expression.slice(0, 20)}..."`);
        clearCueHighlight();
        return;
      }
      log(`centerOnActiveCard: card ${idx}, chunk found, highlighting`);
      // Paint the highlight FIRST so the user sees the new active sentence
      // immediately, even before any scroll animation completes.
      const range = setCueRangeHighlight(chunk, highlightText);
      // Then scroll if any part of the highlight overflows the viewport,
      // respecting the user-scroll grace period (5 s = "they're reading
      // independently, don't yank back"). openView resets
      // lastUserScrollTime so the initial enter always centers correctly.
      if (Date.now() - lastUserScrollTime < 5000) return;
      // Use the near-right-with-context positioning so the user
      // always opens the reader oriented: active chunk near the
      // right edge, ~3 lines of previously-read text visible.
      // Replaces the old "autoScrollForRange or scrollChunkIntoView
      // fallback" pair — those produced the "highlight slightly
      // off-screen" cases the user reported.
      log('[scroll-trace] centerOnActiveCard → scrollChunkNearRightWithContext');
      scrollChunkNearRightWithContext(chunk, 3, { allowFarJump: true });
    } catch (e) { log('centerOnActiveCard error:', e.message); }
  }

  // ===================== PAGED SCROLL PHYSICS (experimental) =====================
  // Gives the free-scroll reader a "paged" feel. A slow horizontal drag rubber-
  // bands (resistance grows the further you pull) and SNAPS BACK to where you
  // started on release — so you can peek around the current spot/playhead
  // without losing it. If the same gesture goes sideways THEN UP, the rubber
  // band UNLOCKS and you can browse freely (no snap-back). A quick horizontal
  // swipe turns one page. We drive scrollLeft directly (touch-action:none takes
  // touch off the native scroller); programmatic scrolls (cue-follow, restore)
  // still work because scrollLeft is unchanged as the source of truth.
  // Kill switch: localStorage.PAGED_PHYSICS = '0'. All feel constants are here.
  const PHYS = {
    COMMIT_PX: 10,   // finger travel before a drag is "ours" (below = tap, handled elsewhere)
    RUBBER_C: 0.55,  // rubber-band stiffness (lower = stiffer / more pushback)
    PEEK_FRAC: 0.85, // max peek distance as a fraction of viewport width (asymptote)
    FLING_V: 0.45,   // px/ms swipe velocity that turns a page
    SNAP_MS: 340,    // snap-back animation duration
    TURN_MS: 300,    // page-turn animation duration
    DIR: 1,          // flip to -1 if drag/turn direction feels reversed on device
  };
  // Column width in vertical-rl = the line-height (horizontal extent of one
  // vertical text line). Used to advance pages by WHOLE columns so no line is
  // partially rendered at a page boundary. Falls back when line-height is
  // 'normal'. Measured off a real chunk (chunks may override innerEl's line-height).
  function _columnWidth() {
    try {
      const el = (chunks && chunks[0]) || innerEl;
      const cs = getComputedStyle(el);
      let lh = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 18) * 1.7;
      return Math.max(12, lh);
    } catch (_) { return 36; }
  }
  let physDragging = false; // true while OUR drag owns the gesture (existing tap/swipe handlers bail)
  let _physAnim = null;
  let _edgeMaskL = null, _edgeMaskR = null; // black strips hiding partial columns at the two edges
  let _maskLW = 0, _maskRW = 0;             // their current widths (px) — autoscroll excludes them from "visible"
  let _edgeMaskRafPending = false;
  function _physEnabled() {
    try { return localStorage.getItem('PAGED_PHYSICS') !== '0'; } catch (_) { return true; }
  }
  function _cancelPhysAnim() { if (_physAnim) { cancelAnimationFrame(_physAnim); _physAnim = null; } }
  // iOS-style rubber band: displacement asymptotes to PEEK_FRAC*dim as the raw
  // finger delta grows, so the further you pull the more it resists.
  function _rubber(d, dim) {
    const max = PHYS.PEEK_FRAC * dim;
    const s = d < 0 ? -1 : 1;
    const a = Math.abs(d);
    return s * (1 - 1 / (a * PHYS.RUBBER_C / max + 1)) * max;
  }
  function _physAnimateTo(target, ms, onDone) {
    _cancelPhysAnim();
    const from = scrollEl.scrollLeft;
    const delta = target - from;
    if (Math.abs(delta) < 0.5) { if (onDone) onDone(); return; }
    const t0 = performance.now();
    const ease = (p) => 1 - Math.pow(1 - p, 3); // ease-out cubic
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      lastProgrammaticScrollTime = Date.now();
      scrollEl.scrollLeft = from + delta * ease(p); // browser clamps to scroll bounds
      if (p < 1) _physAnim = requestAnimationFrame(step);
      else { _physAnim = null; if (onDone) onDone(); }
    };
    _physAnim = requestAnimationFrame(step);
  }
  // Settle the reading (right) edge exactly onto a column boundary so no
  // vertical line is ever partially rendered. This is the SAME alignment
  // autoScrollForRange uses for cues — align a line-box right edge to
  // (sr.right - pad), where `pad` reserves room for the furigana that sits to
  // the right of the base column — but applied to the NEAREST column on any
  // settle (swipe page-turn, snap-back, post-autoscroll). Two robustness
  // choices matter for cross-platform correctness:
  //   • INSTANT scrollBy (no behavior:'smooth') — WKWebView's smooth-scroll
  //     easing lands a few px off the boundary, which is exactly why iOS
  //     autoscroll looked un-clean while Android's did; an instant scrollBy
  //     lands precisely on both.
  //   • the MEDIAN residual over every visible column (the grid is one
  //     continuous pitch since the CSS zeroes all chunk margins/padding) — so
  //     a stray glyph rect can't skew the alignment.
  function _snapToColumn() {
    if (!scrollEl || physDragging || !_physEnabled()) return;
    if (!document.body.classList.contains('mode-read')) return;
    const sr = scrollEl.getBoundingClientRect();
    if (sr.width < 40) return;
    const W = _columnWidth();
    const pad = Math.min(24, sr.width * 0.05);
    const targetX = sr.right - pad;            // reading edge, furigana room reserved
    const list = (chunks && chunks.length) ? chunks : (innerEl ? [innerEl] : []);
    const res = [];
    for (const ch of list) {
      let cb; try { cb = ch.getBoundingClientRect(); } catch (_) { continue; }
      if (cb.width < 1 || cb.height < 1) continue;
      if (cb.right < sr.left - W || cb.left > sr.right + W) continue; // not near viewport
      // A chunk's bounding-box RIGHT edge IS a true column boundary — furigana
      // included (it's the element's full extent) and free of the per-glyph
      // noise that getClientRects gives (ruby annotations emit their own rects
      // offset from the base column, which skewed the old median by ~a column).
      // Chunks are contiguous (CSS zeroes their margins) so they share one
      // continuous column grid of pitch W.
      let d = cb.right - targetX;               // residual to this chunk's leading column edge
      d -= W * Math.round(d / W);               // fold to nearest boundary, [-W/2, W/2]
      res.push(d);
    }
    if (!res.length) return;
    res.sort((a, b) => a - b);
    const off = res[Math.floor(res.length / 2)]; // median over chunks (robust)
    if (Math.abs(off) < 4) return;               // already on a boundary (autoscroll's own tolerance)
    lastProgrammaticScrollTime = Date.now();
    scrollEl.scrollBy({ left: off });            // same sign convention as autoScrollForRange
  }
  function _ensureEdgeMasks() {
    const mk = (id) => {
      const d = document.createElement('div');
      d.id = id;
      d.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;background:#000;z-index:2700;pointer-events:none;';
      (viewEl || document.body).appendChild(d);
      return d;
    };
    if (!_edgeMaskL || !_edgeMaskL.isConnected) _edgeMaskL = mk('pagedEdgeMaskL');
    if (!_edgeMaskR || !_edgeMaskR.isConnected) _edgeMaskR = mk('pagedEdgeMaskR');
  }
  // Hide the PARTIAL column at BOTH edges so no vertical line is ever shown
  // half-rendered (furigana included). The far (left / unread) edge gets the
  // large `viewport mod columnWidth` leftover; the reading (right) edge gets the
  // thin sliver of the PREVIOUS column that peeks past the reading column — the
  // "few pixels on the right" on iPhone, and the ~1px that appears after a font
  // change on Android. Both strips match the reader background so they read as
  // page margins. Display-only: it never scrolls, so it can't disturb autoscroll
  // or jiggle, and `_columnWidth()` is recomputed each call so font changes
  // (which change the column pitch) are tracked immediately.
  function _updateEdgeMask() {
    if (!scrollEl) return;
    _ensureEdgeMasks();
    const on = _physEnabled() && document.body.classList.contains('mode-read') &&
               !_readerHidden();
    if (!on) { _edgeMaskL.style.width = '0'; _edgeMaskR.style.width = '0'; _maskLW = 0; _maskRW = 0; return; }
    const sr = scrollEl.getBoundingClientRect();
    if (sr.width < 40) { _edgeMaskL.style.width = '0'; _edgeMaskR.style.width = '0'; _maskLW = 0; _maskRW = 0; return; }
    const W = _columnWidth();
    const list = (chunks && chunks.length) ? chunks : (innerEl ? [innerEl] : []);
    const lefts = [], rights = [];
    for (const ch of list) {
      let cb; try { cb = ch.getBoundingClientRect(); } catch (_) { continue; }
      if (cb.width < 1 || cb.height < 1) continue;
      if (cb.right < sr.left - W || cb.left > sr.right + W) continue;
      // cb.right is a true column boundary; the grid has uniform pitch W.
      // Left: from sr.left to the leftmost grid boundary still >= sr.left.
      lefts.push(cb.right + Math.ceil((sr.left - cb.right) / W) * W - sr.left);   // in [0, W)
      // Right: from the rightmost grid boundary still <= sr.right to sr.right.
      rights.push(sr.right - (cb.right + Math.floor((sr.right - cb.right) / W) * W)); // in [0, W)
    }
    let bg = '#000';
    try {
      bg = getComputedStyle(scrollEl).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(document.body).backgroundColor || '#000';
    } catch (_) {}
    const med = (a) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const effW = (raw) => (raw > 1.5 ? Math.min(raw, W) : 0);
    _maskLW = effW(med(lefts));
    _maskRW = effW(med(rights));
    const apply = (m, w, side) => {
      if (!(w > 0)) { m.style.width = '0'; return; }
      m.style.background = bg;
      m.style.top = sr.top + 'px';
      m.style.height = (sr.bottom - sr.top) + 'px';
      m.style.width = w + 'px';
      m.style.left = (side === 'right' ? (sr.right - w) : sr.left) + 'px';
    };
    apply(_edgeMaskL, _maskLW, 'left');
    apply(_edgeMaskR, _maskRW, 'right');
  }
  function _scheduleEdgeMask() {
    if (_edgeMaskRafPending) return;
    _edgeMaskRafPending = true;
    requestAnimationFrame(() => { _edgeMaskRafPending = false; try { _updateEdgeMask(); } catch (_) {} });
  }
  // True when a top-2/3 horizontal swipe should navigate SUBTITLES instead of
  // turning the page: an audiobook+SRT title (cues exist) with a known current
  // cue. Pure EPUB-only books (no cues) keep the whole-page page-turn unchanged.
  function _readerCueSwipeAvailable() {
    const cues = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    if (!cues.length) return false;
    const cur = (Number.isFinite(window._lastAudioCueIdx) && window._lastAudioCueIdx >= 0)
      ? window._lastAudioCueIdx
      : (Number.isFinite(lastReadCueIdx) ? lastReadCueIdx : -1);
    return cur >= 0;
  }

  // Read-mode "transport" swipe: a horizontal swipe in the TOP 2/3 of the reader
  // navigates by ONE SUBTITLE (like card / audio mode) instead of turning the
  // page. Seeks the audiobook to the prev/next cue with the same brief audio
  // fade, and moves the reader (paint + smooth scroll) to follow — so it works
  // whether audio is playing or paused. Base = the active (highlighted) cue =
  // the audio playhead, like the other modes' transport; falls back to the read
  // cursor if the playhead is unknown. dir: +1 next subtitle, -1 previous.
  function readerCueSwipe(dir) {
    try {
      const cues = (pagedCues?.length ? pagedCues : (window.__abCues || []));
      if (!cues.length) return;
      let cur = window._lastAudioCueIdx;
      if (!Number.isFinite(cur) || cur < 0) cur = Number.isFinite(lastReadCueIdx) ? lastReadCueIdx : -1;
      if (!Number.isFinite(cur) || cur < 0) return;
      const target = Math.max(0, Math.min(cues.length - 1, cur + dir));
      if (target === cur) return;   // already at the first / last cue
      const cue = cues[target];
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      if (bg && cue && Number.isFinite(cue.startMs)) {
        const ms = Math.max(0, Math.round(cue.startMs) - (window.AUDIO_START_OFFSET_MS || 0));
        try { bg.seek({ ms, fadeMs: 70 }); } catch (_) {}   // brief fade, like the other modes
      }
      window._lastAudioCueIdx = target;
      if (typeof window.persistReadCue === 'function') { try { window.persistReadCue(target); } catch (_) {} }
      // The seek lands at (target.start − AUDIO_START_OFFSET_MS), i.e. a beat
      // BEFORE the target cue, so the first position event would make the live
      // audio-follow briefly paint the PREVIOUS cue green before playback crosses
      // in. Arm a guard so the live-follow holds the swiped-to highlight until the
      // playhead actually reaches the target (mirrors the card-mode post-swipe
      // guard). ensureGreenOnEnter below paints the target by INDEX (not guarded).
      window._readerCueHlGuardTarget = target;
      window._readerCueHlGuardUntil  = Date.now() + 1500;
      try { ensureGreenOnEnter(target); } catch (_) {}       // move the reader to follow (paint + scroll)
    } catch (e) { log('readerCueSwipe err: ' + (e?.message || e)); }
  }

  // True while a read-mode subtitle swipe is holding the highlight: the playhead
  // hasn't yet reached the swiped-to cue, so a position-derived paint of an
  // EARLIER cue should be suppressed (else the previous cue flashes green).
  // Releases as soon as the playhead reaches the target, or after a failsafe.
  function _readerCueHlGuarded(idx) {
    const until = window._readerCueHlGuardUntil || 0;
    if (!until || Date.now() > until) { window._readerCueHlGuardUntil = 0; return false; }
    const target = window._readerCueHlGuardTarget;
    if (!Number.isFinite(target)) return false;
    if (idx >= target) { window._readerCueHlGuardUntil = 0; return false; }  // playhead arrived → release
    return true;                                                            // still in the lead-in → hold
  }

  function installPagedPhysics() {
    if (!scrollEl || scrollEl._physWired || !_physEnabled()) return;
    scrollEl._physWired = true;
    scrollEl.style.touchAction = 'none'; // take touch off the native scroller
    let sx = 0, sy = 0, anchor = 0;
    let committed = false;
    let cueMode = false, cueDx = 0;   // top-2/3 horizontal swipe = subtitle nav (enriched titles)
    let lastX = 0, lastT = 0, vel = 0;
    let anchorMaskTotal = 0; // mask widths at the page we're turning FROM (for the page step)
    scrollEl.addEventListener('touchstart', (e) => {
      const t = e.touches?.[0]; if (!t) return;
      _cancelPhysAnim();
      sx = t.clientX; sy = t.clientY; anchor = scrollEl.scrollLeft;
      committed = false; physDragging = false; cueMode = false; cueDx = 0;
      // Captured NOW (page settled at the anchor) — during the drag the masks
      // update to the peeked position, which would skew the page step.
      anchorMaskTotal = (_maskLW || 0) + (_maskRW || 0);
      lastX = t.clientX; lastT = Date.now(); vel = 0;
    }, { passive: true });
    scrollEl.addEventListener('touchmove', (e) => {
      const t = e.touches?.[0]; if (!t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (!committed) {
        if (adx > PHYS.COMMIT_PX && adx > ady) {
          committed = true; physDragging = true;
          // ZONE SPLIT: a horizontal swipe that STARTS in the top 2/3 of the
          // reader navigates SUBTITLES (one cue, like card/audio mode) instead of
          // turning the page — but ONLY for enriched (audiobook+SRT) titles that
          // have cues. EPUB-only books (no cues) keep the whole-page page-turn.
          // The bottom 1/3 always turns the page.
          const _rect = scrollEl.getBoundingClientRect();
          const _localY = sy - _rect.top;
          cueMode = (_localY >= 0 && _localY < _rect.height * (2 / 3)) && _readerCueSwipeAvailable();
          // A committed horizontal PAGE drag is the user actively reading — start
          // (or keep alive) the read timer even for a slight jiggle that springs
          // back (NOT for a cue-nav swipe, which isn't a page move). The native
          // 'scroll' listener can't catch this: the physics drag tags its own
          // scrollLeft writes as programmatic (lastProgrammaticScrollTime), which
          // suppresses its bumpRead.
          if (!cueMode) { try { if (document.body.classList.contains('mode-read')) window.stats?.bumpRead?.(); } catch (_) {} }
        }
        else return; // vertical-first or still a tap → leave it to the other handlers
      }
      if (cueMode) {
        // Don't rubber-band/peek the page; just block native scroll, remember the
        // direction, and fire the cue nav on release (a discrete swipe like card
        // mode, not a drag-follow).
        if (e.cancelable) e.preventDefault();
        cueDx = dx;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const now = Date.now();
      vel = (t.clientX - lastX) / Math.max(1, now - lastT);
      lastX = t.clientX; lastT = now;
      const dim = scrollEl.clientWidth || cw || 360;
      // Rubber-band the drag (resistance grows with distance); a slow drag is
      // always a "peek" — release snaps back to the column-aligned page.
      const disp = _rubber(dx, dim);
      lastUserScrollTime = Date.now();
      lastProgrammaticScrollTime = Date.now();
      scrollEl.scrollLeft = anchor - PHYS.DIR * disp;
    }, { passive: false });
    const onEnd = () => {
      if (!committed) { physDragging = false; return; }
      if (cueMode) {
        // Discrete subtitle swipe: navigate one cue by direction (swipe-left =
        // forward = next subtitle, matching the page-turn + card mode). A small
        // committed jiggle below the gesture threshold is a no-op.
        if (Math.abs(cueDx) > 30) readerCueSwipe(cueDx < 0 ? 1 : -1);
        cueMode = false; cueDx = 0;
        setTimeout(() => { physDragging = false; }, 60);
        return;
      }
      const W = _columnWidth();
      const dim = scrollEl.clientWidth || cw || 360;
      // Advance by the columns actually VISIBLE BETWEEN the edge masks. Plain
      // floor(dim/W) counts the masked partial columns too, so when the two
      // partials sum to ≥ one column the page-turn jumps a column too far and
      // EATS the blacked-out line (manual reading / EPUB-only, where there's no
      // autoscroll to re-justify it). dim − anchorMaskTotal == N_visible × W, so
      // round() recovers the exact visible-column count. Masks off → plain fit.
      const cols = anchorMaskTotal > 0.5
        ? Math.max(1, Math.round((dim - anchorMaskTotal) / W))
        : Math.max(1, Math.floor(dim / W));
      if (Math.abs(vel) > PHYS.FLING_V) {
        // Quick swipe → advance one page of WHOLE columns, then settle the
        // reading edge precisely onto a column boundary (no partial line).
        const sign = vel < 0 ? -1 : 1;
        // No post-turn column snap: the smooth animation stops where it lands
        // and the edge masks hide any leftover partial column. (The snap's
        // instant scrollBy was the "rough, unnatural stop" on iPhone — and
        // since each turn advances by WHOLE columns, an already-aligned page
        // stays aligned without it; the next autoscroll re-aligns regardless.)
        _physAnimateTo(anchor - PHYS.DIR * sign * cols * W, PHYS.TURN_MS, () => { _scheduleEdgeMask(); _creditReadCharsFromVisible(); _creditReadFrontier(); _armBookmarkTimer(); });
      } else {
        // Slow drag → spring back to where you started.
        _physAnimateTo(anchor, PHYS.SNAP_MS, () => { _scheduleEdgeMask(); _creditReadCharsFromVisible(); _creditReadFrontier(); _armBookmarkTimer(); });
      }
      // Keep physDragging true through the settle so the tap handler doesn't
      // fire a dict lookup; clear shortly after.
      setTimeout(() => { physDragging = false; }, 60);
    };
    scrollEl.addEventListener('touchend', onEnd, { passive: true });
    scrollEl.addEventListener('touchcancel', onEnd, { passive: true });
  }

  // Credit read-mode char progress + advance the read cursor (lastReadCueIdx)
  // from the leftmost visible chunk. Safe to call repeatedly and from anywhere:
  // noteReadPosition is a monotonic max (backward scroll = no-op) and this does
  // NO scroll / seek / DOM move, so it can never relocate the user. The physics
  // page-turn settle calls this directly because, under the physics engine,
  // every scrollLeft write is tagged programmatic (lastProgrammaticScrollTime),
  // so the gated scroll-listener path below NEVER runs while paging — which is
  // why the read char counter sat at 0 and lastReadCueIdx never advanced.
  function _creditReadCharsFromVisible() {
    try {
      if (!document.body.classList.contains('mode-read')) return;
      if (!window.stats?.noteReadPosition || !chunks?.length) return;
      const sr = scrollEl.getBoundingClientRect();
      // One scan, TWO different anchors — they are genuinely different things:
      //  • leftChunk (leftmost visible)   → CHAR PROGRESS ("how far have I read").
      //    In vertical-rl the leftmost on-screen column is the furthest-advanced
      //    text, and it stays ~stable across orientation changes (landscape fits
      //    many more columns), so the progress % doesn't jump on rotation.
      //  • edgeChunk (the RIGHT reading edge) → READ CURSOR ("where am I").
      //    Japanese vertical text reads RIGHT-to-left, so the line the user is
      //    actually on is the column at the right edge (the same place the reader
      //    parks the active/green line). Anchoring the cursor on the leftmost
      //    peek-ahead column was what reopened the book 1-2 subtitles AHEAD.
      let leftChunk = null, leftMin = Infinity;
      let edgeChunk = null, edgeDist = Infinity;
      for (const ch of chunks) {
        const r = ch.getBoundingClientRect();
        if (r.right < sr.left + 1 || r.left > sr.right - 1) continue;
        if (r.bottom < sr.top + 1 || r.top > sr.bottom - 1) continue;
        if (r.left < leftMin) { leftChunk = ch; leftMin = r.left; }
        const d = Math.abs(r.right - sr.right); // closest to the right reading edge
        if (d < edgeDist) { edgeChunk = ch; edgeDist = d; }
      }
      // (Char crediting removed from this scroll path — it counted auto-scroll.
      // Chars are credited only at the 5 s bookmark; `leftChunk` is unused here
      // now but kept so the scan stays a single source for both anchors.)
      void leftChunk;
      // Read cursor: the current reading line is the chunk at the RIGHT edge, so
      // "stay at read position" + restore-on-open land where the user actually is.
      if (edgeChunk && pagedChunkToCue) {
        const ci = chunks.indexOf(edgeChunk);
        if (ci >= 0 && ci < pagedChunkToCue.length && pagedChunkToCue[ci] >= 0) {
          lastReadCueIdx = pagedChunkToCue[ci];
          window._lastAudioCueIdx = lastReadCueIdx;
        }
      }
      // NOTE: char crediting deliberately does NOT happen here anymore — it would
      // count auto-scroll / smooth programmatic scrolls. Chars are credited only
      // at the 5s bookmark (_settleBookmark). This call now only moves the cursor.
    } catch (_) {}
  }

  // ===================== READ BOOKMARK — single position anchor =============
  // ONE source of truth for the read/card place: the line you're on (a chunk
  // index). It is where the book reopens, the highlighted line, AND the char
  // baseline. Auto-set after 5 s of no page movement (with a toast) and silently
  // on close, so reopen is always exact. Char credit happens ONLY here, so
  // auto-scroll / jumps can never inflate the count. Hard guards: never bookmark
  // or restore unless read mode + laid out + a real line is on screen — so a
  // dump-to-0 / garbage save is structurally impossible.
  const KEY_BOOKMARK_PREFIX = 'PAGED_BOOKMARK_';
  const BOOKMARK_SETTLE_MS = 5000;
  let _bookmarkChunkIdx = -1;
  let _bookmarkTimer = null;
  let _lastToastedBookmarkIdx = -2;

  // The current reading line (right edge) + frontier char offset (leftmost
  // visible), read from the live viewport. Returns null if nothing valid is on
  // screen (view hidden / not laid out / no chunk intersects) — callers MUST
  // treat null as "do nothing", never as position 0.
  function _visibleReadAnchors() {
    if (!scrollEl || !chunks?.length) return null;
    const sr = scrollEl.getBoundingClientRect();
    if (!(sr.width > 1)) return null;
    // The line the user is actually reading sits where the RESTORE re-positions
    // the bookmark: "near the right edge with ~3 context lines", i.e. its right
    // edge at (viewport-right − pad − 3 lines). Saving THAT chunk (not the
    // right-edge / oldest-visible chunk, which is those ~3 already-read context
    // lines behind) is what makes a reopen land where the user left off instead
    // of ~3 lines back. Mirrors scrollChunkNearRightWithContext's geometry.
    let lineHeightPx = 40;
    try {
      const cs = getComputedStyle(innerEl);
      lineHeightPx = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) lineHeightPx = (parseFloat(cs.fontSize) || 18) * 1.8;
    } catch (_) {}
    const pad = Math.min(16, sr.width * 0.04);
    const targetRightX = sr.right - pad - lineHeightPx * 3;   // 3 = the restore's contextLines

    let edgeChunk = null, edgeDist = Infinity;
    let readingChunk = null, readingDist = Infinity;
    let maxFrontier = 0;   // deepest END char-offset among on-screen chunks
    for (const ch of chunks) {
      const r = ch.getBoundingClientRect();
      if (r.right < sr.left + 1 || r.left > sr.right - 1) continue;
      if (r.bottom < sr.top + 1 || r.top > sr.bottom - 1) continue;
      // Frontier = the DEEPEST visible text, from char METADATA (engine-agnostic).
      // dataset.jpOff/jpLen are identical on both engines and the max END offset
      // on screen climbs monotonically as you read forward.
      const end = (parseInt(ch.dataset.jpOff) || 0) + (parseInt(ch.dataset.jpLen) || 0);
      if (end > maxFrontier) maxFrontier = end;
      const d = Math.abs(r.right - sr.right);
      if (d < edgeDist) { edgeChunk = ch; edgeDist = d; }
      const rd = Math.abs(r.right - targetRightX);
      if (rd < readingDist) { readingChunk = ch; readingDist = rd; }
    }
    if (!edgeChunk) return null;
    return {
      edgeIdx: chunks.indexOf(edgeChunk),
      readingIdx: chunks.indexOf(readingChunk || edgeChunk),
      frontierOff: maxFrontier
    };
  }

  // ---- Bookmarks (Workstream A): read-location capture + restore ----
  // First chunk whose END jp-offset passes `target` — used to re-resolve a
  // bookmark after a font-size re-pagination shifted chunk indices.
  function _findChunkForJpOff(target) {
    if (!chunks?.length || !Number.isFinite(target)) return -1;
    for (let i = 0; i < chunks.length; i++) {
      const off = parseInt(chunks[i].dataset.jpOff) || 0;
      const len = parseInt(chunks[i].dataset.jpLen) || 0;
      if (target < off + len) return i;
    }
    return chunks.length - 1;
  }
  // The bookmark anchor for an ENRICHED (audio/SRT/EPUB) title: the chunk the
  // audio cue was LAST playing (the green-highlighted chunk), NOT the EPUB
  // scroll position. Returns null when no cue has been painted — i.e. there's
  // no audio context, so the title isn't bookmark-worthy. Stored as chunkIdx
  // (fast same-layout restore) + jpOff (human-readable char-offset + cross-
  // layout fallback after a re-pagination).
  window.pagedGetReadLocation = function () {
    if (!(lastHighlightedChunkIdx >= 0 && lastHighlightedChunkIdx < (chunks?.length || 0))) return null;
    const ch = chunks[lastHighlightedChunkIdx];
    const jpOff = ch ? (parseInt(ch.dataset.jpOff) || 0) : 0;
    return { chunkIdx: lastHighlightedChunkIdx, jpOff, bookName: currentName };
  };
  // Seed the per-book bookmark pref so a (re)open of that book lands here
  // (used before opening a DIFFERENT title from the Bookmarks list).
  window.pagedSeedBookmark = async function (loc) {
    if (!loc || !loc.bookName || !Number.isFinite(loc.chunkIdx)) return;
    try { await setPref(KEY_BOOKMARK_PREFIX + loc.bookName, String(loc.chunkIdx)); } catch (_) {}
  };
  // Jump the live reader to a bookmark — only if its book is the active one.
  window.pagedJumpToBookmark = async function (loc) {
    if (!loc) return;
    try {
      await window.pagedSeedBookmark(loc);
      if (loc.bookName !== currentName || !chunks?.length) return;
      let idx = loc.chunkIdx;
      if (!(idx >= 0 && idx < chunks.length)) idx = _findChunkForJpOff(loc.jpOff);
      if (!(idx >= 0 && idx < chunks.length)) return;
      _bookmarkChunkIdx = idx;
      try { await _waitForPagedLayout(1500); } catch (_) {}
      scrollChunkNearRightWithContext(chunks[idx], 3, { allowFarJump: true });
      _flashBookmarkChunk(chunks[idx]);
    } catch (e) {}
  };

  // Briefly tint the chunk a bookmark was made at, so jumping back shows the
  // user exactly which line they're returning to. Uses the read highlight
  // colour (.bm-flash → var(--accent-read)); the CSS animation fades it out.
  function _flashBookmarkChunk(ch) {
    if (!ch) return;
    try {
      ch.classList.remove('bm-flash');
      // reflow so re-adding the class restarts the animation on a repeat jump
      void ch.offsetWidth;
      ch.classList.add('bm-flash');
      setTimeout(() => { try { ch.classList.remove('bm-flash'); } catch (_) {} }, 3800);
    } catch (_) {}
  }

  // Restart the 5 s settle timer on every USER page movement (read mode only).
  // Capture the book name AT ARM TIME so a timer armed for book A can never fire
  // after a switch to book B and save B's not-yet-restored (0) viewport.
  let _bookmarkArmedForName = null;
  function _armBookmarkTimer() {
    if (!document.body.classList.contains('mode-read')) return;
    if (_bookmarkTimer) clearTimeout(_bookmarkTimer);
    _bookmarkArmedForName = currentName;
    _bookmarkTimer = setTimeout(_settleBookmark, BOOKMARK_SETTLE_MS);
  }

  // Cancel any pending settle (on book load / close / mode change) so it can't
  // fire against the wrong book.
  function _clearBookmarkTimer() {
    if (_bookmarkTimer) { clearTimeout(_bookmarkTimer); _bookmarkTimer = null; }
    _bookmarkArmedForName = null;
  }

  function _persistBookmark() {
    if (!currentName || _bookmarkChunkIdx < 0) return;       // never persist garbage
    try { setPref(KEY_BOOKMARK_PREFIX + currentName, String(_bookmarkChunkIdx)); } catch (_) {}
  }

  // Guard for the RAW-scrollLeft save: refuse to write unless the view is live,
  // laid out, and the value is real — so a transient mid-flip 0 (book B has reset
  // scrollLeft to 0 but currentName is still book A) can NEVER overwrite book A's
  // good saved position — the title-alternation place-loss this guards against.
  // A real deep position, a card-bearing title, or a recent user scroll passes.
  function _canSaveReadScroll() {
    try {
      if (!currentName || !scrollEl || !viewEl) return false;
      if (_readerHidden()) return false;
      if (!(scrollEl.scrollWidth > scrollEl.clientWidth + 1)) return false;  // not laid out
      const hasCards = Array.isArray(window.allNotes) && window.allNotes.length > 0;
      return hasCards || Math.abs(scrollEl.scrollLeft) > 1 || (Date.now() - lastUserScrollTime < 4000);
    } catch (_) { return false; }
  }

  // Credit genuine reading via the frontier (leftmost-visible) char offset.
  // noteReadPosition is monotonic + page-capped, so calling this often (page
  // turns, settle, close) can never OVER-credit, and a jump's big delta is
  // dropped — yet it can't UNDER-count a steady read that ends in a close.
  function _creditReadFrontier() {
    try {
      if (!document.body.classList.contains('mode-read')) return;
      const a = _visibleReadAnchors();
      if (a) window.stats?.noteReadPosition?.(a.frontierOff);
    } catch (_) {}
  }

  // 5 s of stillness → bookmark the current line, credit reading, toast.
  function _settleBookmark() {
    try {
      _bookmarkTimer = null;
      if (_bookmarkArmedForName !== currentName) return;   // book changed since arm → bail
      if (!document.body.classList.contains('mode-read')) return;
      if (_readerHidden()) return;
      const a = _visibleReadAnchors();
      if (!a || a.edgeIdx < 0) return;               // nothing valid → never bookmark garbage
      _bookmarkChunkIdx = a.readingIdx;
      _persistBookmark();
      try { window.stats?.noteReadPosition?.(a.frontierOff); } catch (_) {}
      if (a.readingIdx !== _lastToastedBookmarkIdx) {     // one toast per new line
        _lastToastedBookmarkIdx = a.readingIdx;
        try { window.showToast?.('Location bookmarked', 1200); } catch (_) {}
      }
    } catch (_) {}
  }

  // Capture the current line silently (on close / background) so reopen is exact
  // even if the user left before 5 s, and credit the final reading so a session
  // that ends in a close isn't lost. Never overwrites a good bookmark with junk.
  function _saveBookmarkNow(force) {
    try {
      // Restore in flight: currentName is already the NEW book and the view is
      // laid out + mode-read, but scrollLeft is still 0 because the bookmark
      // scroll hasn't been applied yet (across `await _waitForPagedLayout`). A
      // visibilitychange/hidden or a leave-read flush in that window would read
      // edgeIdx≈0 and persist 0 over the just-loaded deep bookmark → dump-to-0.
      // suppressScrollSave is true for the whole restore window (same signal the
      // raw-scroll save already trusts), so bail.
      if (suppressScrollSave) return;
      // `force` (from the leave-read flush) bypasses ONLY the mode-read class
      // gate: shell.js clears mode-read BEFORE firing shell:mode-change, so the
      // exit flush would otherwise skip freshening the line and reopen a few
      // lines behind. The view-visible guard + the _visibleReadAnchors null-check
      // below still block any write when the paged view isn't the live layout,
      // so a real card/audio mode (paged view hidden) is still correctly skipped.
      if (!force && !document.body.classList.contains('mode-read')) return;
      if (_readerHidden()) return;
      const a = _visibleReadAnchors();
      if (!a || a.edgeIdx < 0) return;
      _bookmarkChunkIdx = a.readingIdx;
      _persistBookmark();
      try { window.stats?.noteReadPosition?.(a.frontierOff); } catch (_) {}
    } catch (_) {}
  }

  function setupScrollTracking() {
    let pendingSave = null;
    scrollEl.addEventListener('scroll', () => {
      _scheduleEdgeMask(); // keep the far-edge partial-column mask in sync (rAF-throttled, never scrolls)
      // Distinguish user-initiated scroll from programmatic (audio-follow)
      // scroll. Anything not within 800ms of our last programmatic call
      // counts as the user actively reading.
      if (Date.now() - lastProgrammaticScrollTime > 800) {
        lastUserScrollTime = Date.now();
        // User-driven scroll IS reading activity — kick the read timer
        // alive. Cheap call; if the timer is already running it just
        // refreshes lastInteraction. If it had been stopped by the
        // inactivity timeout, a small jiggle is enough to restart it.
        try { window.stats?.bumpRead?.(); } catch (_) {}
        // Feed the read stats char tracker + advance the read cursor from the
        // leftmost visible chunk. (Extracted to _creditReadCharsFromVisible so
        // the physics page-turn settle can call it too — under that engine this
        // gated scroll path never fires.)
        _creditReadCharsFromVisible();
        _armBookmarkTimer();   // user moved → (re)start the 5 s bookmark countdown
      }
      updateProgress();
      if (suppressScrollSave) return;
      if (pendingSave) clearTimeout(pendingSave);
      pendingSave = setTimeout(() => {
        if (_canSaveReadScroll()) {
          setPref(KEY_LAST_SCROLL_PREFIX + currentName, scrollEl.scrollLeft);
        }
        // Persist the read location as the title's card index for SRT-cards
        // titles (card index === cue index), so a restart restores the
        // last-read line instead of a stale card position.
        if (lastReadCueIdx >= 0 && typeof window.persistReadCue === 'function') {
          window.persistReadCue(lastReadCueIdx);
        }
      }, 400);
    }, { passive: true });

    // Flush the latest read position the instant the app is backgrounded /
    // closed. The 400ms debounce above can otherwise lose it if the user swipes
    // the app away right after scrolling — a real "position isn't saved" cause
    // (esp. for EPUB-only titles). Only while the reader is the active view.
    if (!window._pagedVisFlushWired) {
      window._pagedVisFlushWired = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        if (!currentName || !scrollEl || _readerHidden()) return;
        try { _saveBookmarkNow(); } catch (_) {}
        try { if (_canSaveReadScroll()) setPref(KEY_LAST_SCROLL_PREFIX + currentName, scrollEl.scrollLeft); } catch (_) {}
        if (lastReadCueIdx >= 0 && typeof window.persistReadCue === 'function') {
          try { window.persistReadCue(lastReadCueIdx); } catch (_) {}
        }
      });
    }

    // Paged scroll physics (rubber-band peek / snap-back / page-turn). Idempotent
    // (guarded by scrollEl._physWired); no-op when localStorage.PAGED_PHYSICS==='0'.
    try { installPagedPhysics(); } catch (e) { log('installPagedPhysics failed: ' + e.message); }

    // Refresh the edge masks on a font-size change. The reader font slider only
    // writes the --font-size-read CSS var on :root (re-flowing the vertical-rl
    // columns to a new pitch) and fires NO scroll/resize event, so the masks
    // would otherwise keep the old column width — the "1px of the previous line
    // after a font change" report. Observe :root's style attribute; the handler
    // is rAF-throttled, so the (rare) extra :root style mutations are cheap.
    if (!window._pagedFontObsWired) {
      window._pagedFontObsWired = true;
      try {
        new MutationObserver(() => _scheduleEdgeMask())
          .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      } catch (_) {}
    }
  }

  function setupResize() {
    let t;
    let lastWidth = 0;
    window.addEventListener('resize', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (_readerHidden()) return;
        // CRITICAL: only react to WIDTH changes. iOS Safari fires resize
        // events constantly as the URL bar hides/shows on scroll — if we
        // re-scroll on every event, the view fights the user's swipe.
        // That was the "snapping back" the user reported.
        const newW = scrollEl.clientWidth;
        if (newW === lastWidth || newW === cw) return;
        lastWidth = newW;
        recompute();
        // Wait one more frame for vertical-rl layout to settle at the
        // new orientation before computing chunk positions.
        requestAnimationFrame(() => {
          // Snap to the active card. The previous scrollLeft-fraction
          // math (frac × sw) sent the user to the start of the book on
          // rotation because vertical-rl + direction:rtl scrollLeft
          // semantics flip mid-rotation on iOS WKWebView — same
          // fraction at the new sw lands at a totally different
          // location. centerOnActiveCard uses the chunk's
          // getBoundingClientRect, which is rotation-stable.
          // Bypass the user-scroll grace period (lastUserScrollTime
          // check inside centerOnActiveCard) — rotation is a deliberate
          // event, not "the user is reading independently."
          const savedUserScroll = lastUserScrollTime;
          lastUserScrollTime = 0;
          try { centerOnActiveCard(); } catch (_) {}
          lastUserScrollTime = savedUserScroll;
          _scheduleEdgeMask(); // viewport width changed → recompute the leftover mask
        });
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
    _scheduleEdgeMask(); // column pitch may have changed (font/orientation) → refresh masks
  }

  // Create the progress strip once and keep it as a sibling of body so
  // it survives across paged-view rebuilds. Click AND touchend both
  // trigger the jump prompt — Capacitor WKWebView sometimes drops the
  // synthetic click after touchend, so wiring both is the reliable
  // pattern (same one shell-menu items use).
  // In landscape, the standalone fixed strip gets clipped behind the
  // notch/Dynamic Island. Mirror it into the appHeader (between mode
  // tabs and the timer) so it stays visible. CSS swaps which copy is
  // displayed based on orientation.
  let progressInlineEl = null;
  function ensureProgressInline() {
    if (progressInlineEl) return progressInlineEl;
    const header = document.getElementById('appHeader');
    const tabs = document.getElementById('shellModeTabs');
    if (!header || !tabs) return null;
    progressInlineEl = document.createElement('div');
    progressInlineEl.id = 'readingPagedProgressInline';
    progressInlineEl.textContent = '—';
    progressInlineEl.style.cssText =
      'font:11px/1 var(--font-sans,system-ui);color:#aaa;letter-spacing:.03em;' +
      'padding:0 10px;white-space:nowrap;cursor:pointer;user-select:none;' +
      '-webkit-user-select:none;align-self:center;';
    tabs.parentNode.insertBefore(progressInlineEl, tabs.nextSibling);
    progressInlineEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof window.onProgressBarTap === 'function') {
        try { window.onProgressBarTap(e); } catch (_) {}
      }
    });
    return progressInlineEl;
  }

  function ensureProgressStrip() {
    // Header clone is cheap to set up here so card-only mode (which calls
    // ensureProgressStrip from window.pagedEnsureProgressStrip) also gets
    // the landscape-friendly placement.
    ensureProgressInline();
    if (progressEl) return;
    progressEl = document.createElement('div');
    progressEl.id = 'readingPagedProgress';
    progressEl.textContent = '—';
    let firing = false;
    const fire = (e) => {
      if (firing) return;
      firing = true;
      try { e.stopPropagation(); } catch (_) {}
      try { if (e.cancelable) e.preventDefault(); } catch (_) {}
      // Route by mode so the strip behaves like the bottom bar in
      // each mode: audio→seek modal, card→jump-to-card, read→
      // percent-jump. window.onProgressBarTap is the existing
      // mode-aware dispatcher in app.js. Fallback to the local
      // openJumpModal if the dispatcher isn't loaded.
      if (typeof window.onProgressBarTap === 'function') {
        try { window.onProgressBarTap(e); } catch (_) { openJumpModal(); }
      } else {
        openJumpModal();
      }
      setTimeout(() => { firing = false; }, 500);
    };
    progressEl.addEventListener('click', fire);
    progressEl.addEventListener('touchend', fire, { passive: false });
    document.body.appendChild(progressEl);
  }

  // Top-right safe-area button — sets audio playhead to the cue under
  // the right edge of the viewport (the cue the user is currently
  // reading in vertical-rl). Horizontally aligned with #shellPlayBtn so
  // it sits visually directly above the play/pause icon.
  function ensurePlayheadBtn() {
    if (document.getElementById('pagedPlayheadBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'pagedPlayheadBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play from here');
    // Skip-to-next glyph (▶▌).
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M6 5v14l9-7L6 5zm10 0h2v14h-2V5z"/></svg>';
    let firing = false;
    const fire = (e) => {
      if (firing) return;
      firing = true;
      // Triple-channel proof of tap: log line, console.log, and a toast.
      // If NONE of these surface, the button isn't receiving the event
      // at all (z-index / pointer-events / OS layer issue) — distinct
      // from "event fires but handler returns early."
      const msg = 'pagedPlayheadBtn fired (' + e.type + ')';
      log(msg);
      try { console.log('[reader-paged] ' + msg); } catch (_) {}
      try { window.showToast?.('▶▌', 700); } catch (_) {}
      try { e.stopPropagation(); } catch (_) {}
      try { if (e.cancelable) e.preventDefault(); } catch (_) {}
      Promise.resolve()
        .then(() => window.pagedSetPlayheadFromView?.())
        .catch((err) => {
          const m = 'pagedSetPlayheadFromView error: ' + (err?.message || err);
          log(m);
          try { console.warn('[reader-paged] ' + m); } catch (_) {}
          try { window.showToast?.('✗ ' + (err?.message || err), 2200); } catch (_) {}
        })
        .finally(() => { setTimeout(() => { firing = false; }, 400); });
    };
    // Cover every mobile-safari path. pointerup is the canonical iOS
    // tap event; click can be eaten by 300ms delay or scroll cancel;
    // touchend can fire even on a quick swipe but we already gated with
    // the `firing` flag. Capture phase so no descendant can swallow it.
    btn.addEventListener('pointerup',  fire, { capture: true });
    btn.addEventListener('click',      fire, { capture: true });
    btn.addEventListener('touchend',   fire, { capture: true, passive: false });
    document.body.appendChild(btn);
    positionPlayheadBtn();
    window.addEventListener('resize', positionPlayheadBtn);
    window.addEventListener('orientationchange', positionPlayheadBtn);
    setTimeout(positionPlayheadBtn, 0);
    setTimeout(positionPlayheadBtn, 300);
  }

  // Place the floating button so its horizontal center matches
  // #shellPlayBtn's center. Falls back to a right-edge offset if the
  // shell button isn't rendered yet.
  function positionPlayheadBtn() {
    const btn = document.getElementById('pagedPlayheadBtn');
    if (!btn) return;
    const play = document.getElementById('shellPlayBtn');
    if (play) {
      const r = play.getBoundingClientRect();
      if (r.width > 0) {
        const center = r.left + r.width / 2;
        btn.style.left = (center - 20) + 'px'; // 20 = half of 40px width
        btn.style.right = 'auto';
        return;
      }
    }
    btn.style.right = 'calc(env(safe-area-inset-right, 0px) + 60px)';
    btn.style.left = 'auto';
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
      // A bare number >100 is a character count — interpret it in the same
      // JP-only unit the position strip shows.
      const frac = Math.min(1, Math.max(0, n <= 100 ? n / 100 : n / totalJpChars));
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
  // Exposed so the top-left progress-strip tap (routed through
  // app.js onProgressBarTap) can open the read-mode percent/char jump.
  window.pagedOpenJumpModal = openJumpModal;

  // Update the progress strip. Reads the scroll fraction and multiplies
  // by totalChars. Cheap enough to run on every scroll event.
  // Mode-aware progress strip. Accepts an optional `opts.cueIdx` so
  // callers in card / audio modes (where scrollEl isn't being scrolled
  // by the user) can drive the display from the active cue's
  // character offset. Without this, the strip stayed static in
  // non-read modes — user reported "the top-left counter only works
  // in read mode."
  //
  //   updateProgress()              — default: derive from scrollLeft
  //   updateProgress({cueIdx: n})   — derive from chunks[pagedCueToChunk[n]]
  //                                  .dataset.charOffset + charLen
  // Compact h:mm:ss / m:ss formatter.
  function _fmtHms(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—:——';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0
      ? h + ':' + String(m).padStart(2, '0') + ':' + s
      : m + ':' + s;
  }

  function _activeMode() {
    const b = document.body;
    if (b.classList.contains('mode-audio')) return 'audio';
    if (b.classList.contains('mode-read'))  return 'read';
    if (b.classList.contains('mode-card'))  return 'card';
    return 'card'; // safe default
  }

  // Mode-aware top-left progress strip.
  //   audio mode → "h:mm:ss / h:mm:ss"  (current / total audio time)
  //   card mode  → "N / total"          (1-indexed card / total cards)
  //   read mode  → "chars / total · pct%" (EPUB char position)
  //
  // opts.cueIdx is honored for read mode (paints the char position
  // for that cue's chunk) and as a fallback for the others.
  // Single point of truth for what text the strip displays. Writes to
  // both copies (standalone fixed + header inline) so a CSS-driven swap
  // between orientations doesn't drop a frame.
  function writeStripText(text) {
    if (progressEl) progressEl.textContent = text;
    if (progressInlineEl) progressInlineEl.textContent = text;
  }

  function updateProgress(opts) {
    if (!progressEl && !progressInlineEl) return;
    const mode = _activeMode();

    // --- AUDIO MODE: current / total audio time ---
    if (mode === 'audio' && typeof window.getAudioProgress === 'function') {
      const a = window.getAudioProgress();
      if (a && Number.isFinite(a.dur) && a.dur > 0) {
        writeStripText(_fmtHms(a.ms) + ' / ' + _fmtHms(a.dur));
        return;
      }
      // No duration yet — fall through to default.
    }

    // --- CARD MODE: card / total ---
    if (mode === 'card' && Array.isArray(window.allNotes) && window.allNotes.length) {
      const ci = Number.isFinite(window.currentCardIndex) ? window.currentCardIndex : 0;
      writeStripText((ci + 1).toLocaleString() + ' / ' +
                     window.allNotes.length.toLocaleString());
      return;
    }

    // --- READ MODE (or any mode with EPUB loaded): char position ---
    // Displayed in JP-only chars (ttu unit), via the parallel jpOff/jpLen
    // table — the raw charOffset coordinate is reserved for cue alignment.
    if (totalJpChars) {
      let cur = -1;
      // Prefer the explicit cueIdx ONLY when in audio mode — that's
      // where "show me where the audio cue is in the text" actually
      // matches the user's mental model. In read mode we always want
      // the SCROLL position (where the reader is looking) — falling
      // back to scroll when cueIdx is unavailable used to leave the
      // strip stuck on '—' for new titles whose audio cue index was
      // stale or -1, and flicker between scroll-chars and '—' as
      // stray audio events came in.
      if (mode === 'audio' && opts && Number.isFinite(opts.cueIdx) && opts.cueIdx >= 0) {
        if (pagedCueToChunk && pagedCueToChunk[opts.cueIdx] >= 0) {
          const chunk = chunks[pagedCueToChunk[opts.cueIdx]];
          if (chunk) {
            const off = parseInt(chunk.dataset.jpOff) || 0;
            const len = parseInt(chunk.dataset.jpLen) || 0;
            cur = off + len;
          }
        }
      }
      if (cur < 0 && scrollEl) {
        // Pick the LEFTMOST visible chunk. In vertical-rl content
        // flows right-to-left across columns; the leftmost on-screen
        // chunk is the NEWEST text the user is currently focused on.
        // Earlier we used the rightmost — that's the oldest visible
        // text, which in landscape (more columns per page) sits many
        // columns BEHIND the user's actual position. So the 33k →
        // 16k mismatch on rotation was the rightmost chunk falling
        // back N columns when the screen widened. Leftmost is
        // approximately the same regardless of how many columns
        // fit per page.
        let chosen = null;
        let chosenLeft = Infinity;
        if (chunks?.length) {
          const sr = scrollEl.getBoundingClientRect();
          for (const ch of chunks) {
            const r = ch.getBoundingClientRect();
            if (r.right < sr.left + 1 || r.left > sr.right - 1) continue;
            if (r.bottom < sr.top + 1 || r.top > sr.bottom - 1) continue;
            if (r.left < chosenLeft) { chosen = ch; chosenLeft = r.left; }
          }
        }
        if (chosen) {
          const off = parseInt(chosen.dataset.jpOff) || 0;
          const len = parseInt(chosen.dataset.jpLen) || 0;
          // Use the chunk's start offset (not end). The user is
          // CURRENTLY reading this chunk's first lines, so off ≈
          // their position. off+len would put them past it.
          cur = off;
        } else {
          // No visible chunks yet (fresh title, layout in flight).
          // Show "0 / N · 0%" instead of "—" — less alarming than a
          // dash on the position strip while the user waits.
          cur = 0;
        }
      }
      if (cur >= 0) {
        const pct = Math.round((cur / totalJpChars) * 1000) / 10;
        writeStripText(`${cur.toLocaleString()} / ${totalJpChars.toLocaleString()} · ${pct}%`);
        return;
      }
    }

    writeStripText('—');
  }
  // Visible base-text length of a chunk (ruby <rt>/<rp> readings excluded).
  function _chunkBaseLen(chunk) {
    try {
      let n = 0;
      (function walk(node) {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) n += c.nodeValue.length;
          else if (c.nodeType === 1 && c.tagName !== 'RT' && c.tagName !== 'RP') walk(c);
        }
      })(chunk);
      return n;
    } catch (_) { return (chunk.textContent || '').length; }
  }
  // Print support: extract a slice of the reading as EPUB HTML (native <ruby>
  // intact) starting at the current position, sized to ~charBudget base chars.
  // Returns { html, endCue, chars } — endCue is the cue index at the end of the
  // segment (to advance the playhead after a printed-reading session), or null
  // when the title has no cues. Lives here so it can read the chunk/cue maps.
  window.printGetReadingSegment = function (charBudget) {
    try {
      const el = innerEl || document.getElementById('readingPagedInner');
      if (!el) return null;
      const all = Array.from(el.querySelectorAll('.reading-chunk'));
      if (!all.length) return null;
      // Start at the reader's CURRENT page — the rightmost chunk visible in the
      // viewport (vertical-rl reads from the right) — so the printout continues
      // from where the user is, not the EPUB's front matter. Falls back to the
      // audio-follow active chunk, then the current cue's chunk, then the top.
      let startIdx = -1;
      try {
        if (scrollEl) {
          const sr = scrollEl.getBoundingClientRect();
          if (sr.width >= 40) {
            let bestRight = -Infinity;
            for (let i = 0; i < all.length; i++) {
              const r = all[i].getBoundingClientRect();
              if (r.width < 1 || r.height < 1) continue;
              if (r.right < sr.left + 1 || r.left > sr.right - 1) continue;
              if (r.right > bestRight) { bestRight = r.right; startIdx = i; }
            }
          }
        }
      } catch (_) {}
      if (startIdx < 0) {
        const act = el.querySelector('.reading-chunk.active');
        startIdx = act ? all.indexOf(act) : -1;
      }
      if (startIdx < 0) {
        const ci = Number.isFinite(window.currentCardIndex) ? window.currentCardIndex : -1;
        const mapped = (ci >= 0 && pagedCueToChunk && ci < pagedCueToChunk.length) ? pagedCueToChunk[ci] : -1;
        if (mapped != null && mapped >= 0) startIdx = mapped;
      }
      if (startIdx < 0) startIdx = 0;
      const budget = Math.max(1, charBudget | 0);
      let chars = 0, endIdx = startIdx;
      for (let i = startIdx; i < all.length; i++) {
        endIdx = i;
        chars += _chunkBaseLen(all[i]);
        if (chars >= budget) break;
      }
      // Per-chunk list (inner HTML with ruby + base-text length + a
      // paragraph-boundary flag) so the print layout can pack chunks into
      // side-by-side vertical half-pages and preserve paragraph breaks.
      const blockOf = (el) => el.closest('p,div,li,blockquote,h1,h2,h3,h4,h5,h6,section,article') || el.parentElement;
      // The cue a chunk belongs to (forward-nearest mapped cue), so the print
      // layout can advance the playhead to the LAST cue it actually placed.
      const cueForChunk = (gi) => {
        if (!pagedChunkToCue || !Array.isArray(pagedChunkToCue)) return null;
        for (let k = gi; k < pagedChunkToCue.length; k++) if (pagedChunkToCue[k] >= 0) return pagedChunkToCue[k];
        for (let k = Math.min(gi, pagedChunkToCue.length - 1); k >= 0; k--) if (pagedChunkToCue[k] >= 0) return pagedChunkToCue[k];
        return null;
      };
      const chunks = [];
      let prevBlock = null;
      for (let i = startIdx; i <= endIdx; i++) {
        const cel = all[i];
        const blk = blockOf(cel);
        chunks.push({
          html: cel.innerHTML, len: _chunkBaseLen(cel), para: blk !== prevBlock, cue: cueForChunk(i),
          charOffset: parseInt(cel.dataset.charOffset) || 0,
          charLen: parseInt(cel.dataset.charLen) || _chunkBaseLen(cel)
        });
        prevBlock = blk;
      }
      const range = document.createRange();
      range.setStartBefore(all[startIdx]);
      range.setEndAfter(all[endIdx]);
      const holder = document.createElement('div');
      holder.appendChild(range.cloneContents());
      let endCue = null;
      if (pagedChunkToCue && Array.isArray(pagedChunkToCue)) {
        for (let i = endIdx; i < pagedChunkToCue.length; i++) {
          if (pagedChunkToCue[i] != null && pagedChunkToCue[i] >= 0) { endCue = pagedChunkToCue[i]; break; }
        }
        if (endCue == null) {
          for (let i = Math.min(endIdx, pagedChunkToCue.length - 1); i >= 0; i--) {
            if (pagedChunkToCue[i] != null && pagedChunkToCue[i] >= 0) { endCue = pagedChunkToCue[i]; break; }
          }
        }
      }
      return { html: holder.innerHTML, chunks, endCue, chars };
    } catch (e) { console.warn('[print] getReadingSegment failed:', e?.message || e); return null; }
  };
  // Externally callable from card / audio mode so the progress strip
  // tracks the current playhead even when the reader view is hidden.
  window.pagedUpdateProgressForCue = function (cueIdx) {
    try { updateProgress({ cueIdx }); } catch (_) {}
  };
  // Public hook so card-only mode (Anki deck loaded, no EPUB, no
  // audiobook) can still see the top-left "N / total" counter without
  // ever opening the reader. Without this the strip was created lazily
  // inside the first openView() call — so Anki-only users got NO strip
  // at all. This idempotently creates the strip DOM and triggers an
  // initial paint based on the current mode.
  window.pagedEnsureProgressStrip = function () {
    try {
      // CRITICAL: the strip's CSS (position:fixed, z-index:9001, top, left)
      // lives inside the paged-reader stylesheet that ensureView() injects.
      // When this hook is the FIRST entry into the paged reader (Anki-only
      // titles never call openView/ensureView), the stylesheet wasn't yet
      // in the DOM, so the bare <div> rendered inline with browser defaults
      // — visually nowhere. Inject the stylesheet first.
      ensureStylesheet();
      ensureProgressStrip();
      updateProgress();
    } catch (_) {}
  };

  // Wait for the vertical-rl layout to settle. iOS WKWebView frequently
  // needs more than the canonical "2 RAFs" before innerEl has a real
  // scrollWidth — especially for big EPUBs with many sections. Polls
  // until scrollWidth exceeds clientWidth (i.e. content has overflowed
  // horizontally as expected) or the timeout elapses.
  async function _waitForPagedLayout(maxMs) {
    const start = Date.now();
    while (Date.now() - start < (maxMs || 2000)) {
      if (scrollEl && innerEl &&
          scrollEl.scrollWidth > scrollEl.clientWidth + 10) {
        return true;
      }
      await new Promise(r => requestAnimationFrame(r));
    }
    return false;
  }

  // Silently load + lay out + center the reader at app boot, while the
  // user is still in card mode. The "blank reader on first switch"
  // symptom traces back to: chunks land in DOM, but layout hasn't
  // settled when openView's setTimeout fires recompute/centerOnActiveCard
  // — so scrollLeft ends up at a position that points at empty space.
  // Playing a card through reliably fixed it because the audio cue
  // events kept re-triggering scroll long after layout had stabilized.
  // The prewarm does the same work up front: visibility:hidden + no
  // pointer events while we mount, lay out, recompute, and position.
  // User stays in card mode the whole time.
  // Override the legacy reading-mode.js's prewarmReader so the existing
  // app.js call sites (autoRestoreFromTitles) trigger the paged reader's
  // silent layout-warm instead of the now-deprecated legacy parser.
  // Defer the override until the IIFE finishes — at module-load time the
  // legacy prewarmReader hasn't been assigned yet (reading-mode.js runs
  // its IIFE, then this file's IIFE; both export window functions during
  // their respective inits).
  setTimeout(() => {
    if (typeof window.pagedPrewarm === 'function') {
      window.prewarmReader = window.pagedPrewarm;
      log('window.prewarmReader → pagedPrewarm');
    }
  }, 0);

  window.pagedPrewarm = async function () {
    if (window._pagedPrewarmInFlight || window._pagedPrewarmDone) return;
    // If we're ALREADY in read mode, openView owns the visible load. Prewarm
    // would set visibility:hidden on the live reader AND kick a second
    // concurrent EPUB load — that's the black-screen-on-open-to-read race.
    // Skip; openView handles the load + paint. (Prewarm is only useful to
    // preload while in another mode for a later switch into read.)
    if (document.body.classList.contains('mode-read')) return;
    window._pagedPrewarmInFlight = true;
    try {
      ensureView();
      // Render-but-don't-paint: visibility:hidden so layout computes,
      // pointer-events:none so any touch the user makes goes straight
      // through to whatever's behind. Stays "display:flex" the whole
      // time so we don't trigger another layout pass on the way out.
      const prevDisplay    = viewEl.style.display;
      const prevVisibility = viewEl.style.visibility;
      const prevPointer    = viewEl.style.pointerEvents;
      viewEl.style.visibility = 'hidden';
      viewEl.style.pointerEvents = 'none';
      viewEl.style.display = 'flex';
      try {
        const loaded = await tryLoadFromActiveTitle();
        if (document.body.classList.contains('mode-read')) {
          // The user switched INTO read while we were loading — openView now
          // owns the live view (its own load + entry scroll). Don't run our
          // center/recompute too: two concurrent entry scrolls fight and land
          // the reader off-position. Yield; the finally leaves it revealed.
          log('prewarm: entered read mid-load — yielding to openView');
        } else if (innerEl.querySelector('.reading-chunk')) {
          // Wait for vertical-rl layout to materialize. Without this,
          // recompute reads scrollWidth=0 and centerOnActiveCard does
          // nothing useful.
          await _waitForPagedLayout(2500);
          recompute();
          centerOnActiveCard();
          try { await loadAudiobookCues(); } catch (_) {}
          try { attachBgListener(); } catch (_) {}
          // Persist the centered position so the FIRST visible openView
          // restores it deterministically. ONLY for card-bearing titles —
          // for EPUB-only there's no card, so scrollLeft here may still be the
          // snapped-to-0 value (centerOnActiveCard → restoreReadScrollIfNoCard
          // re-applies the real position asynchronously); saving now would
          // clobber the user's saved spot back to 0.
          try {
            if (currentName && Array.isArray(window.allNotes) && window.allNotes.length) {
              setPref(KEY_LAST_SCROLL_PREFIX + currentName, scrollEl.scrollLeft);
            }
          } catch (_) {}
          log('prewarm complete (chunks=' + chunks.length + ' scrollLeft=' + scrollEl.scrollLeft + ')');
        } else {
          log('prewarm: no chunks after tryLoadFromActiveTitle (no EPUB attached?)');
        }
      } finally {
        // If the user switched INTO read mode while this prewarm was loading,
        // openView already revealed the live reader (visibility:visible). Do
        // NOT restore the stale "hidden" we captured before — that would yank
        // the now-live reader back, and the 800ms DOM-resync would read the
        // hidden view as 'card' and dump the user out of read at the last
        // second. Only restore the hidden state if we're still in another mode.
        if (!document.body.classList.contains('mode-read')) {
          viewEl.style.display = prevDisplay || 'flex';
          viewEl.style.visibility = prevVisibility || 'hidden';
          viewEl.style.pointerEvents = prevPointer || '';
        }
      }
      window._pagedPrewarmDone = true;
    } catch (e) {
      log('prewarm error:', e?.message || e);
    } finally {
      window._pagedPrewarmInFlight = false;
    }
  };

  // caretRangeFromPoint snaps to the nearest character BOUNDARY (the gap between
  // glyphs), so a tap past a glyph's midpoint returns the NEXT boundary — which
  // would start the word one character too far IN THE READING DIRECTION ("misses
  // the first letter"; device-dependent because Android WebViews round
  // differently; direction-dependent: users had to tap higher in tategaki / left
  // in yokogaki to compensate). Refine the caret offset to the character whose
  // ACTUAL glyph box contains the tap, so it's correct in both writing modes and
  // on every device. Only ever corrects toward the char under the finger (or
  // no-ops where the caret was already right) — never regresses a working tap.
  function refineCharOffset(node, offset, x, y) {
    try {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      const hit = (s, e) => {
        if (s < 0 || e > len || s >= e) return false;
        const r = document.createRange();
        r.setStart(node, s); r.setEnd(node, e);
        const rects = r.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const rc = rects[i];
          if (x >= rc.left - 0.5 && x <= rc.right + 0.5 &&
              y >= rc.top - 0.5 && y <= rc.bottom + 0.5) return true;
        }
        return false;
      };
      if (hit(offset, offset + 1)) return offset;       // tap is over the char at the caret → keep
      if (hit(offset - 1, offset)) return offset - 1;   // tap is over the PREVIOUS char (boundary snapped forward)
    } catch (_) {}
    return offset;                                       // gap/edge → trust the caret unchanged
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
    // Correct the half-character boundary snap so the word starts on the glyph
    // actually under the finger (the "misses the first letter" fix).
    offset = refineCharOffset(node, offset, x, y);
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

    // Stash the chunk DOM node so positionDictPopup can fall back to
    // its bounding rect when Range-based lookup fails on iOS WKWebView.
    try { window._dictLookupChunk = chunk; } catch (_) {}

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
        // Stash the Range itself so the dict popup positioner can
        // read its bounding rect directly — iterating a Highlight
        // object on iOS WKWebView is unreliable across versions, so
        // we cache the source Range globally and the positioner
        // reads from here first.
        window._dictLookupRange = r;
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

  // Plain-text book → reader HTML. Each non-blank line becomes a paragraph
  // (chunk). Aozora-Bunko ruby (漢字《かんじ》 or ｜base《reading》) is converted
  // to <ruby>, and ［＃…］ editor annotations are stripped. A plain .txt with no
  // Aozora markup just gets one <p> per line.
  function _txtToReaderHtml(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = String(text || '').replace(/﻿/g, '').replace(/\r\n?/g, '\n').split('\n');
    const ps = [];
    for (let line of lines) {
      line = line.replace(/［＃[^］]*］/g, '');     // strip Aozora annotations
      const t = line.trim();
      if (!t) continue;
      let h = esc(t);
      // Aozora furigana: explicit ｜base《reading》 first, then bare 漢字《reading》.
      h = h.replace(/｜([^《》｜\n]+)《([^《》\n]+)》/g, '<ruby>$1<rt>$2</rt></ruby>');
      h = h.replace(/([一-鿿々〆ヶ々]+)《([^《》\n]+)》/g, '<ruby>$1<rt>$2</rt></ruby>');
      ps.push('<p>' + h + '</p>');
    }
    if (!ps.length) ps.push('<p style="color:#888;text-align:center;margin-top:30vh;">(empty text file)</p>');
    return ps.join('\n');
  }

  async function loadEpubFromUri(uri, name) {
    try {
      ensureView();
      // Snapshot the OUTGOING book's freshest line FIRST — before any reset or
      // DOM swap — so a same-mode A→B title-open (which does NOT fire a
      // mode-change flush) still persists A's exact line under A's key.
      // currentName + chunks + the DOM all still reflect the outgoing book here.
      // Internally guarded (read-mode + view-visible + not-mid-restore), and a
      // no-op on the very first open when there is no outgoing book.
      try { _saveBookmarkNow(); } catch (_) {}
      // Reset per-book position state IMMEDIATELY — before any DOM swap — so
      // nothing reads a CROSS-BOOK stale bookmark index, or fires the prior
      // book's settle timer against this one (the title-flip place-loss). The
      // real value for THIS book is loaded from its pref further down.
      _bookmarkChunkIdx = -1;
      _lastToastedBookmarkIdx = -2;
      _clearBookmarkTimer();
      innerEl.innerHTML = `<p style="color:#888;text-align:center;margin-top:30vh;">Loading ${name}…</p>`;

      const { path } = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri });
      const response = await fetch(window.Capacitor.convertFileSrc(path));
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      // A plain-text book (.txt) is read directly into paragraphs; EPUBs are
      // unzipped + spine-walked. Detect by the attachment name / uri extension.
      const _isTxt = /\.txt$/i.test(name || '') || /\.txt$/i.test(String(uri || ''));
      let sectionCount = 0;
      if (_isTxt) {
        innerEl.innerHTML = _txtToReaderHtml(await response.text());
        sectionCount = 1;
      } else {
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
        sectionCount = sections.length;
      }

      // Tag block-level descendants as .reading-chunk for dict / scroll-snap.
      // Also accumulate per-chunk char offsets for the bottom progress
      // indicator (treat ruby <rt>/<rp> as zero-cost — count base text only).
      let chunkCount = 0;
      let charAcc = 0;
      let jpAcc = 0;
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
        const len = txt.length;                                       // RAW: flat-text coordinate
        const jpLen = window.jpCharCount ? window.jpCharCount(txt) : len; // JP-only: display
        el.dataset.charOffset = String(charAcc);
        el.dataset.charLen = String(len);
        el.dataset.jpOff = String(jpAcc);
        el.dataset.jpLen = String(jpLen);
        charAcc += len;
        jpAcc += jpLen;
        chunkCount++;
      });
      totalChars = charAcc;       // raw coordinate space (cue alignment / highlight)
      totalJpChars = jpAcc;       // displayed total — matches ttu / desktop reader

      const isFreshBookLoad = currentName !== name;
      currentName = name;
      if (isFreshBookLoad) pagedInitialScrollDone = false;
      // Re-anchor the read char baseline to THIS book. maxCharOffsetSeen is a
      // single GLOBAL high-water mark but is semantically a per-book char offset
      // — without re-anchoring, a high-water left by a DEEPER book (or a prior
      // session, since it's persisted to localStorage) sits above every offset
      // in this book, so noteReadPosition credits NOTHING and the read counter
      // sticks at 0. rebaselineRead only clears baselineSet (the accumulated
      // chars total is preserved); the next settle silently re-anchors to the
      // reopen line, after which forward reading accrues normally.
      if (isFreshBookLoad) { try { window.stats?.rebaselineRead?.(); } catch (_) {} }
      log(`Loaded ${name}: ${sectionCount} sections, ${chunkCount} chunks`);

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

      // Restore THIS book's saved scroll position. The key is per-book
      // (KEY_LAST_SCROLL_PREFIX + name), so it's always the right book's spot —
      // the old `savedName === name` gate only restored when this was ALSO the
      // globally last-opened book, so an EPUB-only title silently lost its
      // position the moment any other title was opened in between. (This is the
      // "position isn't saved for EPUB-only" bug.) A never-opened book has no
      // key → resumeLeft stays 0 → starts at the beginning.
      let resumeLeft = 0;
      const sl = parseFloat(await getPref(KEY_LAST_SCROLL_PREFIX + name) || '0');
      if (Number.isFinite(sl)) resumeLeft = sl;
      savedReadScrollLeft = resumeLeft; // raw-scroll fallback for restoreReadScrollIfNoCard
      // Bookmark = the LINE you were on → engine-agnostic, line-exact reopen.
      const _bmRaw = await getPref(KEY_BOOKMARK_PREFIX + name);
      const _bmIdx = (_bmRaw != null && _bmRaw !== '') ? parseInt(_bmRaw) : -1;
      _bookmarkChunkIdx = (Number.isFinite(_bmIdx) && _bmIdx >= 0) ? _bmIdx : -1;
      _lastToastedBookmarkIdx = -2; // a fresh open may toast again on first settle
      await setPref(KEY_LAST_NAME, name);
      suppressScrollSave = true;
      lastProgrammaticScrollTime = Date.now(); // this restore is not "reading"
      // Wait for vertical-rl layout to settle so the bookmark chunk has a real
      // rect — 2 RAFs is NOT enough on a cold WKWebView open, and the relative
      // scroll silently no-ops on a zero-width rect (without this the book could
      // sit at 0 with no retry).
      try { await _waitForPagedLayout(2500); } catch (_) {}
      let _restored = false;
      if (_bookmarkChunkIdx >= 0 && _bookmarkChunkIdx < chunks.length) {
        const _ch = chunks[_bookmarkChunkIdx];
        if ((_ch.getBoundingClientRect().width || 0) > 0) {
          // Relative scrollBy off the chunk's rect — no scrollWidth/raw-scrollLeft
          // dependency, so it lands the same LINE on WKWebView and Chromium.
          // allowFarJump: a deep bookmark in a long book is a legit huge delta.
          try { scrollChunkNearRightWithContext(_ch, 3, { allowFarJump: true }); _restored = true; } catch (_) {}
        }
      }
      if (!_restored) {
        scrollEl.scrollTo({ left: resumeLeft, behavior: 'instant' }); // no/late bookmark → raw fallback
      }
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
    // Already loaded + mapped for THIS title against the CURRENT chunk layout?
    // Skip the SRT re-fetch + re-parse (~10k cues) + alignment rebuild. This runs
    // on EVERY read-entry / mode switch, and re-parsing+re-mapping each time was a
    // major chunk of the mode-switch lag. The map-length check vs the current
    // chunks invalidates the cache after a relayout (e.g. font-size change), so a
    // stale map can never mis-highlight; otherwise the maps stay valid (same title
    // → same chunks → same indices) and the read cursor is preserved.
    if (window._activeTitleId && window._activeTitleId === window._pagedCuesTitleId &&
        pagedCues.length > 0 && pagedChunkToCue && Array.isArray(chunks) &&
        pagedChunkToCue.length === chunks.length) {
      return true;
    }
    pagedCues = []; pagedCueToChunk = null; pagedChunkToCue = null; pagedAudioPath = null;
    window._pagedAudioPath = null; // expose for read-mode PLAY (toggleReadingPlayback)
    pagedCueMapFromAlignment = false;
    // Drop the stale read-cue ONLY when the title actually changed. Preserving
    // it across a same-title reload (mode round-trips, re-open) keeps the user's
    // read place instead of resetting the cursor to -1 on every cue (re)load —
    // which was the structural reason the read anchor kept vanishing.
    if (!window._activeTitleId || window._activeTitleId !== window._pagedCuesTitleId) {
      lastReadCueIdx = -1;
    }
    window._pagedCuesTitleId = window._activeTitleId || null;
    if (!window.srtParser?.parseSrt) { log('srtParser missing'); return false; }

    // Get audio + SRT paths. Try title-store first (newer), fall back to
    // deck-based legacy pairings.
    let audio = null, srt = null;
    let activeTitle = null;
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        activeTitle = titles.find(x => x.id === window._activeTitleId) || null;
        // Materialize lazy {uri} attachments to cachePath, then read the
        // CORRECT schema fields (audiobook.cachePath / srt.cachePath — the
        // earlier `attachments.audio.path` never matched the stored shape,
        // so the title branch silently fell through to legacy prefs).
        if (activeTitle && typeof window.rehydrateTitleCachePaths === 'function') {
          activeTitle = await window.rehydrateTitleCachePaths(activeTitle) || activeTitle;
        }
        const t = activeTitle;
        if (t?.attachments?.audiobook?.cachePath) audio = { path: t.attachments.audiobook.cachePath, name: t.attachments.audiobook.name };
        if (t?.attachments?.srt?.cachePath)       srt   = { path: t.attachments.srt.cachePath,       name: t.attachments.srt.name };
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
    if (!audio || !srt) {
      log('No audio/srt context for paged reader');
      // Wipe the stale LEGACY audiobook context ONLY for a GENUINELY EPUB-only
      // title (epub + NO audiobook/audio/srt/deck attachment). `!audio||!srt`
      // here only means the PAGED resolver couldn't find audio — for an
      // "enriched" title whose audio the LEGACY reader loaded but this resolver
      // missed (older pairing / timing), we must KEEP __abCues, else its
      // Set-playhead + cue highlight vanish. The leak that clearing fixes (stale
      // cues bleeding into an EPUB-only book) only happens for true EPUB-only
      // titles, so scope the clear to exactly those.
      const at = activeTitle && activeTitle.attachments;
      const epubOnly = !!at && !!at.epub && !at.audiobook && !at.audio && !at.srt && !at.deck;
      if (epubOnly) { try { window._clearLegacyAudioContext?.(); } catch (_) {} }
      return false;
    }
    pagedAudioPath = audio.path;
    window._pagedAudioPath = audio.path; // the visible reader's CURRENT-title audiobook

    try {
      const url = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(srt.path) : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch SRT ${res.status}`);
      const text = await res.text();
      pagedCues = window.srtParser.parseSrt(text);
      log(`Loaded ${pagedCues.length} SRT cues for paged reader`);
    } catch (e) { log('SRT load failed:', e.message); return false; }

    // Build cue→chunk mapping. Preferred path: the new preprocessing
    // module (cue-alignment.js) builds a stable cue→char-range
    // alignment via forward-cursor + bounded-window match, caches it
    // per title, and we derive a local cue→chunk by looking up each
    // cue's char range against chunk `dataset.charOffset`. Fallback:
    // srtParser.buildCueChunkMaps (the old in-line matcher) if the
    // module is missing or returns a suspiciously low match rate.
    // dataset.norm is still populated because findChunkForText and the
    // dict tap-handler search rely on it.
    for (const c of chunks) c.dataset.norm = normalizeJP(c.textContent);
    if (!chunks.length || !pagedCues.length) return true;

    let used = 'none';
    let freshAlignment = false; // true → this run computed a fresh alignment (not cached)
    if (window.cueAlignment?.loadOrBuild) {
      // Peek for a cached alignment first so we only show the blocking
      // overlay when we actually have to run the matcher. The check
      // mirrors loadOrBuild's fingerprint logic; on cache hit, no UI.
      let progress = null;
      try {
        const titleId = window._activeTitleId || null;
        const epubName = currentName || '';
        const srtName  = srt?.name || '';
        const peekFp = window.cueAlignment.computeFingerprint({
          epubName, srtName,
          cueCount: pagedCues.length,
          totalChars: window.cueAlignment.extractFlatText(chunks).length
        });
        const peekHit = titleId
          ? await window.cueAlignment.loadAlignment(titleId, peekFp)
          : null;
        if (!peekHit && window.cueAlignment.showProgress) {
          progress = window.cueAlignment.showProgress({
            title: 'Preparing book',
            sub:   'Aligning subtitles to text…'
          });
        }
        const t0 = performance.now();
        const { alignment, cached } =
          await window.cueAlignment.loadOrBuild({
            titleId, epubName, srtName, chunks, cues: pagedCues,
            onProgress: progress ? (p) => progress.update(p) : null
          });
        const dt = Math.round(performance.now() - t0);
        const ratio = alignment.matchedRatio;
        freshAlignment = !cached;
        log(`Paged alignment: ${alignment.matched}/${alignment.cueCount}` +
            ` (ratio=${ratio.toFixed(2)}, ${cached ? 'cache' : 'fresh'}, ${dt}ms)`);
        if (ratio >= window.cueAlignment.MIN_MATCHED_RATIO) {
          const maps = window.cueAlignment.buildCueToChunk(alignment, chunks);
          pagedCueToChunk = maps.cueToChunk;
          pagedChunkToCue = maps.chunkToCue;
          pagedCueMapFromAlignment = true;
          used = cached ? 'align-cache' : 'align-fresh';
        } else {
          log(`Paged alignment ratio too low (${ratio.toFixed(2)} < ${window.cueAlignment.MIN_MATCHED_RATIO}); falling back to legacy matcher`);
          try { await window.cueAlignment.clearAlignment(titleId); } catch (e) {}
        }
      } catch (e) {
        log('Paged alignment error; falling back:', e.message);
      } finally {
        if (progress) { try { progress.close(); } catch (e) {} }
      }
    }
    if (used === 'none' && window.srtParser?.buildCueChunkMaps) {
      const maps = window.srtParser.buildCueChunkMaps(pagedCues, chunks, normalizeJP);
      pagedCueToChunk = maps.cueToChunk;
      let matched = 0;
      for (let i = 0; i < pagedCueToChunk.length; i++) if (pagedCueToChunk[i] >= 0) matched++;
      log(`Paged cue→chunk (legacy fallback): ${matched}/${pagedCues.length} mapped`);
      used = 'legacy';
    }
    log(`Paged matcher used: ${used}`);

    // Initial-position jump for fresh book loads. Without this, opening
    // a never-seen-before title parks the reader at scrollLeft=0 which
    // for most EPUBs is cover / copyright / TOC — looks blank until the
    // user advances a card and triggers a sync. With this, the first
    // matched chunk (i.e., where the audiobook actually starts in the
    // text) becomes the reader's starting view, so the user sees real
    // content immediately. Only runs once per book, only when no saved
    // scroll position exists, only when we have a trustworthy alignment
    // map to consult. See [[reference-cue-alignment]].
    if (pagedCueMapFromAlignment && !pagedInitialScrollDone &&
        scrollEl && Math.abs(scrollEl.scrollLeft || 0) < 5) {
      let targetChunk = null;
      const cardIdx = window.currentCardIndex;
      if (Number.isFinite(cardIdx) && pagedCueToChunk &&
          pagedCueToChunk[cardIdx] >= 0) {
        targetChunk = chunks[pagedCueToChunk[cardIdx]] || null;
      }
      if (!targetChunk && pagedCueToChunk) {
        const startFrom = Math.max(0, cardIdx | 0);
        for (let i = startFrom; i < pagedCueToChunk.length; i++) {
          if (pagedCueToChunk[i] >= 0) { targetChunk = chunks[pagedCueToChunk[i]]; break; }
        }
      }
      if (!targetChunk && pagedCueToChunk) {
        for (let i = 0; i < pagedCueToChunk.length; i++) {
          if (pagedCueToChunk[i] >= 0) { targetChunk = chunks[pagedCueToChunk[i]]; break; }
        }
      }
      if (targetChunk) {
        log('Initial scroll: jumping to first matched chunk');
        lastProgrammaticScrollTime = Date.now();
        try { scrollChunkIntoView(targetChunk); } catch (e) {}
      }
      pagedInitialScrollDone = true;
    }
    // ALWAYS re-paint the active-card highlight after alignment is
    // ready, regardless of whether we did the initial-position jump.
    // The first centerOnActiveCard call in openView's setTimeout ran
    // BEFORE the alignment was built, so it had to fall back to
    // findChunkForText (which fails on short common card text). Now
    // that pagedCueToChunk is populated, re-running centerOnActiveCard
    // uses the reliable alignment-map path and paints the highlight
    // even on a non-fresh reader open. Without this, the user has to
    // wait for the first audio cue to fire before seeing any reader
    // highlight at all.
    try { centerOnActiveCard(); } catch (e) {}
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
    if (_readerCueHlGuarded(idx)) return;   // post-swipe: hold the swiped-to green until the playhead arrives
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
    try { window._clearCueRubyColor && window._clearCueRubyColor(); } catch (e) {}
    document.body.classList.remove('has-cue-highlight');
  }

  function paintCueHighlight(cueIdx) {
    const cue = pagedCues[cueIdx];
    if (!cue?.text) return;
    // Try the pre-built cue→chunk map first; fall back to live text
    // search if the map missed (e.g. buildCueChunkMaps' forward-cursor
    // skipped past a chunk, or the map wasn't fully populated when this
    // event fired).
    const chunk = resolveCueChunk(cueIdx, cue.text, !pagedCueMapFromAlignment);
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
    const normCue = normalizeJP(cueText);
    if (!normCue) { clearCueHighlight(); return; }
    // Collect text nodes (skipping ruby rt/rp) from `chunk`, EXTENDING into
    // following sibling chunks when the cue text straddles a paragraph
    // boundary. The cue→chunk map anchors a cue to the chunk holding its
    // FIRST char; SRT cues are segmented independently of paragraph breaks,
    // so a cue can continue into the next chunk and be only HALF-present in
    // the anchor chunk. A single-chunk indexOf would then miss → clear →
    // white text (the "no green / skips a line" bug, on enter AND during
    // live audio-follow). Walking consecutive chunks reconstructs the same
    // flat text the alignment matched against, so the Range can span the
    // break (CSS Custom Highlights paint across block elements). Capped so a
    // genuinely-absent cue can't walk the whole book.
    const startIdx = chunks.indexOf(chunk);
    const MAX_SPAN_CHUNKS = 4;
    const textNodes = [];
    let flat = '';
    const collectChunk = (c) => {
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          let p = n.parentNode;
          while (p && p !== c) {
            if (p.tagName === 'RT' || p.tagName === 'RP') return NodeFilter.FILTER_REJECT;
            p = p.parentNode;
          }
          return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let n;
      while ((n = walker.nextNode())) { textNodes.push(n); flat += n.nodeValue; }
    };
    let normStart = -1;
    const maxIdx = (startIdx >= 0) ? Math.min(chunks.length - 1, startIdx + MAX_SPAN_CHUNKS) : -1;
    let ci = startIdx;
    // Collect the anchor chunk first; extend forward ONLY while the cue text
    // isn't yet fully contained. A cue that fits one chunk matches on the
    // first iteration and never touches its neighbours (identical to before).
    do {
      collectChunk((startIdx >= 0) ? chunks[ci] : chunk);
      normStart = normalizeJP(flat).indexOf(normCue);
      ci++;
    } while (normStart < 0 && startIdx >= 0 && ci <= maxIdx);
    if (!flat) return;
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
      // iOS: ::highlight color doesn't reach the kanji BASE of <ruby>, only the
      // furigana — color the active cue's ruby elements directly (no DOM mutation).
      try { window._applyCueRubyColor && window._applyCueRubyColor(r, chunk); } catch (_) {}
      document.body.classList.add('has-cue-highlight');
      // Remember which chunk is green — anchors the bounded local search.
      lastHighlightedChunkIdx = chunks.indexOf(chunk);
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
    //
    // CRITICAL: exclude the edge MASKS from the visible region. A cue that has
    // advanced under the left mask is geometrically on-screen (rangeRect.left >=
    // sr.left) but VISUALLY BLACKED OUT — without this the narrator reads a line
    // that's never shown. Treating the masked strip as off-screen makes the page
    // turn the instant the cue reaches it, re-justifying that line to the clean
    // reading edge. (_maskLW/_maskRW are 0 when masks are off.)
    const visLeft = sr.left + (_maskLW || 0);
    const visRight = sr.right - (_maskRW || 0);
    const fullyVisible = rangeRect.left >= visLeft && rangeRect.right <= visRight;
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
    log('[scroll-trace] scrollBy delta=' + Math.round(delta));
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
  let _epubLoadPromise = null;   // in-flight load, to coalesce concurrent callers
  let _epubLoadTitleId = null;
  async function tryLoadFromActiveTitle() {
    if (!window.titleStore || !window._activeTitleId) return false;
    // Don't reload the same book we already have.
    if (window._activeTitleId === currentTitleId &&
        innerEl.querySelector('.reading-chunk')) return false;
    const titleId = window._activeTitleId;
    // COALESCE concurrent loads. openView (visible load when restoring straight
    // into read mode) and pagedPrewarm (hidden preload) both fire on the same
    // title open; two concurrent loadEpubFromUri calls race on innerEl.innerHTML
    // → corrupted/empty render → BLACK reader. Reuse the in-flight load instead.
    // _epubLoadPromise is assigned SYNCHRONOUSLY (before any await) so the second
    // caller always sees it.
    if (_epubLoadPromise && _epubLoadTitleId === titleId) return _epubLoadPromise;
    _epubLoadTitleId = titleId;
    _epubLoadPromise = (async () => {
      try {
        const titles = await window.titleStore.list();
        const t = titles.find(x => x.id === titleId);
        const ep = t?.attachments?.epub;
        if (!ep?.uri || !ep?.name) return false;
        currentTitleId = titleId;
        log(`Auto-load from active title: ${ep.name}`);
        await loadEpubFromUri(ep.uri, ep.name);
        return true;
      } catch (e) {
        log('tryLoadFromActiveTitle error: ' + (e?.message || e));
        return false;
      } finally {
        _epubLoadPromise = null;
        _epubLoadTitleId = null;
      }
    })();
    return _epubLoadPromise;
  }

  // ---- Reader-entry cover (Workstream C, step 1) ----
  // An opaque panel (matching the reader's own #000 bg) held over the reader
  // while it loads + scrolls to position on ENTRY, then faded out once the
  // position is settled — so the user never sees the entry scroll. It's a CHILD
  // of the reader, so it's automatically hidden whenever the reader is (leaving
  // read mode needs no extra handling). Live audio-follow happens AFTER the
  // cover lifts, so the green-line tracking stays visible, as intended.
  let _readerCover = null;
  let _readerCoverHideT = null;
  let _readerDotsT = null;
  function _ensureReaderCover() {
    if (_readerCover && _readerCover.isConnected) return _readerCover;
    if (!viewEl) ensureView();
    _readerCover = document.createElement('div');
    _readerCover.id = 'readerEnterCover';
    Object.assign(_readerCover.style, {
      position: 'absolute', inset: '0',
      background: '#000', zIndex: '50',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: '0', pointerEvents: 'none',
      transition: 'opacity .18s ease'
    });
    // Pulsing dots — shown only if the cover lingers (slow load), so a fast
    // mode switch doesn't flash them. Styled in theme.css (#readerEnterCover).
    _readerCover.innerHTML =
      '<div class="rc-dots" style="display:flex;gap:9px;opacity:0;transition:opacity .3s ease;">' +
      '<span class="rc-dot"></span><span class="rc-dot"></span><span class="rc-dot"></span></div>';
    viewEl.appendChild(_readerCover);
    return _readerCover;
  }
  window.showReaderCover = function () {
    const c = _ensureReaderCover();
    if (_readerCoverHideT) { clearTimeout(_readerCoverHideT); _readerCoverHideT = null; }
    if (_readerDotsT) { clearTimeout(_readerDotsT); _readerDotsT = null; }
    c.style.transition = 'none';
    c.style.opacity = '1';
    void c.offsetWidth;                 // commit the opaque state before any fade
    c.style.transition = 'opacity .18s ease';
    const dots = c.querySelector('.rc-dots');
    if (dots) dots.style.opacity = '0';
    _readerDotsT = setTimeout(() => { if (dots) dots.style.opacity = '1'; }, 180);
    // Safety: never leave the cover up — reveal after a bounded wait even if the
    // settle signal never fires (position is best-effort by then).
    _readerCoverHideT = setTimeout(() => { try { window.hideReaderCover(); } catch (_) {} }, 4000);
  };
  window.hideReaderCover = function () {
    // The reader entry has settled (entry scroll painted, or the 4s safety) —
    // lift the boot cover too. No-op after the first reveal. Tying it here
    // means ANY path that ends the reader entry also reveals the app, so a
    // read-mode cold boot goes spinner → settled reader with no flash.
    try { window.revealApp && window.revealApp(); } catch (_) {}
    if (!_readerCover) return;
    if (_readerCoverHideT) { clearTimeout(_readerCoverHideT); _readerCoverHideT = null; }
    if (_readerDotsT) { clearTimeout(_readerDotsT); _readerDotsT = null; }
    _readerCover.style.opacity = '0';
    const dots = _readerCover.querySelector('.rc-dots');
    if (dots) dots.style.opacity = '0';
  };
  // Fade the cover out AFTER the entry scroll has actually painted (2 rAF).
  function _revealReaderSettled() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { window.hideReaderCover(); } catch (_) {}
    }));
  }

  async function openView() {
    ensureView();
    window.showReaderCover();               // cover BEFORE reveal — entry scroll happens behind it
    viewEl.style.display = 'flex';
    viewEl.style.visibility = 'visible';   // reveal (layout already computed → no re-layout)
    viewEl.style.pointerEvents = 'auto';
    document.body.classList.add('has-paged-progress');
    positionPlayheadBtn();
    setTimeout(positionPlayheadBtn, 200);
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

    // Run the cue-load + green-highlight setup once the EPUB chunks are
    // actually in the DOM. THE COLD-OPEN BUG: on "switch to read immediately
    // after opening a title", loadEpubFromUri can still be rendering chunks
    // when we reach here — a one-shot `if (.reading-chunk)` check would then
    // skip the ENTIRE setup and leave the reader unmarked until the user plays
    // a card (which warms the shared state, masking the race). Poll for the
    // chunks first, then retry the paint until it lands.
    let _openWaited = 0;
    const runReaderEnterSetup = async () => {
      if (_readerHidden()) return;       // left read mode
      if (!innerEl.querySelector('.reading-chunk')) {
        if (_openWaited < 4000) { _openWaited += 80; setTimeout(runReaderEnterSetup, 80); }
        return;
      }
      // Snapshot + CONSUME the card→read signal now, so it can never leak into a
      // later title-open (which must still land on the M1 bookmark).
      const _cameFromCardEntry = Number.isFinite(window._reentryCardCueIdx) && window._reentryCardCueIdx >= 0;
      window._reentryCardCueIdx = null;
      recompute();
      centerOnActiveCard();
      _scheduleEdgeMask(); // paint the leftover-column mask now that content is laid out
      await loadAudiobookCues();
      attachBgListener();
      if (_readerHidden()) return;       // bailed during await
      lastUserScrollTime = 0; // deliberate enter → always allow centering
      const jumpCue = window._reentryAudioJumpCueIdx;
      window._reentryAudioJumpCueIdx = null;
      // "Stay at read position" captures the read cue at dialog time (before
      // this function's loadAudiobookCues wipes lastReadCueIdx). Honor it with
      // TOP priority so STAY lands on the read position, not the audio-ahead cue.
      const stayCue = window._reentryStayCueIdx;
      window._reentryStayCueIdx = null;
      // CARD → READ: centerOnActiveCard (run above + re-run inside loadAudiobookCues)
      // is the SOLE positioner — it resolves the card's chunk for SRT-cards AND
      // deck-cards and has already painted + scrolled the card's EXACT line. Skip
      // ensureGreenOnEnter(bmCue): bmCue is the sparse-collapsed BOOKMARK cue
      // (1-2 lines off the card) and would fight + overwrite the correct card line
      // — the reported card↔read drift + oscillation. Re-assert once now that the
      // alignment maps + layout are fully ready, then stop.
      if (_cameFromCardEntry) {
        centerOnActiveCard();
        _revealReaderSettled();
        return;
      }
      // Plain reopen → land on the BOOKMARK line (the single anchor). A reentry
      // stay/jump choice still wins when one is present.
      const bmCue = (_bookmarkChunkIdx >= 0 && pagedChunkToCue &&
                     _bookmarkChunkIdx < pagedChunkToCue.length && pagedChunkToCue[_bookmarkChunkIdx] >= 0)
        ? pagedChunkToCue[_bookmarkChunkIdx] : -1;
      const preferred = (Number.isFinite(stayCue) && stayCue >= 0) ? stayCue
        : (Number.isFinite(jumpCue) && jumpCue >= 0) ? jumpCue
        : bmCue;
      const cueN = (pagedCues?.length ? pagedCues : (window.__abCues || [])).length;
      if (cueN <= 0) { centerOnActiveCard(); _revealReaderSettled(); return; }
      // GUARANTEED green-on-enter, WITH RETRY. chunks, cues, and the alignment
      // map don't all become ready at the same instant on a cold open, so keep
      // re-attempting the paint until it actually lands — this is what "playing
      // a card first" did implicitly by warming the state. Yield the moment
      // audio starts (live audio-follow owns the highlight then) or the reader
      // is closed. ensureGreenOnEnter returns true on a successful paint, which
      // stops the retry.
      let _tries = 0;
      const tryPaint = () => {
        if (_readerHidden()) return;
        const ok = ensureGreenOnEnter(preferred);
        _tries++;
        // The FIRST attempt always runs (no blank gap on enter, even while
        // audio plays). Keep retrying only while it hasn't painted, under the
        // cap, AND audio isn't driving the highlight live — once _bgPlaying is
        // true, __onPagedCueUpdate owns the paint and retries would fight it.
        if (!ok && _tries < 20 && !window._bgPlaying) setTimeout(tryPaint, 120);
      };
      tryPaint();
      _revealReaderSettled();
    };
    setTimeout(runReaderEnterSetup, 80);
  }
  // Synchronously persist the reader's current position. Called on EVERY exit
  // from the reader (closeView, mode-switch away, app background) because the
  // 400ms debounced save in setupScrollTracking is otherwise LOST if the user
  // closes/switches within 400ms of their last page-turn — the EPUB-only
  // "position not saved reliably" cause (EPUB-only has no cue cursor, so the
  // per-book scrollLeft is its ONLY restore anchor; it restores pixel-exact).
  function flushReadPosition() {
    try {
      if (!currentName || !scrollEl) return;
      _clearBookmarkTimer();     // a pending settle must not fire against the next book
      _saveBookmarkNow(true);    // force: capture the exact line even though shell may have already cleared mode-read
      if (_canSaveReadScroll()) setPref(KEY_LAST_SCROLL_PREFIX + currentName, scrollEl.scrollLeft);
      if (lastReadCueIdx >= 0 && typeof window.persistReadCue === 'function') {
        window.persistReadCue(lastReadCueIdx);
      }
    } catch (_) {}
  }
  function closeView() {
    flushReadPosition();
    if (viewEl) { viewEl.style.visibility = 'hidden'; viewEl.style.pointerEvents = 'none'; }  // hide but KEEP layout
    try { clearCueHighlight(); } catch (_) {}   // drop the green so it can't bleed on the hidden-but-laid-out reader (iOS WebKit)
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
      // Keep the shared "current subtitle" in sync when the active card IS a
      // cue (SRT-cards titles: card index === cue index). Then read-mode enter
      // and the audio-follow highlight all reference the same current line.
      try {
        const cues = (pagedCues?.length ? pagedCues : (window.__abCues || []));
        if (Number.isFinite(idx) && idx >= 0 && idx < cues.length &&
            cues[idx]?.text && window.allNotes?.[idx]?.expression === cues[idx].text) {
          window._lastAudioCueIdx = idx;
        }
      } catch (e) {}
      if (!_readerHidden()) {
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
      // Refresh the progress strip on EVERY mode change so the format
      // flips immediately (card N/total → audio mm:ss/mm:ss → read
      // chars/total). updateProgress's mode detection reads body
      // classes; shell sets those before firing this event.
      try { updateProgress({ cueIdx: window._lastAudioCueIdx ?? -1 }); } catch (_) {}
      if (!viewEl) return;
      const pagedShown = !_readerHidden();
      if (mode === 'read') {
        // Show progress strip only when paged reader is the active view.
        if (pagedShown) document.body.classList.add('has-paged-progress');
      } else {
        // Leaving read mode → flush position BEFORE hiding, so a quick
        // read→audio/card switch can't drop the last page-turn.
        if (pagedShown) { flushReadPosition(); viewEl.style.visibility = 'hidden'; viewEl.style.pointerEvents = 'none'; }
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
    // Paged reader is now the ONLY reader. The KEY_USE_PAGED toggle has
    // been removed from Preferences; we install the route override
    // unconditionally at boot. The legacy horizontal reader is dead
    // code path-wise but its source stays on disk for fallback.
    installReadingRouteOverride();
    try { if (PREF) await setPref(KEY_USE_PAGED, '1'); } catch (_) {}
  }

  // Allow Preferences to flip the switch back to the legacy reader.
  async function disablePagedReader() {
    await setPref(KEY_USE_PAGED, '0');
    if (window._openReadingModeLegacy) {
      window.openReadingMode = window._openReadingModeLegacy;
    }
    closeView();
  }

  // Find the cue under the RIGHTMOST visible chunk, paint it green
  // (reader-selection highlight), and play from its startMs. If the
  // audiobook isn't already loaded into BackgroundAudio, bg.play({url})
  // loads it as part of the same call — bg.seek() alone is a no-op
  // until audio is loaded, which was the "toast but no audio" symptom.
  window.pagedSetPlayheadFromView = async function () {
    const note = (m) => { log(m); try { console.log('[reader-paged] ' + m); } catch (_) {} };
    note('pagedSetPlayheadFromView invoked');
    if (_readerHidden()) {
      try { window.showToast?.('Reader not open', 1800); } catch (_) {}
      return;
    }
    if (!scrollEl || !chunks?.length) {
      try { window.showToast?.('No content loaded', 1800); } catch (_) {}
      return;
    }
    const sr = scrollEl.getBoundingClientRect();
    let chosen = null, chosenRight = -Infinity, visibleCount = 0;
    for (const ch of chunks) {
      const r = ch.getBoundingClientRect();
      if (r.right < sr.left + 1 || r.left > sr.right - 1) continue;
      if (r.bottom < sr.top + 1 || r.top > sr.bottom - 1) continue;
      visibleCount++;
      if (r.right > chosenRight) { chosen = ch; chosenRight = r.right; }
    }
    note('setPlayhead: ' + visibleCount + ' visible chunks');
    if (!chosen) {
      try { window.showToast?.('No visible text', 1800); } catch (_) {}
      return;
    }
    const nearest = findNearestChunkCue(chosen);
    if (!nearest) {
      try { window.showToast?.('No audio cue here', 1800); } catch (_) {}
      return;
    }
    // Recover the full cue object from whichever cues source matched.
    const cuesSrc = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    const fullCue = cuesSrc[nearest.idx];
    if (!fullCue) {
      try { window.showToast?.('Cue data missing', 1800); } catch (_) {}
      return;
    }
    // Paint the cue text GREEN via the existing reader-selection highlight.
    // This is the same machinery the old swipe-up gesture used.
    paintSelectionHighlight(chosen, fullCue.text || '');
    selectedCue = { cue: fullCue, idx: nearest.idx, chunk: chosen };
    // Paint cue-active (green) + reset BOTH cue gates so the highlight FOLLOWS
    // as audio advances — legacy abUpdateCueDisplay's own `idx===abCurrentCueIdx`
    // gate would otherwise swallow the first update. See pagedPlayFromCue.
    try { setCueRangeHighlight(chosen, fullCue.text || ''); } catch (_) {}
    lastHighlightedCue = -1;
    try { window._resetAbCueGate?.(); } catch (_) {}
    note('setPlayhead → cue#' + nearest.idx + ' "' + (fullCue.text||'').slice(0,30) +
         '" at ' + Math.round(nearest.startMs) + 'ms');
    // Resolve the audio file path + URL. Must come from somewhere even
    // when the user hasn't opened audio mode yet — otherwise bg.play has
    // no source and silently does nothing.
    const audioPath = pagedAudioPath || window.__abAudioPath || null;
    if (!audioPath) {
      try { window.showToast?.('No audio paired', 1800); } catch (_) {}
      return;
    }
    // BackgroundAudio's native player takes a raw file:// URL, NOT
    // Capacitor.convertFileSrc (which produces a capacitor:// webview
    // URL that AVPlayer can't open — OSStatus 2003334207 = 'what').
    const url = audioPath.startsWith('file://') ? audioPath : ('file://' + audioPath);
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) {
      try { window.showToast?.('Audio plugin missing', 1800); } catch (_) {}
      return;
    }
    try {
      await bg.play({
        url,
        startMs: Math.round(nearest.startMs),
        rate: window.audioPlaybackRate || 1
      });
    } catch (e) {
      note('bg.play error: ' + e.message);
      try { window.showToast?.('Play error: ' + e.message, 2200); } catch (_) {}
      return;
    }
  };

  window.openPagedReader     = openView;
  window.closePagedReader    = closeView;
  window.disablePagedReader  = disablePagedReader;

  // Externally-callable: jump audio to a specific cue and paint it
  // green. Used by the dict popup's "Set playhead" button so the
  // behavior matches exactly what the floating playhead button used
  // to do. Validates the cue index, paints the selection highlight
  // immediately so the user sees a result before audio starts, and
  // resets lastHighlightedCue so the subsequent cue-active updates
  // from the position listener fire reliably (avoids the "next cue
  // plays but isn't highlighted" pattern).
  // Centered-scroll variant for explicit jumps (audio→read reentry
  // "Keep current audiobook position" choice, future jump-to-percent
  // flows). Unlike autoScrollForRange which right-justifies the cue
  // at the viewport's reading edge, this centers the chunk in the
  // viewport so the user can read forward AND back without the cue
  // hugging an edge. Also paints the cue-active highlight on the
  // chunk so the user can immediately see WHERE the playhead is.
  window.pagedCenterOnCue = function (cueIdx) {
    if (!Number.isFinite(cueIdx)) return false;
    if (_readerHidden()) return false;
    const cuesSrc = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    const cue = cuesSrc[cueIdx];
    if (!cue) return false;
    // Deliberate jump → allow the book-wide fallback so we always land somewhere.
    const chunk = resolveCueChunk(cueIdx, cue.text || '', true);
    if (!chunk) {
      log('pagedCenterOnCue: no chunk for cue ' + cueIdx);
      return false;
    }
    // Paint the cue-active highlight so the user sees a clear marker
    // exactly at the new playhead. setCueRangeHighlight is the same
    // helper __onPagedCueUpdate uses, so the visual matches the
    // auto-follow look.
    try { setCueRangeHighlight(chunk, cue.text); } catch (_) {}
    // Reset the highlight-cue gate so the next position event (when
    // user resumes audio from here) actually paints — without this,
    // the listener's idx === lastHighlightedCue early return can
    // swallow the first cue advance.
    lastHighlightedCue = cueIdx;
    try { scrollChunkNearRightWithContext(chunk); } catch (e) {
      log('pagedCenterOnCue scroll err: ' + e.message);
    }
    return true;
  };

  // Scroll the chunk into "near-right" position with ~3 line-widths
  // of previously-read text visible to the right of it. In vertical-rl
  // the reading direction is right→left across columns, so the right
  // side of the viewport holds OLDER text. Putting the active chunk
  // near (but not flush against) the right edge anchors the user with
  // a tiny strip of "what I just read" context.
  //
  // Hardened against the vertical-rl scroll-blackout bug class:
  //   1. behavior: 'smooth' — the only safe scroll mode in vertical-rl
  //      (see [[reference-paged-reader-scroll-blackout]] memory).
  //   2. Sanity-check the computed delta — if it's absurdly large
  //      (>200k px, the symptom of a stale chunk reference or short-
  //      cue false match), bail out instead of scrolling into the
  //      void.
  //   3. After the smooth scroll, schedule a verification pass at
  //      ~600 ms: if the chunk STILL isn't visible (the scroll
  //      animation got eaten by some race), re-issue the scroll.
  function scrollChunkNearRightWithContext(chunk, contextLines, opts) {
    if (!chunk || !scrollEl) return;
    const mySeq = ++_scrollSeq;   // newest scroll wins; stale verifiers below bail
    if (typeof contextLines !== 'number') contextLines = 3;
    const cr = chunk.getBoundingClientRect();
    const sr = scrollEl.getBoundingClientRect();
    if (!cr.width || !sr.width) return;
    // In vertical-rl each "line" is actually one COLUMN of text. The
    // chunk's own width approximates one column for single-paragraph
    // cues; for multi-line chunks computedStyle.lineHeight is more
    // accurate. Try lineHeight first, fall back to chunk width.
    let lineHeightPx = 0;
    try {
      const cs = getComputedStyle(innerEl);
      lineHeightPx = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
        const fs = parseFloat(cs.fontSize) || 18;
        lineHeightPx = fs * 1.8; // matches the CSS rule for innerEl
      }
    } catch (_) { lineHeightPx = 40; }
    const contextPx = lineHeightPx * contextLines;
    const pad = Math.min(16, sr.width * 0.04);
    const targetRightX = sr.right - pad - contextPx;
    const idealDelta = cr.right - targetRightX;
    // Clamp so the chunk's LEFT edge stays at least pad inside the
    // viewport — a multi-line chunk wider than (viewport - context)
    // would otherwise be partially pushed off-screen to the left,
    // which is the "highlight slightly off the screen" symptom the
    // user reported. Trade context for visibility when forced.
    const minDelta = cr.right - sr.right + pad;
    const maxDelta = cr.left - sr.left - pad;
    let delta = idealDelta;
    if (delta > maxDelta) delta = maxDelta; // chunk too wide; clamp to keep left visible
    if (delta < minDelta) delta = minDelta; // chunk already fits; just align right edge
    // Bail on absurd deltas — symptom of stale chunk refs or a
    // findChunkForText false match. Don't scroll into the void.
    if (Math.abs(delta) > 200000) {
      if (opts && opts.allowFarJump) {
        // Deliberate reopen to a known chunk in a LONG book — a huge delta is
        // legitimate, not a stale-ref bug. Move by it and let the browser clamp
        // to the valid range (NEVER abort to 0). Works on either scrollLeft sign.
        lastProgrammaticScrollTime = Date.now();
        scrollEl.scrollLeft += delta;
        // Self-heal: this is the deep-bookmark cold-open path (the most
        // layout-fragile moment) and the single set above can be eaten by a
        // post-restore reflow on a slow WKWebView. Re-verify at ~600 ms and
        // re-apply against the fresh rect, exactly like the smooth path below.
        setTimeout(() => {
          if (mySeq !== _scrollSeq) return;   // superseded by a newer scroll
          try {
            const cr2 = chunk.getBoundingClientRect();
            const sr2 = scrollEl.getBoundingClientRect();
            if (!cr2.width || !sr2.width) return;
            const visible = cr2.right > sr2.left && cr2.left < sr2.right;
            if (!visible) {
              lastProgrammaticScrollTime = Date.now();
              scrollEl.scrollLeft += (cr2.right - (sr2.right - pad - contextPx));
            }
          } catch (_) {}
        }, 600);
        return;
      }
      log('scrollChunkNearRightWithContext: absurd delta=' + Math.round(delta) + ' — aborting');
      return;
    }
    if (Math.abs(delta) < 4) return; // already there
    lastProgrammaticScrollTime = Date.now();
    log('[scroll-trace] scrollChunkNearRightWithContext delta=' + Math.round(delta));
    scrollEl.scrollBy({ left: delta, behavior: 'smooth' });
    // Verification pass: if the chunk still isn't visible 600 ms
    // later (smooth scroll should complete in ~400 ms), re-issue
    // a one-shot direct scrollLeft set to force the position. This
    // recovers from the "black viewport" case where the smooth
    // animation got swallowed.
    setTimeout(() => {
      if (mySeq !== _scrollSeq) return;   // superseded by a newer scroll
      try {
        const cr2 = chunk.getBoundingClientRect();
        const sr2 = scrollEl.getBoundingClientRect();
        const visible = cr2.right > sr2.left && cr2.left < sr2.right;
        if (!visible) {
          log('[scroll-trace] verification failed — forcing scrollLeft');
          // Direct scrollLeft set — NOT scrollBy({behavior:'instant'})
          // which blanks the viewport. Setting scrollLeft directly
          // is safer per the same memory.
          const fixDelta = cr2.right - (sr2.right - pad - contextPx);
          scrollEl.scrollLeft += fixDelta;
        }
      } catch (_) {}
    }, 600);
  }

  window.pagedPlayFromCue = async function (cueIdx) {
    log('pagedPlayFromCue cueIdx=' + cueIdx);
    if (!Number.isFinite(cueIdx)) {
      log('pagedPlayFromCue: invalid cueIdx');
      return false;
    }
    const cuesSrc = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    const cue = cuesSrc[cueIdx];
    if (!cue || !Number.isFinite(cue.startMs)) {
      log('pagedPlayFromCue: cue not found or no startMs');
      try { window.showToast?.('Cue not found', 1600); } catch (_) {}
      return false;
    }
    const audioPath = pagedAudioPath || window.__abAudioPath || null;
    if (!audioPath) {
      try { window.showToast?.('No audio paired', 1600); } catch (_) {}
      return false;
    }
    // Find the chunk for the cue (paged map first, then text search
    // fallback). Paint the green selection highlight FIRST so the
    // user sees the result immediately, even before audio actually
    // starts playing.
    let chunk = null;
    if (pagedCueToChunk && pagedCueToChunk[cueIdx] >= 0) {
      chunk = chunks[pagedCueToChunk[cueIdx]] || null;
    }
    if (!chunk) chunk = findChunkForText(cue.text);
    if (chunk) {
      // Paint the cue-active (GREEN) highlight directly — the same key the
      // audio auto-follow uses — so the line is green immediately AND keeps
      // following as audio advances. (The old paintSelectionHighlight set the
      // separate reader-selection key, which is static and doesn't move with
      // the playhead.)
      try { setCueRangeHighlight(chunk, cue.text || ''); } catch (e) {}
    }
    // Reset BOTH cue gates so the position listener re-renders and re-fires
    // __onPagedCueUpdate for the landing cue — even when the audio lands on the
    // SAME index that was already current. The paged gate alone isn't enough:
    // the LEGACY abUpdateCueDisplay has its own `idx === abCurrentCueIdx` early
    // return that swallows the update upstream (the "Set Playhead → line not
    // green" bug). _resetAbCueGate (reading-mode.js) clears the legacy one.
    lastHighlightedCue = -1;
    try { window._resetAbCueGate?.(); } catch (_) {}
    // Construct play URL + adjusted startMs (AUDIO_START_OFFSET_MS
    // compensates MP3 frame alignment + SRT-imprecision so the first
    // word of the cue isn't clipped).
    const url = audioPath.startsWith('file://') ? audioPath : 'file://' + audioPath;
    const startMs = Math.max(0, Math.round(cue.startMs) - (window.AUDIO_START_OFFSET_MS || 0));
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) {
      try { window.showToast?.('Audio plugin missing', 1600); } catch (_) {}
      return false;
    }
    try {
      await bg.play({ url, startMs, rate: window.audioPlaybackRate || 1 });
      log('pagedPlayFromCue: bg.play resolved startMs=' + startMs);
      return true;
    } catch (e) {
      log('pagedPlayFromCue: bg.play failed ' + e?.message);
      try { window.showToast?.('Play error: ' + e?.message, 2000); } catch (_) {}
      return false;
    }
  };

  // Hook invoked by the legacy reading-mode.js position handler on every
  // audio cue change. Legacy already owns the BackgroundAudio 'position'
  // listener and computes the active cue index against `abCues`; rather
  // than register a second listener (which fought legacy for the same
  // CSS.highlights 'cue-active' key and lost the race), we piggyback.
  // Receives (idx, cue) — `cue` may be null when idx<0.
  window.__onPagedCueUpdate = function (idx, cue, positionMs) {
    // Update the top-left progress strip regardless of whether the
    // paged reader view is visible — the strip lives at body level
    // and is visible across all modes (card / read / audio). User
    // wanted the counter to track current playhead position even
    // outside read mode.
    if (Number.isFinite(idx) && idx >= 0) {
      // Audio chars: credit cue text length as the playhead advances —
      // but ONLY while the user is actually in AUDIO mode. Card-mode SRT
      // clips share the BackgroundAudio plugin and also set _bgPlaying, so
      // gating on _bgPlaying alone wrongly counted card browsing as
      // listening. And only credit a CONTINUOUS forward advance: the first
      // cue of a session (no prior baseline) or a big jump (seek / mode
      // re-entry / catch-up) RE-BASELINES without crediting — previously the
      // whole 0→N range got dumped in at once (the "huge chars" bug).
      // Credit while audio plays in a LISTENING context — audio mode OR
      // reading-along (read mode). Card mode is EXCLUDED: its SRT clips share
      // the plugin and set _bgPlaying but aren't "listening" (this was the
      // over-count source). Only a CONTINUOUS advance counts: the first cue of
      // a session (no baseline) or a seek (big TIME gap) re-baselines WITHOUT
      // crediting, so the whole range can never dump in at once. The baseline
      // is reset on each audio-mode entry (openAudiobookMode), so re-entering
      // at an earlier position credits cleanly instead of being swallowed by a
      // stale high-water mark.
      const listening = window._bgPlaying && !document.body.classList.contains('mode-card');
      if (listening && window.stats?.incrementAudioChars) {
        const cuesS = (window.pagedCues?.length ? window.pagedCues : window.__abCues) || [];
        const prev = window._lastAudioCueIdxForStats ?? -1;
        // Capture the CURRENT playhead + wall clock, and read the PRIOR
        // baseline before overwriting it below.
        const nowWall = Date.now();
        const rate = parseFloat(window.audioPlaybackRate) || 1;
        const lastWall = window._audioStatsLastWallMs ?? 0;
        const lastPos  = window._audioStatsLastPosMs ?? -1;
        const posMs = Number.isFinite(positionMs) ? positionMs : (cuesS[idx]?.startMs ?? 0);
        if (idx > prev) {                       // credit FORWARD advances only
          // CONTINUITY CHECK (replaces the old cue-start-time gap ≤ 3000ms,
          // which compared cue DURATIONS and silently dropped every cue
          // longer than 3 s — undercounting real listening by ~half).
          //
          // The right question isn't "how long is this cue" but "did the
          // playhead actually traverse this span in real time, or did the
          // user SEEK?". Compare playhead advance to wall-clock advance,
          // scaled by playback rate: continuous listening moves the
          // playhead ≈ wall × rate; a forward seek moves it far more than
          // elapsed real time allows. This also credits screen-off /
          // background listening correctly (wall and playhead both advance
          // together across a long suspended gap), and treats pause→resume
          // as continuous (playhead barely moved while wall ran on).
          let continuous = false;
          if (prev >= 0 && lastWall > 0 && lastPos >= 0) {
            const playheadAdvance = posMs - lastPos;     // ms of audio crossed
            const wallAdvance     = nowWall - lastWall;  // ms of real time elapsed
            // Allowed playhead motion for a continuous listen: wall×rate
            // plus slack for poll granularity (≈2-3 Hz) and several short
            // cues collapsing into one tick. A forward seek blows past this.
            const allowed = wallAdvance * rate * 1.5 + 2500;
            continuous = playheadAdvance >= 0 && playheadAdvance <= allowed;
          }
          if (continuous) {
            let total = 0;
            for (let i = prev + 1; i <= idx; i++) {
              const c = (i === idx) ? (cue || cuesS[i]) : cuesS[i];
              // JP-only count so audio matches the read / card char counters.
              if (c?.text) total += window.jpCharCount ? window.jpCharCount(c.text)
                                                       : c.text.length;
            }
            if (total > 0) window.stats.incrementAudioChars(total);
          }
          window._lastAudioCueIdxForStats = idx; // high-water (forward only)
        }
        // Advance the continuity baseline on EVERY listening tick — forward,
        // backward, or replay — NOT just forward advances. If we only moved
        // it forward, a backward-seek detour (idx ≤ prev) would freeze
        // lastWall/lastPos at the high-water cue while real time ran on, and
        // a later forward seek would then look "continuous" (huge wallAdvance
        // vs the frozen baseline) and get falsely credited. Tracking the
        // playhead's ACTUAL position each tick keeps the next forward jump
        // measured against where the audio really was.
        window._audioStatsLastWallMs = nowWall;
        window._audioStatsLastPosMs  = posMs;
      }
      window._lastAudioCueIdx = idx;
      try { updateProgress({ cueIdx: idx }); } catch (_) {}
    }
    if (_readerHidden()) { clearCueHighlight(); return; }   // drop stale green: it would paint on the hidden-but-laid-out reader on iOS
    if (_readerCueHlGuarded(idx)) return;   // post-swipe: hold the swiped-to green until the playhead arrives (no prev-cue flash)
    if (idx === lastHighlightedCue) return;
    lastHighlightedCue = idx;
    if (idx < 0 || !cue?.text) { clearCueHighlight(); return; }
    // Locate the chunk via the preprocessed cue→chunk map. When that
    // map came from cue-alignment (pagedCueMapFromAlignment = true)
    // we TRUST a negative result: an unmatched cue means the
    // preprocessing window-search couldn't place it, so painting
    // anything would be guessing — exactly the failure mode that
    // produced the 243k-pixel scrolls (findChunkForText returns the
    // FIRST text match in book order, often a chapter away from where
    // the user is). Skip the paint instead.
    //
    // When the map came from the legacy buildCueChunkMaps fallback,
    // the old findChunkForText safety net stays active.
    // Resolve via map → bounded local search (anchored to the current green
    // chunk) → book-wide ONLY for legacy (non-alignment) maps. The bounded
    // local search keeps the highlight following the subtitle line-by-line
    // even when the alignment map left this cue unmatched, without risking
    // the book-wide far-jump that the old "SKIP unmatched" guarded against.
    const chunk = resolveCueChunk(idx, cue.text, !pagedCueMapFromAlignment);
    if (!chunk) return; // genuinely unplaceable — keep the current highlight
    // READ-ALONG char credit: the reader is VISIBLE (read mode — guaranteed by the
    // _readerHidden early-return above) and the playhead is advancing, so the user
    // is reading along with the audio. Credit the read frontier from the line now
    // being spoken — the auto-scroll path otherwise never credited (it's
    // programmatic, so the user-scroll gate skips it). noteReadPosition is
    // MONOTONIC + page-capped (READ_DELTA_CAP), so a seek/jump never credits the
    // skipped span and re-firing the same line is a no-op — this cannot
    // reintroduce the old auto-scroll over-count.
    if (document.body.classList.contains('mode-read')) {
      try {
        const _jpEnd = (parseInt(chunk.dataset.jpOff) || 0) + (parseInt(chunk.dataset.jpLen) || 0);
        if (_jpEnd > 0) window.stats?.noteReadPosition?.(_jpEnd);
        window.stats?.bumpRead?.();
      } catch (_) {}
    }
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
    //
    // Short-cue guard: skip auto-scroll for cues with fewer than 10
    // characters. Short cues ("うん", "そうか", "わかった") false-match
    // the wrong chunk in findChunkForText (which returns the FIRST
    // text-match in the book) — when the first occurrence is far from
    // the user's reading position, the resulting scroll delta is huge
    // (observed 243k pixels in round 188 logs), which causes the
    // blank-viewport + jerk-back pattern. The highlight has already
    // been painted above; skipping the scroll just leaves the user's
    // position alone. Long cues stay snap-on, so legitimate
    // "user-explored, snap back to playhead" still works.
    if ((cue.text || '').trim().length < 10) {
      log('[scroll-trace] __onPagedCueUpdate idx=' + idx + ' SKIP short cue len=' + (cue.text||'').length);
      return;
    }
    log('[scroll-trace] __onPagedCueUpdate idx=' + idx);
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
