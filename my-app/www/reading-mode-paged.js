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
  let bgListenerHandle = null;
  // Shared Highlight instance for the 'cue-active' key. Reused across
  // every paint so WebKit's invalidator sees a single object whose
  // range set changes, instead of a fresh Highlight per cue (which left
  // ghost paints in iOS WKWebView during scroll animations).
  let activeCueHighlight = null;
  let selectionHighlight = null;  // shared Highlight for 'reader-selection'
  let selectedCue = null;          // { cue, idx, chunk } when a swipe-up selected a sentence
  let undoMs = null;               // previous playhead ms to revert to
  let undoTimer = null;            // setTimeout handle to auto-hide undo chip
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
      /* Undo chip — top-right safe-area, mirrors the progress strip. */
      #pagedUndoChip {
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) / 2);
        transform: translateY(-50%);
        right: calc(env(safe-area-inset-right, 0px) + 12px);
        padding: 8px 12px;
        font: 600 10px var(--font-sans, system-ui);
        color: var(--accent-read, #4caf50);
        background: transparent;
        border: 1px solid var(--accent-read, #4caf50);
        border-radius: 999px;
        z-index: 9001;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        white-space: nowrap;
        transition: opacity .18s ease;
      }
      #pagedUndoChip:active { opacity: .55; }
      body.chrome-hidden #pagedUndoChip {
        opacity: 0;
        pointer-events: none;
      }
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
      if (swipeFired) return;
      const t = e.touches?.[0];
      if (!t) return;
      const dxRaw = t.clientX - sx, dyRaw = t.clientY - sy;
      const adx = Math.abs(dxRaw), ady = Math.abs(dyRaw);
      if (dyRaw > 30 && ady > adx * 1.5 && adx < 50) {
        swipeFired = true;
        log('[swipe] down dy=' + Math.round(dyRaw) + ' dx=' + Math.round(dxRaw));
        try { handleSwipeDown(); } catch (err) { log('[swipe] handler error:', err?.message); }
      }
    }, { passive: true });

    scrollEl.addEventListener('touchend', (e) => {
      if (swipeFired) return; // swipe already handled in touchmove
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

  // ---------- Play from selection + undo ----------

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
    // Record the previous position for undo BEFORE we seek.
    const oldMs = await getCurrentPlayMs();
    if (Number.isFinite(oldMs)) recordUndo(oldMs);
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

  function recordUndo(ms) {
    undoMs = ms;
    let chip = document.getElementById('pagedUndoChip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'pagedUndoChip';
      chip.textContent = 'UNDO';
      chip.addEventListener('click', revertUndo);
      document.body.appendChild(chip);
    }
    chip.style.display = 'block';
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
  }

  function hideUndo() {
    const chip = document.getElementById('pagedUndoChip');
    if (chip) chip.style.display = 'none';
    undoMs = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }

  async function revertUndo() {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg || undoMs == null) { hideUndo(); return; }
    try { await bg.seek({ ms: Math.round(undoMs) }); } catch (_) {}
    hideUndo();
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
      if (pagedCueMapFromAlignment && pagedCueToChunk &&
          Number.isFinite(idx) && idx < pagedCueToChunk.length &&
          pagedCueToChunk[idx] >= 0 && pagedCues[idx]?.text) {
        chunk = chunks[pagedCueToChunk[idx]] || null;
        if (chunk) highlightText = pagedCues[idx].text;
      }
      if (!chunk) chunk = findChunkForText(card.expression);
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
      scrollChunkNearRightWithContext(chunk);
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
        // User-driven scroll IS reading activity — kick the read timer
        // alive. Cheap call; if the timer is already running it just
        // refreshes lastInteraction. If it had been stopped by the
        // inactivity timeout, a small jiggle is enough to restart it.
        try { window.stats?.bumpRead?.(); } catch (_) {}
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
  function updateProgress(opts) {
    if (!progressEl) return;
    const mode = _activeMode();

    // --- AUDIO MODE: current / total audio time ---
    if (mode === 'audio' && typeof window.getAudioProgress === 'function') {
      const a = window.getAudioProgress();
      if (a && Number.isFinite(a.dur) && a.dur > 0) {
        progressEl.textContent = _fmtHms(a.ms) + ' / ' + _fmtHms(a.dur);
        return;
      }
      // No duration yet — fall through to default.
    }

    // --- CARD MODE: card / total ---
    if (mode === 'card' && Array.isArray(window.allNotes) && window.allNotes.length) {
      const ci = Number.isFinite(window.currentCardIndex) ? window.currentCardIndex : 0;
      progressEl.textContent = (ci + 1).toLocaleString() + ' / ' +
                               window.allNotes.length.toLocaleString();
      return;
    }

    // --- READ MODE (or any mode with EPUB loaded): char position ---
    if (totalChars) {
      let cur = -1;
      if (opts && Number.isFinite(opts.cueIdx)) {
        if (pagedCueToChunk && pagedCueToChunk[opts.cueIdx] >= 0) {
          const chunk = chunks[pagedCueToChunk[opts.cueIdx]];
          if (chunk) {
            const off = parseInt(chunk.dataset.charOffset) || 0;
            const len = parseInt(chunk.dataset.charLen) || 0;
            cur = off + len;
          }
        }
      } else if (scrollEl) {
        const sw = scrollEl.scrollWidth - scrollEl.clientWidth;
        if (sw > 0) {
          const frac = Math.min(1, Math.max(0, Math.abs(scrollEl.scrollLeft) / sw));
          cur = Math.round(totalChars * frac);
        }
      }
      if (cur >= 0) {
        const pct = Math.round((cur / totalChars) * 1000) / 10;
        progressEl.textContent = `${cur.toLocaleString()} / ${totalChars.toLocaleString()} · ${pct}%`;
        return;
      }
    }

    progressEl.textContent = '—';
  }
  // Externally callable from card / audio mode so the progress strip
  // tracks the current playhead even when the reader view is hidden.
  window.pagedUpdateProgressForCue = function (cueIdx) {
    try { updateProgress({ cueIdx }); } catch (_) {}
  };

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

      const isFreshBookLoad = currentName !== name;
      currentName = name;
      if (isFreshBookLoad) pagedInitialScrollDone = false;
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
    pagedCueMapFromAlignment = false;
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

    if (innerEl.querySelector('.reading-chunk')) {
      setTimeout(async () => {
        recompute();
        centerOnActiveCard();
        await loadAudiobookCues();
        attachBgListener();
        // Consume a pending audio-reentry centering set by
        // reentryChoose('audio'). One-shot — clear after use so a
        // later openView doesn't re-trigger.
        try {
          const jumpCue = window._reentryAudioJumpCueIdx;
          if (Number.isFinite(jumpCue)) {
            window._reentryAudioJumpCueIdx = null;
            // Small extra delay so loadAudiobookCues' alignment-map
            // setup is fully done before we read pagedCueToChunk.
            setTimeout(() => {
              try { window.pagedCenterOnCue?.(jumpCue); } catch (_) {}
            }, 60);
          }
        } catch (_) {}
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
      // Refresh the progress strip on EVERY mode change so the format
      // flips immediately (card N/total → audio mm:ss/mm:ss → read
      // chars/total). updateProgress's mode detection reads body
      // classes; shell sets those before firing this event.
      try { updateProgress({ cueIdx: window._lastAudioCueIdx ?? -1 }); } catch (_) {}
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
    if (!viewEl || viewEl.style.display === 'none') {
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
    const oldMs = await getCurrentPlayMs();
    if (Number.isFinite(oldMs)) recordUndo(oldMs);
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
    try { window.showToast?.('▶ cue ' + nearest.idx, 1400); } catch (_) {}
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
    if (!viewEl || viewEl.style.display === 'none') return false;
    const cuesSrc = (pagedCues?.length ? pagedCues : (window.__abCues || []));
    const cue = cuesSrc[cueIdx];
    if (!cue) return false;
    let chunk = null;
    if (pagedCueToChunk && pagedCueToChunk[cueIdx] >= 0) {
      chunk = chunks[pagedCueToChunk[cueIdx]] || null;
    }
    if (!chunk) chunk = findChunkForText(cue.text || '');
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
  function scrollChunkNearRightWithContext(chunk, contextLines) {
    if (!chunk || !scrollEl) return;
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
      try { paintSelectionHighlight(chunk, cue.text || ''); } catch (e) {}
    }
    // Reset the highlight-cue gate so the position listener WILL
    // fire __onPagedCueUpdate when the new cue lands — without this
    // reset, if lastHighlightedCue happens to already equal cueIdx
    // (or the cue we land on right after), the listener's
    // `idx === lastHighlightedCue` early return swallows the paint
    // and the cue plays unhighlighted.
    lastHighlightedCue = -1;
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
    // Record undo (if the helper exists, it captures current position
    // before the jump).
    try {
      const s = await bg.getState?.();
      if (s && Number.isFinite(s.positionMs)) recordUndo(s.positionMs);
    } catch (_) {}
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
  window.__onPagedCueUpdate = function (idx, cue) {
    // Update the top-left progress strip regardless of whether the
    // paged reader view is visible — the strip lives at body level
    // and is visible across all modes (card / read / audio). User
    // wanted the counter to track current playhead position even
    // outside read mode.
    if (Number.isFinite(idx) && idx >= 0) {
      window._lastAudioCueIdx = idx;
      try { updateProgress({ cueIdx: idx }); } catch (_) {}
    }
    if (!viewEl || viewEl.style.display === 'none') return;
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
    let chunk = null;
    if (pagedCueToChunk && pagedCueToChunk[idx] >= 0) {
      chunk = chunks[pagedCueToChunk[idx]] || null;
    } else if (pagedCueMapFromAlignment) {
      // Trustworthy "unmatched" — leave whatever highlight is up alone,
      // don't risk a wrong scroll.
      log('[scroll-trace] __onPagedCueUpdate idx=' + idx + ' SKIP unmatched (alignment)');
      return;
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
