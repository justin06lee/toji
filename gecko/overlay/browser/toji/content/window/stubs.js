/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's window stand-ins. Firefox's URL bar, sidebar, Firefox View, Sync,
// the stop/reload button and the add-ons toolbar are deleted from the tree;
// the engine's remaining scripts (tabbrowser, session restore, full screen,
// the context menu, add-on installs) still name these objects in a few
// places. Each one here answers "nothing there": no element, no state, no
// work. Toji's shell replaces gURLBar's focus and select with its omnibox
// (TojiShell.sys.mjs).

/* eslint-disable no-unused-vars */

// The address bar. Per-browser state (which the tab model keeps for focus
// bookkeeping) lives in a WeakMap; the value is what the page's own address is.
var gURLBar = {
  _states: new WeakMap(),
  value: "",
  untrimmedValue: "",
  focused: false,
  readOnly: false,
  inputField: null,
  controller: { addListener() {}, removeListener() {} },
  editor: { clearUndoRedo() {} },
  view: { isOpen: false, close() {} },
  style: {},
  searchMode: null,
  searchModeSwitcher: null,
  getBrowserState(browser) {
    let state = this._states.get(browser);
    if (!state) {
      state = {};
      this._states.set(browser, state);
    }
    return state;
  },
  getAttribute() {
    return null;
  },
  setAttribute() {},
  removeAttribute() {},
  hasAttribute() {
    return false;
  },
  querySelector() {
    return null;
  },
  select() {},
  focus() {},
  blur() {},
  setURI() {},
  handleRevert() {},
  formatValue() {},
  makeURIReadable(uri) {
    return uri;
  },
  search() {},
  setSearchMode() {},
  getSearchMode() {
    return null;
  },
  maybeHandleRevertFromPopup() {},
  saveSelectionStateForBrowser() {},
  restoreSelectionStateForBrowser() {},
  afterTabSwitchFocusChange() {},
  addGBrowserListeners() {},
  initPlaceHolder() {},
  delayedStartupInit() {},
};

var FirefoxViewHandler = {
  tab: null,
  button: null,
  init() {},
  uninit() {},
  openTab() {},
};

var SidebarController = {
  initialized: false,
  isOpen: false,
  currentID: "",
  browser: null,
  sidebarMain: null,
  _positionStart: true,
  promiseInitialized: Promise.resolve(),
  expandOnHoverComplete: Promise.resolve(),
  init() {},
  uninit() {},
  toggle() {},
  show() {},
  hide() {},
  startDelayedLoad() {},
  updateShortcut() {},
  getUIState() {
    return null;
  },
  markSessionRestoreStateReceived() {},
  updateUIState() {},
  updatePinnedTabsHeightOnResize() {},
  getMouseTargetRect() {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  },
  onMouseEnter() {},
  onMouseLeave() {},
};

var CombinedStopReload = {
  ensureInitialized() {
    return false;
  },
  uninit() {},
  switchToStop() {},
  switchToReload() {},
  onTabSwitch() {},
};

var gSync = {
  init() {},
  uninit() {},
  updateContentContextMenu() {
    return false;
  },
  populateSendTabToDevicesMenu() {},
  _resetSendTabExposureTracking() {},
};

var gUnifiedExtensions = {
  init() {},
  uninit() {},
  button: null,
  browserActionFor() {
    return null;
  },
  getPopupAnchorID() {
    return null;
  },
  openPanel() {},
  updateContextMenu() {},
};

var PanelUI = {
  panel: { state: "closed" },
  mainView: { addEventListener() {}, removeEventListener() {} },
  overflowPanel: { state: "closed" },
  init() {},
  uninit() {},
  hide() {},
  updateNotifications() {},
};

var BookmarkingUI = {
  toolbar: null,
  star: null,
  init() {},
  uninit() {},
  onLocationChange() {},
  updateEmptyToolbarMessage() {},
  isOnNewTabPage() {
    return false;
  },
};

var PlacesToolbarHelper = { init() {}, uninit() {} };

// ⌘D and the Bookmark command: TojiShell puts the page on the shell's bar.
var PlacesCommandHook = {
  async bookmarkPage() {},
  async bookmarkTabs() {},
  searchBookmarks() {},
  searchHistory() {},
};

var gCustomizeMode = { enter() {}, exit() {} };
var CustomizationHandler = {
  isCustomizing() {
    return false;
  },
  isEnteringCustomizeMode: false,
  isExitingCustomizeMode: false,
};

var gProtectionsHandler = {
  init() {},
  uninit() {},
  onStateChange() {},
  onContentBlockingEvent() {},
  onLocationChange() {},
};
var gTrustPanelHandler = {
  init() {},
  uninit() {},
  onContentBlockingEvent() {},
  updateIdentity() {},
};
var gIdentityHandler = {
  pointerlockFsWarningClassName: "unknownIdentity",
  refreshIdentityBlock() {},
  updateIdentity() {},
  observe() {},
};
var gPermissionPanel = { updateSharingIndicator() {}, onLocationChange() {} };

var DownloadsButton = { init() {}, uninit() {}, initializeIndicator() {} };
var gBrowserThumbnails = { init() {}, uninit() {} };
var ctrlTab = { prefName: "browser.ctrlTab.sortByRecentlyUsed", readPref() {}, uninit() {}, observe() {} };
var gTabsPanel = { showAllTabsPanel() {}, hideAllTabsPanel() {}, showHiddenTabsPanel() {} };
var FullPageTranslationsPanel = { handleEvent() {}, onLocationChange() {}, open() {} };
var SelectTranslationsPanel = { open() {}, getLangPairPromise() { return Promise.resolve(null); } };
var gProfiles = { init() {}, handleCommand() {}, onPopupShowing() {}, populateMoveTabMenu() {} };
var ToolbarKeyboardNavigator = { init() {}, uninit() {} };
var BrowserPageActions = { init() {}, onLocationChange() {} };
