// ai-openai.js — OpenAI (ChatGPT) API core for the IMAGE backend (window.aiOpenai).
//
// A sibling of ai.js (which is the Anthropic/Claude transport for the TEXT
// features). This module is BYOK + accounting ONLY for the optional cloud
// image backend: key handling, the native-HTTP transport, three image
// primitives, a small art-director chat helper, and its OWN token/cost ledger
// (kept separate from ai.js's Claude ledger so the two never mix).
//
// BYOK: the key is the user's own OpenAI key (Preferences → AI Features → AI
// Image). It is sent only to api.openai.com and stored only in Capacitor
// Preferences / localStorage. api.openai.com returns NO CORS headers, so every
// call goes through the native CapacitorHttp plugin (like ai-images.js); a
// WebView fetch would be blocked. Everything here is the OPTIONAL cloud path —
// the local image server (ai-images.js) stays the default.
//
// Image generation + editing use the Responses API (/v1/responses) with the
// built-in `image_generation` tool, so a text edit ("make her hair longer")
// chains from the prior image via previous_response_id. The art-director step
// (Japanese card → English prompt + Japanese caption) is a plain text Responses
// call. See image-pipeline-spec.md for the two-stage contract.
(function () {
  'use strict';

  const API_BASE = 'https://api.openai.com/v1';
  const RESPONSES_URL = API_BASE + '/responses';
  const IMAGES_GEN_URL = API_BASE + '/images/generations';

  const KEY_PREF = 'OPENAI_API_KEY';
  const LEDGER_KEY = 'OPENAILEDGER_V1';   // blobStore; [{ts,model,feature,tid,ti,to} | {ts,model,feature,tid,usd}]
  const LEDGER_MAX = 2000;
  const COST_KEY = 'OPENAICOST_V1';       // { titles: { [titleId]: usd }, total } — cumulative, never capped

  // Text $/MTok (input, output) for the art-director / orchestration model.
  // Estimates only (billing is OpenAI's); surfaced as "~$". The image cost
  // dwarfs the text cost, so rough text numbers are fine.
  const TEXT_PRICES = [
    { match: 'gpt-4.1-mini', inUsd: 0.4, outUsd: 1.6 },
    { match: 'gpt-4.1-nano', inUsd: 0.1, outUsd: 0.4 },
    { match: 'gpt-4.1',      inUsd: 2,   outUsd: 8 },
    { match: 'gpt-4o-mini',  inUsd: 0.15, outUsd: 0.6 },
    { match: 'gpt-4o',       inUsd: 2.5, outUsd: 10 },
    { match: 'gpt-5-mini',   inUsd: 0.25, outUsd: 2 },
    { match: 'gpt-5',        inUsd: 1.25, outUsd: 10 },
  ];
  // Flat per-image estimate by quality (gpt-image-1.5/2 mid range). The exact
  // figure is token-derived and varies by size; this is an honest "~$".
  const IMG_USD = { low: 0.02, medium: 0.06, high: 0.19, auto: 0.07 };

  // Defaults if a pref is unset (the AIIMG_OAI_* prefs override via the adapter).
  const DEFAULT_TEXT_MODEL = 'gpt-4.1';     // tool-capable; supports the image_generation tool
  const DEFAULT_QUALITY = 'medium';

  let _cost = { titles: {}, total: 0 };

  // ---- prefs (dual-write, identical pattern to ai.js) ----------------------
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins
    && window.Capacitor.Plugins.Preferences;
  async function getPref(k) {
    try { const p = CapPrefs(); if (p) { const r = await p.get({ key: k }); if (r && r.value != null) return r.value; } } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function setPref(k, v) {
    try { localStorage.setItem(k, v); } catch (_) {}
    try { const p = CapPrefs(); if (p) await p.set({ key: k, value: v }); } catch (_) {}
  }
  function dbg() { try { return localStorage.getItem('KADOKI_DEBUG') === '1'; } catch (_) { return false; } }
  function slog() { if (!dbg()) return; try { console.log.apply(console, ['[aiOpenai]'].concat([].slice.call(arguments))); } catch (_) {} }

  let _key = '';
  const ready = (async () => {
    _key = (await getPref(KEY_PREF)) || '';
    try { _cost = JSON.parse((await getPref(COST_KEY)) || 'null') || { titles: {}, total: 0 }; } catch (_) { _cost = { titles: {}, total: 0 }; }
    if (!_cost || !_cost.titles) _cost = { titles: {}, total: 0 };
  })();

  // ---- ledger ---------------------------------------------------------------
  let _ledger = null;
  async function loadLedger() {
    if (_ledger) return _ledger;
    try {
      const raw = window.blobStore ? await window.blobStore.get(LEDGER_KEY) : null;
      const p = raw ? JSON.parse(raw) : null;
      _ledger = (p && Array.isArray(p.entries)) ? p : { v: 1, entries: [] };
    } catch (_) { _ledger = { v: 1, entries: [] }; }
    return _ledger;
  }
  function pushEntry(entry) {
    loadLedger().then((led) => {
      led.entries.push(entry);
      if (led.entries.length > LEDGER_MAX) led.entries.splice(0, led.entries.length - LEDGER_MAX);
      try { if (window.blobStore) window.blobStore.set(LEDGER_KEY, JSON.stringify(led)).catch(() => {}); } catch (_) {}
    }).catch(() => {});
  }
  function recordTokens(model, feature, usage, titleId) {
    try {
      pushEntry({ ts: Date.now(), model, feature: feature || 'misc', tid: titleId || null,
                  ti: (usage && usage.input_tokens) || 0, to: (usage && usage.output_tokens) || 0 });
    } catch (_) {}
  }
  function recordImage(model, feature, usd, titleId) {
    try {
      pushEntry({ ts: Date.now(), model, feature: feature || 'img', tid: titleId || null, usd: usd || 0 });
      addCost(titleId, usd || 0);
    } catch (_) {}
  }
  function textPriceFor(model) {
    const m = String(model || '').toLowerCase();
    for (const p of TEXT_PRICES) if (m.includes(p.match)) return p;
    return TEXT_PRICES[2]; // gpt-4.1 as the neutral default
  }
  function entryCostUsd(e) {
    if (e && Number.isFinite(e.usd)) return e.usd;               // image entry: pre-estimated $
    const p = textPriceFor(e && e.model);
    return (((e && e.ti) || 0) * p.inUsd + ((e && e.to) || 0) * p.outUsd) / 1e6;
  }
  function estimateImageUsd(quality) {
    const q = String(quality || DEFAULT_QUALITY).toLowerCase();
    return Number.isFinite(IMG_USD[q]) ? IMG_USD[q] : IMG_USD.medium;
  }
  async function monthSpendUsd() {
    const led = await loadLedger();
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    let sum = 0;
    for (const e of led.entries) { const d = new Date(e.ts); if (d.getFullYear() === y && d.getMonth() === m) sum += entryCostUsd(e); }
    return sum;
  }
  // Summed $ recorded since `sinceTs` (used by the daily-budget $ safety cap).
  async function spendSinceUsd(sinceTs) {
    const led = await loadLedger();
    let sum = 0;
    for (const e of led.entries) if ((e.ts || 0) >= sinceTs) sum += entryCostUsd(e);
    return sum;
  }
  function addCost(titleId, usd) {
    try {
      if (!Number.isFinite(usd) || usd <= 0) return;
      if (!_cost || !_cost.titles) _cost = { titles: {}, total: 0 };
      _cost.total = (_cost.total || 0) + usd;
      if (titleId) _cost.titles[titleId] = (_cost.titles[titleId] || 0) + usd;
      setPref(COST_KEY, JSON.stringify(_cost));
    } catch (_) {}
  }
  function costByTitle() {
    try {
      const titles = Object.keys((_cost && _cost.titles) || {})
        .map(id => ({ titleId: id, usd: _cost.titles[id] }))
        .sort((a, b) => b.usd - a.usd);
      return { titles, total: (_cost && _cost.total) || 0 };
    } catch (_) { return { titles: [], total: 0 }; }
  }

  // ---- transport (native CapacitorHttp only — OpenAI has no CORS) -----------
  function nativeHttp() {
    try { return window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp || null; } catch (_) { return null; }
  }
  // POST JSON to an OpenAI endpoint. Resolves the parsed body; throws an Error
  // with a user-presentable message and ._status / ._retryAfterMs / ._refused.
  async function oaPost(url, body, opts) {
    opts = opts || {};
    const H = nativeHttp();
    let resp;
    try {
      if (H) {
        resp = await H.request({
          url, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _key },
          data: body,
          connectTimeout: 30000,
          readTimeout: opts.timeout || 180000,   // image renders can take ~2 min
        });
      } else {
        // desktop dev fallback (will hit CORS in a real browser; native is the real path)
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _key }, body: JSON.stringify(body) });
        resp = { status: r.status, data: await r.json().catch(() => null), headers: {} };
      }
    } catch (e) { throw new Error('Network error — check your connection'); }
    const data = (typeof resp.data === 'string')
      ? (() => { try { return JSON.parse(resp.data); } catch (_) { return null; } })()
      : resp.data;
    if (resp.status < 200 || resp.status >= 300) {
      const errObj = (data && data.error) || {};
      let msg = errObj.message || ('OpenAI error ' + resp.status);
      const err = new Error(msg);
      err._status = resp.status;
      const lc = (msg + ' ' + (errObj.code || '') + ' ' + (errObj.type || '')).toLowerCase();
      if (resp.status === 401) err.message = 'Invalid OpenAI API key (401) — check Preferences → AI Features';
      else if (resp.status === 429) { err.message = 'OpenAI rate limited (429) — wait a moment and retry'; }
      else if (/verif/.test(lc) && /organi[sz]ation/.test(lc)) { err.message = 'OpenAI: your organization must be verified to use image models — verify at platform.openai.com/settings/organization'; err._terminal = true; }
      else if (/moderation|content_policy|safety|content filter|not allowed|violat/.test(lc)) err._refused = true;
      else if (resp.status === 400 || resp.status === 403 || resp.status === 404) err._terminal = true;   // deterministic client error — retrying won't help (don't loop/re-bill)
      try {
        const h = resp.headers || {};
        const ra = parseFloat(h['retry-after'] || h['Retry-After']);
        if (isFinite(ra) && ra > 0) err._retryAfterMs = ra * 1000;
      } catch (_) {}
      throw err;
    }
    if (!data) throw new Error('Unexpected OpenAI response');
    return data;
  }

  // Pull the aggregated text out of a Responses result.
  function responseText(data) {
    if (data && typeof data.output_text === 'string' && data.output_text) return data.output_text;
    let t = '';
    const out = (data && Array.isArray(data.output)) ? data.output : [];
    for (const o of out) {
      if (o && o.type === 'message' && Array.isArray(o.content)) {
        for (const c of o.content) if (c && c.type === 'output_text' && c.text) t += c.text;
      }
    }
    return t;
  }
  // Pull the generated image (base64) + response id out of a Responses result.
  function responseImage(data) {
    const out = (data && Array.isArray(data.output)) ? data.output : [];
    const call = out.find(o => o && o.type === 'image_generation_call');
    const respId = (data && data.id) || null;
    if (call && call.result) return { b64: call.result, respId, status: call.status || 'completed' };
    // No image → collect any refusal/text so the caller can explain.
    let refusal = '';
    for (const o of out) {
      if (o && o.type === 'message' && Array.isArray(o.content)) {
        for (const c of o.content) {
          if (c && c.type === 'refusal' && c.refusal) refusal += c.refusal + ' ';
          else if (c && c.type === 'output_text' && c.text) refusal += c.text + ' ';
        }
      }
    }
    return { b64: null, respId, status: (call && call.status) || (data && data.status) || 'incomplete', refusal: refusal.trim() };
  }

  // ---- public primitives ----------------------------------------------------

  // Art-director step: text-only Responses call. Returns the raw model text
  // (the adapter parses the <p>/<c> blocks). Throws on error/refusal.
  async function chat(opts) {
    await ready;
    if (!_key) throw new Error('No OpenAI API key — add one in Preferences → AI Features');
    const model = opts.model || DEFAULT_TEXT_MODEL;
    const body = {
      model,
      instructions: opts.system || '',
      input: opts.user || '',
      max_output_tokens: opts.maxTokens || 2600,
    };
    if (Number.isFinite(opts.temperature) && !/^(o\d|gpt-5)/i.test(model)) body.temperature = opts.temperature;   // reasoning/gpt-5 models reject temperature != 1
    const data = await oaPost(RESPONSES_URL, body, { timeout: 90000 });
    recordTokens(model, opts.feature || 'img-prompt', data.usage, opts.titleId);
    if (data.status === 'incomplete' && data.incomplete_details && /content_filter|safety/i.test(JSON.stringify(data.incomplete_details))) {
      const e = new Error('OpenAI declined to write this prompt (content policy)'); e._refused = true; throw e;
    }
    return responseText(data);
  }

  // Generate ONE image from a finished English prompt via the image_generation
  // tool. Returns { b64, respId }. respId lets a later editImage() chain from
  // this exact image. Throws with ._refused on a content-policy refusal.
  async function generateImage(opts) {
    await ready;
    if (!_key) throw new Error('No OpenAI API key — add one in Preferences → AI Features');
    // A PINNED gpt-image-* model → the Images API (lets us choose the exact
    // model). No response id, so later edits use the stored-bytes path. The
    // default 'auto' falls through to the Responses path below (newest image
    // model + a previous_response_id edit chain).
    const imageModel = opts.imageModel;
    if (imageModel && imageModel !== 'auto' && /^gpt-image/.test(imageModel)) {
      const ib = { model: imageModel, prompt: opts.prompt || '', n: 1, moderation: opts.moderation || 'low' };
      if (opts.size && opts.size !== 'auto') ib.size = opts.size;
      if (opts.quality) ib.quality = opts.quality;
      const idata = await oaPost(IMAGES_GEN_URL, ib);
      const b64 = idata && Array.isArray(idata.data) && idata.data[0] && idata.data[0].b64_json;
      if (!b64) { const e = new Error('OpenAI returned no image (likely content policy)'); e._refused = true; throw e; }
      recordImage(imageModel, opts.feature || 'img', estimateImageUsd(opts.quality), opts.titleId);
      return { b64, respId: null };
    }
    const model = opts.model || DEFAULT_TEXT_MODEL;        // orchestration (text) model that drives the tool
    const tool = { type: 'image_generation', moderation: opts.moderation || 'low', output_format: opts.format || 'png' };
    if (opts.size) tool.size = opts.size;                  // '1024x1536' | '1024x1024' | '1536x1024' | 'auto'
    if (opts.quality) tool.quality = opts.quality;         // low | medium | high | auto
    const body = {
      model,
      input: 'Generate an image for this exact description. Do not add text or watermarks.\n\n' + (opts.prompt || ''),
      tools: [tool],
      store: true,                                          // keep server state so previous_response_id edits work
    };
    const data = await oaPost(RESPONSES_URL, body);
    // Cost tracked via the flat recordImage estimate below; orchestration tokens
    // are omitted here because the Responses usage can fold image-output tokens
    // into output_tokens and pricing those at text rates would double-count.
    const img = responseImage(data);
    if (!img.b64) {
      const e = new Error(img.refusal ? ('OpenAI refused: ' + img.refusal.slice(0, 200)) : 'OpenAI returned no image (likely content policy)');
      e._refused = true; e._respId = img.respId; throw e;
    }
    recordImage(model, opts.feature || 'img', estimateImageUsd(opts.quality), opts.titleId);
    return { b64: img.b64, respId: img.respId };
  }

  // Edit an existing image by chaining from its response id. The model sees the
  // prior image in context and applies the text instruction. Returns the NEW
  // { b64, respId } so edits keep chaining.
  async function editImage(opts) {
    await ready;
    if (!_key) throw new Error('No OpenAI API key — add one in Preferences → AI Features');
    if (!opts.prevRespId) { const e = new Error('no-resp-id'); e._noChain = true; throw e; }
    const model = opts.model || DEFAULT_TEXT_MODEL;
    const tool = { type: 'image_generation', action: 'edit', moderation: opts.moderation || 'low', output_format: opts.format || 'png' };
    if (opts.size) tool.size = opts.size;
    if (opts.quality) tool.quality = opts.quality;
    const body = {
      model,
      previous_response_id: opts.prevRespId,
      input: 'Edit the image you just generated: ' + (opts.instruction || ''),
      tools: [tool],
      store: true,
    };
    const data = await oaPost(RESPONSES_URL, body);
    // Cost tracked via the flat recordImage estimate below; orchestration tokens
    // are omitted here because the Responses usage can fold image-output tokens
    // into output_tokens and pricing those at text rates would double-count.
    const img = responseImage(data);
    if (!img.b64) {
      const e = new Error(img.refusal ? ('OpenAI refused: ' + img.refusal.slice(0, 200)) : 'OpenAI returned no image (likely content policy)');
      e._refused = true; if (img.status === 404 || /previous_response/i.test(img.refusal || '')) e._noChain = true; throw e;
    }
    recordImage(model, opts.feature || 'img-edit', estimateImageUsd(opts.quality), opts.titleId);
    return { b64: img.b64, respId: img.respId };
  }

  // Edit using the stored PNG bytes (reinstall-safe fallback when the response
  // id has expired). The prior image is passed inline as an input_image (base64
  // data URL), so we still avoid multipart and stay on the Responses API.
  async function editImageBytes(opts) {
    await ready;
    if (!_key) throw new Error('No OpenAI API key — add one in Preferences → AI Features');
    if (!opts.pngDataUri) { const e = new Error('no-bytes'); throw e; }
    const model = opts.model || DEFAULT_TEXT_MODEL;
    const tool = { type: 'image_generation', action: 'edit', moderation: opts.moderation || 'low', output_format: opts.format || 'png' };
    if (opts.size) tool.size = opts.size;
    if (opts.quality) tool.quality = opts.quality;
    const body = {
      model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Edit this image, keeping the same subject and style: ' + (opts.instruction || '') },
          { type: 'input_image', image_url: opts.pngDataUri },
        ],
      }],
      tools: [tool],
      store: true,
    };
    const data = await oaPost(RESPONSES_URL, body);
    // Cost tracked via the flat recordImage estimate below; orchestration tokens
    // are omitted here because the Responses usage can fold image-output tokens
    // into output_tokens and pricing those at text rates would double-count.
    const img = responseImage(data);
    if (!img.b64) {
      const e = new Error(img.refusal ? ('OpenAI refused: ' + img.refusal.slice(0, 200)) : 'OpenAI returned no image (likely content policy)');
      e._refused = true; throw e;
    }
    recordImage(model, opts.feature || 'img-edit', estimateImageUsd(opts.quality), opts.titleId);
    return { b64: img.b64, respId: img.respId };
  }

  // ---- public surface --------------------------------------------------------
  window.aiOpenai = {
    ready,
    hasKey() { return !!_key; },
    getKey() { return _key; },
    async setKey(k) { _key = (k || '').trim(); await setPref(KEY_PREF, _key); },
    chat,
    generateImage,
    editImage,
    editImageBytes,
    estimateImageUsd,
    monthSpendUsd,
    spendSinceUsd,
    costByTitle,
    DEFAULT_TEXT_MODEL,
  };
})();
