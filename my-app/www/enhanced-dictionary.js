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
    let dictLoaded = false;
    let rules = [];
    let rulesLoaded = false;
    let lastHovered = [];
    let touchTimer = null;

    // ==================== DICTIONARY SCANNING ====================
    
    async function scanDictionaryFiles() {
        console.log('📚 Dynamically scanning for .zip dictionary files...');
        
        try {
            // Since JMdict loads successfully from 'assets/dictionaries/', let's test that exact path
            console.log('📚 Testing the same path that works for JMdict...');
            
            // First, let's verify the path works by testing a known file
            try {
                console.log('📚 Testing known working path with JMdict...');
                const testResponse = await fetch('assets/dictionaries/JMdict_english.json', { method: 'HEAD' });
                console.log(`📚 JMdict test: status=${testResponse.status}, ok=${testResponse.ok}`);
            } catch (error) {
                console.log('📚 JMdict test failed:', error);
            }
            
            const yourDictionaries = [
                'MonolingualA.zip'
                //'sankoku8.zip'
                // Removed duplicate Kotowaza.zip
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
                    'sankoku8.zip',
                    'dict.zip', 
                    'dictionary.zip',
                    'test.zip'
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
        const zip = await JSZip.loadAsync(arrayBuffer);
        const indexFile = zip.file('index.json');
        if (!indexFile) throw new Error('Not a Yomitan dictionary: index.json missing');
        const indexData = JSON.parse(await indexFile.async('text'));
        const dictName = (indexData.title || opts.fallbackName || 'Imported').trim();
        if (!dictName) throw new Error('Dictionary has no title');
        const termEntries = new Map();
        let bankIndex = 1;
        let totalEntries = 0;
        while (true) {
            const bankFile = zip.file(`term_bank_${bankIndex}.json`);
            if (!bankFile) break;
            const bankData = JSON.parse(await bankFile.async('text'));
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
            bankIndex++;
        }
        if (totalEntries === 0) throw new Error('Dictionary has no term_bank entries');
        const metadata = { ...indexData, filename: opts.fallbackName || dictName + '.zip' };
        // Register in-memory.
        dictionaries.set(dictName, termEntries);
        dictionaryMetadata.set(dictName, metadata);
        // Persist for next launch.
        if (window.dictCache?.save) {
            await window.dictCache.save(
                IMPORTED_CACHE_PREFIX + dictName,
                IMPORTED_CACHE_VERSION,
                { termEntries, metadata }
            );
        }
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
        for (const name of list) {
            if (dictionaries.has(name)) continue;
            try {
                const cached = await window.dictCache?.load?.(IMPORTED_CACHE_PREFIX + name, IMPORTED_CACHE_VERSION);
                if (cached?.termEntries) {
                    dictionaries.set(name, cached.termEntries);
                    if (cached.metadata) dictionaryMetadata.set(name, cached.metadata);
                    console.log(`✅ Restored imported dict "${name}" from cache: ${cached.termEntries.size} terms`);
                }
            } catch (e) {
                console.warn(`Failed to restore imported dict "${name}":`, e);
            }
        }
    }

    async function removeImportedDictionary(name) {
        dictionaries.delete(name);
        dictionaryMetadata.delete(name);
        const list = listImportedDicts().filter(n => n !== name);
        persistImportedList(list);
        try { await window.dictCache?.clear?.(IMPORTED_CACHE_PREFIX + name); } catch (e) {}
        console.log(`🗑 Removed imported dict "${name}"`);
    }

    window.importYomitanDictionaryFromBuffer = async function (arrayBuffer, opts) {
        return await ingestZipBuffer(arrayBuffer, opts);
    };
    window.listImportedDictionaries = listImportedDicts;
    window.removeImportedDictionary = removeImportedDictionary;
    window.loadImportedDictionariesFromCache = loadImportedDictionariesFromCache;

    // ==================== JMDICT LOADING (EXISTING FUNCTIONALITY) ====================
    
    // Bump JMDICT_CACHE_VERSION whenever the bundled JMdict_english.json changes
    // so cached IDB copies are invalidated and re-parsed.
    const JMDICT_CACHE_VERSION = '2025-05-19';

    async function loadJMDict() {
        console.log('📚 Loading JMDict...');

        // 1) Try IndexedDB cache first. After first install, this returns the
        //    parsed Map in milliseconds — no fetch, no JSON.parse, no index
        //    rebuild.
        if (window.dictCache && typeof window.dictCache.load === 'function') {
            try {
                const cached = await window.dictCache.load('JMDict', JMDICT_CACHE_VERSION);
                if (cached && typeof cached.size === 'number' && cached.size > 0) {
                    dictionaries.set('JMDict', cached);
                    dictionaryMetadata.set('JMDict', {
                        title: 'JMDict',
                        revision: JMDICT_CACHE_VERSION,
                        filename: 'JMdict_english.json'
                    });
                    console.log(`✅ JMDict from cache: ${cached.size} indexed terms`);
                    return;
                }
            } catch (e) {
                console.warn('JMDict cache load failed; falling back to parse:', e);
            }
        }

        try {
            const res = await fetch('assets/dictionaries/JMdict_english.json');
            console.log('📚 JMdict fetch status:', res.status, res.statusText);

            if (!res.ok) {
                throw new Error(`JMdict fetch failed: ${res.status} ${res.statusText}`);
            }

            console.log('📚 JMdict fetch successful, parsing JSON...');
            const raw = await res.json();
            console.log('📚 JMdict JSON parsed, building index...');

            if (!raw.words || !Array.isArray(raw.words)) {
                throw new Error('Invalid JMdict format - no words array found');
            }

            console.log(`📚 Found ${raw.words.length} dictionary words, building index...`);

            const jmEntries = new Map();
            let count = 0;

            for (const e of raw.words) {
                // Index kanji forms
                (e.kanji || []).forEach(k => {
                    if (k.text) {
                        if (!jmEntries.has(k.text)) {
                            jmEntries.set(k.text, []);
                        }
                        jmEntries.get(k.text).push(e);
                        count++;
                    }
                });

                // Index kana forms
                (e.kana || []).forEach(k => {
                    if (k.text) {
                        if (!jmEntries.has(k.text)) {
                            jmEntries.set(k.text, []);
                        }
                        jmEntries.get(k.text).push(e);
                        count++;
                    }
                });
            }

            dictionaries.set('JMDict', jmEntries);
            dictionaryMetadata.set('JMDict', {
                title: 'JMDict',
                revision: JMDICT_CACHE_VERSION,
                filename: 'JMdict_english.json'
            });

            // 2) Persist the parsed Map so next launch hits the cache.
            if (window.dictCache && typeof window.dictCache.save === 'function') {
                window.dictCache.save('JMDict', JMDICT_CACHE_VERSION, jmEntries)
                    .catch(err => console.warn('JMDict cache save failed:', err));
            }

            console.log(`✅ Successfully loaded JMdict with ${count} total entries`);
            
        } catch (error) {
            console.error('❌ JMdict loading failed:', error);
            console.log('⚠️ Falling back to test dictionary');
            
            // Create test dictionary
            const testEntries = new Map();
            testEntries.set('食べる', [{
                kanji: [{ text: '食べる' }],
                kana: [{ text: 'たべる' }],
                sense: [{ gloss: [{ text: 'to eat' }] }]
            }]);
            testEntries.set('たべる', testEntries.get('食べる'));
            
            dictionaries.set('JMDict', testEntries);
            dictionaryMetadata.set('JMDict', {
                title: 'JMDict (Test)',
                revision: 'test',
                filename: 'test'
            });
        }
    }

    // ==================== MULTI-DICTIONARY LOOKUP ====================
    
    async function multiDictionaryLookup(term) {
        await ensureJM();

        const results = [];

        // Use user-defined dictionary order + enable flags (dict-prefs.js)
        // when available; otherwise fall back to original behavior.
        const allNames = Array.from(dictionaries.keys());
        const ordered = (window.dictPrefs && typeof window.dictPrefs.orderedNames === 'function')
          ? window.dictPrefs.orderedNames(allNames)
          : allNames;
        const isEnabled = (n) => window.dictPrefs?.isEnabled
            ? window.dictPrefs.isEnabled(n) : true;

        for (const dictName of ordered) {
            if (!isEnabled(dictName)) continue;
            const entries = dictionaries.get(dictName);
            if (entries && entries.has(term)) {
                const dictEntries = entries.get(term);
                for (const entry of dictEntries) {
                    results.push({
                        dictionary: dictName,
                        term: term,
                        entry: entry,
                        type: dictName === 'JMDict' ? 'jmdict' : 'yomitan'
                    });
                }
            }
        }

        console.log(`🔍 Found ${results.length} results for "${term}" across dictionaries`);
        return results;
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
            updateStartupProgress('Loading Yomitan dictionaries...', 0);
            await loadYomitanDictionaries();
            // User-imported Yomitan dictionaries (persisted in IDB).
            await loadImportedDictionariesFromCache();

            updateStartupProgress('Loading JMDict...', 90, 'Loading fallback dictionary...');
            await loadJMDict();
            
            updateStartupProgress('Dictionaries ready!', 100, 'All dictionaries loaded successfully');
            
            // Hide progress after brief delay
            setTimeout(() => {
                hideStartupProgress();
            }, 1000);
            
        } catch (error) {
            console.error('❌ Dictionary loading failed:', error);
            updateStartupProgress('Loading JMDict only...', 95, 'Falling back to JMDict');
            await loadJMDict(); // Fallback to JMDict only
            
            setTimeout(() => {
                hideStartupProgress();
            }, 1500);
        }
        
        dictLoaded = true;
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

    function getDeinflections(surface, maxDepth = 3) {
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
    
    function renderYomitanEntry(result) {
        const { dictionary, term, entry, type } = result;
        
        if (type === 'jmdict') {
            return renderJMDictEntry(result);
        }
        
        // Yomitan entry format: [term, reading, definitionTags, ruleTags, score, definitions, sequence, termTags]
        const [entryTerm, reading, defTags, ruleTags, score, definitions] = entry;
        
        let content = `<div style="font-size:1.2em;font-weight:700">${entryTerm}</div>`;
        
        if (reading && reading !== entryTerm) {
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

        let content = `<div style="font-size:1.2em;font-weight:700">${term}</div>`;
        
        if (reading) {
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
        if (!results || results.length === 0) {
            return `<div class="manatan-empty">No dictionary entries found
                <div class="manatan-hint">Tap anywhere to close</div></div>`;
        }
        const result = results[currentIndex];
        const isJmdict = result.type === 'jmdict';
        const reading = isJmdict
            ? (result.entry.kana || []).map(k => k.text).join('・')
            : (result.entry[1] && result.entry[1] !== result.term ? result.entry[1] : '');
        const dictTag = result.dictionary || (isJmdict ? 'JMdict' : '');

        let content = `
            <div class="manatan-header">
                <div class="manatan-title-block">
                    ${reading ? `<div class="manatan-reading">${reading}</div>` : ''}
                    <div class="manatan-term">${result.term}</div>
                </div>
                <div class="manatan-header-icons">
                    <button id="audioBtn" type="button" title="Play audio" class="manatan-icon-btn" aria-label="Play audio">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 5L6 9H3v6h3l5 4V5z"/>
                        <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
                        <path d="M18.5 5.5a9 9 0 0 1 0 13"/>
                      </svg>
                    </button>
                    <button id="ankiBtn" class="manatan-anki-btn"
                            data-dictionary="${result.dictionary}"
                            data-term="${result.term}"
                            data-type="${result.type}">+ Anki</button>
                </div>
            </div>
        `;
        if (results.length > 1) {
            content += `
                <div class="manatan-nav">
                    <button id="prevResult" class="manatan-nav-btn" ${currentIndex === 0 ? 'disabled' : ''}>← Prev</button>
                    <span class="manatan-nav-count">${currentIndex + 1} / ${results.length}</span>
                    <button id="nextResult" class="manatan-nav-btn" ${currentIndex === results.length - 1 ? 'disabled' : ''}>Next →</button>
                </div>
            `;
        }

        if (isJmdict) {
            const senses = (result.entry.sense || []);
            senses.forEach((s, i) => {
                const pos = (s.partOfSpeech || []).slice(0, 2).join(', ');
                const glosses = (s.gloss || []).map(g => `<li>${g.text}</li>`).join('');
                if (!glosses) return;
                content += `
                    <div class="manatan-sense">
                        <div class="manatan-sense-head">
                            <span class="manatan-sense-num">${i + 1}.</span>
                            ${pos ? `<span class="manatan-pill manatan-pill-pos">${pos}</span>` : ''}
                            <span class="manatan-pill manatan-pill-dict">${dictTag}</span>
                        </div>
                        <ul class="manatan-glosses">${glosses}</ul>
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
                content += `
                    <div class="manatan-sense">
                        <div class="manatan-sense-head">
                            <span class="manatan-sense-num">${count}.</span>
                            <span class="manatan-pill manatan-pill-dict">${dictTag}</span>
                        </div>
                        <ul class="manatan-glosses"><li>${text}</li></ul>
                    </div>
                `;
            }
        }

        content += `<div class="manatan-hint">Tap anywhere to close</div>`;
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
            const cueRect = audiobookCue.getBoundingClientRect();
            const top  = Math.max(margin, cueRect.bottom + margin);
            const maxH = Math.min(vh * 0.42, 380);
            const h    = Math.min(maxH, Math.max(180, vh - top - margin * 2));
            const w    = Math.min(vw * 0.92, 500);
            popup.style.width  = `${w}px`;
            popup.style.height = `${h}px`;
            popup.style.left   = `${(vw - w) / 2}px`;
            popup.style.top    = `${top}px`;
            return;
        }

        // Card mode: anchor below the subtitle text.
        const subtitleEl = document.querySelector('.subtitle-text');
        const subtitleVisible = subtitleEl && subtitleEl.offsetParent !== null;
        const imageElement = document.querySelector('.card-image');
        const imageVisible = imageElement && imageElement.offsetParent !== null;
        if (imageVisible && subtitleVisible) {
            const subRect = subtitleEl.getBoundingClientRect();
            const top = Math.max(margin, subRect.bottom + margin);
            const maxH = Math.min(vh * 0.72, 520);
            const h = Math.min(maxH, Math.max(180, vh - top - margin * 2));
            const w = Math.min(vw * 0.92, 560);
            popup.style.width = `${w}px`;
            popup.style.height = `${h}px`;
            popup.style.left = `${(vw - w) / 2}px`;
            popup.style.top = `${top}px`;
            return;
        }
        // Reading-mode fallback: keep the popup out of the active chunk so the
        // user can still see the highlighted word being looked up.
        const w = Math.min(vw * 0.92, 600);

        // Find the area to avoid. Prefer the highlighted dict-frag(s); fall
        // back to the active reading-chunk; else just the touch-most-recent
        // .dict-frag.highlight in the document.
        let avoid = null;
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

        // Compute available space above and below the avoid rect.
        let h, top;
        if (avoid) {
            const spaceAbove = avoid.top - margin * 2;
            const spaceBelow = vh - avoid.bottom - margin * 2;
            const maxH = Math.min(vh * 0.7, 520);
            if (spaceBelow >= spaceAbove) {
                h = Math.min(maxH, Math.max(180, spaceBelow));
                top = Math.min(vh - h - margin, avoid.bottom + margin);
            } else {
                h = Math.min(maxH, Math.max(180, spaceAbove));
                top = Math.max(margin, avoid.top - h - margin);
            }
        } else {
            h = Math.min(vh * 0.7, 520);
            top = (vh - h) / 2;
        }

        popup.style.width = `${w}px`;
        popup.style.height = `${h}px`;
        popup.style.left = `${(vw - w) / 2}px`;
        popup.style.top = `${Math.max(margin, top)}px`;
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
                background: '#0a0a0a',
                color: '#fff',
                borderRadius: '14px',
                padding: '18px 20px',
                fontSize: '16px',
                zIndex: 9999,
                display: 'none',
                boxShadow: '0 12px 40px rgba(0,0,0,.85)',
                border: '1px solid #1a1a1a',
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
        const inReadOrAudio = body.classList.contains('mode-read') ||
                              body.classList.contains('mode-audio');
        if (!inReadOrAudio) return false;
        // Preference defaults to true; user can disable via Preferences.
        const v = localStorage.getItem('DICT_PAUSE_ON_LOOKUP');
        return v === null || v === 'true';
    }
    async function maybePauseForLookup() {
        if (!isLookupModeAutoPause()) return;
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        if (!bg) return;
        try {
            const s = await bg.getState();
            if (s?.playing) {
                _lookupPausedPlayback = true;
                bg.pause();
            }
        } catch (e) {}
    }
    function maybeResumeAfterLookup() {
        if (!_lookupPausedPlayback) return;
        _lookupPausedPlayback = false;
        const bg = window.Capacitor?.Plugins?.BackgroundAudio;
        try { bg?.resume?.(); } catch (e) {}
    }
    window.maybePauseForLookup = maybePauseForLookup;

    function hidePopup() {
        console.log('🚪 Hiding popup...');
        const popup = document.getElementById('dictPopup');
        if (popup) {
            popup.style.display = 'none';
            popup.innerHTML = '';
        }
        clearHighlight();
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

    function greedyDeinflect(text, start, maxLength = 10) {
        console.log(`🔍 Greedy deinflect at position ${start} in text: "${text.substring(start, start + 5)}..."`);
        
        let best = { match: text[start], base: text[start], length: 1 };

        const searchLimit = Math.min(maxLength, text.length - start);
        
        for (let len = 1; len <= searchLimit; len++) {
            const surface = text.slice(start, start + len);
            const forms = getDeinflections(surface, 2);

            for (const f of forms) {
                // Check all dictionaries for this form
                let found = false;
                for (const [dictName, entries] of dictionaries) {
                    if (entries.has(f.word)) {
                        found = true;
                        break;
                    }
                }
                
                if (found && f.word.length >= best.base.length) {
                    console.log(`✨ Found better match: "${surface}" -> "${f.word}"`);
                    best = { match: surface, base: f.word, length: len };
                }
            }
        }

        console.log(`🎯 Best match: "${best.match}" -> "${best.base}" (length: ${best.length})`);
        return best;
    }

    // ==================== MAIN LOOKUP FUNCTION ====================
    
    async function performLookup(spans, index) {
        console.log(`🚀 Performing multi-dictionary lookup for span ${index}...`);
        // Read-mode active-reading signal: looking up a word is a clear
        // sign of active reading, so start the read timer.
        if (document.body.classList.contains('mode-read') && window.stats?.bumpRead) {
          window.stats.bumpRead();
        }
        try {
            hidePopup();
            
            const text = spans.map(s => s.textContent).join('');
            const charIndex = spans.slice(0, index)
                .reduce((sum, s) => sum + s.textContent.length, 0);
            const best = greedyDeinflect(text, charIndex);
            
            highlightSpans(spans, index, best.length);
            
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
                        setupNavigationHandlers();
                        setupAnkiHandler(results);
                        setupAudioHandler(results);
                    }
                }, 500);
            } else {
                // For subsequent lookups, show results immediately (no loading bar)
                const popup = getOrCreatePopup();
                popup.innerHTML = renderPopupContent(results, currentResultIndex);
                // Position BEFORE display:block so no flash at default bounds.
                positionDictPopup(popup);
                popup.style.display = 'block';
                maybePauseForLookup();

                setupNavigationHandlers();
                setupAnkiHandler(results);
                setupAudioHandler(results);
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
    
    function setupNavigationHandlers() {
        const prevBtn = document.getElementById('prevResult');
        const nextBtn = document.getElementById('nextResult');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentResultIndex > 0) {
                    currentResultIndex--;
                    updatePopupContent();
                }
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentResultIndex < currentLookupResults.length - 1) {
                    currentResultIndex++;
                    updatePopupContent();
                }
            });
        }
    }
    
    function updatePopupContent() {
        const popup = document.getElementById('dictPopup');
        if (popup && currentLookupResults.length > 0) {
            popup.innerHTML = renderPopupContent(currentLookupResults, currentResultIndex);
            setupNavigationHandlers();
            setupAnkiHandler(currentLookupResults);
            setupAudioHandler(currentLookupResults);
        }
    }
    
    function setupAudioHandler(results) {
        const btn = document.getElementById('audioBtn');
        if (!btn || !results || results.length === 0) return;
        const result = results[currentResultIndex];
        const term = result.term;
        const reading = extractReadingFromResult(result);

        // Preserve the SVG icon. Earlier versions clobbered btn.textContent
        // on click/unavailable, which wiped the icon and made the button
        // appear to disappear.
        const originalIconHTML = btn.innerHTML;

        const markUnavailable = () => {
            btn.style.opacity = '0.35';
            btn.style.cursor = 'default';
            btn.disabled = true;
            btn.title = 'No local audio for this word';
        };

        if (typeof window.lookupLocalAudio === 'function') {
            window.lookupLocalAudio(term, reading).then(urls => {
                if (!urls || urls.length === 0) markUnavailable();
            }).catch(() => { /* leave the icon as-is; click will report any error */ });
        }

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            if (typeof window.playLocalAudio !== 'function') return;
            btn.disabled = true;
            btn.style.opacity = '0.55';
            try {
                const ok = await window.playLocalAudio(term, reading);
                if (!ok) { markUnavailable(); return; }
            } catch (err) {
                console.warn('Audio play error:', err);
            } finally {
                if (!btn.title || btn.title.indexOf('No local') < 0) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                }
            }
            // Defensive: if anything stripped the SVG, restore it.
            if (!btn.querySelector('svg')) btn.innerHTML = originalIconHTML;
        });
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
                    
                    // Pick context: reading-mode lookups carry the chunk's
                    // matching card via window.lookupContext, so the Anki
                    // sentence + audio come from where the WORD actually lives,
                    // not from whatever card is currently playing in the deck.
                    const ctx = window.lookupContext;
                    const readingView = document.getElementById('readingModeView');
                    const inReadingMode = readingView && readingView.style.display !== 'none';

                    let currentCard, sentence;
                    if (inReadingMode && ctx && ctx.source === 'reading') {
                        currentCard = ctx.card;
                        sentence = (ctx.sentence || '').trim() || result.term;
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
                    // it in the Term Audio field. Quietly skipped if no match.
                    let wordAudio = null;
                    if (typeof window.getLocalAudioBase64 === 'function') {
                        try {
                            wordAudio = await window.getLocalAudioBase64(result.term, reading);
                        } catch (e) {
                            console.warn('Word audio fetch failed:', e);
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
                    const cueAudioPath = ctxCue?.cueAudioPath || window._currentReadingAudiobookPath || null;
                    const cueStartMs   = Number.isFinite(ctxCue?.cueStartMs) ? ctxCue.cueStartMs : window._currentReadingCueStartMs;
                    const cueEndMs     = Number.isFinite(ctxCue?.cueEndMs)   ? ctxCue.cueEndMs   : window._currentReadingCueEndMs;
                    let finalSentence = sentence;
                    if (!audioData && cueAudioPath &&
                        Number.isFinite(cueStartMs) && Number.isFinite(cueEndMs) &&
                        window.waveform?.edit && window.Capacitor?.Plugins?.AudioSlicer) {
                      const adjusted = await window.waveform.edit({
                        srcPath: cueAudioPath,
                        startMs: Math.round(cueStartMs),
                        endMs:   Math.round(cueEndMs),
                        title: sentence || result.term,
                        cues: ctxCue?.cues,
                        cueIndex: Number.isFinite(ctxCue?.cueIndex) ? ctxCue.cueIndex : -1
                      });
                      if (!adjusted) return; // user cancelled
                      if (adjusted.text) finalSentence = adjusted.text;
                      try {
                        const slicer = window.Capacitor.Plugins.AudioSlicer;
                        const slice = await slicer.slice({
                          srcPath: cueAudioPath,
                          startMs: Math.round(adjusted.startMs),
                          endMs:   Math.round(adjusted.endMs)
                        });
                        if (slice?.path && typeof window.cacheFileToDataUri === 'function') {
                          audioData = await window.cacheFileToDataUri(slice.path, slice.mime || 'audio/mp4');
                          console.log('[dict] slice bytes=' + (audioData?.length || 0) + ' mime=' + (slice.mime || ''));
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
                        wordAudio: wordAudio,
                        dictionary: result.dictionary
                    };

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
        } else {
            // Extract from Yomitan structured content (simplified)
            const definitions = result.entry[5] || [];
            const meanings = [];
            
            for (const def of definitions.slice(0, 2)) {
                if (def.type === 'structured-content') {
                    const simpleText = extractSimpleTextFromStructured(def.content);
                    if (simpleText && simpleText.length > 10 && simpleText.length < 200) {
                        meanings.push(simpleText.substring(0, 100));
                    }
                }
            }
            
            return meanings.join('; ') || `Definition from ${result.dictionary}`;
        }
    }
    
    function extractReadingFromResult(result) {
        if (result.type === 'jmdict') {
            return (result.entry.kana || []).map(k => k.text).join('・');
        } else {
            return result.entry[1] || ''; // Reading is at index 1 in Yomitan format
        }
    }

    // ==================== ANKI INTEGRATION (FROM EXISTING CODE) ====================
    
    async function sendWordToAnki({ expression, reading, sentence, meaning, imageData, audioData, wordAudio, dictionary }) {
        // Pull live settings; fall back to the prior hardcoded mapping.
        const cfg = (typeof window.getAnkiSettings === 'function')
          ? await window.getAnkiSettings('dict')
          : { deck: 'Mining', model: 'jidoujisho Kinomoto',
              fields: { term:'Term', reading:'Reading', sentence:'Sentence',
                        meaning:'Meaning', image:'Image',
                        sentenceAudio:'Sentence Audio', termAudio:'Term Audio' } };

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
                if (audioData) {
                    audioList.push({
                        filename:   sentenceAudioFilename,
                        dataBase64: audioData.split(',')[1],
                        field:      cfg.fields.sentenceAudio
                    });
                }
                if (wordAudio && wordAudio.base64) {
                    const wordAudioFilename =
                        `word_${Date.now()}_${wordAudio.filename || 'audio.mp3'}`;
                    audioList.push({
                        filename:   wordAudioFilename,
                        dataBase64: wordAudio.base64,
                        field:      cfg.fields.termAudio
                    });
                }
                const params = {
                    deckName:  cfg.deck,
                    modelName: cfg.model,
                    fields,
                    tags: ['mining', 'dictionary', dictionary || 'unknown'].filter(Boolean)
                };
                if (audioList.length) params.audio = audioList;
                if (imageData) {
                    params.picture = [{
                        filename:   imageFilename,
                        dataBase64: imageData.split(',')[1],
                        field:      cfg.fields.image
                    }];
                }
                const r = await ab.addNote(params);
                console.log('✅ AnkiBridge.addNote ->', r);
                if (typeof window.showToast === 'function') {
                    window.showToast(`✓ Added to ${cfg.deck}`, 2200);
                }
                return r;
            } catch (err) {
                console.error('❌ AnkiBridge.addNote error:', err);
                if (typeof window.showToast === 'function') {
                    window.showToast(`✗ Anki: ${err?.message || err}`, 4000);
                }
                throw new Error(err?.message || String(err));
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

        // Add click-anywhere-to-close handler
        document.addEventListener('click', (e) => {
            const popup = document.getElementById('dictPopup');
            if (popup && !popup.contains(e.target) && !e.target.classList.contains('dict-frag')) {
                hidePopup();
            }
        });

        // Helper: bind lookupContext to the CURRENTLY DISPLAYED card before
        // each tap. Without this, the dict's Send falls back to the global
        // _currentReadingCueStartMs which tracks the playing cue, not the
        // visible card — produced the user's "audio is from the previous
        // card" report.
        function bindCardLookupContext() {
            try {
                const idx = window.currentCardIndex;
                const card = Array.isArray(window.allNotes) ? window.allNotes[idx] : null;
                if (!card) { window.lookupContext = null; return; }
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
            // Visual debugging
            span.style.backgroundColor = 'rgba(255,0,0,0.1)';

            // Touch handler for mobile
            span.addEventListener('touchstart', (e) => {
                console.log(`👆 TOUCHSTART on span ${index}: "${span.textContent}"`);
                e.preventDefault();
                bindCardLookupContext();

                if (touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }

                const text = spans.map(s => s.textContent).join('');
                const charIndex = spans.slice(0, index)
                    .reduce((sum, s) => sum + s.textContent.length, 0);
                const best = greedyDeinflect(text, charIndex);

                highlightSpans(spans, index, best.length);
            });

            span.addEventListener('touchend', (e) => {
                console.log(`👆 TOUCHEND on span ${index} - triggering lookup immediately`);
                e.preventDefault();
                e.stopPropagation();
                bindCardLookupContext();

                console.log(`👆 Touch lookup span ${index}: "${span.textContent}"`);
                performLookup(spans, index);
            });

            span.addEventListener('touchcancel', () => {
                console.log(`👆 TOUCHCANCEL on span ${index}`);
                if (touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
                clearHighlight();
            });
            
            // Hover for visual feedback (desktop)
            span.addEventListener('mouseenter', () => {
                const popup = document.getElementById('dictPopup');
                if (!popup || popup.style.display === 'none') {
                    span.style.backgroundColor = 'rgba(0,255,0,0.3)';
                }
            });
            
            span.addEventListener('mouseleave', () => {
                span.style.backgroundColor = 'rgba(255,0,0,0.1)';
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
                await Promise.all([loadDeinflectRules(), ensureJM()]);
                console.log('✅ Global dictionary loading complete!');
                return true;
            } catch (error) {
                console.error('❌ Global dictionary loading failed:', error);
                hideStartupProgress();
                return false;
            }
        })();
        
        return dictionaryLoadingPromise;
    }

    // ==================== MAIN INITIALIZATION ====================
    
    window.performDictLookup = async function (spans, index) {
        // Ensure dictionaries start loading on first external use.
        startGlobalDictionaryLoading();
        return performLookup(spans, index);
    };

    window.wrapSubtitleTokens = async function() {
        console.log('🚀 Initializing dictionary system for new card...');
        
        try {
            // Start global dictionary loading only once
            const loadingPromise = startGlobalDictionaryLoading();
            
            console.log('🔧 Wrapping text for current card...');
            wrapTextInSpans();
            console.log('✅ Text wrapping complete!');
            
            console.log('🎯 Setting up lookup handlers...');
            setupLookupHandlers();
            console.log('✅ Lookup handlers ready!');
            
            // Don't wait for dictionaries - let them load in background
            console.log('📚 Dictionaries loading in background...');
            
            // Optional: Wait for dictionaries to complete (but don't block UI)
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
        
        /* Dictionary highlight is mode-tinted. Each mode's accent gets
           color-mixed with transparent so the highlight reads as a
           soft tint of the mode color rather than a fixed cyan. */
        .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-cyan, #00ffcc) 32%, transparent) !important;
            border-radius: 3px;
        }
        body.mode-card  .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-card, #ff9550) 32%, transparent) !important;
        }
        body.mode-read  .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-read, #4caf50) 32%, transparent) !important;
        }
        body.mode-audio .dict-frag.highlight {
            background: color-mix(in srgb, var(--accent-audio, #b794f6) 32%, transparent) !important;
        }
        
        .subtitle-text {
            user-select: none !important;
            -webkit-user-select: none !important;
            white-space: pre-wrap !important;
            line-height: 1.4 !important;
            font-size: 2.4rem !important; /* Decreased from 2.8rem */
            width: 80% !important;
            background-color: transparent !important;
            left: 10% !important;
            right: 10% !important;
            position: absolute !important;
            top: calc(env(safe-area-inset-top, 0px) + var(--subtitle-offset, 0px)) !important;
            padding: 12px 20px !important;
            box-sizing: border-box !important;
            text-align: center !important;
            color: #fff !important;
        }
        
        /* Fix maroonish-red background on dict-frag spans */
        .dict-frag {
            background-color: rgba(0, 0, 0, 0.1) !important; /* Changed from rgba(255,0,0,0.1) to dark */
        }
        
        @media (hover: hover) {
            .dict-frag:hover {
                background-color: rgba(0, 255, 0, 0.3) !important;
            }
        }
        
        #dictPopup {
            -webkit-overflow-scrolling: touch !important;
            overscroll-behavior: contain;
            overflow-y: auto !important;
            overflow-x: hidden;
        }
        /* Manatan-style dictionary card. Compact, dark, type-forward.
           Reading sits above the term, source pill in mode color, sense
           cards with a numbered head row. */
        #dictPopup {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
        }
        .manatan-header {
            display: flex; justify-content: space-between; align-items: flex-start;
            gap: 12px; margin-bottom: 12px;
        }
        .manatan-title-block { flex: 1; min-width: 0; }
        .manatan-reading {
            color: #b0b0b0; font-size: 0.75em; letter-spacing: 0.04em;
            margin-bottom: 2px; font-weight: 400;
        }
        .manatan-term {
            font-size: 2em; font-weight: 700; color: #fff;
            line-height: 1.1; letter-spacing: -0.01em;
        }
        .manatan-header-icons {
            display: flex; flex-direction: row; align-items: center; gap: 8px;
            flex-shrink: 0;
        }
        .manatan-icon-btn {
            background: transparent; color: #d0d0d0;
            border: 1px solid transparent;
            padding: 4px 6px; cursor: pointer;
            border-radius: 6px;
            display: inline-flex; align-items: center; justify-content: center;
        }
        .manatan-icon-btn:active { background: rgba(255,255,255,0.06); }
        .manatan-icon-btn svg { display: block; }
        .manatan-anki-btn {
            background: var(--accent-read, #4caf50); color: #000;
            border: none; padding: 6px 12px; border-radius: 999px;
            font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em;
            cursor: pointer; text-transform: uppercase;
        }
        .manatan-anki-btn:disabled { opacity: 0.4; cursor: default; }
        .manatan-nav {
            display: flex; align-items: center; justify-content: center;
            gap: 12px; padding: 6px 0 12px 0;
            border-bottom: 1px solid #1f1f1f; margin-bottom: 12px;
        }
        .manatan-nav-btn {
            background: transparent; color: #aaa;
            border: 1px solid #333; padding: 4px 10px; border-radius: 999px;
            font-size: 0.75em; letter-spacing: 0.05em; cursor: pointer;
        }
        .manatan-nav-btn:disabled { color: #444; border-color: #1f1f1f; cursor: default; }
        .manatan-nav-count {
            color: #888; font-size: 0.8em; font-variant-numeric: tabular-nums;
            letter-spacing: 0.05em;
        }
        .manatan-sense {
            margin-bottom: 16px;
        }
        .manatan-sense-head {
            display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
            margin-bottom: 6px;
        }
        .manatan-sense-num {
            font-size: 1.05em; font-weight: 700; color: #fff;
            margin-right: 4px;
        }
        .manatan-pill {
            display: inline-block; padding: 2px 8px; border-radius: 4px;
            font-size: 0.7em; font-weight: 600; letter-spacing: 0.03em;
            line-height: 1.5;
        }
        .manatan-pill-pos {
            background: #2a2a2a; color: #d0d0d0;
        }
        .manatan-pill-dict {
            background: #6b4ea3; color: #fff;
        }
        .manatan-glosses {
            margin: 0; padding-left: 22px; list-style: disc;
            color: #ddd; line-height: 1.45;
        }
        .manatan-glosses li {
            font-size: 0.95em; margin-bottom: 2px;
        }
        .manatan-empty {
            font-size: 1em; color: #ccc; text-align: center; padding: 8px 0;
        }
        .manatan-hint {
            color: #555; font-size: 0.72em; text-align: center;
            margin-top: 14px; padding-top: 8px; border-top: 1px solid #1f1f1f;
            letter-spacing: 0.04em;
        }
    `;
    document.head.appendChild(style);
    console.log('✅ CSS styles added');

    console.log('✅ Integrated Yomitan Dictionary System loaded successfully!');

})();