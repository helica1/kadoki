(function () {
  // Local audio integration for the dictionary popup.
  //
  // Layouts (themoeway "Local Audio Server for Yomitan"):
  //   <base>/jpod_files/index.json
  //   <base>/jpod_files/media-zips/<XX>.zip       (256 buckets)
  //   <base>/shinmeikai8_files/index.json
  //   <base>/shinmeikai8_files/media-zips/<NN>.zip (100 buckets)
  //   <base>/nhk16_files/entries.json
  //   <base>/nhk16_files/audio-zips/<SS>.zip       (60 buckets)
  //
  // <base> resolves to:
  //   - Android: `yomichan-audio/...` — bundled in the APK alongside www/.
  //   - iOS:     `Documents/yomichan-audio/...` after the user sideloads
  //              the archive via Preferences → Audio archive → Import.
  //              We fetch via Capacitor.convertFileSrc() which routes
  //              through WKWebView's local file scheme.
  //
  // The originals exceed the APK ZIP central-directory limit (65,535 entries),
  // so MP3s ship in per-source bucket zips and we extract on demand with
  // JSZip + an LRU cache.

  // Resolve the on-disk base directory for audio archives. On iOS we read
  // the Documents path that ArchiveExtractor wrote when the user finished
  // their .tar import. Cached after first resolve so per-lookup overhead
  // stays at a Map.get(), not a bridge round-trip.
  let resolvedBase = null;       // string or null
  let resolveBasePromise = null; // dedupe concurrent first-lookup probes
  function ensureResolvedBase() {
    if (resolvedBase !== null) return Promise.resolve(resolvedBase);
    if (resolveBasePromise) return resolveBasePromise;
    resolveBasePromise = (async () => {
      // 1) Preferences pref written by audio-archive.js when the user
      //    extracted a .tar through the importer.
      try {
        if (window.Capacitor?.Plugins?.Preferences) {
          const r = await window.Capacitor.Plugins.Preferences.get({ key: 'YOMICHAN_AUDIO_DIR' });
          if (r.value) {
            console.log(`[local-audio] base from Preferences: ${r.value}`);
            resolvedBase = r.value;
            return r.value;
          }
        }
      } catch (e) {}
      // 2) Fallback: if the user manually dragged files into
      //    "On My iPhone → AnkiDeckReader → yomichan-audio" via Files.app,
      //    no pref is set. Discover the path via the Filesystem plugin
      //    (DOCUMENTS dir + "yomichan-audio").
      try {
        if (window.Capacitor?.Plugins?.Filesystem?.getUri) {
          const u = await window.Capacitor.Plugins.Filesystem.getUri({
            directory: 'DOCUMENTS',
            path: 'yomichan-audio'
          });
          if (u?.uri) {
            // Filesystem.getUri returns file:// — strip it; convertFileSrc
            // wants a raw filesystem path on iOS.
            const path = u.uri.replace(/^file:\/\//, '');
            console.log(`[local-audio] base via Filesystem.getUri: ${path}`);
            resolvedBase = path;
            return path;
          }
        }
      } catch (e) {
        console.warn('[local-audio] Filesystem.getUri fallback failed:', e?.message);
      }
      // 3) Final fallback: relative path (Android bundles audio at
      //    www/yomichan-audio/...).
      resolvedBase = '';
      return '';
    })();
    return resolveBasePromise;
  }

  // Probe-and-cache the actual subdirectory layout inside the extracted
  // archive. The community archive (e.g. local-yomichan-audio-collection-
  // 2023-06-11-mp3.tar) nests the source folders under a `user_files/`
  // subdir; other distributions put them at the top level. We test which
  // one works on first lookup per source and remember it.
  const _layoutCache = new Map(); // src.id → resolved sub-path prefix
  async function probeLayout(src) {
    if (_layoutCache.has(src.id)) return _layoutCache.get(src.id);
    const base = await ensureResolvedBase();
    const candidates = base && window.Capacitor?.convertFileSrc
      ? [
          // Strip the bundled-Android prefix once, then try both layouts.
          `${base}/${src.base.replace(/^yomichan-audio\/?/, '')}`,                // <root>/jpod_files
          `${base}/user_files/${src.base.replace(/^yomichan-audio\/?/, '')}`,     // <root>/user_files/jpod_files
        ]
      : [src.base];
    for (const cand of candidates) {
      const probeUrl = window.Capacitor?.convertFileSrc
        ? (cand.startsWith('http') || cand.startsWith('capacitor://')
           ? `${cand}/${src.indexFile}`
           : `${window.Capacitor.convertFileSrc(`${cand}/${src.indexFile}`)}`)
        : `${cand}/${src.indexFile}`;
      try {
        const res = await fetch(probeUrl);
        if (res.ok) {
          _layoutCache.set(src.id, cand);
          console.log(`[local-audio] ${src.id} resolved to ${cand} (probe ${res.status})`);
          return cand;
        }
        console.log(`[local-audio] ${src.id} probe ${res.status} at ${probeUrl}`);
      } catch (e) {
        console.warn(`[local-audio] ${src.id} probe failed at ${probeUrl}:`, e?.message);
      }
    }
    // Probe failed everywhere — cache the most-likely candidate so we
    // don't re-probe on every lookup. Lookups will 404 and log.
    const fallback = candidates[candidates.length - 1] || `${src.base}`;
    _layoutCache.set(src.id, fallback);
    console.warn(`[local-audio] ${src.id} could not resolve, using ${fallback}`);
    return fallback;
  }

  async function resolveSrcURL(src, sub) {
    const prefix = await probeLayout(src);
    const path = `${prefix}/${sub}`;
    if (window.Capacitor?.convertFileSrc && (await ensureResolvedBase())) {
      return window.Capacitor.convertFileSrc(path);
    }
    return path;
  }

  const SOURCES = [
    {
      id: 'jpod',
      base: 'yomichan-audio/jpod_files',
      bucketsDir: 'media-zips',
      bucketKey: (fn) => fn.slice(0, 2).toLowerCase(),
      indexFile: 'index.json',
      indexFormat: 'standard',
      indexLoaded: null,
      index: null
    },
    {
      id: 'shinmeikai',
      base: 'yomichan-audio/shinmeikai8_files',
      bucketsDir: 'media-zips',
      bucketKey: (fn) => fn.slice(0, 2),
      indexFile: 'index.json',
      indexFormat: 'standard',
      indexLoaded: null,
      index: null
    }
    // NHK16 was dropped to keep the APK under the 4 GB ZIP32 limit.
    // Re-add the entry block if you ever externalize audio to /sdcard.
  ];

  const LRU_MAX = 8;
  const bucketCache = new Map(); // "<sourceId>/<bucket>" → JSZip

  let sharedAudio = null;
  function getSharedAudio() {
    if (!sharedAudio) sharedAudio = new Audio();
    return sharedAudio;
  }

  // NHK's entries.json is an array of detailed accent records. Flatten into a
  // {term-or-reading → [soundFile, ...]} map so the same headwords-lookup code
  // works across all sources.
  function buildNhkHeadwords(entries) {
    const headwords = {};
    const push = (key, files) => {
      if (!key) return;
      let arr = headwords[key];
      if (!arr) { arr = []; headwords[key] = arr; }
      for (const f of files) if (f && arr.indexOf(f) < 0) arr.push(f);
    };
    for (const e of entries) {
      const files = [];
      const accs = e.accents || [];
      for (const a of accs) if (a && a.soundFile) files.push(a.soundFile);
      if (!files.length) continue;
      if (e.kana) push(e.kana, files);
      const kanjis = e.kanji || [];
      for (const k of kanjis) push(k, files);
    }
    return { meta: { name: 'NHK Accent Dict 16' }, headwords };
  }

  async function loadIndex(src) {
    if (src.index) return src.index;
    if (src.indexLoaded) return src.indexLoaded;
    src.indexLoaded = (async () => {
      try {
        const url = await resolveSrcURL(src, src.indexFile);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${src.indexFile}: ${res.status}`);
        const json = await res.json();
        let idx;
        if (src.indexFormat === 'nhk') {
          idx = buildNhkHeadwords(json);
          console.log(`[local-audio] ${src.id}: built ${Object.keys(idx.headwords).length} headwords from ${json.length} entries`);
        } else {
          idx = json;
          console.log(`[local-audio] ${src.id}: loaded ${Object.keys(json.headwords || {}).length} headwords`);
        }
        src.index = idx;
        return idx;
      } catch (e) {
        console.warn(`[local-audio] index load failed for ${src.id}:`, e.message);
        src.indexLoaded = null;
        return null;
      }
    })();
    return src.indexLoaded;
  }

  async function loadBucket(src, bucketKey) {
    const cacheKey = `${src.id}/${bucketKey}`;
    if (bucketCache.has(cacheKey)) {
      const zip = bucketCache.get(cacheKey);
      bucketCache.delete(cacheKey);
      bucketCache.set(cacheKey, zip);
      return zip;
    }
    if (typeof JSZip === 'undefined') {
      console.warn('[local-audio] JSZip not loaded');
      return null;
    }
    try {
      const url = await resolveSrcURL(src, `${src.bucketsDir}/${bucketKey}.zip`);
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[local-audio] bucket fetch failed ${cacheKey}: ${res.status}`);
        return null;
      }
      const buf = await res.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      bucketCache.set(cacheKey, zip);
      while (bucketCache.size > LRU_MAX) {
        const oldest = bucketCache.keys().next().value;
        bucketCache.delete(oldest);
      }
      return zip;
    } catch (e) {
      console.warn(`[local-audio] bucket load error ${cacheKey}:`, e.message);
      return null;
    }
  }

  async function resolveAudioBlobUrl(src, filename) {
    if (!filename) return null;
    const bucketKey = src.bucketKey(filename);
    const zip = await loadBucket(src, bucketKey);
    if (!zip) return null;
    const entry = zip.file(filename);
    if (!entry) {
      console.warn(`[local-audio] file ${filename} not in ${src.id} bucket ${bucketKey}`);
      return null;
    }
    const blob = await entry.async('blob');
    const typedBlob = blob.type ? blob : new Blob([blob], { type: 'audio/mpeg' });
    return URL.createObjectURL(typedBlob);
  }

  async function lookupLocalAudio(term, reading) {
    if (!term) return [];
    const refs = [];
    for (const src of SOURCES) {
      const idx = await loadIndex(src);
      if (!idx || !idx.headwords) continue;
      const tryKey = (key) => {
        if (!key) return;
        const files = idx.headwords[key];
        if (!files) return;
        const arr = Array.isArray(files) ? files : [files];
        for (const f of arr) {
          if (typeof f === 'string') refs.push({ source: src, filename: f });
        }
      };
      tryKey(term);
      if (reading && reading !== term) tryKey(reading);
    }
    return refs;
  }

  let lastBlobUrl = null;

  async function tryPlay(url) {
    return new Promise((resolve) => {
      const audio = getSharedAudio();
      let settled = false;
      const cleanup = () => {
        audio.oncanplaythrough = null;
        audio.onerror = null;
      };
      audio.oncanplaythrough = () => {
        if (settled) return;
        settled = true;
        cleanup();
        audio.play().then(() => resolve(true)).catch(() => resolve(false));
      };
      audio.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      try {
        audio.src = url;
        audio.load();
      } catch (e) {
        settled = true;
        cleanup();
        resolve(false);
      }
    });
  }

  async function playRefs(refs) {
    for (const ref of refs) {
      const url = await resolveAudioBlobUrl(ref.source, ref.filename);
      if (!url) continue;
      const prev = lastBlobUrl;
      lastBlobUrl = url;
      if (prev) setTimeout(() => { try { URL.revokeObjectURL(prev); } catch (e) {} }, 30000);
      const ok = await tryPlay(url);
      if (ok) return true;
    }
    return false;
  }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const r = reader.result || '';
        const idx = r.indexOf(',');
        resolve(idx >= 0 ? r.slice(idx + 1) : '');
      };
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function getLocalAudioBase64(term, reading) {
    const refs = await lookupLocalAudio(term, reading);
    for (const ref of refs) {
      try {
        const bucketKey = ref.source.bucketKey(ref.filename);
        const zip = await loadBucket(ref.source, bucketKey);
        if (!zip) continue;
        const entry = zip.file(ref.filename);
        if (!entry) continue;
        const blob = await entry.async('blob');
        const base64 = await blobToBase64(blob);
        if (!base64) continue;
        return { filename: ref.filename, base64, source: ref.source.id };
      } catch (e) {
        console.warn('[local-audio] base64 extract failed:', e.message);
      }
    }
    return null;
  }

  window.lookupLocalAudio = lookupLocalAudio;
  window.getLocalAudioBase64 = getLocalAudioBase64;
  window.playLocalAudio = async function (term, reading) {
    const refs = await lookupLocalAudio(term, reading);
    if (!refs.length) return false;
    return playRefs(refs);
  };
})();
