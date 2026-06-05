
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
    ANKI_DICT_F_GLOSSARY:       'ANKI_DICT_F_GLOSSARY',
    ANKI_DICT_F_TERM_FURIGANA:  'ANKI_DICT_F_TERM_FURIGANA',
  };

  // Defaults preserve the user's current hardcoded behavior so legacy decks
  // keep working before they open Preferences once.
  const ANKI_DEFAULTS = {
    swipe: {
      deck: 'Shadowing9',
      model: 'jidoujisho Kinomoto BLUE',
      fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio' }
    },
    dict: {
      deck: 'Mining',
      model: 'jidoujisho Kinomoto',
      fields: {
        term: 'Term', reading: 'Reading', sentence: 'Sentence', meaning: 'Meaning',
        image: 'Image', sentenceAudio: 'Sentence Audio', termAudio: 'Term Audio',
        // Optional rich extras — default unmapped so nothing changes until the
        // user picks a field for them.
        glossary: '', termFurigana: ''
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

    // Font size control: -/+ buttons + numeric label. Replaces the
    // earlier <input type=range> which was very laggy on iOS WKWebView
    // (each input event repainted the entire mode view + dict popup
    // CSS variables, queuing a backlog of style recalc).
    const fontSizeRange = (mode, getCurrent) => {
      const FONT_MIN_PX = 12;
      const FONT_MAX_PX = 64;
      const FONT_STEP_PX = 1;
      const startPx = Math.round(parseFloat(getCurrent().replace('rem', '')) * 16);
      let currentPx = Math.max(FONT_MIN_PX, Math.min(FONT_MAX_PX, startPx));

      const btnStyle =
        'width:34px;height:34px;background:#1a1a1a;color:var(--text,#e8e8e8);' +
        'border:1px solid #333;border-radius:6px;font-size:1.1rem;font-weight:700;' +
        'cursor:pointer;touch-action:manipulation;display:flex;align-items:center;' +
        'justify-content:center;-webkit-tap-highlight-color:transparent;';
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.style.cssText = btnStyle;
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.style.cssText = btnStyle;
      const label = document.createElement('span');
      label.style.cssText = 'min-width:54px;text-align:center;color:#fff;font-weight:600;font-size:.85rem;font-variant-numeric:tabular-nums;';
      label.textContent = currentPx + 'px';

      const updateBounds = () => {
        minus.disabled = currentPx <= FONT_MIN_PX;
        plus.disabled  = currentPx >= FONT_MAX_PX;
        minus.style.opacity = minus.disabled ? '0.4' : '1';
        plus.style.opacity  = plus.disabled  ? '0.4' : '1';
      };
      updateBounds();

      const writeSize = () => {
        label.textContent = currentPx + 'px';
        const rem = (currentPx / 16).toFixed(3) + 'rem';
        apply(mode, { fontSize: rem });
        updateBounds();
      };
      const step = (dir) => {
        const next = currentPx + dir * FONT_STEP_PX;
        if (next < FONT_MIN_PX || next > FONT_MAX_PX) return;
        currentPx = next;
        writeSize();
      };
      minus.addEventListener('click', () => step(-1));
      plus .addEventListener('click', () => step(+1));

      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-end;';
      wrap.appendChild(minus);
      wrap.appendChild(label);
      wrap.appendChild(plus);
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

    // Card-only: subtitle vertical offset + stopwatch timeout (moved here
    // from a deleted standalone Card mode prefs section).
    const subtitleOffsetRow = () => {
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '150'; slider.step = '1';
      const saved = parseInt(localStorage.getItem('SUBTITLE_OFFSET')) || 65;
      slider.value = String(saved);
      slider.style.flex = '1'; slider.style.minWidth = '0';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:48px;text-align:right;color:#fff;font-weight:600;font-size:.78rem;padding-right:4px;';
      label.textContent = slider.value + 'px';
      slider.addEventListener('input', () => {
        label.textContent = slider.value + 'px';
        document.documentElement.style.setProperty('--subtitle-offset', slider.value + 'px');
        // Mirror to the hidden slider the save handler reads.
        const hidden = document.getElementById('subtitleOffsetSlider');
        if (hidden) hidden.value = slider.value;
        const hiddenLabel = document.getElementById('subtitleOffsetLabel');
        if (hiddenLabel) hiddenLabel.textContent = slider.value + 'px';
      });
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
      wrap.appendChild(slider); wrap.appendChild(label);
      return wrap;
    };
    const stopwatchTimeoutRow = () => {
      const input = document.createElement('input');
      input.type = 'number'; input.min = '5'; input.max = '600';
      input.style.cssText = 'width:90px;background:#0c0c0c;color:#e8e8e8;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
      const saved = parseInt(localStorage.getItem('STOPWATCH_TIMEOUT')) || 60;
      input.value = String(saved);
      input.addEventListener('input', () => {
        const v = parseInt(input.value);
        if (Number.isFinite(v)) {
          window.stopwatchTimeout = v;
          const hidden = document.getElementById('timeoutInput');
          if (hidden) hidden.value = input.value;
        }
      });
      return input;
    };

    const modeBlock = (mode) => {
      const block = document.createElement('div');
      block.className = 'appearance-mode';
      const lbl = document.createElement('div');
      lbl.className = 'mode-label';
      lbl.dataset.mode = mode;
      lbl.textContent = mode;
      block.appendChild(lbl);

      const get = () => window.appearance?.get?.(mode) || window.appearance?.defaults?.()[mode];

      // Font family — only Serif / Sans-serif, and only for Card + Audio.
      // Read mode is locked to Serif per user request.
      if (mode === 'card' || mode === 'audio') {
        const FONT_OPTIONS = [
          ['Serif',      'serif'],
          ['Sans-serif', 'sans']
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
      }

      block.appendChild(row('Font size', fontSizeRange(mode, () => get().fontSize)));

      // Card-only extras (moved from the deleted Card mode prefs section).
      if (mode === 'card') {
        block.appendChild(row('Subtitle vertical offset', subtitleOffsetRow()));
        block.appendChild(row('Stopwatch inactivity timeout (s)', stopwatchTimeoutRow()));
      }
      return block;
    };

    host.innerHTML = '';
    host.appendChild(modeBlock('card'));
    host.appendChild(modeBlock('read'));
    host.appendChild(modeBlock('audio'));
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
    // Add the iOS-only "Link AnkiMobile media folder" affordance below
    // the dictionary Anki section. Lets the user grant our app a
    // security-scoped bookmark to AnkiMobile's collection.media folder
    // so audio/image bytes deliver silently via direct file write.
    injectIOSMediaFolderLinker();
  }

  function injectIOSMediaFolderLinker() {
    const ab = window.Capacitor?.Plugins?.AnkiBridge;
    if (!ab || typeof ab.linkMediaFolder !== 'function') return;
    // Find the Anki dictionary section to append to.
    const sections = document.querySelectorAll('.prefs-section');
    let target = null;
    sections.forEach(s => {
      if (s.textContent.includes('Anki: dictionary add-word')) target = s;
    });
    if (!target) return;
    if (target.querySelector('[data-role="anki-media-link"]')) return; // dedupe

    const row = document.createElement('div');
    row.className = 'prefs-row';
    row.setAttribute('data-role', 'anki-media-link');
    row.style.alignItems = 'flex-start';
    row.innerHTML = `
      <label style="flex:0 0 45%;line-height:1.35;">Media folder
        <span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">
          Optional fallback. Primary delivery uses the in-app HTTP server — no linking required.
        </span>
      </label>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;">
        <div data-role="status" style="font-size:.78rem;color:var(--text-muted,#888);">Checking…</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button data-role="link" class="btn" style="flex:1;background:transparent;color:var(--accent-cyan,#00ffcc);border:1px solid var(--accent-cyan,#00ffcc);padding:6px 10px;border-radius:6px;font-size:.78rem;">Link folder</button>
          <button data-role="unlink" class="btn" style="background:transparent;color:var(--text-muted,#888);border:1px solid var(--border,#2a2a2a);padding:6px 10px;border-radius:6px;font-size:.78rem;display:none;">Unlink</button>
          <button data-role="test-anki" class="btn" style="flex:1;background:transparent;color:var(--accent-warn,#ffd54a);border:1px solid var(--accent-warn,#ffd54a);padding:6px 10px;border-radius:6px;font-size:.78rem;">Send test card</button>
        </div>
      </div>
    `;
    target.appendChild(row);

    const status = row.querySelector('[data-role="status"]');
    const linkBtn = row.querySelector('[data-role="link"]');
    const unlinkBtn = row.querySelector('[data-role="unlink"]');
    const testBtn = row.querySelector('[data-role="test-anki"]');

    async function refresh() {
      try {
        const r = await ab.getMediaFolderStatus();
        if (r?.linked) {
          status.textContent = '✓ Linked: ' + (r.name || 'collection.media');
          status.style.color = 'var(--accent-read,#4caf50)';
          linkBtn.textContent = 'Re-link';
          unlinkBtn.style.display = 'inline-block';
        } else {
          status.textContent = 'Not linked (fallback only — not required)';
          status.style.color = 'var(--text-muted,#888)';
          linkBtn.textContent = 'Link folder';
          unlinkBtn.style.display = 'none';
        }
      } catch (e) {
        status.textContent = 'Status check failed';
      }
    }
    refresh();

    linkBtn.addEventListener('click', async () => {
      try {
        await ab.linkMediaFolder();
      } catch (e) {
        alert('Could not link folder: ' + (e?.message || e));
      }
      refresh();
    });
    unlinkBtn.addEventListener('click', async () => {
      await ab.unlinkMediaFolder();
      refresh();
    });

    // Minimal-card diagnostic — bypasses media, sentence, image and
    // sends a single Term="anki-bridge-test-<timestamp>". If the test
    // card lands in AnkiMobile but real sends don't, the model name
    // and deck are fine — the issue is media/HTTP server / large URL.
    // If the test card ALSO doesn't land, model name or deck name
    // is wrong in Preferences.
    testBtn.addEventListener('click', async () => {
      try {
        const cfg = (typeof window.getAnkiSettings === 'function')
          ? await window.getAnkiSettings('dict')
          : null;
        if (!cfg) { alert('Anki settings unavailable'); return; }
        const fields = {};
        fields[cfg.fields.term] = `anki-bridge-test-${Date.now()}`;
        const cbPromise = (typeof window.waitForAnkiCallback === 'function')
          ? window.waitForAnkiCallback(8000)
          : Promise.resolve('unknown');
        const r = await ab.addNote({
          deckName: cfg.deck,
          modelName: cfg.model,
          fields,
          tags: ['anki-bridge-test'],
        });
        const constructedUrl = r?.constructedUrl || '(unknown)';
        console.log('[anki-test] sent URL:', constructedUrl);
        console.log('[anki-test] addNote ->', r);
        const cbResult = await cbPromise;
        console.log('[anki-test] callback result:', cbResult,
                    'lastCallbackUrl:', window._lastAnkiCallbackUrl);

        // Show outcome + offer to copy the URL to clipboard so user can
        // paste it directly into Safari. If Safari also fails to create a
        // card, the URL itself (model/deck/profile) is wrong. If Safari
        // succeeds but our plugin fails, it's a UIApplication.open issue.
        const verdict = (cbResult === 'success')
          ? `✓ TEST OK — model/deck names work. If real sends fail, the issue is media-related.`
          : (cbResult === 'error')
          ? `✗ TEST REJECTED by AnkiMobile (model "${cfg.model}" invalid). Tap OK to copy the URL.`
          : `? TEST: no reply from AnkiMobile.\n\nSent: model="${cfg.model}" deck="${cfg.deck}"\nLast callback URL seen: ${window._lastAnkiCallbackUrl || '(none)'}\n\nTap OK to copy the URL for manual Safari testing.`;
        const confirmed = window.confirm(verdict + '\n\n— URL —\n' + constructedUrl);
        if (confirmed && constructedUrl !== '(unknown)') {
          try {
            await navigator.clipboard.writeText(constructedUrl);
            if (typeof window.showToast === 'function') {
              window.showToast('URL copied. Paste in Safari to test AnkiMobile directly.', 5000);
            }
          } catch (clipErr) {
            // Fallback: textarea hack
            const ta = document.createElement('textarea');
            ta.value = constructedUrl;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
            if (typeof window.showToast === 'function') {
              window.showToast('URL copied (fallback). Paste in Safari to test.', 5000);
            }
          }
        }
      } catch (e) {
        console.error('[anki-test] failed:', e);
        if (typeof window.showToast === 'function') {
          window.showToast(`✗ Test failed: ${e?.message || e}`, 5000);
        }
      }
    });
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
      // Default 30px so the subtitle clears the shell top bar instead
      // of starting flush at the safe-area inset (where it was hidden).
      const raw = await getPref(PREF_KEYS.SUBTITLE_OFFSET);
      const savedOffset = (raw === null || raw === undefined || raw === '')
        ? 30
        : (parseInt(raw) || 0);
      applySubtitleOffset(savedOffset);
      subtitleOffsetSlider.value = savedOffset;
      if (subtitleOffsetLabel) subtitleOffsetLabel.textContent = savedOffset + 'px';
    }
    const pauseToggle = document.getElementById('pauseOnLookupToggle');
    if (pauseToggle) {
      const v = localStorage.getItem('DICT_PAUSE_ON_LOOKUP');
      pauseToggle.checked = v === null || v === 'true';
    }
    const contToggle = document.getElementById('continuousModeToggle');
    if (contToggle) contToggle.checked = localStorage.getItem('CONTINUOUS_MODE_V1') === 'true';
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
    await setPref(PREF_KEYS.ANKI_DICT_F_GLOSSARY,       document.getElementById('ankiDictFieldGlossary').value);
    await setPref(PREF_KEYS.ANKI_DICT_F_TERM_FURIGANA,  document.getElementById('ankiDictFieldFurigana').value);

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
    const contToggle = document.getElementById('continuousModeToggle');
    if (contToggle) {
      localStorage.setItem('CONTINUOUS_MODE_V1', contToggle.checked ? 'true' : 'false');
      window._continuousMode = contToggle.checked;
    }
    window.closePreferences();
    if (typeof showToast === 'function') showToast('Preferences saved', 2000);
  };

  // ---- Dictionary manager (enable + reorder + import) ----
  async function buildDictionarySection() {
    const host = document.getElementById('prefsDictList');
    if (!host) return;
    // After dict-store migration, the in-memory `dictionaries` Map can be
    // empty (lookups go straight to IDB). Merge both sources so dicts
    // imported into the store show up in the manager.
    const memNames = (typeof window.getLoadedDictionaryNames === 'function')
      ? window.getLoadedDictionaryNames() : [];
    let storeNames = [];
    const countByName = new Map();   // dictName -> entryCount (for display)
    try {
      if (window.dictStore?.list) {
        const meta = await window.dictStore.list();
        storeNames = meta.map(m => m.dictName);
        for (const m of meta) if (typeof m.entryCount === 'number') countByName.set(m.dictName, m.entryCount);
      }
    } catch (e) {}
    // Names that actually have ENTRIES records. Anything here WITHOUT a meta row
    // is an orphaned relic (e.g. an interrupted delete, or an old build's leftover)
    // that lookups still serve — surface it so it's visible AND deletable.
    let entryDicts = [];
    try { if (window.dictStore?.listEntryDicts) entryDicts = await window.dictStore.listEntryDicts(); } catch (e) {}
    const entryNameSet = new Set(entryDicts.map(d => d.dictName));
    for (const d of entryDicts) if (!countByName.has(d.dictName)) countByName.set(d.dictName, d.entryCount);
    const storeNameSet = new Set(storeNames);
    const orphanNames = entryDicts.map(d => d.dictName).filter(n => !storeNameSet.has(n));

    const seen = new Set();
    const names = [];
    for (const n of [...memNames, ...storeNames, ...orphanNames]) {
      // Hide a name ONLY if it's the legacy in-memory bundled JMDict with NO
      // backing store data (no meta row AND no entries). Anything with real
      // store data stays visible + deletable.
      const isLegacyOnly = (n === 'JMDict' || n === 'JMdict') &&
                           !storeNameSet.has(n) && !entryNameSet.has(n);
      if (isLegacyOnly) continue;
      if (!seen.has(n)) { seen.add(n); names.push(n); }
    }
    const ordered = window.dictPrefs ? window.dictPrefs.orderedNames(names) : names;
    const importedSet = new Set((typeof window.listImportedDictionaries === 'function')
      ? window.listImportedDictionaries() : []);

    let html = `
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;">
        <button id="dictImportBtn" class="btn" style="font-size:.78rem;">＋ Import Yomitan zip…</button>
        <span id="dictImportStatus" style="font-size:.75rem;color:#888;align-self:center;"></span>
      </div>
      <div id="dictImportBarWrap" style="display:none;height:6px;background:#222;border-radius:3px;overflow:hidden;margin:0 0 10px;">
        <div id="dictImportBar" style="width:0%;height:100%;background:#4caf50;transition:width .2s ease;"></div>
      </div>
    `;
    if (!ordered.length) {
      html += '<div style="color:#666;font-size:.8rem;padding:8px 0;">No dictionaries loaded yet. Open Preferences again once startup loading completes.</div>';
    } else {
      html += ordered.map(name => {
        const cnt = countByName.get(name);
        const isOrphan = !storeNameSet.has(name) && entryNameSet.has(name);
        const tag = isOrphan
          ? ' <span style="color:#f80;font-size:.7rem;">(orphaned relic)</span>'
          : importedSet.has(name) ? ' <span style="color:#888;font-size:.7rem;">(imported)</span>' : '';
        const cntTxt = (typeof cnt === 'number')
          ? ` <span style="color:#666;font-size:.7rem;">· ${cnt.toLocaleString()} entries</span>` : '';
        const removable = storeNameSet.has(name) || entryNameSet.has(name) || importedSet.has(name);
        return `
        <div data-dict="${encodeURIComponent(name)}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1f1f1f;">
          <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;">
            <input type="checkbox" data-role="enabled" ${window.dictPrefs?.isEnabled(name) ? 'checked' : ''}>
            <span style="font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${name}${tag}${cntTxt}
            </span>
          </label>
          <button data-role="up"   class="btn" style="padding:4px 8px;font-size:.85rem;min-width:32px;">▲</button>
          <button data-role="down" class="btn" style="padding:4px 8px;font-size:.85rem;min-width:32px;">▼</button>
          ${removable ? '<button data-role="remove" class="btn" style="padding:4px 8px;font-size:.85rem;color:#f44;" title="Remove dictionary">✕</button>' : ''}
        </div>`;
      }).join('');
    }
    host.innerHTML = html;

    document.getElementById('dictImportBtn')?.addEventListener('click', () => triggerDictImport());

    host.querySelectorAll('[data-dict]').forEach(row => {
      const name = decodeURIComponent(row.dataset.dict);
      row.querySelector('[data-role="enabled"]')?.addEventListener('change', (e) => {
        window.dictPrefs?.setEnabled(name, e.target.checked);
      });
      row.querySelector('[data-role="up"]')?.addEventListener('click', () => {
        const all = names; // merged store+mem list (in-memory Map is empty post-migration)
        window.dictPrefs?.moveUp(name, all);
        buildDictionarySection();
      });
      row.querySelector('[data-role="down"]')?.addEventListener('click', () => {
        const all = names; // merged store+mem list (in-memory Map is empty post-migration)
        window.dictPrefs?.moveDown(name, all);
        buildDictionarySection();
      });
      row.querySelector('[data-role="remove"]')?.addEventListener('click', async () => {
        if (!confirm(`Remove dictionary "${name}"? Its data will be cleared from device storage.`)) return;
        // Re-query each tick so the bar/text survive any re-render during the
        // (potentially many-second) batched delete of a large dictionary.
        const setStatus = (m) => { const s = document.getElementById('dictImportStatus'); if (s) s.textContent = m; };
        const setBar = (pct) => {
          const w = document.getElementById('dictImportBarWrap');
          const b = document.getElementById('dictImportBar');
          if (w) w.style.display = 'block';
          if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
        };
        setStatus(`Removing "${name}"…`);
        setBar(3);
        if (typeof window.removeImportedDictionary === 'function') {
          await window.removeImportedDictionary(name, (p) => {
            const pct = Math.floor((p.pct || 0) * 100);
            setStatus(`Removing "${name}"… ${pct}%`);
            setBar((p.pct || 0) * 100);
          });
        }
        const w = document.getElementById('dictImportBarWrap');
        if (w) w.style.display = 'none';
        buildDictionarySection(); // row disappears once fully removed from the store
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
      const status  = document.getElementById('dictImportStatus');
      const barWrap = document.getElementById('dictImportBarWrap');
      const bar     = document.getElementById('dictImportBar');
      const setStatus = (msg) => { if (status) status.textContent = msg; };
      const setBar = (pct) => {
        if (barWrap) barWrap.style.display = 'block';
        if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      };
      const hideBar = () => { if (barWrap) barWrap.style.display = 'none'; if (bar) bar.style.width = '0%'; };
      const phaseLabel = {
        unzip: 'Unzipping…', parse: 'Parsing entries…', cache: 'Saving…',
        index: 'Indexing…', done: 'Imported'
      };
      // Collapse each phase's local pct onto ONE monotonic 0–100 bar, so a big
      // dictionary's long parse + index phases visibly advance instead of the
      // status sitting at "Indexing 0%" for minutes.
      const overall = (p) => {
        const x = Math.max(0, Math.min(1, p.pct || 0));
        switch (p.phase) {
          case 'unzip': return 2;
          case 'parse': return 5 + x * 45;
          case 'cache': return 52;
          case 'index': return 55 + x * 45;
          case 'done':  return 100;
          default:      return x * 100;
        }
      };
      setStatus('Reading ' + f.name + '…');
      setBar(1);
      try {
        const buf = await f.arrayBuffer();
        const name = await window.importYomitanDictionaryFromBuffer(buf, {
          fallbackName: f.name,
          onProgress: (p) => {
            const within = Math.floor((p.pct || 0) * 100);
            const label = phaseLabel[p.phase] || p.phase;
            // Show the within-phase % on the long phases so motion is visible.
            setStatus((p.phase === 'parse' || p.phase === 'index') ? `${label} ${within}%` : label);
            setBar(overall(p));
          }
        });
        setStatus(`Imported "${name}". Lookups ready.`);
        setBar(100);
        buildDictionarySection();
        setTimeout(hideBar, 1500);
      } catch (e) {
        console.error('Dict import failed:', e);
        setStatus('Failed: ' + (e?.message || e));
        hideBar();
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
    glossary:      'ankiDictFieldGlossary',
    termFurigana:  'ankiDictFieldFurigana',
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
    glossary:      PREF_KEYS.ANKI_DICT_F_GLOSSARY,
    termFurigana:  PREF_KEYS.ANKI_DICT_F_TERM_FURIGANA,
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
      // Default 30px so the subtitle clears the shell top bar instead
      // of starting flush at the safe-area inset (where it was hidden).
      const raw = await getPref(PREF_KEYS.SUBTITLE_OFFSET);
      const savedOffset = (raw === null || raw === undefined || raw === '')
        ? 30
        : (parseInt(raw) || 0);
      applySubtitleOffset(savedOffset);
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
          glossary:      await getOr(PREF_KEYS.ANKI_DICT_F_GLOSSARY,       ANKI_DEFAULTS.dict.fields.glossary),
          termFurigana:  await getOr(PREF_KEYS.ANKI_DICT_F_TERM_FURIGANA,  ANKI_DEFAULTS.dict.fields.termFurigana),
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
    // Apply subtitle offset on launch. Default 30px when never set so the
    // subtitle clears the top bar; the user can adjust in Preferences →
    // Card mode → Subtitle vertical offset.
    const initialSubtitleOffset = await getPref(PREF_KEYS.SUBTITLE_OFFSET);
    if (initialSubtitleOffset != null && initialSubtitleOffset !== '') {
      applySubtitleOffset(initialSubtitleOffset);
    } else {
      applySubtitleOffset(65);
    }
  }

  // Continuous-mode flag — read synchronously at load so shell.js mode
  // switches (which can run before applyStartupPrefs resolves) see the saved
  // value. Defaults to false (today's behavior) when never set.
  try { window._continuousMode = localStorage.getItem('CONTINUOUS_MODE_V1') === 'true'; } catch (_) {}

  applyStartupPrefs();
  if (document.readyState !== 'complete') {
    window.addEventListener('load', applyStartupPrefs, { once: true });
  }
})();
