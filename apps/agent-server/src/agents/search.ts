import { config, isBraveSearchEnabled } from '../config.js';
import type { PageSource, SearchPath, SearchResult } from '../types.js';
import { canonicalUrl, isAuthorityPrimary, isAuthorityStrong, isUrlLike, keywordSet, normalizeUrl, normalizeWhitespace, overlapScore, safeHostname, stripHtml } from '../lib/text.js';

function decodeDuckDuckGoUrl(raw: string) {
  const withoutEntities = raw.replace(/&amp;/g, '&');
  try {
    const url = new URL(withoutEntities, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return url.href;
  } catch {
    return withoutEntities;
  }
}

function asLikelyUrl(input: string) {
  return isUrlLike(input) ? canonicalUrl(input.trim()) : undefined;
}

function scoreResult(result: Omit<SearchResult, 'score'>, planQuery: string, seenHosts = new Set<string>()) {
  const host = safeHostname(result.url);
  const queryTerms = keywordSet(planQuery);
  const titleTerms = keywordSet(`${result.title} ${result.snippet} ${host}`);
  let matches = 0;
  for (const term of queryTerms) if (titleTerms.has(term)) matches += 1;
  const lexical = queryTerms.size > 0 ? matches / queryTerms.size : overlapScore(planQuery, `${result.title} ${result.snippet}`);
  const rankBoost = result.rank ? Math.max(0, 1 - (result.rank - 1) * 0.06) : 0.5;
  const diversityBoost = seenHosts.has(host) ? -0.22 : 0.12;
  const authorityBoost = isAuthorityPrimary(host) || isAuthorityStrong(host) ? 0.18 : 0;
  const freshnessBoost = /202[4-9]|latest|new|updated|release|changelog|docs|blog/i.test(`${result.title} ${result.snippet}`) ? 0.05 : 0;
  return Math.max(0, Math.min(1.25, lexical * 0.52 + rankBoost * 0.28 + diversityBoost + authorityBoost + freshnessBoost));
}

function parseDuckDuckGo(html: string, query: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\//gi;
  const snippets = [...html.matchAll(snippetPattern)].map((match) => stripHtml(match[1] ?? ''));

  let index = 0;
  for (const match of html.matchAll(linkPattern)) {
    const rawUrl = decodeDuckDuckGoUrl(match[1] ?? '');
    if (!rawUrl.startsWith('http')) continue;
    if (/duckduckgo\.com\/y\.js/i.test(rawUrl)) continue;
    const url = normalizeUrl(rawUrl);
    const title = stripHtml(match[2] ?? 'Untitled source') || safeHostname(url);
    const snippet = snippets[index] ?? '';
    const partial = { title, url, snippet, source: 'duckduckgo' as const, query, rank: index + 1, domain: safeHostname(url) };
    results.push({ ...partial, score: scoreResult(partial, query) });
    index += 1;
  }
  return dedupeResults(results);
}

function dedupeResults(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((item) => {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const endpoint = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      'user-agent': config.userAgent,
      accept: 'text/html,application/xhtml+xml'
    }
  });
  const html = await response.text();
  return parseDuckDuckGo(html, query).slice(0, Math.max(1, limit));
}

async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(20, Math.max(1, limit))));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      accept: 'application/json',
      'x-subscription-token': config.braveSearchApiKey
    }
  });
  if (!response.ok) throw new Error(`Brave Search failed: ${response.status}`);
  const payload = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (payload.web?.results ?? [])
    .filter((item) => item.url)
    .map((item, index) => {
      const url = normalizeUrl(item.url ?? '');
      const title = stripHtml(item.title ?? safeHostname(url));
      const snippet = stripHtml(item.description ?? '');
      const partial = { title, url, snippet, source: 'brave' as const, query, rank: index + 1, domain: safeHostname(url) };
      return { ...partial, score: scoreResult(partial, query) };
    })
    .slice(0, limit);
}

function directIfUrl(query: string): SearchResult[] | undefined {
  const direct = asLikelyUrl(query);
  if (!direct) return undefined;
  const url = normalizeUrl(direct);
  return [{ title: safeHostname(url), url, snippet: 'Direct navigation target from the intent bar.', source: 'direct' as const, query, rank: 1, score: 1, domain: safeHostname(url) }];
}

