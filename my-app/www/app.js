// FileAccess plugin will be available globally through Capacitor

// No import needed - Capacitor automatically registers plugins

// PERFORMANCE (Android-only jank fix): gate verbose console.log behind a runtime
// flag. On Android the WebView intercepts EVERY console.log on the UI thread and
// writes logcat synchronously; this app logs heavily (per-scroll [scroll-trace],
// per-switch deck-state saves, dict lookups), which janked scrolling + lookups
// ("unresponsive then perks up"). iOS's console path is cheap, so iOS stayed
// snappy. Default OFF for speed; `localStorage.setItem('KADOKI_DEBUG','1')` then
// reload re-enables it for diagnosis. console.error / console.warn are left
// intact so crashes/warnings still reach logcat.
(function () {
  try { window.__KDBG = (localStorage.getItem('KADOKI_DEBUG') === '1'); }
  catch (_) { window.__KDBG = false; }
  const _origLog = console.log.bind(console);
  console.log = function () { if (window.__KDBG) _origLog.apply(console, arguments); };
})();

// Cleared the first time displayCard is asked to start audio. Keeps the
// app silent on launch so the user can choose when to start playback.
window.startupAutoPlayBlocked = true;

// System-gesture safe zones (iOS + Android). A swipe that BEGINS within these
// edge bands belongs to the OS — top = notification shade / Control Center,
// bottom = app switcher / home — so the app's swipe handlers must ignore it,
// otherwise the system gesture also fires an in-app action. Generous enough to
// cover the status-bar/notch region up top and the gesture-nav pill / home
// indicator at the bottom on both platforms. `_inSystemGestureZone(clientY)` is
// called at the START point of every vertical-swipe handler.
window.SYS_GESTURE_TOP = 64;
window.SYS_GESTURE_BOTTOM = 72;
window._inSystemGestureZone = function (clientY) {
  if (!Number.isFinite(clientY)) return false;
  const vh = window.innerHeight || 0;
  return clientY <= window.SYS_GESTURE_TOP ||
         (vh > 0 && clientY >= vh - window.SYS_GESTURE_BOTTOM);
};
// Cue → audio offset (ms). Compensates for two real-world issues:
//   (a) SRT timestamps tend to land *at* the first phoneme rather than
//       just before it, so playback starts mid-word.
//   (b) MP3 seek is frame-aligned (~26 ms granularity), can land *after*
//       the requested startMs.
// We start AUDIO_START_OFFSET_MS earlier than the cue says. End is left
// alone — we don't want to chop the trailing word.
window.AUDIO_START_OFFSET_MS = 150;
let allNotes = [];
let currentCardIndex = 0;
let currentAudio = null;
let stopwatchSeconds = 0;
let stopwatchTimeout = 20; // default timeout in seconds
let stopwatchInterval = null;
let lastInteractionTime = Date.now();
let viewedNotes = new Set();
let currentZip = null;
let currentApkgReader = null; // open zip.js ZipReader for the active deck (lazy media)
let _deckLoadInFlight = false; // serializes loadDeckFromFile against concurrent calls
let mediaCache = new Map(); // LRU cache for media files
let maxCacheSize = 50; // Limit cache to 50 media files

// Progressive loading state
let isLoadingComplete = false;
let backgroundProcessor = null;
let totalNotesExpected = 0;
let notesProcessed = 0;

// Capacitor-specific variables
let Filesystem, Preferences;
let currentFileUri = null; // Store file URI for Capacitor
let currentStoredPath = null; // Store app's private file path

// Enhanced debugging
function debugLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `[APP] ${timestamp}: ${message}`;
  console.log(logMessage);

  // Forward to a SEPARATE on-screen HTML debug console if one exists — but NEVER
  // when window.debugLog is THIS function. index.html does `window.debugLog =
  // debugLog` to expose it globally, so an unguarded forward calls itself
  // forever: a stack overflow on every debugLog call (and isCapacitorEnvironment
  // calls it repeatedly). That burned ~60k recursions, aborted the reading-mode
  // restore (→ opens a few lines back) and the card render (→ blank card), and
  // caused multi-second mode-switch lag.
  if (window.debugLog && window.debugLog !== debugLog) {
    window.debugLog(message);
  }
}

// Persistence keys for Capacitor
const PERSISTENCE_KEYS = {
  FILE_URI: 'ankiDeckFILE_URI',
  CARD_INDEX: 'ankiDeckCARD_INDEX',
  FILE_NAME: 'ankiDeckFILE_NAME',
  STORED_FILE_PATH: 'ankiDeckSTORED_FILE_PATH',
  LAST_ACCESSED: 'ankiDeckLAST_ACCESSED'
};

// Initialize Capacitor plugins with better error handling
async function initCapacitorPlugins() {
  debugLog("Initializing Capacitor plugins...");
  
  if (window.Capacitor) {
    debugLog("Capacitor core detected");
    
    // Try different ways to access the plugins
    let fsPlugin = null;
    let prefsPlugin = null;
    
    // Method 1: Try Capacitor.Plugins (standard way)
    if (window.Capacitor.Plugins) {
      debugLog("Capacitor.Plugins available");
      fsPlugin = window.Capacitor.Plugins.Filesystem;
      prefsPlugin = window.Capacitor.Plugins.Preferences;
    }
    
    // Method 2: Try direct plugin access (some versions)
    if (!fsPlugin && window.Filesystem) {
      debugLog("Trying direct window.Filesystem");
      fsPlugin = window.Filesystem;
    }
    if (!prefsPlugin && window.Preferences) {
      debugLog("Trying direct window.Preferences");
      prefsPlugin = window.Preferences;
    }
    
    // Method 3: Try Capacitor namespace (older versions)
    if (!fsPlugin && window.Capacitor.Filesystem) {
      debugLog("Trying Capacitor.Filesystem");
      fsPlugin = window.Capacitor.Filesystem;
    }
    if (!prefsPlugin && window.Capacitor.Preferences) {
      debugLog("Trying Capacitor.Preferences");
      prefsPlugin = window.Capacitor.Preferences;
    }
    
    // Method 4: Try importing plugins dynamically
    if (!fsPlugin || !prefsPlugin) {
      try {
        debugLog("Trying dynamic plugin import");
        const { Filesystem: DynamicFS, Preferences: DynamicPrefs } = await import('@capacitor/filesystem');
        if (!fsPlugin) fsPlugin = DynamicFS;
        if (!prefsPlugin) prefsPlugin = DynamicPrefs;
      } catch (importError) {
        debugLog(`Dynamic import failed: ${importError.message}`);
      }
    }
    
    // Set global references
    if (fsPlugin) {
      Filesystem = fsPlugin;
      window.Filesystem = fsPlugin;
      debugLog("✅ Filesystem plugin available");
    } else {
      debugLog("❌ Filesystem plugin not found");
    }
    
    if (prefsPlugin) {
      Preferences = prefsPlugin;
      window.Preferences = prefsPlugin;
      debugLog("✅ Preferences plugin available");
    } else {
      debugLog("❌ Preferences plugin not found");
    }
    
    // Test the plugins
    if (prefsPlugin) {
      try {
        await prefsPlugin.get({ key: 'test' });
        debugLog("✅ Preferences plugin working");
      } catch (testError) {
        debugLog(`⚠️ Preferences test failed: ${testError.message}`);
      }
    }
    
    const success = !!(fsPlugin && prefsPlugin);
    debugLog(`Capacitor initialization result: ${success}`);
    return success;
    
  } else {
    debugLog("⚠️ Capacitor not available (running in web environment)");
    return false;
  }
}

// Check if running in Capacitor environment
function isCapacitorEnvironment() {
  // Try multiple ways to detect working Capacitor plugins
  let hasFilesystem = false;
  let hasPreferences = false;
  
  // Check various possible locations for the plugins
  if (window.Capacitor) {
    // Standard location
    hasFilesystem = !!(window.Capacitor.Plugins?.Filesystem || 
                      window.Filesystem || 
                      window.Capacitor.Filesystem);
    hasPreferences = !!(window.Capacitor.Plugins?.Preferences || 
                       window.Preferences || 
                       window.Capacitor.Preferences);
  }
  
  const result = !!(window.Capacitor && hasFilesystem && hasPreferences);

  // Log the environment probe at most ONCE. This is a HOT path — called on every
  // preference read/write, many times per mode switch — and emitting 3 verbose
  // lines (the full Capacitor property + plugin list) each time was hundreds of
  // console.log → logcat JNI hops, contributing real mode-switch lag + log spam.
  if (!window._capEnvLogged) {
    window._capEnvLogged = true;
    debugLog(`Capacitor environment check: ${result} (Capacitor: ${!!window.Capacitor}, Plugins: ${!!window.Capacitor?.Plugins}, FS: ${hasFilesystem}, Prefs: ${hasPreferences})`);
    if (window.Capacitor) {
      debugLog(`Available Capacitor properties: ${Object.keys(window.Capacitor).join(', ')}`);
      if (window.Capacitor.Plugins) {
        debugLog(`Available Plugin names: ${Object.keys(window.Capacitor.Plugins).join(', ')}`);
      }
    }
  }
  
  return result;
}

// Make this function globally available
window.isCapacitorEnvironment = isCapacitorEnvironment;

// Enhanced save deck state with field mappings
async function saveDeckState() {
  debugLog(`Saving deck metadata: card ${currentCardIndex}, deck: ${document.getElementById('deckName').textContent}`);
  
  try {
    const currentTime = Date.now();
    const cardIndex = currentCardIndex.toString();
    const fileName = document.getElementById('deckName').textContent;
    
    if (fileName === 'No file chosen' || !fileName) {
      debugLog('Not saving deck state - no valid file name');
      return;
    }
    
    // Create deck info object with field mapping reference
    const deckInfo = {
      fileName: fileName,
      cardIndex: currentCardIndex,
      lastAccessed: currentTime,
      totalCards: allNotes.length,
      fileUri: currentFileUri || null,
      requiresManualSelection: !currentFileUri,
      hasCustomFieldMapping: !!window.currentFieldMappings
    };
    
    debugLog(`Saving with file URI: ${currentFileUri || 'none'}`);
    
    if (isCapacitorEnvironment()) {
      // Use Capacitor Preferences
      await window.Capacitor.Plugins.Preferences.set({
        key: PERSISTENCE_KEYS.CARD_INDEX,
        value: cardIndex
      });
      
      await window.Capacitor.Plugins.Preferences.set({
        key: PERSISTENCE_KEYS.FILE_NAME,
        value: fileName
      });
      
      await window.Capacitor.Plugins.Preferences.set({
        key: PERSISTENCE_KEYS.LAST_ACCESSED,
        value: currentTime.toString()
      });
      
      // Save file URI if we have one
      if (currentFileUri) {
        await window.Capacitor.Plugins.Preferences.set({
          key: PERSISTENCE_KEYS.FILE_URI,
          value: currentFileUri
        });
        debugLog(`Saved file URI: ${currentFileUri}`);
      }
      
      // Manage deck list
      await addDeckToList(deckInfo, true); // true = use Capacitor
      
      debugLog(`✅ Saved deck metadata (Capacitor): card ${currentCardIndex}`);
    } else {
      // Fallback to localStorage
      localStorage.setItem(PERSISTENCE_KEYS.CARD_INDEX, cardIndex);
      localStorage.setItem(PERSISTENCE_KEYS.FILE_NAME, fileName);
      localStorage.setItem(PERSISTENCE_KEYS.LAST_ACCESSED, currentTime.toString());
      
      if (currentFileUri) {
        localStorage.setItem(PERSISTENCE_KEYS.FILE_URI, currentFileUri);
      }
      
      // Manage deck list
      await addDeckToList(deckInfo, false); // false = use localStorage
      
      debugLog(`✅ Saved deck metadata (localStorage): card ${currentCardIndex}`);
    }
  } catch (error) {
    debugLog(`❌ Error saving deck metadata: ${error.message}`);
  }
}

// Remove the file storage function entirely since we never copy files
// This simplifies the codebase significantly

// Stream a content:// URI into the app cache and load it as a deck.
// Same path used by initial pick, recent-list tap, and startup auto-restore.
async function loadDeckFromUri(uri, fileName) {
  if (!window.Capacitor?.Plugins?.FileAccess) {
    throw new Error('FileAccess plugin not available');
  }

  debugLog(`📥 Materializing URI to cache: ${uri}`);
  showToast(`Loading ${fileName}...`, 2000);

  const { path, size, cached } = await window.Capacitor.Plugins.FileAccess.materializeToCache({ uri });
  debugLog(`Cache ready: ${path} (${size} bytes, cached=${cached})`);

  currentFileUri = uri;

  const deckNameEl = document.getElementById('deckName');
  deckNameEl.textContent = fileName;
  deckNameEl.className = 'file-name restored';
  deckNameEl.style.cursor = 'default';
  deckNameEl.onclick = null;

  // Pass the disk path straight through — loadDeckFromFile reads it by
  // byte-range. The old code fetch→blob→new File()'d the whole file into the JS
  // heap here, then loadDeckFromFile did file.arrayBuffer() — two full ~1 GB
  // copies before parsing even began. That double-copy was the OOM.
  await loadDeckFromFile({ path, size, name: fileName });
}

// Add or update deck in the deck list
async function addDeckToList(deckInfo, useCapacitor) {
  debugLog(`Adding deck to list: ${deckInfo.fileName} (useCapacitor: ${useCapacitor})`);
  
  try {
    let deckList = [];
    
    // Get existing deck list
    if (useCapacitor && window.Capacitor?.Plugins?.Preferences) {
      try {
        const result = await window.Capacitor.Plugins.Preferences.get({ key: 'ankiDeckList' });
        if (result.value) {
          deckList = JSON.parse(result.value);
        }
        debugLog(`Retrieved ${deckList.length} decks from Capacitor preferences`);
      } catch (capacitorError) {
        debugLog(`Failed to get deck list from Capacitor: ${capacitorError.message}`);
        // Fall back to localStorage
        useCapacitor = false;
      }
    }
    
    if (!useCapacitor) {
      const listJson = localStorage.getItem('ankiDeckList');
      if (listJson) {
        deckList = JSON.parse(listJson);
      }
      debugLog(`Retrieved ${deckList.length} decks from localStorage`);
    }
    
    // Remove existing entry for this deck (if any)
    const originalLength = deckList.length;
    deckList = deckList.filter(deck => deck.fileName !== deckInfo.fileName);
    debugLog(`Removed ${originalLength - deckList.length} duplicate entries`);
    
    // Add current deck to the beginning
    deckList.unshift(deckInfo);
    
    // Limit to 25 most recent decks
    deckList = deckList.slice(0, 25);
    
    // Save updated list
    const listJson = JSON.stringify(deckList);
    
    if (useCapacitor && window.Capacitor?.Plugins?.Preferences) {
      try {
        await window.Capacitor.Plugins.Preferences.set({
          key: 'ankiDeckList',
          value: listJson
        });
        debugLog(`✅ Saved deck list to Capacitor with ${deckList.length} decks`);
      } catch (capacitorError) {
        debugLog(`Failed to save to Capacitor: ${capacitorError.message}, falling back to localStorage`);
        localStorage.setItem('ankiDeckList', listJson);
        debugLog(`✅ Saved deck list to localStorage with ${deckList.length} decks`);
      }
    } else {
      localStorage.setItem('ankiDeckList', listJson);
      debugLog(`✅ Saved deck list to localStorage with ${deckList.length} decks`);
    }
    
  } catch (error) {
    debugLog(`❌ Error updating deck list: ${error.message}`);
  }
}

// Enhanced load deck state with detailed debugging
/**
 * Picks the most-recently-opened Title and restores it on launch.
 *   - Deck-based Title → mirrors deck info into legacy CARD_INDEX/FILE_URI/
 *     FILE_NAME prefs so loadDeckState() restores the right deck.
 *     Returns false so the caller still runs loadDeckState().
 *   - Deck-less Title with audiobook + SRT → loads via loadTitleAsSrtCards.
 *     Returns true (don't run legacy restore).
 *   - EPUB-only / audiobook-only Title → sets deckName label; returns false
 *     so the mode views render their empty-state until the user picks.
 */
async function autoRestoreFromTitles() {
  try {
    if (!window.titleStore) return false;
    const titles = await window.titleStore.list();
    if (!titles?.length) return false;
    // Skip any title quarantined after its deck hard-crashed on load — auto-
    // opening it would just re-trigger the crash. The user lifts the
    // quarantine by deliberately opening it from the Library.
    const sorted = titles.slice()
      .filter(t => !(window.isDeckQuarantined && window.isDeckQuarantined(t.id)))
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    let t = sorted[0];
    if (!t) return false;
    // Rebuild audio/SRT cache files from their stored URIs if they were
    // wiped from NSTemporaryDirectory (Xcode rebuild, iOS purge, etc.).
    // Without this the title looks "loaded" but the legacy prefs that get
    // synced below carry dead paths and audiobook playback fails silently.
    if (typeof window.rehydrateTitleCachePaths === 'function') {
      try { t = await window.rehydrateTitleCachePaths(t) || t; } catch (e) {}
    }
    const a = t.attachments || {};
    debugLog(`autoRestoreFromTitles → "${t.name}" (id=${t.id})`);

    const setP = async (k, v) => {
      if (isCapacitorEnvironment() && window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.set({ key: k, value: String(v) });
      } else {
        localStorage.setItem(k, String(v));
      }
    };

    // Deck-based: mirror to legacy keys so loadDeckState restores THIS deck.
    if (a.deck?.uri) {
      await setP(PERSISTENCE_KEYS.FILE_NAME, a.deck.name || t.name);
      await setP(PERSISTENCE_KEYS.FILE_URI,  a.deck.uri);
      const idx = Number.isFinite(t.lastCardIndex) ? t.lastCardIndex
                 : (a.deck.cardIndex || 0);
      await setP(PERSISTENCE_KEYS.CARD_INDEX, String(idx));
      await setP(PERSISTENCE_KEYS.LAST_ACCESSED, String(t.lastOpenedAt || Date.now()));
      window._activeTitleId = t.id;
      // Pre-warm EPUB chunk index in the background after the deck loads.
      // The deck restoration is async and fires from the legacy path; we
      // schedule a delayed prewarm so the heavy SRT parse + map build
      // overlap with idle time.
      if (a.epub && typeof window.prewarmReader === 'function') {
        setTimeout(() => window.prewarmReader(), 1500);
      }
      return false; // legacy path handles the actual load
    }

    // Deck-less with audiobook + SRT → build synthetic cards.
    if (a.audiobook && a.srt && typeof window.loadTitleAsSrtCards === 'function') {
      window._activeTitleId = t.id;
      const ok = await window.loadTitleAsSrtCards(t);
      // Pre-warm the reader in the background. EPUB parse + chunk index
      // takes 1–2 s on a large book; running it now means the first tap
      // on READ doesn't sit on a blank screen waiting for the parse.
      if (a.epub && typeof window.prewarmReader === 'function') {
        setTimeout(() => window.prewarmReader(), 0);
      }
      return !!ok;
    }

    // EPUB-only or audio-only: nothing to "load" at startup beyond labeling.
    // Crucially, RETURN TRUE so the caller does NOT fall through to
    // loadDeckState() — that would restore the legacy saved deck (some
    // OTHER title's cards) into CARD mode even though this title has no
    // deck. Also wipe any cards/audio so CARD mode starts genuinely empty.
    if (a.epub || a.audiobook) {
      const deckEl = document.getElementById('deckName');
      if (deckEl) {
        deckEl.textContent = t.name || 'Untitled';
        deckEl.className = 'file-name restored';
      }
      window._activeTitleId = t.id;
      if (typeof window.clearLoadedCardsAndAudio === 'function') {
        window.clearLoadedCardsAndAudio();
      }
      if (a.epub && typeof window.prewarmReader === 'function') {
        setTimeout(() => window.prewarmReader(), 0);
      }
      return true;
    }
    return false;
  } catch (e) {
    debugLog(`autoRestoreFromTitles failed: ${e?.message || e}`);
    return false;
  }
}

