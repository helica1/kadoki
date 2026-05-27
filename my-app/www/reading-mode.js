(function () {
  const KEYS = {
    EPUB_URI: 'READING_EPUB_URI',
    EPUB_NAME: 'READING_EPUB_NAME',
    FONT: 'READING_FONT',
    FONT_SIZE: 'READING_FONT_SIZE',
    VERTICAL: 'READING_VERTICAL',
    HIGHLIGHT: 'READING_HIGHLIGHT_COLOR',
    AUTO_ADVANCE: 'READING_AUTO_ADVANCE',
    TIME_SEC: 'READING_TIME_SEC',
    CHARS: 'READING_CHARS_TOTAL',
    PROGRESS_MODE: 'READING_PROGRESS_MODE',
    MODE_OPEN: 'READING_MODE_OPEN',
    AUDIOBOOK_OPEN: 'READING_AUDIOBOOK_OPEN',
    PAIRING_PREFIX: 'READING_PAIRING_',
    CURSOR_PREFIX: 'READING_CURSOR_',
    AUDIO_PAIR_PREFIX: 'READING_AUDIO_PAIR_',     // <deck> → audio cache file path
    AUDIO_NAME_PREFIX: 'READING_AUDIO_NAME_',     // <deck> → audio display name
    SRT_PAIR_PREFIX: 'READING_SRT_PAIR_',         // <deck> → srt cache file path
    SRT_NAME_PREFIX: 'READING_SRT_NAME_',         // <deck> → srt display name
    AUDIO_LAST_POS_PREFIX: 'READING_AUDIO_LAST_POS_', // <deck> → ms position
    AUDIO_LAST_CHUNK_PREFIX: 'READING_AUDIO_LAST_CHUNK_' // <deck> → chunk idx
  };

  const DEFAULT_HIGHLIGHT = '#4caf50'; // green — matches the read-mode accent

  let timerStart = null;
  let timerInterval = null;
  let cumulativeSec = 0;
  let cumulativeChars = 0;
  let currentEpubName = null;
  let chunks = [];
  let lastMatchedIdx = -1;
  let firstSyncForBook = true;
  let toolbarShown = true;
  let playStatePollInterval = null;

  function rlog(msg) {
    if (window.debugLog) window.debugLog('[READ] ' + msg);
    else console.log('[READ] ' + msg);
  }

  function isCap() {
    return typeof window.isCapacitorEnvironment === 'function' && window.isCapacitorEnvironment();
  }

  async function setPref(key, value) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
    } else {
      localStorage.setItem(key, String(value));
    }
  }

  async function getPref(key) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      const res = await window.Capacitor.Plugins.Preferences.get({ key });
      return res.value;
    }
    return localStorage.getItem(key);
  }

  function currentDeckName() {
    const el = document.getElementById('deckName');
    const raw = (el?.textContent || '').trim();
    if (!raw) return null;
    return raw.replace(/\s*\((Tap to reopen|Auto-restoring\.\.\.)\)\s*$/i, '').trim() || null;
  }

  function pairingKey(deckName) {
    return KEYS.PAIRING_PREFIX + deckName;
  }
  function cursorKey(deckName, epubName) {
    return KEYS.CURSOR_PREFIX + deckName + '__' + epubName;
  }

  async function savePairing(deckName, epubName) {
    if (!deckName || !epubName) return;
    await setPref(pairingKey(deckName), epubName);
  }
  async function getPairedEpub(deckName) {
    if (!deckName) return null;
    return await getPref(pairingKey(deckName));
  }
  async function saveCursor(deckName, epubName, idx) {
    if (!deckName || !epubName || idx < 0) return;
    await setPref(cursorKey(deckName, epubName), idx);
  }
  async function getCursor(deckName, epubName) {
    if (!deckName || !epubName) return -1;
    const v = await getPref(cursorKey(deckName, epubName));
    const n = parseInt(v);
    return Number.isFinite(n) ? n : -1;
  }

  // -------- Audiobook + SRT deck-pairing helpers --------

  async function saveAudiobookPairing(deckName, cachePath, displayName) {
    if (!deckName || !cachePath) return;
    await setPref(KEYS.AUDIO_PAIR_PREFIX + deckName, cachePath);
    if (displayName) await setPref(KEYS.AUDIO_NAME_PREFIX + deckName, displayName);
  }
  async function getAudiobookPairing(deckName) {
    if (!deckName) return null;
    const path = await getPref(KEYS.AUDIO_PAIR_PREFIX + deckName);
    if (!path) return null;
    const name = await getPref(KEYS.AUDIO_NAME_PREFIX + deckName);
    return { path, name: name || 'audiobook' };
  }
  async function saveSrtPairing(deckName, cachePath, displayName) {
    if (!deckName || !cachePath) return;
    await setPref(KEYS.SRT_PAIR_PREFIX + deckName, cachePath);
    if (displayName) await setPref(KEYS.SRT_NAME_PREFIX + deckName, displayName);
  }
  async function getSrtPairing(deckName) {
    if (!deckName) return null;
    const path = await getPref(KEYS.SRT_PAIR_PREFIX + deckName);
    if (!path) return null;
    const name = await getPref(KEYS.SRT_NAME_PREFIX + deckName);
    return { path, name: name || 'subtitles' };
  }
  async function saveAudiobookLastPosition(deckName, ms, chunkIdx) {
    if (!deckName) return;
    if (Number.isFinite(ms) && ms >= 0) {
      await setPref(KEYS.AUDIO_LAST_POS_PREFIX + deckName, Math.floor(ms));
    }
    if (Number.isFinite(chunkIdx) && chunkIdx >= 0) {
      await setPref(KEYS.AUDIO_LAST_CHUNK_PREFIX + deckName, chunkIdx);
    }
  }
  // Expose deck-pairing getters to the shell so it can grey out tabs for
  // modes the current title doesn't enable.
  window.getEpubPairingForDeck = async (deck) => deck ? await getPairedEpub(deck) : null;
  window.getAudiobookPairingForDeck = async (deck) => deck ? await getAudiobookPairing(deck) : null;
  window.getSrtPairingForDeck = async (deck) => deck ? await getSrtPairing(deck) : null;

  async function getAudiobookLastPosition(deckName) {
    if (!deckName) return { ms: 0, chunkIdx: -1 };
    const ms = parseInt(await getPref(KEYS.AUDIO_LAST_POS_PREFIX + deckName));
    const chunkIdx = parseInt(await getPref(KEYS.AUDIO_LAST_CHUNK_PREFIX + deckName));
    return {
      ms: Number.isFinite(ms) ? ms : 0,
      chunkIdx: Number.isFinite(chunkIdx) ? chunkIdx : -1
    };
  }

  function formatSec(total) {
    total = Math.floor(total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function startTimer() {
    if (timerStart !== null) return;
    timerStart = Date.now();
    const label = document.getElementById('readingTimerLabel');
    timerInterval = setInterval(() => {
      const sessionSec = (Date.now() - timerStart) / 1000;
      if (label) label.textContent = formatSec(cumulativeSec + sessionSec);
    }, 1000);
  }

  async function stopTimer() {
    if (timerStart === null) return;
    const sessionSec = (Date.now() - timerStart) / 1000;
    cumulativeSec += sessionSec;
    timerStart = null;
    clearInterval(timerInterval);
    timerInterval = null;
    await setPref(KEYS.TIME_SEC, Math.floor(cumulativeSec));
    rlog(`Timer stopped: session ${sessionSec.toFixed(1)}s, cumulative ${cumulativeSec.toFixed(0)}s`);
  }

  function ensureFontOverrideStyle() {
    if (document.getElementById('readingFontOverride')) return;
    const style = document.createElement('style');
    style.id = 'readingFontOverride';
    style.textContent = `
      #readingModeContent, #readingModeContent * {
        font-family: var(--reader-font, serif) !important;
      }
      #readingModeContent {
        font-size: var(--reader-font-size, 1.1rem);
        background: #000000;
      }
      #readingModeContent .reading-chunk {
        transition: background-color 0.25s ease;
        border-radius: 3px;
      }
      #readingModeContent .reading-chunk.active {
        background-color: var(--reader-highlight-bg, rgba(0, 255, 204, 0.18));
        box-shadow: 0 0 0 2px var(--reader-highlight-ring, rgba(0, 255, 204, 0.35));
      }
      /* No chunk-level outlines — pending + active visuals are drawn at
         the SRT-cue granularity via CSS Custom Highlight. */
      #readingModeContent .reading-chunk.long-press-armed { /* no-op */ }
      #readingModeContent .reading-chunk.pending { /* no-op */ }
      #readingModeContent, #readingModeContent .reading-chunk {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      /* In reading mode, dict-frags should be invisible until highlighted.
         Override the global rgba(0,0,0,0.1) background applied by enhanced-dictionary.js. */
      #readingModeContent .dict-frag {
        background-color: transparent !important;
      }
      #readingModeContent .dict-frag.highlight {
        background-color: var(--reader-highlight-bg, rgba(0,255,204,0.22)) !important;
        color: inherit !important;
      }
      #readingTimerLabel.paused { color: #ff5555 !important; }
      #readingFloatingControls {
        position: fixed; z-index: 2900;
        display: flex; gap: 4px; padding: 4px;
        background: rgba(34,34,34,0.95);
        border: 1px solid #555; border-radius: 999px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.6);
      }
      #readingFloatingControls button {
        background: transparent; color: #fff; border: none;
        padding: 8px 12px; font-size: 16px; border-radius: 999px;
        min-width: 36px;
      }
      #readingFloatingControls button:active {
        background: rgba(255,255,255,0.15);
      }
      #readingModeToolbar.hidden {
        transform: translateY(-110%) !important;
      }
      #readingModeContent.vertical {
        writing-mode: vertical-rl;
        -webkit-writing-mode: vertical-rl;
        text-orientation: mixed;
        -webkit-text-orientation: mixed;
        overflow-x: auto;
        overflow-y: hidden;
        height: 100%;
      }
      #readingModeContent.vertical hr {
        border: 0 !important;
        border-right: 1px solid #333 !important;
        margin: 0 32px !important;
        height: auto !important;
        width: 0 !important;
        align-self: stretch;
      }
    `;
    document.head.appendChild(style);
  }

  async function applyFontPrefs() {
    ensureFontOverrideStyle();
    // Parallelize the 5 prefs reads. Capacitor's Preferences plugin does a
    // JNI hop per call (~50–100 ms on Android), so sequencing 5 of them
    // was eating 250–500 ms on every reader open. Promise.all collapses
    // that to roughly the cost of the slowest single call.
    const [font, size, vertical, hi, auto] = await Promise.all([
      getPref(KEYS.FONT),
      getPref(KEYS.FONT_SIZE),
      getPref(KEYS.VERTICAL),
      getPref(KEYS.HIGHLIGHT),
      getPref(KEYS.AUTO_ADVANCE)
    ]);
    document.documentElement.style.setProperty('--reader-font', font || 'serif');
    document.documentElement.style.setProperty('--reader-font-size', (size || '1.1') + 'rem');
    applyVertical(vertical === 'true');
    applyHighlightColor(hi || DEFAULT_HIGHLIGHT);
    window.readingAutoAdvance = auto !== 'false';
  }

  function hexToRgba(hex, alpha) {
    let h = (hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return `rgba(0,255,204,${alpha})`;
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function applyHighlightColor(hex) {
    document.documentElement.style.setProperty('--reader-highlight-bg', hexToRgba(hex, 0.22));
    document.documentElement.style.setProperty('--reader-highlight-ring', hexToRgba(hex, 0.45));
  }
  // Derive the reading highlight color from the current read-mode accent.
  // Called on startup and whenever mode colors change so the highlight
  // tracks the user's chosen read accent automatically.
  function applyHighlightFromAccent() {
    const cs = getComputedStyle(document.body);
    const hex = (cs.getPropertyValue('--accent-read').trim()) || '#4caf50';
    applyHighlightColor(hex);
  }
  // Re-derive when mode colors update (Preferences → Mode accent colors).
  window.addEventListener('shell:mode-change', applyHighlightFromAccent);
  // Also poll once after each storage write — mode-colors.js writes the
  // CSS var on every picker change. We catch up on next render tick.
  document.addEventListener('DOMContentLoaded', applyHighlightFromAccent);
  if (document.readyState !== 'loading') queueMicrotask(applyHighlightFromAccent);

  function applyVertical(vertical) {
    const content = document.getElementById('readingModeContent');
    if (!content) return;
    content.classList.toggle('vertical', !!vertical);
  }

  function showToolbar() {
    const tb = document.getElementById('readingModeToolbar');
    if (!tb) return;
    tb.classList.remove('hidden');
    toolbarShown = true;
  }
  function hideToolbar() {
    const tb = document.getElementById('readingModeToolbar');
    if (!tb) return;
    tb.classList.add('hidden');
    toolbarShown = false;
  }
  function toggleToolbar() {
    if (toolbarShown) hideToolbar();
    else showToolbar();
  }

  function refreshPlayPauseButton() {
    const btn = document.getElementById('readingPlayPauseBtn');
    if (!btn) return;
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    btn.textContent = playing ? '⏸' : '▶';
  }

  function startPlayStatePoll() {
    if (playStatePollInterval) return;
    playStatePollInterval = setInterval(refreshPlayPauseButton, 600);
  }
  function stopPlayStatePoll() {
    if (!playStatePollInterval) return;
    clearInterval(playStatePollInterval);
    playStatePollInterval = null;
  }

  window.toggleReadingPlaybackUI = function () {
    if (typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
    }
    refreshPlayPauseButton();
  };

  const LONG_PRESS_MS = 500;
  const SWIPE_MIN_DELTA = 60;     // px
  const SWIPE_MAX_TIME = 400;     // ms
  let longPressTimer = null;
  let longPressFired = false;
  let floatingControlsTimer = null;
  let pendingChunk = null;
  let totalBookChars = 0;
  let progressMode = 0; // 0=percent, 1=current/total, 2=remaining
  let progressBarShown = false;

  function clearPendingChunk() {
    if (pendingChunk) {
      pendingChunk.classList.remove('pending');
      pendingChunk = null;
    }
    try { if (window.CSS?.highlights) CSS.highlights.delete('cue-pending'); } catch (e) {}
  }

  function setPendingChunk(chunk) {
    if (!chunk) return;
    if (pendingChunk && pendingChunk !== chunk) {
      pendingChunk.classList.remove('pending');
    }
    pendingChunk = chunk;
    chunk.classList.add('pending');
    // Set cue-precise pending highlight: dashed underline on the chunk's
    // matched SRT cue text only (never on surrounding sentence chars).
    const cIdx = chunks.indexOf(chunk);
    if (abChunkToCue && cIdx >= 0) {
      const cueIdx = abChunkToCue[cIdx];
      const cueText = (cueIdx >= 0 && abCues[cueIdx]) ? abCues[cueIdx].text : '';
      if (cueText) setCueHighlightFor('cue-pending', cIdx, cueText);
      else { try { CSS.highlights.delete('cue-pending'); } catch (e) {} }
    }
  }

  function handleDownSwipe() {
    if (pendingChunk) {
      const target = pendingChunk;
      clearPendingChunk();
      seekToChunk(target);
      // seekToChunk → updateCardIndex → displayCard plays the new card.
      // If audio happened to be paused before, ensure it's playing now.
      if (typeof window.isReadingPlaying === 'function' && !window.isReadingPlaying() &&
          typeof window.toggleReadingPlayback === 'function') {
        window.toggleReadingPlayback();
      }
      refreshPlayPauseButton();
      return;
    }
    if (typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
      refreshPlayPauseButton();
    }
  }

  function handleUpSwipe(chunk) {
    if (!chunk) return;
    setPendingChunk(chunk);
    showSelectionActionPopup(chunk);
  }

  // Small floating popup with two actions — COPY (cue text only) and
  // ADD TO ANKI (which itself opens the waveform editor for audio).
  // Position is clamped to a safe viewport area so the user can always
  // reach the buttons, regardless of where the chunk landed.
  function showSelectionActionPopup(chunk) {
    hideSelectionActionPopup();
    if (!chunk) return;
    // Prefer the matched SRT cue's text (so the selection is precisely the
    // subtitle the user heard); fall back to the chunk text if no map.
    let text = '';
    const cIdx = chunks.indexOf(chunk);
    if (abChunkToCue && cIdx >= 0) {
      const cueIdx = abChunkToCue[cIdx];
      if (cueIdx >= 0 && abCues?.[cueIdx]) text = abCues[cueIdx].text;
    }
    if (!text) text = textWithoutRuby(chunk).trim();
    if (!text) return;
    const rect = chunk.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'readSelectionPopup';
    pop.style.cssText = `
      position:fixed; z-index:2800;
      background:var(--panel,#161616); color:var(--text,#e8e8e8);
      border:1px solid var(--border,#2a2a2a); border-radius:8px;
      padding:6px; display:flex; gap:6px; font-size:.78rem;
      box-shadow:0 8px 24px rgba(0,0,0,0.6);
      max-width:92vw;
    `;
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.style.cssText = 'padding:8px 14px;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;font-weight:700;';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    pop.appendChild(mkBtn('Copy', () => {
      try { navigator.clipboard.writeText(text); } catch (e) {}
      hideSelectionActionPopup();
    }));
    pop.appendChild(mkBtn('Add to Anki', async () => {
      hideSelectionActionPopup();
      await sendChunkToAnki(chunk, text);
    }));
    document.body.appendChild(pop);
    // Position: above the chunk if room, below if not, else clamped to a
    // safe band that stays clear of the top header (~48px) and bottom bar
    // (~36px) so it's always reachable.
    const popRect = pop.getBoundingClientRect();
    const TOP_MARGIN = 64;
    const BOTTOM_MARGIN = 72;
    let top = rect.top - popRect.height - 10;
    if (top < TOP_MARGIN) top = rect.bottom + 8;
    const maxTop = window.innerHeight - popRect.height - BOTTOM_MARGIN;
    if (top > maxTop) top = maxTop;
    top = Math.max(TOP_MARGIN, top);
    let left = rect.left + (rect.width - popRect.width) / 2;
    left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top  = Math.round(top) + 'px';
    setTimeout(() => {
      const dismiss = (e) => {
        if (pop.contains(e.target)) return;
        hideSelectionActionPopup();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }
  function hideSelectionActionPopup() {
    const p = document.getElementById('readSelectionPopup');
    if (p) p.remove();
  }

  // Resolve the audiobook range a chunk corresponds to (via chunkToCue map).
  function chunkCueRange(chunk) {
    if (!abChunkToCue || !abAudioPath || !chunk) return null;
    const i = chunks.indexOf(chunk);
    if (i < 0) return null;
    const cueIdx = abChunkToCue[i];
    if (cueIdx < 0 || !abCues?.[cueIdx]) return null;
    return { srcPath: abAudioPath, startMs: abCues[cueIdx].startMs, endMs: abCues[cueIdx].endMs };
  }

  async function adjustAudioForChunk(chunk) {
    const r = chunkCueRange(chunk);
    if (!r) { alert('This sentence has no matched audiobook cue.'); return; }
    if (!window.waveform?.edit) return;
    const text = textWithoutRuby(chunk).trim();
    // Locate the anchor cue so the editor can expose text-range handles.
    const chunkIdx = chunks.indexOf(chunk);
    const cueIdx = (chunkIdx >= 0 && abChunkToCue) ? abChunkToCue[chunkIdx] : -1;
    const adjusted = await window.waveform.edit({
      srcPath: r.srcPath,
      startMs: Math.round(r.startMs),
      endMs:   Math.round(r.endMs),
      title: text,
      cues: abCues,
      cueIndex: cueIdx
    });
    if (!adjusted) return;
    // Persist override on the chunk's dataset so a subsequent Add-to-Anki
    // (or Adjust) uses the new bounds.
    chunk.dataset.audioStartMs = Math.round(adjusted.startMs);
    chunk.dataset.audioEndMs   = Math.round(adjusted.endMs);
  }

  async function sendChunkToAnki(chunk, text) {
    if (!window.sendToAnki) { alert('Anki integration not loaded'); return; }
    // Bounds: chunk-level override (set by Adjust audio) wins; else cue range.
    let startMs = chunk.dataset.audioStartMs ? parseInt(chunk.dataset.audioStartMs) : NaN;
    let endMs   = chunk.dataset.audioEndMs   ? parseInt(chunk.dataset.audioEndMs)   : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      const r = chunkCueRange(chunk);
      if (r) { startMs = Math.round(r.startMs); endMs = Math.round(r.endMs); }
    }
    let audioData = '';
    let finalText = text;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && abAudioPath &&
        window.Capacitor?.Plugins?.AudioSlicer) {
      // Let user fine-tune before send. Cancel = abort.
      const chunkIdx = chunks.indexOf(chunk);
      const cueIdx = (chunkIdx >= 0 && abChunkToCue) ? abChunkToCue[chunkIdx] : -1;
      const adjusted = await window.waveform.edit({
        srcPath: abAudioPath, startMs, endMs, title: text,
        cues: abCues, cueIndex: cueIdx
      });
      if (!adjusted) return;
      if (adjusted.text) finalText = adjusted.text;
      try {
        const slice = await window.Capacitor.Plugins.AudioSlicer.slice({
          srcPath: abAudioPath,
          startMs: Math.round(adjusted.startMs),
          endMs:   Math.round(adjusted.endMs)
        });
        if (slice?.path && typeof window.cacheFileToDataUri === 'function') {
          audioData = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
          console.log('[read-anki] slice bytes=' + (audioData?.length || 0) + ' mime=' + (slice.mime || ''));
        }
      } catch (e) { console.warn('slice for Anki:', e); }
    }
    // Image: prefer Title cover for non-deck titles.
    let imageData = '';
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const tit = titles.find(t => t.id === window._activeTitleId);
        if (tit?.attachments?.cover?.dataUri) imageData = tit.attachments.cover.dataUri;
      }
    } catch (e) {}
    await window.sendToAnki({ expression: finalText, imageData, audioData });
  }

  // Lazy: wrap a chunk's text in per-char dict-frag spans (skipping rt/rp).
  function wrapChunkForLookup(chunk) {
    if (!chunk || chunk.dataset.lookupWrapped === '1') return;
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let cur = node.parentNode;
        while (cur && cur !== chunk) {
          if (cur.tagName === 'RT' || cur.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          cur = cur.parentNode;
        }
        return node.nodeValue && node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const textNodes = [];
    let n;
    while (n = walker.nextNode()) textNodes.push(n);
    for (const tn of textNodes) {
      const frag = document.createDocumentFragment();
      for (const ch of tn.nodeValue) {
        const sp = document.createElement('span');
        sp.className = 'dict-frag';
        sp.textContent = ch;
        frag.appendChild(sp);
      }
      tn.parentNode.replaceChild(frag, tn);
    }
    chunk.dataset.lookupWrapped = '1';
  }

  async function lookupAtPoint(chunk, x, y) {
    if (typeof window.performDictLookup !== 'function') {
      rlog('Dictionary not available (performDictLookup missing)');
      return;
    }
    wrapChunkForLookup(chunk);
    const target = document.elementFromPoint(x, y);
    if (!target || !target.classList.contains('dict-frag')) return;
    if (!chunk.contains(target)) return;
    const spans = Array.from(chunk.querySelectorAll('.dict-frag'));
    const idx = spans.indexOf(target);
    if (idx < 0) return;

    // Establish Anki context: sentence, card AND audiobook cue range
    // come from the TAPPED chunk — not from whatever cue happens to be
    // currently playing. (Bug: previously the Anki "Add" used the
    // playing cue, sending the wrong audio + sentence for the word.)
    const cardIdx = findCardForChunk(chunk);
    const card = (cardIdx >= 0 && Array.isArray(window.allNotes)) ? window.allNotes[cardIdx] : null;
    const chunkIdxLocal = chunks.indexOf(chunk);
    let cueAudioPath = null, cueStartMs = null, cueEndMs = null, cueText = '', cueIdxOut = -1;
    if (abChunkToCue && chunkIdxLocal >= 0) {
      const cueIdx = abChunkToCue[chunkIdxLocal];
      if (cueIdx >= 0 && abCues[cueIdx]) {
        cueAudioPath = abAudioPath;
        cueStartMs = abCues[cueIdx].startMs;
        cueEndMs   = abCues[cueIdx].endMs;
        cueText    = abCues[cueIdx].text;
        cueIdxOut  = cueIdx;
      }
    }
    window.lookupContext = {
      source: 'reading',
      card,
      cardIdx,
      sentence: cueText || textWithoutRuby(chunk),
      cueAudioPath,
      cueStartMs,
      cueEndMs,
      cueIndex: cueIdxOut,
      cues: abCues
    };

    try {
      await window.performDictLookup(spans, idx);
    } catch (e) {
      rlog(`Dictionary error: ${e.message}`);
    }
  }

  // Locate which card (in window.allNotes) corresponds to a chunk.
  // Prefer the cached cardIdx if syncReadingToCard already matched this chunk;
  // otherwise scan allNotes forward from currentCardIndex.
  function findCardForChunk(chunk) {
    if (!chunk) return -1;
    if (chunk.dataset.cardIdx) {
      const i = parseInt(chunk.dataset.cardIdx);
      if (Number.isFinite(i) && Array.isArray(window.allNotes) && i >= 0 && i < window.allNotes.length) {
        return i;
      }
    }
    const notes = window.allNotes;
    if (!Array.isArray(notes) || !notes.length) return -1;
    const chunkNorm = chunk.dataset.norm || '';
    if (!chunkNorm) return -1;
    const cur = Math.max(0, window.currentCardIndex | 0);
    // Search outward from current index.
    for (let dist = 0; dist < notes.length; dist++) {
      for (const dir of [+1, -1]) {
        const i = cur + dir * dist;
        if (i < 0 || i >= notes.length) continue;
        const exp = notes[i] && notes[i].expression;
        if (!exp) continue;
        const expNorm = normalizeText(textWithoutRubyFromHtml(exp));
        if (!expNorm) continue;
        if (chunkNorm === expNorm || chunkNorm.includes(expNorm) || expNorm.includes(chunkNorm)) {
          return i;
        }
      }
    }
    return -1;
  }

  function hideFloatingControls() {
    const m = document.getElementById('readingFloatingControls');
    if (m) m.remove();
    if (floatingControlsTimer) {
      clearTimeout(floatingControlsTimer);
      floatingControlsTimer = null;
    }
  }

  function showFloatingControls(x, y) {
    hideFloatingControls();
    const wrap = document.createElement('div');
    wrap.id = 'readingFloatingControls';

    const mkBtn = (label, onTap) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      const fire = (e) => {
        e.stopPropagation();
        e.preventDefault();
        onTap();
        refreshPlayPauseButton();
        // Refresh local play/pause label.
        const playBtn = wrap.querySelector('[data-action="play"]');
        if (playBtn) {
          const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
          playBtn.textContent = playing ? '⏸' : '▶';
        }
      };
      b.addEventListener('click', fire);
      b.addEventListener('touchend', fire, { passive: false });
      return b;
    };

    const prevBtn = mkBtn('⏮', () => { if (window.goToPreviousCard) window.goToPreviousCard(); });
    const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
    const playBtn = mkBtn(playing ? '⏸' : '▶', () => {
      if (typeof window.toggleReadingPlayback === 'function') window.toggleReadingPlayback();
    });
    playBtn.dataset.action = 'play';
    const nextBtn = mkBtn('⏭', () => { if (window.goToNextCard) window.goToNextCard(); });

    wrap.appendChild(prevBtn);
    wrap.appendChild(playBtn);
    wrap.appendChild(nextBtn);
    document.body.appendChild(wrap);

    // Position near tap; clamp to viewport. Prefer above the tap when possible.
    const rect = wrap.getBoundingClientRect();
    let px = x - rect.width / 2;
    let py = y - rect.height - 14; // above the tap
    if (py < 8) py = y + 14;        // not enough room above → below
    px = Math.min(Math.max(8, px), window.innerWidth - rect.width - 8);
    py = Math.min(Math.max(8, py), window.innerHeight - rect.height - 8);
    wrap.style.left = px + 'px';
    wrap.style.top = py + 'px';

    // Auto-dismiss after 4s.
    floatingControlsTimer = setTimeout(hideFloatingControls, 4000);

    // Dismiss on outside tap.
    setTimeout(() => {
      const dismiss = (e) => {
        if (wrap.contains(e.target)) return;
        hideFloatingControls();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('mousedown', dismiss, true);
      };
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('mousedown', dismiss, true);
    }, 0);
  }

  function seekToChunk(chunk) {
    if (!chunk) return;
    // Resolve target card BEFORE any visual change. setActive used to tag
    // chunk.dataset.cardIdx with the current (old) index, which then made
    // findCardForChunk return the old card and updateCardIndex no-op.
    const cardIdx = findCardForChunk(chunk);
    const chunkIdx = chunks.indexOf(chunk);

    if (cardIdx >= 0) {
      const oldCardIdx = window.currentCardIndex;
      if (typeof window.updateCardIndex === 'function') {
        window.updateCardIndex(cardIdx);
      } else if (Array.isArray(window.allNotes)) {
        window.currentCardIndex = cardIdx;
        if (typeof window.displayCard === 'function') window.displayCard();
      }
      // If the card didn't change, displayCard wasn't called and the highlight
      // didn't move. Force it to land on the chunk the user picked.
      if (cardIdx === oldCardIdx && chunkIdx >= 0) {
        setActive(chunkIdx);
        tagChunkWithCard(chunkIdx, cardIdx);
      }
    } else if (chunkIdx >= 0) {
      // No matching card; just highlight visually.
      setActive(chunkIdx);
    }
  }

  function handleLongPressOnChunk(chunk /* , x, y */) {
    if (!chunk) return;
    chunk.classList.remove('long-press-armed');
    // Long press = seek playback to this sentence ("region selection").
    seekToChunk(chunk);
  }

  function installContentTapHandler() {
    const content = document.getElementById('readingModeContent');
    if (!content || content.dataset.tapInstalled === '1') return;
    content.dataset.tapInstalled = '1';
    let tStart = 0, xStart = 0, yStart = 0, moved = false;
    let pressedChunk = null;
    let pressedX = 0, pressedY = 0;
    let startScrollTop = 0, startScrollLeft = 0;

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (pressedChunk) pressedChunk.classList.remove('long-press-armed');
    };

    content.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      markInteraction();
      // If the dictionary popup is open, any tap inside the EPUB content area
      // should close it (and NOT trigger a new lookup or any other gesture).
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        popup.style.display = 'none';
        popup.innerHTML = '';
        tStart = -1; // mark this touch sequence as "consumed"
        return;
      }
      tStart = Date.now();
      xStart = e.touches[0].clientX;
      yStart = e.touches[0].clientY;
      pressedX = xStart;
      pressedY = yStart;
      moved = false;
      longPressFired = false;
      startScrollTop = content.scrollTop;
      startScrollLeft = content.scrollLeft;
      hideFloatingControls();
      pressedChunk = e.target && e.target.closest ? e.target.closest('.reading-chunk') : null;
      if (pressedChunk) {
        pressedChunk.classList.add('long-press-armed');
        longPressTimer = setTimeout(() => {
          longPressFired = true;
          handleLongPressOnChunk(pressedChunk, pressedX, pressedY);
        }, LONG_PRESS_MS);
      }
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
      if (!e.touches?.[0]) return;
      const dx = Math.abs(e.touches[0].clientX - xStart);
      const dy = Math.abs(e.touches[0].clientY - yStart);
      if (dx > 10 || dy > 10) {
        moved = true;
        clearLongPress();
      }
    }, { passive: true });

    content.addEventListener('touchend', (e) => {
      // Touch that was consumed by outside-tap-to-close on the dict popup.
      if (tStart < 0) {
        tStart = 0;
        return;
      }
      const touch = e.changedTouches && e.changedTouches[0];
      const targetChunk = e.target && e.target.closest ? e.target.closest('.reading-chunk') : null;
      const wasLongPress = longPressFired;
      clearLongPress();

      if (wasLongPress) return; // long-press already handled (seek)
      if (e.target && e.target.closest('button, a, input, select, textarea')) return;

      const dt = Date.now() - tStart;
      const dx = touch ? (touch.clientX - xStart) : 0;
      const dy = touch ? (touch.clientY - yStart) : 0;
      const adx = Math.abs(dx), ady = Math.abs(dy);

      // Fast vertical swipe → gesture (independent of any scroll that happened).
      if (dt < SWIPE_MAX_TIME && ady > SWIPE_MIN_DELTA && ady > adx * 1.5) {
        if (dy < 0) {
          // Up-swipe: only meaningful on a chunk.
          if (targetChunk) handleUpSwipe(targetChunk);
        } else {
          // Down-swipe: pause/play, or play from pending region.
          handleDownSwipe();
        }
        return;
      }

      if (moved) return; // ordinary scroll/drag
      if (dt > LONG_PRESS_MS - 20) return;

      if (targetChunk) {
        // Short tap on a chunk → dictionary lookup at the touched character.
        lookupAtPoint(targetChunk, pressedX, pressedY);
        return;
      }
      // Empty / margin tap. Bottom 90 px toggles the inside-reading progress
      // bar (book %). Other margins toggle the shell chrome (full-screen).
      const bottomZone = 90; // px
      if (pressedY > window.innerHeight - bottomZone) {
        toggleProgressBar();
      } else if (typeof window.shellToggleChrome === 'function') {
        window.shellToggleChrome();
      }
    }, { passive: true });

    content.addEventListener('touchcancel', clearLongPress, { passive: true });
  }

  function refreshTimerUI() {
    const label = document.getElementById('readingTimerLabel');
    const bigBtn = document.getElementById('readerTimerBigBtn');
    const running = timerStart !== null;
    if (label) {
      label.classList.toggle('paused', !running);
      if (!running) label.textContent = formatSec(cumulativeSec);
    }
    if (bigBtn) {
      bigBtn.textContent = running ? 'Pause Timer' : 'Start Timer';
      bigBtn.style.background = running ? '#4caf50' : '#f44336';
    }
  }

  function refreshStatsModal() {
    // Pull live values from the per-mode stats module. The modal lays out
    // three side-by-side sections (CARD / READ / AUDIO).
    const s = window.stats;
    if (!s) return;
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setRunning = (id, running) => {
      const el = document.getElementById(id);
      if (el) el.dataset.running = running ? '1' : '0';
    };

    const cardSec  = s.getCardSec();
    const readSec  = s.getReadSec();
    const audioSec = s.getAudioSec();

    setText('statsCardTime',  formatSec(cardSec));
    setText('statsCardCount', s.getCardCount().toLocaleString());
    setRunning('statsCard', s.isRunning('card'));

    setText('statsReadTime',  formatSec(readSec));
    setText('statsReadChars', cumulativeChars.toLocaleString());
    if (readSec < 1 || cumulativeChars === 0) {
      setText('statsReadRate', '—');
    } else {
      setText('statsReadRate', Math.round(cumulativeChars / (readSec / 3600)).toLocaleString());
    }
    setRunning('statsRead', s.isRunning('read'));

    setText('statsAudioTime', formatSec(audioSec));
    setRunning('statsAudio', s.isRunning('audio'));
  }

  let statsRefreshTimer = null;

  // ---- Inactivity auto-pause ------------------------------------------------
  const INACTIVITY_MS = 60000;
  let lastInteractionMs = Date.now();
  let inactivityInterval = null;
  let autoStoppedByInactivity = false;

  function markInteraction() {
    lastInteractionMs = Date.now();
    if (autoStoppedByInactivity && timerStart === null) {
      autoStoppedByInactivity = false;
      startTimer();
      refreshTimerUI();
    }
  }
  window.markReadingInteraction = markInteraction;

  function startInactivityWatcher() {
    if (inactivityInterval) return;
    lastInteractionMs = Date.now();
    inactivityInterval = setInterval(() => {
      if (timerStart === null) return; // already paused (manually or auto)
      const playing = typeof window.isReadingPlaying === 'function' && window.isReadingPlaying();
      if (playing) {
        lastInteractionMs = Date.now(); // playback counts as active
        return;
      }
      if (Date.now() - lastInteractionMs >= INACTIVITY_MS) {
        autoStoppedByInactivity = true;
        stopTimer();
        refreshTimerUI();
        rlog('Timer auto-paused (1 min idle, no audio)');
      }
    }, 5000);
  }
  function stopInactivityWatcher() {
    if (!inactivityInterval) return;
    clearInterval(inactivityInterval);
    inactivityInterval = null;
  }

  // Snapshot for the shell's persistent timer label (shell polls this).
  // Returns the timer of the currently active mode.
  window.getReadingTimerState = function () {
    const s = window.stats;
    if (!s) return { running: false, totalSec: 0 };
    const mode = document.body.classList.contains('mode-audio') ? 'audio'
               : document.body.classList.contains('mode-read')  ? 'read'
               : 'card';
    return { running: s.isRunning(mode), totalSec: s.liveTotal(mode) };
  };

  // Snapshot of reading-mode progress for the unified bottom bar.
  window.getReadProgress = function () {
    const p = progressForIdx(lastMatchedIdx);
    return { current: p.current, total: p.total, pct: p.pct };
  };
  // Jump reading mode to a target character offset (resolves to nearest chunk).
  window.jumpReadingToChars = function (targetChars) {
    if (!chunks || !chunks.length || !totalBookChars) return;
    const target = Math.max(0, Math.min(totalBookChars, Math.floor(targetChars)));
    // Pick the chunk whose [off, off+len) contains the target.
    let best = 0;
    for (let i = 0; i < chunks.length; i++) {
      const off = parseInt(chunks[i].dataset.charOffset) || 0;
      const len = parseInt(chunks[i].dataset.charLen) || 0;
      if (target < off + len) { best = i; break; }
      best = i;
    }
    setActive(best);
    const el = chunks[best];
    const content = document.getElementById('readingModeContent');
    if (el && content) content.scrollTop = el.offsetTop - 100;
    refreshProgressBar();
  };

  // Cross-mode sync: when switching INTO card mode, jump the card index
  // to whatever cue the audio is currently playing. Sets a global flag
  // so displayCard skips its bg.play() (audio is already running at the
  // right position; restarting would cause a back-jump).
  window.syncCardToCurrentCue = function () {
    if (!Array.isArray(window.allNotes)) return;
    const isSrt = !!window.allNotes[0]?.isSrtCard;
    let target = -1;
    if (isSrt) {
      // SRT-cards mode: cue index == card index.
      target = abCurrentCueIdx;
    } else if (abCueToChunk && abCurrentCueIdx >= 0) {
      // Deck-card mode: cue → chunk → card via tagged dataset.
      const chunkIdx = abCueToChunk[abCurrentCueIdx];
      if (chunkIdx >= 0 && chunks[chunkIdx]) {
        const tagged = parseInt(chunks[chunkIdx].dataset.cardIdx);
        if (Number.isFinite(tagged)) target = tagged;
      }
    }
    if (target < 0 || target === window.currentCardIndex) return;
    window._skipNextCardAudioRestart = true;
    if (typeof window.updateCardIndex === 'function') window.updateCardIndex(target);
  };

  // Audio-mode progress (mm:ss / mm:ss + percent) for the unified bar.
  window.getAudioProgress = function () {
    const ms = abPositionRef.ms || 0;
    const dur = abPositionRef.durMs || 0;
    return { ms, dur, pct: dur ? (ms / dur) * 100 : 0 };
  };
  window.jumpAudioToMs = async function (targetMs) {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    try { await bg.seek({ ms: Math.max(0, Math.round(targetMs)) }); } catch (e) {}
  };

  window.toggleReadingTimer = function () {
    // Toggle the CURRENT mode's stats timer — which is what the shell
    // pill + timer menu read from. Legacy `timerStart` is kept in sync
    // (used by some refresh helpers + the legacy stats fields).
    const s = window.stats;
    const mode = s ? s.currentMode() : 'card';
    if (s && s.isRunning(mode)) {
      s.stopMode(mode);
      if (timerStart !== null) stopTimer();
    } else {
      if (s) s.startMode(mode);
      if (timerStart === null && mode === 'read') startTimer();
    }
    refreshTimerUI();
    refreshStatsModal();
  };

  window.openReadingStats = async function () {
    const modal = document.getElementById('readingStatsModal');
    if (!modal) return;
    // Auto-pause playback when stats opens — user is reviewing stats,
    // not using the app actively.
    if (typeof window.isReadingPlaying === 'function' && window.isReadingPlaying() &&
        typeof window.toggleReadingPlayback === 'function') {
      window.toggleReadingPlayback();
      refreshPlayPauseButton();
    }
    if (timerStart !== null) await stopTimer();
    // Per-mode timers (stats.js): stop whichever is running.
    if (window.stats?.stopAll) window.stats.stopAll();
    modal.style.display = 'flex';
    refreshTimerUI();
    refreshStatsModal();
    if (statsRefreshTimer) clearInterval(statsRefreshTimer);
    statsRefreshTimer = setInterval(refreshStatsModal, 1000);
  };

  window.closeReadingStats = function () {
    const modal = document.getElementById('readingStatsModal');
    if (modal) modal.style.display = 'none';
    if (statsRefreshTimer) {
      clearInterval(statsRefreshTimer);
      statsRefreshTimer = null;
    }
  };

  window.resetReadingTimer = async function () {
    cumulativeSec = 0;
    cumulativeChars = 0;
    if (timerStart !== null) {
      timerStart = Date.now();
    }
    chunks.forEach(c => { delete c.dataset.counted; });
    await setPref(KEYS.TIME_SEC, 0);
    await setPref(KEYS.CHARS, 0);
    // Reset all per-mode stats counters.
    if (window.stats?.resetAll) window.stats.resetAll();
    refreshTimerUI();
    refreshStatsModal();
    const label = document.getElementById('readingTimerLabel');
    if (label && timerStart !== null) label.textContent = formatSec(0);
  };

  window.readingAnkiCount = window.readingAnkiCount || 0;

  // Strip ruby annotations (furigana) so the normalized text matches the SRT/deck text.
  function textWithoutRuby(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach(n => n.remove());
    return clone.textContent || '';
  }

  // Normalize for matching: strip whitespace and common JP/EN punctuation, lowercase.
  function normalizeText(s) {
    if (!s) return '';
    return s
      .replace(/[\s　]+/g, '')
      .replace(/[「」『』、。・…！？!?,.;:""'']/g, '')
      .toLowerCase();
  }

  // Split a block's innerHTML into per-sentence pieces. Honors:
  //   - sentence terminators 。！？
  //   - trailing closing quotes 」』")】 stick to the preceding sentence
  //   - never split inside HTML tags
  //   - never split inside <rt> or <rp> (furigana)
  //   - if the boundary lands inside open inline tags (em, span, b...),
  //     close them in the preceding sentence and reopen them in the next.
  function splitHtmlIntoSentences(html) {
    const out = [];
    let buf = '';
    let i = 0;
    let inTag = false;
    const tagStack = [];
    const closing = (n) => /^<\/([a-zA-Z][a-zA-Z0-9]*)/.exec(n);
    const opening = (n) => /^<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/.exec(n);
    const isRtOpen = (s) => /^<rt[\s>]/.test(s) || /^<rp[\s>]/.test(s);
    const isRtClose = (s) => /^<\/(rt|rp)>/.test(s);
    const inRuby = () => tagStack.some(t => t === 'rt' || t === 'rp');

    while (i < html.length) {
      const ch = html[i];
      if (ch === '<' && !inTag) {
        const rest = html.slice(i);
        if (isRtOpen(rest)) {
          tagStack.push(/^<(rt|rp)/.exec(rest)[1]);
        } else if (isRtClose(rest)) {
          // pop matching rt/rp
          for (let k = tagStack.length - 1; k >= 0; k--) {
            if (tagStack[k] === 'rt' || tagStack[k] === 'rp') {
              tagStack.splice(k, 1);
              break;
            }
          }
        } else {
          const c = closing(rest);
          const o = c ? null : opening(rest);
          if (c) {
            const name = c[1].toLowerCase();
            for (let k = tagStack.length - 1; k >= 0; k--) {
              if (tagStack[k] === name) {
                tagStack.splice(k, 1);
                break;
              }
            }
          } else if (o) {
            const name = o[1].toLowerCase();
            const attrs = o[2] || '';
            const selfClosing = /\/\s*$/.test(attrs) ||
              /^(br|img|hr|input|meta|link|source|wbr)$/i.test(name);
            if (!selfClosing) tagStack.push(name);
          }
        }
        inTag = true;
      }
      buf += ch;
      if (ch === '>') {
        inTag = false;
      } else if (!inTag && !inRuby() && (ch === '。' || ch === '！' || ch === '？')) {
        // Absorb trailing closing punctuation into this chunk.
        let j = i + 1;
        while (j < html.length && /[」』""''\)）\]】]/.test(html[j])) {
          buf += html[j];
          j++;
        }
        // If we are inside open inline tags at this point, close them in the
        // current chunk and reopen at the start of the next chunk.
        const open = tagStack.slice();
        if (open.length) {
          const close = open.slice().reverse().map(t => `</${t}>`).join('');
          const reopen = open.map(t => `<${t}>`).join('');
          out.push(buf + close);
          buf = reopen;
        } else {
          out.push(buf);
          buf = '';
        }
        i = j;
        continue;
      }
      i++;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  function chunkRenderedContent(root) {
    const blocks = root.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6');
    const result = [];
    blocks.forEach(block => {
      const totalNorm = normalizeText(textWithoutRuby(block));
      if (!totalNorm) return;
      const parts = splitHtmlIntoSentences(block.innerHTML);
      if (parts.length <= 1) {
        block.classList.add('reading-chunk');
        block.dataset.norm = totalNorm;
        result.push(block);
        return;
      }
      block.innerHTML = parts.map(p => `<span class="reading-chunk">${p}</span>`).join('');
      block.querySelectorAll(':scope > .reading-chunk').forEach(span => {
        const norm = normalizeText(textWithoutRuby(span));
        if (!norm) {
          // empty after stripping ruby/punct — unwrap
          while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
          span.parentNode.removeChild(span);
          return;
        }
        span.dataset.norm = norm;
        result.push(span);
      });
    });
    return result;
  }

  function computeChunkCharOffsets() {
    let acc = 0;
    chunks.forEach(c => {
      const len = textWithoutRuby(c).length;
      c.dataset.charOffset = String(acc);
      c.dataset.charLen = String(len);
      acc += len;
    });
    totalBookChars = acc;
  }

  function progressForIdx(idx) {
    if (idx < 0 || !chunks[idx] || !totalBookChars) {
      return { current: 0, total: totalBookChars, pct: 0 };
    }
    const c = chunks[idx];
    const off = parseInt(c.dataset.charOffset) || 0;
    const len = parseInt(c.dataset.charLen) || 0;
    const current = off + len;
    const pct = totalBookChars ? (current / totalBookChars) * 100 : 0;
    return { current, total: totalBookChars, pct };
  }

  function formatProgressLabel(p) {
    if (!p.total) return '—';
    switch (progressMode) {
      case 1:
        return `${p.current.toLocaleString()} / ${p.total.toLocaleString()}`;
      case 2:
        return `${(p.total - p.current).toLocaleString()} left`;
      default:
        return `${p.pct.toFixed(1)}%`;
    }
  }

  function refreshProgressBar() {
    const p = progressForIdx(lastMatchedIdx);
    const fill = document.getElementById('readingProgressFill');
    const label = document.getElementById('readingProgressLabel');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, p.pct))}%`;
    if (label) label.textContent = formatProgressLabel(p);
  }

  function showProgressBar() {
    const bar = document.getElementById('readingProgressBar');
    if (!bar) return;
    bar.style.transform = 'translateY(0)';
    progressBarShown = true;
    refreshProgressBar();
  }
  function hideProgressBar() {
    const bar = document.getElementById('readingProgressBar');
    if (!bar) return;
    bar.style.transform = 'translateY(110%)';
    progressBarShown = false;
  }
  function toggleProgressBar() {
    if (progressBarShown) hideProgressBar();
    else showProgressBar();
  }

  window.cycleReadingProgressMode = function () {
    progressMode = (progressMode + 1) % 3;
    setPref(KEYS.PROGRESS_MODE, String(progressMode));
    refreshProgressBar();
  };

  function clearActiveHighlight() {
    if (lastMatchedIdx >= 0 && chunks[lastMatchedIdx]) {
      chunks[lastMatchedIdx].classList.remove('active');
    }
  }

  // Cue-precise highlight. Uses CSS Custom Highlight API to mark just the
  // characters of the currently-playing SRT cue inside a chunk (without
  // mutating the DOM). Falls back silently if the API is unavailable.
  function clearCueHighlight() {
    try { if (window.CSS?.highlights) CSS.highlights.delete('cue-active'); } catch (e) {}
    document.body.classList.remove('has-cue-highlight');
  }
  function setCueHighlight(chunkIdx, cueText) {
    setCueHighlightFor('cue-active', chunkIdx, cueText);
    if (document.body && CSS.highlights?.has?.('cue-active')) {
      document.body.classList.add('has-cue-highlight');
    } else {
      document.body.classList.remove('has-cue-highlight');
    }
  }
  function setCueHighlightFor(name, chunkIdx, cueText) {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined' || !cueText) {
      try { CSS.highlights?.delete?.(name); } catch (e) {}
      return;
    }
    const chunk = chunks[chunkIdx];
    if (!chunk) { try { CSS.highlights.delete(name); } catch (e) {} return; }
    // Collect visible text nodes (skip ruby readings inside <rt>/<rp>).
    const flat = [];
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let cur = node.parentNode;
        while (cur && cur !== chunk) {
          if (cur.tagName === 'RT' || cur.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          cur = cur.parentNode;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) flat.push({ node: n, text: n.nodeValue });
    const flatStr = flat.map(f => f.text).join('');
    const normFlat = normalizeText(flatStr);
    const normCue  = normalizeText(cueText);
    if (!normCue) { clearCueHighlight(); return; }
    const startInNorm = normFlat.indexOf(normCue);
    if (startInNorm < 0) { clearCueHighlight(); return; }
    const endInNorm = startInNorm + normCue.length;
    // Map raw → normalized index by walking once.
    const STRIP = /[\s　「」『』、。・…！？!?,.;:""'']/;
    let rawStart = -1, rawEnd = flatStr.length, rawNormPos = 0;
    for (let i = 0; i < flatStr.length; i++) {
      if (rawStart < 0 && rawNormPos >= startInNorm) rawStart = i;
      if (rawNormPos >= endInNorm) { rawEnd = i; break; }
      if (!STRIP.test(flatStr[i])) rawNormPos++;
    }
    if (rawStart < 0) { clearCueHighlight(); return; }
    // Map raw position back to (node, offset).
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const f of flat) {
      const next = acc + f.text.length;
      if (sNode === null && rawStart < next) { sNode = f.node; sOff = rawStart - acc; }
      if (eNode === null && rawEnd <= next) { eNode = f.node; eOff = rawEnd - acc; break; }
      acc = next;
    }
    if (sNode === null) { try { CSS.highlights.delete(name); } catch (e) {} return; }
    if (eNode === null) {
      eNode = flat[flat.length - 1].node;
      eOff = flat[flat.length - 1].text.length;
    }
    try {
      const range = new Range();
      range.setStart(sNode, sOff);
      range.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      CSS.highlights.set(name, new Highlight(range));
    } catch (e) {
      try { CSS.highlights.delete(name); } catch (er) {}
    }
  }

  // Publishes the audiobook range that corresponds to a chunk (via the
  // chunkToCue map). The dictionary uses these to open the waveform editor
  // for "Add word with sentence audio" flows.
  function publishChunkCueRange(idx) {
    try {
      window._currentReadingAudiobookPath = null;
      window._currentReadingCueStartMs = null;
      window._currentReadingCueEndMs   = null;
      if (!abChunkToCue || idx < 0 || !abAudioPath) return;
      const cueIdx = abChunkToCue[idx];
      if (cueIdx < 0 || !abCues?.[cueIdx]) return;
      window._currentReadingAudiobookPath = abAudioPath;
      window._currentReadingCueStartMs    = abCues[cueIdx].startMs;
      window._currentReadingCueEndMs      = abCues[cueIdx].endMs;
    } catch (e) {}
  }

  function setActive(idx, opts) {
    clearActiveHighlight();
    lastMatchedIdx = idx;
    publishChunkCueRange(idx);
    const el = chunks[idx];
    if (!el) return;
    el.classList.add('active');
    if (opts && opts.instantScroll) el.dataset._instantScroll = '1';
    if (opts && opts.center) el.dataset._scrollCenter = '1';
    if (!el.dataset.counted) {
      const len = textWithoutRuby(el).length;
      if (len > 0) {
        cumulativeChars += len;
        el.dataset.counted = '1';
        setPref(KEYS.CHARS, Math.floor(cumulativeChars));
      }
    }
    const view = document.getElementById('readingModeView');
    if (view && view.style.display !== 'none') {
      paginatedScrollToChunk(el);
    }
    if (progressBarShown) refreshProgressBar();
  }

  // Pseudo-pagination: if the chunk is fully inside the scrollable viewport,
  // do nothing (the highlight just moves within the visible page). If it's
  // not fully visible (advanced past the page edge), smooth-scroll so the
  // chunk lands at the reading-start edge of the viewport.
  //   horizontal mode → top edge
  //   vertical-rl     → right edge (start of inline-flow direction)
  function paginatedScrollToChunk(el) {
    const container = document.getElementById('readingModeContent');
    if (!container) return;
    const isVertical = container.classList.contains('vertical');
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const tol = 2; // px tolerance for "fully visible"

    const fullyVisible =
      eRect.top    >= cRect.top    - tol &&
      eRect.bottom <= cRect.bottom + tol &&
      eRect.left   >= cRect.left   - tol &&
      eRect.right  <= cRect.right  + tol;
    // Skip the visibility shortcut when the caller explicitly asked to
    // CENTER the chunk — user wants it in the middle, not just "somewhere
    // on screen" (matters for the open-reader sync).
    if (fullyVisible && !el.dataset._scrollCenter) return;

    // inline:'start' is the writing-mode-aware start of the inline axis.
    // _instantScroll skips the smooth animation (used on reader-open
    // sync). _scrollCenter centers the chunk vertically — used by
    // syncReaderToCurrentPosition so the user lands with the active line
    // in the middle of the page instead of the top.
    const behavior = el.dataset._instantScroll ? 'instant' : 'smooth';
    const block    = el.dataset._scrollCenter  ? 'center'  : 'start';
    delete el.dataset._instantScroll;
    delete el.dataset._scrollCenter;
    try {
      el.scrollIntoView({ behavior, block, inline: 'start' });
    } catch (e) {
      el.scrollIntoView(true);
    }
  }

  // Tag a chunk with the card index it matches. Only called from
  // syncReadingToCard (audio-driven), where we know the mapping is correct.
  function tagChunkWithCard(idx, cardIdx) {
    const el = chunks[idx];
    if (!el || !Number.isFinite(cardIdx) || cardIdx < 0) return;
    el.dataset.cardIdx = String(cardIdx);
  }

  // Find the first chunk index whose normalized text contains the normalized target.
  function findContainsFrom(targetNorm, startIdx) {
    if (!targetNorm) return -1;
    for (let i = Math.max(0, startIdx); i < chunks.length; i++) {
      if (chunks[i].dataset.norm.includes(targetNorm)) return i;
    }
    return -1;
  }

  // Fuzzy initial alignment: find the first chunk where a substantial prefix of
  // the card text appears. Handles minor edition differences at the start.
  function findInitialAlignment(targetNorm) {
    if (!targetNorm) return -1;
    const minLen = Math.max(6, Math.floor(targetNorm.length * 0.6));
    for (let i = 0; i < chunks.length; i++) {
      const chunkNorm = chunks[i].dataset.norm;
      if (chunkNorm.includes(targetNorm)) return i;
      // Try shrinking prefix from the end down to minLen
      for (let len = targetNorm.length - 1; len >= minLen; len--) {
        if (chunkNorm.includes(targetNorm.slice(0, len))) return i;
      }
    }
    return -1;
  }

  async function syncReadingToCard(expression) {
    if (!chunks.length || !expression) return;
    const target = normalizeText(textWithoutRubyFromHtml(expression));
    if (!target) return;

    let idx = -1;
    if (firstSyncForBook || lastMatchedIdx < 0) {
      idx = findInitialAlignment(target);
      firstSyncForBook = false;
    } else {
      // Steady state: search forward from cursor, then wrap to start.
      idx = findContainsFrom(target, lastMatchedIdx);
      if (idx < 0) idx = findContainsFrom(target, 0);
    }

    if (idx < 0) {
      rlog(`No EPUB chunk matches: "${target.slice(0, 40)}"`);
      return;
    }

    setActive(idx);
    if (typeof window.currentCardIndex === 'number') {
      tagChunkWithCard(idx, window.currentCardIndex);
    }
    const deck = currentDeckName();
    if (deck && currentEpubName) {
      await saveCursor(deck, currentEpubName, idx);
      await savePairing(deck, currentEpubName);
    }
  }

  // card.expression may itself contain HTML (e.g. <ruby>) when sourced from
  // richer fields. Strip tags before normalizing.
  function textWithoutRubyFromHtml(html) {
    if (typeof html !== 'string' || html.indexOf('<') < 0) return html || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return textWithoutRuby(tmp);
  }

  async function pickReadingEpub() {
    if (!isCap() || !window.Capacitor?.Plugins?.FileAccess) {
      alert('Reading mode requires the native FileAccess plugin.');
      return;
    }
    try {
      const { uri, name } = await window.Capacitor.Plugins.FileAccess.pickFileWithUri();
      rlog(`EPUB picked: ${name}`);
      await setPref(KEYS.EPUB_URI, uri);
      await setPref(KEYS.EPUB_NAME, name);
      await loadEpubFromUri(uri, name);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) rlog(`Pick failed: ${msg}`);
    }
  }

  // -------- Audiobook + SRT picking (paired with the loaded deck) --------

  // After picking either file, if the audio view is open AND both files are
  // now paired, kick off playback automatically.
  async function maybeAutoStartAudio(deck) {
    const view = document.getElementById('audiobookModeView');
    if (!view || view.style.display === 'none') return;
    const audio = await getAudiobookPairing(deck);
    const srt = await getSrtPairing(deck);
    if (audio && srt && typeof window.openAudiobookMode === 'function') {
      window.openAudiobookMode({ seekToCurrentPosition: false });
    } else {
      // Still missing one — re-render the inline picker with updated checkmarks.
      renderInlineAudiobookPicker(!audio, !srt);
    }
  }

  async function pickAudiobookFile() {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa) { alert('FileAccess plugin not loaded.'); return; }
    const deck = currentDeckName();
    if (!deck) { alert('Load a deck first so the audiobook can be paired with it.'); return; }
    try {
      const picked = await fa.pickFileWithUri({ kind: 'audio' });
      if (!picked || !picked.uri) return;
      const mat = await fa.materializeToCache({ uri: picked.uri });
      if (!mat || !mat.path) { alert('Audiobook materialize failed.'); return; }
      await saveAudiobookPairing(deck, mat.path, picked.name || 'audiobook');
      rlog(`Audiobook paired with "${deck}": ${picked.name}`);
      await maybeAutoStartAudio(deck);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) alert('Audiobook pick failed: ' + msg);
    }
  }

  async function pickSrtFile() {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa) { alert('FileAccess plugin not loaded.'); return; }
    const deck = currentDeckName();
    if (!deck) { alert('Load a deck first so the SRT can be paired with it.'); return; }
    try {
      // 'any' since SRT mime is typically application/x-subrip and not in
      // most picker filters by default.
      const picked = await fa.pickFileWithUri({ kind: 'any' });
      if (!picked || !picked.uri) return;
      const mat = await fa.materializeToCache({ uri: picked.uri });
      if (!mat || !mat.path) { alert('SRT materialize failed.'); return; }
      await saveSrtPairing(deck, mat.path, picked.name || 'subtitles');
      rlog(`SRT paired with "${deck}": ${picked.name}`);
      await maybeAutoStartAudio(deck);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('cancel')) alert('SRT pick failed: ' + msg);
    }
  }

  window.pickAudiobookFile = pickAudiobookFile;
  window.pickSrtFile = pickSrtFile;

  // -------- Audiobook mode --------

  let abCues = [];
  let abCueToChunk = null;
  let abChunkToCue = null;
  let abCurrentCueIdx = -1;
  let abAudioPath = null;
  let abAudioName = '';
  let abListenersAttached = false;
  let abScrubbing = false;
  let abPositionRef = { ms: 0, durMs: 0 };

  function abFmtMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '–:––';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  // Render an inline picker UI inside the audiobook view's cue text area —
  // used when the user opens AUDIO mode but no pairing is set for the deck.
  function renderInlineAudiobookPicker(missingAudio, missingSrt) {
    const cueEl = document.getElementById('audiobookCueText');
    if (!cueEl) return;
    const deck = currentDeckName() || 'this deck';
    cueEl.innerHTML = `
      <div style="max-width:420px;margin:0 auto;text-align:left;font-size:1rem;line-height:1.6;">
        <div style="font-size:1.2rem;color:#00ffcc;margin-bottom:14px;font-weight:600;">Audiobook not paired</div>
        <div style="color:#aaa;margin-bottom:18px;">No ${[missingAudio ? 'audiobook' : null, missingSrt ? 'SRT' : null].filter(Boolean).join(' or ')} is paired with <b>${deck}</b>. Pick one of each, then tap AUDIO again to start.</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button onclick="window.pickAudiobookFile && window.pickAudiobookFile()" style="padding:14px;background:${missingAudio ? '#2196f3' : '#333'};color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer;">${missingAudio ? '🎧 Pick audiobook (.mp3/.m4b)' : '🎧 Audiobook ✓ (re-pick)'}</button>
          <button onclick="window.pickSrtFile && window.pickSrtFile()" style="padding:14px;background:${missingSrt ? '#2196f3' : '#333'};color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer;">${missingSrt ? '📄 Pick SRT (.srt)' : '📄 SRT ✓ (re-pick)'}</button>
        </div>
      </div>
    `;
  }

  // Public setter for SRT-card titles (deck-less, no EPUB). app.js's
  // loadTitleAsSrtCards already parsed the SRT; we just plumb it into
  // the closure state so abUpdateCueDisplay works and the position
  // listener gets attached.
  window.setAudiobookContextForSrtCards = function ({ audioPath, audioName, cues }) {
    if (!Array.isArray(cues) || !cues.length || !audioPath) return;
    abAudioPath = audioPath;
    abAudioName = audioName || 'Audiobook';
    abCues = cues;
    // Expose path globally so reader-mode PLAY can route through bg even
    // when no chunk-cue is bound yet (publishChunkCueRange only fires
    // after a setActive call).
    window._audiobookSrcPath = audioPath;
    abAttachListenersOnce();
  };

  // Data-only cue context loader — pulls the SRT into abCues and builds
  // cue↔chunk maps without showing any UI. Used by loadEpubFromUri so the
  // reading-mode highlight can follow audio even when the user never opens
  // the audio mode view.
  async function ensureCueContextLoaded() {
    // Cues already loaded — but maps may not be built yet if cues were
    // loaded BEFORE chunks (e.g. user opened audio mode before reader).
    // Rebuild if needed; otherwise we're done.
    if (abCues.length) {
      const needsMaps = chunks.length &&
        (!abCueToChunk || abCueToChunk.length !== abCues.length);
      if (needsMaps && window.srtParser?.buildCueChunkMaps) {
        const maps = window.srtParser.buildCueChunkMaps(abCues, chunks, (s) => normalizeText(s));
        abCueToChunk = maps.cueToChunk;
        abChunkToCue = maps.chunkToCue;
        let matched = 0;
        for (let i = 0; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) matched++;
        rlog(`Rebuilt cue maps post-chunks: ${matched}/${abCues.length} cues mapped`);
      }
      return true;
    }
    const deck = currentDeckName();
    if (!deck) return false;
    const audio = await getAudiobookPairing(deck);
    const srt   = await getSrtPairing(deck);
    if (!audio || !srt) return false;
    abAudioPath = audio.path;
    abAudioName = audio.name;
    window._audiobookSrcPath = audio.path;
    try {
      const url = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(srt.path) : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) return false;
      const text = await res.text();
      abCues = window.srtParser.parseSrt(text);
    } catch (e) { return false; }
    if (chunks.length && abCues.length && window.srtParser?.buildCueChunkMaps) {
      const maps = window.srtParser.buildCueChunkMaps(abCues, chunks, (s) => normalizeText(s));
      abCueToChunk = maps.cueToChunk;
      abChunkToCue = maps.chunkToCue;
    }
    // Mark pre-warm successful so a later openAudiobookMode skips re-loading.
    abContextLoadedForDeck = deck;
    return true;
  }

  // Pre-warm: if we've already loaded the cue context for the current deck,
  // openAudiobookMode can skip the "Loading audiobook…" placeholder. Tracks
  // by deck name; null if a fresh load is needed.
  let abContextLoadedForDeck = null;

  function invalidateAbContext() {
    abContextLoadedForDeck = null;
  }
  window.invalidateAbContext = invalidateAbContext;

  async function abLoadContextForCurrentDeck() {
    const deck = currentDeckName();
    if (!deck) {
      // Show inline message instead of an alert.
      const cueEl = document.getElementById('audiobookCueText');
      if (cueEl) cueEl.textContent = 'Load a deck first, then return to the AUDIO tab.';
      return false;
    }
    const audio = await getAudiobookPairing(deck);
    const srt = await getSrtPairing(deck);
    if (!audio || !srt) {
      renderInlineAudiobookPicker(!audio, !srt);
      // Also make sure the audiobook view is visible so the user sees the picker.
      const view = document.getElementById('audiobookModeView');
      if (view) view.style.display = 'flex';
      return false;
    }
    // Fast path: pre-warmed for this deck, paths unchanged. Skip the
    // ~500 ms SRT fetch+parse+map. Caller hides "Loading audiobook…".
    if (abContextLoadedForDeck === deck && abCues?.length && abAudioPath === audio.path) {
      return true;
    }
    abAudioPath = audio.path;
    abAudioName = audio.name;
    window._audiobookSrcPath = audio.path;
    // Read + parse SRT from cache file. Use convertFileSrc so the WebView's
    // local server serves the file via its allowed origin (raw file:// won't
    // work for arbitrary paths inside the WebView fetch sandbox).
    try {
      const url = (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function')
        ? window.Capacitor.convertFileSrc(srt.path)
        : 'file://' + srt.path;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch status ${res.status}`);
      const text = await res.text();
      abCues = window.srtParser.parseSrt(text);
      rlog(`SRT: ${abCues.length} cues from ${srt.name}`);
    } catch (e) {
      alert('Failed to read SRT: ' + (e?.message || e));
      return false;
    }
    // Build cue↔chunk maps (uses already-loaded EPUB chunks).
    if (chunks.length && abCues.length) {
      const maps = window.srtParser.buildCueChunkMaps(abCues, chunks, (s) => normalizeText(s));
      abCueToChunk = maps.cueToChunk;
      abChunkToCue = maps.chunkToCue;
      let matched = 0;
      for (let i = 0; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) matched++;
      rlog(`Cue↔chunk: ${matched}/${abCues.length} cues mapped`);
    } else {
      abCueToChunk = null;
      abChunkToCue = null;
      rlog('No EPUB chunks yet — cue↔chunk mapping skipped');
    }
    abContextLoadedForDeck = deck;
    return true;
  }

  // Synchronous path: cue idx → text, chunk highlight, cue-precise paint.
  // Runs every position event. Nothing here can await — that was the bug
  // where a hung await on titleStore.list() (Preferences plugin slowness)
  // would block the highlight sync forever after the first cue painted.
  function abUpdateCueDisplay(positionMs) {
    if (!abCues.length) {
      console.log('[abUpdate] abCues empty; pos=' + positionMs);
      return;
    }
    const idx = window.srtParser.findCueAtTime(abCues, positionMs);
    if (idx === abCurrentCueIdx) return;
    abCurrentCueIdx = idx;
    const cueEl = document.getElementById('audiobookCueText');
    if (cueEl) cueEl.textContent = idx >= 0 ? abCues[idx].text : '…';
    console.log('[abUpdate] cue=' + idx + ' pos=' + positionMs +
      ' mapsReady=' + !!abCueToChunk + ' chunks=' + chunks.length);

    // Reading-mode highlight sync: chunk active class + cue-precise CSS
    // highlight. Done FIRST (synchronously) so it stays reliable.
    if (abCueToChunk && idx >= 0) {
      let chunkIdx = abCueToChunk[idx];
      if (chunkIdx < 0) {
        let prevCue = -1, prevChunk = -1;
        for (let i = idx - 1; i >= 0; i--) {
          if (abCueToChunk[i] >= 0) { prevCue = i; prevChunk = abCueToChunk[i]; break; }
        }
        let nextCue = -1, nextChunk = -1;
        for (let i = idx + 1; i < abCueToChunk.length; i++) {
          if (abCueToChunk[i] >= 0) { nextCue = i; nextChunk = abCueToChunk[i]; break; }
        }
        if (prevChunk >= 0 && nextChunk >= 0 && nextCue > prevCue) {
          const ratio = (idx - prevCue) / (nextCue - prevCue);
          chunkIdx = Math.round(prevChunk + ratio * (nextChunk - prevChunk));
        } else if (prevChunk >= 0) chunkIdx = prevChunk;
        else if (nextChunk >= 0) chunkIdx = nextChunk;
      }
      if (chunkIdx >= 0 && chunkIdx !== lastMatchedIdx) {
        setActive(chunkIdx);
        if (typeof window.currentCardIndex === 'number') tagChunkWithCard(chunkIdx, window.currentCardIndex);
      }
      if (chunkIdx >= 0 && idx >= 0 && abCues[idx]) {
        setCueHighlight(chunkIdx, abCues[idx].text);
      } else {
        clearCueHighlight();
      }
    }

    // Lock screen + audio view image — fire-and-forget. Any latency on
    // the Preferences plugin (titleStore.list) is isolated from the
    // highlight path above.
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg && idx >= 0) {
      bg.setMetadata({ title: abAudioName || 'Audiobook', subtitle: abCues[idx].text }).catch(() => {});
    }
    updateAudiobookCardImage(idx);
  }

  // Image-resolution side-effect — runs async, isolated from cue sync.
  async function updateAudiobookCardImage(idx) {
    const imgEl = document.getElementById('audiobookCardImage');
    if (!imgEl) return;
    let src = '';
    try {
      if (window._activeTitleId && window.titleStore?.list) {
        const titles = await window.titleStore.list();
        const tit = titles.find(t => t.id === window._activeTitleId);
        if (tit?.attachments?.cover?.dataUri) src = tit.attachments.cover.dataUri;
      }
    } catch (e) {}
    if (!src && abCueToChunk && idx >= 0) {
      const chunkIdx = abCueToChunk[idx];
      if (chunkIdx >= 0 && Array.isArray(window.allNotes)) {
        const card = window.allNotes[chunkIdx];
        const m = card?.imageHtml?.match(/src="([^"]+)"/);
        if (m) src = m[1];
      }
    }
    if (src && imgEl.src !== src) imgEl.src = src;
    imgEl.style.display = src ? '' : 'none';
  }

  function abAttachListenersOnce() {
    if (abListenersAttached) return;
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    abListenersAttached = true;
    bg.addListener('position', (d) => {
      abPositionRef.ms = d.positionMs || 0;
      abPositionRef.durMs = d.durationMs || 0;
      const label = document.getElementById('audiobookTimeLabel');
      if (label) label.textContent = `${abFmtMs(abPositionRef.ms)} / ${abFmtMs(abPositionRef.durMs)}`;
      if (!abScrubbing) {
        const scrub = document.getElementById('audiobookScrub');
        if (scrub && abPositionRef.durMs > 0) {
          scrub.value = String(Math.round((abPositionRef.ms / abPositionRef.durMs) * 1000));
        }
      }
      abUpdateCueDisplay(abPositionRef.ms);
    });
    bg.addListener('state', (d) => {
      const btn = document.getElementById('audiobookPlayPause');
      if (btn) btn.textContent = d.playing ? 'PAUSE' : 'PLAY';
    });
    bg.addListener('ended', () => {
      const btn = document.getElementById('audiobookPlayPause');
      if (btn) btn.textContent = 'PLAY';
    });
    bg.addListener('error', (d) => {
      alert('Audiobook playback error: ' + (d?.message || 'unknown'));
    });
  }

  function abAttachScrubControl() {
    const scrub = document.getElementById('audiobookScrub');
    if (!scrub || scrub.dataset.wired === '1') return;
    scrub.dataset.wired = '1';
    scrub.addEventListener('touchstart', () => { abScrubbing = true; });
    scrub.addEventListener('mousedown', () => { abScrubbing = true; });
    scrub.addEventListener('change', async () => {
      const bg = window.Capacitor?.Plugins?.BackgroundAudio;
      const v = parseInt(scrub.value);
      if (bg && abPositionRef.durMs > 0 && Number.isFinite(v)) {
        const targetMs = Math.round((v / 1000) * abPositionRef.durMs);
        await bg.seek({ ms: targetMs });
      }
      abScrubbing = false;
    });
  }

  window.openAudiobookMode = async function (opts) {
    opts = opts || {};
    // Show the audiobook view IMMEDIATELY (before any awaits) so the user
    // doesn't see card mode flashing through during async context loading.
    const view = document.getElementById('audiobookModeView');
    if (view) {
      view.style.display = 'flex';
      // Only show the "Loading audiobook…" placeholder when we actually have
      // to load. If the reader already pre-warmed the cue context for this
      // deck, skip the message — it'd flash visibly for ~0 ms.
      const deck = currentDeckName();
      const isPreWarmed = abContextLoadedForDeck === deck && abCues?.length;
      if (!isPreWarmed) {
        const cueEl = document.getElementById('audiobookCueText');
        if (cueEl) cueEl.textContent = 'Loading audiobook…';
      }
    }
    const ok = await abLoadContextForCurrentDeck();
    if (!ok) return;
    if (!view) return;
    setPref(KEYS.AUDIOBOOK_OPEN, 'true');
    const titleEl = document.getElementById('audiobookTitle');
    if (titleEl) titleEl.textContent = abAudioName || 'Audiobook';
    abAttachListenersOnce();
    abAttachScrubControl();
    window.audiobookActive = true;
    if (typeof window.stopCardAudio === 'function') window.stopCardAudio();
    const cueEl = document.getElementById('audiobookCueText');
    if (cueEl) cueEl.textContent = '…';
    // Decide startMs. Default: resume from last saved position for this deck.
    // If opts.seekToCurrentPosition (shell tab switch): derive from
    //   (a) SRT-card mode → current card's audiobookStartMs (most direct)
    //   (b) Read-mode chunk → chunkToCue[lastMatchedIdx] → cue.startMs
    const deck = currentDeckName();
    let startMs = 0;
    const card = Array.isArray(window.allNotes) ? window.allNotes[window.currentCardIndex] : null;
    if (opts.seekToCurrentPosition) {
      if (card?.isSrtCard && Number.isFinite(card.audiobookStartMs)) {
        startMs = card.audiobookStartMs;
      } else if (abChunkToCue && lastMatchedIdx >= 0) {
        const cueIdx = abChunkToCue[lastMatchedIdx];
        if (cueIdx >= 0 && abCues[cueIdx]) startMs = abCues[cueIdx].startMs;
      }
    }
    if (!startMs) {
      const last = await getAudiobookLastPosition(deck);
      startMs = last.ms || 0;
    }
    console.log('[ab] openAudiobookMode seek=' + !!opts.seekToCurrentPosition +
      ' isSrt=' + !!card?.isSrtCard +
      ' cardStart=' + (card?.audiobookStartMs ?? 'n/a') +
      ' chunkIdx=' + lastMatchedIdx +
      ' → startMs=' + startMs);
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg) {
      const url = abAudioPath.startsWith('file://') ? abAudioPath : 'file://' + abAudioPath;
      const rate = parseFloat(window.audioPlaybackRate) || 1.0;
      const adjStart = Math.max(0, Math.round(startMs) - (window.AUDIO_START_OFFSET_MS || 0));
      await bg.play({ url, startMs: adjStart, rate });
      bg.setMetadata({ title: abAudioName || 'Audiobook', subtitle: '' }).catch(() => {});
      // Force an immediate cue update so the subtitle appears before the
      // first periodic position event arrives (saves user a play/pause toggle).
      const initialPoll = async (delay) => {
        try {
          const s = await bg.getState();
          if (s && (s.ready || s.positionMs > 0)) {
            // Reset abCurrentCueIdx so abUpdateCueDisplay forces a re-render.
            abCurrentCueIdx = -2;
            abUpdateCueDisplay(s.positionMs || startMs);
          }
        } catch (e) {}
      };
      setTimeout(() => initialPoll(300), 300);
      setTimeout(() => initialPoll(900), 900);
    }
  };

  window.closeAudiobookMode = async function () {
    const view = document.getElementById('audiobookModeView');
    if (view) view.style.display = 'none';
    await setPref(KEYS.AUDIOBOOK_OPEN, 'false');
    // Pause + save position so re-entry into reading mode can show the dialog.
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg) {
      try { await bg.pause(); } catch (e) {}
    }
    const deck = currentDeckName();
    if (deck) {
      const chunkIdx = (abCueToChunk && abCurrentCueIdx >= 0) ? abCueToChunk[abCurrentCueIdx] : -1;
      await saveAudiobookLastPosition(deck, abPositionRef.ms, chunkIdx);
    }
    // Card mode can resume normal audio playback now.
    window.audiobookActive = false;
  };

  window.audiobookTogglePlay = async function () {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    const s = await bg.getState();
    if (s.playing) await bg.pause();
    else await bg.resume();
  };

  window.audiobookSkip = async function (deltaMs) {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return;
    const s = await bg.getState();
    const target = Math.max(0, (s.positionMs || 0) + deltaMs);
    await bg.seek({ ms: target });
  };

  // -------- Audiobook → other-mode re-entry dialog --------
  //
  // Triggered when the user switches OUT of audio to card/read mode. If the
  // audiobook drifted far from the reading cursor (>2 chunks), ask whether to
  // keep the cursor, jump to where audio is, or jump + summarize.

  // Master playhead threshold: prompt only if audio has drifted >60 s from
  // the cursor. Time-based (not chunk-count-based) so it works for both
  // EPUB chunks (uneven length) and SRT-cards.
  const REENTRY_THRESHOLD_MS = 60 * 1000;
  let reentryPendingAudioChunk = -1;
  let _reentryResolve = null;

  // Returns a promise that resolves to 'cursor' | 'audio' | 'summary' | null
  // ('null' when no dialog was needed, i.e. positions are close enough).
  window.maybeShowAudioReentryDialog = function () {
    return new Promise((resolve) => {
      let audioChunk = -1, cursor = -1;
      let audioMs = abPositionRef.ms || 0;
      let cursorMs = 0;
      if (abCueToChunk && abCurrentCueIdx >= 0) {
        audioChunk = abCueToChunk[abCurrentCueIdx];
        cursor = lastMatchedIdx;
        // Cursor → cue time via the chunk→cue map.
        if (cursor >= 0 && abChunkToCue) {
          const cueIdxForCursor = abChunkToCue[cursor];
          if (cueIdxForCursor >= 0 && abCues[cueIdxForCursor]) {
            cursorMs = abCues[cueIdxForCursor].startMs;
          }
        }
      } else if (abCurrentCueIdx >= 0 &&
                 Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard) {
        audioChunk = abCurrentCueIdx;
        cursor = typeof window.currentCardIndex === 'number' ? window.currentCardIndex : -1;
        if (cursor >= 0 && abCues[cursor]) cursorMs = abCues[cursor].startMs;
      }
      if (audioChunk < 0 || cursor < 0) { resolve(null); return; }
      const deltaMs = Math.abs(audioMs - cursorMs);
      if (deltaMs < REENTRY_THRESHOLD_MS) { resolve(null); return; }
      reentryPendingAudioChunk = audioChunk;
      const modal = document.getElementById('audiobookReentryModal');
      const txt = document.getElementById('audiobookReentryText');
      if (txt) {
        const dir = audioMs > cursorMs ? 'ahead of' : 'behind';
        const minutes = (deltaMs / 60000).toFixed(1);
        txt.textContent = `Audio is ${minutes} minute${minutes === '1.0' ? '' : 's'} ${dir} your last position. Jump or stay?`;
      }
      if (!modal) { resolve(null); return; }
      _reentryResolve = resolve;
      modal.style.display = 'flex';
    });
  };

  window.reentryChoose = function (choice) {
    const modal = document.getElementById('audiobookReentryModal');
    if (modal) modal.style.display = 'none';
    const target = reentryPendingAudioChunk;
    if (choice === 'audio' || choice === 'summary') {
      const isSrtCardsMode = Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard;
      if (isSrtCardsMode && typeof window.updateCardIndex === 'function' && target >= 0) {
        // In SRT-cards mode the chunk index IS the card index.
        window.updateCardIndex(target);
      } else if (target >= 0 && chunks[target]) {
        // EPUB chunk-based: highlight the matching chunk in reading mode.
        setActive(target);
      }
      if (choice === 'summary') {
        alert('AI summary not yet implemented — jumped to the audio position instead.');
      }
    }
    // 'cursor' → no-op
    const r = _reentryResolve;
    _reentryResolve = null;
    reentryPendingAudioChunk = -1;
    if (r) r(choice);
  };

  async function loadEpubFromUri(uri, name) {
    const content = document.getElementById('readingModeContent');
    const title = document.getElementById('readingModeTitle');
    title.textContent = `Loading ${name}…`;
    content.innerHTML = `<p style="color:#888;text-align:center;margin-top:40vh;">Loading ${name}…</p>`;

    const { path } = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri });
    const response = await fetch(window.Capacitor.convertFileSrc(path));
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();

    const zip = await JSZip.loadAsync(blob);

    const containerXml = await zip.file('META-INF/container.xml')?.async('string');
    if (!containerXml) throw new Error('Not a valid EPUB (no META-INF/container.xml)');
    const opfPath = new DOMParser()
      .parseFromString(containerXml, 'application/xml')
      .querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('No OPF rootfile in container.xml');

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

    rlog(`EPUB has ${spineOrder.length} spine items`);

    const sections = [];
    for (const href of spineOrder) {
      const fullPath = (opfDir + href).replace(/^\//, '');
      const file = zip.file(fullPath);
      if (!file) continue;
      const html = await file.async('string');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, link').forEach(el => el.remove());
      doc.querySelectorAll('img, image').forEach(el => el.remove());
      const body = doc.body;
      if (body) sections.push(body.innerHTML);
    }

    content.innerHTML = sections.join('\n<hr style="border:0;border-top:1px solid #333;margin:32px 0;">\n');
    content.scrollTop = 0;
    title.textContent = name;
    currentEpubName = name;
    rlog(`EPUB rendered: ${sections.length} sections`);

    chunks = chunkRenderedContent(content);
    computeChunkCharOffsets();
    lastMatchedIdx = -1;
    firstSyncForBook = true;
    rlog(`Indexed ${chunks.length} reading chunks (${totalBookChars.toLocaleString()} chars)`);
    refreshProgressBar();
    // Load SRT cues + build cue↔chunk maps so read-mode highlight follows
    // audio even when the user never opened the audio-mode view. Quiet:
    // no UI side-effects. Also attach the BG-audio position listener that
    // drives abUpdateCueDisplay (normally attached by openAudiobookMode).
    if (await ensureCueContextLoaded()) {
      let matched = 0;
      if (abCueToChunk) {
        for (let i = 0; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) matched++;
      }
      rlog(`Cue↔chunk ready: ${matched}/${abCues.length} cues mapped`);
      abAttachListenersOnce();
    }

    // Restore cursor if we have a saved one for this (deck, epub) pair.
    const deck = currentDeckName();
    if (deck) {
      const savedIdx = await getCursor(deck, name);
      if (savedIdx >= 0 && savedIdx < chunks.length) {
        setActive(savedIdx);
        firstSyncForBook = false;
        rlog(`Restored cursor to chunk ${savedIdx}`);
      }
      await savePairing(deck, name);
    }

    // If a card is already current, sync right away.
    if (window.currentCardIndex != null && Array.isArray(window.allNotes) && window.allNotes.length) {
      const card = window.allNotes[window.currentCardIndex];
      if (card?.expression) syncReadingToCard(card.expression);
    }
  }

  // Render empty-state UI in the reading view when no EPUB is paired with
  // the current deck (or no deck loaded). Also wipes any stale chunks from
  // a previously-loaded EPUB so the user doesn't see the wrong book.
  function renderReadingEmptyState(message) {
    const content = document.getElementById('readingModeContent');
    const title = document.getElementById('readingModeTitle');
    if (content) {
      content.innerHTML = `
        <div style="text-align:center;margin-top:25vh;color:#888;line-height:1.6;">
          <div style="font-size:1.05rem;margin-bottom:14px;">${message}</div>
          <div style="font-size:0.9rem;color:#666;">Open <b>MORE → Pick EPUB</b> to choose one.</div>
        </div>`;
    }
    if (title) title.textContent = 'No EPUB loaded';
    chunks = [];
    lastMatchedIdx = -1;
    currentEpubName = null;
    totalBookChars = 0;
  }

  async function restoreLastEpub() {
    const deck = currentDeckName();
    if (!deck) {
      renderReadingEmptyState('No deck loaded.');
      return;
    }
    const name = await getPairedEpub(deck);
    if (!name) {
      renderReadingEmptyState(`No EPUB paired with <b>${deck}</b>.`);
      return;
    }
    let uri = null;
    const lastName = await getPref(KEYS.EPUB_NAME);
    if (lastName === name) {
      uri = await getPref(KEYS.EPUB_URI);
    }
    if (!uri) {
      renderReadingEmptyState(`The paired EPUB (<b>${name}</b>) is no longer accessible.`);
      return;
    }
    try {
      await loadEpubFromUri(uri, name);
    } catch (e) {
      rlog(`Restore failed: ${e.message}`);
      const content = document.getElementById('readingModeContent');
      content.innerHTML = `<p style="color:#f66;text-align:center;margin-top:40vh;">Could not reopen ${name}: ${e.message}<br>Use MORE → Library to pick again.</p>`;
    }
  }

  // Wire a one-time scroll listener on the content area: any non-trivial
  // scroll counts as "actively reading" and starts/refreshes the read
  // timer. Casual background taps are intentionally NOT enough.
  function installReadActivityHooks() {
    const content = document.getElementById('readingModeContent');
    if (!content || content.dataset.statsHooked === '1') return;
    content.dataset.statsHooked = '1';
    let lastScrollTop = content.scrollTop;
    content.addEventListener('scroll', () => {
      if (Math.abs(content.scrollTop - lastScrollTop) < 8) return;
      lastScrollTop = content.scrollTop;
      if (window.stats?.bumpRead) window.stats.bumpRead();
    }, { passive: true });
  }

  // Session-level "warm" flag. The first openReadingMode does the heavy
  // setup (font prefs, hooks, prefs reads). Subsequent calls within the
  // session skip all of it — chunks + DOM are already in memory, hooks
  // are already attached, prefs values are still valid. This keeps tab
  // switches into READ snappy (sub-100 ms) instead of paying ~500 ms of
  // sequential Capacitor Preferences round-trips every time.
  let readerWarmed = false;

  window.openReadingMode = async function () {
    rlog('Opening reading mode');
    const view = document.getElementById('readingModeView');
    view.style.display = 'flex';
    const content = document.getElementById('readingModeContent');

    // Warm path: just snap + show. The expensive prefs are already
    // applied; their values haven't changed since they were last read.
    if (readerWarmed) {
      if (content) content.style.opacity = '1';
      setPref(KEYS.MODE_OPEN, 'true');
      startTimer();
      // Sync still needs to run — playhead may have moved while in
      // another mode. syncReader is fast (~5 ms of array walks + a
      // scrollIntoView), so just await it; no opacity fade needed.
      await syncReaderToCurrentPosition();
      return;
    }

    // Cold path: do the expensive setup once. Keep content invisible
    // while everything wires up so the user doesn't see a flash of
    // unstyled content / scroll-to-top.
    if (content) {
      content.style.opacity = '0';
      content.style.transition = 'opacity 0.15s ease';
    }
    // Run every awaitable piece concurrently. Each Capacitor Preferences
    // call hops the bridge; running them sequentially burned ~500 ms.
    const deck = currentDeckName();
    const [, storedSec, storedChars, storedMode, pairedName] = await Promise.all([
      applyFontPrefs(),
      getPref(KEYS.TIME_SEC),
      getPref(KEYS.CHARS),
      getPref(KEYS.PROGRESS_MODE),
      deck ? getPairedEpub(deck) : Promise.resolve(null)
    ]);
    cumulativeSec = parseInt(storedSec) || 0;
    cumulativeChars = parseInt(storedChars) || 0;
    const m = parseInt(storedMode);
    if (Number.isFinite(m) && m >= 0 && m < 3) progressMode = m;
    const label = document.getElementById('readingTimerLabel');
    if (label) label.textContent = formatSec(cumulativeSec);

    installReadActivityHooks();
    installContentTapHandler();
    startInactivityWatcher();
    refreshPlayPauseButton();
    startPlayStatePoll();
    setPref(KEYS.MODE_OPEN, 'true');
    startTimer();
    if (pairedName !== currentEpubName) {
      await restoreLastEpub();
    }
    await syncReaderToCurrentPosition();
    if (content) {
      requestAnimationFrame(() => { content.style.opacity = '1'; });
    }
    readerWarmed = true;
  };

  // Title swap invalidates the warm flag — new title may have different
  // font/highlight prefs, and EPUB pairing has to be re-resolved.
  window.addEventListener('shell:title-change', () => { readerWarmed = false; });

  // Open-reader and tab-switch sync: locate the chunk that matches the
  // current playhead (audio cue → mapped chunk, else the current card's
  // expression text, else the last-matched cursor), highlight it, and
  // center it on screen — no smooth animation.
  async function syncReaderToCurrentPosition() {
    try {
      rlog(`syncReader start: chunks=${chunks?.length || 0} cues=${abCues?.length || 0} ` +
           `mapsReady=${!!abCueToChunk} cardIdx=${window.currentCardIndex} ` +
           `audioMs=${abPositionRef?.ms || 0} lastMatched=${lastMatchedIdx}`);
      if (!chunks?.length) return;
      let cueIdx = -1;
      let chunkIdx = -1;
      let how = '';

      // 1) Audio position → cue → chunk.
      if (abCues?.length && Number.isFinite(abPositionRef?.ms) && abPositionRef.ms > 0) {
        cueIdx = window.srtParser.findCueAtTime(abCues, abPositionRef.ms);
        if (cueIdx >= 0 && abCueToChunk && abCueToChunk[cueIdx] >= 0) {
          chunkIdx = abCueToChunk[cueIdx];
          how = 'audio-position';
        }
      }

      // 2) SRT-card titles: card index IS cue index. Use map directly with
      //    neighbor-walk fallback for unmapped cues.
      if (chunkIdx < 0 && Array.isArray(window.allNotes) &&
          window.allNotes[0]?.isSrtCard && abCueToChunk) {
        const ci = window.currentCardIndex;
        if (Number.isFinite(ci) && ci >= 0 && ci < abCueToChunk.length) {
          cueIdx = ci;
          chunkIdx = abCueToChunk[ci];
          how = 'srt-card-index';
          if (chunkIdx < 0) {
            let prev = -1, next = -1;
            for (let i = ci - 1; i >= 0; i--) if (abCueToChunk[i] >= 0) { prev = abCueToChunk[i]; break; }
            for (let i = ci + 1; i < abCueToChunk.length; i++) if (abCueToChunk[i] >= 0) { next = abCueToChunk[i]; break; }
            if (prev >= 0 && next >= 0) chunkIdx = Math.round((prev + next) / 2);
            else if (prev >= 0) chunkIdx = prev;
            else if (next >= 0) chunkIdx = next;
            if (chunkIdx >= 0) how = 'srt-card-neighbor';
          }
        }
      }

      // 3) Deck card → matched cue (via SRT text) → chunk. Walks abCues
      //    looking for one whose text contains the card's expression;
      //    then uses abCueToChunk for the chunk. More reliable than
      //    matching card.expression directly against chunks (cue text
      //    is closer to chunk text than card text is).
      if (chunkIdx < 0 && abCues?.length && abCueToChunk &&
          Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        const cardText = card?.expression
          ? normalizeText(textWithoutRubyFromHtml(card.expression)) : '';
        if (cardText) {
          for (let i = 0; i < abCues.length; i++) {
            if (normalizeText(abCues[i].text).includes(cardText)) {
              if (abCueToChunk[i] >= 0) {
                cueIdx = i;
                chunkIdx = abCueToChunk[i];
                how = 'card-text→cue→chunk';
              }
              break;
            }
          }
        }
      }

      // 4) Direct chunk text match (existing path).
      if (chunkIdx < 0 && Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        if (card?.expression) {
          const target = normalizeText(textWithoutRubyFromHtml(card.expression));
          if (target) {
            const idx = findContainsFrom(target, 0);
            if (idx >= 0) {
              chunkIdx = idx;
              how = 'card-text→chunk';
              if (abChunkToCue && abChunkToCue[idx] >= 0) cueIdx = abChunkToCue[idx];
            }
          }
        }
      }

      // 5) Last-matched cursor.
      if (chunkIdx < 0 && lastMatchedIdx >= 0) {
        chunkIdx = lastMatchedIdx;
        how = 'last-cursor';
      }

      if (chunkIdx < 0 || !chunks[chunkIdx]) {
        rlog(`syncReader → NO MATCH (chunks=${chunks?.length} cues=${abCues?.length} cardIdx=${window.currentCardIndex})`);
        return;
      }
      rlog(`syncReader → chunk ${chunkIdx} (cue ${cueIdx}) via ${how}`);

      setActive(chunkIdx, { instantScroll: true, center: true });

      let highlightText = '';
      if (cueIdx >= 0 && abCues?.[cueIdx]) highlightText = abCues[cueIdx].text;
      else if (Array.isArray(window.allNotes)) {
        const card = window.allNotes[window.currentCardIndex];
        if (card?.expression) highlightText = textWithoutRubyFromHtml(card.expression);
      }
      if (highlightText) setCueHighlight(chunkIdx, highlightText);
    } catch (e) {
      rlog('syncReader error: ' + (e?.message || e));
    }
  }
  window.syncReaderToCurrentPosition = syncReaderToCurrentPosition;

  window.closeReadingMode = async function () {
    rlog('Closing reading mode');
    await stopTimer();
    stopPlayStatePoll();
    stopInactivityWatcher();
    await setPref(KEYS.MODE_OPEN, 'false');
    document.getElementById('readingModeView').style.display = 'none';
  };

  window.pickReadingEpub = pickReadingEpub;
  window.syncReadingToCard = syncReadingToCard;

  window.openReadingSettings = async function () {
    const modal = document.getElementById('readingSettingsModal');
    modal.style.display = 'flex';
    const fontSelect = document.getElementById('readerFontSelect');
    const sizeSlider = document.getElementById('readerFontSizeSlider');
    const sizeLabel = document.getElementById('readerFontSizeLabel');
    const verticalToggle = document.getElementById('readerVerticalToggle');
    const autoToggle = document.getElementById('readerAutoAdvanceToggle');
    const hiInput = document.getElementById('readerHighlightColor');
    const savedFont = (await getPref(KEYS.FONT)) || 'serif';
    const savedSize = parseFloat(await getPref(KEYS.FONT_SIZE)) || 1.1;
    fontSelect.value = savedFont;
    if (fontSelect.value !== savedFont) {
      const opt = document.createElement('option');
      opt.value = savedFont;
      opt.textContent = savedFont;
      fontSelect.appendChild(opt);
      fontSelect.value = savedFont;
    }
    sizeSlider.value = savedSize;
    sizeLabel.textContent = savedSize.toFixed(2) + 'rem';
    if (verticalToggle) {
      verticalToggle.checked = (await getPref(KEYS.VERTICAL)) === 'true';
    }
    const speedSlider = document.getElementById('readerSpeedSlider');
    const speedLabel = document.getElementById('readerSpeedLabel');
    if (speedSlider) {
      // Reuse the main AUDIO_SPEED pref so deck-view + reading stay in sync.
      let saved = parseFloat(await (async () => {
        if (isCap() && window.Capacitor?.Plugins?.Preferences) {
          const r = await window.Capacitor.Plugins.Preferences.get({ key: 'AUDIO_SPEED' });
          return r.value;
        }
        return localStorage.getItem('AUDIO_SPEED');
      })());
      if (!Number.isFinite(saved) || saved <= 0) saved = 1;
      if (saved > 2) saved = 2; // slider max
      speedSlider.value = saved;
      if (speedLabel) speedLabel.textContent = saved.toFixed(2) + '×';
    }
    if (autoToggle) {
      const auto = await getPref(KEYS.AUTO_ADVANCE);
      autoToggle.checked = auto !== 'false';
    }
    // Audiobook + SRT pairing button labels — show paired filename if any.
    const deckNow = currentDeckName();
    const audioBtn = document.getElementById('readerPickAudiobookBtn');
    if (audioBtn) {
      const ab = deckNow ? await getAudiobookPairing(deckNow) : null;
      audioBtn.textContent = ab ? ab.name : 'Pick Audiobook';
    }
    const srtBtn = document.getElementById('readerPickSrtBtn');
    if (srtBtn) {
      const sr = deckNow ? await getSrtPairing(deckNow) : null;
      srtBtn.textContent = sr ? `📄 ${sr.name}` : '📄 Pick SRT';
    }
    if (hiInput) {
      const saved = (await getPref(KEYS.HIGHLIGHT)) || DEFAULT_HIGHLIGHT;
      hiInput.value = saved;
      // Wire preset swatches once.
      if (!modal.dataset.presetsWired) {
        modal.querySelectorAll('.hl-preset').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const c = btn.getAttribute('data-color');
            hiInput.value = c;
            applyHighlightColor(c);
          });
        });
        hiInput.addEventListener('input', () => applyHighlightColor(hiInput.value));
        modal.dataset.presetsWired = '1';
      }
    }
  };

  // Live update from the slider oninput — applies immediately to current audio
  // but does NOT persist until Save is pressed.
  window.setReadingPlaybackRateLive = function (rate) {
    const label = document.getElementById('readerSpeedLabel');
    if (label) label.textContent = rate.toFixed(2) + '×';
    if (typeof window.setReadingPlaybackRate === 'function') {
      window.setReadingPlaybackRate(rate);
    }
  };

  window.closeReadingSettings = function () {
    document.getElementById('readingSettingsModal').style.display = 'none';
  };

  window.saveReadingSettings = async function () {
    const font = document.getElementById('readerFontSelect').value;
    const size = document.getElementById('readerFontSizeSlider').value;
    const verticalToggle = document.getElementById('readerVerticalToggle');
    const autoToggle = document.getElementById('readerAutoAdvanceToggle');
    const hiInput = document.getElementById('readerHighlightColor');
    const speedSlider = document.getElementById('readerSpeedSlider');
    const vertical = !!(verticalToggle && verticalToggle.checked);
    const auto = autoToggle ? !!autoToggle.checked : true;
    const hi = (hiInput && hiInput.value) || DEFAULT_HIGHLIGHT;
    await setPref(KEYS.FONT, font);
    await setPref(KEYS.FONT_SIZE, size);
    await setPref(KEYS.VERTICAL, vertical ? 'true' : 'false');
    await setPref(KEYS.AUTO_ADVANCE, auto ? 'true' : 'false');
    await setPref(KEYS.HIGHLIGHT, hi);
    if (speedSlider) {
      const r = parseFloat(speedSlider.value) || 1;
      await setPref('AUDIO_SPEED', String(r));
      if (typeof window.setReadingPlaybackRate === 'function') {
        window.setReadingPlaybackRate(r);
      }
    }
    document.documentElement.style.setProperty('--reader-font', font);
    document.documentElement.style.setProperty('--reader-font-size', size + 'rem');
    applyVertical(vertical);
    applyHighlightColor(hi);
    window.readingAutoAdvance = auto;
    if (lastMatchedIdx >= 0 && chunks[lastMatchedIdx]) {
      chunks[lastMatchedIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    window.closeReadingSettings();
  };

  applyFontPrefs();

  // Auto-restore reading mode if it was open when the app was last closed.
  // Wait briefly for the deck to be restored so syncReadingToCard has data.
  (async function maybeRestoreReadingMode() {
    try {
      const wasOpen = (await getPref(KEYS.MODE_OPEN)) === 'true';
      if (!wasOpen) return;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (Array.isArray(window.allNotes) && window.allNotes.length > 0) break;
        await new Promise(r => setTimeout(r, 200));
      }
      if (typeof window.openReadingMode === 'function') {
        rlog('Auto-restoring reading mode');
        window.openReadingMode();
      }
    } catch (e) {
      console.warn('Reading-mode restore failed:', e);
    }
  })();
})();
