// Minimal SRT subtitle parser + utilities for mapping audio time → cue → chunk.
//
// SRT cue:
//   1
//   00:00:01,500 --> 00:00:04,200
//   Hello, world.
//
//   2
//   ...
//
// Multi-line text inside a cue is joined with a space.

(function () {
  // "HH:MM:SS,mmm" → milliseconds. Returns -1 on parse failure.
  function parseTimestamp(s) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec((s || '').trim());
    if (!m) return -1;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    const ms = parseInt(m[4].padEnd(3, '0').slice(0, 3), 10);
    return ((h * 3600 + mn * 60 + sec) * 1000) + ms;
  }

  /**
   * Parse an SRT file's text content into an array of cue objects:
   *   [{ index, startMs, endMs, text }, ...]
   *
   * Skips malformed cues silently. Cues are returned in file order; this
   * implementation does NOT re-sort by startMs.
   */
  function parseSrt(text) {
    if (!text) return [];
    // Normalize line endings + collapse Unicode BOM.
    const normalized = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    // Cues are separated by one or more blank lines.
    const blocks = normalized.split(/\n\s*\n+/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l.length);
      if (lines.length < 2) continue;
      // Optional numeric index on first line.
      let i = 0;
      if (/^\d+$/.test(lines[0])) i = 1;
      const timing = lines[i];
      const arrow = timing.indexOf('-->');
      if (arrow < 0) continue;
      const startMs = parseTimestamp(timing.slice(0, arrow));
      const endMs = parseTimestamp(timing.slice(arrow + 3));
      if (startMs < 0 || endMs < 0) continue;
      const text = lines.slice(i + 1).join(' ').trim();
      if (!text) continue;
      cues.push({ index: cues.length, startMs, endMs, text });
    }
    return cues;
  }

  /**
   * Binary-search cues for the one active at positionMs. Returns the cue
   * index, or -1 if none. If the position falls in a gap between cues, the
   * preceding cue is returned (so the "currently relevant" cue stays selected
   * during silence).
   */
  function findCueAtTime(cues, positionMs) {
    if (!cues || !cues.length) return -1;
    if (positionMs < cues[0].startMs) return -1;
    let lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (positionMs >= c.startMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /**
   * Build a cueIdx → chunkIdx map using normalized text matching.
   * `normalizeFn` should turn both cue.text and chunk.dataset.norm into the
   * same canonical form. Forward-only scan from a moving cursor so duplicate
   * sentences match the next occurrence.
   *
   * Returns:
   *   { cueToChunk: Int32Array(cues.length) [-1 if no match],
   *     chunkToCue: Int32Array(chunks.length) [first matching cue, -1 if none] }
   */
  function buildCueChunkMaps(cues, chunks, normalizeFn) {
    const n = cues.length;
    const m = chunks.length;
    const cueToChunk = new Int32Array(n).fill(-1);
    const chunkToCue = new Int32Array(m).fill(-1);
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const norm = normalizeFn(cues[i].text);
      if (!norm) continue;
      // Forward scan from cursor; loop back to 0 once if nothing matches.
      let found = -1;
      for (let j = cursor; j < m; j++) {
        if (chunks[j].dataset.norm && chunks[j].dataset.norm.includes(norm)) {
          found = j;
          break;
        }
      }
      if (found < 0) {
        for (let j = 0; j < cursor; j++) {
          if (chunks[j].dataset.norm && chunks[j].dataset.norm.includes(norm)) {
            found = j;
            break;
          }
        }
      }
      if (found >= 0) {
        cueToChunk[i] = found;
        if (chunkToCue[found] < 0) chunkToCue[found] = i;
        cursor = found + 1;
      }
    }
    return { cueToChunk, chunkToCue };
  }

  window.srtParser = {
    parseSrt,
    findCueAtTime,
    buildCueChunkMaps
  };
})();
