/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Toji's own pages — Settings, Welcome, Plans and the new tab page — are React
// builds shipped as chrome://toji/content/pages/*.html and shown under about:
// addresses registered here, in the parent process (like about:preferences).
// The pages reach the browser only through window.toji, which the TojiPage
// JSWindowActor provides; TojiPageAPI below is everything it can ask for.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  // Services.search is gone in Firefox 153; the service is this module now.
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  ShellService: "moz-src:///browser/components/shell/ShellService.sys.mjs",
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
  TojiAsk: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiImport: "resource:///modules/toji/TojiImport.sys.mjs",
  TojiTor: "resource:///modules/toji/TojiTor.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
});

const PAGE_BASE = "chrome://toji/content/pages/";
export const START_PAGE = "about:start";

/** about:<name> -> the built page. */
const PAGES = {
  settings: "settings.html",
  welcome: "welcome.html",
  plans: "plans.html",
  start: "start.html",
  report: "report.html",
};

// Parent process only; no URI_SAFE_FOR_UNTRUSTED_CONTENT, so web pages can't
// link to them and they carry the chrome page's (system) principal.
const ABOUT_FLAGS =
  Ci.nsIAboutModule.ALLOW_SCRIPT |
  Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT |
  Ci.nsIAboutModule.IS_SECURE_CHROME_UI;

class AboutPage {
  constructor(file) {
    this.file = file;
  }
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);
  newChannel(uri, loadInfo) {
    const target = Services.io.newURI(PAGE_BASE + this.file);
    const channel = Services.io.newChannelFromURIWithLoadInfo(target, loadInfo);
    channel.originalURI = uri;
    return channel;
  }
  getURIFlags() {
    return ABOUT_FLAGS;
  }
  getChromeURI() {
    return Services.io.newURI(PAGE_BASE + this.file);
  }
}

function registerAboutPages() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  for (const [name, file] of Object.entries(PAGES)) {
    const page = new AboutPage(file);
    const cid = Components.ID(Services.uuid.generateUUID().toString());
    registrar.registerFactory(
      cid,
      `Toji about:${name}`,
      `@mozilla.org/network/protocol/about;1?what=${name}`,
      {
        QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
        createInstance(iid) {
          return page.QueryInterface(iid);
        },
      }
    );
  }
}

function registerActors() {
  ChromeUtils.registerWindowActor("TojiPage", {
    parent: { esModuleURI: "resource:///modules/toji/actors/TojiPageParent.sys.mjs" },
    child: {
      esModuleURI: "resource:///modules/toji/actors/TojiPageChild.sys.mjs",
      events: { DOMDocElementInserted: { capture: true } },
    },
    matches: Object.keys(PAGES).map(name => `about:${name}*`),
  });
}

// --- Settings the pages can read and change ---------------------------------

const PREF_THEME = "toji.theme";
const PREF_LAYOUT = "toji.layout";
const PREF_BOOKMARKS_BAR = "browser.toolbars.bookmarks.visibility";
const PREF_VAULT_AUTOSAVE = "toji.vault.autosave";
const PREF_REPLAY = "toji.replay";
const PREF_ADBLOCK = "toji.adblock";
const UBLOCK_ID = "uBlock0@raymondhill.net";

async function readSettings() {
  let engines = [];
  let current = "";
  try {
    await lazy.SearchService.init();
    // getIconURL() is async; a pending Promise can't cross to the page.
    engines = await Promise.all(
      (await lazy.SearchService.getVisibleEngines()).map(async e => ({
        name: e.name,
        icon: (await e.getIconURL?.()) ?? undefined,
      }))
    );
    current = (await lazy.SearchService.getDefault())?.name ?? "";
  } catch (e) {
    console.error("[toji:pages] search engines", e);
  }
  return {
    theme: Services.prefs.getStringPref(PREF_THEME, "light") === "dark" ? "dark" : "light",
    layout: Services.prefs.getStringPref(PREF_LAYOUT, "top") === "side" ? "side" : "top",
    // Pinned unless set to show on hover, as in the Electron app (Firefox's own
    // default for this pref is "newtab").
    bookmarksBar:
      Services.prefs.getStringPref(PREF_BOOKMARKS_BAR, "always") === "never"
        ? "hover"
        : "pinned",
    searchEngine: current,
    searchEngines: engines,
    vaultAutosave: Services.prefs.getBoolPref(PREF_VAULT_AUTOSAVE, true),
    replay: Services.prefs.getBoolPref(PREF_REPLAY, true),
    adblock: Services.prefs.getBoolPref(PREF_ADBLOCK, true),
  };
}

