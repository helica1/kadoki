// ai-characters-screen.js — Characters list screen (AI plan v2 §9).
// Full-screen overlay over aiCharacters.openState(): per character a ruby
// name, role chip, 最新の動き (newest developments first), an expandable 背景
// section (older developments + stored fields + relationships resolved to
// surfaces), chapter links into the timeline's chapter view, and the existing
// deep-dive flow (aiCharsUi.wireDeepDive). Read-only; merged records hidden.
// All body text is dict-tappable; the kai-summary-text class puts it on the
// squiggle poll's container list, so character names link back here too.
(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Typography matches CARD mode (user-chosen font incl. custom), same as the
  // character popup / AI summary bodies.
  const BODY_STYLE =
    'color:#ddd;font-family:var(--font-family-card);font-size:var(--font-size-card,1rem);' +
    'line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;min-width:0;';
  const LABEL_STYLE =
    'font-size:.68rem;color:#8a93c4;letter-spacing:.08em;margin:10px 0 2px;';

  // 'kai:proc-status' listener for the header spinner — added in open(),
  // removed here (close() is the screen's single teardown path).
  let _procListener = null;
  // Image-generation wiring (ai-images.js): a 'kai:img-data' listener refreshes
  // the per-card portrait strips + header counts; a poll reconciles pending jobs
  // while the screen is open. Both torn down in close().
  let _imgListener = null, _imgPoll = null;
  let _cardRefreshers = [];        // per-card portrait-strip refreshers (reset each render)
  let _imgHeaderUpdate = null;     // header sync/review button refresher

  function close() {
    try {
      if (_procListener) {
        window.removeEventListener('kai:proc-status', _procListener);
        _procListener = null;
      }
    } catch (_) {}
    try {
      if (_imgListener) { window.removeEventListener('kai:img-data', _imgListener); _imgListener = null; }
      if (_imgPoll) { clearInterval(_imgPoll); _imgPoll = null; }
      _cardRefreshers = []; _imgHeaderUpdate = null;
    } catch (_) {}
    try {
      const el = document.getElementById('kcharsScreen');
      if (el) el.remove();
    } catch (_) {}
  }

  // Shared with shell.js (same id guard): small rotating-ring spinner.
  function ensureKaiSpinStyle() {
    if (document.getElementById('kaiSpinStyle')) return;
    try {
      const st = document.createElement('style');
      st.id = 'kaiSpinStyle';
      st.textContent =
        '@keyframes kai-spin{to{transform:rotate(360deg);}}' +
        '.kai-spin{display:inline-block;width:.85em;height:.85em;border:2px solid #555;' +
        'border-top-color:#b794f6;border-radius:50%;animation:kai-spin .8s linear infinite;' +
        'vertical-align:-2px;margin-left:6px;}';
      document.head.appendChild(st);
    } catch (_) {}
  }

  function textBody(text) {
    const el = document.createElement('div');
    el.className = 'kai-summary-text';
    el.style.cssText = BODY_STYLE;
    el.textContent = text;
    try { if (typeof window.dictEnableLookupIn === 'function') window.dictEnableLookupIn(el); } catch (_) {}
    return el;
  }
  function sectionLabel(text) {
    const el = document.createElement('div');
    el.style.cssText = LABEL_STYLE;
    el.textContent = text;
    return el;
  }
  function devRow(dev) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin-top:6px;';
    const tag = document.createElement('div');
    tag.style.cssText = 'flex:none;color:#667;font-size:.66rem;min-width:3.2em;';
    tag.textContent = window.i18n.fmt('cs.chapter_n', { n: (dev.chunkIdx | 0) + 1 });
    const body = textBody(dev.text);
    body.style.flex = '1';
    row.appendChild(tag);
    row.appendChild(body);
    return row;
  }
  function chapterLink(label, idx) {
    const a = document.createElement('span');
    a.style.cssText = 'color:#8a93c4;font-size:.7rem;cursor:pointer;text-decoration:underline;' +
                      'text-underline-offset:2px;';
    a.textContent = label + ' ' + window.i18n.fmt('cs.chapter_n', { n: idx + 1 });
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        if (window.aiTimeline && typeof window.aiTimeline.openChapterView === 'function') {
          window.aiTimeline.openChapterView(idx);
        }
      } catch (_) {}
    });
    return a;
  }

  function buildBackground(rec, state, shownDevs, skipDesc) {
    const box = document.createElement('div');
    const olderDevs = (rec.developments || []).slice(shownDevs);
    if (olderDevs.length) {
      box.appendChild(sectionLabel(window.i18n.t('cs.history', 'これまでの動き')));
      for (const d of olderDevs) box.appendChild(devRow(d));
    }
    const fields = [
      [window.i18n.t('cs.field_profile', '人物'), skipDesc ? '' : rec.description],
      [window.i18n.t('cs.field_personality', '性格'), rec.personality],
      [window.i18n.t('cs.field_appearance', '外見'), rec.appearance],
      [window.i18n.t('cs.field_motivations', '動機'), rec.motivations],
      [window.i18n.t('cs.field_secrets', '秘密'), rec.secrets],
    ];
    for (const f of fields) {
      if (!f[1]) continue;
      box.appendChild(sectionLabel(f[0]));
      box.appendChild(textBody(f[1]));
    }
    const rels = (rec.relationships || [])
      .map(r => ((state.surfaceOf && state.surfaceOf[r.to]) || r.to) + ' — ' + r.rel)
      .join('\n');
    if (rels) {
      box.appendChild(sectionLabel(window.i18n.t('cs.field_relationships', '関係')));
      box.appendChild(textBody(rels));
    }
    // Existing deep-dive flow (cached per <charId>@<chunkIdx> in AIDEEP_V1).
    try {
      if (window.aiCharsUi && typeof window.aiCharsUi.wireDeepDive === 'function'
          && window.aiCharacters && window.aiCharacters.matcher) {
        const m = window.aiCharacters.matcher();
        if (m) {
          const host = document.createElement('div');
          box.appendChild(host);
          window.aiCharsUi.wireDeepDive(rec, m, host);
        }
      }
    } catch (_) {}
    return box;
  }

  // ---- per-title collapse state (Characters-screen cards; default expanded) ----
  function collapsedKey() { return 'AICHAR_COLLAPSED_' + (window._activeTitleId || ''); }
  function loadCollapsed() { try { return new Set(JSON.parse(localStorage.getItem(collapsedKey()) || '[]')); } catch (_) { return new Set(); } }
  function saveCollapsed(s) { try { localStorage.setItem(collapsedKey(), JSON.stringify(Array.from(s))); } catch (_) {} }

  function buildCard(rec, state, collapsedSet = new Set()) {
    const card = document.createElement('div');
    card.style.cssText =
      'background:#15151c;border:1px solid #2a2a3c;border-radius:14px;' +
      'padding:14px 16px;margin-bottom:12px;';

    // name row (copy + caret pinned right, NO wrap) — the role chip goes BELOW the name.
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;';
    // Furigana on EVERY kanji name: author's ruby (rubyReading) preferred, else
    // the standard reading. All-kana names need none (already readable).
    const clean = (window.aiCharacters && window.aiCharacters.cleanReading) || ((x) => x || '');
    let reading = clean(rec.rubyReading) || clean(rec.standardReading) || '';
    // A real furigana reading is short; a malformed/over-long one (some models put
    // a phrase — or the whole bio — in the reading field) made a giant <ruby><rt>
    // that pushed the name row past the viewport: the collapse caret got shoved
    // off-screen and the list scrolled horizontally. Drop an implausibly long one.
    if (reading.length > (rec.surface || '').length * 4 + 4) reading = '';
    const hasKanji = /[㐀-鿿豈-﫿々〆ヶ]/.test(rec.surface || '');
    const name = document.createElement('div');
    name.className = 'kai-name-ruby';   // orange per-kanji furigana via .kai-name-ruby rt
    name.style.cssText = 'flex:1;min-width:0;overflow:hidden;font-size:1.35rem;color:#eee;font-family:var(--font-family-card);';
    // nameRubyHtml ties the reading to each kanji (dict-popup furigana) and carries
    // the giant-ruby guard; falls back to the plain surface if it's unavailable.
    name.innerHTML = (window.aiCharsUi && window.aiCharsUi.nameRubyHtml)
      ? window.aiCharsUi.nameRubyHtml(rec) : esc(rec.surface);
    head.appendChild(name);
    const cp = document.createElement('button');
    cp.textContent = '⧉';
    cp.title = window.i18n.t('cs.copy_desc_title', 'Copy character description');
    cp.style.cssText =
      'margin-left:auto;background:none;border:1px solid #333;border-radius:8px;color:#8a93c4;' +
      'font-size:.9rem;padding:2px 10px;cursor:pointer;';
    cp.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (window.aiExport && window.aiExport.charText) {
          const ids = (state && state.surfaceOf) ? state.surfaceOf : {};
          const ok = await window.aiExport.copyText(window.aiExport.charText(rec, ids));
          window.aiExport.toast(ok ? window.i18n.t('cs.copied', 'Copied') : window.i18n.t('cs.copy_failed', 'Copy failed'));
        }
      } catch (_) {}
    });
    head.appendChild(cp);

    // collapse / expand caret (default expanded; persisted per title). The
    // single `body` div below is the one thing it flips.
    const body = document.createElement('div');
    const collapsed = collapsedSet.has(rec.id);
    const car = document.createElement('button');
    car.setAttribute('aria-label', window.i18n.t('cs.collapse_expand', 'collapse / expand'));
    car.style.cssText =
      'background:none;border:none;color:#aab4dd;cursor:pointer;margin-left:4px;flex:none;' +
      'width:40px;height:40px;display:flex;align-items:center;justify-content:center;padding:0;' +
      'font-size:1.5rem;line-height:1;';
    // Open-angle chevron (not a filled ▸ play triangle): big glyph in a 40px tap
    // target. Points right when collapsed, rotates down when expanded.
    const chev = document.createElement('span');
    chev.textContent = '❯';   // ❯
    chev.style.cssText = 'display:block;transition:transform .15s ease;transform-origin:center;';
    car.appendChild(chev);
    const applyCollapse = (c) => { body.style.display = c ? 'none' : ''; chev.style.transform = c ? 'rotate(0deg)' : 'rotate(90deg)'; };
    applyCollapse(collapsed);
    car.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = body.style.display !== 'none';
      applyCollapse(c);
      if (c) collapsedSet.add(rec.id); else collapsedSet.delete(rec.id);
      saveCollapsed(collapsedSet);
    });
    head.appendChild(car);
    card.appendChild(head);

    // role chip — UNDER the name (was inline to the right; moved here so the caret
    // always stays pinned to the right of the name row instead of wrapping below).
    if (rec.role) {
      const chip = document.createElement('div');
      chip.style.cssText =
        'display:inline-block;background:#262640;color:#aab4dd;border-radius:10px;padding:2px 9px;font-size:.66rem;margin-top:6px;';
      chip.textContent = rec.role;
      card.appendChild(chip);
    }

    // per-character squiggle show/hide toggle (mirrors the popup; collapsing
    // hides it too since it lives at the top of the collapsible body)
    try {
      if (window.aiCharsUi && window.aiCharsUi.buildSquiggleToggle) {
        body.appendChild(window.aiCharsUi.buildSquiggleToggle(rec));
      }
    } catch (_) {}

    // portrait(s) + generate/update control (shared with the reader popup)
    try {
      if (window.aiCharsUi && window.aiCharsUi.buildCharImages) {
        body.appendChild(window.aiCharsUi.buildCharImages(rec, {
          onChange: () => { if (_imgHeaderUpdate) _imgHeaderUpdate(); },
          registerRefresher: (f) => _cardRefreshers.push(f),
        }));
      }
    } catch (_) {}

    const others = (rec.aliases || []).filter(a => a !== rec.surface);
    if (others.length) {
      const al = document.createElement('div');
      al.style.cssText = 'color:#777;font-size:.72rem;margin-top:4px;';
      al.textContent = others.join('・');
      body.appendChild(al);
    }

    // 初登場 / 直近 chapter links
    const links = document.createElement('div');
    links.style.cssText = 'display:flex;gap:14px;margin-top:6px;';
    if (Number.isFinite(rec.firstChunkIdx) && rec.firstChunkIdx >= 0) {
      links.appendChild(chapterLink(window.i18n.t('cs.first_appearance', '初登場'), rec.firstChunkIdx));
    }
    if (Number.isFinite(rec.lastChunkIdx) && rec.lastChunkIdx > rec.firstChunkIdx) {
      links.appendChild(chapterLink(window.i18n.t('cs.latest', '直近'), rec.lastChunkIdx));
    }
    if (links.children.length) body.appendChild(links);

    // 最新の動き — newest 2-3 developments
    const devs = rec.developments || [];
    const shownDevs = Math.min(devs.length, 3);
    if (shownDevs) {
      body.appendChild(sectionLabel(window.i18n.t('cs.latest_developments', '最新の動き')));
      for (let i = 0; i < shownDevs; i++) body.appendChild(devRow(devs[i]));
    } else if (rec.description) {
      body.appendChild(sectionLabel(window.i18n.t('cs.field_profile', '人物')));
      body.appendChild(textBody(rec.description));
    }

    // expandable 背景 (built lazily on first open)
    const toggle = document.createElement('button');
    toggle.style.cssText =
      'margin-top:12px;background:none;border:1px solid #2e2e44;border-radius:8px;' +
      'color:#9aa3cc;font-size:.76rem;padding:6px 12px;cursor:pointer;';
    toggle.textContent = window.i18n.t('cs.background', '背景') + ' ▸';
    let bg = null;
    toggle.addEventListener('click', () => {
      try {
        if (!bg) {
          // description already shown inline when there were no developments
          bg = buildBackground(rec, state, shownDevs, !shownDevs && !!rec.description);
          bg.style.display = 'none';
          body.appendChild(bg);
        }
        const open = bg.style.display === 'none';
        bg.style.display = open ? '' : 'none';
        toggle.textContent = window.i18n.t('cs.background', '背景') + (open ? ' ▾' : ' ▸');
      } catch (_) {}
    });
    body.appendChild(toggle);

    card.appendChild(body);
    return card;
  }

  // Sort order for the Characters list (persisted). 'recent' = openState's
  // default (most-recently-active first); 'freq' = most prominent first;
  // 'chrono' = first-appearance order. Data already on each record.
  function getSort() { try { return localStorage.getItem('AICHAR_SORT') || 'recent'; } catch (_) { return 'recent'; } }
  function applySort(list) {
    if (!Array.isArray(list)) return;
    const mode = getSort();
    if (mode === 'freq') list.sort((a, b) => ((b.totalImportance || 0) - (a.totalImportance || 0)) || ((a.firstChunkIdx || 0) - (b.firstChunkIdx || 0)));
    else if (mode === 'chrono') list.sort((a, b) => ((a.firstChunkIdx || 0) - (b.firstChunkIdx || 0)) || ((b.totalImportance || 0) - (a.totalImportance || 0)));
    else list.sort((a, b) => ((b.lastChunkIdx || 0) - (a.lastChunkIdx || 0)) || ((b.totalImportance || 0) - (a.totalImportance || 0)));
  }

  function renderList(listEl, state) {
    listEl.innerHTML = '';
    _cardRefreshers = [];          // rebuilt as cards are created below
    if (!state || !state.list || !state.list.length) {
      const empty = document.createElement('div');
      empty.style.cssText = BODY_STYLE + 'color:#888;text-align:center;padding:48px 24px;';
      // Hint matches the actual state: AI off → enable it; auto-process off →
      // point at the timeline's manual update button; else the default copy.
      let hint = window.i18n.t('cs.empty_hint_default', '章を読み終えるごとに自動で分析され、登場人物がここに追加されていきます。');
      try {
        if (!(window.ai && window.ai.isEnabled && window.ai.isEnabled())) {
          hint = window.i18n.t('cs.empty_hint_ai_off', '設定の「AI assistant」を有効にすると、章ごとに登場人物が分析されます。');
        } else if (localStorage.getItem('AI_AUTO_PROCESS') === '0') {
          hint = window.i18n.t('cs.empty_hint_auto_off', '自動処理がオフです。タイムラインの「タイムラインを更新」から分析できます。');
        }
      } catch (_) {}
      empty.textContent = window.i18n.t('cs.empty_title', 'まだ登場人物の情報がありません。') + '\n\n' + hint;
      listEl.appendChild(empty);
      return;
    }
    try { applySort(state.list); } catch (_) {}
    const collapsedSet = loadCollapsed();
    for (const rec of state.list) {
      try { listEl.appendChild(buildCard(rec, state, collapsedSet)); } catch (_) {}
    }
    // Squiggle character names in the card bodies immediately, not on the next
    // 1.5s poll (these are .kai-summary-text lazy containers).
    try { listEl.querySelectorAll('.kai-summary-text').forEach(el => window.aiCharsUi && window.aiCharsUi.markNow(el)); } catch (_) {}
  }

  async function open() {
    try {
      const titleId = window._activeTitleId;
      if (!titleId) return false;
      let _screenState = null;   // kept so the sort control can re-render in place
      // AI on but book not activated → prompt to activate first (opt-in per
      // book). 'proceed' still opens the screen (empty until activated).
      try {
        if (window.aiProcessor && window.aiProcessor.ensureActivated) {
          await window.aiProcessor.ensureActivated(titleId);
        }
      } catch (_) {}
      close();

      const overlay = document.createElement('div');
      overlay.id = 'kcharsScreen';
      // z 9000 — below dict popup (9999), toast (9500) and char popup (9400).
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;' +
        'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
        'padding:calc(8px + env(safe-area-inset-top, 0px)) 0 calc(8px + env(safe-area-inset-bottom, 0px));';
      // Block ALL gestures from leaking to the app behind (card-swipe→Anki,
      // audio transport, reader physics) — esp. horizontal image swipes inside.
      try { if (window.aiImages && window.aiImages.shieldOverlay) window.aiImages.shieldOverlay(overlay); } catch (_) {}
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.addEventListener('touchend', (e) => {
        if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); close(); }
      });

      const card = document.createElement('div');
      card.style.cssText =
        'background:#101016;border:1px solid #2a2a2a;border-radius:14px;' +
        'width:min(94vw,720px);height:90vh;max-height:100%;display:flex;flex-direction:column;overflow:hidden;';

      const head = document.createElement('div');
      head.id = 'kcharsScreenHead';
      head.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #242424;';
      head.innerHTML =
        '<div data-i18n="cs.characters_title" style="flex:1;min-width:0;font-weight:600;color:#eee;font-size:1rem;">' +
        esc(window.i18n.t('cs.characters_title', 'Characters')) + '</div>';
      // chapter-processing indicator (ai-processor 'kai:proc-status' broadcasts)
      const procWrap = document.createElement('span');
      procWrap.style.cssText =
        'display:none;align-items:center;flex:none;color:#8a7fb8;font-size:.72rem;';
      ensureKaiSpinStyle();
      const procRing = document.createElement('span');
      procRing.className = 'kai-spin';
      procRing.style.marginLeft = '0';
      const procTxt = document.createElement('span');
      procTxt.style.marginLeft = '6px';
      procTxt.textContent = window.i18n.t('cs.processing', '処理中…');
      procWrap.appendChild(procRing);
      procWrap.appendChild(procTxt);
      head.appendChild(procWrap);
      const updateProc = () => {
        try {
          const st = window._kaiProcStatus;
          const busy = !!(st && st.busy && st.titleId === titleId);
          procWrap.style.display = busy ? 'inline-flex' : 'none';
        } catch (_) {}
      };
      updateProc();
      _procListener = () => updateProc();
      window.addEventListener('kai:proc-status', _procListener);
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      // Match the Timeline close X (larger, clearer).
      closeBtn.style.cssText =
        'background:none;border:1px solid #333;border-radius:8px;color:#ccc;' +
        'font-size:1.4rem;padding:6px 14px;cursor:pointer;';
      closeBtn.addEventListener('click', close);

      // ----- image-generation header controls (ai-images.js) -----
      // "画像を同期" queues every character that still has no image AND pulls any
      // finished renders; "確認 (N)" opens the keep/reject/crop review when there
      // are returned images awaiting a decision.
      if (window.aiImages) {
        const mkHB = (txt) => {
          const b = document.createElement('button');
          b.style.cssText = 'background:#1a1622;border:1px solid #3a3450;border-radius:8px;' +
            'color:#b9a9e0;font-size:.74rem;padding:4px 10px;cursor:pointer;flex:none;';
          b.textContent = txt; return b;
        };
        const newPill = mkHB(window.i18n.t('cs.new_label', '新着'));           // informational: total not-yet-viewed images
        newPill.style.display = 'none';
        newPill.style.cursor = 'default';
        newPill.style.borderColor = '#5a4a2a'; newPill.style.color = '#e0cf9a';
        const runRefreshers = () => { for (const f of _cardRefreshers) { try { f(); } catch (_) {} } };
        const updateHeaderImg = async () => {
          try {
            const c = await window.aiImages.counts(titleId);
            newPill.style.display = c.unseen ? 'inline-block' : 'none';
            newPill.textContent = window.i18n.fmt('cs.new_count', { n: c.unseen });
          } catch (_) {}
        };
        _imgHeaderUpdate = updateHeaderImg;
        // The bulk "画像を同期" button was removed — generation is per-character (画像を生成)
        // or the timeline Scenes section, never a fan-out. Background reconcile still runs
        // via pollPending + the kai:img-data listener below.
        head.appendChild(newPill);
        updateHeaderImg();
        _imgListener = (e) => { try { if (!e || !e.detail || e.detail.titleId === titleId) { runRefreshers(); updateHeaderImg(); } } catch (_) {} };
        window.addEventListener('kai:img-data', _imgListener);
        // reconcile in-flight renders while the screen is open (cheap; no-ops when nothing pending)
        _imgPoll = setInterval(() => { try { window.aiImages.pollPending(titleId); } catch (_) {} }, 9000);
      }

      // ----- sort order (most-recent / frequency / first-appearance) -----
      const sortSel = document.createElement('select');
      sortSel.title = window.i18n.t('cs.sort_order', '並び順');
      // Styled to clearly read as a changeable menu: visible chevron, brighter border, button-like fill.
      sortSel.style.cssText = "appearance:none;-webkit-appearance:none;background:#241d33 url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%23c9b8ff' stroke-width='1.5' fill='none'/></svg>\") no-repeat right 8px center;border:1px solid #5a4f7a;border-radius:8px;color:#c9b8ff;font-size:.74rem;padding:5px 26px 5px 10px;cursor:pointer;flex:none;";
      [['recent', window.i18n.t('cs.sort_recent', '最近')], ['freq', window.i18n.t('cs.sort_freq', '頻度順')], ['chrono', window.i18n.t('cs.sort_chrono', '登場順')]].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sortSel.appendChild(o); });
      try { sortSel.value = getSort(); } catch (_) {}
      sortSel.addEventListener('change', () => {
        try { localStorage.setItem('AICHAR_SORT', sortSel.value); } catch (_) {}
        if (_screenState) { try { renderList(listEl, _screenState); } catch (_) {} }
      });
      head.appendChild(sortSel);

      head.appendChild(closeBtn);

      const listEl = document.createElement('div');
      listEl.style.cssText =
        'flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 14px 20px;';   // overflow-x:hidden: overflow-y:auto alone makes overflow-x compute to auto → a too-wide child scrolled the list sideways. no -webkit-overflow-scrolling:touch (iOS legacy re-rastering layer = lag)
      listEl.innerHTML =
        '<div style="text-align:center;padding:40px 0;">' +
        '<span class="kai-dots" style="color:#8a7fb8;"><span>·</span><span>·</span><span>·</span></span></div>';

      const foot = document.createElement('div');
      foot.style.cssText =
        'padding:8px 14px;border-top:1px solid #242424;color:#555;font-size:.66rem;';
      foot.textContent = window.i18n.t('cs.footer_note', '現在の読書位置までの情報のみ表示しています');

      card.appendChild(head);
      card.appendChild(listEl);
      card.appendChild(foot);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      try { if (window.ai && typeof window.ai.markSeen === 'function') window.ai.markSeen(titleId, 'characters'); } catch (_) {}

      (async () => {
        let state = null;
        try {
          if (window.aiCharacters && typeof window.aiCharacters.openState === 'function') {
            state = await window.aiCharacters.openState(titleId);
          }
        } catch (_) {}
        if (!overlay.isConnected) return;
        _screenState = state;
        try { renderList(listEl, state); } catch (_) { listEl.innerHTML = ''; }
      })();
      return true;
    } catch (_) { return false; }
  }

  window.aiCharsScreen = { open, close };
})();
