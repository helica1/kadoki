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

  function init() {
    const btn = document.getElementById('prefsAudioArchiveImport');
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', importArchive);
    refreshStatus();
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
