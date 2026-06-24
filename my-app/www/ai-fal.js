// ai-fal.js — fal.ai image backend client (window.aiFal).
//
// A third image backend beside the LOCAL server (ai-images.js) and OpenAI-direct
// (ai-openai.js). fal.ai proxies many text-to-image models — FLUX, Ideogram, and
// even OpenAI's gpt-image-* — behind ONE API key with NO identity verification
// (unlike calling OpenAI directly). The user picks the model; a fallback model
// auto-retries when the primary refuses (e.g. gpt-image-2's content filter →
// fall back to uncensored FLUX).
//
// BYOK: the user's own fal key (Preferences → AI Image). Sent only to fal.run,
// stored only in Capacitor Preferences / localStorage. All HTTP goes through the
// native CapacitorHttp plugin (fal needs no CORS exception but this matches the
// rest of the app and avoids any WebView fetch quirks). The PROMPT for character
// images is built by the Claude art-director (window.ai) in the cloud adapter;
// scene prompts arrive pre-built — fal only renders.
(function () {
  'use strict';

  const QUEUE_URL = 'https://queue.fal.run/'; // queue API: submit → poll status → fetch result (image models are async)
  const KEY_PREF = 'FAL_API_KEY';
  const LEDGER_KEY = 'FALLEDGER_V1';         // blobStore; [{ts,model,feature,tid,usd}]
  const LEDGER_MAX = 2000;
  const COST_KEY = 'FALCOST_V1';             // { titles:{}, total } cumulative

  // Per-model size/aspect param (fal validates strictly, so the param NAME differs by
  // model family: flux-pro-ultra uses aspect_ratio; flux dev/ideogram use image_size
  // enums; gpt-image uses explicit pixel sizes). Defaults to square.
  function aspectParams(model, aspect) {
    aspect = aspect || 'square';
    const m = String(model || '').toLowerCase();
    if (m.includes('flux') && m.includes('ultra')) return { aspect_ratio: aspect === 'portrait' ? '3:4' : aspect === 'landscape' ? '4:3' : '1:1' };
    if (m.includes('gpt-image')) return { image_size: aspect === 'portrait' ? '1024x1536' : aspect === 'landscape' ? '1536x1024' : '1024x1024' };
    return { image_size: aspect === 'portrait' ? 'portrait_4_3' : aspect === 'landscape' ? 'landscape_4_3' : 'square_hd' };
  }
  // Flat per-image estimate by model family (token/credit-derived; surfaced as "~$").
  function estimateUsd(model) {
    const m = String(model || '').toLowerCase();
    if (m.includes('gpt-image')) return 0.07;
    if (m.includes('ideogram')) return 0.08;
    if (m.includes('flux-2-max')) return 0.10;
    if (m.includes('flux-2')) return 0.06;
    if (m.includes('flux') && m.includes('ultra')) return 0.06;
    if (m.includes('flux')) return 0.035;
    return 0.05;
  }

  let _cost = { titles: {}, total: 0 };

  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  async function getPref(k) {
    try { const p = CapPrefs(); if (p) { const r = await p.get({ key: k }); if (r && r.value != null) return r.value; } } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function setPref(k, v) {
    try { localStorage.setItem(k, v); } catch (_) {}
    try { const p = CapPrefs(); if (p) await p.set({ key: k, value: v }); } catch (_) {}
  }
  function dbg() { try { return localStorage.getItem('KADOKI_DEBUG') === '1'; } catch (_) { return false; } }
  function slog() { if (!dbg()) return; try { console.log.apply(console, ['[aiFal]'].concat([].slice.call(arguments))); } catch (_) {} }

  let _key = '';
  const ready = (async () => {
    _key = (await getPref(KEY_PREF)) || '';
    try { _cost = JSON.parse((await getPref(COST_KEY)) || 'null') || { titles: {}, total: 0 }; } catch (_) { _cost = { titles: {}, total: 0 }; }
    if (!_cost || !_cost.titles) _cost = { titles: {}, total: 0 };
  })();

  // ---- ledger ----
  let _ledger = null;
  async function loadLedger() {
    if (_ledger) return _ledger;
    try { const raw = window.blobStore ? await window.blobStore.get(LEDGER_KEY) : null; const p = raw ? JSON.parse(raw) : null; _ledger = (p && Array.isArray(p.entries)) ? p : { v: 1, entries: [] }; }
    catch (_) { _ledger = { v: 1, entries: [] }; }
    return _ledger;
  }
  function recordImage(model, feature, usd, titleId) {
    loadLedger().then((led) => {
      led.entries.push({ ts: Date.now(), model, feature: feature || 'img', tid: titleId || null, usd: usd || 0 });
      if (led.entries.length > LEDGER_MAX) led.entries.splice(0, led.entries.length - LEDGER_MAX);
      try { if (window.blobStore) window.blobStore.set(LEDGER_KEY, JSON.stringify(led)).catch(() => {}); } catch (_) {}
    }).catch(() => {});
    addCost(titleId, usd || 0);
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
  async function monthSpendUsd() {
    const led = await loadLedger();
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    let s = 0; for (const e of led.entries) { const d = new Date(e.ts); if (d.getFullYear() === y && d.getMonth() === m) s += (e.usd || 0); }
    return s;
  }
  async function spendSinceUsd(sinceTs) { const led = await loadLedger(); let s = 0; for (const e of led.entries) if ((e.ts || 0) >= sinceTs) s += (e.usd || 0); return s; }
  function costByTitle() {
    try { const titles = Object.keys((_cost && _cost.titles) || {}).map(id => ({ titleId: id, usd: _cost.titles[id] })).sort((a, b) => b.usd - a.usd); return { titles, total: (_cost && _cost.total) || 0 }; }
    catch (_) { return { titles: [], total: 0 }; }
  }

  // ---- transport ----
  function nativeHttp() { try { return window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp || null; } catch (_) { return null; } }
  // One fal HTTP call; resolves parsed JSON or throws a typed error
  // (._status, ._refused on content moderation, ._terminal on a 4xx config error).
  async function falJson(method, url, body) {
    const H = nativeHttp();
    let resp;
    try {
      if (H) {
        const req = { url, method, headers: { 'Authorization': 'Key ' + _key }, connectTimeout: 30000, readTimeout: 120000 };
        if (body != null) { req.headers['Content-Type'] = 'application/json'; req.data = body; }
        resp = await H.request(req);
      } else {
        const init = { method, headers: { 'Authorization': 'Key ' + _key } };
        if (body != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        const r = await fetch(url, init); resp = { status: r.status, data: await r.json().catch(() => null) };
      }
    } catch (e) { throw new Error('Network error — check your connection'); }
    const data = (typeof resp.data === 'string') ? (() => { try { return JSON.parse(resp.data); } catch (_) { return resp.data; } })() : resp.data;
    if (resp.status < 200 || resp.status >= 300) {
      const detail = (data && (data.detail || data.error || data.message)) || '';
      const msg = (typeof detail === 'string' ? detail : JSON.stringify(detail)) || ('fal error ' + resp.status);
      const err = new Error('fal: ' + msg);
      err._status = resp.status;
      const lc = msg.toLowerCase();
      if (resp.status === 401 || resp.status === 403) err.message = 'fal: invalid key or no access (Preferences → AI Image). Key is key_id:key_secret.';
      else if (/moderation|content[_ ]?policy|safety|not allowed|violat|blocked|nsfw|prohibited|flagged/.test(lc)) err._refused = true;
      else if (resp.status === 422 || resp.status === 400) err._terminal = true;   // bad params for this model
      throw err;
    }
    return data;
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Submit to the fal QUEUE, poll status until COMPLETED, then fetch the result.
  async function runModel(model, body) {
    try { if (window._kaiImgProgress) window._kaiImgProgress('falに送信中…'); } catch (_) {}
    const base = QUEUE_URL + String(model).replace(/^\/+/, '');
    const sub = await falJson('POST', base, body);
    if (sub && (Array.isArray(sub.images) || sub.image)) return sub;   // some endpoints answer inline
    const statusUrl = sub && (sub.status_url || (sub.request_id ? (base + '/requests/' + sub.request_id + '/status') : null));
    const responseUrl = sub && (sub.response_url || (sub.request_id ? (base + '/requests/' + sub.request_id) : null));
    if (!statusUrl || !responseUrl) throw new Error('fal: unexpected submit response');
    const start = Date.now();
    for (;;) {
      try { if (window._kaiImgProgress) window._kaiImgProgress('画像を生成中… ' + Math.round((Date.now() - start) / 1000) + '秒'); } catch (_) {}
      let st = null;
      try { st = await falJson('GET', statusUrl, null); }
      catch (e) { if (e && e._status === 404) { await sleep(1600); if (Date.now() - start > 150000) break; continue; } throw e; }   // status not ready yet
      const status = String((st && st.status) || '').toUpperCase();
      if (status === 'COMPLETED' || status === 'OK') break;
      if (status === 'FAILED' || status === 'ERROR') {
        const blob = JSON.stringify(st || {}); const e = new Error('fal: ' + (st && st.error ? (typeof st.error === 'string' ? st.error : JSON.stringify(st.error)) : 'render failed'));
        if (/moderation|content|safety|blocked|nsfw|policy|flagged|violat/i.test(blob)) e._refused = true;
        throw e;
      }
      if (Date.now() - start > 150000) throw new Error('fal: timed out waiting for the image');
      await sleep(1600);
    }
    return await falJson('GET', responseUrl, null);
  }
  async function fetchUrlB64(url) {
    const H = nativeHttp();
    if (H) { const res = await H.request({ url, method: 'GET', responseType: 'blob', connectTimeout: 30000, readTimeout: 60000 }); return (typeof res.data === 'string') ? res.data : ''; }
    const r = await fetch(url); const blob = await r.blob();
    return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
  }

  function pickImage(data) {
    const arr = data && (Array.isArray(data.images) ? data.images : (data.image ? [data.image] : null));
    const im = arr && arr[0];
    return im && (im.url || im.image_url) ? { url: im.url || im.image_url, mime: im.content_type || 'image/png' } : null;
  }
  // fal/FLUX occasionally returns an all-black frame; detect a near-pure-black image
  // (downscale + check the brightest pixel) so generate() can retry once. A genuinely
  // dark night scene still has bright spots (a moon/lamp), so its max stays high.
  function isLikelyBlank(dataUrl) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const w = 24, h = 24;
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
            const d = ctx.getImageData(0, 0, w, h).data;
            let maxv = 0;
            for (let i = 0; i < d.length; i += 4) { if (d[i] > maxv) maxv = d[i]; if (d[i + 1] > maxv) maxv = d[i + 1]; if (d[i + 2] > maxv) maxv = d[i + 2]; if (maxv > 12) break; }
            resolve(maxv <= 12);   // brightest pixel ~black everywhere → blank render
          } catch (_) { resolve(false); }
        };
        img.onerror = () => resolve(false);
        img.src = dataUrl;
      } catch (_) { resolve(false); }
    });
  }

  // Render ONE image from a finished prompt. Tries `model`; on a content refusal
  // retries `fallbackModel` (if set + different). Returns { b64 (data URL), modelUsed, respId:null }.
  async function generate(opts) {
    await ready;
    if (!_key) throw new Error('No fal API key — add one in Preferences → AI Image');
    const tryModel = async (model) => {
      const body = Object.assign({ prompt: opts.prompt || '', num_images: 1 }, aspectParams(model, opts.aspect));
      for (let attempt = 0; attempt < 2; attempt++) {
        const data = await runModel(model, body);
        const img = pickImage(data);
        if (!img) {   // completed with no image ≈ filtered/blocked
          const e = new Error('fal returned no image' + (data && data.detail ? (' — ' + String(data.detail).slice(0, 160)) : ' (likely content filter)'));
          e._refused = true; throw e;
        }
        const raw = await fetchUrlB64(img.url);
        if (!raw || raw.length < 64) { const e = new Error('fal image fetch failed'); throw e; }
        const dataUrl = 'data:' + img.mime + ';base64,' + raw;
        if (attempt === 0 && await isLikelyBlank(dataUrl)) { slog('blank/black render — retrying once'); continue; }   // fal black-frame glitch → one retry
        recordImage(model, opts.feature || 'img', estimateUsd(model), opts.titleId);
        return { b64: dataUrl, modelUsed: model, respId: null };
      }
    };
    try {
      return await tryModel(opts.model);
    } catch (e) {
      const fb = opts.fallbackModel;
      if (e && e._refused && fb && fb !== opts.model && fb !== 'none') {
        slog('primary refused; falling back to', fb);
        try { return await tryModel(fb); }
        catch (e2) { if (e2 && e2._refused) { e2._refused = true; } throw e2; }
      }
      throw e;
    }
  }

  window.aiFal = {
    ready,
    hasKey() { return !!_key; },
    getKey() { return _key; },
    async setKey(k) { _key = (k || '').trim(); await setPref(KEY_PREF, _key); },
    generate,
    estimateUsd,
    monthSpendUsd,
    spendSinceUsd,
    costByTitle,
  };
})();
