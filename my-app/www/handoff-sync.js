// handoff-sync.js — direct iPhone ⇄ Vision Pro state handoff over the local
// network. No cloud round-trip: each device runs a tiny HTTP server
// (KadokiHandoffServer, Bonjour-advertised as _kadoki._tcp) and, when the app
// is open on both, the device with the OLDER position pulls the newer state.
//
// Payload (per title): driveSync.gatherSnapshot's blobs — chunk maps, chapter
// artifacts (summaries/quotes/vocab), character + place DBs, session
// summaries, cue alignment, coverage, stats — PLUS the transcription cue
// cache and read markers, PLUS positions (audio playhead, read bookmark,
// card index, furthest). AI images and media files are deliberately
// excluded (first pass).
//
// Safety: NEWEST-POSITION-WINS per title with a 5s hysteresis; a title
// actively playing on THIS device is never overwritten; apply ends with a
// reload prompt so every module rehydrates cleanly (no half-applied state).
//
// Server side of the dance: the native server can't read IndexedDB, so it
// evals `kadokiHandoff.serve(reqId, what, param)` in this webview; we build
// the JSON async and hand it back through BackgroundAudio.handoffServeResult.
(function () {
  'use strict';

  const bg = () => window.Capacitor?.Plugins?.BackgroundAudio;
  // Per-title stores NOT in driveSync's KEY_PREFIXES that handoff wants:
  // the transcription cues (Vision can't whisper; the phone can) and the
  // AI read-markers + places DB.
  const EXTRA_PREFIXES = ['SRT_CUES_V1_', 'AIPLACE_V1_', 'AIREAD_V1_'];
  const GLOBAL_KEYS = ['VOCAB_SRS_V1'];   // vocab SRS rides along (newest wins with the title batch)

  const toast = (m, ms) => { try { window.showToast && window.showToast(m, ms || 2500); } catch (_) {} };

  async function allTitles() {
    try { return (await window.titleStore.list()) || []; } catch (_) { return []; }
  }
  function titleKey(t) { return t.syncId || t.name || t.id; }

  // The freshness clock: the audio-resume timestamp (bumped every time the
  // playhead persists), falling back to lastOpenedAt.
  async function localPosTs(t) {
    try {
      const P = window.Capacitor?.Plugins?.Preferences;
      const get = async (k) => P ? (await P.get({ key: k })).value : localStorage.getItem(k);
      const ts = parseInt(await get('READING_AUDIO_LAST_TS_' + (t.name || '')), 10);
      if (Number.isFinite(ts) && ts > 0) return ts;
    } catch (_) {}
    return Number.isFinite(t.lastOpenedAt) ? t.lastOpenedAt : 0;
  }

  // ---- server: build responses (called via native eval) --------------------
  async function buildManifest() {
    const titles = await allTitles();
    const out = [];
    for (const t of titles) {
      out.push({
        key: titleKey(t), name: t.name || '', syncId: t.syncId || null,
        ts: await localPosTs(t),
      });
    }
    let device = 'kadoki';
    try { device = window.KADOKI_VISION ? 'vision' : 'phone'; } catch (_) {}
    return { v: 1, device, titles: out };
  }

  async function buildState(key) {
    const titles = await allTitles();
    const t = titles.find(x => titleKey(x) === key || x.name === key);
    if (!t) return { error: 'no such title' };
    const ds = window.driveSync;
    if (!ds || !ds.gatherSnapshot) return { error: 'driveSync unavailable' };
    const snap = await ds.gatherSnapshot(t.id, t);
    delete snap.images;   // AI images excluded from handoff (first pass)
    const extra = {};
    for (const p of EXTRA_PREFIXES) {
      try { const v = await window.blobStore.get(p + t.id); if (v != null) extra[p] = v; } catch (_) {}
    }
    const globals = {};
    for (const k of GLOBAL_KEYS) {
      try { const v = await window.blobStore.get(k); if (v != null) globals[k] = v; } catch (_) {}
    }
    return { v: 1, title: { key: titleKey(t), name: t.name || '', syncId: t.syncId || null }, snap, extra, globals };
  }

  async function serve(reqId, what, param) {
    let body = '';
    try {
      if (what === 'manifest') body = JSON.stringify(await buildManifest());
      else if (what === 'state') body = JSON.stringify(await buildState(param));
      else body = JSON.stringify({ error: 'unknown' });
    } catch (e) { body = JSON.stringify({ error: String((e && e.message) || e) }); }
    try { await bg()?.handoffServeResult?.({ reqId, body }); } catch (_) {}
  }

  // ---- client: apply a pulled state ---------------------------------------
  async function applyState(localTitle, payload) {
    const ds = window.driveSync;
    const id = localTitle.id;
    const snap = payload.snap || {};
    const blobs = snap.blobs || {};
    for (const [k, v] of Object.entries(blobs)) {
      if (k === 'AICHAR_IMGIDX_V1') continue;   // image index without images → keep local
      try { await window.blobStore.set(ds.srcKey(k, id), v); } catch (_) {}
    }
    for (const [p, v] of Object.entries(payload.extra || {})) {
      try { await window.blobStore.set(p + id, v); } catch (_) {}
    }
    for (const [k, v] of Object.entries(payload.globals || {})) {
      try { await window.blobStore.set(k, v); } catch (_) {}
    }
    // Positions — written to the SAME keys the restore paths read.
    const P = window.Capacitor?.Plugins?.Preferences;
    const set = async (k, v) => { try { P ? await P.set({ key: k, value: String(v) }) : localStorage.setItem(k, String(v)); } catch (_) {} };
    const ar = snap.audioResume;
    if (ar && Number.isFinite(ar.ms) && ar.ms > 0 && localTitle.name) {
      await set('READING_AUDIO_LAST_POS_' + localTitle.name, ar.ms);
      if (Number.isFinite(ar.chunkIdx)) await set('READING_AUDIO_LAST_CHUNK_' + localTitle.name, ar.chunkIdx);
      await set('READING_AUDIO_LAST_TS_' + localTitle.name, ar.ts || Date.now());
      // The device-local native floor is forward-only and would out-vote this
      // adopted position at restore (the "sync got everything but the place"
      // bug). Handoff is a deliberate user-visible position adoption — clear
      // the floor so the pulled position rules.
      try { await bg()?.clearSavedPosition?.(); } catch (_) {}
    }
    // History (the 3-per-mode recent-session bookmarks): merge the remote
    // title's entries under OUR title id, so the History menu offers the
    // other device's spots — the user can pick a different one if the
    // automatic position isn't what they wanted.
    try {
      if (Array.isArray(snap.bms) && window.bookmarks && window.bookmarks.record) {
        const bms = snap.bms.slice().sort((x, y) => (x.ts || 0) - (y.ts || 0));   // oldest first → newest ends on top
        for (const bm of bms) {
          if (!bm || !bm.mode) continue;
          window.bookmarks.record(Object.assign({}, bm, { titleId: id }));
        }
      }
    } catch (_) {}
    const rb = snap.readBookmark;
    const localEpub = localTitle.attachments && localTitle.attachments.epub && localTitle.attachments.epub.name;
    if (rb && Number.isFinite(rb.chunkIdx) && localEpub) {
      await set('PAGED_BOOKMARK_' + localEpub, rb.chunkIdx);
    }
    try {
      const patch = {};
      if (Number.isFinite(snap.cardIndex)) patch.lastCardIndex = snap.cardIndex;
      if (Number.isFinite(snap.cardMs)) patch.lastCardMs = snap.cardMs;
      if (Object.keys(patch).length) await window.titleStore.update(id, patch);
    } catch (_) {}
    try {
      if (Number.isFinite(snap.audioFurthestMs) && snap.audioFurthestMs > 0 &&
          window.bookmarks && window.bookmarks.creditFurthest) {
        window.bookmarks.creditFurthest(id, snap.audioFurthestMs);
      }
    } catch (_) {}
    try {
      if (snap.aiActivation && window.ai && window.ai.setActivated) {
        await window.ai.setActivated(id, snap.aiActivation.mode || 'new');
      }
    } catch (_) {}
  }

  // ---- client: the sync pass ----------------------------------------------
  let _syncing = false;
  async function syncNow(silent) {
    if (_syncing) return;
    _syncing = true;
    try {
      const b = bg();
      if (!b || typeof b.handoffGet !== 'function') return;
      const peers = ((await b.handoffPeers?.()) || {}).peers || [];
      if (!peers.length) { if (!silent) toast('近くのKadokiが見つかりません（両方の端末でアプリを開いてください）', 3200); return; }
      const svc = peers[0];
      let man = null;
      try { man = JSON.parse(((await b.handoffGet({ service: svc, path: '/kadoki/manifest' })) || {}).body || 'null'); } catch (_) {}
      if (!man || !Array.isArray(man.titles)) { if (!silent) toast('同期先に接続できませんでした', 2800); return; }
      const titles = await allTitles();
      let applied = 0;
      const names = [];
      for (const rt of man.titles) {
        const lt = titles.find(t => (rt.syncId && t.syncId === rt.syncId) || (rt.name && t.name === rt.name));
        if (!lt) continue;   // media-less first pass: only titles present on both devices
        const lts = await localPosTs(lt);
        if (!(rt.ts > lts + 5000)) continue;                                   // remote must be clearly newer
        if (window._bgPlaying && lt.id === window._activeTitleId) continue;    // in use HERE — never clobber
        let st = null;
        try { st = JSON.parse(((await b.handoffGet({ service: svc, path: '/kadoki/state?key=' + encodeURIComponent(rt.key) })) || {}).body || 'null'); } catch (_) {}
        if (!st || st.error || !st.snap) continue;
        await applyState(lt, st);
        applied++;
        names.push(lt.name || lt.id);
      }
      if (applied) {
        toast('✓ ' + names.join('、') + ' を同期しました', 3000);
        // Full rehydrate: every module re-reads its stores. Ask first — the
        // user may be mid-something.
        setTimeout(() => {
          try { if (window.confirm('同期した内容を反映するため再読み込みしますか？')) location.reload(); } catch (_) {}
        }, 600);
      } else if (!silent) {
        toast('すでに最新です', 2200);
      }
    } catch (_) {} finally { _syncing = false; }
  }

  // Automatic: shortly after boot, on every foreground, and every 3 minutes
  // while open — both devices run this, so whichever is behind catches up.
  setTimeout(() => syncNow(true), 15000);
  setInterval(() => { if (!document.hidden) syncNow(true); }, 180000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => syncNow(true), 2500);
  });

  window.kadokiHandoff = { serve, syncNow, buildManifest, buildState };
})();
