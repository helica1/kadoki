// settings-transfer.js — export/import of ALL user settings as one JSON
// bundle, for moving to a new device/installation (any platform).
//
// The manifest below is a CURATED ALLOWLIST (verified against every storage
// writer in www, 2026-08). The importer refuses anything not on it, so even a
// hand-edited bundle can never inject per-title positions, caches, stats,
// sync identity, or OAuth tokens — the classes of state that must never move
// between devices (place-loss invariant, GDRIVE_DEVICE_ID collisions, etc.).
//
// Storage model note: the app has THREE write conventions (Preferences-else-
// localStorage, dual-write, localStorage-only). The exporter therefore reads
// localStorage first and falls back to Capacitor Preferences; the importer
// writes every key to BOTH stores, then reloads — boot re-reads everything.
//
// Custom fonts (multi-MB IndexedDB blobs) ride as an OPTIONAL top-level
// `fonts` bundle field (id/name preserved so APPEARANCE_V1's `custom:<id>`
// picks keep working with zero user action) — not through the keys
// allowlist below (a metadata-only export would leave ghost entries).
//
// Deliberately NOT exported: dictionary data (re-import the Yomitan zips;
// the bundle carries the NAMES so the import summary can say which ones to
// re-import). YOMICHAN_AUDIO_DIR is a device-local filesystem path —
// excluded, self-heals to "not linked".

