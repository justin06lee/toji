/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The rest of Firefox's UI. The shell replaces the window's chrome (TojiShell); what
// is left is native — the macOS menu bar, the page's right-click menu — or Firefox's
// panels that would open over the page (downloads, the status bubble, close-tabs
// warnings). Menus keep only what the Electron app's had, and the prefs keep the
// panels from opening.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "nsContextMenu", () => {
  try {
    return ChromeUtils.importESModule("chrome://browser/content/nsContextMenu.sys.mjs").nsContextMenu;
  } catch (e) {
    console.error("[toji:firefox-ui] context menu module", e);
    return null;
  }
});

// Default values (a user can still change them in about:config).
const BOOL_DEFAULTS = {
  // The link-hover URL bubble: the Electron app had none.
  "browser.tabs.hideStatusPanel": true,
  // Downloads: the Save dialog (as in the Electron app), never Firefox's panel.
  "browser.download.useDownloadDir": false,
  "browser.download.alwaysOpenPanel": false,
  "browser.download.panel.shown": true,
  "browser.download.always_ask_before_handling_new_types": false,
  // No Firefox dialogs asking whether to close tabs or quit.
  "browser.tabs.warnOnClose": false,
  "browser.tabs.warnOnCloseOtherTabs": false,
  "browser.warnOnQuit": false,
  "browser.warnOnQuitShortcut": false,
  // macOS's own print dialog, not Firefox's print preview.
  "print.prefer_system_dialog": true,
  // Panels that would hang from the hidden address bar.
  "browser.translations.automaticallyPopup": false,
  "browser.translations.enable": false,
  "browser.shopping.experience2023.enabled": false,
  "browser.tabs.hoverPreview.enabled": false,
  "browser.tabs.groups.smart.enabled": false,
  "sidebar.revamp": false,
  "sidebar.verticalTabs": false,
};
const INT_DEFAULTS = {
  // Content drawn up into the title bar; the shell's header is the title bar.
  "browser.tabs.inTitlebar": 1,
};

// The macOS menu bar, as the Electron app's: File, Edit, View, Window, Help.
const HIDDEN_MENUS = ["history-menu", "bookmarksMenu", "profiles-menu", "tools-menu"];
// Items that sit in hidden-by-default spots but feed the application menu (About,
// Settings, Services, Hide, Quit): never touched.
const APP_MENU_ITEMS = new Set([
  "aboutName",
  "menu_FileQuitItem",
  "menu_preferences",
  "menu_settings",
  "menu_mac_services",
  "menu_mac_hide_app",
  "menu_mac_hide_others",
  "menu_mac_show_all",
  "menu_mac_touch_bar",
]);
// Each kept menu: the items to keep, in order; null is a separator.
const MENUS = {
  menu_FilePopup: ["menu_newNavigator", "menu_newPrivateWindow", null, "menu_newNavigatorTab", "menu_close", null, "menu_closeWindow"],
  menu_EditPopup: ["menu_undo", "menu_redo", null, "menu_cut", "menu_copy", "menu_paste", "menu_delete", null, "menu_selectAll"],
  menu_viewPopup: ["viewFullZoomMenu", null, "enterFullScreenItem", "exitFullScreenItem", "fullScreenItem"],
  menu_HelpPopup: ["toji-report-bug"],
};