async function loadDeckState() {
  debugLog("Loading deck state...");
  
  try {
    let savedCardIndex, savedFileName, savedStoredPath, savedUri, savedLastAccessed;
    
    if (isCapacitorEnvironment()) {
      debugLog("Using Capacitor Preferences to load state");
      
      try {
        const cardResult = await Preferences.get({ key: PERSISTENCE_KEYS.CARD_INDEX });
        const nameResult = await Preferences.get({ key: PERSISTENCE_KEYS.FILE_NAME });
        const pathResult = await Preferences.get({ key: PERSISTENCE_KEYS.STORED_FILE_PATH });
        const uriResult = await Preferences.get({ key: PERSISTENCE_KEYS.FILE_URI });
        const timeResult = await Preferences.get({ key: PERSISTENCE_KEYS.LAST_ACCESSED });
        
        savedCardIndex = cardResult.value;
        savedFileName = nameResult.value;
        savedStoredPath = pathResult.value;
        savedUri = uriResult.value;
        savedLastAccessed = timeResult.value;
        
        debugLog(`Capacitor state loaded - Card: ${savedCardIndex}, File: ${savedFileName}, Path: ${savedStoredPath}, URI: ${savedUri}, Time: ${savedLastAccessed}`);
      } catch (capacitorError) {
        debugLog(`❌ Error loading from Capacitor: ${capacitorError.message}`);
      }
    } else {
      debugLog("Using localStorage to load state");
      
      // Fallback to localStorage
      savedCardIndex = localStorage.getItem(PERSISTENCE_KEYS.CARD_INDEX);
      savedFileName = localStorage.getItem(PERSISTENCE_KEYS.FILE_NAME);
      savedStoredPath = localStorage.getItem(PERSISTENCE_KEYS.STORED_FILE_PATH);
      savedUri = localStorage.getItem(PERSISTENCE_KEYS.FILE_URI);
      savedLastAccessed = localStorage.getItem(PERSISTENCE_KEYS.LAST_ACCESSED);
      
      debugLog(`localStorage state loaded - Card: ${savedCardIndex}, File: ${savedFileName}, Path: ${savedStoredPath}, URI: ${savedUri}, Time: ${savedLastAccessed}`);
    }
    
    if (savedCardIndex && savedFileName && savedFileName !== 'No file chosen') {
      debugLog(`✅ Found valid saved deck state: ${savedFileName}, card ${savedCardIndex}`);
      
      // Update UI to show last deck info
      const deckNameEl = document.getElementById('deckName');
      deckNameEl.textContent = `${savedFileName} (Auto-restoring...)`;
      deckNameEl.className = 'file-name restoring';
      deckNameEl.style.cursor = 'pointer';
      
      // Store the card index to restore after file is selected
      window.pendingCardIndex = parseInt(savedCardIndex);
      debugLog(`Set pending card index to: ${window.pendingCardIndex}`);
      
      // Try to auto-restore the file
      debugLog("Attempting auto-restore...");
      const restored = await tryAutoRestoreFile(savedStoredPath, savedFileName);
      
      if (!restored) {
        debugLog("Auto-restore failed, setting up manual restore");
        // Set up manual restore
        deckNameEl.textContent = `${savedFileName} (Tap to reopen)`;
        deckNameEl.className = 'file-name restoration-failed';
        deckNameEl.onclick = async () => {
          debugLog("User clicked to manually restore file");
          openFilePicker();
        };
        
        showToast(`💾 Last deck: ${savedFileName}. Tap filename to reopen and continue from card ${parseInt(savedCardIndex) + 1}.`, 5000);
      }
      
      return restored;
    } else {
      debugLog("No valid saved deck state found");
      return false;
    }
  } catch (error) {
    debugLog(`❌ Error loading deck state: ${error.message}`);
    return false;
  }
}

// Clear saved deck state
async function clearDeckState() {
  debugLog("Clearing deck state...");
  
  try {
    if (isCapacitorEnvironment()) {
      await Preferences.remove({ key: PERSISTENCE_KEYS.CARD_INDEX });
      await Preferences.remove({ key: PERSISTENCE_KEYS.FILE_NAME });
      await Preferences.remove({ key: PERSISTENCE_KEYS.STORED_FILE_PATH });
      await Preferences.remove({ key: PERSISTENCE_KEYS.FILE_URI });
      await Preferences.remove({ key: PERSISTENCE_KEYS.LAST_ACCESSED });
      // Note: We don't clear the deck list as that should persist
    } else {
      localStorage.removeItem(PERSISTENCE_KEYS.CARD_INDEX);
      localStorage.removeItem(PERSISTENCE_KEYS.FILE_NAME);
      localStorage.removeItem(PERSISTENCE_KEYS.STORED_FILE_PATH);
      localStorage.removeItem(PERSISTENCE_KEYS.FILE_URI);
      localStorage.removeItem(PERSISTENCE_KEYS.LAST_ACCESSED);
      // Note: We don't clear the deck list as that should persist
    }
    debugLog('✅ Cleared deck state');
  } catch (error) {
    debugLog(`❌ Error clearing deck state: ${error.message}`);
  }
}

// Enhanced auto-restore function with extensive debugging
async function tryAutoRestoreFile(maybeUri, savedFileName) {
  debugLog(`🔄 Auto-restore attempt: file="${savedFileName}", arg="${maybeUri}"`);

  if (!savedFileName) {
    debugLog("❌ No saved file name provided");
    return false;
  }
  if (!isCapacitorEnvironment()) {
    debugLog("🌐 Web environment - cannot auto-restore");
    return false;
  }
  if (!window.Capacitor?.Plugins?.FileAccess) {
    debugLog("❌ FileAccess plugin not available - cannot auto-restore");
    return false;
  }

  // Caller may pass the URI directly; otherwise pull it from Preferences.
  // Accept any scheme — Android documents arrive as `content://`, iOS
  // document-picker URIs as `file://`, and both flow through the
  // FileAccess plugin's bookmark store. The prior check filtered out
  // anything that wasn't `content://`, which silently nulled out every
  // iOS URI and dropped us into the "please select manually" fallback.
  let savedUri = (typeof maybeUri === 'string' && /^[a-z][a-z0-9+.\-]*:\/\//i.test(maybeUri))
    ? maybeUri : null;
  if (!savedUri) {
    try {
      const uriResult = await Preferences.get({ key: PERSISTENCE_KEYS.FILE_URI });
      savedUri = uriResult.value;
    } catch (e) {
      debugLog(`Could not read saved URI from Preferences: ${e.message}`);
    }
  }

  if (!savedUri) {
    debugLog("❌ No saved URI to restore from");
    return false;
  }

  // Confirm we still hold a persistable read grant on this URI.
  try {
    const { uris } = await window.Capacitor.Plugins.FileAccess.getPersistedUriPermissions();
    if (!uris.includes(savedUri)) {
      debugLog(`⚠️ No persisted permission for ${savedUri}; cleaning up`);
      await Preferences.remove({ key: PERSISTENCE_KEYS.FILE_URI });
      return false;
    }
  } catch (e) {
    debugLog(`getPersistedUriPermissions failed: ${e.message}`);
    return false;
  }

  try {
    await loadDeckFromUri(savedUri, savedFileName);
    showToast(`Auto-restored: ${savedFileName}`, 2000);
    return true;
  } catch (e) {
    debugLog(`❌ loadDeckFromUri failed: ${e.message}`);
    // URI grant exists but read still failed — keep the URI; next attempt may succeed.
    return false;
  }
}

// Make this function globally available for library
window.tryAutoRestoreFile = tryAutoRestoreFile;

// Enhanced file input handler
async function setupFileInputWithUriCapture() {
  debugLog("Setting up file input with URI capture");
  
  const fileInput = document.getElementById('apkgFile');
  
  // Enhanced change handler
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) {
      debugLog("No file selected");
      return;
    }

    debugLog(`File selected via HTML input fallback: ${file.name} (${file.size} bytes)`);

    // Clear any previous restoration UI state
    const deckNameEl = document.getElementById('deckName');
    deckNameEl.className = 'file-name';
    deckNameEl.style.cursor = 'default';
    deckNameEl.onclick = null;

    await loadDeckFromFile(file);
  });
}

// Store file in app's private directory with better memory management
async function storeFileForPersistence(file) {
  if (!isCapacitorEnvironment()) {
    debugLog("Cannot store file - not in Capacitor environment");
    return null;
  }
  
  // Skip storage for very large files to prevent crashes
  const maxFileSize = 100 * 1024 * 1024; // 100MB limit
  if (file.size > maxFileSize) {
    debugLog(`File too large for storage (${Math.round(file.size / 1024 / 1024)}MB > ${Math.round(maxFileSize / 1024 / 1024)}MB)`);
    return null;
  }
  
  try {
    debugLog(`📁 Starting file storage for persistence: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB)`);
    
    // Process file in chunks to avoid memory issues
    const chunkSize = 1024 * 1024; // 1MB chunks
    const chunks = [];
    
    for (let start = 0; start < file.size; start += chunkSize) {
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      const arrayBuffer = await chunk.arrayBuffer();
      chunks.push(new Uint8Array(arrayBuffer));
      
      // Small delay to prevent blocking the UI
      if (chunks.length % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
        debugLog(`Processed ${Math.round((end / file.size) * 100)}% of file...`);
      }
    }
    
    // Combine chunks
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Convert to base64
    debugLog("Converting to base64...");
    const base64Data = btoa(String.fromCharCode(...combined));
    
    // Generate a safe filename with timestamp to avoid conflicts
    const timestamp = Date.now();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `anki_decks/${timestamp}_${safeFileName}`;
    
    // Try different directories to find one that works
    const directories = [
      { name: 'Documents', dir: window.Capacitor.Plugins.Filesystem.Directory.Documents },
      { name: 'Data', dir: window.Capacitor.Plugins.Filesystem.Directory.Data },
      { name: 'Cache', dir: window.Capacitor.Plugins.Filesystem.Directory.Cache }
    ];
    
    let successPath = null;
    
    for (const { name, dir } of directories) {
      try {
        debugLog(`Trying to store in ${name} directory...`);
        
        // Write file to directory
        await window.Capacitor.Plugins.Filesystem.writeFile({
          path: filePath,
          data: base64Data,
          directory: dir,
          recursive: true
        });
        
        // Test that we can read it back
        await window.Capacitor.Plugins.Filesystem.stat({
          path: filePath,
          directory: dir
        });
        
        successPath = filePath;
        debugLog(`✅ Successfully stored file in ${name}: ${filePath}`);
        
        // Save the successful directory for later use
        await window.Capacitor.Plugins.Preferences.set({
          key: `${PERSISTENCE_KEYS.STORED_FILE_PATH}_DIR`,
          value: name
        });
        
        break;
        
      } catch (dirError) {
        debugLog(`❌ Failed to store in ${name}: ${dirError.message}`);
      }
    }
    
    if (successPath) {
      // Save the path to preferences
      await window.Capacitor.Plugins.Preferences.set({
        key: PERSISTENCE_KEYS.STORED_FILE_PATH,
        value: successPath
      });
      
      currentStoredPath = successPath;
      return successPath;
    } else {
      debugLog("❌ Failed to store file in any directory");
      return null;
    }
    
  } catch (error) {
    debugLog(`❌ Error storing file for persistence: ${error.message}`);
    return null;
  }
}

// Read file from app's private directory
async function readStoredFile(filePath, fileName) {
  if (!isCapacitorEnvironment() || !filePath) {
    debugLog("Cannot read stored file - invalid environment or path");
    return null;
  }
  
  try {
    debugLog(`📖 Reading stored file: ${filePath}`);
    
    // Get the directory that was used for storing
    let storedDir = window.Capacitor.Plugins.Filesystem.Directory.Documents; // default
    
    try {
      const dirResult = await window.Capacitor.Plugins.Preferences.get({ 
        key: `${PERSISTENCE_KEYS.STORED_FILE_PATH}_DIR` 
      });
      if (dirResult.value) {
        storedDir = window.Capacitor.Plugins.Filesystem.Directory[dirResult.value];
        debugLog(`Using stored directory: ${dirResult.value}`);
      }
    } catch (dirError) {
      debugLog(`Could not get stored directory, using Documents: ${dirError.message}`);
    }
    
    // Try the stored directory first
    try {
      const fileData = await window.Capacitor.Plugins.Filesystem.readFile({
        path: filePath,
        directory: storedDir
      });
      
      if (fileData && fileData.data) {
        debugLog("✅ Successfully read stored file data");
        // Convert base64 back to File object
        const arrayBuffer = Uint8Array.from(atob(fileData.data), c => c.charCodeAt(0)).buffer;
        return new File([arrayBuffer], fileName, { type: 'application/zip' });
      }
    } catch (primaryError) {
      debugLog(`Failed to read from primary directory: ${primaryError.message}`);
      
      // Try other directories as fallback
      const directories = [
        { name: 'Documents', dir: window.Capacitor.Plugins.Filesystem.Directory.Documents },
        { name: 'Data', dir: window.Capacitor.Plugins.Filesystem.Directory.Data },
        { name: 'Cache', dir: window.Capacitor.Plugins.Filesystem.Directory.Cache }
      ];
      
      for (const { name, dir } of directories) {
        if (dir === storedDir) continue; // Skip the one we already tried
        
        try {
          debugLog(`Trying to read from ${name} directory...`);
          const fileData = await window.Capacitor.Plugins.Filesystem.readFile({
            path: filePath,
            directory: dir
          });
          
          if (fileData && fileData.data) {
            debugLog(`✅ Successfully read from ${name} directory`);
            const arrayBuffer = Uint8Array.from(atob(fileData.data), c => c.charCodeAt(0)).buffer;
            return new File([arrayBuffer], fileName, { type: 'application/zip' });
          }
        } catch (dirError) {
          debugLog(`❌ Failed to read from ${name}: ${dirError.message}`);
        }
      }
    }
    
    debugLog("❌ Could not read file from any directory");
    
  } catch (error) {
    debugLog(`❌ Error reading stored file: ${error.message}`);
  }
  
  return null;
}

// Simple file picker with validation test.
// On Capacitor + FileAccess: uses the native picker, which grants persistable URI permission.
// Falls back to the HTML file input on web or if the plugin call fails.
async function openFilePicker() {
  debugLog("🔄 Opening file picker...");
  debugLog(`Current validation state: pendingCardIndex=${window.pendingCardIndex}, expectedDeckName="${window.expectedDeckName}"`);

  if (isCapacitorEnvironment() && window.Capacitor?.Plugins?.FileAccess) {
    try {
      const { uri, name } = await window.Capacitor.Plugins.FileAccess.pickFileWithUri();
      debugLog(`Picker returned uri=${uri} name=${name}`);
      await loadDeckFromUri(uri, name);
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes('cancel')) {
        debugLog('User cancelled the picker');
        return;
      }
      debugLog(`⚠️ Native picker failed (${msg}); falling back to HTML input`);
      // fall through
    }
  }

  document.getElementById('apkgFile').click();
}

