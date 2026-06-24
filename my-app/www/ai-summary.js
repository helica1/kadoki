// ai-summary.js — first user-facing AI feature (plan slice 2/6 bridge):
// "summarize this session" from the Bookmarks menu. Tier 0: sends ONLY the
// text between the session-start position (event log) and the current
// position — never anything past the reader's place, so it cannot spoil.
//
// Text sources are read-only: window._srtCues for audio/card, the rendered
// .reading-chunk elements (ruby <rt> stripped) for read mode.
(function () {
  'use strict';

  const MAX_CHARS = 20000;        // cost/context cap; keep the TAIL (ends at "now")
  const FALLBACK_CUES = 100;      // no session start known → last ~100 cues
  const FALLBACK_READ_CHARS = 8000;
  const SAVE_PREFIX = 'AISUM_V1_';
  const SAVE_MAX = 50;            // newest-first, per title

  const SYSTEM_PROMPT =
    'あなたは読書アシスタントです。提供された本文の抜粋のみに基づいて、読者がいま読み終えた' +
    '(または聞き終えた)範囲の出来事を日本語で要約してください。本文の文体・トーンに' +
    'できるだけ寄せること。抜粋に書かれていない外部知識(この作品についての知識を含む)や、' +
    '今後の展開の推測は一切使わないこと。マークダウン記法は使わず、プレーンテキストで書くこと。' +
    '読みやすさのため、2〜3文ごとに段落を分け、段落のあいだには必ず空行を1行入れること。' +
    '入力がどれだけ長くても、要約全体は600〜900字程度に収めること。';

  const INTERVAL_MAX_CHARS = 120000;   // hard input cap for interval summaries
  const CONFIRM_USD = 0.50;            // ask before spending more than this

  // Rough pre-flight estimate (default model, output capped by the prompt).
  // Display/confirmation only — the ledger records the real numbers afterwards.
  function estimateCostUsd(chars) {
    try {
      if (window.ai && window.ai.estimateCostUsd) {
        return window.ai.estimateCostUsd(window.ai.MODELS.default, chars, 1600);
      }
    } catch (_) {}
    return (chars * 1.2 * 3 + 1600 * 15) / 1e6;
  }

  function currentMode() {
    try { if (window.stats && window.stats.currentMode) return window.stats.currentMode(); } catch (_) {}
    const cl = document.body.classList;
    if (cl.contains('mode-read')) return 'read';
    if (cl.contains('mode-audio')) return 'audio';
    return 'card';
  }

  // Latest 'o' (open) event's position from the slice-1 event log — that is
  // "where this session started". Best-effort; null is fine.
  async function sessionStartPos() {
    try {
      if (!window.eventLog) return null;
      const log = await window.eventLog.getLog();
      if (!log || !Array.isArray(log.events)) return null;
      for (let i = log.events.length - 1; i >= 0; i--) {
        if (log.events[i].t === 'o') return log.events[i].p || null;
      }
    } catch (_) {}
    return null;
  }

  function cardToCue(cardIdx) {
    try {
      if (typeof window._srtCardToCueAnchor === 'function') {
        const c = window._srtCardToCueAnchor(cardIdx);
        if (Number.isFinite(c)) return c;
      }
    } catch (_) {}
    return cardIdx;
  }

  function gatherCueText(startPos) {
    const cues = window._srtCues;
    if (!Array.isArray(cues) || !cues.length) return null;
    let cur = null;
    if (Number.isFinite(window._lastAudioCueIdx)) cur = window._lastAudioCueIdx;
    if (cur === null && Number.isFinite(window.currentCardIndex)) cur = cardToCue(window.currentCardIndex);
    if (!Number.isFinite(cur)) return null;
    cur = Math.max(0, Math.min(cues.length - 1, cur));

    let start = null;
    if (startPos) {
      if (startPos.k === 'audio' && Number.isFinite(startPos.cueIdx)) start = startPos.cueIdx;
      else if (startPos.k === 'card' && Number.isFinite(startPos.cardIndex)) start = cardToCue(startPos.cardIndex);
    }
    if (!Number.isFinite(start) || start === null || cur - start < 3) start = cur - FALLBACK_CUES;
    start = Math.max(0, Math.min(start, cur));

    let text = '';
    for (let i = start; i <= cur; i++) {
      const t = cues[i] && cues[i].text;
      if (t) text += t.replace(/\n+/g, ' ') + '\n';
    }
    if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
    return { text, label: '字幕 ' + (start + 1) + '–' + (cur + 1), space: 'cue', a: start, b: cur };
  }

  function gatherReadText(startPos) {
    let cur = null;
    try {
      const loc = window.pagedGetReadLocation && window.pagedGetReadLocation();
      if (loc && Number.isFinite(loc.jpOff)) cur = loc.jpOff;
    } catch (_) {}
    if (!Number.isFinite(cur)) return null;

    let startOff = (startPos && startPos.k === 'read' && Number.isFinite(startPos.jpOff))
      ? startPos.jpOff : (cur - FALLBACK_READ_CHARS);
    if (cur - startOff < 200) startOff = cur - FALLBACK_READ_CHARS;  // too small to summarize
    startOff = Math.max(0, startOff);

    // Chunk-granularity slice of the rendered book: include any paragraph
    // chunk overlapping [startOff, cur]. Strip ruby <rt> so furigana doesn't
    // duplicate readings into the text we send.
    let text = '';
    try {
      const nodes = document.querySelectorAll('.reading-chunk');
      for (const el of nodes) {
        const off = parseInt(el.dataset.jpOff, 10);
        const len = parseInt(el.dataset.jpLen, 10) || 0;
        if (!Number.isFinite(off)) continue;
        if (off + len <= startOff || off > cur) continue;
        const clone = el.cloneNode(true);
        clone.querySelectorAll('rt').forEach(rt => rt.remove());
        const t = (clone.textContent || '').trim();
        if (t) text += t + '\n';
      }
    } catch (_) {}
    if (!text) return null;
    if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
    return {
      text,
      label: startOff.toLocaleString() + '–' + cur.toLocaleString() + ' 字',
      space: 'jp', a: startOff, b: cur,
    };
  }

  // ---- persistence (saved summaries, per title) -------------------------------
  async function loadSaved(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(SAVE_PREFIX + titleId) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && p.v === 1 && Array.isArray(p.entries)) ? p : { v: 1, entries: [] };
    } catch (_) { return { v: 1, entries: [] }; }
  }
  async function saveSummary(titleId, entry) {
    try {
      const box = await loadSaved(titleId);
      box.entries.unshift(entry);
      if (box.entries.length > SAVE_MAX) box.entries.length = SAVE_MAX;
      if (window.blobStore) await window.blobStore.set(SAVE_PREFIX + titleId, JSON.stringify(box));
    } catch (_) {}
  }
  async function listSaved(titleId) {
    const id = titleId || window._activeTitleId;
    if (!id) return [];
    return (await loadSaved(id)).entries;
  }
  function openSaved(entry) {
    const when = (() => { try { return new Date(entry.ts).toLocaleString(); } catch (_) { return ''; } })();
    const ui = openOverlay(entry.label + ' · ' + when);
    ui.content.textContent = entry.text;
    ui.meta.textContent = entry.model + ' · 保存済みの要約 (再生成なし・無料)';
    if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(ui.content);
    try { window.aiCharsUi && window.aiCharsUi.markNow(ui.content); } catch (_) {}
  }

  // ---- place guard --------------------------------------------------------------
  // NEVER-LOSE-PLACE: snapshot the native playhead when the overlay opens; on
  // close, if the playhead somehow regressed while the overlay was up (a stray
  // seek from a lookup/Send inside it), restore the snapshot. Forward motion
  // (audio kept playing) is always respected — we never seek forward, never to
  // 0, and only on the same audio file.
  let _guard = null;
  function placeGuardArm() {
    _guard = null;
    try {
      const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio;
      if (!bg || typeof bg.getState !== 'function') return;
      bg.getState().then((s) => {
        if (s && s.ready && Number(s.positionMs) > 1000) {
          _guard = { ms: Math.round(s.positionMs), url: s.url || null };
        }
      }).catch(() => {});
    } catch (_) {}
  }
  function placeGuardCheck() {
    const g = _guard; _guard = null;
    if (!g) return;
    try {
      const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio;
      if (!bg) return;
      bg.getState().then((s) => {
        if (!s || !s.ready) return;
        if (g.url && s.url && s.url !== g.url) return;       // different audio now
        if (Number(s.positionMs) < g.ms - 4000) {
          console.log('[ai-place-guard] playhead regressed (' + s.positionMs + ' < ' + g.ms + ') — restoring');
          bg.seek({ ms: g.ms, fadeMs: 40 });
        }
      }).catch(() => {});
    } catch (_) {}
  }

  // ---- overlay ---------------------------------------------------------------
  function openOverlay(rangeLabel) {
    const prev = document.getElementById('aiSummaryOverlay');
    if (prev) prev.remove();
    placeGuardArm();
    const closeOverlay = (overlay) => { overlay.remove(); placeGuardCheck(); };
    const overlay = document.createElement('div');
    overlay.id = 'aiSummaryOverlay';
    // z-index 9000: deliberately BELOW the dict popup (9999) so word lookups
    // inside the summary open on top, and below the toast (9500).
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(overlay); });

    const card = document.createElement('div');
    card.style.cssText =
      'background:#141414;border:1px solid #2a2a2a;border-radius:14px;' +
      'width:min(94vw,720px);height:86vh;display:flex;flex-direction:column;overflow:hidden;';

    const head = document.createElement('div');
    head.id = 'aiSummaryHead';   // dict popup positions itself below this
    head.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #242424;';
    head.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;color:#eee;font-size:1rem;">AI要約</div>' +
        '<div style="color:#888;font-size:.72rem;margin-top:2px;">' + rangeLabel + '</div>' +
      '</div>';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText =
      'background:none;border:1px solid #333;border-radius:8px;color:#aaa;' +
      'font-size:1rem;padding:4px 12px;cursor:pointer;';
    close.addEventListener('click', () => closeOverlay(overlay));
    head.appendChild(close);

    const content = document.createElement('div');
    // kai-summary-text: ai-characters-ui's marking poll picks this up, so
    // character names inside summaries get squiggles + popups too.
    content.className = 'kai-summary-text';
    // Typography matches CARD mode: same appearance.js variables, so the
    // user's chosen card font (incl. custom kfont-<id>) and size apply here.
    content.style.cssText =
      'flex:1;overflow-y:auto;padding:16px 18px;color:#ddd;' +
      'font-family:var(--font-family-card);font-size:var(--font-size-card);' +
      'line-height:1.7;white-space:pre-wrap;-webkit-overflow-scrolling:touch;';
    // Animated waiting dots (replaced by the first streamed token).
    content.innerHTML =
      '<span class="kai-dots" style="color:#8a7fb8;"><span>·</span><span>·</span><span>·</span></span>';

    const meta = document.createElement('div');
    meta.style.cssText =
      'padding:8px 14px;border-top:1px solid #242424;color:#666;font-size:.7rem;min-height:1em;';

    card.appendChild(head);
    card.appendChild(content);
    card.appendChild(meta);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return { overlay, content, meta };
  }

  // ---- entry point -------------------------------------------------------------
  let _busy = false;
  async function summarizeRecent() {
    if (_busy) return;
    if (!window.ai || !window.ai.isEnabled()) {
      if (typeof window.showToast === 'function') {
        window.showToast('Enable AI in Preferences → AI Features first', 3000);
      }
      return;
    }
    const mode = currentMode();
    const startPos = await sessionStartPos();
    const src = (mode === 'read') ? gatherReadText(startPos) : gatherCueText(startPos);
    if (!src || !src.text || src.text.length < 80) {
      if (typeof window.showToast === 'function') {
        window.showToast('Not enough recent text to summarize yet', 2500);
      }
      return;
    }

    await runSummary(src, mode);
  }

  async function runSummary(src, mode) {
    const ui = openOverlay(src.label + ' · ' + src.text.length.toLocaleString() + '字');
    let started = false;
    _busy = true;
    try {
      const r = await window.ai.request({
        feature: 'summary',
        system: SYSTEM_PROMPT,
        maxTokens: 1600,
        messages: [{
          role: 'user',
          content: '本文抜粋:\n\n' + src.text + '\n\n上記の範囲の要約:',
        }],
        onText: (delta) => {
          if (!document.body.contains(ui.overlay)) return;   // user closed it
          if (!started) { started = true; ui.content.textContent = ''; }
          ui.content.textContent += delta;
        },
      });
      if (document.body.contains(ui.overlay)) {
        ui.meta.textContent =
          r.model + ' · ~$' + r.costUsd.toFixed(3) +
          ' · in ' + r.usage.input_tokens.toLocaleString() +
          ' / out ' + r.usage.output_tokens.toLocaleString() + ' tok';
        // Streaming is done — make the summary text dictionary-tappable
        // (same per-char .dict-frag pipeline card subtitles use).
        if (typeof window.dictEnableLookupIn === 'function') {
          window.dictEnableLookupIn(ui.content);
        }
        try { window.aiCharsUi && window.aiCharsUi.markNow(ui.content); } catch (_) {}   // squiggle names now
      }
      // Persist so the user can reopen it from the Bookmarks menu for free.
      const titleId = window._activeTitleId;
      if (titleId && r.text) {
        saveSummary(titleId, {
          ts: Date.now(), label: src.label, mode,
          text: r.text, model: r.model, costUsd: r.costUsd,
          range: (src.space && Number.isFinite(src.a)) ? { space: src.space, a: src.a, b: src.b } : null,
        });
      }
    } catch (e) {
      if (document.body.contains(ui.overlay)) {
        ui.content.textContent = '';
        const err = document.createElement('div');
        err.style.cssText = 'color:#e08a8a;font-size:.85rem;';
        err.textContent = '要約に失敗しました: ' + (e && e.message ? e.message : e);
        ui.content.appendChild(err);
      }
    } finally {
      _busy = false;
    }
  }

  // ---- interval summaries (Bookmarks timeline rows) ----------------------------
  function gatherCueRange(a, b) {
    const cues = window._srtCues;
    if (!Array.isArray(cues) || !cues.length) return null;
    a = Math.max(0, a | 0); b = Math.min(cues.length - 1, b | 0);
    if (b < a) return null;
    let text = '';
    for (let i = a; i <= b; i++) {
      const t = cues[i] && cues[i].text;
      if (t) text += t.replace(/\n+/g, ' ') + '\n';
    }
    return { text, label: '字幕 ' + (a + 1) + '–' + (b + 1), space: 'cue', a, b };
  }
  function gatherJpRange(a, b) {
    let text = '';
    try {
      const nodes = document.querySelectorAll('.reading-chunk');
      for (const el of nodes) {
        const off = parseInt(el.dataset.jpOff, 10);
        const len = parseInt(el.dataset.jpLen, 10) || 0;
        if (!Number.isFinite(off)) continue;
        if (off + len <= a || off > b) continue;
        const clone = el.cloneNode(true);
        clone.querySelectorAll('rt').forEach(rt => rt.remove());
        const t = (clone.textContent || '').trim();
        if (t) text += t + '\n';
      }
    } catch (_) {}
    if (!text) return null;
    return { text, label: a.toLocaleString() + '–' + b.toLocaleString() + ' 字', space: 'jp', a, b };
  }

  // seg: { space:'cue'|'jp', a, b, mode? } — from the Bookmarks interval rows.
  // Output stays 600–900字 no matter the input size (prompt-capped); inputs
  // estimated above CONFIRM_USD get an explicit go-ahead dialog first.
  async function summarizeRange(seg) {
    if (_busy) return;
    if (!window.ai || !window.ai.isEnabled()) {
      if (typeof window.showToast === 'function') {
        window.showToast('Enable AI in Preferences → AI Features first', 3000);
      }
      return;
    }
    const src = (seg.space === 'cue') ? gatherCueRange(seg.a, seg.b) : gatherJpRange(seg.a, seg.b);
    if (!src || !src.text || src.text.length < 80) {
      if (typeof window.showToast === 'function') {
        window.showToast('この範囲のテキストが見つかりません', 2500);
      }
      return;
    }
    if (src.text.length > INTERVAL_MAX_CHARS) {
      src.text = src.text.slice(src.text.length - INTERVAL_MAX_CHARS);
      src.label += ' (後半' + INTERVAL_MAX_CHARS.toLocaleString() + '字)';
    }
    const est = estimateCostUsd(src.text.length);
    if (est > CONFIRM_USD) {
      const ok = window.confirm('この範囲の要約には約 $' + est.toFixed(2) +
        ' かかります(' + src.text.length.toLocaleString() + '字を送信)。続行しますか?');
      if (!ok) return;
    }
    await runSummary(src, seg.mode || currentMode());
  }

  window.aiSummary = { summarizeRecent, summarizeRange, listSaved, openSaved, estimateCostUsd };
})();
