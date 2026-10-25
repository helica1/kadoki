// Native iOS Preferences, generated from the web Preferences.
//
// On iOS (window.KADOKI_NATIVE_PREFS, injected by NativePrefs.swift) opening
// Preferences builds the web panel as usual — every section's setup runs, so
// values, dynamic sections and side effects are exactly the web ones — then
// keeps it invisible and hands Swift a description of it:
//   sections → items (toggle / select / text / slider / color / stepper /
//   button / note), read straight from the live DOM.
// A native change is written back into the matching web control with its
// normal events, so the web handlers stay the single place settings are
// applied and stored, and Save / Cancel are the web ones. A setting added to
// the web panel shows up natively with no Swift change.
// Buttons that open a web dialog: the native screen steps aside while a web
// overlay covers the screen, then comes back.
(function () {
  'use strict';
  if (!window.KADOKI_NATIVE_PREFS) return;
  const post = (msg) => { try { window.webkit.messageHandlers.kadokiNativePrefs.postMessage(msg); } catch (_) {} };
  const modal = () => document.getElementById('preferencesModal');

  let els = new Map();          // item id → element(s), from the last describe()
  let nativeOpen = false;

  // Text with a space between block-level children ("Models" + "Each …"),
  // read from textContent: the panel is visibility:hidden, so innerText is empty.
  const raw = (el) => {
    let out = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1) {
        const block = !/^(inline|contents|ruby)/.test(getComputedStyle(n).display);
        out += block ? ' ' + raw(n) + ' ' : raw(n);
      }
    });
    return out;
  };
  const text = (el) => (el ? raw(el).replace(/\s+/g, ' ').trim() : '');
  const isControl = (el) => el.matches('input:not([type=hidden]):not([type=file]), select, textarea, button');

  // A control's label and help: <label for=id>, an enclosing <label>, or the
  // row's label. Help = a smaller nested span/div inside that label.
  function labelFor(c) {
    let lab = (c.id && document.querySelector('label[for="' + CSS.escape(c.id) + '"]')) || c.closest('label');
    if (!lab) {
      const row = c.closest('.prefs-row, .prefs-field, div');
      lab = row && row.querySelector(':scope > label');
    }
    if (!lab) return { label: '', help: '', el: null };
    const helpEl = lab.querySelector('span[style*="block"], div, small');
    const help = text(helpEl);
    let label = '';
    lab.childNodes.forEach((n) => {
      if (n === helpEl || (n.nodeType === 1 && (isControl(n) || n.contains(helpEl)))) return;
      label += n.textContent;
    });
    label = label.replace(/\s+/g, ' ').trim();
    return { label, help, el: lab };
  }

  function describe() {
    const m = modal();
    els = new Map();
    const sections = [];
    if (!m) return { sections };
    // Every section open while reading (closed <details> hide their content).
    const details = [...m.querySelectorAll('details.prefs-section')];
    const wasOpen = details.map(d => d.open);
    details.forEach(d => { d.open = true; });
    details.forEach((d, si) => {
      const title = text(d.querySelector('summary'));
      const key = d.querySelector('summary')?.getAttribute('data-i18n') || '';
      const items = [];
      const used = new Set();
      let n = 0;
      const id = (el) => {
        const k = 's' + si + ':' + (el.id || ('n' + (n++)));
        els.set(k, el);
        return k;
      };
      const walk = (node) => {
        for (const el of node.children) {
          if (el.tagName === 'SUMMARY' || used.has(el)) continue;
          if (!el.getClientRects().length) continue;               // display:none
          if (el.matches('button') && /^[−-]$/.test(text(el))) {
            // − value + stepper (font sizes)
            const row = el.parentElement;
            const plus = [...row.querySelectorAll('button')].find(b => text(b) === '+');
            if (plus) {
              const valEl = [...row.children].find(x => x !== el && x !== plus && !isControl(x) && text(x));
              const lf = labelFor(el);
              const k = id(el); els.set(k + '+', plus);
              items.push({ t: 'stepper', id: k, label: lf.label || text(row.closest('.prefs-row, div')?.querySelector('label')), value: text(valEl) });
              used.add(plus); if (valEl) used.add(valEl); if (lf.el) used.add(lf.el);
              continue;
            }
          }
          if (el.matches('button') && /^[▲▼✕×]$/.test(text(el))) {
            // Row accessory (dictionary list): attach to the previous item.
            const prev = items[items.length - 1];
            if (prev) {
              const k = id(el);
              (prev.acc = prev.acc || []).push({ id: k, kind: { '▲': 'up', '▼': 'down' }[text(el)] || 'delete' });
            }
            continue;
          }
          if (isControl(el)) { addControl(el); continue; }
          if (el.tagName === 'LABEL' && el.querySelector('input,select,textarea')) { walk(el); continue; }
          if (el.tagName === 'A' && el.href) { items.push({ t: 'link', label: text(el), url: el.href }); continue; }
          if (!el.querySelector('input,select,textarea,button,a[href]')) {
            if (el.tagName === 'LABEL' && el.htmlFor) continue;        // read with its control
            const tx = text(el);
            if (tx) items.push({ t: el.matches('.mode-label, h4, h5') ? 'header' : 'note', text: tx });
            continue;
          }
          walk(el);
        }
      };
      const addControl = (c) => {
        if (used.has(c)) return;
        const lf = labelFor(c);
        if (lf.el) used.add(lf.el);
        const base = { id: id(c), label: lf.label, help: lf.help, disabled: !!c.disabled };
        if (c.tagName === 'SELECT') {
          items.push(Object.assign(base, { t: 'select', value: c.value,
            options: [...c.options].filter(o => !o.hidden).map(o => ({ v: o.value, l: text(o) })) }));
        } else if (c.tagName === 'BUTTON') {
          items.push(Object.assign(base, { t: 'button', label: text(c) || lf.label,
            destructive: /reset|delete|remove|unlink|削除|リセット/i.test(text(c)) }));
        } else if (c.type === 'checkbox') {
          items.push(Object.assign(base, { t: 'toggle', on: !!c.checked, label: lf.label || text(c.parentElement) }));
        } else if (c.type === 'range') {
          const out = c.parentElement && [...c.parentElement.querySelectorAll('span,output')].find(s => /\d/.test(text(s)) && s !== c);
          items.push(Object.assign(base, { t: 'slider', value: +c.value, min: +c.min || 0, max: +c.max || 100,
            step: c.step === 'any' ? 0 : (+c.step || 1), display: text(out) }));
          if (out) used.add(out);
        } else if (c.type === 'color') {
          items.push(Object.assign(base, { t: 'color', value: c.value, label: lf.label || text(c.parentElement) }));
        } else if (c.tagName === 'TEXTAREA' || /^(text|password|number|url|email|search)$/.test(c.type)) {
          items.push(Object.assign(base, { t: 'text', value: c.value, secure: c.type === 'password',
            numeric: c.type === 'number', placeholder: c.placeholder || '' }));
        }
      };
      walk(d);
      // A control with no label of its own takes a short note right before it
      // (its label sits in a separate element: "Font size" − 18 +).
      for (let i = 1; i < items.length; i++) {
        const it = items[i], prev = items[i - 1];
        if (!it.label && it.t !== 'note' && it.t !== 'header' && prev.t === 'note' && prev.text.length <= 40) {
          it.label = prev.text;
          prev.drop = true;
        }
      }
      // A unit right after a field ("k字", "px") belongs to that field.
      for (let i = 1; i < items.length; i++) {
        const it = items[i], prev = items[i - 1];
        if (it.t === 'note' && it.text.length <= 4 && (prev.t === 'text' || prev.t === 'slider')) {
          prev.unit = it.text;
          it.drop = true;
        }
      }
      // Drop notes that only repeat a control's label.
      const labels = new Set(items.filter(x => x.label).map(x => x.label));
      sections.push({ title, key, items: items.filter(x => !x.drop && !(x.t === 'note' && labels.has(x.text))) });
    });
    details.forEach((d, i) => { d.open = wasOpen[i]; });
    return { title: text(m.querySelector('h3')), sections };
  }

  const settle = () => new Promise(r => setTimeout(r, 60));
  const fire = (el, ...types) => types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));

  window.__kadokiPrefsDescribe = () => JSON.stringify(describe());

  window.__kadokiPrefsSet = async function (k, v) {
    const el = els.get(k);
    if (!el) return JSON.stringify(describe());
    if (el.type === 'checkbox') { if (el.checked !== !!v) el.click(); }
    else if (el.tagName === 'SELECT') { el.value = String(v); fire(el, 'input', 'change'); }
    else { el.value = String(v); fire(el, 'input', 'change'); }
    await settle();
    return JSON.stringify(describe());
  };

  // Stepper: dir +1 / −1. Accessories and buttons: plain clicks.
  window.__kadokiPrefsStep = async function (k, dir) {
    const el = els.get(dir > 0 ? k + '+' : k);
    if (el) el.click();
    await settle();
    return JSON.stringify(describe());
  };
  window.__kadokiPrefsClick = async function (k) {
    const el = els.get(k);
    if (el) el.click();
    await new Promise(r => setTimeout(r, 350));
    checkCover();
    return JSON.stringify(describe());
  };

  window.__kadokiPrefsSave = () => { try { window.savePreferences(); } catch (_) {} };
  window.__kadokiPrefsCancel = () => { try { window.closePreferences(); } catch (_) {} };

  // ---- a web dialog over the screen while native Preferences is up ----
  // Full-screen fixed layers already there when Preferences opened (the audio
  // / reading views) are the app, not a dialog: only new ones count.
  let covered = false;
  let baseline = new Set();
  function overlays() {
    const vw = innerWidth, vh = innerHeight, out = [];
    for (const el of document.body.children) {
      if (el === modal() || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.3) out.push(el);
    }
    return out;
  }
  function checkCover() {
    if (!nativeOpen) return;
    const on = overlays().some(el => !baseline.has(el));
    if (on !== covered) { covered = on; post({ type: 'cover', on }); }
  }

  // ---- open / close ----
  const origOpen = window.openPreferences;
  window.openPreferences = async function () {
    const m = modal();
    if (m) { m.style.visibility = 'hidden'; m.style.pointerEvents = 'none'; }
    await origOpen.apply(this, arguments);
    nativeOpen = true;
    covered = false;
    baseline = new Set(overlays());
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    post({ type: 'open', model: JSON.stringify(describe()) });
  };
  function restore() {
    const m = modal();
    if (m) { m.style.visibility = ''; m.style.pointerEvents = ''; }
  }
  // Closed by Save / Cancel, or by web code (some buttons close Preferences).
  // Watches only while native Preferences is up (the reader restyles itself
  // constantly; no page-wide observer while reading).
  const watch = new MutationObserver(() => {
    const m = modal();
    if (nativeOpen && m && m.style.display === 'none') {
      nativeOpen = false; covered = false; restore();
      watch.disconnect();
      post({ type: 'closed' });
      return;
    }
    checkCover();
  });
})();
