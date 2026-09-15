/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's AboutNewTab (gecko/overlay): only the new-tab address. Firefox's new
// tab page (Activity Stream) is deleted from the tree; Toji's start page is set
// here by TojiPages (about:start), which the engine's code — tabbrowser,
// session restore, the WebExtension APIs — reads through this module as before.

const ABOUT_URL = "about:newtab";

export const AboutNewTab = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  _newTabURL: ABOUT_URL,
  _newTabURLOverridden: false,
  initialized: false,
  willNotifyUser: false,

  init() {
    this.initialized = true;
  },

  get newTabURL() {
    return this._newTabURL;
  },

  set newTabURL(aNewTabURL) {
    let newTabURL = String(aNewTabURL ?? "").trim();
    if (newTabURL === ABOUT_URL) {
      this.resetNewTabURL();
      return;
    } else if (newTabURL === "") {
      newTabURL = "about:blank";
    }
    this._newTabURL = newTabURL;
    this._newTabURLOverridden = true;
    this.notifyChange();
  },

  get newTabURLOverridden() {
    return this._newTabURLOverridden;
  },

  get activityStreamEnabled() {
    return false;
  },

  resetNewTabURL() {
    this._newTabURLOverridden = false;
    this._newTabURL = ABOUT_URL;
    this.notifyChange();
  },

  notifyChange() {
    Services.obs.notifyObservers(null, "newtab-url-changed", this._newTabURL);
  },

  uninit() {
    this.initialized = false;
  },

  getTopSites() {
    return [];
  },

  noteNonDefaultStartup() {},
  maybeRecordTopsitesPainted() {},
  observe() {},
};
