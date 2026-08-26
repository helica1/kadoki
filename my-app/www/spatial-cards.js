// spatial-cards.js — visionOS spatial depth for card-mode pictures.
//
// A subs2srs card is a movie frame; on Vision Pro that frame can carry real
// parallax via visionOS 26's Spatial Scene generator. WebKit cannot composite
// RealityKit inline, so the picture is drawn by a native layer BEHIND the
// webview (SpatialImagePlugin) while the DOM <img> goes to opacity 0 and the
// page turns transparent over it. Everything else in card mode — subtitle,
// dictionary taps, swipe gestures, chrome — stays exactly where it was.
//
// ── THE PACING PROBLEM ───────────────────────────────────────────────────
// generate() is a multi-second on-device pass and the user can swipe faster
// than once a second. You cannot win that race, so this does not try:
//
//   FLAT WHILE MOVING, SPATIAL WHEN IT SETTLES.
//
// Every card render immediately drops back to the plain DOM image. Only after
// SETTLE_MS of no further renders does the native layer get asked for the
// picture. Blowing through twenty cards therefore costs nothing at all, and
// landing on one you have already seen is instant (the plugin keeps an LRU).
// On settle we also ask the plugin to pre-generate the NEXT card, so a normal
// read-one-then-advance rhythm stays ahead of the user.
//
// Off switch: Appearance -> Card -> "Spatial pictures". Vision Pro only; this
// whole module is inert everywhere else.

