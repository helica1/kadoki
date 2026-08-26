// ai-places-ui.js — real-world place-name underlines + tap popup map (places
// companion to ai-characters-ui.js). Mirrors that file's marking engine
// exactly (same CONTAINERS, same span/lazy dual-path text marking) but with
// its own class (.kplace-name) and its own tap popup: a real interactive
// OpenStreetMap (vendored Leaflet, my-app/www/vendor/leaflet/ — no CDN
// dependency), geocoded on tap and cached — no location-services permission
// (the DEVICE's position is never read; only the PLACE's coordinates, via
// public geocoding), plus an Open-in-Maps escape hatch and a live Wikipedia
// lookup (never an AI-guessed URL).
//
// Runs as an INDEPENDENT sibling to ai-characters-ui.js (own poll, own
// touchend listener) rather than folding into it, so a place-marking bug
// can't touch the character path. The one coordination point: this file's
// tap handler yields to an existing .kchar-name hit (character names win
// if a span is ever claimed by both, which in practice shouldn't happen).
(function () {
  'use strict';

  const POLL_MS = 1500;
  const CONTAINERS = '.subtitle-text, #comboSubtitle, #audiobookCueText, .kai-summary-text';

  // ---- style ---------------------------------------------------------------
  // Same GPU-composited background-image technique as .kchar-name (a real
  // `text-decoration: underline` re-rasterizes on every scroll frame on iOS
  // WebKit and was the confirmed cause of AI-summary scroll jank) — but a
  // STRAIGHT line, not a wavy squiggle, and a different (teal) hue so the two
  // mark kinds stay visually distinct where they sit near each other.
  const LINE = (op) =>
    "url(\"data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 " +
    "width=%228%22 height=%224%22><line x1=%220%22 y1=%223%22 x2=%228%22 y2=%223%22 " +
    "stroke=%22rgba(90,205,175," + op + ")%22 stroke-width=%221.4%22/></svg>\")";
  const style = document.createElement('style');
  style.textContent =
    '.kplace-name{background-image:' + LINE('0.8') + ';background-repeat:repeat-x;' +
    'background-position:0 100%;background-size:8px 4px;padding-bottom:2px;}' +
    '#kplacePopup .kp-spin{display:inline-block;width:22px;height:22px;border:2px solid #34344a;' +
    'border-radius:50%;border-top-color:#5accaf;animation:spin 1s ease-in-out infinite;}' +
    // Dark-theme tweaks for Leaflet's default (light) chrome so the map's zoom
    // buttons/attribution don't read as a jarring white box in the popup.
    '#kplacePopup .leaflet-control-zoom a{background:#1d1830;color:#cdbcf5;border-color:#3a3450 !important;}' +
    '#kplacePopup .leaflet-control-zoom a:hover{background:#241c3a;}' +
    '#kplacePopup .leaflet-control-attribution{background:rgba(21,21,28,.75);color:#999;font-size:.62rem;}' +
    '#kplacePopup .leaflet-control-attribution a{color:#8a93c4;}';
  document.head.appendChild(style);

  // ---- marking (verbatim port of ai-characters-ui.js's engine, .kplace-* keys) ---
  function collectFrags(container) {
    const entries = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1) {
          if (ch.tagName === 'BR') { entries.push({ span: null, ch: '\n' }); continue; }
          if (ch.classList && ch.classList.contains('dict-frag')) {
            const t = ch.textContent || '';
            for (const c of t) entries.push({ span: ch, ch: c });
            continue;
          }
          walk(ch);
        }
      }
    };
    walk(container);
    return entries;
  }
  function hash32(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  function collectLazySegments(container) {
    const segments = [];
    let flat = '';
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          const v = ch.nodeValue || '';
          if (v) { segments.push({ node: ch, start: flat.length, len: v.length }); flat += v; }
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName;
          if (tag === 'RT' || tag === 'RP') continue;
          if (tag === 'BR') { flat += '\n'; continue; }
          walk(ch);
        }
      }
    };
    walk(container);
    return { flat, segments };
  }
  function unwrapLazyNames(container) {
    container.querySelectorAll('.kplace-name').forEach((sp) => {
      try {
        const parent = sp.parentNode;
        if (!parent) return;
        while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
        parent.removeChild(sp);
      } catch (_) {}
    });
    try { container.normalize(); } catch (_) {}
  }
  function wrapLazyNameRun(segments, run) {
    try {
      const start = run.at, end = run.at + run.len;
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si];
        const from = Math.max(start, seg.start);
        const to = Math.min(end, seg.start + seg.len);
        if (from >= to) continue;
        let node = seg.node;
        if (!node || !node.isConnected || node.nodeType !== 3) continue;
        const localStart = from - seg.start;
        const localEnd = to - seg.start;
        let target = node;
        if (localStart > 0) target = target.splitText(localStart);
        if (localEnd - localStart < target.nodeValue.length) target.splitText(localEnd - localStart);
        const parent = target.parentNode;
        if (!parent) continue;
        const wrap = document.createElement('span');
        wrap.className = 'kplace-name';
        wrap.dataset.kplaceAlias = run.alias;
        parent.insertBefore(wrap, target);
        wrap.appendChild(target);
      }
    } catch (_) {}
  }
  function markContainerLazy(container, m) {
    const recCheap = () => {
      try {
        container.dataset.kplaceLazyBucket = m.bucket;
        container.dataset.kplaceLazyLen = String((container.textContent || '').length);
        container.dataset.kplaceLazyWrap = String(container.querySelectorAll('.kplace-name').length);
      } catch (_) {}
    };
    if (container.dataset.kplaceSig &&
        container.dataset.kplaceLazyBucket === m.bucket &&
        container.dataset.kplaceLazyLen === String((container.textContent || '').length) &&
        container.dataset.kplaceLazyWrap === String(container.querySelectorAll('.kplace-name').length)) {
      container.dataset.kplaceSigB = m.bucket;
      return;
    }
    const { flat } = collectLazySegments(container);
    if (!flat) return;
    const sig = m.bucket + '|' + flat.length + '|' + container.querySelectorAll('.kplace-name').length + '|' + hash32(flat);
    if (container.dataset.kplaceSig === sig) { container.dataset.kplaceSigB = m.bucket; recCheap(); return; }

    unwrapLazyNames(container);
    const fresh = collectLazySegments(container);
    container.dataset.kplaceSig = sig;
    container.dataset.kplaceSigB = m.bucket;
    if (!m.map.size) { recCheap(); return; }

    const text = fresh.flat;
    const taken = new Array(text.length).fill(false);
    const aliases = Array.from(m.map.keys()).sort((a, b) => b.length - a.length);
    const runs = [];
    for (const alias of aliases) {
      const rec = m.map.get(alias);
      let from = 0, at;
      while ((at = text.indexOf(alias, from)) >= 0) {
        from = at + 1;
        let free = true;
        for (let i = at; i < at + alias.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (let i = at; i < at + alias.length; i++) taken[i] = true;
        runs.push({ at, len: alias.length, alias, rec });
      }
    }
    if (!runs.length) { recCheap(); return; }
    runs.sort((a, b) => b.at - a.at);
    for (const run of runs) wrapLazyNameRun(fresh.segments, run);
    recCheap();
  }
  function markContainer(container, m) {
    if (container.dataset.dictLazy === '1') {
      try { markContainerLazy(container, m); } catch (_) {}
      return;
    }
    if (container.dataset.kplaceSigB === m.bucket && container.dataset.kplaceSig) return;
    const entries = collectFrags(container);
    if (!entries.length) return;
    const text = entries.map(e => e.ch).join('');
    const sig = m.bucket + '|' + text.length + '|' + hash32(text);
    if (container.dataset.kplaceSig === sig) { container.dataset.kplaceSigB = m.bucket; return; }
    container.dataset.kplaceSig = sig;
    container.dataset.kplaceSigB = m.bucket;

    container.querySelectorAll('.kplace-name').forEach((el) => {
      el.classList.remove('kplace-name');
      delete el.dataset.kplaceAlias;
    });

    if (!m.map.size) return;
    const taken = new Array(text.length).fill(false);
    const aliases = Array.from(m.map.keys()).sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      let from = 0, at;
      while ((at = text.indexOf(alias, from)) >= 0) {
        from = at + 1;
        let free = true;
        for (let i = at; i < at + alias.length; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (let i = at; i < at + alias.length; i++) {
          taken[i] = true;
          const sp = entries[i].span;
          if (sp) { sp.classList.add('kplace-name'); sp.dataset.kplaceAlias = alias; }
        }
      }
    }
  }

  let lastReadBucket = null;
  let _lastScrollTs = 0;
  try { document.addEventListener('scroll', () => { _lastScrollTs = Date.now(); }, { capture: true, passive: true }); } catch (_) {}
  function pass() {
    try {
      if (window._kaiAiPaused) return;
      if (document.hidden) return;
      if (Date.now() - _lastScrollTs < 350) return;
      if (!window.aiPlaces) return;
      const m = window.aiPlaces.matcher();
      if (!m) return;
      document.querySelectorAll(CONTAINERS).forEach((c) => {
        markContainer(c, m);
        if (!c.dataset.kplaceObs && c.dataset.dictLazy !== '1') {
          c.dataset.kplaceObs = '1';
          let t = null;
          try {
            new MutationObserver(() => {
              if (t) clearTimeout(t);
              t = setTimeout(() => {
                try {
                  if (window._kaiAiPaused) return;
                  if (c.dataset.dictLazy === '1') return;
                  delete c.dataset.kplaceSig;
                  delete c.dataset.kplaceSigB;
                  const mm = window.aiPlaces && window.aiPlaces.matcher();
                  if (mm) markContainer(c, mm);
                } catch (_) {}
              }, 60);
            }).observe(c, { childList: true, subtree: true });
          } catch (_) {}
        }
      });
      if (window.aiPlacesRead && m.bucket !== lastReadBucket) {
        lastReadBucket = m.bucket;
        window.aiPlacesRead.refresh();
      }
    } catch (_) {}
  }
  setInterval(pass, POLL_MS);
  window.addEventListener('shell:mode-change', () => setTimeout(pass, 250));

  function remarkSoon() {
    if (window._kaiAiPaused) return;
    pass();
    if (window.aiPlaces && window.aiPlaces.matcher()) return;
    let n = 0;
    const t = setInterval(() => {
      if (window._kaiAiPaused || document.hidden) return;
      pass();
      if (++n >= 4 || (window.aiPlaces && window.aiPlaces.matcher())) clearInterval(t);
    }, 300);
  }
  function markNow(el) {
    if (window._kaiAiPaused) return;
    try {
      const m = window.aiPlaces && window.aiPlaces.matcher();
      if (m && el) { markContainer(el, m); return; }
    } catch (_) {}
    remarkSoon();
  }
  window.addEventListener('kai:ai-place-data', () => { if (!document.hidden && !window._kaiAiPaused) remarkSoon(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) remarkSoon(); });

  // ---- tap → map popup -------------------------------------------------------
  // Own capture-phase listener (independent of ai-characters-ui.js's). Yields
  // to a `.kchar-name` hit so character names always win a tap.
  let tsX = 0, tsY = 0, moved = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tsX = t ? t.clientX : 0; tsY = t ? t.clientY : 0; moved = false;
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', (e) => {
    if (moved) return;
    const t = e.touches[0];
    if (t && (Math.abs(t.clientX - tsX) > 8 || Math.abs(t.clientY - tsY) > 8)) moved = true;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', (e) => {
    try {
      if (moved) return;
      if (e.target && e.target.closest && e.target.closest('.kchar-name')) return;   // character name wins
      if (e.target && e.target.closest && e.target.closest('#waveformEditorOverlay')) return;
      if (e.target && e.target.closest && e.target.closest('#lookupNavBar, #lookupNavShield')) return;
      const dp = document.getElementById('dictPopup');
      if (dp && dp.style.display !== 'none' && !dp.contains(e.target)) return;   // ai-characters-ui.js's listener already handles the dismiss
      const m = window.aiPlaces && window.aiPlaces.matcher();
      if (!m) return;
      let rec = null;
      const hit = e.target && e.target.closest && e.target.closest('.kplace-name');
      if (hit) {
        rec = m.map.get(hit.dataset.kplaceAlias);
      } else if (window.aiPlacesRead && document.body.classList.contains('mode-read') &&
                 !(e.target && e.target.closest && e.target.closest('#kcharPopup, #kplacePopup, #dictPopup, #kcharsScreen, #bookmarksOverlay, .kai-modal'))) {
        const t = e.changedTouches && e.changedTouches[0];
        if (t) rec = window.aiPlacesRead.hitTest(t.clientX, t.clientY);
      }
      if (!rec) return;
      e.preventDefault();
      e.stopPropagation();
      window._dictPopupDismissedTs = Date.now();
      openPlacePopup(rec);
    } catch (_) {}
  }, { capture: true });

  // ---- geocoding (Nominatim; no map library, no location permission) --------
  // Only the PLACE's coordinates are looked up — the device's own position is
  // never read. Results cached app-wide (not per-book) in blobStore, keyed by
  // the exact surface string, since a real place is the same place across books.
  // V2: bumped when Japan-biased search was added (see fetchGeocode) — V1
  // entries may hold wrong-country matches from the old unrestricted query
  // (南箱根 resolved to Taiwan) and must not be trusted/reused.
  // V3: entries now carry Nominatim's boundingbox (+ addresstype) so the map
  // can open at the place's own scale; V2 entries lack it and are re-fetched.
  const GEO_KEY = 'PLACE_GEOCODE_V3';
  async function loadGeoCache() {
    try {
      const raw = window.blobStore ? await window.blobStore.get(GEO_KEY) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && p.v === 1 && p.entries) ? p : { v: 1, entries: {} };
    } catch (_) { return { v: 1, entries: {} }; }
  }
  async function saveGeoCache(box) {
    try {
      const keys = Object.keys(box.entries);
      if (keys.length > 500) {
        keys.sort((a, b) => (box.entries[a].ts || 0) - (box.entries[b].ts || 0));
        for (const k of keys.slice(0, keys.length - 500)) delete box.entries[k];
      }
      if (window.blobStore) await window.blobStore.set(GEO_KEY, JSON.stringify(box));
    } catch (_) {}
  }
  function capHttp() {
    try { return window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp || null; } catch (_) { return null; }
  }
  async function fetchGeocode(name, countrycodes) {
    const url = 'https://nominatim.openstreetmap.org/search';
    const params = { format: 'jsonv2', q: name, limit: '1', 'accept-language': 'ja' };
    if (countrycodes) params.countrycodes = countrycodes;
    const H = capHttp();
    if (H) {
      // Native HTTP so a real identifying User-Agent can be set (Nominatim's usage
      // policy requires one; a plain browser fetch() can't override its UA).
      const res = await H.request({
        url, method: 'GET', params,
        headers: { 'User-Agent': 'Kadoki-ReaderApp/1.0 (offline Japanese reading app; in-app place lookup)' },
        connectTimeout: 8000, readTimeout: 8000,
      });
      if (res.status < 200 || res.status >= 300) throw new Error('geocode ' + res.status);
      return res.data;
    }
    const q = new URLSearchParams(params);
    const r = await fetch(url + '?' + q.toString());
    if (!r.ok) throw new Error('geocode ' + r.status);
    return await r.json();
  }
  // Serial queue + ≥1.1s spacing: Nominatim's usage policy caps at ~1 req/s.
  // Taps are rare and results cache forever, so this never becomes a bottleneck.
  let _geoChain = Promise.resolve();
  let _lastReqTs = 0;
  async function throttle() {
    const wait = Math.max(0, 1100 - (Date.now() - _lastReqTs));
    if (wait) await new Promise((res) => setTimeout(res, wait));
    _lastReqTs = Date.now();
  }
  function serial(fn) {
    const p = _geoChain.then(fn, fn);
    _geoChain = p.then(() => {}, () => {});
    return p;
  }
  function parseGeocodeHit(data) {
    const first = Array.isArray(data) && data[0];
    const lat = first && parseFloat(first.lat);
    const lng = first && parseFloat(first.lon);
    if (!(Number.isFinite(lat) && Number.isFinite(lng))) return null;
    const out = { lat, lng, display: first.display_name || '', ts: Date.now() };
    // boundingbox = [south, north, west, east] as strings. Its extent is what
    // sizes the opening map (zoomFor): a station is a point, a prefecture is
    // a region, and Nominatim knows which.
    try {
      const bb = Array.isArray(first.boundingbox) ? first.boundingbox.map(parseFloat) : null;
      if (bb && bb.length === 4 && bb.every(Number.isFinite)) out.bbox = bb;
      if (first.addresstype || first.type) out.atype = String(first.addresstype || first.type);
    } catch (_) {}
    return out;
  }
  // Returns {lat,lng,display} or null (not found / lookup failed). A definitive
  // "Nominatim has nothing (in Japan or anywhere)" is cached; a network failure
  // is NOT (so a later tap with connectivity can still resolve it).
  //
  // Japan-biased first: this app's content is Japanese-language books, and an
  // unrestricted free-text query on a short/ambiguous place name can match an
  // unrelated place elsewhere in the world with a similar-looking name (南箱根
  // resolved to somewhere in Taiwan). Try countrycodes=jp first; only if THAT
  // finds nothing, retry unrestricted so a real place legitimately outside
  // Japan (a book set abroad) can still resolve — false negative (no pin) is
  // preferred over a wrong-country false positive, same bias used for the
  // Wikipedia lookup.
  async function geocode(name) {
    const key = String(name || '').trim();
    if (!key) return null;
    const box = await loadGeoCache();
    const hit = box.entries[key];
    if (hit) return hit.notFound ? null : hit;
    return serial(async () => {
      const box2 = await loadGeoCache();
      const hit2 = box2.entries[key];
      if (hit2) return hit2.notFound ? null : hit2;
      let found = null;
      try {
        await throttle();
        found = parseGeocodeHit(await fetchGeocode(key, 'jp'));
        if (!found) {
          await throttle();
          found = parseGeocodeHit(await fetchGeocode(key));
        }
      } catch (_) { return null; }   // transient failure — not cached
      const entry = found || { notFound: true, ts: Date.now() };
      box2.entries[key] = entry;
      await saveGeoCache(box2);
      return entry.notFound ? null : entry;
    });
  }

  // ---- interactive map (Leaflet) + pin ----------------------------------------
  // Opening scale follows the PLACE, never street level (the user found the
  // original street-zoom disorienting with no geographic context): a station
  // or a neighbourhood inside Tokyo opens at city scale with the city around
  // it, Osaka opens showing Osaka, a prefecture opens as a region, and a
  // country opens at country scale. Derived from Nominatim's bounding box —
  // zoom ≈ log2(360° / extent) − 1, clamped to [ZOOM_MIN, ZOOM_MAX]; a point
  // feature (tiny box) lands on ZOOM_MAX = city scale. Entries without a box
  // (or a failed parse) fall back to the old country-scale default.
  const ZOOM = 6;
  const ZOOM_MIN = 5, ZOOM_MAX = 10;
  function zoomFor(geo) {
    try {
      const bb = geo && geo.bbox;
      if (!bb) return ZOOM;
      const latSpan = Math.abs(bb[1] - bb[0]);
      const lonSpan = Math.abs(bb[3] - bb[2]) * Math.cos((geo.lat || 0) * Math.PI / 180);
      const span = Math.max(latSpan, lonSpan, 1e-4);
      const z = Math.floor(Math.log2(360 / span)) - 1;
      return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    } catch (_) { return ZOOM; }
  }
  const PIN_SVG =
    '<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M13 0C5.8 0 0 5.8 0 13c0 9.7 13 21 13 21s13-11.3 13-21C26 5.8 20.2 0 13 0z" fill="#e05f5f" stroke="#fff" stroke-width="1.5"/>' +
    '<circle cx="13" cy="13" r="5" fill="#fff"/></svg>';
  // Real interactive map (pinch/pan/double-tap zoom) via vendored Leaflet
  // (my-app/www/vendor/leaflet/ — no CDN dependency). Leaflet manages its own
  // touch-action on the map container, so it's unaffected by the popup
  // overlay's shieldOverlay (which only stops the event from bubbling PAST
  // the overlay to the app behind, not from reaching Leaflet's own listeners
  // on the map div — those are closer to the touch target and fire first).
  function buildLeafletMap(container, lat, lng, zoom) {
    const map = L.map(container, { attributionControl: true, zoomControl: true }).setView([lat, lng], Number.isFinite(zoom) ? zoom : ZOOM);
    try { map.attributionControl.setPrefix(false); } catch (_) {}
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    const icon = L.divIcon({
      html: '<div style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));">' + PIN_SVG + '</div>',
      className: '', iconSize: [26, 34], iconAnchor: [13, 34],
    });
    L.marker([lat, lng], { icon, keyboard: false }).addTo(map);
    return map;
  }

  // ---- Wikipedia lookup (ja.wikipedia.org; live query, never an AI-guessed
  // URL/title — cached forever like geocoding) ---------------------------------
  // EXACT title + redirect resolution (action=query&titles=…&redirects=1), NOT
  // full-text search: fuzzy srsearch was confirmed to drift to a wrong, only
  // vaguely-related article when no real page matched the name (南箱根 → some
  // unrelated たんあぼんち entry) — a wrong link is worse than no link. Exact
  // title lookup either finds the real page (incl. via a curated redirect like
  // an alternate/former place name) or correctly reports nothing, matching the
  // same false-negative-over-false-positive bias used elsewhere in this feature.
  // V2: bumped when the lookup method changed from fuzzy free-text search to
  // exact-title+redirect (see above) — V1 entries may hold wrong matches
  // computed by the old method and must not be trusted/reused.
  const WIKI_KEY = 'PLACE_WIKI_V2';
  async function loadWikiCache() {
    try {
      const raw = window.blobStore ? await window.blobStore.get(WIKI_KEY) : null;
      const p = raw ? JSON.parse(raw) : null;
      return (p && p.v === 1 && p.entries) ? p : { v: 1, entries: {} };
    } catch (_) { return { v: 1, entries: {} }; }
  }
  async function saveWikiCache(box) {
    try {
      const keys = Object.keys(box.entries);
      if (keys.length > 500) {
        keys.sort((a, b) => (box.entries[a].ts || 0) - (box.entries[b].ts || 0));
        for (const k of keys.slice(0, keys.length - 500)) delete box.entries[k];
      }
      if (window.blobStore) await window.blobStore.set(WIKI_KEY, JSON.stringify(box));
    } catch (_) {}
  }
  async function fetchWikiSearch(name) {
    const url = 'https://ja.wikipedia.org/w/api.php';
    const params = { action: 'query', titles: name, redirects: '1', format: 'json', origin: '*' };
    const H = capHttp();
    if (H) {
      const res = await H.request({
        url, method: 'GET', params,
        headers: { 'User-Agent': 'Kadoki-ReaderApp/1.0 (offline Japanese reading app; in-app place lookup)' },
        connectTimeout: 8000, readTimeout: 8000,
      });
      if (res.status < 200 || res.status >= 300) throw new Error('wiki ' + res.status);
      return res.data;
    }
    const q = new URLSearchParams(params);
    const r = await fetch(url + '?' + q.toString());
    if (!r.ok) throw new Error('wiki ' + r.status);
    return await r.json();
  }
  async function wikiLookup(name) {
    const key = String(name || '').trim();
    if (!key) return null;
    const box = await loadWikiCache();
    const hit = box.entries[key];
    if (hit) return hit.notFound ? null : hit;
    let data;
    try { data = await fetchWikiSearch(key); } catch (_) { return null; }   // transient failure — not cached
    const pages = data && data.query && data.query.pages;
    const page = pages && Object.values(pages)[0];
    // A missing page has `missing` set and no real pageid (MediaWiki uses
    // negative placeholder ids like "-1" for these) — must check BOTH, since a
    // real page's pageid can coincidentally be falsy-looking as a string key.
    const entry = (page && page.title && !('missing' in page) && Number(page.pageid) > 0)
      ? { title: page.title, ts: Date.now() } : { notFound: true, ts: Date.now() };
    box.entries[key] = entry;
    await saveWikiCache(box);
    return entry.notFound ? null : entry;
  }
  function wikiUrl(title) {
    return 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  }

  // ---- popup ------------------------------------------------------------------
  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function platform() {
    try { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web'; } catch (_) { return 'web'; }
  }
  function mapsAppUrl(lat, lng, name) {
    const p = platform();
    if (p === 'ios') return 'https://maps.apple.com/?ll=' + lat + ',' + lng + '&q=' + encodeURIComponent(name);
    if (p === 'android') return 'geo:' + lat + ',' + lng + '?q=' + encodeURIComponent(lat + ',' + lng + '(' + name + ')');
    return 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=15/' + lat + '/' + lng;
  }
  function openPlacePopup(rec) {
    const prev = document.getElementById('kplacePopup');
    if (prev) prev.remove();
    const overlay = document.createElement('div');
    overlay.id = 'kplacePopup';
    // Same z-index band as the character popup (9400) — the two never open
    // together (a tap resolves to at most one of .kchar-name/.kplace-name).
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9400;' +
      'display:flex;align-items:center;justify-content:center;';
    // Custom shield (NOT the shared shieldOverlay helper): the vendored Leaflet
    // build attaches its drag/pinch CONTINUATION listeners to `document` (grep-
    // confirmed — touchmove/touchend on document, not just the map container),
    // relying on them for a gesture that starts on the map to keep tracking.
    // shieldOverlay's blanket bubble-phase stopPropagation on the overlay sits
    // between the map and document, so it silently swallowed those events and
    // pinch/pan looked frozen after the initial touch. Same shielding for
    // everything else in the popup, but touches on the Leaflet map are let
    // through to bubble all the way up.
    overlay.classList.add('kai-modal');
    overlay.style.touchAction = 'none';
    overlay.style.overscrollBehavior = 'contain';
    const shieldStop = (e) => {
      if (e.target && e.target.closest && e.target.closest('.leaflet-container')) return;
      e.stopPropagation();
    };
    ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointermove']
      .forEach((t) => overlay.addEventListener(t, shieldStop));

    const card = document.createElement('div');
    card.style.cssText =
      'background:#15151c;border:1px solid #34344a;border-radius:14px;' +
      'width:min(90vw,380px);max-height:78vh;overflow-y:auto;padding:16px 18px;';
    const name = esc(rec.surface);
    const reading = (rec.reading && rec.reading !== rec.surface) ? esc(rec.reading) : '';
    card.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">' +
        '<div>' +
          '<div style="font-size:1.3rem;color:#eee;font-family:var(--font-family-card);">' + name + '</div>' +
          (reading ? '<div style="color:#7a8;font-size:.72rem;margin-top:2px;">' + reading + '</div>' : '') +
        '</div>' +
        '<button id="kplaceClose" aria-label="Close" style="background:none;border:none;' +
        'color:#ccc;padding:4px 8px;font-size:1.6rem;line-height:1;cursor:pointer;flex:0 0 auto;">✕</button>' +
      '</div>';
    const body = document.createElement('div');
    body.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;align-items:center;gap:8px;';
    const mapArea = document.createElement('div');
    mapArea.style.cssText = 'width:100%;';
    mapArea.innerHTML = '<div style="height:280px;display:flex;align-items:center;justify-content:center;">' +
      '<span class="kp-spin"></span></div>' +
      '<div style="color:#888;font-size:.72rem;text-align:center;margin-top:6px;">' + window.i18n.t('pl.locating', '場所を検索中…') + '</div>';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:8px;';
    body.appendChild(mapArea);
    body.appendChild(btnRow);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const closeBtn = card.querySelector('#kplaceClose');
    let leafletMap = null;
    const closeWithCleanup = () => { try { if (leafletMap) leafletMap.remove(); } catch (_) {} overlay.remove(); };
    closeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeWithCleanup(); });
    closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); closeWithCleanup(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWithCleanup(); });
    overlay.addEventListener('touchend', (e) => {
      if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); closeWithCleanup(); }
    });

    const mkActionBtn = (label) => {
      const b = document.createElement('button');
      b.style.cssText =
        'width:100%;background:#1d1830;border:1px solid #3a3450;border-radius:8px;' +
        'color:#a9d9c9;font-size:.78rem;padding:8px 12px;cursor:pointer;';
      b.textContent = label;
      return b;
    };

    geocode(rec.surface).then((geo) => {
      if (!overlay.isConnected) return;   // popup closed while geocoding
      if (!geo) {
        mapArea.innerHTML = '<div style="padding:24px 10px;color:#e08a8a;font-size:.8rem;text-align:center;">' +
          esc(window.i18n.t('pl.not_found', '場所が見つかりませんでした')) + '</div>';
        return;
      }
      mapArea.innerHTML = '';
      const mapDiv = document.createElement('div');
      mapDiv.style.cssText = 'width:100%;height:280px;border-radius:10px;overflow:hidden;';
      mapArea.appendChild(mapDiv);
      try { leafletMap = buildLeafletMap(mapDiv, geo.lat, geo.lng, zoomFor(geo)); } catch (_) {}
      const openBtn = mkActionBtn('⤴ ' + window.i18n.t('pl.open_in_maps', '地図アプリで開く'));
      openBtn.addEventListener('click', () => {
        try { window.open(mapsAppUrl(geo.lat, geo.lng, rec.surface), '_system'); } catch (_) {}
      });
      btnRow.appendChild(openBtn);
      // Google Maps, alongside the platform's own maps app. The universal
      // /maps/search/ URL hands off to the installed Google Maps app on both
      // iOS and Android and falls back to the web otherwise. Queried by
      // COORDINATES, not by name — the pin the user is looking at is the one
      // they get, with none of the free-text-search ambiguity that sent 南箱根
      // to Taiwan.
      const gBtn = mkActionBtn('⤴ ' + window.i18n.t('pl.open_google_maps', 'Googleマップで開く'));
      gBtn.addEventListener('click', () => {
        try {
          window.open('https://www.google.com/maps/search/?api=1&query=' +
            encodeURIComponent(geo.lat + ',' + geo.lng), '_system');
        } catch (_) {}
      });
      btnRow.appendChild(gBtn);
    }).catch(() => {
      if (!overlay.isConnected) return;
      mapArea.innerHTML = '<div style="padding:24px 10px;color:#e08a8a;font-size:.8rem;text-align:center;">' +
        esc(window.i18n.t('pl.lookup_failed', '検索に失敗しました')) + '</div>';
    });

    // Independent of geocoding — a place can have a Wikipedia article even when
    // geocoding fails (or vice versa), so this resolves and appends on its own.
    wikiLookup(rec.surface).then((wiki) => {
      if (!overlay.isConnected || !wiki) return;
      const wikiBtn = mkActionBtn('Ⓦ ' + window.i18n.t('pl.open_wikipedia', 'Wikipediaで見る'));
      wikiBtn.addEventListener('click', () => {
        try { window.open(wikiUrl(wiki.title), '_system'); } catch (_) {}
      });
      btnRow.appendChild(wikiBtn);
    }).catch(() => {});
  }

  function openPopupFor(surface) {
    try {
      const m = window.aiPlaces && window.aiPlaces.matcher();
      if (!m) return false;
      const rec = m.map.get(surface);
      if (!rec) return false;
      openPlacePopup(rec);
      return true;
    } catch (_) { return false; }
  }

  window.aiPlacesUi = { markContainer, markNow, remark: remarkSoon, openPopupFor };
})();