// The page's right-click menu: Firefox's items the Electron app's menu had no
// counterpart for (context-menu.cjs).
const HIDDEN_CONTEXT_ITEMS = [
  "context-bookmarkpage",
  "context-openlinkincontainertab",
  "context-openlinkinsplitview",
  "context-openlinkinusercontext-menu",
  "context-openlink",
  "context-openlinkprivate",
  "context-openlinksmartwindow",
  "context-previewlink",
  "context-bookmarklink",
  "context-stripOnShareLink",
  "context-sendlinktodevice",
  "context-sep-sendlinktodevice",
  "context-media-play",
  "context-media-pause",
  "context-media-mute",
  "context-media-unmute",
  "context-media-playbackrate",
  "context-media-loop",
  "context-leave-dom-fullscreen",
  "context-video-fullscreen",
  "context-media-hidecontrols",
  "context-media-showcontrols",
  "context-viewvideo",
  "context-video-pictureinpicture",
  "context-video-saveimage",
  "context-reloadimage",
  "context-sendimage",
  "context-sendvideo",
  "context-sendaudio",
  "context-imagetext",
  "context-viewimageinfo",
  "context-viewimagedesc",
  "context-visual-search",
  "context-setDesktopBackground",
  "fill-login",
  "fill-login-generated-password",
  "use-relay-mask",
  "manage-saved-logins",
  "passwordmgr-items-separator",
  "context-reveal-password",
  "context-copy-link-to-highlight",
  "context-copy-clean-link-to-highlight",
  "context-remove-highlight",
  "context-take-screenshot",
  "context-add-engine",
  "context-searchselect-private",
  "context-translate-selection",
  "context-ask-chat",
  "frame",
  "frame-sep",
  "context-bidi-text-direction-toggle",
  "context-bidi-page-direction-toggle",
  "context-viewpartialsource-selection",
  "context-inspect-a11y",
  "context-sendpagetodevice",
  "context-media-eme-learnmore",
];
// Toji's ad blocker is uBlock Origin; the Electron app's blocker had no menu items.
const HIDDEN_CONTEXT_PREFIXES = ["ublock0_raymondhill_net-menuitem"];

// Shortcuts that open Firefox's own panels, windows and sidebars; they do nothing.
const REMOVED_KEYS = [
  "viewBookmarksSidebarKb",
  "viewBookmarksToolbarKb",
  "toggleSidebarKb",
  "viewGenaiChatSidebarKb",
  "viewOpenTabsSidebarKb",
  "key_gotoHistory",
  "manBookmarkKb",
  "key_openDownloads",
  "key_openAddons",
  "key_viewInfo",
  "key_screenshot",
  "key_toggleReaderMode",
  "key_find",
  "key_findAgain",
  "key_findPrevious",
  "key_undoCloseWindow",
];

/** Firefox's content prompts in Toji's look (their frame is in toji.css). */
function registerPromptSheet() {
  const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const uri = Services.io.newURI("chrome://toji/content/prompts.css");
  if (!sss.sheetRegistered(uri, sss.USER_SHEET)) {
    sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
  }
}

function setDefaults() {
  const branch = Services.prefs.getDefaultBranch("");
  for (const [name, value] of Object.entries(BOOL_DEFAULTS)) {
    if (!Services.prefs.prefIsLocked(name)) {
      branch.setBoolPref(name, value);
    }
  }
  for (const [name, value] of Object.entries(INT_DEFAULTS)) {
    if (!Services.prefs.prefIsLocked(name)) {
      branch.setIntPref(name, value);
    }
  }
}

/** Separators only between visible items: none first, none last, none doubled. */
export function tidySeparators(popup) {
  let previousVisible = null;
  let lastSeparator = null;
  for (const item of popup.children) {
    if (item.localName === "menuseparator") {
      const show = !!previousVisible && previousVisible.localName !== "menuseparator";
      item.hidden = !show;
      if (show) {
        previousVisible = item;
        lastSeparator = item;
      }
      continue;
    }
    if (!item.hidden && item.localName !== "template") {
      previousVisible = item;
      lastSeparator = null;
    }
  }
  if (lastSeparator && previousVisible === lastSeparator) {
    lastSeparator.hidden = true;
  }
}

function trimMenubar(win) {
  const doc = win.document;
  for (const id of HIDDEN_MENUS) {
    doc.getElementById(id)?.setAttribute("hidden", "true");
  }
  for (const [popupId, order] of Object.entries(MENUS)) {
    const popup = doc.getElementById(popupId);
    if (!popup) {
      continue;
    }
    const arrange = () => {
      for (const item of popup.children) {
        if (!APP_MENU_ITEMS.has(item.id)) {
          item.setAttribute("hidden", "true");
        }
      }
      for (const id of order) {
        let item;
        if (id === null) {
          item = doc.createXULElement("menuseparator");
          item.className = "toji-menu-separator";
        } else {
          item = doc.getElementById(id);
          if (!item) {
            continue;
          }
          // Firefox shows one of the full-screen items at a time.
          if (!/FullScreen/.test(id)) {
            item.removeAttribute("hidden");
          }
        }
        popup.append(item);
      }
    };
    arrange();
    // Firefox unhides some items as it goes; the menu is put back each time it opens.
    popup.addEventListener("popupshowing", e => {
      if (e.target !== popup) {
        return;
      }
      for (const sep of popup.querySelectorAll(":scope > .toji-menu-separator")) {
        sep.remove();
      }
      arrange();
    });
  }
}

