// icloud.js — window.kCloud: the iCloud Drive library store (iPhone / iPad /
// Vision Pro via the KadokiCloud Capacitor plugin, Mac via the shim's
// kadokiCloud handler — one {op, ...} contract, see KadokiCloud.swift).
//
// Paths are relative to iCloud Drive › Kadoki ("Library/<syncId>/title.json").
// Files that aren't on this device are still listed (status "notDownloaded");
// readText/readJSON download them first. Android has no iCloud: kCloud.supported
// is false there and every call rejects.
(function () {
  'use strict';
  const plugin = () => window.Capacitor?.Plugins?.KadokiCloud || null;
  const supported = () => !!plugin() && typeof plugin().op === 'function';

  function call(op, args) {
    const p = plugin();
    if (!p) return Promise.reject(new Error('iCloud is not available on this device'));
    return p.op(Object.assign({ op }, args || {}));
  }

  let statusP = null;
  const kCloud = {
    get supported() { return supported(); },
    call,
    /** {available, root} — cached after the first success. */
    status(force) {
      if (!supported()) return Promise.resolve({ available: false, error: 'unsupported' });
      if (!statusP || force) {
        statusP = call('status').catch((e) => ({ available: false, error: String(e?.message || e) }));
        statusP.then((s) => { if (!s.available) statusP = null; });
      }
      return statusP;
    },
    list: (path, recursive) => call('list', { path: path || '', recursive: !!recursive }).then((r) => r.entries || []),
    stat: (path) => call('stat', { path }),
    localPath: (path) => call('localPath', { path }),
    readText: (path, waitMs) => call('readText', { path, waitMs }).then((r) => r.text),
    writeText: (path, text) => call('writeText', { path, text: String(text) }),
    async readJSON(path, waitMs) {
      try { return JSON.parse(await kCloud.readText(path, waitMs)); }
      catch (e) { if (/not found|No such file|couldn.t be opened/i.test(String(e?.message || e))) return null; throw e; }
    },
    writeJSON: (path, obj) => call('writeText', { path, text: JSON.stringify(obj) }),
    mkdir: (path) => call('mkdir', { path }),
    /** Start downloading a file or folder; {wait:true} resolves when it's all local. */
    download: (path, opts) => call('download', Object.assign({ path }, opts || {})),
    /** "Remove download": keeps it in iCloud, frees this device's copy. */
    evict: (path) => call('evict', { path }),
    /** Move (opts.move) or copy a local file (absolute path or file:// URL) into the library. */
    importFile: (src, dest, opts) => call('importFile', Object.assign({ src, dest }, opts || {})),
    move: (from, to) => call('move', { from, to }),
    remove: (path) => call('remove', { path }),
    /** Live change feed: cb({initial, changed:[{path,status,percent,uploaded}], removed}). */
    onChange(cb) { return kCloud._on('change', cb); },
    onAccount(cb) { return kCloud._on('account', cb); },
    _watching: false,
    _on(name, cb) {
      const p = plugin();
      if (!p || typeof p.addListener !== 'function') return { remove() {} };
      const h = p.addListener(name, cb);
      if (!kCloud._watching) { kCloud._watching = true; call('watch', { on: true }).catch(() => { kCloud._watching = false; }); }
      return { remove() { try { (h && h.remove) ? h.remove() : h?.then?.((x) => x.remove()); } catch (_) {} } };
    },
  };
  window.kCloud = kCloud;
})();
