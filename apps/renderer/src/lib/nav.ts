// Helpers for deciding whether omnibox input is a URL vs a search, and building URLs.

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/;
const LOCALHOST_RE = /^localhost(:\d+)?(\/\S*)?$/i;

/** True when the input should be treated as a direct navigation target, not a search. */
export function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  if (!value || /\s/.test(value.replace(/^\S+:\/\/\S*$/, ''))) {
    // contains whitespace and isn't a bare scheme://... URL → treat as a query
    if (/\s/.test(value)) return false;
  }
  return URL_RE.test(value) || DOMAIN_RE.test(value) || LOCALHOST_RE.test(value);
}

/** Normalize omnibox input into a full URL (adds https:// when missing). */
export function toUrl(input: string): string {
  const value = input.trim();
  return URL_RE.test(value) ? value : `https://${value}`;
}

export type SearchEngineId = 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage';

export const SEARCH_ENGINES: { id: SearchEngineId; name: string }[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo' },
  { id: 'google', name: 'Google' },
  { id: 'bing', name: 'Bing' },
  { id: 'brave', name: 'Brave Search' },
  { id: 'startpage', name: 'Startpage' }
];

const ENGINE_URL: Record<SearchEngineId, (q: string) => string> = {
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  bing: (q) => `https://www.bing.com/search?q=${q}`,
  brave: (q) => `https://search.brave.com/search?q=${q}`,
  startpage: (q) => `https://www.startpage.com/sp/search?query=${q}`
};

/** A regular web-search results URL for a query, using the chosen engine (default DuckDuckGo). */
export function webSearchUrl(query: string, engine: SearchEngineId = 'duckduckgo'): string {
  const q = encodeURIComponent(query.trim());
  return (ENGINE_URL[engine] ?? ENGINE_URL.duckduckgo)(q);
}

/**
 * True for a Tor hidden-service address. These only resolve through Tor's own
 * resolver, so a container on a direct connection can never reach one — Toji moves
 * the tab into a Tor container instead of showing a DNS error.
 */
export function isOnionUrl(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? safeHost(value) : value.split(/[/?#]/)[0];
  return /(^|\.)onion$/i.test((host || '').replace(/:\d+$/, ''));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
