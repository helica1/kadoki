// cue-alignment.js — Renderer-agnostic SRT-to-EPUB preprocessing.
//
// Builds a stable, persistable cue→character-range alignment once per
// (epub, srt) pair, then exposes a renderer-local cue→chunk derivation
// for both readers (paged + legacy). The alignment is computed in the
// FLAT-TEXT coordinate space — the EPUB body text with whitespace
// preserved and ruby (rt/rp) readings stripped — which matches the
// space both readers use for `dataset.charOffset` / `dataset.charLen`.
//
// Why a dedicated module? The legacy in-line buildCueChunkMaps did
// unbounded forward-cursor matching with a global fallback, so short
// common cues ("うん", "そうか") could leap to the wrong chapter, drag
// the cursor with them, and cascade misalignments downstream. See
// [[reference-paged-reader-scroll-blackout]] and
// [[reference-ttu-whispersync-algorithm]] for the diagnosis. This
// module implements the ttu-whispersync approach: forward-only cursor
// + bounded look-ahead window, no global fallback — unmatched cues
// stay unmatched, the cursor never leaps.
//
// Inputs are SRT-from-EPUB pairs (cue text is a literal substring of
// the source EPUB), so the matcher uses normalized `indexOf` rather
// than Sørensen-Dice. If/when fuzzy SRTs become a thing, swap in a
// similarity scorer inside the window — the surrounding cursor logic
// stays the same.
//
// Persistence: the computed alignment is cached per-title in a
// dedicated Capacitor Preferences key (CUE_ALIGN_v<n>_<titleId>) so
// the next session skips the ~few-second matching phase. The cache
// is invalidated automatically when the (epubName, srtName, cueCount,
// totalChars) fingerprint changes.

