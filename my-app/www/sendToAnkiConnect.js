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

// =============================================================================
// AnkiMobile x-callback resolution
// =============================================================================
//
// When iOS opens our anki:// URL, AnkiMobile invokes EITHER
// `ankideckreader://anki-success` or `ankideckreader://anki-error` once
// it's done. Without this listener, our addNote toast fires the moment
// iOS successfully HANDS OFF the URL (UIApplication.shared.open ok=true),
// which is NOT the same as AnkiMobile actually creating a card. Result:
// "Added to Mining" toast with no card present, because AnkiMobile
// silently rejected the URL (most commonly: model name doesn't exist).
//
// We hook into the Capacitor App plugin's appUrlOpen event, route the
// callback URL to whichever send is currently waiting for it, and the
// send path can replace the optimistic toast with the actual outcome.
let _pendingAnkiCallbackResolve = null;
let _pendingAnkiCallbackTimer   = null;

function _resolveAnkiCallback(result) {
  if (_pendingAnkiCallbackTimer) clearTimeout(_pendingAnkiCallbackTimer);
  _pendingAnkiCallbackTimer = null;
  const r = _pendingAnkiCallbackResolve;
  _pendingAnkiCallbackResolve = null;
  if (r) r(result);
}

function _handleCallbackUrl(u, source) {
  console.log(`[anki-cb] (${source}) url=`, u);
  try { window._lastAnkiCallbackUrl = u; } catch (_) {}
  if (u.includes('anki-success')) _resolveAnkiCallback('success');
  else if (u.includes('anki-error')) _resolveAnkiCallback('error');
}

function hookAnkiCallbackOnce() {
  if (window._ankiCallbackHooked) return;
  let hooked = false;
  // Primary path: @capacitor/app's appUrlOpen event. Only available
  // if @capacitor/app is installed (it isn't, in this build — kept
  // for completeness if it's added later).
  const App = window.Capacitor?.Plugins?.App;
  if (App?.addListener) {
    try {
      App.addListener('appUrlOpen', (data) => _handleCallbackUrl(data?.url || '', 'App'));
      console.log('[anki-cb] App.appUrlOpen listener hooked');
      hooked = true;
    } catch (e) { console.warn('[anki-cb] App hook failed:', e?.message); }
  }
  // Fallback path: AnkiBridge plugin's ankiCallbackUrl event, which is
  // fired by AppDelegate.swift via NSNotification. This works without
  // @capacitor/app installed.
  const Ab = window.Capacitor?.Plugins?.AnkiBridge;
  if (Ab?.addListener) {
    try {
      Ab.addListener('ankiCallbackUrl', (data) => _handleCallbackUrl(data?.url || '', 'AnkiBridge'));
      console.log('[anki-cb] AnkiBridge.ankiCallbackUrl listener hooked');
      hooked = true;
    } catch (e) { console.warn('[anki-cb] AnkiBridge hook failed:', e?.message); }
  }
  if (hooked) window._ankiCallbackHooked = true;
  else console.warn('[anki-cb] no listener available yet — will retry');
}
// Retry aggressively at boot — plugins can be unavailable for the
// first few hundred ms on iOS while WKWebView initializes.
[100, 300, 500, 1000, 2000, 4000].forEach(ms => setTimeout(hookAnkiCallbackOnce, ms));

