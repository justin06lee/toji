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

/** A regular web-search results URL for a query. */
export function webSearchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query.trim())}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
