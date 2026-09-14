// Leaving a page, through the browser. Each helper calls the bridge when it has the
// call, and otherwise does the closest thing a plain browser tab can, so the built pages
// can be clicked through during development without the Gecko browser.

import { bridge } from '../src/lib/bridge';
import { isBrowserAddress, looksLikeUrl, toUrl, webSearchUrl } from '../src/lib/nav';

type TojiPage = 'settings' | 'welcome' | 'plans';

/** Another of Toji's pages (about:settings, about:welcome, about:plans). */
export function openPage(page: TojiPage, options?: { query?: string }) {
  const toji = bridge();
  if (toji.openPage) {
    toji.openPage(page, options);
    return;
  }
  window.location.assign(`./${page}.html${options?.query ? `?q=${encodeURIComponent(options.query)}` : ''}`);
}

/** A web page, in a tab of this window next to this one. */
export function openTab(url: string) {
  const toji = bridge();
  if (toji.openTab) toji.openTab(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** What was typed into the start page; the browser decides whether it is an address or a search. */
export function navigate(input: string) {
  const toji = bridge();
  if (toji.navigate) {
    toji.navigate(input);
    return;
  }
  window.location.assign(looksLikeUrl(input) ? toUrl(input) : webSearchUrl(input));
}

/** Opens an AI answer page for a query; undefined when the browser cannot, so callers hide the wand. */
export function askAI(): ((query: string) => void) | undefined {
  const toji = bridge();
  if (!toji.askAI) return undefined;
  // An address with Shift+Enter or the wand still just opens, as in the omnibox.
  return (query: string) => (looksLikeUrl(query) || isBrowserAddress(query) ? navigate(query) : toji.askAI?.(query));
}
