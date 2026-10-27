// import-pairing.js — pairs EPUBs with audiobooks (and SRTs) for folder import.
//
// A flat folder of rips and e-books rarely shares exact filenames, so pairing
// uses three signals, strongest first:
//   1. Embedded metadata: the EPUB's dc:title/dc:creator vs the audio file's
//      title/artist tags (FileAccess.mediaTags — no copy, tags only).
//   2. Normalized filenames: NFKC, lowercase, ASIN/ISBN brackets and other
//      bracketed groups removed, rip/format noise words removed, then
//      character-bigram Dice similarity with a containment bonus.
//   3. Volume guards: 上/中/下, 第N巻, vol.N and trailing numerals must agree
//      (鹿の王 1 must never pair with 鹿の王 3).
// Then a one-to-one greedy assignment by score. The importer shows a review
// sheet when any pair is uncertain (score < REVIEW_MIN) or files are left over.
(function () {
  'use strict';

  const REVIEW_MIN = 0.8;    // below this a pair is shown for confirmation
  const ACCEPT_MIN = 0.45;   // below this two files are not paired at all

  const nfkc = (s) => { try { return String(s || '').normalize('NFKC'); } catch (_) { return String(s || ''); } };
  const stripExt = (s) => String(s || '').replace(/\.[^.]+$/, '');

  // Bracketed IDs (ASIN / ISBN / catalogue codes): letters+digits, 8+ chars.
  const ID_BRACKET = /[\[（(【][^\]）)】]*[A-Za-z0-9]{8,}[^\]）)】]*[\]）)】]/g;
  const ANY_BRACKET = /[\[（(【{][^\]）)】}]*[\]）)】}]/g;
  const NOISE_WORDS = /(?:^|[\s_\-.])(?:cbr|vbr|abr|mp3|m4b|m4a|epub|audiobook|audio|kindle|unabridged|abridged|\d{2,3}\s?kbps|\d{2,3}k|100limit)(?=$|[\s_\-.])/gi;
  const JP_NOISE = /(オーディオブック|朗読版?|音声版|電子書籍版?|完全版)/g;
  const PUNCT = /[\s　_\-–—:：꞉;；,，.。・･!！?？'"“”‘’`~〜～|｜/\\*+]/g;

  function kanjiNum(s) {
    const map = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    const t = nfkc(s);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    let n = 0, cur = 0;
    for (const ch of t) {
      if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
      else if (map[ch] != null) cur = map[ch];
      else return NaN;
    }
    return n + cur;
  }

  // Volume markers found in a filename or title: a Set of keys such as '上',
  // '下', 'v1', 'v3' ('' → empty set). A name can carry both a kanji and a
  // numeric marker ("[01] 新世界より（上）"); compatibility is judged per kind.
  function volumeKeys(raw) {
    let s = nfkc(stripExt(raw)).replace(ID_BRACKET, ' ').replace(NOISE_WORDS, ' ');
    const out = new Set();
    let m;
    if ((m = s.match(/(?:^|[\s_\-（(\[【）)\]】])([上中下])(?:巻)?(?:$|[\s_\-）)\]】.（(\[【])/))) out.add(m[1]);
    else if ((m = s.match(/([上中下])巻/))) out.add(m[1]);
    if ((m = s.match(/第\s*([0-9一二三四五六七八九十〇零]+)\s*[巻部集話]/))) { const n = kanjiNum(m[1]); if (Number.isFinite(n)) out.add('v' + n); }
    else if ((m = s.match(/(?:vol(?:ume)?\.?|巻|part)\s*([0-9]{1,3})/i))) out.add('v' + parseInt(m[1], 10));
    else if ((m = s.match(/^\s*[\[（(]?\s*([0-9]{1,2})\s*[\]）)]?[\s_\-.．]/))) out.add('v' + parseInt(m[1], 10));   // "[03] …", "６．…"
    else if ((m = s.match(/(?:^|[\s_\-（(\[])([0-9]{1,2})\s*[）)\]]?\s*$/))) out.add('v' + parseInt(m[1], 10));   // "鹿の王 3"
    return out;
  }
  function volumeKey(raw) { const k = volumeKeys(raw); return k.size ? [...k].join('+') : ''; }
  // 1 = compatible, 0.9 = one side has only a kanji marker and the other only
  // a number (上 could be 1 — or 2 of 3; unknowable), 0 = a real mismatch.
  function volumeCompat(a, b) {
    if (!a.size || !b.size) return (a.size || b.size) ? 0.85 : 1;
    for (const k of a) if (b.has(k)) return 1;
    const num = (set) => [...set].some((k) => k.startsWith('v')), kan = (set) => [...set].some((k) => !k.startsWith('v'));
    if (num(a) && num(b)) return 0;
    if (kan(a) && kan(b)) return 0;
    return 0.9;
  }

  // Normalized comparison string (no volume info removed — the guard handles it).
  function norm(raw) {
    let s = nfkc(stripExt(raw)).toLowerCase();
    s = s.replace(ID_BRACKET, ' ').replace(ANY_BRACKET, ' ');
    s = s.replace(JP_NOISE, ' ').replace(NOISE_WORDS, ' ');
    s = s.replace(PUNCT, '');
    return s.trim();
  }
  function bigrams(s) {
    const set = new Set();
    if (!s) return set;
    if (s.length === 1) { set.add(s); return set; }
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return (2 * inter) / (A.size + B.size);
  }
  function similarity(rawA, rawB) {
    const a = norm(rawA), b = norm(rawB);
    if (!a || !b) return 0;
    let s = dice(a, b);
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 2 && long.includes(short)) s = Math.max(s, 0.75 + 0.2 * (short.length / long.length));
    return Math.min(1, s);
  }

  // Score one epub against one audio (or srt) file, metadata included.
  function scorePair(epub, other) {
    let s = similarity(epub.name, other.name);
    // Metadata: tag titles from both sides; author agreement is a bonus.
    const mtA = epub.metaTitle, mtB = other.metaTitle;
    if (mtA && mtB) {
      let ms = similarity(mtA, mtB);
      const auA = epub.metaAuthor, auB = other.metaAuthor;
      if (ms >= 0.5 && auA && auB && similarity(auA, auB) >= 0.6) ms = Math.min(1, ms + 0.1);
      s = Math.max(s, ms);
    } else if (mtB) {
      s = Math.max(s, similarity(epub.name, mtB));          // audio tag vs epub filename
    } else if (mtA) {
      s = Math.max(s, similarity(mtA, other.name));         // epub title vs audio filename
    }
    // Volume guard (filename markers first; a tag title can add its own).
    const va = volumeKeys(epub.name); for (const k of volumeKeys(epub.metaTitle || '')) va.add(k);
    const vb = volumeKeys(other.name); for (const k of volumeKeys(other.metaTitle || '')) vb.add(k);
    return s * volumeCompat(va, vb);
  }

  // One-to-one greedy assignment. Returns { pairs:[{epub, audio, score}], epubOnly:[], audioOnly:[] }.
  function assign(epubs, others, opts) {
    const allowSingle = !!(opts && opts.allowSingle);
    const cand = [];
    for (const e of epubs) for (const o of others) { const s = scorePair(e, o); if (s > 0) cand.push({ e, o, s }); }
    cand.sort((x, y) => y.s - x.s);
    const usedE = new Set(), usedO = new Set(), pairs = [];
    for (const c of cand) {
      if (c.s < ACCEPT_MIN) break;
      if (usedE.has(c.e) || usedO.has(c.o)) continue;
      usedE.add(c.e); usedO.add(c.o);
      pairs.push({ epub: c.e, audio: c.o, score: c.s });
    }
    if (allowSingle && epubs.length === 1 && others.length === 1 && !pairs.length) {
      const s = scorePair(epubs[0], others[0]);
      pairs.push({ epub: epubs[0], audio: others[0], score: Math.max(s, 0.7) });   // the folder itself says they belong together
      usedE.add(epubs[0]); usedO.add(others[0]);
    }
    return { pairs, epubOnly: epubs.filter((e) => !usedE.has(e)), audioOnly: others.filter((o) => !usedO.has(o)) };
  }

  // Candidates for the review sheet: every audio scored against this epub, best first.
  function rankCandidates(epub, audios) {
    return audios.map((a) => ({ file: a, score: scorePair(epub, a) })).sort((x, y) => y.score - x.score);
  }

  // SRT for a book: best match against the epub name/title and the audio name/title.
  function matchSrt(book, srts, used) {
    let best = null, bestS = 0;
    for (const s of srts) {
      if (used && used.has(s)) continue;
      let sc = 0;
      if (book.epub) sc = Math.max(sc, scorePair(book.epub, s));
      if (book.audio) sc = Math.max(sc, scorePair({ name: book.audio.name, metaTitle: book.audio.metaTitle, metaAuthor: book.audio.metaAuthor }, s));
      if (sc > bestS) { bestS = sc; best = s; }
    }
    return bestS >= ACCEPT_MIN ? { srt: best, score: bestS } : null;
  }

  // Pair one folder group. Returns books (importer shape) + review flag.
  function pairGroup(epubs, audios, srts, opts) {
    const allowSingle = !!(opts && opts.allowSingle);
    const r = assign(epubs, audios, { allowSingle });
    const books = [];
    const usedSrt = new Set();
    const bookOf = (epub, audio, score) => {
      const b = { epub: epub || null, audio: audio || null, srt: null, score: (score == null ? null : score) };
      const m = matchSrt(b, srts, usedSrt);
      if (m) { b.srt = m.srt; usedSrt.add(m.srt); }
      return b;
    };
    for (const p of r.pairs) books.push(bookOf(p.epub, p.audio, p.score));
    for (const e of r.epubOnly) books.push(bookOf(e, null, null));
    for (const a of r.audioOnly) books.push(bookOf(null, a, null));
    const uncertain = books.some((b) => b.epub && b.audio && b.score < REVIEW_MIN);
    const leftovers = r.epubOnly.length > 0 && r.audioOnly.length > 0;   // both kinds unmatched — worth a look
    return { books, review: uncertain || leftovers, audios, srts };
  }

  // ---- metadata (EPUB OPF via JSZip on a materialized copy; audio tags natively) ----
  async function readEpubMeta(cachePath) {
    if (!cachePath || typeof JSZip === 'undefined') return null;
    try {
      const url = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(cachePath) : 'file://' + cachePath;
      const res = await fetch(url);
      if (!res.ok) return null;
      const zip = await JSZip.loadAsync(await res.blob());
      const deBom = (s) => (s ? s.replace(/^﻿+/, '') : s);
      const containerXml = deBom(await zip.file('META-INF/container.xml')?.async('string'));
      if (!containerXml) return null;
      const opfPath = new DOMParser().parseFromString(containerXml, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
      if (!opfPath || !zip.file(opfPath)) return null;
      const opfDoc = new DOMParser().parseFromString(deBom(await zip.file(opfPath).async('string')), 'application/xml');
      const text = (sel) => { const el = opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', sel)[0]; return el ? String(el.textContent || '').trim() : ''; };
      return { title: text('title'), author: text('creator'), language: text('language') };
    } catch (_) { return null; }
  }

  // Enrich file records in place: epub → cachePath + metaTitle/metaAuthor;
  // audio → metaTitle/metaAuthor/durationMs. `onProgress(done, total)`.
  async function readMeta(files, onProgress) {
    const fa = window.Capacitor?.Plugins?.FileAccess;
    // Picked files carry a uri; Wi-Fi inbox files are local (cachePath only).
    const list = files.filter((f) => f && (f.uri || f.cachePath));
    let done = 0;
    const step = () => { done++; try { onProgress && onProgress(done, list.length); } catch (_) {} };
    const worker = async (f) => {
      try {
        if (f.kind === 'epub' && !f.uri && f.cachePath) {
          const meta = await readEpubMeta(f.cachePath);
          if (meta) { f.metaTitle = meta.title || ''; f.metaAuthor = meta.author || ''; f.metaLang = meta.language || ''; }
        } else if (f.kind === 'epub') {
          if (fa?.materializeToCache) {
            const m = await fa.materializeToCache({ uri: f.uri });
            if (m?.path) { f.cachePath = m.path; const meta = await readEpubMeta(m.path); if (meta) { f.metaTitle = meta.title || ''; f.metaAuthor = meta.author || ''; f.metaLang = meta.language || ''; } }
          }
        } else if (f.kind === 'audio') {
          if (fa && typeof fa.mediaTags === 'function') {
            const t = await fa.mediaTags({ uri: f.uri || ('file://' + f.cachePath) });
            if (t) { f.metaTitle = t.title || ''; f.metaAuthor = t.artist || t.album || ''; if (Number(t.durationMs) > 0) f.durationMs = Math.round(Number(t.durationMs)); }
          }
        }
      } catch (_) {}
      step();
    };
    const CONC = 3;
    let i = 0;
    const runners = [];
    for (let k = 0; k < CONC; k++) runners.push((async () => { while (i < list.length) { const f = list[i++]; await worker(f); } })());
    await Promise.all(runners);
  }

  window.importPairing = { pairGroup, rankCandidates, matchSrt, scorePair, readMeta, readEpubMeta, norm, volumeKey, volumeKeys, similarity, REVIEW_MIN, ACCEPT_MIN };
})();
