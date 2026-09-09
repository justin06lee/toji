'use strict';

// The Chrome Web Store greets every browser that isn't Chrome with a "Switch to Chrome?"
// card — "Google recommends using Chrome when using extensions and themes", No thanks / Yes.
// Declining stores nothing (no cookie, no local storage), so the card is back on the very
// next page load. Toji installs from the store perfectly well, so the card is pure noise:
// this removes it the moment it lands, before it is ever painted.
//
// It is removed rather than declined through its own button: "No thanks" keeps no state
// worth updating, and pressing it the instant the card lands trips the store's ripple
// effect, which sizes itself from a button that has not been laid out yet and logs a
// warning on every load. Taking the node out leaves the page exactly as "No thanks" would.
//
// The file is both a module and a session preload (see installGuestFixups in main.cjs). A
// sandboxed preload cannot require() a sibling file, so the page-side code has to live in
// the file that is registered; the pure parts are exported for tests.

const STORE_HOST = 'chromewebstore.google.com';

/** Only the store itself — never a look-alike host or a page that merely links to it. */
function isChromeWebStore(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return false;
    if (url.hostname === STORE_HOST) return true;
    // The pre-2024 address still answers; it redirects, but its first document can render.
    return url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore');
  } catch {
    return false;
  }
}

// The card's "Yes" is a link to download Chrome. The store's class names and jsnames are
// minified and churn with every deploy, so recognise the card by the one thing that cannot
// change without changing the card itself. The English heading is a second, locale-bound tell.
const CHROME_DOWNLOAD_LINK = 'a[href*="google.com/chrome"]';
const HEADING = /switch to (google )?chrome\?/i;

/** Is this element the "Switch to Chrome?" card? */
function isSwitchToChromePrompt(el) {
  if (!el || el.nodeType !== 1 || el.getAttribute('role') !== 'dialog') return false;
  if (el.querySelector(CHROME_DOWNLOAD_LINK)) return true;
  return HEADING.test(el.textContent || '');
}

/**
 * Every "Switch to Chrome?" card in or around `root`: the document, or a node that was
 * just added — which may be the card, something inside the card (the store can mount the
 * shell first and fill it a moment later), or an ancestor of it.
 */
function findSwitchToChromePrompts(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const candidates = Array.from(root.querySelectorAll('[role="dialog"]'));
  if (typeof root.closest === 'function') {
    const enclosing = root.closest('[role="dialog"]');
    if (enclosing) candidates.unshift(enclosing);
  }
  return candidates.filter(isSwitchToChromePrompt);
}

/** Remove every card in or around `root`; returns how many went. */
function removeSwitchToChromePrompts(root) {
  const prompts = findSwitchToChromePrompts(root);
  for (const prompt of prompts) prompt.remove();
  return prompts.length;
}

/**
 * Watch a document and remove every card as it lands. Sweeps once for a card that is
 * already there, then observes additions: the store is a single-page app, so the card is
 * re-created on client-side navigation, not only on load. Mutation observers run before
 * the browser paints, so the card is gone before anyone could see it. Returns a function
 * that stops watching.
 */
function watchSwitchToChromePrompt(doc) {
  removeSwitchToChromePrompts(doc);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') removeSwitchToChromePrompts(record.target);
      for (const node of record.addedNodes) if (node.nodeType === 1) removeSwitchToChromePrompts(node);
    }
  });
  // Observing the document node itself works before <html> exists, which is when a preload runs.
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });
  return () => observer.disconnect();
}

if (typeof module === 'object' && module) {
  module.exports = { isChromeWebStore, isSwitchToChromePrompt, findSwitchToChromePrompts, removeSwitchToChromePrompts, watchSwitchToChromePrompt };
}

// As a preload: runs at document-start in every guest frame, and acts only on the store.
if (typeof document !== 'undefined' && typeof location !== 'undefined' && isChromeWebStore(location.href)) {
  watchSwitchToChromePrompt(document);
}
