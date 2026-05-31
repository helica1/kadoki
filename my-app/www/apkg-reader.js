// apkg-reader.js — random-access .apkg loading.
//
// The old path did `file.arrayBuffer()` + `JSZip.loadAsync()`, which buffers the
// ENTIRE archive into the JS heap. On a ~1 GB immersion deck that hard-OOM'd the
// WebView (and trapped the app in a boot loop). An .apkg is a ZIP, and ZIP is
// random-access by design (central directory at the tail points at each entry),
// so we can read ONLY the bytes we actually need:
//   • the central directory (a few KB),
//   • the collection DB entry (tens of MB), and
//   • each media entry on demand (one at a time).
// Peak memory drops from ~the whole file to ~one entry.
//
// Backed by zip.js (vendored, no-worker inflate build). Two read strategies:
//   • picker File  → BlobReader (Blob.slice is disk-backed/lazy in the WebView)
//   • disk path    → ranged fetch against convertFileSrc(path), IF the local
//                    server honours HTTP Range; else a one-time whole-file read
//                    (no worse than the old behaviour — used only as a fallback).
(function () {
  'use strict';

  function Z() { return window.zip; }

  // The vendored bundle is the no-worker inflate build and the sideloaded www
  // ships no worker script, so force main-thread inflation.
  try { window.zip?.configure?.({ useWebWorkers: false }); } catch (_) {}

  // Verify the local file server returns 206 + ONLY the requested slice for a
  // Range request. Capacitor's iOS/Android servers do (it's how media seeking
  // works), but if a given build/scheme ignores Range it would re-send the whole
  // file per slice — catastrophic — so we probe a small mid-file range first.
  async function serverHonorsRange(url, size) {
    try {
      if (!size || size < 64) return false;
      const mid = Math.floor(size / 2);
      const res = await fetch(url, { headers: { Range: `bytes=${mid}-${mid + 15}` } });
      if (res.status !== 206) { try { await res.arrayBuffer(); } catch (_) {} return false; }
      const buf = await res.arrayBuffer();
      return buf.byteLength <= 32; // got the slice, not the whole file
    } catch (e) { return false; }
  }

  // A zip.js Reader that pulls byte ranges from a Capacitor file URL via fetch.
  function makeRangeReader(url, size) {
    const z = Z();
    return new (class extends z.Reader {
      constructor() { super(); this.size = size; }
      async readUint8Array(index, length) {
        const end = index + length - 1;
        const res = await fetch(url, { headers: { Range: `bytes=${index}-${end}` } });
        if (res.status !== 206 && res.status !== 200) throw new Error('range fetch ' + res.status);
        let buf = new Uint8Array(await res.arrayBuffer());
        // Defensive: if the server ignored Range and sent the whole file, window it.
        if (res.status === 200 && buf.length > length) buf = buf.slice(index, index + length);
        return buf;
      }
    })();
  }

  // Open a ZipReader over the deck and return its entries.
  async function open({ file, path, size }) {
    const z = Z();
    if (!z) throw new Error('zip.js not loaded');
    let reader, mode;
    if (file) {
      reader = new z.BlobReader(file);
      mode = 'blob';
    } else if (path) {
      const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(path) : path;
      if (await serverHonorsRange(url, size)) {
        reader = makeRangeReader(url, size);
        mode = 'range';
      } else {
        // Range unsupported → one-time whole-file read (old behaviour). The
        // Range:bytes=0- header is the known workaround for this repo's server
        // returning res.ok=false on a bare GET.
        const res = await fetch(url, { headers: { Range: 'bytes=0-' } });
        reader = new z.BlobReader(await res.blob());
        mode = 'blob-fallback';
      }
    } else {
      throw new Error('openApkgReader: need a file or a path');
    }
    const zipReader = new z.ZipReader(reader);
    const entries = await zipReader.getEntries();
    return { zipReader, entries, mode };
  }

  function entryBytes(entry)         { return entry.getData(new (Z().Uint8ArrayWriter)()); }
  function entryText(entry)          { return entry.getData(new (Z().TextWriter)()); }
  function entryDataUri(entry, mime) { return entry.getData(new (Z().Data64URIWriter)(mime || 'application/octet-stream')); }

  // Decompress IF the bytes are a zstd frame (magic 28 B5 2F FD), else return
  // as-is. The new Anki package format (v3) zstd-compresses the collection DB,
  // the media manifest, AND every media blob — but sources disagree on the
  // manifest specifically, so we detect rather than assume.
  function maybeZstd(u8) {
    if (u8 && u8.length >= 4 && u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD) {
      if (!window.fzstd) throw new Error('zstd data needs the fzstd decoder, which is not loaded');
      return window.fzstd.decompress(u8);
    }
    return u8;
  }

  // Decode a new-format Anki "media" manifest (protobuf MediaEntries) into an
  // ordered array of real filenames: names[i] is stored in zip member String(i).
  // Layout: MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry {
  // string name = 1; uint32 size = 2; bytes sha1 = 3; uint32 legacy=255 }. We
  // only need `name` and ordinal position. Feed ALREADY-decompressed bytes.
  function decodeMediaEntries(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let p = 0;
    const td = new TextDecoder('utf-8');
    function varint() {
      let shift = 0, result = 0, b;
      do { b = u[p++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
      return result;
    }
    function skip(wire) {
      if (wire === 0) { while (u[p] & 0x80) p++; p++; }
      // NB: `const l = varint()` THEN `p += l` — not `p += varint()`, which
      // reads the old p before varint()'s side-effect and skips short by the
      // length-prefix byte (lands mid-field → spurious "bad wire" errors).
      else if (wire === 2) { const l = varint(); p += l; }
      else if (wire === 5) p += 4;
      else if (wire === 1) p += 8;
      else throw new Error('bad protobuf wire ' + wire);
    }
    const names = [];
    while (p < u.length) {
      const tag = varint(), field = tag >>> 3, wire = tag & 7;
      if (field === 1 && wire === 2) {            // a MediaEntry sub-message
        const end = p + varint();
        let name = '';
        while (p < end) {
          const t2 = varint(), f2 = t2 >>> 3, w2 = t2 & 7;
          if (f2 === 1 && w2 === 2) { const l = varint(); name = td.decode(u.subarray(p, p + l)); p += l; }
          else skip(w2);
        }
        names.push(name);
      } else skip(wire);
    }
    return names;
  }

  // Sniff a media MIME from magic bytes — more reliable than the filename
  // extension (e.g. an AVIF/WebP snapshot, or an extensionless file). An <img>
  // won't render a data URI typed application/octet-stream, so getting this
  // right is what makes images (not just audio) show. Falls back to the
  // extension-derived guess when nothing matches.
  function sniffMime(b, fallback) {
    fallback = fallback || 'application/octet-stream';
    if (!b || b.length < 12) return fallback;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
    if (riff && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (riff && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) { // ISO-BMFF 'ftyp'
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic';
      if (brand.startsWith('M4A')) return 'audio/mp4';
      return 'video/mp4';
    }
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';   // ID3 (mp3)
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio/mpeg';           // mp3 frame
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
    if (b[0] === 0x3C && (b[1] === 0x3F || b[1] === 0x73 || b[1] === 0x53)) return 'image/svg+xml';
    return fallback;
  }

  // Chunked base64 → data URI. Avoids the String.fromCharCode(...big) stack
  // overflow that spreading a multi-MB Uint8Array would hit.
  function bytesToDataUri(bytes, mime) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
  }

  window.ApkgReader = { open, entryBytes, entryText, entryDataUri, serverHonorsRange, maybeZstd, decodeMediaEntries, bytesToDataUri, sniffMime };
})();
