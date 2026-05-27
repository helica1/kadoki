// dict-prefs.js — persistence + helpers for the user's dictionary
// preferences (enabled set + display order). Loaded from localStorage
// under DICT_PREFS_V1 = { enabled: {name:true|false}, order: [name,...] }.
//
// Source of truth for which dictionaries are *available* lives in
// enhanced-dictionary.js (the runtime `dictionaries` Map). This module
// is just the user-config layer on top.

(function () {
  const KEY = 'DICT_PREFS_V1';

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { enabled: {}, order: [] };
      const o = JSON.parse(raw);
      return { enabled: o.enabled || {}, order: Array.isArray(o.order) ? o.order : [] };
    } catch (e) {
      return { enabled: {}, order: [] };
    }
  }

  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  let cache = load();

  // Returns the resolved enabled flag for a given dict name (default true
  // if never explicitly toggled — so newly-loaded dicts work out of the box).
  function isEnabled(name) {
    if (!name) return false;
    return cache.enabled[name] !== false;
  }

  // Returns the merged display order: persisted order first, then any
  // newly-discovered dict names appended in their original order.
  function orderedNames(allNames) {
    const seen = new Set();
    const result = [];
    for (const n of cache.order) {
      if (allNames.includes(n) && !seen.has(n)) { result.push(n); seen.add(n); }
    }
    for (const n of allNames) {
      if (!seen.has(n)) { result.push(n); seen.add(n); }
    }
    return result;
  }

  function setEnabled(name, enabled) {
    cache.enabled[name] = !!enabled;
    save(cache);
  }

  function setOrder(names) {
    cache.order = names.slice();
    save(cache);
  }

  function moveUp(name, allNames) {
    const ordered = orderedNames(allNames);
    const i = ordered.indexOf(name);
    if (i > 0) {
      [ordered[i - 1], ordered[i]] = [ordered[i], ordered[i - 1]];
      setOrder(ordered);
    }
  }

  function moveDown(name, allNames) {
    const ordered = orderedNames(allNames);
    const i = ordered.indexOf(name);
    if (i >= 0 && i < ordered.length - 1) {
      [ordered[i + 1], ordered[i]] = [ordered[i], ordered[i + 1]];
      setOrder(ordered);
    }
  }

  window.dictPrefs = { isEnabled, orderedNames, setEnabled, setOrder, moveUp, moveDown };
})();
