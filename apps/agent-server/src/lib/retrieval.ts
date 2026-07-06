import type { MemoryFact } from './memory.js';

// Dependency-free BM25 lexical retrieval over memory facts. No embeddings exist in
// this stack (inference is a CLI agent over stdin/stdout), so the librarian uses
// classic lexical ranking to pick candidate memories before condensing them.

const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'i', 'my',
  'me', 'you', 'your', 'we', 'our', 'do', 'does', 'did', 'so', 'if', 'then', 'than', 'into', 'about'
]);

/** Lowercase alphanumeric tokens, stopwords dropped. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Each fact's searchable text = its text plus its tags. */
function factTokens(fact: MemoryFact): string[] {
  return tokenize(`${fact.text} ${fact.tags.join(' ')}`);
}

/**
 * Return the top-k facts most relevant to `query` by BM25. Ties break toward the
 * most recent fact. An empty query returns the k most recent facts.
 */
export function searchFacts(facts: MemoryFact[], query: string, k: number): MemoryFact[] {
  if (k <= 0 || facts.length === 0) return [];

  const byRecent = (a: MemoryFact, b: MemoryFact) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return [...facts].sort(byRecent).slice(0, k);
  }

  // Build per-document token lists, term frequencies, and document frequencies.
  const docs = facts.map((fact) => {
    const tokens = factTokens(fact);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { fact, len: tokens.length, tf };
  });
  const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    df.set(term, docs.filter((d) => d.tf.has(term)).length);
  }

  const N = docs.length;
  const scored = docs.map((d) => {
    let score = 0;
    for (const term of queryTerms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      // Standard BM25 idf (always positive via the +1 form).
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const freq = d.tf.get(term) ?? 0;
      if (freq === 0) continue;
      const denom = freq + K1 * (1 - B + (B * d.len) / avgLen);
      score += idf * ((freq * (K1 + 1)) / denom);
    }
    return { fact: d.fact, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score - a.score) || byRecent(a.fact, b.fact))
    .slice(0, k)
    .map((s) => s.fact);
}