async function writeSetting(key, value) {
  switch (key) {
    case "theme":
      Services.prefs.setStringPref(PREF_THEME, value === "dark" ? "dark" : "light");
      break;
    case "layout":
      Services.prefs.setStringPref(PREF_LAYOUT, value === "side" ? "side" : "top");
      break;
    case "bookmarksBar":
      Services.prefs.setStringPref(PREF_BOOKMARKS_BAR, value === "pinned" ? "always" : "never");
      break;
    case "searchEngine": {
      const engine = lazy.SearchService.getEngineByName(String(value));
      if (engine) {
        await lazy.SearchService.setDefault(engine, lazy.SearchService.CHANGE_REASON.USER);
      }
      break;
    }
    case "vaultAutosave":
      Services.prefs.setBoolPref(PREF_VAULT_AUTOSAVE, !!value);
      break;
    case "replay":
      Services.prefs.setBoolPref(PREF_REPLAY, !!value);
      break;
    case "adblock": {
      Services.prefs.setBoolPref(PREF_ADBLOCK, !!value);
      const addon = await lazy.AddonManager.getAddonByID(UBLOCK_ID);
      if (addon) {
        await (value ? addon.enable() : addon.disable());
      }
      break;
    }
    default:
      throw new Error(`unknown setting ${key}`);
  }
  const settings = await readSettings();
  TojiPageEvents.emit("settings", settings);
  return settings;
}

/** Settings for chrome code (the window's shell), through the same setter as the pages. */
export const TojiSettings = {
  read: readSettings,
  write: writeSetting,
};

// --- Events pushed to open pages --------------------------------------------

export const TojiPageEvents = {
  /** topic -> Set<TojiPageParent> */
  subscribers: new Map(),
  subscribe(topic, actor) {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic).add(actor);
  },
  unsubscribeAll(actor) {
    for (const set of this.subscribers.values()) {
      set.delete(actor);
    }
  },
  emit(topic, payload) {
    for (const actor of this.subscribers.get(topic) ?? []) {
      try {
        actor.sendAsyncMessage("event", { topic, payload });
      } catch {
        this.unsubscribeAll(actor);
      }
    }
  },
};

// --- The API ------------------------------------------------------------------

function windowOf(actor) {
  return actor.browsingContext?.topChromeWindow ?? null;
}

/** Page names allowed through openPage. */
const OPENABLE = new Set(["settings", "welcome", "plans"]);

