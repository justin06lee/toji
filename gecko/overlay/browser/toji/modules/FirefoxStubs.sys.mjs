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
  init() {},
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
  isTaskbarTabWindow() {
    return false;
  },
};

export const TaskbarTabs = {
  getTaskbarTab() {
    return Promise.reject(new Error("no taskbar tabs"));
  },
  findOrCreateTaskbarTab() {
    return Promise.reject(new Error("no taskbar tabs"));
  },
  moveTabIntoTaskbarTab() {
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
  // Returns [trimmed, strippedPrefix], as the URL bar's helper did.
  stripPrefixAndTrim(spec, options = {}) {
    let str = String(spec ?? "");
    let prefix = "";
    const m = str.match(/^(https?:\/\/)/i);
    if (m && ((options.stripHttp && m[1].toLowerCase() === "http://") || (options.stripHttps && m[1].toLowerCase() === "https://"))) {
      prefix = m[1];
      str = str.slice(prefix.length);
    }
    if (options.stripWww && /^www\./i.test(str)) {
      prefix += str.slice(0, 4);
      str = str.slice(4);
    }
    if (options.trimEmptyQuery) str = str.replace(/\?$/, "");
    if (options.trimEmptyHash) str = str.replace(/#$/, "");
    if (options.trimSlash) str = str.replace(/\/$/, "");
    if (options.trimTrailingDot) str = str.replace(/\.$/, "");
    return [str, prefix];
  },
  addToUrlbarHistory() {},
  getURLBarForFocus(win) {
    return win.gURLBar;
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
  getOpenTabUrls() {
    return new Map();
  },
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
  summarizeCurrentPage() {},
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
  async createShareableLinkFromBookmarkFolders() {
    return null;
  },
};

export const AIWindow = {
  isDefaultWindow: false,
  isEnabled: false,
  newTabURL: "about:blank",
  isAIWindowActiveAndEnabled() {
    return false;
  },
  // The window opener passes its options through here and takes the args back.
  handleAIWindowOptions({ args = null } = {}) {
    return args;
  },
  toggleAIWindow() {},
  recordOpenWindowTelemetry() {},
  initialStartupURL: "about:blank",
  shouldOpenAsSmartWindow() {
    return false;
  },
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

export const AIWindowAccountAuth = {
  hasToSConsent: false,
};

// The URL bar's suggestion service (the FirefoxSuggest enterprise policy waits on it).
export const QuickSuggest = {
  initPromise: Promise.resolve(),
};

export const ChatStore = {
  async deleteConversationsByDateRange() {},
  async deleteAllConversations() {},
};

// The search UI's OpenSearch discovery: a page's offered engine is ignored.
export const OpenSearchManager = {
  addEngine() {},
};

// Reader mode's actor: the tabs extension API registers for its button updates.
export const AboutReaderParent = {
  addMessageListener() {},
  removeMessageListener() {},
};

// The toolbar customization framework's widget list and panel views (devtools
// registers its toolbar button and the profiler popup through them).
export const CustomizableWidgets = [];
export const PanelMultiView = {
  getViewNode() {
    return null;
  },
  openPopup() {
    return Promise.resolve(false);
  },
  hidePopup() {},
};

// Multiple profiles: Toji has its own containers instead.
export const SelectableProfileService = {
  initialized: false,
  isEnabled: false,
  currentProfile: { name: "" },
};

// The new tab page's startup cache (its message is never sent: about:home is Toji's).
export const AboutHomeStartupCacheChild = {
  init() {},
};

// Onboarding's messages (the terms-of-use notice toolkit's telemetry policy looks up).
export const OnboardingMessageProvider = {
  getPreonboardingMessages() {
    return [];
  },
  async getMessages() {
    return [];
  },
};

// Firefox's usage telemetry: nothing is recorded.
export const BrowserUsageTelemetry = {
  Policy: {},
  recordWidgetChange() {},
  reportProfileCount() {},
  async reportInstallationTelemetry() {},
};
