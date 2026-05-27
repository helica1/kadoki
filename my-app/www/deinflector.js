let rules = [];

// Load deinflect.json at startup
export async function loadDeinflectRules() {
  if (rules.length) return;

  const res = await fetch('assets/dictionaries/deinflect.json');
  if (!res.ok) throw new Error('Failed to load deinflect.json');
  const raw = await res.json();

  // Flatten rules by group
  for (const group of Object.values(raw)) {
    for (const rule of group) {
      rules.push({
        in: rule.kanaIn,
        out: rule.kanaOut,
        rulesIn: rule.rulesIn || [],
        rulesOut: rule.rulesOut || [],
      });
    }
  }

  // Sort by longest suffix first (greedy match)
  rules.sort((a, b) => b.in.length - a.in.length);
}

/**
 * Try all possible deinflections from the surface form.
 * Returns an array of { word: baseForm, reason, depth }
 */
export function getDeinflections(surface) {
  const results = new Map();
  results.set(surface, { word: surface, depth: 0, reason: null });

  const queue = [{ word: surface, depth: 0, reason: null, rules: [] }];

  while (queue.length) {
    const cur = queue.shift();

    for (const rule of rules) {
      if (!cur.word.endsWith(rule.in)) continue;

      const stem = cur.word.slice(0, -rule.in.length);
      const newWord = stem + rule.out;

      if (results.has(newWord)) continue;

      results.set(newWord, {
        word: newWord,
        reason: rule.in,
        depth: cur.depth + 1,
      });

      queue.push({
        word: newWord,
        depth: cur.depth + 1,
        reason: rule.in,
        rules: [...cur.rules, rule],
      });
    }
  }

  return Array.from(results.values());
}
