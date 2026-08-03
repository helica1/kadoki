// cover-extract.js — pull a cover image out of an EPUB or audiobook.
//
// Public API:
//   window.coverExtract.fromEpub(epubCachePath)  → { dataUri, mime } | null
//   window.coverExtract.fromAudio(audioCachePath) → { dataUri, mime } | null
//   window.coverExtract.fromFile(file) → { dataUri, mime } | null  (manual pick)
//
// Approach:
//   EPUB: it's a ZIP. Container.xml → OPF → look for the cover image item
//         (either <meta name="cover" content="ID"> or an item with
//         properties="cover-image"). Extract that file → data URI.
//   Audiobook (mp3 with ID3v2): stream-read the first ~1.5 MB of the file
//         and scan for an APIC frame. Returns its picture bytes.
//
// Data URIs keep storage simple but mean covers live inline in the Title
// JSON blob. Cover images are typically 30–300 KB JPEG, which is fine for
// a small library; if it grows we can migrate to disk caching later.

(function () {
  const MAX_AUDIO_HEAD_BYTES = 1.5 * 1024 * 1024; // 1.5 MB — covers ID3 tags

  // ---- helpers ----

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function makeDataUri(bytes, mime) {
    return 'data:' + (mime || 'image/jpeg') + ';base64,' + bytesToBase64(bytes);
  }

  async function readFirstNBytes(url, n) {
    // Capacitor's iOS WebViewAssetHandler responds to media file extensions
    // with a bare URLResponse (no HTTP status), so a plain `fetch(url).ok`
    // is false even though the body bytes are intact. Forcing a Range
    // header routes through the handler's range branch which always emits
    // a 206 HTTPURLResponse — bytes flow through normally and .ok is true.
    // (Same trap we worked around in local-audio.js for Anki audio fetching.)
    const r = await fetch(url, { headers: { Range: `bytes=0-${Math.max(1, n - 1)}` } });
    // Treat any 2xx / 206 as success — guards against the rare cache
    // path that does emit a plain HTTPURLResponse with 200.
    if (!r.ok && r.status !== 206 && r.status !== 0) {
      throw new Error('fetch ' + url + ' → ' + r.status);
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { reader.cancel(); } catch (e) {}
    if (total === 0) {
      throw new Error('fetch ' + url + ' → 0 bytes (status ' + r.status + ')');
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c.subarray(0, Math.min(c.byteLength, out.length - off)), off);
      off += c.byteLength;
    }
    return out;
  }

  function urlFor(path) {
    if (path.startsWith('http') || path.startsWith('data:')) return path;
    if (window.Capacitor?.convertFileSrc) return window.Capacitor.convertFileSrc(path);
    return 'file://' + path;
  }

  // Read an arbitrary byte range. Returns null when the server ignored the
  // Range header for a non-zero offset (a 200-with-full-body would hand us
  // bytes from position 0 and silently corrupt the atom walk).
  async function readRange(url, start, len) {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
    if (!r.ok && r.status !== 206 && r.status !== 0) {
      throw new Error('fetch ' + url + ' → ' + r.status);
    }
    if (start > 0 && r.status !== 206) {
      const cr = r.headers.get('Content-Range');
      if (!cr || !cr.includes(String(start))) {
        try { r.body?.cancel(); } catch (e) {}
        return null;
      }
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < len) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { reader.cancel(); } catch (e) {}
    if (total === 0) return null;
    const out = new Uint8Array(Math.min(total, len));
    let off = 0;
    for (const c of chunks) {
      if (off >= out.length) break;
      out.set(c.subarray(0, Math.min(c.byteLength, out.length - off)), off);
      off += c.byteLength;
    }
    return out;
  }

  async function getFileSize(cachePath) {
    try {
      const fs = window.Capacitor?.Plugins?.Filesystem;
      const p = cachePath.startsWith('file://') ? cachePath : 'file://' + cachePath;
      const st = await fs?.stat({ path: p });
      if (st && st.size > 0) return st.size;
    } catch (e) {}
    return 0;
  }

  // ============================================================
  // EPUB cover
  // ============================================================

  async function fromEpub(cachePath) {
    if (!cachePath) return null;
    if (typeof JSZip === 'undefined') { console.warn('[cover] JSZip not loaded'); return null; }
    try {
      const res = await fetch(urlFor(cachePath));
      if (!res.ok) throw new Error('fetch EPUB → ' + res.status);
      const blob = await res.blob();
      const zip = await JSZip.loadAsync(blob);

      // UTF-8 BOM strip — iOS WebKit's XML parser fails on content before
      // <?xml (Blink tolerates it); JSZip keeps the BOM in decoded strings.
      const deBom = (s) => (s ? s.replace(/^\uFEFF+/, '') : s);
      const containerXml = deBom(await zip.file('META-INF/container.xml')?.async('string'));
      if (!containerXml) return null;
      const opfPath = new DOMParser()
        .parseFromString(containerXml, 'application/xml')
        .querySelector('rootfile')?.getAttribute('full-path');
      if (!opfPath) return null;

      const opfXml = deBom(await zip.file(opfPath).async('string'));
      const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
      const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';

      // EPUB3: item with properties="cover-image".
      let coverItem = opfDoc.querySelector('manifest > item[properties~="cover-image"]');
      // EPUB2: <meta name="cover" content="ID"> → manifest item with that ID.
      if (!coverItem) {
        const metaCoverId = opfDoc.querySelector('metadata > meta[name="cover"]')?.getAttribute('content');
        if (metaCoverId) {
          coverItem = opfDoc.querySelector('manifest > item[id="' + CSS.escape(metaCoverId) + '"]');
        }
      }
      // Heuristic: an item whose href contains "cover" and has an image MIME.
      if (!coverItem) {
        const items = [...opfDoc.querySelectorAll('manifest > item')];
        coverItem = items.find(it => {
          const href = it.getAttribute('href') || '';
          const mt = it.getAttribute('media-type') || '';
          return /cover/i.test(href) && mt.startsWith('image/');
        }) || items.find(it => (it.getAttribute('media-type') || '').startsWith('image/'));
      }
      if (!coverItem) return null;

      const href = coverItem.getAttribute('href');
      const mime = coverItem.getAttribute('media-type') || 'image/jpeg';
      const fullPath = (opfDir + href).replace(/^\//, '');
      const file = zip.file(fullPath);
      if (!file) return null;
      const buf = await file.async('uint8array');
      return { dataUri: makeDataUri(buf, mime), mime };
    } catch (e) {
      console.warn('[cover] EPUB extract failed:', e?.message || e);
      return null;
    }
  }

  // ============================================================
  // Audiobook (ID3v2 APIC) cover
  // ============================================================
  //
  // ID3v2 header (10 bytes):
  //   bytes 0..2  "ID3"
  //   byte  3     version major
  //   byte  4     version revision
  //   byte  5     flags
  //   bytes 6..9  size  (synchsafe int — each byte uses only 7 low bits)
  //
  // Each frame:
  //   bytes 0..3  frame ID (e.g. "APIC")
  //   bytes 4..7  size (synchsafe in v2.4, regular big-endian in v2.3)
  //   bytes 8..9  flags
  //   bytes 10..  data
  //
  // APIC frame data:
  //   byte 0      text encoding (0 = ISO-8859-1, 1 = UTF-16, 3 = UTF-8)
  //   bytes …     MIME (null-terminated ASCII)
  //   byte         picture type (0x03 = front cover)
  //   bytes …     description (null-terminated, in given encoding)
  //   bytes …     picture data

  function readSynchsafe(bytes, off) {
    return (bytes[off] << 21) | (bytes[off + 1] << 14) | (bytes[off + 2] << 7) | bytes[off + 3];
  }
  function readU32BE(bytes, off) {
    return (bytes[off] << 24 >>> 0) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
  }
  function readAscii(bytes, off, max) {
    let end = off;
    while (end < off + max && bytes[end] !== 0 && end < bytes.length) end++;
    return { text: String.fromCharCode(...bytes.subarray(off, end)), nextOff: end + 1 };
  }
  function readNullTerm(bytes, off, encoding) {
    if (encoding === 1 || encoding === 2) {
      // UTF-16: terminator is two zero bytes (16-bit zero).
      let end = off;
      while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2;
      return { nextOff: end + 2 };
    }
    let end = off;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return { nextOff: end + 1 };
  }

  // Walk top-level MP4 boxes looking for `moov > udta > meta > ilst > covr`.
  // Audiobooks distributed as `.m4b` / `.m4a` use this format; the cover
  // art is an atom payload, not an ID3 frame.
  function findMp4Cover(bytes, start, end) {
    // Look for moov first.
    function walk(at, until, target) {
      let off = at;
      while (off + 8 <= until) {
        const size = readU32BE(bytes, off);
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        if (size < 8 || off + size > until) return null;
        if (type === target) return { contentStart: off + 8, contentEnd: off + size };
        off += size;
      }
      return null;
    }
    const moov = walk(start, end, 'moov');
    if (!moov) return null;
    const udta = walk(moov.contentStart, moov.contentEnd, 'udta');
    if (!udta) return null;
    const meta = walk(udta.contentStart, udta.contentEnd, 'meta');
    if (!meta) return null;
    // meta has a 4-byte version+flags BEFORE its subboxes.
    const ilst = walk(meta.contentStart + 4, meta.contentEnd, 'ilst');
    if (!ilst) return null;
    const covr = walk(ilst.contentStart, ilst.contentEnd, 'covr');
    if (!covr) return null;
    // covr contains one or more `data` subboxes. The image is inside the
    // first one. data layout: 4B size, 4B 'data', 4B type-indicator,
    // 4B locale, then image bytes.
    const data = walk(covr.contentStart, covr.contentEnd, 'data');
    if (!data) return null;
    if (data.contentEnd - data.contentStart < 8) return null;
    const typeIndicator = readU32BE(bytes, data.contentStart) & 0xFFFFFF;
    // 13 = JPEG, 14 = PNG (per iTunes metadata atom spec).
    const mime = (typeIndicator === 14) ? 'image/png' : 'image/jpeg';
    const pic = bytes.subarray(data.contentStart + 8, data.contentEnd);
    if (pic.length === 0) return null;
    return { dataUri: makeDataUri(pic, mime), mime };
  }

  // Locate the top-level moov atom by hopping atom headers with ranged
  // reads (ftyp → free → mdat → … → moov), then fetch the whole moov and
  // reuse the in-buffer walker. Handles 64-bit (size==1 + largesize) and
  // to-end-of-file (size==0) atoms, both common with multi-GB mdat.
  async function findMp4CoverByRangedWalk(url, cachePath) {
    try {
      const fileSize = await getFileSize(cachePath);
      if (!fileSize) return null;
      let off = 0;
      for (let hops = 0; hops < 64 && off + 16 <= fileSize; hops++) {
        const hdr = await readRange(url, off, 16);
        if (!hdr || hdr.length < 8) return null;
        let size = readU32BE(hdr, 0);
        const type = String.fromCharCode(hdr[4], hdr[5], hdr[6], hdr[7]);
        let headerLen = 8;
        if (size === 1) {
          if (hdr.length < 16) return null;
          size = readU32BE(hdr, 8) * 4294967296 + readU32BE(hdr, 12);
          headerLen = 16;
        } else if (size === 0) {
          size = fileSize - off;
        }
        if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerLen) return null;
        if (type === 'moov') {
          const MAX_MOOV = 32 * 1024 * 1024;
          const buf = await readRange(url, off, Math.min(size, MAX_MOOV));
          if (!buf) return null;
          if (size > buf.length) {
            // Truncated fetch — clamp the moov size field so the in-buffer
            // walker's bounds checks hold (covr sits near the front of moov).
            if (headerLen !== 8) return null;
            const c = buf.length;
            buf[0] = (c >>> 24) & 255; buf[1] = (c >>> 16) & 255;
            buf[2] = (c >>> 8) & 255;  buf[3] = c & 255;
          }
          return findMp4Cover(buf, 0, buf.length);
        }
        off += size;
      }
      return null;
    } catch (e) {
      console.warn('[cover] ranged moov walk failed:', e?.message || e);
      return null;
    }
  }

  async function fromAudio(cachePath) {
    if (!cachePath) return null;
    try {
      const bytes = await readFirstNBytes(urlFor(cachePath), MAX_AUDIO_HEAD_BYTES);
      if (bytes.length < 10) {
        console.warn('[cover] audio: read returned only ' + bytes.length + ' bytes');
        return null;
      }
      // Detect container by magic bytes for clearer diagnostics.
      const head = Array.from(bytes.subarray(0, 12))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log('[cover] audio first 12 bytes: ' + head);
      const ftypAt4 = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);

      // ---- ID3v2 (MP3) ----
      if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        const major = bytes[3];
        const tagSize = readSynchsafe(bytes, 6);
        const tagEnd = 10 + tagSize;
        console.log('[cover] ID3v2.' + major + ' tag, size=' + tagSize);
        let off = 10;
        while (off + 10 <= bytes.length && off + 10 <= tagEnd) {
          const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
          if (!/^[A-Z0-9]{4}$/.test(id)) break;  // padding
          const size = (major >= 4) ? readSynchsafe(bytes, off + 4) : readU32BE(bytes, off + 4);
          const dataStart = off + 10;
          const dataEnd = dataStart + size;
          if (id === 'APIC') {
            if (dataEnd > bytes.length) {
              console.warn('[cover] APIC frame truncated — head buffer too small');
              return null;
            }
            let p = dataStart;
            const encoding = bytes[p++];
            const mimeR = readAscii(bytes, p, dataEnd - p);
            const mime = mimeR.text || 'image/jpeg';
            p = mimeR.nextOff;
            p++; // picture type byte
            const descR = readNullTerm(bytes, p, encoding);
            p = descR.nextOff;
            const pic = bytes.subarray(p, dataEnd);
            if (pic.length === 0) return null;
            console.log('[cover] ID3 APIC found, ' + pic.length + ' bytes ' + mime);
            return { dataUri: makeDataUri(pic, mime), mime };
          }
          off = dataEnd;
        }
        console.warn('[cover] ID3v2 tag had no APIC frame — file has no cover art embedded in the ID3 header.');
        return null;
      }

      // ---- MP4 / M4B / M4A ----
      if (ftypAt4 === 'ftyp') {
        console.log('[cover] MP4 container detected — walking atoms');
        const r = findMp4Cover(bytes, 0, bytes.length);
        if (r) {
          console.log('[cover] MP4 covr found, ' + r.dataUri.length + ' base64 chars ' + r.mime);
          return r;
        }
        // moov usually sits AFTER the multi-hundred-MB mdat in audiobook
        // m4b files (non-faststart mux), so the head buffer never reaches
        // it. Walk the top-level atoms via ranged reads to find moov
        // anywhere in the file, fetch just that atom, and walk inside it.
        const r2 = await findMp4CoverByRangedWalk(urlFor(cachePath), cachePath);
        if (r2) {
          console.log('[cover] MP4 covr found via ranged moov walk, ' + r2.mime);
          return r2;
        }
        console.warn('[cover] MP4 has no reachable covr atom (head + ranged moov walk).');
        return null;
      }

      console.warn('[cover] unrecognized audio container — head=' + head);
      return null;
    } catch (e) {
      console.warn('[cover] audio extract failed:', e?.message || e);
      return null;
    }
  }

  // ============================================================
  // Manual image file (from FileAccess pick)
  // ============================================================

  async function fromFile(file) {
    if (!file) return null;
    // file is a Blob (e.g., from a File input). Read as data URL.
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        const dataUri = fr.result;
        const mime = (dataUri.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
        resolve({ dataUri, mime });
      };
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }

  window.coverExtract = { fromEpub, fromAudio, fromFile };
})();
