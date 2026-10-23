// ai-cleanup.js — AI proofreading of on-device transcriptions.
//
// For audio-only titles (no real book: the read text is generated from the
// transcription), a cloud model proofreads the transcript in ~2,400-char
// chunks: wrong-kanji homophones, names, punctuation, 「」 around dialogue and
// paragraph starts. The text is sent with every cue marked (‹n›) and must come
// back with every marker in place, so each corrected piece lands on the cue it
// came from: cue timing, word timings (karaoke), the follow map and the
// generated book all stay exact. A failed check leaves the chunk as it was.
//
// Before the first chunk, one request with web search builds a glossary
// (work, author, narrator, character / place names in the right kanji) that
// rides along with every chunk.
//
// Started/stopped from the audio page (#abCleanBtn). Order: from the
// listener's position forward, then back-fills from the start; while the
// transcription is still running it waits for more text. State per title in
// blobStore AICLEAN_V1_<titleId>; the pre-clean-up transcript is kept for
// undo (autoTranscribe.backupBeforeClean / restoreBeforeClean).
(function () {
  'use strict';

  const STATE_PREFIX = 'AICLEAN_V1_';
  const CHUNK_CHARS = 2400;      // target text per request
  const CHUNK_MAX = 3600;        // hard cap when no sentence end turns up
  const CTX_CHARS = 300;         // read-only context on each side
  const REBUILD_EVERY = 4;       // chunks between generated-book rebuilds
  const WAIT_MS = 60000;         // transcription frontier: re-check this often
  const OR_PATTERNS = [/^anthropic\/claude-sonnet-5[.-]5/, /^anthropic\/claude-sonnet-5/, /^anthropic\/claude-sonnet/];

  const log = (m) => { try { window.debugLog?.('[ai-cleanup] ' + m); } catch (_) {} };
  const t = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let run = null;        // { titleId, stop, phase, error }
  const listeners = new Set();
  function emit() {
    for (const fn of listeners) { try { fn(); } catch (_) {} }
    try { window.__pagedRefreshSynthChip?.(); } catch (_) {}
  }

  // ── state ─────────────────────────────────────────────────────────────────

  async function loadState(titleId) {
    try {
      const raw = await window.blobStore?.get(STATE_PREFIX + titleId);
      const o = raw ? JSON.parse(raw) : null;
      if (o && o.v === 1) return o;
    } catch (_) {}
    return { v: 1, glossary: '', costUsd: 0, failed: 0, chunks: 0 };
  }
  async function saveState(titleId, st) {
    try { await window.blobStore?.set(STATE_PREFIX + titleId, JSON.stringify(st)); } catch (_) {}
  }

  async function titleFor(titleId) {
    try { return (await window.titleStore.list()).find(x => x.id === titleId) || null; } catch (_) { return null; }
  }
  // Audio titles whose read text is generated from the transcription.
  function eligibleTitle(title) {
    const a = title && title.attachments;
    if (!a || !a.audiobook) return false;
    if (a.epub && !a.epub.auto) return false;
    if (a.srt && !a.srt.auto) return false;
    if (a.audiobook.isVideo) return false;
    return true;
  }

  // ── chunking ──────────────────────────────────────────────────────────────

  // Next run of un-proofread cues: the first at/after `anchorMs`, else the
  // first from the start. Returns { i, j } (cue index range, exclusive end)
  // or null. `partial` when it stops at the transcription frontier short of
  // a full chunk.
  function nextChunk(cues, anchorMs, fromIdx) {
    const find = (from) => {
      for (let i = from; i < cues.length; i++) if (!cues[i].ai && (cues[i].text || '').trim()) return i;
      return -1;
    };
    let start = -1;
    if (Number.isFinite(fromIdx)) start = find(fromIdx);
    else if (anchorMs > 0) {
      let k = 0;
      while (k < cues.length && cues[k].endMs < anchorMs - 60000) k++;
      start = find(k);
    }
    if (start < 0 && !Number.isFinite(fromIdx)) start = find(0);
    if (start < 0) return null;
    let chars = 0, j = start;
    for (; j < cues.length; j++) {
      const c = cues[j];
      if (c.ai) break;                       // contiguous un-proofread run only
      chars += (c.text || '').length;
      const next = cues[j + 1];
      const sentEnd = /[。．！？!?」』]$/.test(c.text || '') || !next || (next.startMs - c.endMs) > 1200;
      if ((chars >= CHUNK_CHARS && sentEnd) || chars >= CHUNK_MAX) { j++; break; }
    }
    return { i: start, j, chars, atEnd: j >= cues.length };
  }

  function contextText(cues, from, to) {
    let s = '';
    for (let k = from; k < to; k++) s += cues[k].text || '';
    return s;
  }

  // ── prompts ───────────────────────────────────────────────────────────────

  const SYSTEM = [
    'You proofread a Japanese audiobook transcript produced by speech recognition, so that it reads like the published book.',
    '',
    'Input: segments, each starting with a marker like ‹12›. Output the same segments in the same order: every marker exactly once, unchanged, each followed by its corrected text. Output nothing else — no commentary, no code fences.',
    '',
    'Fix:',
    '- Recognition errors: wrong kanji for a homophone (短歌 not 単価 when the context is poetry), misheard words where the intended word is clear from context, names and terms as given in the glossary.',
    '- Punctuation: 、 and 。 where a published text would have them; 「」 around spoken dialogue, 『』 for quotes inside dialogue and for titles of works.',
    '- Numbers in the style of a published Japanese novel (二十歳, 一人, 二年生), unless the context is a date, address or similar.',
    '- Paragraphs: write ¶ immediately after the marker of a segment that begins a new paragraph (‹12›¶「…). Start a new paragraph when the speaker changes, when narration resumes after dialogue, and at natural breaks in narration.',
    '',
    'Do not:',
    '- Paraphrase, summarise, modernise, add or remove content, or "improve" the style. The narrator\'s words stay.',
    '- Merge, split, drop, reorder or renumber markers. A few characters may move to the neighbouring segment only to repair a word split across the boundary.',
    '- Change anything you are not confident about — keep the original.',
    'A segment that is a chapter title stays as it is.',
  ].join('\n');

  async function buildGlossary(title, cues, st) {
    const a = title.attachments || {};
    const audioName = (a.audiobook && (a.audiobook.name || '')) || '';
    const asin = (audioName.match(/\b(B0[0-9A-Z]{8})\b/) || [])[1] || '';
    const n = cues.length;
    const sample = (from) => contextText(cues, from, Math.min(n, from + 60)).slice(0, 1200);
    const prompt = [
      'Audiobook title: ' + (title.name || ''),
      title.author ? 'Author (from the library): ' + title.author : '',
      'Audio file name: ' + audioName + (asin ? '  (Audible/Amazon ASIN ' + asin + ')' : ''),
      '',
      'Transcript samples (speech recognition, may contain errors):',
      '[start] ' + sample(0),
      '[middle] ' + sample(Math.floor(n / 2)),
      '[late] ' + sample(Math.floor(n * 0.85)),
      '',
      'Identify the work (the Audible/Amazon listing first, e.g. by ASIN), then look up its author, narrator, and the correct written forms of character names, place names and special terms. Return a compact glossary for a proofreader, in Japanese, at most 40 lines, nothing else:',
      '作品: …',
      '著者: …',
      '朗読: …',
      'then one line per entry:  よみ → 正しい表記（短い説明）',
      'Only include entries you confirmed from sources or that are unambiguous in the transcript. If you cannot identify the work, say so on the first line and list only what the transcript itself makes clear.',
    ].filter(Boolean).join('\n');
    const req = async (web) => request({
      feature: 'ai-cleanup-glossary', titleId: title.id,
      system: 'You prepare reference material for proofreading a Japanese audiobook transcript.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 6000, effort: 'medium', retryable: true, timeoutMs: 300000,
      webSearch: web ? { maxUses: 6 } : null,
    });
    let res;
    try { res = await req(true); }
    catch (e) {
      log('glossary with web search failed (' + (e?.message || e) + ') — retrying without');
      res = await req(false);
    }
    st.costUsd += res.costUsd || 0;
    return cleanGlossary(res.text);
  }
  // Text the model wrote between web searches can precede the list (one book
  // began "Results seem to be strings sometimes; handle it."): start at 作品.
  function cleanGlossary(g) {
    let s = String(g || '').trim();
    const k = s.indexOf('作品');
    if (k > 0) s = s.slice(k);
    return s.slice(0, 4000);
  }

  // Backend-appropriate model: the Sonnet tier on the Anthropic API (newest
  // Sonnet unless pinned in Preferences); on OpenRouter the
  // newest Anthropic Sonnet in the catalog (else the user's chosen model).
  let _orPick;
  async function request(opts) {
    if (window.ai.backend() === 'openrouter') {
      if (_orPick === undefined) {
        try { _orPick = await window.ai.pickOpenRouterModel(OR_PATTERNS); } catch (_) { _orPick = null; }
      }
      if (_orPick) opts = Object.assign({}, opts, { orModel: _orPick });
    } else {
      opts = Object.assign({}, opts, { model: window.ai.MODELS.default });
    }
    return window.ai.request(opts);
  }

  // Parse ‹n›(¶)text… back into per-segment text. Null when any marker is
  // missing, duplicated or out of order, or a segment is implausible.
  function parseOutput(text, origs) {
    const body = String(text || '').replace(/^```[^\n]*\n?|```\s*$/g, '');
    const re = /‹(\d+)›(¶?)/g;
    const marks = [];
    let m;
    while ((m = re.exec(body))) marks.push({ n: +m[1], pb: !!m[2], at: m.index, end: re.lastIndex });
    if (marks.length !== origs.length) return null;
    const out = [];
    let total = 0, origTotal = 0;
    for (let k = 0; k < marks.length; k++) {
      if (marks[k].n !== k + 1) return null;
      const seg = body.slice(marks[k].end, k + 1 < marks.length ? marks[k + 1].at : body.length)
        .replace(/[\r\n]+/g, '').replace(/¶/g, '').trim();
      const o = origs[k];
      if (!seg && o.length >= 4) return null;
      if (seg.length > o.length * 2.2 + 12) return null;
      total += seg.length; origTotal += o.length;
      out.push({ text: seg || o, pb: marks[k].pb });
    }
    if (origTotal > 40 && (total < origTotal * 0.7 || total > origTotal * 1.5)) return null;
    return out;
  }

  // The request text for one chunk (also used by the batch queue).
  function chunkPrompt(cues, ch, glossary) {
    const seg = cues.slice(ch.i, ch.j);
    const origs = seg.map(c => c.text || '');
    const before = contextText(cues, Math.max(0, ch.i - 40), ch.i).slice(-CTX_CHARS);
    const after = contextText(cues, ch.j, Math.min(cues.length, ch.j + 30)).slice(0, CTX_CHARS / 2);
    const lines = origs.map((x, k) => '‹' + (k + 1) + '›' + x).join('\n');
    const user = [
      '【用語集】', cleanGlossary(glossary) || '（なし）', '',
      '【直前の文脈（参考のみ・出力しない）】', before || '（なし）', '',
      '【直後の文脈（参考のみ・出力しない）】', after || '（なし）', '',
      '【校正対象】', lines,
    ].join('\n');
    return { seg, origs, user };
  }
  // Every un-proofread run of the book, chunked, in order.
  function chunkAll(cues) {
    const out = [];
    let i = 0;
    while (i < cues.length) {
      if (cues[i].ai || !(cues[i].text || '').trim()) { i++; continue; }
      const ch = nextChunk(cues.slice(0), 0, i);
      if (!ch) break;
      out.push(ch);
      i = ch.j;
    }
    return out;
  }

  async function cleanChunk(title, cues, ch, st) {
    const { seg, origs, user } = chunkPrompt(cues, ch, st.glossary);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request({
        feature: 'ai-cleanup', titleId: title.id, system: SYSTEM,
        messages: [{ role: 'user', content: attempt ? user + '\n\n（前回の出力はマーカーが欠けていました。すべてのマーカーを順番通り一度ずつ出力してください。）' : user }],
        maxTokens: 16000, effort: 'medium', retryable: true, timeoutMs: 300000,
      });
      st.costUsd += res.costUsd || 0;
      const parsed = parseOutput(res.text, origs);
      if (parsed) {
        return seg.map((c, k) => ({ startMs: c.startMs, orig: c.text, text: parsed[k].text, pb: parsed[k].pb }));
      }
      log('chunk ' + ch.i + '-' + ch.j + ': output failed the marker check (attempt ' + (attempt + 1) + ')');
    }
    // Leave the text as it was, but mark it handled so the run moves on.
    st.failed++;
    return seg.map(c => ({ startMs: c.startMs, orig: c.text, text: c.text, pb: false }));
  }

  // Finished: save a standalone EPUB (cover art included) to the app's
  // Documents folder — Files › On My iPhone › Kadoki › Books.
  async function exportBook(titleId) {
    const title = await titleFor(titleId);
    if (!title) return null;
    const safe = String(title.name || 'book').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'book';
    const res = await window.autoTranscribe.buildSyntheticEpub(titleId, {
      force: true, minCues: 1, exportTo: 'Books/' + safe + '.epub',
    });
    if (res && res.ok) {
      try {
        window.showToast?.(window.KADOKI_MAC
          ? t('clean.saved_mac', 'Proofread book saved to Documents › Kadoki › Books')
          : t('clean.saved', 'Proofread book saved to Files › Kadoki › Books'), 3200);
      } catch (_) {}
      return res.path;
    }
    try { window.showToast?.(t('clean.save_failed', 'Could not save the book'), 2500); } catch (_) {}
    return null;
  }

  // ── run loop ──────────────────────────────────────────────────────────────

  function playheadMs(titleId) {
    if (titleId !== window._activeTitleId) return 0;
    const v = window._lastBgPosMs;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  async function loop(r) {
    const at = window.autoTranscribe;
    const title = await titleFor(r.titleId);
    const st = await loadState(r.titleId);
    let sinceRebuild = 0;
    const rebuild = async () => {
      sinceRebuild = 0;
      try { await at.buildSyntheticEpub(r.titleId, { force: true, minCues: 1 }); } catch (_) {}
      try { await at.rewriteAutoSrt(r.titleId); } catch (_) {}
      try { if (r.titleId === window._activeTitleId) window.refreshTabAvailability?.(); } catch (_) {}
    };
    try {
      await at.backupBeforeClean(r.titleId);
      if (!st.glossary) {
        r.phase = 'glossary'; emit();
        const src0 = await at.cuesFor(r.titleId);
        if (!src0 || !src0.cues.length) throw new Error(t('clean.no_text', 'No transcript yet'));
        st.glossary = await buildGlossary(title, src0.cues, st);
        await saveState(r.titleId, st);
        log('glossary:\n' + st.glossary);
      }
      while (!r.stop) {
        const src = await at.cuesFor(r.titleId);
        if (!src) throw new Error(t('clean.no_text', 'No transcript yet'));
        let ch = nextChunk(src.cues, playheadMs(r.titleId));
        // Ahead of the listener only a short tail at a growing frontier is
        // left: back-fill earlier text meanwhile.
        if (ch && ch.atEnd && !src.complete && ch.chars < CHUNK_CHARS) {
          const ch2 = nextChunk(src.cues, 0);
          if (ch2 && ch2.i !== ch.i) ch = ch2;
        }
        // Nothing left, or only a short tail at a frontier that is still
        // growing: wait for the transcriber.
        if (!ch || (ch.atEnd && !src.complete && ch.chars < CHUNK_CHARS)) {
          if (!ch && src.complete) { r.phase = 'done'; st.finishedAt = Date.now(); break; }
          if (sinceRebuild) await rebuild();
          r.phase = 'waiting'; emit();
          for (let w = 0; w < WAIT_MS && !r.stop; w += 1000) await sleep(1000);
          continue;
        }
        r.phase = 'cleaning'; emit();
        const edits = await cleanChunk(title, src.cues, ch, st);
        await at.applyCleanEdits(r.titleId, edits);
        st.chunks++;
        await saveState(r.titleId, st);
        emit();
        if (++sinceRebuild >= REBUILD_EVERY) await rebuild();
      }
      if (sinceRebuild || r.phase === 'done') await rebuild();
      if (r.phase === 'done') {
        try { st.exportedTo = await exportBook(r.titleId); } catch (e) { log('export failed: ' + (e?.message || e)); }
      }
    } catch (e) {
      r.phase = 'error'; r.error = e?.message || String(e);
      log('stopped: ' + r.error);
      try { window.showToast?.(t('clean.failed', 'Proofreading stopped: ') + r.error, 3500); } catch (_) {}
      if (sinceRebuild) await rebuild();
    } finally {
      await saveState(r.titleId, st);
      if (run === r) run = null;
      emit();
    }
  }

  // ── public ────────────────────────────────────────────────────────────────

  // { eligible, running, phase, cleaned, total, costUsd, error }
  async function status(titleId) {
    const title = await titleFor(titleId);
    if (!eligibleTitle(title) || !window.ai?.isEnabled?.()) return { eligible: false };
    const src = await window.autoTranscribe?.cuesFor?.(titleId);
    if (!src || !src.cues.length) return { eligible: false };
    let cleaned = 0, chars = 0, left = 0;
    for (const c of src.cues) {
      const L = (c.text || '').length;
      chars += L;
      if (c.ai) cleaned += L; else left += L;
    }
    const st = await loadState(titleId);
    const r = (run && run.titleId === titleId) ? run : null;
    return {
      eligible: true, running: !!r, phase: r ? r.phase : null, error: r ? r.error : null,
      cleaned, total: chars, left, complete: src.complete, costUsd: st.costUsd || 0,
    };
  }

  // Rough cost of proofreading `chars` characters with Sonnet (~1 token per
  // character in and out, plus glossary/context overhead and thinking).
  function estimateUsd(chars) {
    const inTok = chars * 1.35, outTok = chars * 1.4;
    return (inTok * 2 + outTok * 10) / 1e6;
  }

  function start(titleId) {
    if (run) { if (run.titleId === titleId) return; run.stop = true; }
    const r = { titleId, stop: false, phase: 'starting', error: null };
    run = r;
    emit();
    loop(r);
  }
  function stop() { if (run) { run.stop = true; run.phase = 'stopping'; emit(); } }

  async function undo(titleId) {
    if (run && run.titleId === titleId) stop();
    const n = await window.autoTranscribe.restoreBeforeClean(titleId);
    try { await window.autoTranscribe.buildSyntheticEpub(titleId, { force: true, minCues: 1 }); } catch (_) {}
    try { await window.autoTranscribe.rewriteAutoSrt(titleId); } catch (_) {}
    const st = await loadState(titleId);
    st.chunks = 0; st.failed = 0; st.finishedAt = null;
    await saveState(titleId, st);
    emit();
    return n;
  }

  // ── audio-page control (#abCleanBtn in #abRepeatBar) ───────────────────────
  // One pill: tap starts/stops; once proofread, tap (or long-press any time)
  // offers to restore the original transcript.

  let btn = null, refreshSeq = 0;
  function ensureBtn() {
    if (btn && btn.isConnected) return btn;
    const bar = document.getElementById('abRepeatBar');
    if (!bar) return null;
    btn = document.createElement('button');
    btn.id = 'abCleanBtn';
    btn.type = 'button';
    btn.style.display = 'none';
    bar.appendChild(btn);
    let pressT = null, longFired = false;
    btn.addEventListener('pointerdown', () => {
      longFired = false;
      pressT = setTimeout(() => { longFired = true; onLong(); }, 650);
    });
    const cancel = () => { if (pressT) { clearTimeout(pressT); pressT = null; } };
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (longFired) { longFired = false; return; }
      onTap();
    });
    return btn;
  }

  let lastStatus = null;
  async function refreshBtn() {
    const b = ensureBtn();
    if (!b) return;
    const seq = ++refreshSeq;
    const tid = window._activeTitleId;
    let s = { eligible: false };
    try { if (tid) s = await status(tid); } catch (_) {}
    if (seq !== refreshSeq) return;
    lastStatus = Object.assign({ titleId: tid }, s);
    if (!s.eligible) { b.style.display = 'none'; return; }
    b.style.display = '';
    const pct = s.total ? Math.floor(100 * s.cleaned / s.total) : 0;
    const done = !s.left && s.complete;
    let label;
    // Japanese-only labels for now (user choice).
    if (s.running && s.phase === 'glossary') label = '校正・準備中';
    else if (s.running && s.phase === 'stopping') label = '校正・停止中';
    else if (s.running) label = '校正中 ' + pct + '%' + (s.phase === 'waiting' ? ' ·' : '');
    else if (done) label = '✓ 校正済み';
    else label = '校正' + (pct > 0 ? ' ' + pct + '%' : '');
    b.textContent = label;
    b.classList.toggle('running', !!s.running);
    b.classList.toggle('done', done && !s.running);
  }

  async function onTap() {
    const s = lastStatus;
    if (!s || !s.eligible || !s.titleId) return;
    try { window.kHaptic?.(); } catch (_) {}
    if (s.running) { stop(); return; }
    if (!s.left && s.complete) { await exportBook(s.titleId); return; }   // re-save the finished book
    const k = Math.max(1, Math.round(s.left / 1000));
    const usd = estimateUsd(s.left);
    const msg = t('clean.confirm', 'Proofread this transcript? Fixes misheard words and names, adds punctuation, dialogue quotes and paragraphs.') +
      '\n\n' + k + 'k ' + t('clean.chars', 'characters') + ' · ~$' + (usd < 0.1 ? usd.toFixed(2) : usd.toFixed(1)) +
      (s.complete ? '' : '\n' + t('clean.follows', 'Text still being transcribed is proofread as it arrives.'));
    if (!confirm(msg)) return;
    start(s.titleId);
  }

  async function onLong() {
    const s = lastStatus;
    if (!s || !s.eligible || !s.cleaned) return;
    try { window.kHaptic?.(); } catch (_) {}
    if (!confirm(t('clean.undo_confirm', 'Restore the original transcript?'))) return;
    const n = await undo(s.titleId);
    try { window.showToast?.(t('clean.undone', 'Original transcript restored') + (n ? ' (' + n + ')' : ''), 2000); } catch (_) {}
  }

  listeners.add(() => { refreshBtn(); });
  window.addEventListener('shell:title-change', () => refreshBtn());
  window.addEventListener('shell:mode-change', (e) => { if (e?.detail?.mode === 'audio') refreshBtn(); });
  document.addEventListener('DOMContentLoaded', () => refreshBtn());
  setTimeout(refreshBtn, 3000);

  window.aiCleanup = {
    status, start, stop, undo, estimateUsd, exportBook,
    isRunning: (titleId) => !!(run && (!titleId || run.titleId === titleId)),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // Shared with the batch queue (ai-batch.js).
    SYSTEM, chunkPrompt, chunkAll, parseOutput, buildGlossary, loadState, saveState, eligibleTitle,
    _internals: { parseOutput, nextChunk },
  };
})();
