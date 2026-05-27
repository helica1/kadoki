/* dictionary.js  – JMdict-only loader for Yomitan v3 exports  */

const ROOT   = 'assets/dictionaries/';
const JMFILE = 'JMdict_english.json';

let jmMap = null;

/* ---------- helpers -------------------------------------------------- */
async function loadJSON(file) {
  const r = await fetch(ROOT + file);
  if (!r.ok) throw new Error('Missing ' + file);
  return r.json();                         // metadata + words array
}

function buildJMindex(obj) {
  const map = Object.create(null);
  for (const e of obj.words) {             // array name is "words"
    (e.kanji || []).forEach(k => { if (k.text) map[k.text] = e; });
    (e.kana  || []).forEach(k => { if (k.text) map[k.text] = e; });
  }
  return map;
}

async function ensureJM() {
  if (jmMap) return;
  const raw = await loadJSON(JMFILE);
  jmMap = buildJMindex(raw);
}

/* ---------- exported lookup ----------------------------------------- */
export async function lookup(term) {
  term = term.trim();
  if (!term) return null;

  await ensureJM();

  return jmMap[term] ? { type: 'word', data: jmMap[term] } : null;
}