// Show toast notification
function showToast(message, duration = 3000) {
  debugLog(`Toast: ${message}`);
  
  // Remove existing toast if any
  const existingToast = document.getElementById('toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.textContent = message;
  // Dictionary-popup aesthetic: dark, slightly-shaded, blurred panel with a
  // subtle neutral border (no green/cyan accent), centered above all chrome.
  //   - z-index 9500 puts toasts above the header (3500), the shell menus
  //     (3600), the dict popup, etc. (cue-alignment overlay is 99999).
  //   - Animates in/out by transitioning opacity + a small lift/scale, so it
  //     fades smoothly instead of snapping in and vanishing.
  toast.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, calc(-50% + 8px)) scale(0.96);
    background: rgba(24, 24, 27, 0.94);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    color: #f1f1f3;
    padding: 13px 20px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.45;
    font-weight: 500;
    z-index: 9500;
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
    max-width: 80%;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 180ms ease-out, transform 180ms ease-out;
  `;

  document.body.appendChild(toast);

  // Enter on the next frame so the transition animates from the initial state.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, -50%) scale(1)';
  });

  const EXIT_MS = 200;
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, calc(-50% + 8px)) scale(0.96)';
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, EXIT_MS);
  }, Math.max(0, duration));
}

// Update card index and save state
function updateCardIndex(newIndex) {
  if (newIndex >= 0 && newIndex < allNotes.length && newIndex !== currentCardIndex) {
    debugLog(`Updating card index from ${currentCardIndex} to ${newIndex}`);
    // A genuine card navigation (swipe / keyboard / number-jump / auto-advance)
    // lifts the open/restart auto-play suppression, so this card and the ones
    // after it play normally. The INITIAL card on open/restart sets
    // currentCardIndex DIRECTLY + displayCard() (NOT through this function), so
    // it stays silent — which is the "stop the card auto-playing on open" fix.
    window.startupAutoPlayBlocked = false;
    currentCardIndex = newIndex;
    window.currentCardIndex = currentCardIndex;
    // Tell the reader so its cached cursor stays in sync. Otherwise a
    // later tab switch into READ could land on the prior reader position
    // (e.g., 96% from a previous progress-bar tap) instead of the chunk
    // matching the new card.
    if (typeof window.notifyCardIndexChanged === 'function') {
      try { window.notifyCardIndexChanged(newIndex); } catch (e) {}
    }
    // Refresh the top-left progress strip so card-mode swipes track
    // playhead position. SRT-cards titles map currentCardIndex 1:1
    // to cue index, so this just hands the index straight to the
    // paged reader's progress updater. Deck-card titles don't have a
    // clean card→cue mapping; we skip them (audio-driven cue updates
    // still drive the strip when audio is playing).
    if (Array.isArray(allNotes) && allNotes[0]?.isSrtCard &&
        typeof window.pagedUpdateProgressForCue === 'function') {
      try { window.pagedUpdateProgressForCue(newIndex); } catch (_) {}
    }

    // Save state whenever card changes
    saveDeckState();
    // Persist per-title card index for SRT-cards titles too.
    if (window._activeTitleId && window.titleStore?.setCardIndex) {
      window.titleStore.setCardIndex(window._activeTitleId, newIndex).catch(() => {});
    }
    // Stats: a card advance counts toward the card-mode counter (even if
    // it came from a swipe in card mode or a cross-mode sync). Also count
    // characters from the NEW card's expression so chars/hr reflects real
    // reading throughput, not just card flips.
    if (window.stats?.incrementCardCount) window.stats.incrementCardCount();
    if (window.stats?.incrementCardChars) {
      const newCard = allNotes[newIndex];
      const txt = newCard?.expression || '';
      // expression is HTML — count JP-only chars (strips markup + furigana) so
      // the card counter is the same unit as the read / audio counters.
      if (txt) window.stats.incrementCardChars(
        window.jpCharCountHtml ? window.jpCharCountHtml(txt) : txt.length);
    }

    displayCard();
    updateProgressBar();
  }
}

function startStopwatch() {
  if (stopwatchInterval) return;

  stopwatchInterval = setInterval(() => {
    const now = Date.now();
    if (now - lastInteractionTime >= stopwatchTimeout * 1000) {
      clearInterval(stopwatchInterval);
      stopwatchInterval = null;
      return;
    }

    stopwatchSeconds++;
    document.getElementById("stopwatch").textContent = `${stopwatchSeconds}s`;
  }, 1000);
}

function trackNoteView(index) {
  const id = allNotes[index]?.id || index;
  if (!viewedNotes.has(id)) {
    viewedNotes.add(id);
    updateNoteCounter();
  }
}

function updateNoteCounter() {
  document.getElementById("noteCounter").textContent = ` ${viewedNotes.size} notes`;
}

function resetNoteCounter() {
  viewedNotes.clear();
  updateNoteCounter();
}

function resetStopwatch() {
  stopwatchSeconds = 0;
  document.getElementById("stopwatch").textContent = `0s`;
  lastInteractionTime = Date.now();
}

// Read a file at an absolute cache path and return its bytes as a data URI.
// Capacitor's Filesystem.readFile is finicky about absolute paths and has
// returned empty for our slice files; fetching via the WebView's local
// server (convertFileSrc → http://localhost) is reliable for any path.
window.cacheFileToDataUri = async function (absPath, mime) {
  if (!absPath) return '';
  try {
    const url = window.Capacitor?.convertFileSrc
      ? window.Capacitor.convertFileSrc(absPath)
      : 'file://' + absPath;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[cacheFileToDataUri] fetch ' + url + ' → ' + res.status);
      return '';
    }
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        let s = fr.result;
        if (mime && typeof s === 'string') {
          // Force the supplied MIME so Anki recognizes the format.
          s = s.replace(/^data:[^;]+;/, 'data:' + mime + ';');
        }
        resolve(s || '');
      };
      fr.onerror = () => { console.warn('[cacheFileToDataUri] read failed'); resolve(''); };
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[cacheFileToDataUri] ' + (e?.message || e));
    return '';
  }
};

function fmtMmSs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–:––';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function _currentShellMode() {
  if (document.body.classList.contains('mode-audio')) return 'audio';
  if (document.body.classList.contains('mode-read'))  return 'read';
  return 'card';
}

// Mode-aware bottom bar refresh. Card: N/M; Read: chars + %; Audio: time.
function updateProgressBar() {
  const bar = document.getElementById("progressFill");
  const label = document.getElementById("progressLabel");
  if (!bar || !label) return;

  const mode = _currentShellMode();
  if (mode === 'read' && typeof window.getReadProgress === 'function') {
    const p = window.getReadProgress();
    bar.style.width = (p.pct || 0).toFixed(2) + '%';
    label.textContent = p.total
      ? `${p.current.toLocaleString()} / ${p.total.toLocaleString()} chars · ${p.pct.toFixed(1)}%`
      : 'Open an EPUB';
    return;
  }
  if (mode === 'audio' && typeof window.getAudioProgress === 'function') {
    const a = window.getAudioProgress();
    bar.style.width = (a.pct || 0).toFixed(2) + '%';
    label.textContent = a.dur
      ? `${fmtHms(a.ms)} / ${fmtHms(a.dur)}`
      : '— / —';
    return;
  }
  // Card mode (default).
  const total = allNotes.length;
  const current = currentCardIndex + 1;
  const percent = total ? (current / total) * 100 : 0;
  bar.style.width = percent + "%";
  if (!isLoadingComplete && total < totalNotesExpected) {
    label.textContent = `${current} / ${total} (Loading...)`;
  } else {
    label.textContent = total ? `${current} / ${total}` : 'Select a deck';
  }
}

function showLoadingProgress() {
  const progressEl = document.getElementById("progressLabel");
  if (progressEl && !isLoadingComplete) {
    const percent = totalNotesExpected > 0 ? Math.round((notesProcessed / totalNotesExpected) * 100) : 0;
    progressEl.textContent = `Loading: ${percent}% (${notesProcessed}/${totalNotesExpected})`;
  }
}

// Copy the current card's expression/text to the clipboard. Wired to the
// card-mode COPY button. Brief visual confirmation.
window.copyCurrentCardText = function () {
  const card = allNotes?.[currentCardIndex];
  if (!card) return;
  const text = (card.expression || '').trim();
  if (!text) return;
  const btn = document.getElementById('cardCopyBtn');
  const restore = btn ? btn.textContent : null;
  const flash = (msg) => { if (btn) { btn.textContent = msg; setTimeout(() => { if (btn) btn.textContent = restore || 'COPY'; }, 900); } };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => flash('COPIED')).catch(() => flash('FAILED'));
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      flash('COPIED');
    } catch (e) { flash('FAILED'); }
  }
};

// Bottom-bar tap handler. In audio mode this opens a slider modal so
// the user picks a target with a draggable handle (then taps Go) — much
// safer than jumping to wherever the finger first lands. Card/read keep
// the value prompt (precise input).
window.onProgressBarTap = function (e) {
  const mode = _currentShellMode();
  if (mode === 'audio') {
    // Direct seek in audiobook removed 2026-05-30 — too easy to
    // accidentally lose your spot. Audiobook position can only be
    // moved via the card/read modes (their dialogs handle the
    // jump cleanly via "Jump to audiobook position"). Show a
    // simple info modal explaining this.
    _showAudioSeekRedirectInfo();
    return;
  }
  if (mode === 'read') {
    // READ mode: percent/character jump (works for EPUB-only titles too,
    // which have no cards). Falls back to the card jump only if the paged
    // reader's modal isn't available.
    if (typeof window.pagedOpenJumpModal === 'function') { window.pagedOpenJumpModal(); return; }
  }
  promptCardJump();
};

function _showAudioSeekRedirectInfo() {
  const old = document.getElementById('audioSeekInfoModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'audioSeekInfoModal';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.72);
    display:flex; align-items:center; justify-content:center;
    z-index:9700; padding:20px; box-sizing:border-box;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    background:#161616; border:1px solid #303030; border-radius:14px;
    padding:24px; max-width:380px; width:100%;
    box-shadow:0 16px 40px rgba(0,0,0,0.6);
    color:#e8e8e8; text-align:center;
    font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",system-ui,sans-serif;
  `;
  panel.innerHTML = `
    <h3 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:var(--accent-audio,#b794f6);letter-spacing:0.04em;">CHANGE PLAYHEAD</h3>
    <p style="margin:0 0 18px 0;font-size:14px;color:#bbb;line-height:1.5;">
      Please change playhead position in Card or Read modes only.
    </p>
    <button id="audioSeekInfoOk" style="background:var(--accent-audio,#b794f6);color:#0a0a0a;border:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:0.04em;">OK</button>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  panel.querySelector('#audioSeekInfoOk').addEventListener('click', close);
}

function openAudioSeekDialog() {
  if (typeof window.getAudioProgress !== 'function') return;
  const a = window.getAudioProgress();
  if (!a.dur) return;
  // Build a one-shot modal with a slider + Go/Cancel.
  const existing = document.getElementById('audioSeekModal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'audioSeekModal';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.82);
    display:flex; align-items:center; justify-content:center;
    z-index:3200; touch-action:none; padding:20px; box-sizing:border-box;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    background:var(--bg,#0c0c0c); border:1px solid var(--border,#2a2a2a);
    border-radius:14px; width:100%; max-width:520px;
    padding:22px;
    box-shadow:0 16px 40px rgba(0,0,0,0.6);
  `;
  panel.innerHTML = `
    <div class="label-cap" style="text-align:center;margin-bottom:10px;color:var(--text,#e8e8e8);">Seek</div>
    <div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:.95rem;color:var(--accent-audio);margin-bottom:8px;">
      <span data-role="cur">${fmtHms(a.ms)}</span>
      <span style="color:#666;">${fmtHms(a.dur)}</span>
    </div>
    <input data-role="slider" type="range" min="0" max="${Math.round(a.dur)}" step="500" value="${Math.round(a.ms)}"
           style="width:100%;accent-color:var(--accent-audio);height:36px;">
    <div style="display:flex;gap:10px;margin-top:12px;justify-content:flex-end;">
      <button data-role="cancel" class="btn">Cancel</button>
      <button data-role="go" class="btn btn-primary">Go</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const slider = panel.querySelector('[data-role="slider"]');
  const cur = panel.querySelector('[data-role="cur"]');
  slider.addEventListener('input', () => { cur.textContent = fmtHms(parseInt(slider.value)); });
  const close = () => overlay.remove();
  panel.querySelector('[data-role="cancel"]').addEventListener('click', close);
  panel.querySelector('[data-role="go"]').addEventListener('click', () => {
    const ms = parseInt(slider.value);
    if (Number.isFinite(ms) && typeof window.jumpAudioToMs === 'function') window.jumpAudioToMs(ms);
    close();
  });
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
}

// Playback rate state model.
//
//   _playbackRates.global = single rate used when per-mode is off
//   _playbackRates.card / .read / .audio = per-mode rates when on
//   _playbackPerMode      = boolean flag
//
// window.audioPlaybackRate is the LIVE rate that downstream callers
// (bg.play({rate}), <audio>.playbackRate, etc.) read. It's updated
// whenever the speed changes OR the mode changes — so a single
// global setting is enough at the call sites.
window._playbackRates = window._playbackRates || {
  global: 1.0, card: 1.0, read: 1.0, audio: 1.0
};
window._playbackPerMode = !!window._playbackPerMode;

function _currentModeForSpeed() {
  const b = document.body;
  if (b.classList.contains('mode-audio')) return 'audio';
  if (b.classList.contains('mode-read'))  return 'read';
  return 'card';
}

window.getActivePlaybackRate = function () {
  if (window._playbackPerMode) {
    return window._playbackRates[_currentModeForSpeed()] || 1.0;
  }
  return window._playbackRates.global || 1.0;
};

// Apply the active rate to live playback engines AND mirror to
// window.audioPlaybackRate so existing call sites that read that
// variable see the right value.
window.applyActivePlaybackRate = async function () {
  const r = window.getActivePlaybackRate();
  window.audioPlaybackRate = r;
  try {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg?.setRate) await bg.setRate({ rate: r });
  } catch (_) {}
  try { if (currentAudio) currentAudio.playbackRate = r; } catch (_) {}
};

// Persist all four rate slots + the per-mode flag.
async function _persistPlaybackRates() {
  const obj = {
    perMode: !!window._playbackPerMode,
    global: window._playbackRates.global,
    card:   window._playbackRates.card,
    read:   window._playbackRates.read,
    audio:  window._playbackRates.audio
  };
  try {
    const blob = JSON.stringify(obj);
    if (window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key: 'PLAYBACK_RATES_V1', value: blob });
    } else {
      localStorage.setItem('PLAYBACK_RATES_V1', blob);
    }
    // Mirror to the legacy AUDIO_SPEED key so any code still reading
    // it picks up the current effective rate.
    const eff = window.getActivePlaybackRate();
    if (window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key: 'AUDIO_SPEED', value: String(eff) });
    } else {
      localStorage.setItem('AUDIO_SPEED', String(eff));
    }
  } catch (_) {}
}

async function _restorePlaybackRates() {
  try {
    let raw = null;
    if (window.Capacitor?.Plugins?.Preferences) {
      const r = await window.Capacitor.Plugins.Preferences.get({ key: 'PLAYBACK_RATES_V1' });
      raw = r.value;
    } else {
      raw = localStorage.getItem('PLAYBACK_RATES_V1');
    }
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj) {
        window._playbackPerMode = !!obj.perMode;
        if (Number.isFinite(obj.global)) window._playbackRates.global = obj.global;
        if (Number.isFinite(obj.card))   window._playbackRates.card   = obj.card;
        if (Number.isFinite(obj.read))   window._playbackRates.read   = obj.read;
        if (Number.isFinite(obj.audio))  window._playbackRates.audio  = obj.audio;
      }
    } else {
      // Legacy fallback: AUDIO_SPEED single value.
      let legacy = null;
      if (window.Capacitor?.Plugins?.Preferences) {
        const r = await window.Capacitor.Plugins.Preferences.get({ key: 'AUDIO_SPEED' });
        legacy = parseFloat(r.value);
      } else {
        legacy = parseFloat(localStorage.getItem('AUDIO_SPEED'));
      }
      if (Number.isFinite(legacy) && legacy > 0) {
        window._playbackRates.global = legacy;
        window._playbackRates.card = legacy;
        window._playbackRates.read = legacy;
        window._playbackRates.audio = legacy;
      }
    }
  } catch (_) {}
  await window.applyActivePlaybackRate();
}
_restorePlaybackRates();

// Refresh the active rate whenever the shell mode changes — for
// per-mode this swaps in the new rate.
window.addEventListener('shell:mode-change', () => {
  try { window.applyActivePlaybackRate(); } catch (_) {}
});

// Back-compat shim. The old single-setter used to write AUDIO_SPEED;
// new flow uses _playbackRates.global. Routes through the new state
// so old call sites stay correct.
window.setGlobalPlaybackRate = async function (rate) {
  const r = Math.max(0.25, Math.min(3.0, parseFloat(rate) || 1));
  window._playbackRates.global = r;
  if (!window._playbackPerMode) {
    // When per-mode is OFF, the single global rate is what's used.
    // Also normalize the per-mode slots so flipping per-mode ON later
    // doesn't reveal stale values.
    window._playbackRates.card = r;
    window._playbackRates.read = r;
    window._playbackRates.audio = r;
  }
  await window.applyActivePlaybackRate();
  await _persistPlaybackRates();
};

// Legacy slider handler (the bottom audiobook speed slider was
// removed 2026-05-30, but kept here for any reference that survived
// the DOM cleanup).
window.onAudiobookSpeedInput = function (v) {
  const r = parseFloat(v) || 1;
  if (window._speedDebounce) clearTimeout(window._speedDebounce);
  window._speedDebounce = setTimeout(() => window.setGlobalPlaybackRate(r), 80);
};

// ===================== PLAYBACK SPEED DIALOG =====================
//
// Opened from the MORE menu. Shows either a single global +/- card
// or three per-mode cards (color-coded) when "per mode" is checked.
window.openPlaybackSpeedDialog = function () {
  // Clean up any prior instance.
  const old = document.getElementById('playbackSpeedModal');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'playbackSpeedModal';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.78);
    display:flex; align-items:center; justify-content:center;
    z-index:9700; padding:20px; box-sizing:border-box;
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const panel = document.createElement('div');
  panel.style.cssText = `
    background:#161616; border:1px solid #303030; border-radius:14px;
    padding:22px; max-width:420px; width:100%;
    box-shadow:0 16px 40px rgba(0,0,0,0.6);
    color:#e8e8e8;
    font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",system-ui,sans-serif;
  `;

  const STEP = 0.05;
  const MIN = 0.5, MAX = 3.0;

  // One row factory: title + −/+ buttons + 1.0× preset + current value
  // display. Accent color tints the value + the 1.0× preset chip.
  function mkRow(label, accent, getter, setter) {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex; align-items:center; gap:10px;
      padding:14px 0; border-bottom:1px solid #2a2a2a;
    `;
    const lab = document.createElement('div');
    lab.textContent = label;
    lab.style.cssText = `
      flex:0 0 auto; min-width:60px; font-weight:600; font-size:14px;
      color:${accent};
      letter-spacing:0.04em;
    `;
    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.style.cssText = `
      width:42px; height:42px; border-radius:10px;
      background:#222; color:#fff; border:1px solid #3a3a3a;
      font-size:20px; font-weight:600; cursor:pointer;
    `;
    const valDisplay = document.createElement('div');
    valDisplay.style.cssText = `
      flex:1; text-align:center;
      font-family:var(--font-mono,monospace);
      font-size:18px; font-weight:600;
      color:${accent}; font-variant-numeric:tabular-nums;
    `;
    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.style.cssText = minus.style.cssText.replace('−', '+');
    const reset = document.createElement('button');
    reset.textContent = '1.0×';
    reset.style.cssText = `
      flex:0 0 auto;
      padding:0 12px; height:42px; border-radius:10px;
      background:transparent; color:${accent};
      border:1px solid ${accent};
      font-size:13px; font-weight:600; cursor:pointer;
      letter-spacing:0.04em;
    `;

    const render = () => { valDisplay.textContent = getter().toFixed(2) + '×'; };
    render();
    const clamp = (r) => Math.max(MIN, Math.min(MAX, Math.round(r / STEP) * STEP));
    minus.addEventListener('click', async () => { setter(clamp(getter() - STEP)); render(); await window.applyActivePlaybackRate?.(); await _persistPlaybackRates(); });
    plus.addEventListener('click',  async () => { setter(clamp(getter() + STEP)); render(); await window.applyActivePlaybackRate?.(); await _persistPlaybackRates(); });
    reset.addEventListener('click', async () => { setter(1.0); render(); await window.applyActivePlaybackRate?.(); await _persistPlaybackRates(); });

    row.appendChild(lab);
    row.appendChild(minus);
    row.appendChild(valDisplay);
    row.appendChild(plus);
    row.appendChild(reset);
    return { row, refresh: render };
  }

  const body = document.createElement('div');
  body.style.cssText = `margin-bottom:16px;`;

  const header = document.createElement('h3');
  header.textContent = 'Playback Speed';
  header.style.cssText = `
    margin:0 0 4px 0; font-size:16px; font-weight:600;
    letter-spacing:0.02em;
  `;
  const sub = document.createElement('p');
  sub.style.cssText = `margin:0 0 12px 0; font-size:12px; color:#888;`;
  body.appendChild(header);
  body.appendChild(sub);

  // Re-render rows based on per-mode state.
  const rowsContainer = document.createElement('div');
  body.appendChild(rowsContainer);

  function renderRows() {
    rowsContainer.innerHTML = '';
    if (window._playbackPerMode) {
      sub.textContent = 'Per-mode speed enabled. Each mode keeps its own rate.';
      const cardRow = mkRow('CARD',  'var(--accent-card, #ff9550)',
        () => window._playbackRates.card,
        (v) => { window._playbackRates.card = v; });
      const readRow = mkRow('READ',  'var(--accent-read, #4caf50)',
        () => window._playbackRates.read,
        (v) => { window._playbackRates.read = v; });
      const audioRow = mkRow('AUDIO', 'var(--accent-audio, #b794f6)',
        () => window._playbackRates.audio,
        (v) => { window._playbackRates.audio = v; });
      rowsContainer.appendChild(cardRow.row);
      rowsContainer.appendChild(readRow.row);
      rowsContainer.appendChild(audioRow.row);
    } else {
      sub.textContent = 'Applies to all three modes (card, read, audio).';
      const globalRow = mkRow('SPEED', '#00ffcc',
        () => window._playbackRates.global,
        (v) => {
          window._playbackRates.global = v;
          // Also keep per-mode slots aligned so flipping per-mode ON
          // later starts from the same baseline.
          window._playbackRates.card = v;
          window._playbackRates.read = v;
          window._playbackRates.audio = v;
        });
      rowsContainer.appendChild(globalRow.row);
    }
  }
  renderRows();

  // "Per mode" checkbox.
  const checkRow = document.createElement('label');
  checkRow.style.cssText = `
    display:flex; align-items:center; gap:10px;
    padding-top:14px; cursor:pointer;
    font-size:13px; color:#bbb;
  `;
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = !!window._playbackPerMode;
  check.style.cssText = `width:18px; height:18px; cursor:pointer;`;
  const checkLab = document.createElement('span');
  checkLab.textContent = 'Playback speed per mode';
  checkRow.appendChild(check);
  checkRow.appendChild(checkLab);
  check.addEventListener('change', async () => {
    window._playbackPerMode = !!check.checked;
    renderRows();
    await window.applyActivePlaybackRate?.();
    await _persistPlaybackRates();
  });

  // Close row.
  const closeRow = document.createElement('div');
  closeRow.style.cssText = `display:flex; justify-content:flex-end; margin-top:16px;`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = `
    background:#2a2a2a; color:#fff; border:1px solid #3a3a3a;
    padding:8px 16px; border-radius:8px;
    font-size:14px; cursor:pointer;
  `;
  closeBtn.addEventListener('click', () => overlay.remove());
  closeRow.appendChild(closeBtn);

  panel.appendChild(body);
  panel.appendChild(checkRow);
  panel.appendChild(closeRow);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
};

