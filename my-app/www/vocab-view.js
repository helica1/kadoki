// vocab-view.js — the Card tab's "Vocabulary" view for BOOK titles.
//
// A PANE below the app header (the mode tabs stay live for navigation).
// Three sections for the ACTIVE title, in this order: words sent to Anki,
// words looked up but not sent, AI-chosen words (vocab SRS picks). Every row
// has a play button for its sentence; tapping a lookup row opens the entry
// in the lookup viewer's pane layout (context + dictionary, Play, Back).
// Data comes from lookup-log.js (LOOKUP_LOG_V1) and vocab-srs.js
// (VOCAB_SRS_V1) — nothing new is stored here.
(function () {
  'use strict';
  const T = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;

  function ensureStyles() {
    if (document.getElementById('vocabViewStyle')) return;
    const st = document.createElement('style');
    st.id = 'vocabViewStyle';
    st.textContent = `
#vocabPane { position:fixed; left:0; right:0; top:calc(env(safe-area-inset-top,0px) + 48px); bottom:0; z-index:8900;
  display:flex; flex-direction:column; color:#e8e8f0; overflow:hidden; direction:ltr;
  background: radial-gradient(120% 70% at 50% -10%, rgba(76,175,80,.14), transparent 60%),
              linear-gradient(180deg, #13131a, #0a0a0e); }
#vocabPane .vv-head { padding:14px 18px 6px; display:flex; align-items:baseline; gap:10px; flex:none; }
#vocabPane .vv-title { font-weight:800; font-size:1.25rem; letter-spacing:.01em; color:#fff; text-shadow:0 0 18px rgba(76,175,80,.3); }
#vocabPane .vv-sub { color:#8a8a96; font-size:.78rem; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#vocabPane .vv-list { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;
  padding:4px 14px calc(env(safe-area-inset-bottom,0px) + 24px); }
.vv-sec { display:flex; align-items:center; gap:8px; padding:18px 6px 8px; font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; color:var(--vv-accent,#9a9aa6); opacity:.9; }
.vv-sec b { color:#6a6a76; font-weight:600; }
.vv-row { position:relative; margin:7px 0; padding:12px 58px 12px 14px; border-radius:16px; cursor:pointer;
  background:linear-gradient(180deg, rgba(42,42,54,.62), rgba(26,26,34,.62));
  border:1px solid rgba(255,255,255,.10);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 8px 24px rgba(0,0,0,.35);
  -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
  transition: transform .12s ease, filter .12s ease; }
.vv-row:active { filter:brightness(1.15); transform:translateY(1px); }
.vv-word { font-weight:800; font-size:1.12rem; color:#f4f7ff; text-shadow:0 0 14px var(--vv-glow, rgba(183,148,246,.25)); }
.vv-base { color:#9a9aa6; font-size:.8rem; margin-left:8px; }
.vv-sent { color:#b9b9c4; font-size:.86rem; line-height:1.55; margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.vv-sent .hl { color:var(--vv-accent,#4caf50); font-weight:700; }
.vv-play { position:absolute; right:12px; top:50%; transform:translateY(-50%); width:36px; height:36px; border-radius:50%;
  border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.07); color:#f0f0f2; font-size:.85rem;
  display:flex; align-items:center; justify-content:center; box-shadow: inset 0 1px 0 rgba(255,255,255,.12); cursor:pointer; }
.vv-play:active { filter:brightness(1.3); }
.vv-empty { color:#8a8a96; font-size:.92rem; padding:44px 22px; text-align:center; line-height:1.65; }
`;
    document.head.appendChild(st);
  }

  function sectionEl(label, count, accent) {
    const h = document.createElement('div');
    h.className = 'vv-sec';
    h.style.setProperty('--vv-accent', accent);
    h.innerHTML = '<span></span><b></b>';
    h.firstChild.textContent = label;
    h.lastChild.textContent = String(count);
    return h;
  }
  function sentenceEl(sentence, term) {
    const s = document.createElement('div');
    s.className = 'vv-sent';
    const i = term ? sentence.indexOf(term) : -1;
    if (i >= 0) {
      s.appendChild(document.createTextNode(sentence.slice(0, i)));
      const hl = document.createElement('span'); hl.className = 'hl'; hl.textContent = term;
      s.appendChild(hl);
      s.appendChild(document.createTextNode(sentence.slice(i + term.length)));
    } else s.textContent = sentence;
    return s;
  }
  function rowEl(word, sub, sentence, accent, glow, onTap, clip) {
    const row = document.createElement('div');
    row.className = 'vv-row';
    row.style.setProperty('--vv-accent', accent);
    row.style.setProperty('--vv-glow', glow);
    const top = document.createElement('div');
    const w = document.createElement('span'); w.className = 'vv-word'; w.textContent = word;
    top.appendChild(w);
    if (sub) { const b = document.createElement('span'); b.className = 'vv-base'; b.textContent = sub; top.appendChild(b); }
    row.appendChild(top);
    if (sentence) row.appendChild(sentenceEl(sentence, word));
    if (clip && clip.src && Number.isFinite(clip.startMs) && Number.isFinite(clip.endMs)) {
      const pb = document.createElement('button');
      pb.className = 'vv-play'; pb.textContent = '▶'; pb.setAttribute('aria-label', 'Play');
      pb.addEventListener('click', (ev) => {
        ev.stopPropagation(); try { window.kHaptic?.(); } catch (_) {}
        Promise.resolve(window.rebaseContainerPath ? window.rebaseContainerPath(clip.src) : clip.src).then((src) => {
          try { window.aiTimelineClip?.play?.({ startMs: clip.startMs, endMs: clip.endMs }, pb, src || clip.src); } catch (_) {}
        }).catch(() => {});
      });
      row.appendChild(pb);
    }
    if (onTap) row.addEventListener('click', () => { try { window.kHaptic?.(); } catch (_) {} onTap(); });
    return row;
  }

  function close() {
    const had = !!document.getElementById('vocabPane');
    try { document.getElementById('vocabPane')?.remove(); } catch (_) {}
    if (had) { window._statsPaneOpen = false; try { window.stats?.resumeFromModal?.(); } catch (_) {} }
  }

  async function open() {
    const tid = window._activeTitleId;
    if (!tid) return;
    ensureStyles();
    close();
    let title = null;
    try { title = await window.titleStore?.get?.(tid); } catch (_) {}
    let entries = [];
    try { entries = (await window.lookupLog?.entries?.()) || []; } catch (_) {}
    const mine = entries.filter((e) => e && e.titleId === tid);
    const anki = mine.filter((e) => e.ankiSentTs);
    const looked = mine.filter((e) => !e.ankiSentTs);
    let ai = [];
    try { ai = (await window.vocabSrs?.listForTitle?.(tid)) || []; } catch (_) {}
    ai = ai.slice().sort((a, b) => (b.addedTs || 0) - (a.addedTs || 0));
    const audioSrc = window._pagedAudioPath || window.__abAudioPath || (title && title.attachments && title.attachments.audiobook && title.attachments.audiobook.cachePath) || null;

    const pane = document.createElement('div');
    pane.id = 'vocabPane';
    pane.className = 'kai-modal';
    const head = document.createElement('div');
    head.className = 'vv-head';
    head.innerHTML = '<div class="vv-title"></div><div class="vv-sub"></div>';
    head.firstChild.textContent = T('vv.title', 'Vocabulary');
    head.lastChild.textContent = (title && title.name) || '';
    pane.appendChild(head);
    const list = document.createElement('div');
    list.className = 'vv-list';
    if (!anki.length && !looked.length && !ai.length) {
      const empty = document.createElement('div');
      empty.className = 'vv-empty';
      empty.textContent = T('vv.empty', 'Nothing yet for this title. Words you look up, send to Anki, or that the AI picks will appear here.');
      list.appendChild(empty);
    }
    const openEntry = (e) => {
      close();
      try { window.lookupLog.openViewer(mine, mine.indexOf(e), { pane: true, onBack: () => { open(); } }); } catch (_) {}
    };
    // Live path first (the entry belongs to the active title): a stored
    // absolute path can be stale after an iOS reinstall.
    const clipFor = (e) => ({ src: audioSrc || e.cueAudioPath, startMs: e.cueStartMs, endMs: e.cueEndMs });
    const ACC = { anki: ['var(--accent-card,#ff9550)', 'rgba(255,149,80,.28)'], look: ['var(--accent-read,#4caf50)', 'rgba(76,175,80,.28)'], ai: ['var(--accent-audio,#b794f6)', 'rgba(183,148,246,.3)'] };
    if (anki.length) {
      list.appendChild(sectionEl(T('vv.sec_anki', 'Sent to Anki'), anki.length, ACC.anki[0]));
      for (const e of anki) list.appendChild(rowEl(e.term || e.base || '', (e.base && e.base !== e.term) ? e.base : '', e.sentence || '', ACC.anki[0], ACC.anki[1], () => openEntry(e), clipFor(e)));
    }
    if (looked.length) {
      list.appendChild(sectionEl(T('vv.sec_lookups', 'Looked up'), looked.length, ACC.look[0]));
      for (const e of looked) list.appendChild(rowEl(e.term || e.base || '', (e.base && e.base !== e.term) ? e.base : '', e.sentence || '', ACC.look[0], ACC.look[1], () => openEntry(e), clipFor(e)));
    }
    if (ai.length) {
      list.appendChild(sectionEl(T('vv.sec_ai', 'AI picks'), ai.length, ACC.ai[0]));
      for (const c of ai) {
        // AI picks: tap looks the word up in place via the dictionary, with the
        // pick's own sentence as context (same viewer pane as lookups).
        const asEntry = { term: c.word || '', base: c.word || '', sentence: c.context || '', pre: '', post: '',
          titleId: tid, titleName: (title && title.name) || '', cueStartMs: c.startMs, cueEndMs: c.endMs,
          cueAudioPath: audioSrc, ts: c.addedTs || 0, source: 'ai', ankiSentTs: 0 };
        list.appendChild(rowEl(c.word || '', c.reading || '', c.context || '', ACC.ai[0], ACC.ai[1], () => {
          close();
          try { window.lookupLog.openViewer([asEntry], 0, { pane: true, onBack: () => { open(); } }); } catch (_) {}
        }, { src: audioSrc, startMs: c.startMs, endMs: c.endMs }));
      }
    }
    pane.appendChild(list);
    document.body.appendChild(pane);
    window._statsPaneOpen = true;   // the third "mode": no read/audio time accrues here (stats.startMode gate)
    try { window.stats?.pauseForModal?.(); } catch (_) {}
  }

  window.vocabView = { open, close };
})();
