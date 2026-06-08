// combo-card.js — render + drive a COMBINED SRT card (multiple short subtitles
// on one card) in card mode. A combined note (built by cue-grouper in
// loadTitleAsSrtCards) carries per-cue text + timings; this module renders the
// units (line break BETWEEN sentences, flow WITHIN a sentence/quote), keeps each
// original subtitle a tappable <span class="combo-cue"> of <span class="dict-frag">
// chars (so dictionary lookup still works per character), highlights the
// currently-narrated subtitle in the card accent (orange), autoscrolls it into
// view, and exposes the active / tapped subtitle's bounds for Anki ("single
// subtitle by default, expand to the whole card").
//
// Isolated on purpose: the 1-cue-per-card path is untouched; this only runs for
// notes flagged `combined`.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isCombined(card) {
    return !!(card && card.combined && Array.isArray(card.cueTexts) && card.cueTexts.length > 1
      && Array.isArray(card.units) && Array.isArray(card.cueStartMs));
  }

  // Build the inner HTML for the .subtitle-text element of a combined card.
  // Each unit (sentence/quote) is a block (line break between units); each cue
  // is an inline .combo-cue span carrying its bounds; each char is a .dict-frag.
  function buildSubtitleHTML(card) {
    // Flatten to (char, cueOrdinal) so we can insert a line break at every
    // sentence end (。！？) and every complete quote (」/』) at depth 0 — EVEN
    // when one subtitle cue contains several (e.g. "…おいて」「それは…」") — while
    // keeping each cue a tappable .combo-cue span (highlight + dict + Anki bounds).
    const flat = [];
    for (let o = 0; o < card.cueTexts.length; o++) {
      for (const ch of (card.cueTexts[o] || '')) flat.push({ ch, o });
    }
    const nextNonSpace = (i) => {
      for (let j = i + 1; j < flat.length; j++) { if (!/\s/.test(flat[j].ch)) return flat[j].ch; }
      return '';
    };
    // A continued-quote chunk (a later piece of a split long quote) starts INSIDE
    // the quote, so seed the depth so its internal 。 keep flowing (no break).
    let html = '', depth = card.startDepth || 0, curO = -1;
    for (let i = 0; i < flat.length; i++) {
      const { ch, o } = flat[i];
      if (o !== curO) {
        if (curO !== -1) html += '</span>';
        const cs = card.cueStartMs[o], ce = card.cueEndMs[o];
        const gi = card.cueIndices ? card.cueIndices[o] : o;
        html += '<span class="combo-cue" data-co="' + o + '" data-cs="' + cs +
                '" data-ce="' + ce + '" data-gi="' + gi + '">';
        curO = o;
      }
      html += '<span class="dict-frag">' + esc(ch) + '</span>';
      if (ch === '「' || ch === '『') depth++;
      else if (ch === '」' || ch === '』') depth = Math.max(0, depth - 1);
      // Break AFTER this char when, at depth 0, it ends a sentence or closes a
      // quote — but NOT an embedded quote continuing with と/って (e.g. 「ふうん」と…),
      // and never after the final char of the card.
      if (i < flat.length - 1 && depth === 0) {
        const isSentEnd = /[。．！？!?]/.test(ch);
        let isQuoteEnd = (ch === '」' || ch === '』');
        if (isQuoteEnd) { const nx = nextNonSpace(i); if (nx === 'と' || nx === 'っ') isQuoteEnd = false; }
        if (isSentEnd || isQuoteEnd) html += '<span class="combo-nl"></span>';
      }
    }
    if (curO !== -1) html += '</span>';
    return '<div class="subtitle-text combo" id="comboSubtitle">' + html + '</div>';
  }

  // Resolve {sentence, cueStartMs, cueEndMs, cueIndex} from a .combo-cue element.
  function ctxFromCueEl(cueEl) {
    if (!cueEl) return null;
    const cs = parseFloat(cueEl.getAttribute('data-cs'));
    const ce = parseFloat(cueEl.getAttribute('data-ce'));
    return {
      sentence: cueEl.textContent || '',
      cueStartMs: Number.isFinite(cs) ? cs : null,
      cueEndMs: Number.isFinite(ce) ? ce : null,
      cueIndex: parseInt(cueEl.getAttribute('data-gi')),
    };
  }

  // Point window.lookupContext at one subtitle (so a dict lookup uses that single
  // cue as the sentence + audio bounds — "single subtitle by default"; the
  // existing waveform editor still lets the user expand). Preserves other fields.
  function bindCueContext(cueEl, card) {
    const c = ctxFromCueEl(cueEl);
    if (!c) return;
    const lc = window.lookupContext || {};
    window.lookupContext = Object.assign({}, lc, {
      sentence: c.sentence,
      cueStartMs: c.cueStartMs,
      cueEndMs: c.cueEndMs,
      cueIndex: c.cueIndex,
      cueAudioPath: card && card.audiobookPath,
      // Full-card text kept so a future "expand to card" control can offer it.
      comboCardText: card ? (card.cueTexts || []).join('') : '',
    });
  }

  // Reduce straggly trailing characters (e.g. an orphan "た。" on its own last
  // line). text-wrap:pretty / line-break:strict (theme.css) help on recent
  // WebViews but iOS still orphans, so glue the last few characters of each
  // sentence/quote together with white-space:nowrap — the line then breaks BEFORE
  // that group, so the final line carries several chars instead of one. Cheap
  // (no layout reads): the only DOM work is moving a handful of existing spans.
  // The wrap stays INSIDE its .combo-cue, so tap/highlight/dict lookup are intact.
  var KEEP_TAIL = 3;
  function preventOrphans(root) {
    try {
      var seq = root.querySelectorAll('.dict-frag, .combo-nl');
      var seg = [];
      var flush = function () {
        if (seg.length > KEEP_TAIL) {
          var last = seg[seg.length - 1];
          var parent = last.parentNode;
          var tail = [];
          for (var i = seg.length - 1; i >= 0 && tail.length < KEEP_TAIL; i--) {
            if (seg[i].parentNode !== parent) break;   // never wrap across a cue span
            tail.unshift(seg[i]);
          }
          if (tail.length >= 2 && tail.length < seg.length) {
            var wrap = document.createElement('span');
            wrap.className = 'combo-keep';
            parent.insertBefore(wrap, tail[0]);
            for (var k = 0; k < tail.length; k++) wrap.appendChild(tail[k]);
          }
        }
        seg = [];
      };
      seq.forEach(function (n) {
        if (n.classList && n.classList.contains('combo-nl')) flush();
        else seg.push(n);
      });
      flush();   // final segment (no trailing combo-nl)
    } catch (_) {}
  }

  // After the card HTML is in the DOM: capture-phase tap binding (so the tapped
  // subtitle's context is set BEFORE the dict lookup fires) + initial highlight.
  // posMs path (legacy/playhead) OR an explicit window-local ORDINAL (the paged
  // renderer: the active cue is currentCardIndex, so the highlight is driven by
  // the index, not the playhead). When `ordinal` is a finite number it wins.
  function afterRender(container, card, posMs, ordinal) {
    const root = container.querySelector('#comboSubtitle');
    if (!root) return;
    _curCard = card;
    preventOrphans(root);
    if (!root._comboTapHooked) {
      root._comboTapHooked = true;
      root.addEventListener('pointerdown', (e) => {
        const cueEl = e.target && e.target.closest ? e.target.closest('.combo-cue') : null;
        if (cueEl) bindCueContext(cueEl, _curCard);
      }, true);
    }
    if (Number.isFinite(ordinal)) { _lastOrdinal = -1; setActiveOrdinal(ordinal); }
    else updateActive(card, posMs, true);
  }

  // Find the active subtitle for a playhead position and paint it orange +
  // autoscroll. ordinal = last cue whose start <= posMs (clamped to 0).
  let _lastOrdinal = -1;
  let _curCard = null;   // the page/window card currently rendered in the DOM
  function activeOrdinal(card, posMs) {
    const starts = card.cueStartMs;
    let o = 0;
    for (let i = 0; i < starts.length; i++) { if (starts[i] <= posMs) o = i; else break; }
    return o;
  }
  // Paint the orange highlight on the cue at window-local ordinal `o` and point
  // the lookup/Anki context at it (overridden on a specific tap by the capture
  // listener in afterRender). No autoscroll: the page is screen-fit +
  // overflow:hidden (never scrolls, to keep the swipe up/down transport).
  function paintOrdinal(o) {
    const root = document.getElementById('comboSubtitle');
    if (!root) return;
    const cues = root.querySelectorAll('.combo-cue');
    let activeEl = null;
    cues.forEach((el) => { if (parseInt(el.getAttribute('data-co')) === o) activeEl = el; });
    // An all-whitespace/empty cue produces no .combo-cue span for its ordinal
    // (buildSubtitleHTML only emits spans for chars). Keep the PRIOR highlight +
    // context rather than clearing everything, so a blank music/sound cue doesn't
    // make the highlight vanish for its whole duration.
    if (!activeEl) return;
    _lastOrdinal = o;
    cues.forEach((el) => el.classList.toggle('combo-cue-active', el === activeEl));
    if (_curCard) bindCueContext(activeEl, _curCard);
    window._comboActiveContext = ctxFromCueEl(activeEl);
    // Keep the highlighted line visible inside a CLIPPED page (a long single
    // sentence spanning several cues can exceed --combo-max-h; .combo is
    // overflow:hidden, not scroll). Scroll the clip box programmatically —
    // overflow:hidden still honors scrollTop, so the swipe up/down transport is
    // preserved (the box is never user-scrollable).
    try {
      if (root.scrollHeight > root.clientHeight + 1) {
        const top = activeEl.offsetTop, bot = top + activeEl.offsetHeight;
        if (top < root.scrollTop) root.scrollTop = Math.max(0, top - 8);
        else if (bot > root.scrollTop + root.clientHeight) root.scrollTop = bot - root.clientHeight + 8;
      }
    } catch (_) {}
  }
  // Highlight the active cue by its window-local ordinal (currentCardIndex −
  // page.lo). Used by the paged renderer's fast path (move the highlight without
  // a full re-render). No-op if the ordinal hasn't changed.
  function setActiveOrdinal(o) {
    if (!Number.isFinite(o) || o === _lastOrdinal) return;
    paintOrdinal(o);
  }
  function updateActive(card, posMs, force) {
    const root = document.getElementById('comboSubtitle');
    if (!root || !isCombined(card)) return;
    const o = (Number.isFinite(posMs) && posMs > 0) ? activeOrdinal(card, posMs) : 0;
    if (!force && o === _lastOrdinal) return;
    _curCard = card;
    paintOrdinal(o);
  }

  function reset() { _lastOrdinal = -1; _curCard = null; }

  // For the swipe-up card send: the single active subtitle's text/bounds.
  function activeContext(card) {
    if (!isCombined(card)) return null;
    return window._comboActiveContext || ctxFromCueEl(document.querySelector('#comboSubtitle .combo-cue-active'));
  }

  window.comboCard = { isCombined, buildSubtitleHTML, afterRender, updateActive, setActiveOrdinal, reset, activeContext };
})();