(function () {
  'use strict';

  // Bumped to v2: algorithm changed (initial-anchor full scan +
  // adaptive window growth). v1 caches would alias to a worse mapping,
  // so invalidate them via the schema version baked into the pref key.
  const SCHEMA_VERSION = 2;
  // Forward look-ahead window in NORMALIZED chars per cue once anchored.
  // ~2000 is ~2-3 paragraphs of dense Japanese prose — plenty for an SRT
  // cue that follows the prior one, far too narrow for a short cue to
  // jump chapters. Tunable if real-world data needs it.
  const DEFAULT_WINDOW_CHARS = 2000;
  // Min normalized length for the FIRST anchor cue. Audiobook intros
  // ("Penguin Random House presents...") often contain stray short
  // tokens that happen to match somewhere in the EPUB cover/front
  // matter — anchoring on those puts the cursor in the wrong place
  // forever. Require the first anchoring cue to carry at least this
  // many normalized chars so we anchor on something substantive.
  const INITIAL_ANCHOR_MIN_LEN = 5;
  // When matching has anchored but the cursor stalls (consecutive
  // misses), grow the next cue's window by this factor per miss, up
  // to MAX_WINDOW_CHARS. This handles mid-book discontinuities:
  // chapter-transition narrator lines that aren't in the EPUB,
  // illustration captions, etc. Resets to DEFAULT_WINDOW_CHARS on
  // the next successful match.
  const MISS_GROWTH_FACTOR = 2;
  const MAX_WINDOW_CHARS = 50000;
  // If matched rate is below this fraction, the caller should treat
  // the alignment as unreliable and fall back. Empirical guess; the
  // user's working titles match >95% so anything way under that
  // indicates a real EPUB/SRT mismatch, not an algorithm fault.
  const MIN_MATCHED_RATIO = 0.30;
  // Yield to the event loop every this many cues during the cue loop,
  // and every this many flat-text chars during the normFlat build, to
  // keep the WebView main thread responsive on large books. Empirical
  // — 256 cues ≈ 5-10ms work, 4000 chars ≈ 5-10ms; we want yields
  // ~every 16ms so the WebView gets a chance to paint at ~60fps.
  const CUE_YIELD_EVERY = 256;
  const CHAR_YIELD_EVERY = 4000;

  // Shared normalizer. NFKC handles halfwidth↔fullwidth; lowercase
  // handles any embedded Latin runs. Strip whitespace + the JP/EN
  // punctuation both readers strip in their own normalizers. The
  // output of this function is the canonical form used everywhere
  // matching happens.
  function defaultNormalize(s) {
    if (!s) return '';
    return s.normalize('NFKC')
      .replace(/[\s　「」『』、。・…！？!?,.;:""'']/g, '')
      .toLowerCase();
  }

  // Char-class predicate used when walking the raw flat text to keep
  // a parallel norm→raw index map. MUST agree with defaultNormalize's
  // strip set, otherwise the map drifts and matches paint the wrong
  // raw range.
  const STRIP_RE = /[\s　「」『』、。・…！？!?,.;:""'']/;

  // ---------- Core matcher ----------

  /**
   * Build a cue alignment between an SRT cue list and a flat EPUB
   * text. The flat text is the EPUB body text with whitespace kept
   * and ruby readings stripped — the same coordinate space readers
   * use for their per-chunk `dataset.charOffset`.
   *
   * @param {string} flatText
   * @param {Array<{startMs:number,endMs:number,text:string}>} cues
   * @param {{ windowChars?: number, normalize?: (s:string)=>string }} [opts]
   * @returns {{
   *   schemaVersion: number,
   *   cueCount: number,
   *   matched: number,
   *   matchedRatio: number,
   *   totalChars: number,
   *   // Length = 2 * cueCount. ranges[2i]=startChar, ranges[2i+1]=endChar
   *   // in the RAW flatText (NOT normalized). -1/-1 = unmatched cue.
   *   ranges: Int32Array
   * }}
   */
  function _yield() { return new Promise(r => setTimeout(r, 0)); }

  async function buildAlignment(flatText, cues, opts) {
    opts = opts || {};
    const normalize = opts.normalize || defaultNormalize;
    const windowChars = opts.windowChars || DEFAULT_WINDOW_CHARS;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const n = cues ? cues.length : 0;
    const ranges = new Int32Array(n * 2);
    for (let i = 0; i < ranges.length; i++) ranges[i] = -1;
    const totalChars = flatText ? flatText.length : 0;

    if (!flatText || !n) {
      return { schemaVersion: SCHEMA_VERSION, cueCount: n, matched: 0,
        matchedRatio: 0, totalChars, ranges };
    }

    // ---- Phase 1: normalized flat string + norm→raw index map ----
    // Single pass over the EPUB body text. NFKC may expand a single
    // char into multiple norm chars; we map each output char back to
    // the same raw source index, so the inverse mapping is well-defined
    // for any norm position. Yield periodically so the WebView paints.
    if (onProgress) onProgress({ phase: 'index', current: 0, total: flatText.length });
    const normChars = [];
    const normToRaw = [];
    let nextCharYield = CHAR_YIELD_EVERY;
    for (let i = 0; i < flatText.length; i++) {
      if (i >= nextCharYield) {
        if (onProgress) onProgress({ phase: 'index', current: i, total: flatText.length });
        await _yield();
        nextCharYield = i + CHAR_YIELD_EVERY;
      }
      const ch = flatText[i];
      if (STRIP_RE.test(ch)) continue;
      const nch = ch.normalize('NFKC').toLowerCase();
      for (let k = 0; k < nch.length; k++) {
        normChars.push(nch[k]);
        normToRaw.push(i);
      }
    }
    const normFlat = normChars.join('');
    if (onProgress) onProgress({ phase: 'index', current: flatText.length, total: flatText.length });

    // ---- Phase 2: forward-cursor match with adaptive window ----
    // Two-mode operation:
    //   (a) Pre-anchor: cursor is at 0 and we haven't placed any cue
    //       yet. Each cue scans the entire remaining normFlat (no
    //       window cap). Short cues are SKIPPED (norm length <
    //       INITIAL_ANCHOR_MIN_LEN) so a stray "うん" in the cover or
    //       title page doesn't trap the cursor near the start.
    //   (b) Post-anchor: bounded window with adaptive growth. The
    //       window doubles per consecutive miss (up to
    //       MAX_WINDOW_CHARS), so mid-book discontinuities — chapter
    //       transitions, narrator-only lines, illustration captions —
    //       can be recovered from instead of derailing every
    //       subsequent cue.
    let cursor = 0;
    let matched = 0;
    let anchored = false;
    let consecutiveMisses = 0;
    if (onProgress) onProgress({ phase: 'match', current: 0, total: n });
    for (let i = 0; i < n; i++) {
      if (i > 0 && (i % CUE_YIELD_EVERY) === 0) {
        if (onProgress) onProgress({ phase: 'match', current: i, total: n });
        await _yield();
      }
      const cueText = cues[i] && cues[i].text || '';
      const normCue = normalize(cueText);
      if (!normCue) continue;

      let windowEnd;
      if (!anchored) {
        if (normCue.length < INITIAL_ANCHOR_MIN_LEN) {
          // Don't let a short fragment claim the first anchor.
          continue;
        }
        windowEnd = normFlat.length;
      } else {
        const grown = Math.min(
          MAX_WINDOW_CHARS,
          windowChars * Math.pow(MISS_GROWTH_FACTOR, consecutiveMisses)
        );
        windowEnd = Math.min(normFlat.length, cursor + grown);
      }

      if (windowEnd - cursor < normCue.length) {
        consecutiveMisses++;
        continue;
      }
      const slice = normFlat.slice(cursor, windowEnd);
      const localPos = slice.indexOf(normCue);
      if (localPos < 0) {
        consecutiveMisses++;
        continue;
      }
      const normStart = cursor + localPos;
      const normEnd = normStart + normCue.length;
      const rawStart = normToRaw[normStart];
      const rawEnd = normEnd < normToRaw.length
        ? normToRaw[normEnd]
        : flatText.length;
      if (typeof rawStart !== 'number' || rawStart < 0) {
        consecutiveMisses++;
        continue;
      }
      ranges[i * 2]     = rawStart;
      ranges[i * 2 + 1] = rawEnd;
      matched++;
      cursor = normEnd;
      anchored = true;
      consecutiveMisses = 0;
    }
    if (onProgress) onProgress({ phase: 'match', current: n, total: n });

    return {
      schemaVersion: SCHEMA_VERSION,
      cueCount: n,
      matched,
      matchedRatio: n ? matched / n : 0,
      totalChars,
      ranges
    };
  }

  /**
   * Derive a renderer-local cue→chunk and chunk→cue map from the
   * renderer-agnostic alignment plus the chunks each reader rendered.
   * Each chunk must carry `dataset.charOffset` (raw start index in the
   * same flat text used to build the alignment); `dataset.charLen`
   * isn't needed here because we walk in lockstep.
   *
   * @param {ReturnType<typeof buildAlignment>} alignment
   * @param {Array<HTMLElement>} chunks
   * @returns {{ cueToChunk: Int32Array, chunkToCue: Int32Array }}
   */
  function buildCueToChunk(alignment, chunks) {
    const n = alignment ? alignment.cueCount : 0;
    const m = chunks ? chunks.length : 0;
    const cueToChunk = new Int32Array(n).fill(-1);
    const chunkToCue = new Int32Array(m).fill(-1);
    if (!n || !m) return { cueToChunk, chunkToCue };

    // Both arrays are in source order (cues by SRT order, chunks by
    // DOM order). Walk them in lockstep — O(n + m).
    let chunkIdx = 0;
    for (let i = 0; i < n; i++) {
      const startChar = alignment.ranges[i * 2];
      if (startChar < 0) continue;
      // Advance chunkIdx forward while the NEXT chunk's start is still
      // ≤ this cue's startChar — i.e., this cue belongs in chunkIdx or
      // later, not the one we're currently on.
      while (chunkIdx < m - 1) {
        const next = chunks[chunkIdx + 1];
        const nextOff = parseInt(next.dataset.charOffset || '0', 10);
        if (nextOff > startChar) break;
        chunkIdx++;
      }
      cueToChunk[i] = chunkIdx;
      if (chunkToCue[chunkIdx] < 0) chunkToCue[chunkIdx] = i;
    }
    return { cueToChunk, chunkToCue };
  }

  /**
   * Concat chunks' ruby-stripped textContent in DOM order. The result
   * is byte-for-byte (well, char-for-char) the same as what each
   * reader's chunk char-offset table indexes into — so the alignment
   * built on this string maps directly back onto chunks via their
   * `dataset.charOffset`.
   */
  function extractFlatText(chunks) {
    if (!chunks || !chunks.length) return '';
    let acc = '';
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      // Walk text nodes ourselves, skipping rt/rp — cheaper than cloning
      // the subtree for every chunk on a 3000-chunk book.
      const walker = document.createTreeWalker(ch, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          let p = n.parentNode;
          while (p && p !== ch) {
            if (p.tagName === 'RT' || p.tagName === 'RP') return NodeFilter.FILTER_REJECT;
            p = p.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) acc += n.nodeValue || '';
    }
    return acc;
  }

  // ---------- Persistence ----------

  /**
   * Fingerprint inputs that should invalidate a cached alignment.
   * EPUB and SRT names + cue count + total chars catch the common
   * cases (renamed file, re-encoded SRT, edited EPUB). Schema version
   * is bumped manually if the algorithm or output shape changes.
   */
  function computeFingerprint(opts) {
    const parts = [
      'v' + SCHEMA_VERSION,
      opts.epubName || '',
      opts.srtName || '',
      'cc=' + (opts.cueCount | 0),
      'tc=' + (opts.totalChars | 0)
    ];
    return parts.join('|');
  }

  function prefKeyFor(titleId) {
    return 'CUE_ALIGN_v' + SCHEMA_VERSION + '_' + (titleId || 'default');
  }

  // Alignment caches live in IndexedDB via blobStore, NOT Capacitor
  // Preferences: at ~10k cues a serialized alignment is hundreds of KB per
  // title, and Preferences rewrites its ENTIRE store on every set() — so
  // these blobs were taxing every tiny position save with a multi-MB flash
  // rewrite (battery audit 2026-06-10). Reads fall back to the legacy
  // Preferences key (pre-sweep installs; blob-store.js migrates + deletes
  // them at boot); writes go to IndexedDB, degrading to Preferences only
  // if IndexedDB is broken so a computed alignment is never just dropped.
  async function _getPref(key) {
    try {
      const v = await window.blobStore?.get?.(key);
      if (v) return v;
    } catch (e) {}
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        const r = await window.Capacitor.Plugins.Preferences.get({ key });
        return r.value;
      }
      return localStorage.getItem(key);
    } catch (e) { return null; }
  }
  async function _setPref(key, value) {
    try {
      await window.blobStore.set(key, String(value));
      return;
    } catch (e) {}
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
      } else {
        localStorage.setItem(key, String(value));
      }
    } catch (e) {}
  }
  async function _removePref(key) {
    try { await window.blobStore?.remove?.(key); } catch (e) {}
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.remove({ key });
      } else {
        localStorage.removeItem(key);
      }
    } catch (e) {}
  }

  function serializeAlignment(a, fingerprint) {
    const arr = new Array(a.cueCount * 2);
    for (let i = 0; i < arr.length; i++) arr[i] = a.ranges[i];
    return {
      schemaVersion: a.schemaVersion,
      fingerprint: fingerprint || '',
      cueCount: a.cueCount,
      matched: a.matched,
      matchedRatio: a.matchedRatio,
      totalChars: a.totalChars,
      ranges: arr
    };
  }
  function deserializeAlignment(obj) {
    if (!obj || obj.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(obj.ranges)) return null;
    if (obj.ranges.length !== obj.cueCount * 2) return null;
    const ranges = new Int32Array(obj.cueCount * 2);
    for (let i = 0; i < ranges.length; i++) ranges[i] = obj.ranges[i] | 0;
    return {
      schemaVersion: obj.schemaVersion,
      cueCount: obj.cueCount,
      matched: obj.matched | 0,
      matchedRatio: obj.matchedRatio || 0,
      totalChars: obj.totalChars | 0,
      ranges
    };
  }

  async function saveAlignment(titleId, alignment, fingerprint) {
    if (!titleId || !alignment) return;
    const blob = JSON.stringify(serializeAlignment(alignment, fingerprint));
    await _setPref(prefKeyFor(titleId), blob);
  }

  async function loadAlignment(titleId, fingerprint) {
    if (!titleId) return null;
    const raw = await _getPref(prefKeyFor(titleId));
    if (!raw) return null;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (fingerprint && obj.fingerprint !== fingerprint) return null;
    return deserializeAlignment(obj);
  }

  async function clearAlignment(titleId) {
    if (!titleId) return;
    await _removePref(prefKeyFor(titleId));
  }

  // ---------- High-level convenience ----------

  /**
   * Load a cached alignment for this (title, epub, srt) tuple if the
   * fingerprint matches; otherwise compute one from chunks + cues and
   * persist it. Returns the alignment plus a `cached` flag for logging.
   *
   * Caller is responsible for deciding what to do when matchedRatio
   * is below MIN_MATCHED_RATIO — typically: log a warning and fall
   * back to srtParser.buildCueChunkMaps for this session.
   */
  async function loadOrBuild(opts) {
    const { titleId, epubName, srtName, chunks, cues, windowChars, onProgress } = opts || {};
    const flatText = extractFlatText(chunks);
    const fp = computeFingerprint({
      epubName: epubName || '',
      srtName:  srtName  || '',
      cueCount: cues ? cues.length : 0,
      totalChars: flatText.length
    });
    if (titleId) {
      const hit = await loadAlignment(titleId, fp);
      if (hit) return { alignment: hit, cached: true, fingerprint: fp };
    }
    const alignment = await buildAlignment(flatText, cues, { windowChars, onProgress });
    if (titleId && alignment.matchedRatio >= MIN_MATCHED_RATIO) {
      // Only cache when the result is plausibly useful. Bad alignments
      // shouldn't get re-served from cache on the next launch.
      try { await saveAlignment(titleId, alignment, fp); } catch (e) {}
    }
    return { alignment, cached: false, fingerprint: fp };
  }

  // ---------- Blocking progress overlay ----------
  //
  // Self-contained modal shown during a fresh (uncached) alignment so
  // the user knows the app isn't crashed while the matcher works. Two
  // phases the caller can report on: 'index' (building normalized flat
  // text) and 'match' (running the cue loop). Idempotent — calling
  // showProgress while another is open closes the prior one first.
  let _activeOverlay = null;

  function _ensureOverlayStyles() {
    if (document.getElementById('cueAlignOverlayStyles')) return;
    const s = document.createElement('style');
    s.id = 'cueAlignOverlayStyles';
    s.textContent = `
      #cueAlignOverlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.78);
        z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
        color: #e8e8e8;
        padding: env(safe-area-inset-top, 0) 20px env(safe-area-inset-bottom, 0);
        box-sizing: border-box;
      }
      #cueAlignOverlay .card {
        background: #181818;
        border: 1px solid #303030;
        border-radius: 14px;
        padding: 28px 32px;
        min-width: 280px;
        max-width: 90vw;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        text-align: center;
      }
      #cueAlignOverlay .title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 6px;
        letter-spacing: 0.3px;
      }
      #cueAlignOverlay .sub {
        font-size: 13px;
        color: #9a9a9a;
        margin-bottom: 18px;
      }
      #cueAlignOverlay .bar {
        position: relative;
        height: 6px;
        background: #2a2a2a;
        border-radius: 3px;
        overflow: hidden;
      }
      #cueAlignOverlay .fill {
        position: absolute; inset: 0;
        width: 0%;
        background: #6fb9ff;
        border-radius: 3px;
        transition: width 120ms linear;
      }
      #cueAlignOverlay .count {
        margin-top: 10px;
        font-size: 12px;
        color: #707070;
        font-variant-numeric: tabular-nums;
      }
    `;
    document.head.appendChild(s);
  }

  function showProgress(opts) {
    opts = opts || {};
    if (_activeOverlay) { try { _activeOverlay.close(); } catch (e) {} }
    _ensureOverlayStyles();
    const el = document.createElement('div');
    el.id = 'cueAlignOverlay';
    el.innerHTML =
      '<div class="card">' +
        '<div class="title"></div>' +
        '<div class="sub"></div>' +
        '<div class="bar"><div class="fill"></div></div>' +
        '<div class="count"></div>' +
      '</div>';
    el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    el.addEventListener('click', e => e.stopPropagation());
    document.body.appendChild(el);
    const titleEl = el.querySelector('.title');
    const subEl   = el.querySelector('.sub');
    const fillEl  = el.querySelector('.fill');
    const countEl = el.querySelector('.count');
    titleEl.textContent = opts.title || 'Preparing book';
    subEl.textContent   = opts.sub   || 'Aligning subtitles to text…';

    const handle = {
      update(p) {
        // p = { phase: 'index'|'match', current, total }. Map both
        // phases onto a single 0-100% bar: index = 0-30%, match = 30-100%.
        // Indexing is the cheaper phase but a visible move there
        // reassures the user something is happening even before the
        // cue loop starts.
        if (!p || !p.total) return;
        const ratio = Math.max(0, Math.min(1, p.current / p.total));
        const pct = p.phase === 'index'
          ? ratio * 30
          : 30 + ratio * 70;
        fillEl.style.width = pct.toFixed(1) + '%';
        if (p.phase === 'index') {
          subEl.textContent = 'Indexing text…';
        } else {
          subEl.textContent = 'Matching subtitles…';
        }
        countEl.textContent = p.current.toLocaleString() + ' / ' + p.total.toLocaleString();
      },
      setTitle(t) { titleEl.textContent = t; },
      setSub(t)   { subEl.textContent = t; },
      close() {
        if (_activeOverlay === handle) _activeOverlay = null;
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
    _activeOverlay = handle;
    return handle;
  }

  window.cueAlignment = {
    SCHEMA_VERSION,
    MIN_MATCHED_RATIO,
    DEFAULT_WINDOW_CHARS,
    defaultNormalize,
    buildAlignment,
    buildCueToChunk,
    extractFlatText,
    computeFingerprint,
    serializeAlignment,
    deserializeAlignment,
    saveAlignment,
    loadAlignment,
    clearAlignment,
    loadOrBuild,
    showProgress
  };
})();
