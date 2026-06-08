// ==================== INTEGRATED YOMITAN + ENHANCED DICTIONARY SYSTEM ====================
// This version combines Yomitan dictionary support with the existing enhanced dictionary functionality

(function() {
    'use strict';
    
    console.log('📊 Integrated Yomitan Dictionary System loading...');
    
    // Global variables
    let dictionaries = new Map(); // Dictionary name -> entries map
    let dictionaryMetadata = new Map(); // Dictionary name -> metadata
    let currentLookupResults = []; // Current lookup results for navigation
    let currentResultIndex = 0; // Current result being displayed
    let currentLookupToken = 0; // Cancellation token for performDictLookupAtPosition
    let dictLoaded = false;
    let rules = [];
    let rulesLoaded = false;
    let lastHovered = [];
    let touchTimer = null;

    // ==================== DICTIONARY SCANNING ====================
    
    async function scanDictionaryFiles() {
        console.log('📚 Dynamically scanning for .zip dictionary files...');
        
        try {
            const yourDictionaries = [
                // No dictionaries are bundled in the app any more — the
                // monolingual dictionaries were copyrighted commercial products
                // and can't be redistributed. Users import their own via
                // Preferences → Dictionaries (stored in dictStore). Empty list =
                // nothing scanned or loaded from app assets.
            ];
            
            console.log(`📚 Checking ${yourDictionaries.length} specified dictionaries...`);
            let availableDictionaries = [];
            
            // Test your specific dictionaries first
            for (const filename of yourDictionaries) {
                try {
                    console.log(`📚 Testing specified dictionary: ${filename}`);
                    const url = `assets/dictionaries/${filename}`;
                    console.log(`📚 Full URL: ${url}`);
                    
                    const response = await fetch(url, { 
                        method: 'HEAD',
                        cache: 'no-cache' 
                    });
                    
                    console.log(`📚 Response for ${filename}: status=${response.status}, ok=${response.ok}`);
                    
                    if (response.ok) {
                        console.log(`✅ Found specified dictionary: ${filename}`);
                        availableDictionaries.push(filename);
                    } else {
                        console.log(`❌ Specified dictionary not found: ${filename} (HTTP ${response.status})`);
                    }
                } catch (error) {
                    console.log(`❌ Error checking specified dictionary ${filename}: ${error.message}`);
                }
            }
            
            // If we still haven't found anything, let's try a broader search
            if (availableDictionaries.length === 0) {
                console.log('📚 No files found with specific names, trying common patterns...');
                
                const commonPatterns = [
                    // (none — no bundled dictionaries to discover)
                ];
                
                for (const filename of commonPatterns) {
                    try {
                        const response = await fetch(`assets/dictionaries/${filename}`, { 
                            method: 'HEAD',
                            cache: 'no-cache' 
                        });
                        
                        console.log(`📚 Pattern test ${filename}: status=${response.status}`);
                        
                        if (response.ok) {
                            console.log(`✅ Found pattern match: ${filename}`);
                            availableDictionaries.push(filename);
                        }
                    } catch (error) {
                        // Continue silently
                    }
                }
            }
            
            console.log(`📚 Final scan result: found ${availableDictionaries.length} dictionaries:`, availableDictionaries);
            return availableDictionaries;
            
        } catch (error) {
            console.error('❌ Dictionary scanning failed:', error);
            return [];
        }
    }

    // ==================== STARTUP PROGRESS BAR ====================
    
    function showStartupProgress() {
        // Create non-modal progress bar positioned at bottom of image area
        const progressBar = document.createElement('div');
        progressBar.id = 'dictionaryLoadingBar';
        Object.assign(progressBar.style, {
            position: 'fixed',
            bottom: '100px', // Above the card progress bar and control bar (64px + 36px margin)
            left: '10%',
            width: '80%',
            height: '50px',
            background: 'rgba(17, 17, 17, 0.95)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            boxSizing: 'border-box',
            zIndex: 9998, // Below dictionary popup but above everything else
            border: '2px solid #4caf50',
            borderRadius: '8px',
            fontSize: '13px',
            backdropFilter: 'blur(5px)',
            WebkitBackdropFilter: 'blur(5px)'
        });
        
        progressBar.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex:1;">
                <div style="font-size:.7rem;letter-spacing:.12em;font-weight:600;color:#888;">DICT</div>
                <div>
                    <div id="startupStatus" style="font-weight:600; margin-bottom:1px; font-size:13px;">Loading dictionaries...</div>
                    <div id="startupDetails" style="color:#ccc; font-size:11px;">Initializing...</div>
                </div>
            </div>
            <div style="flex:1; max-width:150px; margin:0 12px;">
                <div style="width:100%; height:5px; background:#333; border-radius:2px; overflow:hidden;">
                    <div id="startupProgressBar" style="width:0%; height:100%; background:#4caf50; transition:width 0.5s ease;"></div>
                </div>
            </div>
            <div id="startupPercent" style="font-weight:600; min-width:35px; text-align:right; font-size:13px;">0%</div>
        `;
        
        document.body.appendChild(progressBar);
        return progressBar;
    }
    
    function updateStartupProgress(message, progress = 0, details = '') {
        const status = document.getElementById('startupStatus');
        const progressBar = document.getElementById('startupProgressBar');
        const detailsEl = document.getElementById('startupDetails');
        const percentEl = document.getElementById('startupPercent');
        
        if (status) status.textContent = message;
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (detailsEl) detailsEl.textContent = details;
        if (percentEl) percentEl.textContent = `${Math.round(progress)}%`;
    }
    
    function hideStartupProgress() {
        const progressBar = document.getElementById('dictionaryLoadingBar');
        if (progressBar) {
            // Fade out animation
            progressBar.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            progressBar.style.opacity = '0';
            progressBar.style.transform = 'translateY(20px)';
            
            setTimeout(() => {
                if (progressBar.parentNode) { // Check if still in DOM
                    progressBar.remove();
                }
            }, 500);
        }
    }
    
    async function loadYomitanDictionaries() {
        console.log('📚 Loading Yomitan dictionaries...');

        // User pref: ship-with-JMDict-only by default. The user can opt
        // back in to bundled monolingual dictionaries via the
        // SKIP_BUNDLED_DICTS=false pref.
        try {
            const raw = localStorage.getItem('SKIP_BUNDLED_DICTS');
            // Default true unless explicitly set to "false"
            const skip = raw === null ? true : (raw !== 'false');
            if (skip) {
                console.log('[dict] Bundled monolingual dicts disabled (SKIP_BUNDLED_DICTS=true). User can import via Preferences → Dictionaries.');
                return;
            }
        } catch (e) {}

        try {
            // Show startup progress
            showStartupProgress();
            updateStartupProgress('Scanning for dictionaries...', 5);

            // Scan for dictionary zip files
            const dictionaryFiles = await scanDictionaryFiles();
            
            if (dictionaryFiles.length === 0) {
                console.log('⚠️ No Yomitan dictionaries found, will use JMDict only');
                updateStartupProgress('No Yomitan dictionaries found', 100, 'Using JMDict only');
                setTimeout(hideStartupProgress, 1000);
                return;
            }
            
            updateStartupProgress(`Found ${dictionaryFiles.length} dictionaries`, 10, 'Beginning dictionary loading...');
            
            // Load each dictionary with progress updates
            for (let i = 0; i < dictionaryFiles.length; i++) {
                const filename = dictionaryFiles[i];
                const progressStart = 10 + (i / dictionaryFiles.length) * 80; // 10% to 90%
                const progressEnd = 10 + ((i + 1) / dictionaryFiles.length) * 80;
                
                try {
                    updateStartupProgress(`Loading ${filename}...`, progressStart, `Dictionary ${i + 1} of ${dictionaryFiles.length}`);
                    await loadSingleDictionary(filename, (bankProgress) => {
                        // Update progress within this dictionary
                        const currentProgress = progressStart + (bankProgress / 100) * (progressEnd - progressStart);
                        updateStartupProgress(`Loading ${filename}...`, currentProgress, `Processing term banks...`);
                    });
                } catch (error) {
                    console.error(`❌ Failed to load dictionary ${filename}:`, error);
                    updateStartupProgress(`Failed to load ${filename}`, progressStart, `Continuing with other dictionaries...`);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause to show error
                }
            }
            
            updateStartupProgress('Finalizing dictionaries...', 95, 'Almost ready!');
            console.log(`✅ Loaded ${dictionaries.size} Yomitan dictionaries`);
            
        } catch (error) {
            console.error('❌ Yomitan dictionary loading failed:', error);
            updateStartupProgress('Dictionary loading failed', 100, 'Will use JMDict only');
            setTimeout(hideStartupProgress, 2000);
        }
    }
    
    // Bump YOMITAN_CACHE_VERSION to invalidate ALL cached Yomitan dicts
    // (do this when you swap zip files or change the parser logic).
    const YOMITAN_CACHE_VERSION = '1';

    async function loadSingleDictionary(filename, progressCallback = null) {
        console.log(`📚 Loading dictionary: ${filename}`);

        // 1) Cache hit path — skip fetch + unzip + parse entirely.
        if (window.dictCache && typeof window.dictCache.load === 'function') {
            try {
                const cached = await window.dictCache.load('Yomitan:' + filename, YOMITAN_CACHE_VERSION);
                if (cached && cached.termEntries && cached.metadata) {
                    const dictName = cached.metadata.title || filename.replace('.zip', '');
                    dictionaries.set(dictName, cached.termEntries);
                    dictionaryMetadata.set(dictName, cached.metadata);
                    if (progressCallback) progressCallback(100);
                    console.log(`✅ ${dictName} from cache: ${cached.termEntries.size} indexed terms`);
                    return;
                }
            } catch (e) {
                console.warn(`Yomitan cache load failed for ${filename}:`, e);
            }
        }

        try {
            // Fetch the zip file
            const response = await fetch(`assets/dictionaries/${filename}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch ${filename}: ${response.status}`);
            }
            
            console.log(`📚 Downloaded ${filename}, extracting...`);
            const arrayBuffer = await response.arrayBuffer();
            const zip = new JSZip();
            const zipData = await zip.loadAsync(arrayBuffer);
            
            // Load index.json for metadata
            const indexFile = zipData.file('index.json');
            if (!indexFile) {
                throw new Error(`No index.json found in ${filename}`);
            }
            
            const indexData = JSON.parse(await indexFile.async('text'));
            const dictName = indexData.title || filename.replace('.zip', '');
            
            console.log(`📚 Loading dictionary: ${dictName} (revision: ${indexData.revision || 'unknown'})`);
            
            // Store metadata
            dictionaryMetadata.set(dictName, {
                ...indexData,
                filename: filename
            });
            
            // Count total term banks first
            let totalBanks = 0;
            let bankIndex = 1;
            while (zipData.file(`term_bank_${bankIndex}.json`)) {
                totalBanks++;
                bankIndex++;
            }
            
            console.log(`📚 Found ${totalBanks} term banks in ${dictName}`);
            
            // Load all term banks with progress tracking
            const termEntries = new Map();
            bankIndex = 1;
            let totalEntries = 0;
            
            while (true) {
                const bankFile = zipData.file(`term_bank_${bankIndex}.json`);
                if (!bankFile) break;
                
                console.log(`📚 Loading term_bank_${bankIndex}.json...`);
                
                // Update progress if callback provided
                if (progressCallback) {
                    const bankProgress = ((bankIndex - 1) / totalBanks) * 100;
                    progressCallback(bankProgress);
                }
                
                const bankData = JSON.parse(await bankFile.async('text'));
                
                // Index each entry
                for (const entry of bankData) {
                    const [term, reading] = entry;
                    
                    // Index by both term and reading
                    if (!termEntries.has(term)) {
                        termEntries.set(term, []);
                    }
                    termEntries.get(term).push(entry);
                    
                    if (reading && reading !== term) {
                        if (!termEntries.has(reading)) {
                            termEntries.set(reading, []);
                        }
                        termEntries.get(reading).push(entry);
                    }
                    
                    totalEntries++;
                }
                
                bankIndex++;
            }
            
            // Final progress update
            if (progressCallback) {
                progressCallback(100);
            }
            
            dictionaries.set(dictName, termEntries);
            console.log(`✅ Loaded ${dictName} with ${termEntries.size} indexed terms (${totalEntries} total entries)`);

            // 2) Persist for next launch.
            if (window.dictCache && typeof window.dictCache.save === 'function') {
                window.dictCache.save('Yomitan:' + filename, YOMITAN_CACHE_VERSION, {
                    termEntries,
                    metadata: { ...indexData, filename }
                }).catch(err => console.warn(`Yomitan cache save failed for ${filename}:`, err));
            }

        } catch (error) {
            console.error(`❌ Failed to load ${filename}:`, error);
            throw error;
        }
    }

    // ==================== USER-IMPORTED YOMITAN DICTIONARIES ====================
    //
    // Parses a user-supplied Yomitan dictionary zip (ArrayBuffer or Blob),
    // ingests it into the runtime maps, and caches the parsed index in
    // IndexedDB so subsequent app launches restore it instantly. A registry
    // of imported names is kept in localStorage so we know what to reload.

    const IMPORTED_LIST_KEY = 'IMPORTED_DICTS_V1';
    const IMPORTED_CACHE_PREFIX = 'YomitanImport:';
    const IMPORTED_CACHE_VERSION = '1';

    function listImportedDicts() {
        try {
            const raw = localStorage.getItem(IMPORTED_LIST_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }
    function persistImportedList(list) {
        try { localStorage.setItem(IMPORTED_LIST_KEY, JSON.stringify(list)); } catch (e) {}
    }

    async function ingestZipBuffer(arrayBuffer, opts) {
        opts = opts || {};
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
        onProgress({ phase: 'unzip', pct: 0 });
        const zip = await JSZip.loadAsync(arrayBuffer);
        const indexFile = zip.file('index.json');
        if (!indexFile) throw new Error('Not a Yomitan dictionary: index.json missing');
        const indexData = JSON.parse(await indexFile.async('text'));
        const dictName = (indexData.title || opts.fallbackName || 'Imported').trim();
        if (!dictName) throw new Error('Dictionary has no title');

        // Count banks first so we can drive a real progress bar.
        let bankCount = 0;
        while (zip.file(`term_bank_${bankCount + 1}.json`)) bankCount++;

        const termEntries = new Map();
        let totalEntries = 0;
        for (let b = 1; b <= bankCount; b++) {
            const bankData = JSON.parse(await zip.file(`term_bank_${b}.json`).async('text'));
            for (const entry of bankData) {
                const [term, reading] = entry;
                if (!termEntries.has(term)) termEntries.set(term, []);
                termEntries.get(term).push(entry);
                if (reading && reading !== term) {
                    if (!termEntries.has(reading)) termEntries.set(reading, []);
                    termEntries.get(reading).push(entry);
                }
                totalEntries++;
            }
            onProgress({ phase: 'parse', pct: b / bankCount, banks: b, totalBanks: bankCount });
            // Yield to the UI runloop so the progress text actually paints.
            await new Promise(r => setTimeout(r, 0));
        }
        if (totalEntries === 0) throw new Error('Dictionary has no term_bank entries');
        const metadata = { ...indexData, filename: opts.fallbackName || dictName + '.zip' };
        dictionaryMetadata.set(dictName, metadata);

        // Write to the indexed store — the authoritative, on-disk, query-on-demand
        // source. In the common case this is the ONLY copy we keep.
        let storeOk = false;
        if (window.dictStore?.importFromMap) {
            try {
                await window.dictStore.importFromMap(dictName, metadata, termEntries, (p) => {
                    onProgress({ phase: 'index', pct: p.pct, written: p.written, total: p.total });
                });
                storeOk = true;
            } catch (e) { console.warn('[dictStore] import write failed:', e); }
        }
        if (storeOk) {
            // dictStore has it -> DON'T keep a redundant in-memory Map copy (resident
            // heap that hurts the LMK/restart problem) or a full-Map dictCache copy
            // (a slow structured-clone write — the old "Saving…" step). Lookups query
            // dictStore directly via existsBulk/lookup.
            dictionaries.delete(dictName);
            dictStoreReadyCache = true; // store is now non-empty → lookups use it at once
        } else {
            // Fallback: the indexed write failed. Keep the in-memory copy AND cache it
            // so the dict still works (legacy path) and survives a reboot.
            dictionaries.set(dictName, termEntries);
            if (window.dictCache?.save) {
                onProgress({ phase: 'cache', pct: 0 });
                try {
                    await window.dictCache.save(IMPORTED_CACHE_PREFIX + dictName,
                        IMPORTED_CACHE_VERSION, { termEntries, metadata });
                } catch (e) {}
            }
        }
        onProgress({ phase: 'done', pct: 1 });
        // Track imported names.
        const list = listImportedDicts();
        if (!list.includes(dictName)) {
            list.push(dictName);
            persistImportedList(list);
        }
        console.log(`✅ Imported "${dictName}" with ${termEntries.size} indexed terms (${totalEntries} entries)`);
        return dictName;
    }

    async function loadImportedDictionariesFromCache() {
        const list = listImportedDicts();
        if (!list.length) return;
        // Dicts that live in the indexed store need NO in-memory copy — lookups
        // query dictStore directly (existsBulk/lookup). Only restore (into the
        // legacy Map) dicts NOT in the store, e.g. an import whose store write
        // failed, so they still work via the in-memory fallback path.
        let storeNames = new Set();
        try {
            if (window.dictStore?.list) {
                storeNames = new Set((await window.dictStore.list()).map(m => m.dictName));
            }
        } catch (e) {}
        for (const name of list) {
            if (storeNames.has(name)) {
                // Served from dictStore → drop the now-redundant full-Map dictCache
                // copy left by older builds (reclaims disk; keeps zero heap copy).
                try { await window.dictCache?.clear?.(IMPORTED_CACHE_PREFIX + name); } catch (e) {}
                continue;
            }
            if (dictionaries.has(name)) continue;
            try {
                const cached = await window.dictCache?.load?.(IMPORTED_CACHE_PREFIX + name, IMPORTED_CACHE_VERSION);
                if (cached?.termEntries) {
                    dictionaries.set(name, cached.termEntries);
                    if (cached.metadata) dictionaryMetadata.set(name, cached.metadata);
                    console.log(`✅ Restored imported dict "${name}" from cache (fallback): ${cached.termEntries.size} terms`);
                }
            } catch (e) {
                console.warn(`Failed to restore imported dict "${name}":`, e);
            }
        }
    }

    async function removeImportedDictionary(name, onProgress) {
        dictionaries.delete(name);
        dictionaryMetadata.delete(name);
        const list = listImportedDicts().filter(n => n !== name);
        persistImportedList(list);
        try { await window.dictCache?.clear?.(IMPORTED_CACHE_PREFIX + name); } catch (e) {}
        // Remove from the indexed store too — otherwise the dict lingers there,
        // keeps being served in lookups, and re-importing duplicates it (the
        // 'deleted dict shows up twice' relic). Batched remove, so it can't hang.
        try { await window.dictStore?.remove?.(name, onProgress); } catch (e) {}
        dictStoreReadyCache = null; // re-probe: store may now be empty
        console.log(`🗑 Removed imported dict "${name}"`);
    }

    window.importYomitanDictionaryFromBuffer = async function (arrayBuffer, opts) {
        return await ingestZipBuffer(arrayBuffer, opts);
    };
    window.listImportedDictionaries = listImportedDicts;
    window.removeImportedDictionary = removeImportedDictionary;
    window.loadImportedDictionariesFromCache = loadImportedDictionariesFromCache;

    // ==================== JMDICT REMOVED ====================
    //
    // The bundled JMdict_english.json (108 MB) and its in-memory load were
    // removed: holding the parsed ~125k-entry Map resident made the WebView
    // process a prime target for Android's Low-Memory Killer (the "app
    // restarts on unlock" bug). English coverage now comes from the user's
    // imported JP->EN dictionary (Preferences -> Dictionaries), served via
    // dictStore. This one-time helper reclaims the orphaned 108 MB IDB copy
    // left by older builds.
    async function purgeStaleJMDictCache() {
        try {
            if (localStorage.getItem('JMDICT_CACHE_PURGED_V1') === '1') return;
            if (window.dictCache && typeof window.dictCache.clear === 'function') {
                await window.dictCache.clear('JMDict');
            }
            localStorage.setItem('JMDICT_CACHE_PURGED_V1', '1');
            console.log('[dict] purged stale JMDict IDB cache');
        } catch (e) { /* best-effort */ }
    }

    // One-time cleanup of a JMDict copy that an OLDER build migrated into the
    // indexed dictStore. The 108 MB bundle + in-memory load are gone, but a
    // migrated copy would otherwise (a) keep ~405k entries that buildTermSet must
    // scan every boot (the multi-second 'Initializing Dictionaries…' the user
    // saw) and (b) keep serving JMDict glosses in lookups — defeating the whole
    // removal. GATED: only drop it when ANOTHER dict exists, so a user whose only
    // dictionary is the migrated JMDict is never left with zero coverage.
    async function purgeStaleJMDictFromStore() {
        try {
            if (localStorage.getItem('JMDICT_STORE_PURGED_V1') === '1') return;
            if (!window.dictStore || !window.dictStore.list || !window.dictStore.remove) return;
            const names = (await window.dictStore.list()).map(m => m.dictName);
            const jmNames = names.filter(n => n === 'JMDict' || n === 'JMdict');
            const others  = names.filter(n => n !== 'JMDict' && n !== 'JMdict');
            if (jmNames.length && others.length) {
                for (const n of jmNames) {
                    await window.dictStore.remove(n);
                    console.log('[dict] removed stale dictStore JMDict copy:', n);
                }
                localStorage.setItem('JMDICT_STORE_PURGED_V1', '1');
            } else if (!jmNames.length) {
                localStorage.setItem('JMDICT_STORE_PURGED_V1', '1'); // nothing to purge
            }
            // jmNames present but NO other dict → leave it (don't strand the user).
        } catch (e) { /* best-effort */ }
    }

    // ==================== MULTI-DICTIONARY LOOKUP ====================
    //
    // Two paths:
    //   FAST: window.dictStore (IDB-indexed) is populated → single
    //         async getAll() into the on-disk index, ~5-10 ms regardless
    //         of dictionary count or size. Same on-disk-index architecture
    //         Yomitan / Jidoujisho use. No in-memory entry maps.
    //   SLOW: legacy in-memory Map (dictionaries) populated by ensureJM().
    //         Triggered on first launch / after re-import.
    //
    // We also opportunistically MIGRATE: after a slow lookup hits, we
    // background-write the loaded Maps into dictStore so subsequent boots
    // skip ensureJM() entirely.

    let dictStoreReadyCache = null;     // null = unknown, bool once probed
    let dictStoreMigrationStarted = false;
    async function isDictStoreReady() {
        if (dictStoreReadyCache === true) return true; // re-probe while false: an import may have populated it
        if (!window.dictStore) { dictStoreReadyCache = false; return false; }
        try {
            dictStoreReadyCache = await window.dictStore.isPopulated();
        } catch (e) {
            dictStoreReadyCache = false;
        }
        return dictStoreReadyCache;
    }

    function enabledNameSet(allNames) {
        const isEnabled = (n) => window.dictPrefs?.isEnabled
            ? window.dictPrefs.isEnabled(n) : true;
        const out = new Set();
        for (const n of allNames) if (isEnabled(n)) out.add(n);
        return out;
    }

    async function migrateInMemoryToStore() {
        if (dictStoreMigrationStarted) return;
        dictStoreMigrationStarted = true;
        if (!window.dictStore) return;
        try {
            for (const [name, termEntries] of dictionaries) {
                if (!(termEntries instanceof Map)) continue;
                // We don't track per-dict meta in a Map — pass the name as
                // both title + filename. Good enough for the manager UI.
                const meta = { title: name, filename: name, revision: 'migrated' };
                await window.dictStore.importFromMap(name, meta, termEntries);
                console.log(`[dictStore] migrated "${name}" (${termEntries.size} headwords)`);
            }
            dictStoreReadyCache = true;
        } catch (e) {
            console.warn('[dictStore] migration failed:', e);
        }
    }

    async function multiDictionaryLookup(term) {
        // Query BOTH paths and merge — the previous early-return on the
        // dictStore path meant JMDict (still in the legacy in-memory
        // `dictionaries` Map prior to migration) never got a chance to
        // answer when dictStore had user-imported dicts but those dicts
        // didn't happen to contain the looked-up base form. Result:
        // common conjugated verbs/adjs (高かった → 高い) failed to resolve
        // because the user's 2 monolingual dicts didn't have 高い but
        // JMDict did. Merging guarantees coverage.
        const _t0 = performance.now();
        const ms = () => Math.round(performance.now() - _t0);
        const results = [];
        // Tracks which dicts dictStore is authoritative for. Used to
        // prevent the in-memory path from re-pushing the same dict's
        // entries — replaces a (dictName, term) seen-set whose collision
        // semantics were too coarse: when JMDict has multiple entries
        // for the same surface (e.g. 認める → みとめる + したためる), the
        // (dict, term)-keyed dedup dropped all but the first record so
        // the popup never showed the less-frequent reading at all.
        const dictsHandledByStore = new Set();

        // Rank entries within a dict by frequency / priority hints so
        // common readings come first. Without this, JMDict returns
        // entries in source-file order (≈ sequence ID), which has zero
        // correlation with usage frequency — e.g. 誘う surfaces as
        // いざなう before さそう, and 認める as したためる before みとめる.
        function entryPriorityScore(dictName, entry) {
            if (!entry) return 0;
            if (dictName === 'JMDict') {
                // Yomitan-converted JMDict marks common entries with a
                // "P" tag on the kanji or kana objects. Some converters
                // also preserve raw JMdict re_pri/ke_pri arrays under
                // `.pri`. Sum both signals; higher = more common.
                let s = 0;
                const collect = (arr) => {
                    for (const k of (arr || [])) {
                        if (Array.isArray(k.tags) && k.tags.includes('P')) s += 10;
                        if (Array.isArray(k.pri)) s += k.pri.length;
                    }
                };
                collect(entry.kanji);
                collect(entry.kana);
                return s;
            }
            // Yomitan v3 array entry: [term, reading, defTags, rules,
            // score, glossary, sequence, termTags]. score (index 4) is
            // the dict's intrinsic ranking field — higher = better.
            if (Array.isArray(entry)) return Number(entry[4]) || 0;
            return 0;
        }

        // ----- Fast path: dictStore (IDB-indexed) -----
        if (await isDictStoreReady()) {
            try {
                const meta = await window.dictStore.list();
                console.log(`⏱   [lookup] dictStore.list: +${ms()}ms`);
                const allNames = meta.map(m => m.dictName);
                for (const n of allNames) dictsHandledByStore.add(n);
                const ordered = (window.dictPrefs?.orderedNames)
                  ? window.dictPrefs.orderedNames(allNames)
                  : allNames;
                const enabled = enabledNameSet(allNames);
                const records = await window.dictStore.lookup(term, { enabledDicts: enabled });
                console.log(`⏱   [lookup] dictStore.lookup("${term}"): +${ms()}ms → ${records.length} records`);
                const orderIdx = new Map(ordered.map((n, i) => [n, i]));
                // Two-key sort: dict order first, then priority within
                // each dict (descending — common entries first). JS sort
                // is stable on V8/JSC so the within-dict order is honored.
                records.sort((a, b) => {
                    const dictDiff = (orderIdx.get(a.dictName) ?? 999) - (orderIdx.get(b.dictName) ?? 999);
                    if (dictDiff !== 0) return dictDiff;
                    return entryPriorityScore(b.dictName, b.entry) -
                           entryPriorityScore(a.dictName, a.entry);
                });
                for (const r of records) {
                    results.push({
                        dictionary: r.dictName,
                        term:       r.term,
                        entry:      r.entry,
                        type:       r.dictName === 'JMDict' ? 'jmdict' : 'yomitan'
                    });
                }
            } catch (e) {
                console.warn('dictStore lookup failed for', term, e);
            }
        }

        // ----- Legacy path: in-memory `dictionaries` Map -----
        // Only consult dicts that dictStore doesn't already own — when a
        // dict has been migrated to dictStore, the records above are the
        // authoritative copy and pushing again would duplicate everything.
        const _memT = performance.now();
        if (dictionaries.size > 0) {
            const allNames = Array.from(dictionaries.keys());
            const ordered = (window.dictPrefs?.orderedNames)
              ? window.dictPrefs.orderedNames(allNames)
              : allNames;
            const isEnabled = (n) => window.dictPrefs?.isEnabled
                ? window.dictPrefs.isEnabled(n) : true;
            for (const dictName of ordered) {
                if (dictsHandledByStore.has(dictName)) continue;
                if (!isEnabled(dictName)) continue;
                const entries = dictionaries.get(dictName);
                if (!entries || !entries.has(term)) continue;
                const dictEntries = entries.get(term);
                // Sort by priority score within this dict (stable copy).
                const sortedEntries = [...dictEntries].sort((a, b) =>
                    entryPriorityScore(dictName, b) - entryPriorityScore(dictName, a)
                );
                for (const entry of sortedEntries) {
                    results.push({
                        dictionary: dictName,
                        term: term,
                        entry: entry,
                        type: dictName === 'JMDict' ? 'jmdict' : 'yomitan'
                    });
                }
            }
            // Background-migrate so subsequent boots skip ensureJM. We
            // still always query both paths regardless — migration is for
            // load-time perf, not correctness.
            Promise.resolve().then(migrateInMemoryToStore);
        }
        console.log(`⏱   [lookup] in-memory scan: +${Math.round(performance.now() - _memT)}ms (${dictionaries.size} dicts)`);

        // Collapse byte-identical duplicate entries. Relic/duplicate store rows
        // (a dict imported under name variants like 'JMDict' vs 'JMdict', or
        // orphaned entries from an interrupted delete) produce repeated cards with
        // identical content; distinct senses/dicts have distinct content and are
        // preserved, so this only removes true duplicates.
        const _seenEntries = new Set();
        const deduped = [];
        for (const r of results) {
            let key = null;
            try { key = JSON.stringify(r.entry); } catch (e) {}
            if (key !== null) {
                if (_seenEntries.has(key)) continue;
                _seenEntries.add(key);
            }
            deduped.push(r);
        }
        console.log(`🔍 Found ${results.length} results for "${term}" → ${deduped.length} after dedup (store+mem) total +${ms()}ms`);
        return deduped;
    }

    // Expose currently-loaded dictionary names so the Preferences UI can
    // render the manager list. Empty until startup load completes.
    window.getLoadedDictionaryNames = function () {
        return Array.from(dictionaries.keys());
    };
    
    async function ensureJM() {
        if (dictLoaded) return;
        
        console.log('📚 Loading dictionaries...');
        
        try {
            updateStartupProgress('Loading dictionaries...', 0);
            await loadYomitanDictionaries();
            // User-imported Yomitan dictionaries (persisted in IDB).
            await loadImportedDictionariesFromCache();
            // Reclaim the orphaned 108 MB JMdict IDB cache from older builds.
            purgeStaleJMDictCache();

            
            updateStartupProgress('Dictionaries ready!', 100, 'All dictionaries loaded successfully');
            
            // Hide progress after brief delay
            setTimeout(() => {
                hideStartupProgress();
            }, 1000);
            
        } catch (error) {
            console.error('❌ Dictionary loading failed:', error);
            
            setTimeout(() => {
                hideStartupProgress();
            }, 1500);
        }
        
        dictLoaded = true;

        // No bundled fallback dictionary any more: if the user imported none
        // (and dictStore is empty) every lookup would silently return nothing.
        // Point them at the importer instead of failing in silence.
        try {
            let _storeCount = 0;
            if (window.dictStore && typeof window.dictStore.list === 'function') {
                try { _storeCount = (await window.dictStore.list()).length; } catch (_) {}
            }
            if (dictionaries.size === 0 && _storeCount === 0) {
                if (typeof window.showToast === 'function') {
                    window.showToast('No dictionary loaded — import one in Preferences → Dictionaries', 4000);
                } else {
                    console.warn('[dict] No dictionaries loaded — import one in Preferences → Dictionaries');
                }
            }
        } catch (_) {}
    }

    // ==================== DEINFLECTION FUNCTIONS (FROM EXISTING CODE) ====================
    
    function createTestRules() {
        return [
            { in: 'た', out: 'る', rulesIn: [], rulesOut: [] },
            { in: 'だ', out: 'る', rulesIn: [], rulesOut: [] },
            { in: 'んだ', out: 'む', rulesIn: [], rulesOut: [] },
            { in: 'いた', out: 'く', rulesIn: [], rulesOut: [] }
        ].sort((a, b) => b.in.length - a.in.length);
    }

    async function loadDeinflectRules() {
        if (rulesLoaded) return;
        
        console.log('🔧 Loading deinflection rules via fetch...');
        
        try {
            const res = await fetch('assets/dictionaries/deinflect.json');
            console.log('🔧 Deinflect fetch status:', res.status, res.statusText);
            
            if (!res.ok) {
                throw new Error(`Deinflect fetch failed: ${res.status} ${res.statusText}`);
            }
            
            console.log('🔧 Deinflect fetch successful, parsing JSON...');
            const raw = await res.json();
            console.log('🔧 Deinflect JSON parsed, found groups:', Object.keys(raw));
            
            const tempRules = [];
            for (const [groupName, group] of Object.entries(raw)) {
                console.log(`🔧 Processing group "${groupName}" with ${group.length} rules`);
                for (const rule of group) {
                    tempRules.push({
                        in: rule.kanaIn,
                        out: rule.kanaOut,
                        rulesIn: rule.rulesIn || [],
                        rulesOut: rule.rulesOut || [],
                    });
                }
            }
            
            rules = tempRules.sort((a, b) => b.in.length - a.in.length);
            console.log(`✅ Successfully loaded ${rules.length} deinflection rules`);
            
        } catch (error) {
            console.error('❌ Deinflection loading failed:', error);
            console.log('⚠️ Falling back to test deinflection rules');
            rules = createTestRules();
            console.log(`✅ Created ${rules.length} test deinflection rules`);
        }
        
        rulesLoaded = true;
    }

    // Reverted to ONLY the deinflect.json-based table. The Yomitan port
    // (yomitan-deinflect.js) is left on disk for future use but no
    // longer in the call path — its 834 rules × per-tap-iteration was
    // 14-43 s on iOS WKWebView; the 569-rule local table that powered
    // the Android build is fast enough and accurate enough for most
    // inflections we care about (〜た, 〜って, 〜せば, 〜ない, etc.).
    function getDeinflections(surface, maxDepth = 2) {
        const results = new Map();
        results.set(surface, { word: surface, depth: 0, reason: null });

        const queue = [{ word: surface, depth: 0, reason: null }];

        while (queue.length) {
            const cur = queue.shift();

            if (cur.depth >= maxDepth) continue;

            for (const rule of rules) {
                if (!cur.word.endsWith(rule.in)) continue;

                const stem = cur.word.slice(0, -rule.in.length);
                const newWord = stem + rule.out;

                if (results.has(newWord) || newWord.length < 1) continue;

                results.set(newWord, {
                    word: newWord,
                    reason: rule.in,
                    depth: cur.depth + 1,
                });

                queue.push({
                    word: newWord,
                    depth: cur.depth + 1,
                    reason: rule.in,
                });
            }
        }

        return Array.from(results.values());
    }

    // ==================== RENDERING FUNCTIONS ====================

    // ---- Furigana (ruby) for headwords --------------------------------------
    // Port of Yomitan's furigana-distribution: align the term's kana runs
    // (okurigana) against the reading and let the kanji runs absorb what's
    // left. Handles 食べる→食[た]べる, 食べ物→食[た]べ物[もの]; when a kanji run
    // can't be split unambiguously (e.g. 昨日→きのう) it falls back to ruby
    // over the whole run. No external data needed (that's the Tier-2 upgrade).
    function _isKanaCp(cp) {
        return (cp >= 0x3040 && cp <= 0x309f) ||   // hiragana
               (cp >= 0x30a0 && cp <= 0x30ff) ||   // katakana (+ prolonged mark)
               (cp >= 0xff66 && cp <= 0xff9d);      // halfwidth katakana
    }
    function _kataToHira(s) {
        let out = '';
        for (const ch of s) {
            const cp = ch.codePointAt(0);
            out += (cp >= 0x30a1 && cp <= 0x30f6) ? String.fromCodePoint(cp - 0x60) : ch;
        }
        return out;
    }
    function _segmentizeFurigana(reading, readingNorm, groups, start) {
        if (groups.length - start <= 0) return reading.length === 0 ? [] : null;
        const g = groups[start];
        if (g.isKana) {
            if (!readingNorm.startsWith(_kataToHira(g.text))) return null;
            const rest = _segmentizeFurigana(reading.slice(g.text.length),
                readingNorm.slice(g.text.length), groups, start + 1);
            if (rest === null) return null;
            rest.unshift({ text: g.text, reading: '' });
            return rest;
        }
        let result = null;
        for (let end = reading.length; end >= g.text.length; --end) {
            const rest = _segmentizeFurigana(reading.slice(end), readingNorm.slice(end), groups, start + 1);
            if (rest === null) continue;
            if (result !== null) return null;   // ambiguous → caller falls back to whole-run
            rest.unshift({ text: g.text, reading: reading.slice(0, end) });
            result = rest;
        }
        return result;
    }
    function distributeFurigana(term, reading) {
        if (!term) return [];
        if (!reading || reading === term) return [{ text: term, reading: '' }];
        const groups = [];
        let prev = null, isPrevKana = null;
        for (const ch of term) {
            const k = _isKanaCp(ch.codePointAt(0));
            if (k === isPrevKana) prev.text += ch;
            else { prev = { isKana: k, text: ch, reading: '' }; groups.push(prev); isPrevKana = k; }
        }
        const segs = _segmentizeFurigana(reading, _kataToHira(reading), groups, 0);
        return (segs && segs.length) ? segs : [{ text: term, reading: reading }];
    }
    function _escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    // → { html, hasRuby }. html is always the rendered headword (ruby where a
    // segment has a reading, plain otherwise); hasRuby=false for kana-only /
    // no-reading terms so callers can still show a plain reading line.
    // ---- Tier-2: JmdictFurigana dataset (precise per-kanji furigana) --------
    // 234k entries of `text|reading|spec` where spec is `idx:rt` or `start-end:rt`
    // segments (a range covers jukujikun like 今日→0-1:きょう). Loaded lazily +
    // parsed in chunks so it never blocks boot. When a (term,reading) is found
    // we split furigana per-kanji exactly (図書館 → 図[と]書[しょ]館[かん]);
    // otherwise we fall back to the okurigana algorithm above.
    let _furiMap = null, _furiLoading = false;
    async function loadFuriganaData() {
        if (_furiMap || _furiLoading) return;
        _furiLoading = true;
        try {
            const res = await fetch('assets/dictionaries/JmdictFurigana.txt');
            if (!res || !res.ok) { _furiLoading = false; return; }
            const text = await res.text();
            const lines = text.split('\n');
            const map = new Map();
            let i = 0;
            const CHUNK = 25000;
            (function step() {
                const end = Math.min(lines.length, i + CHUNK);
                for (; i < end; i++) {
                    let line = lines[i];
                    if (!line) continue;
                    if (i === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
                    const p1 = line.indexOf('|'); if (p1 < 0) continue;
                    const p2 = line.indexOf('|', p1 + 1); if (p2 < 0) continue;
                    map.set(line.slice(0, p1) + '\t' + line.slice(p1 + 1, p2), line.slice(p2 + 1).trimEnd());
                }
                if (i < lines.length) { setTimeout(step, 0); }
                else { _furiMap = map; _furiLoading = false; console.log('[furigana] dataset ready:', map.size, 'entries'); }
            })();
        } catch (e) { _furiLoading = false; console.warn('[furigana] load failed:', e?.message || e); }
    }
    window.loadFuriganaData = loadFuriganaData;
    // Char-index-based spec → segments. Indices are UTF-16 code units (matches
    // the dataset's .NET origin), so slice() on the raw string aligns correctly.
    function _segmentsFromSpec(text, spec) {
        const ranges = [];
        for (const part of spec.split(';')) {
            const c = part.indexOf(':'); if (c < 0) continue;
            const loc = part.slice(0, c), rt = part.slice(c + 1);
            const dash = loc.indexOf('-');
            let start, end;
            if (dash >= 0) { start = +loc.slice(0, dash); end = +loc.slice(dash + 1); }
            else { start = end = +loc; }
            if (Number.isInteger(start) && Number.isInteger(end)) ranges.push({ start, end, rt });
        }
        ranges.sort((a, b) => a.start - b.start);
        const segs = [];
        let idx = 0, ri = 0;
        while (idx < text.length) {
            if (ri < ranges.length && ranges[ri].start <= idx) {
                const r = ranges[ri++];
                const s = Math.max(idx, r.start), e = Math.min(r.end, text.length - 1);
                if (e >= s) segs.push({ text: text.slice(s, e + 1), reading: r.rt });
                idx = e + 1;
            } else {
                const nextStart = (ri < ranges.length) ? ranges[ri].start : text.length;
                if (nextStart > idx) { segs.push({ text: text.slice(idx, nextStart), reading: '' }); idx = nextStart; }
                else idx++;
            }
        }
        return segs;
    }
    function buildFuriganaRuby(term, reading) {
        let segs = null;
        // Precise per-kanji from the dataset when we have it; else the algorithm.
        if (_furiMap && term) {
            const spec = _furiMap.get(term + '\t' + (reading || ''));
            if (spec) { try { segs = _segmentsFromSpec(term, spec); } catch (_) {} }
        }
        if (!segs || !segs.length) segs = distributeFurigana(term, reading);
        let hasRuby = false, html = '';
        for (const s of segs) {
            const t = _escapeHtml(s.text);
            if (s.reading && s.reading !== s.text) {
                hasRuby = true;
                html += `<ruby>${t}<rt>${_escapeHtml(s.reading)}</rt></ruby>`;
            } else {
                html += t;
            }
        }
        return { html: html || _escapeHtml(term), hasRuby };
    }
    window.distributeFurigana = distributeFurigana;
    window.buildFuriganaRuby = buildFuriganaRuby;
    // Warm the dataset shortly after boot so the first lookup is already precise.
    setTimeout(() => { try { loadFuriganaData(); } catch (_) {} }, 2500);

    function renderYomitanEntry(result) {
        const { dictionary, term, entry, type } = result;
        
        if (type === 'jmdict') {
            return renderJMDictEntry(result);
        }
        
        // Yomitan entry format: [term, reading, definitionTags, ruleTags, score, definitions, sequence, termTags]
        const [entryTerm, reading, defTags, ruleTags, score, definitions] = entry;
        
        const _ruby = (typeof buildFuriganaRuby === 'function')
            ? buildFuriganaRuby(entryTerm, (reading || '').split('・')[0] || '')
            : { html: entryTerm, hasRuby: false };
        let content = `<div style="font-size:1.2em;font-weight:700">${_ruby.html}</div>`;

        if (reading && reading !== entryTerm && !_ruby.hasRuby) {
            content += `<div style="color:#ffa726;margin:4px 0">【${reading}】</div>`;
        }
        
        // Dictionary name
        content += `<div style="color:#4caf50;font-size:0.9em;margin:2px 0;font-weight:600">[${dictionary}]</div>`;
        
        // Process definitions (simplified)
        if (definitions && definitions.length > 0) {
            content += `<div style="margin:8px 0;line-height:1.4">`;
            
            let definitionCount = 0;
            for (const def of definitions) {
                if (definitionCount >= 3) break; // Limit to 3 definitions
                
                if (def.type === 'structured-content') {
                    const simpleText = extractSimpleTextFromStructured(def.content);
                    if (simpleText && simpleText.length > 10) {
                        content += `<div style="margin:4px 0;padding:4px 0;border-bottom:1px solid #333;">• ${simpleText}</div>`;
                        definitionCount++;
                    }
                } else if (typeof def === 'string' && def.length > 0) {
                    content += `<div style="margin:4px 0;padding:4px 0;border-bottom:1px solid #333;">• ${def}</div>`;
                    definitionCount++;
                }
            }
            
            content += `</div>`;
        }
        
        return content;
    }
    
    function renderJMDictEntry(result) {
        const { dictionary, term, entry } = result;
        const e = entry;
        
        const reading = (e.kana || []).map(k => k.text).join('・');
        const glosses = (e.sense || [])
            .flatMap(s => (s.gloss || []).map(g => g.text))
            .slice(0, 5)
            .map(g => `<li>${g}</li>`)
            .join('');

        const _ruby = (typeof buildFuriganaRuby === 'function')
            ? buildFuriganaRuby(term, (reading || '').split('・')[0] || '')
            : { html: term, hasRuby: false };
        let content = `<div style="font-size:1.2em;font-weight:700">${_ruby.html}</div>`;

        if (reading && !_ruby.hasRuby) {
            content += `<div style="color:#ffa726;margin:4px 0">【${reading}】</div>`;
        }
        
        content += `<div style="color:#4caf50;font-size:0.9em;margin:2px 0;font-weight:600">[${dictionary}]</div>`;
        content += `<ul style="margin:8px 0 0 1.2em;padding:0;line-height:1.3">${glosses}</ul>`;
        
        return content;
    }
    
    function extractSimpleTextFromStructured(content) {
        // Very basic extraction of text from structured content
        if (Array.isArray(content)) {
            return content.map(item => extractSimpleTextFromStructured(item)).filter(Boolean).join(' ');
        }
        
        if (typeof content === 'string') {
            return content;
        }
        
        if (content && content.content) {
            return extractSimpleTextFromStructured(content.content);
        }
        
        return '';
    }
    
    function renderPopupContent(results, currentIndex = 0) {
        // Reader-mode-only "Set playhead" section, above the dictionary
        // header. Tapping it jumps audio playback to the start of the
        // cue containing the looked-up word — same logic the floating
        // playhead button used to provide. lookupContext.cueStartMs +
        // cueAudioPath are populated by the reader's tap-binding code
        // before this render runs. Only renders when:
        //   - body is in mode-read (not card / audio mode)
        //   - lookupContext has a valid cue + audio path
        // so the section is absent in non-reader popups.
        // Shown in READ mode (jump to the cue's start in the reader) AND CARD mode
        // (play from the start of the SRT cue containing the looked-up word).
        const inReadMode = document.body.classList.contains('mode-read');
        const inCardMode = document.body.classList.contains('mode-card');
        const ctx = window.lookupContext || {};
        // Show whenever THIS lookup resolved to a real cue with audio (epub+SRT+
        // audiobook titles). EPUB-only lookups resolve no cue → cueAudioPath /
        // cueStartMs are null → hidden. The stale-context leak that made it
        // appear on EPUB-only is handled by clearing window.lookupContext on
        // title load (resetCrossTitlePositionState).
        const hasCue = (inReadMode || inCardMode) &&
                       !!ctx.cueAudioPath &&
                       Number.isFinite(ctx.cueStartMs);
        let playheadSection = '';
        if (hasCue) {
            const mmss = _formatMs(ctx.cueStartMs);
            // Line-triangle (skip-to-start) icon — matches the "Play card" pill.
            playheadSection = `
                <div class="dict-popup-playhead-section">
                    <button id="setPlayheadBtn" type="button" class="dict-popup-playhead-btn">
                        <span class="dict-popup-playhead-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="5" width="2.6" height="14" rx="1"/><path d="M9 5l11 7-11 7z"/></svg></span>
                        <span class="dict-popup-playhead-label">Set playhead</span>
                        <span class="dict-popup-playhead-time">${mmss}</span>
                    </button>
                </div>
            `;
        }

        if (!results || results.length === 0) {
            return playheadSection + `<div class="dict-popup-empty">No dictionary entries found
                <div class="dict-popup-hint">Tap anywhere to close</div></div>`;
        }
        const result = results[currentIndex];
        const isJmdict = result.type === 'jmdict';
        const reading = isJmdict
            ? (result.entry.kana || []).map(k => k.text).join('・')
            : (result.entry[1] && result.entry[1] !== result.term ? result.entry[1] : '');

        // Furigana ruby over the headword. The reading list may be '・'-joined
        // (JMdict alternates) — distribute the FIRST reading as ruby; surviving
        // alternates stay on the small reading line. Kana-only terms produce no
        // ruby, so the plain reading line is kept for them.
        const primaryReading = (reading || '').split('・')[0] || '';
        const ruby = (typeof buildFuriganaRuby === 'function')
            ? buildFuriganaRuby(result.term, primaryReading)
            : { html: result.term, hasRuby: false };
        const altReadings = (reading || '').split('・').slice(1).join('・');
        const readingLine = ruby.hasRuby ? altReadings : reading;

        let content = playheadSection + `
            <div class="dict-popup-header">
                <div class="dict-popup-title-block">
                    ${readingLine ? `<div class="dict-popup-reading">${readingLine}</div>` : ''}
                    <div class="dict-popup-term">${ruby.html}</div>
                </div>
                <div class="dict-popup-header-icons">
                    <div class="dict-popup-audio-group" style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                        <div class="dict-popup-audio-row" style="display:flex;align-items:center;gap:2px;">
                            <button id="audioPrev" type="button" title="Previous audio source" class="dict-popup-icon-btn dict-popup-audio-nav" aria-label="Previous audio" style="display:none;">
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="15 18 9 12 15 6"/>
                              </svg>
                            </button>
                            <button id="audioBtn" type="button" title="Play audio" class="dict-popup-icon-btn" aria-label="Play audio">
                              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M11 5L6 9H3v6h3l5 4V5z"/>
                                <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
                                <path d="M18.5 5.5a9 9 0 0 1 0 13"/>
                              </svg>
                            </button>
                            <button id="audioNext" type="button" title="Next audio source" class="dict-popup-icon-btn dict-popup-audio-nav" aria-label="Next audio" style="display:none;">
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="9 18 15 12 9 6"/>
                              </svg>
                            </button>
                        </div>
                        <span id="audioCount" class="dict-popup-audio-count" style="display:none;font-size:.65rem;opacity:.7;line-height:1;white-space:nowrap;"></span>
                    </div>
                    <button id="ankiBtn" class="dict-popup-anki-btn"
                            data-dictionary="${result.dictionary}"
                            data-term="${result.term}"
                            data-type="${result.type}">+ Anki</button>
                </div>
            </div>
        `;
        if (results.length > 1) {
            content += `
                <div class="dict-popup-nav">
                    <button id="prevResult" class="dict-popup-nav-btn" ${currentIndex === 0 ? 'disabled' : ''}>← Prev</button>
                    <span class="dict-popup-nav-count">${currentIndex + 1} / ${results.length}</span>
                    <button id="nextResult" class="dict-popup-nav-btn" ${currentIndex === results.length - 1 ? 'disabled' : ''}>Next →</button>
                </div>
            `;
        }

        // Sense blocks — shared with the Anki "Glossary" field builder
        // (buildGlossaryHtml) so the card and the popup stay byte-identical.
        content += buildGlossaryHtml(result);

        content += `<div class="dict-popup-hint">Tap anywhere to close</div>`;
        return content;
    }

    // ==================== POPUP FUNCTIONS (FROM EXISTING CODE) ====================
    
    function positionDictPopup(popup) {
        if (!popup) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const margin = 12;

        // Audiobook mode: anchor BELOW the cue text and keep popup small.
        // The audiobook view's subtitle takes the center band of the screen
        // and the user reported the dict was eating it. Cap height at 40 %
        // of viewport so the cue text + the word being looked up stays
        // visible.
        const audiobookView = document.getElementById('audiobookModeView');
        const audiobookCue  = document.getElementById('audiobookCueText');
        const inAudiobook   = audiobookView && audiobookView.style.display !== 'none' &&
                              audiobookCue && audiobookCue.offsetParent !== null;
        if (inAudiobook) {
            // Anchor ABOVE the cue text so the popup fills the cover-art
            // band (where there's plenty of vertical room) instead of the
            // narrow strip below the cue (which is partially taken by the
            // transport row).
            const cueRect = audiobookCue.getBoundingClientRect();
            const w  = Math.min(vw * 0.92, 500);
            const availAbove = cueRect.top - margin * 2;
            // maxHeight (not height) so the popup shrinks to its content
            // — short entries don't leave a giant empty box dangling.
            const maxH  = Math.min(420, Math.max(220, availAbove));
            popup.style.width     = `${w}px`;
            popup.style.height    = 'auto';
            popup.style.maxHeight = `${maxH}px`;
            popup.style.left      = `${(vw - w) / 2}px`;
            popup.style.top       = `${Math.max(margin, cueRect.top - margin - maxH)}px`;
            return;
        }

        // READ mode takes precedence over the card-subtitle branch. A title
        // that has BOTH cards and an epub keeps its `.subtitle-text` element
        // in the DOM while reading (the card view is layered behind the
        // reader, not display:none), so without this guard the card branch
        // below would hijack positioning in read mode — which is exactly why
        // the avoid-content placement only worked on epub-ONLY titles and why
        // combined titles dropped the popup in a fixed spot over the text.
        const pagedView = document.getElementById('readingPagedView');
        // display:flex always now; visibility is the toggle — check both.
        const pagedActive = pagedView && pagedView.style.display !== 'none' && pagedView.style.visibility !== 'hidden';

        // Card mode: anchor below the subtitle text. Works for BOTH classic
        // image+subtitle cards AND SRT-cards (subtitle + waveform, no image).
        const subtitleEl = document.querySelector('.subtitle-text');
        const subtitleVisible = subtitleEl && subtitleEl.offsetParent !== null;
        if (subtitleVisible && !pagedActive) {
            const subRect = subtitleEl.getBoundingClientRect();
            const top = Math.max(margin, subRect.bottom + margin);
            const maxH = Math.min(vh * 0.72, 520, Math.max(180, vh - top - margin * 2));
            const w = Math.min(vw * 0.92, 560);
            popup.style.width     = `${w}px`;
            popup.style.height    = 'auto';
            popup.style.maxHeight = `${maxH}px`;
            popup.style.left      = `${(vw - w) / 2}px`;
            popup.style.top       = `${top}px`;
            return;
        }
        // PAGED-READER fast path: text flows in vertical columns, so
        // "above/below the highlight" still covers the same column the
        // user wants to read. Instead, snap the popup to the LEFT or
        // RIGHT edge of the screen — whichever side is farther from
        // the highlighted word's column — with a compact width that
        // leaves the highlight column clearly visible.
        if (pagedActive) {
            // Find a hlRect via increasingly-loose fallbacks. iOS WKWebView
            // is uneven across versions about what's actually available:
            //   1. The source Range stashed by the paged reader's paintFn
            //      (window._dictLookupRange). gBCR works on most iOS
            //      versions; falls back to getClientRects()[0] which
            //      sometimes returns a valid rect when gBCR returns zero
            //      in vertical-rl (the known WKWebView quirk).
            //   2. CSS.highlights registry iteration. Empty on some iOS.
            //   3. The looked-up chunk's bounding rect — coarse but
            //      ALWAYS available because chunks are regular DOM nodes.
            //      Used as last resort so the popup at least positions
            //      relative to the right column.
            let hlRect = null;
            let hlSrc = 'none';
            try {
                const r = window._dictLookupRange;
                if (r) {
                    let rc = r.getBoundingClientRect();
                    if (!rc || !rc.width || !rc.height) {
                        // gBCR returns zero on iOS vertical-rl sometimes;
                        // getClientRects() returns one rect per line box
                        // and the first is usually non-empty.
                        try {
                            const list = r.getClientRects();
                            if (list && list.length) {
                                for (let i = 0; i < list.length; i++) {
                                    const c = list[i];
                                    if (c && c.width && c.height) { rc = c; break; }
                                }
                            }
                        } catch (_) {}
                    }
                    if (rc && rc.width && rc.height) { hlRect = rc; hlSrc = 'range-gBCR'; }
                }
            } catch (_) {}
            if (!hlRect) {
                try {
                    const hl = window.CSS?.highlights?.get?.('reader-dict-lookup') ||
                               window._dictLookupHl;
                    if (hl) for (const r of hl) {
                        const rc = r.getBoundingClientRect?.();
                        if (rc && rc.width && rc.height) {
                            hlRect = rc; hlSrc = 'hl-iter'; break;
                        }
                    }
                } catch (_) {}
            }
            if (!hlRect) {
                // Last resort: use the chunk containing the lookup.
                // The paged reader stashes it on window._dictLookupChunk.
                // Coarse but always available.
                try {
                    const ch = window._dictLookupChunk;
                    if (ch) {
                        const rc = ch.getBoundingClientRect();
                        if (rc && rc.width && rc.height) {
                            hlRect = rc; hlSrc = 'chunk';
                        }
                    }
                } catch (_) {}
            }
            // Diagnostics for Safari Inspector — read via dataset.
            try {
                popup.dataset.posSrc = hlRect ? ('paged-' + hlSrc) : 'paged-fallback';
                if (hlRect) {
                    popup.dataset.posRect =
                        Math.round(hlRect.left) + ',' + Math.round(hlRect.top) +
                        ',' + Math.round(hlRect.width) + ',' + Math.round(hlRect.height);
                }
            } catch (_) {}
            const safeTop = (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')) || 64);
            // Reserve a margin around the highlight rect so the popup
            // doesn't sit flush against the looked-up character. Lifts
            // the "almost touching" feel without breaking the picker.
            const gap = 14;
            // No highlight rect at all → pin a narrow column to the LEFT edge.
            // In vertical-rl the reader's current column is toward the right
            // (text flows right-to-left), so a left column is the least likely
            // to cover what's being read. This beats a bottom sheet (which
            // obscured the continuation of the tapped word's column) and a
            // centered box (which sat over the text).
            if (!hlRect) {
                const fw = Math.min(360, Math.max(200, vw * 0.46));
                popup.style.width  = `${fw}px`;
                popup.style.height = 'auto';
                popup.style.maxHeight = `${vh - safeTop - margin * 2}px`;
                popup.style.left = `${margin}px`;
                popup.style.top  = `${safeTop + margin}px`;
                try { popup.dataset.posSide = 'fallback-left'; } catch (_) {}
                return;
            }
            // Place the popup in the region FARTHEST from the looked-up word
            // and pin it to the OUTER screen edge — never centered over the
            // word. The old area-scoring picked full-width above/below
            // strips (bigger area than the narrow vertical-rl side columns)
            // and then centered within them, dropping the box mid-screen
            // right on top of the context — exactly the recurring complaint.
            // In vertical-rl a side column keeps the word's whole column
            // readable, so prefer LEFT/RIGHT when a side is wide enough;
            // otherwise fall into the top/bottom half that doesn't contain
            // the word, flush to that edge.
            const minTop = safeTop + margin;
            const targetH = Math.min(520, vh * 0.72);
            const roomLeft  = hlRect.left - gap - margin;
            const roomRight = vw - margin - (hlRect.right + gap);
            const roomAbove = hlRect.top - gap - minTop;
            const roomBelow = vh - margin - (hlRect.bottom + gap);
            // PREFER a near-FULL-WIDTH popup pinned to the TOP or BOTTOM —
            // whichever half is farther from the looked-up word. In vertical-rl
            // a side column is too narrow (the recurring "dict is too narrow"
            // complaint); top/bottom gives the entry the screen's full width and
            // still leaves the word's column readable. Fall back to a side column
            // ONLY when the word is vertically centered so neither half has
            // usable height (top/bottom would obscure the word) AND a side is
            // wide enough.
            const TOPBOT_MIN = 200;                  // min usable height to take a top/bottom slot
            const SIDE_MIN = Math.min(240, vw * 0.5);
            const fullW = Math.min(vw - margin * 2, 600);
            let boxW, boxH, boxLeft, boxTop, posSide;
            if (Math.max(roomAbove, roomBelow) >= TOPBOT_MIN ||
                Math.max(roomLeft, roomRight) < SIDE_MIN) {
                // Full-width, flush to whichever edge is farther from the word.
                const useAbove = roomAbove >= roomBelow;
                const room = Math.max(140, useAbove ? roomAbove : roomBelow);
                boxW = fullW;
                boxH = Math.min(targetH, room);
                boxLeft = (vw - boxW) / 2;
                boxTop = useAbove ? minTop : (vh - margin - Math.min(targetH, room));
                posSide = useAbove ? 'above' : 'below';
            } else {
                // Word vertically centered → narrow side column (last resort).
                const useLeft = roomLeft >= roomRight;
                const room = useLeft ? roomLeft : roomRight;
                boxW = Math.min(420, room);
                boxH = Math.min(targetH, vh - minTop - margin);
                boxLeft = useLeft ? margin : (vw - margin - boxW);
                boxTop = minTop;
                posSide = useLeft ? 'left' : 'right';
            }
            try { popup.dataset.posSide = posSide; } catch (_) {}
            popup.style.width = `${boxW}px`;
            popup.style.height = 'auto';
            popup.style.maxHeight = `${boxH}px`;
            popup.style.left = `${boxLeft}px`;
            popup.style.top  = `${boxTop}px`;
            return;
        }

        // Legacy reader fallback: keep the popup out of the active chunk so the
        // user can still see the highlighted word being looked up.
        // Smaller width than before — was covering too much of the page.
        const w = Math.min(vw * 0.84, 460);

        // Find the area to avoid. In paged reader, the surest signal is
        // the CSS Custom Highlight 'reader-dict-lookup' — its range's
        // bounding rect is exactly where the looked-up word sits. Fall
        // back to legacy reader's .dict-frag.highlight spans, then the
        // active chunk, then nothing.
        let avoid = null;
        try {
            const hl = window.CSS?.highlights?.get?.('reader-dict-lookup');
            if (hl) {
                let union = null;
                // Highlight is iterable across its ranges.
                for (const r of hl) {
                    const rc = r.getBoundingClientRect?.();
                    if (!rc || !rc.width || !rc.height) continue;
                    if (!union) {
                        union = { top: rc.top, bottom: rc.bottom, left: rc.left, right: rc.right };
                    } else {
                        union.top    = Math.min(union.top, rc.top);
                        union.bottom = Math.max(union.bottom, rc.bottom);
                        union.left   = Math.min(union.left, rc.left);
                        union.right  = Math.max(union.right, rc.right);
                    }
                }
                if (union) avoid = union;
            }
        } catch (e) {}
        if (!avoid) {
            const highlighted = document.querySelectorAll('#readingModeContent .dict-frag.highlight');
            if (highlighted.length) {
                const first = highlighted[0].getBoundingClientRect();
                const last = highlighted[highlighted.length - 1].getBoundingClientRect();
                avoid = {
                    top: Math.min(first.top, last.top),
                    bottom: Math.max(first.bottom, last.bottom),
                    left: Math.min(first.left, last.left),
                    right: Math.max(first.right, last.right)
                };
            } else {
                const active = document.querySelector('#readingModeContent .reading-chunk.active');
                if (active) avoid = active.getBoundingClientRect();
            }
        }

        // Compute available space above and below the avoid rect.
        let maxH, top;
        if (avoid) {
            const spaceAbove = avoid.top - margin * 2;
            const spaceBelow = vh - avoid.bottom - margin * 2;
            const cap = Math.min(vh * 0.7, 520);
            if (spaceBelow >= spaceAbove) {
                maxH = Math.min(cap, Math.max(180, spaceBelow));
                top  = avoid.bottom + margin;
            } else {
                maxH = Math.min(cap, Math.max(180, spaceAbove));
                top  = Math.max(margin, avoid.top - maxH - margin);
            }
        } else {
            maxH = Math.min(vh * 0.7, 520);
            top  = (vh - maxH) / 2;
        }

        popup.style.width     = `${w}px`;
        popup.style.height    = 'auto';
        popup.style.maxHeight = `${maxH}px`;
        popup.style.left      = `${(vw - w) / 2}px`;
        popup.style.top       = `${Math.max(margin, top)}px`;
    }

    function getOrCreatePopup() {
        let popup = document.getElementById('dictPopup');
        
        if (!popup) {
            console.log('🎨 Creating new popup element...');
            popup = document.createElement('div');
            popup.id = 'dictPopup';
            Object.assign(popup.style, {
                position: 'fixed',
                maxWidth: '90%',
                maxHeight: '80%',
                width: '90%',
                // Slightly tinted dark — visibly distinct from the
                // pure-black reader background so the popup reads as a
                // floating card, not a hole in the page.
                background: '#15171a',
                color: '#fff',
                borderRadius: '14px',
                padding: '18px 20px',
                fontSize: '16px',
                zIndex: 9999,
                display: 'none',
                // Layered shadow — close-and-tight for the lift, plus a
                // wider diffuse for the ambient "hovering" feel.
                boxShadow: '0 4px 12px rgba(0,0,0,.45), 0 24px 60px rgba(0,0,0,.55)',
                border: '1px solid #262a30',
                overflow: 'auto',
                overscrollBehavior: 'contain'
            });
            
            // Prevent scroll passthrough but allow internal scrolling
            popup.addEventListener('touchstart', (e) => {
                e.stopPropagation();
            }, { passive: true }); // Changed to passive: true
            
            popup.addEventListener('touchmove', (e) => {
                e.stopPropagation();
                // Allow scrolling within the popup
            }, { passive: true }); // Changed to passive: true
            
            popup.addEventListener('touchend', (e) => {
                e.stopPropagation();
            }, { passive: true });
            
            popup.addEventListener('wheel', (e) => {
                e.stopPropagation();
                // Allow wheel scrolling within popup
            }, { passive: true });
            
            document.body.appendChild(popup);
            console.log('✅ Popup element created with proper scroll handling');
        }
        
        return popup;
    }

    // Track whether we paused playback specifically because of a lookup,
    // so we know whether to auto-resume on dismiss. Set in showPopup, read
    // (and cleared) in hidePopup.
    let _lookupPausedPlayback = false;

    function isLookupModeAutoPause() {
        const body = document.body;
        // Pause narration on lookup in read, audio, AND card mode (card was
        // excluded before — user wants the transport to stop when the dictionary
        // is brought up, same as read mode, and resume on dismiss).
        const inPausableMode = body.classList.contains('mode-read') ||
                               body.classList.contains('mode-audio') ||
                               body.classList.contains('mode-card');
        if (!inPausableMode) return false;
        // Preference defaults to true; user can disable via Preferences.
        const v = localStorage.getItem('DICT_PAUSE_ON_LOOKUP');
        return v === null || v === 'true';
    }
    async function maybePauseForLookup() {
        const gate = isLookupModeAutoPause();
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        if (!gate) { console.log('[dict-pause] skip: pref off or wrong mode'); return; }
        if (!bg)  { console.log('[dict-pause] skip: no BackgroundAudio'); return; }
        try {
            const s = await bg.getState();
            console.log('[dict-pause] state.playing=' + !!s?.playing);
            if (s?.playing) {
                _lookupPausedPlayback = true;
                bg.pause({ fadeMs: 140 });   // brief fade-out so it doesn't click
                console.log('[dict-pause] paused, flag set');
            }
        } catch (e) { console.log('[dict-pause] error: ' + e.message); }
    }
    function maybeResumeAfterLookup() {
        console.log('[dict-resume] called, flag=' + _lookupPausedPlayback);
        if (!_lookupPausedPlayback) return;
        _lookupPausedPlayback = false;
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        try {
            const r = bg?.resume?.({ fadeMs: 140 });   // brief fade-in on resume
            console.log('[dict-resume] bg.resume() invoked');
            if (r?.catch) r.catch((err) => console.log('[dict-resume] resume err: ' + err?.message));
        } catch (e) { console.log('[dict-resume] error: ' + e.message); }
    }
    window.maybePauseForLookup = maybePauseForLookup;
    // Expose hidePopup so external dismiss paths (paged reader's
    // touchstart) can route through it and trigger
    // maybeResumeAfterLookup, instead of nuking popup.style.display
    // directly and skipping the resume.
    window.hideDictPopup = hidePopup;
    // Lets external callers (e.g., the Set-playhead button) suppress
    // the post-hide bg.resume() so a fresh bg.play({startMs}) they
    // just initiated isn't immediately overridden by the resume
    // racing back to the old pre-pause position. Without this, the
    // Set-playhead button "sometimes starts from a random place" —
    // resume won the race against the new play call's startMs.
    window._clearLookupPauseFlag = () => { _lookupPausedPlayback = false; };

    function hidePopup() {
        console.log('🚪 Hiding popup...');
        const popup = document.getElementById('dictPopup');
        if (popup) {
            popup.style.display = 'none';
            popup.innerHTML = '';
        }
        clearHighlight();
        // Clear the reader's CSS Custom Highlight (set by the caret-based
        // lookup path). Safe no-op if not in reader mode.
        try { if (typeof window._clearReaderDictHighlight === 'function') window._clearReaderDictHighlight(); } catch (e) {}
        maybeResumeAfterLookup();
    }

    function clearHighlight() {
        lastHovered.forEach(s => s.classList.remove('highlight'));
        lastHovered = [];
    }

    function highlightSpans(spans, startIndex, length) {
        clearHighlight();
        let charCount = 0;
        
        for (let i = startIndex; i < spans.length && charCount < length; i++) {
            const span = spans[i];
            lastHovered.push(span);
            span.classList.add('highlight');
            charCount += span.textContent.length;
        }
        
        console.log(`🎨 Highlighted ${lastHovered.length} spans`);
    }

    // Longest-match deinflection, Yomitan-style: generate ALL candidate base
    // forms for every surface length IN-MEMORY (getDeinflections — no existence
    // check), gather them, then do ONE bulk async existence query against the
    // indexed dictStore (existsBulk) PLUS a sync check of the legacy in-memory
    // `dictionaries` Map, and pick the longest surface (longest base within it)
    // that has a hit. Replaces the old per-candidate synchronous _termSet.has,
    // so there is NO boot-time term-index scan — startup is instant regardless
    // of dictionary count/size, and per-tap cost scales with candidates only.
    //
    // Selection invariants preserved from the previous matcher: longest SURFACE
    // first, and within a surface the longest BASE form. Changing this brought
    // back known regressions (説明した clobbered by 説き明かし; 積もらない by 積).
    async function greedyDeinflect(text, start, maxLength = 12) {
        const fallback = { match: text[start], base: text[start], length: 1 };
        const searchLimit = Math.min(maxLength, text.length - start);
        if (searchLimit < 1) return fallback;

        // 1) Generate candidates for every length (longest-first) and gather
        //    all unique candidate words for ONE bulk existence query.
        const perLen = [];
        const allWords = new Set();
        for (let len = searchLimit; len >= 1; len--) {
            const surface = text.slice(start, start + len);
            const forms = getDeinflections(surface, 2);
            perLen.push({ len, surface, forms });
            for (const f of forms) allWords.add(f.word);
        }
        if (!allWords.size) return fallback;

        // 2) ONE bulk async existence check against the indexed store…
        let exists = new Set();
        try {
            if (window.dictStore?.existsBulk) {
                exists = await window.dictStore.existsBulk(Array.from(allWords));
            }
        } catch (e) { exists = new Set(); }
        // …plus the legacy in-memory Map (covers the brief pre-migration /
        // store-empty window, exactly as the old hasTermAnywhere did).
        if (dictionaries.size) {
            for (const w of allWords) {
                if (exists.has(w)) continue;
                for (const [, entries] of dictionaries) {
                    if (entries.has(w)) { exists.add(w); break; }
                }
            }
        }

        // 3) Pick the longest surface with a hit; longest base within it.
        for (const { len, surface, forms } of perLen) {
            let bestAtLen = null;
            for (const f of forms) {
                if (!exists.has(f.word)) continue;
                if (!bestAtLen || f.word.length > bestAtLen.word.length) bestAtLen = f;
            }
            if (bestAtLen) return { match: surface, base: bestAtLen.word, length: len };
        }
        return fallback;
    }

    // ==================== MAIN LOOKUP FUNCTION ====================
    
    async function performLookup(spans, index) {
        const _t0 = performance.now();
        const lap = (label) => console.log(`⏱ ${label}: +${Math.round(performance.now() - _t0)}ms`);
        console.log(`🚀 Performing multi-dictionary lookup for span ${index}...`);
        // Kick off dict loading from inside performLookup, not just from
        // the wrapper window.performDictLookup. Card-mode dict-frag taps
        // call performLookup DIRECTLY (see the touchend handler in
        // setupDictFragHandlers), bypassing the wrapper — and the
        // wrapper was the only spot that set window._dictLoadPromise.
        // Without this line, the touchend path never triggered
        // startGlobalDictionaryLoading, so loadDeinflectRules never ran
        // and rules.length stayed at 0 forever. That's why every
        // inflected verb collapsed to a 1-char hit: getDeinflections
        // had an empty rule array and could only return the identity
        // surface.
        if (!window._dictLoadPromise) {
            window._dictLoadPromise = startGlobalDictionaryLoading();
        }
        // Read-mode active-reading signal: looking up a word is a clear
        // sign of active reading, so start the read timer.
        if (document.body.classList.contains('mode-read') && window.stats?.bumpRead) {
          window.stats.bumpRead();
        }
        try {
            hidePopup();

            // Immediate visual feedback. If the user tapped before dicts
            // finished loading (first-launch tap), the next two awaits can
            // sit for several seconds while the legacy JMDict parser
            // finishes + the termSet builds. Plain "Looking up…" reads as
            // "the tap did nothing" — show a more honest "Initializing
            // Dictionaries…" with a progress bar instead.
            const dictsReady = dictLoaded;
            const earlyPopup = getOrCreatePopup();
            if (dictsReady) {
                earlyPopup.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 0;">
                        <div style="color:#4caf50;font-size:.9em;">Looking up…</div>
                    </div>`;
            } else {
                earlyPopup.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 12px;">
                        <div style="color:#4caf50;font-size:1em;font-weight:600;margin-bottom:10px;">
                            Initializing Dictionaries…
                        </div>
                        <div style="width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;margin-bottom:10px;">
                            <div id="earlyLookupBar" style="width:0%;height:100%;background:#4caf50;transition:width .4s ease;"></div>
                        </div>
                        <div style="color:#666;font-size:.72em;">First lookup loads the term index — please wait.</div>
                    </div>`;
            }
            positionDictPopup(earlyPopup);
            earlyPopup.style.display = 'block';
            lap('earlyPopup shown (dictsReady=' + dictsReady + ')');

            // Drive the bar through staged increments. The actual dict load
            // doesn't expose a percentage at this scope, so this is paced
            // progress — close to the typical 1.5–3 s wait. If it's still
            // visible past 3 s we park at 90% so the user sees we're still
            // working rather than a frozen 100%.
            if (!dictsReady) {
                const bar = document.getElementById('earlyLookupBar');
                if (bar) {
                    setTimeout(() => { if (bar.isConnected) bar.style.width = '25%'; }, 80);
                    setTimeout(() => { if (bar.isConnected) bar.style.width = '55%'; }, 700);
                    setTimeout(() => { if (bar.isConnected) bar.style.width = '80%'; }, 1500);
                    setTimeout(() => { if (bar.isConnected) bar.style.width = '90%'; }, 3000);
                }
            }

            // Ensure dictionaries are loaded before deinflecting. Otherwise
            // first-tap returns single-char matches because hasTermAnywhere
            // sees empty stores. Awaits ensureJM (legacy in-memory load) OR
            // dict-store termSet — whichever is the canonical data source.
            try { if (window._dictLoadPromise) await window._dictLoadPromise; } catch (e) {}
            lap('after _dictLoadPromise');
            // Finish the bar so the transition to the next popup state
            // doesn't look like it bailed at 90%.
            const finishBar = document.getElementById('earlyLookupBar');
            if (finishBar) finishBar.style.width = '100%';

            const text = spans.map(s => s.textContent).join('');
            const charIndex = spans.slice(0, index)
                .reduce((sum, s) => sum + s.textContent.length, 0);
            const best = await greedyDeinflect(text, charIndex);
            lap(`greedyDeinflect → "${best.base}" (${best.length}ch)`);

            highlightSpans(spans, index, best.length);
            lap('highlightSpans');
            
            // Check if this is the first lookup and dictionaries aren't loaded yet
            const isFirstLookup = !dictLoaded;
            
            if (isFirstLookup) {
                // Show loading popup for first lookup only
                const popup = getOrCreatePopup();
                popup.innerHTML = `
                    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:200px;">
                        <div style="font-size:1.2em;font-weight:700;margin-bottom:16px;">Looking up: ${best.base}</div>
                        <div style="color:#4caf50;margin-bottom:16px;">Loading dictionaries…</div>
                        <div style="width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;">
                            <div id="loadingBar" style="width:0%;height:100%;background:#4caf50;transition:width 0.3s ease;"></div>
                        </div>
                        <div style="color:#666;font-size:0.8em;margin-top:12px;">This may take 1-2 minutes for the first lookup...</div>
                    </div>
                `;
                // Position BEFORE making visible so the popup never paints at
                // its default (full-viewport) bounds — that was producing the
                // "whole line briefly flashes" report.
                positionDictPopup(popup);
                popup.style.display = 'block';
                maybePauseForLookup();

                // Animate loading bar
                const loadingBar = document.getElementById('loadingBar');
                if (loadingBar) {
                    setTimeout(() => loadingBar.style.width = '20%', 100);
                    setTimeout(() => loadingBar.style.width = '40%', 500);
                    setTimeout(() => loadingBar.style.width = '70%', 1000);
                    setTimeout(() => loadingBar.style.width = '90%', 1500);
                }
                
                positionDictPopup(popup);
            }
            
            // Multi-dictionary lookup (this will load dictionaries on first call)
            const results = await multiDictionaryLookup(best.base);
            lap(`multiDictionaryLookup → ${results.length} results`);
            currentLookupResults = results;
            currentResultIndex = 0;
            
            if (isFirstLookup) {
                // Complete loading bar and show completion message briefly
                const loadingBar = document.getElementById('loadingBar');
                if (loadingBar) {
                    loadingBar.style.width = '100%';
                }
                
                // Brief completion message
                const popup = document.getElementById('dictPopup');
                if (popup) {
                    popup.innerHTML = `
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:200px;">
                            <div style="font-size:1.2em;font-weight:700;margin-bottom:16px;color:#4caf50;letter-spacing:.06em;">Dictionaries loaded</div>
                            <div style="color:#ccc;margin-bottom:16px;">Showing definitions for: ${best.base}</div>
                            <div style="width:200px;height:4px;background:#333;border-radius:2px;overflow:hidden;">
                                <div style="width:100%;height:100%;background:#4caf50;"></div>
                            </div>
                        </div>
                    `;
                }
                
                // Show completion for 0.5 seconds, then show results
                setTimeout(() => {
                    const popup = document.getElementById('dictPopup');
                    if (popup) {
                        popup.innerHTML = renderPopupContent(results, currentResultIndex);
                        positionDictPopup(popup);
                        requestAnimationFrame(() => positionDictPopup(popup));
                        setupNavigationHandlers();
                        setupAnkiHandler(results);
                        setupAudioHandler(results);
                        setupPlayheadHandler();
                    }
                }, 500);
            } else {
                // For subsequent lookups, show results immediately (no loading bar)
                const popup = getOrCreatePopup();
                popup.innerHTML = renderPopupContent(results, currentResultIndex);
                // Position BEFORE display:block so no flash at default bounds.
                positionDictPopup(popup);
                popup.style.display = 'block';
                // Re-position once layout settles so the smart-quadrant
                // logic has a real highlight rect to read.
                requestAnimationFrame(() => positionDictPopup(popup));
                maybePauseForLookup();

                setupNavigationHandlers();
                setupAnkiHandler(results);
                setupAudioHandler(results);
                setupPlayheadHandler();
            }
            
            console.log(`✅ Multi-dictionary lookup complete for "${best.match}" -> "${best.base}"`);
            
        } catch (error) {
            console.error('❌ Multi-dictionary lookup failed:', error);
            // Show error in popup
            const popup = document.getElementById('dictPopup');
            if (popup) {
                popup.innerHTML = `
                    <div style="text-align:center;padding:20px;">
                        <div style="font-size:1.1em;font-weight:700;color:#f44336;margin-bottom:8px;letter-spacing:.06em;">Lookup failed</div>
                        <div style="color:#ccc;margin-bottom:12px;">Could not load dictionary definitions</div>
                        <div style="color:#666;font-size:0.8em;">Tap anywhere to close</div>
                    </div>
                `;
            }
        }
    }
    
    // Compact m:ss formatter used in the Set-playhead button label.
    function _formatMs(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '—';
        const total = Math.floor(ms / 1000);
        const m = Math.floor(total / 60);
        const s = String(total % 60).padStart(2, '0');
        return m + ':' + s;
    }

    // Reader-mode "Set playhead" button handler. Delegates the actual
    // play to window.pagedPlayFromCue(cueIdx) which lives in
    // reading-mode-paged.js — that helper paints the cue green,
    // resets the cue-highlight gate (so the next cue lands
    // properly), records undo, and plays from the cue's startMs.
    // BEFORE invoking it we clear the dict-lookup pause flag so the
    // popup's hide path doesn't fire a racing bg.resume() that
    // overrides our fresh bg.play({startMs}) and bounces audio back
    // to the pre-pause position. That race was the "starts in a
    // random place" pattern.
    function setupPlayheadHandler() {
        const btn = document.getElementById('setPlayheadBtn');
        if (!btn) return;
        const ctx = window.lookupContext || {};
        if (!Number.isFinite(ctx.cueIndex) && !Number.isFinite(ctx.cueStartMs)) {
            btn.disabled = true;
            return;
        }
        let firing = false;
        const fire = async (e) => {
            if (firing) return;
            firing = true;
            try { e.stopPropagation(); } catch (_) {}
            try { if (e.cancelable) e.preventDefault(); } catch (_) {}
            try {
                // CRITICAL: suppress the resume that hideDictPopup
                // would otherwise fire on its way out. The resume
                // races our fresh bg.play({startMs}) on iOS and
                // sometimes wins, planting playback at the pre-pause
                // position instead of the cue start.
                try { window._clearLookupPauseFlag?.(); } catch (_) {}
                let ok = false;
                // CARD mode: play from the START of the cue holding the word
                // (continuous flags armed) — the paged-reader helper doesn't apply.
                if (document.body.classList.contains('mode-card') &&
                    typeof window.playSrtCueFromMs === 'function' &&
                    Number.isFinite(ctx.cueStartMs)) {
                    ok = await window.playSrtCueFromMs(ctx.cueStartMs, ctx.cueAudioPath, ctx.cueEndMs);
                } else if (typeof window.pagedPlayFromCue === 'function' &&
                    Number.isFinite(ctx.cueIndex)) {
                    ok = await window.pagedPlayFromCue(ctx.cueIndex);
                }
                // Fallback: direct bg.play if the helper isn't loaded
                // (e.g., paged reader not active for some reason).
                if (!ok && ctx.cueAudioPath && Number.isFinite(ctx.cueStartMs)) {
                    const bg = window.Capacitor?.Plugins?.BackgroundAudio;
                    if (bg) {
                        const audioPath = ctx.cueAudioPath;
                        const url = audioPath.startsWith('file://') ? audioPath : 'file://' + audioPath;
                        const startMs = Math.max(0, Math.round(ctx.cueStartMs) -
                                                    (window.AUDIO_START_OFFSET_MS || 0));
                        await bg.play({ url, startMs, rate: window.audioPlaybackRate || 1 });
                    }
                }
                // Dismiss the popup so the reader is visible.
                try { window.hideDictPopup?.(); } catch (_) {}
            } catch (err) {
                try { window.showToast?.('Play error: ' + (err?.message || err), 2200); } catch (_) {}
            } finally {
                setTimeout(() => { firing = false; }, 400);
            }
        };
        btn.addEventListener('click', fire);
        btn.addEventListener('touchend', fire, { passive: false });
    }

    function setupNavigationHandlers() {
        const prevBtn = document.getElementById('prevResult');
        const nextBtn = document.getElementById('nextResult');

        // Capacitor WKWebView drops the synthetic click after touchend
        // on quick taps inside a popup overlay — wire BOTH events with a
        // 500 ms debounce (same pattern as shell.js menu items). Without
        // touchend, prev/next buttons appeared inert despite being
        // visually un-disabled, which the user reported as "the arrows
        // don't do anything."
        const wire = (btn, advance) => {
            if (!btn) return;
            let firing = false;
            const fire = (e) => {
                if (firing) return;
                firing = true;
                try { e.stopPropagation(); } catch (_) {}
                try { if (e.cancelable) e.preventDefault(); } catch (_) {}
                advance();
                setTimeout(() => { firing = false; }, 400);
            };
            btn.addEventListener('click', fire);
            btn.addEventListener('touchend', fire, { passive: false });
        };

        wire(prevBtn, () => {
            if (currentResultIndex > 0) {
                currentResultIndex--;
                updatePopupContent();
            }
        });
        wire(nextBtn, () => {
            if (currentResultIndex < currentLookupResults.length - 1) {
                currentResultIndex++;
                updatePopupContent();
            }
        });
    }
    
    function updatePopupContent() {
        const popup = document.getElementById('dictPopup');
        if (popup && currentLookupResults.length > 0) {
            popup.innerHTML = renderPopupContent(currentLookupResults, currentResultIndex);
            setupNavigationHandlers();
            setupAnkiHandler(currentLookupResults);
            setupAudioHandler(currentLookupResults);
            setupPlayheadHandler();
        }
    }
    
    function setupAudioHandler(results) {
        const btn      = document.getElementById('audioBtn');
        const prevBtn  = document.getElementById('audioPrev');
        const nextBtn  = document.getElementById('audioNext');
        const countEl  = document.getElementById('audioCount');
        if (!btn || !results || results.length === 0) return;
        const result = results[currentResultIndex];
        const term = result.term;
        const reading = extractReadingFromResult(result);

        const originalIconHTML = btn.innerHTML;

        const markUnavailable = () => {
            btn.style.opacity = '0.35';
            btn.style.cursor = 'default';
            btn.disabled = true;
            btn.title = 'No local audio for this word';
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (countEl) countEl.style.display = 'none';
            // Clear popup-scope state so Anki path falls back cleanly
            // when no audio is available.
            window._currentAudioRefs = [];
            window._currentAudioRefIndex = 0;
        };

        const updateCycler = () => {
            const refs = window._currentAudioRefs || [];
            const idx  = window._currentAudioRefIndex || 0;
            const showCycler = refs.length > 1;
            if (prevBtn) {
                prevBtn.style.display = showCycler ? '' : 'none';
                prevBtn.disabled = !showCycler || idx <= 0;
                prevBtn.style.opacity = prevBtn.disabled ? '0.35' : '1';
            }
            if (nextBtn) {
                nextBtn.style.display = showCycler ? '' : 'none';
                nextBtn.disabled = !showCycler || idx >= refs.length - 1;
                nextBtn.style.opacity = nextBtn.disabled ? '0.35' : '1';
            }
            if (countEl) {
                if (showCycler && refs[idx]) {
                    const src = refs[idx].source?.id || '?';
                    countEl.textContent = `${src} ${idx + 1}/${refs.length}`;
                    countEl.style.display = '';
                } else {
                    countEl.style.display = 'none';
                }
            }
        };

        // Load refs up front so the Anki button (and the cycler) have
        // them ready. Persisted on window for the Anki handler.
        if (typeof window.lookupLocalAudio === 'function') {
            window.lookupLocalAudio(term, reading).then(refs => {
                window._currentAudioRefs = refs || [];
                window._currentAudioRefIndex = 0;
                if (!refs || refs.length === 0) {
                    markUnavailable();
                } else {
                    updateCycler();
                }
            }).catch(() => { /* leave the icon as-is */ });
        }

        const playCurrent = async () => {
            if (btn.disabled) return;
            const refs = window._currentAudioRefs || [];
            const idx  = window._currentAudioRefIndex || 0;
            const ref  = refs[idx];
            btn.disabled = true;
            btn.style.opacity = '0.55';
            try {
                let ok = false;
                if (ref && typeof window.playRef === 'function') {
                    ok = await window.playRef(ref);
                } else if (typeof window.playLocalAudio === 'function') {
                    ok = await window.playLocalAudio(term, reading);
                }
                if (!ok) { markUnavailable(); return; }
            } catch (err) {
                console.warn('Audio play error:', err);
            } finally {
                if (!btn.title || btn.title.indexOf('No local') < 0) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                }
            }
            if (!btn.querySelector('svg')) btn.innerHTML = originalIconHTML;
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            playCurrent();
        });

        if (prevBtn) {
            prevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (prevBtn.disabled) return;
                window._currentAudioRefIndex = Math.max(0, (window._currentAudioRefIndex || 0) - 1);
                updateCycler();
                playCurrent();
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (nextBtn.disabled) return;
                const refs = window._currentAudioRefs || [];
                window._currentAudioRefIndex = Math.min(refs.length - 1, (window._currentAudioRefIndex || 0) + 1);
                updateCycler();
                playCurrent();
            });
        }
    }

    function setupAnkiHandler(results) {
        const ankiBtn = document.getElementById('ankiBtn');
        if (ankiBtn && results.length > 0) {
            ankiBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                
                const result = results[currentResultIndex];
                console.log(`📝 Adding word to Anki from ${result.dictionary}: "${result.term}"`);
                
                try {
                    ankiBtn.disabled = true;
                    ankiBtn.textContent = '⏳ Adding...';
                    
                    // Extract meaning and reading from current result
                    const meaning = extractMeaningFromResult(result);
                    const reading = extractReadingFromResult(result);
                    // Rich, optional extras for a 1:1 dictionary card: the full
                    // multi-sense glossary HTML (pills + POS + numbered senses,
                    // identical to the popup) and per-kanji furigana ruby. Only
                    // written to Anki if the user has mapped a field for them.
                    const glossaryHtml = buildGlossaryHtml(result);
                    const termFurigana = buildTermRubyHtml(result);
                    
                    // Anki sentence + audio come from where the TAPPED WORD
                    // actually lives, never from the currently-playing cue or
                    // visible card. The caller that initiated the lookup is
                    // responsible for binding window.lookupContext to the
                    // right region (paged reader → cue containing tap; card
                    // mode → active card; legacy reader → tapped chunk's
                    // matched card). If a non-empty sentence is bound, ALWAYS
                    // prefer it — earlier this branch was gated on `source ===
                    // 'reading'` AND legacy reading view visibility, so paged
                    // reader lookups (source: 'paged-reader') silently fell
                    // through to the globals and pulled the playing cue's
                    // text, producing the "Anki sent the wrong sentence and
                    // audio" report.
                    const ctx = window.lookupContext;
                    let currentCard, sentence;
                    if (ctx && typeof ctx.sentence === 'string' && ctx.sentence.trim()) {
                        currentCard = ctx.card || null;
                        sentence = ctx.sentence.trim();
                    } else {
                        currentCard = window.allNotes ? window.allNotes[window.currentCardIndex] : null;
                        const subtitleElement = document.querySelector('.subtitle-text');
                        sentence = subtitleElement ? subtitleElement.textContent.trim() : result.term;
                    }

                    if (!currentCard) {
                        // Reading-mode lookup on a chunk with no matching card
                        // (e.g. chapter heading): still send text, just no media.
                        currentCard = { imageHtml: '', audioSrc: '' };
                    } else if (typeof window.ensureCardMediaLoaded === 'function') {
                        await window.ensureCardMediaLoaded(currentCard);
                    }

                    // Pull the word's local pronunciation audio so Anki gets
                    // it in the Term Audio field. Use the ref the user is
                    // CURRENTLY VIEWING in the cycler — falls back to the
                    // first available ref if state isn't set (e.g. legacy
                    // call path).
                    let wordAudio = null;
                    const refsAtSend = window._currentAudioRefs || [];
                    const selectedRef = refsAtSend[window._currentAudioRefIndex || 0];
                    console.log(`[anki-send] refs in scope: ${refsAtSend.length}, idx=${window._currentAudioRefIndex || 0}, selectedRef=${selectedRef ? `${selectedRef.source?.id}/${selectedRef.filename}` : 'none'}`);
                    if (selectedRef && typeof window.getRefAudioBase64 === 'function') {
                        try {
                            wordAudio = await window.getRefAudioBase64(selectedRef);
                            console.log(`[anki-send] getRefAudioBase64 → ${wordAudio ? `${wordAudio.filename} (${wordAudio.base64?.length || 0} chars)` : 'null'}`);
                        } catch (e) {
                            console.warn('[anki-send] getRefAudioBase64 threw:', e);
                        }
                    }
                    if (!wordAudio && typeof window.getLocalAudioBase64 === 'function') {
                        try {
                            wordAudio = await window.getLocalAudioBase64(result.term, reading);
                            console.log(`[anki-send] getLocalAudioBase64 fallback → ${wordAudio ? `${wordAudio.filename}` : 'null'}`);
                        } catch (e) {
                            console.warn('[anki-send] getLocalAudioBase64 fallback threw:', e);
                        }
                    }

                    let audioData = currentCard.audioSrc || "";
                    let imageData = currentCard.imageHtml?.match(/src="([^"]+)"/)?.[1] || "";
                    // Pull cue range from the TAPPED-chunk/card lookupContext
                    // first; fall back to the playing cue's globals only if
                    // the tap context didn't carry one. ANY source is OK as
                    // long as it has the cue fields — covers 'reading',
                    // 'card', and 'audiobook' equally.
                    const ctxCue = (ctx && Number.isFinite(ctx.cueStartMs)) ? ctx : null;
                    const isPagedReader = ctx?.source === 'paged-reader';
                    // PATH can fall back to the global — there's only ONE
                    // audiobook file per title, so the global path is the
                    // same file the paged reader uses. Without this
                    // fallback, the waveform gate fails and Anki gets no
                    // audio at all (skip-the-editor symptom).
                    const cueAudioPath = ctxCue?.cueAudioPath || window._currentReadingAudiobookPath || null;
                    // START/END must come from the TAPPED cue for paged-
                    // reader. The globals track the currently-PLAYING cue,
                    // not the tapped one, which produced the "Anki audio
                    // is from where I was just playing, not the tapped
                    // sentence" symptom.
                    const cueStartMs = isPagedReader
                        ? (Number.isFinite(ctxCue?.cueStartMs) ? ctxCue.cueStartMs : null)
                        : (Number.isFinite(ctxCue?.cueStartMs) ? ctxCue.cueStartMs : window._currentReadingCueStartMs);
                    const cueEndMs = isPagedReader
                        ? (Number.isFinite(ctxCue?.cueEndMs) ? ctxCue.cueEndMs : null)
                        : (Number.isFinite(ctxCue?.cueEndMs) ? ctxCue.cueEndMs : window._currentReadingCueEndMs);
                    // Diagnostic — why did/didn't the waveform editor open?
                    console.log('[anki] waveform gate:',
                      'audioData=' + (audioData ? `len${audioData.length}` : 'none'),
                      'cueAudioPath=' + (cueAudioPath ? '✓' : 'MISSING'),
                      'cueStartMs=' + cueStartMs,
                      'cueEndMs=' + cueEndMs,
                      'waveform.edit=' + (window.waveform?.edit ? '✓' : 'MISSING'),
                      'AudioSlicer=' + (window.Capacitor?.Plugins?.AudioSlicer ? '✓' : 'MISSING'),
                      'ctx.source=' + (ctx?.source || 'none'));
                    let finalSentence = sentence;
                    if (!audioData && cueAudioPath &&
                        Number.isFinite(cueStartMs) && Number.isFinite(cueEndMs) &&
                        window.waveform?.edit && window.Capacitor?.Plugins?.AudioSlicer) {
                      // Hand the full SRT cues array to the editor so its
                      // +/- buttons have neighbors to walk to. Anchor on
                      // the tapped cue — prefer ctx.cueIndex (set by the
                      // paged reader's lookupContext) and fall back to
                      // a startMs lookup if it's missing.
                      const allCues = (window.pagedCues?.length
                        ? window.pagedCues
                        : (window.__abCues || []));
                      let anchorIdx = Number.isFinite(ctx?.cueIndex) ? ctx.cueIndex : -1;
                      if (anchorIdx < 0 || anchorIdx >= allCues.length) {
                        anchorIdx = allCues.findIndex(c =>
                          Number.isFinite(c.startMs) && Math.abs(c.startMs - cueStartMs) < 50
                        );
                      }
                      // If we still can't locate the cue (e.g. dict popup
                      // invoked outside an SRT-cards title), fall back to
                      // the legacy single-cue array so the editor still
                      // opens with valid bounds — +/- just stay disabled
                      // in that case.
                      const editCues = (anchorIdx >= 0 && allCues.length > 1)
                        ? allCues
                        : [{ startMs: cueStartMs, endMs: cueEndMs, text: sentence || result.term }];
                      const editAnchor = (anchorIdx >= 0 && allCues.length > 1) ? anchorIdx : 0;
                      console.log(`[anki] waveform cues: passing ${editCues.length} cues, anchor=${editAnchor} (ctx.cueIndex=${ctx?.cueIndex}, allCues=${allCues.length})`);
                      const adjusted = await window.waveform.edit({
                        srcPath: cueAudioPath,
                        startMs: Math.round(cueStartMs),
                        endMs:   Math.round(cueEndMs),
                        title: sentence || result.term,
                        cues: editCues,
                        cueIndex: editAnchor
                      });
                      if (!adjusted) return; // user cancelled
                      // The editor's `adjusted.text` is the concatenation
                      // of cues[leftIdx..rightIdx]. If the user didn't
                      // touch the +/- buttons, leftIdx===rightIdx===anchor
                      // and that text equals the tapped cue. If they DID
                      // expand, the text grows to include the appended
                      // neighbors — that's what the user asked for, so we
                      // honor it.
                      if (adjusted.text && adjusted.text.trim() !== sentence.trim()) {
                        finalSentence = adjusted.text.trim();
                      }
                      try {
                        const slicer = window.Capacitor.Plugins.AudioSlicer;
                        // Anki audio export contract: always 1.0x.
                        // AudioSlicer.slice does raw frame copy (MP3) or
                        // MediaMuxer remux (M4A) at native speed,
                        // regardless of the user's listening rate.
                        const slice = await slicer.slice({
                          srcPath: cueAudioPath,
                          startMs: Math.round(adjusted.startMs),
                          endMs:   Math.round(adjusted.endMs)
                        });
                        if (slice?.path) {
                          // Pass the on-disk path to native — skips the
                          // base64 round-trip through WKWebView which was
                          // returning empty data URIs silently for tmp/
                          // files on iOS, leaving the Anki audio blank.
                          window._lastDictSliceSrcPath = slice.path;
                          console.log('[dict] slice srcPath=' + slice.path);
                        }
                      } catch (e) { console.warn('dict slice for Anki:', e); }
                    }
                    // Fall back to the active Title's cover when no image
                    // resolved from the card (typical for SRT-only titles).
                    if (!imageData && window._activeTitleId && window.titleStore?.list) {
                      try {
                        const titles = await window.titleStore.list();
                        const tit = titles.find(t => t.id === window._activeTitleId);
                        if (tit?.attachments?.cover?.dataUri) imageData = tit.attachments.cover.dataUri;
                      } catch (e) {}
                    }

                    const ankiData = {
                        expression: result.term,
                        reading: reading,
                        sentence: finalSentence,
                        meaning: meaning,
                        imageData,
                        audioData,
                        // Native plugin can read this directly off disk —
                        // avoids the iOS base64-via-WKWebView empty-result
                        // issue. Consumed by sendWordToAnki below.
                        audioSrcPath: window._lastDictSliceSrcPath || null,
                        wordAudio: wordAudio,
                        dictionary: result.dictionary,
                        glossary: glossaryHtml,
                        termFurigana: termFurigana
                    };
                    window._lastDictSliceSrcPath = null;

                    await sendWordToAnki(ankiData);
                    if (inReadingMode) {
                        window.readingAnkiCount = (window.readingAnkiCount || 0) + 1;
                    }
                    
                    ankiBtn.textContent = 'Added';
                    ankiBtn.style.background = '#2196f3';
                    
                    setTimeout(() => {
                        hidePopup();
                    }, 1000);
                    
                } catch (error) {
                    console.error('❌ Failed to add word to Anki:', error);
                    ankiBtn.textContent = 'Failed';
                    ankiBtn.style.background = '#f44336';
                    
                    setTimeout(() => {
                        ankiBtn.disabled = false;
                        ankiBtn.textContent = 'Add to Anki';
                        ankiBtn.style.background = '#4caf50';
                    }, 2000);
                }
            });
        }
    }
    
    function extractMeaningFromResult(result) {
        if (result.type === 'jmdict') {
            return (result.entry.sense || [])
                .flatMap(s => (s.gloss || []).map(g => g.text))
                .slice(0, 3)
                .join('; ');
        }
        // Yomitan-format entry: definitions live at entry[5]. Each item is
        // either a plain string (simple gloss), a {type:'structured-content',
        // content:...} object, or a {type:'text', text:...} object.
        const definitions = result.entry[5] || [];
        const meanings = [];
        for (const def of definitions.slice(0, 4)) {
            if (typeof def === 'string') {
                const s = def.trim();
                if (s) meanings.push(s.substring(0, 200));
            } else if (def && typeof def === 'object') {
                if (def.type === 'text' && typeof def.text === 'string') {
                    const s = def.text.trim();
                    if (s) meanings.push(s.substring(0, 200));
                } else if (def.type === 'structured-content') {
                    const simpleText = extractSimpleTextFromStructured(def.content);
                    if (simpleText) meanings.push(simpleText.substring(0, 200));
                }
            }
            if (meanings.length >= 3) break;
        }
        if (meanings.length) return meanings.join('; ');
        // Final fallback: stringify the first def (helps diagnose unfamiliar
        // structures) — never reach the "Definition from <name>" placeholder
        // again. That placeholder ended up on real cards.
        if (definitions.length) {
            try {
                const dump = typeof definitions[0] === 'string'
                  ? definitions[0]
                  : JSON.stringify(definitions[0]);
                if (dump) return dump.substring(0, 200);
            } catch (e) {}
        }
        return '';
    }
    
    function extractReadingFromResult(result) {
        if (result.type === 'jmdict') {
            return (result.entry.kana || []).map(k => k.text).join('・');
        } else {
            return result.entry[1] || ''; // Reading is at index 1 in Yomitan format
        }
    }

    // Build the structured glossary HTML — the SAME numbered, pill-tagged sense
    // blocks the popup renders (see renderResults below, which now also calls
    // this) — so an Anki "Glossary" field can be styled 1:1 with the in-app
    // popup. Returns the concatenated .dict-popup-sense blocks (no outer wrapper).
    function buildGlossaryHtml(result) {
        if (!result) return '';
        const isJmdict = result.type === 'jmdict';
        const dictTag = result.dictionary || (isJmdict ? 'JMdict' : '');
        let html = '';
        if (isJmdict) {
            const senses = (result.entry.sense || []);
            senses.forEach((s, i) => {
                const pos = (s.partOfSpeech || []).slice(0, 2).join(', ');
                const glosses = (s.gloss || []).map(g => `<li>${g.text}</li>`).join('');
                if (!glosses) return;
                html += `
                    <div class="dict-popup-sense">
                        <div class="dict-popup-sense-head">
                            <span class="dict-popup-sense-num">${i + 1}.</span>
                            ${pos ? `<span class="dict-popup-pill dict-popup-pill-pos">${pos}</span>` : ''}
                            <span class="dict-popup-pill dict-popup-pill-dict">${dictTag}</span>
                        </div>
                        <ul class="dict-popup-glosses">${glosses}</ul>
                    </div>
                `;
            });
        } else {
            const defs = result.entry[5] || [];
            let count = 0;
            for (const def of defs) {
                if (count >= 5) break;
                let text = '';
                if (def?.type === 'structured-content') {
                    text = extractSimpleTextFromStructured(def.content);
                } else if (typeof def === 'string') {
                    text = def;
                }
                if (!text || text.length < 2) continue;
                count++;
                html += `
                    <div class="dict-popup-sense">
                        <div class="dict-popup-sense-head">
                            <span class="dict-popup-sense-num">${count}.</span>
                            <span class="dict-popup-pill dict-popup-pill-dict">${dictTag}</span>
                        </div>
                        <ul class="dict-popup-glosses"><li>${text}</li></ul>
                    </div>
                `;
            }
        }
        return html;
    }

    // Headword furigana ruby (per-kanji), for an Anki "Furigana" field. Returns
    // ruby HTML only when real ruby was produced; otherwise '' so the card can
    // fall back to the plain Term (matches the popup, which shows no ruby then).
    function buildTermRubyHtml(result) {
        if (!result) return '';
        const isJmdict = result.type === 'jmdict';
        const reading = isJmdict
            ? (result.entry.kana || []).map(k => k.text).join('・')
            : (result.entry[1] && result.entry[1] !== result.term ? result.entry[1] : '');
        const primaryReading = (reading || '').split('・')[0] || '';
        const ruby = (typeof buildFuriganaRuby === 'function')
            ? buildFuriganaRuby(result.term, primaryReading)
            : { html: result.term, hasRuby: false };
        return ruby.hasRuby ? ruby.html : '';
    }

    // ==================== ANKI INTEGRATION (FROM EXISTING CODE) ====================
    
    async function sendWordToAnki({ expression, reading, sentence, meaning, imageData, audioData, audioSrcPath, wordAudio, dictionary, glossary, termFurigana }) {
        // Pull live settings; fall back to generic field names with NO deck/model
        // (the user picks those in Preferences — no personal values ship).
        const cfg = (typeof window.getAnkiSettings === 'function')
          ? await window.getAnkiSettings('dict')
          : { deck: '', model: '',
              fields: { term:'Term', reading:'Reading', sentence:'Sentence',
                        meaning:'Meaning', image:'Image',
                        sentenceAudio:'Sentence Audio', termAudio:'Term Audio',
                        glossary:'', termFurigana:'' } };

        // No deck/note type chosen yet → guide the user instead of failing.
        if (!cfg.deck || !cfg.model) {
            alert('Choose a deck and note type in Preferences → Anki (dictionary) first.');
            return;
        }
        // No field mapping → don't write into an empty field name (silent blank card).
        if (!cfg.fields || !cfg.fields.term) {
            alert('Map your note type’s fields in Preferences → Anki (dictionary) first.');
            return;
        }

        const imageFilename = `mining_${Date.now()}.jpg`;
        const sentenceAudioFilename = `sentence_${Date.now()}.mp3`;

        const fields = {};
        fields[cfg.fields.term]          = expression || '';
        fields[cfg.fields.reading]       = reading || '';
        fields[cfg.fields.sentence]      = sentence || '';
        fields[cfg.fields.meaning]       = meaning || '';
        fields[cfg.fields.image]         = '';
        fields[cfg.fields.sentenceAudio] = '';
        fields[cfg.fields.termAudio]     = '';
        // Optional rich fields — only written when the user has mapped a field
        // for them (left "(none)" by default), so the add path is unchanged for
        // anyone who hasn't opted in.
        if (cfg.fields.glossary)     fields[cfg.fields.glossary]     = glossary || '';
        if (cfg.fields.termFurigana) fields[cfg.fields.termFurigana] = termFurigana || '';

        // --- AnkiBridge path (default on Android) ---
        const ab = (typeof window.viaAnkiBridge === 'function')
            ? await window.viaAnkiBridge()
            : window.Capacitor?.Plugins?.AnkiBridge;
        if (ab) {
            try {
                // Multi-attachment audio array — sentence audio AND term
                // audio land on the same note. The native plugin splices
                // [sound:...] tokens into the matching field for each.
                const audioList = [];
                // Track a codec iOS can't decode at all (Opus/OGG/WebM) so we
                // can warn rather than ship a silently-unplayable card.
                let iosUnplayableAudio = null;
                if (audioSrcPath) {
                    // Native AnkiBridge reads bytes straight off disk —
                    // skips the base64-via-WKWebView round-trip that was
                    // silently returning empty data URIs on iOS tmp/ files.
                    // The iOS slicer outputs AAC/.m4a (Android outputs .mp3) —
                    // name the delivery to match the slice's real extension so
                    // AnkiMobile doesn't reject "an mp3 file" that's actually m4a.
                    audioList.push({
                        filename: window.ankiAudioFilename(sentenceAudioFilename, { srcPath: audioSrcPath }),
                        srcPath:  audioSrcPath,
                        field:    cfg.fields.sentenceAudio
                    });
                } else if (audioData) {
                    const sMime = window.sniffAudioBase64?.(audioData) || '';
                    if (sMime && window.isIosPlayableAudio && !window.isIosPlayableAudio(sMime)) iosUnplayableAudio = sMime;
                    audioList.push({
                        filename:   window.ankiAudioFilename(sentenceAudioFilename, { mime: sMime }),
                        dataBase64: audioData.split(',')[1],
                        field:      cfg.fields.sentenceAudio
                    });
                }
                if (wordAudio && wordAudio.base64) {
                    // Word/term audio comes from the local-audio library and
                    // keeps its source name — which often lies about the codec.
                    // Sniff the real bytes and fix the extension so iOS accepts it.
                    const wMime = window.sniffAudioBase64?.(wordAudio.base64) || '';
                    if (wMime && window.isIosPlayableAudio && !window.isIosPlayableAudio(wMime)) iosUnplayableAudio = wMime;
                    const wordAudioFilename = window.ankiAudioFilename(
                        `word_${Date.now()}_${wordAudio.filename || 'audio.mp3'}`, { mime: wMime });
                    audioList.push({
                        filename:   wordAudioFilename,
                        dataBase64: wordAudio.base64,
                        field:      cfg.fields.termAudio
                    });
                    console.log(`[anki-send] termAudio: ${wordAudioFilename} sniffed=${wMime || '?'} (${wordAudio.base64.length} chars b64) → field "${cfg.fields.termAudio}"`);
                } else {
                    console.log(`[anki-send] termAudio: no wordAudio (wordAudio=${!!wordAudio}, base64=${!!wordAudio?.base64})`);
                }
                if (iosUnplayableAudio && window.Capacitor?.getPlatform?.() === 'ios') {
                    console.warn(`[anki-send] audio codec ${iosUnplayableAudio} is not decodable by iOS AVFoundation — AnkiMobile won't play it (Android will).`);
                    setTimeout(() => {
                        try { window.showToast?.(`⚠ Audio is ${iosUnplayableAudio}; AnkiMobile (iOS) can't play this codec — it will play on Android. Use an MP3 audio source for both.`, 7000); } catch (_) {}
                    }, 1600);
                }
                const params = {
                    deckName:  cfg.deck,
                    modelName: cfg.model,
                    fields,
                    tags: ['mining', 'dictionary', dictionary || 'unknown'].filter(Boolean)
                };
                if (audioList.length) params.audio = audioList;
                console.log(`[anki-send] audioList.length=${audioList.length}, fields.termAudio="${cfg.fields.termAudio}"`);
                if (imageData) {
                    params.picture = [{
                        filename:   imageFilename,
                        dataBase64: imageData.split(',')[1],
                        field:      cfg.fields.image
                    }];
                }
                // Mark the anki round-trip BEFORE the addNote handoff so
                // stats.js suspends its background-stop. Otherwise the
                // iOS URL-scheme hop to AnkiMobile would halt the
                // read-mode timer mid-dict-send.
                try { window.stats?.markAnkiRoundtripActive?.(); } catch (_) {}
                // Arm the x-callback listener BEFORE addNote — see
                // sendToAnkiConnect.js for the rationale. addNote
                // resolves on URL handoff, not actual card creation;
                // the x-callback tells the truth.
                // Android = synchronous AnkiDroid ContentProvider insert (no
                // x-callback exists); iOS = async AnkiMobile URL handoff
                // confirmed via the x-callback. Don't wait for a callback on
                // Android — it always timed out as "No reply from AnkiMobile".
                const isAndroid = window.Capacitor?.getPlatform?.() === 'android';
                const cbPromise = (!isAndroid && typeof window.waitForAnkiCallback === 'function')
                    ? window.waitForAnkiCallback(8000)
                    : Promise.resolve('unknown');
                const r = await ab.addNote(params);
                console.log('✅ AnkiBridge.addNote ->', r);
                if (r?.mediaServerRestartedThisSend) {
                    console.log('AnkiBridge: media server was restarted to complete this send');
                }
                if (isAndroid) {
                    // Non-throwing addNote = AnkiDroid created the note.
                    if (typeof window.showToast === 'function') {
                        window.showToast(`✓ Added to ${cfg.deck}`, 2200);
                    }
                    return r;
                }
                if (typeof window.showToast === 'function') {
                    window.showToast(`Sending to ${cfg.deck}…`, 1400);
                }
                const cbResult = await cbPromise;
                console.log('AnkiBridge x-callback result:', cbResult);
                if (typeof window.showToast === 'function') {
                    if (cbResult === 'success') {
                        window.showToast(`✓ Added to ${cfg.deck}`, 2200);
                    } else if (cbResult === 'error') {
                        const real = window.describeAnkiError?.();
                        window.showToast(real
                            ? `✗ AnkiMobile: ${real}`
                            : `✗ AnkiMobile rejected the note. Check that model "${cfg.model}" and its fields exist.`, 6000);
                    } else if (cbResult === 'timeout') {
                        window.showToast(`? No reply from AnkiMobile. Sent model="${cfg.model}". Verify it exists in AnkiMobile → Manage note types.`, 6500);
                    } else {
                        window.showToast(`✓ Sent to ${cfg.deck}`, 2200);
                    }
                }
                return r;
            } catch (err) {
                console.error('❌ AnkiBridge.addNote error:', err);
                // Drop the cached availability handle so the next send
                // re-verifies. Same rationale as the swipe-up send path —
                // covers "AnkiDroid was killed" (Android) and "media server
                // restart failed" (iOS) without requiring the user to
                // figure out which platform-specific symptom they hit.
                try { window.invalidateAnkiBridgeCache?.(); } catch (e) {}
                const msg = err?.message || String(err);
                const isServerDown = /media server is unreachable/i.test(msg);
                const display = isServerDown
                    ? '✗ Anki media server stuck — restart the app to recover'
                    : `✗ Anki: ${msg}`;
                if (typeof window.showToast === 'function') {
                    window.showToast(display, 4000);
                }
                throw new Error(msg);
            }
        }

        /* ---- legacy AnkiConnect HTTP path (kept for fallback) ----
        return new Promise((resolve, reject) => {
            const wordAudioFilename = wordAudio ? `word_${Date.now()}_${wordAudio.filename || 'audio.mp3'}` : null;
            const audioEntries = [];
            if (audioData) {
                audioEntries.push({
                    filename: sentenceAudioFilename,
                    data: audioData.split(",")[1],
                    fields: [cfg.fields.sentenceAudio]
                });
            }
            if (wordAudio && wordAudio.base64) {
                audioEntries.push({
                    filename: wordAudioFilename,
                    data: wordAudio.base64,
                    fields: [cfg.fields.termAudio]
                });
            }
            const payload = {
                action: "addNote",
                version: 6,
                params: {
                    note: {
                        deckName: cfg.deck,
                        modelName: cfg.model,
                        fields,
                        options: { allowDuplicate: false },
                        tags: ["mining", "dictionary", dictionary || "unknown"].filter(Boolean),
                        audio: audioEntries,
                        picture: imageData
                            ? [{ filename: imageFilename,
                                 data: imageData.split(",")[1],
                                 fields: [cfg.fields.image] }]
                            : []
                    }
                }
            };

            console.log('📤 Sending to AnkiConnect:', payload);

            fetch("http://127.0.0.1:8765", {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" }
            })
                .then(res => res.json())
                .then(json => {
                    console.log("📥 AnkiConnect response:", json);
                    if (json.error) {
                        reject(new Error("Anki error: " + json.error));
                    } else {
                        console.log(`✅ Word successfully added to Anki from ${dictionary}`);
                        resolve(json);
                    }
                })
                .catch(err => {
                    console.error("❌ AnkiConnect error:", err);
                    reject(err);
                });
        });
        */
        throw new Error('AnkiDroid not detected. Install AnkiDroid from the Play Store.');
    }

    // ==================== TEXT WRAPPING AND HANDLERS (FROM EXISTING CODE) ====================
    
    function wrapTextInSpans() {
        console.log('📝 Wrapping text in spans...');
        
        const el = document.querySelector('.subtitle-text');
        if (!el || !el.textContent.trim()) {
            console.error('❌ No subtitle text to wrap!');
            return;
        }

        const text = el.textContent;
        console.log(`📝 Wrapping text: "${text.substring(0, 50)}..." (${text.length} characters)`);
        
        el.innerHTML = '';

        const fragment = document.createDocumentFragment();
        
        for (const char of text) {
            const span = document.createElement('span');
            span.className = 'dict-frag';
            span.textContent = char;
            fragment.appendChild(span);
        }
        
        el.appendChild(fragment);
        console.log(`✅ Created ${text.length} character spans`);
    }

    function setupLookupHandlers() {
        console.log('🔧 Setting up lookup handlers...');
        
        const container = document.querySelector('.subtitle-text');
        if (!container) {
            console.error('❌ No .subtitle-text container found!');
            return;
        }

        const spans = Array.from(container.querySelectorAll('.dict-frag'));
        if (!spans.length) {
            console.error('❌ No .dict-frag spans found!');
            return;
        }

        console.log(`✅ Setting up handlers for ${spans.length} spans`);

        // Click-anywhere-to-close (legacy desktop / non-touch path).
        // Skip when the paged reader is the active view — paged manages
        // its own dismiss via touchstart/touchend, and this `click`
        // listener fires synchronously AFTER touchend on the same tap.
        // It was hiding the just-shown earlyPopup before the lookup
        // could populate it, producing the "flash, then nothing"
        // symptom in read mode but NOT in card mode (where the tap
        // target carries the `.dict-frag` class, which this guard
        // already excluded).
        document.addEventListener('click', (e) => {
            const pagedView = document.getElementById('readingPagedView');
            if (pagedView && pagedView.style.display !== 'none' &&
                pagedView.style.visibility !== 'hidden' && pagedView.contains(e.target)) return;
            const popup = document.getElementById('dictPopup');
            if (popup && !popup.contains(e.target) && !e.target.classList.contains('dict-frag')) {
                hidePopup();
            }
        });

        // Touch path: race with shell.js's chrome-toggle on touchend. Fire
        // FIRST (capture phase, touchstart-time) so the same gesture that
        // would toggle the chrome instead closes the popup, and the chrome
        // stays as-is. Without this, first tap toggled bars and only the
        // second tap closed the popup.
        //
        // Skip when the PAGED reader is the active view — paged reader
        // has its own dismiss-on-touchstart that lets the SAME tap also
        // trigger a new lookup on text. Letting this global handler
        // dismiss too is harmless visually but stamps the dismissed-ts
        // and (historically) prevented the paged reader's lookup from
        // running on the same tap. The paged reader stamps the ts
        // itself when appropriate, so this listener is redundant there.
        document.addEventListener('touchstart', (e) => {
            const pagedView = document.getElementById('readingPagedView');
            if (pagedView && pagedView.style.display !== 'none' &&
                pagedView.style.visibility !== 'hidden' && pagedView.contains(e.target)) return;
            const popup = document.getElementById('dictPopup');
            if (!popup || popup.style.display === 'none') return;
            const t = e.target;
            if (popup.contains(t)) return;
            if (t && t.classList && t.classList.contains('dict-frag')) return;
            hidePopup();
            // Signal shell.js / reader to ignore this gesture.
            window._dictPopupDismissedTs = Date.now();
        }, { capture: true, passive: true });

        // Helper: bind lookupContext to the CURRENTLY DISPLAYED card before
        // each tap. Without this, the dict's Send falls back to the global
        // _currentReadingCueStartMs which tracks the playing cue, not the
        // visible card — produced the user's "audio is from the previous
        // card" report.
        function bindCardLookupContext(tappedEl) {
            try {
                const idx = window.currentCardIndex;
                const card = Array.isArray(window.allNotes) ? window.allNotes[idx] : null;
                if (!card) { window.lookupContext = null; return; }
                // Combined card: bind to the TAPPED subtitle (or the active one),
                // so "send word to Anki" defaults to that SINGLE subtitle's bounds.
                // The waveform editor still lets the user expand to neighbors.
                if (card.isSrtCard && card.combined) {
                    const cueEl = (tappedEl && tappedEl.closest) ? tappedEl.closest('.combo-cue') : null;
                    const src = cueEl || document.querySelector('#comboSubtitle .combo-cue-active');
                    if (src) {
                        const cs = parseFloat(src.getAttribute('data-cs'));
                        const ce = parseFloat(src.getAttribute('data-ce'));
                        window.lookupContext = {
                            source: 'card', card, cardIdx: idx,
                            sentence: (src.textContent || '').trim(),
                            cueAudioPath: card.audiobookPath,
                            cueStartMs: Number.isFinite(cs) ? cs : card.audiobookStartMs,
                            cueEndMs:   Number.isFinite(ce) ? ce : card.audiobookEndMs,
                            cueIndex:   parseInt(src.getAttribute('data-gi')),
                            cues: null,
                            comboCardText: (card.cueTexts || []).join('')
                        };
                        return;
                    }
                }
                if (card.isSrtCard && Number.isFinite(card.audiobookStartMs)) {
                    window.lookupContext = {
                        source: 'card',
                        card,
                        cardIdx: idx,
                        sentence: (card.expression || '').replace(/<[^>]+>/g, '').trim(),
                        cueAudioPath: card.audiobookPath,
                        cueStartMs:   card.audiobookStartMs,
                        cueEndMs:     card.audiobookEndMs,
                        cueIndex:     idx,  // for SRT-cards, cardIdx === cueIdx
                        cues:         null
                    };
                    console.log('[card-dict] lookupContext bound: cardIdx=' + idx +
                        ' startMs=' + card.audiobookStartMs +
                        ' text="' + (card.expression || '').slice(0, 30) + '"');
                } else {
                    window.lookupContext = null;
                }
            } catch (e) {}
        }

        spans.forEach((span, index) => {
            // Touch handler for mobile. We track touch motion so a SCROLL
            // doesn't fire a lookup — on iOS, touchstart on a span is also
            // the start of a scroll gesture, and we must not preventDefault
            // until we know it's a tap (otherwise scrolling is dead). Track
            // movement; only fire highlight+lookup if the finger stayed put.
            let tsX = 0, tsY = 0, moved = false;
            span.addEventListener('touchstart', (e) => {
                const t = e.touches[0];
                tsX = t ? t.clientX : 0;
                tsY = t ? t.clientY : 0;
                moved = false;
                if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
            }, { passive: true });
            span.addEventListener('touchmove', (e) => {
                if (moved) return;
                const t = e.touches[0];
                if (!t) return;
                const dx = Math.abs(t.clientX - tsX);
                const dy = Math.abs(t.clientY - tsY);
                if (dx > 8 || dy > 8) moved = true;
            }, { passive: true });
            span.addEventListener('touchend', async (e) => {
                if (moved) return; // scrolled, not a tap
                e.preventDefault();
                e.stopPropagation();
                // If the dict popup is already open, THIS tap is a dismiss — just
                // close it and swallow the tap; do NOT trigger a new lookup on the
                // tapped word. Mirrors read mode (a tap that dismisses the popup
                // does nothing else). Stamp the dismissed-ts so other handlers
                // (paged reader / global) also skip a same-gesture lookup.
                const _pop = document.getElementById('dictPopup');
                if (_pop && _pop.style.display !== 'none') {
                    try { window.hideDictPopup?.(); } catch (_) {}
                    window._dictPopupDismissedTs = Date.now();
                    return;
                }
                bindCardLookupContext(span);
                const text = spans.map(s => s.textContent).join('');
                const charIndex = spans.slice(0, index)
                    .reduce((sum, s) => sum + s.textContent.length, 0);
                const best = await greedyDeinflect(text, charIndex);
                highlightSpans(spans, index, best.length);
                performLookup(spans, index);
            });
            span.addEventListener('touchcancel', () => {
                if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
                clearHighlight();
            });
        });
        
        console.log('✅ Click handlers attached to all spans');
    }

    // Global dictionary loading promise - only load once
    let dictionaryLoadingPromise = null;
    let dictionaryLoadingStarted = false;

    // ==================== GLOBAL DICTIONARY LOADER ====================
    
    function startGlobalDictionaryLoading() {
        if (dictionaryLoadingStarted) {
            return dictionaryLoadingPromise; // Return existing promise
        }

        dictionaryLoadingStarted = true;
        console.log('🌐 Starting global dictionary loading (one time only)...');

        dictionaryLoadingPromise = (async () => {
            try {
                // ALWAYS load the deinflect rules — small file, fast.
                await loadDeinflectRules();
                console.log('✅ Deinflect rules loaded');

                // Check if dictStore is already populated. If so, the
                // legacy ensureJM() path (which re-parses JMDict, re-
                // loads Yomitan dicts, walks bundled archives) is pure
                // duplication of data we already have on disk and pure
                // wasted boot time. Skip it entirely and use dictStore
                // as the authoritative source. termSet build is all we
                // need to make lookups fast.
                const t0 = performance.now();
                let storePopulated = false;
                try { storePopulated = !!(await window.dictStore?.isPopulated?.()); } catch (_) {}
                if (storePopulated) {
                    console.log(`✅ dictStore already populated — skipping ensureJM`);
                } else {
                    console.log('📚 dictStore empty — running ensureJM legacy load');
                    await ensureJM();
                }

                // Drop any JMDict an older build migrated into dictStore so
                // lookups reflect the removal. (No term-index pre-build any more —
                // existence is answered per-tap via dictStore.existsBulk, so
                // startup is instant regardless of dictionary size.)
                await purgeStaleJMDictFromStore();
                // Mark dictionaries READY regardless of which source served them.
                // dictLoaded is otherwise set ONLY inside ensureJM(), but the
                // dictStore-populated branch above SKIPS ensureJM — so without
                // this the readiness gate (dictsReady, ~line 1735) and the
                // first-lookup loader (isFirstLookup, ~line 1799) would stay
                // stuck 'not ready' forever and show "Initializing Dictionaries…"
                // on every tap once the term index is actually built and fast.
                dictLoaded = true;
                console.log(`✅ Global dictionary loading complete in ${Math.round(performance.now() - t0)}ms`);
                return true;
            } catch (error) {
                console.error('❌ Global dictionary loading failed:', error);
                hideStartupProgress();
                return false;
            }
        })();

        return dictionaryLoadingPromise;
    }

    // Eagerly kick off dictionary loading at script-evaluation time, so
    // the rules + termSet are warm by the time the user navigates to a
    // deck and taps their first word. This used to live somewhere
    // implicit and clearly got lost in a refactor; making it explicit
    // here so we don't lose it again.
    window._dictLoadPromise = startGlobalDictionaryLoading();

    // ==================== MAIN INITIALIZATION ====================
    
    window.performDictLookup = async function (spans, index) {
        // Ensure dictionaries start loading on first external use AND
        // expose the promise so performLookup can await it before
        // greedyDeinflect runs (fixes single-char matches on first tap).
        window._dictLoadPromise = startGlobalDictionaryLoading();
        return performLookup(spans, index);
    };

    // Reader-mode dict lookup. Takes pre-computed flat text + char index
    // (from reading-mode's caretRangeFromPoint path) and uses a caller-
    // provided highlight painter to mark the matched span via CSS Custom
    // Highlight API instead of mutating the chunk's DOM.
    //
    //   chunk:       the .reading-chunk element
    //   textNodes:   array of Text nodes (rt/rp filtered)
    //   flatText:    concatenation of textNodes' values
    //   charIndex:   character offset of the tap within flatText
    //   paintFn:     function(chunk, textNodes, charStart, length) — paints
    //                the highlight via CSS.highlights.set
    window.performDictLookupAtPosition = async function (chunk, textNodes, flatText, charIndex, paintFn) {
        // Cancellation token — each call bumps the counter; a stale in-
        // flight call sees its token mismatch and aborts before painting.
        // Without this, rapid taps queued up so the popup flashed Loading
        // for every tap and definitions from earlier taps would pop up
        // seconds later in random order.
        const token = ++currentLookupToken;
        const loadPromise = startGlobalDictionaryLoading();
        if (document.body.classList.contains('mode-read') && window.stats?.bumpRead) {
            window.stats.bumpRead();
        }
        try {
            hidePopup();
            // Immediate feedback popup (same pattern as performLookup).
            const earlyPopup = getOrCreatePopup();
            earlyPopup.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 0;">
                    <div style="color:#4caf50;font-size:.9em;">Looking up…</div>
                </div>`;
            positionDictPopup(earlyPopup);
            earlyPopup.style.display = 'block';

            // CRITICAL: deinflection needs data. On first tap we must wait
            // for either the in-memory `dictionaries` Map to be populated
            // (ensureJM legacy path) or for dict-store's termSet to be
            // built. Without this, greedyDeinflect returns single-char
            // matches because hasTermAnywhere always returns false against
            // empty stores (the symptom: "tapped 高かった, got just 高").
            try { await loadPromise; } catch (e) {}

            // Cancellation: if another tap fired while we were awaiting
            // dict load, abandon this stale lookup.
            if (token !== currentLookupToken) return;

            const best = await greedyDeinflect(flatText, charIndex);
            // Paint via CSS Custom Highlight API — no DOM mutation.
            if (typeof paintFn === 'function') {
                try { paintFn(chunk, textNodes, charIndex, best.length); } catch (e) {}
            }

            const results = await multiDictionaryLookup(best.base);
            // If a NEWER tap fired while we were awaiting, drop this
            // result silently. Otherwise we'd race the newer tap and
            // paint definitions out of order.
            if (token !== currentLookupToken) return;
            currentLookupResults = results;
            currentResultIndex = 0;

            const popup = document.getElementById('dictPopup');
            if (!popup) return;
            if (!results || results.length === 0) {
                // Distinguish "word genuinely not in any dictionary" from "no
                // dictionaries are installed at all" — the latter is a setup
                // problem the user can fix, so point them at Preferences instead
                // of the misleading "No definition found." Check BOTH sources:
                // the legacy in-memory `dictionaries` Map (sync, in scope) AND
                // dictStore.isPopulated() (the IDB store — some users have dicts
                // ONLY there). It's "no dictionaries" only when both are empty.
                let noDicts = dictionaries.size === 0;
                if (noDicts && window.dictStore?.isPopulated) {
                    try { noDicts = !(await window.dictStore.isPopulated()); } catch (_) {}
                }
                if (token !== currentLookupToken) return; // a newer tap superseded us during the async check
                const emptyMsg = noDicts
                    ? 'No dictionaries loaded — add one in Preferences.'
                    : 'No definition found.';
                popup.innerHTML = `
                    <div style="padding:20px;text-align:center;">
                        <div style="font-size:1.1em;font-weight:700;margin-bottom:8px;">${best.base}</div>
                        <div style="color:#888;font-size:.85em;">${emptyMsg}</div>
                        <div style="color:#666;font-size:.7em;margin-top:12px;">Tap anywhere to close</div>
                    </div>`;
                // CRITICAL: explicit display='block'. The results branch
                // below sets it; the empty branch was missing it, so when
                // the earlyPopup got dismissed mid-lookup (by another tap
                // or the global handler), the "No definition found"
                // message never became visible. User saw "tap → flash →
                // nothing" — actually the popup HAD updated, it was just
                // stuck at display:none.
                popup.style.display = 'block';
                positionDictPopup(popup);
                maybePauseForLookup();
                return;
            }
            popup.innerHTML = renderPopupContent(results, currentResultIndex);
            popup.style.display = 'block';
            positionDictPopup(popup);
            // Re-position one frame later so the CSS Custom Highlight
            // has finished its layout pass — the first call can hit
            // the no-hlRect fallback (centered) because the Highlight
            // registry update is sync but the rendered rect lags by
            // a frame on iOS WKWebView.
            requestAnimationFrame(() => positionDictPopup(popup));
            setupNavigationHandlers();
            setupAnkiHandler(results);
            setupAudioHandler(results);
            setupPlayheadHandler();
            maybePauseForLookup();
        } catch (e) {
            console.error('performDictLookupAtPosition error:', e);
        }
    };

    window.wrapSubtitleTokens = async function() {
        console.log('🚀 Initializing card subtitle (lazy dict mode)…');

        try {
            // Lazy dict loading: do NOT kick off the dictionary load here.
            // Wrapping subtitle chars in <span>s is cheap and tap-ready;
            // the heavy JMDict + Yomitan IDB hydration only runs the first
            // time the user actually taps a word (see performDictLookup).
            // Boot warmup went from ~20 s to near-instant for users who
            // don't immediately do a lookup.

            // Combined card (combo-card.js already built per-cue .dict-frag
            // spans): DON'T flatten — that would destroy the per-subtitle
            // structure + line breaks. Just wire the existing spans.
            if (document.querySelector('.subtitle-text.combo')) {
                console.log('🔧 Combined card: skip flatten, wire existing spans');
            } else {
                console.log('🔧 Wrapping text for current card...');
                wrapTextInSpans();
                console.log('✅ Text wrapping complete!');
            }

            console.log('🎯 Setting up lookup handlers...');
            setupLookupHandlers();
            console.log('✅ Lookup handlers ready!');

            // Faux promise so the existing .then().catch() chain below
            // still works without restructuring. Resolves immediately;
            // the real load promise lives behind performDictLookup.
            const loadingPromise = Promise.resolve(true);
            loadingPromise.then((success) => {
                if (success) {
                    console.log('🎉 Dictionary system fully ready!');
                    console.log(`📊 Available dictionaries: ${Array.from(dictionaries.keys()).join(', ')}`);
                } else {
                    console.log('⚠️ Dictionary system ready with JMDict only');
                }
            });
            
        } catch (error) {
            console.error('❌ Card initialization failed:', error);
            
            // Hide progress bar on error
            hideStartupProgress();
            
            // Fallback to basic wrapping
            const el = document.querySelector('.subtitle-text');
            if (el) {
                console.log('⚠️ Falling back to basic text wrapping');
                wrapTextInSpans();
            }
        }
    };

    // ==================== CSS STYLES ====================
    
    console.log('🎨 Adding CSS styles...');
    const style = document.createElement('style');
    style.textContent = `
        .dict-frag {
            user-select: none;
            -webkit-user-select: none;
            cursor: pointer;
            transition: background 0.2s;
            touch-action: manipulation;
            display: inline;
        }
        
        /* Dictionary highlight: light translucent mode-color wash that lets
           the text underneath stay readable. Forced black text + heavy fill
           (60-70% alpha) made it look like dark blocks blurring out the
           word being looked up — exactly the opposite of "highlight the
           thing I tapped on". Now: 28% alpha of the mode's accent, native
           text color inherited (white), and a 2px underline in the accent
           so even partially-transparent picks remain visible. */
        /* Dict-lookup pick = BACKGROUND highlight only. The underline was added
           for visibility but adding/removing text-decoration reflows the line on
           iOS WebKit (the subtitle "jiggle" on tap). A stronger 40% background
           keeps the pick clearly visible without any metric change. */
        .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-cyan, #00ffcc) 40%, transparent) !important;
            border-radius: 3px;
        }
        body.mode-card  .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-card, #ff9550) 40%, transparent) !important;
        }
        body.mode-read  .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-read, #4caf50) 40%, transparent) !important;
        }
        body.mode-audio .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-audio, #b794f6) 40%, transparent) !important;
        }

        /* ---- Combined card (multiple short subtitles on one card) ---- */
        /* Each unit (sentence/quote) is its own block → line break between
           sentences; cues flow within a unit. The currently-narrated subtitle is
           painted in the card accent (orange); the rest stay normal. A bounded
           height makes a long card autoscroll to keep the active line in view. */
        /* NOTE: the #cardContainer prefix is REQUIRED — theme.css's base rule
           "#cardContainer .subtitle-text { max-height:55vh; overflow-y:auto }"
           has ID specificity and would otherwise override these (combos would
           still scroll + ignore the screen-fit budget). Matching the ID lets the
           extra .combo / .srt-active class win. */
        #cardContainer .subtitle-text.combo {
            display: block;
            /* Height fits the screen (set by applyComboMaxHeightVar from the
               screen-fit budget). A COMBINED card NEVER scrolls — a scroll
               container swallows the swipe up/down transport shortcuts — so the
               line budget is responsible for making it fit; overflow is clipped
               as a safety, never scrolled. */
            max-height: var(--combo-max-h, 62vh);
            overflow: hidden;
            line-height: 1.5;
        }
        /* A SINGLE subtitle (1 cue, no combine) is the ONLY thing allowed to
           scroll, and only when it's exceptionally long (taller than the screen
           budget). Normal single subtitles fit and don't scroll. */
        #cardContainer .subtitle-text.srt-active {
            max-height: var(--combo-max-h, 62vh);
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        }
        .subtitle-text.combo .combo-cue { color: inherit; transition: color .15s ease; }
        /* Line break after each quote/sentence, with ~half a line of extra gap. */
        .subtitle-text.combo .combo-nl { display: block; height: 0.5em; }
        /* Anti-orphan: glue the last few chars of each sentence so a single
           trailing char (e.g. "た。") can't land alone on the final line. */
        .subtitle-text.combo .combo-keep { white-space: nowrap; }
        body.mode-card .subtitle-text.combo .combo-cue-active,
        body.mode-card .subtitle-text.combo .combo-cue-active .dict-frag {
            color: var(--accent-card, #ff9550) !important;
        }
        /* Single-subtitle SRT card: the whole (only) subtitle IS the current
           line, so color it like the active cue. */
        body.mode-card .subtitle-text.srt-active,
        body.mode-card .subtitle-text.srt-active .dict-frag {
            color: var(--accent-card, #ff9550) !important;
        }

        .subtitle-text {
            user-select: none !important;
            -webkit-user-select: none !important;
            white-space: pre-wrap !important;
            line-height: 1.4 !important;
            font-size: 2.4rem !important; /* Decreased from 2.8rem */
            width: 92% !important;
            background-color: transparent !important;
            left: 4% !important;
            right: 4% !important;
            position: absolute !important;
            top: calc(env(safe-area-inset-top, 0px) + var(--subtitle-offset, 65px)) !important;
            padding: 12px 20px !important;
            box-sizing: border-box !important;
            text-align: center !important;
            color: #fff !important;
        }
        
        /* Idle dict-frag is invisible — no per-char dimming. The earlier
           rgba(0,0,0,0.1) "fix" was actually the cause of the "very dark"
           card-mode subtitle: it darkened every character a little, making
           the whole sentence look muddled. Only flip backgrounds on
           .highlight (driven by the selection logic).
           NOTE: the :hover rule has been removed because iOS Mobile Safari
           leaves :hover sticky on touched-and-released elements, producing
           green smears across text after any drag/scroll. */
        .dict-frag {
            background-color: transparent !important;
        }
        
        #dictPopup {
            -webkit-overflow-scrolling: touch !important;
            overscroll-behavior: contain;
            overflow-y: auto !important;
            overflow-x: hidden;
        }
        /* In-app dictionary popup card. Compact, dark, type-forward.
           Reading sits above the term, source pill in mode color, sense
           cards with a numbered head row. */
        #dictPopup {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
        }
        .dict-popup-playhead-section {
            margin: -4px 0 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid #2a2a2a;
        }
        .dict-popup-playhead-btn {
            width: 100%;
            background: rgba(76, 175, 80, 0.10);
            border: 1px solid rgba(76, 175, 80, 0.45);
            color: var(--accent-read, #4caf50);
            padding: 10px 14px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
            letter-spacing: 0.02em;
        }
        .dict-popup-playhead-btn:active { background: rgba(76, 175, 80, 0.18); }
        .dict-popup-playhead-btn[disabled] {
            opacity: 0.4;
            cursor: default;
        }
        .dict-popup-playhead-icon { font-size: 14px; }
        .dict-popup-playhead-label { flex: 1; text-align: left; }
        .dict-popup-playhead-time {
            font-variant-numeric: tabular-nums;
            font-size: 12px;
            color: #b0b0b0;
        }
        .dict-popup-header {
            display: flex; justify-content: space-between; align-items: flex-start;
            gap: 12px; margin-bottom: 12px;
        }
        .dict-popup-title-block { flex: 1; min-width: 0; }
        .dict-popup-reading {
            color: #b0b0b0; font-size: 0.75em; letter-spacing: 0.04em;
            margin-bottom: 2px; font-weight: 400;
        }
        .dict-popup-term {
            font-size: 2em; font-weight: 700; color: #fff;
            line-height: 1.1; letter-spacing: -0.01em;
        }
        /* Furigana ruby over the headword (Tier-1 dictionary ruby). */
        .dict-popup-term ruby { ruby-position: over; ruby-align: center; }
        .dict-popup-term ruby rt {
            font-size: 0.5em; color: #ffa726; font-weight: 500;
            line-height: 1.05; letter-spacing: 0.02em; text-align: center;
            user-select: none; -webkit-user-select: none;
        }
        .dict-popup-header-icons {
            display: flex; flex-direction: row; align-items: center; gap: 8px;
            flex-shrink: 0;
        }
        .dict-popup-icon-btn {
            background: transparent; color: #d0d0d0;
            border: 1px solid transparent;
            padding: 4px 6px; cursor: pointer;
            border-radius: 6px;
            display: inline-flex; align-items: center; justify-content: center;
        }
        .dict-popup-icon-btn:active { background: rgba(255,255,255,0.06); }
        .dict-popup-icon-btn svg { display: block; }
        .dict-popup-anki-btn {
            background: var(--accent-read, #4caf50); color: #000;
            border: none; padding: 6px 12px; border-radius: 999px;
            font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em;
            cursor: pointer; text-transform: uppercase;
        }
        .dict-popup-anki-btn:disabled { opacity: 0.4; cursor: default; }
        .dict-popup-nav {
            display: flex; align-items: center; justify-content: center;
            gap: 12px; padding: 6px 0 12px 0;
            border-bottom: 1px solid #1f1f1f; margin-bottom: 12px;
        }
        .dict-popup-nav-btn {
            background: transparent; color: #aaa;
            border: 1px solid #333; padding: 4px 10px; border-radius: 999px;
            font-size: 0.75em; letter-spacing: 0.05em; cursor: pointer;
        }
        .dict-popup-nav-btn:disabled { color: #444; border-color: #1f1f1f; cursor: default; }
        .dict-popup-nav-count {
            color: #888; font-size: 0.8em; font-variant-numeric: tabular-nums;
            letter-spacing: 0.05em;
        }
        .dict-popup-sense {
            margin-bottom: 16px;
        }
        .dict-popup-sense-head {
            display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
            margin-bottom: 6px;
        }
        .dict-popup-sense-num {
            font-size: 1.05em; font-weight: 700; color: #fff;
            margin-right: 4px;
        }
        .dict-popup-pill {
            display: inline-block; padding: 2px 8px; border-radius: 4px;
            font-size: 0.7em; font-weight: 600; letter-spacing: 0.03em;
            line-height: 1.5;
        }
        .dict-popup-pill-pos {
            background: #2a2a2a; color: #d0d0d0;
        }
        .dict-popup-pill-dict {
            background: #6b4ea3; color: #fff;
        }
        .dict-popup-glosses {
            margin: 0; padding-left: 22px; list-style: disc;
            color: #ddd; line-height: 1.45;
        }
        .dict-popup-glosses li {
            font-size: 0.95em; margin-bottom: 2px;
        }
        .dict-popup-empty {
            font-size: 1em; color: #ccc; text-align: center; padding: 8px 0;
        }
        .dict-popup-hint {
            color: #555; font-size: 0.72em; text-align: center;
            margin-top: 14px; padding-top: 8px; border-top: 1px solid #1f1f1f;
            letter-spacing: 0.04em;
        }
    `;
    document.head.appendChild(style);
    console.log('✅ CSS styles added');

    console.log('✅ Integrated Yomitan Dictionary System loaded successfully!');

})();