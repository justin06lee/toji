'use strict';

// Sites that want you to switch browsers. The Chrome Web Store greets every browser that
// isn't Chrome with a "Switch to Chrome?" card; DuckDuckGo floats an "Upgrade to our
// browser" popover over its results; Google, Bing and Brave Search run variants of the same
// thing. None of them remember a "no" — declining stores nothing, so the card is back on the
// next load. Toji removes them the moment they land, before they are painted.
//
// A promo is recognised by the one thing it cannot do without: a call to action that links
// to a browser download. Never by the sites' minified class names, which churn with every
// deploy. A search result that merely links to a browser's download page is left alone —
// it sits in the page's normal flow, whereas a promo floats (position fixed or absolute),
// is a dialog, or is labelled as a promo by the site itself. Nothing that holds a form or
// navigation is ever removed, so a floating page header that happens to carry a promo
// loses only the promo.
//
// The file is both a module and a session preload (see installGuestFixups in main.cjs). A
// sandboxed preload cannot require() a sibling file, so the page-side code has to live in
// the file that is registered; the pure parts are exported for tests.

/** Hosts whose promos are handled — each exactly, or any subdomain of it. */
const HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'duckduckgo.com', 'bing.com', 'search.brave.com', 'startpage.com', 'ecosia.org'];
// Google's search hosts come one per country: google.com, google.co.uk, google.de…
const GOOGLE_HOST = /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/;

/** Is this page one where promos are removed? */
function isWatchedHost(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname;
    return GOOGLE_HOST.test(host) || HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Where the "Yes" / "Download" of a switch-browser promo points. */
const DOWNLOAD_LINK = [
  'a[href*="google.com/chrome"]',
  'a[href*="duckduckgo.com/mac"]',
  'a[href*="duckduckgo.com/windows"]',
  'a[href*="duckduckgo.com/app"]',
  'a[href*="duckduckgo.com/browser"]',
  'a[href*="microsoft.com/edge"]',
  'a[href*="brave.com/download"]',
  'a[href*="mozilla.org/firefox"]'
].join(', ');

/** The store's card, for locales where its link is missing: the English heading. */
const STORE_HEADING = /switch to (google )?chrome\?/i;

// A promo is a small thing. Anything with more links or text than this is page content
// that happens to contain a download link, and stays.
const MAX_LINKS = 12;
const MAX_TEXT = 800;
/** Site furniture a promo never contains; an ancestor holding any of it is not the promo. */
const FURNITURE = 'form, input, select, textarea, nav, main, [role="search"], [role="navigation"], [role="main"]';
/** How sites label their own promos. */
const PROMO_LABEL = /promo|upsell|callout|nag\b|banner|notification|interstitial/i;

const isSmall = (el) => el.querySelectorAll('a').length <= MAX_LINKS && (el.textContent || '').length <= MAX_TEXT;
const isLabelled = (el) => PROMO_LABEL.test(`${el.id} ${el.getAttribute('class') || ''} ${el.getAttribute('data-testid') || ''}`);
function isFloating(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (!view) return false;
  const position = view.getComputedStyle(el).position;
  return position === 'fixed' || position === 'absolute' || position === 'sticky';
}
const isDialog = (el) => el.getAttribute('role') === 'dialog' || el.tagName === 'DIALOG';

/**
 * The promo an element belongs to: the outermost of its small ancestors (itself included)
 * that floats, is a dialog or is labelled as a promo, and holds no site furniture. Null
 * when the element is just part of the page.
 */
function promoContaining(start) {
  const doc = start.ownerDocument;
  let found = null;
  for (let el = start; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    if (el.nodeType !== 1) continue;
    if (!isSmall(el)) break; // ancestors only get bigger
    if (el.querySelector(FURNITURE)) break;
    if (isDialog(el) || isFloating(el) || isLabelled(el)) found = el;
  }
  return found;
}

/** Every switch-browser promo in `root` (a document or an element), outermost first. */
function findBrowserPromos(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const promos = new Set();
  const links = Array.from(root.querySelectorAll(DOWNLOAD_LINK));
  if (root.nodeType === 1 && root.matches(DOWNLOAD_LINK)) links.unshift(root);
  for (const link of links) {
    const promo = promoContaining(link.parentElement || link);
    if (promo) promos.add(promo);
  }
  const dialogs = Array.from(root.querySelectorAll('[role="dialog"], dialog'));
  if (root.nodeType === 1 && isDialog(root)) dialogs.unshift(root);
  for (const dialog of dialogs) {
    if (STORE_HEADING.test(dialog.textContent || '') && isSmall(dialog) && !dialog.querySelector(FURNITURE)) promos.add(dialog);
  }
  // A promo inside a promo goes with its parent.
  return Array.from(promos).filter((promo) => !Array.from(promos).some((other) => other !== promo && other.contains(promo)));
}

/** Remove every promo in `root`; returns how many went. */
function removeBrowserPromos(root) {
  const promos = findBrowserPromos(root);
  for (const promo of promos) promo.remove();
  return promos.length;
}

/**
 * Watch a document and remove every promo as it lands. Sweeps once for anything already
 * there, then again after every batch of DOM changes: these are single-page apps, so a
 * promo is re-created on client-side navigation, and some mount an empty shell and fill
 * it a moment later. Mutation observers run before the browser paints, so a promo is gone
 * before anyone could see it; a sweep is one selector query over the document, cheap
 * enough to run on every batch. Returns a function that stops watching.
 */
function watchBrowserPromos(doc) {
  removeBrowserPromos(doc);
  const observer = new MutationObserver(() => removeBrowserPromos(doc));
  // Observing the document node itself works before <html> exists, which is when a preload runs.
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });
  return () => observer.disconnect();
}

if (typeof module === 'object' && module) {
  module.exports = { isWatchedHost, findBrowserPromos, removeBrowserPromos, watchBrowserPromos };
}

// As a preload: runs at document-start in every guest frame, and acts only on the hosts above.
if (typeof document !== 'undefined' && typeof location !== 'undefined' && isWatchedHost(location.href)) {
  watchBrowserPromos(document);
}
