// youtube-collection.js — window.ytCollection: YouTube Collections.
//
// A Collection is ONE audiobook Title made from many YouTube videos (a list of
// links and/or playlists), joined end to end into a single M4A so it plays
// seamlessly — and so every existing feature (cards, read mode, AI, positions,
// iCloud) treats it as an ordinary audiobook.
//
//   title.collection = { v:1, subs:'youtube'|'transcribe',
//                        parts:[{id, title, url, startMs, durMs}] }
//   blobStore YTCOLL_THUMBS_V1_<titleId> = { videoId: dataUri }  (per-part art)
//
// Creating and growing Collections needs yt-dlp → Mac only, and only in builds
// that bundle it (window.KADOKI_YT; never the App Store builds). PLAYING one
// works everywhere: the parts list and thumbnails come through iCloud, and the
// audio-mode picture follows the part that's playing (coverAt).
//
// Growing a Collection only ever appends at the END, so every saved position
// (a time in the file) stays exactly where it was.
(function () {
  'use strict';
  const THUMBS = 'YTCOLL_THUMBS_V1_';
  const log = (m) => { try { window.debugLog ? window.debugLog('[ytColl] ' + m) : console.log('[ytColl] ' + m); } catch (_) {} };
  const T = (k, d) => { try { return window.i18n ? window.i18n.t(k, d) : d; } catch (_) { return d; } };
  const canBuild = () => !!(window.KADOKI_YT && window.webkit?.messageHandlers?.kadokiYouTube);
  const yt = (op, args) => new Promise((resolve, reject) => {
    window.webkit.messageHandlers.kadokiYouTube.postMessage(JSON.stringify(Object.assign({ op }, args || {})))
      .then(resolve, (e) => reject(new Error(String(e && e.message || e))));
  });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const safeName = (n) => String(n || 'Collection').replace(/[\/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'Collection';

  // ---- subtitles: YouTube json3 → cues -----------------------------------------
  function json3ToCues(text, offsetMs, durMs) {
    let j;
    try { j = JSON.parse(text); } catch (_) { return []; }
    const out = [];
    for (const ev of (j.events || [])) {
      if (!Array.isArray(ev.segs) || !Number.isFinite(ev.tStartMs)) continue;
      const start = ev.tStartMs;
      const evDur = Number(ev.dDurationMs) || 2000;
      const end = start + evDur;
      if (durMs && start >= durMs) break;
      // Text + word timings: automatic captions carry each word's offset
      // (tOffsetMs) — the karaoke sweep. w = [charIdx, len, startRel, endRel].
      let text = '';
      const w = [];
      const segs = ev.segs;
      for (let k = 0; k < segs.length; k++) {
        let u = String(segs[k].utf8 || '').replace(/\s*\n\s*/g, ' ');
        if (!text) u = u.replace(/^\s+/, '');
        if (!u) continue;
        const a = Number(segs[k].tOffsetMs) || 0;
        const nx = segs.slice(k + 1).find(x => Number.isFinite(x.tOffsetMs));
        const b = nx ? nx.tOffsetMs : evDur;
        const lead = u.length - u.replace(/^\s+/, '').length;
        const core = u.trim().length;
        if (core && b > a) w.push(text.length + lead, core, a, b);
        text += u;
      }
      const t = text.replace(/\s+$/, '');
      if (!t) continue;
      const cue = { startMs: offsetMs + start, endMs: offsetMs + Math.min(end, durMs || end), text: t };
      if (w.length >= 8) cue.w = w;   // ≥2 words: real per-word timing
      out.push(cue);
    }
    // Auto-captions overlap (rolling lines): end each cue where the next begins.
    for (let i = 0; i < out.length - 1; i++) if (out[i].endMs > out[i + 1].startMs) out[i].endMs = Math.max(out[i].startMs + 200, out[i + 1].startMs);
    return out.filter(c => c.endMs > c.startMs);
  }

  // ---- per-part picture -------------------------------------------------------------
  const _thumbCache = new Map();   // titleId → {thumbs} (null while loading)
  function primeThumbs(titleId) {
    if (_thumbCache.has(titleId)) return;
    _thumbCache.set(titleId, null);
    Promise.resolve(window.blobStore?.get(THUMBS + titleId)).then((raw) => {
      let m = {};
      try { m = JSON.parse(raw || '{}') || {}; } catch (_) {}
      _thumbCache.set(titleId, m);
    }).catch(() => _thumbCache.set(titleId, {}));
  }
  let _titleCache = { id: null, t: null, at: 0 };
  function activeCollection() {
    const id = window._activeTitleId;
    if (!id) return null;
    if (_titleCache.id !== id || Date.now() - _titleCache.at > 30000) {
      _titleCache = { id, t: _titleCache.id === id ? _titleCache.t : null, at: Date.now() };
      Promise.resolve(window.titleStore?.get?.(id)).then((t) => { if (_titleCache.id === id) _titleCache.t = t; }).catch(() => {});
    }
    const t = _titleCache.t;
    return t && t.collection && Array.isArray(t.collection.parts) && t.collection.parts.length ? t : null;
  }
  function partAt(t, ms) {
    const parts = t.collection.parts;
    let lo = 0, hi = parts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (parts[mid].startMs <= ms) lo = mid; else hi = mid - 1; }
    return parts[lo];
  }
  /** Thumbnail of the part playing now in the active Collection, or '' (sync; primes caches). */
  function coverAt() {
    const t = activeCollection();
    if (!t) return '';
    primeThumbs(t.id);
    const thumbs = _thumbCache.get(t.id);
    if (!thumbs) return '';
    let ms = 0;
    try { ms = window.getAudioProgress?.()?.ms || 0; } catch (_) {}
    const p = partAt(t, ms);
    return (p && thumbs[p.id]) || '';
  }
  /** Parts as chapters: [{startMs, title}] (audio-mode chapter list / next-chapter). */
  function chaptersFor(title) {
    const parts = title && title.collection && title.collection.parts;
    return Array.isArray(parts) ? parts.map(p => ({ startMs: p.startMs, title: p.title, part: true })) : null;
  }
  window.addEventListener('kai:icloud-library', () => { _thumbCache.clear(); _titleCache = { id: null, t: null, at: 0 }; });

  // ---- building -------------------------------------------------------------------------
  let _job = null;   // one build at a time

  /**
   * Create a Collection (no titleId) or append to one. entries: [{id,title,duration,url}]
   * from probe; opts: {name, subs:'youtube'|'transcribe', proofread:bool, onStatus(text)}.
   */
  async function build(entries, opts) {
    if (!canBuild()) throw new Error('YouTube Collections need the Mac YouTube build.');
    if (_job) throw new Error('A Collection is already being built — wait for it to finish.');
    const status = (s) => { log(s); try { opts.onStatus && opts.onStatus(s); } catch (_) {} };
    const ts = window.titleStore, kc = window.kCloud, L = window.iCloudLib;
    if (!L || !(await L.available())) throw new Error('iCloud Drive is needed for Collections (they play on your iPhone through it).');
    _job = { started: Date.now() };
    const dirKey = 'job_' + Date.now().toString(36);
    let workDir = '';
    try {
      let title = opts.titleId ? await ts.get(opts.titleId) : null;
      if (title && (title.id === window._loadedContentTitleId || title.id === window._activeTitleId)) {
        throw new Error('This Collection is open. Switch to another title first, then add videos.');
      }
      const coll = title ? title.collection : {
        v: 1, subs: opts.subs === 'youtube' ? 'youtube' : 'transcribe', parts: [],
        video: !!opts.video, height: [480, 720, 1080].includes(opts.height) ? opts.height : 480, codec: 'hevc',
      };
      const known = new Set(coll.parts.map(p => p.id));
      const todo = entries.filter(e => e && e.id && !known.has(e.id));
      if (!todo.length) throw new Error('Those videos are already in this Collection.');
      const wantSubs = coll.subs === 'youtube';
      const wantVideo = !!coll.video;
      const height = coll.height || 720;
      const codec = coll.codec === 'hevc' ? 'hevc' : 'h264';   // Collections made before HEVC stay H.264
      // Live percent for the current step (native "progress" events).
      let curLabel = '';
      const sub = window.Capacitor?.Plugins?.YouTube?.addListener?.('progress', (ev) => {
        if (!curLabel || !ev || !Number.isFinite(ev.percent)) return;
        const what = ev.stage === 'encode' ? T('yt.st_encode', 'converting video') : ev.stage === 'join' ? T('yt.st_join', 'joining') : T('yt.st_download', 'downloading');
        try { opts.onStatus && opts.onStatus(curLabel + ' — ' + what + ' ' + Math.round(ev.percent) + '%'); } catch (_) {}
      });
      _job.unsub = () => { try { sub && sub.remove && sub.remove(); } catch (_) {} };

      // 1. Download each video's audio (+ subtitles) and thumbnail.
      const got = [];
      let thumbs = {};
      if (title) { try { thumbs = JSON.parse((await window.blobStore.get(THUMBS + title.id)) || '{}') || {}; } catch (_) {} }
      for (let i = 0; i < todo.length; i++) {
        const e = todo[i];
        curLabel = T('yt.downloading', 'Video {i} of {n}: {t}').replace('{i}', i + 1).replace('{n}', todo.length).replace('{t}', e.title);
        status(curLabel);
        const d = await yt('download', { id: e.id, dir: dirKey, subs: wantSubs, video: wantVideo, height, codec });
        workDir = workDir || d.media.slice(0, d.media.lastIndexOf('/'));
        got.push({ e, media: d.media, subsText: d.subsText || '' });
        try { thumbs[e.id] = (await yt('thumb', { id: e.id })).dataUri; } catch (err) { log('no thumbnail for ' + e.id); }
      }

      // 2. Join: [existing Collection file] + new parts → one file (stream copy).
      curLabel = T('yt.joining', 'Joining');
      status(curLabel + '…');
      const inputs = [];
      let oldPath = '';
      if (title) {
        const r = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri: title.attachments.audiobook.uri });
        oldPath = r.path;
        inputs.push(oldPath);
      }
      for (const g of got) inputs.push(g.media);
      const joined = workDir + '/joined.' + (wantVideo ? 'mp4' : 'm4a');
      const c = await yt('concat', { inputs, output: joined });
      curLabel = '';
      const durs = c.durationsMs;
      const oldDur = title ? durs[0] : 0;
      const newDurs = title ? durs.slice(1) : durs;
      const totalMs = durs.reduce((a, b) => a + b, 0);

      // 3. Parts list, appended at the end.
      let at = oldDur;
      const newParts = got.map((g, i) => {
        const p = { id: g.e.id, title: g.e.title, url: g.e.url, startMs: at, durMs: newDurs[i] };
        at += newDurs[i];
        return p;
      });
      const collection = Object.assign({}, coll, { parts: coll.parts.concat(newParts), updatedAt: Date.now() });

      // 4. Into the iCloud library (moved, not copied).
      status(T('yt.saving', 'Saving to iCloud…'));
      if (!title) {
        title = await ts.create({ name: opts.name || 'YouTube Collection', attachments: {} });
      }
      const sid = await ts.ensureSyncId(title.id);
      const fileName = safeName(title.name) + (wantVideo ? '.mp4' : '.m4a');
      const dest = (title.attachments?.audiobook?.uri && L.isICloudUri(title.attachments.audiobook.uri))
        ? L._fromUri(title.attachments.audiobook.uri)
        : `Library/${sid}/media/${fileName}`;
      await kc.importFile(joined, dest, { move: true, overwrite: true });
      const st = await kc.stat(dest).catch(() => ({}));
      await window.blobStore.set(THUMBS + title.id, JSON.stringify(thumbs));
      const firstThumb = thumbs[collection.parts[0].id];
      const patch = {
        collection, icloudLinked: true,
        attachments: { audiobook: Object.assign({ uri: L.toUri(dest), name: dest.split('/').pop(), size: st.size || null }, wantVideo ? { isVideo: true } : {}) },
      };
      if (firstThumb && !title.attachments?.cover?.dataUri) patch.attachments.cover = { dataUri: firstThumb };
      title = await ts.update(title.id, patch);
      _thumbCache.delete(title.id);
      try { await ensureCover(title.id); title = (await ts.get(title.id)) || title; } catch (_) {}
      try { await window.cueAlignment?.clearAlignment?.(title.id); } catch (_) {}

      // 5. Subtitles → the transcript (YouTube's), or let transcription continue.
      const at2 = window.autoTranscribe;
      if (wantSubs) {
        status(T('yt.subs', 'Preparing subtitles…'));
        const cues = [];
        newParts.forEach((p, i) => { if (got[i].subsText) cues.push(...json3ToCues(got[i].subsText, p.startMs, p.durMs)); });
        const missing = got.filter(g => !g.subsText).length;
        if (missing) log(missing + ' video(s) had no Japanese subtitles');
        if (at2?.seedCues) await at2.seedCues(title.id, cues, totalMs, oldDur ? { keepBeforeMs: oldDur } : undefined);
      } else if (oldDur && at2?.seedCues) {
        await at2.seedCues(title.id, null, totalMs, { coverToMs: oldDur });
      }

      // 6. Title files to iCloud (generated SRT/book, parts list, thumbnails).
      await L.publish(title.id);

      // 7. Optional: the overnight proofreading queue (transcribes first if needed).
      if (opts.proofread && window.aiBatch?.enqueue) {
        const n = await window.aiBatch.enqueue([title.id]);
        status(n ? T('yt.queued', 'Added to the proofreading queue.') : T('yt.not_queued', 'Could not add it to the proofreading queue.'));
      }
      try { window.populateLibrary?.(); } catch (_) {}
      status(T('yt.done', 'Done: {n} video(s), {d} in total.').replace('{n}', newParts.length).replace('{d}', fmt(totalMs)));
      return title;
    } finally {
      try { _job && _job.unsub && _job.unsub(); } catch (_) {}
      _job = null;
      if (workDir) { try { await yt('remove', { path: workDir }); } catch (_) {} }
    }
  }

  /** Can this Collection's video be made smaller (HEVC 480p)? */
  function canShrink(t) {
    const c = t && t.collection;
    return !!(canBuild() && c && c.video && (c.codec !== 'hevc' || (c.height || 720) > 480));
  }
  /**
   * Re-encode a Collection's video to HEVC 480p in place. Same length to the
   * millisecond (audio copied), so positions, the proofread transcript and
   * the parts list all stay valid; only the file shrinks.
   */
  async function shrink(titleId, onStatus) {
    if (!canBuild()) throw new Error('Shrinking needs the Mac YouTube build.');
    if (_job) throw new Error('A Collection is already being built — wait for it to finish.');
    const ts = window.titleStore, kc = window.kCloud, L = window.iCloudLib;
    let t = await ts.get(titleId);
    if (!t || !canShrink(t)) throw new Error('Nothing to shrink.');
    if (t.id === window._loadedContentTitleId || t.id === window._activeTitleId) throw new Error('This Collection is open. Switch to another title first.');
    const say = (s) => { log(s); try { onStatus && onStatus(s); } catch (_) {} };
    _job = { started: Date.now() };
    const sub = window.Capacitor?.Plugins?.YouTube?.addListener?.('progress', (ev) => {
      if (ev && ev.stage === 'encode' && Number.isFinite(ev.percent)) say(T('yt.shrinking', 'Shrinking video…') + ' ' + Math.round(ev.percent) + '%');
    });
    let out = '';
    try {
      say(T('yt.shrinking', 'Shrinking video…'));
      const uri = t.attachments.audiobook.uri;
      const src = (await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri })).path;
      const wd = (await yt('available')).workDir;
      out = wd + '/shrink_' + t.id + '/video.mp4';
      const r = await yt('shrink', { input: src, output: out, codec: 'hevc', height: 480 });
      if (!(r.durationMs > 0) || Math.abs(r.durationMs - r.inputMs) > 300) throw new Error('The shrunk video’s length doesn’t match — kept the original.');
      say(T('yt.saving', 'Saving to iCloud…'));
      const dest = L._fromUri(uri);
      await kc.importFile(out, dest, { move: true, overwrite: true });
      out = '';
      const st = await kc.stat(dest).catch(() => ({}));
      t = await ts.update(t.id, {
        attachments: { audiobook: Object.assign({}, t.attachments.audiobook, { size: st.size || r.size || null }) },
        collection: Object.assign({}, t.collection, { codec: 'hevc', height: 480 }),
      });
      try { await window.autoTranscribe?.seedCues?.(t.id, null, r.durationMs, { resign: true }); } catch (_) {}
      await L.publish(t.id);
      const mb = Math.round((st.size || r.size || 0) / 1048576);
      say(T('yt.shrunk', 'Done: the video is now {mb} MB.').replace('{mb}', mb));
      try { window.populateLibrary?.(); } catch (_) {}
      return t;
    } finally {
      try { sub && sub.remove && sub.remove(); } catch (_) {}
      if (out) { try { await yt('remove', { path: out.slice(0, out.lastIndexOf('/')) }); } catch (_) {} }
      _job = null;
    }
  }

  // ---- the sheet ---------------------------------------------------------------------------
  function openSheet(titleId) {
    if (!canBuild()) { alert(T('yt.mac_only', 'YouTube Collections are made in the Mac YouTube build.')); return; }
    document.getElementById('ytCollSheet')?.remove();
    const ov = document.createElement('div');
    ov.id = 'ytCollSheet';
    ov.className = 'kai-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    for (const ev of ['touchstart', 'touchmove', 'touchend']) ov.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--panel-elev,#1e1e22);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:12px;padding:18px;width:min(620px,100%);max-height:86vh;overflow:auto;font-family:var(--font-sans,system-ui);';
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => { if (!_job) ov.remove(); };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    (async () => {
      const existing = titleId ? await window.titleStore.get(titleId) : null;
      const btnCss = 'border-radius:8px;padding:8px 14px;font:600 .9rem var(--font-sans,system-ui);cursor:pointer;border:1px solid var(--border,#444);background:transparent;color:inherit;';
      const priCss = btnCss + 'background:var(--accent-audio,#b794f6);color:#111;border-color:transparent;';
      box.innerHTML = `
        <div style="font-weight:700;font-size:1.05rem;margin-bottom:12px;">${esc(existing ? T('yt.add_title', 'Add videos to “{name}”').replace('{name}', existing.name) : T('yt.new_title', 'New YouTube Collection'))}</div>
        ${existing ? '' : `<label style="display:block;font-size:.8rem;color:var(--text-faint,#aaa);margin-bottom:4px;">${esc(T('yt.name', 'Name'))}</label>
        <input id="ytName" type="text" style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--panel,#111);color:inherit;margin-bottom:12px;">`}
        <label style="display:block;font-size:.8rem;color:var(--text-faint,#aaa);margin-bottom:4px;">${esc(T('yt.links', 'YouTube links or a playlist (one per line)'))}</label>
        <textarea id="ytUrls" rows="5" style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--panel,#111);color:inherit;font-family:ui-monospace,monospace;font-size:.8rem;"></textarea>
        ${existing ? `<div style="font-size:.8rem;color:var(--text-faint,#aaa);margin:8px 0;">${esc(T('yt.append_note', 'New videos are added at the end; your place doesn’t move.'))}</div>` : `
        <div style="margin:12px 0 4px;font-size:.8rem;color:var(--text-faint,#aaa);">${esc(T('yt.subs_label', 'Subtitles'))}</div>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytSubs" value="transcribe" checked> ${esc(T('yt.subs_transcribe', 'Transcribe on this Mac'))}</label>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytSubs" value="youtube"> ${esc(T('yt.subs_youtube', 'YouTube’s automatic subtitles (rough; best with proofreading)'))}</label>
        <div style="margin:12px 0 4px;font-size:.8rem;color:var(--text-faint,#aaa);">${esc(T('yt.video_label', 'Video'))}</div>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytVideo" value="480" checked> ${esc(T('yt.video_480', '480p — about 260 MB per hour (recommended)'))}</label>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytVideo" value="720"> ${esc(T('yt.video_720', '720p — about 420 MB per hour'))}</label>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytVideo" value="1080"> ${esc(T('yt.video_1080', '1080p — about 730 MB per hour'))}</label>
        <label style="display:block;margin:4px 0;"><input type="radio" name="ytVideo" value="0"> ${esc(T('yt.video_none', 'Audio only'))}</label>`}
        <label style="display:block;margin:10px 0;"><input type="checkbox" id="ytProof"> ${esc(T('yt.proofread', 'Proofread with AI when ready (adds furigana; batch, billed to your API key)'))}</label>
        <div id="ytList" style="margin:10px 0;font-size:.85rem;"></div>
        <div id="ytStatus" style="min-height:1.2em;font-size:.85rem;color:var(--text-faint,#aaa);margin:8px 0;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="ytCancel" style="${btnCss}">${esc(T('yt.close', 'Close'))}</button>
          <button id="ytCheck" style="${btnCss}">${esc(T('yt.check', 'Check links'))}</button>
          <button id="ytGo" style="${priCss}" disabled>${esc(existing ? T('yt.add', 'Add') : T('yt.create', 'Create'))}</button>
        </div>`;
      const $ = (id) => box.querySelector('#' + id);
      if (!existing) $('ytProof').checked = false;
      let entries = [];
      const setStatus = (s) => { $('ytStatus').textContent = s; };
      $('ytCancel').onclick = close;
      const check = async () => {
        const urls = $('ytUrls').value.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s));
        if (!urls.length) { setStatus(T('yt.no_links', 'Paste at least one YouTube link.')); return; }
        $('ytCheck').disabled = true; $('ytGo').disabled = true;
        setStatus(T('yt.checking', 'Checking links…'));
        try {
          const r = await yt('probe', { urls });
          const seen = new Set((existing?.collection?.parts || []).map(p => p.id));
          entries = []; const dup = new Set();
          for (const e of r.entries || []) { if (seen.has(e.id) || dup.has(e.id)) continue; dup.add(e.id); entries.push(e); }
          const total = entries.reduce((a, e) => a + (e.duration || 0) * 1000, 0);
          $('ytList').innerHTML = entries.length
            ? `<div style="margin-bottom:6px;font-weight:600;">${entries.length} ${esc(T('yt.videos', 'videos'))} · ${fmt(total)}</div>` +
              entries.map((e, i) => `<div style="display:flex;gap:8px;padding:3px 0;border-top:1px solid var(--border,#2a2a2a);"><span style="color:var(--text-faint,#888);width:2em;text-align:right;">${i + 1}</span><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(e.title)}</span><span style="color:var(--text-faint,#888);">${e.duration ? fmt(e.duration * 1000) : ''}</span></div>`).join('')
            : esc(T('yt.none_new', 'No new videos in those links.'));
          if (!existing && !$('ytName').value && entries.length) $('ytName').value = (r.entries[0].playlist || entries[0].title || '').slice(0, 80);
          setStatus('');
          $('ytGo').disabled = !entries.length;
        } catch (e) { setStatus(String(e.message || e)); }
        $('ytCheck').disabled = false;
      };
      $('ytCheck').onclick = check;
      $('ytUrls').addEventListener('input', () => { $('ytGo').disabled = !$('ytUrls').value.trim(); entries = []; });
      $('ytGo').onclick = async () => {
        if (!entries.length) await check();   // Create without "Check links" first
        if (!entries.length) return;
        $('ytGo').disabled = true; $('ytCheck').disabled = true; $('ytCancel').disabled = true;
        try {
          const made = await build(entries, {
            titleId: existing?.id,
            name: existing ? existing.name : ($('ytName').value.trim() || 'YouTube Collection'),
            subs: existing ? existing.collection.subs : (box.querySelector('input[name=ytSubs]:checked')?.value || 'transcribe'),
            video: existing ? !!existing.collection.video : (box.querySelector('input[name=ytVideo]:checked')?.value || '480') !== '0',
            height: existing ? existing.collection.height : (parseInt(box.querySelector('input[name=ytVideo]:checked')?.value, 10) || 480),
            proofread: $('ytProof').checked,
            onStatus: setStatus,
          });
          // Finished: nothing left to create — offer Open / Done instead.
          $('ytCheck').style.display = 'none';
          $('ytGo').textContent = T('yt.open', 'Open');
          $('ytGo').disabled = false;
          $('ytGo').onclick = () => {
            ov.remove();
            try { window.closeLibrary?.(); } catch (_) {}
            if (made && typeof window.loadTitleFromLibrary === 'function') window.loadTitleFromLibrary(made);
          };
          $('ytCancel').textContent = T('yt.done_btn', 'Done');
          for (const el of box.querySelectorAll('textarea, input')) el.disabled = true;
        } catch (e) { setStatus(String(e.message || e)); $('ytGo').disabled = false; $('ytCheck').disabled = false; }
        $('ytCancel').disabled = false;
      };
    })();
  }

  function boot() {
    const btn = document.getElementById('ytCollBtn');
    if (btn && canBuild()) btn.style.display = '';
  }

  /** True while the active Title is a YouTube Collection (sync; cached). */
  function isActive() { return !!activeCollection(); }
  // Library cover for a Collection (2026-11-24, user: "a composite of the
  // different parts"): the parts' YouTube thumbnails stacked, up to three
  // (one part = its own thumbnail). Each device builds it from the synced
  // thumbnails, so it needs nothing extra in iCloud. A cover the user set
  // is never replaced: only a missing one, a lone first-part thumbnail (the
  // old automatic cover), or an earlier composite for fewer parts.
  function loadImg(src) {
    return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }
  async function ensureCover(titleId) {
    const t = await window.titleStore?.get(titleId);
    const parts = t && t.collection && t.collection.parts;
    if (!parts || !parts.length) return false;
    let thumbs = {};
    try { thumbs = JSON.parse((await window.blobStore.get(THUMBS + titleId)) || '{}') || {}; } catch (_) {}
    const cur = t.attachments?.cover;
    const sig = parts.map(p => p.id).slice(0, 3).join(',') + '|' + Math.min(3, parts.length);
    if (cur && cur.dataUri && cur.collSig === sig) return false;
    if (cur && cur.dataUri && !cur.collSig && cur.dataUri !== thumbs[parts[0].id]) return false;   // the user's own
    const srcs = parts.map(p => thumbs[p.id]).filter(Boolean).slice(0, 3);
    if (!srcs.length) return false;
    const imgs = (await Promise.all(srcs.map(loadImg))).filter(Boolean);
    if (!imgs.length) return false;
    const W = 480, H = Math.round(W * 9 / 16), gap = imgs.length > 1 ? 4 : 0;
    const c = document.createElement('canvas');
    c.width = W; c.height = H * imgs.length + gap * (imgs.length - 1);
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, i) => {
      // cover-fit each thumbnail into its 16:9 band (YouTube's 4:3 "hq"
      // thumbnails carry black letterbox bars — cropping drops them)
      const s = Math.max(W / im.width, H / im.height);
      const dw = im.width * s, dh = im.height * s;
      const y = i * (H + gap);
      g.save(); g.beginPath(); g.rect(0, y, W, H); g.clip();
      g.drawImage(im, (W - dw) / 2, y + (H - dh) / 2, dw, dh);
      g.restore();
    });
    const dataUri = c.toDataURL('image/jpeg', 0.85);
    await window.titleStore.update(titleId, { attachments: { cover: { dataUri, collSig: sig } } });
    log('collection cover built for ' + t.name + ' (' + imgs.length + ' parts)');
    return true;
  }
  async function ensureAllCovers() {
    let n = 0;
    try {
      for (const t of (await window.titleStore?.list()) || []) {
        if (t.collection && t.collection.parts && t.collection.parts.length) { try { if (await ensureCover(t.id)) n++; } catch (_) {} }
      }
    } catch (_) {}
    if (n) { try { window.populateLibrary?.(); } catch (_) {} }
    return n;
  }
  window.addEventListener('kai:icloud-library', () => { setTimeout(() => ensureAllCovers(), 500); });
  setTimeout(() => ensureAllCovers(), 6000);

  window.ytCollection = { openSheet, build, shrink, canShrink, coverAt, chaptersFor, json3ToCues, canBuild, isActive, THUMBS, ensureCover, ensureAllCovers };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