(function () {
  'use strict';

  const SETTLE_MS = 450;   // no card render for this long = the user has landed

  const plugin = () => window.Capacitor?.Plugins?.SpatialImage || null;
  // Gaze-glow hotspots ride the main spatial toggle (folded 2026-08-26 —
  // the separate experimental pref graduated once hover targets proved out).
  const hoverOn = () => enabled();
  const enabled = () => {
    try {
      return !!window.KADOKI_VISION_NATIVE &&
             window.appearance?.get?.('card')?.spatialPics === true;
    } catch (_) { return false; }
  };

  // ---- on-screen trace (diagnostic, OFF by default) -----------------------
  // The devicectl console tunnel drops within seconds; a trace the overlay
  // mirrors into the 3D view and a screenshot captures is the reliable path.
  // Enable with localStorage KADOKI_SPATIAL_DIAG='1'.
  const DIAG_ON = (() => { try { return localStorage.getItem('KADOKI_SPATIAL_DIAG') === '1'; } catch (_) { return false; } })();
  const _diag = [];
  let _diagStatus = '';
  function kvDiagStatus(line) {       // fixed top line, rewritten only when it CHANGES
    if (!DIAG_ON || line === _diagStatus) return;
    _diagStatus = line;
    kvDiag(null);
  }
  function kvDiag(msg) {
    if (!DIAG_ON) return;
    try {
      if (msg) {
        const t = new Date();
        _diag.push(`${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}.${String(t.getMilliseconds()).padStart(3,'0')} ${msg}`);
        while (_diag.length > 8) _diag.shift();
      }
      let box = document.getElementById('kvSpatialDiag');
      if (!box) {
        box = document.createElement('pre');
        box.id = 'kvSpatialDiag';
        box.style.cssText = 'position:fixed;right:12px;top:90px;width:44vw;overflow:hidden;z-index:99999;pointer-events:none;margin:0;padding:8px 10px;' +
          'font:22px/1.3 ui-monospace,Menlo,monospace;color:#9f9;background:rgba(0,0,0,.7);border-radius:8px;max-width:70vw;white-space:pre-wrap;';
        document.body.appendChild(box);
      }
      box.textContent = (_diagStatus ? _diagStatus + '\n' : '') + _diag.join('\n');
    } catch (_) {}
  }
  window.kvDiag = kvDiag;

  let settleTimer = 0;
  let live = false;          // the native layer currently owns the picture
  let token = 0;             // cancels an in-flight present that got superseded
  let savedBg = null;        // page background to restore when we let go

  // ---- page transparency -------------------------------------------------
  // The native layer can only be seen where the page paints nothing, and
  // html/body are `background-color: black`. We hand the ORIGINAL computed
  // colour to native so it can paint the same backdrop itself — otherwise
  // every part of the window that isn't the picture would fall through to the
  // system's window glass, which is a startling change for a feature that
  // only concerns one <img>.
  function pageBackdrop() {
    try {
      const c = getComputedStyle(document.body).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      const h = getComputedStyle(document.documentElement).backgroundColor;
      if (h && h !== 'rgba(0, 0, 0, 0)' && h !== 'transparent') return h;
    } catch (_) {}
    return '#000000';
  }

  function openHole() {
    if (savedBg) return;
    const html = document.documentElement, body = document.body;
    savedBg = { html: html.style.background, body: body.style.background };
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    body.classList.add('kv-spatial-live');
  }

  function closeHole() {
    document.body.classList.remove('kv-spatial-live');
    if (!savedBg) return;
    document.documentElement.style.background = savedBg.html;
    document.body.style.background = savedBg.body;
    savedBg = null;
  }

  // ---- keeping clear of the chrome ---------------------------------------
  // A RealityKit layer that claims a depth budget composites in FRONT of its 2D
  // sibling views — measured on device: the picture hid the subtitle no matter
  // how far back the entity was pushed. So the picture must not occupy the
  // chrome's space in the first place.
  //
  // The subtitle sits absolutely positioned OVER the top of the picture area,
  // and the Vision nav zones are fixed bands down the sides. Reserving room for
  // them shrinks the picture, which is the price of keeping the subtitle in the
  // DOM — and keeping it in the DOM is what preserves dictionary lookup,
  // furigana, and the scroll safe-zone. A native subtitle would have to
  // reimplement all three.
  //
  // Applied on every card render, not just on settle, so the flat DOM image and
  // the native picture occupy exactly the same box and the cross-fade doesn't
  // jump.
  function reserveChrome(img) {
    const cont = document.getElementById('cardContainer');
    if (!img || !cont) return;
    const c = cont.getBoundingClientRect();
    if (c.height < 10) return;
    const floating = (el) => {
      if (!el) return null;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return null;
      if (parseFloat(st.opacity) === 0) return null;
      // Only elements OUT OF FLOW can overlap the picture; in-flow siblings are
      // already kept apart by the flex layout.
      if (st.position !== 'absolute' && st.position !== 'fixed') return null;
      const r = el.getBoundingClientRect();
      return (r.width > 2 && r.height > 2) ? r : null;
    };

    // Subtitle reservation is OFF: with the depth region aligned .back the
    // picture sits behind the webview plane and the subtitle draws over it, as
    // it does over the flat image. Reserving its band cost a third of the
    // frame's height for nothing. Flip RESERVE_SUB if overlap ever returns.
    const RESERVE_SUB = false;
    let top = 0, bottom = 0;
    const sub = RESERVE_SUB ? floating(cont.querySelector('.subtitle-text')) : null;
    if (sub) {
      // Whichever half it hugs is the band to give up.
      if (sub.top + sub.height / 2 < c.top + c.height / 2) top = sub.bottom - c.top + 10;
      else bottom = c.bottom - sub.top + 10;
    }
    // The side nav zones are deliberately NOT reserved by default. Measured on
    // device they cost ~200pt EACH, taking the picture from 1145pt wide to 740 —
    // and unlike the subtitle they are decorative: they are faint glyphs whose
    // gaze/pinch targets keep working perfectly while covered. Giving up a third
    // of the frame to keep two hint arrows visible is the wrong trade for a
    // feature that exists to show a big picture. Flip RESERVE_NAV to restore.
    const RESERVE_NAV = false;
    let left = 0, right = 0;
    if (RESERVE_NAV) {
      document.querySelectorAll('.kv-cardnav-zone').forEach((z) => {
        const r = floating(z);
        if (!r) return;
        if (r.left + r.width / 2 < c.left + c.width / 2) left = Math.max(left, r.right - c.left + 8);
        else right = Math.max(right, c.right - r.left + 8);
      });
    }

    // Never give up more than a third of an axis — a very long subtitle would
    // otherwise squeeze the frame down to nothing.
    const capY = c.height / 3, capX = c.width / 3;
    img.style.marginTop = Math.round(Math.min(Math.max(top, 0), capY)) + 'px';
    img.style.marginBottom = Math.round(Math.min(Math.max(bottom, 0), capY)) + 'px';
    img.style.marginLeft = Math.round(Math.min(Math.max(left, 0), capX)) + 'px';
    img.style.marginRight = Math.round(Math.min(Math.max(right, 0), capX)) + 'px';
    img.style.width = 'auto';   // the base rule pins width:100%, which would fight the side margins
  }

  // ---- geometry ----------------------------------------------------------
  // Where the PICTURE is, not where its element is. .card-image is
  // object-fit: contain, so a 16:9 frame in a taller box is letterboxed and
  // the element rect is bigger than the drawn image on one axis; handing
  // native the element rect would stretch the scene over the empty bands.
  function pictureRect(img) {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!nw || !nh) return { x: r.left, y: r.top, width: r.width, height: r.height };
    const scale = Math.min(r.width / nw, r.height / nh);
    const w = nw * scale, h = nh * scale;
    // Vertical placement follows object-position, which the "Picture position"
    // pref drives via --image-card-objpos.
    let objpos = 'center';
    try { objpos = (getComputedStyle(img).objectPosition || '').split(' ')[1] || 'center'; } catch (_) {}
    const slackY = r.height - h;
    const y = objpos === 'top' ? r.top : objpos === 'bottom' ? r.top + slackY : r.top + slackY / 2;
    return { x: r.left + (r.width - w) / 2, y: y, width: w, height: h };
  }

  // A stable identity for one card's picture, so the plugin's LRU can skip
  // regenerating it. Anki media are data: URLs; the tail is stable per file.
  const keyFor = (src) => src.slice(-64);
  const b64Of = (src) => {
    const i = src.indexOf(',');
    return (src.startsWith('data:') && i > 0) ? src.slice(i + 1) : null;
  };

  function currentImage() {
    const b = document.body.classList;
    if (!b.contains('mode-card') || b.contains('card-srt')) return null;
    const img = document.querySelector('#cardContainer .card-image');
    if (!img || !img.getAttribute('src')) return null;
    // A picture that hasn't decoded yet has no natural size, so its rect is
    // not trustworthy — wait for the next settle rather than place it wrong.
    if (!img.complete || !img.naturalWidth) return null;
    return img;
  }

  // ---- UI mirror ---------------------------------------------------------
  // The depth layer composites IN FRONT of the webview it lives in, whatever z
  // its entities sit at (measured, repeatedly). So while a picture is up, the
  // webview's own pixels are snapshotted natively and drawn back over the
  // scene — subtitle, furigana, dictionary highlights, nav glyphs, timer —
  // pixel-exact and with no DOM duplication. Taps still land on the real
  // elements underneath. This is what drives the snapshot cadence: every DOM
  // change while live (debounced), every transition end, and a slow heartbeat.
  let mirrorObs = null, mirrorTimer = 0, mirrorBeat = 0, mirrorBusy = false, mirrorAgain = false;

  let mirrorLast = 0;
  const MIRROR_MIN_GAP = 170;   // ≤ ~6 snapshots/s; a lookup mutates the DOM hard, and a
                                // full-window snapshot each time was costing input latency

  async function mirrorNow() {
    const p = plugin();
    if (!p || !live) return;
    if (mirrorBusy) { mirrorAgain = true; return; }
    const wait = MIRROR_MIN_GAP - (performance.now() - mirrorLast);
    if (wait > 0) { mirrorSoon(wait); return; }
    mirrorBusy = true;
    mirrorLast = performance.now();
    try {
      const hot = hoverOn() ? hotspots() : [];
      kvDiagStatus(`hotspots=${hot.length} hoverPref=${hoverOn()} live=${live}`);
      await p.refreshOverlay({
        x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
        // 1.5x: still crisp for subtitle-size glyphs, 44% fewer pixels than 2x
        // per frame (the snapshot pipeline was showing up as input lag).
        scale: 1.5,
        hot: hot,
      });
    } catch (_) {}
    mirrorBusy = false;
    if (mirrorAgain) { mirrorAgain = false; mirrorSoon(MIRROR_MIN_GAP); }
  }
  function mirrorSoon(ms) {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => { mirrorTimer = 0; mirrorNow(); }, ms);
  }
  const onTransition = () => { if (live) mirrorSoon(20); };

  // Gaze targets for the native hover layer: the subtitle's word tokens (and
  // any word-hit capsules), plus the nav zones. visionOS draws its hover glow
  // for web content itself, above the webview — it is not in WebKit's pixels,
  // so it cannot be in the snapshot, and under the depth layer it vanished.
  // Native rebuilds the glow on invisible planes at these rects.
  // .kv-card-hit = the per-dictionary-word overlays enhanced-dictionary.js
  // builds for card mode on Vision (deinflection-based, one per word — these
  // ARE the 2D gaze targets, so the native glow lands on exactly the same
  // rects). The Segmenter path below is only the fallback before they exist.
  // Nav/replay zones are deliberately NOT glow targets: a band that lights up
  // whenever the gaze crosses the picture was distracting (user call); their
  // pinches still reach the DOM through the pass-through container.
  const HOT_SEL = '#cardContainer .subtitle-text .kv-card-hit, #cardContainer .subtitle-text .dict-token, #cardContainer .subtitle-text .kword-hit';
  const _seg = (() => { try { return new Intl.Segmenter('ja', { granularity: 'word' }); } catch (_) { return null; } })();
  const _isJa = (s) => /[぀-ヿ一-鿿㐀-䶿々〆]/.test(s);

  // Word rects for a PLAIN subtitle (the deck-card subtitle is not tokenised
  // into per-word elements — the dictionary resolves taps by coordinates), so
  // segment the text ourselves and measure each word with a Range. Ruby
  // annotations are skipped so furigana never produces its own targets.
  function wordRects(el, out, W, H) {
    if (!_seg || !el) return;
    const nodes = [], parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return (n.parentElement && n.parentElement.closest('rt, rp')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let n, acc = 0;
    while ((n = walker.nextNode())) { nodes.push({ n, start: acc }); parts.push(n.nodeValue); acc += n.nodeValue.length; }
    const text = parts.join('');
    if (!text.trim()) return;
    const at = (off) => {   // global offset → {node, offset}
      let lo = 0, hi = nodes.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].start <= off) lo = mid; else hi = mid - 1; }
      return { node: nodes[lo].n, offset: Math.min(off - nodes[lo].start, nodes[lo].n.nodeValue.length) };
    };
    const range = document.createRange();
    for (const sgm of _seg.segment(text)) {
      if (out.length >= 240) return;
      const w = sgm.segment;
      if (!sgm.isWordLike || !_isJa(w)) continue;
      const a = at(sgm.index), b = at(sgm.index + w.length);
      try { range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); } catch (_) { continue; }
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
        // a little vertical slack: a steadier capsule as the gaze drifts
        out.push([r.left, r.top - 3, r.width, r.height + 6]);
      }
    }
  }

  function hotspots() {
    const out = [];
    try {
      const W = window.innerWidth, H = window.innerHeight;
      document.querySelectorAll(HOT_SEL).forEach((el) => {
        if (out.length >= 240) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        for (const r of el.getClientRects()) {
          if (r.width < 2 || r.height < 2) continue;
          if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
          out.push([r.left, r.top, r.width, r.height]);
        }
      });
      const sub = document.querySelector('#cardContainer .subtitle-text');
      if (sub && !sub.querySelector('.kv-card-hit, .dict-token, .kword-hit')) {
        const before = out.length;
        wordRects(sub, out, W, H);
        // Segmenter unavailable or produced nothing: fall back to the per-char
        // .dict-frag spans the dictionary itself taps on — coarser glow, but
        // a glow.
        if (out.length === before) {
          sub.querySelectorAll('.dict-frag').forEach((el) => {
            if (out.length >= 240) return;
            for (const r of el.getClientRects()) {
              if (r.width < 2 || r.height < 2) continue;
              out.push([r.left, r.top - 3, r.width, r.height + 6]);
            }
          });
        }
      }
    } catch (_) {}
    return out;
  }

  // A pinch on a native hotspot comes back here as the point it covered; hand
  // it to the DOM as the click the webview would have received directly.
  window.addEventListener('kadokiSpatialTap', (e) => {
    try {
      // Capacitor's triggerEvent copies the payload's fields ONTO the event
      // (e.x / e.y), not into detail — read both shapes.
      let d = e && e.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
      const x = Number((d && d.x) != null ? d.x : e.x), y = Number((d && d.y) != null ? d.y : e.y);
      console.log('[kvSpatial] tap event', x, y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const el = document.elementFromPoint(x, y);
      console.log('[kvSpatial] tap target', el && (el.id || el.className || el.tagName));
      if (!el) return;
      // The app is touch-first: the subtitle's dictionary lookup is bound on
      // touchstart/touchend per span (click only exists for the Mac shell), and
      // the swipe/chrome handlers are document-level touch listeners. So the
      // forwarded pinch is replayed as the same touch sequence WebKit would
      // have produced for a pinch on that point, then a click for anything
      // (nav zones, buttons) that listens to click instead.
      let touched = false;
      try {
        if (typeof Touch === 'function' && typeof TouchEvent === 'function') {
          const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y,
            pageX: x + window.scrollX, pageY: y + window.scrollY, screenX: x, screenY: y,
            radiusX: 2, radiusY: 2, force: 1 });
          const mk = (type, touches) => new TouchEvent(type, { bubbles: true, cancelable: true,
            composed: true, view: window, touches, targetTouches: touches, changedTouches: [t] });
          el.dispatchEvent(mk('touchstart', [t]));
          el.dispatchEvent(mk('touchend', []));
          touched = true;
        }
      } catch (_) { touched = false; }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
        clientX: x, clientY: y, view: window }));
    } catch (_) {}
  });

  function startMirror() {
    stopMirror();
    // Native seeded frame 0 (the screen exactly as it was) before the layer
    // appeared. The DOM image now fades out over ~280ms (theme.css): snapshot
    // through the fade so the overlay cross-fades to the scene, then settle.
    [70, 180, 300, 460].forEach((t) => setTimeout(() => { if (live) mirrorNow(); }, t));
    mirrorObs = new MutationObserver((recs) => {
      // The trace box is DOM too; its own writes must not drive the mirror.
      for (const r of recs) { if (!(r.target && r.target.closest && r.target.closest('#kvSpatialDiag'))) { mirrorSoon(40); return; } }
    });
    mirrorObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('transitionend', onTransition, true);
    document.addEventListener('animationend', onTransition, true);
    // Heartbeat for things that change without a DOM mutation we observe
    // (canvas waveforms, scroll inside a long subtitle).
    mirrorBeat = setInterval(() => { if (live) mirrorNow(); }, 1000);
  }
  function stopMirror() {
    if (mirrorObs) { try { mirrorObs.disconnect(); } catch (_) {} mirrorObs = null; }
    document.removeEventListener('transitionend', onTransition, true);
    document.removeEventListener('animationend', onTransition, true);
    clearTimeout(mirrorTimer); mirrorTimer = 0;
    clearInterval(mirrorBeat); mirrorBeat = 0;
    mirrorAgain = false;
  }

  // ---- the two states ----------------------------------------------------

  function goFlat() {
    kvDiag(`flat (was live=${live})`);
    token++;
    clearTimeout(settleTimer); settleTimer = 0;
    if (!live && !savedBg) return;
    live = false;
    stopMirror();
    closeHole();
    try { plugin()?.hide(); } catch (_) {}
  }

  async function goSpatial() {
    const p = plugin();
    if (!p || !enabled()) return;
    const img = currentImage();
    if (!img) return;
    const src = img.getAttribute('src');
    const b64 = b64Of(src);
    if (!b64) return;

    const mine = ++token;
    kvDiag(`spatial: present… live=${live}`);
    reserveChrome(img);
    const rect = pictureRect(img);
    const backdrop = pageBackdrop();
    try {
      const r = await p.present({
        image: b64, key: keyFor(src),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        spatial: true, backdrop: backdrop,
      });
      // Superseded while the generative pass ran (the user swiped on): the
      // plugin still cached the result, but this card is no longer on screen,
      // so do NOT open the hole over whatever is there now.
      if (mine !== token) { kvDiag('present superseded'); return; }
      kvDiag(`present ok gen=${r && r.generation} ${r && r.cached ? 'cached' : 'gen'} ${r && r.ms}ms`);
      const wasLive = live;
      openHole();
      live = true;
      if (!wasLive) startMirror(); else mirrorSoon(10);
      if (r && r.fallbackReason) {
        console.warn('[kvSpatial] flat fallback:', r.fallbackReason);
      }
      prepareNext();
    } catch (e) {
      kvDiag('present FAILED ' + String(e?.message || e).slice(0, 60));
      if (mine !== token) return;
      goFlat();
      console.warn('[kvSpatial] present failed:', e?.message || e);
    }
  }

  // Lookahead. Runs only AFTER a settle — never during a swipe — and walks
  // forward LOOKAHEAD cards, inflating their picture from the deck archive if
  // the app hasn't cached it yet. Each prepare() is a full generative pass, so
  // they are issued in sequence rather than at once; the plugin serialises them
  // anyway and a burst would just compete with the visible card.
  //
  // This is what makes a slow reader never see the flat->depth swap: by the time
  // you swipe, the next card's scene is already in the LRU and present()
  // returns from cache in ~0ms.
  const LOOKAHEAD = 3;
  let prepLoopRunning = false;
  async function prepareNext() {
    if (prepLoopRunning) return;           // the running loop re-reads the index every pass
    prepLoopRunning = true;
    try {
      // Keep going until the LOOKAHEAD cards after the CURRENT index are all
      // prepared. Re-evaluates the index each pass, so swiping while it runs
      // simply retargets it instead of leaving it preparing stale cards.
      for (let guard = 0; guard < 40; guard++) {
        if (!enabled() || !live) break;
        const notes = window.allNotes;
        const i = window.currentCardIndex;
        if (!Array.isArray(notes) || typeof i !== 'number') break;
        let todo = null;
        for (let n = i + 1; n <= i + LOOKAHEAD && n < notes.length; n++) {
          const note = notes[n];
          if (!note || !(note.imageHtml || note.imageFilename)) continue;
          let src = null;
          if (note.imageHtml) { const m = note.imageHtml.match(/src=["']([^"']+)["']/); if (m) src = m[1]; }
          if (!src && note.imageFilename && window.mediaPromises && window.mediaPromises[note.imageFilename]) {
            try { src = await window.mediaPromises[note.imageFilename](); } catch (_) {}
            if (src && !note.imageHtml) note.imageHtml = `<img src="${src}" class="card-image">`;  // warm the app's own cache too
          }
          if (!src || !b64Of(src)) continue;
          let cached = false;
          try { cached = !!(await plugin()?.isCached({ key: keyFor(src), spatial: true }))?.cached; } catch (_) {}
          if (!cached) { todo = src; break; }
        }
        if (!todo) break;                  // everything ahead is ready
        try { await plugin()?.prepare({ image: b64Of(todo), key: keyFor(todo), spatial: true }); }
        catch (_) {}
      }
    } finally { prepLoopRunning = false; }
  }

  // True when the plugin already holds this picture's generated scene (the
  // lookahead ran, or the card was seen before): present() is then ~3ms and
  // the layer can cut 3D→3D without dropping to flat. (Re-added: an earlier
  // edit deleted this function and every card render after the first threw a
  // ReferenceError inside the MutationObserver — the frozen-picture bug.)
  async function isPrepared(img) {
    try {
      const src = img.getAttribute('src') || '';
      const p = plugin();
      if (!p || typeof p.isCached !== 'function') return false;
      // A silent bridge stall must never freeze the card: 1.5s cap → "not
      // prepared" → the flat path runs.
      const r = await Promise.race([
        p.isCached({ key: keyFor(src), spatial: true }),
        new Promise((res) => setTimeout(() => res({ cached: false, timeout: true }), 1500)),
      ]);
      if (r && r.timeout) kvDiag('isCached TIMEOUT');
      return !!(r && r.cached);
    } catch (e) { kvDiag('isCached threw ' + String((e && e.message) || e).slice(0, 40)); return false; }
  }

  function scheduleSettle() {
    if (!enabled() || document.hidden) { goFlat(); return; }
    // Reserve the chrome's space NOW so the flat image already sits in the box
    // the native picture will occupy; otherwise the hand-over visibly jumps.
    try { reserveChrome(document.querySelector('#cardContainer .card-image')); } catch (_) {}
    clearTimeout(settleTimer); settleTimer = 0;
    // NOTE: not currentImage() — that requires the <img> to have DECODED, and
    // right after a swipe it hasn't yet, which sent every swipe down the flat
    // detour even with the next scene cached (log: hide → 460ms → present
    // cached=true, on every card). Decide on the src alone, then await decode.
    const b = document.body.classList;
    const rawImg = (b.contains('mode-card') && !b.contains('card-srt'))
      ? document.querySelector('#cardContainer .card-image') : null;
    kvDiag(`card render: live=${live} img=${!!rawImg} src=${!!(rawImg && rawImg.getAttribute('src'))}`);
    if (live && rawImg && rawImg.getAttribute('src')) {
      // Layer is up from the previous card. If the new one is already
      // generated, cut straight to it; the layer never drops.
      const mine = ++token;
      isPrepared(rawImg).then(async (ok) => {
        kvDiag(`prepared=${ok} tokenOK=${mine === token}`);
        if (mine !== token) return;
        if (ok) {
          try { if (rawImg.decode) await rawImg.decode(); } catch (_) {}
          if (mine !== token) return;
          goSpatial();
          return;
        }
        goFlat();
        settleTimer = setTimeout(() => { settleTimer = 0; goSpatial(); }, SETTLE_MS);
      });
      return;
    }
    goFlat();                       // flat FIRST — never leave a stale picture up
    if (!enabled() || document.hidden) return;
    settleTimer = setTimeout(() => { settleTimer = 0; goSpatial(); }, SETTLE_MS);
  }

  // ---- triggers ----------------------------------------------------------
  function start() {
    const container = document.getElementById('cardContainer');
    if (!container) { setTimeout(start, 500); return; }

    // Every card render replaces #cardContainer's children, on every path
    // (swipe, restore, auto-advance, mode re-entry) — which is why this
    // observes the DOM rather than wrapping displayCard, whose internal
    // callers bypass the window binding.
    new MutationObserver(scheduleSettle).observe(container, { childList: true });

    // Leaving card mode, an SRT card taking over, or a modal opening on top
    // all mean the picture must go back to the DOM immediately.
    new MutationObserver(() => {
      if (!enabled() || !document.body.classList.contains('mode-card') ||
          document.body.classList.contains('card-srt')) goFlat();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) goFlat();
    });
    window.addEventListener('resize', scheduleSettle);

    if (enabled()) scheduleSettle();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // The transport ornament's flat ⇄ spatial button mirrors the pref: push the
  // state whenever it may have changed (boot, pref row, ornament tap).
  function pushState() {
    try { window.Capacitor?.Plugins?.BackgroundAudio?.tpState?.({ spatialOn: enabled() }); } catch (_) {}
  }
  if (window.KADOKI_VISION_NATIVE) setTimeout(pushState, 1200);

  // Kept for hand-testing and for preferences.js to poke after the toggle
  // flips (the pref is read live, but the state has to be re-evaluated).
  window.kvSpatial = {
    refresh() { scheduleSettle(); pushState(); },
    off: goFlat,
    // Ornament button: flip Appearance → Card → "Spatial pictures" in place.
    toggle() {
      let on = false;
      try {
        on = !(window.appearance?.get?.('card')?.spatialPics === true);
        window.appearance?.set?.('card', { spatialPics: on });
      } catch (_) {}
      scheduleSettle();
      pushState();
      try {
        const label = window.i18n?.t?.('pj.spatial_pics', 'Spatial pictures (depth)') || 'Spatial pictures';
        window.showToast?.(label + ': ' + (on ? 'ON' : 'OFF'), 1400);
      } catch (_) {}
    },
    async available() {
      try { return !!(await plugin()?.available())?.available; } catch (_) { return false; }
    },
    clearCache() { try { plugin()?.clearCache(); } catch (_) {} },
  };
})();
