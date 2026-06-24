// ai-export.js — export the AI reading record (all chapter summaries + all
// character descriptions) for the active title as nicely-formatted plain text:
// Copy-all to clipboard, or Save a .txt file. Also exposes the per-item
// formatters + a clipboard helper so the chapter view / Characters screen can
// add "Copy" buttons that reuse the exact same formatting.
(function () {
  'use strict';

  const CHAP_PREFIX = 'AICHAP_V1_';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp() {
    try {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    } catch (_) { return ''; }
  }

  // ---- clipboard (secure-context first, execCommand fallback) ----------------
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }
  function toast(msg) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, 1800); } catch (_) {}
  }

  // ---- formatters (shared with the per-item Copy buttons) --------------------
  function reading(rec) { return rec.rubyReading || rec.standardReading || ''; }

  // One chapter's record. `ch` is the chunk-map chunk (for label/number), `art`
  // the AICHAP artifact. Returns plain text.
  function chapterText(art, ch, num) {
    const out = [];
    const n = Number.isFinite(num) ? num : ((ch && Number.isFinite(ch.idx)) ? ch.idx + 1 : '?');
    const label = (art && art.label) || (ch && ch.label) || '';
    out.push('▼ 第' + n + '章' + (label ? ' — ' + label : ''));
    if (art && art.shortSummary) out.push(art.shortSummary.trim());
    if (art && art.longSummary) { out.push(''); out.push(art.longSummary.trim()); }
    const events = (art && Array.isArray(art.events)) ? art.events.filter(e => e && (e.title || e.description)) : [];
    if (events.length) {
      out.push(''); out.push('主な出来事:');
      for (const e of events) out.push('・' + (e.title ? e.title + '：' : '') + (e.description || ''));
    }
    const pas = (art && Array.isArray(art.keyPassages)) ? art.keyPassages.filter(p => p && p.quote) : [];
    if (pas.length) {
      out.push(''); out.push('印象的な場面:');
      for (const p of pas) {
        out.push('「' + p.quote.trim() + '」');
        if (p.why) out.push('  — ' + p.why.trim());
      }
    }
    return out.join('\n');
  }

  // One character record. idToSurface resolves relationship targets.
  function charText(rec, idToSurface) {
    const out = [];
    const rd = reading(rec);
    out.push('■ ' + (rec.surface || '') + (rd ? '（' + rd + '）' : '') + (rec.role ? '  — ' + rec.role : ''));
    const others = (rec.aliases || []).filter(a => a && a !== rec.surface);
    if (others.length) out.push('別名: ' + others.join('・'));
    const devs = Array.isArray(rec.developments) ? rec.developments : [];
    if (devs.length) {
      out.push('最新の動き:');
      for (const d of devs) out.push('・' + (d && d.text ? d.text : '') +
        (d && Number.isFinite(d.chunkIdx) ? '（第' + (d.chunkIdx + 1) + '章）' : ''));
    }
    const fld = (label, v) => { if (v) { out.push(label + ': ' + String(v).replace(/\n+/g, ' ')); } };
    fld('人物', rec.description);
    fld('性格', rec.personality);
    fld('外見', rec.appearance);
    fld('動機', rec.motivations);
    fld('秘密', rec.secrets);
    const rels = (rec.relationships || [])
      .map(r => ((idToSurface && idToSurface[r.to]) || r.to) + '（' + r.rel + '）')
      .filter(Boolean);
    if (rels.length) out.push('関係: ' + rels.join('、'));
    return out.join('\n');
  }

  // ---- gather + build the full document --------------------------------------
  async function titleName(titleId) {
    try {
      if (window.titleStore && window.titleStore.list) {
        const ts = await window.titleStore.list();
        const t = (ts || []).find(x => x && x.id === titleId);
        if (t) return t.name || t.title || titleId;
      }
    } catch (_) {}
    return titleId;
  }

  async function buildDocument(titleId) {
    const lines = [];
    const name = await titleName(titleId);
    const bar = '═══════════════════════════════';
    lines.push(bar);
    lines.push(name);
    lines.push('AI読書記録  (' + stamp() + ')');
    lines.push(bar);

    // chapters: order by chunk-map idx; labels from the map, summaries from AICHAP
    let map = null, art = {};
    try { if (window.aiChunks && window.aiChunks.getMap) map = await window.aiChunks.getMap(titleId); } catch (_) {}
    try {
      const raw = window.blobStore ? await window.blobStore.get(CHAP_PREFIX + titleId) : null;
      const p = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if (p && typeof p === 'object') art = p;
    } catch (_) {}
    const chunks = (map && Array.isArray(map.chunks)) ? map.chunks : [];
    const fp = map && map.fingerprint;

    const idxs = chunks.length
      ? chunks.map(c => c && c.idx).filter(Number.isFinite)
      : Object.keys(art).map(Number).filter(Number.isFinite).sort((a, b) => a - b);

    let nChap = 0;
    const chapBody = [];
    for (const idx of idxs) {
      const a = art[idx];
      if (!a || !(a.longSummary || a.shortSummary)) continue;
      if (a.fp && fp && a.fp !== fp) continue;   // stale boundary generation
      const ch = chunks.find(c => c && c.idx === idx) || { idx };
      chapBody.push(chapterText(a, ch, idx + 1));
      chapBody.push('');
      nChap++;
    }
    lines.push('');
    lines.push('【章のまとめ】  ' + nChap + '章');
    lines.push('');
    lines.push(chapBody.length ? chapBody.join('\n') : '(まだ要約がありません)');

    // characters
    let cstate = null;
    try { if (window.aiCharacters && window.aiCharacters.openState) cstate = await window.aiCharacters.openState(titleId); } catch (_) {}
    const list = (cstate && Array.isArray(cstate.list)) ? cstate.list : [];
    const idToSurface = {};
    for (const r of list) if (r && r.id) idToSurface[r.id] = r.surface || r.id;
    lines.push('');
    lines.push(bar);
    lines.push('【登場人物】  ' + list.length + '人');
    lines.push('');
    if (list.length) {
      for (const r of list) { lines.push(charText(r, idToSurface)); lines.push(''); }
    } else {
      lines.push('(まだ登場人物の情報がありません)');
    }
    return { text: lines.join('\n'), name, nChap, nChar: list.length };
  }

  // ---- save a .txt file (Filesystem; best-effort) ----------------------------
  async function saveTxt(name, text) {
    try {
      const fs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!fs) { toast('File save unavailable'); return; }
      const safe = String(name || 'book').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
      const fname = safe + ' — AI記録.txt';
      await fs.writeFile({
        path: fname, data: text, directory: fs.Directory.Documents, encoding: 'utf8',
      });
      toast('Saved: ' + fname);
    } catch (e) {
      try { toast('Save failed'); } catch (_) {}
    }
  }

  // ---- export overlay --------------------------------------------------------
  async function run(titleId) {
    try {
      const id = titleId || window._activeTitleId;
      if (!id) { toast('Open a book first'); return; }
      const prev = document.getElementById('kaiExportOverlay');
      if (prev) prev.remove();

      const ov = document.createElement('div');
      ov.id = 'kaiExportOverlay';
      ov.style.cssText =
        'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.9);display:flex;' +
        'flex-direction:column;box-sizing:border-box;padding:calc(10px + env(safe-area-inset-top,0px)) ' +
        '10px calc(10px + env(safe-area-inset-bottom,0px));';

      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center;';
      const mkB = (txt, fn, hot) => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'background:' + (hot ? '#2a2440' : '#1c1c24') + ';border:1px solid ' +
          (hot ? '#6f5fc0' : '#333') + ';border-radius:8px;color:' + (hot ? '#cbbfee' : '#aaa') +
          ';font-size:.82rem;padding:7px 16px;cursor:pointer;';
        b.addEventListener('click', fn);
        return b;
      };
      const title = document.createElement('div');
      title.style.cssText = 'flex:1;min-width:120px;color:#888;font-size:.78rem;';
      title.textContent = 'AI reading record';

      const ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = 'Building…';
      ta.style.cssText =
        'flex:1;background:#0d0d12;color:#ddd;border:1px solid #2a2a2a;border-radius:8px;' +
        'font-family:-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.6;padding:12px;' +
        'white-space:pre-wrap;overflow:auto;-webkit-overflow-scrolling:touch;';

      bar.appendChild(title);
      bar.appendChild(mkB('Copy all', async () => {
        const ok = await copyText(ta.value); toast(ok ? 'Copied' : 'Copy failed');
      }, true));
      let docName = 'book';
      bar.appendChild(mkB('Save .txt', () => saveTxt(docName, ta.value)));
      bar.appendChild(mkB('Close', () => ov.remove()));
      ov.appendChild(bar);
      ov.appendChild(ta);
      document.body.appendChild(ov);

      const built = await buildDocument(id);
      ta.value = built.text;
      docName = built.name;
      title.textContent = built.nChap + ' chapters · ' + built.nChar + ' characters';
    } catch (e) {
      try { toast('Export failed'); } catch (_) {}
    }
  }

  window.aiExport = { run, copyText, chapterText, charText, toast };
})();
