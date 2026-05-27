(function () {
  // Local audio integration for the dictionary popup.
  //
  // Layouts (themoeway "Local Audio Server for Yomitan"):
  //   www/yomichan-audio/jpod_files/index.json
  //   www/yomichan-audio/jpod_files/media-zips/<XX>.zip       (256 buckets)
  //   www/yomichan-audio/shinmeikai8_files/index.json
  //   www/yomichan-audio/shinmeikai8_files/media-zips/<NN>.zip (100 buckets)
  //   www/yomichan-audio/nhk16_files/entries.json
  //   www/yomichan-audio/nhk16_files/audio-zips/<SS>.zip       (60 buckets)
  //
  // The originals exceed the APK ZIP central-directory limit (65,535 entries),
  // so MP3s ship in per-source bucket zips and we extract on demand with
  // JSZip + an LRU cache.

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
        const res = await fetch(`${src.base}/${src.indexFile}`);
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
      const url = `${src.base}/${src.bucketsDir}/${bucketKey}.zip`;
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