// H:MM:SS (drops the hour segment when < 1 h so short clips read nicely).
function fmtHms(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–:––';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

// Mode-aware jump prompt. Used by the unified bottom bar.
function promptCardJump() {
  const mode = _currentShellMode();
  if (mode === 'read' && typeof window.getReadProgress === 'function') {
    const p = window.getReadProgress();
    if (!p.total) return;
    const input = prompt(
      `Jump to character (0–${p.total.toLocaleString()}) or % (e.g. "75%"):`,
      p.current.toString()
    );
    if (input == null) return;
    let target;
    const trimmed = input.trim();
    if (trimmed.endsWith('%')) {
      const pct = parseFloat(trimmed.replace('%', ''));
      if (!Number.isFinite(pct)) return;
      target = Math.round(p.total * pct / 100);
    } else {
      target = parseInt(trimmed.replace(/,/g, ''));
    }
    if (Number.isFinite(target) && typeof window.jumpReadingToChars === 'function') {
      window.jumpReadingToChars(target);
    }
    return;
  }
  if (mode === 'audio' && typeof window.getAudioProgress === 'function') {
    const a = window.getAudioProgress();
    if (!a.dur) return;
    const input = prompt(
      `Jump to time. mm:ss, seconds, or % (current ${fmtMmSs(a.ms)} / ${fmtMmSs(a.dur)}):`,
      fmtMmSs(a.ms)
    );
    if (input == null) return;
    const trimmed = input.trim();
    let targetMs;
    if (trimmed.endsWith('%')) {
      const pct = parseFloat(trimmed.replace('%', ''));
      if (!Number.isFinite(pct)) return;
      targetMs = Math.round(a.dur * pct / 100);
    } else if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map(s => parseInt(s, 10));
      let s = 0;
      if (parts.length === 2) s = parts[0] * 60 + parts[1];
      else if (parts.length === 3) s = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else return;
      targetMs = s * 1000;
    } else {
      const sec = parseFloat(trimmed);
      if (!Number.isFinite(sec)) return;
      targetMs = Math.round(sec * 1000);
    }
    if (Number.isFinite(targetMs) && typeof window.jumpAudioToMs === 'function') {
      window.jumpAudioToMs(targetMs);
    }
    return;
  }
  // Card mode.
  const input = prompt(`Enter card number (1–${allNotes.length}):`);
  const num = parseInt(input);
  if (!isNaN(num) && num >= 1 && num <= allNotes.length) {
    updateCardIndex(num - 1);
  }
}

// Enhanced memory cleanup
function cleanupMemory() {
  debugLog("🧹 Starting memory cleanup...");
  
  // Stop background processing
  if (backgroundProcessor) {
    backgroundProcessor.stop = true;
    backgroundProcessor = null;
  }
  
  // Clear current data
  allNotes = [];
  currentCardIndex = 0;
  viewedNotes.clear();
  isLoadingComplete = false;
  totalNotesExpected = 0;
  notesProcessed = 0;
  
  // Clear field mapping data
  window.currentFieldNames = [];
  window.currentDeckName = '';
  window.currentFieldMappings = null;
  
  // Hide field mapping button
  const fieldMappingBtn = document.getElementById('fieldMappingBtn');
  if (fieldMappingBtn) {
    fieldMappingBtn.style.display = 'none';
  }
  
  // Stop audio
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio.load();
    currentAudio = null;
  }
  
  // Clear stopwatch
  if (stopwatchInterval) {
    clearInterval(stopwatchInterval);
    stopwatchInterval = null;
  }
  
  // Clear media cache
  mediaCache.clear();

  // Clear ZIP reference
  currentZip = null;

  // Close the random-access deck reader (releases its file handle / buffers).
  if (currentApkgReader) {
    try { currentApkgReader.close(); } catch (e) {}
    currentApkgReader = null;
  }

  // Reset swipe listeners flag
  window.swipeListenersSetup = false;
  
  // Clear any dictionary data that might be loaded
  if (window.clearDictionaryData) {
    try {
      window.clearDictionaryData();
      debugLog("Dictionary data cleared");
    } catch (e) {
      debugLog(`Could not clear dictionary data: ${e.message}`);
    }
  }
  
  // Clear any blob URLs
  document.querySelectorAll('img, audio').forEach(el => {
    if (el.src && el.src.startsWith('blob:')) {
      URL.revokeObjectURL(el.src);
    }
  });
  
  // Force garbage collection if available
  if (window.gc) {
    window.gc();
  }
  
  debugLog("✅ Memory cleanup completed");
}

// LRU Cache implementation for media files
function addToMediaCache(filename, data) {
  if (mediaCache.size >= maxCacheSize) {
    // Remove oldest entry
    const firstKey = mediaCache.keys().next().value;
    const oldData = mediaCache.get(firstKey);
    if (oldData && oldData.startsWith('blob:')) {
      URL.revokeObjectURL(oldData);
    }
    mediaCache.delete(firstKey);
  }
  mediaCache.set(filename, data);
}

function getFromMediaCache(filename) {
  if (mediaCache.has(filename)) {
    const data = mediaCache.get(filename);
    // Move to end (most recently used)
    mediaCache.delete(filename);
    mediaCache.set(filename, data);
    return data;
  }
  return null;
}

// Safe JSON parser that handles various edge cases
function safeJsonParse(jsonString, fallback = null) {
  if (!jsonString) return fallback;
  
  try {
    // Handle binary data that might be passed as string
    if (jsonString instanceof Uint8Array) {
      jsonString = new TextDecoder().decode(jsonString);
    }
    
    // Clean up common JSON issues
    let cleanJson = jsonString.trim();
    
    // Remove null bytes that can corrupt JSON
    cleanJson = cleanJson.replace(/\0/g, '');
    
    // Basic validation before parsing
    if (!cleanJson.startsWith('{') && !cleanJson.startsWith('[')) {
      debugLog("Data doesn't look like JSON:" + cleanJson.substring(0, 100));
      return fallback;
    }
    
    return JSON.parse(cleanJson);
  } catch (error) {
    debugLog(`JSON parse error: ${error.message}`);
    debugLog("Problematic data (first 200 chars): " + (jsonString || '').toString().substring(0, 200));
    return fallback;
  }
}

// Enhanced function to safely get models from database with better field detection
function getModelsFromDatabase(db) {
  debugLog("Attempting to read models from database...");
  
  try {
    // First, check what tables exist
    const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tables = tablesResult[0] ? tablesResult[0].values.flat() : [];
    debugLog("Available tables: " + tables.join(', '));
    
    // Method 1: Try the new schema (notetypes table)
    if (tables.includes('notetypes')) {
      debugLog("Trying new schema (notetypes table)...");
      try {
        const noteTypesResult = db.exec("SELECT id, name, config FROM notetypes LIMIT 5");
        if (noteTypesResult[0] && noteTypesResult[0].values.length > 0) {
          const models = {};
          
          for (const [id, name, configData] of noteTypesResult[0].values) {
            debugLog(`Processing notetype: ${name} (ID: ${id})`);
            
            const config = safeJsonParse(configData, { flds: [] });
            
            if (config && config.flds) {
              models[id] = {
                id: id,
                name: name,
                flds: config.flds
              };
              debugLog(`✅ Loaded notetype: ${name} with ${config.flds.length} fields`);
              debugLog("Field names: " + config.flds.map(f => f.name).join(', '));
            } else {
              debugLog(`⚠️ No valid fields found for notetype: ${name}`);
              // Create a basic model even if config parsing failed
              models[id] = {
                id: id,
                name: name,
                flds: [
                  { name: "Expression" },
                  { name: "Meaning" }, 
                  { name: "Reading" },
                  { name: "Screenshot" },
                  { name: "Audio" }
                ]
              };
            }
          }
          
          if (Object.keys(models).length > 0) {
            debugLog("Successfully loaded models from new schema");
            return models;
          }
        }
      } catch (newSchemaError) {
        debugLog(`New schema method failed: ${newSchemaError.message}`);
      }
    }
    
    // Method 2: Try the legacy schema (col table)
    if (tables.includes('col')) {
      debugLog("Trying legacy schema (col table)...");
      try {
        const colResult = db.exec("SELECT models FROM col LIMIT 1");
        if (colResult[0] && colResult[0].values.length > 0) {
          const modelsData = colResult[0].values[0][0];
          debugLog(`Models data type: ${typeof modelsData}`);
          debugLog("Models data preview: " + (modelsData || '').toString().substring(0, 300));
          
          const models = safeJsonParse(modelsData, null);
          
          if (models && typeof models === 'object') {
            debugLog("✅ Successfully loaded models from legacy schema");
            debugLog("Found model IDs: " + Object.keys(models).join(', '));
            
            // Log field names for each model
            Object.values(models).forEach(model => {
              if (model.flds) {
                debugLog(`Model "${model.name}" fields: ` + model.flds.map(f => f.name).join(', '));
              }
            });
            
            return models;
          } else {
            debugLog("⚠️ Failed to parse models JSON from col table");
          }
        }
      } catch (legacyError) {
        debugLog(`Legacy schema method failed: ${legacyError.message}`);
      }
    }
    
    // Method 3: Create a fallback model structure with common field names
    debugLog("⚠️ Could not load models, creating fallback...");
    return {
      "1": {
        id: 1,
        name: "Default",
        flds: [
          { name: "Expression" },
          { name: "Meaning" },
          { name: "Reading" },
          { name: "Screenshot" },
          { name: "Audio" },
          { name: "Front" },
          { name: "Back" }
        ]
      }
    };
    
  } catch (error) {
    debugLog(`Error in getModelsFromDatabase: ${error.message}`);
    // Return a basic fallback model
    return {
      "1": {
        id: 1,
        name: "Fallback",
        flds: [
          { name: "Expression" },
          { name: "Screenshot" },
          { name: "Audio" }
        ]
      }
    };
  }
}

// Smart field content detector - analyzes actual content to determine field purpose
function analyzeFieldContent(content) {
  if (!content || typeof content !== 'string') return { type: 'unknown', score: 0 };
  
  const trimmed = content.trim();
  if (!trimmed) return { type: 'empty', score: 0 };
  
  // Check for image content
  if (trimmed.includes('<img') || trimmed.includes('.jpg') || trimmed.includes('.png') || 
      trimmed.includes('.jpeg') || trimmed.includes('.gif') || trimmed.includes('.webp')) {
    return { type: 'image', score: -5 }; // Negative score for non-expression content
  }
  
  // Check for audio content
  if (trimmed.includes('[sound:') || trimmed.includes('.mp3') || trimmed.includes('.m4a') || 
      trimmed.includes('.wav') || trimmed.includes('.ogg')) {
    return { type: 'audio', score: -5 }; // Negative score for non-expression content
  }
  
  // Check for HTML content (likely not main expression)
  if (trimmed.includes('<') && trimmed.includes('>')) {
    return { type: 'html', score: -3 }; // Negative score for HTML
  }
  
  // Check for furigana/reading fields with brackets - should NOT be selected as expression
  if (trimmed.includes('[') && trimmed.includes(']')) {
    // Count bracket pairs to determine if this is likely a reading field
    const openBrackets = (trimmed.match(/\[/g) || []).length;
    const closeBrackets = (trimmed.match(/\]/g) || []).length;
    if (openBrackets > 0 && closeBrackets > 0) {
      return { type: 'reading_furigana', score: -8 }; // Strong negative for reading fields
    }
  }
  
  // Check for IDs (more comprehensive patterns)
  if (/^[A-Za-z0-9]+_[A-Za-z0-9_.-]+$/.test(trimmed) || 
      /^\d+_\d+/.test(trimmed) ||
      /^[A-Za-z]+-[A-Za-z-]+-S\d+/.test(trimmed)) {
    return { type: 'id', score: -10 }; // Very negative score for IDs
  }
  
  // Check for very long content (likely not main expression)
  if (trimmed.length > 200) {
    return { type: 'long_text', score: 1 };
  }
  
  // Check for Japanese characters (likely expression) - HIGHEST PRIORITY
  if (/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(trimmed)) {
    // Give extra points for longer Japanese text and mixed character types
    let score = 15; // Base high score
    if (trimmed.length > 10) score += 5; // Bonus for longer text
    if (/[\u4e00-\u9faf]/.test(trimmed) && /[\u3040-\u309f\u30a0-\u30ff]/.test(trimmed)) {
      score += 5; // Bonus for mixed kanji and kana
    }
    // Penalize if it has brackets (likely reading field mixed with Japanese)
    if (trimmed.includes('[') || trimmed.includes(']')) {
      score -= 12; // Heavy penalty for brackets in Japanese text
    }
    return { type: 'japanese', score: score };
  }
  
  // Check for short meaningful text (likely expression)
  if (trimmed.length >= 1 && trimmed.length <= 50 && !/^\d+$/.test(trimmed)) {
    return { type: 'short_text', score: 6 };
  }
  
  // Numbers only
  if (/^\d+$/.test(trimmed)) {
    return { type: 'number', score: -2 }; // Negative for pure numbers
  }
  
  return { type: 'text', score: 4 };
}

// Enhanced expression finder using content analysis
function findBestExpression(fields, fieldNames) {
  debugLog(`Finding best expression from ${fields.length} fields`);
  
  // First try: Look for fields with obvious expression names AND good content
  const expressionFieldNames = ["Expression", "Japanese", "Front", "Text", "Question", "Word", "Phrase"];
  // Explicitly avoid reading field names
  const avoidFieldNames = ["Reading", "Furigana", "Pronunciation", "Yomi"];
  
  for (const fieldName of expressionFieldNames) {
    const index = fieldNames.indexOf(fieldName);
    if (index >= 0 && fields[index]) {
      const analysis = analyzeFieldContent(fields[index]);
      // Only use named fields if they have positive scores and aren't reading fields
      if (analysis.score > 0 && analysis.type !== 'reading_furigana') {
        debugLog(`✅ Found expression in named field "${fieldName}": ${fields[index].substring(0, 50)}`);
        return fields[index].trim();
      }
    }
  }
  
  // Second try: Analyze all fields by content and find the highest scoring one
  const candidates = [];
  for (let i = 0; i < fields.length; i++) {
    const fieldName = fieldNames[i] || `Field${i}`;
    
    // Skip fields that are explicitly reading/furigana fields by name
    if (avoidFieldNames.some(avoid => fieldName.toLowerCase().includes(avoid.toLowerCase()))) {
      debugLog(`⚠️ Skipping field "${fieldName}" - identified as reading field by name`);
      continue;
    }
    
    const analysis = analyzeFieldContent(fields[i]);
    candidates.push({
      index: i,
      fieldName: fieldName,
      content: fields[i],
      analysis: analysis,
      score: analysis.score
    });
  }
  
  // Sort by score (higher is better)
  candidates.sort((a, b) => b.score - a.score);
  
  debugLog("Field analysis results:");
  candidates.forEach(c => {
    debugLog(`  ${c.fieldName} (Field ${c.index}): ${c.analysis.type} (score: ${c.score}) - "${c.content?.substring(0, 50)}..."`);
  });
  
  // Return the best candidate with a positive score
  for (const candidate of candidates) {
    if (candidate.score > 0 && candidate.content?.trim()) {
      debugLog(`✅ Selected field ${candidate.index} "${candidate.fieldName}" as expression (score: ${candidate.score}): ${candidate.content.substring(0, 50)}`);
      return candidate.content.trim();
    }
  }
  
  // Final fallback: return first non-empty field that's not clearly problematic
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] && fields[i].trim()) {
      const analysis = analyzeFieldContent(fields[i]);
      if (analysis.type !== 'id' && analysis.type !== 'image' && analysis.type !== 'audio' && analysis.type !== 'reading_furigana') {
        debugLog(`⚠️ Fallback: using field ${i}: ${fields[i].substring(0, 50)}`);
        return fields[i].trim();
      }
    }
  }
  
  return "No content found";
}

// Lazy loading function for media files
async function loadMediaFile(filename, mediaPromises) {
  // Check cache first
  const cached = getFromMediaCache(filename);
  if (cached) {
    debugLog(`📦 Cache hit for ${filename}`);
    return cached;
  }
  
  // Load from ZIP if not cached
  if (mediaPromises[filename]) {
    try {
      const data = await mediaPromises[filename]();
      if (data) {
        addToMediaCache(filename, data);
        debugLog(`💾 Loaded and cached ${filename}`);
        return data;
      }
    } catch (error) {
      debugLog(`❌ Error loading media file ${filename}: ${error.message}`);
    }
  } else {
    // Diagnostic: the card referenced a file that isn't in the media manifest.
    // Usually a name-mismatch (path/encoding/case) between the card HTML and the
    // manifest. Show a few available keys to compare.
    const keys = Object.keys(mediaPromises || {});
    debugLog(`⚠️ Media "${filename}" not in manifest (${keys.length} entries). Sample: ${keys.slice(0, 4).join(', ')}`);
  }

  return null;
}

