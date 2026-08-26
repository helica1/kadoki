// mac-shim.js — Capacitor compatibility layer for the Kadoki macOS shell.
//
// Injected by the Swift shell as a WKUserScript at document start, BEFORE any
// app script runs. Provides the plugin surface the www code needs on desktop:
//   • FileAccess       — native pickers + real on-disk paths (no copying)
//   • BackgroundAudio  — the audiobook transport over one HTMLAudioElement
//   • AudioSlicer      — native AVFoundation slicing/waveforms (kadokiSlicer)
//   • AutoTranscribe   — native SpeechAnalyzer transcription (kadokiTranscribe)
//   • AnkiBridge       — desktop Anki via AnkiConnect (kadokiAnkiConnect proxy)
//   • Filesystem       — CACHE/DATA dirs under the app media root (Drive sync
//                        media transfer + auto-transcribe SRT finalize)
//   • App / Browser    — OAuth redirect capture + external-browser open
//   • Capacitor.convertFileSrc — absolute path → kadoki://localhost/__abs URL
//
// Deliberately ABSENT: Preferences. isCapacitorEnvironment() requires BOTH
// Filesystem and Preferences (presence probes), so leaving Preferences out
// keeps it false and every well-tested localStorage/IndexedDB web fallback in
// the app engages unchanged.
//
// Storage model: picked files stay IN PLACE (real absolute paths, granted to
// the scheme handler for Range-streamed serving) — same lazy contract as the
// mobile FileAccess plugin. uri = "macfile://<absolute path>". Files imported
// by the FIRST Mac build went into IndexedDB; those legacy
// "kadokimac://media/<id>" uris are migrated to disk lazily on first open.
(function () {
  'use strict';
  if (window.Capacitor) return; // real Capacitor present — do nothing

  const MH = () => (window.webkit && window.webkit.messageHandlers) || {};
  function native(handler, req) {
    const h = MH()[handler];
    if (!h) return Promise.reject(new Error(handler + ' handler unavailable'));
    return h.postMessage(JSON.stringify(req));
  }
  const nFile = (req) => native('kadokiFile', req);
  const nSlicer = (req) => native('kadokiSlicer', req);
  const nTranscribe = (req) => native('kadokiTranscribe', req);

  // ------------------------------------------------------------ event router
  // Swift pushes plugin events through window.__kadokiNativeEvent.
  const eventRegistries = new Map(); // pluginName → Map<eventName, Set<cb>>
  function registryFor(plugin) {
    if (!eventRegistries.has(plugin)) eventRegistries.set(plugin, new Map());
    return eventRegistries.get(plugin);
  }
  function makeAddListener(plugin) {
    return function addListener(name, cb) {
      const reg = registryFor(plugin);
      if (!reg.has(name)) reg.set(name, new Set());
      reg.get(name).add(cb);
      return { remove() { reg.get(name).delete(cb); } };
    };
  }
  function emit(plugin, name, data) {
    const set = registryFor(plugin).get(name);
    if (set) set.forEach((cb) => { try { cb(data); } catch (_) {} });
  }
  window.__kadokiNativeEvent = function (plugin, name, payload) { emit(plugin, name, payload); };

  // ------------------------------------------------------------ b64 helpers
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  const textToB64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64ToText = (b) => decodeURIComponent(escape(atob(b)));

  // ------------------------------------------------------------ path plumbing
  const URI_PREFIX = 'macfile://';
  const LEGACY_PREFIX = 'kadokimac://media/';
  const stripFile = (p) => String(p || '').replace(/^file:\/\//, '');

  let _mediaRootP = null;
  function mediaRoot() {
    if (!_mediaRootP) _mediaRootP = nFile({ op: 'mediaRoot' }).then((r) => r.path);
    return _mediaRootP;
  }

  function convertFileSrc(path) {
    const p = stripFile(path);
    if (!p || !p.startsWith('/')) return path; // blob:/data:/http(s)/relative — untouched
    return 'kadoki://localhost/__abs?p=' + encodeURIComponent(p);
  }

  // ---- legacy IndexedDB media (first Mac build) — lazy migration to disk ----
  let _dbP = null;
  function legacyDb() {
    if (_dbP) return _dbP;
    _dbP = new Promise((resolve) => {
      const req = indexedDB.open('kadoki_mac_media', 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore('files', { keyPath: 'id' }); } catch (_) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return _dbP;
  }
  function legacyGet(id) {
    return legacyDb().then((d) => new Promise((res) => {
      if (!d) return res(null);
      try {
        const r = d.transaction('files').objectStore('files').get(id);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      } catch (_) { res(null); }
    }));
  }
  async function migrateLegacy(id) {
    const rec = await legacyGet(id);
    if (!rec || !rec.blob) throw new Error('media record missing: ' + id);
    const root = await mediaRoot();
    const safe = String(rec.name || 'file').replace(/[\/\\]/g, '_');
    const dest = root + '/idb/' + id + '_' + safe;
    const st = await nFile({ op: 'stat', path: dest });
    if (!st.exists || st.size !== (rec.blob.size || 0)) {
      const CHUNK = 6291456; // divisible by 3 → base64 chunks concat cleanly
      for (let off = 0; off < rec.blob.size; off += CHUNK) {
        const buf = await rec.blob.slice(off, off + CHUNK).arrayBuffer();
        await nFile({ op: 'writeChunk', path: dest, dataBase64: bufToB64(buf), append: off > 0 });
      }
    }
    return { path: dest, size: rec.blob.size || 0 };
  }

  // ---------------------------------------------------------------- FileAccess
  const FileAccess = {
    async pickFileWithUri(opts) {
      const r = await nFile({ op: 'pickFile', kind: (opts && opts.kind) || null });
      if (!r || r.canceled || !r.path) return { uri: null };
      return { uri: URI_PREFIX + r.path, name: r.name, size: r.size };
    },

    async materializeToCache(opts) {
      const uri = String((opts && opts.uri) || '');
      if (uri.startsWith(URI_PREFIX)) {
        const path = uri.slice(URI_PREFIX.length);
        const st = await nFile({ op: 'stat', path });
        if (!st.exists) throw new Error('file missing: ' + path);
        return { path, size: st.size, cached: true };
      }
      if (uri.startsWith(LEGACY_PREFIX)) {
        const m = await migrateLegacy(uri.slice(LEGACY_PREFIX.length));
        return { path: m.path, size: m.size, cached: true };
      }
      // A bare absolute path (or file:// form) also materializes to itself.
      const bare = stripFile(uri);
      if (bare.startsWith('/')) {
        const st = await nFile({ op: 'stat', path: bare });
        if (!st.exists) throw new Error('file missing: ' + bare);
        return { path: bare, size: st.size, cached: true };
      }
      throw new Error('unknown uri: ' + uri);
    },

    async getPersistedUriPermissions() {
      try {
        const r = await nFile({ op: 'granted' });
        return { uris: (r.paths || []).map((p) => URI_PREFIX + p) };
      } catch (_) { return { uris: [] }; }
    },

    async readChunk(opts) {
      const path = stripFile((opts && opts.path) || '');
      const r = await nFile({ op: 'readChunk', path, offset: opts.offset || 0, length: opts.length || 0 });
      return { data: r.data, bytesRead: r.bytesRead };
    },

    async pickFolderTree() {
      const r = await nFile({ op: 'pickFolder' });
      if (!r || r.canceled || !r.rootPath) return { rootUri: null, rootName: '', files: [] };
      const files = (r.files || []).map((f) => ({
        uri: URI_PREFIX + f.path,
        name: f.name,
        dir: f.dir || '',
        relPath: f.relPath,
        ext: f.ext || '',
      }));
      emit('FileAccess', 'folderScanProgress', { scanned: files.length, total: files.length });
      return { rootUri: URI_PREFIX + r.rootPath, rootName: r.rootName, files };
    },

    addListener: makeAddListener('FileAccess'),
  };

  // ---------------------------------------------------------- BackgroundAudio
  const LASTPOS_KEY = 'KADOKI_MAC_BG_LASTPOS';
  const audio = new Audio();
  audio.preload = 'auto';
  let bgUrl = null;        // the exact url string passed to play()
  let bgTimer = null;
  let lastPersist = 0;

  function persistPos(force) {
    if (!bgUrl) return;
    const now = Date.now();
    if (!force && now - lastPersist < 3000) return;
    lastPersist = now;
    try {
      localStorage.setItem(LASTPOS_KEY, JSON.stringify({ url: bgUrl, ms: Math.round(audio.currentTime * 1000) }));
    } catch (_) {}
  }

  function emitPosition() {
    emit('BackgroundAudio', 'position', {
      positionMs: Math.round(audio.currentTime * 1000),
      durationMs: isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
      playing: !audio.paused && !audio.ended,
      ts: Date.now(),
    });
  }

  function startTicker() {
    if (bgTimer) return;
    bgTimer = setInterval(() => {
      if (audio.paused || audio.ended) return;
      emitPosition();
      persistPos(false);
    }, 150);
  }

  audio.addEventListener('play',  () => { emit('BackgroundAudio', 'state', { playing: true,  ts: Date.now() }); emitPosition(); });
  audio.addEventListener('pause', () => { emit('BackgroundAudio', 'state', { playing: false, ts: Date.now() }); persistPos(true); });
  audio.addEventListener('ended', () => { persistPos(true); emit('BackgroundAudio', 'ended', {}); });
  audio.addEventListener('error', () => {
    const e = audio.error;
    emit('BackgroundAudio', 'error', { message: 'audio error' + (e ? ' code=' + e.code : '') });
  });

  function waitReady(timeoutMs) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, timeoutMs || 8000);
      function done() { clearTimeout(t); audio.removeEventListener('loadedmetadata', done); resolve(); }
      audio.addEventListener('loadedmetadata', done);
    });
  }

  const BackgroundAudio = {
    async play(opts) {
      const url = String((opts && opts.url) || '');
      const src = convertFileSrc(url);
      if (audio.src !== src) { audio.src = src; audio.load(); }
      bgUrl = url;
      await waitReady(8000);
      if (opts && typeof opts.startMs === 'number') {
        try { audio.currentTime = Math.max(0, opts.startMs) / 1000; } catch (_) {}
      }
      audio.playbackRate = (opts && opts.rate) || 1.0;
      startTicker();
      await audio.play();
      emitPosition();
      return {};
    },
    async pause() { audio.pause(); return {}; },
    async resume() { startTicker(); await audio.play(); return {}; },
    async stop() { persistPos(true); audio.pause(); return {}; },
    async seek(opts) {
      try { audio.currentTime = Math.max(0, ((opts && opts.ms) || 0)) / 1000; } catch (_) {}
      persistPos(true);
      emitPosition();
      return {};
    },
    async setRate(opts) { audio.playbackRate = (opts && opts.rate) || 1.0; return {}; },
    async getState() {
      return {
        playing: !audio.paused && !audio.ended && !!audio.src,
        ready: audio.readyState >= 2,
        positionMs: Math.round(audio.currentTime * 1000),
        durationMs: isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
        url: bgUrl || '',
      };
    },
    async getLastSavedPosition() {
      try {
        const v = JSON.parse(localStorage.getItem(LASTPOS_KEY) || 'null');
        if (v && v.url) return { url: v.url, ms: v.ms || 0 };
      } catch (_) {}
      return { url: '', ms: 0 };
    },
    async setMetadata() { return {}; },
    async setSubtitleArt() { return {}; },
    async setKeepAwake() { return {}; },
    async setChapterRepeat() { return {}; },
    async skipToNextChapter() { return {}; },
    addListener: makeAddListener('BackgroundAudio'),
  };

  // -------------------------------------------------------------- AudioSlicer
  const AudioSlicer = {
    async slice(opts) {
      return nSlicer({
        op: 'slice',
        srcPath: stripFile((opts && opts.srcPath) || ''),
        startMs: (opts && opts.startMs) || 0,
        endMs: (opts && opts.endMs) || 0,
      });
    },
    async getWaveform(opts) {
      return nSlicer({
        op: 'getWaveform',
        srcPath: stripFile((opts && opts.srcPath) || ''),
        startMs: (opts && opts.startMs) || 0,
        endMs: (opts && opts.endMs) || 0,
        samples: (opts && opts.samples) || 200,
      });
    },
  };

  // ------------------------------------------------------------ AutoTranscribe
  const AutoTranscribe = {
    checkAvailability: () => nTranscribe({ op: 'checkAvailability' }),
    ensureAssets:      () => nTranscribe({ op: 'ensureAssets' }),
    start: (opts) => nTranscribe({
      op: 'start',
      jobId: opts.jobId, srcPath: stripFile(opts.srcPath),
      startMs: opts.startMs || 0,
      targetMs: (opts.targetMs != null ? opts.targetMs : (opts.startMs || 0)),
      aheadMs: (opts.aheadMs != null ? opts.aheadMs : 600000),
    }),
    setTarget: (opts) => nTranscribe({ op: 'setTarget', jobId: opts.jobId || null, targetMs: opts.targetMs || 0 }),
    stop:      (opts) => nTranscribe({ op: 'stop', jobId: (opts && opts.jobId) || null }),
    getChapters: (opts) => nTranscribe({ op: 'getChapters', srcPath: stripFile((opts && opts.srcPath) || '') }),
    addListener: makeAddListener('AutoTranscribe'),
  };

  // ---------------------------------------------------------------- Filesystem
  // Minimal surface for drive-sync-media.js (CACHE) and auto-transcribe.js
  // finalize (DATA). Directories live under the native media root so the
  // scheme handler can serve their contents.
  async function fsResolve(path, directory) {
    const bare = stripFile(String(path || ''));
    if (bare.startsWith('/')) return bare;
    const root = await mediaRoot();
    return root + '/fs/' + (directory || 'DATA') + '/' + bare;
  }

  const Filesystem = {
    async stat(opts) {
      const p = await fsResolve(opts.path, opts.directory);
      const r = await nFile({ op: 'stat', path: p });
      if (!r.exists) throw new Error('File does not exist');
      return { type: 'file', size: r.size, mtime: 0, uri: 'file://' + p };
    },
    async getUri(opts) {
      const p = await fsResolve(opts.path, opts.directory);
      return { uri: 'file://' + p };
    },
    async writeFile(opts) {
      const p = await fsResolve(opts.path, opts.directory);
      const enc = (opts.encoding || '').toLowerCase();
      const b64 = (enc === 'utf8' || enc === 'utf-8') ? textToB64(String(opts.data || ''))
                                                      : String(opts.data || '');
      await nFile({ op: 'writeChunk', path: p, dataBase64: b64, append: false });
      return { uri: 'file://' + p };
    },
    async appendFile(opts) {
      const p = await fsResolve(opts.path, opts.directory);
      const enc = (opts.encoding || '').toLowerCase();
      const b64 = (enc === 'utf8' || enc === 'utf-8') ? textToB64(String(opts.data || ''))
                                                      : String(opts.data || '');
      await nFile({ op: 'writeChunk', path: p, dataBase64: b64, append: true });
      return {};
    },
    async readFile(opts) {
      const p = await fsResolve(opts.path, opts.directory);
      const st = await nFile({ op: 'stat', path: p });
      if (!st.exists) throw new Error('File does not exist');
      const CHUNK = 6291456; // divisible by 3 → base64 concat is valid
      let b64 = '';
      for (let off = 0; off < st.size; off += CHUNK) {
        const r = await nFile({ op: 'readChunk', path: p, offset: off, length: Math.min(CHUNK, st.size - off) });
        b64 += r.data;
      }
      const enc = (opts.encoding || '').toLowerCase();
      return { data: (enc === 'utf8' || enc === 'utf-8') ? b64ToText(b64) : b64 };
    },
    async mkdir() { return {}; },   // writeChunk creates directories as needed
    async deleteFile() { return {}; },
  };

  // ------------------------------------------------------------- App / Browser
  const App = {
    addListener: makeAddListener('App'),
    async getState() { return { isActive: !document.hidden }; },
    async exitApp() { return {}; },
  };

  const Browser = {
    async open(opts) {
      // The shell's WKUIDelegate routes window.open to the default browser.
      window.open((opts && opts.url) || '', '_blank');
      return {};
    },
    async close() { return {}; },
    addListener: makeAddListener('Browser'),
  };

  // -------------------------------------------------------------- AnkiBridge
  // Desktop Anki via AnkiConnect, proxied through the native shell (no CORS).
  async function ankiRequest(action, params) {
    const h = MH().kadokiAnkiConnect;
    if (!h) throw new Error('AnkiConnect proxy unavailable');
    const body = JSON.stringify(params ? { action, version: 6, params } : { action, version: 6 });
    const text = await h.postMessage(body);
    const json = JSON.parse(text);
    if (json && json.error) throw new Error(json.error);
    return json ? json.result : null;
  }

  async function readFileB64(path) {
    const p = stripFile(path);
    const st = await nFile({ op: 'stat', path: p });
    if (!st.exists) throw new Error('audio file missing: ' + p);
    const CHUNK = 6291456;
    let b64 = '';
    for (let off = 0; off < st.size; off += CHUNK) {
      const r = await nFile({ op: 'readChunk', path: p, offset: off, length: Math.min(CHUNK, st.size - off) });
      b64 += r.data;
    }
    return b64;
  }

  let _ankiAvailableCache = null;
  const AnkiBridge = {
    async isAvailable() {
      if (_ankiAvailableCache === true) return { available: true };
      try {
        await ankiRequest('version');
        _ankiAvailableCache = true;
        return { available: true };
      } catch (_) {
        _ankiAvailableCache = null;
        return { available: false };
      }
    },
    async requestPermission() { return { granted: true }; },
    async deckNames() { return { decks: (await ankiRequest('deckNames')) || [] }; },
    async modelNames() { return { models: (await ankiRequest('modelNames')) || [] }; },
    async modelFieldNames(opts) {
      return { fields: (await ankiRequest('modelFieldNames', { modelName: opts && opts.modelName })) || [] };
    },
    async addNote(params) {
      const note = {
        deckName: params.deckName,
        modelName: params.modelName,
        fields: params.fields || {},
        tags: params.tags || [],
        options: { allowDuplicate: true },
      };
      if (Array.isArray(params.audio) && params.audio.length) {
        note.audio = [];
        for (const a of params.audio) {
          // Two shapes: {dataBase64} (inline) or {srcPath} (slice on disk —
          // the enhanced-dictionary path hands the file to the bridge).
          const data = a.dataBase64 || (a.srcPath ? await readFileB64(a.srcPath) : null);
          if (data) note.audio.push({ filename: a.filename, data, fields: [a.field] });
        }
      }
      if (Array.isArray(params.picture) && params.picture.length) {
        note.picture = params.picture.map((p) => ({ filename: p.filename, data: p.dataBase64, fields: [p.field] }));
      }
      try {
        const noteId = await ankiRequest('addNote', { note });
        // Resolve the app's x-callback wait (sendToAnkiConnect.js matches on
        // the substring "anki-success").
        setTimeout(() => emit('AnkiBridge', 'ankiCallbackUrl', { url: 'ankideckreader://anki-success' }), 50);
        return { noteId };
      } catch (e) {
        setTimeout(() => emit('AnkiBridge', 'ankiCallbackUrl', { url: 'ankideckreader://anki-error?errorMessage=' + encodeURIComponent(e.message || 'AnkiConnect error') }), 50);
        throw e;
      }
    },
    async fetchInfo() {
      try {
        const decks = (await ankiRequest('deckNames')) || [];
        const models = (await ankiRequest('modelNames')) || [];
        const notetypes = [];
        for (const name of models) {
          let fields = [];
          try { fields = (await ankiRequest('modelFieldNames', { modelName: name })) || []; } catch (_) {}
          notetypes.push({ name, fields });
        }
        emit('AnkiBridge', 'ankiInfo', { decks, notetypes });
      } catch (e) {
        emit('AnkiBridge', 'ankiInfo', { error: e.message || 'AnkiConnect unavailable' });
      }
      return {};
    },
    addListener: makeAddListener('AnkiBridge'),
  };

  // ------------------------------------------------- Google Drive OAuth seed
  // gdrive-auth.js picks clientIdAndroid on platform 'web'. The shell's
  // Info.plist registers the iOS client's reversed scheme, so steer the
  // 'web' slot to the iOS client id (only when the user hasn't configured
  // anything themselves).
  try {
    if (!localStorage.getItem('GDRIVE_CONFIG_V1')) {
      localStorage.setItem('GDRIVE_CONFIG_V1', JSON.stringify({
        clientIdAndroid: '806495706886-mgaafth2nul8p9p95ni58tsrdb6s40ds.apps.googleusercontent.com',
      }));
    }
  } catch (_) {}

  // ------------------------------------------------------- trackpad gestures
  // Two-finger trackpad swipes arrive as wheel events. Deltas are normalized
  // to FINGER direction (macOS "natural scrolling" inverts them), accumulated
  // per gesture, and mapped — in all three modes:
  //   fingers down  → play/pause        (shellTogglePlay, mode-appropriate)
  //   fingers left  → previous subtitle (lockScreenCueJump(-1))
  //   fingers right → next subtitle     (lockScreenCueJump(+1))
  // Read mode keeps native horizontal trackpad paging: only a FAST flick
  // (large per-event delta) claims the horizontal gesture there.
  (function installTrackpadGestures() {
    // Subtitle navigation for keyboard/trackpad. lockScreenCueJump derives the
    // current cue from the LIVE audio playhead (right for lock-screen buttons,
    // and for audio mode) — but in read/card mode with idle audio the playhead
    // can legitimately sit at 0, which made "previous" jump to the START OF
    // THE BOOK. Here: audio mode (or actively playing audio) → playhead-based;
    // otherwise → the reader/card cursor (_lastAudioCueIdx, maintained by
    // reader scrolling and card renders). No cursor → do nothing, never 0.
    function cueJump(dir) {
      try {
        const inAudio = document.body && document.body.classList.contains('mode-audio');
        if (inAudio || (!audio.paused && !audio.ended && audio.src)) {
          window.lockScreenCueJump?.(dir);
          return;
        }
        const cues = (window.pagedCues && window.pagedCues.length ? window.pagedCues : window.__abCues) || [];
        if (!cues.length) return;
        const cur = (window._lastAudioCueTitleId === window._activeTitleId &&
                     Number.isFinite(window._lastAudioCueIdx)) ? window._lastAudioCueIdx : -1;
        if (cur < 0) return;   // unknown spot → stay put (place-loss guard)
        const target = Math.max(0, Math.min(cues.length - 1, cur + dir));
        const cue = cues[target];
        if (!cue || !Number.isFinite(cue.startMs)) return;
        window._lastAudioCueIdx = target;
        window._lastAudioCueTitleId = window._activeTitleId;
        window._audioStatsSeekTs = Date.now();
        const ms = Math.max(0, Math.round(cue.startMs) - (window.AUDIO_START_OFFSET_MS || 0));
        BackgroundAudio.seek({ ms, fadeMs: 40 });
      } catch (_) {}
    }

    let accX = 0, accY = 0, fired = false, claimed = false, lastT = 0, fireT = 0;
    const TH = 28;          // accumulated finger-px to fire (short swipes count)
    const QUIET_MS = 140;   // silence that ends a gesture
    const REFIRE_MS = 350;  // after this, a fresh energetic delta = new gesture

    function overlayBlocked(t) {
      let el = (t instanceof Element) ? t : null;
      for (; el && el !== document.body; el = el.parentElement) {
        if (el.id === 'dictPopup') return true;
        // The full-screen MODE ROOTS are themselves fixed high-z layers
        // (#audiobookModeView is fixed z:2750, #readingPagedView similar) —
        // gestures inside them are exactly the point. Stop the walk there;
        // real overlays attach to <body> directly, so they're still caught.
        if (el.id === 'readingPagedView' || el.id === 'audiobookModeView' ||
            el.id === 'cardContainer' || el.id === 'appHeader') return false;
        let cs;
        try { cs = getComputedStyle(el); } catch (_) { return false; }
        const z = parseInt(cs.zIndex, 10);
        // Overlays (timeline, preferences, library, menus…) are fixed/absolute
        // high-z layers — never steal their scroll.
        if ((cs.position === 'fixed' || cs.position === 'absolute') && Number.isFinite(z) && z >= 1000) return true;
      }
      return false;
    }

    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) return;   // pinch-zoom / modified scroll
      const body = document.body;
      if (!body) return;
      const mode = body.classList.contains('mode-read') ? 'read'
                 : body.classList.contains('mode-card') ? 'card'
                 : body.classList.contains('mode-audio') ? 'audio' : null;
      if (!mode) return;
      if (overlayBlocked(e.target)) return;

      // true (or undefined, the macOS default) = natural scrolling.
      const inv = (e.webkitDirectionInvertedFromDevice !== false);
      const fx = inv ? -e.deltaX : e.deltaX;
      const fy = inv ? -e.deltaY : e.deltaY;

      // Resting-finger jitter (sub-3px deltas) must never accumulate into a
      // gesture — with the short-swipe threshold it eventually fired actions
      // from fingers merely TOUCHING the trackpad.
      if (Math.abs(fx) < 3 && Math.abs(fy) < 3) return;

      const now = Date.now();
      if (now - lastT > QUIET_MS) { accX = 0; accY = 0; fired = false; claimed = false; }
      lastT = now;
      if (fired) {
        // A fresh energetic delta after the refractory window is a NEW swipe
        // (momentum tails only decay) — without this, back-to-back swipes were
        // swallowed as "the same gesture" until the user paused or clicked.
        if (now - fireT >= REFIRE_MS && (Math.abs(fx) >= 15 || Math.abs(fy) >= 15)) {
          fired = false; claimed = false; accX = 0; accY = 0;
        } else {
          if (claimed) e.preventDefault();   // swallow the momentum tail
          return;
        }
      }
      accX += fx; accY += fy;

      const ax = Math.abs(accX), ay = Math.abs(accY);
      // Read mode splits the window: LOWER half = swipe zone (subtitle jumps),
      // UPPER half = native trackpad page-scrolling. (Flip the comparison if
      // the halves should be the other way around.)
      const horizOk = mode !== 'read' || e.clientY > (window.innerHeight * 0.5);
      if (ay > TH && ay > ax * 1.6) {
        fired = true; fireT = now;
        if (accY > 0) {                    // fingers moved DOWN
          claimed = true;
          e.preventDefault();
          try { window.shellTogglePlay?.(); } catch (_) {}
        }
      } else if (horizOk && ax > TH && ax > ay * 1.6) {
        fired = true; fireT = now;
        claimed = true;
        e.preventDefault();
        try { cueJump(accX > 0 ? 1 : -1); } catch (_) {}
      }
    }, { passive: false, capture: true });

    // Keyboard transport in all three modes (never while typing in a field,
    // never with modifiers — those stay available as shortcuts):
    //   Space → play/pause;  ← → previous subtitle;  → → next subtitle
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.code !== 'Space' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      const body = document.body;
      if (!body) return;
      if (!(body.classList.contains('mode-read') || body.classList.contains('mode-card') ||
            body.classList.contains('mode-audio'))) return;
      e.preventDefault();   // suppress the scroll defaults
      try {
        if (e.code === 'Space') window.shellTogglePlay?.();
        else cueJump(e.code === 'ArrowRight' ? 1 : -1);
      } catch (_) {}
    }, true);

    // Dictionary-popup escape hatches. With rich dictionaries the popup can
    // grow near-fullscreen, leaving no "outside" area to click — the mobile
    // dismissers only fire on outside taps, so the popup felt stuck open.
    //   ESC          → always closes it
    //   click INSIDE → closes too, unless the click is on a control or was
    //                  a drag (CMD-selection stays untouched)
    function dismissPopup() {
      try { window.hideDictPopup?.(); } catch (_) {}
      window._dictPopupDismissedTs = Date.now();
    }
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      const popup = document.getElementById('dictPopup');
      if (popup && popup.style.display !== 'none') {
        e.preventDefault();
        dismissPopup();
      }
    }, true);
    let pdX = 0, pdY = 0;
    document.addEventListener('mousedown', (e) => { pdX = e.clientX; pdY = e.clientY; }, true);
    document.addEventListener('click', (e) => {
      const popup = document.getElementById('dictPopup');
      if (!popup || popup.style.display === 'none') return;
      if (e.metaKey) return;                                    // CMD = selecting text
      if (document.getElementById('waveformEditorOverlay')) return;
      if (document.getElementById('lookupNavBar')) return;
      if (Math.abs(e.clientX - pdX) > 6 || Math.abs(e.clientY - pdY) > 6) return;  // drag/scroll
      const t = e.target instanceof Element ? e.target : null;
      if (popup.contains(e.target)) {
        // Interior click closes too (the popup can grow near-fullscreen),
        // unless it's on a control.
        if (t && t.closest('button, input, select, textarea, a, [contenteditable], .dict-sc-link, summary, audio')) return;
        dismissPopup();
        return;
      }
      // OUTSIDE click: dismiss in card/audio modes. The paged reader handles
      // its own dismissal on mousedown (same tap may also start a lookup), so
      // leave clicks inside it alone. Clicking a subtitle character starts a
      // NEW lookup via its own handler — don't double-handle it here.
      const pagedView = document.getElementById('readingPagedView');
      if (pagedView && pagedView.style.visibility !== 'hidden' &&
          pagedView.style.display !== 'none' && pagedView.contains(e.target)) return;
      if (t && (t.classList.contains('dict-frag') || t.closest('.dict-frag'))) return;
      dismissPopup();
    }, true);
  })();

  // ---------------------------------------------------------------- Capacitor
  window.Capacitor = {
    getPlatform() { return 'web'; },
    isNativePlatform() { return false; },
    convertFileSrc,
    Plugins: {
      FileAccess, BackgroundAudio, AudioSlicer, AutoTranscribe,
      AnkiBridge, Filesystem, App, Browser,
    },
  };
})();