// Resolves to 'success' | 'error' | 'timeout' depending on which callback
// AnkiMobile fires. Caller should immediately invoke addNote AFTER this
// returns a Promise (to avoid the race where the callback fires before
// the listener is armed).
function waitForAnkiCallback(timeoutMs) {
  hookAnkiCallbackOnce();
  // If a previous send didn't resolve yet, kill it — the new send is
  // what the user is paying attention to.
  if (_pendingAnkiCallbackResolve) _resolveAnkiCallback('superseded');
  return new Promise((resolve) => {
    _pendingAnkiCallbackResolve = resolve;
    _pendingAnkiCallbackTimer = setTimeout(() => {
      _resolveAnkiCallback('timeout');
    }, timeoutMs || 8000);
  });
}
window.waitForAnkiCallback = waitForAnkiCallback;

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
//
// Cache: `_bridgeAvailableCached === true` skips the isAvailable round-trip
// on subsequent calls. The cache is INVALIDATED any time an actual addNote
// (or any verb) fails — the catch blocks below call `invalidateBridgeCache`.
// That handles the "AnkiDroid was killed in the background" case: next send
// re-runs isAvailable and can surface the permission prompt again instead of
// failing silently with a stale handle.
let _bridgeAvailableCached = null;
function invalidateBridgeCache() { _bridgeAvailableCached = null; }
window.invalidateAnkiBridgeCache = invalidateBridgeCache;
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
      // Mark the anki round-trip BEFORE the addNote handoff. On iOS,
      // the URL scheme call backgrounds us briefly; stats.js suspends
      // its background-stop while this flag is set so the running
      // card/read timer isn't halted just because the user added a
      // card. Harmless no-op on Android (no handoff happens).
      try { window.stats?.markAnkiRoundtripActive?.(); } catch (_) {}
      // Arm the callback listener BEFORE addNote so the x-success /
      // x-error event from AnkiMobile can be caught. addNote itself
      // resolves the moment iOS hands off the URL — which says
      // nothing about whether AnkiMobile actually created the card.
      // iOS hands the note off to AnkiMobile via an anki:// URL and learns the
      // REAL result asynchronously through the x-callback. Android inserts
      // directly through the AnkiDroid ContentProvider — addNote is SYNCHRONOUS
      // and authoritative (it rejects on a bad deck/model/permission/duplicate),
      // and there is NO x-callback. Waiting for one on Android always timed out
      // → the bogus "No reply from AnkiMobile" error.
      const isAndroid = window.Capacitor?.getPlatform?.() === 'android';
      const cbPromise = (!isAndroid && typeof window.waitForAnkiCallback === 'function')
        ? window.waitForAnkiCallback(8000)
        : Promise.resolve('unknown');
      const r = await ab.addNote(params);
      console.log('AnkiBridge.addNote ->', r);
      if (r?.mediaServerRestartedThisSend) {
        console.log('AnkiBridge: media server was restarted to complete this send');
      }
      if (isAndroid) {
        // A non-throwing addNote means AnkiDroid created the note (r.noteId).
        if (typeof window.showToast === 'function') {
          window.showToast(`✓ Added to ${cfg.deck}`, 2200);
        }
        return;
      }
      // Optimistic "Sending…" toast while we wait for the callback (iOS).
      if (typeof window.showToast === 'function') {
        window.showToast(`Sending to ${cfg.deck}…`, 1400);
      }
      const cbResult = await cbPromise;
      console.log('AnkiBridge x-callback result:', cbResult);
      if (typeof window.showToast === 'function') {
        if (cbResult === 'success') {
          window.showToast(`✓ Added to ${cfg.deck}`, 2200);
        } else if (cbResult === 'error') {
          window.showToast(`✗ AnkiMobile rejected — model "${cfg.model}" likely doesn't exist`, 5500);
        } else if (cbResult === 'timeout') {
          // Most common cause of a silent timeout (no x-error fired)
          // is the model name mismatching what's in AnkiMobile. Surface
          // the model we sent so the user can compare it against
          // AnkiMobile → manage note types without leaving the toast.
          window.showToast(`? No reply from AnkiMobile. Sent model="${cfg.model}". Verify it exists in AnkiMobile → Manage note types.`, 6500);
        } else {
          window.showToast(`✓ Sent to ${cfg.deck}`, 2200);
        }
      }
      return;
    } catch (err) {
      console.error('AnkiBridge.addNote error:', err);
      // Clear the availability cache so the NEXT send re-runs isAvailable +
      // requestPermission. Handles "AnkiDroid was killed in background" on
      // Android and "media server is genuinely dead" on iOS — both surface
      // here as a reject. User can swipe-up again and we'll re-validate.
      invalidateBridgeCache();
      const msg = err?.message || String(err);
      // The iOS plugin already attempts a forceRestart before this error
      // surfaces. So a "media server is unreachable" reject here means
      // the restart itself failed — the user needs to relaunch the app
      // rather than just retry the send.
      const isServerDown = /media server is unreachable/i.test(msg);
      const display = isServerDown
        ? '✗ Anki media server stuck — restart the app to recover'
        : `✗ Anki: ${msg}`;
      if (typeof window.showToast === 'function') {
        window.showToast(display, 4000);
      } else {
        alert(display);
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