// Process a single note with custom field mapping support
function processSingleNote(noteRow, fieldNames, globalIndex) {
  const [id, flds] = noteRow;
  
  try {
    const fields = flds.split("\u001f");
    const fieldMap = {};
    fieldNames.forEach((name, idx) => fieldMap[name] = fields[idx] || "");

    let expression, imageFilename = null, audioFilename = null;

    // Check if we have custom field mappings
    if (window.currentFieldMappings) {
      debugLog(`Using custom field mappings for note ${id}`);
      
      // Use custom expression field
      if (window.currentFieldMappings.expression !== null) {
        expression = fields[parseInt(window.currentFieldMappings.expression)] || `Card ${globalIndex + 1}`;
      } else {
        expression = `Card ${globalIndex + 1}`;
      }
      
      // Use custom image field
      if (window.currentFieldMappings.image !== null) {
        const imageField = fields[parseInt(window.currentFieldMappings.image)];
        if (imageField) {
          const match = imageField.match(/<img[^>]+src=["']([^"']+)["']/i);
          if (match) {
            imageFilename = match[1].replace(/^.*[\/\\]/, '');
          }
        }
      }
      
      // Use custom audio field
      if (window.currentFieldMappings.audio !== null) {
        const audioField = fields[parseInt(window.currentFieldMappings.audio)];
        if (audioField) {
          const audioMatch = audioField.match(/\[sound:(.+?)\]/);
          if (audioMatch) {
            audioFilename = audioMatch[1];
          }
        }
      }
    } else {
      // Use automatic field detection
      expression = findBestExpression(fields, fieldNames);

      // Find image filename without loading (automatic detection)
      const imageFields = ["Screenshot", "Snapshot", "Image", "Picture", "Photo"];
      for (const fieldName of imageFields) {
        if (fieldMap[fieldName]) {
          const match = fieldMap[fieldName].match(/<img[^>]+src=["']([^"']+)["']/i);
          if (match) {
            imageFilename = match[1].replace(/^.*[\/\\]/, '');
            break;
          }
        }
      }

      // Find audio filename without loading (automatic detection)
      const audioFields = ["Audio", "Sound", "Pronunciation"];
      for (const fieldName of audioFields) {
        if (fieldMap[fieldName]) {
          const audioMatch = fieldMap[fieldName].match(/\[sound:(.+?)\]/);
          if (audioMatch) {
            audioFilename = audioMatch[1];
            break;
          }
        }
      }
    }

    

// Content-based audio fallback if not found by field name
if (!audioFilename) {
  for (const fld of fields) {
    if (!fld) continue;
    const m = fld.match(/\[sound:([^\]]+)\]/i);
    if (m) {
      audioFilename = m[1];
      debugLog(`🔊 Detected audio from content: ${audioFilename}`);
      break;
    }
  }
}
// Bare filename fallback (e.g. just 'word.mp3')
if (!audioFilename) {
  for (const fld of fields) {
    if (!fld) continue;
    const m = fld.trim().match(/([A-Za-z0-9_-]+\.(mp3|m4a|aac|wav|ogg))/i);
    if (m) {
      audioFilename = m[1];
      debugLog(`🔊 Detected audio bare filename: ${audioFilename}`);
      break;
    }
  }
}
// Content-based IMAGE fallback if not found by field name. Audio already has
// this; images didn't, so a card whose image field wasn't identified (e.g. a
// non-standard field name, or a new-schema notetype whose fields didn't parse)
// silently lost its picture while audio still resolved via its own scan.
if (!imageFilename) {
  for (const fld of fields) {
    if (!fld) continue;
    const m = fld.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) {
      imageFilename = m[1].replace(/^.*[\/\\]/, '');
      debugLog(`🖼️ Detected image from content: ${imageFilename}`);
      break;
    }
  }
}
// Store note with media filenames only (not loaded data)
    const note = {
      id,
      expression: expression.trim() || `Card ${globalIndex + 1}`,
      allFields: fieldMap,
      rawFields: fields,
      imageFilename: imageFilename,
      audioFilename: audioFilename,
      imageHtml: "",
      audioSrc: ""
    };

    return note;

  } catch (noteError) {
    debugLog(`Warning: Error processing note ${id}: ${noteError.message}`);
    return {
      id,
      expression: `Error loading note ${id}`,
      imageFilename: null,
      audioFilename: null,
      imageHtml: "",
      audioSrc: "",
      allFields: {},
      rawFields: []
    };
  }
}

// PROGRESSIVE LOADING: Process first batch immediately, then continue in background
async function startProgressiveNoteProcessing(noteRows, models, mediaPromises) {

const namesFor = (mid) => {
  const m = models[mid];
  return (m && m.flds ? m.flds.map(f => f.name || f) : []);
};
  const totalNotes = noteRows[0].values.length;
    
  totalNotesExpected = totalNotes;
  notesProcessed = 0;
  
  debugLog(`🚀 Starting progressive loading for ${totalNotes} notes...`);
  
  // Process first 20 notes immediately for instant display
  const immediateCount = Math.min(20, totalNotes);
  debugLog(`⚡ Processing first ${immediateCount} notes immediately...`);
  
  for (let i = 0; i < immediateCount; i++) {
    const row = noteRows[0].values[i];
    const fieldNames = namesFor(row[2]);
    const note = processSingleNote([row[0], row[1]], fieldNames, i);
    allNotes.push(note);
    notesProcessed++;
  }
  
  debugLog(`✅ First ${immediateCount} notes ready for display!`);
  
  // Make variables globally accessible for dictionary system
  window.allNotes = allNotes;
  window.currentCardIndex = currentCardIndex;
  window.mediaPromises = mediaPromises;
  
  // Check if we need to restore to a specific card position BEFORE showing the first card
  if (window.pendingCardIndex !== undefined && window.pendingCardIndex >= 0) {
    if (window.pendingCardIndex < immediateCount) {
      // The target card is already loaded, jump to it immediately
      debugLog(`🎯 Jumping to saved card position: ${window.pendingCardIndex + 1}`);
      currentCardIndex = window.pendingCardIndex;
      window.currentCardIndex = currentCardIndex;
      window.pendingCardIndex = undefined;
      showToast(`🎯 Resumed at card ${currentCardIndex + 1}`, 2000);
    } else {
      // Target card not loaded yet, will restore after background processing
      debugLog(`⏳ Target card ${window.pendingCardIndex + 1} not loaded yet, will restore after background processing`);
    }
  }
  
  // Show the current card (either card 1 or restored position)
  displayCard();
  updateProgressBar();
  
  // Continue processing remaining notes in background
  if (totalNotes > immediateCount) {
    debugLog(`📦 Starting background processing for remaining ${totalNotes - immediateCount} notes...`);
    
    backgroundProcessor = {
      stop: false,
      async process() {
        const batchSize = 50; // Process 50 notes at a time in background
        
        for (let batchStart = immediateCount; batchStart < totalNotes; batchStart += batchSize) {
          // Check if we should stop (e.g., new deck loaded)
          if (this.stop) {
            debugLog("Background processing stopped");
            return;
          }
          
          const batchEnd = Math.min(batchStart + batchSize, totalNotes);
          debugLog(`📦 Background processing batch: ${batchStart + 1}-${batchEnd} of ${totalNotes}`);
          
          // Process this batch
          for (let i = batchStart; i < batchEnd; i++) {
            if (this.stop) return;
            
            const row = noteRows[0].values[i];
    const fieldNames = namesFor(row[2]);
    const note = processSingleNote([row[0], row[1]], fieldNames, i);
            allNotes.push(note);
            notesProcessed++;
            
            // Check if this is the target card we were waiting for
            if (window.pendingCardIndex !== undefined && i === window.pendingCardIndex) {
              debugLog(`🎯 Target card ${window.pendingCardIndex + 1} now loaded, jumping to it`);
              currentCardIndex = window.pendingCardIndex;
              window.currentCardIndex = currentCardIndex;
              displayCard();
              updateProgressBar();
              showToast(`🎯 Resumed at card ${currentCardIndex + 1}`, 2000);
              window.pendingCardIndex = undefined;
            }
          }
          
          // Update progress display
          showLoadingProgress();
          updateProgressBar();
          
          // Small delay to keep UI responsive
          await new Promise(resolve => setTimeout(resolve, 10));
          
          // Periodic garbage collection
          if (batchStart % (batchSize * 10) === 0 && window.gc) {
            window.gc();
          }
        }
        
        // Mark loading as complete
        isLoadingComplete = true;
        updateProgressBar();
        debugLog(`✅ Background processing complete! All ${totalNotes} notes loaded.`);
        
        // Final check for pending card restoration
        if (window.pendingCardIndex !== undefined && window.pendingCardIndex >= 0 && window.pendingCardIndex < allNotes.length) {
          debugLog(`🎯 Final restoration to card ${window.pendingCardIndex + 1}`);
          currentCardIndex = window.pendingCardIndex;
          window.currentCardIndex = currentCardIndex;
          displayCard();
          updateProgressBar();
          showToast(`🎯 Resumed at card ${currentCardIndex + 1}`, 2000);
          window.pendingCardIndex = undefined;
        }
      }
    };
    
    // Start background processing
    backgroundProcessor.process().catch(error => {
      debugLog(`❌ Background processing failed: ${error.message}`);
      isLoadingComplete = true;
      updateProgressBar();
    });
  } else {
    // All notes processed immediately
    isLoadingComplete = true;
    updateProgressBar();
  }
  
  return allNotes;
}

// Enhanced deck loading with field mapping support

// Retrieve saved field mappings (expression/image/audio indices) for a given deck
async function getSavedFieldMappings(deckName) {
  try {
    const mappingKey = `fieldMapping_${deckName}`;
    let savedMappings = null;

    if (isCapacitorEnvironment()) {
      if (window.Capacitor?.Plugins?.Preferences) {
        const result = await window.Capacitor.Plugins.Preferences.get({ key: mappingKey });
        if (result.value) {
          savedMappings = JSON.parse(result.value);
        }
      }
    } else {
      const mappingJson = localStorage.getItem(mappingKey);
      if (mappingJson) {
        savedMappings = JSON.parse(mappingJson);
      }
    }
    return savedMappings;
  } catch (err) {
    debugLog(`⚠️ Error retrieving field mappings for ${deckName}: ${err.message}`);
    return null;
  }
}

async function loadDeckFromFile(source) {
  // Callers pass EITHER a File/Blob (the file picker — already disk-backed and
  // lazily sliceable) OR a disk descriptor { path, size, name } (auto-restore /
  // library open). The latter lets us read the archive by byte-range straight
  // off disk instead of copying the whole (up to ~1 GB) file into the JS heap.
  let file = null, path = null, size = 0, displayName = 'deck.apkg';
  if (source instanceof Blob) {
    file = source; displayName = source.name || displayName; size = source.size || 0;
  } else if (source && source.path) {
    path = source.path; size = source.size || 0; displayName = source.name || displayName;
  } else {
    debugLog('❌ loadDeckFromFile: invalid source'); return;
  }

  // Serialize against concurrent loads (double-tap, or auto-restore racing a
  // manual open). Two loads in flight would stomp currentApkgReader and leave
  // one ZipReader orphaned mid-parse. The `finally` at the end clears this.
  if (_deckLoadInFlight) {
    debugLog('⏳ Deck load already in progress — ignoring concurrent request');
    return;
  }
  _deckLoadInFlight = true;

  debugLog(`Loading deck: ${displayName} (${size ? Math.round(size / 1024 / 1024) + 'MB' : 'size unknown'})`);

  // Everything below runs under one try/finally so the in-flight flag is ALWAYS
  // cleared — a leak here would block every future load until app restart.
  try {
  // Arm the crash guard before the heavy read. Even with random-access reading,
  // a pathological deck could still exhaust memory; if that hard-kills the
  // WebView before we disarm, the next launch boots safe instead of looping.
  await markDeckLoadStart();

  resetCrossTitlePositionState();

  // Clean up memory from previous deck
  cleanupMemory();

  document.getElementById('deckName').textContent = displayName;

  // Store current deck name for field mapping
  window.currentDeckName = displayName;

// Attempt to load saved field mappings for this deck *before* processing notes
window.currentFieldMappings = await getSavedFieldMappings(displayName);
if (window.currentFieldMappings) {
  debugLog(`✅ Loaded saved field mappings for ${displayName}`);
} else {
  debugLog(`ℹ️ No saved field mappings for ${displayName}`);
}

    // Open the archive for RANDOM ACCESS — reads only the central directory now,
    // and individual entries on demand below. No whole-file buffering.
    debugLog("Opening deck archive (random-access)...");
    const apkg = await window.ApkgReader.open({ file, path, size });
    currentApkgReader = apkg.zipReader; // closed in cleanupMemory()
    debugLog(`✅ Archive opened (mode=${apkg.mode}); ${apkg.entries.length} entries`);

    // Index entries by name for O(1) lookup.
    const byName = new Map();
    for (const e of apkg.entries) byName.set(e.filename, e);

    // New-format (.anki21b) decks zstd-compress the DB, the media manifest, and
    // every media blob; legacy decks store a JSON media map and raw blobs.
    const newFormat = byName.has("collection.anki21b");

    // Media manifest → { "0": "real.mp3", ... }. Legacy = JSON; new = protobuf
    // MediaEntries (zstd) whose entry order IS the numbered zip member.
    let media = {};
    try {
      const manifestEntry = byName.get("media");
      if (manifestEntry) {
        if (newFormat) {
          const mb = window.ApkgReader.maybeZstd(await window.ApkgReader.entryBytes(manifestEntry));
          window.ApkgReader.decodeMediaEntries(mb).forEach((nm, i) => { if (nm) media[String(i)] = nm; });
          debugLog(`Loaded protobuf media manifest with ${Object.keys(media).length} files (new format)`);
        } else {
          media = safeJsonParse(await window.ApkgReader.entryText(manifestEntry), {});
          debugLog(`Loaded media manifest with ${Object.keys(media).length} files`);
        }
      }
    } catch (mediaError) {
      debugLog(`Warning: Could not load media manifest: ${mediaError.message}`);
      media = {};
    }

    // Lazy media: decode each entry from the archive only when a card asks for
    // it (Phase 1 keeps the base64 data-URI shape; disk-offload is a later phase).
    const mediaPromises = {};
    const deckReader = apkg.zipReader; // bind closures to THIS deck's reader
    for (const [id, name] of Object.entries(media)) {
      const entry = byName.get(id);
      if (!entry) continue;
      mediaPromises[name] = async () => {
        try {
          // If the deck was switched since these promises were built, the
          // reader has been closed by cleanupMemory — touching its entries
          // would throw. Bail quietly; the new deck has its own mediaPromises.
          if (currentApkgReader !== deckReader) return null;
          const ext = (name.split('.').pop() || '').toLowerCase();
          let mime = "application/octet-stream";
          if (["mp3", "m4a", "aac", "wav", "ogg"].includes(ext)) mime = `audio/${ext}`;
          if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
          if (newFormat) {
            // Blob bytes are a zstd frame — decompress, then base64 ourselves
            // (zip.js's Data64URIWriter would encode the still-compressed bytes).
            // Sniff the real MIME from magic bytes: an <img> won't render a data
            // URI typed application/octet-stream, so a wrong extension → no image.
            const raw = window.ApkgReader.maybeZstd(await window.ApkgReader.entryBytes(entry));
            return window.ApkgReader.bytesToDataUri(raw, window.ApkgReader.sniffMime(raw, mime));
          }
          return await window.ApkgReader.entryDataUri(entry, mime);
        } catch (error) {
          debugLog(`Error loading media file ${name}: ${error.message}`);
          return null;
        }
      };
    }

    // Read ONLY the collection DB entry into sql.js (not the whole archive).
    // Prefer the NEWEST format present: a new-format export can include a
    // legacy collection.anki2 STUB alongside the real zstd collection.anki21b,
    // so checking anki2 first would load an empty placeholder.
    const dbCandidates = ["collection.anki21b", "collection.anki21", "collection.anki2"]
      .filter(k => byName.has(k));
    if (dbCandidates.length > 1) {
      debugLog(`⚠️ Multiple collection formats present (${dbCandidates.join(', ')}); using ${dbCandidates[0]}`);
    }
    const dbEntry = dbCandidates.length ? byName.get(dbCandidates[0]) : null;
    if (!dbEntry) throw new Error("No collection database found in the deck file");
    debugLog(`Loading ${dbEntry.filename}`);
    // maybeZstd decodes the new-format zstd DB and passes a raw sqlite DB through.
    const dbBytes = window.ApkgReader.maybeZstd(await window.ApkgReader.entryBytes(dbEntry));

    const db = new SQL.Database(dbBytes);
    debugLog("✅ Database loaded successfully");

    // Get models using the enhanced function
    const models = getModelsFromDatabase(db);
    // Build a complete list of field names across all note-types
    window.currentFieldNames = Array.from(new Set(Object.values(models).flatMap(m => m.flds.map(f => f.name || f))));

    const model = Object.values(models)[0];
    
    if (!model) {
      throw new Error("No valid models found in database");
    }

// Enhanced function to get actual field names from note data
function getActualFieldNames(noteRows, models) {
  debugLog("Analyzing actual note data to determine field structure...");
  
  try {
    // First, try to get field names from models
    const model = Object.values(models)[0];
    let modelFieldNames = [];
    
    if (model && model.flds) {
      modelFieldNames = model.flds.map(f => f.name || f);
      debugLog(`Model provides ${modelFieldNames.length} field names: ${modelFieldNames.join(', ')}`);
    }
    
    // Analyze actual note data to see how many fields we really have
    if (noteRows[0] && noteRows[0].values && noteRows[0].values.length > 0) {
      // Take the first few notes to analyze field structure
      const sampleSize = Math.min(5, noteRows[0].values.length);
      let maxFieldCount = 0;
      
      for (let i = 0; i < sampleSize; i++) {
        const [id, flds] = noteRows[0].values[i];
        const fields = flds.split("\u001f");
        maxFieldCount = Math.max(maxFieldCount, fields.length);
      }
      
      debugLog(`Actual note data shows ${maxFieldCount} fields per note`);
      
      // If we have more actual fields than model fields, create generic names
      if (maxFieldCount > modelFieldNames.length) {
        debugLog(`⚠️ Note data has more fields (${maxFieldCount}) than model (${modelFieldNames.length})`);
        
        const actualFieldNames = [];
        
        // Use model names for the fields we have
        for (let i = 0; i < maxFieldCount; i++) {
          if (i < modelFieldNames.length && modelFieldNames[i]) {
            actualFieldNames.push(modelFieldNames[i]);
          } else {
            // Create generic names for extra fields
            actualFieldNames.push(`Field ${i + 1}`);
          }
        }
        
        debugLog(`✅ Using actual field structure: ${actualFieldNames.join(', ')}`);
        return actualFieldNames;
      }
      
      // If model field count matches or exceeds actual fields, use model names
      if (modelFieldNames.length > 0) {
        debugLog(`✅ Using model field names: ${modelFieldNames.join(', ')}`);
        return modelFieldNames;
      }
    }
    
    // Fallback: create generic field names based on first note
    if (noteRows[0] && noteRows[0].values && noteRows[0].values.length > 0) {
      const [id, flds] = noteRows[0].values[0];
      const fields = flds.split("\u001f");
      const fallbackNames = fields.map((_, index) => `Field ${index + 1}`);
      
      debugLog(`⚠️ Fallback: created ${fallbackNames.length} generic field names`);
      return fallbackNames;
    }
    
    // Ultimate fallback
    debugLog("❌ Could not determine field structure, using default names");
    return ["Expression", "Meaning", "Reading", "Image", "Audio"];
    
  } catch (error) {
    debugLog(`❌ Error analyzing field structure: ${error.message}`);
    return ["Field 1", "Field 2", "Field 3", "Field 4", "Field 5"];
  }
}
    let noteRows;
    try {
      noteRows = db.exec("SELECT id, flds, mid FROM notes");
    } catch (notesError) {
      debugLog(`Error reading notes: ${notesError.message}`);
      throw new Error("Could not read notes from database: " + notesError.message);
    }

    if (!noteRows[0] || !noteRows[0].values || noteRows[0].values.length === 0) {
      throw new Error("No notes found in database");
    }

    debugLog(`Found ${noteRows[0].values.length} notes`);

    // Check for existing field mappings
    await loadFieldMappings(displayName);

    // START PROGRESSIVE LOADING - This will show first cards immediately!
    debugLog("🚀 Starting progressive loading...");
    await startProgressiveNoteProcessing(noteRows, models, mediaPromises);

    debugLog(`✅ Deck ready! ${noteRows[0].values.length} total notes loaded.`);

    // Survived the heavy load and first cards are showing → disarm the guard.
    markDeckLoadDone();

    // Show field mapping button
    const fieldMappingBtn = document.getElementById('fieldMappingBtn');
    if (fieldMappingBtn) {
      fieldMappingBtn.style.display = 'inline-block';
      debugLog('✅ Field mapping button shown');
    } else {
      debugLog('❌ Field mapping button not found');
    }

    // Save deck metadata
    saveDeckState();

    // Clear validation variables after successful load
    window.expectedDeckName = undefined;

    if (window.Capacitor && Capacitor.Plugins?.SplashScreen) {
      Capacitor.Plugins.SplashScreen.hide();
    }

  } catch (error) {
    debugLog(`❌ Detailed error: ${error.message}`);
    debugLog(`❌ Error stack: ${error.stack}`);

    // A caught error means the app is still alive (no hard crash), so this is
    // NOT a boot-loop situation → disarm the guard so the next launch isn't
    // needlessly forced into safe mode.
    markDeckLoadDone();

    // Clear validation variables on error too
    window.expectedDeckName = undefined;
    window.pendingCardIndex = undefined;

    alert(`Error loading deck: ${error.message}\n\nCheck the debug console for more details.`);

    // Clean up on error
    cleanupMemory();
  } finally {
    _deckLoadInFlight = false;
  }
}

