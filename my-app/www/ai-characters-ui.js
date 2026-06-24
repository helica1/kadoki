// ai-characters-ui.js — character name squiggles + tap popup (AI plan slice 4,
// card/audio surfaces; the paged-reader overlay path is a later slice).
//
// All three subtitle surfaces render text as per-char .dict-frag spans
// (.subtitle-text, #comboSubtitle's .combo-cue children, #audiobookCueText),
// so marking a known character name = adding .kchar-name to the spans the
// name covers. Tap handling runs document-level in CAPTURE phase so it wins
// over the spans' own dict-lookup handlers; everything else about the dict
// pipeline is untouched.
(function () {
  'use strict';

  const POLL_MS = 1500;
  const CONTAINERS = '.subtitle-text, #comboSubtitle, #audiobookCueText, .kai-summary-text';

  // ---- style -------------------------------------------------------------
  // The squiggle is a GPU-COMPOSITED background-image wavy SVG, NOT
  // `text-decoration: underline wavy`. On iOS WebKit the wavy text-decoration
  // is re-rasterized on every scroll frame, and a name-dense AI summary has
  // dozens of them → continuous repaint ("text jitter") that saturates the
  // main thread (the confirmed AI-summary lag). A background image is
  // rasterized into the scroll layer once and composited, so it does not
  // repaint on scroll. (The paged-reader overlay already uses this approach.)
  const WAVE = (op) =>
    "url(\"data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 " +
    "width=%228%22 height=%224%22><path d=%22M0 3 Q 2 0.4 4 3 T 8 3%22 fill=%22none%22 " +
    "stroke=%22rgba(150,165,255," + op + ")%22 stroke-width=%221%22/></svg>\")";
  const style = document.createElement('style');
  style.textContent =
    '.kchar-name{background-image:' + WAVE('0.6') + ';background-repeat:repeat-x;' +
    'background-position:0 100%;background-size:8px 4px;padding-bottom:2px;}' +
    '.kchar-name.kchar-stub{background-image:' + WAVE('0.34') + ';}' +
    // squiggle on/off switch (popup + Characters screen): a track+knob slider with
    // a live preview of the name showing the ACTUAL wavy underline when ON.
    '.ksq-row{display:flex;align-items:center;gap:10px;margin-top:10px;}' +
    '.ksq-sample{font-size:1rem;color:#ddd;flex:0 0 auto;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.ksq-label{font-size:.72rem;color:#b9a9e0;flex:1 1 auto;line-height:1.3;}' +
    '.ksq-switch{position:relative;width:46px;height:26px;border-radius:13px;background:#2a2440;border:1px solid #3a3450;cursor:pointer;padding:0;flex:0 0 auto;transition:background .15s,border-color .15s;}' +
    '.ksq-switch[aria-checked="true"]{background:#5a4b8c;border-color:#6f5caa;}' +
    '.ksq-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#cdbcf5;transition:left .15s;}' +
    '.ksq-switch[aria-checked="true"] .ksq-knob{left:22px;}';
  document.head.appendChild(style);

  // ---- marking -------------------------------------------------------------
  // Walk a container's tree collecting per-char entries; <br> contributes a
  // '\n' so alias matches can't span line breaks.
  function collectFrags(container) {
    const entries = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1) {
          if (ch.tagName === 'BR') { entries.push({ span: null, ch: '\n' }); continue; }
          if (ch.classList && ch.classList.contains('dict-frag')) {
            const t = ch.textContent || '';
            for (const c of t) entries.push({ span: ch, ch: c });
            continue;
          }
          walk(ch);
        }
      }
    };
    walk(container);
    return entries;
  }

  function hash32(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // ---- span-less marking for lazy AI containers (dataset.dictLazy==='1') -------
  // These containers keep their text nodes intact (no per-char dict-frag spans).
  // We flatten the text-node tree, find alias runs, and wrap ONLY matched runs
  // (tens, not thousands) in span.kchar-name. AI prose is static, so no
  // MutationObserver is installed for them — wrapping can't trigger a remark.
  function collectLazySegments(container) {
    const segments = [];   // {node, start, len}
    let flat = '';
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          const v = ch.nodeValue || '';
          if (v) { segments.push({ node: ch, start: flat.length, len: v.length }); flat += v; }
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName;
          if (tag === 'RT' || tag === 'RP') continue;
          if (tag === 'BR') { flat += '\n'; continue; }   // line boundary, no segment
          walk(ch);
        }
      }
    };
    walk(container);
    return { flat, segments };
  }

  function unwrapLazyNames(container) {
    container.querySelectorAll('.kchar-name').forEach((sp) => {
      try {
        const parent = sp.parentNode;
        if (!parent) return;
        while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
        parent.removeChild(sp);
      } catch (_) {}
    });
    try { container.normalize(); } catch (_) {}
  }

  function markContainerLazy(container, m) {
    // (Squiggles were A/B-disabled while hunting the iOS summary jitter; proven
    // NOT the cause — the trigger was border/radius on scrolled text. Re-enabled.
    // They render as a GPU-composited background-image SVG, iOS-safe.)
    const { flat, segments } = collectLazySegments(container);
    if (!flat) return;
    // Include the live wrapper count: a DOM rebuild that re-rendered the same
    // text but DROPPED our .kchar-name wrappers (caption/carousel reload, etc.)
    // changes this even when bucket+flat are identical → forces a re-mark.
    const sig = m.bucket + '|' + flat.length + '|' + container.querySelectorAll('.kchar-name').length + '|' + hash32(flat);
    if (container.dataset.kcharSig === sig) { container.dataset.kcharSigB = m.bucket; return; }

    unwrapLazyNames(container);     // remove our prior wrappers before re-walking
    // Re-flatten after unwrap (node references changed); recompute on the now
    // pristine text so wrap offsets are valid.
    const fresh = collectLazySegments(container);
    container.dataset.kcharSig = sig;
    container.dataset.kcharSigB = m.bucket;
    if (!m.map.size) return;

    const text = fresh.flat;
    const taken = new Array(text.length).fill(false);
    const aliases = Array.from(m.map.keys()).sort((a, b) => b.length - a.length);
    const runs = [];   // {at, len, rec} collected first, wrapped after (wrapping mutates the tree)
    for (const alias of aliases) {
      const rec = m.map.get(alias);
      let from = 0, at;
      while ((at = text.indexOf(alias, from)) >= 0) {
        from = at + 1;
        let free = true;
        for (let i = at; i < at + alias.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (let i = at; i < at + alias.length; i++) taken[i] = true;
        runs.push({ at, len: alias.length, alias, rec });
      }
    }
    if (!runs.length) return;
    // Wrap right-to-left so earlier splits don't invalidate later offsets within
    // a shared text node.
    runs.sort((a, b) => b.at - a.at);
    for (const run of runs) wrapLazyNameRun(fresh.segments, run);
  }

  function wrapLazyNameRun(segments, run) {
    try {
      const start = run.at, end = run.at + run.len;
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si];
        const from = Math.max(start, seg.start);
        const to = Math.min(end, seg.start + seg.len);
        if (from >= to) continue;
        let node = seg.node;
        if (!node || !node.isConnected || node.nodeType !== 3) continue;
        const localStart = from - seg.start;
        const localEnd = to - seg.start;
        let target = node;
        if (localStart > 0) target = target.splitText(localStart);
        if (localEnd - localStart < target.nodeValue.length) {
          target.splitText(localEnd - localStart);
        }
        const parent = target.parentNode;
        if (!parent) continue;
        const wrap = document.createElement('span');
        wrap.className = run.rec.isStub ? 'kchar-name kchar-stub' : 'kchar-name';
        wrap.dataset.kcharAlias = run.alias;
        parent.insertBefore(wrap, target);
        wrap.appendChild(target);
      }
    } catch (_) {}
  }

  function markContainer(container, m) {
    // Span-less AI containers (chapter view / summary / chars screen / char popup
    // bodies) keep their text nodes — wrap only matched name runs.
    if (container.dataset.dictLazy === '1') {
      // No bucket-only early-return: lazy containers have no MutationObserver, so
      // a same-bucket DOM rebuild that wiped our wrappers must still re-mark. The
      // wrapCount-aware signature inside markContainerLazy keeps this cheap (it
      // no-ops when the text AND wrapper count are unchanged).
      try { markContainerLazy(container, m); } catch (_) {}
      return;
    }
    // Fast path for the 1.5s poll: same matcher bucket + not observer-dirtied
    // → skip without flattening (the flatten allocates one object per char,
    // which at poll cadence over big AI-text containers was a real cost).
    if (container.dataset.kcharSigB === m.bucket && container.dataset.kcharSig) return;
    const entries = collectFrags(container);
    if (!entries.length) return;
    const text = entries.map(e => e.ch).join('');
    const sig = m.bucket + '|' + text.length + '|' + hash32(text);   // never store full text in an attribute
    if (container.dataset.kcharSig === sig) { container.dataset.kcharSigB = m.bucket; return; }
    container.dataset.kcharSig = sig;
    container.dataset.kcharSigB = m.bucket;

    container.querySelectorAll('.kchar-name').forEach((el) => {
      el.classList.remove('kchar-name', 'kchar-stub');
      delete el.dataset.kcharAlias;
    });

    if (!m.map.size) return;
    const taken = new Array(text.length).fill(false);
    // Longest alias first so 「黒鉄さん」 wins over 「黒鉄」 on the same run.
    const aliases = Array.from(m.map.keys()).sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const rec = m.map.get(alias);
      let from = 0, at;
      while ((at = text.indexOf(alias, from)) >= 0) {
        from = at + 1;
        let free = true;
        for (let i = at; i < at + alias.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (let i = at; i < at + alias.length; i++) {
          taken[i] = true;
          const sp = entries[i].span;
          if (sp) {
            sp.classList.add('kchar-name');
            if (rec.isStub) sp.classList.add('kchar-stub');
            sp.dataset.kcharAlias = alias;
          }
        }
      }
    }
  }

  let lastReadBucket = null;
  function pass() {
    try {
      if (window._kaiAiPaused) return;        // perf-probe kill switch
      if (document.hidden) return;
      if (!window.aiCharacters) return;
      const m = window.aiCharacters.matcher();
      if (!m) return;
      document.querySelectorAll(CONTAINERS).forEach((c) => {
        markContainer(c, m);
        // Re-mark IMMEDIATELY when the container's children are rebuilt
        // (cue swipes re-render the per-char spans, wiping the classes) —
        // the 1.5s poll alone left a visible squiggle gap. The sig cache
        // must be dropped first: same text ≠ same (fresh, unmarked) spans.
        // SKIP for lazy AI containers: their text is static, and our own
        // name-wrapping would trip the observer into a remark loop.
        if (!c.dataset.kcharObs && c.dataset.dictLazy !== '1') {
          c.dataset.kcharObs = '1';
          let t = null;
          try {
            new MutationObserver(() => {
              if (t) clearTimeout(t);
              t = setTimeout(() => {
                try {
                  if (window._kaiAiPaused) return;
                  // Became lazy after this observer was installed (summary
                  // overlay: dictLazy is set only after streaming finishes, so
                  // a poll during streaming installed this observer). Our own
                  // name-wrapping must NOT retrigger a remark → bail for good.
                  if (c.dataset.dictLazy === '1') return;
                  delete c.dataset.kcharSig;
                  delete c.dataset.kcharSigB;
                  const mm = window.aiCharacters && window.aiCharacters.matcher();
                  if (mm) markContainer(c, mm);
                } catch (_) {}
              }, 60);
            }).observe(c, { childList: true, subtree: true });
          } catch (_) {}
        }
      });
      // Paged-reader marks live in their own overlay module; poke it when
      // the visible character state changes (new snapshot/stub or position).
      if (window.aiCharsRead && m.bucket !== lastReadBucket) {
        lastReadBucket = m.bucket;
        window.aiCharsRead.refresh();
      }
    } catch (_) {}
  }
  setInterval(pass, POLL_MS);
  window.addEventListener('shell:mode-change', () => setTimeout(pass, 250));

  // ---- event-driven marking (so squiggles don't wait up to 1.5s) ---------------
  // A short retry burst covers the window where the character store is still
  // loading async (matcher() null → pass() bails); one pass is enough once it's
  // ready. Render sites (caption/summary/cards) call markNow() directly.
  function remarkSoon() {
    if (window._kaiAiPaused) return;
    pass();
    if (window.aiCharacters && window.aiCharacters.matcher()) return;  // store ready → done
    let n = 0;
    const t = setInterval(() => {
      if (window._kaiAiPaused || document.hidden) return;
      pass();
      if (++n >= 4 || (window.aiCharacters && window.aiCharacters.matcher())) clearInterval(t);
    }, 300);   // ~0.3–1.2s
  }
  function markNow(el) {
    if (window._kaiAiPaused) return;
    try {
      const m = window.aiCharacters && window.aiCharacters.matcher();
      if (m && el) { markContainer(el, m); return; }   // matcher ready → mark just this element
    } catch (_) {}
    remarkSoon();                                       // store still loading → burst
  }
  // Fired by ai-processor.js on character merge AND by ai-characters.js on
  // store-load-complete — immediate squiggles for new characters / title open.
  window.addEventListener('kai:ai-data', () => { if (!document.hidden && !window._kaiAiPaused) remarkSoon(); });
  // Content rendered while hidden/paused (no poll ran) gets marked on resume.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remarkSoon(); });

  // ---- tap → character popup ---------------------------------------------------
  // Capture-phase so the tap never reaches the span's dict-lookup handler.
  // Same scroll-vs-tap discrimination as the dict spans (8px movement).
  let tsX = 0, tsY = 0, moved = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tsX = t ? t.clientX : 0; tsY = t ? t.clientY : 0; moved = false;
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', (e) => {
    if (moved) return;
    const t = e.touches[0];
    if (t && (Math.abs(t.clientX - tsX) > 8 || Math.abs(t.clientY - tsY) > 8)) moved = true;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', (e) => {
    try {
      if (moved) return;
      // Dict popup open AND the tap is OUTSIDE it → this tap is a DISMISS. Close
      // it and do nothing else (no new lookup, no character popup). Taps INSIDE
      // the popup (Send to Anki, nav, audio buttons) must pass through to the
      // popup's own handlers — `!dp.contains` is what lets Send to Anki work.
      const dp = document.getElementById('dictPopup');
      if (dp && dp.style.display !== 'none' && !dp.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        try { window.hideDictPopup && window.hideDictPopup(); } catch (_) {}
        window._dictPopupDismissedTs = Date.now();
        return;
      }
      const m = window.aiCharacters && window.aiCharacters.matcher();
      if (!m) return;
      let rec = null;
      const hit = e.target && e.target.closest && e.target.closest('.kchar-name');
      if (hit) {
        rec = m.map.get(hit.dataset.kcharAlias);
      } else if (window.aiCharsRead && document.body.classList.contains('mode-read') &&
                 !(e.target && e.target.closest && e.target.closest('#kcharPopup, #dictPopup, #kcharsScreen, #bookmarksOverlay, .kai-modal'))) {
        // Paged reader: marks are pointer-events:none overlays — resolve the tap by
        // coordinates against the painted runs. SKIP when the tap is inside a popup/
        // overlay (e.g. the char-popup ✕) — otherwise a name painted BEHIND the popup
        // resolves here, stopPropagation kills the close button, and it "reopens".
        const t = e.changedTouches && e.changedTouches[0];
        if (t) rec = window.aiCharsRead.hitTest(t.clientX, t.clientY);
      }
      if (!rec) return;
      e.preventDefault();
      e.stopPropagation();                          // beats the dict span/reader handlers
      window._dictPopupDismissedTs = Date.now();    // reader skips a same-tap lookup
      openCharPopup(rec, m);
    } catch (_) {}
  }, { capture: true });

  // ---- popup --------------------------------------------------------------------
  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // Body text matches CARD mode typography (user-chosen font incl. custom).
  // pre-wrap: descriptions now arrive with per-sentence line breaks.
  const BODY_STYLE =
    'color:#ddd;font-family:var(--font-family-card);font-size:var(--font-size-card,1rem);' +
    'line-height:1.6;white-space:pre-wrap;';
  function sectionRaw(title, html) {
    if (!html) return '';
    return '<div style="margin-top:10px;"><div style="font-size:.68rem;color:#8a93c4;' +
           'letter-spacing:.08em;margin-bottom:2px;">' + title + '</div>' +
           '<div class="kchar-secbody" style="' + BODY_STYLE + '">' + html + '</div></div>';
  }
  function section(title, body) { return sectionRaw(title, esc(body)); }

  // (Recursive name squiggles inside popups now ride the dict-frag pipeline:
  // dictEnableLookupIn() wraps the text per-char, then markContainer() adds
  // .kchar-name on top — names → character popup, everything else → dict.)

  // ---- deep dive (動機・心理) — Sonnet over consumed text, cached ------------
  // Stored per (character, latest merged chapter): the analysis naturally
  // refreshes as chapters are processed, and re-opening at the same point is
  // free. The book-text block carries cache_control, so deep-diving several
  // characters in one sitting shares one prompt-cache write.
  const DEEP_PREFIX = 'AIDEEP_V1_';
  const DEEP_SYSTEM =
    'あなたは文学に詳しい読書アシスタントです。提供された本文(物語の冒頭から読者の現在位置まで)' +
    'のみに基づいて、指定された登場人物の動機と心理を日本語で分析してください。本文に書かれた' +
    '出来事の解釈や行間を読むことは大いに歓迎します。ただし、この作品についての外部知識と、' +
    '本文より先の展開の予測は一切禁止。' +
    '出力形式: 「・」で始まる箇条書きを5〜8項目。各項目は1〜2文、可能なら根拠となる本文の' +
    '短い引用「…」を含める。各項目のあいだに空行を1行入れる。長い段落の塊は禁止。' +
    'マークダウン記法(-、*、#)は使わない。';

  async function loadDeep(titleId) {
    try {
      const raw = window.blobStore ? await window.blobStore.get(DEEP_PREFIX + titleId) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && p.v === 1 && p.entries) ? p : { v: 1, entries: {} };
    } catch (_) { return { v: 1, entries: {} }; }
  }
  async function saveDeep(titleId, key, entry) {
    try {
      const box = await loadDeep(titleId);
      box.entries[key] = entry;
      const keys = Object.keys(box.entries);
      if (keys.length > 100) {
        keys.sort((a, b) => (box.entries[a].ts || 0) - (box.entries[b].ts || 0));
        for (const k of keys.slice(0, keys.length - 100)) delete box.entries[k];
      }
      if (window.blobStore) await window.blobStore.set(DEEP_PREFIX + titleId, JSON.stringify(box));
    } catch (_) {}
  }
  function deepKey(rec, m) {
    const idx = (m && m.state && Number.isFinite(m.state.chunkIdx)) ? m.state.chunkIdx : -1;
    return rec.id + '@' + idx;
  }

  let _deepBusy = false;
  async function runDeepDive(rec, m, host, btn) {
    if (_deepBusy) return;
    const titleId = window._activeTitleId;
    if (!titleId || !window.ai || !window.ai.isEnabled()) return;
    _deepBusy = true;
    if (btn) btn.remove();
    const out = document.createElement('div');
    out.style.cssText = BODY_STYLE + 'white-space:pre-wrap;margin-top:4px;';
    out.innerHTML = '<span class="kai-dots" style="color:#8a7fb8;"><span>·</span><span>·</span><span>·</span></span>';
    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'color:#555;font-size:.64rem;margin-top:6px;';
    host.appendChild(out);
    host.appendChild(metaEl);
    let started = false;
    try {
      const book = window.aiCharacters.contextText(60000);
      if (!book || book.length < 400) throw new Error(window.i18n.t('cu.not_enough_text', '本文がまだ十分にありません'));
      const aliasNote = (rec.aliases || []).filter(a => a !== rec.surface).join('、');
      const r = await window.ai.request({
        feature: 'char-deep',
        model: (window.ai && window.ai.modelFor) ? window.ai.modelFor('deep') : undefined,
        system: DEEP_SYSTEM,
        maxTokens: 1400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '本文(冒頭〜現在位置):\n\n' + book,
              cache_control: { type: 'ephemeral' } },
            { type: 'text',
              text: '\n\n人物「' + rec.surface + '」' +
                    (aliasNote ? '(別名: ' + aliasNote + ')' : '') +
                    'について、現在までの動機と心理を分析してください。' },
          ],
        }],
        onText: (d) => {
          if (!started) { started = true; out.textContent = ''; }
          out.textContent += d;
        },
      });
      metaEl.textContent = r.model + ' · ~$' + r.costUsd.toFixed(3);
      if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(out);
      markContainer(out, m);
      saveDeep(titleId, deepKey(rec, m), {
        ts: Date.now(), text: r.text, model: r.model, costUsd: r.costUsd,
      });
    } catch (e) {
      out.innerHTML = '';
      out.style.color = '#e08a8a';
      out.textContent = window.i18n.fmt('cu.analysis_failed', { msg: (e && e.message ? e.message : e) });
    } finally {
      _deepBusy = false;
    }
  }

  // Fills the popup's deep-dive area: cached analysis if present, otherwise
  // the analyze button (skipped for stubs — not enough material yet).
  async function wireDeepDive(rec, m, host) {
    const titleId = window._activeTitleId;
    if (!titleId || rec.isStub || !window.ai || !window.ai.isEnabled()) return;
    let cached = null;
    try { cached = (await loadDeep(titleId)).entries[deepKey(rec, m)] || null; } catch (_) {}
    if (!host.isConnected) return;                 // popup closed while loading
    if (cached && cached.text) {
      const title = document.createElement('div');
      title.style.cssText = 'font-size:.68rem;color:#8a93c4;letter-spacing:.08em;margin:10px 0 2px;';
      title.textContent = window.i18n.t('cu.motivation_psychology', '動機・心理');
      const out = document.createElement('div');
      out.style.cssText = BODY_STYLE + 'white-space:pre-wrap;';
      out.textContent = cached.text;
      host.appendChild(title);
      host.appendChild(out);
      if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(out);
      markContainer(out, m);
      return;
    }
    const btn = document.createElement('button');
    btn.style.cssText =
      'margin-top:12px;width:100%;background:#1d1830;border:1px solid #4a3c72;border-radius:8px;' +
      'color:#cdbcf5;font-size:.84rem;padding:9px 12px;cursor:pointer;';
    btn.textContent = '✦ ' + window.i18n.t('cu.analyze_motivation', '動機・心理を分析');
    btn.addEventListener('click', () => runDeepDive(rec, m, host, btn));
    host.appendChild(btn);
  }

  // Audio auto-pause while the character popup is up — same behavior (and
  // same preference) as the dict popup: fade out on open, fade back on close.
  let _charPausedAudio = false;
  function charPopupPause() {
    try {
      const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio;
      const pref = localStorage.getItem('DICT_PAUSE_ON_LOOKUP');
      if (!bg || !(pref === null || pref === 'true')) return;
      bg.getState().then((s) => {
        if (s && s.playing) {
          _charPausedAudio = true;
          bg.pause({ fadeMs: 140 });
        }
      }).catch(() => {});
    } catch (_) {}
  }
  function charPopupResume() {
    if (!_charPausedAudio) return;
    _charPausedAudio = false;
    try {
      const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundAudio;
      if (bg) bg.resume({ fadeMs: 140 });
    } catch (_) {}
  }

  // ---- shared image strip + generate UI (used by BOTH the popup and the -------
  // Characters screen card). Builds the interactive gallery (browse + crop/
  // regenerate/delete) PLUS the "画像を生成 / 別の画像を生成" control with status,
  // busy guard, queueCharacter()+sync() wiring, sticky-error surfacing, and a
  // "ローカルで再生成" local-server fallback on a cloud refusal. The screen passes
  // opts.onChange (header count refresh) and opts.registerRefresher (per-card
  // kai:img-data reload); the popup passes nothing.
  function buildCharImages(rec, opts) {
    opts = opts || {};
    const box = document.createElement('div');
    const tid = window._activeTitleId;
    if (!window.aiImages || !tid) return box;   // manual image UI for EVERY character (incl. common-word names like 僕)
    const strip = window.aiImages.buildImageStrip(tid, rec.id, {
      interactive: true, rec: rec,
      onChange: () => { try { opts && opts.onChange && opts.onChange(); } catch (_) {} },
    });
    box.appendChild(strip);
    const ctl = document.createElement('div');
    ctl.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:6px;';
    const btn = document.createElement('button');
    btn.style.cssText =
      'background:#1d1830;border:1px solid #463a6b;border-radius:8px;color:#cbbfee;' +
      'font-size:.74rem;padding:6px 12px;cursor:pointer;';
    btn.textContent = window.i18n.t('cu.generate_image', '画像を生成');
    const status = document.createElement('span');
    status.style.cssText = 'font-size:.68rem;color:#888;';
    ctl.appendChild(btn); ctl.appendChild(status);
    box.appendChild(ctl);
    let busy = false;
    let lastErr = '';   // sticky error text so refresh() doesn't mask a real failure with 生成待ち
    // Refusal fallback (the user's choice): when a cloud backend refuses a render and
    // the LOCAL server is reachable, offer a one-tap local retry; otherwise just show
    // the refusal (handled by the status text below).
    let localBtn = null;
    const offerLocalRetry = () => {
      if (localBtn) return;
      localBtn = document.createElement('button');
      localBtn.style.cssText = 'background:#1a1622;border:1px solid #3a3450;border-radius:8px;color:#b9a9e0;font-size:.7rem;padding:5px 10px;cursor:pointer;';
      localBtn.textContent = window.i18n.t('cu.regenerate_local', 'ローカルで再生成');
      localBtn.addEventListener('click', async () => {
        localBtn.disabled = true; status.textContent = window.i18n.t('cu.sending_local', 'ローカルに送信中…');
        try {
          const r = await window.aiImages.retryLocal(tid, rec.id);
          if (!r || r.ok === false) status.textContent = (r && r.reason === 'unreachable') ? window.i18n.t('cu.local_unreachable', 'ローカルサーバーに接続できません') : window.i18n.t('cu.failed', '失敗');
          else { status.textContent = r.ingested ? '' : window.i18n.t('cu.awaiting_generation', '生成待ち…'); try { localBtn.remove(); } catch (_) {} localBtn = null; }
        } catch (_) { status.textContent = window.i18n.t('common.error', 'エラー'); }
        finally { if (localBtn) localBtn.disabled = false; refresh(); try { opts && opts.onChange && opts.onChange(); } catch (_) {} }
      });
      ctl.appendChild(localBtn);
    };
    const refresh = async () => {
      try {
        const s = await window.aiImages.statusFor(tid, rec.id);
        btn.style.display = '';                          // always available — a clear manual generate trigger
        btn.textContent = s.images ? window.i18n.t('cu.generate_another_image', '別の画像を生成') : window.i18n.t('cu.generate_image', '画像を生成');
        if (s.images) lastErr = '';                      // a new image clears any sticky error
        status.textContent = lastErr || (s.pending ? (s.pending > 1 ? window.i18n.fmt('cu.queued_n', { n: s.pending }) : window.i18n.t('cu.awaiting_generation', '生成待ち…')) : '');
        try { strip._reload && strip._reload(); } catch (_) {}
      } catch (_) {}
    };
    btn.addEventListener('click', async () => {
      if (busy) return; busy = true; btn.disabled = true;
      const prev = btn.textContent; btn.textContent = window.i18n.t('cu.sending', '送信中…');
      lastErr = '';
      if (localBtn) { try { localBtn.remove(); } catch (_) {} localBtn = null; }
      window._kaiImgProgress = (t) => { try { if (busy) status.textContent = t; } catch (_) {} };   // live stage readout from the deep layers
      try {
        await window.aiImages.queueCharacter(tid, rec);   // first image (no-op if already queued)
        const r = await window.aiImages.sync(tid);
        if (!r || r.ok === false) {                       // surface the ACTUAL reason (sticky, not masked by 生成待ち)
          if (r && r.reason === 'refused') { lastErr = r.refusalMsg || window.i18n.t('cu.image_refused', '画像が拒否されました'); if (r.canLocal) offerLocalRetry(); }
          else if (r && r.reason === 'rate-limited') { lastErr = ''; }   // NOT a failure — stays queued + auto-drains; refresh() shows 順番待ち via the pending path
          else if (r && r.reason === 'no-key') lastErr = window.i18n.t('cu.set_api_key', 'APIキーを設定してください（設定→AI Image）');
          else if (r && r.reason === 'unreachable') lastErr = window.i18n.t('cu.local_unreachable', 'ローカルサーバーに接続できません');
          else lastErr = window.i18n.t('cu.failed', '失敗') + (r && r.error ? ('：' + r.error) : '');
          try { if (window.showToast && lastErr) window.showToast(lastErr, 7000); } catch (_) {}
        }
      } catch (e) { lastErr = window.i18n.t('common.error', 'エラー') + (e && e.message ? ('：' + e.message) : ''); try { if (window.showToast) window.showToast(lastErr, 7000); } catch (_) {} }
      finally { btn.disabled = false; busy = false; btn.textContent = prev; refresh(); try { opts && opts.onChange && opts.onChange(); } catch (_) {} }
    });
    refresh();
    if (opts && typeof opts.registerRefresher === 'function') opts.registerRefresher(refresh);
    return box;
  }

  // Per-character squiggle show/hide toggle (writes through aiCharacters.
  // setHideSquiggle, which is merge-safe + re-marks the reader). Mutates the
  // passed `rec` so the button stays consistent within this surface; in the
  // popup `rec` is the live store record, on the screen it's a clone.
  function buildSquiggleToggle(rec) {
    const wrap = document.createElement('div'); wrap.className = 'ksq-row';
    // Live illustration: the name shown WITH the real wavy underline when ON,
    // plain when OFF — so the control visibly shows what it does.
    const sample = document.createElement('span'); sample.className = 'ksq-sample';
    const sampleName = document.createElement('span');
    sampleName.textContent = (rec.surface || window.i18n.t('cu.sample_name', '名前')).slice(0, 6);
    sample.appendChild(sampleName);
    const label = document.createElement('span'); label.className = 'ksq-label';
    label.textContent = window.i18n.t('cu.squiggle_label', '本文の名前に波線');
    const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'ksq-switch'; sw.setAttribute('role', 'switch');
    const knob = document.createElement('span'); knob.className = 'ksq-knob'; sw.appendChild(knob);
    let hidden = !!rec.hideSquiggle;
    const sync = () => {
      sw.setAttribute('aria-checked', hidden ? 'false' : 'true');   // checked == squiggle ON (knob right)
      sampleName.className = hidden ? '' : 'kchar-name';             // preview mirrors the state
      sw.setAttribute('aria-label', hidden ? window.i18n.t('cu.squiggle_aria_off', '名前の波線：オフ') : window.i18n.t('cu.squiggle_aria_on', '名前の波線：オン'));
    };
    sync();
    sw.addEventListener('click', async (e) => {
      e.stopPropagation(); hidden = !hidden; sync();
      // AWAIT: setHideSquiggle is async (await ensureLoaded), so a SYNC write-back
      // would land before its no-op guard reads the old store value → guard
      // short-circuits → no save / no re-mark (the toggle "did nothing" bug, popup
      // only, where `rec` IS the live record). Awaiting lets the guard see the old
      // value first; the write-back then keeps the screen's cloned rec in sync.
      try { await window.aiCharacters.setHideSquiggle(rec.id, hidden); } catch (_) {}
      rec.hideSquiggle = hidden;
    });
    wrap.appendChild(sample); wrap.appendChild(label); wrap.appendChild(sw);
    return wrap;
  }

  function openCharPopup(rec, m) {
    const prev = document.getElementById('kcharPopup');
    if (prev) prev.remove();
    charPopupPause();
    // Live-refresh wiring for the popup's portrait (parity with the Characters
    // screen): a render that lands while the popup is open repaints it. Cleaned
    // up on every close path (overlay tap, ✕, touchend all route through closePopup).
    const imgRefreshers = [];
    let imgListener = null, imgPoll = null;
    const closePopup = (overlay) => {
      if (imgListener) { try { window.removeEventListener('kai:img-data', imgListener); } catch (_) {} imgListener = null; }
      if (imgPoll) { try { clearInterval(imgPoll); } catch (_) {} imgPoll = null; }
      overlay.remove(); charPopupResume();
    };
    const overlay = document.createElement('div');
    overlay.id = 'kcharPopup';
    // Below toast (9500) and dict popup (9999); above the AI summary (9000).
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9400;' +
      'display:flex;align-items:center;justify-content:center;';
    // Block gestures (esp. horizontal image swipes) from leaking to the reader/
    // card/audio handlers behind the popup.
    try { if (window.aiImages && window.aiImages.shieldOverlay) window.aiImages.shieldOverlay(overlay); } catch (_) {}
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(overlay); });
    overlay.addEventListener('touchend', (e) => {
      if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); closePopup(overlay); }
    });

    // Furigana on every kanji name: author-given ruby first, standard reading
    // as the fallback. All-kana names need none (already readable).
    const clean = (window.aiCharacters && window.aiCharacters.cleanReading) || ((x) => x || '');
    const reading = clean(rec.rubyReading) || clean(rec.standardReading) || '';
    const hasKanji = /[㐀-鿿豈-﫿々〆ヶ]/.test(rec.surface || '');
    const name = (reading && hasKanji && reading !== rec.surface)
      ? '<ruby>' + esc(rec.surface) + '<rt style="font-size:.5em;color:#aab;">' + esc(reading) + '</rt></ruby>'
      : esc(rec.surface);
    const others = (rec.aliases || []).filter(a => a !== rec.surface);
    // Plain text with \n (not <br>): the body is rendered pre-wrap and later
    // re-wrapped into per-char dict spans, which only preserves TEXT newlines.
    const rels = (rec.relationships || []).map((r) => {
      let toName = r.to;
      try {
        const t = m.state.characters.get(r.to);
        if (t) toName = t.surface;
      } catch (_) {}
      return toName + ' — ' + r.rel;
    }).join('\n');

    const card = document.createElement('div');
    card.style.cssText =
      'background:#15151c;border:1px solid #34344a;border-radius:14px;' +
      'width:min(90vw,420px);max-height:72vh;overflow-y:auto;padding:16px 18px;' +
      '-webkit-overflow-scrolling:touch;';
    card.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">' +
        '<div style="font-size:1.5rem;color:#eee;font-family:var(--font-family-card);">' + name + '</div>' +
        '<button id="kcharClose" style="background:none;border:1px solid #333;border-radius:8px;' +
        'color:#aaa;padding:2px 10px;font-size:1rem;cursor:pointer;flex:0 0 auto;">✕</button>' +
      '</div>' +
      (others.length
        ? '<div style="color:#777;font-size:.72rem;margin-top:4px;">' + esc(others.join('・')) + '</div>' : '') +
      (!rec.description && !(rec.developments && rec.developments.length)
        ? '<div style="color:#9a8cc4;font-size:.74rem;margin-top:8px;">' + esc(window.i18n.t('cu.just_appeared', '登場したばかりの人物')) + '</div>' : '') +
      section(window.i18n.t('cu.section_profile', '人物'), rec.description) +
      section(window.i18n.t('cu.section_personality', '性格'), rec.personality) +
      section(window.i18n.t('cu.section_relationships', '関係'), rels) +
      section(window.i18n.t('cu.section_appearance', '外見'), rec.appearance);
    // Portrait(s) + full generate UI under the name (shared with the Characters
    // screen card), then the per-character squiggle show/hide toggle. Both go
    // right after the name row.
    try {
      if (window._activeTitleId && card.firstElementChild) {
        const after = card.firstElementChild.nextSibling;
        const tid = window._activeTitleId;
        const imgBox = buildCharImages(rec, { registerRefresher: (f) => imgRefreshers.push(f) });   // item 3: full generate UI in the popup
        imgBox.style.margin = '10px 0 4px';
        card.insertBefore(imgBox, after);
        card.insertBefore(buildSquiggleToggle(rec), after);   // item 6a: squiggle toggle just below the image
        // repaint the strip when a render for this title lands, and poll the
        // server while open (mirrors the Characters screen). Cleaned in closePopup.
        imgListener = (e) => { try { if (!e || !e.detail || e.detail.titleId === tid) imgRefreshers.forEach((f) => { try { f(); } catch (_) {} }); } catch (_) {} };
        window.addEventListener('kai:img-data', imgListener);
        imgPoll = setInterval(() => { try { if (window.aiImages && window.aiImages.pollPending) window.aiImages.pollPending(tid); } catch (_) {} }, 9000);
      }
    } catch (_) {}
    const deepHost = document.createElement('div');
    card.appendChild(deepHost);
    const foot = document.createElement('div');
    foot.style.cssText = 'color:#555;font-size:.66rem;margin-top:14px;';
    foot.textContent = window.i18n.t('cu.up_to_position', '現在の読書位置までの情報のみ表示しています');
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    // ✕ close: stopPropagation on both events so the capture-phase touch
    // machinery (name taps, dict spans) never sees the tap; always close
    // through closePopup so the audio fade-back runs.
    const closeBtn = card.querySelector('#kcharClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); closePopup(overlay);
      });
      closeBtn.addEventListener('touchend', (e) => {
        e.preventDefault(); e.stopPropagation(); closePopup(overlay);
      });
    }
    // Dictionary + recursive squiggles in the section bodies: wrap into the
    // per-char dict pipeline first, then mark character names on top (the
    // capture-phase name handler beats the dict span handlers, so names open
    // character popups and everything else opens the dictionary).
    card.querySelectorAll('.kchar-secbody').forEach((el) => {
      if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(el);
      markContainer(el, m);
    });
    wireDeepDive(rec, m, deepHost);
  }

  // §8 chip contract + Characters-screen reuse: open the character popup by
  // id or alias; wireDeepDive renders the cached-or-button deep-dive flow
  // into an arbitrary host (the Characters screen embeds it per card).
  function openPopupFor(idOrAlias) {
    try {
      const m = window.aiCharacters && window.aiCharacters.matcher();
      if (!m) return false;
      let rec = null;
      if (m.state && m.state.characters && m.state.characters.has(idOrAlias)) {
        rec = m.state.characters.get(idOrAlias);
        if (rec && rec.mergedInto && m.state.characters.has(rec.mergedInto)) {
          rec = m.state.characters.get(rec.mergedInto);
        }
      }
      if (!rec) rec = m.map.get(idOrAlias) || null;
      if (!rec) return false;
      openCharPopup(rec, m);
      return true;
    } catch (_) { return false; }
  }
  window.aiCharsUi = { openPopupFor, wireDeepDive, markContainer, markNow, remark: remarkSoon, buildCharImages, buildSquiggleToggle };
})();
