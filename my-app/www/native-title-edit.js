// Native iOS Edit Title (NativeTitleEdit.swift). The web editor
// (index.html openTitleEdit / #titleEditModal) still runs underneath, kept out
// of sight, so every button here calls the web editor's own function: file
// picks, cover extraction, Send to Apple Watch, Create book. This file builds
// the form's model from the title and re-sends it whenever something changes.
// Inert unless native injected window.KADOKI_NATIVE_TITLEEDIT (iOS 16+).
(function () {
  'use strict';
  if (!window.KADOKI_NATIVE_TITLEEDIT) return;
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativeTitleEdit.postMessage(msg); } catch (_) {} };
  const T = (k, d) => { try { return window.i18n.t(k, d); } catch (_) { return d; } };
  // The web editor stays out of sight for good (it is only ever opened to set
  // up its fields): showing it, even for a frame, made the native Library
  // think a web dialog had opened and fade out and back.
  document.documentElement.classList.add('kadoki-native-titleedit');
  try {
    const st = document.createElement('style');
    st.textContent = 'html.kadoki-native-titleedit #titleEditModal{display:none!important}';
    document.head.appendChild(st);
  } catch (_) {}
  const color = (v, d) => { try { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || d; } catch (_) { return d; } };
  let open = false, tid = null;

  // Cover thumbnail, small (the full data URI can be megabytes).
  const thumbs = new Map();
  function thumb(src) {
    if (!src) return Promise.resolve('');
    const key = src.length + ':' + src.slice(-32);
    if (thumbs.has(key)) return thumbs.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const h = 240, w = Math.max(1, Math.round(img.width * h / img.height));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (_) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
    thumbs.set(key, p);
    return p;
  }

  async function model() {
    const t = tid ? await window.titleStore.get(tid) : null;
    if (!t) return null;
    const a = t.attachments || {};
    let style = '';
    try { const v = await window.blobStore?.get('AISTYLE_V1_' + tid); if (typeof v === 'string') style = v; } catch (_) {}
    // Each row carries the library's coloured pill for its kind.
    const video = !!window.titleStore?.isVideoTitle?.(t);
    const pills = {
      epub: { l: a.epub?.auto ? 'AUTO TEXT' : 'EPUB', c: color('--accent-read', '#4caf50') },
      audiobook: { l: video ? 'VIDEO' : 'AUDIO', c: color('--accent-audio', '#b794f6') },
      srt: { l: 'SRT', c: color('--accent-warn', '#ffd54a') },
      deck: { l: 'DECK', c: color('--accent-card', '#ff9550') },
    };
    const row = (id, label, indent) => ({ id, label, indent, file: a[id]?.name || '', attached: !!a[id], pill: pills[id]?.l || '', color: pills[id]?.c || '' });
    const watchEl = document.getElementById('watchSendStatus');
    return JSON.stringify({
      id: tid,
      name: t.name || '',
      style,
      reading: [row('epub', 'EPUB / TXT', false), row('audiobook', T('te.audiobook', 'Audiobook'), true), row('srt', T('te.srt', 'SRT subtitles'), true)],
      cards: [row('deck', T('te.deck', 'Anki deck (.apkg)'), false)],
      createBook: !a.epub && !!a.audiobook,
      watch: !!(a.audiobook && window.Capacitor?.Plugins?.WatchBridge),
      watchStatus: (watchEl?.textContent || '').trim(),
      cover: {
        thumb: await thumb(a.cover?.dataUri || ''),
        source: a.cover ? (a.cover.source || 'manual') : '',
        hasEpub: !!a.epub?.uri,
        hasAudio: !!a.audiobook?.cachePath,
      },
      strings: {
        title: T('te.title', 'Edit Title'), name: T('te.name', 'Title name'), done: T('te.done', 'Done'),
        reading: T('te.reading', 'Reading'), cards: T('te.cards', 'Cards'), cover: T('te.cover', 'Cover'),
        pick: T('te.pick', 'Pick'), replace: T('te.replace', 'Replace'), remove: T('te.remove', 'Remove'),
        notAttached: T('te.not_attached', 'Not attached'),
        createBook: T('te.create_book', 'Create book from transcription'),
        createBookNote: T('te.create_book_note', 'Packages the generated subtitles as an EPUB so this title gains Read mode.'),
        watch: T('te.watch', 'Send to Apple Watch'),
        watchNote: T('te.watch_note', 'Audio + subtitles for offline listening. Large books take a while; keep both devices nearby.'),
        coverNone: T('te.cover_none', 'No cover'), coverFrom: T('te.cover_from', 'Use cover from'),
        epub: 'EPUB', audio: T('te.audio', 'Audio'), clipboard: T('te.clipboard', 'Clipboard'),
        styleLabel: T('te.style', 'AI illustration style'),
        stylePlaceholder: T('te.style_ph', 'Leave empty and the AI picks one from the book (or describe it in English).'),
        styleNote: T('te.style_note', 'Applies to every character and scene picture.'),
        del: T('te.delete', 'Delete Title'), delConfirm: T('lib.delete_confirm', 'Remove this title from your library?'),
      },
    });
  }
  async function send() { if (open) { const m = await model(); if (m) post({ type: 'model', model: m }); } }
  let sendT = 0;
  const sendSoon = () => { clearTimeout(sendT); sendT = setTimeout(send, 120); };

  // ---- open / close ----
  let origOpen = null, origClose = null;
  let watchObs = null;
  async function openNative(id) {
    await origOpen(id);                  // sets up the web editor (fields, handlers, rows)
    const modal = document.getElementById('titleEditModal');
    if (modal) modal.style.display = 'none';
    tid = id; open = true;
    document.body.classList.add('native-titleedit-open');
    baseline = new Set(overlays());
    coverWatch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    // Rows re-render after a pick / remove / cover change; the watch status
    // line updates while a transfer runs.
    const cont = document.getElementById('titleEditAttachments');
    watchObs = new MutationObserver(sendSoon);
    if (cont) watchObs.observe(cont, { childList: true, subtree: true, characterData: true });
    const m = await model();
    if (m) post({ type: 'open', model: m });
  }
  function closeNative() {
    if (!open) return;
    open = false; tid = null; covered = false;
    coverWatch.disconnect();
    try { watchObs?.disconnect(); } catch (_) {}
    document.body.classList.remove('native-titleedit-open');
    post({ type: 'closed' });
    try { window.__kadokiLibRefreshNative?.(); } catch (_) {}
  }
  function wrap() {
    origOpen = window.openTitleEdit;
    origClose = window.closeTitleEdit;
    if (typeof origOpen !== 'function' || typeof origClose !== 'function') return;
    window.openTitleEdit = openNative;
    window.closeTitleEdit = function () { const r = origClose.apply(this, arguments); closeNative(); return r; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrap);
  else wrap();

  // ---- actions from the native form ----
  window.__kadokiTitleEdit = async function (action, arg) {
    if (!open || !tid) return;
    const id = tid;
    switch (action) {
      case 'name': {
        const v = String(arg || '');
        const inp = document.getElementById('titleEditName');
        if (inp) inp.value = v;
        try { await window.titleStore.update(id, { name: v }); } catch (_) {}
        return;   // no re-send: the field is the source of truth while typing
      }
      case 'style': {
        const ta = document.getElementById('titleEditStyle');
        if (ta) { ta.value = String(arg || ''); ta.onchange?.(); }
        return;
      }
      case 'pick': await window.pickTitleAttachment?.(arg); break;
      case 'remove': await window.removeTitleAttachment?.(arg); break;
      case 'createBook': await window.createBookFromTranscription?.(); break;
      case 'watch': await window.sendTitleToWatch?.(); break;
      case 'coverEpub': await window.setTitleCoverFromEpub?.(); break;
      case 'coverAudio': await window.setTitleCoverFromAudio?.(); break;
      case 'coverClipboard': await window.setTitleCoverFromClipboard?.(); break;
      case 'delete': {
        // Native already asked (its own confirmation dialog).
        try {
          const t = await window.titleStore.get(id);
          if (t && t.syncId && window.driveIndex) await window.driveIndex.dismiss(t.syncId);
        } catch (_) {}
        try { await window.titleStore.remove(id); } catch (_) {}
        window.closeTitleEdit();
        try { window.populateLibrary?.(); } catch (_) {}
        return;
      }
      case 'done': window.closeTitleEdit(); return;
    }
    sendSoon();
  };

  // ---- a web sheet / progress dialog over the screen ----
  // Same rule as the native Library: full-screen fixed layers already there
  // when the editor opened are the app; a new one means a web dialog is up.
  let covered = false, baseline = new Set();
  function overlays() {
    const vw = innerWidth, vh = innerHeight, out = [];
    for (const el of document.body.children) {
      if (el.id === 'titleEditModal' || el.id === 'libraryPage' || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.3) out.push(el);
    }
    return out;
  }
  function checkCover() {
    if (!open) return;
    const on = overlays().some(el => !baseline.has(el));
    if (on !== covered) { covered = on; post({ type: 'cover', on }); if (!on) sendSoon(); }
  }
  const coverWatch = new MutationObserver(checkCover);
})();