// Load existing field mappings for a deck
async function loadFieldMappings(deckName) {
  try {
    const mappingKey = `fieldMapping_${deckName}`;
    let savedMappings = null;
    
    if (isCapacitorEnvironment()) {
      const result = await window.Capacitor.Plugins.Preferences.get({ key: mappingKey });
      if (result.value) {
        savedMappings = JSON.parse(result.value);
      }
    } else {
      const mappingJson = localStorage.getItem(mappingKey);
      if (mappingJson) {
        savedMappings = JSON.parse(mappingJson);
      }
    }
    
    if (savedMappings) {
      debugLog(`Found existing field mappings for ${deckName}`);
      window.currentFieldMappings = savedMappings;
      return savedMappings;
    } else {
      debugLog(`No existing field mappings for ${deckName}`);
      window.currentFieldMappings = null;
      return null;
    }
  } catch (error) {
    debugLog(`Error loading field mappings: ${error.message}`);
    window.currentFieldMappings = null;
    return null;
  }
}

// Fixed displayCard with proper caching logic
async function displayCard() {
  if (!allNotes || allNotes.length === 0) return;

  // Capture which card we're rendering at function entry. If currentCardIndex
  // changes during the async media-load awaits (e.g., pendingCardIndex
  // restore runs after we start), we detect the drift before painting and
  // re-render for the new index.
  const capturedIndex = currentCardIndex;
  const card = allNotes[capturedIndex];
  const container = document.getElementById("cardContainer");
  
  // Always start with the text content to avoid blank cards
  let imageHtml = "";
  let audioSrc = "";
  
  // Check if we have cached media
  if (card.imageHtml) {
    imageHtml = card.imageHtml;
  } else if (card.imageFilename && window.mediaPromises) {
    // Load image if not cached
    try {
      debugLog(`🖼️ Loading image: ${card.imageFilename}`);
      const imageData = await loadMediaFile(card.imageFilename, window.mediaPromises);
      if (imageData) {
        imageHtml = `<img src="${imageData}" class="card-image">`;
        card.imageHtml = imageHtml; // Cache for future use
      }
    } catch (error) {
      debugLog(`❌ Error loading image ${card.imageFilename}: ${error.message}`);
    }
  }
  
  if (card.audioSrc) {
    audioSrc = card.audioSrc;
  } else if (card.audioFilename && window.mediaPromises) {
    // Load audio if not cached
    try {
      debugLog(`🔊 Loading audio: ${card.audioFilename}`);
      audioSrc = await loadMediaFile(card.audioFilename, window.mediaPromises);
      if (audioSrc) {
        card.audioSrc = audioSrc; // Cache for future use
      }
    } catch (error) {
      debugLog(`❌ Error loading audio ${card.audioFilename}: ${error.message}`);
    }
  }
  
  // Re-read the card before rendering. The async awaits above may have
  // yielded long enough for the restore-pendingCardIndex path (or a swipe)
  // to update currentCardIndex. If so, recompute media for the new card
  // before painting — otherwise we'd render the stale card while the bar
  // shows the new position.
  if (currentCardIndex !== capturedIndex) {
    debugLog(`displayCard: index changed mid-await ${capturedIndex} → ${currentCardIndex}, re-rendering`);
    return displayCard();
  }
  // SRT-card path: this card's audio is a segment of an audiobook. Play via
  // BackgroundAudio plugin (no per-card mp3 file). Skip the new-Audio path.
  if (card.isSrtCard) {
    container.innerHTML = `
      <div class="subtitle-text">${card.expression}</div>
      <div id="srtCardWaveform" style="width:90%;max-width:520px;margin:auto auto calc(96px + env(safe-area-inset-bottom, 0px)) auto;order:2;align-self:center;flex:0 0 auto;"></div>
    `;
    if (window.wrapSubtitleTokens) window.wrapSubtitleTokens();
    if (window.syncReadingToCard) {
      try { window.syncReadingToCard(card.expression); } catch (e) {}
    }
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg && card.audiobookPath && card.audiobookStartMs != null) {
      const url = card.audiobookPath.startsWith('file://') ? card.audiobookPath : 'file://' + card.audiobookPath;
      // Continuous play-through (PLAY button → audioAutoAdvance) lets the
      // audiobook flow through the inter-cue silence like audio mode, so don't
      // arm the per-cue end-stop. Single-card playback (navigating to a card
      // while paused) still stops at the cue's endMs.
      _srtCardEndMs = window.audioAutoAdvance ? 0 : (card.audiobookEndMs || 0);
      _ensureBgListenersForSrtCards();
      // When a cross-mode sync (e.g., switching to card mode while audio
      // was already playing) brought us here, audio is already at the
      // right position. Re-issuing bg.play would back-jump to startMs.
      // Just keep _srtCardEndMs armed and let auto-advance take over.
      // Also suppressed by startupAutoPlayBlocked on first launch so the
      // user gets a silent app open.
      if (window._skipNextCardAudioRestart || window.startupAutoPlayBlocked) {
        // Do NOT consume startupAutoPlayBlocked here — it must persist across
        // the several displayCard calls during open/restart init, and is
        // lifted only by a real card advance (updateCardIndex) or explicit
        // PLAY. Only the one-shot _skipNextCardAudioRestart is consumed.
        window._skipNextCardAudioRestart = false;
        console.log('[srt-card] silent-display idx=' + currentCardIndex);
      } else {
        const adjStart = Math.max(0, Math.round(card.audiobookStartMs) - (window.AUDIO_START_OFFSET_MS || 0));
        console.log('[srt-card] play idx=' + currentCardIndex +
          ' startMs=' + adjStart + ' endMs=' + card.audiobookEndMs);
        bg.play({
          url,
          startMs: adjStart,
          rate: window.audioPlaybackRate || 1
        }).catch(err => debugLog('SRT card play: ' + err.message));
      }
    }
    // Render the per-card waveform with draggable endpoints. Adjusting the
    // bounds updates the card object in-memory; auto-advance and Anki sends
    // will use the adjusted bounds. Continuous play re-shows this for each new
    // cue; waveform.show() carries the playhead across a same-source re-show so
    // the cursor glides through cue boundaries instead of cold-starting.
    if (window.waveform && card.audiobookPath) {
      window.waveform.show({
        container: document.getElementById('srtCardWaveform'),
        srcPath: card.audiobookPath,
        startMs: card.audiobookStartMs,
        endMs: card.audiobookEndMs,
        onChange: ({ startMs, endMs }) => {
          card.audiobookStartMs = startMs;
          card.audiobookEndMs = endMs;
          _srtCardEndMs = endMs;
        }
      });
    }
    updateProgressBar();
    lastInteractionTime = Date.now();
    startStopwatch();
    trackNoteView(currentCardIndex);
    return;
  }
  // Always update the container with current content
  container.innerHTML = `
    ${imageHtml}
    <div class="subtitle-text">${card.expression}</div>
  `;

  if (window.wrapSubtitleTokens) window.wrapSubtitleTokens();

  if (window.syncReadingToCard) {
    try { window.syncReadingToCard(card.expression); }
    catch (e) { debugLog(`syncReadingToCard error: ${e.message}`); }
  }

  // Check actual view visibility rather than a flag — flag can get stuck if
  // audiobook view was opened via the toolbar's 🎧 button instead of a shell
  // tab. The view itself is authoritative.
  const audiobookViewOpen = (() => {
    const v = document.getElementById('audiobookModeView');
    return !!(v && v.style.display !== 'none');
  })();
  if (audioSrc && !audiobookViewOpen) {
    // Stop previous audio
    if (currentAudio) {
      currentAudio.pause();
    }

    currentAudio = new Audio(audioSrc);
    currentAudio.playbackRate = window.audioPlaybackRate || 1;
    currentAudio.addEventListener('ended', () => {
      // Don't auto-advance if audiobook mode has taken over.
      const ab = document.getElementById('audiobookModeView');
      if (ab && ab.style.display !== 'none') return;
      if (!window.audioAutoAdvance) return;
      const readingView = document.getElementById('readingModeView');
      const inReadingMode = readingView && readingView.style.display !== 'none';
      if (inReadingMode && window.readingAutoAdvance === false) return;
      if (currentCardIndex < allNotes.length - 1) goToNextCard();
    });
    // Suppress auto-play on the very first card after app launch — the
    // user expects a quiet startup. Subsequent displayCards (after a
    // swipe, PLAY tap, etc.) play normally.
    if (window.startupAutoPlayBlocked) {
      // Suppressed on open/restart. Do NOT consume — it's lifted by a real
      // card advance (updateCardIndex) or explicit PLAY, so the first card on
      // open/restart never auto-plays while normal navigation still does.
    } else {
      currentAudio.play().catch(err => {
        debugLog(`Audio play error: ${err.message}`);
      });
    }
  }
  
  updateProgressBar();
  lastInteractionTime = Date.now();
  startStopwatch();
  trackNoteView(currentCardIndex);
}

function setupSwipe() {
  // Check if event listeners are already set up to prevent duplicates
  if (window.swipeListenersSetup) {
    debugLog("Swipe listeners already set up, skipping...");
    return;
  }
  
  let touchStartY = 0;
  let touchStartX = 0;

  try {
    // Add a small delay to ensure DOM is ready and prevent memory crashes
    setTimeout(() => {
      try {
        const inReadingView = (target) => {
          if (!target) return false;
          const paged = document.getElementById('readingPagedView');
          if (paged && paged.style.display !== 'none' && paged.style.visibility !== 'hidden' && paged.contains(target)) return true;
          const view = document.getElementById('readingModeView');
          return !!(view && view.style.display !== 'none' && view.contains(target));
        };
        const libraryOpen = () => {
          const lib = document.getElementById('libraryPage');
          return !!(lib && lib.classList.contains('visible'));
        };
        const inWaveform = (target) => !!(target?.closest && target.closest('#srtCardWaveform'));
        // Audio mode owns its own touch handlers (the audiobookModeView's
        // own touchend does play/pause on down-swipe). Without this
        // guard, the document-level card handler ALSO fired for those
        // touches and replayed the SRT card audio → the "down-swipe
        // in audio replays instead of pausing" report.
        const inAudioView = (target) => {
          const av = document.getElementById('audiobookModeView');
          return !!(av && av.style.display !== 'none' && av.contains(target));
        };
        // Block card swipes whenever a modal is up (preferences / edit title /
        // reentry / etc.) so vertical scroll inside the modal doesn't fire
        // card-mode replay or send-to-Anki.
        const inModal = (target) => {
          if (document.body.classList.contains('prefs-open')) return true;
          return !!(target?.closest && target.closest(
            '#preferencesModal, #titleEditModal, #audiobookReentryModal, #readingSettingsModal, #readingStatsModal, .shell-menu'
          ));
        };

        // True when the current gesture started inside a subtitle that
        // is actually scrollable RIGHT NOW (scrollHeight > clientHeight).
        // Set in touchstart, consumed in touchend to suppress vertical
        // swipes (Anki / replay) so the user can scroll long subtitles
        // without accidentally sending the card. Horizontal swipes
        // (next/prev) still fire because they don't conflict with
        // vertical scroll.
        let inSubtitleSafeZone = false;
        const touchStartHandler = (e) => {
          if (libraryOpen()) return;
          if (inReadingView(e.target)) return;
          if (inWaveform(e.target)) return;
          if (inAudioView(e.target)) return;
          if (inModal(e.target)) return;
          if (e.touches && e.touches[0]) {
            touchStartY = e.touches[0].clientY;
            touchStartX = e.touches[0].clientX;
          }
          // Detect the safe-scroll zone at touchstart, not touchend —
          // the user can scroll within the subtitle and lift their
          // finger anywhere; what matters is where the gesture STARTED.
          inSubtitleSafeZone = false;
          const sub = e.target?.closest?.('.subtitle-text');
          if (sub && sub.scrollHeight > sub.clientHeight + 1) {
            inSubtitleSafeZone = true;
          }
        };

        const touchEndHandler = async (e) => {
          if (libraryOpen()) return;
          if (inReadingView(e.target)) return;
          if (inWaveform(e.target)) return;
          if (inAudioView(e.target)) return;
          if (inModal(e.target)) return;
          if (!e.changedTouches || !e.changedTouches[0] || !allNotes || allNotes.length === 0) {
            return;
          }
          
          const deltaY = e.changedTouches[0].clientY - touchStartY;
          const deltaX = e.changedTouches[0].clientX - touchStartX;

          // Card-mode interaction signal — fires for any swipe past the
          // ~30px threshold even if we end up declining the action
          // (e.g. an up-swipe in the bottom 1/5 system-gesture zone).
          // Stray taps (both deltas < 30) intentionally do NOT count;
          // the timer stays stopped per the user's "swipe to restart"
          // rule. See stats.js bumpCard() docs.
          const isSwipe = Math.abs(deltaX) > 30 || Math.abs(deltaY) > 30;
          if (isSwipe && window.stats?.bumpCard) {
            try { window.stats.bumpCard(); } catch (_) {}
          }

          if (Math.abs(deltaX) > Math.abs(deltaY)) {
            if (deltaX < -30 && currentCardIndex < allNotes.length - 1) {
              updateCardIndex(currentCardIndex + 1);
            } else if (deltaX > 30 && currentCardIndex > 0) {
              updateCardIndex(currentCardIndex - 1);
            }
          } else if (inSubtitleSafeZone) {
            // Vertical motion inside a scrollable subtitle — the user
            // is scrolling subtitle text, not invoking Anki / replay.
            // Native scroll has already handled the motion; we just
            // skip the swipe-actions branch.
            return;
          } else {
            // System-gesture safe zones: a vertical swipe that BEGAN at the very
            // top (notification shade / Control Center) or bottom (app switcher /
            // home) belongs to the OS — don't also fire replay / send-to-Anki.
            if (window._inSystemGestureZone?.(touchStartY)) return;
            if (deltaY > 30) {
              const card = allNotes[currentCardIndex];
              if (card?.isSrtCard) {
                // SRT-card: replay via background audio plugin from the
                // (possibly user-adjusted) startMs.
                const bg = window.Capacitor?.Plugins?.BackgroundAudio;
                if (bg && card.audiobookPath && Number.isFinite(card.audiobookStartMs)) {
                  const url = card.audiobookPath.startsWith('file://') ? card.audiobookPath : 'file://' + card.audiobookPath;
                  _srtCardEndMs = card.audiobookEndMs || 0;
                  bg.play({
                    url,
                    startMs: Math.max(0, Math.round(card.audiobookStartMs) - (window.AUDIO_START_OFFSET_MS || 0)),
                    rate: window.audioPlaybackRate || 1
                  }).catch(err => debugLog('SRT replay: ' + err.message));
                }
              } else if (currentAudio) {
                currentAudio.currentTime = 0;
                currentAudio.play().catch(err => {
                  debugLog(`Audio replay error: ${err.message}`);
                });
              }
            } else if (deltaY < -30) {
              // (Bottom-edge up-swipes — the app-switcher gesture — are already
              // filtered by the _inSystemGestureZone guard at the top of this
              // branch.)
              const card = allNotes[currentCardIndex];
              if (card && window.sendToAnki) {
                const expression = card.expression;
                let imageData = card.imageHtml?.match(/src="([^"]+)"/)?.[1] || "";
                let audioData = card.audioSrc || "";
                // Fall back to the active Title's cover image for SRT-cards
                // (no card image of their own).
                if (!imageData && window._activeTitleId && window.titleStore?.list) {
                  try {
                    const titles = await window.titleStore.list();
                    const tit = titles.find(t => t.id === window._activeTitleId);
                    if (tit?.attachments?.cover?.dataUri) imageData = tit.attachments.cover.dataUri;
                  } catch (e) {}
                }
                // For SRT cards, open the waveform editor so the user can
                // fine-tune bounds before we slice + send. Cancel aborts.
                let finalExpression = expression;
                if (card.isSrtCard && card.audiobookPath && window.Capacitor?.Plugins?.AudioSlicer) {
                  let finalStart = Math.round(card.audiobookStartMs);
                  let finalEnd   = Math.round(card.audiobookEndMs);
                  console.log('[card-anki] currentCardIndex=' + currentCardIndex +
                    ' expression="' + (expression || '').slice(0, 40) + '"' +
                    ' audiobookStartMs=' + card.audiobookStartMs +
                    ' audiobookEndMs=' + card.audiobookEndMs +
                    ' path=' + card.audiobookPath);
                  if (window.waveform?.edit) {
                    // SRT-card index IS cue index. Pass the cue list so the
                    // editor's text-range handles can expand/contract.
                    const cuesFromCards = window.allNotes
                      ?.filter(n => n.isSrtCard)
                      .map(n => ({
                        startMs: n.audiobookStartMs,
                        endMs:   n.audiobookEndMs,
                        text:    (n.expression || '').replace(/<[^>]+>/g, '').trim()
                      }));
                    const result = await window.waveform.edit({
                      srcPath: card.audiobookPath,
                      startMs: finalStart,
                      endMs:   finalEnd,
                      title: expression,
                      cues: cuesFromCards,
                      cueIndex: currentCardIndex
                    });
                    if (!result) return; // user cancelled
                    finalStart = Math.round(result.startMs);
                    finalEnd   = Math.round(result.endMs);
                    if (result.text) finalExpression = result.text;
                    // Persist the adjusted bounds back into the in-memory card
                    // so the next replay/next-card transition uses them too.
                    card.audiobookStartMs = finalStart;
                    card.audiobookEndMs   = finalEnd;
                  }
                  try {
                    const slicer = window.Capacitor.Plugins.AudioSlicer;
                    console.log('[card-anki] slicing srcPath=' + card.audiobookPath +
                      ' finalStart=' + finalStart + ' finalEnd=' + finalEnd +
                      ' duration=' + (finalEnd - finalStart) + 'ms');
                    // Anki audio export contract: always 1.0x. AudioSlicer.slice
                    // does raw frame copy (MP3) or MediaMuxer remux (M4A) at
                    // native speed regardless of the user's playback rate.
                    const slice = await slicer.slice({
                      srcPath: card.audiobookPath,
                      startMs: finalStart,
                      endMs:   finalEnd
                    });
                    if (slice?.path) {
                      audioData = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
                      debugLog('SRT slice for Anki → bytes=' + (audioData?.length || 0) + ' mime=' + (slice.mime || ''));
                    }
                  } catch (e) { debugLog('SRT slice for Anki: ' + e.message); }
                }
                sendToAnki({ expression: finalExpression, imageData, audioData });
              }
            }
          }
        };

        document.addEventListener("touchstart", touchStartHandler, { passive: true });
        document.addEventListener("touchend", touchEndHandler, { passive: true });
        
        // Mark as set up to prevent duplicates
        window.swipeListenersSetup = true;
        debugLog("✅ Swipe listeners set up successfully");
        
      } catch (listenerError) {
        debugLog(`Error setting up touch listeners: ${listenerError.message}`);
      }
    }, 100); // Small delay to prevent memory issues
    
  } catch (error) {
    debugLog(`Error in setupSwipe: ${error.message}`);
  }
}