function fallbackResults(query: string, limit: number): SearchResult[] {
  const duck = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const google = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return [
    {
      title: `Search results for ${query}`,
      url: google,
      snippet: 'Fallback visible search-results page. Configure Brave Search for production-grade retrieval.',
      source: 'fallback' as const,
      query,
      rank: 1,
      score: 0.38,
      domain: safeHostname(google)
    },
    {
      title: `DuckDuckGo results for ${query}`,
      url: duck,
      snippet: 'Fallback search-results page.',
      source: 'fallback' as const,
      query,
      rank: 2,
      score: 0.35,
      domain: safeHostname(duck)
    }
  ].slice(0, Math.max(1, Math.min(limit, 2)));
}

export async function searchWeb(query: string, limit: number): Promise<SearchResult[]> {
  const direct = directIfUrl(query);
  if (direct) return direct.slice(0, limit);

  try {
    const parsed = isBraveSearchEnabled ? await searchBrave(query, limit) : await searchDuckDuckGo(query, limit);
    if (parsed.length > 0) return parsed.slice(0, limit);
  } catch (error) {
    // Return visible fallback pages so the user can still see a tab doing useful work.
    console.warn(`[toji] searchWeb failed for "${query.slice(0, 80)}":`, error instanceof Error ? error.message : error);
  }
  return fallbackResults(query, limit);
}

// Shared, deduped source gathering for the AI page: both the page generation
// (grounding) and the on-screen "sources" footer use this, so they're identical.
// Concurrent calls for the same query share one in-flight search.
const SOURCES_TTL_MS = 5 * 60 * 1000;
const sourcesCache = new Map<string, { at: number; sources: PageSource[] }>();
const sourcesInflight = new Map<string, Promise<PageSource[]>>();

export async function gatherPageSources(query: string): Promise<PageSource[]> {
  const key = normalizeWhitespace(query).toLowerCase();
  if (!key) return [];
  const cached = sourcesCache.get(key);
  if (cached && Date.now() - cached.at < SOURCES_TTL_MS) return cached.sources;
  const existing = sourcesInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const results = await searchWeb(query, 6);
    const seen = new Set<string>();
    const sources: PageSource[] = [];
    for (const result of results) {
      const dedupeKey = result.url.replace(/#.*$/, '');
      if (!result.url.startsWith('http') || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sources.push({ title: result.title || result.domain || result.url, url: result.url, summary: result.snippet || undefined });
      if (sources.length >= 6) break;
    }
    sourcesCache.set(key, { at: Date.now(), sources });
    if (sourcesCache.size > 200) sourcesCache.delete(sourcesCache.keys().next().value as string);
    return sources;
  })();
  sourcesInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    sourcesInflight.delete(key);
  }
}

export async function gatherSearchCandidates(paths: SearchPath[], limit: number): Promise<SearchResult[]> {
  const candidates: SearchResult[] = [];
  const perQuery = Math.max(2, Math.ceil(limit / Math.max(1, paths.length)) + 2);
  const usablePaths = paths.length > 0 ? paths : [{ query: '', intent: 'fallback', priority: 1, freshness: 'auto' as const }];

  for (const path of usablePaths) {
    if (!path.query.trim()) continue;
    const results = await searchWeb(path.query, perQuery);
    for (const result of results) {
      candidates.push({ ...result, query: path.query, reason: path.intent, score: result.score * Math.max(0.2, path.priority) });
    }
  }

  const byUrl = new Map<string, SearchResult>();
  for (const candidate of candidates) {
    const key = normalizeUrl(candidate.url);
    const previous = byUrl.get(key);
    if (!previous || candidate.score > previous.score) byUrl.set(key, candidate);
  }

  const chosen: SearchResult[] = [];
  const seenHosts = new Set<string>();
  for (const candidate of [...byUrl.values()].sort((a, b) => b.score - a.score)) {
    candidate.score = candidate.score + scoreResult(candidate, candidate.query, seenHosts);
    candidate.domain = safeHostname(candidate.url);
    chosen.push(candidate);
    seenHosts.add(candidate.domain);
    if (chosen.length >= limit) break;
  }

  if (chosen.length === 0 && usablePaths[0]?.query) return fallbackResults(usablePaths[0].query, limit);
  return chosen.sort((a, b) => b.score - a.score).slice(0, limit);
}
