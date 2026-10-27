// ttu-import.js — import a ッツ (ttu) Reader backup zip: books + reading
// progress.
//
// A ttu backup (ttu → Settings → Backup) holds one folder per book:
//   <title>/bookdata_*.zip    ttu's processed copy of the book:
//                               staticdata.json {title, elementHtml, sections, styleSheet}
//                               blobs/<name>     images (the HTML points at them as
//                                                data:image/gif;ttu:<name>;… or ttu:<name>)
//                               cover.<ext>
//   <title>/progress_*.json   { exploredCharCount, progress, lastBookmarkModified }
//   <title>/cover_*, statistics_*.json, audioBook_*.json   (not imported yet)
//
// Each book becomes an EPUB rebuilt from ttu's HTML (one file per section,
// images included) attached to a new Title. Progress travels as a character
// count — Kadoki counts characters exactly as ttu does (stats.js jpCharCount)
// — and is stored on the title as `ttuPos`; the paged reader turns it into a
// bookmark on first open, and ONLY when the book has no Kadoki bookmark yet,
// so an import can never move a place the user already has.
// A ttu book already in the library (same title) is not duplicated: it just
// gets `ttuPos` under the same rule.
(function () {
  'use strict';

  const T = (k, d) => { try { return window.i18n.t(k, d); } catch (_) { return d; } };
  const toast = (m, ms) => { try { window.showToast?.(m, ms || 2500); } catch (_) {} };
  const xesc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  // ttu's folder names: URL-encoded, plus three escapes of its own
  // (BaseStorageHandler.desanitizeFilename).
  function desanitize(name) {
    let s = String(name || '');
    try { s = decodeURIComponent(s); } catch (_) {}
    return s.replace(/~ttu-star~/g, '*').replace(/~ttu-dend~/g, '.').replace(/~ttu-spc~/g, ' ');
  }
  const normTitle = (s) => String(s || '').normalize('NFKC').replace(/[\s　【】［］\[\]（）()「」『』:：・]/g, '').toLowerCase();
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
  const extOf = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };

  // Newest file of a kind in a book folder: ttu names carry the modified
  // timestamp (progress_<ver>_<db>_<lastModified>_<progress>.json).
  function newest(files, prefix) {
    let best = null, bestTs = -1;
    for (const f of files) {
      const base = f.name.split('/').pop();
      if (!base.startsWith(prefix)) continue;
      const parts = base.replace(/\.[^.]+$/, '').split('_');
      const ts = Number(parts[3]) || 0;
      if (ts >= bestTs) { best = f; bestTs = ts; }
    }
    return best;
  }

  // ttu HTML → EPUB. Sections are the top-level elements whose ids match
  // `sections[].reference`; anything before the first section rides with it.
  async function buildEpub(meta, blobs, coverName, coverBytes) {
    const doc = new DOMParser().parseFromString('<!DOCTYPE html><html><body><div id="kttu-root"></div></body></html>', 'text/html');
    const root = doc.getElementById('kttu-root');
    let html = String(meta.elementHtml || '');
    // Images: ttu placeholders → files inside the EPUB.
    const imgPath = (key) => 'images/' + key.replace(/[^\w.\-]/g, '_');
    for (const key of Object.keys(blobs)) {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp('data:image/gif;ttu:' + esc + ';base64,[A-Za-z0-9+/=]*', 'g'), imgPath(key))
                 .replace(new RegExp('ttu:' + esc + '(?=["\'\\s)])', 'g'), imgPath(key));
    }
    root.innerHTML = html;
    const top = root.children.length === 1 && root.firstElementChild.children.length ? root.firstElementChild : root;
    const refs = new Set((meta.sections || []).map((s) => s && s.reference).filter(Boolean));
    const labels = new Map((meta.sections || []).filter((s) => s && s.reference).map((s) => [s.reference, s.label || '']));
    const groups = [];
    for (const el of Array.from(top.children)) {
      if (!groups.length || (el.id && refs.has(el.id))) groups.push({ id: el.id || '', els: [] });
      groups[groups.length - 1].els.push(el);
    }
    if (!groups.length) groups.push({ id: '', els: [top] });

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const items = [], spine = [], nav = [];
    const ser = new XMLSerializer();
    groups.forEach((g, i) => {
      const body = g.els.map((el) => ser.serializeToString(el)).join('\n');
      const fn = 'sec' + i + '.xhtml';
      const label = labels.get(g.id) || '';
      zip.file('OEBPS/' + fn,
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        '<head><meta charset="utf-8"/><title>' + xesc(label || meta.title || '') + '</title></head>\n<body>\n' + body + '\n</body></html>');
      items.push('<item id="s' + i + '" href="' + fn + '" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="s' + i + '"/>');
      if (label) nav.push('<li><a href="' + fn + '">' + xesc(label) + '</a></li>');
    });
    let n = 0;
    for (const [key, bytes] of Object.entries(blobs)) {
      const p = imgPath(key);
      zip.file('OEBPS/' + p, bytes);
      items.push('<item id="img' + (n++) + '" href="' + p + '" media-type="' + (MIME[extOf(key)] || 'image/jpeg') + '"/>');
    }
    let coverMeta = '';
    if (coverBytes) {
      const ext = extOf(coverName) || 'jpg';
      zip.file('OEBPS/cover.' + ext, coverBytes);
      items.push('<item id="cover-img" href="cover.' + ext + '" media-type="' + (MIME[ext] || 'image/jpeg') + '" properties="cover-image"/>');
      coverMeta = '<meta name="cover" content="cover-img"/>';
    }
    if (!nav.length) nav.push('<li><a href="sec0.xhtml">' + xesc(meta.title || '1') + '</a></li>');
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
      '<head><title>Contents</title></head><body><nav epub:type="toc"><ol>' + nav.join('') + '</ol></nav></body></html>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">kadoki-ttu-' + Date.now() + '</dc:identifier>' +
      '<dc:title>' + xesc(meta.title || 'Untitled') + '</dc:title><dc:language>ja</dc:language>' + coverMeta +
      '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>\n<manifest>' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' + items.join('') +
      '</manifest>\n<spine page-progression-direction="rtl">' + spine.join('') + '</spine>\n</package>');
    return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  }

  const b64ToDataUri = (bytes, ext) => {
    let bin = '';
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return 'data:' + (MIME[ext] || 'image/jpeg') + ';base64,' + btoa(bin);
  };

  async function importBackup(file, onProgress) {
    if (typeof JSZip === 'undefined') throw new Error('zip support missing');
    const fs = window.Capacitor?.Plugins?.Filesystem;
    const ts = window.titleStore;
    if (!fs || !ts) throw new Error('storage unavailable');
    const outer = await JSZip.loadAsync(file);
    // Group entries by their top folder (= one book).
    const books = new Map();
    outer.forEach((path, entry) => {
      if (entry.dir) return;
      const slash = path.indexOf('/');
      if (slash < 0) return;            // root files (reading goals)
      const folder = path.slice(0, slash);
      if (!books.has(folder)) books.set(folder, []);
      books.get(folder).push(entry);
    });
    const existing = await ts.list();
    const byName = new Map(existing.map((t) => [normTitle(t.name), t]));
    const res = { added: [], matched: [], skipped: [] };
    let k = 0;
    for (const [folder, files] of books) {
      k++;
      const title = desanitize(folder);
      try { onProgress?.(k, books.size, title); } catch (_) {}
      try {
        const prog = newest(files, 'progress_');
        let charPos = 0;
        if (prog) {
          try { const p = JSON.parse(await prog.async('string')); charPos = Math.max(0, Math.floor(Number(p.exploredCharCount) || 0)); } catch (_) {}
        }
        const known = byName.get(normTitle(title));
        if (known) {
          if (charPos > 0 && !known.ttuPos) await ts.update(known.id, { ttuPos: charPos });
          res.matched.push(title);
          continue;
        }
        const bd = newest(files, 'bookdata_');
        if (!bd) { res.skipped.push(title + ' (no book data)'); continue; }
        const inner = await JSZip.loadAsync(await bd.async('uint8array'));
        const sd = inner.file('staticdata.json');
        if (!sd) { res.skipped.push(title + ' (no text)'); continue; }
        const meta = JSON.parse(await sd.async('string'));
        if (!meta.elementHtml) { res.skipped.push(title + ' (empty)'); continue; }
        const blobs = {};
        let coverName = '', coverBytes = null;
        for (const name of Object.keys(inner.files)) {
          const e = inner.files[name];
          if (e.dir) continue;
          if (name.startsWith('blobs/')) blobs[name.slice(6)] = await e.async('uint8array');
          else if (/^cover\.[a-z0-9]+$/i.test(name)) { coverName = name; coverBytes = await e.async('uint8array'); }
        }
        const name = meta.title || title;
        const b64 = await buildEpub({ ...meta, title: name }, blobs, coverName, coverBytes);
        const t = await ts.create({ name, attachments: {} });
        const relPath = 'ttuimport/' + t.id + '.epub';
        await fs.writeFile({ path: relPath, data: b64, directory: 'DATA', recursive: true });
        const u = await fs.getUri({ path: relPath, directory: 'DATA' });
        const cachePath = String(u?.uri || '').replace(/^file:\/\//, '');
        await ts.attach(t.id, 'epub', { cachePath, name: name + '.epub', size: Math.floor(b64.length * 3 / 4), ttu: true });
        if (coverBytes) {
          const ext = extOf(coverName) || 'jpg';
          await ts.attach(t.id, 'cover', { dataUri: b64ToDataUri(coverBytes, ext), mime: MIME[ext] || 'image/jpeg', source: 'ttu', name: 'cover' });
        }
        if (charPos > 0) await ts.update(t.id, { ttuPos: charPos });
        byName.set(normTitle(name), t);
        res.added.push(name);
      } catch (e) {
        console.warn('[ttu-import]', title, e);
        res.skipped.push(title + ' (' + (e?.message || e) + ')');
      }
    }
    return res;
  }

  // Library entry: pick the backup zip, import, report.
  async function pickAndImport() {
    let input = document.getElementById('ttuImportInput');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.id = 'ttuImportInput';
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    input.value = '';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      toast(T('ttu.reading', 'Reading ッツ backup…'), 2000);
      try {
        const r = await importBackup(f, (i, n, name) => toast(T('ttu.importing', 'Importing') + ' ' + i + '/' + n + ': ' + name, 4000));
        try { window.populateLibrary?.(); } catch (_) {}
        try { window.__kadokiLibRefreshNative?.(); } catch (_) {}
        const lines = [];
        lines.push(T('ttu.added', 'Books added') + ': ' + r.added.length);
        if (r.matched.length) lines.push(T('ttu.matched', 'Already in your library (progress kept where you have none yet)') + ': ' + r.matched.length);
        if (r.skipped.length) lines.push(T('ttu.skipped', 'Skipped') + ':\n' + r.skipped.join('\n'));
        alert(T('ttu.done', 'ッツ import finished') + '\n\n' + lines.join('\n'));
      } catch (e) {
        alert(T('ttu.failed', 'Could not import this file') + ': ' + (e?.message || e));
      }
    };
    input.click();
  }

  window.ttuImport = { importBackup, pickAndImport, _buildEpub: buildEpub, _desanitize: desanitize };
})();
