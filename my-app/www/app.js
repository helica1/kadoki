// FileAccess plugin will be available globally through Capacitor

// No import needed - Capacitor automatically registers plugins

// Cleared the first time displayCard is asked to start audio. Keeps the
// app silent on launch so the user can choose when to start playback.
window.startupAutoPlayBlocked = true;
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
  
  // Also send to HTML debug console if available
  if (window.debugLog) {
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
  
  debugLog(`Capacitor environment check: ${result} (Capacitor: ${!!window.Capacitor}, Plugins: ${!!window.Capacitor?.Plugins}, FS: ${hasFilesystem}, Prefs: ${hasPreferences})`);
  
  // Additional debugging
  if (window.Capacitor) {
    debugLog(`Available Capacitor properties: ${Object.keys(window.Capacitor).join(', ')}`);
    if (window.Capacitor.Plugins) {
      debugLog(`Available Plugin names: ${Object.keys(window.Capacitor.Plugins).join(', ')}`);
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

  const fetchUrl = window.Capacitor.convertFileSrc(path);
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`fetch(${fetchUrl}) returned ${response.status}`);
  }
  const blob = await response.blob();
  const file = new File([blob], fileName, { type: 'application/zip' });

  currentFileUri = uri;

  const deckNameEl = document.getElementById('deckName');
  deckNameEl.textContent = fileName;
  deckNameEl.className = 'file-name restored';
  deckNameEl.style.cursor = 'default';
  deckNameEl.onclick = null;

  await loadDeckFromFile(file);
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
    const sorted = titles.slice().sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    const t = sorted[0];
    if (!t) return false;
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
      return false; // legacy path handles the actual load
    }

    // Deck-less with audiobook + SRT → build synthetic cards.
    if (a.audiobook && a.srt && typeof window.loadTitleAsSrtCards === 'function') {
      window._activeTitleId = t.id;
      const ok = await window.loadTitleAsSrtCards(t);
      return !!ok;
    }

    // EPUB-only or audio-only: nothing to "load" at startup beyond labeling.
    if (a.epub || a.audiobook) {
      const deckEl = document.getElementById('deckName');
      if (deckEl) {
        deckEl.textContent = t.name || 'Untitled';
        deckEl.className = 'file-name restored';
      }
      window._activeTitleId = t.id;
      return false;
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
  let savedUri = (typeof maybeUri === 'string' && maybeUri.startsWith('content://')) ? maybeUri : null;
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
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 12px 20px;
    border-radius: 6px;
    font-size: 14px;
    z-index: 3000;
    border: 1px solid #00ffcc;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    max-width: 80%;
    text-align: center;
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, duration);
}

// Update card index and save state
function updateCardIndex(newIndex) {
  if (newIndex >= 0 && newIndex < allNotes.length && newIndex !== currentCardIndex) {
    debugLog(`Updating card index from ${currentCardIndex} to ${newIndex}`);
    currentCardIndex = newIndex;
    window.currentCardIndex = currentCardIndex;

    // Save state whenever card changes
    saveDeckState();
    // Persist per-title card index for SRT-cards titles too.
    if (window._activeTitleId && window.titleStore?.setCardIndex) {
      window.titleStore.setCardIndex(window._activeTitleId, newIndex).catch(() => {});
    }
    // Stats: a card advance counts toward the card-mode counter (even if
    // it came from a swipe in card mode or a cross-mode sync).
    if (window.stats?.incrementCardCount) window.stats.incrementCardCount();

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
  if (mode === 'audio' && typeof window.getAudioProgress === 'function') {
    openAudioSeekDialog();
    return;
  }
  promptCardJump();
};

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
    display:flex; align-items:flex-end; justify-content:center;
    z-index:3200; touch-action:none;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    background:var(--bg,#0c0c0c); border:1px solid var(--border,#2a2a2a);
    border-radius:14px 14px 0 0; width:100%; max-width:520px;
    padding:18px 18px 26px;
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

// Global playback-rate setter. Used by:
//   - Audiobook transport speed buttons
//   - Preferences → Playback → Audio speed slider
// Affects all three modes by updating window.audioPlaybackRate, telling
// the BackgroundAudio plugin (for audiobook + SRT card playback), and
// the currently-active HTMLAudioElement (deck-card per-card audio).
// Persisted via Preferences so the choice survives launches.
window.setGlobalPlaybackRate = async function (rate) {
  const r = Math.max(0.25, Math.min(3.0, parseFloat(rate) || 1));
  window.audioPlaybackRate = r;
  try {
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg?.setRate) await bg.setRate({ rate: r });
  } catch (e) {}
  try { if (currentAudio) currentAudio.playbackRate = r; } catch (e) {}
  // Persist (best-effort).
  try {
    if (window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key: 'AUDIO_SPEED', value: String(r) });
    } else {
      localStorage.setItem('AUDIO_SPEED', String(r));
    }
  } catch (e) {}
  // Reflect the new rate in the audiobook slider (no oninput recursion —
  // setting .value programmatically doesn't fire `input`).
  const slider = document.getElementById('audiobookSpeed');
  const label  = document.getElementById('audiobookSpeedLabel');
  if (slider) slider.value = r;
  if (label)  label.textContent = r.toFixed(2) + '×';
};

