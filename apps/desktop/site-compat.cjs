'use strict';

// What pages are told about the browser, and where the windows they open should go.
// Both are rules about being an ordinary browser to the sites that run in Toji.

/**
 * The user agent every page sees: Electron's default with the app's own name and the
 * Electron token taken out, so it reads as the Chromium it is.
 *
 * Sites take an unfamiliar token for an embedded or out-of-date browser: Google served
 * its years-old sign-in page and refused some logins outright, and others fell back to
 * their no-frills layouts. Everything else in the string, the Chromium version above
 * all, stays exactly as Chromium wrote it, so what a page is told matches what it gets.
 */
function chromeUserAgent(fallback) {
  return String(fallback || '')
    .replace(/ Electron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))(?: [^\s()]+\/[^\s()]+)*?(?= Chrome\/)/, '$1');
}

/**
 * Where a window a page asks to open should go.
 *
 *   'window'  a real window, with window.opener intact: a sized window.open() (a sign-in
 *             popup, a payment window, a print view), or an empty one the page means to
 *             navigate itself once it has a handle on it. A tab could offer the page no
 *             handle at all, and the sign-in would end with nothing to report back to.
 *   'tab'     everything else on the web: a target=_blank link, a ⌘-click.
 *   'mail'    a mailto: link, for the system mail app.
 *   'deny'    anything else.
 *
 * `disposition` is Chromium's word for how the page (or the click) wanted it.
 */
function popupPlacement({ url, disposition }) {
  const address = String(url || '');
  if (address === '' || address === 'about:blank') return 'window';
  let scheme;
  try {
    scheme = new URL(address).protocol;
  } catch {
    return 'deny';
  }
  if (scheme === 'mailto:') return 'mail';
  if (scheme !== 'http:' && scheme !== 'https:') return 'deny';
  return disposition === 'new-window' ? 'window' : 'tab';
}

module.exports = { chromeUserAgent, popupPlacement };
