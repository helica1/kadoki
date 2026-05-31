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
  let resolvedBase = null;       // non-empty string or null
  let resolveBasePromise = null; // dedupe concurrent first-lookup probes
  function ensureResolvedBase() {
    // Only cache *non-empty* results. If a lookup runs before the user
    // imports the archive, resolveBase will return '' (Android fallback)
    // — caching that would mean the dict popup keeps using the wrong
    // path even after the import completes. Re-running the resolver
    // until we get a real base is cheap.
    if (resolvedBase) return Promise.resolve(resolvedBase);
    if (resolveBasePromise) return resolveBasePromise;
    resolveBasePromise = (async () => {
      // 1) PRIMARY: ask Filesystem.getUri for the CURRENT container's
      //    Documents/yomichan-audio. The iOS app container UUID changes
      //    on reinstall; if we stored an absolute path in Preferences
      //    once, that path becomes a phantom after the next rebuild.
      //    Filesystem.getUri always returns the live path.
      try {
        if (window.Capacitor?.Plugins?.Filesystem?.getUri) {
          // iOS keeps the imported archive in Documents; Android in the app's
          // external files dir (Directory.EXTERNAL = getExternalFilesDir — no
          // storage permission, multi-GB room) which is exactly where
          // ArchiveExtractorPlugin writes it. Picking the wrong directory here
          // resolves to an empty/forbidden path and the lookup silently fails.
          const audioDir = (window.Capacitor?.getPlatform?.() === 'android') ? 'EXTERNAL' : 'DOCUMENTS';
          const u = await window.Capacitor.Plugins.Filesystem.getUri({
            directory: audioDir,
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
        console.warn('[local-audio] Filesystem.getUri probe failed:', e?.message);
      }
      // 2) Fallback: legacy Preferences pref. Note this can be a stale
      //    absolute path from a prior install; only used if getUri above
      //    didn't return anything.
      try {
        if (window.Capacitor?.Plugins?.Preferences) {
          const r = await window.Capacitor.Plugins.Preferences.get({ key: 'YOMICHAN_AUDIO_DIR' });
          if (r.value) {
            console.log(`[local-audio] base from Preferences (fallback): ${r.value}`);
            resolvedBase = r.value;
            return r.value;
          }
        }
      } catch (e) {}
      // 3) Final fallback: relative path (Android bundles audio at
      //    www/yomichan-audio/...). Don't cache this — see above.
      resolveBasePromise = null;
      return '';
    })();
    return resolveBasePromise;
  }

  // Called by audio-archive.js after a successful import. Clears every
  // cache that may have been populated with pre-import "no archive yet"
  // misses so the next dict lookup picks up the new files without an
  // app restart.
  window.invalidateLocalAudio = function () {
    resolvedBase = null;
    resolveBasePromise = null;
    _layoutCache.clear();
    bucketCache.clear();
    for (const src of SOURCES) {
      src.index = null;
      src.indexLoaded = null;
      src.layout = null;
      src.layoutPromise = null;
    }
    console.log('[local-audio] caches invalidated');
  };

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

  // After the index loads we know enough to probe whether this archive is
  // shipping bucketed-into-zips (Android-bundled layout, used to dodge the
  // 65,535-entry APK ZIP cap) or loose files in bucket subdirectories
  // (community tar.gz layout). iOS doesn't care about the APK cap so flat
  // is the natural form there.
  //
  // We pick one filename out of the loaded index and HEAD-probe its flat
  // path. If 2xx, layout=flat — every subsequent lookup just hands the
  // file URL straight to the audio element / fetch. If not, fall back to
  // the existing JSZip pipeline.
  async function detectLayout(src) {
    if (src.layout) return src.layout;
    if (src.layoutPromise) return src.layoutPromise;
    src.layoutPromise = (async () => {
      const idx = src.index;
      let probeFile = null;
      if (idx?.headwords) {
        for (const k in idx.headwords) {
          const files = idx.headwords[k];
          const arr = Array.isArray(files) ? files : [files];
          for (const f of arr) {
            if (typeof f === 'string') { probeFile = f; break; }
          }
          if (probeFile) break;
        }
      }
      if (probeFile) {
        const prefix = await probeLayout(src);
        const mediaDir = src.mediaDir || 'media';
        const flatPath = `${prefix}/${mediaDir}/${probeFile}`;
        const flatUrl = (window.Capacitor?.convertFileSrc && (await ensureResolvedBase()))
          ? window.Capacitor.convertFileSrc(flatPath)
          : flatPath;
        try {
          // Range header keeps the probe to a single byte instead of
          // pulling the whole mp3 just to test existence.
          const r = await fetch(flatUrl, { headers: { Range: 'bytes=0-0' } });
          if (r.ok || r.status === 206) {
            src.layout = 'flat';
            console.log(`[local-audio] ${src.id} layout=flat (probe ${probeFile} → ${r.status})`);
            return 'flat';
          }
          console.log(`[local-audio] ${src.id} flat probe ${flatPath} → ${r.status}, assuming zipped`);
        } catch (e) {
          console.warn(`[local-audio] ${src.id} flat probe error:`, e?.message);
        }
      }
      src.layout = 'zipped';
      return 'zipped';
    })();
    return src.layoutPromise;
  }

  // For flat-layout archives (community tar) all mp3s live in a single
  // <prefix>/<mediaDir>/<filename>. No bucketing — iOS handles a
  // 134k-file directory fine, and the source archive ships this way.
  async function flatFileUrl(src, filename) {
    const prefix = await probeLayout(src);
    const mediaDir = src.mediaDir || 'media';
    const path = `${prefix}/${mediaDir}/${filename}`;
    if (window.Capacitor?.convertFileSrc && (await ensureResolvedBase())) {
      return window.Capacitor.convertFileSrc(path);
    }
    return path;
  }

  // `mediaDir` is the source archive's flat-layout subdir (community tar):
  // <prefix>/<mediaDir>/<filename>. `bucketsDir` is the APK-bundled
  // layout: <prefix>/<bucketsDir>/<bucketKey>.zip → contains <filename>.
  // bucketKey/bucketsDir only matter when layout=zipped (Android path).
  //
  // Each entry must have all three fields; probeLayout falls back to a
  // sensible candidate when the source dir doesn't exist in this user's
  // archive, so registering extra sources is harmless (loadIndex 404s
  // silently and the source is skipped per-lookup).
  const SOURCES = [
    {
      id: 'jpod',
      base: 'yomichan-audio/jpod_files',
      mediaDir: 'media',
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
      mediaDir: 'media',
      bucketsDir: 'media-zips',
      bucketKey: (fn) => fn.slice(0, 2),
      indexFile: 'index.json',
      indexFormat: 'standard',
      indexLoaded: null,
      index: null
    },
    {
      // NHK Accent Dict 16 — array-format entries.json, audio/ subdir.
      // Was dropped from the Android APK for the 4 GB ZIP32 limit, but
      // iOS has no such cap so we can light it up on the imported tar.
      id: 'nhk',
      base: 'yomichan-audio/nhk16_files',
      mediaDir: 'audio',
      bucketsDir: 'audio-zips',
      bucketKey: (fn) => fn.slice(12, 14),
      indexFile: 'entries.json',
      indexFormat: 'nhk',
      indexLoaded: null,
      index: null
    },
    {
      // Daijirin (大辞林) — if present in the user's archive. Same
      // standard schema as jpod. Skipped silently if the dir doesn't
      // exist.
      id: 'daijirin',
      base: 'yomichan-audio/daijirin_files',
      mediaDir: 'media',
      bucketsDir: 'media-zips',
      bucketKey: (fn) => fn.slice(0, 2).toLowerCase(),
      indexFile: 'index.json',
      indexFormat: 'standard',
      indexLoaded: null,
      index: null
    },
    {
      // Daijisen (大辞泉) — same pattern as daijirin.
      id: 'daijisen',
      base: 'yomichan-audio/daijisen_files',
      mediaDir: 'media',
      bucketsDir: 'media-zips',
      bucketKey: (fn) => fn.slice(0, 2).toLowerCase(),
      indexFile: 'index.json',
      indexFormat: 'standard',
      indexLoaded: null,
      index: null
    }
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
        // Layout probe now that we have a real filename to test with.
        // Run async; resolveAudioBlobUrl awaits it lazily on first lookup.
        detectLayout(src).catch((e) =>
          console.warn(`[local-audio] ${src.id} layout detect failed:`, e?.message)
        );
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
    // Flat layout — just hand back a fetchable URL pointing at the file
    // on disk. No zip extraction needed, so playback is faster too.
    const layout = await detectLayout(src);
    if (layout === 'flat') {
      return await flatFileUrl(src, filename);
    }
    // Zipped layout (Android-bundled archive).
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
    console.log(`[local-audio] lookupLocalAudio enter: term="${term}" reading="${reading}"`);
    if (!term) return [];
    // Load every source's index in parallel — total wait is the slowest
    // index, not the sum. NHK's entries.json is ~7 MB and used to dominate
    // first-popup latency when loaded serially after jpod/shinmeikai.
    const indexes = await Promise.all(SOURCES.map(src =>
      loadIndex(src).then(idx => ({ src, idx }), () => ({ src, idx: null }))
    ));
    const refs = [];
    for (const { src, idx } of indexes) {
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
        const layout = await detectLayout(ref.source);
        let blob;
        if (layout === 'flat') {
          // Flat: fetch the mp3 directly, no JSZip needed. Range header
          // forces the HTTPURLResponse code-path in WebViewAssetHandler;
          // without it iOS sends a bare URLResponse for media files and
          // res.ok comes back false despite the body being intact.
          const url = await flatFileUrl(ref.source, ref.filename);
          const res = await fetch(url, { headers: { Range: 'bytes=0-' } });
          blob = await res.blob();
          if (!blob || blob.size === 0) {
            console.warn(`[local-audio] flat fetch ${ref.filename} → empty (status=${res.status})`);
            continue;
          }
        } else {
          const bucketKey = ref.source.bucketKey(ref.filename);
          const zip = await loadBucket(ref.source, bucketKey);
          if (!zip) continue;
          const entry = zip.file(ref.filename);
          if (!entry) continue;
          blob = await entry.async('blob');
        }
        const base64 = await blobToBase64(blob);
        if (!base64) continue;
        return { filename: ref.filename, base64, source: ref.source.id };
      } catch (e) {
        console.warn('[local-audio] base64 extract failed:', e.message);
      }
    }
    return null;
  }

  // Single-ref helpers — let callers (dict popup) choose WHICH audio to
  // play / send rather than always picking the first match. Powers the
  // ◀ ▶ audio cycler.
  async function playRef(ref) {
    if (!ref) return false;
    return playRefs([ref]);
  }
  async function getRefAudioBase64(ref) {
    if (!ref) return null;
    try {
      const layout = await detectLayout(ref.source);
      let blob;
      if (layout === 'flat') {
        const url = await flatFileUrl(ref.source, ref.filename);
        // iOS Capacitor's WebViewAssetHandler sends media files (.mp3
        // etc.) with a bare URLResponse — no HTTP status. That makes
        // `fetch().ok` false even though the body bytes are streamed
        // through fine. Forcing a Range header routes the request
        // through the handler's range branch which DOES send a 206
        // HTTPURLResponse. `bytes=0-` means "from offset 0 to EOF" —
        // we still get the whole file.
        const res = await fetch(url, { headers: { Range: 'bytes=0-' } });
        blob = await res.blob();
        if (!blob || blob.size === 0) {
          console.warn(`[local-audio] flat fetch ${ref.filename} → empty blob (status=${res.status} ok=${res.ok})`);
          return null;
        }
      } else {
        const bucketKey = ref.source.bucketKey(ref.filename);
        const zip = await loadBucket(ref.source, bucketKey);
        if (!zip) return null;
        const entry = zip.file(ref.filename);
        if (!entry) return null;
        blob = await entry.async('blob');
      }
      const base64 = await blobToBase64(blob);
      if (!base64) return null;
      return { filename: ref.filename, base64, source: ref.source.id };
    } catch (e) {
      console.warn('[local-audio] getRefAudioBase64 failed:', e?.message);
      return null;
    }
  }

  window.lookupLocalAudio = lookupLocalAudio;
  window.getLocalAudioBase64 = getLocalAudioBase64;
  window.playRef = playRef;
  window.getRefAudioBase64 = getRefAudioBase64;
  window.playLocalAudio = async function (term, reading) {
    const refs = await lookupLocalAudio(term, reading);
    if (!refs.length) return false;
    return playRefs(refs);
  };
})();