(function () {
  'use strict';

  const FORMAT = 'kadoki-settings';
  const VERSION = 2; // v2 adds the optional top-level `fonts` array
  // Kill switch: font export/restore can hang the WebView on some font files
  // (FontFace.load() never settling — see fonts.js's withTimeout guard).
  // Flip back on once that's actually root-caused, not just timed-out-around.
  const FONTS_EXPORT_ENABLED = false;

  // Chunked base64 (avoids String.fromCharCode.apply stack overflow on
  // multi-MB font blobs; mirrors macos/Kadoki/mac-shim.js's bufToB64).
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  async function fontBytesTotal(list) {
    let total = 0;
    for (const f of list) {
      try { const blob = await window.fonts.getBlob(f.id); if (blob) total += blob.size || 0; } catch (_) {}
    }
    return total;
  }

  const EXACT_KEYS = [
    // Language / appearance / colors
    'UI_LANG', 'APPEARANCE_V1', 'MODE_COLORS_V1', 'SUBTITLE_OFFSET',
    'TL_FONT_SCALE_V1', 'TL_PICS_HIDDEN_V1', 'AICHAR_SORT',
    // Playback / card / reading / screen
    'PLAYBACK_RATES_V1', 'AUDIO_SPEED', 'KADOKI_CARD_AUTOADVANCE',
    'CHAPTER_REPEAT', 'KADOKI_COMBINE_SUBS', 'LOCKSCREEN_SUBTITLE_ART',
    'KADOKI_AT_PHRASE', 'STOPWATCH_TIMEOUT', 'KEEP_AWAKE_MIN',
    'READING_PROGRESS_MODE', 'KADOKI_KW_LEAD', 'DICT_PAUSE_ON_LOOKUP',
    'DICT_PREFS_V1',
    // Anki mappings (PREF_KEYS in preferences.js)
    'SELECTED_DECK', 'ANKI_SWIPE_DECK', 'ANKI_SWIPE_MODEL',
    'ANKI_SWIPE_F_EXPRESSION', 'ANKI_SWIPE_F_IMAGE', 'ANKI_SWIPE_F_AUDIO',
    'ANKI_DICT_DECK', 'ANKI_DICT_MODEL', 'ANKI_DICT_F_TERM',
    'ANKI_DICT_F_READING', 'ANKI_DICT_F_SENTENCE', 'ANKI_DICT_F_MEANING',
    'ANKI_DICT_F_IMAGE', 'ANKI_DICT_F_SENTENCE_AUDIO', 'ANKI_DICT_F_TERM_AUDIO',
    'ANKI_DICT_F_GLOSSARY', 'ANKI_DICT_F_TERM_FURIGANA',
    // AI text backend
    'AI_API_KEY', 'AI_ENABLED', 'AI_QUALITY', 'AI_BACKEND',
    'AI_OPENROUTER_KEY', 'AI_OPENROUTER_MODEL', 'AI_AUTO_PROCESS',
    'AICHUNK_SPLIT_K', 'AISCENE_AUTO_IMG', 'AISCENE_AUTO', 'AISCENE_IDEAS',
    'AISCENE_CHARS_PER',
    // AI image providers
    'OPENAI_API_KEY', 'FAL_API_KEY', 'AIIMG_BACKEND', 'AIIMG_SERVER_URL',
    'AIIMG_MODEL', 'AIIMG_STYLE', 'AIIMG_SCENES', 'AIIMG_SIZE',
    'AIIMG_OAI_IMGMODEL', 'AIIMG_OAI_MODEL', 'AIIMG_OAI_QUALITY', 'AIIMG_OAI_SIZE',
    'AIIMG_FAL_MODEL', 'AIIMG_FAL_MODEL_CUSTOM', 'AIIMG_FAL_FALLBACK',
    'AIIMG_FAL_ASPECT', 'AIIMG_DAILY_BUDGET', 'AIIMG_DAILY_USD', 'AIIMG_OR_MODEL',
    // Drive settings (never tokens / device id / root id)
    'GDRIVE_INCLUDE_MEDIA', 'GDRIVE_CONFIG_V1',
  ];
  // Per-deck custom field mappings — dormant until a same-named deck loads.
  const PREFIX_KEYS = ['fieldMapping_'];

  const t = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;

  function Prefs() { return window.Capacitor?.Plugins?.Preferences || null; }

  async function readKey(key) {
    const ls = localStorage.getItem(key);
    if (ls !== null) return ls;
    const p = Prefs();
    if (p) {
      try {
        const r = await p.get({ key });
        if (r && r.value !== null && r.value !== undefined) return r.value;
      } catch (_) {}
    }
    return null;
  }

  async function writeKey(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
    const p = Prefs();
    if (p) { try { await p.set({ key, value }); } catch (_) {} }
  }

  function allowedKey(key) {
    if (EXACT_KEYS.includes(key)) return true;
    return PREFIX_KEYS.some((pre) => key.startsWith(pre));
  }

  // ---------------------------------------------------------------- export

  async function buildBundle(opts) {
    opts = opts || {};
    const keys = {};
    for (const k of EXACT_KEYS) {
      const v = await readKey(k);
      if (v !== null) keys[k] = v;
    }
    // fieldMapping_* live in localStorage (Pref-else-LS writers); scan LS,
    // and that's sufficient on web/Mac. On native, per-deck mappings written
    // Preferences-only can't be enumerated (no keys() in all versions) — the
    // dominant settings all ride the exact list above.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && PREFIX_KEYS.some((pre) => k.startsWith(pre))) {
        keys[k] = localStorage.getItem(k);
      }
    }
    let dicts = [];
    try {
      if (window.dictStore?.list) dicts = (await window.dictStore.list()).map((m) => m.dictName);
    } catch (_) {}
    const bundle = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      platform: window.Capacitor?.getPlatform?.() || 'web',
      keys,
      dictionaries: dicts,
    };
    if (opts.includeFonts && window.fonts && window.fonts.list && window.fonts.getBlob) {
      const list = window.fonts.list();
      const fonts = [];
      // Sequential, one font at a time — do not hold multiple decoded
      // copies simultaneously (CJK faces can be 15-25 MB each).
      for (const f of list) {
        try {
          const blob = await window.fonts.getBlob(f.id);
          if (!blob) continue;
          const buf = await blob.arrayBuffer();
          fonts.push({ id: f.id, name: f.name, dataBase64: bufToB64(buf) });
        } catch (_) {}
      }
      if (fonts.length) bundle.fonts = fonts;
    }
    return bundle;
  }

  async function importBundle(text) {
    let bundle;
    try { bundle = JSON.parse(text); } catch (e) { throw new Error(t('pj.st_bad_json', 'Not valid JSON')); }
    if (!bundle || bundle.format !== FORMAT) throw new Error(t('pj.st_bad_format', 'Not a Kadoki settings file'));
    if (Number(bundle.version) > VERSION) throw new Error(t('pj.st_newer', 'Settings file is from a newer app version'));
    const keys = bundle.keys || {};
    let written = 0, skipped = 0;
    for (const [k, v] of Object.entries(keys)) {
      if (!allowedKey(k) || typeof v !== 'string') { skipped++; continue; }
      await writeKey(k, v);
      written++;
    }
    // Which of the bundle's dictionaries are missing here?
    let missingDicts = [];
    try {
      const have = new Set(window.dictStore?.list ? (await window.dictStore.list()).map((m) => m.dictName) : []);
      missingDicts = (bundle.dictionaries || []).filter((n) => !have.has(n));
    } catch (_) { missingDicts = bundle.dictionaries || []; }
    // Restore fonts under their original ids (id-idempotent — a repeated
    // import never duplicates the picker entry).
    let fontsImported = 0;
    if (Array.isArray(bundle.fonts) && window.fonts && window.fonts.restore) {
      for (const f of bundle.fonts) {
        if (!f || !f.id || !f.dataBase64) continue;
        try {
          const bytes = b64ToBytes(f.dataBase64);
          await window.fonts.restore(f.id, f.name, new Blob([bytes]));
          fontsImported++;
        } catch (_) {}
      }
    }
    return { written, skipped, missingDicts, fontsImported };
  }

  // ---------------------------------------------------------------- UI

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function makeOverlay() {
    const ov = document.createElement('div');
    ov.className = 'kai-modal';   // blocks background gestures (project rule)
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9700;background:rgba(0,0,0,.7);display:flex;' +
      'align-items:center;justify-content:center;padding:20px;direction:ltr;';
    const box = document.createElement('div');
    box.style.cssText =
      'background:#161616;border:1px solid #333;border-radius:14px;padding:16px;' +
      'width:100%;max-width:520px;max-height:86vh;display:flex;flex-direction:column;' +
      'gap:10px;box-shadow:0 12px 36px rgba(0,0,0,.6);color:#ddd;' +
      'font:13px/1.5 var(--font-sans,system-ui);';
    ov.appendChild(box);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    return { ov, box };
  }

  function btn(label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'padding:8px 14px;border-radius:8px;border:1px solid #444;background:#222;' +
      'color:#ddd;font:600 12px var(--font-sans,system-ui);cursor:pointer;';
    return b;
  }

  const TEXTAREA_INLINE_LIMIT = 2 * 1024 * 1024; // 2 MB of JSON text

  // iOS/Android Capacitor WKWebView / WebView do not act on `<a download>` +
  // blob URLs the way a desktop browser does — the click silently no-ops.
  // The Web Share API (with a File) opens the real native share sheet
  // (Save to Files, AirDrop, Messages, Mail, Drive, …) instead; it needs no
  // native plugin. Feature-detected — falls back to the anchor-click on web
  // and the Mac shell (getPlatform() === 'web' there), where it does work.
  function useNativeShare() {
    const platform = window.Capacitor?.getPlatform?.() || 'web';
    return (platform === 'ios' || platform === 'android') &&
      typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  }

  async function openExportDialog() {
    const { ov, box } = makeOverlay();
    const nativeShare = useNativeShare();
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:14px;';
    title.textContent = t('pj.st_export_title', 'Export settings');
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11.5px;color:#999;';
    note.textContent = nativeShare
      ? t('pj.st_export_note_share',
          'This file contains your API keys — keep it private. Copy puts it on the clipboard to paste into Import on the other device; Share saves or sends the file (Files, AirDrop, Messages…).')
      : t('pj.st_export_note',
          'This file contains your API keys — keep it private. Copy it, or download and move the file to the new device.');

    // Fonts export is disabled for now: restoring a font on import can make
    // WebKit's FontFace.load() spin indefinitely on some font files (observed
    // as a full app hang on the macOS shell — see fonts.js's register()
    // timeout, added as a guard but not a real fix). Re-enable once that's
    // root-caused.
    let fontList = FONTS_EXPORT_ENABLED
      ? (() => { try { return (window.fonts && window.fonts.list) ? window.fonts.list() : []; } catch (_) { return []; } })()
      : [];
    let includeFonts = fontList.length > 0;
    let fontsLabel = null, fontsCheckbox = null;
    if (fontList.length) {
      fontsLabel = document.createElement('label');
      fontsLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#bbb;';
      fontsCheckbox = document.createElement('input');
      fontsCheckbox.type = 'checkbox';
      fontsCheckbox.checked = true;
      const span = document.createElement('span');
      const totalBytes = await fontBytesTotal(fontList);
      span.textContent = window.i18n?.fmt
        ? window.i18n.fmt('pj.st_include_fonts', { n: fontList.length, size: fmtBytes(totalBytes) }, 'Include {n} font(s) (~{size})')
        : `Include ${fontList.length} font(s) (~${fmtBytes(totalBytes)})`;
      fontsLabel.append(fontsCheckbox, span);
    }

    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;color:#999;';
    const sizeNote = document.createElement('div');
    sizeNote.style.cssText = 'font-size:11.5px;color:#999;display:none;';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.style.cssText =
      'flex:1;min-height:180px;background:#0d0d0d;color:#bbb;border:1px solid #2a2a2a;' +
      'border-radius:8px;padding:8px;font:11px/1.4 monospace;resize:none;';
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    const copyB = btn(t('pj.st_copy', 'Copy'));
    const dlB = btn(nativeShare ? t('pj.st_share', 'Share') : t('pj.st_download', 'Download'));
    const closeB = btn(t('pj.st_close', 'Close'));

    let json = '';
    async function rebuild() {
      status.textContent = t('pj.st_building', 'Building export…');
      ta.style.display = 'none';
      sizeNote.style.display = 'none';
      const bundle = await buildBundle({ includeFonts });
      json = JSON.stringify(bundle, null, 1);
      status.textContent = '';
      if (json.length > TEXTAREA_INLINE_LIMIT) {
        sizeNote.style.display = '';
        sizeNote.textContent = window.i18n?.fmt
          ? window.i18n.fmt('pj.st_bundle_size', { size: fmtBytes(json.length) }, 'Bundle is {size} — use Download / Copy below.')
          : `Bundle is ${fmtBytes(json.length)} — use Download / Copy below.`;
      } else {
        ta.style.display = '';
        ta.value = json;
      }
    }
    if (fontsCheckbox) fontsCheckbox.addEventListener('change', () => { includeFonts = fontsCheckbox.checked; rebuild(); });

    copyB.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(json); ok = true; } catch (_) {}
      if (!ok) { try { ta.value = json; ta.style.display = ''; ta.select(); ok = document.execCommand('copy'); } catch (_) {} }
      copyB.textContent = ok ? t('pj.st_copied', 'Copied') : t('pj.st_copy_failed', 'Copy failed');
      setTimeout(() => { copyB.textContent = t('pj.st_copy', 'Copy'); }, 1600);
    });
    dlB.addEventListener('click', async () => {
      const fname = 'kadoki-settings-' + new Date().toISOString().slice(0, 10) + '.json';
      if (nativeShare) {
        dlB.disabled = true;
        try {
          const file = new File([json], fname, { type: 'application/json' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            dlB.disabled = false;
            return;
          }
        } catch (e) {
          if (e && e.name === 'AbortError') { dlB.disabled = false; return; } // user dismissed the sheet
          // fall through to the anchor-click path below
        }
        dlB.disabled = false;
      }
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {} }, 4000);
      } catch (_) {}
    });
    closeB.addEventListener('click', () => ov.remove());
    rowEl.append(copyB, dlB, closeB);
    box.append(title, note);
    if (fontsLabel) box.append(fontsLabel);
    box.append(status, sizeNote, ta, rowEl);
    rebuild();
  }

  function openImportDialog() {
    const { ov, box } = makeOverlay();
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:14px;';
    title.textContent = t('pj.st_import_title', 'Import settings');
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11.5px;color:#999;';
    note.textContent = t('pj.st_import_note',
      'Paste the exported JSON below, or choose the file. Existing settings with the same names are overwritten; positions, stats and library are never touched.');
    const ta = document.createElement('textarea');
    ta.placeholder = '{ "format": "kadoki-settings", ... }';
    ta.style.cssText =
      'flex:1;min-height:160px;background:#0d0d0d;color:#bbb;border:1px solid #2a2a2a;' +
      'border-radius:8px;padding:8px;font:11px/1.4 monospace;resize:none;';
    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;color:#999;min-height:1.2em;white-space:pre-wrap;';
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';

    const fileB = btn(t('pj.st_choose_file', 'Choose file…'));
    const fileIn = document.createElement('input');
    fileIn.type = 'file';
    fileIn.accept = '.json,application/json';
    fileIn.style.display = 'none';
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      if (f) { try { ta.value = await f.text(); } catch (_) {} }
    });
    // iOS AND the macOS dev shell both expose FileAccess.pickFileWithUri — a
    // native document-picker bridge. Gate on its presence, not platform: a
    // synthetic <input type=file>.click() from inside a JS handler doesn't
    // reliably keep WKWebView's user-gesture trust, so the raw picker opens
    // but never fires `change` there (matches app.js's openFilePicker()).
    fileB.addEventListener('click', async () => {
      const fa = window.Capacitor?.Plugins?.FileAccess;
      if (fa?.pickFileWithUri && fa?.materializeToCache) {
        try {
          const picked = await fa.pickFileWithUri({ type: 'any' });
          if (!picked?.uri) return; // cancelled
          const mat = await fa.materializeToCache({ uri: picked.uri });
          if (!mat?.path) return;
          const url = window.Capacitor?.convertFileSrc
            ? window.Capacitor.convertFileSrc(mat.path)
            : ('file://' + mat.path);
          // Bare fetch can come back empty on the native asset handlers
          // unless it's a Range request (same fix as local-audio.js / the
          // font-import path above).
          const resp = await fetch(url, { headers: { Range: 'bytes=0-' } });
          ta.value = await resp.text();
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (!msg.toLowerCase().includes('cancel')) {
            status.style.color = '#c66';
            status.textContent = msg;
          }
        }
        return;
      }
      fileIn.click();
    });

    const importB = btn(t('pj.st_import', 'Import'));
    importB.addEventListener('click', async () => {
      importB.disabled = true;
      // A multi-MB bundle (fonts) blocks paint during JSON.parse — show a
      // status line before it, deferred one tick so it actually paints.
      if (ta.value.length > TEXTAREA_INLINE_LIMIT) {
        status.style.color = '#999';
        status.textContent = t('pj.st_importing', 'Importing…');
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        const res = await importBundle(ta.value);
        let msg = res.fontsImported
          ? (window.i18n?.fmt
              ? window.i18n.fmt('pj.st_done_fonts', { n: res.written, m: res.fontsImported }, 'Imported {n} settings, {m} fonts.')
              : ('Imported ' + res.written + ' settings, ' + res.fontsImported + ' fonts.'))
          : (window.i18n?.fmt
              ? window.i18n.fmt('pj.st_done', { n: res.written }, 'Imported {n} settings.')
              : ('Imported ' + res.written + ' settings.'));
        if (res.missingDicts.length) {
          msg += '\n' + t('pj.st_dicts', 'Dictionaries to re-import:') + ' ' + res.missingDicts.join(', ');
        }
        msg += '\n' + t('pj.st_reload_note', 'The app will reload to apply everything.');
        status.style.color = '#9c8';
        status.textContent = msg;
        importB.textContent = t('pj.st_reload', 'Reload now');
        importB.disabled = false;
        importB.onclick = () => { try { location.reload(); } catch (_) {} };
      } catch (e) {
        status.style.color = '#c66';
        status.textContent = String((e && e.message) || e);
        importB.disabled = false;
      }
    });
    const closeB = btn(t('pj.st_close', 'Close'));
    closeB.addEventListener('click', () => ov.remove());
    rowEl.append(fileB, importB, closeB);
    box.append(title, note, ta, status, rowEl, fileIn);
  }

  function wire() {
    const ex = document.getElementById('prefsExportSettings');
    const im = document.getElementById('prefsImportSettings');
    if (ex) ex.addEventListener('click', () => { openExportDialog().catch(() => {}); });
    if (im) im.addEventListener('click', openImportDialog);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.settingsTransfer = { buildBundle, importBundle };
})();
