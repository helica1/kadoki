// auto-align.js — streaming fuzzy alignment of auto-transcribed (ASR) cues
// to the title's book text (EPUB/TXT read source).
//
// When an audio-only title ALSO carries a read source, auto-transcribe.js
// asks this module to replace each ASR cue's text with the exact passage
// from the book, so subtitles/cards/Anki/dictionary all show the author's
// text instead of the recognizer's guess — the on-device replacement for
// the off-device SubPlz sync step. Downstream nothing changes: the final
// generated SRT carries book text, so cue-alignment.js's exact matcher
// builds the read-along maps for it with no modification.
//
// Matching model (differs from cue-alignment.js on purpose):
//   - Cues arrive OUT OF ORDER (backfill jobs run behind the playhead), so
//     instead of one forward cursor we keep a time-sorted anchor list of
//     confirmed matches and window each new cue around the char position
//     interpolated from its ms neighbors. Windows are hard-bounded by the
//     neighboring anchors' ranges, so one false match can't cascade.
//   - ASR text is NOT a literal substring of the book (homophone kanji,
//     number formatting, kana variants), so after an exact-indexOf fast
//     path we run a banded edit-distance search (Sellers: free text
//     prefix/suffix) and accept below a distance-ratio threshold.
//   - Normalization = cue-alignment's strip set + NFKC + lowercase, plus
//     katakana→hiragana folding (recognizer and book frequently disagree
//     on kana script). Normalization is matching-only: replacement text is
//     always sliced from the RAW book text via the norm→raw index map.
//
// Wrong-book guard: an abridged/different-edition audiobook would fail
// almost every match — after DISABLE_AFTER attempts below DISABLE_BELOW
// the module disables itself for the session and cues keep ASR text.
//
// This module never touches playback position and never reorders cues —
// text substitution is orthogonal to the never-lose-place invariant.
(function () {
  'use strict';

  const PASS1_HALF = 1500;      // normalized chars each side of the expected position
  const PASS2_HALF = 6000;      // escalation window on a pass-1 miss
  const MAX_NEEDLE = 120;       // hard cap on normalized cue length fed to the DP
  const BOUND_SLACK = 24;       // allowed overlap into a neighboring anchor's range
  const RATE_FALLBACK = 0.0075; // norm chars per ms of JP narration (~7.5 chars/s)
  const TIGHT_DIST_RATIO = 0.42;   // edit distance / needle length, anchored nearby
  const LOOSE_DIST_RATIO = 0.30;   // stricter when extrapolating far from any anchor
  const DISABLE_AFTER = 40;
  const DISABLE_BELOW = 0.25;
  const INDEX_YIELD_EVERY = 8000;  // chars per event-loop yield while indexing

  // Same strip set as cue-alignment.js defaultNormalize — the generated SRT
  // must round-trip through that matcher later, so anything we strip here
  // it strips too.
  const STRIP_RE = /[\s　「」『』、。・…！？!?,.;:""'']/;
  const OPEN_SET = '「『（【〈《"\'([';
  const CLOSE_SET = '。、」』）】〉》！？!?…"\'.,)]';

  const log = (m) => { try { console.log('[autoAlign] ' + m); } catch (_) {} };

  let state = null;      // { titleId, flat, normFlat, normToRaw, anchors, tried, matched, disabled, getDurMs }
  let preparing = null;  // in-flight prepare() promise, keyed by titleId

  // ── normalization ─────────────────────────────────────────────────────────

  // Per-char NFKC + lowercase + katakana→hiragana fold. Char-by-char so the
  // norm→raw map stays well-defined when NFKC expands one char into several.
  function normChar(ch) {
    if (STRIP_RE.test(ch)) return '';
    let n = ch.normalize('NFKC').toLowerCase();
    let out = '';
    for (let k = 0; k < n.length; k++) {
      const cp = n.charCodeAt(k);
      out += (cp >= 0x30A1 && cp <= 0x30F6) ? String.fromCharCode(cp - 0x60) : n[k];
    }
    return out;
  }

  function normalizeStr(s) {
    if (!s) return '';
    let out = '';
    for (let i = 0; i < s.length; i++) out += normChar(s[i]);
    return out;
  }

  // normalizeStr + a raw-index → norm-index map (used to project word-timing
  // offsets from ASR text onto the substituted display text). rawToNorm has
  // length s.length + 1; entry i = norm index where raw char i begins.
  function normalizeStrMapped(s) {
    const rawToNorm = new Int32Array((s ? s.length : 0) + 1);
    let out = '';
    for (let i = 0; i < (s ? s.length : 0); i++) {
      rawToNorm[i] = out.length;
      out += normChar(s[i]);
    }
    rawToNorm[s ? s.length : 0] = out.length;
    return { norm: out, rawToNorm };
  }

  // Character-level Needleman-Wunsch with traceback between two SHORT
  // normalized strings (a cue vs its matched book span, both ≤~150 chars).
  // Returns a2b: Int32Array(a.length + 1), monotonic, mapping each a-index
  // to its aligned b-index. Cost is a few thousand cells per matched cue.
  function charAlign(a, b) {
    const n = a.length, m = b.length;
    const a2b = new Int32Array(n + 1);
    if (!n || !m) { for (let i = 0; i <= n; i++) a2b[i] = 0; return a2b; }
    const W = m + 1;
    const dp = new Int32Array((n + 1) * W);
    for (let j = 0; j <= m; j++) dp[j] = j;
    for (let i = 1; i <= n; i++) {
      dp[i * W] = i;
      const ac = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const sub = dp[(i - 1) * W + j - 1] + (ac === b.charCodeAt(j - 1) ? 0 : 1);
        const del = dp[(i - 1) * W + j] + 1;
        const ins = dp[i * W + j - 1] + 1;
        dp[i * W + j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
      }
    }
    let i = n, j = m;
    a2b[n] = m;
    while (i > 0) {
      const cur = dp[i * W + j];
      if (j > 0 && i > 0 &&
          cur === dp[(i - 1) * W + j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1)) {
        i--; j--;
      } else if (i > 0 && cur === dp[(i - 1) * W + j] + 1) {
        i--;
      } else {
        j--; continue;
      }
      a2b[i] = j;
    }
    for (let k = 1; k <= n; k++) if (a2b[k] < a2b[k - 1]) a2b[k] = a2b[k - 1];
    return a2b;
  }

  async function buildIndex(flat) {
    const normChars = [];
    const normToRaw = [];
    let nextYield = INDEX_YIELD_EVERY;
    for (let i = 0; i < flat.length; i++) {
      if (i >= nextYield) {
        await new Promise(r => setTimeout(r, 0));
        nextYield = i + INDEX_YIELD_EVERY;
      }
      const n = normChar(flat[i]);
      for (let k = 0; k < n.length; k++) {
        normChars.push(n[k]);
        normToRaw.push(i);
      }
    }
    const map = new Int32Array(normToRaw.length);
    for (let i = 0; i < normToRaw.length; i++) map[i] = normToRaw[i];
    return { normFlat: normChars.join(''), normToRaw: map };
  }

  // ── fuzzy substring search (Sellers: match anywhere in the window) ───────
  //
  // DP over needle (rows) × window (cols) where starting anywhere in the
  // window is free (row 0 = all zeros) and the end is the min of the last
  // row. Start positions are carried through the DP so the matched range
  // comes out directly — no second backward pass. Buffers are module-level
  // and grown on demand to avoid per-call allocation churn.
  let _bufA = null, _bufB = null, _bufSA = null, _bufSB = null;
  function _buffers(size) {
    if (!_bufA || _bufA.length < size) {
      _bufA = new Int32Array(size); _bufB = new Int32Array(size);
      _bufSA = new Int32Array(size); _bufSB = new Int32Array(size);
    }
    return [_bufA, _bufB, _bufSA, _bufSB];
  }

  function fuzzyFind(normFlat, lo, hi, needle) {
    const W = hi - lo, L = needle.length;
    if (W < L || L < 1) return null;
    let [prev, cur, prevS, curS] = _buffers(W + 1);
    for (let j = 0; j <= W; j++) { prev[j] = 0; prevS[j] = j; }
    for (let i = 1; i <= L; i++) {
      cur[0] = i; curS[0] = 0;
      const nc = needle.charCodeAt(i - 1);
      for (let j = 1; j <= W; j++) {
        let d = prev[j - 1] + (normFlat.charCodeAt(lo + j - 1) === nc ? 0 : 1);
        let s = prevS[j - 1];
        const del = prev[j] + 1;
        if (del < d) { d = del; s = prevS[j]; }
        const ins = cur[j - 1] + 1;
        if (ins < d) { d = ins; s = curS[j - 1]; }
        cur[j] = d; curS[j] = s;
      }
      let t = prev; prev = cur; cur = t;
      t = prevS; prevS = curS; curS = t;
    }
    let bj = -1, bd = Infinity;
    for (let j = 0; j <= W; j++) {
      if (prev[j] < bd) { bd = prev[j]; bj = j; }
    }
    if (bj < 0 || prevS[bj] >= bj) return null;
    return { ns: lo + prevS[bj], ne: lo + bj, dist: bd };
  }

  // A norm position is a "clean boundary" when stripped chars (punctuation /
  // whitespace) sit between it and the previous norm char in the raw text —
  // i.e. the book itself marks a break there. Audiobook cue splits land on
  // sentence punctuation, so fuzzy-match boundaries (blurred by edge
  // corruption) snap to the nearest clean boundary within ±3 chars.
  function isCleanBoundary(st, p) {
    if (p <= 0 || p >= st.normToRaw.length) return true;
    return st.normToRaw[p] > st.normToRaw[p - 1] + 1;
  }
  function snapBoundary(st, p) {
    if (isCleanBoundary(st, p)) return p;
    for (let d = 1; d <= 3; d++) {
      if (p - d >= 0 && isCleanBoundary(st, p - d)) return p - d;
      if (p + d <= st.normToRaw.length && isCleanBoundary(st, p + d)) return p + d;
    }
    return p;
  }

  // ── anchors (time-sorted confirmed matches) ──────────────────────────────

  function anchorNeighbors(anchors, ms) {
    // Binary search: prev = last anchor with ms <= target, next = the one after.
    let lo = 0, hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].ms <= ms) lo = mid + 1; else hi = mid;
    }
    return { prev: lo > 0 ? anchors[lo - 1] : null, next: lo < anchors.length ? anchors[lo] : null, at: lo };
  }

  function charRate(st) {
    const a = st.anchors;
    if (a.length >= 2) {
      const span = a[a.length - 1].ms - a[0].ms;
      if (span > 60000) {
        const r = (a[a.length - 1].ne - a[0].ns) / span;
        if (r > 0.001 && r < 0.05) return r;
      }
    }
    return RATE_FALLBACK;
  }

  // Expected norm position + hard bounds + confidence for a cue at `ms`.
  function expectedPos(st, ms) {
    const N = st.normFlat.length;
    const { prev, next } = anchorNeighbors(st.anchors, ms);
    let exp;
    if (prev && next && next.ms > prev.ms) {
      const t = (ms - prev.ms) / (next.ms - prev.ms);
      exp = prev.ne + t * Math.max(0, next.ns - prev.ne);
    } else if (prev) {
      exp = prev.ne + (ms - prev.ms) * charRate(st);
    } else if (next) {
      exp = next.ns - (next.ms - ms) * charRate(st);
    } else {
      const dur = st.getDurMs ? st.getDurMs() : 0;
      exp = dur > 0 ? (ms / dur) * N : 0;
    }
    exp = Math.max(0, Math.min(N, Math.round(exp)));
    const lo = prev ? Math.max(0, prev.ne - BOUND_SLACK) : 0;
    const hi = next ? Math.min(N, next.ns + BOUND_SLACK) : N;
    const tight = !!((prev && ms - prev.ms < 60000) || (prev && next));
    return { exp, lo, hi, tight, first: !st.anchors.length };
  }

  function insertAnchor(st, ms, ns, ne) {
    const { at } = anchorNeighbors(st.anchors, ms);
    st.anchors.splice(at, 0, { ms, ns, ne });
  }

  // ── display text: raw slice + boundary expansion + whitespace cleanup ────

  // Raw slice + boundary expansion + whitespace cleanup, built char-by-char
  // so an optional bookRaw-index → output-index map can be recorded for
  // word-timing projection. Whitespace runs collapse to nothing between CJK
  // neighbors, a single space inside Latin runs, nothing at the edges.
  function displaySlice(st, ns, ne, wantMap) {
    const flat = st.flat;
    let rs = st.normToRaw[ns];
    let re = ne < st.normToRaw.length ? st.normToRaw[ne] : flat.length;
    // Pull in the book's own opening quotes / closing punctuation so the cue
    // reads like the printed line. Normalization strips these anyway, so the
    // later exact re-match in cue-alignment.js is unaffected.
    let n = 0;
    while (rs > 0 && n < 3 && OPEN_SET.indexOf(flat[rs - 1]) >= 0) { rs--; n++; }
    n = 0;
    while (re < flat.length && n < 4 && CLOSE_SET.indexOf(flat[re]) >= 0) { re++; n++; }
    // `re` points at the NEXT cue's first content char, so the raw gap before
    // it (this cue's closing punctuation) is included — but any OPENING
    // bracket at the gap's end belongs to the NEXT cue, whose own start
    // expansion also grabs it. Trim it here or the char renders twice
    // ("…した。「" + "「十九…" → 「「).
    for (;;) {
      let k = re - 1;
      while (k > rs && /\s/.test(flat[k])) k--;
      if (k > rs && OPEN_SET.indexOf(flat[k]) >= 0) { re = k; continue; }
      break;
    }
    const rawToOut = wantMap ? new Int32Array(re - rs + 1) : null;
    let out = '';
    let i = rs;
    while (i < re) {
      const ch = flat[i];
      if (/\s/.test(ch)) {
        let j = i;
        while (j < re && /\s/.test(flat[j])) j++;
        const prev = out.length ? out.charCodeAt(out.length - 1) : 0;
        const next = j < re ? flat.charCodeAt(j) : 0;
        const keep = prev && next && prev <= 0x2fff && next <= 0x2fff;
        if (keep) {
          if (rawToOut) for (let k = i; k < j; k++) rawToOut[k - rs] = out.length;
          out += ' ';
        } else if (rawToOut) {
          for (let k = i; k < j; k++) rawToOut[k - rs] = out.length;
        }
        i = j;
        continue;
      }
      if (rawToOut) rawToOut[i - rs] = out.length;
      out += ch;
      i++;
    }
    if (rawToOut) rawToOut[re - rs] = out.length;
    return wantMap ? { text: out, rs, re, rawToOut } : out;
  }

  // ── the matcher ──────────────────────────────────────────────────────────

  /**
   * Try to match one ASR cue against the book. Returns { text } with the
   * book's own text on success (and records an anchor), null on a miss.
   * With opts.wantMap, also returns wmap: Int32Array(text.length + 1)
   * projecting each ASR char offset onto the returned display text —
   * used to carry per-word timings across the substitution.
   * Synchronous; typical cost is sub-ms (exact hit), worst ~10-15ms (long
   * cue through the pass-2 DP).
   */
  function matchCue(text, startMs, opts) {
    const st = state;
    if (!st || st.disabled || !st.normFlat) return null;
    const retry = !!(opts && opts.retry);
    let needle = normalizeStr(text);
    if (needle.length > MAX_NEEDLE) needle = needle.slice(0, MAX_NEEDLE);
    const ctx = expectedPos(st, startMs);
    const strict = ctx.first || !ctx.tight;
    const minExact = strict ? 8 : 4;
    const minFuzzy = strict ? 10 : 6;
    const maxRatio = strict ? LOOSE_DIST_RATIO : TIGHT_DIST_RATIO;
    if (needle.length < minExact) return null;
    if (!retry) st.tried++;

    let hit = null;
    // No anchors yet (fresh book, or restart where seeding found nothing):
    // a long cue that exactly matches a UNIQUE passage anywhere in the book
    // is a safe first anchor even when the ratio estimate is far off.
    if (ctx.first && needle.length >= 12) {
      const i1 = st.normFlat.indexOf(needle);
      if (i1 >= 0 && st.normFlat.indexOf(needle, i1 + 1) < 0) {
        hit = { ns: i1, ne: i1 + needle.length };
      }
    }
    for (const half of hit ? [] : [PASS1_HALF, PASS2_HALF]) {
      const lo = Math.max(ctx.lo, ctx.exp - half);
      const hi = Math.min(ctx.hi, ctx.exp + half + needle.length);
      if (hi - lo < needle.length) continue;
      const idx = st.normFlat.indexOf(needle, lo);
      if (idx >= 0 && idx + needle.length <= hi) {
        // Exact hit: boundaries are authoritative, no snapping.
        hit = { ns: idx, ne: idx + needle.length };
        break;
      }
      if (needle.length >= minFuzzy) {
        const r = fuzzyFind(st.normFlat, lo, hi, needle);
        if (r && r.dist <= Math.floor(needle.length * maxRatio)) {
          hit = { ns: snapBoundary(st, r.ns), ne: snapBoundary(st, r.ne) };
          break;
        }
      }
    }

    if (!hit) {
      _maybeDisable(st);
      return null;
    }
    // Tiling heal: edge corruption shifts a fuzzy match's boundaries by a
    // char or two. When the time-adjacent anchors are also text-adjacent,
    // snap tiny gaps closed and clip overlaps so consecutive cues tile the
    // book exactly (each char shown once). Real content gaps (unmatched
    // cues in between) are far larger than the 4-char snap limit.
    const nb = anchorNeighbors(st.anchors, startMs);
    if (nb.prev && hit.ns !== nb.prev.ne &&
        (hit.ns < nb.prev.ne || hit.ns - nb.prev.ne <= 4)) hit.ns = nb.prev.ne;
    if (nb.next && hit.ne !== nb.next.ns &&
        (hit.ne > nb.next.ns || nb.next.ns - hit.ne <= 4)) hit.ne = nb.next.ns;
    if (hit.ne - hit.ns < 2) { _maybeDisable(st); return null; }
    if (!(opts && opts.wantMap)) {
      const out = displaySlice(st, hit.ns, hit.ne);
      if (!out) { _maybeDisable(st); return null; }   // no anchor without a usable slice
      st.matched++;
      insertAnchor(st, startMs, hit.ns, hit.ne);
      return { text: out };
    }
    // Word-timing projection: ASR raw index → ASR norm (normalizeStrMapped)
    // → matched book norm (charAlign, identity on an exact hit) → book raw
    // (normToRaw) → display-text index (displaySlice's rawToOut).
    const d = displaySlice(st, hit.ns, hit.ne, true);
    if (!d.text) { _maybeDisable(st); return null; }
    const nm = normalizeStrMapped(text);
    let asrNorm = nm.norm;
    if (asrNorm.length > MAX_NEEDLE) asrNorm = asrNorm.slice(0, MAX_NEEDLE);
    const sliceNorm = st.normFlat.slice(hit.ns, hit.ne);
    const a2b = (asrNorm === sliceNorm) ? null : charAlign(asrNorm, sliceNorm);
    const wmap = new Int32Array(text.length + 1);
    for (let k = 0; k <= text.length; k++) {
      let p = nm.rawToNorm[k];
      if (p > asrNorm.length) p = asrNorm.length;
      const q = a2b ? a2b[p] : p;
      const gnorm = hit.ns + q;
      const braw = gnorm < st.normToRaw.length ? st.normToRaw[gnorm] : st.flat.length;
      let oi = braw - d.rs;
      if (oi < 0) oi = 0;
      if (oi > d.rawToOut.length - 1) oi = d.rawToOut.length - 1;
      wmap[k] = d.rawToOut[oi];
    }
    for (let k = 1; k <= text.length; k++) if (wmap[k] < wmap[k - 1]) wmap[k] = wmap[k - 1];
    st.matched++;
    insertAnchor(st, startMs, hit.ns, hit.ne);
    return { text: d.text, wmap };
  }

  // Rebuild the anchor lattice from already-matched (b:1) cues after a
  // restart — their text IS book text, so exact forward search re-places
  // them instantly. Without this a mid-book resume would have to re-anchor
  // from the ratio estimate alone. Cues must be time-sorted (they are).
  function seedFromCues(cues) {
    const st = state;
    if (!st || st.disabled || !Array.isArray(cues) || !cues.length) return 0;
    let lastNe = 0, seeded = 0;
    const step = Math.max(1, Math.floor(cues.length / 200));
    for (let i = 0; i < cues.length; i += step) {
      const c = cues[i];
      if (!c || !c.b || !c.text || !Number.isFinite(c.startMs)) continue;
      const needle = normalizeStr(c.text);
      if (needle.length < 8) continue;
      const p = st.normFlat.indexOf(needle, lastNe);   // forward-monotonic by construction
      if (p < 0) continue;
      insertAnchor(st, c.startMs, p, p + needle.length);
      lastNe = p + needle.length;
      seeded++;
    }
    if (seeded) log('seeded ' + seeded + ' anchors from matched cues');
    return seeded;
  }

  function _maybeDisable(st) {
    if (!st.disabled && st.tried >= DISABLE_AFTER && st.matched / st.tried < DISABLE_BELOW) {
      st.disabled = true;
      log('disabled for this title: ' + st.matched + '/' + st.tried +
          ' matched — book text does not track this audio (abridged/different edition?)');
    }
  }

  // ── sweep: re-try cues that failed while anchors were sparse ─────────────
  //
  // A cue that missed early often succeeds later once neighbors matched and
  // its window tightened. Each cue re-runs only when its expected position
  // or bound width moved meaningfully since the last attempt, with a hard
  // per-cue attempt cap. Mutates matched cues in place ({ text, b:1 }) and
  // returns how many changed — the caller owns the downstream refresh.
  // Project word-timing quads [off, len, relS, relE] through a matchCue wmap
  // onto the substituted display text. Words that vanish in the alignment
  // (deleted ASR chars) are dropped; the highlight simply skips them.
  function remapW(w, wmap, outLen) {
    if (!w || !wmap) return null;
    const out = [];
    for (let i = 0; i + 3 < w.length; i += 4) {
      let a = w[i], b = w[i] + w[i + 1];
      if (a >= wmap.length) a = wmap.length - 1;
      if (b >= wmap.length) b = wmap.length - 1;
      const na = wmap[a], nb = Math.min(outLen, wmap[b]);
      if (nb > na) out.push(na, nb - na, w[i + 2], w[i + 3]);
    }
    return out.length ? out : null;
  }

  const ATTEMPT_CAP = 5;
  async function sweep(cues) {
    const st = state;
    if (!st || st.disabled || !Array.isArray(cues) || !cues.length) return 0;
    let changed = 0, work = 0;
    for (let i = 0; i < cues.length; i++) {
      if (state !== st || st.disabled) break;
      const c = cues[i];
      if (!c || c.b || !c.text || !Number.isFinite(c.startMs)) continue;
      const att = c._aa || (c._aa = { n: 0, exp: -1, bw: -1 });
      if (att.n >= ATTEMPT_CAP) continue;
      const ctx = expectedPos(st, c.startMs);
      const bw = ctx.hi - ctx.lo;
      const moved = att.exp < 0 || Math.abs(ctx.exp - att.exp) > 400 || (att.bw - bw) > 400;
      if (att.n >= 1 && !moved) continue;
      att.n++; att.exp = ctx.exp; att.bw = bw;
      const m = matchCue(c.text, c.startMs, { retry: att.n > 1, wantMap: !!c.w });
      if (m) {
        if (c.w) {
          const nw = remapW(c.w, m.wmap, m.text.length);
          if (nw) c.w = nw; else delete c.w;   // stale offsets must never survive a text swap
        }
        c.text = m.text; c.b = 1; changed++;
      }
      if (++work % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return changed;
  }

  // ── book text acquisition ────────────────────────────────────────────────
  //
  // Cheapest source first: the AI flat-text cache, then the rendered-HTML
  // cache, then a direct parse of the read-source attachment (covers a
  // fresh import that has never been opened in read mode). Coordinates are
  // internal to this module, so the sources don't need to agree char-for-
  // char with the readers' canonical flat space.

  async function _textFromAitext(titleId) {
    try {
      const raw = await window.blobStore?.get('AITEXT_V1_' + titleId);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && obj.v === 1 && typeof obj.raw === 'string' && obj.raw.length) ? obj.raw : null;
    } catch (_) { return null; }
  }

  function _htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('rt, rp, style, script').forEach(el => el.remove());
    const body = doc.body || doc.documentElement;
    return body ? body.textContent || '' : '';
  }

  async function _textFromReadHtml(titleId) {
    try {
      const raw = await window.blobStore?.get('READ_HTML_V1_' + titleId);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.html !== 'string' || !obj.html) return null;
      return _htmlToText(obj.html) || null;
    } catch (_) { return null; }
  }

  function _stripAozora(text) {
    return String(text || '')
      .replace(/［＃[^］]*］/g, '')
      .replace(/｜([^《》｜\n]+)《[^《》\n]*》/g, '$1')
      .replace(/([一-鿿々〆ヶ]+)《[^《》\n]*》/g, '$1');
  }

  async function _textFromAttachment(titleId) {
    try {
      const list = await window.titleStore?.list();
      const at = list?.find(x => x.id === titleId)?.attachments?.epub;
      if (!at) return null;
      let path = null;
      if (at.uri) {
        try { path = (await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri: at.uri })).path; }
        catch (_) { path = at.cachePath || null; }
      } else {
        path = at.cachePath || null;
      }
      if (!path) return null;
      const resp = await fetch(window.Capacitor.convertFileSrc(path));
      if (!resp.ok) return null;
      if (/\.txt$/i.test(at.name || '') || /\.txt$/i.test(String(at.uri || at.cachePath || ''))) {
        return _stripAozora(await resp.text());
      }
      const zip = await JSZip.loadAsync(await resp.blob());
      const containerXml = await zip.file('META-INF/container.xml')?.async('string');
      if (!containerXml) return null;
      // UTF-8 BOM strip — iOS WebKit's XML parser fails on content before <?xml.
      const deBom = (s) => (s ? s.replace(/^\uFEFF+/, '') : s);
      const opfPath = new DOMParser().parseFromString(deBom(containerXml), 'application/xml')
        .querySelector('rootfile')?.getAttribute('full-path');
      if (!opfPath) return null;
      const opfDoc = new DOMParser().parseFromString(deBom(await zip.file(opfPath).async('string')), 'application/xml');
      const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
      const manifest = {};
      opfDoc.querySelectorAll('manifest > item').forEach(item => {
        manifest[item.getAttribute('id')] = item.getAttribute('href');
      });
      const spine = [...opfDoc.querySelectorAll('spine > itemref')]
        .map(ref => manifest[ref.getAttribute('idref')])
        .filter(Boolean);
      let acc = '';
      for (const href of spine) {
        const f = zip.file(opfDir + href) || zip.file(decodeURIComponent(opfDir + href));
        if (!f) continue;
        acc += _htmlToText(await f.async('string')) + '\n';
      }
      return acc.length ? acc : null;
    } catch (e) {
      log('attachment parse failed: ' + (e?.message || e));
      return null;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  // Test seam + shared tail of prepare(): adopt a book text string directly.
  async function _adoptText(titleId, flat, opts) {
    const idx = await buildIndex(flat);
    state = {
      titleId, flat,
      normFlat: idx.normFlat, normToRaw: idx.normToRaw,
      anchors: [], tried: 0, matched: 0, disabled: false,
      getDurMs: (opts && opts.getDurMs) || null
    };
    log('ready: ' + flat.length + ' raw / ' + idx.normFlat.length + ' norm chars for ' + titleId);
    return true;
  }

  async function prepare(titleId, opts) {
    if (!titleId) return false;
    if (state && state.titleId === titleId && state.normFlat) return !state.disabled;
    if (preparing && preparing.titleId === titleId) return preparing.p;
    const p = (async () => {
      const flat = (await _textFromAitext(titleId)) ||
                   (await _textFromReadHtml(titleId)) ||
                   (await _textFromAttachment(titleId));
      if (!flat || flat.length < 500) { log('no usable book text for ' + titleId); return false; }
      return _adoptText(titleId, flat, opts);
    })();
    preparing = { titleId, p };
    try { return await p; } finally { if (preparing && preparing.p === p) preparing = null; }
  }

  function release() { state = null; }

  function readyFor(titleId) {
    return !!(state && state.titleId === titleId && state.normFlat && !state.disabled);
  }

  function stats() {
    return state ? { titleId: state.titleId, tried: state.tried, matched: state.matched,
      anchors: state.anchors.length, disabled: state.disabled } : null;
  }

  // Inverse of progressAt: audio ms for a book fraction (0..1). Anchor-
  // interpolated in norm space; pre-anchor / no-anchor falls back to the
  // uniform duration ratio. Null when unavailable. Used to TIME-BOUND the
  // reader's tap→cue text matching (identical phrase text elsewhere in the
  // book used to win and seek the audio to a random position).
  function msForProgress(ratio) {
    const st = state;
    if (!st || !st.normFlat || !st.normFlat.length || !(ratio >= 0)) return null;
    const np = Math.max(0, Math.min(st.normFlat.length, ratio * st.normFlat.length));
    const a = st.anchors;
    if (!a.length) {
      const dur = st.getDurMs ? st.getDurMs() : 0;
      return dur > 0 ? (np / st.normFlat.length) * dur : null;
    }
    let lo = 0, hi = a.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].ns <= np) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (k < 0) return Math.max(0, a[0].ms - (a[0].ns - np) / charRate(st));
    const p = a[k];
    if (np <= p.ne) return p.ms;
    const n = (k + 1 < a.length) ? a[k + 1] : null;
    if (n && n.ns > p.ne) {
      return p.ms + ((np - p.ne) / (n.ns - p.ne)) * (n.ms - p.ms);
    }
    return p.ms + (np - p.ne) / charRate(st);
  }

  // Fraction of the book (raw chars, 0..1) the audio position `ms` maps to.
  // Anchor-interpolated, so frontmatter/TOC the narrator skips is accounted
  // for automatically — this is NOT a uniform time ratio (that's only the
  // seed before any anchors exist). Null when no book text is loaded. Used
  // by the paged reader to BOUND its cue-text search (a book-wide first
  // match on a short phrase cue used to teleport the highlight mid-book).
  function progressAt(ms) {
    const st = state;
    if (!st || !st.normFlat || !st.normFlat.length || !Number.isFinite(ms)) return null;
    const ctx = expectedPos(st, ms);
    const raw = ctx.exp < st.normToRaw.length ? st.normToRaw[ctx.exp] : st.flat.length;
    return Math.max(0, Math.min(1, raw / st.flat.length));
  }

  window.autoAlign = {
    prepare,      // async (titleId, {getDurMs}) → bool (book text indexed)
    release,
    readyFor,     // sync gate used by the merge hot path
    matchCue,     // sync (text, startMs, {retry}) → {text} | null
    sweep,        // async (cues) → changed count; mutates {text, b:1} in place
    remapW,       // project word-timing quads through a matchCue wmap
    seedFromCues, // rebuild anchors from persisted b:1 cues after a restart
    progressAt,   // (ms) → anchor-interpolated book fraction 0..1, or null
    msForProgress,// (ratio 0..1) → anchor-interpolated audio ms, or null
    textLen: () => (state && state.flat) ? state.flat.length : 0,  // full raw book chars (render-independent)
    stats,
    _internals: { normalizeStr, fuzzyFind, _adoptText, expectedPos: (ms) => state && expectedPos(state, ms) }
  };
})();
