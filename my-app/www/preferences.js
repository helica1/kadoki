
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

  // Defaults: NO personal deck/note-type (the user picks those in Preferences —
  // on Android/iOS via the live "Fetch from Anki" dropdowns). Field names are
  // left as the standard Anki/jidoujisho names so a typical note type maps with
  // zero setup; they're overridden once the user picks a note type.
  const ANKI_DEFAULTS = {
    swipe: {
      deck: '',
      model: '',
      fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio' }
    },
    dict: {
      deck: '',
      model: '',
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

    // ---- Custom fonts (import a TTF/OTF, then pick it per mode) ----
    function triggerFontImport(onDone) {
      // iOS: WKWebView's <input type=file> silently drops .ttf/.otf selections
      // (it has no MIME/UTType mapping for fonts, so onchange never fires and
      // nothing imports). Route iOS through the native document picker the same
      // way every other file type is picked.
      const platform = window.Capacitor?.getPlatform?.() || '';
      const fa = window.Capacitor?.Plugins?.FileAccess;
      if (platform === 'ios' && fa?.pickFileWithUri && fa?.materializeToCache) {
        (async () => {
          try {
            const picked = await fa.pickFileWithUri({ type: 'font' });
            if (!picked?.uri) return;                 // user cancelled
            const mat = await fa.materializeToCache({ uri: picked.uri });
            if (!mat?.path || !window.fonts) return;
            // iOS WKWebView can't fetch file:// directly — read via the local
            // server URL (convertFileSrc), same as the apkg/audio paths.
            const url = window.Capacitor?.convertFileSrc
              ? window.Capacitor.convertFileSrc(mat.path)
              : ('file://' + mat.path);
            // iOS's WebViewAssetHandler serves a cached file with a bare response
            // (no HTTP status) unless a Range request routes it through the 206
            // branch — without this header the body comes back empty and the font
            // silently fails to register. Same pattern as local-audio.js / apkg-reader.js.
            const resp = await fetch(url, { headers: { Range: 'bytes=0-' } });
            const blob = await resp.blob();
            if (!blob || blob.size === 0) throw new Error('Font file came back empty');
            const name = picked.name || 'font.ttf';
            const file = new File([blob], name, { type: blob.type || '' });
            const info = await window.fonts.importFile(file);
            if (onDone) onDone(info);
          } catch (e) {
            alert('Font import failed: ' + (e && e.message || e));
          }
        })();
        return;
      }
      let input = document.getElementById('fontImportInput');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ttf,.otf,.ttc,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';
        input.id = 'fontImportInput';
        input.style.display = 'none';
        document.body.appendChild(input);
      }
      input.value = '';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f || !window.fonts) return;
        try { const info = await window.fonts.importFile(f); if (onDone) onDone(info); }
        catch (e) { alert('Font import failed: ' + (e && e.message || e)); }
      };
      input.click();
    }
    // Rebuild the whole appearance section so every mode's picker + the font
    // manager reflect an import/delete.
    function refreshAppearance() {
      if (host) { host.dataset.built = ''; buildAppearanceSection(); }
    }
    // Per-mode font picker: built-in serif/sans + imported customs + Import.
    function fontControl(mode, getCurrent) {
      const sel = document.createElement('select');
      const cur = getCurrent();
      [['Serif', 'serif'], ['Sans-serif', 'sans']].forEach(([label, val]) => {
        const o = document.createElement('option'); o.value = val; o.textContent = label;
        if (cur === val) o.selected = true; sel.appendChild(o);
      });
      ((window.fonts && window.fonts.list && window.fonts.list()) || []).forEach(f => {
        const o = document.createElement('option');
        o.value = 'custom:' + f.id; o.textContent = f.name;
        if (cur === 'custom:' + f.id) o.selected = true; sel.appendChild(o);
      });
      const imp = document.createElement('option');
      imp.value = '__import__'; imp.textContent = '➕ Import TTF…';
      sel.appendChild(imp);
      sel.addEventListener('change', () => {
        if (sel.value === '__import__') {
          sel.value = cur;   // don't leave "Import…" selected if cancelled
          triggerFontImport((info) => { apply(mode, { fontFamily: 'custom:' + info.id }); refreshAppearance(); });
          return;
        }
        apply(mode, { fontFamily: sel.value });
      });
      return sel;
    }

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

    // Boolean on/off control. getOn() reads the current state; onChange(bool)
    // persists. Works for real booleans and for the imageDisplay block/none var.
    const toggle = (getOn, onChange) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!getOn();
      cb.style.cssText = 'width:22px;height:22px;accent-color:var(--accent-read,#4caf50);cursor:pointer;';
      cb.addEventListener('change', () => onChange(cb.checked));
      return cb;
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

      // Font family — Serif / Sans-serif, any imported custom (TTF) fonts, and
      // an "Import TTF…" action. Shown for ALL modes so fonts can be set per
      // mode (read included).
      block.appendChild(row('Font family', fontControl(mode, () => get().fontFamily)));

      block.appendChild(row('Font size', fontSizeRange(mode, () => get().fontSize)));

      // Display toggles.
      if (mode === 'card') {
        block.appendChild(row('Text alignment', (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['center', 'Center'], ['left', 'Left']].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          sel.value = (get().align === 'left') ? 'left' : 'center';
          sel.addEventListener('change', () => apply('card', { align: sel.value }));
          return sel;
        })()));
        block.appendChild(row('Picture position', (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['flex-start', 'Top'], ['center', 'Centered'], ['flex-end', 'Bottom']].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          const cur = get().imageAlign;
          sel.value = (cur === 'flex-start' || cur === 'flex-end') ? cur : 'center';
          sel.addEventListener('change', () => apply('card', { imageAlign: sel.value }));
          return sel;
        })()));
        block.appendChild(row('Show background image', toggle(
          () => get().showBgImage !== false,
          (on) => apply('card', { showBgImage: on })
        )));
        block.appendChild(row('Show waveform', toggle(
          () => get().showWaveform !== false,
          (on) => apply('card', { showWaveform: on })
        )));
        block.appendChild(row('Show upcoming subtitle', toggle(
          () => get().showNextSub === true,
          (on) => apply('card', { showNextSub: on })
        )));
      }
      if (mode === 'audio') {
        block.appendChild(row('Show waveform', toggle(
          () => get().showWaveform !== false,
          (on) => apply('audio', { showWaveform: on })
        )));
        block.appendChild(row('Show upcoming subtitle', toggle(
          () => get().showNextSub === true,
          (on) => apply('audio', { showNextSub: on })
        )));
      }

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

    // Imported-fonts manager — list + delete (preview each name in its font).
    const imported = (window.fonts && window.fonts.list && window.fonts.list()) || [];
    if (imported.length) {
      const mgr = document.createElement('div');
      mgr.className = 'appearance-mode';
      const lbl = document.createElement('div');
      lbl.className = 'mode-label';
      lbl.textContent = 'Imported fonts';
      mgr.appendChild(lbl);
      imported.forEach(f => {
        const r = document.createElement('div');
        r.className = 'prefs-row';
        const nm = document.createElement('label');
        nm.textContent = f.name;
        nm.style.fontFamily = '"' + f.family + '", serif';
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete';
        del.style.cssText = 'background:#2a1414;color:#e88;border:1px solid #5a2a2a;border-radius:6px;padding:5px 12px;font-size:.8rem;cursor:pointer;';
        del.addEventListener('click', async () => {
          try { await window.fonts.remove(f.id); } catch (_) {}
          refreshAppearance();
        });
        r.appendChild(nm); r.appendChild(del);
        mgr.appendChild(r);
      });
      host.appendChild(mgr);
    }
  }

  // Empty-list placeholder text — platform-aware. iOS has no AnkiConnect; its
  // lists come from the "Fetch from Anki" round-trip, so point the user there
  // instead of showing a confusing AnkiConnect message.
  function ankiEmptyListLabel() {
    return (window.Capacitor?.getPlatform?.() === 'ios')
      ? '(tap "Fetch from Anki")'
      : '(AnkiConnect unreachable)';
  }

  function populateDeckSelect(select, decks, value) {
    select.innerHTML = '';
    if (!decks.length) {
      const opt = document.createElement('option');
      opt.textContent = ankiEmptyListLabel();
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

  // iOS: AnkiMobile has no live per-call listing, but anki://x-callback-url/
  // infoForAdding returns the decks / note types (each with its fields) after an
  // app-switch round-trip. Keep the SAME dropdowns as Android — they're populated
  // from the cached fetch via fetchDeckNames/fetchModelNames/fetchModelFieldNames
  // — and add a "Fetch from Anki" button per Anki section to run the round-trip
  // and repopulate. (Android auto-populates live, so it gets no button.)
  function setupIOSAnkiPickers() {
    const platform = window.Capacitor?.getPlatform?.() || '';
    if (platform !== 'ios') return;
    injectIOSAnkiFetchButton();
    // Recover a cold-launch result: if a prior "Fetch from Anki" returned while
    // the app had been evicted, the native side cached it (getLastInfo) — load it
    // so the dropdowns populate without another AnkiMobile round-trip.
    (async () => {
      try {
        if (window._iosAnkiInfo && (window._iosAnkiInfo.decks || []).length) return;
        const ab = window.Capacitor?.Plugins?.AnkiBridge;
        if (!ab || typeof ab.getLastInfo !== 'function') return;
        const info = await ab.getLastInfo();
        if (info && (info.decks || []).length) {
          window._iosAnkiInfo = { decks: info.decks || [], notetypes: info.notetypes || [] };
          if (typeof wireAnkiSection === 'function') await wireAnkiSection();
        }
      } catch (_) {}
    })();
    // iOS-only "Link AnkiMobile media folder" affordance (security-scoped
    // bookmark to AnkiMobile's collection.media for silent media delivery).
    injectIOSMediaFolderLinker();
  }

  function injectIOSAnkiFetchButton() {
    document.querySelectorAll('.prefs-section').forEach((s) => {
      const isAnki = s.textContent.includes('Anki: swipe-up') ||
                     s.textContent.includes('Anki: dictionary add-word');
      if (!isAnki || s.querySelector('[data-role="anki-fetch"]')) return; // dedupe
      const row = document.createElement('div');
      row.style.cssText = 'margin:10px 0;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.role = 'anki-fetch';
      btn.textContent = '⤓ Fetch decks, note types & fields from Anki';
      btn.style.cssText = 'background:#1a1a1a;color:var(--text,#e8e8e8);border:1px solid #333;' +
        'border-radius:8px;padding:8px 14px;font-size:.85rem;cursor:pointer;-webkit-tap-highlight-color:transparent;';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:.72rem;color:#888;margin-top:4px;';
      note.textContent = 'Opens AnkiMobile and returns here. Run once — and again after you add decks/note types in Anki.';
      btn.addEventListener('click', async () => {
        if (typeof window.fetchAnkiInfoIOS !== 'function') { alert('AnkiMobile bridge unavailable.'); return; }
        const label = btn.textContent; btn.disabled = true; btn.textContent = 'Opening AnkiMobile…';
        try {
          const info = await window.fetchAnkiInfoIOS();
          if (typeof wireAnkiSection === 'function') await wireAnkiSection(); // repopulate all dropdowns from the cache
          const nd = (info.decks || []).length, nt = (info.notetypes || []).length;
          btn.textContent = `✓ ${nd} decks, ${nt} note types`;
          setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
        } catch (e) {
          alert('Could not fetch from AnkiMobile: ' + ((e && e.message) || e) +
                '\n\nMake sure AnkiMobile is installed and up to date, then try again.');
          btn.textContent = label; btn.disabled = false;
        }
      });
      row.appendChild(btn); row.appendChild(note);
      const summary = s.querySelector('summary');
      if (summary) s.insertBefore(row, summary.nextSibling); else s.prepend(row);
    });
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

  // "Combine short subtitles" toggle (card mode). Stored as KADOKI_COMBINE_SUBS
  // ('1'/'0', default on). The per-card size is no longer a manual value — it's
  // derived from the screen (computeCardLineBudget in app.js), so the old
  // KADOKI_COMBINE_SUBS_MAX char-limit input was removed.
  async function setupCombineSubsPref() {
    const cb = document.getElementById('combineSubsToggle');
    if (!cb) return;
    try {
      const rv = await getPref('KADOKI_COMBINE_SUBS');
      cb.checked = (rv === null || rv === undefined) ? true : (rv !== '0' && rv !== 'false');
    } catch (_) { cb.checked = true; }
    if (!cb.dataset.wired) {
      cb.dataset.wired = '1';
      cb.addEventListener('change', () => { setPref('KADOKI_COMBINE_SUBS', cb.checked ? '1' : '0'); });
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
    await setupCombineSubsPref();
    await wireAnkiSection();
    setupIOSAnkiPickers();

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
      opt.textContent = ankiEmptyListLabel();
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
