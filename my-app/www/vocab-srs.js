// vocab-srs.js — lightweight in-app spaced review over the AI vocab picks
// (the 語彙 section of chapter summaries). Deliberately NOT a general SRS:
// cards come ONLY from vocab entries (＋ button on the vocab rows), keep all
// their context (book/cover, chapter, verbatim sentence, resolved audio
// bounds), and review front/back is the vocab card itself:
//   FRONT: word (furigana hidden — tap the word to peek) + context sentence
//          with the word bolded + ▶ audio clip.
//   BACK:  same + the AI definition inset; furigana auto-revealed.
// The built-in dictionary works on the context text (no stored definitions).
//
// Scheduler: two-button (もう一度 / OK) graduated intervals — 1, 3, 7, 16, 35
// days then ×2.2 capped at 365. Again → back into this session (+10 min due).
// This is intentionally simple; the user retired from Anki and wants light
// review, not a collection manager.
//
// Store: blobStore VOCAB_SRS_V1 = { v:1, cards:[{ id, titleId, chapterIdx,
// word, reading, note, context, anchorOff, startMs, endMs, addedTs, due,
// ivlDays, reps, lapses, lastTs }] }. id = titleId|chapterIdx|word.
//
// Audio: bounds are resolved (word-timed) at ADD time while the title is
// active; review re-resolves live only when the card's title IS the active
// title, else plays the stored bounds. Playback goes through ai-timeline's
// clip player (window.aiTimelineClip) — the place-safe dedicated <audio>
// path; the book playhead is NEVER seeked (hard invariant).
(function () {
  'use strict';

  const KEY = 'VOCAB_SRS_V1';
  let _store = null, _loading = null;

  async function load() {
    if (_store) return _store;
    if (_loading) { await _loading; return _store; }
    _loading = (async () => {
      let s = null;
      try {
        const raw = window.blobStore ? await window.blobStore.get(KEY) : null;
        if (raw) s = JSON.parse(raw);
      } catch (_) {}
      if (!s || s.v !== 1 || !Array.isArray(s.cards)) s = { v: 1, cards: [] };
      _store = s; _loading = null;
    })();
    await _loading;
    return _store;
  }
  function save() {
    if (!_store || !window.blobStore) return;
    try { window.blobStore.set(KEY, JSON.stringify(_store)).catch(() => {}); } catch (_) {}
  }
  const cardId = (titleId, chapterIdx, word) => titleId + '|' + (chapterIdx | 0) + '|' + word;

  async function has(titleId, chapterIdx, word) {
    const s = await load();
    const id = cardId(titleId, chapterIdx, word);
    return s.cards.some(c => c && c.id === id);
  }
  // entry: { titleId, chapterIdx, word, reading, note, context, anchorOff, startMs, endMs }
  async function add(entry) {
    if (!entry || !entry.titleId || !entry.word || !entry.context) return false;
    const s = await load();
    const id = cardId(entry.titleId, entry.chapterIdx, entry.word);
    if (s.cards.some(c => c && c.id === id)) return true;
    const now = Date.now();
    s.cards.push({
      id, titleId: entry.titleId, chapterIdx: entry.chapterIdx | 0,
      word: String(entry.word), reading: String(entry.reading || ''),
      note: String(entry.note || ''), context: String(entry.context),
      anchorOff: Number.isFinite(entry.anchorOff) ? entry.anchorOff : undefined,
      startMs: Number.isFinite(entry.startMs) ? Math.round(entry.startMs) : undefined,
      endMs: Number.isFinite(entry.endMs) ? Math.round(entry.endMs) : undefined,
      addedTs: now, due: now, ivlDays: 0, reps: 0, lapses: 0, lastTs: 0,
    });
    save();
    return true;
  }
  async function remove(titleId, chapterIdx, word) {
    const s = await load();
    const id = cardId(titleId, chapterIdx, word);
    const n = s.cards.length;
    s.cards = s.cards.filter(c => !c || c.id !== id);
    if (s.cards.length !== n) save();
    return s.cards.length !== n;
  }
  async function counts() {
    const s = await load();
    const now = Date.now();
    return { total: s.cards.length, due: s.cards.filter(c => c && c.due <= now).length };
  }

  // Review-frequency preference (SRS hub): multiplier on the scheduled gap.
  // '0.6' = more often, '1' = standard, '1.6' = less often. Applied at DUE
  // computation only — the base interval ladder stays untouched, so changing
  // the preference affects future grades, not past schedules.
  const FREQ_KEY = 'VOCAB_SRS_FREQ';
  function freqMult() {
    try {
      const v = parseFloat(localStorage.getItem(FREQ_KEY));
      if (v === 0.6 || v === 1 || v === 1.6) return v;
    } catch (_) {}
    return 1;
  }
  function setFreqMult(v) {
    try { localStorage.setItem(FREQ_KEY, String(v)); } catch (_) {}
  }

  function gradeCard(c, good, now) {
    c.lastTs = now;
    if (!good) {
      c.lapses = (c.lapses | 0) + 1;
      c.ivlDays = 0;
      c.due = now + 10 * 60000;
      return;
    }
    c.reps = (c.reps | 0) + 1;
    const seq = [1, 3, 7, 16, 35];
    const cur = c.ivlDays | 0;
    const next = cur < 1 ? 1 : (seq.find(x => x > cur) || Math.min(365, Math.round(cur * 2.2)));
    c.ivlDays = next;
    c.due = now + Math.round(next * freqMult() * 86400000);
  }

  // ---- shared bits with the vocab card renderer -----------------------------
  function ensureStyles() {
    if (document.getElementById('kaiVocabStyles')) return;
    const st = document.createElement('style');
    st.id = 'kaiVocabStyles';
    st.textContent =
      '.kai-vocab-word ruby rt { color:var(--accent-card, #ff9550); font-size:.5em; font-weight:600; visibility:hidden; }' +
      '.kai-vocab-word.kai-furi-show ruby rt { visibility:visible; }';
    document.head.appendChild(st);
  }
  function boldWordIn(el, word) {
    try {
      const t = el.textContent, w = String(word || '');
      let hit = '';
      for (let L = w.length; L >= 2; L--) { const p = w.slice(0, L); if (t.indexOf(p) >= 0) { hit = p; break; } }
      if (!hit) return;
      const escH = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      el.innerHTML = t.split(hit).map(escH)
        .join('<b style="font-weight:800;color:#efe9fb;">' + escH(hit) + '</b>');
    } catch (_) {}
  }

  // ---- review overlay -------------------------------------------------------
  async function openReview() {
    try {
      const prev = document.getElementById('kvocabReview');
      if (prev) prev.remove();
      const s = await load();
      const now = Date.now();
      let queue = s.cards.filter(c => c && c.due <= now).sort((a, b) => a.due - b.due);
      let ahead = false;
      if (!queue.length) {
        // Nothing due — offer the nearest-due handful as an optional warmup.
        queue = s.cards.slice().sort((a, b) => a.due - b.due).slice(0, 10);
        ahead = true;
      }
      const total0 = queue.length;

      const overlay = document.createElement('div');
      overlay.id = 'kvocabReview';
      // kai-modal blocks background swipe gestures (hard rule); kai-srs-page
      // credits review time to its OWN stats bucket (separate from AI
      // material — stats.js suppresses the ai timer while this is open).
      overlay.className = 'kai-modal kai-srs-page';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.6);' +
        'display:flex;align-items:center;justify-content:center;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 8px calc(8px + env(safe-area-inset-bottom, 0px));';
      const stop = (e) => e.stopPropagation();
      for (const ev of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'click']) {
        overlay.addEventListener(ev, stop, { passive: true });
      }
      const card = document.createElement('div');
      card.style.cssText =
        'background:#141414;border:1px solid #2a2a2a;border-radius:14px;width:min(96vw,600px);' +
        'height:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';
      overlay.appendChild(card);
      ensureStyles();

      const close = () => {
        try { window.aiTimelineClip && window.aiTimelineClip.dispose && window.aiTimelineClip.dispose(); } catch (_) {}
        try { overlay.remove(); } catch (_) {}
      };

      // header: cover + book name + progress + ✕ (cover/name filled per card)
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #242424;';
      const cover = document.createElement('img');
      cover.style.cssText = 'width:34px;height:48px;object-fit:cover;border-radius:5px;background:#222;flex:none;display:none;';
      const hInfo = document.createElement('div');
      hInfo.style.cssText = 'flex:1;min-width:0;';
      const hTitle = document.createElement('div');
      hTitle.style.cssText = 'font-weight:600;color:#eee;font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      hTitle.textContent = window.i18n.t('vs.title', '語彙の復習');
      const hSub = document.createElement('div');
      hSub.style.cssText = 'color:#999;font-size:.74rem;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      hInfo.appendChild(hTitle); hInfo.appendChild(hSub);
      const prog = document.createElement('div');
      prog.style.cssText = 'flex:none;color:#8a7fb8;font-size:.86rem;font-weight:700;';
      const xb = document.createElement('button');
      xb.textContent = '✕';
      xb.style.cssText = 'background:none;border:1px solid #333;border-radius:8px;color:#ccc;font-size:1.15rem;padding:7px 14px;cursor:pointer;line-height:1.1;flex:none;';
      xb.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      head.appendChild(cover); head.appendChild(hInfo); head.appendChild(prog); head.appendChild(xb);
      card.appendChild(head);

      const content = document.createElement('div');
      content.style.cssText = 'flex:1;overflow-y:auto;padding:18px 16px;background:#141414;display:flex;flex-direction:column;gap:14px;';
      card.appendChild(content);

      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;gap:10px;padding:10px 12px calc(10px + env(safe-area-inset-bottom, 0px));border-top:1px solid #242424;';
      card.appendChild(foot);

      const mkFootBtn = (txt, accent) => {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'flex:1;background:' + (accent ? '#1d1830' : '#1c1c24') + ';border:1px solid ' +
          (accent ? '#463a6b' : '#333') + ';border-radius:10px;color:' + (accent ? '#cbbfee' : '#ccc') +
          ';font-size:1rem;font-weight:600;padding:13px 10px;cursor:pointer;';
        return b;
      };

      let done = 0;
      const titleCache = {};
      async function titleFor(id) {
        if (titleCache[id] !== undefined) return titleCache[id];
        let t = null;
        try { t = await window.titleStore.get(id); } catch (_) {}
        titleCache[id] = t || null;
        return titleCache[id];
      }

      async function showCard(c) {
        prog.textContent = (done + 1) + ' / ' + total0;
        content.innerHTML = '';
        foot.innerHTML = '';
        try { window.aiTimelineClip && window.aiTimelineClip.dispose && window.aiTimelineClip.dispose(); } catch (_) {}

        // header context for THIS card
        const t = await titleFor(c.titleId);
        const cov = t && t.attachments && t.attachments.cover && t.attachments.cover.dataUri;
        if (cov) { cover.src = cov; cover.style.display = 'block'; } else { cover.style.display = 'none'; }
        hSub.textContent = (t && (t.name || t.title)) || '';

        // FRONT: word (furigana hidden; tap to peek)
        const wordEl = document.createElement('div');
        wordEl.className = 'kai-vocab-word';
        wordEl.style.cssText = 'align-self:center;margin-top:6px;font-weight:700;color:#e2d9f5;' +
          'font-family:var(--font-family-card);font-size:calc(var(--font-size-card, 1rem) * 1.5);line-height:1.9;' +
          'background:#221d33;border:1px solid #463a6b;border-radius:12px;padding:5px 22px 6px;cursor:pointer;';
        let rubyOk = false;
        try {
          const rb = (typeof window.buildFuriganaRuby === 'function')
            ? window.buildFuriganaRuby(c.word, c.reading || '') : null;
          if (rb && rb.html) { wordEl.innerHTML = rb.html; rubyOk = rb.hasRuby; }
        } catch (_) {}
        if (!wordEl.innerHTML) wordEl.textContent = c.word;
        wordEl.addEventListener('click', (e) => { e.stopPropagation(); wordEl.classList.toggle('kai-furi-show'); });
        content.appendChild(wordEl);

        // context sentence (dict-enabled leaf) + ▶ clip
        const ctxRow = document.createElement('div');
        ctxRow.style.cssText = 'display:flex;align-items:flex-end;gap:10px;background:#191722;border-radius:10px;box-shadow:inset 3px 0 0 #6f5fc0;padding:11px 14px 10px;';
        const ctx = document.createElement('div');
        ctx.className = 'kai-summary-text';
        ctx.style.cssText = 'flex:1;min-width:0;color:#d6d6de;font-family:var(--font-family-card);' +
          'font-size:var(--font-size-card);line-height:1.7;white-space:pre-wrap;';
        ctx.textContent = c.context;
        boldWordIn(ctx, c.word);
        ctxRow.appendChild(ctx);
        const pb = document.createElement('button');
        pb.textContent = '▶';
        pb.style.cssText = 'flex:none;background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;font-size:.78rem;padding:4px 13px;cursor:pointer;';
        pb.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const tt = await titleFor(c.titleId);
            const srcPath = (tt && tt.attachments && tt.attachments.audiobook && tt.attachments.audiobook.cachePath) || '';
            let bounds = null;
            // Live re-resolve (word-timed) when this card's book is the active
            // title; otherwise the bounds stored at add time.
            if (c.titleId === window._activeTitleId && window.aiChunks && window.aiChunks.cueRangeForQuote) {
              try {
                const loc = await window.aiChunks.cueRangeForQuote(c.titleId, c.chapterIdx, c.context, { anchorOff: c.anchorOff, tight: true });
                if (loc && Number.isFinite(loc.startMs) && Number.isFinite(loc.endMs) && loc.endMs > loc.startMs) {
                  bounds = { startMs: loc.startMs, endMs: loc.endMs };
                }
              } catch (_) {}
            }
            if (!bounds && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs) {
              bounds = { startMs: c.startMs, endMs: c.endMs };
            }
            if (!srcPath || !bounds || !window.aiTimelineClip || !window.aiTimelineClip.play) {
              try { window.showToast && window.showToast(window.i18n.t('tl.no_audio', '音声なし'), 2000); } catch (_) {}
              return;
            }
            window.aiTimelineClip.play(bounds, pb, srcPath);
          } catch (_) {}
        });
        ctxRow.appendChild(pb);
        content.appendChild(ctxRow);
        try { if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(ctx); } catch (_) {}

        // BACK: definition inset (hidden until reveal)
        const noteEl = document.createElement('div');
        noteEl.style.cssText = 'display:none;margin:0 2px;padding:8px 12px;background:#1c1930;border-radius:8px;' +
          'box-shadow:inset 2px 0 0 #6f5fc0;color:#c5bede;' +
          'font-size:calc(var(--font-size-card, 1rem) * .92);line-height:1.6;';
        noteEl.textContent = c.note || (c.reading ? '（' + c.reading + '）' : '');
        content.appendChild(noteEl);

        const next = () => {
          if (!queue.length) {
            content.innerHTML = '';
            foot.innerHTML = '';
            prog.textContent = '';
            cover.style.display = 'none';
            hSub.textContent = '';
            const doneEl = document.createElement('div');
            doneEl.style.cssText = 'margin:auto;text-align:center;color:#cbbfee;font-size:1.1rem;font-weight:700;';
            doneEl.textContent = window.i18n.t('vs.done', '復習 完了！');
            content.appendChild(doneEl);
            const ok = mkFootBtn('✕', false);
            ok.addEventListener('click', (e) => { e.stopPropagation(); close(); });
            foot.appendChild(ok);
            return;
          }
          showCard(queue[0]);
        };

        const reveal = mkFootBtn(window.i18n.t('vs.show_answer', '答えを見る'), true);
        reveal.addEventListener('click', (e) => {
          e.stopPropagation();
          noteEl.style.display = 'block';
          if (rubyOk) wordEl.classList.add('kai-furi-show');
          foot.innerHTML = '';
          const again = mkFootBtn(window.i18n.t('vs.again', 'もう一度'), false);
          again.style.color = '#e0a0a0';
          const good = mkFootBtn(window.i18n.t('vs.good', 'OK'), true);
          again.addEventListener('click', (e2) => {
            e2.stopPropagation();
            gradeCard(c, false, Date.now()); save();
            queue.shift(); queue.push(c);   // re-shows this session
            showCard(queue[0]);
          });
          good.addEventListener('click', (e2) => {
            e2.stopPropagation();
            gradeCard(c, true, Date.now()); save();
            queue.shift(); done++;
            next();
          });
          foot.appendChild(again); foot.appendChild(good);
        });
        foot.appendChild(reveal);
      }

      document.body.appendChild(overlay);
      if (!queue.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'margin:auto;text-align:center;color:#999;font-size:.95rem;';
        empty.textContent = window.i18n.t('vs.none_saved', '保存された語彙がありません（章の語彙カードの ＋ で追加）');
        content.appendChild(empty);
        const ok = mkFootBtn('✕', false);
        ok.addEventListener('click', (e) => { e.stopPropagation(); close(); });
        foot.appendChild(ok);
        return;
      }
      if (ahead) {
        try { window.showToast && window.showToast(window.i18n.t('vs.ahead_note', '期限の復習はありません — 先取りで復習します'), 2500); } catch (_) {}
      }
      showCard(queue[0]);
    } catch (e) {
      try { console.log('[vocab-srs] openReview failed: ' + (e && e.message)); } catch (_) {}
    }
  }

  // ---- SRS hub (hamburger → SRS…): due counts, start button, preferences ---
  async function openHub() {
    try {
      const prev = document.getElementById('kvocabHub');
      if (prev) prev.remove();
      const c = await counts();

      const overlay = document.createElement('div');
      overlay.id = 'kvocabHub';
      overlay.className = 'kai-modal';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.55);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      for (const ev of ['touchstart', 'touchmove', 'touchend']) {
        overlay.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
      }
      const card = document.createElement('div');
      card.style.cssText =
        'background:#161620;border:1px solid #2a2a2a;border-radius:14px;width:min(92vw,420px);' +
        'padding:16px 16px 14px;display:flex;flex-direction:column;gap:14px;';
      card.addEventListener('click', (e) => e.stopPropagation());
      overlay.appendChild(card);

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const ht = document.createElement('div');
      ht.style.cssText = 'flex:1;font-weight:700;color:#eee;font-size:1.05rem;';
      ht.textContent = window.i18n.t('vs.title', '語彙の復習');
      const xb = document.createElement('button');
      xb.textContent = '✕';
      xb.style.cssText = 'background:none;border:1px solid #333;border-radius:8px;color:#ccc;font-size:1.05rem;padding:6px 12px;cursor:pointer;line-height:1.1;';
      xb.addEventListener('click', () => overlay.remove());
      head.appendChild(ht); head.appendChild(xb);
      card.appendChild(head);

      const stat = document.createElement('div');
      stat.style.cssText = 'color:#aab;font-size:.95rem;line-height:1.6;';
      stat.textContent = window.i18n.fmt('vs.hub_counts', { due: c.due, total: c.total },
        '今日の復習: ' + c.due + '件 · 保存語彙: ' + c.total + '語');
      card.appendChild(stat);

      const start = document.createElement('button');
      start.style.cssText = 'background:#1d1830;border:1px solid #463a6b;border-radius:10px;color:#cbbfee;' +
        'font-size:1.05rem;font-weight:700;padding:14px 10px;cursor:pointer;';
      start.textContent = window.i18n.t('vs.start', '復習を始める') + (c.due > 0 ? '（' + c.due + '）' : '');
      start.disabled = c.total === 0;
      if (c.total === 0) start.style.opacity = '.4';
      start.addEventListener('click', () => { overlay.remove(); openReview(); });
      card.appendChild(start);

      // preferences: review frequency (interval multiplier)
      const prefLab = document.createElement('div');
      prefLab.style.cssText = 'color:#8a7fb8;font-size:.78rem;font-weight:700;letter-spacing:.1em;margin-top:2px;';
      prefLab.textContent = window.i18n.t('vs.freq', '復習の頻度');
      card.appendChild(prefLab);
      const seg = document.createElement('div');
      seg.style.cssText = 'display:flex;gap:8px;';
      const opts = [
        { v: 0.6, label: window.i18n.t('vs.freq_more', '多め') },
        { v: 1,   label: window.i18n.t('vs.freq_std', '標準') },
        { v: 1.6, label: window.i18n.t('vs.freq_less', '少なめ') },
      ];
      const btns = [];
      const paintSeg = () => {
        const cur = freqMult();
        for (const b of btns) {
          const on = b._v === cur;
          b.style.background = on ? '#221d33' : '#1c1c24';
          b.style.borderColor = on ? '#6f5fc0' : '#333';
          b.style.color = on ? '#cbbfee' : '#888';
        }
      };
      for (const o of opts) {
        const b = document.createElement('button');
        b._v = o.v;
        b.textContent = o.label;
        b.style.cssText = 'flex:1;border:1px solid #333;border-radius:9px;font-size:.92rem;font-weight:600;padding:10px 6px;cursor:pointer;';
        b.addEventListener('click', () => { setFreqMult(o.v); paintSeg(); });
        seg.appendChild(b); btns.push(b);
      }
      paintSeg();
      card.appendChild(seg);
      const prefNote = document.createElement('div');
      prefNote.style.cssText = 'color:#666;font-size:.74rem;line-height:1.5;';
      prefNote.textContent = window.i18n.t('vs.freq_note', '間隔の伸び方に反映されます（次の採点から）');
      card.appendChild(prefNote);

      document.body.appendChild(overlay);
    } catch (_) {}
  }

  window.vocabSrs = { add, remove, has, counts, openReview, openHub };
})();
