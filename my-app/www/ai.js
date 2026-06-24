// ai.js — Claude API core (AI plan slice 2, docs/ai-reading-companion-plan.md).
// Transport + accounting ONLY: BYOK key handling, one streaming request
// helper, and the token/cost ledger. Features live in ai-*.js modules.
//
// BYOK: the key is the user's own (Preferences → AI Features). It is sent
// only to api.anthropic.com and stored only in Capacitor Preferences /
// localStorage. The `anthropic-dangerous-direct-browser-access` header is
// Anthropic's supported opt-in for exactly this keyless-backend pattern.
(function () {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const KEY_PREF = 'AI_API_KEY';
  const ENABLED_PREF = 'AI_ENABLED';
  const LEDGER_KEY = 'AILEDGER_V1';     // blobStore; [{ts,model,feature,ti,to,cw,cr}]
  const LEDGER_MAX = 2000;

  // $/MTok (input, output). Cache write bills at in×1.25, cache read at in×0.1.
  // Local estimate only — actual billing is Anthropic's; surface as "~$".
  const PRICES = [
    { match: 'haiku',  inUsd: 1, outUsd: 5  },
    { match: 'opus',   inUsd: 5, outUsd: 25 },
    { match: 'sonnet', inUsd: 3, outUsd: 15 },
  ];
  const MODELS = {
    high:    'claude-opus-4-8',     // 高品質 tier (priceFor matches on 'opus')
    default: 'claude-sonnet-4-6',   // summaries, chat
    cheap:   'claude-haiku-4-5',    // segmentation, background extraction
  };
  const QUALITY_PREF = 'AI_QUALITY'; // economy | balanced | high
  const QUALITIES = ['economy', 'balanced', 'high'];
  const ACT_KEY = 'AIACT_V1';        // { [titleId]: { mode:'new'|'retro', ts } } — books the user activated AI for
  const COST_KEY = 'AICOST_V1';      // { titles: { [titleId]: usd }, total } — cumulative, never capped
  let _act = {};
  let _cost = { titles: {}, total: 0 };

  // ---- prefs (dual-write like the rest of the app) -------------------------
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins
    && window.Capacitor.Plugins.Preferences;

  async function getPref(k) {
    try {
      const p = CapPrefs();
      if (p) {
        const r = await p.get({ key: k });
        if (r && r.value !== null && r.value !== undefined) return r.value;
      }
    } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function setPref(k, v) {
    try { localStorage.setItem(k, v); } catch (_) {}
    try { const p = CapPrefs(); if (p) await p.set({ key: k, value: v }); } catch (_) {}
  }

  let _key = '';
  let _enabled = false;
  let _quality = 'balanced';
  const ready = (async () => {
    _key = (await getPref(KEY_PREF)) || '';
    _enabled = (await getPref(ENABLED_PREF)) === '1';
    const q = await getPref(QUALITY_PREF);
    if (QUALITIES.indexOf(q) >= 0) _quality = q;
    // ai-processor.js reads AI_AUTO_PROCESS synchronously from localStorage.
    // localStorage can be wiped while Capacitor Preferences survives — if the
    // local copy is gone, restore it from Preferences so the toggle sticks.
    try {
      if (localStorage.getItem('AI_AUTO_PROCESS') === null) {
        const p = CapPrefs();
        if (p) {
          const r = await p.get({ key: 'AI_AUTO_PROCESS' });
          if (r && r.value !== null && r.value !== undefined) {
            localStorage.setItem('AI_AUTO_PROCESS', r.value);
          }
        }
      }
    } catch (_) {}
    // Per-book activation cache (sync-queryable by the shell glow) + cost cache.
    try { _act = JSON.parse((await getPref(ACT_KEY)) || 'null') || {}; } catch (_) { _act = {}; }
    try { _cost = JSON.parse((await getPref(COST_KEY)) || 'null') || { titles: {}, total: 0 }; } catch (_) { _cost = { titles: {}, total: 0 }; }
    if (!_cost.titles) _cost = { titles: {}, total: 0 };
  })();

  function modelFor(task) {
    if (task === 'segment') return MODELS.cheap;
    if (_quality === 'economy') return MODELS.cheap;
    if (_quality === 'high') return MODELS.high;
    return MODELS.default;
  }

  // ---- ledger ---------------------------------------------------------------
  let _ledger = null;        // in-memory cache; single writer (this module)

  async function loadLedger() {
    if (_ledger) return _ledger;
    try {
      const raw = window.blobStore ? await window.blobStore.get(LEDGER_KEY) : null;
      const p = raw ? JSON.parse(raw) : null;
      _ledger = (p && Array.isArray(p.entries)) ? p : { v: 1, entries: [] };
    } catch (_) { _ledger = { v: 1, entries: [] }; }
    return _ledger;
  }
  async function recordUsage(model, feature, u, titleId) {
    try {
      const led = await loadLedger();
      led.entries.push({
        ts: Date.now(), model, feature, tid: titleId || null,
        ti: u.input_tokens || 0, to: u.output_tokens || 0,
        cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
      });
      if (led.entries.length > LEDGER_MAX) led.entries.splice(0, led.entries.length - LEDGER_MAX);
      if (window.blobStore) window.blobStore.set(LEDGER_KEY, JSON.stringify(led)).catch(() => {});
    } catch (_) {}
  }
  function priceFor(model) {
    const m = String(model || '').toLowerCase();
    for (const p of PRICES) if (m.includes(p.match)) return p;
    return PRICES[2]; // sonnet pricing as the neutral default
  }
  function entryCostUsd(e) {
    const p = priceFor(e.model);
    return (e.ti * p.inUsd + e.cw * p.inUsd * 1.25 + e.cr * p.inUsd * 0.1) / 1e6
         + (e.to * p.outUsd) / 1e6;
  }
  // Pre-flight estimate for confirms/hints (Japanese ≈ 1.2 tok/char).
  function estimateCostUsd(model, inChars, outTokens) {
    const p = priceFor(model || MODELS.default);
    return ((inChars || 0) * 1.2 * p.inUsd + (outTokens || 0) * p.outUsd) / 1e6;
  }
  async function monthSpendUsd() {
    const led = await loadLedger();
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    let sum = 0;
    for (const e of led.entries) {
      const d = new Date(e.ts);
      if (d.getFullYear() === y && d.getMonth() === m) sum += entryCostUsd(e);
    }
    return sum;
  }

  // ---- notify bus (red dots) -------------------------------------------------
  // AISEEN_V1: { [titleId]: {timelineRev, charsRev, seenTimelineRev, seenCharsRev} }.
  // Producers bump a rev via emitDataChanged; surfaces clear via markSeen; shell
  // reads unseen(). The 'kai:ai-data' CustomEvent fires on both so dots update live.
  const SEEN_KEY = 'AISEEN_V1';
  let _seen = null;

  async function loadSeen() {
    if (_seen) return _seen;
    try {
      const raw = window.blobStore ? await window.blobStore.get(SEEN_KEY) : null;
      const p = raw ? JSON.parse(raw) : null;
      _seen = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
    } catch (_) { _seen = {}; }
    return _seen;
  }
  function saveSeen() {
    try {
      if (window.blobStore) window.blobStore.set(SEEN_KEY, JSON.stringify(_seen)).catch(() => {});
    } catch (_) {}
  }
  function fireSeenEvent(titleId, kind) {
    try {
      window.dispatchEvent(new CustomEvent('kai:ai-data', { detail: { titleId, kind } }));
    } catch (_) {}
  }
  async function emitDataChanged(titleId, kind) {
    try {
      if (!titleId || (kind !== 'timeline' && kind !== 'characters')) return;
      const s = await loadSeen();
      const rec = s[titleId] || (s[titleId] = {
        timelineRev: 0, charsRev: 0, seenTimelineRev: 0, seenCharsRev: 0,
      });
      if (kind === 'timeline') rec.timelineRev = (rec.timelineRev || 0) + 1;
      else rec.charsRev = (rec.charsRev || 0) + 1;
      saveSeen();
      fireSeenEvent(titleId, kind);
    } catch (_) {}
  }
  // Returns COUNTS of unseen updates (rev − seenRev), truthy when > 0 so the
  // existing boolean callers still work. Each processed chapter bumps timeline+
  // characters once, so the count ≈ "new entries since you last looked".
  async function unseen(titleId) {
    try {
      const s = await loadSeen();
      const rec = titleId ? s[titleId] : null;
      if (!rec) return { timeline: 0, characters: 0 };
      return {
        timeline: Math.max(0, (rec.timelineRev || 0) - (rec.seenTimelineRev || 0)),
        characters: Math.max(0, (rec.charsRev || 0) - (rec.seenCharsRev || 0)),
      };
    } catch (_) { return { timeline: 0, characters: 0 }; }
  }

  // ---- per-book activation ---------------------------------------------------
  // AI processes a title ONLY after the user activates it (opt-in per book, so
  // they can open + scroll first). Sync-queryable from the boot-loaded cache.
  function activatedSync(titleId) {
    try { return !!(titleId && _act && _act[titleId]); } catch (_) { return false; }
  }
  function activationInfo(titleId) {
    try { return (titleId && _act && _act[titleId]) ? Object.assign({ activated: true }, _act[titleId]) : { activated: false }; }
    catch (_) { return { activated: false }; }
  }
  async function setActivated(titleId, mode) {
    try {
      if (!titleId) return;
      _act[titleId] = { mode: (mode === 'retro' ? 'retro' : 'new'), ts: Date.now() };
      await setPref(ACT_KEY, JSON.stringify(_act));
      try { window.dispatchEvent(new CustomEvent('kai:ai-activated', { detail: { titleId, mode } })); } catch (_) {}
    } catch (_) {}
  }
  async function deactivate(titleId) {
    try {
      if (!titleId || !_act[titleId]) return;
      delete _act[titleId];
      await setPref(ACT_KEY, JSON.stringify(_act));
      try { window.dispatchEvent(new CustomEvent('kai:ai-activated', { detail: { titleId, mode: null } })); } catch (_) {}
    } catch (_) {}
  }

  // ---- per-title cumulative cost (never capped, unlike the ledger) -----------
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
  async function markSeen(titleId, kind) {
    try {
      if (!titleId) return;
      const s = await loadSeen();
      const rec = s[titleId];
      if (!rec) return;
      // Already current → no-op. Saving/dispatching here fed the open surface's
      // 'kai:ai-data' listener, which refreshed and called markSeen again — loop.
      if (kind === 'timeline') {
        if ((rec.seenTimelineRev || 0) >= (rec.timelineRev || 0)) return;
        rec.seenTimelineRev = rec.timelineRev || 0;
      } else if (kind === 'characters') {
        if ((rec.seenCharsRev || 0) >= (rec.charsRev || 0)) return;
        rec.seenCharsRev = rec.charsRev || 0;
      } else {
        return;
      }
      saveSeen();
      fireSeenEvent(titleId, kind);
    } catch (_) {}
  }

  // ---- request --------------------------------------------------------------
  function platform() {
    try { return (window.Capacitor && window.Capacitor.getPlatform) ? window.Capacitor.getPlatform() : 'web'; }
    catch (_) { return 'web'; }
  }
  function nativeHttp() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  }

  // Non-streaming call through the native HTTP bridge. iOS primary path:
  // WKWebView's fetch stalled on the cross-origin SSE stream on device
  // (stuck at "…", no error), and native URLSession also sidesteps CORS.
  // The response arrives whole; onText fires once with the full text.
  async function requestNative(opts, body) {
    const http = nativeHttp();
    body = Object.assign({}, body, { stream: false });
    let resp;
    try {
      resp = await http.request({
        url: API_URL, method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': _key,
          'anthropic-version': '2023-06-01',
        },
        data: body,
        connectTimeout: 30000,
        readTimeout: 180000,
      });
    } catch (e) {
      throw new Error('Network error — check your connection');
    }
    const data = (typeof resp.data === 'string')
      ? (() => { try { return JSON.parse(resp.data); } catch (_) { return null; } })()
      : resp.data;
    if (resp.status !== 200) {
      let msg = 'API error ' + resp.status;
      if (data && data.error && data.error.message) msg = data.error.message;
      if (resp.status === 401) msg = 'Invalid API key (401) — check Preferences → AI Features';
      if (resp.status === 429) msg = 'Rate limited (429) — wait a moment and retry';
      const err = new Error(msg);
      err._status = resp.status;
      try {
        const h = resp.headers || {};
        const ra = parseFloat(h['retry-after'] || h['Retry-After']);
        if (isFinite(ra) && ra > 0) err._retryAfterMs = ra * 1000;
      } catch (_) {}
      throw err;
    }
    if (!data || !Array.isArray(data.content)) throw new Error('Unexpected API response');
    if (data.stop_reason === 'refusal') throw new Error('The model declined this request');
    const text = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    const u = data.usage || {};
    const usage = {
      input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
    };
    if (text && opts.onText) { try { opts.onText(text); } catch (_) {} }
    return { text, usage };
  }

  // Streaming Messages call. opts: { feature, model?, system?, messages,
  // maxTokens?, onText?(delta), outputSchema? }. Resolves { text, usage,
  // costUsd, model }. Throws Error with a user-presentable message.
  async function request(opts) {
    await ready;
    if (!_key) throw new Error('No API key — add one in Preferences → AI Features');
    const model = opts.model || MODELS.default;
    const body = {
      model,
      max_tokens: opts.maxTokens || 1500,
      stream: true,
      messages: opts.messages,
    };
    if (opts.system) body.system = opts.system;
    // Structured outputs: constrain the response to a JSON schema (used by
    // the background character pipeline so results parse deterministically).
    if (opts.outputSchema) {
      body.output_config = { format: { type: 'json_schema', schema: opts.outputSchema } };
    }

    // Stream-first on every platform. If the stream produces NOTHING within
    // the first-byte watchdog (WKWebView/VPN stalls) — or dies before any
    // output — retry once through the native HTTP bridge (no CORS, reliable,
    // non-streaming). Streaming UX when the network allows, working summary
    // when it doesn't.
    const sendOnce = async () => {
      try {
        return await requestStream(opts, body);
      } catch (e) {
        if (nativeHttp() && e && e._noOutput) return await requestNative(opts, body);
        throw e;
      }
    };

    // Background callers (opts.retryable) ride out transient 429/529
    // overloads: honor Retry-After when present else 60s, max 2 retries.
    // Interactive callers stay fail-fast; user-facing messages unchanged.
    let out;
    for (let attempt = 0; ; attempt++) {
      try { out = await sendOnce(); break; }
      catch (e) {
        const overloaded = e && (e._status === 429 || e._status === 529 ||
          /overloaded/i.test(e.message || ''));
        if (!opts.retryable || !overloaded || attempt >= 2) throw e;
        const waitMs = (e._retryAfterMs > 0 && e._retryAfterMs <= 10 * 60 * 1000)
          ? e._retryAfterMs : 60 * 1000;
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    const titleId = opts.titleId || window._activeTitleId || null;
    recordUsage(model, opts.feature || 'misc', out.usage, titleId);
    const costUsd = entryCostUsd({ model, ti: out.usage.input_tokens, to: out.usage.output_tokens,
                                   cw: out.usage.cache_creation_input_tokens,
                                   cr: out.usage.cache_read_input_tokens });
    addCost(titleId, costUsd);
    return { text: out.text, usage: out.usage, costUsd, model };
  }

  async function requestStream(opts, body) {
    const ctrl = new AbortController();
    let gotAny = false;
    const timeout = setTimeout(() => ctrl.abort(), 120 * 1000);
    // First-byte watchdog: a stalled stream (observed on iOS under VPN)
    // aborts after 15s so the native fallback can take over quickly.
    const firstByte = setTimeout(() => { if (!gotAny) ctrl.abort(); }, 15 * 1000);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': _key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      clearTimeout(timeout);
      clearTimeout(firstByte);
      const err = new Error('Network error — check your connection');
      err._noOutput = true;   // nothing reached the caller → native retry is safe
      throw err;
    }
    if (!res.ok) {
      clearTimeout(timeout);
      clearTimeout(firstByte);
      let msg = 'API error ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (_) {}
      if (res.status === 401) msg = 'Invalid API key (401) — check Preferences → AI Features';
      if (res.status === 429) msg = 'Rate limited (429) — wait a moment and retry';
      const err = new Error(msg);
      err._status = res.status;
      try {
        const ra = parseFloat(res.headers.get('retry-after'));
        if (isFinite(ra) && ra > 0) err._retryAfterMs = ra * 1000;
      } catch (_) {}
      throw err;
    }

    // SSE parse. usage arrives split: input/cache counts on message_start,
    // output tokens on message_delta.
    const usage = { input_tokens: 0, output_tokens: 0,
                    cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let text = '';
    let stopReason = null;
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
      if (!ev || !ev.type) return;
      if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        const u = ev.message.usage;
        usage.input_tokens = u.input_tokens || 0;
        usage.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
        usage.cache_read_input_tokens = u.cache_read_input_tokens || 0;
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        text += ev.delta.text;
        if (opts.onText) { try { opts.onText(ev.delta.text); } catch (_) {} }
      } else if (ev.type === 'message_delta') {
        if (ev.usage && ev.usage.output_tokens) usage.output_tokens = ev.usage.output_tokens;
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === 'error') {
        const er = new Error((ev.error && ev.error.message) || 'stream error');
        if (ev.error && ev.error.type === 'overloaded_error') er._status = 529;
        throw er;
      }
    };

    try {
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          gotAny = true;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            handleLine(buf.slice(0, nl).trim());
            buf = buf.slice(nl + 1);
          }
        }
        if (buf.trim()) handleLine(buf.trim());
      } else {
        // Older WebView without fetch streaming: parse the full SSE body at once.
        const all = await res.text();
        gotAny = true;
        for (const line of all.split('\n')) handleLine(line.trim());
      }
    } catch (e) {
      if (!gotAny) {
        // Watchdog abort or pre-output failure — nothing was delivered, the
        // caller may safely retry on the native bridge.
        const err = new Error('Network error — check your connection');
        err._noOutput = true;
        throw err;
      }
      const err2 = new Error('Connection interrupted — please retry');
      if (e && e._status) err2._status = e._status;
      throw err2;
    } finally {
      clearTimeout(timeout);
      clearTimeout(firstByte);
    }

    if (stopReason === 'refusal') throw new Error('The model declined this request');
    return { text, usage };
  }

  // Glow styling shared by the AI entry points (shell menu item, Bookmarks
  // rows). Injected here so every ai-* module can use the classes.
  try {
    const st = document.createElement('style');
    st.textContent =
      '@keyframes kaiPulse{0%,100%{box-shadow:0 0 6px rgba(150,130,255,.30),0 0 14px rgba(150,130,255,.10);}' +
      '50%{box-shadow:0 0 12px rgba(165,145,255,.55),0 0 26px rgba(165,145,255,.20);}}' +
      '.kai-glow{animation:kaiPulse 2.8s ease-in-out infinite;}' +
      '.kai-glow-text{text-shadow:0 0 8px rgba(175,155,255,.75);}' +
      '@keyframes kaiDot{0%,80%,100%{opacity:.18;}40%{opacity:.9;}}' +
      '.kai-dots span{animation:kaiDot 1.2s ease-in-out infinite;font-size:1.6em;}' +
      '.kai-dots span:nth-child(2){animation-delay:.18s;}' +
      '.kai-dots span:nth-child(3){animation-delay:.36s;}';
    document.head.appendChild(st);
  } catch (_) {}

  // ---- public surface --------------------------------------------------------
  window.ai = {
    ready,
    MODELS,
    isEnabled() { return _enabled && !!_key; },
    hasKey() { return !!_key; },
    getKey() { return _key; },
    enabledFlag() { return _enabled; },
    async setKey(k) { _key = (k || '').trim(); await setPref(KEY_PREF, _key); },
    async setEnabled(b) { _enabled = !!b; await setPref(ENABLED_PREF, b ? '1' : '0'); },
    getQuality() { return _quality; },
    async setQuality(q) {
      if (QUALITIES.indexOf(q) < 0) q = 'balanced';
      _quality = q;
      await setPref(QUALITY_PREF, q);
    },
    modelFor,
    estimateCostUsd,
    emitDataChanged,
    unseen,
    markSeen,
    request,
    monthSpendUsd,
    activatedSync,
    activationInfo,
    setActivated,
    deactivate,
    costByTitle,
  };
})();
