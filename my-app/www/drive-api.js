// drive-api.js — Thin Google Drive v3 REST client over fetch + bearer token.
//
// Scoped to `drive.file`, so every query/list only ever sees files this app
// created (our own per-title sync folders) — there is no access to the user's
// other Drive content. All request bodies are kept as STRINGS (JSON text, or
// base64 for binary via Content-Transfer-Encoding) so the same calls work
// through the native CapacitorHttp fallback if a WebView fetch is blocked.
//
// Surface:
//   ensureFolder(name, parentId?)         -> folderId   (find-or-create)
//   listFiles(folderId)                   -> [{id,name,size,mimeType}]
//   listFolders()                         -> [{id,name}]  (app-created folders)
//   findInFolder(folderId, name)          -> {id,...}|null
//   getText(fileId)                       -> string
//   downloadRange(fileId, start, length)  -> base64        (ranged media GET)
//   getSize(fileId)                       -> number
//   upsertText(folderId, name, mime, str) -> fileId        (small JSON/text)
//   upsertBytes(folderId, name, mime, b64)-> fileId        (small binary, e.g. PNG)
//   deleteFile(fileId)                    -> void
//   createResumable(folderId,name,mime,size) -> uploadUrl  (large media; P3)
//   putChunk(uploadUrl, b64, offset, total)  -> {done, fileId?}
//
// Auth comes from window.gdriveAuth.getAccessToken().

