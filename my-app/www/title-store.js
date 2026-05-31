// title-store.js — Library item ("Title") data model + persistence.
//
// A Title is a media bundle: optional Anki deck + EPUB + audiobook + SRT,
// all of the same underlying story. Library shows Titles; tapping one loads
// all its attachments and switches to an enabled mode.
//
// Storage: single JSON blob in pref `TITLES_V1`.
//
// Migration: on first use, if `TITLES_V1` is empty, scan existing recent
// decks (`ankiDeckList`) + per-deck pairings (`READING_PAIRING_<deck>`,
// `READING_AUDIO_PAIR_<deck>`, `READING_SRT_PAIR_<deck>`) and synthesize
// Title records. Old per-deck prefs are still read by the existing code,
// so this is a non-destructive layering.

(function () {
  const PREF_KEY = 'TITLES_V1';

  function isCap() {
    return typeof window.isCapacitorEnvironment === 'function' && window.isCapacitorEnvironment();
  }
  async function getPref(key) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      const r = await window.Capacitor.Plugins.Preferences.get({ key });
      return r.value;
    }
    return localStorage.getItem(key);
  }
  async function setPref(key, value) {
    if (isCap() && window.Capacitor?.Plugins?.Preferences) {
      await window.Capacitor.Plugins.Preferences.set({ key, value: String(value) });
    } else {
      localStorage.setItem(key, String(value));
    }
  }

  // ---------- Internal cache ----------
  let titles = null; // Array<Title> when loaded.

  function genId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * @typedef {{
   *   id: string,
   *   name: string,
   *   createdAt: number,
   *   lastOpenedAt: number,
   *   attachments: {
   *     deck?:      { uri?: string, name: string, cardIndex?: number, totalCards?: number },
   *     epub?:      { uri: string,  name: string },
   *     audiobook?: { cachePath: string, name: string },
   *     srt?:       { cachePath: string, name: string }
   *   }
   * }} Title
   */

  async function load() {
    if (titles) return titles;
    try {
      const raw = await getPref(PREF_KEY);
      titles = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[titles] parse failed:', e);
      titles = null;
    }
    if (!Array.isArray(titles)) {
      titles = await migrateFromLegacyDecks();
      await persist();
    }
    return titles;
  }

  async function persist() {
    try {
      await setPref(PREF_KEY, JSON.stringify(titles || []));
    } catch (e) {
      console.warn('[titles] persist failed:', e);
    }
  }

  // ---------- Migration from existing recent-decks + per-deck prefs ----------

  async function readRecentDecks() {
    try {
      const raw = await getPref('ankiDeckList');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  async function migrateFromLegacyDecks() {
    const decks = await readRecentDecks();
    const out = [];
    for (const d of decks) {
      const deckName = d.fileName || d.name || 'Unknown deck';
      const tit = {
        id: genId(),
        name: deckName.replace(/\.apkg$/i, ''),
        createdAt: d.lastOpened || Date.now(),
        lastOpenedAt: d.lastOpened || Date.now(),
        attachments: {
          deck: {
            uri: d.fileUri || null,
            name: deckName,
            cardIndex: d.cardIndex || 0,
            totalCards: d.totalCards || 0
          }
        }
      };
      // Pull in any per-deck pairings.
      const epubName = await getPref('READING_PAIRING_' + deckName);
      if (epubName) {
        // We don't store EPUB URI per-deck currently — only the most-recent
        // URI globally. If the most-recent EPUB matches this pairing, attach
        // it. Otherwise leave epub unset for now (user can re-pick).
        const lastEpubName = await getPref('READING_EPUB_NAME');
        const lastEpubUri = await getPref('READING_EPUB_URI');
        if (lastEpubName === epubName && lastEpubUri) {
          tit.attachments.epub = { uri: lastEpubUri, name: epubName };
        } else {
          // Just record the name as a "ghost" attachment; URI can be re-bound later.
          tit.attachments.epub = { uri: '', name: epubName };
        }
      }
      const audioPath = await getPref('READING_AUDIO_PAIR_' + deckName);
      const audioName = await getPref('READING_AUDIO_NAME_' + deckName);
      if (audioPath) {
        tit.attachments.audiobook = { cachePath: audioPath, name: audioName || 'audiobook' };
      }
      const srtPath = await getPref('READING_SRT_PAIR_' + deckName);
      const srtName = await getPref('READING_SRT_NAME_' + deckName);
      if (srtPath) {
        tit.attachments.srt = { cachePath: srtPath, name: srtName || 'subtitles' };
      }
      out.push(tit);
    }
    return out;
  }

  // ---------- CRUD ----------

  async function list() {
    return await load();
  }

  async function create(partial) {
    await load();
    const tit = {
      id: genId(),
      name: partial?.name || 'Untitled',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      attachments: partial?.attachments || {}
    };
    titles.push(tit);
    await persist();
    return tit;
  }

  async function update(id, patch) {
    await load();
    const i = titles.findIndex(t => t.id === id);
    if (i < 0) return null;
    titles[i] = { ...titles[i], ...patch, attachments: { ...titles[i].attachments, ...(patch?.attachments || {}) } };
    await persist();
    return titles[i];
  }

  async function attach(id, kind, attachment) {
    await load();
    const i = titles.findIndex(t => t.id === id);
    if (i < 0) return null;
    titles[i].attachments[kind] = attachment;
    await persist();
    return titles[i];
  }

  async function detach(id, kind) {
    await load();
    const i = titles.findIndex(t => t.id === id);
    if (i < 0) return null;
    delete titles[i].attachments[kind];
    await persist();
    return titles[i];
  }

  async function remove(id) {
    await load();
    titles = titles.filter(t => t.id !== id);
    await persist();
  }

  async function touchOpened(id) {
    await update(id, { lastOpenedAt: Date.now() });
  }

  async function findByDeckName(deckName) {
    await load();
    return titles.find(t => t.attachments.deck?.name === deckName) || null;
  }

  async function findByName(name) {
    await load();
    return titles.find(t => t.name === name) || null;
  }

  async function setCardIndex(id, idx) {
    await load();
    const i = titles.findIndex(t => t.id === id);
    if (i < 0) return;
    titles[i].lastCardIndex = idx;
    titles[i].lastOpenedAt = Date.now();
    await persist();
  }

  // Remember the last shell mode (card / read / audio) a Title was viewed in,
  // so opening it (or restoring it on launch) reopens in that mode.
  async function setMode(id, mode) {
    if (!mode) return;
    await load();
    const i = titles.findIndex(t => t.id === id);
    if (i < 0) return;
    if (titles[i].lastMode === mode) return; // no-op write avoidance
    titles[i].lastMode = mode;
    await persist();
  }

  // Returns which modes a Title enables based on its attachments.
  function enabledModes(title) {
    if (!title) return { card: false, read: false, audio: false };
    const a = title.attachments || {};
    return {
      card: !!a.deck || !!(a.audiobook && a.srt),  // deck OR (audiobook + srt)
      read: !!a.epub,
      audio: !!a.audiobook
    };
  }

  window.titleStore = {
    list,
    load,
    create,
    update,
    attach,
    detach,
    remove,
    touchOpened,
    findByDeckName,
    findByName,
    setCardIndex,
    setMode,
    enabledModes
  };
})();
