/**
 * One query parameter from a page's URL. The Gecko browser serves Toji's pages under
 * about: URLs (about:plans?q=…), which are simple URIs whose `location.search` Firefox
 * does not always fill in, so this reads the raw href the way Firefox's own about:
 * pages do.
 */
export function queryParam(href: string, name: string): string | null {
  const start = href.indexOf('?');
  if (start === -1) return null;
  const hash = href.indexOf('#', start);
  return new URLSearchParams(href.slice(start + 1, hash === -1 ? undefined : hash)).get(name);
}