function trimKeys(win) {
  const doc = win.document;
  const keyset = doc.getElementById("mainKeyset");
  if (!keyset) {
    return;
  }
  // Emptied rather than removed: Firefox's code still looks some of them up by id.
  for (const id of REMOVED_KEYS) {
    const key = doc.getElementById(id);
    if (key) {
      for (const attr of ["key", "keycode", "command", "oncommand"]) {
        key.removeAttribute(attr);
      }
      key.setAttribute("disabled", "true");
    }
  }
  // ⌘⇧N opens a private window, as in the Electron app (Firefox's is ⌘⇧P).
  const privateKey = doc.getElementById("key_privatebrowsing");
  if (privateKey) {
    privateKey.removeAttribute("data-l10n-id");
    privateKey.setAttribute("key", "N");
    privateKey.setAttribute("modifiers", "accel,shift");
  }
  // A keyset reads its keys when it is inserted; put it back so the changes take.
  const parent = keyset.parentNode;
  const next = keyset.nextSibling;
  keyset.remove();
  parent.insertBefore(keyset, next);
}

let contextMenuPatched = false;

function patchContextMenu() {
  if (contextMenuPatched) {
    return;
  }
  const ContextMenu = lazy.nsContextMenu;
  if (!ContextMenu?.prototype?.initItems) {
    return;
  }
  contextMenuPatched = true;
  const initItems = ContextMenu.prototype.initItems;
  ContextMenu.prototype.initItems = function (...args) {
    const result = initItems.apply(this, args);
    try {
      const doc = this.browser?.ownerDocument ?? this.document;
      const popup = doc?.getElementById("contentAreaContextMenu");
      for (const id of HIDDEN_CONTEXT_ITEMS) {
        const item = doc?.getElementById(id);
        if (item) {
          item.hidden = true;
        }
      }
      if (popup) {
        for (const item of popup.querySelectorAll(HIDDEN_CONTEXT_PREFIXES.map(p => `[id^="${p}"]`).join(","))) {
          item.hidden = true;
        }
        // Select All belongs to text fields, as in Chromium's menu.
        const selectAll = doc.getElementById("context-selectall");
        if (selectAll && !this.onEditable) {
          selectAll.hidden = true;
        }
        // Print…, on the page itself (Firefox has it only in the File menu).
        const plainPage = !this.onLink && !this.onImage && !this.onVideo && !this.onAudio && !this.onEditable && !this.isTextSelected;
        let print = doc.getElementById("toji-context-print");
        if (!print) {
          print = doc.createXULElement("menuitem");
          print.id = "toji-context-print";
          print.setAttribute("label", "Print…");
          print.addEventListener("command", () => {
            const win = doc.defaultView;
            win.PrintUtils?.startPrintWindow?.(win.gBrowser.selectedBrowser.browsingContext);
          });
          doc.getElementById("context-savepage")?.after(print);
        }
        print.hidden = !plainPage;
        tidySeparators(popup);
        for (const group of popup.querySelectorAll("menugroup")) {
          tidySeparators(group);
        }
      }
    } catch (e) {
      console.error("[toji:firefox-ui] context menu", e);
    }
    return result;
  };
}

export const TojiFirefoxUI = {
  /** Once, at startup. */
  init() {
    setDefaults();
    try {
      registerPromptSheet();
    } catch (e) {
      console.error("[toji:firefox-ui] prompt stylesheet", e);
    }
  },

  /** Each browser window, once its document is there. */
  initWindow(win) {
    for (const [name, fn] of [
      ["menu bar", trimMenubar],
      ["keys", trimKeys],
    ]) {
      try {
        fn(win);
      } catch (e) {
        console.error(`[toji:firefox-ui] ${name}`, e);
      }
    }
    try {
      patchContextMenu();
    } catch (e) {
      console.error("[toji:firefox-ui] context menu", e);
    }
  },
};

