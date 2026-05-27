
(async function() {
  const PREF_KEYS = {
    SELECTED_DECK: 'SELECTED_DECK',
    STOPWATCH_TIMEOUT: 'STOPWATCH_TIMEOUT',
    AUDIO_SPEED: 'AUDIO_SPEED',
    SUBTITLE_OFFSET: 'SUBTITLE_OFFSET',
    // Anki: swipe-up save (from card mode)
    ANKI_SWIPE_DECK:  'ANKI_SWIPE_DECK',
    ANKI_SWIPE_MODEL: 'ANKI_SWIPE_MODEL',
    ANKI_SWIPE_F_EXPRESSION: 'ANKI_SWIPE_F_EXPRESSION',
    ANKI_SWIPE_F_IMAGE:      'ANKI_SWIPE_F_IMAGE',
    ANKI_SWIPE_F_AUDIO:      'ANKI_SWIPE_F_AUDIO',
    // Anki: dictionary add-word
    ANKI_DICT_DECK:  'ANKI_DICT_DECK',
    ANKI_DICT_MODEL: 'ANKI_DICT_MODEL',
    ANKI_DICT_F_TERM:           'ANKI_DICT_F_TERM',
    ANKI_DICT_F_READING:        'ANKI_DICT_F_READING',
    ANKI_DICT_F_SENTENCE:       'ANKI_DICT_F_SENTENCE',
    ANKI_DICT_F_MEANING:        'ANKI_DICT_F_MEANING',
    ANKI_DICT_F_IMAGE:          'ANKI_DICT_F_IMAGE',
    ANKI_DICT_F_SENTENCE_AUDIO: 'ANKI_DICT_F_SENTENCE_AUDIO',
    ANKI_DICT_F_TERM_AUDIO:     'ANKI_DICT_F_TERM_AUDIO',
  };

  // Defaults preserve the user's current hardcoded behavior so legacy decks
  // keep working before they open Preferences once.
  const ANKI_DEFAULTS = {
    swipe: {
      deck: 'Shadowing5',
      model: 'jidoujisho Kinomoto BLUE',
      fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio' }
    },
    dict: {
      deck: 'Mining',
      model: 'jidoujisho Kinomoto',
      fields: {
        term: 'Term', reading: 'Reading', sentence: 'Sentence', meaning: 'Meaning',
        image: 'Image', sentenceAudio: 'Sentence Audio', termAudio: 'Term Audio'
      }
    }
  };

  function applySubtitleOffset(px) {
    document.documentElement.style.setProperty('--subtitle-offset', (parseInt(px) || 0) + 'px');
  }

  function isCap() { return typeof window.isCapacitorEnvironment === 'function' && window.isCapacitorEnvironment(); }

  async function setPref(key, value) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key, value: value.toString() });
    } else {
      localStorage.setItem(key, value.toString());
    }
  }

  async function getPref(key) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      const res = await window.Capacitor.Plugins.Preferences.get({ key });
      return res.value;
    }
    return localStorage.getItem(key);
  }

  // Convenience: read pref with a fallback when null/empty.
  async function getOr(key, fallback) {
    const v = await getPref(key);
    return (v == null || v === '') ? fallback : v;
  }

  async function fetchDeckNamesLocal() {
    if (typeof fetchDeckNames === 'function') return fetchDeckNames();
    return [];
  }

  // Build the per-mode appearance section into #prefsAppearance.
  // Each mode card has: font size slider, align segmented buttons, and
  // for card+audio: image show/opacity/vertical-align controls.
  function buildAppearanceSection() {
    const host = document.getElementById('prefsAppearance');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';

    const apply = (mode, patch) => window.appearance?.set?.(mode, patch);

    const SEG = (modeId, suffix, options, getCurrent) => {
      const div = document.createElement('div');
      div.className = 'seg';
      options.forEach(([label, value]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.dataset.value = value;
        b.dataset.field = suffix;
        b.dataset.mode = modeId;
        if (getCurrent() === value) b.dataset.on = '1';
        b.addEventListener('click', () => {
          div.querySelectorAll('button').forEach(x => delete x.dataset.on);
          b.dataset.on = '1';
          const patch = {};
          patch[suffix] = value;
          apply(modeId, patch);
        });
        div.appendChild(b);
      });
      return div;
    };

    const fontSizeRange = (mode, getCurrent) => {
      const px = parseFloat(getCurrent().replace('rem','')) * 16;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '12';
      slider.max = '48';
      slider.step = '1';
      slider.value = String(Math.round(px));
      slider.style.flex = '1';
      slider.style.minWidth = '0';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:48px;text-align:right;color:#fff;font-weight:600;font-size:.78rem;padding-right:4px;';
      label.textContent = px.toFixed(0) + 'px';
      slider.addEventListener('input', () => {
        const rem = (parseFloat(slider.value) / 16).toFixed(3) + 'rem';
        label.textContent = slider.value + 'px';
        apply(mode, { fontSize: rem });
      });
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
      wrap.appendChild(slider); wrap.appendChild(label);
      return wrap;
    };

    const opacityRange = (mode, getCurrent) => {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '1'; slider.step = '0.05';
      slider.value = String(getCurrent());
      slider.style.flex = '1';
      slider.style.minWidth = '0';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:36px;text-align:right;color:#fff;font-weight:600;font-size:.78rem;padding-right:4px;';
      label.textContent = Math.round(getCurrent() * 100) + '%';
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        label.textContent = Math.round(v * 100) + '%';
        apply(mode, { imageOpacity: v });
      });
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
      wrap.appendChild(slider); wrap.appendChild(label);
      return wrap;
    };

    const row = (labelText, control) => {
      const r = document.createElement('div');
      r.className = 'prefs-row';
      const l = document.createElement('label'); l.textContent = labelText;
      r.appendChild(l); r.appendChild(control);
      return r;
    };

    const modeBlock = (mode, hasImage) => {
      const block = document.createElement('div');
      block.className = 'appearance-mode';
      const lbl = document.createElement('div');
      lbl.className = 'mode-label';
      lbl.dataset.mode = mode;
      lbl.textContent = mode;
      block.appendChild(lbl);

      const get = () => window.appearance?.get?.(mode) || window.appearance?.defaults?.()[mode];

      // Font family dropdown.
      const FONT_OPTIONS = [
        ['System',         'system'],
        ['Sans-serif',     'sans'],
        ['Serif',          'serif'],
        ['Monospace',      'mono'],
        ['Japanese sans',  'jpSans'],
        ['Japanese serif', 'jpSerif']
      ];
      const fontSelect = document.createElement('select');
      FONT_OPTIONS.forEach(([label, key]) => {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = label;
        if (get().fontFamily === key) opt.selected = true;
        fontSelect.appendChild(opt);
      });
      fontSelect.addEventListener('change', () => apply(mode, { fontFamily: fontSelect.value }));
      block.appendChild(row('Font family', fontSelect));

      block.appendChild(row('Font size', fontSizeRange(mode, () => get().fontSize)));

      if (mode === 'card' || mode === 'audio' || mode === 'read') {
        block.appendChild(row('Align', SEG(mode, 'align',
          [['Left','left'], ['Center','center'], ['Right','right']],
          () => get().align)));
      }

      // Read-mode only: choose how the currently-playing SRT cue is
      // marked. Text-recoloring avoids the overlap artefacts a translucent
      // bg can produce on tight line spacing.
      if (mode === 'read') {
        block.appendChild(row('Cue highlight', SEG(mode, 'highlightStyle',
          [['Text color','text'], ['Background','bg']],
          () => get().highlightStyle || 'text')));
      }

      if (hasImage) {
        block.appendChild(row('Image', SEG(mode, 'imageDisplay',
          [['Show','block'], ['Hide','none']],
          () => get().imageDisplay)));
        block.appendChild(row('Image opacity', opacityRange(mode, () => get().imageOpacity)));
        block.appendChild(row('Image position', SEG(mode, 'imageAlign',
          [['Top','flex-start'], ['Center','center'], ['Bottom','flex-end']],
          () => get().imageAlign)));
      }
      return block;
    };

    host.innerHTML = '';
    host.appendChild(modeBlock('card',  true));
    host.appendChild(modeBlock('read',  false));
    host.appendChild(modeBlock('audio', true));
  }

  function populateDeckSelect(select, decks, value) {
    select.innerHTML = '';
    if (!decks.length) {
      const opt = document.createElement('option');
      opt.textContent = '(AnkiConnect unreachable)';
      opt.value = '';
      select.appendChild(opt);
    } else {
      decks.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d; opt.textContent = d;
        select.appendChild(opt);
      });
    }
    if (value && !decks.includes(value)) {
      // Preserve the saved value even if AnkiConnect couldn't list it now.
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value + ' (saved)';
      select.appendChild(opt);
    }
    select.value = value || '';
  }

  // iOS uses AnkiMobile via URL scheme, which can't enumerate decks /
  // models / fields. Swap the Anki <select> dropdowns for free-text
  // <input> fields on iOS so the user can type the exact names that
  // exist in their AnkiMobile setup. The savePreferences flow reads
  // .value on the same id — works the same for both element types.
  function swapAnkiSelectsToInputsIfIOS() {
    const platform = window.Capacitor?.getPlatform?.() || '';
    if (platform !== 'ios') return;
    const ids = [
      'ankiSwipeDeck', 'ankiSwipeModel',
      'ankiSwipeFieldExpression', 'ankiSwipeFieldImage', 'ankiSwipeFieldAudio',
      'ankiDictDeck', 'ankiDictModel',
      'ankiDictFieldTerm', 'ankiDictFieldReading', 'ankiDictFieldSentence',
      'ankiDictFieldMeaning', 'ankiDictFieldImage',
      'ankiDictFieldSentenceAudio', 'ankiDictFieldTermAudio',
    ];
    for (const id of ids) {
      const sel = document.getElementById(id);
      if (!sel || sel.tagName !== 'SELECT') continue;
      const value = sel.value || '';
      const input = document.createElement('input');
      input.id = id;
      input.type = 'text';
      input.value = value;
      input.placeholder = id.includes('Deck')  ? 'Deck name (in AnkiMobile)'
                         : id.includes('Model') ? 'Note type (in AnkiMobile)'
                         : 'Field name (in AnkiMobile)';
      input.style.cssText = sel.style.cssText;
      input.className = sel.className;
      sel.parentNode.replaceChild(input, sel);
    }
  }

  window.openPreferences = async function() {
    const modal = document.getElementById('preferencesModal');
    if (!modal) return;
    // Pause the running timer for the duration of the modal — Preferences
    // is meta-config, not "active session", so it shouldn't keep ticking.
    if (window.stats?.pauseForModal) window.stats.pauseForModal();
    modal.style.display = 'flex';
    document.body.classList.add('prefs-open');

    buildAppearanceSection();
    buildDictionarySection();
    await wireAnkiSection();
    swapAnkiSelectsToInputsIfIOS();

    // Playback
    const timeoutInput = document.getElementById('timeoutInput');
    timeoutInput.value = (await getPref(PREF_KEYS.STOPWATCH_TIMEOUT)) || 20;

    const audioSpeedSlider = document.getElementById('audioSpeedSlider');
    const audioSpeedLabel = document.getElementById('audioSpeedLabel');
    if (audioSpeedSlider) {
      const saved = parseFloat(await getPref(PREF_KEYS.AUDIO_SPEED)) || 1;
      audioSpeedSlider.value = saved;
      if (audioSpeedLabel) audioSpeedLabel.textContent = saved.toFixed(2) + '×';
    }

    const subtitleOffsetSlider = document.getElementById('subtitleOffsetSlider');
    const subtitleOffsetLabel = document.getElementById('subtitleOffsetLabel');
    if (subtitleOffsetSlider) {
      const savedOffset = parseInt(await getPref(PREF_KEYS.SUBTITLE_OFFSET)) || 0;
      subtitleOffsetSlider.value = savedOffset;
      if (subtitleOffsetLabel) subtitleOffsetLabel.textContent = savedOffset + 'px';
    }
    const pauseToggle = document.getElementById('pauseOnLookupToggle');
    if (pauseToggle) {
      const v = localStorage.getItem('DICT_PAUSE_ON_LOOKUP');
      pauseToggle.checked = v === null || v === 'true';
    }
    if (typeof window.syncModeColorPickers === 'function') window.syncModeColorPickers();
  };

  window.closePreferences = function() {
    const modal = document.getElementById('preferencesModal');
    if (modal) modal.style.display = 'none';
    document.body.classList.remove('prefs-open');
    if (window.stats?.resumeFromModal) window.stats.resumeFromModal();
  };

  window.savePreferences = async function() {
    // Anki swipe-up
    const swipeDeck = document.getElementById('ankiSwipeDeck').value;
    await setPref(PREF_KEYS.ANKI_SWIPE_DECK,  swipeDeck);
    // Mirror to legacy SELECTED_DECK so old code paths keep working.
    await setPref(PREF_KEYS.SELECTED_DECK,    swipeDeck);
    await setPref(PREF_KEYS.ANKI_SWIPE_MODEL, document.getElementById('ankiSwipeModel').value);
    await setPref(PREF_KEYS.ANKI_SWIPE_F_EXPRESSION, document.getElementById('ankiSwipeFieldExpression').value);
    await setPref(PREF_KEYS.ANKI_SWIPE_F_IMAGE,      document.getElementById('ankiSwipeFieldImage').value);
    await setPref(PREF_KEYS.ANKI_SWIPE_F_AUDIO,      document.getElementById('ankiSwipeFieldAudio').value);

    // Anki dictionary
    await setPref(PREF_KEYS.ANKI_DICT_DECK,  document.getElementById('ankiDictDeck').value);
    await setPref(PREF_KEYS.ANKI_DICT_MODEL, document.getElementById('ankiDictModel').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_TERM,           document.getElementById('ankiDictFieldTerm').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_READING,        document.getElementById('ankiDictFieldReading').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_SENTENCE,       document.getElementById('ankiDictFieldSentence').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_MEANING,        document.getElementById('ankiDictFieldMeaning').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_IMAGE,          document.getElementById('ankiDictFieldImage').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_SENTENCE_AUDIO, document.getElementById('ankiDictFieldSentenceAudio').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_TERM_AUDIO,     document.getElementById('ankiDictFieldTermAudio').value);

    const timeoutInput = document.getElementById('timeoutInput');
    const audioSpeedSlider = document.getElementById('audioSpeedSlider');
    const subtitleOffsetSlider = document.getElementById('subtitleOffsetSlider');
    await setPref(PREF_KEYS.STOPWATCH_TIMEOUT, timeoutInput.value);
    if (audioSpeedSlider) {
      const r = parseFloat(audioSpeedSlider.value) || 1;
      if (typeof window.setGlobalPlaybackRate === 'function') {
        await window.setGlobalPlaybackRate(r);
      } else {
        await setPref(PREF_KEYS.AUDIO_SPEED, audioSpeedSlider.value);
        window.audioPlaybackRate = r;
      }
    }
    if (subtitleOffsetSlider) {
      await setPref(PREF_KEYS.SUBTITLE_OFFSET, subtitleOffsetSlider.value);
      applySubtitleOffset(subtitleOffsetSlider.value);
    }
    if (window.stopwatchTimeout !== undefined) {
      window.stopwatchTimeout = parseInt(timeoutInput.value) || 20;
    }
    const pauseToggle = document.getElementById('pauseOnLookupToggle');
    if (pauseToggle) {
      localStorage.setItem('DICT_PAUSE_ON_LOOKUP', pauseToggle.checked ? 'true' : 'false');
    }
    window.closePreferences();
    if (typeof showToast === 'function') showToast('Preferences saved', 2000);
  };

  // ---- Dictionary manager (enable + reorder + import) ----
  function buildDictionarySection() {
    const host = document.getElementById('prefsDictList');
    if (!host) return;
    const names = (typeof window.getLoadedDictionaryNames === 'function')
      ? window.getLoadedDictionaryNames() : [];
    const ordered = window.dictPrefs ? window.dictPrefs.orderedNames(names) : names;
    const importedSet = new Set((typeof window.listImportedDictionaries === 'function')
      ? window.listImportedDictionaries() : []);

    let html = `
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button id="dictImportBtn" class="btn" style="font-size:.78rem;">＋ Import Yomitan zip…</button>
        <span id="dictImportStatus" style="font-size:.75rem;color:#888;align-self:center;"></span>
      </div>
    `;
    if (!ordered.length) {
      html += '<div style="color:#666;font-size:.8rem;padding:8px 0;">No dictionaries loaded yet. Open Preferences again once startup loading completes.</div>';
    } else {
      html += ordered.map(name => `
        <div data-dict="${encodeURIComponent(name)}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1f1f1f;">
          <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
            <input type="checkbox" data-role="enabled" ${window.dictPrefs?.isEnabled(name) ? 'checked' : ''}>
            <span style="font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${name}${importedSet.has(name) ? ' <span style="color:#888;font-size:.7rem;">(imported)</span>' : ''}
            </span>
          </label>
          <button data-role="up"   class="btn" style="padding:4px 8px;font-size:.85rem;min-width:32px;">▲</button>
          <button data-role="down" class="btn" style="padding:4px 8px;font-size:.85rem;min-width:32px;">▼</button>
          ${importedSet.has(name) ? '<button data-role="remove" class="btn" style="padding:4px 8px;font-size:.85rem;color:#f44;" title="Remove imported dictionary">✕</button>' : ''}
        </div>
      `).join('');
    }
    host.innerHTML = html;

    document.getElementById('dictImportBtn')?.addEventListener('click', () => triggerDictImport());

    host.querySelectorAll('[data-dict]').forEach(row => {
      const name = decodeURIComponent(row.dataset.dict);
      row.querySelector('[data-role="enabled"]')?.addEventListener('change', (e) => {
        window.dictPrefs?.setEnabled(name, e.target.checked);
      });
      row.querySelector('[data-role="up"]')?.addEventListener('click', () => {
        const all = window.getLoadedDictionaryNames();
        window.dictPrefs?.moveUp(name, all);
        buildDictionarySection();
      });
      row.querySelector('[data-role="down"]')?.addEventListener('click', () => {
        const all = window.getLoadedDictionaryNames();
        window.dictPrefs?.moveDown(name, all);
        buildDictionarySection();
      });
      row.querySelector('[data-role="remove"]')?.addEventListener('click', async () => {
        if (!confirm(`Remove imported dictionary "${name}"? Its data will be cleared from device storage.`)) return;
        if (typeof window.removeImportedDictionary === 'function') {
          await window.removeImportedDictionary(name);
        }
        buildDictionarySection();
      });
    });
  }

  // Hidden file input for picking a Yomitan dictionary zip from device.
  function triggerDictImport() {
    let input = document.getElementById('dictImportInput');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.id = 'dictImportInput';
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    input.value = '';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const status = document.getElementById('dictImportStatus');
      if (status) status.textContent = 'Reading ' + f.name + '…';
      try {
        const buf = await f.arrayBuffer();
        if (status) status.textContent = 'Parsing…';
        const name = await window.importYomitanDictionaryFromBuffer(buf, { fallbackName: f.name });
        if (status) status.textContent = `Imported "${name}".`;
        buildDictionarySection();
      } catch (e) {
        console.error('Dict import failed:', e);
        if (status) status.textContent = 'Failed: ' + (e?.message || e);
      }
    };
    input.click();
  }

  // ---- Anki dropdown cascade ----
  //
  // Three layers, all populated from live AnkiConnect:
  //   Deck  → deckNames
  //   Model → modelNames                       (independent of deck — Anki's
  //                                             note types aren't deck-bound)
  //   Field → modelFieldNames(currentModel)    (re-fetches on model change)
  //
  // If AnkiConnect is unreachable, lists are empty but any previously-saved
  // value is preserved as a "(saved)" option so the user doesn't lose it.

  function fillSelect(sel, values, savedValue) {
    sel.innerHTML = '';
    const seen = new Set();
    if (values && values.length === 0 && savedValue) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(AnkiConnect unreachable)';
      opt.disabled = true;
      sel.appendChild(opt);
    }
    (values || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      sel.appendChild(opt);
      seen.add(v);
    });
    if (savedValue && !seen.has(savedValue)) {
      const opt = document.createElement('option');
      opt.value = savedValue; opt.textContent = savedValue + ' (saved)';
      sel.appendChild(opt);
    }
    sel.value = savedValue || (values?.[0] || '');
  }

  // For field-mapping rows: includes a "(none)" option so the user can
  // explicitly leave a slot unassigned.
  function fillFieldSelect(sel, fields, saved) {
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(none)';
    sel.appendChild(none);
    const seen = new Set();
    (fields || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      sel.appendChild(opt);
      seen.add(f);
    });
    if (saved && !seen.has(saved) && saved !== '') {
      const opt = document.createElement('option');
      opt.value = saved; opt.textContent = saved + ' (saved)';
      sel.appendChild(opt);
    }
    sel.value = saved || '';
  }

  // Identifier maps for each Anki target.
  const SWIPE_FIELD_IDS = {
    expression: 'ankiSwipeFieldExpression',
    image:      'ankiSwipeFieldImage',
    audio:      'ankiSwipeFieldAudio',
  };
  const DICT_FIELD_IDS = {
    term:          'ankiDictFieldTerm',
    reading:       'ankiDictFieldReading',
    sentence:      'ankiDictFieldSentence',
    meaning:       'ankiDictFieldMeaning',
    image:         'ankiDictFieldImage',
    sentenceAudio: 'ankiDictFieldSentenceAudio',
    termAudio:     'ankiDictFieldTermAudio',
  };
  const SWIPE_FIELD_PREFS = {
    expression: PREF_KEYS.ANKI_SWIPE_F_EXPRESSION,
    image:      PREF_KEYS.ANKI_SWIPE_F_IMAGE,
    audio:      PREF_KEYS.ANKI_SWIPE_F_AUDIO,
  };
  const DICT_FIELD_PREFS = {
    term:          PREF_KEYS.ANKI_DICT_F_TERM,
    reading:       PREF_KEYS.ANKI_DICT_F_READING,
    sentence:      PREF_KEYS.ANKI_DICT_F_SENTENCE,
    meaning:       PREF_KEYS.ANKI_DICT_F_MEANING,
    image:         PREF_KEYS.ANKI_DICT_F_IMAGE,
    sentenceAudio: PREF_KEYS.ANKI_DICT_F_SENTENCE_AUDIO,
    termAudio:     PREF_KEYS.ANKI_DICT_F_TERM_AUDIO,
  };

  async function refreshFieldDropdowns(target) {
    const isSwipe = target === 'swipe';
    const modelId   = isSwipe ? 'ankiSwipeModel' : 'ankiDictModel';
    const fieldIds  = isSwipe ? SWIPE_FIELD_IDS : DICT_FIELD_IDS;
    const fieldPrefs = isSwipe ? SWIPE_FIELD_PREFS : DICT_FIELD_PREFS;
    const defaults  = isSwipe ? ANKI_DEFAULTS.swipe.fields : ANKI_DEFAULTS.dict.fields;

    const model = document.getElementById(modelId)?.value || '';
    const fields = (typeof window.fetchModelFieldNames === 'function')
      ? await window.fetchModelFieldNames(model)
      : [];
    for (const slot of Object.keys(fieldIds)) {
      const sel = document.getElementById(fieldIds[slot]);
      if (!sel) continue;
      const saved = await getOr(fieldPrefs[slot], defaults[slot]);
      fillFieldSelect(sel, fields, saved);
    }
  }

  async function wireAnkiSection() {
    const decks  = (typeof fetchDeckNames  === 'function') ? await fetchDeckNames()  : [];
    const models = (typeof window.fetchModelNames === 'function') ? await window.fetchModelNames() : [];

    const swipeDeck  = document.getElementById('ankiSwipeDeck');
    const dictDeck   = document.getElementById('ankiDictDeck');
    const swipeModel = document.getElementById('ankiSwipeModel');
    const dictModel  = document.getElementById('ankiDictModel');
    const legacyDeck = document.getElementById('deckSelect');

    const savedSwipeDeck = await getOr(PREF_KEYS.ANKI_SWIPE_DECK,
      (await getOr(PREF_KEYS.SELECTED_DECK, ANKI_DEFAULTS.swipe.deck)));
    const savedDictDeck  = await getOr(PREF_KEYS.ANKI_DICT_DECK, ANKI_DEFAULTS.dict.deck);
    const savedSwipeModel = await getOr(PREF_KEYS.ANKI_SWIPE_MODEL, ANKI_DEFAULTS.swipe.model);
    const savedDictModel  = await getOr(PREF_KEYS.ANKI_DICT_MODEL,  ANKI_DEFAULTS.dict.model);

    fillSelect(swipeDeck,  decks,  savedSwipeDeck);
    fillSelect(dictDeck,   decks,  savedDictDeck);
    fillSelect(legacyDeck, decks,  savedSwipeDeck);
    fillSelect(swipeModel, models, savedSwipeModel);
    fillSelect(dictModel,  models, savedDictModel);

    // Re-fetch fields when the user changes the note type. Wired once per
    // element (dataset.wired guard) so reopening the modal doesn't pile up
    // handlers.
    if (swipeModel && !swipeModel.dataset.wired) {
      swipeModel.dataset.wired = '1';
      swipeModel.addEventListener('change', () => refreshFieldDropdowns('swipe'));
    }
    if (dictModel && !dictModel.dataset.wired) {
      dictModel.dataset.wired = '1';
      dictModel.addEventListener('change', () => refreshFieldDropdowns('dict'));
    }

    // Populate field dropdowns based on the currently-selected models.
    await Promise.all([refreshFieldDropdowns('swipe'), refreshFieldDropdowns('dict')]);

    // Other Preferences sections (mirrors of existing inputs).
    const timeoutInput = document.getElementById('timeoutInput');
    timeoutInput.value = (await getPref(PREF_KEYS.STOPWATCH_TIMEOUT)) || 20;
    const audioSpeedSlider = document.getElementById('audioSpeedSlider');
    const audioSpeedLabel = document.getElementById('audioSpeedLabel');
    if (audioSpeedSlider) {
      const saved = parseFloat(await getPref(PREF_KEYS.AUDIO_SPEED)) || 1;
      audioSpeedSlider.value = saved;
      if (audioSpeedLabel) audioSpeedLabel.textContent = saved.toFixed(2) + '×';
    }
    const subtitleOffsetSlider = document.getElementById('subtitleOffsetSlider');
    const subtitleOffsetLabel = document.getElementById('subtitleOffsetLabel');
    if (subtitleOffsetSlider) {
      const savedOffset = parseInt(await getPref(PREF_KEYS.SUBTITLE_OFFSET)) || 0;
      subtitleOffsetSlider.value = savedOffset;
      if (subtitleOffsetLabel) subtitleOffsetLabel.textContent = savedOffset + 'px';
    }
    if (typeof window.syncModeColorPickers === 'function') window.syncModeColorPickers();
  }

  // Expose a lazy reader for Anki settings — other modules use this so
  // they always pick up the latest saved values without re-implementing
  // the default-fallback logic.
  window.getAnkiSettings = async function (target) {
    if (target === 'swipe') {
      return {
        deck:  await getOr(PREF_KEYS.ANKI_SWIPE_DECK,
                  await getOr(PREF_KEYS.SELECTED_DECK, ANKI_DEFAULTS.swipe.deck)),
        model: await getOr(PREF_KEYS.ANKI_SWIPE_MODEL, ANKI_DEFAULTS.swipe.model),
        fields: {
          expression: await getOr(PREF_KEYS.ANKI_SWIPE_F_EXPRESSION, ANKI_DEFAULTS.swipe.fields.expression),
          image:      await getOr(PREF_KEYS.ANKI_SWIPE_F_IMAGE,      ANKI_DEFAULTS.swipe.fields.image),
          audio:      await getOr(PREF_KEYS.ANKI_SWIPE_F_AUDIO,      ANKI_DEFAULTS.swipe.fields.audio),
        }
      };
    }
    if (target === 'dict') {
      return {
        deck:  await getOr(PREF_KEYS.ANKI_DICT_DECK,  ANKI_DEFAULTS.dict.deck),
        model: await getOr(PREF_KEYS.ANKI_DICT_MODEL, ANKI_DEFAULTS.dict.model),
        fields: {
          term:          await getOr(PREF_KEYS.ANKI_DICT_F_TERM,           ANKI_DEFAULTS.dict.fields.term),
          reading:       await getOr(PREF_KEYS.ANKI_DICT_F_READING,        ANKI_DEFAULTS.dict.fields.reading),
          sentence:      await getOr(PREF_KEYS.ANKI_DICT_F_SENTENCE,       ANKI_DEFAULTS.dict.fields.sentence),
          meaning:       await getOr(PREF_KEYS.ANKI_DICT_F_MEANING,        ANKI_DEFAULTS.dict.fields.meaning),
          image:         await getOr(PREF_KEYS.ANKI_DICT_F_IMAGE,          ANKI_DEFAULTS.dict.fields.image),
          sentenceAudio: await getOr(PREF_KEYS.ANKI_DICT_F_SENTENCE_AUDIO, ANKI_DEFAULTS.dict.fields.sentenceAudio),
          termAudio:     await getOr(PREF_KEYS.ANKI_DICT_F_TERM_AUDIO,     ANKI_DEFAULTS.dict.fields.termAudio),
        }
      };
    }
    return null;
  };

  // -------- Startup: apply persisted playback prefs ----------
  async function waitForCapacitorPlugin(name, maxMs = 3000) {
    if (typeof window.isCapacitorEnvironment !== 'function' || !window.isCapacitorEnvironment()) return;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (window.Capacitor?.Plugins?.[name]) return;
      await new Promise(r => setTimeout(r, 25));
    }
  }

  async function applyStartupPrefs() {
    await waitForCapacitorPlugin('Preferences');
    const initialTimeout = await getPref(PREF_KEYS.STOPWATCH_TIMEOUT);
    if (initialTimeout) window.stopwatchTimeout = parseInt(initialTimeout);
    const initialAudioSpeed = await getPref(PREF_KEYS.AUDIO_SPEED);
    const r = parseFloat(initialAudioSpeed) || 1;
    window.audioPlaybackRate = r;
    // Fires the speed-button highlight too if available.
    if (typeof window.setGlobalPlaybackRate === 'function') {
      setTimeout(() => window.setGlobalPlaybackRate(r), 100);
    }
    const initialSubtitleOffset = await getPref(PREF_KEYS.SUBTITLE_OFFSET);
    if (initialSubtitleOffset != null) applySubtitleOffset(initialSubtitleOffset);
  }

  applyStartupPrefs();
  if (document.readyState !== 'complete') {
    window.addEventListener('load', applyStartupPrefs, { once: true });
  }
})();
