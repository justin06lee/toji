/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji (gecko/overlay): the browser window's own scripts — its initialization
// and the engine's tab model. Firefox's sidebar, URL bar, page actions and
// toolbar scripts are gone from the tree.

// prettier-ignore
// eslint-disable-next-line no-lone-blocks
{
  Services.scriptloader.loadSubScript("chrome://browser/content/browser-init.js", this);
  Services.scriptloader.loadSubScript("chrome://global/content/contentAreaUtils.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/browser-customtitlebar.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/drag-and-drop.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/split-view-footer.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/tab.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/tabbrowser.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/tabgroup.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/tabs.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/tabbrowser/tabsplitview.js", this);
}

window.onload = gBrowserInit.onLoad.bind(gBrowserInit);
window.onunload = gBrowserInit.onUnload.bind(gBrowserInit);
window.onclose = WindowIsClosing;

window.addEventListener(
  "MozBeforeInitialXULLayout",
  gBrowserInit.onBeforeInitialXULLayout.bind(gBrowserInit),
  { once: true }
);

// The listener of DOMContentLoaded must be set on window, rather than
// document, because the window can go away before the event is fired.
// In that case, we don't want to initialize anything, otherwise we
// may be leaking things because they will never be destroyed after.
window.addEventListener(
  "DOMContentLoaded",
  gBrowserInit.onDOMContentLoaded.bind(gBrowserInit),
  { once: true }
);
