// Native iOS Library (NativeLibrary.swift draws it).
//
// openLibrary() on iOS shows the native screen instead of #libraryPage. The
// web library's own helpers decide what is listed — the folder scope,
// filter, sort, series grouping and pins (libFolderList, libFilterPass,
// libSortTitles, groupSeries) — so both libraries always agree. Every action
// runs the web library's own function: opening a title is
// loadTitleFromLibrary(title), exactly the web path, and the sheets (Edit,
// Move, Stats, New title, Import folder) are the web sheets: the native
// screen steps aside while one covers the screen.
// The card-tab pane library (openLibrary({pane:true})) stays web.
(function () {
  'use strict';
  if (!window.KADOKI_NATIVE_LIBRARY) return;
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativeLibrary.postMessage(msg); } catch (_) {} };
  const T = (k, d) => window.i18n.t(k, d);
  let nativeOpen = false;
  const titleById = new Map();

  // ---- cover thumbnails (cached per title + source) ----
  const thumbs = new Map();
  function thumb(t) {
    const src = t.attachments?.cover?.dataUri;
    if (!src) return Promise.resolve('');
    const key = t.id + ':' + src.length;
    if (thumbs.has(key)) return thumbs.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const h = 360, w = Math.max(1, Math.round(img.width * h / img.height));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (_) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
    thumbs.set(key, p);
    return p;
  }

  // Length · characters · difficulty (the web libMetaLineHtml, as text).
  function metaLine(t, blurb) {
    const m = t.meta || {};
    const bits = [];
    const h = window.libraryMeta ? window.libraryMeta.fmtHours(m.durationMs) : '';
    const c = window.libraryMeta ? window.libraryMeta.fmtChars(m.chars) : '';
    if (h) bits.push(h);
    if (c) bits.push(c + ' ' + T('lib.chars_unit', 'chars'));
    const d = libDifficulty(t, blurb);
    if (d) bits.push((d.approx ? '≈' : '') + (d.score ? d.score.toFixed(1) : d.n) + '/5');
    return bits.join(' · ');
  }

  async function describeTitle(t, blurb) {
    const a = t.attachments || {};
    const video = !!(a.audiobook && (a.audiobook.isVideo || /\.(mp4|m4v|mov|3gp|mkv)$/i.test(a.audiobook.name || '')));
    // Pills in the live mode accents (a custom Read color shows here too),
    // as the web chips: SRT has no mode of its own and uses the warn color.
    const root = getComputedStyle(document.documentElement);
    const color = (v, d) => root.getPropertyValue(v).trim() || d;
    const kinds = [];
    if (a.deck) kinds.push({ l: 'DECK', c: color('--accent-card', '#ff9550') });
    if (a.epub) kinds.push({ l: a.epub.auto ? 'AUTO TEXT' : 'EPUB', c: color('--accent-read', '#4caf50') });
    if (a.audiobook) kinds.push({ l: video ? 'VIDEO' : 'AUDIO', c: color('--accent-audio', '#b794f6') });
    if (a.srt) kinds.push({ l: 'SRT', c: color('--accent-warn', '#ffd54a') });
    const d = libDifficulty(t, blurb);
    const lang = libPref('LIB_BLURB_LANG', 'ja');
    return {
      id: t.id,
      name: t.name || 'Untitled',
      author: t.author || '',
      cover: await thumb(t),
      kinds,
      progress: titleProgressPct(t),
      opened: new Date(t.lastOpenedAt || t.createdAt || Date.now()).toLocaleDateString(),
      meta: metaLine(t, blurb),
      difficulty: d ? d.n : 0,
      pinned: !!t.pinnedAt,
      want: !!t.wantToRead,
      readingBook: !!t.readingBook,
      canReadingBook: !!(window.KADOKI_DUO && window.duoReading && a.epub),
      cloud: !!t.cloudOnly,
      summary: blurb ? ((lang === 'ja' ? blurb.ja : blurb.en) || []) : [],
      tags: blurb ? (((lang === 'ja' ? blurb.tags_ja : blurb.tags_en) || []).slice(0, 4)) : [],
      canSummarize: !!(a.epub && window.libraryBlurb && window.ai?.isEnabled?.()),
    };
  }

  async function describe() {
    const all = window.titleStore ? await window.titleStore.list() : [];
    all.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    titleById.clear();
    all.forEach(t => titleById.set(t.id, t));
    const folders = libFolderList(all);
    let cur = libCurFolder();
    if (cur && !folders.some(f => f.name === cur)) { cur = ''; libSetCurFolder(''); }
    const here = all.filter(t => (t.folder || '') === cur);
    const blurbs = {};
    try {
      if (window.libraryBlurb) {
        const got = await Promise.all(here.map(t => window.libraryBlurb.get(t.id).catch(() => null)));
        here.forEach((t, i) => { blurbs[t.id] = got[i]; });
      }
    } catch (_) {}
    const shown = libSortTitles(here.filter(t => libFilterPass(t, blurbs[t.id])), blurbs);
    const groups = [];
    for (const g of groupSeries(shown)) {
      if (g.type === 'series') {
        groups.push({ series: seriesDisplayName(g.titles[0]?.name), titles: await Promise.all(g.titles.map(t => describeTitle(t, blurbs[t.id]))) });
      } else {
        groups.push({ series: '', titles: [await describeTitle(g.t, blurbs[g.t.id])] });
      }
    }
    const pinned = cur ? [] : await Promise.all(all.filter(t => t.pinnedAt && !t.cloudOnly).slice(0, PIN_MAX).map(t => describeTitle(t, null)));
    return {
      title: T('lib.library', 'Library'),
      folder: cur,
      folders: cur ? [] : folders.map(f => ({ name: f.name, count: f.titles.length })),
      pinned,
      groups,
      total: all.length,
      empty: !here.length
        ? (cur ? T('lib.folder_empty', 'This folder is empty. Tap Select, pick titles, then Move.') : (all.length ? T('lib.all_in_folders', 'Every title is in a folder.') : 'Library is empty.'))
        : (!shown.length ? 'No titles match this filter.' : ''),
      view: libPref('LIB_VIEW_V1', 'list'),
      filter: libPref('LIB_FILTER_V1', 'all'),
      sort: libPref('LIB_SORT_V1', 'recent'),
      filters: FILTERS().map(([v, l]) => ({ v, l })),
      sorts: SORTS().map(([v, l]) => ({ v, l })),
      blurbLang: libPref('LIB_BLURB_LANG', 'ja'),
      strings: {
        open: T('lib.open', 'Open'), pin: T('lib.pin', 'Pin'), unpin: T('lib.unpin', 'Unpin'),
        want: T('lib.want', 'Want to read'), readingBook: T('lib.reading_book', 'Reading book'),
        move: T('lib.move', 'Move'), stats: T('lib.stats', 'Stats'), edit: T('lib.edit', 'Edit'),
        del: T('lib.delete', 'Delete'), summarize: T('lib.summarize', 'Summarize'), newSummary: T('lib.new_summary', 'New summary'),
        newTitle: T('lib.new_title', 'New title').replace(/^[+＋]\s*/, ''), importFolder: T('lib.import_folder', 'Import folder'),
        newFolder: T('lib.new_folder', 'New folder'), list: T('lib.view_list', 'List'), gallery: T('lib.view_gallery', 'Gallery'),
        show: T('lib.show', 'Show'), sort: T('lib.sort', 'Sort'), library: T('lib.library', 'Library'),
        noSummary: window.ai?.isEnabled?.() ? T('lib.summary_none', 'No summary yet.') : T('lib.summary_ai_off', 'Enable the AI assistant in Preferences to get summaries.'),
        cloud: '☁ In cloud — tap to download',
      },
    };
  }

  const model = async () => JSON.stringify(await describe());
  window.__kadokiLibDescribe = model;

  // Actions. Each is the web library's own function for that button.
  window.__kadokiLibAction = async function (action, id, arg) {
    const t = id ? (titleById.get(id) || await window.titleStore.get(id)) : null;
    switch (action) {
      case 'open':
        close(false);
        loadTitleFromLibrary(t);
        return '';
      case 'pin': await togglePinTitle(t); break;
      case 'want': await toggleWantToRead(t); break;
      case 'reading': await toggleReadingBook(t); break;
      case 'move': openMoveSheet([id]); break;
      case 'stats': window.openTitleStats(id); break;
      case 'edit': openTitleEdit(id); break;
      case 'summarize': try { await window.libraryBlurb.regenerate(id); } catch (_) {} break;
      case 'delete':
        if (!(window.titleStore && confirm('Remove this title from your library?'))) break;
        // Deletes are local-only: dismiss the syncId FIRST so an immediate Sync
        // can't resurrect it from the cloud index (as the web library does).
        try { if (t && t.syncId && window.driveIndex) await window.driveIndex.dismiss(t.syncId); } catch (_) {}
        try { await window.titleStore.remove(id); } catch (_) {}
        break;
      case 'folder': libSetCurFolder(arg || ''); break;
      case 'folderSheet': openFolderSheet(arg); break;
      case 'newFolder': openNewFolderSheet(); break;
      case 'newTitle': window.createNewTitle?.(); break;
      case 'importFolder': window.importFolder?.(); break;
      case 'view': libSet('LIB_VIEW_V1', arg); break;
      case 'filter': libSet('LIB_FILTER_V1', arg); break;
      case 'sort': libSet('LIB_SORT_V1', arg); break;
      case 'blurbLang': libSet('LIB_BLURB_LANG', arg); break;
    }
    await new Promise(r => setTimeout(r, 300));
    checkCover();
    return model();
  };

  // ---- open / close ----
  // The library functions live in index.html's inline script, which runs after
  // this file: wrap them once the document has loaded.
  let origOpen = null, origClose = null;
  function wrap() {
    origOpen = window.openLibrary;
    origClose = window.closeLibrary;
    if (typeof origOpen !== 'function' || typeof origClose !== 'function') return;
    window.openLibrary = openNative;
    window.closeLibrary = closeBoth;
  }
  async function openNative(opts) {
    if (opts && opts.pane) return origOpen.apply(this, arguments);
    if (window.stats?.pauseForModal) window.stats.pauseForModal();
    nativeOpen = true;
    covered = false;
    document.body.classList.add('native-library-open');   // native-menu.js: hamburger off
    baseline = new Set(overlays());
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    post({ type: 'open', model: await model() });
    try { Promise.resolve(window.libraryBlurb?.runQueue?.()).catch(() => {}).finally(() => { try { window.libraryMeta?.ensureAll?.(); } catch (_) {} }); } catch (_) {}
  }
  function close(notify) {
    if (!nativeOpen) return;
    nativeOpen = false; covered = false;
    watch.disconnect();
    document.body.classList.remove('native-library-open');
    if (window.stats?.resumeFromModal) window.stats.resumeFromModal();
    post({ type: 'closed' });
  }
  window.__kadokiLibClose = () => close(true);
  // The web closeLibrary() (a title open from anywhere) closes the native one too.
  function closeBoth() {
    if (nativeOpen) close(true);
    return origClose.apply(this, arguments);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrap);
  else wrap();

  // ---- a web sheet over the screen while the native Library is up ----
  // Full-screen fixed layers that were already there when the Library opened
  // (the audio / reading views) are the app, not a sheet: only new ones count.
  let covered = false;
  let baseline = new Set();
  function overlays() {
    const vw = innerWidth, vh = innerHeight, out = [];
    for (const el of document.body.children) {
      if (el.id === 'libraryPage' || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.3) out.push(el);
    }
    return out;
  }
  function checkCover() {
    if (!nativeOpen) return;
    const on = overlays().some(el => !baseline.has(el));
    if (on !== covered) { covered = on; post({ type: 'cover', on }); }
  }
  const watch = new MutationObserver(checkCover);
})();
