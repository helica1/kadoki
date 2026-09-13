// library-meta.js — per-title library metadata computed in the background:
// author, audio length, Japanese character count, a local difficulty estimate
// (kanji density + sentence length) and a spoiler-free EXCERPT (the first ~12k
// characters after front matter) that library-blurb.js summarizes.
//
// Stored on the Title (title.author, title.meta = { durationMs, chars,
// kanjiRatio, avgSentence, localDifficulty, metaAt }); the excerpt lives in
// blobStore LIB_EXCERPT_V1_<titleId>. Idempotent, one title at a time, never
// touches the reader or the playhead.
(function () {
  'use strict';
  const EXCERPT_CHARS = 12000;
  const EX_KEY = (id) => 'LIB_EXCERPT_V1_' + id;
  const FRONT_RE = /(cover|toc|nav|contents|copyright|colophon|title|titlepage|奥付|目次|扉|序|はじめに|まえがき)/i;
  const KANJI_RE = /[一-鿿㐀-䶿々]/u;
  const PROFILE_V = 2;          // bump → every title recomputes its profile
  const WORD_SAMPLE = 6000;     // chars of the excerpt segmented for word metrics
  const RARE_RANK = 20000;      // beyond this rank a word counts as rare
  let _running = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jp = (s) => (typeof window.jpCharCount === 'function') ? window.jpCharCount(s) : String(s || '').length;

  async function loadZip(cachePath) {
    if (!cachePath || typeof JSZip === 'undefined') return null;
    const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(cachePath) : 'file://' + cachePath;
    const res = await fetch(url);
    if (!res.ok) return null;
    return JSZip.loadAsync(await res.blob());
  }
  const deBom = (s) => (s ? s.replace(/^﻿+/, '') : s);

  // Plain-text books (.txt, Aozora Bunko markup): strip ruby/annotations,
  // split into ~5k-char parts so the same analysis applies.
  async function extractTxtText(cachePath) {
    const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(cachePath) : 'file://' + cachePath;
    const res = await fetch(url);
    if (!res.ok) return null;
    let text = await res.text();
    text = text.replace(/《[^》]*》/g, '').replace(/｜/g, '').replace(/［＃[^］]*］/g, '').replace(/^\uFEFF/, '');
    text = text.replace(/\r\n?/g, '\n').replace(/[ \t　]+/g, ' ').trim();
    const parts = [];
    let buf = '';
    for (const para of text.split(/\n{2,}/)) {
      buf += (buf ? '\n\n' : '') + para;
      if (buf.length >= 5000) { parts.push({ href: 'part' + parts.length, text: buf, jp: jp(buf) }); buf = ''; }
    }
    if (buf) parts.push({ href: 'part' + parts.length, text: buf, jp: jp(buf) });
    return parts;
  }

  // Spine walk → plain text per item (ruby readings removed).
  async function extractEpubText(cachePath) {
    if (/\.txt$/i.test(String(cachePath || ''))) return extractTxtText(cachePath);
    const zip = await loadZip(cachePath);
    if (!zip) return null;
    const containerXml = deBom(await zip.file('META-INF/container.xml')?.async('string'));
    if (!containerXml) return null;
    const opfPath = new DOMParser().parseFromString(containerXml, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath || !zip.file(opfPath)) return null;
    const opfDoc = new DOMParser().parseFromString(deBom(await zip.file(opfPath).async('string')), 'application/xml');
    const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
    const items = {};
    opfDoc.querySelectorAll('manifest > item').forEach((it) => { items[it.getAttribute('id')] = { href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '' }; });
    const spine = Array.from(opfDoc.querySelectorAll('spine > itemref')).map((r) => items[r.getAttribute('idref')]).filter((x) => x && /xhtml|html|xml/i.test(x.type + x.href));
    const parts = [];
    for (const it of spine) {
      const path = (opfDir + decodeURIComponent(it.href)).replace(/^\.\//, '');
      const f = zip.file(path) || zip.file(it.href);
      if (!f) continue;
      let text = '';
      try {
        const doc = new DOMParser().parseFromString(deBom(await f.async('string')), 'text/html');
        doc.querySelectorAll('rt, rp, script, style').forEach((n) => n.remove());
        text = (doc.body ? doc.body.textContent : doc.documentElement.textContent) || '';
      } catch (_) { continue; }
      text = text.replace(/[ \t　]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      parts.push({ href: it.href, text, jp: jp(text) });
    }
    return parts;
  }

  // Kanji inventory over the whole text: distinct kanji and the share used once.
  function kanjiStats(parts) {
    const seen = new Map();
    let runK = 0, runH = 0, nK = 0, nH = 0, curK = 0, curH = 0;
    for (const p of parts) {
      for (const ch of p.text) {
        const isK = KANJI_RE.test(ch), isH = /[ぁ-ゖ]/.test(ch);
        if (isK) seen.set(ch, (seen.get(ch) || 0) + 1);
        if (isK) { curK++; if (curH) { runH += curH; nH++; curH = 0; } }
        else if (isH) { curH++; if (curK) { runK += curK; nK++; curK = 0; } }
        else { if (curK) { runK += curK; nK++; curK = 0; } if (curH) { runH += curH; nH++; curH = 0; } }
      }
    }
    let hapax = 0; for (const c of seen.values()) if (c === 1) hapax++;
    return { uniqueKanji: seen.size, hapaxShare: seen.size ? hapax / seen.size : 0, kanjiRun: nK ? runK / nK : 0, hiraRun: nH ? runH / nH : 0 };
  }
  // Word metrics over the excerpt via the dictionary segmenter (longest-match
  // deinflecting lookup, same as the reader's taps) + the frequency list.
  async function wordStats(text) {
    if (typeof window.dictSegmentWord !== 'function') return null;
    const sample = String(text || '').slice(0, WORD_SAMPLE);
    if (sample.length < 300) return null;
    let freq = null;
    try { if (window.wordFreq?.available?.()) freq = await window.wordFreq.load(); } catch (_) {}
    const SKIP = /[\s　「」『』、。・…！？!?,.;:()（）\-—–~〜0-9０-９A-Za-zＡ-Ｚａ-ｚ]/;
    const words = new Map();
    let n = 0, rare = 0, ranked = 0, sentences = 0, pos = 0, hits = 0, scanned = 0;
    for (const ch of sample) if (ch === '。' || ch === '！' || ch === '？') sentences++;
    while (pos < sample.length) {
      const ch = sample[pos];
      if (SKIP.test(ch)) { pos++; continue; }
      let len = 1;
      try { const best = await window.dictSegmentWord(sample, pos, 12); if (best && best.length > 0) len = best.length; } catch (_) {}
      scanned++;
      if (len > 1 || KANJI_RE.test(ch)) {
        const w = sample.slice(pos, pos + len);
        if (len > 1) hits++;
        n++;
        words.set(w, (words.get(w) || 0) + 1);
        if (freq) {
          const r = freq.get(w);
          if (r != null) { ranked++; if (r > RARE_RANK) rare++; }
          else if (len >= 2) rare++;   // in the dictionary, not in the top list → rare
        }
      }
      pos += len;
      if ((scanned & 63) === 0) await new Promise((r) => setTimeout(r, 0));   // stay gentle
    }
    if (scanned >= 20 && hits / scanned < 0.2) return null;   // no real dictionary behind the segmenter
    return {
      words: n, wps: sentences ? Math.round((n / sentences) * 10) / 10 : 0,
      ttr: n ? Math.round((words.size / n) * 1000) / 1000 : 0,
      rareShare: freq && n ? Math.round((rare / n) * 1000) / 1000 : null,
      freqName: freq ? (window.wordFreq.info()?.name || '') : '',
    };
  }
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  // 1 (easy) … 5 (hard) from the profile; rare-word share leads when a
  // frequency list is present, kanji density otherwise.
  function difficultyFrom(m) {
    const kd = clamp01(((m.kanjiRatio || 0) - 0.18) / 0.20);
    const sl = clamp01(((m.avgSentence || 0) - 25) / 45);
    const uk = clamp01(((m.uniqueKanji || 0) - 800) / 1200);
    const wl = clamp01(((m.wps || 0) - 10) / 14);
    let d;
    if (m.rareShare != null) {
      const rs = clamp01(((m.rareShare || 0) - 0.04) / 0.16);
      d = 1 + 1.6 * rs + 1.0 * kd + 0.6 * sl + 0.5 * uk + 0.3 * wl;
    } else {
      d = 1 + 1.7 * kd + 0.9 * sl + 0.9 * uk + 0.5 * wl;
    }
    return Math.round(Math.max(1, Math.min(5, d)) * 10) / 10;
  }

  function analyze(parts) {
    let chars = 0;
    for (const p of parts) chars += p.jp;
    // Excerpt: skip front matter (named like it, or too short to be a chapter).
    let excerpt = '';
    let started = false;
    for (const p of parts) {
      if (!started) {
        if (FRONT_RE.test(p.href) && p.jp < 1500) continue;
        if (p.jp < 200) continue;
        started = true;
      }
      excerpt += (excerpt ? '\n\n' : '') + p.text;
      if (excerpt.length >= EXCERPT_CHARS) break;
    }
    if (!excerpt) for (const p of parts) { excerpt += p.text; if (excerpt.length >= EXCERPT_CHARS) break; }
    excerpt = excerpt.slice(0, EXCERPT_CHARS);
    // Difficulty features over the whole text.
    let kanji = 0, jpTotal = 0, sentences = 0;
    for (const p of parts) {
      for (const ch of p.text) {
        if (KANJI_RE.test(ch)) kanji++;
        if (ch === '。' || ch === '！' || ch === '？') sentences++;
      }
      jpTotal += p.jp;
    }
    const kanjiRatio = jpTotal ? kanji / jpTotal : 0;
    const avgSentence = sentences ? jpTotal / sentences : 0;
    const ks = kanjiStats(parts);
    return { chars, excerpt, kanjiRatio: Math.round(kanjiRatio * 1000) / 1000, avgSentence: Math.round(avgSentence),
             uniqueKanji: ks.uniqueKanji, hapaxShare: Math.round(ks.hapaxShare * 1000) / 1000, kanjiRun: Math.round(ks.kanjiRun * 100) / 100, hiraRun: Math.round(ks.hiraRun * 100) / 100 };
  }

  // A cached path that actually opens. Stored absolute paths go stale on iOS
  // (every dev reinstall changes the container UUID; tmp can be purged) — this
  // was every "could not extract the book text": rebase to the live container,
  // probe the file, and re-materialize from the picker uri when it is gone.
  async function fileOk(path) {
    if (!path) return false;
    try {
      const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(path) : 'file://' + path;
      const r = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      return r.ok || r.status === 206 || r.status === 0;
    } catch (_) { return false; }
  }
  async function epubCachePath(t) {
    const e = t.attachments && t.attachments.epub;
    if (!e) return null;
    let cp = e.cachePath || null;
    if (cp && window.rebaseContainerPath) { try { cp = (await window.rebaseContainerPath(cp)) || cp; } catch (_) {} }
    if (cp && await fileOk(cp)) {
      if (cp !== e.cachePath) { try { await window.titleStore.attach(t.id, 'epub', Object.assign({}, e, { cachePath: cp })); } catch (_) {} }
      return cp;
    }
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (e.uri && fa?.materializeToCache) {
      try {
        const m = await fa.materializeToCache({ uri: e.uri });
        if (m?.path) { try { await window.titleStore.attach(t.id, 'epub', Object.assign({}, e, { cachePath: m.path })); } catch (_) {} return m.path; }
      } catch (_) {}
    }
    return null;
  }

  function needsMeta(t) {
    const a = t.attachments || {};
    const m = t.meta || {};
    if (a.epub && !(m.chars > 0)) return true;
    if (a.epub && m.profileV !== PROFILE_V) return true;
    // A frequency list arrived after the profile was made → rare-word share is missing.
    if (a.epub && m.rareShare == null && window.wordFreq?.available?.() && !m.freqTried) return true;
    if (a.audiobook && !a.audiobook.isVideo && !(m.durationMs > 0)) return true;
    if (a.epub && !t.author && !m.authorTried) return true;
    return false;
  }

  async function computeFor(t) {
    const a = t.attachments || {};
    const meta = Object.assign({}, t.meta || {});
    const patch = {};
    // Audio length.
    if (a.audiobook && !a.audiobook.isVideo && !(meta.durationMs > 0)) {
      try {
        const bg = window.Capacitor?.Plugins?.BackgroundAudio, fa = window.Capacitor?.Plugins?.FileAccess;
        if (a.audiobook.cachePath && bg?.probeDuration) { const r = await bg.probeDuration({ path: a.audiobook.cachePath }); if (Number(r?.durationMs) > 0) meta.durationMs = Math.round(Number(r.durationMs)); }
        else if (a.audiobook.uri && fa?.mediaTags) { const r = await fa.mediaTags({ uri: a.audiobook.uri }); if (Number(r?.durationMs) > 0) meta.durationMs = Math.round(Number(r.durationMs)); if (!t.author && r?.artist) patch.author = r.artist; }
      } catch (_) {}
    }
    // Book text: chars, difficulty, excerpt, author.
    if (a.epub && (!(meta.chars > 0) || (!t.author && !meta.authorTried))) {
      const cp = await epubCachePath(t);
      if (cp) {
        try {
          let excerpt = null;
          if (!(meta.chars > 0) || meta.profileV !== PROFILE_V) {
            const parts = await extractEpubText(cp);
            if (parts && parts.length) {
              const r = analyze(parts);
              excerpt = r.excerpt;
              Object.assign(meta, { chars: r.chars, kanjiRatio: r.kanjiRatio, avgSentence: r.avgSentence, uniqueKanji: r.uniqueKanji, hapaxShare: r.hapaxShare, kanjiRun: r.kanjiRun, hiraRun: r.hiraRun });
              try { await window.blobStore?.set(EX_KEY(t.id), r.excerpt); } catch (_) {}
            }
          }
          // Word metrics (+ rare-word share with a frequency list).
          if (meta.profileV !== PROFILE_V || (meta.rareShare == null && window.wordFreq?.available?.())) {
            if (excerpt == null) { try { excerpt = await window.blobStore?.get(EX_KEY(t.id)); } catch (_) {} }
            try {
              const ws = excerpt ? await wordStats(excerpt) : null;
              if (ws) { meta.words = ws.words; meta.wps = ws.wps; meta.ttr = ws.ttr; meta.rareShare = ws.rareShare; meta.freqName = ws.freqName; }
            } catch (_) {}
            meta.freqTried = !!window.wordFreq?.available?.();
          }
          meta.localDifficulty = difficultyFrom(meta);
          meta.profileV = PROFILE_V;
          if (!t.author && window.importPairing?.readEpubMeta) {
            const em = await window.importPairing.readEpubMeta(cp);
            if (em?.author) patch.author = em.author;
            if (em?.title && !meta.epubTitle) meta.epubTitle = em.title;
          }
        } catch (_) {}
        meta.authorTried = true;
      }
    }
    meta.metaAt = Date.now();
    patch.meta = meta;
    try { await window.titleStore.update(t.id, patch); } catch (_) {}
    return patch;
  }

  // Run over every title that still needs metadata (one at a time, gentle).
  async function ensureAll(opts) {
    if (_running) return;
    _running = true;
    let did = 0;
    try {
      const titles = await window.titleStore.list();
      for (const t of titles) {
        if (t.cloudOnly || !needsMeta(t)) continue;
        try { await computeFor(t); did++; } catch (_) {}
        await sleep(80);
      }
    } finally { _running = false; }
    if (did && typeof window.populateLibrary === 'function' && document.getElementById('libraryPage')?.classList.contains('visible')) { try { await window.populateLibrary(); } catch (_) {} }
    try { opts && opts.then && opts.then(did); } catch (_) {}
    return did;
  }

  async function excerptFor(t) {
    if (!t) return '';
    try { const s = await window.blobStore?.get(EX_KEY(t.id)); if (s) return s; } catch (_) {}
    const cp = await epubCachePath(t);
    if (!cp) return '';
    try {
      const parts = await extractEpubText(cp);
      if (!parts || !parts.length) return '';
      const r = analyze(parts);
      try { await window.blobStore?.set(EX_KEY(t.id), r.excerpt); } catch (_) {}
      return r.excerpt;
    } catch (_) { return ''; }
  }

  const fmtHours = (ms) => {
    if (!(ms > 0)) return '';
    const h = ms / 3600000;
    return h >= 10 ? Math.round(h) + ' h' : (Math.round(h * 10) / 10) + ' h';
  };
  const fmtChars = (n) => (n > 0) ? (n >= 10000 ? (Math.round(n / 1000) + 'k') : String(n)) : '';

  // In-place library sweep (iOS): every attachment whose file lives inside
  // the app's own Documents folder ("On My iPhone ▸ Kadoki") is pointed at
  // that file directly and its stale cache copy is deleted — reclaims the
  // duplicate gigabytes without waiting for each title to be opened.
  let _sweptInPlace = false;
  async function sweepInPlace() {
    if (_sweptInPlace) return 0;
    const fa = window.Capacitor?.Plugins?.FileAccess;
    if (!fa || typeof fa.localPath !== 'function') return 0;
    _sweptInPlace = true;
    let fixed = 0;
    try {
      const titles = await window.titleStore.list();
      for (const t of titles) {
        const a = t.attachments || {};
        for (const kind of ['audiobook', 'epub', 'srt']) {
          const att = a[kind];
          if (!att || !att.uri) continue;
          try {
            const r = await fa.localPath({ uri: att.uri });
            if (r && r.path && r.path !== att.cachePath) { await window.titleStore.attach(t.id, kind, Object.assign({}, att, { cachePath: r.path, inPlace: true })); fixed++; }
          } catch (_) {}
        }
        // Video series episodes carry their own uris.
        if (Array.isArray(a.series)) {
          for (const ep of a.series) { for (const k of ['video', 'srt']) { const f = ep && ep[k]; if (f && f.uri) { try { await fa.localPath({ uri: f.uri }); } catch (_) {} } } }
        }
        await sleep(10);
      }
    } catch (_) {}
    if (fixed) { try { console.warn('[library] in-place sweep: ' + fixed + ' attachment(s) now used from the Kadoki folder'); } catch (_) {} }
    return fixed;
  }
  setTimeout(() => { try { sweepInPlace(); } catch (_) {} }, 9000);

  // A freshly imported frequency list re-profiles every book (rare-word share).
  window.addEventListener('kai:freq-imported', () => { try { ensureAll(); } catch (_) {} });

  // Boot: library-blurb.js runs the summary queue first, then calls ensureAll.

  // Human line for the details panel.
  function profileLine(m) {
    if (!m) return '';
    const bits = [];
    if (m.kanjiRatio > 0) bits.push(Math.round(m.kanjiRatio * 100) + '% kanji');
    if (m.uniqueKanji > 0) bits.push(m.uniqueKanji.toLocaleString() + ' distinct kanji');
    if (m.avgSentence > 0) bits.push(m.avgSentence + ' chars/sentence');
    if (m.wps > 0) bits.push(m.wps + ' words/sentence');
    if (m.rareShare != null) bits.push(Math.round(m.rareShare * 100) + '% rare words');
    return bits.join(' · ');
  }
  window.libraryMeta = { ensureAll, computeFor, excerptFor, needsMeta, fmtHours, fmtChars, profileLine, difficultyFrom, sweepInPlace };
})();