// Add navigation functions for keyboard controls
function goToPreviousCard() {
  if (currentCardIndex > 0) {
    updateCardIndex(currentCardIndex - 1);
  }
}

function goToNextCard() {
  if (currentCardIndex < allNotes.length - 1) {
    updateCardIndex(currentCardIndex + 1);
  }
}

// Add keyboard navigation
document.addEventListener('keydown', (e) => {
  if (!allNotes || allNotes.length === 0) return;
  
  switch(e.code) {
    case 'ArrowLeft':
      e.preventDefault();
      goToPreviousCard();
      break;
    case 'ArrowRight':
      e.preventDefault();
      goToNextCard();
      break;
    case 'Space':
      e.preventDefault();
      if (currentAudio) {
        currentAudio.currentTime = 0;
        currentAudio.play().catch(err => {
          debugLog(`Audio replay error: ${err.message}`);
        });
      }
      break;
  }
});

// Enhanced initialization with debugging
// =====================================================================
// Boot-crash guard
// ---------------------------------------------------------------------
// A title that crashes the app DURING restore (e.g. a ~1 GB deck that
// exhausts WebView memory and throws "Maximum call stack size exceeded")
// used to trap the app in a boot loop: every launch auto-restored the same
// title and crashed again before the UI ever became usable, with no way out.
//
// loadDeckFromFile() writes an "in-progress" flag to durable storage right
// before the heavy 1 GB ZIP+DB load and clears it once the deck reaches a
// usable state (or fails GRACEFULLY). An UNCAUGHT crash (OOM / stack overflow
// killing the WebView) leaves the flag set. So if a launch sees the flag
// still set, the previous deck load hard-crashed — we skip auto-restore, clear
// the legacy deck pointer, and drop the user into a usable empty app with
// their Library fully intact. This catches crashes from BOTH boot auto-restore
// AND a manual re-open of the same bad deck. A one-time "installed" check makes
// the FIRST launch of this build also boot safe, so an already-looping install
// recovers immediately on update.
// =====================================================================
const BOOT_GUARD_INPROGRESS_KEY  = 'KADOKI_BOOT_INPROGRESS_V1';
const BOOT_GUARD_INSTALLED_KEY   = 'KADOKI_BOOTGUARD_INSTALLED_V1';
const AUTORESTORE_SUPPRESSED_KEY = 'KADOKI_AUTORESTORE_SUPPRESSED_V1';
const DECK_QUARANTINE_KEY        = 'KADOKI_DECK_QUARANTINE_V1';

// localStorage is synchronous and persists across launches in the WebView, so
// it is the most durable place to record the "deck load in progress" marker
// right before a load that might HARD-OOM the process. Capacitor Preferences
// resolves set() BEFORE the value is flushed to disk (Android editor.apply() /
// iOS UserDefaults lazy sync), so an OOM kill can lose that write — the exact
// failure an adversarial review flagged. We write the marker to localStorage
// (sync) AND mirror to Preferences, and treat EITHER store reporting '1' as
// in-progress so a single lost write can't reopen the crash loop.
function _lsGet(key)      { try { return localStorage.getItem(key); } catch (e) { return null; } }
function _lsSet(key, v)   { try { localStorage.setItem(key, String(v)); } catch (e) {} }

async function _guardPrefGet(key) {
  try {
    if (isCapacitorEnvironment() && window.Capacitor?.Plugins?.Preferences) {
      const r = await window.Capacitor.Plugins.Preferences.get({ key });
      return r?.value ?? null;
    }
    return localStorage.getItem(key);
  } catch (e) { return null; }
}
async function _guardPrefSet(key, value) {
  try {
    if (isCapacitorEnvironment() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
    } else { localStorage.setItem(key, String(value)); }
  } catch (e) {}
}
async function _guardPrefRemove(key) {
  try {
    if (isCapacitorEnvironment() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.remove({ key });
    } else { localStorage.removeItem(key); }
  } catch (e) {}
}

// In-progress marker: dual-written (localStorage + Preferences), read from either.
async function _readInProgress() {
  if (_lsGet(BOOT_GUARD_INPROGRESS_KEY) === '1') return true;
  return (await _guardPrefGet(BOOT_GUARD_INPROGRESS_KEY)) === '1';
}
function _writeInProgress(v) {
  _lsSet(BOOT_GUARD_INPROGRESS_KEY, v);              // sync, durable-ish
  return _guardPrefSet(BOOT_GUARD_INPROGRESS_KEY, v); // mirror; awaitable
}

// Quarantine = the set of Title ids whose deck hard-crashed on load. Stored in
// localStorage so it survives a kill. autoRestoreFromTitles refuses to
// auto-open a quarantined title; a deliberate Library open clears it.
function _getQuarantine() { try { return JSON.parse(_lsGet(DECK_QUARANTINE_KEY) || '[]'); } catch (e) { return []; } }
function _addQuarantine(id) {
  if (!id) return;
  const q = _getQuarantine();
  if (!q.includes(id)) { q.push(id); _lsSet(DECK_QUARANTINE_KEY, JSON.stringify(q)); }
}
function _removeQuarantine(id) {
  if (!id) return;
  _lsSet(DECK_QUARANTINE_KEY, JSON.stringify(_getQuarantine().filter(x => x !== id)));
}
window.isDeckQuarantined = function (id) { return !!id && _getQuarantine().includes(id); };

// Decide whether THIS launch should skip auto-restore: a deck load crashed
// last session (in-progress still set), this is the first run of the build, or
// auto-restore is still suppressed from a prior crash. `crashed` distinguishes
// a real crash (→ quarantine the culprit) from the benign first-launch check.
async function evaluateBootGuard() {
  let safe = false, reason = '', crashed = false;
  const inProgress = await _readInProgress();
  const installed  = await _guardPrefGet(BOOT_GUARD_INSTALLED_KEY);
  const suppressed = await _guardPrefGet(AUTORESTORE_SUPPRESSED_KEY);
  if (inProgress) {
    safe = true; crashed = true;
    reason = 'previous launch did not finish (deck load crashed)';
  }
  if (installed !== '1') {
    safe = true;
    reason = reason || 'first launch of crash-guard build';
    await _guardPrefSet(BOOT_GUARD_INSTALLED_KEY, '1');
  }
  if (suppressed === '1') {
    safe = true;
    reason = reason || 'auto-restore suppressed after a prior crash';
  }
  return { safe, reason, crashed };
}

// Enter safe mode: load nothing, wipe the legacy deck pointer so no fallback
// path can reload the crasher, and suppress auto-restore until the user
// deliberately opens a title from the Library.
async function enterSafeBoot(reason, crashed) {
  debugLog(`⚠️ SAFE BOOT engaged — ${reason}`);
  // We've recovered: clear the crash marker, wipe the legacy deck pointer so
  // no fallback path reloads the crasher, and suppress auto-restore until the
  // user deliberately opens a title from the Library.
  await _writeInProgress('0');
  await _guardPrefRemove(PERSISTENCE_KEYS.FILE_URI);
  await _guardPrefRemove(PERSISTENCE_KEYS.FILE_NAME);
  await _guardPrefRemove(PERSISTENCE_KEYS.CARD_INDEX);
  await _guardPrefRemove(PERSISTENCE_KEYS.STORED_FILE_PATH);
  await _guardPrefSet(AUTORESTORE_SUPPRESSED_KEY, '1');
  // If a REAL crash triggered this safe boot, quarantine the most-recently
  // opened deck Title (the culprit). Clearing only the legacy prefs isn't
  // enough — autoRestoreFromTitles would faithfully rebuild that pointer from
  // the surviving Title and loop us again. Quarantine blocks that rebuild
  // until the user deliberately re-opens the title.
  if (crashed) {
    try {
      const titles = (await window.titleStore?.list?.()) || [];
      const culprit = titles
        .filter(t => t?.attachments?.deck)
        .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];
      if (culprit) { _addQuarantine(culprit.id); debugLog(`Quarantined likely crasher: ${culprit.id} (${culprit.name})`); }
    } catch (e) {}
  }
  const deckEl = document.getElementById('deckName');
  if (deckEl) { deckEl.textContent = 'No file chosen'; deckEl.className = 'file-name'; }
  // (crash-recovery toast removed per user request — it fired on ordinary cold
  // starts and read as alarming; safe-boot still quarantines the crasher silently.)
}

// Called by loadDeckFromFile around the heavy load. start() arms the crash
// marker (await it so the flag is persisted BEFORE the risky load); done()
// disarms it once the deck is usable or failed gracefully.
function markDeckLoadStart() { return _writeInProgress('1'); }
function markDeckLoadDone()  { _writeInProgress('0'); }

// Manual title opens are deliberate, so they clear the suppression set by a
// prior safe boot AND lift the quarantine on the opened title (the user is
// explicitly choosing to retry it), re-enabling auto-restore next launch.
window.clearAutoRestoreSuppression = function (titleId) {
  _guardPrefSet(AUTORESTORE_SUPPRESSED_KEY, '0');
  if (titleId) _removeQuarantine(titleId);
};

async function init() {
  debugLog("🚀 App.js initialization started");

  // Initialize Capacitor plugins first
  const capacitorReady = await initCapacitorPlugins();
  debugLog(`Capacitor initialization result: ${capacitorReady}`);

  // Initialize SQL
  debugLog("Initializing SQL.js...");
  const SQL = await initSqlJs({ locateFile: file => "sql-wasm.wasm" });
  window.SQL = SQL;
  debugLog("✅ SQL.js initialized");

  // Boot-crash guard FIRST: if the previous launch started but never reached
  // a stable state (a deck/title crashed during restore), skip auto-restore
  // this launch so we don't re-trigger the same crash and trap the user.
  const boot = await evaluateBootGuard();

  // Title-based auto-restore — preferred entry point. Picks the
  // most-recently-opened Title and either (a) bypasses legacy deck restore
  // entirely for deck-less Titles (SRT-cards / EPUB-only), or (b) mirrors
  // the deck attachment into the legacy keys so the existing flow restores
  // the same deck loadDeckState already knows how to handle.
  let titleLoaded = false;
  let restored = false;
  if (boot.safe) {
    await enterSafeBoot(boot.reason, boot.crashed);
  } else {
    titleLoaded = await autoRestoreFromTitles();
    debugLog(`Title-based restore: ${titleLoaded}`);
    restored = titleLoaded;
    if (!titleLoaded) {
      debugLog("Attempting legacy deck restore...");
      restored = await loadDeckState();
      debugLog(`Legacy deck restore: ${restored}`);
    }
  }

  // Boot content has SETTLED (auto-restore + any deck/card render are done).
  // Signal the shell's mode-restore to switch into the last-used mode NOW —
  // strictly AFTER the card render, so the deck-default render and the 800ms
  // DOM-resync can't flip it back to card. (Firing earlier, on _activeTitleId
  // alone, switched into read before the card painted and got reset to card.)
  window._bootContentReady = true;

  // Set up enhanced file input with URI capture and validation
  debugLog("Setting up file input with validation...");
  await setupFileInputWithUriCapture();
  debugLog("✅ File input setup completed");

  // Set up file picker
  const fileInput = document.getElementById('apkgFile');
  const label = fileInput.previousElementSibling;
  
  label.addEventListener('click', async (e) => {
    e.preventDefault();
    debugLog("📁 File picker label clicked - opening file picker");
    openFilePicker();
  });
  
  // Test that file input validation variables are accessible
  debugLog("🧪 Testing validation setup:");
  debugLog(`window.pendingCardIndex: ${window.pendingCardIndex}`);
  debugLog(`window.expectedDeckName: ${window.expectedDeckName}`);
  
  document.getElementById('cardContainer').addEventListener('dblclick', (e) => {
    const img = document.querySelector(".card-image");
    if (img && img.contains(e.target)) {
      const card = allNotes[currentCardIndex];
      navigator.clipboard.writeText(card.expression).then(() => {
        showToast("✓ Copied to clipboard");
      }).catch(err => {
        debugLog(`Clipboard error: ${err.message}`);
      });
    }
  });

  setupSwipe();
  debugLog("✅ App.js initialization completed");
}

// Add periodic state saving (every 30 seconds)
setInterval(() => {
  if (allNotes && allNotes.length > 0) {
    saveDeckState();
  }
}, 30000);

// Save state when page is about to unload
window.addEventListener('beforeunload', () => {
  if (allNotes && allNotes.length > 0) {
    saveDeckState();
  }
});

window.onload = init;

// NOTE: the native splash is no longer hidden here at parse-time — that
// revealed the un-settled WebView too early (card-then-read flash). The boot
// cover in index.html now hands the splash off to itself after first paint and
// stays up until revealApp() (mode + position restored). See index.html.

// Make functions accessible to other scripts
window.displayCard = displayCard;
window.goToPreviousCard = goToPreviousCard;
window.goToNextCard = goToNextCard;
window.updateCardIndex = updateCardIndex;

// Fully release the card-mode Audio element. Used when audiobook mode takes
// over so the card's audio (and its ended → auto-advance listener) can't
// double-play over the audiobook.
window.stopCardAudio = function () {
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    try { currentAudio.src = ''; } catch (e) {}
    currentAudio = null;
  }
};

// Persist the reading location for SRT-cards titles (where card index === cue
// index): as the user reads in read mode, keep the card synced + save the
// position so a relaunch restores the last-read line, not a stale spot. Only
// applies to SRT-cards titles; deck/epub titles use the per-book scrollLeft.
window.persistReadCue = function (cueIdx) {
  if (!Number.isFinite(cueIdx) || cueIdx < 0) return;
  if (!(allNotes && allNotes.length && allNotes[0]?.isSrtCard)) return;
  if (cueIdx >= allNotes.length) return;
  currentCardIndex = cueIdx;        // keep the card synced to reading (no re-render here)
  if (window._activeTitleId && window.titleStore?.setCardIndex) {
    window.titleStore.setCardIndex(window._activeTitleId, cueIdx).catch(() => {});
  }
};

// Jump the loaded audiobook to the previous/next subtitle cue — used by the
// lock-screen prev/next-track (⏮⏭) buttons. The audiobook is already loaded
// while in audio mode, so a plain seek is enough; the position events repaint
// the cue text + waveform.
window.lockScreenCueJump = function (dir) {
  const cues = (window.pagedCues?.length ? window.pagedCues : window.__abCues) || [];
  const bg = window.Capacitor?.Plugins?.BackgroundAudio;
  if (!cues.length || !bg) return;
  const cur = window._lastAudioCueIdx;
  // Playhead unknown → STAY PUT. Never coerce to 0 and seek the book start:
  // the lock-screen ⏮⏭ used to jump to the very beginning when the cursor was
  // -1/NaN. prev/next only navigates relative to a real, known playhead.
  if (!Number.isFinite(cur) || cur < 0) return;
  const target = Math.max(0, Math.min(cues.length - 1, cur + dir));
  const cue = cues[target];
  if (!cue || !Number.isFinite(cue.startMs)) return;
  window._lastAudioCueIdx = target;
  const ms = Math.max(0, Math.round(cue.startMs) - (window.AUDIO_START_OFFSET_MS || 0));
  try { bg.seek({ ms, fadeMs: 40 }); } catch (_) {}   // brief fade so the jump doesn't click
};

// Drop any loaded cards + card audio WITHOUT tearing down the dictionary,
// media cache, or other subsystems (unlike cleanupMemory). Used when a
// deck-less title (EPUB-only / audio-only) becomes active so CARD mode
// doesn't keep showing — or reload — the previous title's cards.
// Drop the transient, cross-title position/stats state when a NEW title loads,
// so the new book restores its OWN saved position instead of inheriting the
// previous book's playhead (e.g. opening book B and jumping to book A's 2%) and
// so the read char counter re-anchors per book instead of jumping.
function resetCrossTitlePositionState() {
  window._lastAudioCueIdx = -1;
  window._lastAudioCueIdxForStats = -1;
  // Audio-stats continuity baseline (playhead vs wall-clock). Clearing these
  // forces the first cue advance of the new title to re-anchor without
  // crediting, so a title switch can never dump a cross-title span.
  window._audioStatsLastWallMs = 0;
  window._audioStatsLastPosMs = -1;
  // Reentry-dialog divergence state is PER-TITLE. If it survives a title
  // load, opening a brand-new title re-shows the "prior card N vs new card M"
  // dialog using the previous title's stale prior-position — which is exactly
  // the "dialog on fresh title open" bug. A new title has no audio↔cursor
  // divergence, so clear all of it here.
  window._audioPositionUnresolved = false;
  window._priorCardIdx = null;
  window._priorCardIdxAtMs = 0;
  window._priorReaderCursorIdx = null;
  window._priorReaderCursorAtMs = 0;
  window._reentryDismissedByTab = false;
  // Drop the PREVIOUS title's loaded audio + its stale source paths. Without
  // this, after switching titles the BackgroundAudio plugin still holds the old
  // title's file (state.ready === true) and read-mode/audio PLAY RESUMED it —
  // the "plays the old title's audio" bug. The next play then does a fresh
  // bg.play with the new title's path (resolved via _pagedAudioPath).
  try { window.Capacitor?.Plugins?.BackgroundAudio?.stop?.(); } catch (e) {}
  window._pagedAudioPath = null;
  window._currentReadingAudiobookPath = null;
  window._audiobookSrcPath = null;
  window._bgPlaying = false;
  // Drop the previous title's dict lookup context (sentence + cue audio path +
  // cueStartMs). Without this, opening an EPUB-only title and looking up a word
  // inherited the prior audio title's cue audio → the dict popup wrongly showed
  // the "Set playhead" section. Re-set fresh by the next lookup.
  window.lookupContext = null;
  try { window.stats?.rebaselineRead?.(); } catch (e) {}
}

