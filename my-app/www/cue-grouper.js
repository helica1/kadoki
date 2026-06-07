// cue-grouper.js — Combine short subtitle cues into multi-subtitle CARDS for
// card mode (audiobook + SRT "SRT-card" titles).
//
// Rules (from the feature spec):
//   • Fragments of ONE sentence are combined — they flow together (no line
//     break). A sentence may contain a quote; punctuation INSIDE a quote does
//     not end the sentence.
//   • A run of text inside a 「…」/『…』 quote is combined and flows together.
//   • Distinct complete sentences may be packed onto the same card up to a soft
//     char limit (default 80), separated by a LINE BREAK.
//   • A single sentence/quote longer than the limit is its own card (the UI
//     autoscrolls it). We never split a sentence across cards.
//
// Output is engine-agnostic: each card lists its member cues (with per-cue
// text + timings preserved, so the live cue can be highlighted and Anki bounds
// can be per-cue) plus a `units` breakdown that says where the line breaks go.
//
// Pure module — no DOM. Exposed as window.cueGrouper (browser) and
// module.exports (node, for tests).
(function (root) {
  'use strict';

  // Sentence-ending punctuation (JP + ASCII). Trailing closing brackets/quotes
  // are stripped before the test so 「…。」 / （…） still count as sentence ends.
  const SENT_END = /[。．！？!?]$/;
  const TRAIL_CLOSERS = /[\s」』）)】〉》〕｝\]"'’”』」]+$/u;
  const OPENERS = /[「『]/g;
  const CLOSERS = /[」』]/g;

  function countMatches(s, re) {
    const m = s.match(re);
    return m ? m.length : 0;
  }

  const CLOSE_QUOTE = /[」』]/;

  // A "unit" is one complete sentence OR one complete spoken quote. We walk cues
  // adding them to the current unit until EITHER (a) the running text ends a
  // sentence (。！？) and we're not inside an open quote, OR (b) the running text
  // ends with a CLOSING quote 」/』 that brought the quote depth back to 0 — i.e.
  // a complete quote turn. A trailing run with no terminator is its own unit.
  // Quotes are never split mid-quote (a full quote is never shown as a fragment).
  function splitIntoUnits(cues) {
    const units = [];
    let cur = null;
    let quoteDepth = 0;
    const startUnit = () => ({ cues: [], chars: 0 });
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const text = (c.text || '').trim();
      if (!cur) cur = startUnit();
      cur.cues.push(c);
      cur.chars += charLen(text);
      quoteDepth += countMatches(text, OPENERS) - countMatches(text, CLOSERS);
      if (quoteDepth < 0) quoteDepth = 0; // tolerate unmatched closers
      const combined = cur.cues.map(x => (x.text || '').trim()).join('');
      const lastChar = combined.slice(-1);
      // (b) complete quote turn: ends with a closing bracket, depth back to 0.
      const endsQuote = quoteDepth <= 0 && CLOSE_QUOTE.test(lastChar);
      // (a) regular sentence end (strip trailing closers/brackets first).
      const stripped = combined.replace(TRAIL_CLOSERS, '');
      const endsSentence = quoteDepth <= 0 && SENT_END.test(stripped.slice(-1));
      if (endsQuote || endsSentence) {
        cur.text = combined;
        // A "standalone quote turn" both opens and closes with a bracket — those
        // get conservative packing. An EMBEDDED quote (e.g. 〜、「…」と答えた。)
        // is treated as ordinary sentence text and packs normally.
        cur.isQuote = /^[「『]/.test(combined) && CLOSE_QUOTE.test(lastChar);
        units.push(cur); cur = null; quoteDepth = 0;
      }
    }
    if (cur) { cur.text = cur.cues.map(x => (x.text || '').trim()).join(''); cur.isQuote = false; units.push(cur); }
    return units;
  }

  // Count display characters (code points). Whitespace is excluded so the soft
  // limit reflects visible Japanese characters, matching the spec's "~80 chars".
  function charLen(s) {
    let n = 0;
    for (const ch of String(s || '')) { if (!/\s/.test(ch)) n++; }
    return n;
  }

  // Build a card object from a flat, ordered list of member cues. startDepth =
  // the quote depth at the card's start (>0 for a continued-quote chunk, so the
  // renderer keeps its internal 。 flowing instead of line-breaking).
  function cardFromCues(flat, startDepth) {
    return {
      cues: flat,
      cueIndices: flat.map(c => c.index),
      cueTexts: flat.map(c => (c.text || '').trim()),
      cueStartMs: flat.map(c => c.startMs),
      cueEndMs: flat.map(c => c.endMs),
      startMs: flat[0].startMs,
      endMs: flat[flat.length - 1].endMs,
      units: [[0, flat.length - 1]],
      startDepth: startDepth || 0,
      chars: flat.reduce((a, c) => a + charLen((c.text || '').trim()), 0),
    };
  }

  // Split an over-limit unit into ~equal contiguous chunks, breaking ONLY after a
  // cue that ends an internal sentence (。！？) so a sentence is never divided.
  // Used for a long quote (one speaker turn with several internal sentences):
  // a 200-char quote with maxChars 80 → ~67/67/66. Returns [{cues, startDepth}].
  // A unit with no internal sentence break (a single long sentence) stays whole.
  function splitUnitBalanced(cueList, maxChars) {
    const charsOf = (c) => charLen((c.text || '').trim());
    const total = cueList.reduce((a, c) => a + charsOf(c), 0);
    if (total <= maxChars || cueList.length < 2) return [{ cues: cueList, startDepth: 0 }];
    const canBreakAfter = cueList.map((c, i) =>
      i < cueList.length - 1 && SENT_END.test((c.text || '').trim().replace(TRAIL_CLOSERS, '')));
    if (!canBreakAfter.some(Boolean)) return [{ cues: cueList, startDepth: 0 }];
    // N chunks scaled to the (adjustable) limit; balance toward equal sizes.
    const N = Math.max(2, Math.ceil(total / maxChars));
    const target = total / N;
    const rawChunks = [];
    let start = 0;
    // For each of the first N-1 chunks, cut at the allowed break point whose
    // length-from-start is CLOSEST to the target — so a 100-char quote split in 2
    // lands ~50/50, not 90/10 (rather than greedily filling to the limit).
    for (let k = 0; k < N - 1 && start < cueList.length; k++) {
      let run = 0, bestJ = -1, bestDiff = Infinity;
      for (let j = start; j < cueList.length - 1; j++) {
        run += charsOf(cueList[j]);
        if (!canBreakAfter[j]) continue;
        const diff = Math.abs(run - target);
        if (diff < bestDiff) { bestDiff = diff; bestJ = j; }
        if (run >= target) break;   // first break at/after target; later ones are farther
      }
      if (bestJ < 0) break;          // no break point left
      rawChunks.push(cueList.slice(start, bestJ + 1));
      start = bestJ + 1;
    }
    rawChunks.push(cueList.slice(start));
    const out = []; let depth = 0;
    for (const ch of rawChunks) {
      out.push({ cues: ch, startDepth: depth });
      for (const c of ch) {
        depth += countMatches(c.text || '', OPENERS) - countMatches(c.text || '', CLOSERS);
        if (depth < 0) depth = 0;
      }
    }
    return out;
  }

  // Estimated rendered line count for a unit of `chars` visible characters at
  // `cpl` characters per line. A unit always occupies at least one line.
  function unitLineCost(chars, cpl) {
    return Math.max(1, Math.ceil(chars / Math.max(1, cpl)));
  }

  // Pack units into cards. Two budget modes:
  //   • LINE mode (opts.maxLines + opts.charsPerLine): pack until the card would
  //     exceed the number of rendered LINES that fit on screen, counting the
  //     half-line gap between sentences. This is the screen-fit model — char
  //     count alone mis-measures vertical fill when a card is many short
  //     one-line sentences (each 。 forces a new line). PREFERRED.
  //   • CHAR mode (opts.maxChars, legacy/fallback): pack to a flat char budget.
  // A unit taller than the budget is split into balanced chunks at internal
  // sentence boundaries (splitUnitBalanced); an unsplittable single long
  // sentence becomes its own (autoscrolling) card.
  function groupCues(cues, opts) {
    opts = opts || {};
    const list = Array.isArray(cues) ? cues : [];
    if (!list.length) return [];
    const lineMode = Number.isFinite(opts.maxLines) && opts.maxLines > 0 &&
                     Number.isFinite(opts.charsPerLine) && opts.charsPerLine > 0;
    const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 80;
    const maxLines = lineMode ? opts.maxLines : 0;
    const cpl = lineMode ? opts.charsPerLine : 0;
    // Inter-sentence gap (.combo-nl is 0.5em; line-height is 1.5em) ≈ 0.34 line.
    const GAP = 0.34;
    // Effective per-card char budget used to SPLIT an over-budget unit. In line
    // mode a card of maxLines lines holds ~maxLines×charsPerLine chars.
    const effMaxChars = lineMode ? Math.max(cpl, Math.floor(maxLines * cpl)) : maxChars;

    const tooBig = (u) => lineMode ? (unitLineCost(u.chars, cpl) > maxLines) : (u.chars > maxChars);

    const units = splitIntoUnits(list);
    const cards = [];
    let curCues = null, curChars = 0, curLines = 0;
    const flushPacked = () => { if (curCues) { cards.push(cardFromCues(curCues, 0)); curCues = null; curChars = 0; curLines = 0; } };
    const fits = (u) => lineMode
      ? (curLines + GAP + unitLineCost(u.chars, cpl)) <= maxLines
      : (curChars + u.chars) <= maxChars;
    for (const u of units) {
      if (tooBig(u)) {
        flushPacked();
        for (const chunk of splitUnitBalanced(u.cues, effMaxChars)) cards.push(cardFromCues(chunk.cues, chunk.startDepth));
      } else if (!curCues) {
        curCues = u.cues.slice(); curChars = u.chars; curLines = unitLineCost(u.chars, cpl);
      } else if (fits(u)) {
        curCues = curCues.concat(u.cues); curChars += u.chars; curLines += GAP + unitLineCost(u.chars, cpl);
      } else {
        flushPacked();
        curCues = u.cues.slice(); curChars = u.chars; curLines = unitLineCost(u.chars, cpl);
      }
    }
    flushPacked();
    return cards;
  }

  const api = { groupCues, splitIntoUnits, charLen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cueGrouper = api;
})(typeof window !== 'undefined' ? window : null);