// Slider-input handler — wired to #audiobookSpeed.
window.onAudiobookSpeedInput = function (v) {
  const r = parseFloat(v) || 1;
  const label = document.getElementById('audiobookSpeedLabel');
  if (label) label.textContent = r.toFixed(2) + '×';
  // Coalesce rapid drags via a tiny debounce so we don't spam bg.setRate.
  if (window._speedDebounce) clearTimeout(window._speedDebounce);
  window._speedDebounce = setTimeout(() => window.setGlobalPlaybackRate(r), 80);
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

async function loadDeckFromFile(file) {
  debugLog(`Loading deck: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB)`);
  
  // Clean up memory from previous deck
  cleanupMemory();

  document.getElementById('deckName').textContent = file.name;
  
  // Store current deck name for field mapping
  window.currentDeckName = file.name;

// Attempt to load saved field mappings for this deck *before* processing notes
window.currentFieldMappings = await getSavedFieldMappings(file.name);
if (window.currentFieldMappings) {
  debugLog(`✅ Loaded saved field mappings for ${file.name}: ` +
           JSON.stringify(window.currentFieldMappings));
} else {
  debugLog(`ℹ️ No saved field mappings for ${file.name}`);
}


  try {
    // Load the deck normally...
    debugLog("Loading ZIP file into memory...");
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    currentZip = zip; // Store reference

    debugLog("✅ Successfully loaded ZIP file");

    // Handle media files with better error handling
    let media = {};
    try {
      if (zip.file("media")) {
        const mediaContent = await zip.file("media").async("string");
        media = safeJsonParse(mediaContent, {});
        debugLog(`Loaded media manifest with ${Object.keys(media).length} files`);
      }
    } catch (mediaError) {
      debugLog(`Warning: Could not load media manifest: ${mediaError.message}`);
      media = {};
    }

    // Create media file promises (don't load immediately)
    const mediaPromises = {};
    
    for (const [id, name] of Object.entries(media)) {
      if (zip.file(id)) {
        // Store promise instead of loading immediately
        mediaPromises[name] = async () => {
          try {
            const blob = await zip.file(id).async("base64");
            const ext = name.split('.').pop().toLowerCase();
            let mime = "application/octet-stream";
            if (["mp3", "m4a", "aac", "wav", "ogg"].includes(ext)) mime = `audio/${ext}`;
            if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
            return `data:${mime};base64,${blob}`;
          } catch (error) {
            debugLog(`Error loading media file ${name}: ${error.message}`);
            return null;
          }
        };
      }
    }

    // Load the collection database
    let dbFile;
    if (zip.file("collection.anki2")) {
      debugLog("Loading collection.anki2");
      dbFile = await zip.file("collection.anki2").async("arraybuffer");
    } else if (zip.file("collection.anki21b")) {
      debugLog("⚠️ Found collection.anki21b - attempting to load (may have compatibility issues)");
      dbFile = await zip.file("collection.anki21b").async("arraybuffer");
    } else {
      throw new Error("No collection database found in the deck file");
    }

    const db = new SQL.Database(new Uint8Array(dbFile));
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
    await loadFieldMappings(file.name);

    // START PROGRESSIVE LOADING - This will show first cards immediately!
    debugLog("🚀 Starting progressive loading...");
    await startProgressiveNoteProcessing(noteRows, models, mediaPromises);

    debugLog(`✅ Deck ready! ${noteRows[0].values.length} total notes loaded.`);

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
    
    // Clear validation variables on error too
    window.expectedDeckName = undefined;
    window.pendingCardIndex = undefined;
    
    alert(`Error loading deck: ${error.message}\n\nCheck the debug console for more details.`);
    
    // Clean up on error
    cleanupMemory();
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
      <div id="srtCardWaveform" style="width:90%;max-width:520px;margin:18px auto 0;"></div>
    `;
    if (window.wrapSubtitleTokens) window.wrapSubtitleTokens();
    if (window.syncReadingToCard) {
      try { window.syncReadingToCard(card.expression); } catch (e) {}
    }
    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
    if (bg && card.audiobookPath && card.audiobookStartMs != null) {
      const url = card.audiobookPath.startsWith('file://') ? card.audiobookPath : 'file://' + card.audiobookPath;
      _srtCardEndMs = card.audiobookEndMs || 0;
      _ensureBgListenersForSrtCards();
      // When a cross-mode sync (e.g., switching to card mode while audio
      // was already playing) brought us here, audio is already at the
      // right position. Re-issuing bg.play would back-jump to startMs.
      // Just keep _srtCardEndMs armed and let auto-advance take over.
      // Also suppressed by startupAutoPlayBlocked on first launch so the
      // user gets a silent app open.
      if (window._skipNextCardAudioRestart || window.startupAutoPlayBlocked) {
        if (window.startupAutoPlayBlocked) window.startupAutoPlayBlocked = false;
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
    // will use the adjusted bounds.
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
      window.startupAutoPlayBlocked = false;
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
          const view = document.getElementById('readingModeView');
          return !!(view && view.style.display !== 'none' && target && view.contains(target));
        };
        const libraryOpen = () => {
          const lib = document.getElementById('libraryPage');
          return !!(lib && lib.classList.contains('visible'));
        };
        const inWaveform = (target) => !!(target?.closest && target.closest('#srtCardWaveform'));
        // Block card swipes whenever a modal is up (preferences / edit title /
        // reentry / etc.) so vertical scroll inside the modal doesn't fire
        // card-mode replay or send-to-Anki.
        const inModal = (target) => {
          if (document.body.classList.contains('prefs-open')) return true;
          return !!(target?.closest && target.closest(
            '#preferencesModal, #titleEditModal, #audiobookReentryModal, #readingSettingsModal, #readingStatsModal, .shell-menu'
          ));
        };

        const touchStartHandler = (e) => {
          if (libraryOpen()) return;
          if (inReadingView(e.target)) return;
          if (inWaveform(e.target)) return;
          if (inModal(e.target)) return;
          if (e.touches && e.touches[0]) {
            touchStartY = e.touches[0].clientY;
            touchStartX = e.touches[0].clientX;
          }
        };

        const touchEndHandler = async (e) => {
          if (libraryOpen()) return;
          if (inReadingView(e.target)) return;
          if (inWaveform(e.target)) return;
          if (inModal(e.target)) return;
          if (!e.changedTouches || !e.changedTouches[0] || !allNotes || allNotes.length === 0) {
            return;
          }
          
          const deltaY = e.changedTouches[0].clientY - touchStartY;
          const deltaX = e.changedTouches[0].clientX - touchStartX;

          if (Math.abs(deltaX) > Math.abs(deltaY)) {
            if (deltaX < -30 && currentCardIndex < allNotes.length - 1) {
              updateCardIndex(currentCardIndex + 1);
            } else if (deltaX > 30 && currentCardIndex > 0) {
              updateCardIndex(currentCardIndex - 1);
            }
          } else {
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
              // Skip upswipes that start in the bottom 1/5 of the screen — that
              // zone is Android's system app-switcher gesture, and we don't want
              // to double-fire a send-to-Anki on every app switch.
              if (touchStartY > window.innerHeight * 0.8) {
                return;
              }
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
                if (card.isSrtCard && card.audiobookPath && window.Capacitor?.Plugins?.AudioSlicer) {
                  let finalStart = Math.round(card.audiobookStartMs);
                  let finalEnd   = Math.round(card.audiobookEndMs);
                  if (window.waveform?.edit) {
                    const result = await window.waveform.edit({
                      srcPath: card.audiobookPath,
                      startMs: finalStart,
                      endMs:   finalEnd,
                      title: expression
                    });
                    if (!result) return; // user cancelled
                    finalStart = Math.round(result.startMs);
                    finalEnd   = Math.round(result.endMs);
                    // Persist the adjusted bounds back into the in-memory card
                    // so the next replay/next-card transition uses them too.
                    card.audiobookStartMs = finalStart;
                    card.audiobookEndMs   = finalEnd;
                  }
                  try {
                    const slicer = window.Capacitor.Plugins.AudioSlicer;
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
                sendToAnki({ expression, imageData, audioData });
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

  // Title-based auto-restore — preferred entry point. Picks the
  // most-recently-opened Title and either (a) bypasses legacy deck restore
  // entirely for deck-less Titles (SRT-cards / EPUB-only), or (b) mirrors
  // the deck attachment into the legacy keys so the existing flow restores
  // the same deck loadDeckState already knows how to handle.
  const titleLoaded = await autoRestoreFromTitles();
  debugLog(`Title-based restore: ${titleLoaded}`);

  let restored = titleLoaded;
  if (!titleLoaded) {
    debugLog("Attempting legacy deck restore...");
    restored = await loadDeckState();
    debugLog(`Legacy deck restore: ${restored}`);
  }
  
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

if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SplashScreen) {
  Capacitor.Plugins.SplashScreen.hide();
}

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
  bg.addListener('state', (d) => { window._bgPlaying = !!d.playing; });
  bg.addListener('position', (d) => {
    if (!_srtCardEndMs) return;
    // Auto-pause / auto-advance is only for CARD mode. In read or audio
    // mode the user expects audio to flow past cue boundaries.
    if (!document.body.classList.contains('mode-card')) return;
    if ((d.positionMs || 0) >= _srtCardEndMs - 50) {
      _srtCardEndMs = 0; // disarm
      try { bg.pause(); } catch (e) {}
      if (window.audioAutoAdvance && Array.isArray(allNotes) && currentCardIndex < allNotes.length - 1) {
        if (typeof goToNextCard === 'function') goToNextCard();
      }
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

window.loadTitleAsSrtCards = async function (title) {
  const ab = title?.attachments?.audiobook;
  const srtAtt = title?.attachments?.srt;
  if (!ab || !srtAtt || !window.srtParser) return false;

  // Read + parse SRT.
  let cues = [];
  try {
    const url = (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function')
      ? window.Capacitor.convertFileSrc(srtAtt.cachePath)
      : ('file://' + srtAtt.cachePath);
    const res = await fetch(url);
    if (!res.ok) throw new Error('SRT fetch status ' + res.status);
    const text = await res.text();
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

  displayCard();
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
  // SRT-card mode delegates to BackgroundAudio plugin state.
  if (_currentCardIsSrtCard()) return !!window._bgPlaying;
  return !!(currentAudio && !currentAudio.paused && !currentAudio.ended);
};

window.toggleReadingPlayback = function () {
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
});

/* Periodic persistence */
setInterval(() => {
  setPersistent('STOPWATCH_ELAPSED', stopwatchSeconds);
  setPersistent('NOTE_COUNTER', viewedNotes.size);
}, 5000);