window.clearLoadedCardsAndAudio = function () {
  resetCrossTitlePositionState();
  try {
    if (typeof backgroundProcessor === 'object' && backgroundProcessor) {
      backgroundProcessor.stop = true;
    }
  } catch (e) {}
  allNotes = [];
  window.allNotes = allNotes;
  currentCardIndex = 0;
  try { viewedNotes.clear(); } catch (e) {}
  isLoadingComplete = false;
  totalNotesExpected = 0;
  notesProcessed = 0;
  if (typeof window.stopCardAudio === 'function') window.stopCardAudio();
  if (typeof window.invalidateAbContext === 'function') window.invalidateAbContext();
  const cc = document.getElementById('cardContainer');
  if (cc) cc.innerHTML = '';
  try { updateProgressBar(); } catch (e) {}
};

// =====================================================================
// SRT-derived card engine: when a Title has no Anki deck but DOES have an
// audiobook + SRT, build synthetic notes from the SRT cues. Each "card" is
// one cue; audio is played as a segment of the audiobook via the
// BackgroundAudio plugin (seek to startMs, stop when position >= endMs).
// =====================================================================

let _srtCardEndMs = 0;
let _srtEndListenerAttached = false;
window._bgPlaying = false;

function _ensureBgListenersForSrtCards() {
  if (_srtEndListenerAttached) return;
  const bg = window.Capacitor?.Plugins?.BackgroundAudio;
  if (!bg) return;
  _srtEndListenerAttached = true;
  bg.addListener('state', (d) => {
    window._bgPlaying = !!d.playing;
    // Strip refresh on play/pause only matters in AUDIO mode (where
    // the strip shows mm:ss / mm:ss). In read mode, the user wants
    // the scroll-derived character position; in card mode, card N/M.
    // Letting this fire in those modes was racing the scroll/card
    // handlers and overwriting their output with the audio cue's
    // chunk char-offset (or '—' when the cue index was stale),
    // producing the dash-flicker the user reported.
    if (document.body.classList.contains('mode-audio')) {
      try { window.pagedUpdateProgressForCue?.(window._lastAudioCueIdx ?? -1); } catch (_) {}
    }
  });
  // Lock screen / Control Center remote commands. The audiobook is the ONLY
  // content the lock screen ever controls (card SRT clips are just segments of
  // the same audiobook file), so a remote "play" should always land us in
  // AUDIO mode — which is what starts the audio timer + shows the cover, and
  // guarantees we never mis-attribute the time to card/read.
  bg.addListener('remoteCommand', (d) => {
    const action = d?.action;
    if (action === 'play') {
      // Disarm the SRT-card end-boundary auto-pause IMMEDIATELY (synchronously)
      // so the ~150ms position events can't pause the audio the lock screen
      // just resumed before the async mode switch flips us out of card mode.
      _srtCardEndMs = 0;
      // Native already resumed playback; switch to audio mode in RESUME mode
      // so we attach to it without reseeking/restarting.
      if (!document.body.classList.contains('mode-audio') && typeof window.setShellMode === 'function') {
        try { window.setShellMode('audio', { force: true, resumeOnly: true }); } catch (_) {}
      }
    } else if (action === 'nextCue' || action === 'prevCue') {
      try { window.lockScreenCueJump?.(action === 'nextCue' ? 1 : -1); } catch (_) {}
    }
  });
  bg.addListener('position', (d) => {
    // Same constraint as the state handler — only repaint the strip
    // in audio mode. ~3 Hz throttle still applies.
    const now = Date.now();
    if (document.body.classList.contains('mode-audio') &&
        (!window._lastStripUpdateAt || (now - window._lastStripUpdateAt) > 300)) {
      window._lastStripUpdateAt = now;
      try { window.pagedUpdateProgressForCue?.(window._lastAudioCueIdx ?? -1); } catch (_) {}
    }
    // Continuous play-through (card mode, PLAY pressed): the audiobook flows
    // past cue boundaries — including the silences between sentences — and we
    // advance the DISPLAYED card to track the playhead WITHOUT restarting audio
    // (silent display), so it listens straight through like audio mode.
    if (window.audioAutoAdvance && !_srtCardEndMs &&
        document.body.classList.contains('mode-card') &&
        Array.isArray(allNotes) && allNotes.length && allNotes[0]?.isSrtCard) {
      const pos = d.positionMs || 0;
      let idx = currentCardIndex;
      while (idx + 1 < allNotes.length && (allNotes[idx + 1].audiobookStartMs || 0) <= pos) idx++;
      while (idx > 0 && (allNotes[idx].audiobookStartMs || 0) > pos + 1) idx--;
      if (idx !== currentCardIndex && typeof updateCardIndex === 'function') {
        window._skipNextCardAudioRestart = true; // update the card UI, keep audio flowing
        updateCardIndex(idx);
      }
      return;
    }
    if (!_srtCardEndMs) return;
    // Single-clip playback (paused → navigate to a card): stop at the cue's
    // end. In read or audio mode the user expects audio to flow past cues.
    if (!document.body.classList.contains('mode-card')) return;
    if ((d.positionMs || 0) >= _srtCardEndMs - 50) {
      _srtCardEndMs = 0; // disarm
      try { bg.pause(); } catch (e) {}
    }
  });
}

/**
 * Load a Title that has audiobook + SRT but no deck. Parses the SRT,
 * builds a synthetic allNotes array (one entry per cue), sets up state,
 * and displays the first (or saved) card.
 */
// Tracks which Title is currently active so we can persist lastCardIndex.
window._activeTitleId = null;

window.loadTitleAsSrtCards = async function (title, skipCardDisplay) {
  const ab = title?.attachments?.audiobook;
  const srtAtt = title?.attachments?.srt;
  if (!ab || !srtAtt || !window.srtParser) return false;
  // Folder-imported titles carry {uri,name} lazily. rehydrateTitleCachePaths
  // normally fills cachePath before we get here, but be robust to ordering /
  // a silent rehydrate failure: materialize straight from the uri if needed.
  const _fa = window.Capacitor?.Plugins?.FileAccess;
  for (const att of [ab, srtAtt]) {
    if (!att.cachePath && att.uri && _fa?.materializeToCache) {
      try { const m = await _fa.materializeToCache({ uri: att.uri }); if (m?.path) att.cachePath = m.path; } catch (e) {}
    }
  }
  if (!ab.cachePath || !srtAtt.cachePath) {
    alert('Could not load the audio/subtitles for this title.');
    return false;
  }
  resetCrossTitlePositionState();

  // Read + parse SRT. iOS can EVICT the materialized cache file (iCloud
  // offload) while leaving a stale cachePath / 0-byte placeholder, so the
  // fetch fails with "Load failed" on first open and only a manual reload
  // (which re-materializes) works. Self-heal: on a read failure, force a fresh
  // materialize from the original uri and retry ONCE so the first open works.
  const _toFileUrl = (p) => (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function')
    ? window.Capacitor.convertFileSrc(p)
    : ('file://' + p);
  async function _readSrtText(att) {
    try {
      const res = await fetch(_toFileUrl(att.cachePath));
      if (!res.ok) throw new Error('SRT fetch status ' + res.status);
      const t = await res.text();
      if (!t) throw new Error('SRT empty (evicted placeholder?)');
      return t;
    } catch (e) {
      if (att.uri && _fa?.materializeToCache) {
        const m = await _fa.materializeToCache({ uri: att.uri });   // re-streams / downloads from iCloud
        if (m?.path) {
          att.cachePath = m.path;
          const res2 = await fetch(_toFileUrl(att.cachePath));
          if (res2.ok) return await res2.text();
        }
      }
      throw e;
    }
  }
  let cues = [];
  try {
    const text = await _readSrtText(srtAtt);
    cues = window.srtParser.parseSrt(text);
  } catch (e) {
    alert('Failed to read SRT for this title: ' + (e?.message || e));
    return false;
  }
  if (!cues.length) {
    alert('SRT parsed but found 0 cues. Check the file format.');
    return false;
  }

  // Synthesize notes — same shape as deck-derived notes, plus extras the
  // SRT-card playback path needs.
  const notes = cues.map((c) => ({
    expression: c.text,
    imageFilename: null,
    audioFilename: null,
    imageHtml: '',
    audioSrc: '',
    audiobookPath: ab.cachePath,
    audiobookStartMs: c.startMs,
    audiobookEndMs: c.endMs,
    cueIndex: c.index,
    isSrtCard: true
  }));

  // Stop any prior background-processing of a previous deck.
  if (typeof backgroundProcessor === 'object' && backgroundProcessor) {
    backgroundProcessor.stop = true;
  }
  // Wire state.
  allNotes = notes;
  window.allNotes = allNotes;
  notesProcessed = notes.length;
  totalNotesExpected = notes.length;
  isLoadingComplete = true;
  // Restore the saved card position for this title (if any).
  const restoreIdx = Number.isFinite(title.lastCardIndex)
    ? Math.max(0, Math.min(notes.length - 1, title.lastCardIndex))
    : 0;
  currentCardIndex = restoreIdx;
  window.currentCardIndex = restoreIdx;
  window._activeTitleId = title.id;
  // Title swap invalidates the audiobook pre-warm cache + reader warm flag.
  if (typeof window.invalidateAbContext === 'function') window.invalidateAbContext();
  window.dispatchEvent(new CustomEvent('shell:title-change'));

  // Show the title as the "deck name" so the rest of the app (which reads
  // currentDeckName from #deckName) uses the title for pref namespacing.
  const deckEl = document.getElementById('deckName');
  if (deckEl) {
    deckEl.textContent = title.name || 'Untitled';
    deckEl.className = 'file-name restored';
    deckEl.style.cursor = 'default';
    deckEl.onclick = null;
  }
  // Sync the audiobook + SRT into per-(pseudo-)deck prefs so the audio mode
  // can also find them when switching tabs.
  try {
    await window.Capacitor?.Plugins?.Preferences?.set?.({ key: 'READING_AUDIO_PAIR_' + title.name, value: ab.cachePath });
    await window.Capacitor?.Plugins?.Preferences?.set?.({ key: 'READING_AUDIO_NAME_' + title.name, value: ab.name });
    await window.Capacitor?.Plugins?.Preferences?.set?.({ key: 'READING_SRT_PAIR_' + title.name, value: srtAtt.cachePath });
    await window.Capacitor?.Plugins?.Preferences?.set?.({ key: 'READING_SRT_NAME_' + title.name, value: srtAtt.name });
  } catch (e) { debugLog('pref sync: ' + e.message); }

  _ensureBgListenersForSrtCards();

  // Plumb the parsed cues into reading-mode so its position listener +
  // cue-precise highlight work right away in audio/read mode without
  // requiring a tab switch to "wake up".
  if (typeof window.setAudiobookContextForSrtCards === 'function') {
    window.setAudiobookContextForSrtCards({
      audioPath: ab.cachePath,
      audioName: ab.name,
      cues
    });
  }

  // Stop any prior card audio.
  if (typeof window.stopCardAudio === 'function') window.stopCardAudio();

  // Skip the card render when opening straight into read mode — rendering a
  // card then switching modes is what causes the font/color flash.
  if (!skipCardDisplay) displayCard();
  updateProgressBar();
  return true;
};

window.setReadingPlaybackRate = function (rate) {
  const r = parseFloat(rate);
  if (!Number.isFinite(r) || r <= 0) return;
  window.audioPlaybackRate = r;
  if (currentAudio) currentAudio.playbackRate = r;
};

window.ensureCardMediaLoaded = async function (card) {
  if (!card || !window.mediaPromises) return card;
  try {
    if (!card.imageHtml && card.imageFilename) {
      const imageData = await loadMediaFile(card.imageFilename, window.mediaPromises);
      if (imageData) card.imageHtml = `<img src="${imageData}" class="card-image">`;
    }
  } catch (e) { debugLog(`ensureCardMediaLoaded image: ${e.message}`); }
  try {
    if (!card.audioSrc && card.audioFilename) {
      const audioSrc = await loadMediaFile(card.audioFilename, window.mediaPromises);
      if (audioSrc) card.audioSrc = audioSrc;
    }
  } catch (e) { debugLog(`ensureCardMediaLoaded audio: ${e.message}`); }
  return card;
};

function _currentCardIsSrtCard() {
  return !!(Array.isArray(allNotes) && allNotes[currentCardIndex]?.isSrtCard);
}

window.isReadingPlaying = function () {
  // Reader mode (now routing through bg for the audiobook) — and SRT-card
  // mode both delegate to BackgroundAudio plugin state.
  if (document.body.classList.contains('mode-read')) return !!window._bgPlaying;
  if (_currentCardIsSrtCard()) return !!window._bgPlaying;
  return !!(currentAudio && !currentAudio.paused && !currentAudio.ended);
};

window.toggleReadingPlayback = function () {
  const inReader = document.body.classList.contains('mode-read');

  // Reader mode with an audiobook paired (deck OR SRT-card title): PLAY
  // operates on the audiobook playhead via BackgroundAudio so the cue
  // highlight follows. Otherwise reader-mode PLAY would start the deck
  // card's per-mp3 audio, which the highlight code can't track.
  if (inReader) {
    // Fallback chain for audiobook source:
    //   1. The chunk-active cue's audiobook path (publishChunkCueRange)
    //   2. The global audiobook context path (set when ensureCueContext
    //      / setAudiobookContextForSrtCards loads abAudioPath)
    //   3. SRT-card title's per-note audiobookPath
    // Source priority: the PAGED reader's current-title audiobook FIRST. The
    // legacy _currentReadingAudiobookPath / _audiobookSrcPath come from the
    // legacy reader's abAudioPath (cached by deck name) which doesn't refresh
    // when the paged reader loads a new title — that staleness is what made
    // read-mode PLAY play the OLD title's audio after switching titles.
    const audiobookPath = window._pagedAudioPath ||
                          window._currentReadingAudiobookPath ||
                          window._audiobookSrcPath ||
                          (window.allNotes?.[window.currentCardIndex]?.audiobookPath);
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (audiobookPath && bg) {
      // Start point fallback (prefer the LIVE paged read cursor — the line the
      // user actually read — over the legacy _currentReadingCueStartMs, which
      // the paged reader never updates so it's stale/unset in the active flow):
      //   1. Paged read cursor's cue startMs (window._pagedReadCueStartMs)
      //   2. Legacy _currentReadingCueStartMs (if a legacy session set it)
      //   3. SRT-card's audiobookStartMs
      //   4. 0 (the position listener will then drive the highlight)
      // For SRT-card titles the card index is the truer read position (card
      // navigation doesn't advance the paged read cursor, so it can be stale),
      // so prefer audiobookStartMs there; for deck/EPUB use the live read cursor.
      const isSrtCardTitle = Array.isArray(window.allNotes) && window.allNotes[0]?.isSrtCard;
      const readCueMs = (!isSrtCardTitle && typeof window._pagedReadCueStartMs === 'function')
        ? window._pagedReadCueStartMs() : null;
      const startCueMs = Number.isFinite(readCueMs)
        ? readCueMs
        : (Number.isFinite(window._currentReadingCueStartMs)
            ? window._currentReadingCueStartMs
            : (window.allNotes?.[window.currentCardIndex]?.audiobookStartMs ?? 0));
      const startMs = Math.max(0, Math.round(startCueMs) - (window.AUDIO_START_OFFSET_MS || 0));
      const url = audiobookPath.startsWith('file://') ? audiobookPath : 'file://' + audiobookPath;
      console.log('[reader-play] audiobookPath=' + audiobookPath + ' startMs=' + startMs);
      bg.getState().then(s => {
        console.log('[reader-play] state.playing=' + s.playing + ' state.ready=' + s.ready);
        if (s.playing) {
          bg.pause();
        } else if (s.ready) {
          bg.resume();
        } else {
          // Pause any deck-mode card audio first so we don't get a
          // cacophony of two sources.
          try { if (currentAudio && !currentAudio.paused) currentAudio.pause(); } catch (e) {}
          bg.play({ url, startMs, rate: window.audioPlaybackRate || 1 })
            .then(() => console.log('[reader-play] bg.play resolved'))
            .catch(err => console.warn('[reader-play] bg.play err: ' + err?.message));
        }
      }).catch((err) => { console.warn('[reader-play] getState err:', err); });
      return true;
    }
  }

  // SRT-card mode: PLAY → always (re)start the current card from its
  // startMs (don't merely resume). PAUSE → pause.
  if (_currentCardIsSrtCard()) {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (!bg) return false;
    bg.getState().then(s => {
      if (s.playing) {
        bg.pause();
      } else {
        // Force a fresh play from the start of the current card.
        window.startupAutoPlayBlocked = false;
        window._skipNextCardAudioRestart = false;
        try { displayCard(); } catch (e) { debugLog('PLAY-kick: ' + e.message); }
      }
    }).catch(() => {});
    return true;
  }
  // Deck-card mode: PLAY → restart current card audio from 0.
  if (!currentAudio) {
    if (Array.isArray(allNotes) && allNotes.length > 0 && typeof displayCard === 'function') {
      window.startupAutoPlayBlocked = false;
      try { displayCard(); } catch (e) { debugLog(`PLAY-kick displayCard error: ${e.message}`); }
      return true;
    }
    return false;
  }
  if (currentAudio.paused || currentAudio.ended) {
    try { currentAudio.currentTime = 0; } catch (e) {}
    currentAudio.play().catch(err => debugLog(`Play toggle error: ${err.message}`));
    return true;
  }
  currentAudio.pause();
  return false;
};

/* === Preferences Persistence Helpers === */
function isCapacitorEnv() { return typeof isCapacitorEnvironment === 'function' && isCapacitorEnvironment(); }

function setPersistent(key, value) {
  try {
    if (isCapacitorEnv() && window.Capacitor?.Plugins?.Preferences) {
      window.Capacitor.Plugins.Preferences.set({ key, value: value.toString() });
    } else {
      localStorage.setItem(key, value.toString());
    }
  } catch (e) { console.error('setPersistent', e); }
}

async function getPersistent(key) {
  try {
    if (isCapacitorEnv() && window.Capacitor?.Plugins?.Preferences) {
      const res = await window.Capacitor.Plugins.Preferences.get({ key });
      return res.value;
    } else {
      return localStorage.getItem(key);
    }
  } catch (e) { console.error('getPersistent', e); return null; }
}

async function loadCounters() {
  try {
    const elapsed = await getPersistent('STOPWATCH_ELAPSED');
    if (elapsed) {
      stopwatchSeconds = parseInt(elapsed);
      const sw = document.getElementById('stopwatch');
      if (sw) sw.textContent = `${stopwatchSeconds}s`;
    }
    const notes = await getPersistent('NOTE_COUNTER');
    if (notes) {
      const cnt = parseInt(notes);
      const nc = document.getElementById('noteCounter');
      if (nc) nc.textContent = ` ${cnt} notes`;
    }
    const tout = await getPersistent('STOPWATCH_TIMEOUT');
    if (tout) {
      stopwatchTimeout = parseInt(tout);
    }
  } catch (e) { console.error('loadCounters', e); }
}

window.addEventListener('DOMContentLoaded', () => {
  loadCounters();
  // (No dict-store term-set pre-warm any more — deinflection answers term
  // existence per-tap via dictStore.existsBulk, so there is no boot scan.)
});

/* Periodic persistence */
setInterval(() => {
  setPersistent('STOPWATCH_ELAPSED', stopwatchSeconds);
  setPersistent('NOTE_COUNTER', viewedNotes.size);
}, 5000);
