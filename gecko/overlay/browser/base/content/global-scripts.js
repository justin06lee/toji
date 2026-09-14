/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji (gecko/overlay): the scripts every top-level window shares. Toji's
// window stand-ins (chrome://toji/content/window/stubs.js) come first: they
// define the few window globals the engine's scripts still name — gURLBar,
// FirefoxViewHandler, SidebarController and the like — whose Firefox
// implementations are gone from the tree.

// prettier-ignore
// eslint-disable-next-line no-lone-blocks
{
  Services.scriptloader.loadSubScript("chrome://toji/content/window/stubs.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/browser.js", this);
  Services.scriptloader.loadSubScript("chrome://global/content/globalOverlay.js", this);
  Services.scriptloader.loadSubScript("chrome://global/content/editMenuOverlay.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/utilityOverlay.js", this);
  Services.scriptloader.loadSubScript("chrome://browser/content/browser-sets.js", this);
  if (AppConstants.platform == "macosx") {
    Services.scriptloader.loadSubScript("chrome://global/content/macWindowMenu.js", this);
  }
}
