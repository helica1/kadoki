
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
            alert(window.i18n.fmt('pj.font_import_failed', { err: (e && e.message || e) }));
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
        catch (e) { alert(window.i18n.fmt('pj.font_import_failed', { err: (e && e.message || e) })); }
      };
      input.click();
    }
    // Rebuild the whole appearance section so every mode's picker + the font
    // manager reflect an import/delete.
    function refreshAppearance() {
      if (host) { host.dataset.built = ''; buildAppearanceSection(); }
    }
    // Per-mode font picker: built-in serif/sans + imported customs + Import.
    function fontControl(mode, getCurrent, baseOptions) {
      const sel = document.createElement('select');
      const cur = getCurrent();
      (baseOptions || [[window.i18n.t('pj.font_serif', 'Serif'), 'serif'], [window.i18n.t('pj.font_sans', 'Sans-serif'), 'sans']]).forEach(([label, val]) => {
        const o = document.createElement('option'); o.value = val; o.textContent = label;
        if (cur === val) o.selected = true; sel.appendChild(o);
      });
      ((window.fonts && window.fonts.list && window.fonts.list()) || []).forEach(f => {
        const o = document.createElement('option');
        o.value = 'custom:' + f.id; o.textContent = f.name;
        if (cur === 'custom:' + f.id) o.selected = true; sel.appendChild(o);
      });
      const imp = document.createElement('option');
      imp.value = '__import__'; imp.textContent = window.i18n.t('pj.import_ttf', '➕ Import TTF…');
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
      lbl.textContent = window.i18n.t('pj.mode_' + mode, mode);
      block.appendChild(lbl);

      const get = () => window.appearance?.get?.(mode) || window.appearance?.defaults?.()[mode];

      // Font family — Serif / Sans-serif, any imported custom (TTF) fonts, and
      // an "Import TTF…" action. Shown for ALL modes so fonts can be set per
      // mode (read included).
      block.appendChild(row(window.i18n.t('pj.font_family', 'Font family'), fontControl(mode, () => get().fontFamily)));

      block.appendChild(row(window.i18n.t('pj.font_size', 'Font size'), fontSizeRange(mode, () => get().fontSize)));

      // Display toggles.
      if (mode === 'card') {
        block.appendChild(row(window.i18n.t('pj.text_alignment', 'Text alignment'), (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['center', window.i18n.t('pj.align_center', 'Center')], ['left', window.i18n.t('pj.align_left', 'Left')]].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          sel.value = (get().align === 'left') ? 'left' : 'center';
          sel.addEventListener('change', () => apply('card', { align: sel.value }));
          return sel;
        })()));
        block.appendChild(row(window.i18n.t('pj.picture_position', 'Picture position'), (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['flex-start', window.i18n.t('pj.pos_top', 'Top')], ['center', window.i18n.t('pj.pos_centered', 'Centered')], ['flex-end', window.i18n.t('pj.pos_bottom', 'Bottom')]].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          const cur = get().imageAlign;
          sel.value = (cur === 'flex-start' || cur === 'flex-end') ? cur : 'center';
          sel.addEventListener('change', () => apply('card', { imageAlign: sel.value }));
          return sel;
        })()));
        block.appendChild(row(window.i18n.t('pj.show_bg_image', 'Show background image'), toggle(
          () => get().showBgImage !== false,
          (on) => apply('card', { showBgImage: on })
        )));
        block.appendChild(row(window.i18n.t('pj.show_waveform', 'Show waveform'), toggle(
          () => get().showWaveform !== false,
          (on) => apply('card', { showWaveform: on })
        )));
        block.appendChild(row(window.i18n.t('pj.show_upcoming_subtitle', 'Show upcoming subtitle'), toggle(
          () => get().showNextSub === true,
          (on) => apply('card', { showNextSub: on })
        )));
        // Movie-style subtitles: for subs2srs decks (frame + spoken line), put
        // the line ON the lower part of the frame in a translucent black box
        // instead of above it. Only affects deck cards that carry a picture —
        // SRT/transcription cards and text-only cards keep the stacked layout.
        block.appendChild(row(window.i18n.t('pj.movie_subs', 'Movie-style subtitles'), toggle(
          () => get().movieSubs === true,
          (on) => apply('card', { movieSubs: on })
        )));
        // Vision Pro only — nothing else can render a spatial scene, so the row
        // would just be a dead switch on iOS/Android/Mac.
        if (window.KADOKI_VISION_NATIVE) {
          block.appendChild(row(window.i18n.t('pj.spatial_pics', 'Spatial pictures (depth)'), toggle(
            () => get().spatialPics === true,
            (on) => { apply('card', { spatialPics: on }); try { window.kvSpatial?.refresh?.(); } catch (_) {} }
          )));
          // Subtitle mirrored in front of the spatial picture (video-player
          // subtitle architecture; only meaningful with spatial pictures on).
          block.appendChild(row(window.i18n.t('pj.subs_mirror', 'Subtitles in front (3D)'), toggle(
            () => get().subsMirror === true,
            (on) => { apply('card', { subsMirror: on }); try { window.kvSpatial?.refresh?.(); } catch (_) {} }
          )));
        }
      }
      if (mode === 'read') {
        // Invert LINE ART (ink drawings / scanned text pages) so it renders
        // white-on-black in the dark theme. The reader classifies each image
        // at load time — grayscale photos/shaded art and color artwork never
        // auto-invert (they'd look like film negatives); the image viewer's
        // ◑ Invert button covers those by hand.
        // Audio-follow indicator style (word-highlight.js reader overlays).
        block.appendChild(row(window.i18n.t('pj.karaoke_style', 'Audio-follow highlight'), (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['glow', window.i18n.t('pj.karaoke_style_glow', 'A · Glow + phrase pill')],
           ['underline', window.i18n.t('pj.karaoke_style_under', 'B · Progress underline')],
           ['dot', window.i18n.t('pj.karaoke_style_dot', 'C · Marker dot')],
           ['ruler', window.i18n.t('pj.karaoke_style_ruler', 'D · Line ruler')],
           ['comet', window.i18n.t('pj.karaoke_style_comet', 'E · Comet trail')],
           ['beam', window.i18n.t('pj.karaoke_style_beam', 'F · Margin beam')]].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          const cur = get().karaokeStyle;
          sel.value = ['glow', 'underline', 'dot', 'ruler', 'comet', 'beam'].includes(cur) ? cur : 'glow';
          sel.addEventListener('change', () => { apply('read', { karaokeStyle: sel.value }); try { window.wordHighlight?.restyle?.(); } catch (_) {} });
          return sel;
        })()));
        // Follow resolver engine — the revert switch for the sequential cursor.
        block.appendChild(row(window.i18n.t('pj.follow_engine', 'Follow engine'), (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:.85rem;';
          [['cursor', window.i18n.t('pj.follow_engine_cursor', 'Sequential (new)')],
           ['classic', window.i18n.t('pj.follow_engine_classic', 'Classic')]].forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
          });
          sel.value = (get().followEngine === 'classic') ? 'classic' : 'cursor';
          sel.addEventListener('change', () => { apply('read', { followEngine: sel.value }); try { window.__fcResetFollowCursor?.(); } catch (_) {} });
          return sel;
        })()));
        block.appendChild(row(window.i18n.t('pj.invert_line_art', 'Invert line art (dark mode)'), toggle(
          () => get().invertBwImages === true,
          (on) => apply('read', { invertBwImages: on })
        )));
      }
      if (mode === 'audio') {
        block.appendChild(row(window.i18n.t('pj.show_waveform', 'Show waveform'), toggle(
          () => get().showWaveform !== false,
          (on) => apply('audio', { showWaveform: on })
        )));
        block.appendChild(row(window.i18n.t('pj.show_upcoming_subtitle', 'Show upcoming subtitle'), toggle(
          () => get().showNextSub === true,
          (on) => apply('audio', { showNextSub: on })
        )));
        // Lock-screen subtitle artwork: when ON, every subtitle change
        // re-renders a 600px image and pushes it as the Now Playing cover
        // (~every few seconds for the whole listening session — a measurable
        // battery cost, especially on Android where the image crosses the JS
        // bridge as base64 and re-issues the media notification). OFF = the
        // title's cover art is pushed once and stays. Stored in the
        // localStorage key reading-mode.js already gates on.
        block.appendChild(row(window.i18n.t('pj.lockscreen_subtitle_art', 'Lock screen: subtitle as cover art'), toggle(
          () => { try { return localStorage.getItem('LOCKSCREEN_SUBTITLE_ART') !== '0'; } catch (_) { return true; } },
          (on) => {
            try { localStorage.setItem('LOCKSCREEN_SUBTITLE_ART', on ? '1' : '0'); } catch (_) {}
            try { window._refreshLockscreenArt?.(); } catch (_) {}
          }
        )));
        // Generated (on-device) subtitles: comma-grained phrases vs the native
        // sentence-grained cues. Read synchronously by auto-transcribe.js;
        // affects newly split cues, so a change fully applies on next title open.
        block.appendChild(row(window.i18n.t('pj.at_phrase', 'Generated subtitles: split at commas'), toggle(
          () => { try { return localStorage.getItem('KADOKI_AT_PHRASE') !== '0'; } catch (_) { return true; } },
          (on) => { try { localStorage.setItem('KADOKI_AT_PHRASE', on ? '1' : '0'); } catch (_) {} }
        )));
      }

      // Card-only extras (moved from the deleted Card mode prefs section).
      if (mode === 'card') {
        block.appendChild(row(window.i18n.t('pj.subtitle_vertical_offset', 'Subtitle vertical offset'), subtitleOffsetRow()));
        block.appendChild(row(window.i18n.t('pj.stopwatch_timeout', 'Stopwatch inactivity timeout (s)'), stopwatchTimeoutRow()));
        // "Combine short subtitles" (moved here from the removed Card-subtitles
        // section; same KADOKI_COMBINE_SUBS pref + async wiring).
        const combineCb = document.createElement('input');
        combineCb.type = 'checkbox';
        combineCb.id = 'combineSubsToggle';
        block.appendChild(row(window.i18n.t('pj.combine_subs', 'Combine short subtitles'), combineCb));
        setTimeout(() => { try { setupCombineSubsPref(); } catch (_) {} }, 0);
      }
      return block;
    };

    host.innerHTML = '';
    host.appendChild(modeBlock('card'));
    host.appendChild(modeBlock('read'));
    host.appendChild(modeBlock('audio'));

    // Dictionary popup font — a single global setting (not a reading "mode").
    // Offers System (default) / Serif / Sans-serif + any imported custom font,
    // applied to the popup's word / readings / definitions.
    (() => {
      const dblock = document.createElement('div');
      dblock.className = 'appearance-mode';
      const dlbl = document.createElement('div');
      dlbl.className = 'mode-label';
      dlbl.textContent = window.i18n.t('pj.dictionary_popup', 'Dictionary popup');
      dblock.appendChild(dlbl);
      const getDict = () => window.appearance?.get?.('dict') ||
        (window.appearance?.defaults?.() || {}).dict || { fontFamily: 'system' };
      dblock.appendChild(row(window.i18n.t('pj.font_family', 'Font family'), fontControl('dict', () => getDict().fontFamily,
        [[window.i18n.t('pj.font_system', 'System'), 'system'], [window.i18n.t('pj.font_serif', 'Serif'), 'serif'], [window.i18n.t('pj.font_sans', 'Sans-serif'), 'sans']])));
      host.appendChild(dblock);
    })();

    // Imported-fonts manager — list + delete (preview each name in its font).
    const imported = (window.fonts && window.fonts.list && window.fonts.list()) || [];
    if (imported.length) {
      const mgr = document.createElement('div');
      mgr.className = 'appearance-mode';
      const lbl = document.createElement('div');
      lbl.className = 'mode-label';
      lbl.textContent = window.i18n.t('pj.imported_fonts', 'Imported fonts');
      mgr.appendChild(lbl);
      imported.forEach(f => {
        const r = document.createElement('div');
        r.className = 'prefs-row';
        const nm = document.createElement('label');
        nm.textContent = f.name;
        nm.style.fontFamily = '"' + f.family + '", serif';
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = window.i18n.t('common.delete', 'Delete');
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
      ? window.i18n.t('pj.anki_empty_ios', '(tap "Fetch from Anki")')
      : window.i18n.t('pj.anki_empty_android', '(AnkiConnect unreachable)');
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
      opt.value = value; opt.textContent = window.i18n.fmt('pj.saved_suffix', { value });
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
      // Case-insensitive so heading relabels (e.g. "Swipe-Up and Scene Save") don't break detection.
      const txt = (s.textContent || '').toLowerCase();
      const isAnki = txt.includes('anki: swipe-up') ||
                     txt.includes('anki: dictionary add-word');
      if (!isAnki || s.querySelector('[data-role="anki-fetch"]')) return; // dedupe
      const row = document.createElement('div');
      row.style.cssText = 'margin:10px 0;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.role = 'anki-fetch';
      btn.textContent = window.i18n.t('pj.anki_fetch_btn', '⤓ Fetch decks, note types & fields from Anki');
      btn.style.cssText = 'background:#1a1a1a;color:var(--text,#e8e8e8);border:1px solid #333;' +
        'border-radius:8px;padding:8px 14px;font-size:.85rem;cursor:pointer;-webkit-tap-highlight-color:transparent;';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:.72rem;color:#888;margin-top:4px;';
      note.textContent = window.i18n.t('pj.anki_fetch_note', 'Opens AnkiMobile and returns here. Run once — and again after you add decks/note types in Anki.');
      btn.addEventListener('click', async () => {
        if (typeof window.fetchAnkiInfoIOS !== 'function') { alert(window.i18n.t('pj.anki_bridge_unavailable', 'AnkiMobile bridge unavailable.')); return; }
        const label = btn.textContent; btn.disabled = true; btn.textContent = window.i18n.t('pj.opening_ankimobile', 'Opening AnkiMobile…');
        try {
          const info = await window.fetchAnkiInfoIOS();
          if (typeof wireAnkiSection === 'function') await wireAnkiSection(); // repopulate all dropdowns from the cache
          const nd = (info.decks || []).length, nt = (info.notetypes || []).length;
          btn.textContent = '✓ ' + window.i18n.fmt('pj.anki_fetch_result', { nd, nt });
          setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
        } catch (e) {
          alert(window.i18n.fmt('pj.anki_fetch_failed', { err: ((e && e.message) || e) }));
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
      if ((s.textContent || '').toLowerCase().includes('anki: dictionary add-word')) target = s;
    });
    if (!target) return;
    if (target.querySelector('[data-role="anki-media-link"]')) return; // dedupe

    const row = document.createElement('div');
    row.className = 'prefs-row';
    row.setAttribute('data-role', 'anki-media-link');
    row.style.alignItems = 'flex-start';
    row.innerHTML = `
      <label style="flex:0 0 45%;line-height:1.35;">${window.i18n.t('pj.media_folder', 'Media folder')}
        <span style="display:block;font-size:.7em;color:var(--text-muted,#888);margin-top:2px;">
          ${window.i18n.t('pj.media_folder_help', 'Optional fallback. Primary delivery uses the in-app HTTP server — no linking required.')}
        </span>
      </label>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;">
        <div data-role="status" style="font-size:.78rem;color:var(--text-muted,#888);">${window.i18n.t('pj.checking', 'Checking…')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button data-role="link" class="btn" style="flex:1;background:transparent;color:var(--accent-cyan,#00ffcc);border:1px solid var(--accent-cyan,#00ffcc);padding:6px 10px;border-radius:6px;font-size:.78rem;">${window.i18n.t('pj.link_folder', 'Link folder')}</button>
          <button data-role="unlink" class="btn" style="background:transparent;color:var(--text-muted,#888);border:1px solid var(--border,#2a2a2a);padding:6px 10px;border-radius:6px;font-size:.78rem;display:none;">${window.i18n.t('pj.unlink', 'Unlink')}</button>
          <button data-role="test-anki" class="btn" style="flex:1;background:transparent;color:var(--accent-warn,#ffd54a);border:1px solid var(--accent-warn,#ffd54a);padding:6px 10px;border-radius:6px;font-size:.78rem;">${window.i18n.t('pj.send_test_card', 'Send test card')}</button>
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
          status.textContent = '✓ ' + window.i18n.fmt('pj.media_linked', { name: (r.name || 'collection.media') });
          status.style.color = 'var(--accent-read,#4caf50)';
          linkBtn.textContent = window.i18n.t('pj.relink', 'Re-link');
          unlinkBtn.style.display = 'inline-block';
        } else {
          status.textContent = window.i18n.t('pj.not_linked', 'Not linked (fallback only — not required)');
          status.style.color = 'var(--text-muted,#888)';
          linkBtn.textContent = window.i18n.t('pj.link_folder', 'Link folder');
          unlinkBtn.style.display = 'none';
        }
      } catch (e) {
        status.textContent = window.i18n.t('pj.status_check_failed', 'Status check failed');
      }
    }
    refresh();

    linkBtn.addEventListener('click', async () => {
      try {
        await ab.linkMediaFolder();
      } catch (e) {
        alert(window.i18n.fmt('pj.link_folder_failed', { err: (e?.message || e) }));
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
        if (!cfg) { alert(window.i18n.t('pj.anki_settings_unavailable', 'Anki settings unavailable')); return; }
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
          ? window.i18n.t('pj.test_ok', '✓ TEST OK — model/deck names work. If real sends fail, the issue is media-related.')
          : (cbResult === 'error')
          ? window.i18n.fmt('pj.test_rejected', { model: cfg.model })
          : window.i18n.fmt('pj.test_no_reply', { model: cfg.model, deck: cfg.deck, url: (window._lastAnkiCallbackUrl || window.i18n.t('pj.none', '(none)')) });
        const confirmed = window.confirm(verdict + '\n\n' + window.i18n.t('pj.url_header', '— URL —') + '\n' + constructedUrl);
        if (confirmed && constructedUrl !== '(unknown)') {
          try {
            await navigator.clipboard.writeText(constructedUrl);
            if (typeof window.showToast === 'function') {
              window.showToast(window.i18n.t('pj.url_copied', 'URL copied. Paste in Safari to test AnkiMobile directly.'), 5000);
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
              window.showToast(window.i18n.t('pj.url_copied_fallback', 'URL copied (fallback). Paste in Safari to test.'), 5000);
            }
          }
        }
      } catch (e) {
        console.error('[anki-test] failed:', e);
        if (typeof window.showToast === 'function') {
          window.showToast('✗ ' + window.i18n.fmt('pj.test_failed', { err: (e?.message || e) }), 5000);
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


  // "Keep screen awake (minutes)". Stored as KEEP_AWAKE_MIN ('0' = off). Persists
  // on change (dual-write localStorage + Capacitor Preferences); keep-awake.js
  // reads localStorage. Template: setupReverseHSwipePref.
  async function setupKeepAwakePref() {
    const sel = document.getElementById('keepAwakeMinSelect');
    if (!sel) return;
    try { sel.value = String(parseInt(localStorage.getItem('KEEP_AWAKE_MIN'), 10) || 0); }
    catch (_) { sel.value = '0'; }
    if (!Array.from(sel.options).some((o) => o.value === sel.value)) sel.value = '0';
    if (!sel.dataset.wired) {
      sel.dataset.wired = '1';
      sel.addEventListener('change', () => {
        const v = sel.value;
        try { localStorage.setItem('KEEP_AWAKE_MIN', v); } catch (_) {}
        try { window.Capacitor?.Plugins?.Preferences?.set({ key: 'KEEP_AWAKE_MIN', value: v }); } catch (_) {}
        try { window.keepAwake?.refresh(); } catch (_) {}
      });
    }
  }

  // AI assistant (BYOK). Key + enable toggle persist on change (not on Save)
  // so closing the modal without "Save" never silently drops a pasted key.
  async function setupAiPrefs() {
    const cb = document.getElementById('aiEnabledToggle');
    const keyInput = document.getElementById('aiApiKeyInput');
    const usage = document.getElementById('aiUsageLine');
    if (!cb || !keyInput || !window.ai) return;
    try { await window.ai.ready; } catch (_) {}
    cb.checked = window.ai.enabledFlag();
    keyInput.value = window.ai.getKey() || '';
    const quality = document.getElementById('aiQualitySelect');
    if (quality) {
      try { quality.value = window.ai.getQuality ? window.ai.getQuality() : 'balanced'; } catch (_) {}
      if (!quality.dataset.wired) {
        quality.dataset.wired = '1';
        quality.addEventListener('change', () => {
          try { window.ai.setQuality?.(quality.value); } catch (_) {}
        });
      }
    }
    const auto = document.getElementById('aiAutoProcessToggle');
    if (auto) {
      const av = localStorage.getItem('AI_AUTO_PROCESS');
      auto.checked = (av === null || av === '1');
      if (!auto.dataset.wired) {
        auto.dataset.wired = '1';
        auto.addEventListener('change', () => {
          const v = auto.checked ? '1' : '0';
          try { localStorage.setItem('AI_AUTO_PROCESS', v); } catch (_) {}
          // Dual-write: localStorage can be wiped while Capacitor Preferences
          // survives; ai.js mirrors this back into localStorage at boot.
          try {
            window.Capacitor?.Plugins?.Preferences?.set({ key: 'AI_AUTO_PROCESS', value: v });
          } catch (_) {}
        });
      }
    }
    // Chapter split threshold (×1000 chars; 0 = off). ai-chunks.js reads AICHUNK_SPLIT_K.
    const split = document.getElementById('aiSplitTargetInput');
    if (split) {
      try { const v = localStorage.getItem('AICHUNK_SPLIT_K'); split.value = (v === null || v === '') ? '22' : String(parseInt(v, 10) || 0); } catch (_) { split.value = '22'; }
      if (!split.dataset.wired) {
        split.dataset.wired = '1';
        split.addEventListener('change', () => {
          let n = parseInt(split.value, 10);
          if (!Number.isFinite(n) || n < 0) n = 22;
          if (n > 0 && n < 8) n = 8;      // floor so it can't over-split absurdly (0 stays = off)
          if (n > 80) n = 80;
          split.value = String(n);
          try { localStorage.setItem('AICHUNK_SPLIT_K', String(n)); } catch (_) {}
          try { window.Capacitor?.Plugins?.Preferences?.set({ key: 'AICHUNK_SPLIT_K', value: String(n) }); } catch (_) {}
        });
      }
    }
    // Auto-generate scene pictures when scene ideas are created (ai-processor.js reads AISCENE_AUTO_IMG; default off — it costs).
    const sceneImg = document.getElementById('aiSceneAutoImgToggle');
    if (sceneImg) {
      try { sceneImg.checked = (localStorage.getItem('AISCENE_AUTO_IMG') === '1'); } catch (_) { sceneImg.checked = false; }
      if (!sceneImg.dataset.wired) {
        sceneImg.dataset.wired = '1';
        sceneImg.addEventListener('change', () => {
          const v = sceneImg.checked ? '1' : '0';
          try { localStorage.setItem('AISCENE_AUTO_IMG', v); } catch (_) {}
          try { window.Capacitor?.Plugins?.Preferences?.set({ key: 'AISCENE_AUTO_IMG', value: v }); } catch (_) {}
        });
      }
    }
    if (!cb.dataset.wired) {
      cb.dataset.wired = '1';
      cb.addEventListener('change', () => { window.ai.setEnabled(cb.checked); });
      keyInput.addEventListener('change', () => { window.ai.setKey(keyInput.value); });
    }
    if (usage) {
      usage.textContent = '';
      try {
        const c = await window.ai.monthSpendUsd();
        usage.textContent = window.i18n.fmt('pj.api_usage_month', { usd: c.toFixed(2) });
      } catch (_) {}
    }
    await renderAiCostList();
  }

  // ---- OpenRouter text-AI backend (BYOK + live searchable model picker) ----
  // ai.js owns the prefs (AI_BACKEND / AI_OPENROUTER_KEY / AI_OPENROUTER_MODEL) and
  // the public-models fetch; this just drives the Preferences UI. Everything is
  // guarded — window.ai may be absent (older boot / partial load).

  // Pretty USD per-1M price. Returns null for free/zero so the caller can show "free".
  function orFmtPrice(v) {
    v = Number(v);
    if (!Number.isFinite(v) || v <= 0) return null;
    let s;
    if (v < 0.1) s = v.toFixed(3);
    else if (v < 1) s = v.toFixed(2);
    else if (v < 100) s = (Math.round(v * 100) / 100).toString();
    else s = String(Math.round(v));
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return '$' + s;
  }
  function orT(k, f) { try { return window.i18n ? window.i18n.t(k, f) : f; } catch (_) { return f; } }
  function orFmt(k, vars, f) { try { return window.i18n ? window.i18n.fmt(k, vars, f) : f; } catch (_) { return f; } }
  // "in $5/M · out $30/M" (or localized) — "free" when both prices are zero.
  function orCostStr(inUsd, outUsd, kind) {
    const i = orFmtPrice(inUsd), o = orFmtPrice(outUsd);
    // Image models (FLUX etc.) report $0 token pricing because they bill per image,
    // not per token — don't mislabel them "free".
    if (i === null && o === null) return (kind === 'image') ? orT('or.per_image', 'per-image pricing') : orT('or.free', 'free');
    return orFmt('or.cost_inout', { in: (i || '$0'), out: (o || '$0') }, 'in ' + (i || '$0') + '/M · out ' + (o || '$0') + '/M');
  }
  function orCtxStr(ctx) {
    ctx = Number(ctx);
    if (!Number.isFinite(ctx) || ctx <= 0) return '';
    return orFmt('or.ctx', { n: Math.round(ctx / 1000) }, Math.round(ctx / 1000) + 'K ctx');
  }
  // The selected-model summary line, e.g. 'GPT-5.5 — $5 / $30 per 1M'.
  function orModelLabel(meta, kind) {
    if (!meta || !meta.id) return orT('or.no_model', 'No model selected — tap "Choose model…"');
    const nm = meta.name || meta.id;
    const i = orFmtPrice(meta.inUsd), o = orFmtPrice(meta.outUsd);
    if (i === null && o === null) return (kind === 'image')
      ? orFmt('or.model_per_image', { name: nm }, nm + ' — per-image pricing')
      : orFmt('or.model_free', { name: nm }, nm + ' — free');
    return orFmt('or.model_cost', { name: nm, in: (i || '$0'), out: (o || '$0') }, nm + ' — ' + (i || '$0') + ' / ' + (o || '$0') + ' per 1M');
  }

  // The model picker overlay: search + Refresh + a scrollable list. Self-contained
  // .kai-modal (gesture-shielded, dismissible by ✕ / outside-tap). Generalized over a
  // backend: fetchFn(opts)->[{id,name,inUsd,outUsd,ctx}], currentMetaFn()->selected meta
  // (used only to highlight the active row), setFn(meta)->persist the pick. onPicked() is
  // called after a successful selection so the caller can refresh its label. Used by BOTH
  // the text-AI backend (window.ai.*) and the image backend (window.aiImages.*).
  function openOpenRouterModelPicker(fetchFn, currentMetaFn, setFn, onPicked, opts) {
    if (typeof fetchFn !== 'function') return;
    const kind = (opts && opts.kind) || '';   // 'image' → per-image price labels, not "free"
    let curId = '';
    try { const cm = (typeof currentMetaFn === 'function') ? currentMetaFn() : null; curId = (cm && cm.id) ? cm.id : ''; } catch (_) {}

    const overlay = document.createElement('div');
    overlay.id = 'orModelPicker';
    overlay.className = 'kai-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100002;display:flex;align-items:center;justify-content:center;touch-action:none;';
    const close = () => { try { overlay.remove(); } catch (_) {} };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#161616;border:1px solid #2a2a2a;border-radius:12px;width:min(94vw,520px);max-height:82vh;display:flex;flex-direction:column;overflow:hidden;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px 14px 8px;border-bottom:1px solid #242424;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:1rem;color:#eee;flex:1;min-width:0;';
    title.textContent = orT('or.picker_title', 'Choose an OpenRouter model');
    const xBtn = document.createElement('button');
    xBtn.type = 'button';
    xBtn.textContent = '✕';
    xBtn.setAttribute('aria-label', orT('or.close', 'Close'));
    xBtn.style.cssText = 'flex:none;background:transparent;border:none;color:#aaa;font-size:1.2rem;line-height:1;cursor:pointer;padding:2px 8px;';
    xBtn.addEventListener('click', close);
    head.appendChild(title); head.appendChild(xBtn);

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid #242424;';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = orT('or.search_ph', 'Search models…');
    search.autocomplete = 'off'; search.autocapitalize = 'off'; search.spellcheck = false;
    search.style.cssText = 'flex:1;min-width:0;background:#1c1c1c;border:1px solid #333;border-radius:8px;color:#ddd;padding:8px 10px;font-size:.85rem;';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = orT('or.refresh', 'Refresh');
    refreshBtn.style.cssText = 'flex:none;background:transparent;border:1px solid #3a3450;border-radius:8px;color:#b9a9e0;font-size:.78rem;padding:6px 12px;cursor:pointer;';
    toolbar.appendChild(search); toolbar.appendChild(refreshBtn);

    const list = document.createElement('div');
    list.style.cssText = 'overflow:auto;padding:8px 10px 12px;flex:1;-webkit-overflow-scrolling:touch;';

    card.appendChild(head); card.appendChild(toolbar); card.appendChild(list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    try { window.aiImages?.shieldOverlay?.(overlay); } catch (_) {}

    let allModels = [];

    function setStatus(msg) {
      list.innerHTML = '';
      const d = document.createElement('div');
      d.style.cssText = 'color:#888;font-size:.85rem;text-align:center;padding:26px 12px;line-height:1.5;';
      d.textContent = msg;
      list.appendChild(d);
    }

    function buildRow(m) {
      const row = document.createElement('button');
      row.type = 'button';
      const isCur = !!(curId && m.id === curId);
      row.style.cssText = 'display:block;width:100%;text-align:left;background:#1d1d1d;border:1px solid ' + (isCur ? '#5a4f8a' : '#2a2a2a') + ';border-radius:8px;padding:9px 11px;margin-bottom:7px;cursor:pointer;';
      const name = document.createElement('div');
      name.style.cssText = 'font-size:.9rem;color:#eee;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      name.textContent = m.name || m.id || '';
      const idEl = document.createElement('div');
      idEl.style.cssText = 'font-size:.68rem;color:#777;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      idEl.textContent = m.id || '';
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:.72rem;color:#9a93b8;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;';
      const costSpan = document.createElement('span');
      costSpan.textContent = orCostStr(m.inUsd, m.outUsd, kind);
      meta.appendChild(costSpan);
      const cs = orCtxStr(m.ctx);
      if (cs) { const c = document.createElement('span'); c.textContent = cs; meta.appendChild(c); }
      row.appendChild(name); row.appendChild(idEl); row.appendChild(meta);
      row.addEventListener('click', async () => {
        try {
          if (typeof setFn === 'function') {
            await setFn({ id: m.id, name: m.name || m.id, inUsd: m.inUsd, outUsd: m.outUsd, ctx: m.ctx, outMods: m.outMods });
          }
        } catch (_) {}
        try { onPicked && onPicked(); } catch (_) {}
        close();
      });
      return row;
    }

    function renderList() {
      const q = (search.value || '').trim().toLowerCase();
      const items = q
        ? allModels.filter(m => (((m.id || '') + ' ' + (m.name || '')).toLowerCase().indexOf(q) >= 0))
        : allModels;
      list.innerHTML = '';
      if (!items.length) { setStatus(orT('or.no_results', 'No models match your search.')); return; }
      const frag = document.createDocumentFragment();
      items.forEach(m => frag.appendChild(buildRow(m)));
      list.appendChild(frag);
    }

    async function load(force) {
      setStatus(orT('or.loading', 'Loading models…'));
      try {
        const res = await fetchFn(force ? { force: true } : {});
        allModels = Array.isArray(res) ? res : [];
        renderList();
      } catch (_) {
        setStatus(orT('or.error', "Couldn't load models. Check your connection and tap Refresh."));
      }
    }

    search.addEventListener('input', renderList);
    refreshBtn.addEventListener('click', () => load(true));
    load(false);
  }

  // Backend selector + OpenRouter key/model rows. Reflects the saved backend on open
  // and persists every change immediately (like the Anthropic key — never on Save).
  async function setupOpenRouterPrefs() {
    if (!window.ai) return;
    try { await window.ai.ready; } catch (_) {}
    const sel = document.getElementById('aiBackendSelect');
    const orFields = document.getElementById('aiOpenrouterFields');
    const keyInput = document.getElementById('aiOpenrouterKeyInput');
    const chooseBtn = document.getElementById('aiOpenrouterChooseBtn');
    const modelLine = document.getElementById('aiOpenrouterModelLine');

    function applyBackend(b) {
      const isOr = (b === 'openrouter');
      try { document.querySelectorAll('.ai-anthropic-only').forEach(el => { el.style.display = isOr ? 'none' : ''; }); } catch (_) {}
      if (orFields) orFields.style.display = isOr ? '' : 'none';
    }
    function refreshModelLine() {
      if (!modelLine) return;
      let meta = null;
      try { meta = window.ai.openrouterModel ? window.ai.openrouterModel() : null; } catch (_) {}
      modelLine.textContent = orModelLabel(meta);
    }

    // Reflect current state.
    let cur = 'anthropic';
    try { cur = (window.ai.backend ? window.ai.backend() : 'anthropic') || 'anthropic'; } catch (_) {}
    if (sel) sel.value = cur;
    applyBackend(cur);
    if (keyInput) {
      try { keyInput.value = window.ai.openrouterKey ? (window.ai.openrouterKey() || '') : ''; } catch (_) { keyInput.value = ''; }
    }
    refreshModelLine();

    if (sel && !sel.dataset.wired) {
      sel.dataset.wired = '1';
      sel.addEventListener('change', async () => {
        const v = sel.value;
        try { if (window.ai.setBackend) await window.ai.setBackend(v); } catch (_) {}
        applyBackend(v);
        // Newly-revealed rows may carry data-i18n that hasn't been applied yet.
        try { window.i18n && window.i18n.applyStatic(document.getElementById('preferencesModal')); } catch (_) {}
        if (v === 'openrouter') refreshModelLine();
      });
    }
    if (keyInput && !keyInput.dataset.wired) {
      keyInput.dataset.wired = '1';
      keyInput.addEventListener('change', async () => {
        try { if (window.ai.setOpenrouterKey) await window.ai.setOpenrouterKey(keyInput.value); } catch (_) {}
      });
    }
    if (chooseBtn && !chooseBtn.dataset.wired) {
      chooseBtn.dataset.wired = '1';
      chooseBtn.addEventListener('click', () => {
        if (!window.ai || typeof window.ai.fetchOpenRouterModels !== 'function') return;
        openOpenRouterModelPicker(
          (opts) => window.ai.fetchOpenRouterModels(opts),
          () => { try { return window.ai.openrouterModel ? window.ai.openrouterModel() : null; } catch (_) { return null; } },
          (meta) => { try { return window.ai.setOpenrouterModel ? window.ai.setOpenrouterModel(meta) : null; } catch (_) {} },
          refreshModelLine
        );
      });
    }
  }

  // Image-generation backend selector (fal.ai / OpenRouter). Mirrors the Text-AI backend
  // row: reflects window.aiImages.imageBackend() on open and persists every change via the
  // contract setImageBackend() (dual-write). The OpenRouter image MODEL uses the same live
  // searchable picker as text (generalized openOpenRouterModelPicker) and reuses the
  // OpenRouter key from the Text-AI section (window.ai.openrouterKey). All aiImages calls
  // are guarded. NOTE: a distinct dataset marker (imgBkWired) is used so this handler is
  // attached even though aiImages.wireSettings() also touches #aiImgBackend (dataset.wired).
  async function setupImageBackendPrefs() {
    const sel = document.getElementById('aiImgBackend');
    if (!sel) return;
    const falFields = document.getElementById('aiImgFalFields');
    const orFields = document.getElementById('aiImgOrFields');
    const chooseBtn = document.getElementById('aiImgOrChooseBtn');
    const modelLine = document.getElementById('aiImgOrModelLine');

    function applyImgBackend(b) {
      const isOr = (b === 'openrouter');
      if (falFields) falFields.style.display = isOr ? 'none' : '';
      if (orFields) orFields.style.display = isOr ? '' : 'none';
    }
    function refreshImgModelLine() {
      if (!modelLine) return;
      let meta = null;
      try { meta = (window.aiImages && window.aiImages.openrouterImageModel) ? window.aiImages.openrouterImageModel() : null; } catch (_) {}
      modelLine.textContent = orModelLabel(meta, 'image');
    }

    // Reflect current state (default 'fal'; ignore a stored value the <select> can't show).
    let cur = 'fal';
    try { cur = (window.aiImages && window.aiImages.imageBackend) ? (window.aiImages.imageBackend() || 'fal') : 'fal'; } catch (_) {}
    if (!Array.prototype.some.call(sel.options, (o) => o.value === cur)) cur = 'fal';
    sel.value = cur;
    applyImgBackend(cur);
    refreshImgModelLine();

    if (!sel.dataset.imgBkWired) {
      sel.dataset.imgBkWired = '1';
      sel.addEventListener('change', async () => {
        const v = sel.value;
        try { if (window.aiImages && window.aiImages.setImageBackend) await window.aiImages.setImageBackend(v); } catch (_) {}
        applyImgBackend(v);
        // Newly-revealed rows may carry data-i18n that hasn't been applied yet.
        try { window.i18n && window.i18n.applyStatic(document.getElementById('preferencesModal')); } catch (_) {}
        if (v === 'openrouter') refreshImgModelLine();
      });
    }
    if (chooseBtn && !chooseBtn.dataset.wired) {
      chooseBtn.dataset.wired = '1';
      chooseBtn.addEventListener('click', () => {
        if (!window.aiImages || typeof window.aiImages.fetchOpenRouterImageModels !== 'function') return;
        openOpenRouterModelPicker(
          (opts) => window.aiImages.fetchOpenRouterImageModels(opts),
          () => { try { return window.aiImages.openrouterImageModel ? window.aiImages.openrouterImageModel() : null; } catch (_) { return null; } },
          (meta) => { try { return window.aiImages.setOpenrouterImageModel ? window.aiImages.setOpenrouterImageModel(meta) : null; } catch (_) {} },
          refreshImgModelLine,
          { kind: 'image' }
        );
      });
    }
  }

  // OpenAI (ChatGPT) image backend: BYOK key + a "spend this month" line. The
  // model/quality/size/budget selects are wired by aiImages.wireSettings(); only
  // the key (persist on change, mirroring the Anthropic key) + usage live here.
  async function setupOpenAiPrefs() {
    if (!window.aiOpenai) return;
    try { await window.aiOpenai.ready; } catch (_) {}
    const keyInput = document.getElementById('aiOpenAiKeyInput');
    if (keyInput) {
      keyInput.value = window.aiOpenai.getKey() || '';
      if (!keyInput.dataset.wired) {
        keyInput.dataset.wired = '1';
        keyInput.addEventListener('change', () => { try { window.aiOpenai.setKey(keyInput.value); } catch (_) {} });
      }
    }
    const usage = document.getElementById('aiImgUsageLine');
    if (usage) {
      usage.textContent = '';
      try {
        let parts = [];
        // ChatGPT/OpenAI removed from the product — show fal.ai usage only.
        if (window.aiFal) { const f = await window.aiFal.monthSpendUsd(); if (f > 0) parts.push('fal.ai ~$' + f.toFixed(2)); }
        if (parts.length) usage.textContent = window.i18n.t('pj.cloud_img_usage_month', 'Cloud image usage this month: ') + parts.join(' · ');
      } catch (_) {}
    }
  }

  // fal.ai image backend: BYOK key (no identity verification). The model/fallback
  // selects are wired by aiImages.wireSettings(); only the key (persist on change)
  // lives here, mirroring the Anthropic/OpenAI key rows.
  async function setupFalPrefs() {
    if (!window.aiFal) return;
    try { await window.aiFal.ready; } catch (_) {}
    const keyInput = document.getElementById('aiFalKeyInput');
    if (keyInput) {
      keyInput.value = window.aiFal.getKey() || '';
      if (!keyInput.dataset.wired) {
        keyInput.dataset.wired = '1';
        keyInput.addEventListener('change', () => { try { window.aiFal.setKey(keyInput.value); } catch (_) {} });
      }
    }
  }

  // Per-title cumulative AI cost + running total (AICOST_V1 via ai.costByTitle).
  async function renderAiCostList() {
    const host = document.getElementById('aiCostList');
    if (!host) return;
    host.innerHTML = '';
    try {
      if (!window.ai || typeof window.ai.costByTitle !== 'function') return;
      const data = window.ai.costByTitle();
      if (!data || !data.titles || (!data.titles.length && !data.total)) return;
      // resolve title names (best-effort)
      let nameById = {};
      try {
        if (window.titleStore && window.titleStore.list) {
          const ts = await window.titleStore.list();
          (ts || []).forEach(t => { if (t && t.id) nameById[t.id] = t.name || t.title || t.id; });
        }
      } catch (_) {}
      const active = window._activeTitleId || null;
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const head = document.createElement('div');
      head.style.cssText = 'font-size:.72rem;color:#888;font-weight:700;margin:2px 0 4px;letter-spacing:.04em;';
      head.textContent = window.i18n.t('pj.ai_cost_by_book', 'AI cost by book (cumulative)');
      host.appendChild(head);
      const row = (label, usd, hot) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-size:.74rem;' +
          'padding:2px 0;color:' + (hot ? '#cbbfee' : '#aaa') + (hot ? ';font-weight:700;' : ';');
        const l = document.createElement('span');
        l.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        l.innerHTML = (hot ? '▸ ' : '') + esc(label);
        const v = document.createElement('span');
        v.style.cssText = 'flex:none;color:' + (hot ? '#cbbfee' : '#bbb') + ';';
        v.textContent = '~$' + (usd || 0).toFixed(2);
        r.appendChild(l); r.appendChild(v);
        return r;
      };
      for (const t of data.titles.slice(0, 12)) {
        host.appendChild(row(nameById[t.titleId] || t.titleId, t.usd, t.titleId === active));
      }
      // active title with zero recorded cost still gets a line so the user sees it
      if (active && !data.titles.some(t => t.titleId === active)) {
        host.appendChild(row(nameById[active] || active, 0, true));
      }
      const total = document.createElement('div');
      total.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-size:.78rem;' +
        'font-weight:700;color:#ddd;border-top:1px solid #2a2a2a;margin-top:5px;padding-top:5px;';
      const tl = document.createElement('span'); tl.textContent = window.i18n.t('pj.total', 'Total');
      const tv = document.createElement('span'); tv.textContent = '~$' + (data.total || 0).toFixed(2);
      total.appendChild(tl); total.appendChild(tv);
      host.appendChild(total);
    } catch (_) {}
  }

  // UI language selector (English / 日本語). Applies LIVE on change (persists + re-renders
  // immediately via i18n.set) — independent of the Save/Cancel buttons, like a system setting.
  async function setupLangPref() {
    const sel = document.getElementById('uiLangSelect');
    if (!sel || !window.i18n) return;
    sel.value = window.i18n.get();
    if (!sel.dataset.wired) {
      sel.dataset.wired = '1';
      sel.addEventListener('change', async () => { try { await window.i18n.set(sel.value); } catch (_) {} });
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
    try { window.i18n && window.i18n.applyStatic(modal); } catch (_) {}   // reflect current language in the static labels
    // Every step below self-guards: these run top-to-bottom with no barrier
    // between them, and an uncaught throw partway through used to silently
    // abort every section after it (e.g. a fetchDeckNames() failure in
    // wireAnkiSection could take out Playback/color pickers too, or an
    // earlier throw could skip Anki/OpenRouter wiring entirely) — each
    // section should degrade on its own, not take its siblings down with it.
    try { await setupLangPref(); } catch (e) { console.warn('[prefs] setupLangPref failed', e); }

    try { buildAppearanceSection(); } catch (e) { console.warn('[prefs] buildAppearanceSection failed', e); }
    try { buildDictionarySection(); } catch (e) { console.warn('[prefs] buildDictionarySection failed', e); }
    try { await setupCombineSubsPref(); } catch (e) { console.warn('[prefs] setupCombineSubsPref failed', e); }
    try { await setupKeepAwakePref(); } catch (e) { console.warn('[prefs] setupKeepAwakePref failed', e); }
    try { await setupAiPrefs(); } catch (e) { console.warn('[prefs] setupAiPrefs failed', e); }
    try { await setupOpenRouterPrefs(); } catch (e) { console.warn('[prefs] setupOpenRouterPrefs failed', e); }   // text-AI backend selector + OpenRouter key/model picker
    // Image-backend config is independent of the text-AI (Anthropic) module and its
    // DOM — wire it unconditionally so OpenAI/local image prefs still work even if the
    // text-AI section is absent or its element ids change. Both self-guard internally.
    try { window.aiImages?.wireSettings?.(); } catch (e) { console.warn('[prefs] aiImages.wireSettings failed', e); }   // image backend selects (local + OpenAI + fal)
    try { await setupOpenAiPrefs(); } catch (e) { console.warn('[prefs] setupOpenAiPrefs failed', e); }            // OpenAI key (persist on change) + image usage line
    try { await setupFalPrefs(); } catch (e) { console.warn('[prefs] setupFalPrefs failed', e); }               // fal.ai key (persist on change)
    try { await setupImageBackendPrefs(); } catch (e) { console.warn('[prefs] setupImageBackendPrefs failed', e); }      // image backend selector (fal/OpenRouter) + OpenRouter image-model picker
    try { await setupAnkiConnectPref(); } catch (e) { console.warn('[prefs] setupAnkiConnectPref failed', e); }
    try { await wireAnkiSection(); } catch (e) { console.warn('[prefs] wireAnkiSection failed', e); }
    try { setupIOSAnkiPickers(); } catch (e) { console.warn('[prefs] setupIOSAnkiPickers failed', e); }

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

  // When the UI language changes WHILE Preferences is open, re-render the dynamically-
  // built sections. applyStatic() only re-translates static [data-i18n] markup;
  // buildAppearanceSection is build-once (dataset.built guard) and the cost list is
  // generated, so without this they'd stay in the previously-active language.
  window.addEventListener('kai:lang', async () => {
    try {
      const modal = document.getElementById('preferencesModal');
      if (!modal || modal.style.display === 'none') return;
      const ap = document.getElementById('prefsAppearance');
      if (ap) { ap.dataset.built = ''; ap.innerHTML = ''; buildAppearanceSection(); }   // rebuild per-mode appearance controls in the new language
      try { await buildDictionarySection(); } catch (_) {}                               // idempotent (sets innerHTML)
      try { await renderAiCostList(); } catch (_) {}                                      // clears its host, rebuilds labels
      try { await setupOpenAiPrefs(); } catch (_) {}                                      // image usage line
      try { window.i18n && window.i18n.applyStatic(modal); } catch (_) {}                 // re-translate all static labels/help
      try { if (typeof window.syncModeColorPickers === 'function') window.syncModeColorPickers(); } catch (_) {}
    } catch (_) {}
  });

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
    if (typeof showToast === 'function') showToast(window.i18n.t('pj.preferences_saved', 'Preferences saved'), 2000);
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
        <button id="dictImportBtn" class="btn" style="font-size:.78rem;">${window.i18n.t('pj.import_yomitan_zip', '＋ Import Yomitan zip…')}</button>
        <span id="dictImportStatus" style="font-size:.75rem;color:#888;align-self:center;"></span>
      </div>
      <div id="dictImportBarWrap" style="display:none;height:6px;background:#222;border-radius:3px;overflow:hidden;margin:0 0 10px;">
        <div id="dictImportBar" style="width:0%;height:100%;background:#4caf50;transition:width .2s ease;"></div>
      </div>
    `;
    if (!ordered.length) {
      html += '<div style="color:#666;font-size:.8rem;padding:8px 0;">' + window.i18n.t('pj.no_dicts_loaded', 'No dictionaries loaded yet. Open Preferences again once startup loading completes.') + '</div>';
    } else {
      html += ordered.map(name => {
        const cnt = countByName.get(name);
        const isOrphan = !storeNameSet.has(name) && entryNameSet.has(name);
        const tag = isOrphan
          ? ' <span style="color:#f80;font-size:.7rem;">' + window.i18n.t('pj.orphaned_relic', '(orphaned relic)') + '</span>'
          : importedSet.has(name) ? ' <span style="color:#888;font-size:.7rem;">' + window.i18n.t('pj.imported_tag', '(imported)') + '</span>' : '';
        const cntTxt = (typeof cnt === 'number')
          ? ` <span style="color:#666;font-size:.7rem;">· ${cnt.toLocaleString()} ${window.i18n.t('pj.entries', 'entries')}</span>` : '';
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
          ${removable ? '<button data-role="remove" class="btn" style="padding:4px 8px;font-size:.85rem;color:#f44;" title="' + window.i18n.t('pj.remove_dictionary', 'Remove dictionary') + '">✕</button>' : ''}
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
        if (!confirm(window.i18n.fmt('pj.remove_dict_confirm', { name }))) return;
        // Re-query each tick so the bar/text survive any re-render during the
        // (potentially many-second) batched delete of a large dictionary.
        const setStatus = (m) => { const s = document.getElementById('dictImportStatus'); if (s) s.textContent = m; };
        const setBar = (pct) => {
          const w = document.getElementById('dictImportBarWrap');
          const b = document.getElementById('dictImportBar');
          if (w) w.style.display = 'block';
          if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
        };
        setStatus(window.i18n.fmt('pj.removing_dict', { name }));
        setBar(3);
        if (typeof window.removeImportedDictionary === 'function') {
          await window.removeImportedDictionary(name, (p) => {
            const pct = Math.floor((p.pct || 0) * 100);
            setStatus(window.i18n.fmt('pj.removing_dict_pct', { name, pct }));
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
        unzip: window.i18n.t('pj.phase_unzip', 'Unzipping…'),
        parse: window.i18n.t('pj.phase_parse', 'Parsing entries…'),
        cache: window.i18n.t('pj.phase_cache', 'Saving…'),
        index: window.i18n.t('pj.phase_index', 'Indexing…'),
        done:  window.i18n.t('pj.phase_done', 'Imported')
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
      setStatus(window.i18n.fmt('pj.reading_file', { name: f.name }));
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
        setStatus(window.i18n.fmt('pj.import_done', { name }));
        setBar(100);
        buildDictionarySection();
        setTimeout(hideBar, 1500);
      } catch (e) {
        console.error('Dict import failed:', e);
        setStatus(window.i18n.fmt('pj.import_failed', { err: (e?.message || e) }));
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
      opt.value = savedValue; opt.textContent = window.i18n.fmt('pj.saved_suffix', { value: savedValue });
      sel.appendChild(opt);
    }
    sel.value = savedValue || (values?.[0] || '');
  }

  // For field-mapping rows: includes a "(none)" option so the user can
  // explicitly leave a slot unassigned.
  function fillFieldSelect(sel, fields, saved) {
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = window.i18n.t('pj.none', '(none)');
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
      opt.value = saved; opt.textContent = window.i18n.fmt('pj.saved_suffix', { value: saved });
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

  // Desktop Anki over LAN (AnkiConnect on the user's Mac). Host persists on
  // change (dual-write Preferences + localStorage so sendToAnkiConnect.js can
  // read it synchronously); changing it repopulates the deck/model pickers
  // from the new source. Test button = version probe + deck count.
  async function setupAnkiConnectPref() {
    const input = document.getElementById('ankiConnectHostInput');
    const testBtn = document.getElementById('ankiConnectTestBtn');
    const status = document.getElementById('ankiConnectStatus');
    if (!input) return;
    try {
      const saved = (await getPref('ANKICONNECT_HOST')) ||
                    localStorage.getItem('ANKICONNECT_HOST') || '';
      input.value = saved;
    } catch (_) {}
    if (!input.dataset.wired) {
      input.dataset.wired = '1';
      input.addEventListener('change', async () => {
        const v = input.value.trim();
        try { localStorage.setItem('ANKICONNECT_HOST', v); } catch (_) {}
        try { await setPref('ANKICONNECT_HOST', v); } catch (_) {}
        if (status) status.textContent = '';
        // Pickers now come from (or stop coming from) the Mac.
        try { await wireAnkiSection(); } catch (_) {}
      });
    }
    if (testBtn && !testBtn.dataset.wired) {
      testBtn.dataset.wired = '1';
      testBtn.addEventListener('click', async () => {
        // Persist whatever is typed before probing (user may not have blurred).
        const v = input.value.trim();
        try { localStorage.setItem('ANKICONNECT_HOST', v); } catch (_) {}
        try { await setPref('ANKICONNECT_HOST', v); } catch (_) {}
        if (!v) {
          if (status) { status.textContent = window.i18n.t('pj.ac_no_host', 'Enter the Mac’s IP first'); status.style.color = '#c88'; }
          return;
        }
        if (status) { status.textContent = '…'; status.style.color = '#888'; }
        try {
          await window.ankiConnect.probe();
          const decks = await window.fetchDeckNames();
          if (status) {
            status.textContent = '✓ ' + window.i18n.fmt('pj.ac_connected', { n: decks.length });
            status.style.color = 'var(--accent-read,#4caf50)';
          }
          try { await wireAnkiSection(); } catch (_) {}
        } catch (e) {
          if (status) {
            status.textContent = '✗ ' + (e?.message || e);
            status.style.color = '#c88';
          }
        }
      });
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
