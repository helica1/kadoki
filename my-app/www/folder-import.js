// folder-import.js — bulk-import a folder tree of epub / audio / srt as Titles.
//
// Rule (matches the user's mental model):
//   • Files loose in one big folder, one folder per book, or one folder per
//     book holding several volumes (上/下, 1/2/3) all work: pairing happens
//     within each folder first (import-pairing.js: tags + fuzzy names +
//     volume guards), then a stricter cross-folder pass catches an EPUB and
//     its audiobook that live in different folders.
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
  // Video files import as the AUDIOBOOK attachment (a video is "an audiobook
  // whose file has pictures"): audio mode plays it (native AVPlayer engine),
  // card mode gets SRT cards, AudioSlicer clips its audio track. The isVideo
  // flag (plus extension sniffing at open time) tells the visionOS layer to
  // show the native video surface.
  const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', '3gp', 'mkv']);   // mkv: losslessly remuxed to mp4 at first open (native kadoki_remux)
  // Scanned so we can EXPLAIN, never imported: AVFoundation cannot play these
  // containers (the classic mkv season rip). The import toast tells the user
  // to convert instead of silently claiming "no books found".
  // mkv only plays where the remux library ships (visionOS device builds) —
  // on iPhone/iPad it joins the explain-don't-import set at scan time.
  const UNPLAYABLE_VIDEO_EXTS = new Set(['avi', 'wmv']);
  // mkv plays wherever the remux library ships: visionOS AND iOS device
  // builds (libkadokiremux-xros.a / -ios.a). Android/web still explain.
  function mkvOk() {
    const p = window.Capacitor?.getPlatform?.();
    // Android: ExoPlayer demuxes Matroska natively — no remux step needed.
    return !!window.KADOKI_VISION_NATIVE || p === 'ios' || p === 'android';
  }
  function extUnplayable(ext) {
    return UNPLAYABLE_VIDEO_EXTS.has(ext) || (ext === 'mkv' && !mkvOk());
  }
  function videoExtOk(ext) {
    return VIDEO_EXTS.has(ext) && !(ext === 'mkv' && !mkvOk());
  }
  const SRT_EXTS   = new Set(['srt', 'vtt', 'ass']);
  const EPUB_EXTS  = new Set(['epub', 'txt']);   // txt = a plain-text book (read mode)

  let importing = false;

  function stripExt(name) { return (name || '').replace(/\.[^.]+$/, ''); }
  // Human summary of a batch: "1 video series (12 episodes)", "2 books,
  // 1 audiobook", "1 video" — instead of calling everything a "book".
  function describeBatch(list) {
    const n = { series: 0, episodes: 0, video: 0, book: 0, audiobook: 0 };
    for (const b of list) {
      if (Array.isArray(b.series) && b.series.length) { n.series++; n.episodes += b.series.length; }
      else if (b.audio && VIDEO_EXTS.has(b.audio.ext)) n.video++;
      else if (b.epub) n.book++;
      else n.audiobook++;
    }
    const parts = [];
    const pl = (k, one, many) => k === 1 ? `1 ${one}` : `${k} ${many}`;
    if (n.series) parts.push(pl(n.series, 'video series', 'video series') + ` (${pl(n.episodes, 'episode', 'episodes')})`);
    if (n.video) parts.push(pl(n.video, 'video', 'videos'));
    if (n.book) parts.push(pl(n.book, 'book', 'books'));
    if (n.audiobook) parts.push(pl(n.audiobook, 'audiobook', 'audiobooks'));
    return parts.join(', ') || `${list.length} item${list.length === 1 ? '' : 's'}`;
  }
  function baseName(p) { const s = (p || '').split('/'); return s[s.length - 1] || ''; }
  function toast(msg, ms) { try { window.showToast?.(msg, ms || 3000); } catch (_) {} }
  const T = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;

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
    const audios = groupFiles.filter(f => AUDIO_EXTS.has(f.ext) || videoExtOk(f.ext));
    const srts   = groupFiles.filter(f => SRT_EXTS.has(f.ext));
    const folderName = dir ? baseName(dir) : (rootName || '');
    const books = [];

    if (epubs.length) {
      const single = epubs.length === 1;
      const P = window.importPairing;
      if (P && typeof P.pairGroup === 'function') {
        // Metadata + fuzzy-name pairing with volume guards (import-pairing.js).
        // Unpaired audiobooks in a mixed folder become audiobook Titles of
        // their own (a giant flat folder is the normal case now).
        const plainAudios = audios.filter(a => !videoExtOk(a.ext));
        const r = P.pairGroup(epubs, plainAudios, srts, { allowSingle: single && plainAudios.length === 1 });
        for (const b of r.books) {
          b.name = nameFor(b, single, folderName);
          b._cands = { audios: r.audios, srts: r.srts };
          b._review = r.review;
          b._dir = dir || '';
          books.push(b);
        }
        return books;
      }
      for (const epub of epubs) {
        books.push({
          name: (single ? (folderName || stripExt(epub.name)) : stripExt(epub.name)) || 'Untitled',
          epub,
          audio: matchByStem(epub, audios, single),
          srt: matchByStem(epub, srts, single)
        });
      }
    } else if (audios.length) {
      const videos = audios.filter(f => videoExtOk(f.ext));
      if (videos.length >= 2 && videos.length === audios.length) {
        // A SERIES: one folder of episodes (video + per-episode SRT) becomes a
        // SINGLE Title. attachments.audiobook/srt point at the CURRENT episode
        // (starts at ep 1); attachments.series lists them all in order —
        // video-mode.js advances through it at end-of-episode.
        const eps = videos.slice().sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
        const series = eps.map(v => {
          const m = matchByStem(v, srts, false);
          return { video: { uri: v.uri, name: v.name }, srt: m ? { uri: m.uri, name: m.name } : null };
        });
        books.push({
          name: folderName || stripExt(eps[0].name) || 'Untitled',
          epub: null,
          audio: eps[0],
          srt: series[0].srt ? srts.find(s => s.name === series[0].srt.name) : null,
          series
        });
      } else {
        // No epub: an audiobook (+ srt) Title — enables Audio mode, and Card
        // mode when an SRT is present.
        const single = audios.length === 1;
        for (const audio of audios) {
          const mt = (audio.metaTitle && audio.metaTitle.length <= 80) ? audio.metaTitle.trim() : '';
          books.push({
            name: (single ? (folderName || mt || stripExt(audio.name)) : (mt || stripExt(audio.name))) || 'Untitled',
            epub: null,
            audio,
            srt: matchByStem(audio, srts, single),
            _dir: dir || ''
          });
        }
      }
    }
    // Folders with only SRT (or nothing recognized) produce no Title.
    return books;
  }

  // Title name: the EPUB's own title tag when it has one (a folder of rips
  // named "[B0…]-cbr" gets the real book title), else the old folder/stem rule.
  function nameFor(b, single, folderName) {
    const mt = (b.epub && b.epub.metaTitle) || (!b.epub && b.audio && b.audio.metaTitle) || '';
    const clean = mt && mt.length <= 80 ? mt.trim() : '';
    if (single && b.epub) return (folderName || clean || stripExt(b.epub.name)) || 'Untitled';
    const stem = b.epub ? stripExt(b.epub.name) : (b.audio ? stripExt(b.audio.name) : '');
    return (clean || stem) || 'Untitled';
  }

  function attachmentsFor(book) {
    const att = {};
    if (book.epub)  att.epub      = { uri: book.epub.uri,  name: book.epub.name };
    if (book.epub && book.epub.cachePath) att.epub.cachePath = book.epub.cachePath;   // materialized for the metadata read
    if (book.audio) {
      att.audiobook = { uri: book.audio.uri, name: book.audio.name };
      if (VIDEO_EXTS.has(book.audio.ext)) att.audiobook.isVideo = true;
    }
    if (book.srt)   att.srt       = { uri: book.srt.uri,   name: book.srt.name };
    if (book.series) att.series   = book.series;
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

  // ---------- pairing review sheet ----------
  // Shown only when the matcher was unsure about a pair or left both an EPUB
  // and an audiobook unmatched. Tap an audiobook cell to swap it for another
  // candidate (or none); an audiobook taken from another row goes back to
  // "unpaired". Resolves with the (edited) book list, or null on cancel.
  function reviewPairs(books, rootName, skipped) {
    return new Promise((resolve) => {
      const P = window.importPairing;
      const T = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
      const esc = (s) => String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      let list = books.slice();
      const ov = document.createElement('div');
      ov.id = 'importReviewOverlay'; ov.className = 'kai-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:9650;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:12px;direction:ltr;';
      const card = document.createElement('div');
      card.style.cssText = 'background:#141419;border:1px solid #2a2a33;border-radius:16px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 14px 40px rgba(0,0,0,.6);';
      card.innerHTML =
        '<div style="padding:14px 16px 8px;border-bottom:1px solid #22222a;">' +
          '<div style="font:700 15px/1.3 var(--font-sans,system-ui);color:#f0f0f4;"></div>' +
          '<div style="font:12px/1.4 var(--font-sans,system-ui);color:#8a8a96;margin-top:3px;"></div>' +
        '</div>' +
        '<div class="ir-list" style="flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 10px;"></div>' +
        '<div style="display:flex;gap:10px;padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 12px);border-top:1px solid #22222a;">' +
          '<button class="ir-cancel" style="flex:1;background:#22222b;border:1px solid #33333e;color:#ccccd6;border-radius:10px;padding:11px 0;font-size:.9rem;"></button>' +
          '<button class="ir-ok" style="flex:2;background:var(--accent-read,#4caf50);border:none;color:#0b0b0e;font-weight:700;border-radius:10px;padding:11px 0;font-size:.95rem;"></button>' +
        '</div>';
      const head = card.firstElementChild;
      head.children[0].textContent = T('ir.title', 'Import from') + ' ' + rootName;
      head.children[1].textContent = T('ir.sub', 'Uncheck anything you don\'t want. Tap an audiobook to change it.') + (skipped ? ' ' + skipped + ' ' + T('ir.skipped', 'already in your library.') : '');
      const listEl = card.querySelector('.ir-list');
      const okBtn = card.querySelector('.ir-ok'), cancelBtn = card.querySelector('.ir-cancel');
      cancelBtn.textContent = T('common.cancel', 'Cancel');
      const badge = (score) => {
        if (score == null) return '';
        const pct = Math.round(score * 100);
        const col = score >= P.REVIEW_MIN ? 'var(--accent-read,#4caf50)' : (score >= P.ACCEPT_MIN ? '#ffd54a' : '#888');
        return '<span style="flex:none;font-size:.7rem;font-weight:700;color:' + col + ';border:1px solid ' + col + ';border-radius:999px;padding:1px 7px;margin-left:8px;">' + pct + '%</span>';
      };
      const rowCss = 'padding:10px 8px 10px 4px;border-bottom:1px solid #1e1e26;display:flex;gap:8px;align-items:flex-start;';
      const cellCss = 'display:flex;align-items:center;gap:8px;font-size:.84rem;line-height:1.35;';
      // Include toggle (round check) at the left of every row.
      const tick = (b) => {
        const t = document.createElement('button');
        t.className = 'ir-tick';
        const on = !b._skip;
        t.style.cssText = 'flex:none;width:26px;height:26px;border-radius:50%;margin-top:2px;cursor:pointer;font-size:.9rem;line-height:1;' +
          (on ? 'background:var(--accent-read,#4caf50);border:1px solid var(--accent-read,#4caf50);color:#0b0b0e;' : 'background:transparent;border:1px solid #3a3a44;color:transparent;');
        t.textContent = '✓';
        t.setAttribute('aria-label', on ? 'Included' : 'Excluded');
        t.addEventListener('click', (e) => { e.stopPropagation(); b._skip = !b._skip; try { window.kHaptic?.(); } catch (_) {} render(); });
        return t;
      };
      const body = (b) => { const d = document.createElement('div'); d.style.cssText = 'flex:1;min-width:0;' + (b._skip ? 'opacity:.45;' : ''); return d; };
      const render = () => {
        listEl.innerHTML = '';
        const withEpub = list.filter(b => b.epub);
        const audioOnly = list.filter(b => !b.epub && b.audio && !(Array.isArray(b.series) && b.series.length));
        const others = list.filter(b => !b.epub && !audioOnly.includes(b));
        for (const b of withEpub) {
          const row = document.createElement('div');
          row.style.cssText = rowCss;
          row.appendChild(tick(b));
          const bd = body(b); row.appendChild(bd);
          bd.innerHTML =
            '<div style="' + cellCss + 'color:#e8f1ff;font-weight:700;"><span style="flex:none;font-size:.62rem;letter-spacing:.08em;color:#8a93c4;border:1px solid #2f3a5e;border-radius:999px;padding:1px 6px;">EPUB</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(b.epub.name) + '</span></div>' +
            '<button class="ir-audio" style="' + cellCss + 'width:100%;text-align:left;margin-top:6px;background:#1a1a22;border:1px solid #2a2a33;border-radius:10px;padding:8px 10px;color:' + (b.audio ? '#e8e8f0' : '#8a8a96') + ';cursor:pointer;">' +
              '<span style="flex:none;font-size:.62rem;letter-spacing:.08em;color:#b794f6;border:1px solid #4a3c72;border-radius:999px;padding:1px 6px;">AUDIO</span>' +
              '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (b.audio ? esc(b.audio.name) : esc(T('ir.no_audio', 'No audiobook — tap to choose'))) + '</span>' + (b.audio ? badge(b.score) : '') +
            '</button>' +
            (b.srt ? '<div style="' + cellCss + 'margin-top:5px;color:#9a9aa6;font-size:.74rem;"><span style="flex:none;font-size:.6rem;letter-spacing:.08em;color:#ffd54a;border:1px solid #5a4d1a;border-radius:999px;padding:1px 6px;">SRT</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(b.srt.name) + '</span></div>' : '');
          bd.querySelector('.ir-audio').addEventListener('click', () => { if (!b._skip) chooseAudio(b); });
          listEl.appendChild(row);
        }
        if (audioOnly.length) {
          const h = document.createElement('div');
          h.style.cssText = 'padding:14px 8px 4px;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:#8a8a96;';
          h.textContent = T('ir.audio_only', 'Audiobooks without a book (imported as audiobook titles)');
          listEl.appendChild(h);
          for (const b of audioOnly) {
            const row = document.createElement('div');
            row.style.cssText = rowCss + 'color:#b9b9c4;';
            row.appendChild(tick(b));
            const bd = body(b); row.appendChild(bd);
            bd.innerHTML = '<div style="' + cellCss + '"><span style="flex:none;font-size:.62rem;letter-spacing:.08em;color:#b794f6;border:1px solid #4a3c72;border-radius:999px;padding:1px 6px;">AUDIO</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(b.audio.name) + '</span></div>';
            listEl.appendChild(row);
          }
        }
        if (others.length) {
          const h = document.createElement('div');
          h.style.cssText = 'padding:14px 8px 4px;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:#8a8a96;';
          h.textContent = T('ir.others', 'Also importing');
          listEl.appendChild(h);
          for (const b of others) {
            const row = document.createElement('div');
            row.style.cssText = rowCss + 'color:#b9b9c4;font-size:.84rem;';
            row.appendChild(tick(b));
            const bd = body(b); row.appendChild(bd);
            bd.textContent = b.name || '';
            listEl.appendChild(row);
          }
        }
        const chosen = list.filter(b => !b._skip);
        okBtn.textContent = chosen.length ? (T('ir.import', 'Import') + ' ' + describeBatch(chosen)) : T('ir.import_none', 'Nothing selected');
        okBtn.disabled = !chosen.length; okBtn.style.opacity = chosen.length ? '1' : '.5';
      };
      const chooseAudio = (b) => {
        const cands = (b._cands && b._cands.audios) || [];
        const ranked = P.rankCandidates(b.epub, cands).slice(0, 10);
        const sh = document.createElement('div');
        sh.style.cssText = 'position:fixed;inset:0;z-index:9660;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;';
        const sheet = document.createElement('div');
        sheet.style.cssText = 'width:min(100%,520px);max-height:70vh;overflow-y:auto;background:#141419;border:1px solid #2a2a33;border-bottom:0;border-radius:16px 16px 0 0;padding:12px 10px calc(env(safe-area-inset-bottom,0px) + 12px);';
        const mk = (label, sub, onPick, hi) => {
          const bt = document.createElement('button');
          bt.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0;background:' + (hi ? '#1d1830' : '#1a1a22') + ';border:1px solid ' + (hi ? '#5a4a8a' : '#2a2a33') + ';border-radius:10px;padding:10px 12px;color:#eee;font-size:.84rem;line-height:1.35;';
          bt.innerHTML = '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>' + (sub ? '<div style="color:#8a8a96;font-size:.72rem;margin-top:2px;"></div>' : '');
          bt.firstChild.textContent = label;
          if (sub) bt.lastChild.textContent = sub;
          bt.addEventListener('click', (e) => { e.stopPropagation(); sh.remove(); onPick(); });
          return bt;
        };
        sheet.appendChild(mk(T('ir.none', 'No audiobook'), '', () => setAudio(b, null), !b.audio));
        for (const c of ranked) {
          const owner = list.find(x => x !== b && x.audio === c.file);
          const sub = Math.round(c.score * 100) + '%' + (owner ? ' · ' + T('ir.used_by', 'currently paired with') + ' ' + (owner.epub ? owner.epub.name : owner.name) : '');
          sheet.appendChild(mk(c.file.name, sub, () => setAudio(b, c.file), b.audio === c.file));
        }
        sh.addEventListener('click', (e) => { if (e.target === sh) sh.remove(); });
        sh.appendChild(sheet); document.body.appendChild(sh);
      };
      const setAudio = (b, audio) => {
        const prev = b.audio;
        if (audio) {
          // Take it away from whoever had it (an epub row, or a leftover audiobook row).
          for (const x of list.slice()) {
            if (x === b || x.audio !== audio) continue;
            if (x.epub) { x.audio = null; x.score = null; x.srt = null; }
            else list.splice(list.indexOf(x), 1);
          }
        }
        b.audio = audio;
        b.score = audio ? P.scorePair(b.epub, audio) : null;
        // A displaced audiobook becomes its own title again.
        if (prev && prev !== audio && !list.some(x => x.audio === prev)) {
          list.push({ name: (prev.metaTitle && prev.metaTitle.length <= 80) ? prev.metaTitle : stripExt(prev.name), epub: null, audio: prev, srt: null, score: null, _cands: b._cands });
        }
        // Re-match SRTs for this row against the srts nobody else holds.
        const used = new Set(list.filter(x => x !== b && x.srt).map(x => x.srt));
        const m = P.matchSrt(b, (b._cands && b._cands.srts) || [], used);
        b.srt = m ? m.srt : null;
        b.name = nameFor(b, false, '');
        render();
      };
      okBtn.addEventListener('click', () => { ov.remove(); resolve(list.filter(b => !b._skip)); });
      cancelBtn.addEventListener('click', () => { ov.remove(); resolve(null); });
      render();
      ov.appendChild(card);
      document.body.appendChild(ov);
    });
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

      // Unplayable video containers: explain instead of a bare "no books".
      const unplayable = files.filter(f => extUnplayable(f.ext));
      const playable = unplayable.length ? files.filter(f => !UNPLAYABLE_VIDEO_EXTS.has(f.ext)) : files;
      for (const f of playable) {
        f.kind = EPUB_EXTS.has(f.ext) ? 'epub' : (AUDIO_EXTS.has(f.ext) ? 'audio' : (videoExtOk(f.ext) ? 'video' : (SRT_EXTS.has(f.ext) ? 'srt' : '')));
      }
      // Metadata pass (EPUB title/author from the package file; audio title/
      // artist/duration from the tags) — the strongest pairing signal, and it
      // becomes the Title's author + length in the library.
      if (window.importPairing?.readMeta) {
        const metaFiles = playable.filter(f => f.kind === 'epub' || f.kind === 'audio');
        if (metaFiles.length) {
          setProgress(42, `Reading file details… 0/${metaFiles.length}`);
          await window.importPairing.readMeta(metaFiles, (d, t) => setProgress(42 + 23 * (d / Math.max(1, t)), `Reading file details… ${d}/${t}`));
        }
      }

      const groups = groupByDir(playable);
      let books = [];
      for (const [dir, gf] of groups) books = books.concat(classifyFolder(dir, gf, res.rootName));
      // Cross-folder pass: an EPUB left alone in one folder and an audiobook
      // left alone in another (e.g. "epubs/" + "audio/" subfolders) pair up
      // here — with a STRICTER bar than within a folder, since a shared folder
      // is itself evidence. Pairs under the review bar go to the sheet.
      try {
        const P = window.importPairing;
        if (P) {
          const loneEpubs = books.filter(b => b.epub && !b.audio);
          const loneAudios = books.filter(b => !b.epub && b.audio && !(Array.isArray(b.series) && b.series.length) && !videoExtOk(b.audio.ext));
          const CROSS_MIN = 0.7;
          const cand = [];
          for (const e of loneEpubs) for (const a of loneAudios) { if (e._dir === a._dir) continue; const s = P.scorePair(e.epub, a.audio); if (s >= CROSS_MIN) cand.push({ e, a, s }); }
          cand.sort((x, y) => y.s - x.s);
          const usedE = new Set(), usedA = new Set();
          for (const c of cand) {
            if (usedE.has(c.e) || usedA.has(c.a)) continue;
            usedE.add(c.e); usedA.add(c.a);
            c.e.audio = c.a.audio; c.e.score = c.s;
            if (!c.e.srt && c.a.srt) c.e.srt = c.a.srt;
            if (c.s < P.REVIEW_MIN) c.e._review = true;
            books.splice(books.indexOf(c.a), 1);
          }
          // Every EPUB row can pick from the WHOLE import in the review sheet.
          const allAudios = playable.filter(f => f.kind === 'audio'), allSrts = playable.filter(f => f.kind === 'srt');
          for (const b of books) if (b.epub) b._cands = { audios: allAudios, srts: allSrts };
        }
      } catch (_) {}

      if (!books.length) {
        hideModal();
        if (unplayable.length) {
          const exts = [...new Set(unplayable.map(f => '.' + f.ext))].join(' / ');
          alert(`Found ${unplayable.length} video file${unplayable.length === 1 ? '' : 's'} in ${exts} format, ` +
            `which this device cannot play. Convert to .mp4 (H.264/AAC) and re-import.`);
        } else {
          toast('No books (epub / audiobook / video) found to import.');
        }
        return;
      }
      if (unplayable.length) {
        toast(`${unplayable.length} ${[...new Set(unplayable.map(f => '.' + f.ext))].join('/')} file(s) skipped — not playable on this platform.`, 4500);
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
        toast(`Already imported — ${describeBatch(books)} skipped.`);
        return;
      }

      // Confirm before mutating the library. Uncertain pairings (or leftovers
      // of both kinds) go through the review sheet, which has its own Import
      // button; a clean batch just gets the plain confirm.
      hideModal();
      // The review sheet IS the confirmation: every title has an include
      // toggle (user: "seems we have to import everything it finds"), and
      // uncertain pairings can be corrected in place.
      const toImport = await reviewPairs(fresh, res.rootName || 'folder', skipped);
      if (!toImport) return;
      if (!toImport.length) { toast(T('ir.nothing', 'Nothing selected — nothing imported.')); return; }
      fresh.length = 0; for (const b of toImport) fresh.push(b);

      setProgress(75, `Adding ${fresh.length} title${fresh.length === 1 ? '' : 's'}…`);
      const partials = fresh.map(b => ({
        name: b.name || 'Untitled',
        author: (b.epub && b.epub.metaAuthor) || (b.audio && b.audio.metaAuthor) || '',
        meta: {
          durationMs: (b.audio && b.audio.durationMs) || 0,
          epubTitle: (b.epub && b.epub.metaTitle) || '',
          audioTitle: (b.audio && b.audio.metaTitle) || '',
          pairScore: Number.isFinite(b.score) ? Math.round(b.score * 100) / 100 : null,
        },
        attachments: attachmentsFor(b),
      }));
      const created = await window.titleStore.createMany(partials);

      setProgress(100, `Imported ${describeBatch(fresh)}`);
      if (typeof window.populateLibrary === 'function') await window.populateLibrary();
      // A single created VIDEO title (a movie, or a season-as-series): open it
      // right away in the player — that's always the next action anyway.
      if (created && created.length === 1 && created[0]?.attachments?.audiobook?.isVideo &&
          typeof window.loadTitleFromLibrary === 'function') {
        try { await window.titleStore.setMode?.(created[0].id, 'audio'); } catch (_) {}
        created[0].lastMode = 'audio';
        setTimeout(() => { try { window.loadTitleFromLibrary(created[0]); } catch (_) {} }, 600);
      }
      toast(`📁 Imported ${fresh.length} book${fresh.length === 1 ? '' : 's'}` + (skipped ? ` (${skipped} skipped)` : ''));
      setTimeout(hideModal, 1100);
      // Cover art: best-effort BACKGROUND pass (don't block import completion).
      // The library shows letter avatars immediately; embedded covers fill in
      // as each book's epub/audio is read.
      extractCoversForImport(created);
      try { window.libraryMeta?.sweepInPlace?.(); } catch (_) {}
      // Library metadata (length, difficulty) then summaries — background.
      try { Promise.resolve(window.libraryBlurb?.runQueue?.()).catch(() => {}).finally(() => { try { window.libraryMeta?.ensureAll?.(); } catch (_) {} }); } catch (_) {}
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
      // cover?.dataUri, not just cover: the lean TITLES_V1 keeps a cover STUB
      // ({mime,source,name}) with the dataUri stored separately — if the
      // covers blob is ever lost (storage eviction), the stub must not block
      // re-extraction or the cover would never self-heal.
      if (!t?.id || !a || a.cover?.dataUri) continue;
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
