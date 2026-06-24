// ai-images.js — local image-generation client (window.aiImages).
//
// Talks to the user's LOCAL image server (Mac, see APP_HANDOFF.md): a durable
// async job queue that turns a Japanese character card → (local Qwen) an
// English prompt → (local FLUX) a portrait. Fully local, no cloud, no content
// filtering — so dark/mature LITERARY scenes render without the false refusals
// hosted APIs throw.
//
// Shape (mirrors the handoff contract):
//   • OUTBOX (persisted, device-side): one entry per queued character render.
//     Submitted to the server with a stable `meta` so results route back here
//     without server help. Sync is idempotent (an entry with a serverJobId is
//     never re-submitted).
//   • The server auto-deletes finished jobs after 3 DAYS, so on ingest we pull
//     every scene's PNG into local blobStore immediately (the only durable
//     copy) and DELETE the job server-side — keep/reject then run fully local.
//   • Per character: a REVIEW list (downloaded, undecided) and a KEPT list
//     (user approved, optionally cropped). Cards show KEPT images with arrows.
//
// All HTTP goes through the native CapacitorHttp plugin (not patched fetch), so
// it bypasses the WebView's CORS / mixed-content (cleartext LAN) entirely and
// leaves ai.js's streaming fetch untouched. Android cleartext + iOS ATS/local-
// network are opened in the native config for the LAN host.
(function () {
  'use strict';

  // ---- config (localStorage + Capacitor Preferences mirror, like AI_AUTO_PROCESS) --
  const URL_KEY = 'AIIMG_SERVER_URL';
  const MODEL_KEY = 'AIIMG_MODEL';
  const STYLE_KEY = 'AIIMG_STYLE';
  const SCENES_KEY = 'AIIMG_SCENES';
  const SIZE_KEY = 'AIIMG_SIZE';
  const DEFAULTS = {
    url: '',   // local image server is disabled for release; user enters their own LAN URL if re-enabled
    model: 'klein9b', style: 'photoreal', scenes: 1, size: '896x1152',
  };
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return (v === null || v === '') ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (_) {}
    try { window.Capacitor?.Plugins?.Preferences?.set({ key: k, value: String(v) }); } catch (_) {}
  }
  function serverUrl() { return String(lsGet(URL_KEY, DEFAULTS.url) || DEFAULTS.url).replace(/\/+$/, ''); }
  function defModel() { return lsGet(MODEL_KEY, DEFAULTS.model); }
  function defStyle() { return lsGet(STYLE_KEY, DEFAULTS.style); }
  function defScenes() { const n = parseInt(lsGet(SCENES_KEY, DEFAULTS.scenes), 10); return (n >= 1 && n <= 3) ? n : 1; }
  function defSize() { return lsGet(SIZE_KEY, DEFAULTS.size); }

  // ---- backend selection (local image server | OpenAI/ChatGPT cloud) --------
  // The OpenAI path renders synchronously through window.aiImageOpenai (which
  // uses window.aiOpenai) instead of the /jobs server. Default 'local' so the
  // existing workflow is untouched until the user opts in (Preferences → AI Image).
  const BACKEND_KEY = 'AIIMG_BACKEND';        // 'local' | 'openai' | 'fal'
  const OAI_IMGMODEL_KEY = 'AIIMG_OAI_IMGMODEL'; // 'auto' (newest, via Responses chain) | 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini'
  const OAI_MODEL_KEY = 'AIIMG_OAI_MODEL';    // orchestration/text model that drives the image_generation tool (advanced)
  const OAI_QUALITY_KEY = 'AIIMG_OAI_QUALITY';// low | medium | high
  const OAI_SIZE_KEY = 'AIIMG_OAI_SIZE';      // 1024x1536 | 1024x1024 | 1536x1024 | auto  (gpt-image valid sizes)
  const FAL_MODEL_KEY = 'AIIMG_FAL_MODEL';    // a fal endpoint id, or 'custom'
  const FAL_MODEL_CUSTOM_KEY = 'AIIMG_FAL_MODEL_CUSTOM'; // free-text fal endpoint id (used when model === 'custom')
  const FAL_FALLBACK_KEY = 'AIIMG_FAL_FALLBACK'; // fal endpoint id used when the primary refuses, or 'none'
  const FAL_ASPECT_KEY = 'AIIMG_FAL_ASPECT'; // square | portrait | landscape
  const DAILY_BUDGET_KEY = 'AIIMG_DAILY_BUDGET'; // images/day for the semi-random scheduler (0 = off)
  const DAILY_USD_KEY = 'AIIMG_DAILY_USD';    // $ safety cap/day for the scheduler
  const OAI_DEFAULTS = { imgModel: 'auto', model: 'gpt-4.1', quality: 'medium', size: '1024x1536', dailyBudget: 0, dailyUsd: 1 };
  const FAL_DEFAULTS = { model: 'fal-ai/flux-pro/v1.1-ultra', fallback: 'fal-ai/flux/dev', aspect: 'square' };   // FLUX default: fast + uncensored (gpt-image-2 was slow + filtered)
  // Release: ChatGPT/OpenAI backend is removed and the local server is shipped-disabled,
  // so fal.ai is the default. A saved 'local' is still honored (the code path is kept for
  // re-enabling); anything else (incl. a stale 'openai') resolves to 'fal'.
  function backend() { const b = lsGet(BACKEND_KEY, 'fal'); return (b === 'local' || b === 'fal') ? b : 'fal'; }
  function oaImgModel() { return lsGet(OAI_IMGMODEL_KEY, OAI_DEFAULTS.imgModel) || OAI_DEFAULTS.imgModel; }
  function oaModel() { return lsGet(OAI_MODEL_KEY, OAI_DEFAULTS.model) || OAI_DEFAULTS.model; }
  function oaQuality() { return lsGet(OAI_QUALITY_KEY, OAI_DEFAULTS.quality) || OAI_DEFAULTS.quality; }
  function oaSize() { return lsGet(OAI_SIZE_KEY, OAI_DEFAULTS.size) || OAI_DEFAULTS.size; }
  function falModelSel() { return lsGet(FAL_MODEL_KEY, FAL_DEFAULTS.model) || FAL_DEFAULTS.model; }   // raw select value
  function falModel() { const s = falModelSel(); if (s === 'custom') { const c = (lsGet(FAL_MODEL_CUSTOM_KEY, '') || '').trim(); return c || FAL_DEFAULTS.model; } return s; }
  function falFallback() { return lsGet(FAL_FALLBACK_KEY, FAL_DEFAULTS.fallback) || 'none'; }
  function falAspect() { return lsGet(FAL_ASPECT_KEY, FAL_DEFAULTS.aspect) || 'square'; }
  function dailyBudget() { const n = parseInt(lsGet(DAILY_BUDGET_KEY, OAI_DEFAULTS.dailyBudget), 10); return (Number.isFinite(n) && n > 0) ? n : 0; }
  function dailyUsd() { const n = parseFloat(lsGet(DAILY_USD_KEY, OAI_DEFAULTS.dailyUsd)); return (Number.isFinite(n) && n >= 0) ? n : OAI_DEFAULTS.dailyUsd; }
  // Build the cloud render context for the adapter: a pluggable {chat, render}
  // client per backend (style is shared with the local path). OpenAI uses its own
  // chat for the art-director; fal uses Claude (window.ai) to build the prompt then
  // fal to render. Pre-built scene prompts skip chat() entirely (see renderEntry).
  function cloudContext(kind) {
    const cfg = { style: defStyle() };
    let client;
    if (kind === 'fal') {
      cfg.modelLabel = falModel();
      client = {
        chat: (o) => (window.ai && window.ai.request)
          ? window.ai.request({ system: o.system, messages: [{ role: 'user', content: o.user }], maxTokens: o.maxTokens, feature: o.feature || 'img-prompt', titleId: o.titleId }).then(r => (r && r.text) || '')
          : Promise.reject(new Error(window.i18n.t('im.err_claude_prompt_key', 'Claude API key required (image prompt generation)'))),
        render: (o) => window.aiFal.generate({ model: falModel(), fallbackModel: falFallback(), aspect: falAspect(), prompt: o.prompt, titleId: o.titleId, feature: o.feature }),
      };
    } else {   // 'openai'
      cfg.modelLabel = (oaImgModel() === 'auto') ? oaModel() : oaImgModel();
      client = {
        chat: (o) => window.aiOpenai.chat(Object.assign({ model: oaModel() }, o)),
        render: (o) => window.aiOpenai.generateImage(Object.assign({ model: oaModel(), imageModel: oaImgModel(), quality: oaQuality(), size: oaSize() }, o)),
      };
    }
    return { client, cfg, kind };
  }

  // gated diagnostics (set localStorage KADOKI_DEBUG=1 to see them) — silent otherwise
  function _dbg() { try { return localStorage.getItem('KADOKI_DEBUG') === '1'; } catch (_) { return false; } }
  function slog() { if (!_dbg()) return; try { console.log.apply(console, ['[aiImg]'].concat([].slice.call(arguments))); } catch (_) {} }

  // ---- HTTP (native CapacitorHttp; fetch fallback for browser dev) ----------------
  function capHttp() {
    try { return window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp || null; } catch (_) { return null; }
  }
  async function http(method, path, opts) {
    opts = opts || {};
    const url = serverUrl() + path;
    const H = capHttp();
    if (H) {
      const req = {
        url, method,
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        connectTimeout: opts.timeout || 15000,
        readTimeout: opts.timeout || 15000,
      };
      if (opts.params) req.params = opts.params;
      if (opts.body !== undefined) req.data = opts.body;
      if (opts.responseType) req.responseType = opts.responseType; // 'blob' → base64 in data
      const res = await H.request(req);
      if (res.status < 200 || res.status >= 300) {
        const e = new Error('server ' + res.status); e._status = res.status; throw e;
      }
      return res.data;   // object (json) | base64 string (blob)
    }
    // ---- fetch fallback (desktop dev) ----
    let u = url;
    if (opts.params) { const q = new URLSearchParams(opts.params); u += '?' + q.toString(); }
    const init = { method, headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const r = await fetch(u, init);
    if (!r.ok) { const e = new Error('server ' + r.status); e._status = r.status; throw e; }
    if (opts.responseType === 'blob') {
      const blob = await r.blob();
      return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
    }
    return await r.json();
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  // ---- server endpoints -----------------------------------------------------------
  async function health() { try { return await withTimeout(http('GET', '/health', { timeout: 5000 }), 6000); } catch (_) { return null; } }
  // 'reachable' for the OpenAI backend = an API key is present (no health
  // endpoint); for local = the LAN server answers /health.
  async function reachable(be) {
    be = be || backend();
    if (be === 'openai') { try { return !!(window.aiOpenai && window.aiOpenai.hasKey()); } catch (_) { return false; } }
    if (be === 'fal') { try { return !!(window.aiFal && window.aiFal.hasKey()); } catch (_) { return false; } }
    const h = await health(); return !!(h && h.ok);
  }
  function postJobs(jobs) { return http('POST', '/jobs', { body: { jobs }, timeout: 20000 }); }
  function getJob(id) { return http('GET', '/jobs/' + encodeURIComponent(id)); }
  function listDone(sinceIso) { const params = { status: 'done', limit: '200' }; if (sinceIso) params.since = sinceIso; return http('GET', '/jobs', { params }); }
  function deleteJob(id) { return http('DELETE', '/jobs/' + encodeURIComponent(id)).catch(() => {}); }
  async function fetchImageDataUrl(imageUrl) {
    const path = imageUrl.startsWith('/') ? imageUrl : ('/image/' + imageUrl);
    const b64 = await http('GET', path, { responseType: 'blob', timeout: 30000 });
    return 'data:image/png;base64,' + (typeof b64 === 'string' ? b64 : '');
  }

  // ---- storage (serialized read-modify-write per blob) ----------------------------
  const OUTBOX_KEY = 'AIIMG_OUTBOX_V1';
  const IDX_PREFIX = 'AICHAR_IMGIDX_V1_';       // per-title metadata (small)
  const KEPT_PREFIX = 'AICHAR_IMG_V1_';          // <tid>_<imgId> → dataUri
  const REV_PREFIX = 'AICHAR_IMGREV_V1_';        // <tid>_<imgId> → dataUri
  const idxKey = (tid) => IDX_PREFIX + tid;
  const keptBlobKey = (tid, imgId) => KEPT_PREFIX + tid + '_' + imgId;
  const revBlobKey = (tid, imgId) => REV_PREFIX + tid + '_' + imgId;

  const _locks = {};
  function lock(key, fn) {
    const prev = _locks[key] || Promise.resolve();
    const next = prev.then(fn, fn);
    _locks[key] = next.catch(() => {});
    return next;
  }
  async function readJson(key, fallback) {
    try { const raw = window.blobStore ? await window.blobStore.get(key) : null; return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
  }
  function writeJson(key, obj) { try { return window.blobStore ? window.blobStore.set(key, JSON.stringify(obj)) : Promise.resolve(); } catch (_) { return Promise.resolve(); } }

  function freshOutbox() { return { v: 1, lastSyncAt: null, entries: [] }; }
  function loadOutbox() { return readJson(OUTBOX_KEY, freshOutbox()).then(o => (o && o.v === 1 && Array.isArray(o.entries)) ? o : freshOutbox()); }
  function mutateOutbox(fn) { return lock(OUTBOX_KEY, async () => { const o = await loadOutbox(); const r = await fn(o); await writeJson(OUTBOX_KEY, o); return r; }); }

  function freshIdx() { return { v: 1, chars: {} }; }
  function loadIdx(tid) { return readJson(idxKey(tid), freshIdx()).then(p => (p && p.v === 1 && p.chars) ? p : freshIdx()); }
  // Unified per-character image list. Returned images land here directly (no
  // separate review step); `unseen` drives the per-card "新着" notification.
  // Migrates any legacy review/kept split into one list (bytes stay where they
  // are — getImageBytes reads either key).
  function charBucket(idx, charId) {
    if (!idx.chars[charId]) idx.chars[charId] = { images: [] };
    const b = idx.chars[charId];
    if (!Array.isArray(b.images)) b.images = [];
    if (Array.isArray(b.kept) || Array.isArray(b.review)) {
      const seen = new Set(b.images.map(x => x.imgId));
      for (const k of (b.kept || [])) if (!seen.has(k.imgId)) { b.images.push({ imgId: k.imgId, prompt: k.prompt || '', scene: k.scene || 1, model: k.model || '', cropped: !!k.cropped, unseen: false, ts: k.ts || 0 }); seen.add(k.imgId); }
      for (const r of (b.review || [])) if (!seen.has(r.imgId)) { b.images.push({ imgId: r.imgId, prompt: r.prompt || '', scene: r.scene || 1, model: r.model || '', cropped: false, unseen: true, ts: r.ts || 0 }); seen.add(r.imgId); }
      delete b.kept; delete b.review;
    }
    return b;
  }
  function mutateIdx(tid, fn) { return lock(idxKey(tid), async () => { const idx = await loadIdx(tid); const r = await fn(idx); await writeJson(idxKey(tid), idx); return r; }); }
  // Image bytes live under the kept key for new images; legacy review images
  // kept their REV key — try both so a pre-migration image still loads.
  async function getImageBytes(tid, imgId) {
    let d = null;
    try { d = await window.blobStore.get(keptBlobKey(tid, imgId)); } catch (_) {}
    if (!d) { try { d = await window.blobStore.get(revBlobKey(tid, imgId)); } catch (_) {} }
    return d || '';
  }

  // ---- character card text (sent to the server's local Qwen) ----------------------
  function cardTextFor(rec) {
    const lines = [];
    const reading = rec.rubyReading || rec.standardReading || '';
    lines.push('名前: ' + (rec.surface || '') + (reading && reading !== rec.surface ? '（' + reading + '）' : ''));
    const aliases = (rec.aliases || []).filter(a => a && a !== rec.surface);
    if (aliases.length) lines.push('別名: ' + aliases.join('、'));
    if (rec.role) lines.push('役割: ' + rec.role);
    if (rec.appearance) lines.push('外見: ' + rec.appearance);
    if (rec.personality) lines.push('性格: ' + rec.personality);
    if (rec.description) lines.push('人物: ' + rec.description);
    return lines.join('\n');
  }
  // Stable short signature of a character's card text — lets us tell when a
  // character's info (appearance/description/relationships) changed AFTER a picture
  // was generated, to highlight the "update picture" button.
  function sigOf(str) { let h = 5381; const s = String(str || ''); for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0; return (h >>> 0).toString(36); }

  // ---- outbox helpers -------------------------------------------------------------
  let _localSeq = 0;
  function newLocalId() { _localSeq = (_localSeq + 1) % 100000; return 'o' + Date.now().toString(36) + _localSeq.toString(36); }
  function activeEntry(o, tid, charId) {
    return o.entries.find(e => e.titleId === tid && e.charId === charId && (e.status === 'pending' || e.status === 'submitted'));
  }
  function maxAttempt(o, tid, charId) {
    let m = 0; for (const e of o.entries) if (e.titleId === tid && e.charId === charId) m = Math.max(m, e.attempt || 1); return m;
  }

  // Queue ONE character (no-op if an active entry already exists, unless force).
  async function queueCharacter(titleId, rec, opts) {
    opts = opts || {};
    if (!titleId || !rec || !rec.id) return null;
    return mutateOutbox(async (o) => {
      if (opts.force) { if (o.suppressed) delete o.suppressed[rec.id]; }   // intentional regen lifts a server-delete suppression
      else if (o.suppressed && o.suppressed[rec.id]) return null;          // user deleted it on the server — don't re-create it
      if (!opts.force && activeEntry(o, titleId, rec.id)) return null;     // already queued/submitted
      const attempt = (opts.force ? maxAttempt(o, titleId, rec.id) : 0) + 1;
      const cardText = cardTextFor(rec);
      const entry = {
        localId: newLocalId(), titleId, charId: rec.id, charName: rec.surface || rec.id,
        cardText, charSig: sigOf(cardText),

        modify: (opts.modify && String(opts.modify).trim()) || null,   // regenerate instruction → server
        style: opts.style || defStyle(), model: opts.model || defModel(),
        scenes: opts.scenes || defScenes(), size: opts.size || defSize(),
        backend: backend(),   // which backend this was queued FOR — syncOpenAI only renders its own (no cross-backend surprise spend)
        attempt, serverJobId: null, batchId: null, status: 'pending', ts: Date.now(), error: null,
      };
      o.entries.push(entry);
      return entry.localId;
    });
  }

  // ---- SCENE jobs (illustrate a chapter) ------------------------------------------
  // Scenes are stored as "images" under a pseudo-character charId `scene_<idx>`
  // in the SAME index, so the whole gallery / crop / delete / sync stack is reused.
  // The characters PRESENT in a chapter (name-scan of the chapter text against
  // each record's surface/aliases) are sent so the server can keep them visually
  // consistent (text-only; no reference image).
  async function presentCharacters(titleId, chapterIdx, textOverride) {
    try {
      const text = textOverride || ((window.aiChunks && window.aiChunks.chunkText) ? (await window.aiChunks.chunkText(titleId, chapterIdx) || '') : '');
      if (!text) return [];
      let st = null;
      try { st = await window.aiCharacters.openState(titleId); } catch (_) {}
      const list = (st && Array.isArray(st.list)) ? st.list : [];
      const surfaceOf = (st && st.surfaceOf) || {};
      const out = [];
      for (const rec of list) {
        if (!rec || rec.mergedInto || rec.isCommonWord || rec.isStub) continue;
        const names = [rec.surface].concat(rec.aliases || []).filter(n => n && n.length >= 2);
        if (!names.some(n => text.includes(n))) continue;   // not mentioned in this chapter
        let rel = '';
        try {
          rel = (rec.relationships || []).map(r => {
            const toName = (surfaceOf && surfaceOf[r.to]) || r.to;   // .to is a char ID → resolve to a name
            return toName + (r.rel ? '(' + r.rel + ')' : '');
          }).join('、');
        } catch (_) {}
        out.push({
          name: rec.surface || '',
          surface: rec.surface || '',
          reading: rec.rubyReading || rec.standardReading || '',
          appearance: rec.appearance || rec.description || '',
          relationships: rel,
        });
      }
      return out;
    } catch (_) { return []; }
  }

  // Queue a scene-illustration job for ONE chapter. Builds the chapter text +
  // present characters now (kept on the outbox entry; the existing sync() submits
  // it). opts.scenes = optional CAP (omit → server's length-driven count).
  async function queueScene(titleId, chapterIdx, opts) {
    opts = opts || {};
    if (!titleId || !Number.isFinite(chapterIdx)) return { ok: false, reason: 'bad-args' };
    const charId = 'scene_' + chapterIdx;
    // User deleted this chapter's scenes on the server → don't re-create (auto or
    // manual), unless this is an explicit force. (force lifts it inside the mutate.)
    if (!opts.force) { try { const o0 = await loadOutbox(); if (o0.suppressed && o0.suppressed[charId]) return { ok: false, reason: 'suppressed' }; } catch (_) {} }
    let chapterText = '';
    if (opts.chapterText) chapterText = opts.chapterText;   // AUTO: pre-truncated (spoiler-safe) text
    else { try { if (window.aiChunks && window.aiChunks.chunkText) chapterText = (await window.aiChunks.chunkText(titleId, chapterIdx)) || ''; } catch (_) {} }
    if (!chapterText.trim()) return { ok: false, reason: 'no-text' };
    const characters = await presentCharacters(titleId, chapterIdx, opts.chapterText || null);
    return mutateOutbox(async (o) => {
      // force = intentional regen (lifts suppression). multi = auto's per-6k boundary
      // (bypasses the one-active dedup so a chapter can get several scenes) but does
      // NOT lift suppression — so deleting a chapter's scenes stops AUTO re-creating.
      if (opts.force) { if (o.suppressed) delete o.suppressed[charId]; }
      else if (o.suppressed && o.suppressed[charId]) return { ok: false, reason: 'suppressed' };
      if (!opts.force && !opts.multi && activeEntry(o, titleId, charId)) return { ok: true, already: true };
      const attempt = ((opts.force || opts.multi) ? maxAttempt(o, titleId, charId) : 0) + 1;
      o.entries.push({
        localId: newLocalId(), titleId, charId, charName: opts.label || ('第' + (chapterIdx + 1) + '章'),
        kind: 'scene', chapterIdx, chapterText, characters, auto: !!opts.auto,
        scenes: Number.isFinite(opts.scenes) ? opts.scenes : 1,   // default 1 image per scene-gen (was null = server length-driven → several)
        style: opts.style || defStyle(), size: opts.size || defSize(),
        backend: backend(),   // queued-for backend (see queueCharacter)
        attempt, serverJobId: null, batchId: null, status: 'pending', ts: Date.now(), error: null,
      });
      return { ok: true, queued: true };
    });
  }

  // Queue a render from a PRE-BUILT prompt (a Claude-authored scene from the timeline).
  // renderEntry sees entry.prompt and SKIPS the art-director (Stage 1). Each defined
  // scene gets its own charId 'scene_<chapterIdx>_<slot>' so its image is tracked
  // separately. Cloud backends only (the local server has no prompt passthrough yet).
  async function queueSceneFromPrompt(titleId, chapterIdx, slot, opts) {
    opts = opts || {};
    if (!titleId || !Number.isFinite(chapterIdx)) return { ok: false, reason: 'bad-args' };
    if (!opts.prompt || !String(opts.prompt).trim()) return { ok: false, reason: 'no-prompt' };
    const charId = 'scene_' + chapterIdx + '_' + (Number.isFinite(slot) ? slot : 0);
    return mutateOutbox(async (o) => {
      if (!opts.force && activeEntry(o, titleId, charId)) return { ok: true, already: true };
      const attempt = (opts.force ? maxAttempt(o, titleId, charId) : 0) + 1;
      o.entries.push({
        localId: newLocalId(), titleId, charId, charName: opts.label || ('第' + (chapterIdx + 1) + '章'),
        kind: 'scene', chapterIdx,
        prompt: String(opts.prompt), caption: opts.caption || '', style: opts.style || '', sceneId: opts.sceneId || charId,
        scenes: 1, size: opts.size || defSize(),
        backend: backend(),
        attempt, serverJobId: null, batchId: null, status: 'pending', ts: Date.now(), error: null,
      });
      return { ok: true, queued: true };
    });
  }

  // Keep only the `max` most-recent in-flight AUTO scene jobs. Older PENDING ones
  // are dropped from the outbox and their chapterIdx returned (ai-scenes marks them
  // "tappable" on the timeline). Submitted/rendering jobs occupy slots but are never
  // cancelled. This bounds a long offline read from flooding the GPU on reconnect.
  async function capAutoScenes(titleId, max) {
    const cap = Number.isFinite(max) ? max : 10;
    const dropped = [];
    await mutateOutbox((o) => {
      const submitted = o.entries.filter(e => e.titleId === titleId && e.kind === 'scene' && e.auto && e.status === 'submitted').length;
      const keep = Math.max(0, cap - submitted);
      const pend = o.entries.filter(e => e.titleId === titleId && e.kind === 'scene' && e.auto && e.status === 'pending')
                            .sort((a, b) => (a.ts || 0) - (b.ts || 0));   // oldest first
      const over = pend.length - keep;
      for (let i = 0; i < over; i++) { dropped.push(pend[i].chapterIdx); o.entries = o.entries.filter(x => x.localId !== pend[i].localId); }
    });
    return dropped;
  }

  // Queue EVERY character that has no image yet and no active outbox entry.
  async function queueAllMissing(titleId) {
    // Never bulk-create on a cloud backend — it would auto-spend on every
    // character. Cloud generation is on-demand (per-card button) or the
    // semi-random daily scheduler only.
    if (backend() !== 'local') return 0;
    const tid = titleId || window._activeTitleId;
    if (!tid || !window.aiCharacters) return 0;
    let list = [];
    try { const st = await window.aiCharacters.openState(tid); list = (st && st.list) || []; } catch (_) {}
    const idx = await loadIdx(tid);
    const o = await loadOutbox();
    let n = 0;
    for (const rec of list) {
      if (!rec || rec.mergedInto || rec.isCommonWord) continue;
      const b = idx.chars[rec.id];
      const has = b && ((b.images && b.images.length) || (b.kept && b.kept.length) || (b.review && b.review.length));
      if (has) continue;                                    // already has an image
      if (activeEntry(o, tid, rec.id)) continue;            // already queued
      const id = await queueCharacter(tid, rec);
      if (id) n++;
    }
    if (n) emit(tid);
    slog('queueAllMissing: queued', n, 'of', list.length, 'chars');
    return n;
  }

  // ---- cloud backends (OpenAI / fal): synchronous render-and-ingest ---------------
  // No /jobs server, no async lifecycle: each pending entry is rendered (Stage 1
  // art-director + Stage 2 image) by the adapter into a synthetic done-job, fed
  // through the SAME ingestJob() as a local render. Offline / no-key leaves the
  // entry 'pending' (retried on the next foreground catch-up). A content refusal
  // marks the entry 'refused' (terminal — not auto-retried) and is surfaced; if the
  // local server is reachable the caller can offer a one-tap local retry.
  // Cloud render PACING. Queueing N images must not blast the cloud API into a
  // rate-limit. Render at most ONE cloud image per cloudGapMs, draining the backlog
  // over time via a self-rescheduling timer (runs while the app is foregrounded;
  // resumes on foreground after an iOS suspend). The pacing is GLOBAL across every
  // caller (the 9s UI poll, foregroundSync, the drain timer) via _lastCloudRenderAt,
  // so no path can burst. A rate-limit backs off further and is NEVER terminal —
  // the queue keeps draining until every image renders.
  function cloudGapMs() { try { const v = parseInt(lsGet('AIIMG_CLOUD_GAP_S', '20'), 10); return (Number.isFinite(v) && v >= 3) ? v * 1000 : 20000; } catch (_) { return 20000; } }
  const CLOUD_RL_BACKOFF_MS = 60000;   // extra wait after a rate-limit before the next render
  const CLOUD_MAX_TRIES = 12;          // a NON-rate-limit transient gives up after this many (rate-limits never give up)
  let _lastCloudRenderAt = 0;
  let _cloudDrainTimer = 0;
  function scheduleCloudDrain(titleId, kind, ms) {
    try {
      if (_cloudDrainTimer) { clearTimeout(_cloudDrainTimer); _cloudDrainTimer = 0; }
      const wait = Math.max(1000, Math.min(5 * 60000, ms | 0));
      _cloudDrainTimer = setTimeout(() => { _cloudDrainTimer = 0; try { sync(titleId, { backend: kind }); } catch (_) {} }, wait);
    } catch (_) {}
  }

  async function syncCloud(titleId, kind) {
    if (!window.aiImageOpenai) return { ok: false, reason: 'no-key' };
    if (!(await reachable(kind))) { slog(kind + ': not reachable'); return { ok: false, reason: 'no-key' }; }
    // Render entries queued FOR this backend (no cross-backend surprise spend). NOT
    // sliced to a fixed count — the per-render gap below is what limits the rate, so
    // an arbitrarily large queue is fine; it just drains one-at-a-time over time.
    const pending = (await loadOutbox()).entries.filter(e => e.status === 'pending' && e.backend === kind);
    if (!pending.length) { await mutateOutbox((o) => { o.lastSyncAt = new Date(Date.now()).toISOString(); }); if (titleId) emit(titleId); return { ok: true, submitted: 0, ingested: 0, errored: 0 }; }
    const ctx = cloudContext(kind);
    const gap = cloudGapMs();
    let ingested = 0, errored = 0, refusedMsg = '', refusedAny = false, rateLimited = false, lastErr = '';
    for (const p of pending) {
      // Pace: at most one render per `gap` ms (global). If we're inside the window,
      // leave the rest pending and let the drain timer resume after the gap.
      const since = Date.now() - _lastCloudRenderAt;
      if (since < gap) { scheduleCloudDrain(titleId, kind, gap - since); break; }
      let result = null;
      try { result = await window.aiImageOpenai.renderEntry(p, ctx); }
      catch (e) {
        _lastCloudRenderAt = Date.now();            // it consumed an attempt → pace the next regardless
        if (e && e._terminal) {                     // deterministic client error (bad params / org unverified) → terminal, but DON'T abort the drain
          await mutateOutbox((o) => { const x = o.entries.find(y => y.localId === p.localId); if (x) { x.status = 'refused'; x.error = (e && e.message) || 'error'; } });
          refusedAny = true; refusedMsg = refusedMsg || (e && e.message) || 'error'; errored++;
          if (titleId) emit(titleId);
          continue;                                 // move on to the next queued image
        }
        const rl = !!(e && (e._status === 429 || e._status === 503 || /rate|too many|overload|quota|\b429\b|\b503\b/i.test(e.message || '')));
        lastErr = (e && e.message) || (rl ? 'rate limited' : 'render failed');
        // Keep the entry PENDING + store the reason for display. Rate-limits are NEVER
        // terminal (just keep waiting); other transients give up only after many tries.
        await mutateOutbox((o) => {
          const x = o.entries.find(y => y.localId === p.localId);
          if (!x) return;
          x._tries = (x._tries || 0) + 1;
          x.error = lastErr;
          if (!rl && x._tries >= CLOUD_MAX_TRIES) { x.status = 'error'; errored++; }
        });
        if (rl) { rateLimited = true; _lastCloudRenderAt = Date.now() + CLOUD_RL_BACKOFF_MS; }   // wait longer after a rate-limit
        slog('cloud render error', rl ? '(rate-limited)' : '', e && e.message);
        if (titleId) emit(titleId);
        const remaining = (await loadOutbox()).entries.some(e2 => e2.status === 'pending' && e2.backend === kind);
        if (remaining) scheduleCloudDrain(titleId, kind, rl ? CLOUD_RL_BACKOFF_MS : gap);
        if (e && e._status === 401) return { ok: false, reason: 'no-key', error: lastErr, ingested, errored };
        return { ok: false, reason: rl ? 'rate-limited' : 'error', error: lastErr, rateLimited: rl, ingested, errored };
      }
      _lastCloudRenderAt = Date.now();
      if (result && result.produced > 0) {
        await mutateOutbox((o) => { const e = o.entries.find(x => x.localId === p.localId); if (e) e.serverJobId = result.job.id; });
        ingested += await ingestJob(result.job);
        // Cloud renders are ephemeral (b64 only in memory). If ingest didn't persist,
        // mark terminal so a paid image is never re-rendered and re-billed.
        await mutateOutbox((o) => { const e = o.entries.find(x => x.localId === p.localId); if (e && e.status === 'pending') { e.status = 'error'; e.error = 'image not stored'; errored++; } });
      } else {                                       // refusal / no usable prompt → terminal
        refusedAny = refusedAny || !!(result && result.refused);
        refusedMsg = refusedMsg || (result && result.refusalMsg) || window.i18n.t('im.gen_failed', 'Could not generate the image');
        await mutateOutbox((o) => { const e = o.entries.find(x => x.localId === p.localId); if (e) { e.status = 'refused'; e.error = (result && result.refusalMsg) || 'refused'; } });
        errored++;
      }
      if (titleId) emit(titleId);                    // surface each render the moment it lands
    }
    await mutateOutbox((o) => { o.lastSyncAt = new Date(Date.now()).toISOString(); });
    if (titleId) emit(titleId);
    // Keep draining whatever is left (paced).
    const stillPending = (await loadOutbox()).entries.some(e => e.status === 'pending' && e.backend === kind);
    if (stillPending) scheduleCloudDrain(titleId, kind, Math.max(1000, gap - (Date.now() - _lastCloudRenderAt)));
    if (errored > 0 && ingested === 0) {
      let canLocal = false; try { canLocal = await reachable('local'); } catch (_) {}
      return { ok: false, reason: rateLimited ? 'rate-limited' : 'refused', refusalMsg: refusedMsg, error: lastErr || refusedMsg, canLocal, ingested, errored };
    }
    return { ok: true, submitted: ingested, ingested, errored, pending: stillPending };
  }

  // ---- sync (submit pending → reconcile submitted → ingest done) ------------------
  let _syncing = false;
  async function sync(titleId, opts) {
    opts = opts || {};
    if (_syncing) return { ok: false, reason: 'busy' };
    _syncing = true;
    try {
      const be = opts.backend || backend();
      if (be === 'openai') return await syncCloud(titleId, 'openai');   // cloud path: synchronous render-and-ingest
      if (be === 'fal') return await syncCloud(titleId, 'fal');
      slog('sync start', titleId);
      if (!(await reachable('local'))) { slog('sync: server UNREACHABLE', serverUrl()); return { ok: false, reason: 'unreachable' }; }
      // 0. recover STALE 'submitted' entries. A job submitted longer ago than STALE_MS
      // that still isn't done/errored is treated as lost → flip back to 'pending' so it
      // re-submits THIS run. Otherwise activeEntry counts it forever and queueAllMissing
      // never re-queues that character → it can never get a picture. Legacy entries (no
      // submittedAt stamp) are treated as stale. listDone (below) still ingests the old
      // job if the server ever finishes it, so at worst a very slow render yields a dup.
      const STALE_MS = 20 * 60 * 1000;
      let recovered = 0;
      await mutateOutbox((o) => {
        for (const e of o.entries) {
          if (e.status !== 'submitted') continue;
          // Unstamped (legacy) entries: START the clock now and let step-2 reconcile
          // claim them first (done→ingest, 404→error→re-queueable) — so the first
          // post-update sync doesn't mass-resubmit jobs that are actually done (dups).
          if (!e.submittedAt) { e.submittedAt = Date.now(); continue; }
          if (Date.now() - e.submittedAt > STALE_MS) {
            // Cap the re-submit loop (the server saw attempt climb to 8): give up after
            // a few stale recoveries instead of hammering. listDone still ingests it if
            // the server ever finishes, and the server now dedups any re-submit.
            e.reSubmits = (e.reSubmits || 0) + 1;
            if (e.reSubmits > 3) { e.status = 'error'; e.error = 'gave up (stale, retried)'; }
            else { e.status = 'pending'; e.serverJobId = null; recovered++; }
          }
        }
      });
      if (recovered) slog('sync: re-queued', recovered, 'stale submitted entr(ies)');
      // 1. submit all pending. Character jobs batch (≤12/POST). SCENE jobs each carry
      // a WHOLE chapter's text, so they go ONE per POST in their own batches — a big or
      // failing scene job must never poison a shared batch and block character renders.
      const pending = (await loadOutbox()).entries.filter(e => e.status === 'pending' && (e.backend === 'local' || !e.backend));   // local renders local/legacy only (cloud entries belong to syncCloud)
      let submitted = 0, postFailures = 0;
      const charP = pending.filter(e => e.kind !== 'scene');
      const sceneP = pending.filter(e => e.kind === 'scene');
      const batches = [];
      for (let i = 0; i < charP.length; i += 12) batches.push(charP.slice(i, i + 12));
      for (const s of sceneP) batches.push([s]);
      slog('sync: pending', pending.length, '=', charP.length, 'char +', sceneP.length, 'scene →', batches.length, 'batches');
      for (const slice of batches) {
        const jobs = slice.map(e => {
          const meta = { localId: e.localId, titleId: e.titleId, charId: e.charId, charName: e.charName, attempt: e.attempt };
          if (e.charSig) meta.charSig = e.charSig;   // echoed back → stored on the image so "update picture" can detect card changes
          if (e.kind === 'scene') {
            meta.chapterIdx = e.chapterIdx;
            const j = { kind: 'scene', chapterText: e.chapterText || '', characters: e.characters || [], style: e.style, size: e.size, meta };
            if (Number.isFinite(e.scenes)) j.scenes = e.scenes;   // optional CAP (else server length-driven)
            return j;
          }
          const j = { card: e.cardText, style: e.style, model: e.model, scenes: e.scenes, size: e.size, meta };
          if (e.modify) j.modify = e.modify;   // regenerate instruction (server folds into the prompt)
          return j;
        });
        let resp = null;
        try { resp = await postJobs(jobs); } catch (err) { resp = null; slog('sync: POST threw', (slice[0] && slice[0].kind) || 'char', 'x' + slice.length, err && err.message); }
        if (!resp || !resp.ok || !Array.isArray(resp.jobs)) { postFailures++; slog('sync: batch NOT accepted (ok=' + (resp && resp.ok) + ')'); continue; }
        let accepted = 0;
        await mutateOutbox((o) => {
          resp.jobs.forEach((j, k) => {
            const src = slice[k];
            const e = o.entries.find(x => x.localId === src.localId);
            if (!e || !j) return;
            if (j.status === 'suppressed' || (j.id == null && j.suppressed)) {
              // The user DELETED this on the server → stop regenerating it: mark the
              // entry terminal AND record the charId locally so queueAllMissing /
              // queueScene / auto-scenes won't re-create it (force:true lifts it).
              e.status = 'suppressed'; e.error = 'deleted on server';
              if (e.charId) { o.suppressed = o.suppressed || {}; o.suppressed[e.charId] = Date.now(); }
              accepted++;
              return;
            }
            if (j.id) {
              e.serverJobId = j.id; e.batchId = resp.batch_id || null; e.status = 'submitted'; e.submittedAt = Date.now();
              if (j.deduped) e.deduped = true;   // server already had it → reconcile ingests its image, no new render
              submitted++; accepted++;
            }
          });
        });
        if (accepted < slice.length) { postFailures++; slog('sync: batch accepted only', accepted, '/', slice.length); }   // empty/short jobs[] = a silent server failure
      }
      // 2. reconcile our still-open submitted jobs
      const open = (await loadOutbox()).entries.filter(e => e.status === 'submitted' && e.serverJobId);
      let ingested = 0, errored = 0;
      for (const e of open) {
        let job = null;
        try { job = await getJob(e.serverJobId); } catch (err) { if (err && err._status === 404) await markEntry(e.serverJobId, 'error', 'job expired'); continue; } // 404 = server's 3-day retention pruned it → terminal, don't poll forever
        if (!job) continue;
        if (job.status === 'done') ingested += await ingestJob(job);
        else if (job.status === 'error') { errored++; await markEntry(e.serverJobId, 'error', job.error || 'render failed'); }
      }
      // 3. resync any done jobs we may have missed while offline (routed by meta)
      try {
        const since = (await loadOutbox()).lastSyncAt;
        const r = await listDone(since);
        for (const job of ((r && r.jobs) || [])) { if (job && job.status === 'done') ingested += await ingestJob(job); }
      } catch (_) {}
      await mutateOutbox((o) => { o.lastSyncAt = new Date(Date.now()).toISOString(); });
      if (titleId) emit(titleId);
      slog('sync done: submitted', submitted, 'ingested', ingested, 'errored', errored, 'postFailures', postFailures, '(still-open', open.length + ')');
      // Surface a TOTAL submit failure: /health passed but every POST /jobs failed and
      // nothing landed → the button must show an error, not look like a silent success.
      if (submitted === 0 && ingested === 0 && postFailures > 0) {
        return { ok: false, reason: 'submit-failed', submitted, ingested, errored };
      }
      return { ok: true, submitted, ingested, errored };
    } finally { _syncing = false; }
  }

  // FULL catch-up: pull EVERY recent done job from the server (NO `since` filter) and
  // ingest any whose images aren't local yet (routed by meta.titleId). The since-based
  // sync MISSES jobs that finished before the last sync, and a reinstall wipes the
  // local outbox so reconcile can't find them either — so previously-generated scenes
  // never came back. This refetches them. ingestJob dedups (idxHasImg) + deletes the
  // server copy once stored, so it's idempotent and self-cleaning.
  async function refetchDone(titleId) {
    if (backend() !== 'local') return { ok: true, ingested: 0, scanned: 0 };   // cloud backends have no server to refetch from
    if (_syncing) return { ok: false, reason: 'busy' };
    _syncing = true;
    try {
      if (!(await reachable('local'))) { slog('refetchDone: unreachable'); return { ok: false, reason: 'unreachable' }; }
      let ingested = 0, scanned = 0;
      const r = await listDone(null);   // no `since` → all recent done jobs (limit 200)
      for (const job of ((r && r.jobs) || [])) {
        if (!job || job.status !== 'done') continue;
        const m = job.meta || (job.request && job.request.meta) || {};
        if (titleId && m.titleId && m.titleId !== titleId) continue;   // only THIS title
        scanned++;
        ingested += await ingestJob(job);
      }
      if (titleId) emit(titleId);
      slog('refetchDone: scanned', scanned, 'ingested', ingested);
      return { ok: true, ingested, scanned };
    } catch (e) { slog('refetchDone error', e && e.message); return { ok: false, reason: 'error' }; }
    finally { _syncing = false; }
  }

  // Reconcile only the already-submitted jobs (cheap poll while a screen is open).
  let _polling = false;
  async function pollPending(titleId) {
    if (_syncing || _polling || backend() !== 'local') return 0;   // cloud backends are synchronous — nothing to poll
    const open = (await loadOutbox()).entries.filter(e => e.status === 'submitted' && e.serverJobId);
    if (!open.length) return 0;                       // nothing in flight → no network at all
    _polling = true;
    try {
      if (!(await reachable('local'))) return 0;
      return await _pollOpen(open, titleId);
    } finally { _polling = false; }
  }
  async function _pollOpen(open, titleId) {
    let ingested = 0;
    for (const e of open) {
      let job = null;
      try { job = await getJob(e.serverJobId); } catch (_) { continue; }
      if (!job) continue;
      if (job.status === 'done') ingested += await ingestJob(job);
      else if (job.status === 'error') await markEntry(e.serverJobId, 'error', job.error || 'render failed');
    }
    if (ingested && titleId) emit(titleId);
    return ingested;
  }

  function markEntry(serverJobId, status, error) {
    return mutateOutbox((o) => { const e = o.entries.find(x => x.serverJobId === serverJobId); if (e) { e.status = status; if (error) e.error = error; } });
  }

  // Pull every scene of a finished job into the character's image gallery
  // (unseen → triggers the per-card "新着" badge), then DELETE the job
  // server-side (the 3-day cache is no longer our durable copy).
  async function ingestJob(job) {
    try {
      const meta = job.meta || (job.request && job.request.meta) || {};
      const tid = meta.titleId, charId = meta.charId;
      if (!tid || !charId || !Array.isArray(job.results)) return 0;
      let added = 0, expected = 0, haveLocal = 0;
      for (let k = 0; k < job.results.length; k++) {
        const res = job.results[k];
        if (!res || (!res.image_url && !res.file && !res.b64) || res.error) continue;
        expected++;
        // Index-based fallback so a scene job with missing/duplicate `scene`
        // fields can't collide N images onto one imgId (silent loss + early
        // deleteJob). Stable across re-ingests; unchanged when scene IS present.
        const imgId = job.id + '_s' + (res.scene || (k + 1));
        if (await idxHasImg(tid, charId, imgId)) { haveLocal++; continue; }   // already pulled
        let dataUri = '';
        if (res.b64) { dataUri = String(res.b64).startsWith('data:') ? res.b64 : ('data:image/png;base64,' + res.b64); }   // OpenAI inline base64 — no network fetch
        else { try { dataUri = await fetchImageDataUrl(res.image_url || res.file); } catch (_) { continue; } } // transient → retry next poll
        if (!dataUri || dataUri.length < 64) continue;
        await window.blobStore.set(keptBlobKey(tid, imgId), dataUri);
        await mutateIdx(tid, (idx) => {
          const b = charBucket(idx, charId);
          if (!b.images.some(x => x.imgId === imgId)) {
            const now = Date.now();
            // modTs = last-modified (bumped on recrop); drives the sync merge so a
            // crop on one device wins over an older copy regardless of sync order.
            const capTxt = res.caption || res.description || res.text || job.caption || '';   // tolerate server field-name variants
            b.images.push({ imgId, jobId: job.id, scene: res.scene || (k + 1), prompt: res.prompt || '', caption: capTxt, charSig: meta.charSig || '', model: (job.request && job.request.model) || '', respId: res.respId || null, backend: res.backend || (res.b64 ? 'openai' : 'local'), sceneId: res.sceneId || null, cropped: false, unseen: true, ts: now, modTs: now });
          }
        });
        added++; haveLocal++;
      }
      // Only mark done + free the server copy once EVERY scene is local (or the
      // job produced nothing renderable). A failed image fetch leaves it
      // 'submitted' so the next poll/sync retries — never delete before we have it.
      const complete = (expected === 0) || (haveLocal >= expected);
      if (complete) {
        await mutateOutbox((o) => {
          const e = o.entries.find(x => x.serverJobId === job.id);
          if (e) {
            e.status = 'done';
            // Scene entries carry a whole chapter's text — drop it once done so the
            // (never-pruned) outbox blob doesn't grow a chapter per scene job and
            // get rewritten on every future image op. Done entries are never resubmitted.
            if (e.kind === 'scene') { e.chapterText = ''; e.characters = []; }
          }
        });
        if (!String(job.id || '').startsWith('oai_')) { try { await deleteJob(job.id); } catch (_) {} }   // local server cleanup only; OpenAI has no server copy
      }
      if (added) emit(meta.titleId);
      return added;
    } catch (_) { return 0; }
  }
  async function idxHasImg(tid, charId, imgId) {
    const idx = await loadIdx(tid);
    const b = idx.chars[charId];
    if (!b) return false;
    return !!((b.images || []).some(x => x.imgId === imgId) ||
              (b.kept || []).some(x => x.imgId === imgId) ||
              (b.review || []).some(x => x.imgId === imgId));
  }

  // ---- image ops (all local; the card IS the gallery — no separate review) --------
  function bucketImages(b) { return (b && Array.isArray(b.images)) ? b.images
    : [].concat((b && b.kept) || [], (b && b.review) || []); }   // pre-migration read

  // Delete an image from a character (removes the bytes under either key).
  // Also drops a TOMBSTONE so the deletion propagates across the union-merge sync
  // (and isn't resurrected by a device that still holds the image).
  async function deleteImage(tid, charId, imgId) {
    await mutateIdx(tid, (idx) => {
      const b = charBucket(idx, charId);
      b.images = b.images.filter(x => x.imgId !== imgId);
      if (!Array.isArray(b.deleted)) b.deleted = [];
      if (!b.deleted.some(d => d && d.imgId === imgId)) b.deleted.push({ imgId, ts: Date.now() });
    });
    try { await window.blobStore.remove(keptBlobKey(tid, imgId)); } catch (_) {}
    try { await window.blobStore.remove(revBlobKey(tid, imgId)); } catch (_) {}
    emit(tid);
    return true;
  }
  // Replace an image's bytes after an in-place crop — keeps its slot, marks seen.
  // Bumps modTs so the crop wins the sync merge over an un-cropped copy elsewhere.
  async function recropImage(tid, charId, imgId, dataUri) {
    if (!dataUri) return false;
    await window.blobStore.set(keptBlobKey(tid, imgId), dataUri);
    try { await window.blobStore.remove(revBlobKey(tid, imgId)); } catch (_) {}   // legacy key now stale
    // Null respId: the OpenAI edit-chain edits the SERVER-stored original, which is
    // the UNcropped image — so after a crop, route a later text-edit to the stored
    // (cropped) bytes instead. No-op for local images (respId already null).
    await mutateIdx(tid, (idx) => { const b = charBucket(idx, charId); const k = b.images.find(x => x.imgId === imgId); if (k) { k.cropped = true; k.unseen = false; k.respId = null; k.modTs = Date.now(); } });
    emit(tid);
    return true;
  }

  // ---- cross-device MERGE (Drive sync) -------------------------------------
  // Union the REMOTE per-character image index into the LOCAL one instead of
  // overwriting it, so images generated/edited on either device are never lost:
  //  • new images on either side survive (union by imgId),
  //  • on a conflicting imgId (e.g. a crop), the entry with the newer modTs wins,
  //  • a deletion (tombstone) on either side removes the image everywhere.
  // Image BYTES are keyed by imgId; the caller (drive-sync) must NOT overwrite a
  // local image whose entry we kept as newer — `localNewer` reports those imgIds.
  // Returns { localNewer: [imgId,...] }. Bad/empty remote → no change.
  const _imgTs = (e) => (e && (Number.isFinite(e.modTs) ? e.modTs : (Number.isFinite(e.ts) ? e.ts : 0))) || 0;
  async function mergeIndexBlob(tid, remoteJson) {
    let remote = null;
    try { remote = JSON.parse(remoteJson); } catch (_) {}
    if (!remote || typeof remote !== 'object' || !remote.chars || typeof remote.chars !== 'object') return { localNewer: [] };
    const localNewer = [];
    await mutateIdx(tid, (local) => {
      const lc = local.chars || (local.chars = {});
      const rc = remote.chars;
      const cids = new Set([...Object.keys(lc), ...Object.keys(rc)]);
      for (const cid of cids) {
        const lb = lc[cid] || {};
        const rb = rc[cid] || {};
        // Tombstones: union (deleted on EITHER side stays deleted everywhere).
        const tomb = new Map();
        for (const d of (lb.deleted || [])) if (d && d.imgId) tomb.set(d.imgId, Math.max(tomb.get(d.imgId) || 0, d.ts || 0));
        for (const d of (rb.deleted || [])) if (d && d.imgId) tomb.set(d.imgId, Math.max(tomb.get(d.imgId) || 0, d.ts || 0));
        // Images: union by imgId; newer modTs wins on conflict (recrop-safe).
        const merged = new Map();
        for (const im of bucketImages(lb)) if (im && im.imgId) merged.set(im.imgId, im);
        for (const im of bucketImages(rb)) {
          if (!im || !im.imgId) continue;
          const cur = merged.get(im.imgId);
          if (!cur) { merged.set(im.imgId, im); continue; }
          if (_imgTs(im) > _imgTs(cur)) merged.set(im.imgId, im);          // remote newer → adopt remote
          else if (_imgTs(cur) > _imgTs(im)) localNewer.push(im.imgId);    // local newer → keep local bytes
        }
        for (const imgId of tomb.keys()) merged.delete(imgId);             // deleted → gone (overrides edits)
        const out = { images: [...merged.values()] };
        if (tomb.size) out.deleted = [...tomb].map(([imgId, ts]) => ({ imgId, ts }));
        lc[cid] = out;
      }
    });
    return { localNewer };
  }
  // Clear the "新着" flag for a character's images (called when the user views them).
  async function markCharSeen(tid, charId) {
    let changed = false;
    await mutateIdx(tid, (idx) => { const b = charBucket(idx, charId); for (const im of b.images) if (im.unseen) { im.unseen = false; changed = true; } });
    if (changed) emit(tid);
    return changed;
  }
  // Set of chapter indices that have ≥1 SCENE image (charId scene_<n>) — lets the
  // Dynamic Timeline mark which chapters have illustrations, so they're findable.
  async function sceneChapters(tid) {
    const out = new Set();
    try {
      const idx = await loadIdx(tid);
      for (const [k, c] of Object.entries(idx.chars || {})) {
        if (!String(k).startsWith('scene_')) continue;
        if (bucketImages(c).length) { const n = parseInt(k.slice(6), 10); if (Number.isFinite(n)) out.add(n); }
      }
    } catch (_) {}
    return out;
  }
  // { chapterIdx: {images, unseen} } for every chapter with scene images — drives the
  // timeline's per-chapter "new picture" (新着) badge + the has-scenes marker.
  async function sceneStatusByChapter(tid) {
    const out = {};
    try {
      const idx = await loadIdx(tid);
      for (const [k, c] of Object.entries(idx.chars || {})) {
        if (!String(k).startsWith('scene_')) continue;
        const n = parseInt(k.slice(6), 10); if (!Number.isFinite(n)) continue;   // 'scene_5' or 'scene_5_2' → 5
        const l = bucketImages(c);
        if (!l.length) continue;
        const cur = out[n] || (out[n] = { images: 0, unseen: 0 });   // SUM across per-slot scene_<n>_<s> buckets
        cur.images += l.length; cur.unseen += l.filter(x => x.unseen).length;
      }
    } catch (_) {}
    return out;
  }
  // Regenerate: a fresh render of this character, optionally with a free-text
  // modification (passed to the server as `modify`). Empty modify = a new variation.
  async function regenerate(tid, rec, modifyText, opts) {
    opts = opts || {};
    const id = await queueCharacter(tid, rec, Object.assign({ force: true, modify: modifyText }, opts));
    if (id == null) return { ok: false, reason: 'queue' };
    return sync(tid);
  }

  // Store a NEW image (from an OpenAI text-edit) into a character's gallery and
  // return its imgId. Kept alongside the source image so the user keeps both.
  let _editSeq = 0;
  async function storeEditedImage(tid, charId, dataUri, info) {
    info = info || {};
    if (!dataUri) return null;
    const imgId = 'oaedit_' + Date.now().toString(36) + (_editSeq = (_editSeq + 1) % 100000).toString(36);
    try { await window.blobStore.set(keptBlobKey(tid, imgId), dataUri); } catch (_) { return null; }
    const now = Date.now();
    await mutateIdx(tid, (idx) => {
      const b = charBucket(idx, charId);
      if (!b.images.some(x => x.imgId === imgId))
        b.images.push({ imgId, jobId: 'oaedit', scene: 1, prompt: info.prompt || '', caption: info.caption || '', charSig: info.charSig || '', model: info.model || '', respId: info.respId || null, backend: 'openai', cropped: false, unseen: true, ts: now, modTs: now });
    });
    emit(tid);
    return imgId;
  }
  // Edit an existing image with a text instruction via the OpenAI Responses API
  // (chains from its respId; falls back to the stored bytes). image must be a
  // getImages() row ({imgId,dataUri,prompt,caption,respId,backend,...}).
  async function editImageEntry(tid, charId, image, instruction) {
    if (!window.aiImageOpenai) return { ok: false, reason: 'no-openai' };
    if (!(await reachable('openai'))) return { ok: false, reason: 'no-key' };
    try {
      const r = await window.aiImageOpenai.editImage(image, instruction, { cfg: oaCfg(), titleId: tid });
      const dataUri = String(r.b64).startsWith('data:') ? r.b64 : ('data:image/png;base64,' + r.b64);
      const imgId = await storeEditedImage(tid, charId, dataUri, {
        prompt: ((image && image.prompt) || '') + (instruction ? (' [編集: ' + instruction + ']') : ''),
        caption: (image && image.caption) || '', respId: r.respId,
      });
      return imgId ? { ok: true, imgId } : { ok: false, reason: 'store' };
    } catch (e) {
      if (e && e._refused) return { ok: false, reason: 'refused', refusalMsg: e.message };
      return { ok: false, reason: 'error', error: (e && e.message) || 'error' };
    }
  }
  // Re-run a character's OpenAI-refused render on the LOCAL server (the refusal
  // fallback the user chose). Flips its terminal 'refused' entries back to
  // pending and submits them to the local backend regardless of the pref.
  async function retryLocal(tid, charId) {
    let any = false;
    await mutateOutbox((o) => { for (const e of o.entries) { if (e.titleId === tid && e.charId === charId && e.status === 'refused') { e.status = 'pending'; e.serverJobId = null; e.backend = 'local'; any = true; } } });   // re-tag so the local sync filter picks it up
    if (!any) return { ok: false, reason: 'none' };
    return sync(tid, { backend: 'local' });
  }

  // ---- read API for the UI --------------------------------------------------------
  async function getImages(tid, charId) {            // [{imgId,dataUri,prompt,caption,unseen,cropped}] newest last
    const idx = await loadIdx(tid);
    const list = bucketImages(idx.chars[charId]);
    if (!list.length) return [];
    const out = [];
    for (const m of list) { const d = await getImageBytes(tid, m.imgId); if (d) out.push({ imgId: m.imgId, dataUri: d, prompt: m.prompt || '', caption: m.caption || '', charSig: m.charSig || '', respId: m.respId || null, backend: m.backend || '', unseen: !!m.unseen, cropped: !!m.cropped }); }
    return out;
  }
  // Persist a caption on an image, and generate one with Claude (grounded ONLY
  // in the character's book-derived info + the actual render prompt) when the
  // image server didn't return its own. Preferred source is the server's
  // `caption` field (the image-making LLM); this is the on-demand fallback.
  async function setCaption(tid, charId, imgId, caption) {
    await mutateIdx(tid, (idx) => { const b = charBucket(idx, charId); const k = b.images.find(x => x.imgId === imgId); if (k) { k.caption = caption || ''; k.modTs = Date.now(); } });
    emit(tid);
  }
  const _captioning = new Set();
  async function generateCaption(tid, charId, imgId, rec, promptText) {
    if (!window.ai || !window.ai.isEnabled || !window.ai.isEnabled()) return { ok: false, reason: 'ai-off' };
    if (_captioning.has(imgId)) return { ok: false, reason: 'busy' };
    _captioning.add(imgId);
    try {
      const card = rec ? cardTextFor(rec) : '';
      const sys = '提供された登場人物の情報は、すべて作品本文に基づくものです。その情報「だけ」を使って、' +
        '生成された画像を説明する短いキャプションを日本語で1〜2文書いてください。外見・服装・場所・状況は' +
        '本文に忠実に。本文にない設定を創作しないこと。登場人物の名前を必ず含めること。' +
        '箇条書きやマークダウン記法は使わないこと。';
      const user = card + (promptText ? ('\n\n（画像生成プロンプト・参考。本文と矛盾する点は無視）:\n' + promptText) : '') +
        '\n\nこの画像のキャプション:';
      const r = await window.ai.request({ feature: 'img-caption', titleId: tid, system: sys, maxTokens: 240, messages: [{ role: 'user', content: user }] });
      const cap = ((r && r.text) || '').trim();
      if (cap) await setCaption(tid, charId, imgId, cap);
      return { ok: !!cap, caption: cap };
    } catch (e) { return { ok: false, reason: (e && e.message) || 'error' }; }
    finally { _captioning.delete(imgId); }
  }
  async function counts(tid) {                        // {images, unseen, pending} — CHARACTER images only
    const idx = await loadIdx(tid);
    let images = 0, unseen = 0;
    // Scene buckets (scene_<chapterIdx>) live in the same index but belong to the
    // timeline, not the Characters screen (this fn's only caller) — exclude them.
    for (const [k, c] of Object.entries(idx.chars || {})) {
      if (String(k).startsWith('scene_')) continue;
      const l = bucketImages(c); images += l.length; unseen += l.filter(x => x.unseen).length;
    }
    const o = await loadOutbox();
    const pending = o.entries.filter(e => e.titleId === tid && !String(e.charId || '').startsWith('scene_') && (e.status === 'pending' || e.status === 'submitted')).length;
    return { images, unseen, pending };
  }
  async function statusFor(tid, charId) {             // per-card
    const idx = await loadIdx(tid);
    const l = bucketImages(idx.chars[charId]);
    const o = await loadOutbox();
    const act = o.entries.filter(e => e.titleId === tid && e.charId === charId && (e.status === 'pending' || e.status === 'submitted'));
    return { images: l.length, unseen: l.filter(x => x.unseen).length, pending: act.length };
  }
  // Batched status for many ids in ONE idx + ONE outbox read (the daily scheduler
  // would otherwise do 2 IndexedDB reads per character/scene per scan). Includes a
  // `refused` count so the scheduler can skip subjects that already refused.
  async function statusBatch(tid, ids) {
    const idx = await loadIdx(tid);
    const o = await loadOutbox();
    const out = {};
    for (const id of (ids || [])) {
      const l = bucketImages(idx.chars[id]);
      const ent = o.entries.filter(e => e.titleId === tid && e.charId === id);
      out[id] = {
        images: l.length,
        unseen: l.filter(x => x.unseen).length,
        pending: ent.filter(e => e.status === 'pending' || e.status === 'submitted').length,
        refused: ent.filter(e => e.status === 'refused' || e.status === 'error').length,
      };
    }
    return out;
  }

  function emit(titleId) { try { window.dispatchEvent(new CustomEvent('kai:img-data', { detail: { titleId: titleId || window._activeTitleId || null } })); } catch (_) {} }

  // =================================================================================
  //  UI builders (shared by the Characters screen + popup)
  // =================================================================================
  function el(tag, css, txt) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }

  // Make a full-screen overlay a TRUE modal for gestures: nothing that happens
  // on it leaks to the app behind (card swipe→Anki, replay, reader physics).
  //  • class 'kai-modal' → app.js inModal() makes the card-gesture handler bail.
  //  • touch-action/overscroll → no background scroll/pan/zoom through it.
  //  • BUBBLE-phase stopPropagation on touch+pointer → the overlay's own inner
  //    handlers still run (they're deeper, fire first), but the event never
  //    reaches the document-level swipe handlers above it. (Capture is left
  //    alone so taps still reach the overlay's buttons.)
  function shieldOverlay(ov) {
    try {
      ov.classList.add('kai-modal');
      ov.style.touchAction = 'none';
      ov.style.overscrollBehavior = 'contain';
      const stop = (e) => { e.stopPropagation(); };
      ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointermove'].forEach(t => ov.addEventListener(t, stop));
    } catch (_) {}
  }

  // Caption text, book-grounded. The character's NAME is shown with furigana
  // when the book has a reading (it usually does, but NOT always — so this is
  // conditional). The whole caption is dict-tappable, and class 'kai-summary-text'
  // lets the character-name squiggle poll mark names (tap → character popup).
  function buildCaptionEl(caption, rec) {
    // A labelled block: a small "画像キャプション" header tells the reader this is an
    // image caption (not body text), with the caption itself just under card size.
    // (Colour lives on the wrapper so callers — e.g. the fullscreen viewer — can
    // brighten the whole caption by setting the returned element's color.)
    const wrapEl = el('div', 'margin-top:8px;color:#cdd;');
    wrapEl.appendChild(el('div', 'font-size:calc(var(--font-size-card, 1rem) * 0.6);color:#8a93b8;letter-spacing:.08em;margin-bottom:3px;opacity:.9;', window.i18n.t('im.image_caption_label', 'Image caption')));
    const box = el('div', 'font-size:calc(var(--font-size-card, 1rem) * 0.82);line-height:1.5;font-family:var(--font-family-card);white-space:pre-wrap;');
    box.className = 'kai-summary-text';
    box.dataset.dictLazy = '1';
    const reading = rec && (rec.rubyReading || rec.standardReading);
    const surface = rec && rec.surface;
    const at = (surface && reading && reading !== surface) ? caption.indexOf(surface) : -1;
    if (at >= 0) {
      box.appendChild(document.createTextNode(caption.slice(0, at)));
      const ruby = document.createElement('ruby'); ruby.textContent = surface;
      const rt = document.createElement('rt'); rt.style.cssText = 'font-size:.6em;color:#aab;'; rt.textContent = reading;
      ruby.appendChild(rt); box.appendChild(ruby);
      box.appendChild(document.createTextNode(caption.slice(at + surface.length)));
    } else {
      box.textContent = caption;
    }
    try { if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(box); } catch (_) {}
    wrapEl.appendChild(box);
    return wrapEl;
  }

  // Fullscreen gallery: SWIPE horizontally between a character's images, and
  // PINCH-zoom the current image → confirm to crop to that view. Shielded so
  // gestures don't leak to the app behind.
  //   list = [{imgId,dataUri,caption,...}], startIdx, opts = {rec, titleId,
  //   charId, interactive, onChange}.  Back-compat: a single dataUri string works.
  function openLightbox(list, startIdx, opts) {
    opts = opts || {};
    if (typeof list === 'string') list = [{ dataUri: list, caption: (opts && opts.caption) || '' }];
    if (!Array.isArray(list) || !list.length) return;
    let idx = Math.max(0, Math.min(startIdx || 0, list.length - 1));
    const canCrop = !!(opts.interactive && opts.titleId && opts.charId);

    const ov = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.93);z-index:9700;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;box-sizing:border-box;');
    shieldOverlay(ov);
    const stage = el('div', 'position:relative;overflow:hidden;border-radius:8px;background:#0c0c12;touch-action:none;');
    const img = el('img', 'position:absolute;left:0;top:0;object-fit:contain;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-drag:none;pointer-events:none;');
    // Second image: the neighbor that peeks/slides in during a swipe (carousel).
    const slideImg = el('img', 'position:absolute;left:0;top:0;object-fit:contain;will-change:transform;user-select:none;-webkit-user-drag:none;pointer-events:none;display:none;');
    stage.appendChild(img);
    stage.appendChild(slideImg);
    ov.appendChild(stage);

    const closeBtn = el('button', 'position:absolute;top:calc(12px + env(safe-area-inset-top,0px));left:12px;z-index:5;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.28);color:#fff;font-size:1.5rem;width:48px;height:48px;border-radius:50%;cursor:pointer;line-height:46px;text-align:center;padding:0;-webkit-tap-highlight-color:transparent;', '✕');
    const counter = el('div', 'position:absolute;top:18px;right:16px;z-index:3;background:rgba(0,0,0,.5);color:#fff;font-size:.74rem;padding:3px 10px;border-radius:9px;');
    const prevBtn = el('button', 'position:absolute;top:50%;left:8px;transform:translateY(-50%);z-index:3;background:rgba(0,0,0,.5);border:none;color:#fff;font-size:1.7rem;width:44px;height:44px;border-radius:50%;cursor:pointer;line-height:1;', '‹');
    const nextBtn = el('button', 'position:absolute;top:50%;right:8px;transform:translateY(-50%);z-index:3;background:rgba(0,0,0,.5);border:none;color:#fff;font-size:1.7rem;width:44px;height:44px;border-radius:50%;cursor:pointer;line-height:1;', '›');
    const dots = el('div', 'position:absolute;bottom:14px;left:0;right:0;z-index:3;display:flex;gap:6px;justify-content:center;pointer-events:none;');
    const hint = el('div', 'position:absolute;bottom:30px;left:0;right:0;z-index:3;text-align:center;color:#cbd;font-size:.7rem;pointer-events:none;opacity:.85;');
    const capWrap = el('div', 'max-width:660px;text-align:center;max-height:24vh;overflow-y:auto;padding:0 10px;-webkit-overflow-scrolling:touch;');
    [closeBtn, counter, prevBtn, nextBtn, dots, hint].forEach(n => ov.appendChild(n));
    ov.appendChild(capWrap);

    // Crop-confirm bar — appears once a pinch-zoom ends (interactive only).
    const cropBar = el('div', 'position:absolute;bottom:0;left:0;right:0;z-index:4;display:none;gap:12px;justify-content:center;padding:14px;background:linear-gradient(transparent,rgba(0,0,0,.88));');
    const cropOk = el('button', 'background:#2a2440;border:1px solid #5a4a8a;border-radius:9px;color:#dcd0ff;font-size:.9rem;padding:9px 22px;cursor:pointer;', window.i18n.t('im.crop_to_view', 'Crop to this view'));
    const cropCancel = el('button', 'background:#222;border:1px solid #444;border-radius:9px;color:#ccc;font-size:.9rem;padding:9px 20px;cursor:pointer;', window.i18n.t('common.cancel', 'Cancel'));
    cropBar.appendChild(cropCancel); cropBar.appendChild(cropOk); ov.appendChild(cropBar);

    let dispW = 0, dispH = 0, S = 1, tx = 0, ty = 0;
    const applyT = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + S + ')'; };
    const clampT = () => {
      const minTx = Math.min(0, dispW - dispW * S), minTy = Math.min(0, dispH - dispH * S);
      tx = Math.max(minTx, Math.min(0, tx)); ty = Math.max(minTy, Math.min(0, ty));
    };
    const resetZoom = () => { S = 1; tx = 0; ty = 0; applyT(); cropBar.style.display = 'none'; };
    const fit = () => {
      const natW = img.naturalWidth || 1, natH = img.naturalHeight || 1;
      const f = Math.min((window.innerWidth * 0.96) / natW, (window.innerHeight * 0.72) / natH, 1);
      dispW = Math.max(1, Math.round(natW * f)); dispH = Math.max(1, Math.round(natH * f));
      stage.style.width = dispW + 'px'; stage.style.height = dispH + 'px';
      img.style.width = dispW + 'px'; img.style.height = dispH + 'px';
      slideImg.style.width = dispW + 'px'; slideImg.style.height = dispH + 'px';
      slideImg.style.display = 'none'; slideImg.style.transition = 'none';
      resetZoom();
      sliding = false;                 // the swap (or initial/recrop load) has landed → re-enable input
    };
    const updateInfo = () => {
      const multi = list.length > 1;
      counter.style.display = multi ? '' : 'none';
      // Bounded (non-circular) navigation: no left arrow on the first image, no
      // right arrow on the last — so it reads as "back and forth", not a loop.
      prevBtn.style.display = (multi && idx > 0) ? '' : 'none';
      nextBtn.style.display = (multi && idx < list.length - 1) ? '' : 'none';
      counter.textContent = (idx + 1) + ' / ' + list.length;
      dots.innerHTML = '';
      if (multi) list.forEach((_, k) => dots.appendChild(el('span', 'width:7px;height:7px;border-radius:50%;background:' + (k === idx ? '#fff' : 'rgba(255,255,255,.4)') + ';')));
      capWrap.innerHTML = '';
      const cap = list[idx].caption;
      if (cap) { const c = buildCaptionEl(cap, opts.rec); c.style.color = '#e6e6ee'; capWrap.appendChild(c); try { window.aiCharsUi && window.aiCharsUi.markNow(c); } catch (_) {} }
      hint.textContent = canCrop ? window.i18n.t('im.hint_pinch_swipe', 'Pinch to zoom → "Crop" · Swipe for next image') : (multi ? window.i18n.t('im.hint_swipe_next', 'Swipe for next image') : '');
    };
    const show = (k) => { idx = Math.max(0, Math.min(k, list.length - 1)); cropBar.style.display = 'none'; img.src = list[idx].dataUri; updateInfo(); };   // clamp, no wrap
    img.onload = fit;
    img.onerror = fit;                 // never strand slideImg / leave `sliding` stuck if a src fails to load

    // ---- swipe carousel: the neighbor image peeks in following the finger ----
    let sliding = false, slideTimer = null;
    const setupPeek = (dir) => {                     // dir: +1 next, -1 prev
      const nIdx = idx + dir;
      if (nIdx < 0 || nIdx >= list.length) return false;   // edge: no neighbor (no wrap)
      slideImg.src = list[nIdx].dataUri; slideImg.style.display = 'block'; slideImg.style.transition = 'none';
      return true;
    };
    const finishSlide = (dir) => {                   // commit to the neighbor with a slide
      if (sliding) return;
      const nIdx = idx + dir;
      if (nIdx < 0 || nIdx >= list.length) { cancelSlide(dir); return; }   // no wrap past the ends
      sliding = true;
      if (slideImg.style.display === 'none') { slideImg.src = list[nIdx].dataUri; slideImg.style.display = 'block'; slideImg.style.transition = 'none'; slideImg.style.transform = 'translate(' + (dir * dispW) + 'px,0)'; void slideImg.offsetWidth; }
      img.style.transition = slideImg.style.transition = 'transform .18s ease-out';
      img.style.transform = 'translate(' + (-dir * dispW) + 'px,0)';
      slideImg.style.transform = 'translate(0,0)';
      let fired = false;
      const finalize = () => {
        if (fired) return; fired = true;
        img.removeEventListener('transitionend', finalize);
        idx = nIdx; cropBar.style.display = 'none';
        img.style.transition = 'none';
        img.style.transform = 'translate(0,0) scale(1)';
        img.src = list[idx].dataUri;                 // onload→fit resizes, resets zoom, hides slideImg, clears `sliding`
        // slideImg (the new image, on top) stays visible until the new img.src
        // lands → fit() reveals img. Hiding it here would re-expose the OLD
        // (slid-away) image under it for a frame = the "jitter"/flash. `sliding`
        // also stays true until fit() so a fast re-swipe can't race the pending load.
        if (img.complete && img.naturalWidth) fit();   // cached/identical src won't refire onload → land it now
        updateInfo();
      };
      img.addEventListener('transitionend', finalize);
      setTimeout(finalize, 260);                      // fallback if transitionend is missed
    };
    const cancelSlide = (dir) => {                   // not far enough → snap back
      img.style.transition = slideImg.style.transition = 'transform .15s ease-out';
      img.style.transform = 'translate(0,0)';
      slideImg.style.transform = 'translate(' + (dir * dispW) + 'px,0)';
      clearTimeout(slideTimer);
      slideTimer = setTimeout(() => { slideImg.style.display = 'none'; slideImg.style.transition = 'none'; img.style.transition = 'none'; applyT(); }, 165);
    };

    const close = () => { try { ov.remove(); } catch (_) {} };
    // Android WebView synthesizes a `click` shortly after a closing TAP's pointerup;
    // with `ov` already removed it lands on the inline image behind and REOPENS the
    // viewer (image flashes away then back). Swallow exactly that one ghost click.
    // iOS suppresses the ghost click itself and is perfect — so this is a no-op there
    // and its close path is left entirely unchanged.
    const swallowGhostClick = () => {
      if (window.Capacitor?.getPlatform?.() !== 'android') return;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); cleanup(); };
      const cleanup = () => { try { document.removeEventListener('click', swallow, true); } catch (_) {} clearTimeout(t); };
      document.addEventListener('click', swallow, true);
      const t = setTimeout(cleanup, 350);   // fallback if no ghost click arrives
    };
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); show(idx - 1); });
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); show(idx + 1); });
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    // ---- gestures: pinch-zoom / pan (when zoomed) / swipe (when not) -------
    const pts = new Map();
    let pinch = null, pan = null, swipe = null;
    const localOf = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };
    stage.addEventListener('pointerdown', (e) => {
      if (sliding) return;                            // ignore input during a slide animation
      clearTimeout(slideTimer);                       // a pending snap-back cleanup must not fire mid-gesture
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const mid = localOf((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, S, ipx: (mid.x - tx) / S, ipy: (mid.y - ty) / S };
        pan = swipe = null;
      } else if (pts.size === 1) {
        if (S > 1) pan = { x: e.clientX, y: e.clientY, tx, ty };
        else swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const nd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = localOf((a.x + b.x) / 2, (a.y + b.y) / 2);
        S = Math.max(1, Math.min(6, pinch.S * (nd / pinch.d)));
        tx = mid.x - pinch.ipx * S; ty = mid.y - pinch.ipy * S; clampT(); applyT();
      } else if (pan) { tx = pan.tx + (e.clientX - pan.x); ty = pan.ty + (e.clientY - pan.y); clampT(); applyT(); }
      else if (swipe) {
        const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
        // Single image: NEVER translate (else you reveal a blank neighbor). Multi:
        // claim the horizontal axis only once the move is clearly sideways — so a
        // tap or a vertical drift never nudges the image (that nudge read as a "flash").
        if (list.length > 1) {
          if (!swipe.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) swipe.axis = (Math.abs(dx) > Math.abs(dy)) ? 'h' : 'v';
          if (swipe.axis === 'h') {
            const dir = dx < 0 ? 1 : -1;
            if (idx + dir >= 0 && idx + dir < list.length) {     // neighbor exists → follow finger + peek it in
              img.style.transition = 'none'; img.style.transform = 'translate(' + dx + 'px,0)';   // current follows finger
              if (swipe.dir !== dir) { swipe.dir = dir; setupPeek(dir); }   // neighbor for this direction
              slideImg.style.transition = 'none';
              slideImg.style.transform = 'translate(' + (dx + dir * dispW) + 'px,0)';            // peeks in alongside
            }
            // else: at the first/last image, an outward swipe does nothing (no wrap, no blank reveal)
          }
        }
      }
    });
    const onUp = (e) => {
      pts.delete(e.pointerId);
      if (pinch && pts.size < 2) {
        pinch = null;
        // Promote a still-down finger to a pan so it isn't stranded; flag it so
        // its eventual lift isn't mistaken for a reset-tap.
        if (pts.size === 1 && S > 1) { const r = [...pts.values()][0]; pan = { x: r.x, y: r.y, tx, ty, fromPinch: true }; }
      }
      if (pts.size === 0) {
        if (swipe) {
          const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
          if (swipe.dir == null && Math.abs(dx) < 24 && Math.abs(dy) < 24) { swallowGhostClick(); close(); }   // genuine tap (no peek started) → close full screen
          else if (swipe.dir != null) {                                        // a neighbor was peeked → commit or snap back
            const elapsed = Math.max(1, Date.now() - (swipe.t || 0));
            const consistent = (swipe.dir === 1 && dx < 0) || (swipe.dir === -1 && dx > 0);   // released in the peeked direction
            const far = Math.abs(dx) > dispW * 0.12;                           // shorter swipes commit (was .22)
            const flick = elapsed < 260 && Math.abs(dx) > 30;                  // …or a quick flick
            if (consistent && (far || flick) && Math.abs(dx) > Math.abs(dy) * 1.1) finishSlide(swipe.dir);
            else cancelSlide(swipe.dir);                                       // not far/fast enough, or reversed → snap back
          }
          else { img.style.transition = 'none'; applyT(); }                    // no peek happened (edge/near-tap) → reset (image hasn't moved)
        } else if (pan && !pan.fromPinch) {
          const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
          if (Math.abs(dx) < 16 && Math.abs(dy) < 16 && S > 1) resetZoom();     // tap while zoomed → un-zoom (then a tap closes)
        }
        if (S > 1 && canCrop) cropBar.style.display = 'flex';                   // zoomed → offer "crop to this view"
        swipe = pan = null;
      }
    };
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);

    cropCancel.addEventListener('click', (e) => { e.stopPropagation(); resetZoom(); });
    cropOk.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // The visible window in display coords → natural coords → canvas crop.
        let x = -tx / S, y = -ty / S, w = dispW / S, h = dispH / S;
        x = Math.max(0, Math.min(x, dispW)); y = Math.max(0, Math.min(y, dispH));
        w = Math.min(w, dispW - x); h = Math.min(h, dispH - y);
        const ratio = (img.naturalWidth || dispW) / dispW;
        const cx = Math.round(x * ratio), cy = Math.round(y * ratio), cw = Math.max(1, Math.round(w * ratio)), ch = Math.max(1, Math.round(h * ratio));
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
        const out = cv.toDataURL('image/png');
        cropBar.style.display = 'none';
        await recropImage(opts.titleId, opts.charId, list[idx].imgId, out);
        list[idx].dataUri = out;                 // reflect immediately in the gallery
        resetZoom(); img.src = out;
        if (opts.onChange) opts.onChange();
      } catch (_) { resetZoom(); }
    });

    show(idx);
    document.body.appendChild(ov);
  }

  // The character's image gallery: big image, prev/next when >1, a "新着" badge on
  // not-yet-viewed images, and (interactive) crop / regenerate / delete. Pass
  // opts.rec to enable regenerate (with a free-text modification), opts.onChange
  // to react to edits. Returns immediately; fills + reloads asynchronously.
  function buildImageStrip(titleId, charId, opts) {
    opts = opts || {};
    const wrap = el('div', 'margin:2px 0 4px;');
    let imgs = [], i = 0, regenOpen = false, regenText = '', lastSwipe = 0;
    let scenePromptText = (typeof opts.editablePrompt === 'string') ? opts.editablePrompt : '';   // editable scene prompt (scenes only)
    const TOOL = 'flex:1;background:#1b1b26;border:1px solid #34344a;border-radius:8px;color:#bcd;font-size:.74rem;padding:7px 0;cursor:pointer;';
    const seen = () => { if (opts.interactive) { try { markCharSeen(titleId, charId); } catch (_) {} } };
    const buildRegenBox = () => {
      const curImg = imgs[i];                                   // the image an OpenAI text-edit acts on
      const canEdit = backend() === 'openai' && !!curImg;       // OpenAI + an existing image → edit it with text
      const box = el('div', 'margin-top:8px;background:#14101e;border:1px solid #34344a;border-radius:10px;padding:10px;');
      box.appendChild(el('div', 'font-size:.68rem;color:#9a8cc4;margin-bottom:6px;', canEdit ? window.i18n.t('im.edit_text_variation', 'Edit with text — leave blank for a different variation') : window.i18n.t('im.change_optional_variation', 'What to change (optional) — leave blank for a different variation')));
      const ta = el('textarea', 'width:100%;box-sizing:border-box;background:#1c1c28;border:1px solid #3a3450;border-radius:8px;color:#ddd;font-size:.8rem;padding:8px;resize:vertical;min-height:44px;font-family:inherit;');
      ta.placeholder = window.i18n.t('im.regen_placeholder', 'e.g. longer hair / add glasses / darker background / smiling');
      ta.value = regenText;
      ta.addEventListener('input', () => { regenText = ta.value; });
      ta.addEventListener('click', (e) => e.stopPropagation());
      box.appendChild(ta);
      const row = el('div', 'display:flex;gap:8px;margin-top:8px;align-items:center;');
      const send = el('button', 'background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;font-size:.78rem;padding:7px 16px;cursor:pointer;', window.i18n.t('common.generate', 'Generate'));
      const st = el('span', 'font-size:.68rem;color:#888;');
      send.addEventListener('click', async (e) => {
        e.stopPropagation(); send.disabled = true; st.textContent = window.i18n.t('im.sending', 'Sending…');
        try {
          const text = (regenText || '').trim();
          let r;
          if (canEdit && text) r = await editImageEntry(titleId, charId, curImg, text);   // OpenAI: edit THIS image (respId chain → bytes fallback)
          else r = await regenerate(titleId, opts.rec, regenText);                          // local server, or a fresh OpenAI variation
          if (!r || r.ok === false) {
            st.textContent = (r && r.reason === 'unreachable') ? window.i18n.t('im.cannot_connect_server', 'Cannot connect to the server')
              : (r && r.reason === 'no-key') ? window.i18n.t('im.openai_key_needed', 'OpenAI API key required (Settings)')
              : (r && r.reason === 'rate-limited') ? window.i18n.t('im.busy_queued_retry', 'Busy — queued (will retry automatically)')
              : (r && r.error) ? window.i18n.fmt('im.failed_reason', { reason: String(r.error).slice(0, 70) })
              : (r && r.reason === 'refused') ? window.i18n.t('im.openai_declined', 'OpenAI declined the request') : window.i18n.t('im.send_failed', 'Send failed');
          } else {
            st.textContent = (canEdit && text) ? window.i18n.t('im.edited', 'Edited')
              : (r.ingested ? window.i18n.fmt('im.images_received', { n: r.ingested }) : (r.pending ? window.i18n.t('im.queued_in_order', 'Queued… (generating in order)') : window.i18n.t('im.waiting_to_generate', 'Waiting to generate… (shown when ready)')));
            regenText = ''; regenOpen = false; await reload();
          }
        } catch (_) { st.textContent = window.i18n.t('common.error', 'Error'); }
        finally { send.disabled = false; if (opts.onChange) opts.onChange(); }
      });
      const cancel = el('button', 'background:none;border:1px solid #333;border-radius:8px;color:#999;font-size:.78rem;padding:7px 12px;cursor:pointer;', window.i18n.t('common.close', 'Close'));
      cancel.addEventListener('click', (e) => { e.stopPropagation(); regenOpen = false; render(); });
      row.appendChild(send); row.appendChild(cancel); row.appendChild(st);
      box.appendChild(row);
      return box;
    };
    // Scene regenerate: an editable PROMPT box (pre-filled with the scene's current
    // prompt) so the user can alter it before regenerating. The host (opts.onRegenerate)
    // persists the edit + queues + reloads.
    const buildScenePromptBox = () => {
      const box = el('div', 'margin-top:8px;background:#14101e;border:1px solid #34344a;border-radius:10px;padding:10px;');
      box.appendChild(el('div', 'font-size:.68rem;color:#9a8cc4;margin-bottom:6px;', window.i18n.t('im.edit_prompt_regen', 'Edit prompt & regenerate')));
      const ta = el('textarea', 'width:100%;box-sizing:border-box;background:#1c1c28;border:1px solid #3a3450;border-radius:8px;color:#ddd;font-size:.8rem;padding:8px;resize:vertical;min-height:88px;font-family:inherit;');
      ta.value = scenePromptText;
      ta.addEventListener('input', () => { scenePromptText = ta.value; });
      ta.addEventListener('click', (e) => e.stopPropagation());
      box.appendChild(ta);
      const row = el('div', 'display:flex;gap:8px;margin-top:8px;align-items:center;');
      const send = el('button', 'background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;font-size:.78rem;padding:7px 16px;cursor:pointer;', window.i18n.t('common.regenerate', 'Regenerate'));
      const st = el('span', 'font-size:.68rem;color:#888;');
      send.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = (scenePromptText || '').trim();
        if (!text) { st.textContent = window.i18n.t('im.enter_prompt', 'Please enter a prompt'); return; }
        send.disabled = true; st.textContent = window.i18n.t('im.sending', 'Sending…');
        try { regenOpen = false; await opts.onRegenerate(text); }   // host persists + queues + reloads (closes the box)
        catch (_) { st.textContent = window.i18n.t('common.error', 'Error'); }
        finally { send.disabled = false; }
      });
      const cancel = el('button', 'background:none;border:1px solid #333;border-radius:8px;color:#999;font-size:.78rem;padding:7px 12px;cursor:pointer;', window.i18n.t('common.close', 'Close'));
      cancel.addEventListener('click', (e) => { e.stopPropagation(); regenOpen = false; render(); });
      row.appendChild(send); row.appendChild(cancel); row.appendChild(st);
      box.appendChild(row);
      return box;
    };
    const render = () => {
      wrap.innerHTML = '';
      if (!imgs.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      if (i >= imgs.length) i = imgs.length - 1;
      const cur = imgs[i];
      // touch-action:pan-y → the browser owns vertical card-scroll natively (smooth,
      // off the main thread) and hands us the horizontal axis cleanly, so a swipe
      // never fights the scroller. will-change:transform on the images promotes them
      // to compositor layers so the drag/slide is GPU-composited — exactly what makes
      // the fullscreen viewer smooth. Without these the inline swipe was jerky.
      const frame = el('div', 'position:relative;width:100%;border-radius:12px;overflow:hidden;background:#0c0c12;touch-action:pan-y;');
      const img = el('img', 'display:block;width:100%;max-height:48vh;object-fit:contain;background:#0c0c12;cursor:pointer;-webkit-tap-highlight-color:transparent;will-change:transform;');
      img.src = cur.dataUri;
      // Tap → fullscreen gallery (swipe between images, pinch-zoom → crop).
      // Suppressed right after a horizontal swipe so a swipe doesn't also open it.
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() - lastSwipe < 350) return;
        seen();
        openLightbox(imgs, i, { rec: opts.rec, titleId, charId, interactive: opts.interactive, onChange: () => { if (opts.onChange) opts.onChange(); reload(); } });
      });
      frame.appendChild(img);
      // Horizontal swipe between images (in addition to the ‹ › arrows), with a
      // finger-following carousel: the current image tracks the finger and the
      // neighbor peeks in alongside; release commits with a slide or snaps back.
      // Only claims the gesture once it's clearly horizontal (vertical card
      // scroll still works).
      let commitTo = null;   // smooth slide-to-neighbor; shared by swipe + ‹ › arrows
      if (imgs.length > 1) {
        const slide = el('img', 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:#0c0c12;display:none;pointer-events:none;will-change:transform;');
        frame.appendChild(slide);
        let sx = 0, sy = 0, st0 = 0, tracking = false, decided = false, dir = 0, fw = 1, animating = false;
        // Slide to the neighbor in direction d (-1 prev / +1 next) then re-render at the
        // new index. NON-circular (clamped, no wrap) + smooth — matches the fullscreen
        // viewer so inline + fullscreen scroll identically.
        commitTo = (d) => {
          if (animating) return;
          const ni = i + d;
          if (ni < 0 || ni >= imgs.length) return;   // no wrap past the ends
          animating = true; lastSwipe = Date.now(); seen();
          const w = frame.clientWidth || fw || 1;
          slide.src = imgs[ni].dataUri;
          slide.style.display = 'block'; slide.style.transition = 'none';
          slide.style.transform = 'translate(' + (d * w) + 'px,0)';
          void slide.offsetWidth;
          img.style.transition = slide.style.transition = 'transform .18s ease-out';
          img.style.transform = 'translate(' + (-d * w) + 'px,0)';
          slide.style.transform = 'translate(0,0)';
          setTimeout(() => { i = ni; render(); }, 190);
        };
        frame.addEventListener('touchstart', (e) => { if (animating || e.touches.length !== 1) { tracking = false; return; } sx = e.touches[0].clientX; sy = e.touches[0].clientY; st0 = Date.now(); tracking = true; decided = false; dir = 0; fw = frame.clientWidth || 1; }, { passive: true });
        frame.addEventListener('touchmove', (e) => {
          if (!tracking || e.touches.length !== 1) return;
          const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
          if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { decided = true; if (Math.abs(dy) >= Math.abs(dx)) tracking = false; }
          if (!tracking || !decided) return;
          e.preventDefault();   // we own the horizontal axis
          const nd = dx < 0 ? 1 : -1;
          if (i + nd < 0 || i + nd >= imgs.length) return;   // at the first/last image → no wrap, no drag/peek
          img.style.transition = 'none'; img.style.transform = 'translate(' + dx + 'px,0)';
          if (dir !== nd) { dir = nd; slide.src = imgs[i + nd].dataUri; slide.style.display = 'block'; }
          slide.style.transition = 'none'; slide.style.transform = 'translate(' + (dx + nd * fw) + 'px,0)';
        }, { passive: false });
        frame.addEventListener('touchend', (e) => {
          if (!tracking || !decided) return;
          tracking = false;
          const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : sx) - sx;
          const elapsed = Math.max(1, Date.now() - st0);
          const consistent = (dir === 1 && dx < 0) || (dir === -1 && dx > 0);
          const far = Math.abs(dx) > fw * 0.12;                // shorter swipes commit (was .22) — matches fullscreen
          const flick = elapsed < 260 && Math.abs(dx) > 30;    // …or a quick flick
          if (dir !== 0 && consistent && (far || flick)) {
            commitTo(dir);
          } else if (dir !== 0) {                              // snap back
            img.style.transition = slide.style.transition = 'transform .15s ease-out';
            img.style.transform = 'translate(0,0)';
            slide.style.transform = 'translate(' + (dir * fw) + 'px,0)';
            setTimeout(() => { slide.style.display = 'none'; slide.style.transition = img.style.transition = 'none'; img.style.transform = ''; }, 160);
          }
        }, { passive: true });
      }
      if (imgs.length > 1) {
        const mk = (txt, d) => { const b = el('button', 'position:absolute;top:50%;transform:translateY(-50%);' + (d < 0 ? 'left:6px;' : 'right:6px;') + 'background:rgba(0,0,0,.5);border:none;color:#fff;font-size:1.3rem;width:36px;height:36px;border-radius:50%;cursor:pointer;line-height:1;', txt); b.addEventListener('click', (e) => { e.stopPropagation(); if (commitTo) commitTo(d); }); return b; };
        if (i > 0) frame.appendChild(mk('‹', -1));                 // non-circular: no ‹ on the first image
        if (i < imgs.length - 1) frame.appendChild(mk('›', 1));    // …no › on the last
        const dots = el('div', 'position:absolute;bottom:7px;left:0;right:0;display:flex;gap:5px;justify-content:center;');
        imgs.forEach((im, k) => dots.appendChild(el('span', 'width:6px;height:6px;border-radius:50%;background:' + (k === i ? '#fff' : 'rgba(255,255,255,.4)') + ';')));
        frame.appendChild(dots);
        frame.appendChild(el('div', 'position:absolute;top:7px;right:9px;background:rgba(0,0,0,.5);color:#fff;font-size:.64rem;padding:1px 7px;border-radius:8px;', (i + 1) + ' / ' + imgs.length));
      }
      wrap.appendChild(frame);
      // Controls RIGHT under the image (regenerate + delete). No crop.
      if (opts.interactive) {
        const cur2 = imgs[i];
        const bar = el('div', 'display:flex;gap:8px;margin-top:8px;');
        if (opts.rec) {
          // Character: "画像を更新" = re-render from the card (opens the modify box).
          // Glows amber when the card changed since the picture (stale).
          const stale = !!(cur2.charSig && cur2.charSig !== sigOf(cardTextFor(opts.rec)));
          const upd = el('button', TOOL + (stale ? 'border-color:#c8a23a;color:#ffe6a0;box-shadow:0 0 0 1px #c8a23a;' : ''), window.i18n.t('im.update_picture', 'Update picture'));
          upd.addEventListener('click', (e) => { e.stopPropagation(); seen(); regenOpen = !regenOpen; render(); });
          bar.appendChild(upd);
        } else if (typeof opts.onRegenerate === 'function') {
          // Scene: "再生成" opens an editable prompt box (the host persists + regenerates).
          // Falls back to a direct regen if no editable prompt was supplied. The "…" signals
          // the editable-prompt box opens (vs. an immediate regenerate).
          const opensEditor = (typeof opts.editablePrompt === 'string');
          const rg = el('button', TOOL, opensEditor ? window.i18n.t('im.regen_open', 'Regenerate…') : window.i18n.t('common.regenerate', 'Regenerate'));
          if (opensEditor) {
            rg.addEventListener('click', (e) => { e.stopPropagation(); seen(); regenOpen = !regenOpen; render(); });
          } else {
            rg.addEventListener('click', async (e) => { e.stopPropagation(); seen(); rg.disabled = true; try { await opts.onRegenerate(); } catch (_) {} finally { rg.disabled = false; } });
          }
          bar.appendChild(rg);
        }
        const del = el('button', 'flex:1;background:#241a1a;border:1px solid #5a3a3a;border-radius:8px;color:#d99;font-size:.74rem;padding:7px 0;cursor:pointer;', window.i18n.t('common.delete', 'Delete'));
        del.addEventListener('click', async (e) => { e.stopPropagation(); seen(); await deleteImage(titleId, charId, cur2.imgId); await reload(); if (opts.onChange) opts.onChange(); });
        bar.appendChild(del);
        wrap.appendChild(bar);
        if (regenOpen && opts.rec) wrap.appendChild(buildRegenBox());
        else if (regenOpen && !opts.rec && typeof opts.onRegenerate === 'function' && typeof opts.editablePrompt === 'string') wrap.appendChild(buildScenePromptBox());
      }
      // Caption (book-grounded) — BELOW the controls. Suppressed when the host already
      // shows it (scene rows render the caption above the strip → opts.hideCaption).
      if (!opts.hideCaption) {
        if (cur.caption) {
          const cap = buildCaptionEl(cur.caption, opts.rec);
          wrap.appendChild(cap);
          try { window.aiCharsUi && window.aiCharsUi.markNow(cap); } catch (_) {}   // squiggle names now, not on next poll
        } else if (opts.interactive && opts.rec && window.ai && window.ai.isEnabled && window.ai.isEnabled()) {
          const capRow = el('div', 'margin-top:8px;');
          const cb = el('button', 'background:none;border:1px solid #2e2e44;border-radius:8px;color:#9aa3cc;font-size:.72rem;padding:5px 12px;cursor:pointer;', window.i18n.t('im.generate_caption', 'Generate caption'));
          const cst = el('span', 'font-size:.66rem;color:#888;margin-left:8px;');
          cb.addEventListener('click', async (e) => {
            e.stopPropagation(); seen(); cb.disabled = true; cst.textContent = window.i18n.t('im.generating', 'Generating…');
            const r = await generateCaption(titleId, charId, cur.imgId, opts.rec, cur.prompt);
            if (r && r.ok) { await reload(); if (opts.onChange) opts.onChange(); }
            else { cb.disabled = false; cst.textContent = (r && r.reason === 'ai-off') ? window.i18n.t('im.enable_ai', 'Please enable AI') : (r && r.error ? window.i18n.fmt('im.failed_reason', { reason: String(r.error).slice(0, 50) }) : window.i18n.t('im.failed', 'Failed')); }
          });
          capRow.appendChild(cb); capRow.appendChild(cst);
          wrap.appendChild(capRow);
        }
      }
    };
    const reload = async () => { try { imgs = await getImages(titleId, charId); if (i >= imgs.length) i = Math.max(0, imgs.length - 1); render(); } catch (_) {} };
    reload();
    wrap._reload = reload;
    return wrap;
  }

  // ---- crop / zoom tool (canvas) --------------------------------------------------
  // A draggable selection rectangle over the image; confirming writes the cropped region
  // back as a new PNG dataUri. Quick fix for klein's occasional bad hand / edge.
  function openCropper(dataUri) {
    return new Promise((resolve) => {
      const ov = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9800;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;');
      shieldOverlay(ov);   // block all gestures from reaching the app behind (card swipe→Anki, etc.)
      const stage = el('div', 'position:relative;max-width:96vw;max-height:78vh;touch-action:none;');
      const img = new Image();
      ov.appendChild(stage);
      const bar = el('div', 'display:flex;gap:12px;margin-top:14px;');
      const done = () => { try { ov.remove(); } catch (_) {} };
      const cancel = el('button', 'background:#222;border:1px solid #444;border-radius:9px;color:#ccc;font-size:.9rem;padding:9px 22px;cursor:pointer;', window.i18n.t('common.cancel', 'Cancel'));
      const ok = el('button', 'background:#2a2440;border:1px solid #5a4a8a;border-radius:9px;color:#dcd0ff;font-size:.9rem;padding:9px 22px;cursor:pointer;', window.i18n.t('im.crop', 'Crop'));
      cancel.addEventListener('click', () => { done(); resolve(null); });
      bar.appendChild(cancel); bar.appendChild(ok);
      ov.appendChild(bar);
      ov.addEventListener('click', (e) => { if (e.target === ov) { done(); resolve(null); } });

      img.onload = () => {
        const maxW = Math.min(window.innerWidth * 0.94, 760);
        const maxH = window.innerHeight * 0.72;
        const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        const dw = Math.round(img.naturalWidth * scale), dh = Math.round(img.naturalHeight * scale);
        const disp = el('img', 'display:block;width:' + dw + 'px;height:' + dh + 'px;user-select:none;-webkit-user-drag:none;');
        disp.src = dataUri;
        stage.appendChild(disp);
        // selection rect (px in displayed space), defaults to full image
        let sel = { x: 0, y: 0, w: dw, h: dh };
        const box = el('div', 'position:absolute;border:2px solid #b794f6;box-shadow:0 0 0 9999px rgba(0,0,0,.45);cursor:move;');
        stage.appendChild(box);
        const draw = () => { box.style.left = sel.x + 'px'; box.style.top = sel.y + 'px'; box.style.width = sel.w + 'px'; box.style.height = sel.h + 'px'; };
        draw();
        // corner handles to resize
        const handles = {};
        [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]].forEach(([k, hx, hy]) => {
          const h = el('div', 'position:absolute;width:18px;height:18px;border-radius:50%;background:#b794f6;' + (hx ? 'right:-9px;' : 'left:-9px;') + (hy ? 'bottom:-9px;' : 'top:-9px;') + 'touch-action:none;');
          handles[k] = { el: h, hx, hy }; box.appendChild(h);
          let drag = null;
          const start = (px, py) => { drag = { px, py, sx: sel.x, sy: sel.y, sw: sel.w, sh: sel.h }; };
          const move = (px, py) => {
            if (!drag) return;
            const ddx = px - drag.px, ddy = py - drag.py;
            let nx = drag.sx, ny = drag.sy, nw = drag.sw, nh = drag.sh;
            if (hx) nw = drag.sw + ddx; else { nx = drag.sx + ddx; nw = drag.sw - ddx; }
            if (hy) nh = drag.sh + ddy; else { ny = drag.sy + ddy; nh = drag.sh - ddy; }
            nx = Math.max(0, nx); ny = Math.max(0, ny);
            nw = Math.max(24, Math.min(nw, dw - nx)); nh = Math.max(24, Math.min(nh, dh - ny));
            sel = { x: nx, y: ny, w: nw, h: nh }; draw();
          };
          h.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); h.setPointerCapture(e.pointerId); start(e.clientX, e.clientY); });
          h.addEventListener('pointermove', (e) => { if (drag) { e.preventDefault(); move(e.clientX, e.clientY); } });
          h.addEventListener('pointerup', () => { drag = null; });
        });
        // drag the whole box
        let mv = null;
        box.addEventListener('pointerdown', (e) => { if (e.target !== box) return; box.setPointerCapture(e.pointerId); mv = { px: e.clientX, py: e.clientY, sx: sel.x, sy: sel.y }; });
        box.addEventListener('pointermove', (e) => { if (!mv) return; e.preventDefault(); sel.x = Math.max(0, Math.min(dw - sel.w, mv.sx + (e.clientX - mv.px))); sel.y = Math.max(0, Math.min(dh - sel.h, mv.sy + (e.clientY - mv.py))); draw(); });
        box.addEventListener('pointerup', () => { mv = null; });

        ok.addEventListener('click', () => {
          try {
            const r = img.naturalWidth / dw;   // display→natural
            const cx = Math.round(sel.x * r), cy = Math.round(sel.y * r), cw = Math.round(sel.w * r), ch = Math.round(sel.h * r);
            const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
            cv.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
            const out = cv.toDataURL('image/png');
            done(); resolve(out);
          } catch (_) { done(); resolve(null); }
        });
      };
      img.onerror = () => { done(); resolve(null); };
      img.src = dataUri;
      document.body.appendChild(ov);
    });
  }

  // (The standalone review modal was retired: returned images now populate each
  //  character card directly, with a per-card "新着" badge — see buildImageStrip.)

  // ---- settings wiring (called by preferences.js setupAiPrefs) --------------------
  function wireSettings() {
    try {
      const url = document.getElementById('aiImgServerUrl');
      if (url && !url.dataset.wired) {
        url.dataset.wired = '1';
        url.value = serverUrl();
        url.addEventListener('change', () => { lsSet(URL_KEY, (url.value || '').trim() || DEFAULTS.url); });
      } else if (url) { url.value = serverUrl(); }
      const wire = (id, key, getDef) => { const s = document.getElementById(id); if (!s) return; s.value = String(getDef()); if (!s.dataset.wired) { s.dataset.wired = '1'; s.addEventListener('change', () => lsSet(key, s.value)); } };
      wire('aiImgModel', MODEL_KEY, defModel);
      wire('aiImgStyle', STYLE_KEY, defStyle);
      wire('aiImgScenes', SCENES_KEY, defScenes);
      // ----- OpenAI / ChatGPT image backend -----
      wire('aiImgBackend', BACKEND_KEY, backend);
      wire('aiImgOaiImgModel', OAI_IMGMODEL_KEY, oaImgModel);
      wire('aiImgOaiModel', OAI_MODEL_KEY, oaModel);
      wire('aiImgOaiQuality', OAI_QUALITY_KEY, oaQuality);
      wire('aiImgOaiSize', OAI_SIZE_KEY, oaSize);
      // ----- fal.ai backend (no verification) -----
      wire('aiFalModel', FAL_MODEL_KEY, falModelSel);
      wire('aiFalModelCustom', FAL_MODEL_CUSTOM_KEY, () => lsGet(FAL_MODEL_CUSTOM_KEY, ''));
      wire('aiFalFallback', FAL_FALLBACK_KEY, falFallback);
      wire('aiFalAspect', FAL_ASPECT_KEY, falAspect);
      wire('aiImgDailyBudget', DAILY_BUDGET_KEY, dailyBudget);
      wire('aiImgDailyUsd', DAILY_USD_KEY, dailyUsd);
      const sa = document.getElementById('aiSceneAutoToggle');
      if (sa) {
        sa.checked = !!(window.aiScenes && window.aiScenes.enabled());   // default OFF now
        if (!sa.dataset.wired) { sa.dataset.wired = '1'; sa.addEventListener('change', () => { try { window.aiScenes && window.aiScenes.setEnabled(sa.checked); } catch (_) {} }); }
      }
      // Scene IDEAS at summary time (Claude writes the scene prompts). Default ON.
      const si = document.getElementById('aiSceneIdeasToggle');
      if (si) {
        si.checked = (function () { try { return localStorage.getItem('AISCENE_IDEAS') !== '0'; } catch (_) { return true; } })();
        if (!si.dataset.wired) { si.dataset.wired = '1'; si.addEventListener('change', () => { try { localStorage.setItem('AISCENE_IDEAS', si.checked ? '1' : '0'); } catch (_) {} }); }
      }
      // Scene frequency: ~1 scene per N chars (read by ai-processor.js). Default 2000.
      wire('aiSceneCharsPer', 'AISCENE_CHARS_PER', () => { const n = parseInt(lsGet('AISCENE_CHARS_PER', '2000'), 10); return (Number.isFinite(n) && n >= 200) ? n : 2000; });
      const test = document.getElementById('aiImgTest');
      const status = document.getElementById('aiImgTestStatus');
      if (test && !test.dataset.wired) {
        test.dataset.wired = '1';
        test.addEventListener('click', async () => {
          if (status) { status.textContent = window.i18n.t('im.connecting', 'Connecting…'); status.style.color = '#888'; }
          const h = await health();
          if (status) {
            if (h && h.ok) { const q = h.queue || {}; status.textContent = window.i18n.fmt('im.conn_ok', { models: Object.keys(h.models || {}).join(', '), n: (q.queued || 0) + (q.running || 0) }); status.style.color = '#8d9'; }
            else { status.textContent = window.i18n.t('im.conn_fail', 'Cannot connect (check the server is running and on the same Wi‑Fi)'); status.style.color = '#d99'; }
          }
        });
      }
    } catch (_) {}
  }

  // Composite a scene image into an Anki-ready JPEG: the scene on top, with a footer
  // band carrying the shrunk book cover + the title text — so the card is self-labeling.
  // Any failure falls back to the bare scene image (never blocks the send).
  function _loadImg(src) { return new Promise((res) => { if (!src) { res(null); return; } const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }); }
  async function compositeScene(sceneDataUri, coverDataUri, title) {
    try {
      const scene = await _loadImg(sceneDataUri);
      if (!scene) return sceneDataUri || '';
      const sw = scene.naturalWidth || 1024, sh = scene.naturalHeight || 1024;
      const W = Math.min(1024, sw);
      const sceneH = Math.round(W * sh / sw);
      const footer = Math.round(W * 0.22);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = sceneH + footer;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#0c0c12'; ctx.fillRect(0, 0, W, sceneH + footer);
      ctx.drawImage(scene, 0, 0, W, sceneH);
      const pad = Math.round(W * 0.03), fy = sceneH + pad, fh = footer - pad * 2;
      let textX = pad;
      const cover = await _loadImg(coverDataUri);
      if (cover) { const cw = Math.round(fh * (cover.naturalWidth || 2) / (cover.naturalHeight || 3)); ctx.drawImage(cover, pad, fy, cw, fh); textX = pad + cw + pad; }
      if (title) {
        const fontPx = Math.max(20, Math.round(footer * 0.20));
        ctx.fillStyle = '#e8e8e8'; ctx.textBaseline = 'top'; ctx.font = '600 ' + fontPx + 'px "Hiragino Mincho ProN","YuMincho",serif';
        const maxW = W - textX - pad, lines = []; let cur = '';
        for (const c of String(title)) {
          if (c === '\n') { lines.push(cur); cur = ''; if (lines.length >= 3) break; continue; }
          const t = cur + c;
          if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = c; if (lines.length >= 3) break; } else cur = t;
        }
        if (cur && lines.length < 3) lines.push(cur);
        const lh = Math.round(fontPx * 1.3); let ty = fy + Math.max(0, (fh - lines.length * lh) / 2);
        for (const ln of lines.slice(0, 3)) { ctx.fillText(ln, textX, ty); ty += lh; }
      }
      return cv.toDataURL('image/jpeg', 0.9);   // .jpg is hardcoded in the Anki send
    } catch (_) { return sceneDataUri || ''; }
  }

  // ---- foreground catch-up (background-image rescue) ------------------------------
  // Image receipt is 100% WebView-JS-driven. While the app is backgrounded the OS
  // suspends/throttles WebView JS timers + fetch (iOS fully suspends WKWebView,
  // Android throttles the hidden WebView), so any in-flight poll/ingest stalls and
  // the open screen can show "connection interrupted". The server keeps finished
  // jobs ~3 days and ingestJob dedups + deletes only after a successful local store,
  // so nothing is lost — just delayed. On return to foreground we UNCONDITIONALLY
  // pull + ingest every finished job (NOT gated on any "auto" pref) so manually-
  // queued character/scene images also come back after backgrounding. sync() and
  // refetchDone() both emit 'kai:img-data' on ingest, which the open screens listen
  // to and use to refresh + clear their stale error. Image-network ONLY — this never
  // touches reading/audio position. Local backend only: cloud backends re-render and
  // re-bill on re-sync, so they are skipped here.
  let _lastFgSync = 0;
  function foregroundSync() {
    try {
      // No AI = nothing to catch up. This gate also spares users who never use AI
      // a LAN probe of the default local image server on every foreground
      // (backend() defaults to 'local' with a real default host).
      if (!(window.ai && window.ai.isEnabled && window.ai.isEnabled())) return;
      if (typeof backend === 'function' && backend() !== 'local') return;   // cloud re-bills; skip
      const now = Date.now();
      if (now - _lastFgSync < 8000) return;   // collapse the appStateChange + visibilitychange double-fire
      _lastFgSync = now;
      const tid = window._activeTitleId;
      if (!tid) return;
      // sync(): submit pending + reconcile submitted + listDone(since) catch-up.
      // refetchDone(): a no-`since` full sweep for jobs finished before the last sync.
      // Both self-guard on _syncing/reachable → cheap no-op when offline or idle.
      Promise.resolve(sync(tid)).then(() => refetchDone(tid)).catch(() => {});
      // One short retry to cover a server still mid-render when we foregrounded.
      setTimeout(() => {
        try { if (!document.hidden && window._activeTitleId === tid) Promise.resolve(sync(tid)).then(() => refetchDone(tid)).catch(() => {}); } catch (_) {}
      }, 4000);
    } catch (_) {}
  }
  // Wire once (the module/IIFE could in principle run twice) on BOTH foreground
  // triggers, WITHOUT the AISCENE_AUTO gate that ai-scenes.js uses.
  if (!window.__aiImgFgWired) {
    window.__aiImgFgWired = true;
    try { window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App && window.Capacitor.Plugins.App.addListener('appStateChange', (s) => { if (s && s.isActive) foregroundSync(); }); } catch (_) {}
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) foregroundSync(); }); } catch (_) {}
  }

  window.aiImages = {
    // config
    serverUrl, health, reachable,
    // backend selection + cloud helpers
    backend, dailyBudget, dailyUsd, oaQuality, retryLocal, editImageEntry,
    // queue + sync + regenerate
    queueCharacter, queueAllMissing, sync, pollPending, regenerate,
    // scenes (illustrate a chapter → images under pseudo-charId scene_<idx>)
    queueScene, queueSceneFromPrompt, presentCharacters, capAutoScenes, sceneChapters, sceneStatusByChapter, refetchDone,
    // per-character image ops (the card is the gallery — no review step)
    getImages, deleteImage, recropImage, markCharSeen, counts, statusFor, statusBatch,
    // cross-device sync: union-merge the image index (never lose images/crops)
    mergeIndexBlob,
    // UI
    buildImageStrip, openCropper, wireSettings, shieldOverlay, compositeScene,
    cardTextFor,
  };
})();
