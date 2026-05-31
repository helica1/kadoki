// audio-archive.js — drives the iOS-side audio archive import.
//
// User flow:
//   1. Mac: `xz -d local-yomichan.tar.xz` → local-yomichan.tar (~4 GB).
//   2. Drop the .tar into our app's Documents via Finder Files Sharing.
//   3. Preferences → Audio archive → Import .tar
//      → opens our file picker → user picks the .tar
//      → ArchiveExtractor plugin streams it into Documents/yomichan-audio/
//      → progress events animate the bar
//      → on success, set pref + delete the .tar so Documents reclaims 4 GB.

(function () {
  'use strict';

  const PREF_DEST_DIR = 'YOMICHAN_AUDIO_DIR';

  async function getPref(k) {
    if (window.Capacitor?.Plugins?.Preferences) {
      const r = await window.Capacitor.Plugins.Preferences.get({ key: k });
      return r.value;
    }
    return localStorage.getItem(k);
  }
  async function setPref(k, v) {
    if (window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key: k, value: String(v) });
    } else {
      localStorage.setItem(k, String(v));
    }
  }

  async function refreshStatus() {
    const status = document.getElementById('prefsAudioArchiveStatus');
    if (!status) return;
    const dir = await getPref(PREF_DEST_DIR);
    if (dir) {
      status.innerHTML = `Linked: <span style="color:var(--accent-cyan,#00ffcc);">${dir}</span>`;
    } else {
      status.textContent = 'No archive imported yet.';
    }
  }

  function setProgress(pct, label) {
    const wrap = document.getElementById('prefsAudioArchiveProgress');
    const fill = document.getElementById('prefsAudioArchiveProgressFill');
    const pctEl = document.getElementById('prefsAudioArchiveProgressPct');
    const lbl  = document.getElementById('prefsAudioArchiveProgressLabel');
    if (!wrap || !fill || !pctEl || !lbl) return;
    wrap.style.display = '';
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    pctEl.textContent = pct.toFixed(0) + '%';
    if (label) lbl.textContent = label;
  }
  function hideProgress() {
    const wrap = document.getElementById('prefsAudioArchiveProgress');
    if (wrap) wrap.style.display = 'none';
  }

  // The .tar lives in our app's Documents folder (that's where Finder
  // Files Sharing drops it). We don't need to materialize-to-cache a 4 GB
  // file — that was synchronously copying it via the bridge queue and
  // hanging the whole app for minutes. Instead: pick directly from
  // Documents, use the absolute path as-is.
  async function pickTarFromDocuments() {
    // Filesystem plugin (Capacitor core) can list our Documents folder.
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (!fs) return null;
    try {
      const r = await fs.readdir({ path: '', directory: 'DOCUMENTS' });
      const tars = (r.files || []).filter(f => {
        const name = (typeof f === 'string' ? f : f.name) || '';
        return /\.tar$/i.test(name);
      });
      if (!tars.length) return null;
      // If exactly one, use it. Otherwise prompt the user to pick.
      if (tars.length === 1) {
        const name = typeof tars[0] === 'string' ? tars[0] : tars[0].name;
        const stat = await fs.stat({ path: name, directory: 'DOCUMENTS' });
        return { name, path: stat.uri.replace(/^file:\/\//, '') };
      }
      const labels = tars.map(t => typeof t === 'string' ? t : t.name);
      const choice = prompt(
        'Multiple .tar files found in Documents. Type the exact name to import:\n\n' +
          labels.map((l, i) => `${i + 1}. ${l}`).join('\n')
      );
      if (!choice) return null;
      const name = labels.find(l => l === choice || l === choice.trim()) ||
                   labels[parseInt(choice, 10) - 1];
      if (!name) return null;
      const stat = await fs.stat({ path: name, directory: 'DOCUMENTS' });
      return { name, path: stat.uri.replace(/^file:\/\//, '') };
    } catch (e) {
      console.warn('[audio-archive] readdir failed:', e);
      return null;
    }
  }

  async function importArchive() {
    const btn = document.getElementById('prefsAudioArchiveImport');
    const ax  = window.Capacitor?.Plugins?.ArchiveExtractor;
    const fa  = window.Capacitor?.Plugins?.FileAccess;
    if (!ax) { alert('ArchiveExtractor plugin not available on this build.'); return; }
    if (btn) btn.disabled = true;
    let listener = null;
    try {
      // Step 1: see if the .tar is already in our Documents (fast path —
      // user dragged it via Finder Files Sharing). If yes, no picker needed.
      setProgress(0, 'Looking for .tar in Documents…');
      const found = await pickTarFromDocuments();

      let extractArgs;
      let displayName;
      if (found) {
        extractArgs = {
          srcPath:            found.path,
          destSubdir:         'yomichan-audio',
          deleteSrcOnSuccess: true
        };
        displayName = found.name;
      } else if (fa) {
        // Step 2: open the system file picker so the user can navigate
        // to wherever the .tar actually lives (iCloud Drive, another
        // app's documents, etc.). The native extractor reads the file
        // directly through the security-scoped bookmark — no 4 GB
        // copy-to-cache step (which used to hang the whole app).
        setProgress(0, 'Opening file picker…');
        const picked = await fa.pickFileWithUri({ type: 'any' });
        if (!picked?.uri) {
          hideProgress();
          if (btn) btn.disabled = false;
          return;
        }
        extractArgs = {
          srcUri:             picked.uri,
          destSubdir:         'yomichan-audio',
          // Don't delete files we don't own — only safe to remove if we
          // wrote them ourselves (i.e., the in-Documents path).
          deleteSrcOnSuccess: false
        };
        displayName = picked.name || 'archive';
      } else {
        alert('FileAccess plugin not available — cannot pick a .tar.');
        hideProgress();
        if (btn) btn.disabled = false;
        return;
      }

      setProgress(0, `Starting extraction of ${displayName}…`);
      listener = await ax.addListener('progress', (d) => {
        const pct = Math.round((d.pct || 0) * 100);
        setProgress(pct, `Extracting ${displayName}… ${d.fileCount || 0} files`);
      });

      const result = await ax.extractTar(extractArgs);
      setProgress(100, `Done — ${result.fileCount} files`);
      await setPref(PREF_DEST_DIR, result.destDir);
      // Clear local-audio.js caches so the just-imported archive is
      // picked up immediately without an app restart.
      try { window.invalidateLocalAudio?.(); } catch (e) {}
      refreshStatus();
      setTimeout(hideProgress, 1500);
    } catch (e) {
      hideProgress();
      alert('Archive import failed: ' + (e?.message || e));
    } finally {
      try { listener?.remove?.(); } catch (e) {}
      if (btn) btn.disabled = false;
    }
  }

  // ---- diagnostic walker ----
  // Runs each phase of the audio-lookup chain in isolation and reports
  // the FIRST step that fails. Surface the result as a multi-line alert
  // since the user is operating without console access.
  async function diagnoseAudio() {
    console.log('[audio-diag] STARTED');
    const lines = ['Diagnose: starting…'];
    function add(s) { lines.push(s); console.log('[audio-diag]', s); }
    // Show an immediate visual confirmation — WKWebView's alert() always
    // works synchronously, so if the user doesn't see this, the click
    // handler itself isn't firing.
    try { alert(lines[0]); } catch (e) { console.warn('[audio-diag] alert failed:', e); }
    try {
      // Phase 1: YOMICHAN_AUDIO_DIR pref
      const fs = window.Capacitor?.Plugins?.Filesystem;
      const prefs = window.Capacitor?.Plugins?.Preferences;
      const prefVal = prefs ? (await prefs.get({ key: 'YOMICHAN_AUDIO_DIR' }))?.value : null;
      add('1) YOMICHAN_AUDIO_DIR pref: ' + (prefVal || '(not set)'));

      // Phase 2: list top-level files in Documents/yomichan-audio
      // AND walk one level into user_files/ to enumerate the sources.
      if (fs?.readdir) {
        try {
          const r = await fs.readdir({ path: 'yomichan-audio', directory: 'DOCUMENTS' });
          const top = (r.files || []).map(f => typeof f === 'string' ? f : f.name);
          add('2) Documents/yomichan-audio contains: ' + top.join(', '));
          // If the archive nests under user_files/, list THAT too.
          if (top.includes('user_files')) {
            try {
              const r2 = await fs.readdir({ path: 'yomichan-audio/user_files', directory: 'DOCUMENTS' });
              const subs = (r2.files || []).map(f => typeof f === 'string' ? f : f.name);
              add('2a) yomichan-audio/user_files/: ' + subs.join(', '));
            } catch (e) {
              add('2a) user_files/ readdir FAIL: ' + (e?.message || e));
            }
          }
        } catch (e) {
          add('2) Documents/yomichan-audio readdir FAIL: ' + (e?.message || e));
        }
      } else add('2) Filesystem.readdir unavailable');

      // Phase 3: list jpod_files
      if (fs?.readdir) {
        const tries = ['yomichan-audio/jpod_files', 'yomichan-audio/user_files/jpod_files'];
        let foundJpod = null;
        for (const p of tries) {
          try {
            const r = await fs.readdir({ path: p, directory: 'DOCUMENTS' });
            const names = (r.files || []).map(f => typeof f === 'string' ? f : f.name);
            add(`3) ${p}: ${names.slice(0, 8).join(', ')}`);
            foundJpod = p;
            break;
          } catch (e) {
            add(`3) ${p}: not found (${e?.message || e})`);
          }
        }
        // Phase 4: list media/ subdir to confirm flat layout + sample file
        if (foundJpod) {
          const mediaPath = `${foundJpod}/media`;
          try {
            const files = await fs.readdir({ path: mediaPath, directory: 'DOCUMENTS' });
            const fileNames = (files.files || []).map(f => typeof f === 'string' ? f : f.name);
            add(`4) ${mediaPath}: ${fileNames.length} files, sample: ${fileNames[0] || '(empty)'}`);
          } catch (e) {
            add(`4) ${mediaPath} FAIL: ${e?.message || e}`);
          }
        }
      }

      // Phase 5: invoke lookup with a known-common term ("人")
      if (typeof window.lookupLocalAudio === 'function') {
        try {
          const refs = await Promise.race([
            window.lookupLocalAudio('人', 'ひと'),
            new Promise(r => setTimeout(() => r('TIMEOUT'), 5000))
          ]);
          if (refs === 'TIMEOUT') add('5) lookupLocalAudio TIMED OUT after 5s');
          else add('5) lookupLocalAudio for 人/ひと: ' + (refs?.length || 0) + ' refs');
        } catch (e) {
          add('5) lookupLocalAudio THREW: ' + (e?.message || e));
        }
      } else add('5) window.lookupLocalAudio not defined');

      // Phase 6: bypass local-audio.js entirely and inspect the index JSON
      // directly. Tells us (a) whether the file is fetchable via
      // convertFileSrc, (b) what shape the JSON actually has, (c) whether
      // '人'/'ひと' really are keys.
      // Resolve via Filesystem.getUri (CURRENT container) — the stored
      // pref may carry a stale UUID from a prior install.
      let liveBase = null;
      try {
        if (fs?.getUri) {
          const liveUri = await fs.getUri({ directory: 'DOCUMENTS', path: 'yomichan-audio' });
          liveBase = liveUri?.uri?.replace(/^file:\/\//, '');
        }
      } catch (_) {}
      add('6) live base via getUri: ' + (liveBase || '(none)'));
      const indexPath = (liveBase || prefVal || '') + '/user_files/jpod_files/index.json';
      const cap = window.Capacitor;
      const indexUrl = (cap?.convertFileSrc && prefVal)
        ? cap.convertFileSrc(indexPath)
        : indexPath;
      add('6) probing index.json at: ' + indexUrl);
      try {
        const res = await fetch(indexUrl);
        add('6) fetch status: ' + res.status + ' ' + res.statusText);
        if (res.ok) {
          const text = await res.text();
          add('6) bytes received: ' + text.length);
          try {
            const json = JSON.parse(text);
            const topKeys = Object.keys(json || {}).slice(0, 10);
            add('6) top-level keys: ' + topKeys.join(', '));
            const hw = json?.headwords;
            if (hw && typeof hw === 'object') {
              const hwKeyCount = Object.keys(hw).length;
              const hwSample = Object.keys(hw).slice(0, 8);
              add('7) headwords count: ' + hwKeyCount + ', sample: ' + hwSample.join(', '));
              const has人 = !!hw['人'];
              const hasひと = !!hw['ひと'];
              add('7) headwords["人"]: ' + (has人 ? JSON.stringify(hw['人']).slice(0, 120) : 'MISSING'));
              add('7) headwords["ひと"]: ' + (hasひと ? JSON.stringify(hw['ひと']).slice(0, 120) : 'MISSING'));
            } else {
              add('7) NO `headwords` key — JSON shape is unexpected');
            }
          } catch (jsonErr) {
            add('6) JSON.parse failed: ' + (jsonErr?.message || jsonErr));
            add('6) first 200 bytes: ' + text.slice(0, 200));
          }
        }
      } catch (fetchErr) {
        add('6) fetch THREW: ' + (fetchErr?.message || fetchErr));
      }
    } catch (e) {
      add('FATAL: ' + (e?.message || e));
    }
    try { alert(lines.join('\n\n')); } catch (e) { console.warn('[audio-diag] final alert failed:', e); }
  }
  window.diagnoseAudio = diagnoseAudio;
  console.log('[audio-diag] window.diagnoseAudio ready — call it from console if the button is dead');

  function init() {
    const btn = document.getElementById('prefsAudioArchiveImport');
    if (!btn) return;
    // Import button — dedupe so we don't pile multiple click handlers.
    if (btn.dataset.wired !== '1') {
      btn.dataset.wired = '1';
      btn.addEventListener('click', importArchive);
      refreshStatus();
    }
    // Diagnose button removed from the UI per user request. The
    // diagnoseAudio() function stays on window so it's still callable
    // from Safari Web Inspector for future regression testing.
    const existing = btn.parentElement?.querySelector('[data-role="audio-diagnose"]');
    if (existing) existing.remove();
  }

  // The Preferences UI is built lazily on first open; wait for it.
  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('#prefsModal, .prefs-section')) {
      // Re-attempt wire each time prefs are interacted with — covers the
      // first-render-after-DOMContentLoaded case.
      init();
    }
  });

  // Programmatic access for callers (e.g. the eventual setup wizard).
  window.importAudioArchive = importArchive;
})();
