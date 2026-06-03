// folder-import.js — bulk-import a folder tree of epub / audio / srt as Titles.
//
// Rule (matches the user's mental model):
//   • A folder that directly contains media → one or more Titles.
//   • A folder of subfolders → recurse (the native scan already flattens the
//     tree; we just group the returned files by their containing folder).
//   • One leaf folder = one Title when it holds a single book. epub↔audio↔srt
//     are paired by basename within the folder. A folder with multiple epubs
//     yields one Title per epub (audio/srt matched by basename stem).
//
// Attachments are stored LAZILY as { uri, name } — no bytes are copied at
// import time. The existing open paths (rehydrateTitleCachePaths for audio/srt,
// loadEpubFromUri for epub) materialize each file to cache on first open. So
// importing a large library is instant and copies nothing up front.
//
// Native contract (FileAccess.pickFolderTree, both platforms):
//   → { rootUri, rootName, files: [{ uri, name, dir, relPath, ext }] }
//   where `uri` is something materializeToCache({uri}) understands:
//     Android = a tree-scoped content:// document URI,
//     iOS     = a synthetic folder-child:// URI (resolved via the folder bookmark).

(function () {
  const AUDIO_EXTS = new Set(['mp3', 'm4a', 'm4b', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac']);
  const SRT_EXTS   = new Set(['srt', 'vtt', 'ass']);
  const EPUB_EXTS  = new Set(['epub']);

  let importing = false;

  function stripExt(name) { return (name || '').replace(/\.[^.]+$/, ''); }
  function baseName(p) { const s = (p || '').split('/'); return s[s.length - 1] || ''; }
  function toast(msg, ms) { try { window.showToast?.(msg, ms || 3000); } catch (_) {} }

  // ---------- progress modal (self-contained overlay) ----------

  function ensureModal() {
    let el = document.getElementById('folderImportOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'folderImportOverlay';
    el.style.cssText =
      'position:fixed;inset:0;z-index:9600;background:rgba(0,0,0,.66);display:flex;' +
      'align-items:center;justify-content:center;padding:24px;direction:ltr;';
    el.innerHTML =
      '<div style="background:#161616;border:1px solid #333;border-radius:14px;padding:20px;' +
        'width:100%;max-width:360px;box-shadow:0 12px 36px rgba(0,0,0,.6);">' +
        '<div style="font:600 14px/1.3 var(--font-sans,system-ui);color:#eee;margin-bottom:10px;">Import folder</div>' +
        '<div style="display:flex;justify-content:space-between;font:12px/1.4 var(--font-sans,system-ui);color:#aaa;margin-bottom:6px;">' +
          '<span id="folderImportLabel">Scanning…</span><span id="folderImportPct">0%</span>' +
        '</div>' +
        '<div style="height:6px;background:#222;border-radius:3px;overflow:hidden;">' +
          '<div id="folderImportFill" style="height:100%;width:0%;background:var(--accent-read,#4caf50);transition:width .2s;"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }
  function setProgress(pct, label) {
    ensureModal();
    const fill = document.getElementById('folderImportFill');
    const pctEl = document.getElementById('folderImportPct');
    const lbl = document.getElementById('folderImportLabel');
    const p = Math.max(0, Math.min(100, pct));
    if (fill) fill.style.width = p + '%';
    if (pctEl) pctEl.textContent = Math.round(p) + '%';
    if (lbl && label) lbl.textContent = label;
  }
  function hideModal() {
    const el = document.getElementById('folderImportOverlay');
    if (el) el.remove();
  }

  // ---------- grouping + classification (pure) ----------

  function groupByDir(files) {
    const m = new Map();
    for (const f of files) {
      const d = f.dir || '';
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(f);
    }
    return m;
  }

  // Pick the candidate whose basename stem best matches `target`. Falls back to
  // the only candidate, then to a substring match, then to the first.
  // Find the audio/srt that belongs to `target` (an epub or audio).
  //   • exact stem match wins;
  //   • else a strong (min-3-char) prefix match;
  //   • else, ONLY when the folder holds a single book (allowSingle) and there
  //     is exactly one candidate, pair them regardless of name.
  // allowSingle is false when a folder has multiple books, so several epubs
  // can't all grab the one stray audio (the "vol1/vol2 + vol1.mp3" case).
  function matchByStem(target, candidates, allowSingle) {
    if (!candidates.length) return null;
    const stem = stripExt(target.name).toLowerCase();
    const exact = candidates.find(c => stripExt(c.name).toLowerCase() === stem);
    if (exact) return exact;
    if (stem.length >= 3) {
      const pref = candidates.find(c => {
        const s = stripExt(c.name).toLowerCase();
        return s.length >= 3 && (s.startsWith(stem) || stem.startsWith(s));
      });
      if (pref) return pref;
    }
    if (allowSingle && candidates.length === 1) return candidates[0];
    return null;
  }

  // Produce 0+ "books" (each → one Title) from the files in one folder.
  function classifyFolder(dir, groupFiles, rootName) {
    const epubs  = groupFiles.filter(f => EPUB_EXTS.has(f.ext));
    const audios = groupFiles.filter(f => AUDIO_EXTS.has(f.ext));
    const srts   = groupFiles.filter(f => SRT_EXTS.has(f.ext));
    const folderName = dir ? baseName(dir) : (rootName || '');
    const books = [];

    if (epubs.length) {
      const single = epubs.length === 1;
      for (const epub of epubs) {
        books.push({
          name: (single ? (folderName || stripExt(epub.name)) : stripExt(epub.name)) || 'Untitled',
          epub,
          audio: matchByStem(epub, audios, single),
          srt: matchByStem(epub, srts, single)
        });
      }
    } else if (audios.length) {
      // No epub: an audiobook (+ srt) Title — enables Audio mode, and Card mode
      // when an SRT is present.
      const single = audios.length === 1;
      for (const audio of audios) {
        books.push({
          name: (single ? (folderName || stripExt(audio.name)) : stripExt(audio.name)) || 'Untitled',
          epub: null,
          audio,
          srt: matchByStem(audio, srts, single)
        });
      }
    }
    // Folders with only SRT (or nothing recognized) produce no Title.
    return books;
  }

  function attachmentsFor(book) {
    const att = {};
    if (book.epub)  att.epub      = { uri: book.epub.uri,  name: book.epub.name };
    if (book.audio) att.audiobook = { uri: book.audio.uri, name: book.audio.name };
    if (book.srt)   att.srt       = { uri: book.srt.uri,   name: book.srt.name };
    return att;
  }

  // Dedupe key: title name + the filenames of its parts. Catches re-imports of
  // the same folder even when the underlying URIs differ between picks.
  function bookKey(book) {
    return [book.name || '', book.epub?.name || '', book.audio?.name || '', book.srt?.name || ''].join('|');
  }
  function titleKey(t) {
    const a = t.attachments || {};
    return [t.name || '', a.epub?.name || '', a.audiobook?.name || '', a.srt?.name || ''].join('|');
  }

  // ---------- orchestration ----------

  async function importFolder() {
    if (importing) return;
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa || typeof fa.pickFolderTree !== 'function') {
      alert('Folder import requires the installed app (the native folder picker is unavailable here).');
      return;
    }
    if (!window.titleStore?.createMany) {
      alert('Title store unavailable.');
      return;
    }

    importing = true;
    let listener = null;
    try {
      setProgress(2, 'Choose a folder…');
      // Wire scan progress BEFORE picking (events can arrive during the scan).
      try {
        listener = await fa.addListener('folderScanProgress', (d) => {
          setProgress(8, `Scanning… ${(d && d.count) || 0} files found`);
        });
      } catch (_) {}

      let res;
      try {
        res = await fa.pickFolderTree();
      } catch (e) {
        if (String(e?.message || e).toLowerCase().includes('cancel')) { hideModal(); return; }
        throw e;
      }
      if (!res || res.cancelled) { hideModal(); return; }

      const files = Array.isArray(res.files) ? res.files : [];
      if (!files.length) {
        hideModal();
        toast('No epub / audio / srt files found in that folder.');
        return;
      }

      setProgress(40, `Found ${files.length} files — organizing…`);

      const groups = groupByDir(files);
      let books = [];
      for (const [dir, gf] of groups) books = books.concat(classifyFolder(dir, gf, res.rootName));

      if (!books.length) {
        hideModal();
        toast('No books (epub or audiobook) found to import.');
        return;
      }

      // Dedupe against the existing library AND within this batch.
      const existing = await window.titleStore.list();
      const seen = new Set(existing.map(titleKey));
      const fresh = [];
      let skipped = 0;
      for (const b of books) {
        const k = bookKey(b);
        if (seen.has(k)) { skipped++; continue; }
        seen.add(k);
        fresh.push(b);
      }

      if (!fresh.length) {
        hideModal();
        toast(`Already imported — ${books.length} book${books.length === 1 ? '' : 's'} skipped.`);
        return;
      }

      // Confirm before mutating the library. (hide the progress overlay so the
      // native confirm() isn't visually stacked under it.)
      hideModal();
      const ok = confirm(
        `Import ${fresh.length} book${fresh.length === 1 ? '' : 's'} from "${res.rootName || 'folder'}"?` +
        (skipped ? `\n(${skipped} already in your library — skipped)` : '')
      );
      if (!ok) return;

      setProgress(75, `Adding ${fresh.length} title${fresh.length === 1 ? '' : 's'}…`);
      const partials = fresh.map(b => ({ name: b.name || 'Untitled', attachments: attachmentsFor(b) }));
      const created = await window.titleStore.createMany(partials);

      setProgress(100, `Imported ${fresh.length} book${fresh.length === 1 ? '' : 's'}`);
      if (typeof window.populateLibrary === 'function') await window.populateLibrary();
      toast(`📁 Imported ${fresh.length} book${fresh.length === 1 ? '' : 's'}` + (skipped ? ` (${skipped} skipped)` : ''));
      setTimeout(hideModal, 1100);
      // Cover art: best-effort BACKGROUND pass (don't block import completion).
      // The library shows letter avatars immediately; embedded covers fill in
      // as each book's epub/audio is read.
      extractCoversForImport(created);
    } catch (e) {
      hideModal();
      alert('Folder import failed: ' + (e?.message || e));
    } finally {
      try { listener?.remove?.(); } catch (_) {}
      importing = false;
    }
  }

  // Background cover-art extraction for freshly-imported Titles. Materializes
  // each title's epub (preferred — small) or audio, pulls the embedded cover
  // (epub cover-image / ID3 APIC / MP4 covr), attaches it, and re-renders the
  // library as covers land. Best-effort and serial to avoid hammering I/O.
  // Note: materializing also pre-warms the open cache (first open is instant);
  // for very large libraries the audio fallback copies whole files.
  async function extractCoversForImport(titles) {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa?.materializeToCache || !window.coverExtract || !window.titleStore) return;
    let attached = 0;
    const rerender = async () => {
      if (typeof window.populateLibrary === 'function') { try { await window.populateLibrary(); } catch (_) {} }
    };
    for (const t of (titles || [])) {
      const a = t && t.attachments;
      if (!t?.id || !a || a.cover) continue;
      let cover = null;
      if (a.epub?.uri && window.coverExtract.fromEpub) {
        try {
          const m = await fa.materializeToCache({ uri: a.epub.uri });
          if (m?.path) { cover = await window.coverExtract.fromEpub(m.path); if (cover) cover.source = 'epub'; }
        } catch (_) {}
      }
      if (!cover && a.audiobook?.uri && window.coverExtract.fromAudio) {
        try {
          const m = await fa.materializeToCache({ uri: a.audiobook.uri });
          if (m?.path) { cover = await window.coverExtract.fromAudio(m.path); if (cover) cover.source = 'id3'; }
        } catch (_) {}
      }
      if (cover?.dataUri) {
        try {
          await window.titleStore.attach(t.id, 'cover',
            { dataUri: cover.dataUri, mime: cover.mime, source: cover.source || 'epub', name: 'cover' });
          attached++;
          if (attached % 3 === 0) await rerender();   // progressive, throttled
        } catch (_) {}
      }
    }
    if (attached) await rerender();
  }

  window.importFolder = importFolder;
  window.extractCoversForImport = extractCoversForImport;
  // Expose pure helpers for testing / reuse.
  window.folderImport = { groupByDir, classifyFolder, matchByStem, attachmentsFor, bookKey };
})();
