// library-blurb.js — spoiler-free book summaries for the library browser.
//
// The first ~12k characters (library-meta.js excerpt) go to the AI backend
// (OpenRouter by default — window.ai.request) once per title; the reply is
// JSON: 3-4 paragraphs in Japanese AND English, a 1-5 difficulty rating with
// a one-line reason in both languages, and a few genre/tone tags. Cached in
// blobStore LIB_BLURB_V1_<titleId> {v, ts, model, costUsd, ...}. runQueue()
// summarizes every un-summarized book one after another (called after
// import, at boot, and when the library opens); regenerate(id) redoes one.
(function () {
  'use strict';
  const KEY = (id) => 'LIB_BLURB_V1_' + id;
  const T = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
  const mem = new Map();
  let _running = false, _queueTotal = 0, _queueDone = 0, _current = '', _failed = 0;
  // Failures are remembered (blobStore LIB_BLURB_ERR_V1 = {id: {ts, msg}}) so the
  // details panel can say WHY a book has no summary, and the queue doesn't
  // hammer a broken title every run (retry after RETRY_MS, or on demand).
  const ERR_KEY = 'LIB_BLURB_ERR_V2';   // v2: v1 records were all the stale-cache-path failure, now fixed
  const RETRY_MS = 6 * 3600 * 1000;
  let errs = null;
  async function loadErrs() { if (errs) return errs; try { const raw = await window.blobStore?.get(ERR_KEY); errs = raw ? JSON.parse(raw) : {}; } catch (_) { errs = {}; } return errs; }
  async function setErr(id, msg) { const e = await loadErrs(); if (msg) e[id] = { ts: Date.now(), msg: String(msg).slice(0, 300) }; else delete e[id]; try { await window.blobStore?.set(ERR_KEY, JSON.stringify(e)); } catch (_) {} }
  async function lastError(id) { const e = await loadErrs(); return e[id] || null; }

  const SYSTEM =
    'あなたは日本語文学に詳しい書評家です。与えられた本の冒頭部分（約10ページ）だけを読み、' +
    'これから読む日本語学習者のために、ネタバレのない紹介文を書きます。冒頭に書かれていない展開を推測・予測してはいけません。' +
    '必ず指定のJSONだけを返してください。\n' +
    '難易度は「日本語学習者がこの本を読む体験」を、語彙の幅、漢字の密度、文の長さと構造、文体（口語的か文語的・古風か）、方言・俗語・専門用語の多さで判断する。' +
    '"difficulty_score" は 1.0〜5.0 の小数（0.1刻み）、"difficulty" はその四捨五入の整数。1〜5の全範囲を使い、3に偏らないこと。目安: ' +
    '1.0〜1.9 = 児童書・YA・短文で口語的（例: 『かがみの孤城』『コンビニ人間』の文体）, ' +
    '2.0〜2.9 = ライトノベル・青春小説・軽いエンタメ、平明で読みやすい現代文（例: 『君の膵臓をたべたい』『キノの旅』、村上春樹の作品）, ' +
    '3.0〜3.9 = 標準的な大人向けエンタメ・ミステリー（例: 東野圭吾、伊坂幸太郎、『ハサミ男』）, ' +
    '4.0〜4.9 = 文学的で語彙が豊富、長文・重層的な描写、専門用語や古い言い回しが多い（例: 『三体』日本語版、京極夏彦、宮部みゆきの時代物）, ' +
    '5.0 = 古風／文語的／実験的で非常に難解（例: 夏目漱石『こころ』以前の文体、三島由紀夫『金閣寺』、『ドグラ・マグラ』）。' +
    '重要: JLPT・N1〜N5・検定・級など、いかなる試験レベルにも一切言及しない（どのフィールドでも）。' +
    '難易度の理由（difficulty_ja / difficulty_en）は、その本の文章の何が易しい／難しいかを一文で具体的に述べる。' +
    '"ja" と "en" はそれぞれ3〜4段落の紹介文（各段落は独立した文字列）。段落は雰囲気・舞台・登場人物・文体に触れ、結末や後半の展開には触れない。' +
    '"en" は "ja" の翻訳ではなく、英語読者向けに自然に書き直したもの。タグは3〜6個。';
  const SCHEMA = {
    name: 'book_blurb',
    schema: {
      type: 'object',
      properties: {
        ja: { type: 'array', items: { type: 'string' } },   // 3-4 paragraphs: asked in the prompt (the API's schema allows minItems 0/1 only)
        en: { type: 'array', items: { type: 'string' } },
        difficulty: { type: 'integer' },          // 1-5, clamped after parsing
        difficulty_score: { type: 'number' },
        difficulty_ja: { type: 'string' },
        difficulty_en: { type: 'string' },
        tags_ja: { type: 'array', items: { type: 'string' } },
        tags_en: { type: 'array', items: { type: 'string' } },
      },
      required: ['ja', 'en', 'difficulty', 'difficulty_score', 'difficulty_ja', 'difficulty_en', 'tags_ja', 'tags_en'],
      additionalProperties: false,
    },
  };

  async function get(titleId) {
    if (!titleId) return null;
    if (mem.has(titleId)) return mem.get(titleId);
    let b = null;
    try { const raw = await window.blobStore?.get(KEY(titleId)); if (raw) b = JSON.parse(raw); } catch (_) {}
    mem.set(titleId, b);
    return b;
  }
  // Warm the cache shortly after launch so the first Library open doesn't wait
  // on one IndexedDB read per title.
  setTimeout(async () => {
    try {
      const list = (await window.titleStore?.list?.()) || [];
      await Promise.all(list.map(t => get(t.id).catch(() => null)));
    } catch (_) {}
  }, 8000);

  function parseJson(text) {
    const s = String(text || '');
    try { return JSON.parse(s); } catch (_) {}
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
    return null;
  }
  function usable(t) { return !!(t && t.attachments && t.attachments.epub && !t.cloudOnly); }

  async function generate(title, opts) {
    if (!usable(title) || !window.ai?.isEnabled?.()) return null;
    const force = !!(opts && opts.force);
    if (!force) { const have = await get(title.id); if (have && have.v === 1) return have; }
    const excerpt = await window.libraryMeta?.excerptFor?.(title);
    if (!excerpt || excerpt.length < 400) throw new Error(T('lib.err_no_text', 'could not extract the book text') + (excerpt ? ' (' + excerpt.length + ' chars)' : ''));
    _current = title.name || '';
    const r = await window.ai.request({
      feature: 'blurb',
      titleId: title.id,
      model: (window.ai.modelFor ? window.ai.modelFor('deep') : undefined),
      system: SYSTEM,
      maxTokens: 2400,
      outputSchema: SCHEMA.schema,   // ai.js wraps it (json_schema on OpenRouter, output_config on Anthropic)
      retryable: true,
      messages: [{ role: 'user', content: '本のタイトル: ' + (title.name || '') + (title.author ? '\n著者: ' + title.author : '') + '\n\n冒頭部分:\n\n' + excerpt + '\n\n上記のJSONを返してください。' }],
    });
    const obj = parseJson(r && (r.text || r.content));
    if (!obj || !Array.isArray(obj.ja) || !Array.isArray(obj.en)) throw new Error('blurb: unparseable reply');
    const b = {
      v: 1, ts: Date.now(), model: r.model || '', costUsd: Number(r.costUsd) || 0,
      ja: obj.ja.map(String), en: obj.en.map(String),
      difficulty: Math.max(1, Math.min(5, parseInt(obj.difficulty, 10) || Math.round(Number(obj.difficulty_score) || 3))),
      difficulty_score: (Number(obj.difficulty_score) >= 1 && Number(obj.difficulty_score) <= 5) ? Math.round(Number(obj.difficulty_score) * 10) / 10 : null,
      difficulty_ja: String(obj.difficulty_ja || ''), difficulty_en: String(obj.difficulty_en || ''),
      tags_ja: Array.isArray(obj.tags_ja) ? obj.tags_ja.map(String).slice(0, 6) : [],
      tags_en: Array.isArray(obj.tags_en) ? obj.tags_en.map(String).slice(0, 6) : [],
    };
    try { await window.blobStore?.set(KEY(title.id), JSON.stringify(b)); } catch (_) {}
    mem.set(title.id, b);
    try { await setErr(title.id, null); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('kai:blurb', { detail: { titleId: title.id } })); } catch (_) {}
    return b;
  }

  function status() { return _running ? { total: _queueTotal, done: _queueDone, current: _current, failed: _failed } : null; }
  function paintStatus() {
    const el = document.getElementById('libBlurbStatus');
    if (!el) return;
    const st = status();
    if (!st) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = T('lib.summarizing', 'Summarizing') + ' ' + Math.min(st.total, st.done + 1) + '/' + st.total + (st.current ? ' · ' + st.current : '') + (st.failed ? ' · ' + st.failed + ' ' + T('lib.failed_n', 'failed') : '');
  }

  async function runQueue() {
    if (_running || !window.ai?.isEnabled?.()) return 0;
    _running = true; _queueDone = 0; _failed = 0;
    let did = 0;
    try {
      const titles = (await window.titleStore.list()).filter(usable);
      const e = await loadErrs();
      const todo = [];
      for (const t of titles) {
        const have = await get(t.id); if (have) continue;
        const le = e[t.id]; if (le && Date.now() - le.ts < RETRY_MS) continue;   // recently failed: leave it for the Retry button / next window
        todo.push(t);
      }
      _queueTotal = todo.length;
      paintStatus();
      try { console.log('[blurb] queue: ' + todo.length + ' to summarize'); } catch (_) {}
      for (const t of todo) {
        try { const b = await generate(t); if (b) did++; }
        catch (err) { _failed++; try { await setErr(t.id, err && err.message); } catch (_) {} try { console.warn('[blurb] ' + (t.name || t.id) + ': ' + (err && err.message)); } catch (_) {} }
        _queueDone++;
        paintStatus();
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally { _running = false; _current = ''; paintStatus(); }
    if (did && typeof window.populateLibrary === 'function' && document.getElementById('libraryPage')?.classList.contains('visible')) { try { await window.populateLibrary(); } catch (_) {} }
    return did;
  }
  async function regenerate(titleId) {
    const t = await window.titleStore.get(titleId);
    if (!t) return null;
    try { return await generate(t, { force: true }); } catch (e) { try { window.showToast?.(T('lib.summary_failed', 'Summary failed: ') + (e && e.message), 3000); } catch (_) {} return null; }
  }

  // Boot: summaries first (user-visible), then the slower metadata pass.
  setTimeout(() => { Promise.resolve().then(() => runQueue()).catch(() => {}).finally(() => { try { window.libraryMeta?.ensureAll?.(); } catch (_) {} }); }, 14000);
  window.libraryBlurb = { get, generate, regenerate, runQueue, status, lastError };
})();