(function () {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  async function token() {
    if (!window.gdriveAuth) throw new Error('gdriveAuth unavailable');
    return await window.gdriveAuth.getAccessToken();
  }

  function nativeHttp() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  }

  // Core request. `expect`: 'json' (default), 'text', or 'arraybuffer'.
  // Tries WebView fetch first; on a network/CORS-style failure (NOT an HTTP
  // error with a body) falls back to native CapacitorHttp for json/text.
  async function req(method, url, opts) {
    opts = opts || {};
    const expect = opts.expect || 'json';
    const tok = await token();
    const headers = Object.assign({ Authorization: 'Bearer ' + tok }, opts.headers || {});

    let res, networkErr = null;
    try {
      // `no-store`: never serve a cached body. Without this the WebView returned
      // a STALE manifest after the other device updated the same file URL — the
      // "first download stale, second works" bug. (No request header → no CORS
      // preflight impact.)
      res = await fetch(url, { method, headers, body: opts.body, cache: 'no-store' });
    } catch (e) { networkErr = e; }

    if (res) {
      if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); const j = JSON.parse(t); detail = (j.error && (j.error.message || j.error)) || t; }
        catch (_) {}
        // A 403 "insufficient authentication scopes" means the connected token can sign
        // in but was NOT granted the Drive scope (user deselected it on the consent
        // screen). It's unusable for sync, so clear it and prompt a clean reconnect —
        // the connect-time scope check then makes sure Drive is actually granted.
        if (res.status === 403 && /insufficient\s+authentication\s+scopes|insufficient.*scope|scope.*insufficient/i.test(detail)) {
          try { await window.gdriveAuth?.disconnect?.(); } catch (_) {}
          try { window.dispatchEvent(new CustomEvent('kai:gdrive-disconnected')); } catch (_) {}
          const e2 = new Error('Google Drive permission missing — reconnect and allow Drive access.');
          e2._status = 403;
          throw e2;
        }
        const err = new Error('Drive ' + res.status + (detail ? ': ' + detail : ''));
        err._status = res.status;
        throw err;
      }
      if (expect === 'text') return await res.text();
      if (expect === 'arraybuffer') return await res.arrayBuffer();
      const t = await res.text();
      return t ? JSON.parse(t) : {};
    }

    // WebView fetch failed at the network layer — try native (json/text only).
    const http = nativeHttp();
    if (!http) throw networkErr || new Error('Drive network error');
    const resp = await http.request({
      url, method, headers,
      data: opts.body && typeof opts.body === 'string' ? opts.body : undefined,
      responseType: expect === 'arraybuffer' ? 'arraybuffer' : 'text',
    });
    if (resp.status < 200 || resp.status >= 300) {
      const err = new Error('Drive ' + resp.status);
      err._status = resp.status;
      throw err;
    }
    if (expect === 'text') return typeof resp.data === 'string' ? resp.data : String(resp.data);
    if (expect === 'arraybuffer') return resp.data;   // native returns base64 string for arraybuffer
    return (typeof resp.data === 'string') ? (resp.data ? JSON.parse(resp.data) : {}) : resp.data;
  }

  function q(s) { return "'" + String(s).replace(/'/g, "\\'") + "'"; }

  async function listFolders() {
    const url = API + '/files?q=' +
      encodeURIComponent('mimeType=' + q(FOLDER_MIME) + ' and trashed=false') +
      '&fields=' + encodeURIComponent('files(id,name)') + '&pageSize=1000';
    const r = await req('GET', url);
    return (r && r.files) || [];
  }

  async function findFolder(name, parentId) {
    let qstr = 'mimeType=' + q(FOLDER_MIME) + ' and name=' + q(name) + ' and trashed=false';
    if (parentId) qstr += ' and ' + q(parentId) + ' in parents';
    const url = API + '/files?q=' + encodeURIComponent(qstr) + '&fields=' + encodeURIComponent('files(id,name)');
    const r = await req('GET', url);
    return (r && r.files && r.files[0]) || null;
  }

  async function ensureFolder(name, parentId) {
    const existing = await findFolder(name, parentId);
    if (existing) return existing.id;
    const meta = { name, mimeType: FOLDER_MIME };
    if (parentId) meta.parents = [parentId];
    const r = await req('POST', API + '/files?fields=id', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
    return r.id;
  }

  async function listFiles(folderId) {
    const url = API + '/files?q=' +
      encodeURIComponent(q(folderId) + ' in parents and trashed=false') +
      '&fields=' + encodeURIComponent('files(id,name,size,mimeType)') + '&pageSize=1000';
    const r = await req('GET', url);
    return (r && r.files) || [];
  }

  async function findInFolder(folderId, name) {
    const url = API + '/files?q=' +
      encodeURIComponent(q(folderId) + ' in parents and name=' + q(name) + ' and trashed=false') +
      '&fields=' + encodeURIComponent('files(id,name,size,mimeType)');
    const r = await req('GET', url);
    return (r && r.files && r.files[0]) || null;
  }

  async function getText(fileId) {
    return await req('GET', API + '/files/' + fileId + '?alt=media', { expect: 'text' });
  }

  async function getSize(fileId) {
    const r = await req('GET', API + '/files/' + fileId + '?fields=size');
    return parseInt(r.size, 10) || 0;
  }

  // Ranged binary read → base64 (for assembling large media chunk-by-chunk).
  async function downloadRange(fileId, start, length) {
    const end = start + length - 1;
    const buf = await req('GET', API + '/files/' + fileId + '?alt=media', {
      expect: 'arraybuffer',
      headers: { Range: 'bytes=' + start + '-' + end },
    });
    if (typeof buf === 'string') return buf;            // native path already base64
    const bytes = new Uint8Array(buf);
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  // Multipart create (one request). `isB64` sends the media part as base64.
  async function createMultipart(folderId, name, mime, content, isB64) {
    const boundary = 'kadoki' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [folderId] });
    const body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mime + '\r\n' +
      (isB64 ? 'Content-Transfer-Encoding: base64\r\n' : '') + '\r\n' +
      content + '\r\n' +
      '--' + boundary + '--';
    const r = await req('POST', UPLOAD + '?uploadType=multipart&fields=id', {
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    });
    return r.id;
  }

  async function updateMedia(fileId, mime, content, isB64) {
    await req('PATCH', UPLOAD + '/' + fileId + '?uploadType=media', {
      headers: Object.assign({ 'Content-Type': mime }, isB64 ? { 'Content-Transfer-Encoding': 'base64' } : {}),
      body: content,
    });
    return fileId;
  }

  // Find-or-update by name within the folder (idempotent push).
  async function upsert(folderId, name, mime, content, isB64) {
    const existing = await findInFolder(folderId, name);
    if (existing) return await updateMedia(existing.id, mime, content, isB64);
    return await createMultipart(folderId, name, mime, content, isB64);
  }
  function upsertText(folderId, name, mime, str) { return upsert(folderId, name, mime || 'application/json', str, false); }
  function upsertBytes(folderId, name, mime, b64) { return upsert(folderId, name, mime || 'application/octet-stream', b64, true); }

  async function deleteFile(fileId) {
    await req('DELETE', API + '/files/' + fileId, { expect: 'text' });
  }

  // Resumable upload (large media). Returns the session upload URL.
  async function createResumable(folderId, name, mime, size) {
    const tok = await token();
    const res = await fetch(UPLOAD + '?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tok,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!res.ok) throw new Error('Drive resumable init ' + res.status);
    const url = res.headers.get('Location');
    if (!url) throw new Error('No resumable session URL');
    return url;
  }

  // Upload one chunk of a resumable session. `b64` is base64 of the bytes at
  // [offset, offset+len). Returns { done, fileId? }.
  async function putChunk(uploadUrl, b64, offset, total) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const end = offset + bytes.length - 1;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + total },
      body: bytes,
    });
    if (res.status === 200 || res.status === 201) {
      let id = null; try { id = (await res.json()).id; } catch (_) {}
      return { done: true, fileId: id };
    }
    if (res.status === 308) return { done: false };   // resume incomplete — expected mid-upload
    throw new Error('Drive chunk upload ' + res.status);
  }

  window.driveApi = {
    ensureFolder, findFolder, listFolders, listFiles, findInFolder,
    getText, getSize, downloadRange,
    upsertText, upsertBytes, deleteFile,
    createMultipart, updateMedia,   // low-level: caller already knows existence (incremental sync)
    createResumable, putChunk,
  };
})();
