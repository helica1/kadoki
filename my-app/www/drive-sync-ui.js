// drive-sync-ui.js — UI glue for Google Drive sync.
//
// Wires the Preferences "Google Drive sync" section (connect/disconnect +
// status) and exposes syncUp() (push the current title) + syncDown() (pull the
// latest + open it) + browseDrive() + downloadCloudTitle() for the menu/library.
// Progress uses cueAlignment.showProgress; messages use the global showToast.
// Confirm dialogs are self-contained .kai-modal overlays (gesture-blocking,
// per the popup-shielding rule).

(function () {
  'use strict';

  const MEDIA_PREF = 'GDRIVE_INCLUDE_MEDIA';
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  async function prefGet(k) {
    try { if (CapPrefs()) return (await CapPrefs().get({ key: k })).value; } catch (_) {}
    try { return localStorage.getItem(k); } catch (_) { return null; }
  }
  async function prefSet(k, v) {
    try { if (CapPrefs()) await CapPrefs().set({ key: k, value: String(v) }); } catch (_) {}
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }
  function toast(msg, ms) { try { if (typeof showToast === 'function') showToast(msg, ms); } catch (_) {} }

  async function includeMedia() { return (await prefGet(MEDIA_PREF)) === '1'; }

  // ---- Preferences section wiring -----------------------------------------
  async function refreshStatus() {
    const statusEl = document.getElementById('gdriveStatus');
    const btn = document.getElementById('gdriveConnectBtn');
    if (!statusEl || !btn || !window.gdriveAuth) return;
    const t = (k, f) => (window.i18n ? window.i18n.t(k, f) : f);
    if (!(await window.gdriveAuth.isConfigured())) {
      statusEl.textContent = t('dr.not_configured', 'Not configured');
      btn.textContent = t('dr.connect_btn', 'Connect Google Drive');
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (await window.gdriveAuth.isConnected()) {
      const email = await window.gdriveAuth.connectedEmail();
      statusEl.textContent = email ? (window.i18n ? window.i18n.fmt('dr.connected_email', { email }) : ('Connected · ' + email)) : t('dr.connected', 'Connected');
      btn.textContent = t('dr.disconnect_btn', 'Disconnect');
    } else {
      statusEl.textContent = t('dr.not_connected', 'Not connected');
      btn.textContent = t('dr.connect_btn', 'Connect Google Drive');
    }
  }

  async function onConnectClick() {
    if (!window.gdriveAuth) return;
    try {
      if (await window.gdriveAuth.isConnected()) {
        await window.gdriveAuth.disconnect();
        toast(window.i18n ? window.i18n.t('dr.disconnected_toast', 'Disconnected from Google Drive') : 'Disconnected from Google Drive');
      } else {
        toast(window.i18n ? window.i18n.t('dr.opening_signin', 'Opening Google sign-in…') : 'Opening Google sign-in…', 2000);
        const r = await window.gdriveAuth.connect();
        toast(r && r.email ? (window.i18n ? window.i18n.fmt('dr.connected_email', { email: r.email }) : ('Connected · ' + r.email)) : (window.i18n ? window.i18n.t('dr.connected_toast', 'Connected to Google Drive') : 'Connected to Google Drive'));
      }
    } catch (e) {
      toast('Google Drive: ' + (e && e.message ? e.message : (window.i18n ? window.i18n.t('dr.signin_failed', 'sign-in failed') : 'sign-in failed')), 5000);
    }
    refreshStatus();
  }

  let _wired = false;
  function wirePrefs() {
    if (_wired) return;
    const btn = document.getElementById('gdriveConnectBtn');
    const media = document.getElementById('gdriveIncludeMedia');
    if (!btn) return;            // section not in DOM yet — retry
    _wired = true;
    btn.addEventListener('click', (e) => { e.preventDefault(); onConnectClick(); });
    if (media) {
      includeMedia().then(v => { media.checked = !!v; });
      media.addEventListener('change', () => { prefSet(MEDIA_PREF, media.checked ? '1' : '0'); });
    }
    refreshStatus();
  }
  [200, 600, 1500].forEach(ms => setTimeout(wirePrefs, ms));
  // Re-check status whenever the preferences modal is shown.
  document.addEventListener('click', (e) => {
    if (e.target && (e.target.closest && e.target.closest('#preferencesModal'))) refreshStatus();
  }, true);

  // ---- confirm dialog (.kai-modal) ----------------------------------------
  function confirmDialog(title, body, okLabel) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'kai-modal';
      ov.style.cssText =
        // z-index above cue-alignment's progress overlay (99999) so a confirm
        // shown mid-operation is always tappable.
        'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100001;' +
        'display:flex;align-items:center;justify-content:center;padding:24px;touch-action:none;';
      const stop = (e) => e.stopPropagation();
      ['touchstart', 'touchmove', 'touchend', 'click'].forEach(ev => ov.addEventListener(ev, stop, { passive: false }));
      const card = document.createElement('div');
      card.style.cssText =
        'background:#181820;border:1px solid #303040;border-radius:14px;padding:20px 22px;' +
        'max-width:340px;color:#e8e8e8;font-family:-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);';
      card.innerHTML =
        '<div style="font-size:15px;font-weight:600;margin-bottom:8px;"></div>' +
        '<div style="font-size:13px;color:#bbb;line-height:1.5;margin-bottom:18px;"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button data-act="cancel" style="background:none;border:1px solid #444;border-radius:8px;color:#bbb;padding:7px 14px;font-size:13px;">Cancel</button>' +
          '<button data-act="ok" style="background:#3257d0;border:none;border-radius:8px;color:#fff;padding:7px 16px;font-size:13px;"></button>' +
        '</div>';
      card.children[0].textContent = title;
      card.children[1].textContent = body;
      card.querySelector('[data-act="ok"]').textContent = okLabel || 'OK';
      const close = (val) => { try { ov.remove(); } catch (_) {} resolve(val); };
      card.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      card.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
      ov.appendChild(card);
      document.body.appendChild(ov);
    });
  }

  function fmtBytes(n) {
    if (!n || n <= 0) return '';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1048576).toFixed(n < 100 * 1048576 ? 1 : 0) + ' MB';
  }

  // First-sync file decision. `mediaInfo` = [{kind,name,size}]; `direction` is
  // 'push' (this device seeds the files) or 'pull' (download files that are on
  // Drive but missing here). Returns true (include files), false (data only),
  // or null (cancel). Shown ONCE per title; the choice is remembered.
  function fileOptInDialog(name, mediaInfo, direction) {
    const items = (mediaInfo || []).filter(m => m && m.name);
    const total = items.reduce((s, m) => s + (m.size || 0), 0);
    const totalStr = fmtBytes(total);
    const verb = direction === 'pull' ? 'download' : 'upload';
    const fileLines = items.map(m => m.kind + (m.size ? ' (' + fmtBytes(m.size) + ')' : '')).join(', ');
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'kai-modal';
      ov.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100001;display:flex;' +
        'align-items:center;justify-content:center;padding:24px;touch-action:none;';
      ['touchstart', 'touchmove', 'touchend', 'click'].forEach(ev => ov.addEventListener(ev, e => e.stopPropagation(), { passive: false }));
      const card = document.createElement('div');
      card.style.cssText =
        'background:#181820;border:1px solid #303040;border-radius:14px;padding:20px;width:min(390px,92vw);' +
        'color:#e8e8e8;font-family:-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);';
      const opt = (primary) =>
        'display:block;width:100%;text-align:left;border-radius:10px;padding:12px 14px;margin-bottom:10px;' +
        'border:1px solid ' + (primary ? '#3a57c8' : '#2c2c3a') + ';background:' + (primary ? '#1d2950' : '#20202a') + ';color:#e8e8e8;';
      card.innerHTML =
        '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">Sync “' + (name || 'this title') + '”</div>' +
        '<div style="font-size:12px;color:#999;margin-bottom:14px;line-height:1.45;">Position, AI &amp; timeline always sync (fast). Do you also want to ' + verb + ' this title’s files? They only move once — re-syncs stay fast.</div>' +
        '<button data-act="data" style="' + opt(true) + '">' +
          '<div style="font-size:14px;font-weight:600;">Position &amp; AI only</div>' +
          '<div style="font-size:11px;color:#9aa;margin-top:3px;line-height:1.4;">Fast. Best if both devices already have the book/audio.</div>' +
        '</button>' +
        '<button data-act="all" style="' + opt(false) + '">' +
          '<div style="font-size:14px;font-weight:600;">＋ Files' + (totalStr ? ' (' + totalStr + ')' : '') + '</div>' +
          '<div style="font-size:11px;color:#9aa;margin-top:3px;line-height:1.4;">Also ' + verb + ' ' + (fileLines || 'epub / subtitles / audiobook') + '. One-time' + (direction === 'pull' ? ' download' : ' upload') + '.</div>' +
        '</button>' +
        '<div style="text-align:right;margin-top:4px;"><button data-act="cancel" style="background:none;border:none;color:#8a8a9a;font-size:13px;padding:6px 4px;">Cancel</button></div>';
      const close = (v) => { try { ov.remove(); } catch (_) {} resolve(v); };
      card.querySelector('[data-act="data"]').addEventListener('click', () => close(false));
      card.querySelector('[data-act="all"]').addEventListener('click', () => close(true));
      card.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      ov.appendChild(card);
      document.body.appendChild(ov);
    });
  }

  function fmtAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 90) return 'just now';
    const m = Math.floor(s / 60); if (m < 90) return m + ' min ago';
    const h = Math.floor(m / 60); if (h < 36) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  // ---- shared helpers ------------------------------------------------------
  function progress(title, sub) {
    return (window.cueAlignment && window.cueAlignment.showProgress)
      ? window.cueAlignment.showProgress({ title, sub }) : null;
  }
  function mkOnProgress(prog, verb) {
    return (p) => {
      if (!prog) return;
      if (p.phase === 'gather') { prog.setSub && prog.setSub('Reading local data…'); return; }
      if (p.phase === 'media' && prog.update) {
        // Large file transfer — show MB and a percentage.
        const cur = p.current || 0, tot = p.total || 1;
        prog.update({ phase: 'match', current: cur, total: tot });
        if (prog.setSub) {
          const mb = (n) => (n / 1048576).toFixed(1);
          const label = (p.dir === 'down' ? 'Downloading ' : 'Uploading ') + (p.kind || 'media');
          prog.setSub(label + '… ' + mb(cur) + ' / ' + mb(tot) + ' MB');
        }
        return;
      }
      if ((p.phase === 'upload' || p.phase === 'download') && prog.update) {
        prog.update({ phase: 'match', current: p.current || 0, total: p.total || 1 });
        // Override cue-alignment's hardcoded "Matching subtitles…" sub label.
        if (prog.setSub) prog.setSub((verb || 'Syncing') + '… ' + (p.current || 0) + '/' + (p.total || 1));
      }
    };
  }
  async function ensureConnected() {
    if (!window.gdriveAuth || !window.driveSync) { toast('Sync unavailable'); return false; }
    if (!(await window.gdriveAuth.isConfigured())) { toast('Google Drive not configured'); return false; }
    if (!(await window.gdriveAuth.isConnected())) {
      const ok = await confirmDialog('Connect Google Drive',
        'Connect your Google account first (also in Preferences → Google Drive sync). Connect now?', 'Connect');
      if (!ok) return false;
      try { await window.gdriveAuth.connect(); }
      catch (e) { toast('Sign-in failed: ' + (e.message || ''), 5000); return false; }
    }
    return true;
  }

  // True once the running reader/audio has fully switched to `title`, so live
  // position capture is this title's (not the one we switched away from).
  function headerName() {
    try { const el = document.getElementById('deckName'); return (el && el.textContent || '').replace(/\s*\((Tap to reopen|Auto-restoring\.\.\.)\)\s*$/i, '').trim(); }
    catch (_) { return ''; }
  }
  function isTitleReady(title) {
    if (!title) return true;
    if (title.id !== window._activeTitleId) return true;          // not active → persisted is authoritative
    if (headerName() !== (title.name || '')) return false;        // shell still switching titles
    const a = title.attachments || {};
    // If a reader book is loaded, it must be THIS title's epub (else mid-switch).
    try {
      if (a.epub && a.epub.name && typeof window.pagedGetReadLocation === 'function') {
        const loc = window.pagedGetReadLocation();
        if (loc && loc.bookName && loc.bookName !== a.epub.name) return false;
      }
    } catch (_) {}
    return true;
  }
  async function waitTitleReady(titleId, timeoutMs) {
    let title; try { title = await window.titleStore.get(titleId); } catch (_) {}
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      if (isTitleReady(title)) return;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  function isOpenable(t) {
    try { const m = window.titleStore.enabledModes(t); return !!(m && (m.card || m.read || m.audio)); }
    catch (_) { return false; }
  }

  // Arm a one-shot canonical cue for the title about to open via sync, so the
  // read mode's green line aligns to the CARD cue (the reliable, all-modes-fresh
  // anchor) instead of the separately-synced read bookmark (which is stale if
  // the source device wasn't in read mode). title.lastCardIndex is stored in CUE
  // space. ensureGreenOnEnter consumes it (15s fresh window + title-scoped +
  // one-shot, mirroring _pendingAudioStartMs). Card opens correct already; audio
  // self-corrects from the card cue on a card→audio switch.
  function armReadAlign(title) {
    try {
      if (title && Number.isFinite(title.lastCardIndex) && title.lastCardIndex >= 0) {
        window._syncAlignCue = title.lastCardIndex;
        window._syncAlignTitleId = title.id;
        window._syncAlignAt = Date.now();
      }
    } catch (_) {}
  }

  // ---- Explicit two-direction sync (user decision, 2026-06-16) ------------
  // No direction-guessing: Sync ↑ pushes the CURRENT title's state up; Sync ↓
  // pulls the latest synced state down and opens it. Shared helpers below; both
  // reuse the library index, fingerprint binding, and forward-only guards.

  // Read the library index (build once from legacy folders if absent) + local
  // state. Returns the shared context, or null on failure (already toasted;
  // leaves `prog` for the caller to close).
  async function syncCtx(prog) {
    let me, root, idx, localTitles, dismissedSet, bindSkip;
    try {
      me = await window.driveSync.deviceId();
      root = await window.driveSync.rootFolderId();
      idx = await window.driveIndex.read(root);
      localTitles = await window.titleStore.list();
      dismissedSet = await window.driveIndex.dismissed();
      bindSkip = await window.driveIndex.bindSkipped();
    } catch (e) { if (prog) prog.close(); toast('Sync failed: ' + (e && e.message ? e.message : 'error'), 6000); return null; }
    if (!idx) {
      try { idx = await window.driveIndex.buildFromFolders(root, me); if (Object.keys(idx.titles).length) await window.driveIndex.write(root, idx, me); }
      catch (_) { idx = { v: 1, titles: {} }; }
    }
    if (!idx.titles) idx.titles = {};
    return { me, root, idx, localTitles, dismissedSet, bindSkip };
  }

  // Bind the given local titles to matching index entries by media fingerprint
  // (one-time confirm for name-only; remembers declines). Prevents two devices
  // creating separate folders for the same book. Returns the bound syncId set.
  async function bindTitles(titles, idx, bindSkip) {
    const bound = new Set();
    for (const t of titles) { if (t && t.syncId && idx.titles[t.syncId]) bound.add(t.syncId); }
    for (const t of titles) {
      if (!t || t.cloudOnly) continue;
      if (t.syncId && idx.titles[t.syncId]) continue;          // already bound
      const m = window.driveIndex.matchFingerprint(t, idx, bound);
      if (!m) continue;
      if (bindSkip.has(window.driveIndex.bindKey(t.id, m.entry.syncId))) continue;   // user declined before
      let ok = m.exact;                            // confirm dialogs sit above the spinner (z 100001>99999)
      if (!ok) {
        ok = await confirmDialog('Same book?',
          'Is “' + (t.name || 'this title') + '” the same book as “' + (m.entry.titleName || '') + '” on your other device? Linking lets your place sync.', 'Yes, link');
        if (!ok) { try { await window.driveIndex.skipBind(t.id, m.entry.syncId); } catch (_) {} }
      }
      if (ok) {
        // Only trust the bind if it PERSISTED — push() re-reads the title from
        // the store, so an in-memory-only syncId would make it push to the old
        // folder and create a duplicate.
        let wrote = false;
        try { await window.titleStore.update(t.id, { syncId: m.entry.syncId }); wrote = true; } catch (_) {}
        if (wrote) { t.syncId = m.entry.syncId; bound.add(m.entry.syncId); }
      }
    }
    return bound;
  }

  // Create lightweight cloud-placeholder titles for index entries we don't hold
  // locally (skipping dismissed + bound). Returns how many were created.
  async function surfaceCloudEntries(ctx, boundSyncIds) {
    let n = 0;
    const have = new Set(ctx.localTitles.map(t => t.syncId).filter(Boolean));
    for (const sid of Object.keys(ctx.idx.titles)) {
      if (ctx.dismissedSet.has(sid) || have.has(sid) || boundSyncIds.has(sid)) continue;
      const e = ctx.idx.titles[sid];
      try {
        const created = await window.titleStore.create({ syncId: sid, name: e.titleName || 'Synced title' });
        await window.titleStore.update(created.id, { cloudOnly: true, hasFilesRemote: !!e.hasFiles });
        n++;
      } catch (_) {}
    }
    return n;
  }

  // ===== Sync ↑ — push the CURRENT title's state to Drive ==================
  async function syncUp() {
    const activeId = window._activeTitleId || null;
    if (!activeId) { toast('Open a title first, then Sync ↑'); return; }
    if (!(await ensureConnected())) return;
    const prog = progress('Sync ↑', 'Uploading this title…');
    try { await waitTitleReady(activeId, 6000); } catch (_) {}
    const ctx = await syncCtx(prog);
    if (!ctx) return;
    const active = ctx.localTitles.find(t => t.id === activeId);
    if (!active) { if (prog) prog.close(); toast('No title open'); return; }
    if (active.cloudOnly) { if (prog) prog.close(); toast('This title isn’t downloaded yet — use Sync ↓'); return; }
    try {
      // Bind first so we push to the SHARED folder (never a duplicate).
      await bindTitles([active], ctx.idx, ctx.bindSkip);
      await window.driveSync.push(activeId, { includeMedia: !!active.syncIncludeMedia, index: ctx.idx, onProgress: mkOnProgress(prog, 'Uploading') });
      await window.driveIndex.write(ctx.root, ctx.idx, ctx.me);
      if (prog) prog.close();
      toast('Synced ↑ to Drive ✓');
    } catch (e) { if (prog) prog.close(); toast('Sync ↑ failed: ' + (e && e.message ? e.message : 'error'), 6000); }
  }

  // ===== Sync ↓ — pull the latest synced state and open it =================
  // Pulls every title Drive has newer (forward-only), surfaces remote-only
  // titles as cloud entries, then opens the most-recently-synced title:
  // switches to it if present, downloads its file(s) if not.
  async function syncDown() {
    if (!(await ensureConnected())) return;
    const activeId = window._activeTitleId || null;
    const prog = progress('Sync ↓', 'Getting the latest…');
    const ctx = await syncCtx(prog);
    if (!ctx) return;
    if (!Object.keys(ctx.idx.titles).length) { if (prog) prog.close(); toast('Nothing synced to Drive yet'); return; }

    let bound, pulled = 0; const pulledSyncIds = new Set();
    try {
      bound = await bindTitles(ctx.localTitles, ctx.idx, ctx.bindSkip);
      for (const t of ctx.localTitles) {
        if (t.cloudOnly) continue;
        const entry = t.syncId ? ctx.idx.titles[t.syncId] : null;
        if (entry && (entry.rev || 0) > (t.syncRev || 0)) {        // Drive newer → adopt (forward-only)
          let folderId = t.syncFolderId || null;
          if (!folderId) { try { const fo = await window.driveApi.findFolder(t.syncId, ctx.root); folderId = fo ? fo.id : null; } catch (_) {} }
          if (!folderId) continue;
          const remote = await window.driveSync.readRemoteManifest(folderId);
          if (!remote) continue;
          await window.driveSync.pull(folderId, remote, {
            includeMedia: false, targetLocalId: t.id,
            onProgress: mkOnProgress(prog, 'Downloading'), confirmNameMatch: () => Promise.resolve(true),
          });
          pulled++; pulledSyncIds.add(t.syncId);
        }
      }
    } catch (e) { if (prog) prog.close(); toast('Sync ↓ failed: ' + (e && e.message ? e.message : 'error'), 6000); return; }

    let newCloud = 0;
    try { newCloud = await surfaceCloudEntries(ctx, bound); } catch (_) {}
    if (prog) prog.close();

    // Open the most-recently-synced title (skipping any the user dismissed).
    const mr = window.driveIndex.mostRecent(ctx.idx, ctx.dismissedSet);
    if (!mr) { toast('Synced ↓ ✓' + (pulled ? ' · ' + pulled + ' updated' : '')); return; }
    const fresh = await window.titleStore.list();
    const target = fresh.find(t => t.syncId === mr.syncId);
    const openTitle = activeId ? fresh.find(t => t.id === activeId) : null;
    const alreadyOpen = !!(openTitle && openTitle.syncId === mr.syncId);

    if (target && !target.cloudOnly && isOpenable(target)) {
      if (alreadyOpen && !pulledSyncIds.has(mr.syncId)) { toast('Already on the latest ✓'); return; }
      if (typeof window.loadTitleFromLibrary === 'function') { armReadAlign(target); window.loadTitleFromLibrary(target); return; }
    }
    // Not present locally (or cloud-only) → download the file(s) and open.
    if (target) { await downloadCloudTitle(target); return; }
    toast('Synced ↓ ✓' + (newCloud ? ' · ' + newCloud + ' new in cloud' : ''));
  }

  // Download a cloud-placeholder (or re-pull a present) title and open it.
  async function downloadCloudTitle(title) {
    if (!title) return;
    if (!(await ensureConnected())) return;
    let root, fo, remote;
    try {
      root = await window.driveSync.rootFolderId();
      fo = await window.driveApi.findFolder(title.syncId, root);
      if (!fo) { toast('Not found on Drive'); return; }
      remote = await window.driveSync.readRemoteManifest(fo.id);
    } catch (e) { toast('Download failed: ' + (e && e.message ? e.message : ''), 6000); return; }
    if (!remote) { toast('No data on Drive for this title yet'); return; }

    let inclMedia = false;
    const mediaFiles = (remote.media || []).filter(m => m.driveFileId);
    if (mediaFiles.length) {
      const c = await fileOptInDialog(title.name, mediaFiles, 'pull');
      if (c === null) return;
      inclMedia = c;
    }
    const prog = progress('Getting from Drive', 'Downloading…');
    try {
      await window.driveSync.pull(fo.id, remote, {
        includeMedia: inclMedia, targetLocalId: title.id,
        onProgress: mkOnProgress(prog, 'Downloading'), confirmNameMatch: () => Promise.resolve(true),
      });
      if (prog) prog.close();
      try { if (title.syncId) await window.driveIndex.undismiss(title.syncId); } catch (_) {}   // re-added → may resurface if deleted again
      const probe = await window.titleStore.get(title.id);
      const openable = isOpenable(probe);
      try { await window.titleStore.update(title.id, { cloudOnly: !openable, syncIncludeMedia: inclMedia }); } catch (_) {}
      if (openable && typeof window.loadTitleFromLibrary === 'function') {
        const t = await window.titleStore.get(title.id);   // re-fetch: cloudOnly cleared + downloaded attachments present
        armReadAlign(t); toast('Downloaded ✓'); window.loadTitleFromLibrary(t);
      } else toast('Position & AI downloaded — add the book file to read it', 5000);
    } catch (e) { if (prog) prog.close(); toast('Download failed: ' + (e && e.message ? e.message : ''), 6000); }
  }

  // ---- Browse Drive (list + delete) ---------------------------------------
  async function browseDrive() {
    if (!(await ensureConnected())) return;
    const prog = progress('Google Drive', 'Loading your synced titles…');
    let entries, me = '';
    try {
      entries = await window.driveSync.listRemote();
      me = await window.driveSync.deviceId();
    } catch (e) { if (prog) prog.close(); toast('Could not read Drive: ' + (e.message || ''), 6000); return; }
    if (prog) prog.close();
    if (!entries || !entries.length) { toast('No synced titles in Drive yet'); return; }
    entries.sort((a, b) => (b.snapshotTs || 0) - (a.snapshotTs || 0));

    const ov = document.createElement('div');
    ov.className = 'kai-modal';
    ov.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99998;display:flex;' +
      'align-items:center;justify-content:center;padding:24px;touch-action:none;';
    ['touchstart', 'touchmove', 'touchend', 'click'].forEach(ev => ov.addEventListener(ev, e => e.stopPropagation(), { passive: false }));
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    const card = document.createElement('div');
    card.style.cssText =
      'background:#181820;border:1px solid #303040;border-radius:14px;padding:18px 18px 14px;' +
      'width:min(460px,92vw);max-height:80vh;display:flex;flex-direction:column;color:#e8e8e8;' +
      'font-family:-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);';
    card.innerHTML =
      '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">Titles on Google Drive</div>' +
      '<div style="font-size:12px;color:#999;margin-bottom:12px;line-height:1.45;">Get a title onto this device, add its files, or delete it from Drive (your local copy is untouched).</div>' +
      '<div data-list style="overflow-y:auto;flex:1;-webkit-overflow-scrolling:touch;"></div>' +
      '<button data-close style="align-self:flex-end;margin-top:6px;background:none;border:1px solid #444;border-radius:8px;color:#bbb;padding:7px 14px;font-size:13px;">Close</button>';
    const list = card.querySelector('[data-list]');

    // Resolve local presence per entry (by syncId, else media-name fingerprint)
    // so each row shows the right action.
    async function resolveLocal(e) {
      try {
        let t = await window.titleStore.findBySyncId(e.syncId);
        if (t) return t;
        const prim = (e.hasMedia || []).find(m => m.kind === 'epub') || (e.hasMedia || []).find(m => m.kind === 'audiobook') || (e.hasMedia || [])[0];
        if (prim && prim.name && window.titleStore.findByMediaFingerprint) {
          const m = await window.titleStore.findByMediaFingerprint(String(prim.name).trim().toLowerCase() + '|' + (prim.size || ''));
          if (m) return m.title;
        }
      } catch (_) {}
      return null;
    }

    const mkBtn = (label, color, border, bg) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:' + (bg || 'none') + ';border:1px solid ' + border + ';border-radius:8px;color:' + color + ';padding:6px 10px;font-size:12px;flex:none;';
      return b;
    };

    for (const e of entries) {
      const local = await resolveLocal(e);
      const driveHasFiles = (e.hasMedia || []).some(m => m.driveFileId);
      const localHasFiles = !!(local && local.attachments &&
        (local.attachments.epub || local.attachments.audiobook || local.attachments.srt));
      const mediaTotal = (e.hasMedia || []).reduce((s, m) => s + (m.size || 0), 0);
      const mediaStr = driveHasFiles ? fmtBytes(mediaTotal) + ' files' : 'data only';

      const row = document.createElement('div');
      row.style.cssText = 'background:#20202a;border:1px solid #2c2c3a;border-radius:10px;padding:11px 13px;margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:120px;';
      info.innerHTML = '<div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>' +
        '<div style="font-size:11px;color:#8a8a9a;margin-top:2px;"></div>';
      info.children[0].textContent = e.titleName + (local ? '' : '  (not on this device)');
      info.children[1].textContent = fmtAgo(e.snapshotTs) + ' · rev ' + e.rev + ' · ' + mediaStr;
      row.appendChild(info);

      // Get — only when this device doesn't have the title yet.
      if (!local) {
        const get = mkBtn('Get', '#cfe', '#2a3a5a', '#1d2950');
        get.addEventListener('click', async () => { ov.remove(); await getEntry(e); });
        row.appendChild(get);
      }
      // Upload files — present locally, this device HAS files, Drive doesn't yet.
      if (local && localHasFiles && !driveHasFiles) {
        const up = mkBtn('Upload files', '#cfe', '#2a3a5a', '#1d2950');
        up.addEventListener('click', async () => {
          up.disabled = true; up.textContent = '…';
          try { await window.titleStore.update(local.id, { syncIncludeMedia: true }); } catch (_) {}
          const p = progress('Uploading files', 'Uploading…');
          try {
            await window.driveSync.push(local.id, { includeMedia: true, onProgress: mkOnProgress(p, 'Uploading') });
            if (p) p.close(); toast('Files uploaded ✓'); ov.remove(); browseDrive();
          } catch (err) { if (p) p.close(); up.disabled = false; up.textContent = 'Upload files'; toast('Upload failed: ' + (err.message || ''), 6000); }
        });
        row.appendChild(up);
      }
      // Force override (determinism on demand) — only for titles present here.
      if (local && !local.cloudOnly) {
        const fpush = mkBtn('Force ↑', '#cdf', '#3a3a5a');
        fpush.addEventListener('click', async () => {
          const ok = await confirmDialog('Force upload', 'Overwrite the Drive copy of “' + e.titleName + '” with THIS device’s state?', 'Upload');
          if (!ok) return;
          fpush.disabled = true; fpush.textContent = '…';
          const p = progress('Force upload', 'Uploading…');
          try { await window.driveSync.forcePush(local.id); if (p) p.close(); toast('Forced upload ✓'); ov.remove(); browseDrive(); }
          catch (err) { if (p) p.close(); fpush.disabled = false; fpush.textContent = 'Force ↑'; toast('Upload failed: ' + (err.message || ''), 6000); }
        });
        row.appendChild(fpush);
        const fpull = mkBtn('Force ↓', '#cdf', '#3a3a5a');
        fpull.addEventListener('click', async () => {
          const ok = await confirmDialog('Force download', 'Adopt the Drive copy of “' + e.titleName + '” onto THIS device? (Your place only moves forward, never backward.)', 'Download');
          if (!ok) return;
          fpull.disabled = true; fpull.textContent = '…';
          const p = progress('Force download', 'Downloading…');
          try {
            await window.driveSync.forcePull(local.id); if (p) p.close(); toast('Forced download ✓'); ov.remove();
            try { const t = await window.titleStore.get(local.id); if (t && typeof window.loadTitleFromLibrary === 'function') window.loadTitleFromLibrary(t); } catch (_) {}
          } catch (err) { if (p) p.close(); fpull.disabled = false; fpull.textContent = 'Force ↓'; toast('Download failed: ' + (err.message || ''), 6000); }
        });
        row.appendChild(fpull);
      }
      const del = mkBtn('Delete', '#d98a8a', '#5a2a2a');
      del.addEventListener('click', async () => {
        const ok = await confirmDialog('Delete from Drive',
          'Delete “' + e.titleName + '” and its files from Drive? Your local copy stays. (Other devices re-create it on their next Sync.)', 'Delete');
        if (!ok) return;
        del.disabled = true; del.textContent = '…';
        try {
          if (window.driveApi && window.driveApi.deleteFile) await window.driveApi.deleteFile(e.folderId);
          row.remove(); toast('Deleted from Drive ✓');
        } catch (err) { del.disabled = false; del.textContent = 'Delete'; toast('Delete failed: ' + (err.message || ''), 5000); }
      });
      row.appendChild(del);
      list.appendChild(row);
    }
    card.querySelector('[data-close]').addEventListener('click', () => ov.remove());
    ov.appendChild(card);
    document.body.appendChild(ov);
  }

  // Download a title that isn't on this device yet (or re-adopt one). Asks
  // about files (with sizes) when the Drive copy has any.
  async function getEntry(entry) {
    let inclMedia = false;
    const mediaFiles = (entry.hasMedia || []).filter(m => m.driveFileId);
    if (mediaFiles.length) {
      const c = await fileOptInDialog(entry.titleName, mediaFiles, 'pull');
      if (c === null) return;
      inclMedia = c;
    }
    const prog = progress('Getting from Drive', 'Downloading…');
    try {
      const res = await window.driveSync.pull(entry.folderId, entry.manifest, {
        includeMedia: inclMedia, onProgress: mkOnProgress(prog, 'Downloading'),
        confirmNameMatch: () => Promise.resolve(true),
      });
      if (prog) prog.close();
      toast('Downloaded ✓');
      try { if (entry && entry.syncId) await window.driveIndex.undismiss(entry.syncId); } catch (_) {}   // re-added → may resurface if deleted again
      if (res && res.localId) {
        try { await window.titleStore.update(res.localId, { syncIncludeMedia: inclMedia }); } catch (_) {}
        try {
          const t = await window.titleStore.get(res.localId);
          if (t && typeof window.loadTitleFromLibrary === 'function') window.loadTitleFromLibrary(t);
        } catch (_) {}
      }
    } catch (e) {
      if (prog) prog.close();
      toast('Download failed: ' + (e && e.message ? e.message : 'unknown error'), 6000);
    }
  }

  // gdrive-auth clears tokens when the refresh token is revoked/expired — reflect that
  // in the prefs status (no longer "connected") and tell the user to reconnect.
  try {
    window.addEventListener('kai:gdrive-disconnected', () => {
      try { refreshStatus(); } catch (_) {}
      try { toast(window.i18n ? window.i18n.t('dr.access_expired', 'Google Drive access expired — reconnect in Preferences.') : 'Google Drive access expired — reconnect in Preferences.', 5000); } catch (_) {}
    });
  } catch (_) {}

  window.driveSyncUI = { syncUp, syncDown, downloadCloudTitle, browseDrive, refreshStatus, onConnectClick };

  // NOTE: sync is MANUAL-ONLY (user decision). The previous background
  // auto-push (on app-background / page-hide) and the auto-pull open-hook were
  // removed — they raced _activeTitleId reassignment and the reader init, which
  // was a major source of the "unreliable when switching titles" behavior.
  // Everything flows through the explicit Sync ↑ / Sync ↓ buttons.
})();
