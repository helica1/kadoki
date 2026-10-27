// ai-batch.js — overnight queue: transcribe and proofread (校正) many books.
//
// For each queued audio title (read text generated from the transcription):
//   1. transcribe the whole book headless (autoTranscribe.transcribeTitle —
//      full speed, the book need not be open), which also writes its SRT and
//      generated book;
//   2. build the reference list (one live request with web search);
//   3. submit every proofreading chunk as ONE Message Batch (half price,
//      results usually within an hour, at most 24 h) on the high tier (Opus);
//   4. when the batch ends: apply the results (same marker check as the live
//      校正), retry failed chunks once in a second batch, rebuild the book and
//      SRT, and save the proofread EPUB to Files › Kadoki › Books.
// Transcription runs one book at a time; batches overlap (book 2 transcribes
// while book 1's batch is processed). Everything is persisted (BATCHQ_V1 +
// BATCHQ_MAP_<titleId>), so quitting and reopening resumes: unfinished
// transcription restarts from its cache, submitted batches are polled again.
// Anthropic backend only (OpenRouter has no batch pricing). Mac only for now.
(function () {
  'use strict';

  const Q_KEY = 'BATCHQ_V1';
  const MAP_PREFIX = 'BATCHQ_MAP_';
  const POLL_MS = 60000;
  const CHARS_PER_HOUR = 15000;      // narrated Japanese, for estimates before transcription
  const EFFORT = 'high';
  const FMAP_PREFIX = 'BATCHQ_FMAP_';
  const FURI_CHUNK = 6000;          // chars per furigana request (output is short)
  const FURI_REPEAT_GAP = 30000;    // re-ruby a word only after this many chars without it
  const RETRY_PIECES = 4;           // a failed chunk is retried split this many ways
  const RETRY_MIN_CUES = 10;

  const log = (m) => { try { window.debugLog?.('[ai-batch] ' + m); } catch (_) {} };
  const bs = () => window.blobStore;

  let Q = null;                 // { v:1, running, items:[{titleId,name,stage,progress,error,batchId,retried,chunks,costUsd,exportedTo,...}] }
  let driving = false, stopReq = false, pollTimer = null, polling = false;

  async function load() {
    if (Q) return Q;
    try { const raw = await bs()?.get(Q_KEY); Q = raw ? JSON.parse(raw) : null; } catch (_) { Q = null; }
    if (!Q || Q.v !== 1) Q = { v: 1, running: false, items: [] };
    return Q;
  }
  async function save() { try { await bs()?.set(Q_KEY, JSON.stringify(Q)); } catch (_) {} render(); }
  let renderT = 0;
  function progressSave(it, f) {
    it.progress = f;
    const now = Date.now();
    if (now - renderT > 1500) { renderT = now; save(); }
  }

  function available() {
    return !!(window.KADOKI_MAC && window.ai?.isEnabled?.() && window.ai.backend?.() === 'anthropic' &&
              window.autoTranscribe?.transcribeTitle && window.aiCleanup?.chunkAll);
  }
  async function titleById(id) {
    try { return (await window.titleStore.list()).find(x => x.id === id) || null; } catch (_) { return null; }
  }
  function preventSleep(on) { try { window.__kadokiPreventSleep?.(on); } catch (_) {} }

  // Price of proofreading `chars` with Opus at batch rates (~1 token per
  // char in, ~1.4 out, plus thinking at high effort).
  function estimateUsd(chars) {
    const p = { inUsd: 4, outUsd: 20 };
    return 0.5 * (chars * 1.4 * p.inUsd + chars * 2.6 * p.outUsd) / 1e6;
  }
  async function charsFor(titleId) {
    const src = await window.autoTranscribe.cuesFor(titleId);
    if (src && src.complete) {
      let n = 0;
      for (const c of src.cues) if (!c.ai) n += (c.text || '').length;
      return { chars: n, estimated: false };
    }
    let dur = 0;
    try { dur = await window.autoTranscribe.durationFor(titleId); } catch (_) {}
    if (!(dur > 0)) dur = await probeDuration(titleId);
    return { chars: dur > 0 ? Math.round(dur / 3600000 * CHARS_PER_HOUR) : 0, estimated: true };
  }

  // Audio length from the file's metadata (an estimate is fine for pricing).
  async function probeDuration(titleId) {
    try {
      const t = await titleById(titleId);
      const ab = t?.attachments?.audiobook;
      if (!ab) return 0;
      let path = ab.cachePath || null;
      if (ab.uri) { try { path = (await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri: ab.uri })).path || path; } catch (_) {} }
      if (!path) return 0;
      return await new Promise((resolve) => {
        const a = new Audio();
        const done = (v) => { clearTimeout(to); a.removeAttribute('src'); try { a.load(); } catch (_) {} resolve(v); };
        const to = setTimeout(() => done(0), 6000);
        a.preload = 'metadata';
        a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? a.duration * 1000 : 0));
        a.addEventListener('error', () => done(0));
        a.src = window.Capacitor.convertFileSrc(path);
      });
    } catch (_) { return 0; }
  }

  // ── queue ─────────────────────────────────────────────────────────────────

  async function enqueue(ids) {
    await load();
    let added = 0;
    for (const id of ids) {
      if (Q.items.some(x => x.titleId === id && x.stage !== 'done' && x.stage !== 'error')) continue;
      const t = await titleById(id);
      if (!t || !window.aiCleanup.eligibleTitle(t)) continue;
      Q.items = Q.items.filter(x => x.titleId !== id);
      Q.items.push({ titleId: id, name: t.name || id, stage: 'queued', progress: 0, addedAt: Date.now(), costUsd: 0 });
      added++;
    }
    Q.running = true;
    await save();
    drive();
    return added;
  }

  async function drive() {
    await load();
    if (driving || !Q.running) { schedulePoll(); return; }
    driving = true; stopReq = false;
    preventSleep(true);
    try {
      for (;;) {
        if (stopReq || !Q.running) break;
        const it = Q.items.find(x => x.stage === 'queued' || x.stage === 'transcribing' || x.stage === 'glossary' || x.stage === 'submitting');
        if (!it) break;
        try { await prepareAndSubmit(it); }
        catch (e) { it.stage = 'error'; it.error = e?.message || String(e); log(it.name + ': ' + it.error); await save(); }
      }
    } finally {
      driving = false;
      schedulePoll();
      if (!Q.items.some(x => x.stage === 'waiting' || x.stage === 'furigana')) preventSleep(false);
    }
  }

  async function prepareAndSubmit(it) {
    const at = window.autoTranscribe, cl = window.aiCleanup;
    const title = await titleById(it.titleId);
    if (!title) throw new Error('title not found');
    let src = await at.cuesFor(it.titleId);
    if (!src || !src.complete || !title.attachments?.srt) {
      it.stage = 'transcribing'; it.progress = 0; await save();
      const r = await at.transcribeTitle(it.titleId, {
        onProgress: (f) => progressSave(it, f),
        shouldStop: () => stopReq || !Q.running,
      });
      if (!r.ok) { await save(); return; }   // stopped: stays 'transcribing', resumes later
      src = await at.cuesFor(it.titleId);
    }
    if (stopReq || !Q.running) return;
    it.stage = 'glossary'; await save();
    const st = await cl.loadState(it.titleId);
    if (!st.glossary) {
      st.glossary = await cl.buildGlossary(title, src.cues, st);
      await cl.saveState(it.titleId, st);
    }
    it.stage = 'submitting'; await save();
    await at.backupBeforeClean(it.titleId);
    const chunks = cl.chunkAll(src.cues);
    if (!chunks.length) { await startFurigana(it); return; }
    await submit(it, src.cues, chunks.map((ch, k) => ({ ch, id: 'k' + k })), st.glossary);
  }

  async function submit(it, cues, list, glossary) {
    const cl = window.aiCleanup;
    const model = window.ai.MODELS.high;
    const map = {};
    const requests = list.map(({ ch, id }) => {
      const p = cl.chunkPrompt(cues, ch, glossary);
      map[id] = p.seg.map(c => ({ startMs: c.startMs, orig: c.text || '' }));
      return { customId: id, opts: { model, system: cl.SYSTEM, messages: [{ role: 'user', content: p.user }], maxTokens: 16000, effort: EFFORT } };
    });
    await bs()?.set(MAP_PREFIX + it.titleId, JSON.stringify({ model, glossary, map }));
    const b = await window.ai.batchCreate(requests);
    it.batchId = b.id; it.model = model; it.chunks = requests.length; it.stage = 'waiting';
    it.submittedAt = Date.now(); it.progress = 0;
    log(it.name + ': submitted ' + requests.length + ' chunks as ' + b.id);
    await save();
  }

  // ── furigana pass ─────────────────────────────────────────────────────────
  // After proofreading, one more (cheap) batch: the model lists only the words
  // a publisher would give furigana to; the app stores them per cue
  // (c.ruby = [[off, len, reading]]) and drops repeats, so a word is glossed at
  // its first appearance and again only after a long stretch without it.

  function furiSystem(difficulty) {
    return [
      'You prepare furigana (ルビ) for a Japanese novel the way its publisher would for a general adult readership' +
        (difficulty ? ' (this book is rated ' + difficulty + ' on a 1–5 difficulty scale for learners; adjust density slightly to it)' : '') + '.',
      'Mark ONLY: rare or difficult kanji words; words with unusual or irregular readings (熟字訓, 当て字, special readings); personal names and place names whose reading is not obvious; specialised terms.',
      'Do NOT mark common words an adult reader knows. Keep it sparse, as in a typical paperback. Never mark the same word twice in this excerpt.',
      'Input: text segments marked ‹n›. Output one line per furigana and nothing else:',
      '‹n›漢字《よみ》',
      'where 漢字 is copied exactly from segment n (a whole word, kanji only or kanji with okurigana) and よみ is its reading in hiragana (katakana only when the reading is katakana). If nothing needs furigana, output nothing.',
    ].join('\n');
  }
  function furiChunks(cues) {
    const out = [];
    let i = 0;
    while (i < cues.length) {
      let j = i, chars = 0;
      while (j < cues.length) {
        chars += (cues[j].text || '').length;
        j++;
        if (chars >= FURI_CHUNK && /[。！？!?」』]$/.test(cues[j - 1].text || '')) break;
        if (chars >= FURI_CHUNK * 1.5) break;
      }
      out.push({ i, j });
      i = j;
    }
    return out;
  }
  async function difficultyFor(titleId) {
    try {
      const b = await window.libraryBlurb?.get?.(titleId);
      if (b && Number.isFinite(b.difficulty_score)) return b.difficulty_score.toFixed(1);
    } catch (_) {}
    try {
      const t = await titleById(titleId);
      const d = t?.meta?.localDifficulty;
      if (Number.isFinite(d)) return d.toFixed(1);
    } catch (_) {}
    return null;
  }
  const inRanges = (ranges, ms) => ranges.some(([a, b]) => ms >= a && ms <= b);
  async function startFurigana(it) {
    // A re-proofread of a few stretches in a book that already has furigana:
    // gloss just those stretches (their text changed, so their furigana went).
    const only = (it.furiganaDone && it.reproofRanges) ? it.reproofRanges : null;
    if (it.furiganaDone && !only) { await finishItem(it); return; }
    const src = await window.autoTranscribe.cuesFor(it.titleId);
    if (!src || !src.cues.length) { await finishItem(it); return; }
    const cues = only ? src.cues.filter(c => inRanges(only, c.startMs)) : src.cues;
    if (!cues.length) { delete it.reproofRanges; await finishItem(it); return; }
    it.furiOnly = only;
    const system = furiSystem(await difficultyFor(it.titleId));
    const model = window.ai.MODELS.high;
    const map = {};
    const requests = furiChunks(cues).map(({ i, j }, k) => {
      const seg = cues.slice(i, j);
      const id = 'f' + k;
      map[id] = seg.map(c => ({ startMs: c.startMs, text: c.text || '' }));
      return { customId: id, opts: { model, system, maxTokens: 6000, effort: 'medium',
        messages: [{ role: 'user', content: seg.map((c, n) => '‹' + (n + 1) + '›' + (c.text || '')).join('\n') }] } };
    });
    await bs()?.set(FMAP_PREFIX + it.titleId, JSON.stringify({ model, map }));
    const b = await window.ai.batchCreate(requests);
    it.furiBatchId = b.id; it.stage = 'furigana'; it.progress = 0;
    log(it.name + ': furigana batch ' + b.id + ' (' + requests.length + ' requests)');
    await save();
  }
  const KANJI_RE = /[\u3400-\u9fff々〆ヶ]/;
  const READING_RE = /^[ぁ-ゖァ-ヺー・]+$/;
  async function applyFurigana(it) {
    it.stage = 'furigana-applying'; await save();
    const stored = JSON.parse((await bs()?.get(FMAP_PREFIX + it.titleId)) || 'null');
    if (!stored || !stored.map) throw new Error('furigana map missing');
    const results = await window.ai.batchResults(it.furiBatchId);
    const perCue = new Map();   // startMs → { text, ruby: [] }
    for (const r of results) {
      const segs = stored.map[r.customId];
      if (!segs) continue;
      if (r.usage) it.costUsd = (it.costUsd || 0) + window.ai.recordBatchUsage(r.model || stored.model, 'furigana-batch', r.usage, it.titleId);
      if (!r.ok) continue;
      const re = /‹(\d+)›\s*([^《\n]{1,16})《([^》\n]{1,24})》/g;
      let m;
      while ((m = re.exec(r.text || ''))) {
        const seg = segs[+m[1] - 1];
        let base = m[2].trim(), rd = m[3].trim();
        if (!seg || !KANJI_RE.test(base) || !READING_RE.test(rd)) continue;
        // Furigana sits over the kanji only: trim okurigana (and leading kana)
        // that the reading repeats — 見た《みた》 → 見《み》.
        let lead = 0;
        while (base.length > 1 && rd.length > 1 && !KANJI_RE.test(base[base.length - 1]) && base[base.length - 1] === rd[rd.length - 1]) {
          base = base.slice(0, -1); rd = rd.slice(0, -1);
        }
        while (base.length > 1 && rd.length > 1 && !KANJI_RE.test(base[0]) && base[0] === rd[0]) {
          base = base.slice(1); rd = rd.slice(1); lead++;
        }
        if (!KANJI_RE.test(base)) continue;
        let e = perCue.get(seg.startMs);
        if (!e) { e = { text: seg.text, ruby: [] }; perCue.set(seg.startMs, e); }
        // First occurrence of the base in the cue that no earlier ruby covers.
        let from = 0, off = -1;
        const full = m[2].trim();
        // Locate via the full word (so 見 in 見た isn't matched inside another word), then step past trimmed leading kana.
        while ((off = seg.text.indexOf(full, from)) >= 0) {
          off += lead;
          if (!e.ruby.some(([o, l]) => off < o + l && o < off + base.length)) break;
          from = off - lead + 1;
        }
        if (off >= 0) e.ruby.push([off, base.length, rd]);
      }
    }
    // Publisher-style repeats: a word keeps furigana at its first appearance
    // and again only after FURI_REPEAT_GAP chars without it.
    const src = await window.autoTranscribe.cuesFor(it.titleId);
    const lastAt = new Map();
    let pos = 0;
    const items = [];
    const only = it.furiOnly || null;
    for (const c of src.cues) {
      if (only && !inRanges(only, c.startMs)) {
        // Outside the re-glossed stretches: leave the furigana as it is, but
        // count it so the repeat gap still spans the whole book.
        for (const r of c.ruby || []) lastAt.set((c.text || '').substr(r[0], r[1]), pos + r[0]);
        pos += (c.text || '').length;
        continue;
      }
      const e = perCue.get(c.startMs);
      if (e && e.text === c.text) {
        const keep = [];
        for (const r of e.ruby.sort((a, b) => a[0] - b[0])) {
          const base = c.text.substr(r[0], r[1]);
          const prev = lastAt.get(base);
          if (prev == null || pos + r[0] - prev >= FURI_REPEAT_GAP) { keep.push(r); lastAt.set(base, pos + r[0]); }
        }
        items.push({ startMs: c.startMs, text: c.text, ruby: keep });
      } else if (c.ruby) {
        items.push({ startMs: c.startMs, text: c.text, ruby: [] });   // stale furigana from an earlier pass
      }
      pos += (c.text || '').length;
    }
    const n = await window.autoTranscribe.applyRuby(it.titleId, items);
    const added = items.reduce((a, x) => a + x.ruby.length, 0);
    it.furigana = only ? (it.furigana || 0) + added : added;
    it.furiganaDone = true;
    delete it.furiOnly; delete it.reproofRanges;
    log(it.name + ': furigana on ' + n + ' cues, ' + it.furigana + ' words');
    try { await bs()?.remove?.(FMAP_PREFIX + it.titleId); } catch (_) {}
    await finishItem(it);
  }

  // ── batch results ─────────────────────────────────────────────────────────

  function schedulePoll(delay) {
    if (pollTimer) return;
    if (!Q || !Q.items.some(x => x.stage === 'waiting' || x.stage === 'furigana')) return;
    pollTimer = setTimeout(() => { pollTimer = null; poll(); }, delay ?? POLL_MS);
  }
  async function poll() {
    await load();
    if (polling) return;
    polling = true;
    try {
      for (const it of Q.items.filter(x => x.stage === 'waiting' || x.stage === 'furigana')) {
        const furi = it.stage === 'furigana';
        let b;
        try { b = await window.ai.batchGet(furi ? it.furiBatchId : it.batchId); } catch (e) { it.error = e?.message || String(e); continue; }
        const rc = b.request_counts || {};
        const total = (rc.processing || 0) + (rc.succeeded || 0) + (rc.errored || 0) + (rc.canceled || 0) + (rc.expired || 0);
        it.progress = total ? 1 - (rc.processing || 0) / total : 0;
        it.error = null;
        if (b.processing_status === 'ended') {
          try { if (furi) await applyFurigana(it); else await applyResults(it); }
          catch (e) {
            // Never park a book in 'applying': show it as an error so 再試行
            // can pick it up (a retry starts from what is still unproofread).
            it.error = e?.message || String(e); it.stage = 'error';
            log(it.name + ': apply failed: ' + it.error);
          }
        }
        await save();
      }
    } finally {
      polling = false;
      schedulePoll();
      if (!driving && !Q.items.some(x => x.stage === 'waiting' || x.stage === 'furigana')) preventSleep(false);
    }
  }

  async function applyResults(it) {
    const at = window.autoTranscribe, cl = window.aiCleanup;
    it.stage = 'applying'; await save();
    const stored = JSON.parse((await bs()?.get(MAP_PREFIX + it.titleId)) || 'null');
    if (!stored || !stored.map) throw new Error('chunk map missing');
    const results = await window.ai.batchResults(it.batchId);
    const edits = [], failed = [];
    it.failInfo = it.failInfo || [];
    for (const r of results) {
      const segs = stored.map[r.customId];
      if (!segs) continue;
      if (r.usage) it.costUsd = (it.costUsd || 0) + window.ai.recordBatchUsage(r.model || stored.model, 'ai-cleanup-batch', r.usage, it.titleId);
      const parsed = r.ok ? cl.parseOutput(r.text, segs.map(s => s.orig)) : null;
      if (!parsed) {
        failed.push(r.customId);
        // Why, for the next diagnosis: a request error / refusal, or output
        // that failed the marker check (and whether it was cut off).
        const why = !r.ok ? (r.error || 'error') : (r.stopReason === 'max_tokens' ? 'cut off (max_tokens)' : 'format');
        it.failInfo.push({ id: r.customId, cues: segs.length, why, at: Date.now() });
        log(it.name + ': chunk ' + r.customId + ' failed: ' + why);
        continue;
      }
      segs.forEach((s, k) => edits.push({ startMs: s.startMs, orig: s.orig, text: parsed[k].text, pb: parsed[k].pb }));
    }
    // Requests the results file didn't mention (shouldn't happen) count as failed.
    for (const id of Object.keys(stored.map)) if (!results.some(r => r.customId === id)) failed.push(id);
    await at.applyCleanEdits(it.titleId, edits);
    log(it.name + ': applied ' + (Object.keys(stored.map).length - failed.length) + ' chunks, ' + failed.length + ' failed');

    if (failed.length && !it.retried) {
      // One retry round for chunks whose output failed the marker check.
      const src = await at.cuesFor(it.titleId);
      const list = [];
      for (const id of failed) {
        const segs = stored.map[id];
        const i = src.cues.findIndex(c => c.startMs === segs[0].startMs);
        if (i < 0 || src.cues[i].ai) continue;
        // Retry as smaller pieces: a long chunk that broke the marker check
        // once tends to break it again the same way.
        const j = Math.min(src.cues.length, i + segs.length);
        const step = Math.max(RETRY_MIN_CUES, Math.ceil((j - i) / RETRY_PIECES));
        for (let a = i, p = 0; a < j; a += step, p++) list.push({ ch: { i: a, j: Math.min(j, a + step) }, id: id + '_' + p });   // custom_id allows [A-Za-z0-9_-] only
      }
      it.retried = true;
      if (list.length) { await submit(it, src.cues, list, stored.glossary); return; }
    }
    if (failed.length) {
      // Second failure: keep the original text, mark handled.
      const keep = [];
      it.keptRanges = [];
      for (const id of failed) {
        const segs = stored.map[id] || [];
        for (const s of segs) keep.push({ startMs: s.startMs, orig: s.orig, text: s.orig, pb: false });
        if (segs.length) it.keptRanges.push([segs[0].startMs, segs[segs.length - 1].startMs]);
      }
      await at.applyCleanEdits(it.titleId, keep);
      it.failedChunks = failed.length;
    }
    await startFurigana(it);
  }

  async function finishItem(it) {
    const at = window.autoTranscribe;
    try { await at.buildSyntheticEpub(it.titleId, { force: true, minCues: 1 }); } catch (_) {}
    try { await at.rewriteAutoSrt(it.titleId); } catch (_) {}
    try { it.exportedTo = await window.aiCleanup.exportBook(it.titleId); } catch (_) {}
    it.stage = 'done'; it.doneAt = Date.now(); it.progress = 1;
    try { await bs()?.remove?.(MAP_PREFIX + it.titleId); } catch (_) {}
    await save();
  }

  async function stop() {
    await load();
    Q.running = false; stopReq = true;
    try { window.autoTranscribe.stopHeadless(); } catch (_) {}
    await save();
  }
  async function resume() { await load(); Q.running = true; await save(); drive(); }
  // A failed book starts over from where it got to: a finished transcript and
  // a saved reference list are reused, so this usually goes straight to submit.
  async function retry(titleId) {
    await load();
    const it = Q.items.find(x => x.titleId === titleId);
    if (!it) return;
    it.stage = 'queued'; it.error = null; it.progress = 0; it.retried = false;
    Q.running = true;
    await save();
    drive();
  }
  // Proofread again the stretches a finished book kept as transcribed (its
  // chunk failed twice). Books from before keptRanges was recorded find them
  // by comparing with the pre-proofread backup.
  async function reproof(titleId) {
    await load();
    const it = Q.items.find(x => x.titleId === titleId);
    if (!it || it.stage !== 'done' || !it.failedChunks) return 0;
    const at = window.autoTranscribe;
    let ranges = Array.isArray(it.keptRanges) && it.keptRanges.length ? it.keptRanges : null;
    if (!ranges) ranges = (await at.keptStretches(titleId)).slice(0, it.failedChunks);
    if (!ranges.length) return 0;
    const n = await at.unmarkClean(titleId, ranges);
    log(it.name + ': re-proofreading ' + ranges.length + ' stretch(es), ' + n + ' cues');
    if (!n) return 0;
    it.reproofRanges = ranges;
    it.stage = 'queued'; it.error = null; it.progress = 0; it.retried = false;
    it.failedChunks = 0; it.keptRanges = null;
    Q.running = true;
    await save();
    drive();
    return n;
  }
  // Books proofread before the furigana pass existed: run only that pass.
  async function addFurigana(titleId) {
    await load();
    const it = Q.items.find(x => x.titleId === titleId);
    if (!it || it.stage !== 'done' || it.furiganaDone) return;
    it.error = null;
    try {
      await startFurigana(it);
      preventSleep(true);
      schedulePoll(POLL_MS);
    } catch (e) {
      it.stage = 'error'; it.error = e?.message || String(e); log(it.name + ': ' + it.error);
      await save();
    }
  }
  async function clearFinished() {
    await load();
    Q.items = Q.items.filter(x => x.stage !== 'done' && x.stage !== 'error');
    await save();
  }
  async function remove(titleId) {
    await load();
    const it = Q.items.find(x => x.titleId === titleId);
    if (!it) return;
    if (it.stage === 'waiting' && it.batchId) { try { await window.ai.batchCancel(it.batchId); } catch (_) {} }
    if (it.stage === 'transcribing' && driving) { stopReq = true; try { window.autoTranscribe.stopHeadless(); } catch (_) {} }
    Q.items = Q.items.filter(x => x !== it);
    await save();
    if (Q.running) setTimeout(drive, 500);
  }

  // ── UI (Japanese-only labels, like the 校正 pill) ────────────────────────────

  function stageLabel(it) {
    const pct = Math.floor(100 * (it.progress || 0));
    switch (it.stage) {
      case 'queued': return '待機中';
      case 'transcribing': return '文字起こし中 ' + pct + '%';
      case 'glossary': return '用語を調査中';
      case 'submitting': return '送信中';
      case 'waiting': return '校正中（バッチ）' + (pct ? ' ' + pct + '%' : '');
      case 'applying': return '反映中';
      case 'furigana': return 'ふりがな付け中' + (pct ? ' ' + pct + '%' : '');
      case 'furigana-applying': return 'ふりがなを反映中';
      case 'done': return '完了' + (it.furigana ? '・ふりがな' + it.furigana + '語' : '') + (it.failedChunks ? '（' + it.failedChunks + '箇所は原文のまま）' : '');
      case 'error': return 'エラー：' + (it.error || '');
      default: return it.stage;
    }
  }

  // Share of one book's pipeline that is done (0..1): transcription is the
  // long local part, the batch the long remote one.
  function itemFrac(it) {
    const p = Math.max(0, Math.min(1, it.progress || 0));
    switch (it.stage) {
      case 'queued': return 0;
      case 'transcribing': return 0.6 * p;
      case 'glossary': return 0.62;
      case 'submitting': return 0.65;
      case 'waiting': return 0.65 + 0.25 * p;
      case 'applying': return 0.9;
      case 'furigana': return 0.91 + 0.07 * p;
      case 'furigana-applying': return 0.98;
      default: return 1;   // done / error
    }
  }
  function bar(frac, h) {
    const track = document.createElement('div');
    track.style.cssText = 'height:' + (h || 4) + 'px;border-radius:2px;background:#091013;overflow:hidden;margin-top:5px;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:' + Math.round(frac * 100) + '%;background:#6db3b6;border-radius:2px;transition:width .4s ease;';
    track.appendChild(fill);
    return { track, fill };
  }

  // Failed books don't count toward overall progress.
  function overallFrac() {
    const live = Q.items.filter(x => x.stage !== 'error');
    return live.length ? live.reduce((a, x) => a + itemFrac(x), 0) / live.length : 0;
  }

  let pill = null, pillText = null, pillBar = null;
  function render() {
    if (!Q) return;
    const active = Q.items.filter(x => x.stage !== 'done' && x.stage !== 'error');
    // Stays up until 完了を消去, so finished books (and their ふりがな button) stay reachable.
    const show = Q.items.length > 0;
    if (!pill) {
      if (!show) return;
      pill = document.createElement('button');
      pill.id = 'aiBatchPill';
      pill.type = 'button';
      pill.style.cssText = 'position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 16px);z-index:9000;' +
        'background:rgba(26,36,40,.96);color:#d4dbde;border:1px solid #3d4c53;border-radius:6px;' +
        'padding:7px 14px 8px;min-width:230px;text-align:left;font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;font-family:inherit;';
      pill.addEventListener('click', openSheet);
      pillText = document.createElement('div');
      pillBar = bar(0, 3);
      pill.append(pillText, pillBar.track);
      document.body.appendChild(pill);
    }
    pill.style.display = show ? '' : 'none';
    const done = Q.items.filter(x => x.stage === 'done').length;
    const cur = active.find(x => x.stage === 'transcribing') || active[0];
    pillText.textContent = '一括校正 ' + done + '/' + Q.items.length + (cur ? ' · ' + stageLabel(cur) : ' · 完了') + (Q.running || !cur ? '' : ' · 停止中');
    const overall = overallFrac();
    pillBar.fill.style.width = Math.round(overall * 100) + '%';
    if (sheet && sheet.isConnected) fillSheet();
  }

  let sheet = null;
  function openSheet() {
    if (sheet && sheet.isConnected) return;
    sheet = document.createElement('div');
    sheet.className = 'kai-modal';
    sheet.style.cssText = 'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    for (const ev of ['touchstart', 'touchmove', 'touchend']) sheet.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(sheet);
    fillSheet();
  }
  function fillSheet() {
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a2428;color:#d4dbde;border:1px solid #2b3a41;border-radius:10px;padding:18px;width:min(560px,100%);max-height:80vh;overflow:auto;';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin-bottom:10px;';
    const total = Q.items.reduce((s, x) => s + (x.costUsd || 0), 0);
    h.textContent = '一括校正' + (total > 0 ? '（$' + total.toFixed(2) + '）' : '');
    box.appendChild(h);
    if (Q.items.length) {
      const ob = bar(overallFrac(), 6);
      ob.track.style.margin = '0 0 10px';
      box.appendChild(ob.track);
    }
    for (const it of Q.items) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #24333a;font-size:.85rem;';
      const name = document.createElement('div'); name.style.cssText = 'flex:1;min-width:0;';
      const n1 = document.createElement('div'); n1.textContent = it.name; n1.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      const n2 = document.createElement('div'); n2.textContent = stageLabel(it); n2.style.cssText = 'font-size:.75rem;color:' + (it.stage === 'error' ? '#e89a9a' : '#8c989d') + ';';
      name.append(n1, n2);
      if (it.stage !== 'done' && it.stage !== 'error') name.appendChild(bar(itemFrac(it), 4).track);
      if (it.stage === 'error') {
        const rb = document.createElement('button'); rb.type = 'button'; rb.textContent = '再試行';
        rb.style.cssText = 'background:#303d44;color:#d4dbde;border:1px solid #3d4c53;border-radius:5px;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;';
        rb.addEventListener('click', () => retry(it.titleId));
        row.appendChild(name); row.appendChild(rb);
      }
      if (it.stage === 'done' && it.failedChunks) {
        const pb = document.createElement('button'); pb.type = 'button'; pb.textContent = '再校正';
        pb.title = '原文のまま残った箇所をもう一度校正します';
        pb.style.cssText = 'background:#303d44;color:#d4dbde;border:1px solid #3d4c53;border-radius:5px;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;';
        pb.addEventListener('click', () => { pb.disabled = true; reproof(it.titleId); });
        if (!name.parentNode) row.appendChild(name);
        row.appendChild(pb);
      }
      if (it.stage === 'done' && !it.furiganaDone) {
        const fb = document.createElement('button'); fb.type = 'button'; fb.textContent = 'ふりがな';
        fb.style.cssText = 'background:#303d44;color:#d4dbde;border:1px solid #3d4c53;border-radius:5px;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:.75rem;';
        fb.addEventListener('click', () => { fb.disabled = true; addFurigana(it.titleId); });
        row.appendChild(name); row.appendChild(fb);
      }
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕';
      x.style.cssText = 'background:none;border:none;color:#8c989d;font-size:1rem;cursor:pointer;';
      x.addEventListener('click', () => { if (it.stage === 'done' || it.stage === 'error' || confirm('「' + it.name + '」をキューから外しますか？')) remove(it.titleId); });
      if (!name.parentNode) row.appendChild(name);
      row.appendChild(x);
      box.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;';
    const mk = (label, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'background:#303d44;color:#d4dbde;border:1px solid #3d4c53;border-radius:5px;padding:6px 14px;cursor:pointer;font-family:inherit;';
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    if (Q.running) mk('停止', () => stop()); else mk('再開', () => resume());
    if (Q.items.some(x => x.stage === 'done' || x.stage === 'error')) mk('完了を消去', () => clearFinished());
    mk('閉じる', () => sheet.remove());
    box.appendChild(actions);
    sheet.replaceChildren(box);
  }

  // Library select mode → "一括校正…": confirm the selection, then queue it.
  async function confirmAndEnqueue(ids) {
    if (!available()) {
      alert('一括校正には Anthropic の API キー（AI 機能）が必要です。');
      return;
    }
    const titles = [];
    for (const id of ids) { const t = await titleById(id); if (t && window.aiCleanup.eligibleTitle(t)) titles.push(t); }
    if (!titles.length) { alert('選択した本の中に、音声のみの本（生成テキスト）がありません。'); return; }
    let chars = 0, est = false;
    for (const t of titles) { const c = await charsFor(t.id); chars += c.chars; est = est || c.estimated; }
    let total = 0;
    for (const t of titles) { const s2 = await window.autoTranscribe.cuesFor(t.id); if (s2) for (const c of s2.cues) total += (c.text || '').length; }
    total = Math.max(total, chars);
    // Furigana pass: input-heavy, short output.
    const usd = estimateUsd(chars) + 0.5 * (total * 1.4 * 4 + total * 0.15 * 20) / 1e6;
    const skipped = ids.length - titles.length;
    const msg = titles.length + '冊を文字起こし・校正します（' + window.ai.MODELS.high + '、バッチ料金）。\n' +
      '約' + Math.round(chars / 1000) + 'k文字' + (est ? '（推定）' : '') + ' · 約$' + usd.toFixed(1) + '\n' +
      (skipped ? skipped + '冊は対象外（本文のある本）のため除外します。\n' : '') +
      'ふりがな（出版社の基準で必要な語のみ）も付けます。\n' +
      '完了した本は「書類」› Kadoki › Books に EPUB で保存されます。Mac はスリープしません。';
    if (!confirm(msg)) return;
    const n = await enqueue(titles.map(t => t.id));
    try { window.showToast?.(n + '冊を一括校正に追加しました', 2200); } catch (_) {}
    openSheet();
  }

  // Resume after a relaunch.
  setTimeout(async () => {
    await load();
    // A book whose apply step failed (e.g. its retry batch was rejected) is
    // proofread again from what is still unproofread.
    for (const it of Q.items) {
      if ((it.stage === 'applying' || it.stage === 'error') && it.error && it.reproofRanges) {
        it.stage = 'queued'; it.error = null; it.retried = false; it.progress = 0;
      }
    }
    render();
    if (Q.running && Q.items.some(x => ['queued', 'transcribing', 'glossary', 'submitting'].includes(x.stage))) {
      // A crash mid-'applying' just re-polls: results stay available for 29 days.
      drive();
    }
    for (const it of Q.items) {
      if (it.stage === 'applying') it.stage = 'waiting';
      if (it.stage === 'furigana-applying') it.stage = 'furigana';
    }
    schedulePoll(5000);
  }, 6000);

  window.aiBatch = { available, enqueue, confirmAndEnqueue, stop, resume, openSheet, estimateUsd, reproof };
})();
