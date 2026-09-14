/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's module stand-ins. The tab model and the window's scripts lazily import
// a handful of modules that are deleted with Firefox's UI — its messaging
// system, the URL bar's helpers, the new tab page's sponsor tracking, taskbar
// tabs, the AI window, tab notes, AI grouping, page actions, the home page.
// The imports point here instead (gecko/patches), and every export answers as
// if the feature were absent. Nothing here is ever shown.

export const ASRouter = {
  initialized: false,
  state: { messages: [], messageImpressions: {} },
  waitForInitialized: Promise.resolve(),
  sendTriggerMessage() {},
};

export const SponsorProtection = {
  isProtectedBrowser() {
    return false;
  },
  addProtectedBrowser() {},
  removeProtectedBrowser() {},
};

export const TaskbarTabsUtils = {
  getTaskbarTabIdFromWindow() {
    return null;
  },
};

export const TaskbarTabs = {
  getTaskbarTab() {
    return Promise.reject(new Error("no taskbar tabs"));
  },
};

export const UrlbarUtils = {
  RESULT_TYPE: {},
  RESULT_SOURCE: {},
  async getShortcutOrURIAndPostData(url) {
    return { url, postData: null, mayInheritPrincipal: true };
  },
  stripUnsafeProtocolOnPaste(text) {
    return String(text ?? "").replace(/^\s*(javascript|data):/i, "");
  },
};

export const UrlbarPrefs = {
  get() {
    return false;
  },
  getScotchBonnetPref() {
    return false;
  },
};

export const UrlbarProviderOpenTabs = {
  registerOpenTab() {},
  unregisterOpenTab() {},
};

export class SmartTabGroupingManager {
  async smartTabGroupingForGroup() {
    return [];
  }
  async getSuggestedTabsForGroup() {
    return [];
  }
}

export const GenAI = {
  buildTabMenu() {},
  buildAskChatMenu() {},
};

export const TabNotes = {
  TELEMETRY_SOURCE: {},
  isEligible() {
    return false;
  },
  async has() {
    return false;
  },
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
};

export const ContentSharingUtils = {
  isEnabled: false,
  handleShareTabs() {},
};

export const AIWindow = {
  isDefaultWindow: false,
  newTabURL: "about:blank",
  isAIWindowActive() {
    return false;
  },
  isAIWindowContentPage() {
    return false;
  },
  isAIWindowEnabled() {
    return false;
  },
  isOpeningAIWindow() {
    return false;
  },
  launchWindow() {},
  updateImmersiveView() {},
  appMenu() {},
};

export const PageActions = {
  sendPlacedInUrlbarTrigger() {},
};

// The home page is the start page: Toji has no separate home page setting.
export const HomePage = {
  get(win) {
    return win?.BROWSER_NEW_TAB_URL ?? "about:blank";
  },
  getForErrorPage(win) {
    return this.get(win);
  },
  getDefault() {
    return "about:blank";
  },
  isDefault() {
    return true;
  },
  async shouldIgnore() {
    return false;
  },
  set() {},
  reset() {},
  get overridden() {
    return false;
  },
  get locked() {
    return false;
  },
};

export const LaterRun = {
  ENABLE_REASON_NEW_PROFILE: 1,
  ENABLE_REASON_UPDATE_APPLIED: 2,
  enable() {},
  getURL() {
    return "";
  },
};