export const TojiPageAPI = {
  platform() {
    return Services.appinfo.OS === "Darwin" ? "darwin" : Services.appinfo.OS.toLowerCase();
  },

  server() {
    // Starts the server if it isn't up yet. A page opened right after launch
    // (Welcome, Plans) must outwait the sidecar's start, not give up on it.
    return lazy.TojiAgentServer.whenReady(30000);
  },

  /** Shift+Enter or the wand on a page: an AI answer page in this tab. */
  askAI([query], actor) {
    return lazy.TojiAsk.ask(actor.browsingContext?.top.embedderElement, query);
  },

  /** The start page's search box: a URL loads, anything else searches. */
  navigate([input], actor) {
    const text = String(input ?? "").trim();
    const browser = actor.browsingContext?.top.embedderElement;
    if (!text || !browser) {
      return;
    }
    browser.fixupAndLoadURIString(text, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  containers() {
    return lazy.TojiContainers.list();
  },

  saveContainers([list]) {
    return lazy.TojiContainers.replaceAll(list);
  },

  clearContainer([id]) {
    return lazy.TojiContainers.clear(String(id));
  },

  windowContainer(_args, actor) {
    const win = windowOf(actor);
    return win ? lazy.TojiWindows.containerOf(win) : null;
  },

  settings() {
    return readSettings();
  },

  setSetting([key, value]) {
    return writeSetting(key, value);
  },

  openTab([url, options], actor) {
    const win = windowOf(actor);
    const uri = Services.io.newURI(String(url));
    if (!["http", "https"].includes(uri.scheme)) {
      throw new Error("only web addresses can be opened from Toji's pages");
    }
    win?.gBrowser.addTrustedTab(uri.spec, {
      inBackground: !!options?.background,
      relatedToCurrent: true,
    });
  },

  openPage([page, options], actor) {
    if (!OPENABLE.has(page)) {
      throw new Error(`unknown page ${page}`);
    }
    const win = windowOf(actor);
    const url = options?.query ? `about:${page}?q=${encodeURIComponent(options.query)}` : `about:${page}`;
    if (options?.replace && actor.browsingContext) {
      actor.browsingContext.top.embedderElement?.loadURI(Services.io.newURI(url), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    }
    win?.gBrowser.addTrustedTab(url, { relatedToCurrent: true });
  },

  openAddons(_args, actor) {
    windowOf(actor)?.BrowserAddonUI?.openAddonsMgr("addons://list/extension");
  },

  finishOnboarding(_args, actor) {
    Services.prefs.setBoolPref("toji.onboarded", true);
    actor.browsingContext?.top.embedderElement?.loadURI(Services.io.newURI(START_PAGE), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  // --- Bug reports ----------------------------------------------------------

  bugReportAccount([options]) {
    return lazy.TojiBugReport.account({ refresh: !!options?.refresh });
  },

  /** The window still taken when the report opened (then forgotten). */
  async captureWindow(_args, actor) {
    const win = windowOf(actor);
    const shot = win ? await lazy.TojiWindows.takeReportScreenshot(win) : null;
    return shot ?? (win ? lazy.TojiBugReport.captureWindow(win) : null);
  },

  /** The last 15 seconds, frozen when the report was opened, or null. */
  async replayClip(_args, actor) {
    const win = windowOf(actor);
    return win ? (await lazy.TojiWindows.takeReportClip(win)) ?? null : null;
  },

  /** Settings' "Report a bug…": the same as Help › Report a Bug…. */
  openReport(_args, actor) {
    const win = windowOf(actor);
    if (win) {
      lazy.TojiWindows.openBugReport(win);
    }
  },

  submitBugReport([draft], actor) {
    return lazy.TojiBugReport.submit(windowOf(actor), draft);
  },

  attachBugReport([reportId]) {
    return lazy.TojiBugReport.attach(String(reportId));
  },

  revealBugReport([reportId]) {
    return lazy.TojiBugReport.reveal(String(reportId));
  },

  /** Closes the report tab (the sheet's "Done"). */
  closeReport(_args, actor) {
    const win = windowOf(actor);
    const tab = win?.gBrowser.getTabForBrowser(actor.browsingContext?.top.embedderElement);
    if (tab) {
      win.gBrowser.removeTab(tab);
    }
  },

  // --- Default browser (Firefox's shell service; macOS asks the user) ------

  isDefaultBrowser() {
    try {
      return lazy.ShellService.isDefaultBrowser(false, false);
    } catch {
      return false;
    }
  },

  async setDefaultBrowser() {
    try {
      await lazy.ShellService.setDefaultBrowser(false);
    } catch (e) {
      console.error("[toji:pages] set default browser", e);
    }
    // macOS shows its own confirmation; poll briefly for the answer.
    for (let i = 0; i < 100; i++) {
      if (lazy.ShellService.isDefaultBrowser(false, false)) {
        return true;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  },

  // --- Imports: bookmarks into Places, passwords straight into the vault -----

  importBrowsers() {
    return lazy.TojiImport.detect();
  },

  importBrowser([options]) {
    return lazy.TojiImport.importBrowser({
      browser: String(options?.browser ?? ""),
      profile: String(options?.profile ?? "Default"),
      containerId: options?.containerId ? String(options.containerId) : null,
    });
  },

  importBookmarksFile(_args, actor) {
    return lazy.TojiImport.importBookmarksFile(windowOf(actor));
  },

  importPasswordsFile([containerId], actor) {
    return lazy.TojiImport.importPasswordsFile(windowOf(actor), containerId ?? null);
  },

  openFullDiskAccess() {
    lazy.TojiImport.openFullDiskAccess();
  },

  // --- Vault: metadata only; nothing here returns a password ---------------

  vaultStatus() {
    return lazy.TojiVault.status();
  },

  async vaultList([containerId]) {
    try {
      return { ok: true, value: await lazy.TojiVault.list(containerId ?? null) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async vaultDelete([id]) {
    try {
      return { ok: true, value: await lazy.TojiVault.remove(String(id)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async vaultSave([draft]) {
    try {
      return { ok: true, value: await lazy.TojiVault.save(draft) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  vaultGenerate([length]) {
    return lazy.TojiVault.generate(length);
  },

  torStatus() {
    return lazy.TojiTor.status;
  },

  torStart() {
    return lazy.TojiTor.start();
  },

  torStop() {
    return lazy.TojiTor.stop();
  },

  torNewCircuit() {
    return lazy.TojiTor.newCircuit();
  },

  /** Calls a method by name; anything not defined here is refused. */
  async call(name, args, actor) {
    if (name === "call" || !Object.hasOwn(this, name) || typeof this[name] !== "function") {
      throw new Error(`window.toji.${name} is not available`);
    }
    return this[name](Array.isArray(args) ? args : [], actor);
  },
};

let initialized = false;

export const TojiPages = {
  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    registerAboutPages();
    registerActors();
    // New tabs and new windows open Toji's start page, private windows too.
    lazy.AboutNewTab.newTabURL = START_PAGE;
    Services.obs.addObserver(() => {
      TojiPageEvents.emit("containers", lazy.TojiContainers.list());
    }, "toji-containers-changed");
    lazy.TojiTor.onStatus(status => TojiPageEvents.emit("tor", status));
  },
};
