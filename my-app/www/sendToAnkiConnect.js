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

async function fetchDeckNames() {
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
}

// Fetch all available Anki note type names via AnkiConnect's `modelNames`.
// Returns [] on failure / offline.
async function fetchModelNames() {
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
}
window.fetchModelNames = fetchModelNames;

// Fetch the field names of a given Anki note type via AnkiConnect's
// `modelFieldNames`. Returns [] on failure / offline.
async function fetchModelFieldNames(modelName) {
  if (!modelName) return [];
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
}
window.fetchModelFieldNames = fetchModelFieldNames;

async function sendToAnki({ expression, imageData, audioData }) {
  // Read configured Anki settings (with defaults that match the previous
  // hardcoded behavior). See preferences.js for shape + defaults.
  const cfg = (typeof window.getAnkiSettings === 'function')
    ? await window.getAnkiSettings('swipe')
    : { deck: (await getPref('SELECTED_DECK')) || 'Shadowing5',
        model: 'jidoujisho Kinomoto BLUE',
        fields: { expression: 'Term', image: 'Image', audio: 'Sentence Audio' } };

  const decks = await fetchDeckNames();
  if (!decks.includes(cfg.deck)) {
    alert(`Deck "${cfg.deck}" not found. Pick an existing deck in Preferences.`);
    return;
  }

  const imageFilename = `anki_${Date.now()}.jpg`;
  const audioFilename = `sentence_${Date.now()}.mp3`;

  const fields = {};
  fields[cfg.fields.expression] = expression || '';
  fields[cfg.fields.image]      = '';
  fields[cfg.fields.audio]      = '';

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
}

window.sendToAnki = sendToAnki;
