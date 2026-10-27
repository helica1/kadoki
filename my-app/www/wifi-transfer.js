// wifi-transfer.js — Wi-Fi Transfer: send files to the phone from a browser
// on the same network.
//
// Native (WifiTransfer plugin) runs a small HTTP server serving
// wifi-transfer-page.html; each upload lands in the app's WifiInbox folder and
// arrives here as a 'received' event {name, path, size}. A few seconds after
// the last file, the batch is imported:
//   epub / txt / audio / video / srt → the folder importer (same pairing by
//     name, dedupe and review sheet), attached by local path — no copy;
//   .zip → a ッツ backup (it holds bookdata_ files) or a Yomitan dictionary.
// The server runs only while the panel is open.
(function () {
  'use strict';
  const WT = () => window.Capacitor?.Plugins?.WifiTransfer;
  const T = (k, d) => { try { return window.i18n.t(k, d); } catch (_) { return d; } };
  const fmt = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
  const extOf = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };

  let ov = null, listener = null, pending = [], timer = 0, busy = false;

  window.wifiTransferAvailable = () => !!WT();

  function el(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }

  async function open() {
    if (!WT() || ov) return;
    ov = el('div', 'position:fixed;inset:0;z-index:9550;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;');
    ov.className = 'kai-modal';
    ov.id = 'wifiTransferPanel';
    const card = el('div', 'background:#211f26;color:#e6e0e9;border-radius:28px;width:min(460px,94vw);max-height:86vh;overflow:auto;padding:24px;box-sizing:border-box;font-family:system-ui,-apple-system,Roboto,sans-serif;');
    card.appendChild(el('div', 'font-size:22px;font-weight:500;margin-bottom:6px;', T('wt.title', 'Wi-Fi Transfer')));
    const status = el('div', 'font-size:14px;color:#cac4d0;line-height:1.5;', T('wt.starting', 'Starting…'));
    const url = el('div', 'margin:18px 0 6px;padding:14px 16px;border-radius:16px;background:#2b2930;font:600 20px/1.3 ui-monospace,Menlo,monospace;text-align:center;word-break:break-all;-webkit-user-select:text;user-select:text;');
    url.style.display = 'none';
    const list = el('div', 'margin-top:14px;font-size:14px;');
    const actions = el('div', 'display:flex;justify-content:flex-end;margin-top:20px;');
    const done = el('button', 'background:#d0bcff;color:#381e72;border:0;border-radius:20px;padding:10px 24px;font:500 14px system-ui,Roboto,sans-serif;', T('wt.done', 'Done'));
    done.onclick = close;
    actions.appendChild(done);
    card.append(status, url, list, actions);
    ov.appendChild(card);
    document.body.appendChild(ov);
    // The screen stays on while the panel is open (a sleeping phone drops the server).
    try { window.Capacitor?.Plugins?.BackgroundAudio?.setKeepAwake?.({ on: true })?.catch?.(() => {}); } catch (_) {}
    try {
      listener = await WT().addListener('received', (f) => onFile(f, list));
      const r = await WT().start({ port: 8080 });
      if (r && r.url) {
        url.textContent = r.url.replace(/\/$/, '');
        url.style.display = '';
        status.textContent = T('wt.instructions', 'On a computer on the same Wi-Fi, open this address in a browser and drop your files. Keep this screen open while they transfer.');
      } else {
        status.textContent = T('wt.no_wifi', 'No Wi-Fi network found. Connect the phone to Wi-Fi and try again.');
      }
    } catch (e) {
      status.textContent = T('wt.failed', 'Could not start the transfer server') + ': ' + (e?.message || e);
    }
  }

  async function close() {
    try { await WT()?.stop(); } catch (_) {}
    try { listener?.remove?.(); } catch (_) {}
    listener = null;
    try { window.Capacitor?.Plugins?.BackgroundAudio?.setKeepAwake?.({ on: false })?.catch?.(() => {}); window.keepAwake?.refresh?.(); } catch (_) {}
    try { ov?.remove(); } catch (_) {}
    ov = null;
    if (pending.length) { clearTimeout(timer); importBatch(); }
  }

  function onFile(f, list) {
    if (!f || !f.path) return;
    pending.push(f);
    const row = el('div', 'display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #49454f;');
    row.append(el('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', f.name), el('span', 'color:#7bd88f;flex:0 0 auto;', fmt(f.size || 0)));
    list.appendChild(row);
    clearTimeout(timer);
    // Import once the browser has gone quiet (it sends files one by one).
    timer = setTimeout(importBatch, 4000);
  }

  async function importBatch() {
    if (busy || !pending.length) return;
    busy = true;
    const batch = pending.splice(0);
    try {
      const zips = batch.filter(f => extOf(f.name) === 'zip');
      const media = batch.filter(f => extOf(f.name) !== 'zip');
      if (media.length) {
        // The importer's own progress / review sheets sit above this panel.
        await window.importFolder?.({
          rootName: 'Wi-Fi',
          noFolderNames: true,
          files: media.map(f => ({ name: f.name, dir: '', relPath: f.name, ext: extOf(f.name), cachePath: f.path })),
        });
      }
      for (const z of zips) await importZip(z);
    } catch (e) {
      try { window.showToast?.(T('wt.import_failed', 'Import failed') + ': ' + (e?.message || e), 4000); } catch (_) {}
    } finally {
      busy = false;
      if (pending.length) importBatch();
    }
  }

  async function importZip(f) {
    const res = await fetch(window.Capacitor.convertFileSrc(f.path));
    const blob = await res.blob();
    let isTtu = false;
    try {
      const z = await JSZip.loadAsync(blob);
      isTtu = Object.keys(z.files).some(n => /\/bookdata_[^/]*\.zip$/.test(n));
    } catch (_) {}
    if (isTtu && window.ttuImport) {
      const r = await window.ttuImport.importBackup(blob);
      try { window.__kadokiLibRefreshNative?.(); window.populateLibrary?.(); } catch (_) {}
      try { window.showToast?.('ッツ: ' + r.added.length + ' ' + T('ttu.added', 'Books added'), 3500); } catch (_) {}
      return;
    }
    if (typeof window.importYomitanDictionaryFromBuffer === 'function') {
      try { window.showToast?.(T('wt.dict', 'Importing dictionary') + ': ' + f.name, 4000); } catch (_) {}
      const name = await window.importYomitanDictionaryFromBuffer(await blob.arrayBuffer(), { fallbackName: f.name });
      try { window.showToast?.(T('wt.dict_done', 'Dictionary imported') + ': ' + name, 3000); } catch (_) {}
    }
  }

  window.wifiTransfer = { open, close };
})();
