// ============================================================================
// sendToAnkiConnect.js
//
// Anki integration. Two transports:
//
//   1) AnkiBridge (Capacitor plugin) — talks directly to AnkiDroid's
//      ContentProvider (content://com.ichi2.anki.flashcards). No sideload
//      app needed; no Google Play Protect interference. THIS IS THE
//      DEFAULT on Android.
//
//   2) AnkiConnect over HTTP at http://127.0.0.1:8765 — used to require
//      the AnkiConnect-for-Android sideload, which Play Protect kills
//      periodically. KEPT AS A FALLBACK for desktop AnkiConnect testing
//      or if AnkiBridge is unavailable. All old code is commented out
//      below so we can revert by flipping the routing in `viaBridge()`.
//
// API surface (unchanged for callers):
//   window.sendToAnki({ expression, imageData, audioData })
//   window.fetchModelNames()
//   window.fetchModelFieldNames(modelName)
//   fetchDeckNames()  (also called by preferences.js via window.AnkiTransport)
// ============================================================================

async function isCap() {
  return typeof window.isCapacitorEnvironment === 'function' && window.isCapacitorEnvironment();
}

async function getPref(key) {
  if (await isCap()) {
    try {
      const res = await window.Capacitor.Plugins.Preferences.get({ key });
      return res.value;
    } catch (e) {
      console.error('Preferences get error', e);
    }
  }
  return localStorage.getItem(key);
}

async function setPref(key, value) {
  if (await isCap()) {
    try {
      await window.Capacitor.Plugins.Preferences.set({ key, value: value.toString() });
    } catch (e) {
      console.error('Preferences set error', e);
    }
  } else {
    localStorage.setItem(key, value.toString());
  }
}

// Returns the AnkiBridge plugin instance if AnkiDroid is reachable. If the
// permission hasn't been granted yet, surfaces the system prompt and waits
// for the user's decision before returning. Null = AnkiDroid not installed
// or user denied permission.
let _bridgeAvailableCached = null;
async function viaBridge(opts) {
  const ab = window.Capacitor?.Plugins?.AnkiBridge;
  if (!ab) return null;
  if (_bridgeAvailableCached === true) return ab;
  try {
    const r = await ab.isAvailable();
    if (!r?.available) { _bridgeAvailableCached = false; return null; }
    if (r.needsPermission) {
      // Trigger the system "Allow this app to access AnkiDroid's data?"
      // dialog. requestPermission resolves to { granted: bool }.
      if (opts?.skipPermissionPrompt) return null;
      try {
        const grant = await ab.requestPermission();
        if (!grant?.granted) {
          alert('AnkiDroid permission denied. Enable it in Settings → Apps → Anki Deck Reader → Permissions to add cards.');
          _bridgeAvailableCached = false;
          return null;
        }
      } catch (e) {
        console.warn('AnkiBridge.requestPermission threw:', e?.message || e);
        _bridgeAvailableCached = false;
        return null;
      }
    }
    _bridgeAvailableCached = true;
    return ab;
  } catch (e) {
    _bridgeAvailableCached = false;
    return null;
  }
}
window.viaAnkiBridge = viaBridge;

// ----------------------------------------------------------------------------
// fetchDeckNames
// ----------------------------------------------------------------------------
async function fetchDeckNames() {
  const ab = await viaBridge();
  if (ab) {
    try {
      const r = await ab.deckNames();
      return Array.isArray(r?.decks) ? r.decks : [];
    } catch (e) {
      console.warn('AnkiBridge.deckNames failed:', e?.message || e);
      return [];
    }
  }
  /* ---- legacy AnkiConnect HTTP path (kept for fallback / desktop) ----
  try {
    const payload = { action: "deckNames", version: 6 };
    const res = await fetch("http://127.0.0.1:8765", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" }
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.result || [];
  } catch (e) {
    console.error("Failed to fetch deck names:", e);
    return [];
  }
  */
  return [];
}
window.fetchDeckNames = fetchDeckNames;

// ----------------------------------------------------------------------------
// fetchModelNames
// ----------------------------------------------------------------------------
async function fetchModelNames() {
  const ab = await viaBridge();
  if (ab) {
    try {
      const r = await ab.modelNames();
      return Array.isArray(r?.models) ? r.models : [];
    } catch (e) {
      console.warn('AnkiBridge.modelNames failed:', e?.message || e);
      return [];
    }
  }
  /* ---- legacy AnkiConnect HTTP path ----
  try {
    const res = await fetch("http://127.0.0.1:8765", {
      method: "POST",
      body: JSON.stringify({ action: "modelNames", version: 6 }),
      headers: { "Content-Type": "application/json" }
    });
    const json = await res.json();
    if (json.error) { console.warn("modelNames error:", json.error); return []; }
    return Array.isArray(json.result) ? json.result : [];
  } catch (e) {
    console.warn("modelNames unreachable:", e?.message || e);
    return [];
  }
  */
  return [];
}
window.fetchModelNames = fetchModelNames;

