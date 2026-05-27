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
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch ' + url + ' → ' + r.status);
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

      const containerXml = await zip.file('META-INF/container.xml')?.async('string');
      if (!containerXml) return null;
      const opfPath = new DOMParser()
        .parseFromString(containerXml, 'application/xml')
        .querySelector('rootfile')?.getAttribute('full-path');
      if (!opfPath) return null;

      const opfXml = await zip.file(opfPath).async('string');
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

  async function fromAudio(cachePath) {
    if (!cachePath) return null;
    try {
      const bytes = await readFirstNBytes(urlFor(cachePath), MAX_AUDIO_HEAD_BYTES);
      if (bytes.length < 10) return null;
      // Magic check.
      if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
      const major = bytes[3];
      // const flags = bytes[5];
      const tagSize = readSynchsafe(bytes, 6);
      const tagEnd = 10 + tagSize;
      let off = 10;
      while (off + 10 <= bytes.length && off + 10 <= tagEnd) {
        const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;  // padding
        const size = (major >= 4) ? readSynchsafe(bytes, off + 4) : readU32BE(bytes, off + 4);
        // frame flags = off+8..9
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
          return { dataUri: makeDataUri(pic, mime), mime };
        }
        off = dataEnd;
      }
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