// ----------------------------------------------------------------------------
// fetchModelFieldNames
// ----------------------------------------------------------------------------
async function fetchModelFieldNames(modelName) {
  if (!modelName) return [];
  const ab = await viaBridge();
  if (ab) {
    try {
      const r = await ab.modelFieldNames({ modelName });
      return Array.isArray(r?.fields) ? r.fields : [];
    } catch (e) {
      console.warn('AnkiBridge.modelFieldNames failed:', e?.message || e);
      return [];
    }
  }
  /* ---- legacy AnkiConnect HTTP path ----
  try {
    const res = await fetch("http://127.0.0.1:8765", {
      method: "POST",
      body: JSON.stringify({ action: "modelFieldNames", version: 6, params: { modelName } }),
      headers: { "Content-Type": "application/json" }
    });
    const json = await res.json();
    if (json.error) {
      console.warn("modelFieldNames error:", json.error);
      return [];
    }
    return Array.isArray(json.result) ? json.result : [];
  } catch (e) {
    console.warn("modelFieldNames unreachable:", e?.message || e);
    return [];
  }
  */
  return [];
}
window.fetchModelFieldNames = fetchModelFieldNames;

// ----------------------------------------------------------------------------
// sendToAnki — swipe-up flow (card mode)
// ----------------------------------------------------------------------------
async function sendToAnki({ expression, imageData, audioData }) {
  const cfg = (typeof window.getAnkiSettings === 'function')
    ? await window.getAnkiSettings('swipe')
    : { deck: (await getPref('SELECTED_DECK')) || 'Shadowing9',
        model: 'jidoujisho Kinomoto BLUE',
        fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio' } };

  // Pre-flight: verify the deck exists, BUT only when we actually got a
  // non-empty list back. iOS AnkiMobile has no listing API in the URL
  // scheme — our AnkiBridge.deckNames() returns an empty array there.
  // If we treat empty-list as "deck not found" we'd block every send on
  // iOS, which is what was happening (silent no-op + "Shadowing9 doesn't
  // exist" alert even when the deck did exist).
  const decks = await fetchDeckNames();
  if (decks.length > 0 && !decks.includes(cfg.deck)) {
    alert(`Deck "${cfg.deck}" not found. Pick an existing deck in Preferences.`);
    return;
  }

  const imageFilename = `anki_${Date.now()}.jpg`;
  const audioFilename = `sentence_${Date.now()}.mp3`;

  const fields = {};
  fields[cfg.fields.expression] = expression || '';
  fields[cfg.fields.image]      = '';
  fields[cfg.fields.audio]      = '';

  // --- AnkiBridge path (default on Android) ---
  const ab = await viaBridge();
  if (ab) {
    try {
      const params = {
        deckName:  cfg.deck,
        modelName: cfg.model,
        fields,
        tags:      ['android'],
      };
      if (audioData) {
        params.audio = [{
          filename:   audioFilename,
          dataBase64: audioData.split(',')[1],
          field:      cfg.fields.audio
        }];
      }
      if (imageData) {
        params.picture = [{
          filename:   imageFilename,
          dataBase64: imageData.split(',')[1],
          field:      cfg.fields.image
        }];
      }
      const r = await ab.addNote(params);
      console.log('AnkiBridge.addNote ->', r);
      if (typeof window.showToast === 'function') {
        window.showToast(`✓ Added to ${cfg.deck}`, 2200);
      }
      return;
    } catch (err) {
      console.error('AnkiBridge.addNote error:', err);
      if (typeof window.showToast === 'function') {
        window.showToast(`✗ Anki: ${err?.message || err}`, 4000);
      } else {
        alert('Failed to add note to AnkiDroid: ' + (err?.message || err));
      }
      return;
    }
  }

  /* ---- legacy AnkiConnect HTTP path ----
  const payload = {
    action: "addNote",
    version: 6,
    params: {
      note: {
        deckName: cfg.deck,
        modelName: cfg.model,
        fields,
        options: { allowDuplicate: false },
        tags: ["android"],
        audio: audioData
          ? [{ filename: audioFilename, data: audioData.split(",")[1], fields: [cfg.fields.audio] }]
          : [],
        picture: imageData
          ? [{ filename: imageFilename, data: imageData.split(",")[1], fields: [cfg.fields.image] }]
          : []
      }
    }
  };

  try {
    const res = await fetch("http://127.0.0.1:8765", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" }
    });
    const json = await res.json();
    console.log("AnkiConnect response:", json);
    if (json.error) alert("Anki error: " + json.error);
  } catch (err) {
    console.error("AnkiConnect error:", err);
    alert("Failed to reach AnkiConnect.");
  }
  */
  alert('AnkiDroid not detected. Install AnkiDroid from the Play Store and grant permission on first send.');
}

window.sendToAnki = sendToAnki;
