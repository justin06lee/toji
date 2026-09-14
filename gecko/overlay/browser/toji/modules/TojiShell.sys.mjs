/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Every browser window's UI is Toji's own. The shell (apps/renderer/gecko) is the
// Electron app's tab strip, address bar, bookmarks bar, sidebar and overlays, drawn by
// React in a shadow root that covers the window; Firefox's chrome — tabs toolbar, nav
// bar, bookmarks toolbar, sidebar, status panel — is hidden (toji.css). gBrowser still
// owns the tabs, their pages, history and the session: the pages are laid out in the
// box the shell's viewport reports, underneath it, and the shell draws the tabs from
// what this module tells it.
//
// Per window this module is two objects the shell reads:
//   window.tojiShell  the shell's view of the window (apps/renderer/gecko/shellHost.ts)
//   window.toji       the bridge Toji's pages use too (settings, containers, Tor, the
//                     vault's answers, bug reports), through the same TojiPageAPI.
// Both live in the chrome window, which no web page can reach.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  TojiAgent: "resource:///modules/toji/TojiAgent.sys.mjs",
  TojiAsk: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiFirefoxUI: "resource:///modules/toji/TojiFirefoxUI.sys.mjs",
  TojiPageAPI: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiSettings: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiTor: "resource:///modules/toji/TojiTor.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SHELL = "chrome://toji/content/shell/";
const ANCHOR_ID = "toji-prompt-anchor";
// Tab groups are the window's own, as in the Electron app, and kept with the session so
// a duplicated, reopened or restored tab keeps its group: the list on the window, each
// tab's group on the tab.
const GROUPS_KEY = "toji-groups";
const TAB_GROUP_KEY = "toji-group";
let groupCounter = 0;

/** The shell's own look, and the prefs it is kept in. */
const PREFS = {
  theme: "toji.theme",
  layout: "toji.layout",
  bookmarksBar: "browser.toolbars.bookmarks.visibility",
  sidebarOpen: "toji.sidebar.open",
};

function readPrefs() {
  const p = Services.prefs;
  return {
    theme: p.getStringPref(PREFS.theme, "light") === "dark" ? "dark" : "light",
    layout: p.getStringPref(PREFS.layout, "top") === "side" ? "side" : "top",
    bookmarksBar: p.getStringPref(PREFS.bookmarksBar, "always") === "never" ? "hover" : "pinned",
    sidebarOpen: p.getBoolPref(PREFS.sidebarOpen, true),
  };
}

const ERROR_PAGE = /^about:(neterror|certerror|blocked|httpsonlyerror)\b/;

function systemPrincipal() {
  return Services.scriptSecurityManager.getSystemPrincipal();
}

class Emitter {
  #listeners = new Set();
  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(...args) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(...args);
      } catch (e) {
        console.error("[toji:shell]", e);
      }
    }
  }
}

/** window -> Host */
const hosts = new WeakMap();

/** Changes that concern every window: prefs, containers, bookmarks. */
const everyWindow = {
  started: false,
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    const prefsChanged = () => {
      const prefs = readPrefs();
      for (const host of this.hosts()) {
        host.events.prefs.emit(prefs);
      }
    };
    for (const pref of Object.values(PREFS)) {
      Services.prefs.addObserver(pref, prefsChanged);
    }
    Services.obs.addObserver(() => {
      const list = lazy.TojiContainers.list();
      for (const host of this.hosts()) {
        host.events.containers.emit(list);
        host.scheduleFlush();
      }
    }, "toji-containers-changed");
    const PlacesUtils = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
    PlacesUtils.observers.addListener(
      ["bookmark-added", "bookmark-removed", "bookmark-moved", "bookmark-title-changed", "bookmark-url-changed"],
      () => {
        for (const host of this.hosts()) {
          host.events.bookmarks.emit();
        }
      }
    );
  },
  *hosts() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const host = hosts.get(win);
      if (host) {
        yield host;
      }
    }
  },
};

class Host {
  constructor(win) {
    this.win = win;
    this.ids = new WeakMap();
    this.tabsById = new Map();
    this.next = 0;
    this.flushScheduled = false;
    // Tabs in a throwaway identity of their own (Reset context) -> that identity's id.
    this.throwaway = new Map();
    // New tabs whose switch leaves the keyboard where the shell put it.
    this.keepFocus = new WeakSet();
    this.events = {
      state: new Emitter(),
      prefs: new Emitter(),
      containers: new Emitter(),
      focus: new Emitter(),
      topEdge: new Emitter(),
      bookmarks: new Emitter(),
      vaultMatches: new Emitter(),
      vaultPrompt: new Emitter(),
      agent: new Emitter(),
      agentPointer: new Emitter(),
      spotlight: new Emitter(),
      report: new Emitter(),
      reportTray: new Emitter(),
      cursor: new Emitter(),
    };
  }

  get gBrowser() {
    return this.win.gBrowser;
  }

  // --- Tabs -------------------------------------------------------------------

  idOf(tab) {
    let id = this.ids.get(tab);
    if (!id) {
      id = `tab-${++this.next}`;
      this.ids.set(tab, id);
    }
    this.tabsById.set(id, tab);
    return id;
  }

  tab(id) {
    const tab = this.tabsById.get(id);
    return tab && !tab.closing && tab.isConnected ? tab : null;
  }

  browserOf(id) {
    return this.tab(id)?.linkedBrowser ?? null;
  }

  tabOfBrowser(browser) {
    return browser ? this.gBrowser.getTabForBrowser(browser) : null;
  }

  info(tab, groups = null) {
    const browser = tab.linkedBrowser;
    const pending = tab.hasAttribute("pending");
    let url = browser?.currentURI?.spec ?? "";
    let title = browser?.contentTitle ?? "";
    // A tab session restore hasn't loaded yet has no page; the session knows its own.
    if (pending) {
      const store = this.win.SessionStore;
      url = (url && url !== "about:blank" ? url : store?.getLazyTabValue?.(tab, "url")) || url;
      title = title || store?.getLazyTabValue?.(tab, "title") || tab.label || "";
    }
    // A tab with no browser in the window yet (restored, or moved by hold-to-Tor, and not
    // chosen since) answers its address and title from the session; asking it for its
    // history or document would create its browser, waking every such tab at once.
    const live = !!browser?.isConnected;
    if (!live && !title) {
      title = tab.label || "";
    }
    const documentURI = live ? browser.documentURI?.spec ?? "" : "";
    let canBack = false;
    let canForward = false;
    if (live) {
      try {
        canBack = !!browser.canGoBack;
        canForward = !!browser.canGoForward;
      } catch {}
    }
    const groupId = this.groupOf(tab);
    return {
      id: this.idOf(tab),
      url,
      title,
      favicon: tab.getAttribute("image") || "",
      busy: tab.hasAttribute("busy"),
      audible: tab.hasAttribute("soundplaying"),
      muted: tab.hasAttribute("muted"),
      canBack,
      canForward,
      errorPage: ERROR_PAGE.test(documentURI) ? documentURI : null,
      crashed: tab.hasAttribute("crashed"),
      groupId: groupId && (!groups || groups.has(groupId)) ? groupId : null,
      throwaway: this.throwaway.has(tab),
    };
  }

  state() {
    const tabs = this.gBrowser.tabs.filter(t => !t.closing && !t.hidden);
    const selected = this.gBrowser.selectedTab;
    const containerId = lazy.TojiWindows.containerOf(this.win);
    // The window's own container, a hold-to-Tor identity included (the list has only
    // the profiles).
    const container = containerId ? lazy.TojiContainers.byId(containerId) : null;
    const groups = this.groupList();
    const known = new Set(groups.map(g => g.id));
    return {
      containerId,
      container: container ? { ...container } : null,
      tabs: tabs.map(t => this.info(t, known)),
      selectedId: selected ? this.idOf(selected) : null,
      groups,
      // A popup a page opened (window.open with a size): just the page, as the Electron
      // app's popups were.
      popup: !this.win.toolbar.visible,
    };
  }

  /** Coalesces a burst of tab events into one update for the shell. */
  scheduleFlush() {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    Promise.resolve().then(() => {
      this.flushScheduled = false;
      if (!this.win.closed) {
        this.events.state.emit(this.state());
      }
    });
  }

  /** A start page at the end of the strip, in front; the omnibox takes the keys unless told not to. */
  newTab({ focusOmnibox = true } = {}) {
    const tab = this.gBrowser.addTrustedTab(this.win.BROWSER_NEW_TAB_URL, { focusUrlBar: focusOmnibox });
    if (focusOmnibox) {
      this.win.gURLBar.getBrowserState(tab.linkedBrowser).urlbarFocused = true;
    } else {
      // Something of the shell's (the agent spotlight) takes the keys: the page doesn't.
      this.keepFocus.add(tab.linkedBrowser);
    }
    this.gBrowser.selectedTab = tab;
    return this.idOf(tab);
  }

  reorder(ids) {
    // The shell counts the tabs it shows; Firefox counts every tab (hidden and pinned
    // ones too), so each goes where the shown tab at its position is.
    ids.forEach((id, index) => {
      const tab = this.tab(id);
      const at = (this.gBrowser.visibleTabs ?? this.gBrowser.tabs)[index];
      if (tab && at && at !== tab) {
        this.gBrowser.moveTabTo(tab, { tabIndex: at._tPos, isUserTriggered: true });
      }
    });
  }

  /**
   * The tab again in a throwaway identity of its own — no cookies, storage or cache
   * from before — in its place and group, with the same id in the shell (the Electron
   * app's Reset context). A Tor window's gets a circuit of its own. The identity is
   * wiped when the tab or its window closes.
   */
  resetContext(id) {
    const tab = this.tab(id);
    const base = lazy.TojiContainers.byId(lazy.TojiWindows.containerOf(this.win) ?? "");
    if (!tab || !base) {
      return;
    }
    const temp = lazy.TojiContainers.createTemporary(base, { egress: base.egress, kind: "reset" });
    const url = tab.linkedBrowser?.currentURI?.spec || this.win.BROWSER_NEW_TAB_URL;
    const fresh = this.gBrowser.addTrustedTab(url, {
      tabIndex: tab._tPos + 1,
      inBackground: !tab.selected,
      userContextId: temp.userContextId,
      tojiOwnContext: true,
    });
    this.throwaway.set(fresh, temp.id);
    this.ids.set(fresh, id);
    this.tabsById.set(id, fresh);
    const group = this.groupOf(tab);
    if (group) {
      this.setGroupOf(fresh, group);
    }
    if (tab.selected) {
      this.gBrowser.selectedTab = fresh;
    }
    this.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
  }

  // --- Tab groups ---------------------------------------------------------------------

  groupList() {
    try {
      const list = JSON.parse(lazy.SessionStore.getCustomWindowValue(this.win, GROUPS_KEY) || "[]");
      return Array.isArray(list)
        ? list.filter(g => g && typeof g.id === "string").map(g => ({ id: g.id, name: String(g.name ?? ""), collapsed: !!g.collapsed }))
        : [];
    } catch {
      return [];
    }
  }

  writeGroups(list) {
    try {
      lazy.SessionStore.setCustomWindowValue(this.win, GROUPS_KEY, JSON.stringify(list));
    } catch (e) {
      console.error("[toji:shell] groups", e);
    }
    this.scheduleFlush();
  }

  groupOf(tab) {
    try {
      return lazy.SessionStore.getCustomTabValue(tab, TAB_GROUP_KEY) || null;
    } catch {
      return null;
    }
  }

  setGroupOf(tab, groupId) {
    try {
      if (groupId) {
        lazy.SessionStore.setCustomTabValue(tab, TAB_GROUP_KEY, String(groupId));
      } else {
        lazy.SessionStore.deleteCustomTabValue(tab, TAB_GROUP_KEY);
      }
    } catch (e) {
      console.error("[toji:shell] tab group", e);
    }
    this.scheduleFlush();
  }

  /** A group left with no tabs goes, as in the Electron app (`leaving` is on its way out). */
  pruneGroups(leaving = null) {
    const list = this.groupList();
    const used = new Set(
      this.gBrowser.tabs.filter(t => t !== leaving && !t.closing).map(t => this.groupOf(t)).filter(Boolean)
    );
    const kept = list.filter(g => used.has(g.id));
    if (kept.length !== list.length) {
      this.writeGroups(kept);
    }
  }

  createGroup(tabIds) {
    const list = this.groupList();
    const id = `grp-${Date.now()}-${++groupCounter}`;
    this.writeGroups([...list, { id, name: `Group ${list.length + 1}`, collapsed: false }]);
    for (const tabId of tabIds) {
      const tab = this.tab(tabId);
      if (tab) {
        this.setGroupOf(tab, id);
      }
    }
    return id;
  }

  duplicate(id) {
    const tab = this.tab(id);
    if (!tab) {
      return;
    }
    const copy = this.gBrowser.duplicateTab(tab, true);
    this.gBrowser.moveTabTo(copy, { tabIndex: tab._tPos + 1 });
    this.gBrowser.selectedTab = copy;
  }

  load(id, url) {
    const browser = this.browserOf(id);
    if (!browser) {
      return;
    }
    browser.fixupAndLoadURIString(String(url), { triggeringPrincipal: systemPrincipal() });
    this.focusContentIfSelected(browser);
  }

  /** The default engine (the private one in private windows) for text the omnibox says is no address. */
  search(id, text) {
    const browser = this.browserOf(id);
    if (!browser) {
      return "";
    }
    try {
      const isPrivate = this.win.PrivateBrowsingUtils.isWindowPrivate(this.win);
      const engine = isPrivate ? lazy.SearchService.defaultPrivateEngine : lazy.SearchService.defaultEngine;
      const submission = engine.getSubmission(String(text));
      browser.loadURI(submission.uri, {
        triggeringPrincipal: systemPrincipal(),
        postData: submission.postData,
      });
      this.focusContentIfSelected(browser);
      return submission.uri.spec;
    } catch (e) {
      // The search service isn't ready yet: Firefox's own fixup searches with it.
      console.error("[toji:shell] search", e);
      browser.fixupAndLoadURIString(String(text), { triggeringPrincipal: systemPrincipal() });
      return String(text);
    }
  }

  focusContentIfSelected(browser) {
    if (this.gBrowser.selectedBrowser === browser) {
      browser.focus();
    }
  }

  reload(id) {
    const tab = this.tab(id);
    if (!tab) {
      return;
    }
    if (tab.hasAttribute("crashed")) {
      this.win.SessionStore.reviveCrashedTab(tab);
    } else {
      // An answer page reloads as a fresh answer, as in the Electron app.
      if (tab.linkedBrowser?.currentURI?.schemeIs("toji")) {
        lazy.TojiAsk.markFresh(tab.linkedBrowser);
      }
      this.gBrowser.reloadTab(tab);
    }
  }

  openPage(page) {
    const url = `about:${page}`;
    const existing = this.gBrowser.tabs.find(
      t => !t.closing && (t.linkedBrowser?.currentURI?.spec ?? "").split(/[?#]/)[0] === url
    );
    this.gBrowser.selectedTab = existing ?? this.gBrowser.addTrustedTab(url);
  }

  openTab(url, options = {}) {
    const tab = this.gBrowser.addTrustedTab(String(url), {
      inBackground: !!options.background,
      relatedToCurrent: true,
    });
    // Opened from the tab in front (a source, a bookmark): it joins that tab's group.
    const group = this.groupOf(this.gBrowser.selectedTab);
    if (group && tab !== this.gBrowser.selectedTab) {
      this.setGroupOf(tab, group);
    }
    if (!options.background) {
      this.gBrowser.selectedTab = tab;
    }
  }

  // --- Bookmarks: the bookmarks toolbar, flattened, as the Electron app's bar was -----

  async bookmarks() {
    const P = this.win.PlacesUtils;
    const tree = await P.promiseBookmarksTree(P.bookmarks.toolbarGuid);
    const out = [];
    const walk = node => {
      for (const child of node?.children ?? []) {
        if (child.uri) {
          out.push({
            id: child.guid,
            title: child.title ?? "",
            url: child.uri,
            addedAt: new Date((child.dateAdded ?? 0) / 1000).toISOString(),
          });
        } else if (child.children) {
          walk(child);
        }
      }
    };
    walk(tree);
    return out;
  }

  async toggleBookmark(url, title) {
    const P = this.win.PlacesUtils;
    const onBar = (await this.bookmarks()).filter(b => b.url === url);
    if (onBar.length) {
      await P.bookmarks.remove(onBar.map(b => b.id));
    } else {
      await P.bookmarks.insert({ parentGuid: P.bookmarks.toolbarGuid, url, title: String(title ?? "") });
    }
  }

  // --- The window -----------------------------------------------------------------

  setViewport(rect) {
    const style = this.win.document.documentElement.style;
    style.setProperty("--toji-view-x", `${rect.x}px`);
    style.setProperty("--toji-view-y", `${rect.y}px`);
    style.setProperty("--toji-view-width", `${rect.width}px`);
    style.setProperty("--toji-view-height", `${rect.height}px`);
  }

  setPromptAnchor(rect) {
    const anchor = this.win.document.getElementById(ANCHOR_ID);
    if (anchor) {
      anchor.style.left = `${rect.x}px`;
      anchor.style.top = `${rect.y}px`;
      anchor.style.width = `${Math.max(1, rect.width)}px`;
      anchor.style.height = `${Math.max(1, rect.height)}px`;
    }
  }

  /** The object the shell sees as window.tojiShell. */
  api() {
    const host = this;
    const tab = id => host.tab(id);
    return {
      platform: lazy.TojiPageAPI.platform(),
      state: () => host.state(),
      onState: l => host.events.state.on(l),
      select(id) {
        const t = tab(id);
        if (t) {
          host.gBrowser.selectedTab = t;
        }
      },
      close(id) {
        const t = tab(id);
        if (t) {
          host.gBrowser.removeTab(t, { animate: false });
        }
      },
      newTab: options => host.newTab(options),
      reorder: ids => host.reorder(Array.from(ids ?? [])),
      duplicate: id => host.duplicate(id),
      closeOthers(id) {
        const t = tab(id);
        if (t) {
          host.gBrowser.removeAllTabsBut(t, { animate: false });
        }
      },
      load: (id, url) => host.load(id, url),
      search: (id, text) => host.search(id, text),
      ask(id, query, fresh = false) {
        const browser = host.browserOf(id);
        if (browser) {
          lazy.TojiAsk.ask(browser, query, { fresh: !!fresh }).catch(e => console.error("[toji:shell] ask", e));
          host.focusContentIfSelected(browser);
        }
      },
      back: () => host.win.BrowserCommands.back(),
      forward: () => host.win.BrowserCommands.forward(),
      reload: id => host.reload(id),
      toggleMute: id => tab(id)?.toggleMuteAudio(),
      openPage: page => {
        if (["settings", "welcome", "plans"].includes(page)) {
          host.openPage(page);
        }
      },
      openTab: (url, options) => host.openTab(url, options),
      focusContent: () => host.gBrowser.selectedBrowser?.focus(),

      setViewport: rect => host.setViewport(rect),
      setPromptAnchor: rect => host.setPromptAnchor(rect),
      onFocusOmnibox: l => host.events.focus.on(l),
      resetContext: id => host.resetContext(id),
      createGroup: ids => host.createGroup(Array.from(ids ?? [], String)),
      renameGroup(groupId, name) {
        host.writeGroups(host.groupList().map(g => (g.id === groupId ? { ...g, name: String(name) } : g)));
      },
      toggleGroup(groupId) {
        host.writeGroups(host.groupList().map(g => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)));
      },
      removeGroup(groupId) {
        for (const t of host.gBrowser.tabs) {
          if (host.groupOf(t) === groupId) {
            host.setGroupOf(t, null);
          }
        }
        host.writeGroups(host.groupList().filter(g => g.id !== groupId));
      },
      setTabGroup(tabId, groupId) {
        const t = tab(tabId);
        if (t) {
          host.setGroupOf(t, groupId && host.groupList().some(g => g.id === groupId) ? groupId : null);
          host.pruneGroups();
        }
      },
      chooseContainer: id => lazy.TojiWindows.choose(host.win, String(id)),
      toggleTor: () => lazy.TojiWindows.toggleTor(host.win),
      prefs: () => readPrefs(),
      onPrefs: l => host.events.prefs.on(l),
      setPref(key, value) {
        if (key === "sidebarOpen") {
          Services.prefs.setBoolPref(PREFS.sidebarOpen, !!value);
        } else if (key in PREFS) {
          // Through Settings' own setter, so an open Settings page follows.
          lazy.TojiSettings.write(key, value).catch(e => console.error("[toji:shell] setting", key, e));
        }
      },
      containers: () => lazy.TojiContainers.list(),
      onContainers: l => host.events.containers.on(l),
      onPageTopEdge: l => host.events.topEdge.on(l),

      bookmarks: () => host.bookmarks(),
      onBookmarksChanged: l => host.events.bookmarks.on(l),
      toggleBookmark: (url, title) => host.toggleBookmark(url, title),
      removeBookmark: id => host.win.PlacesUtils.bookmarks.remove(String(id)).then(() => {}),

      onVaultMatches: l => host.events.vaultMatches.on(l),
      onVaultPrompt: l => host.events.vaultPrompt.on(l),
      vaultFill(id, entryId) {
        const browser = host.browserOf(id);
        if (browser) {
          lazy.TojiVault.fill(browser, String(entryId)).catch(e => console.error("[toji:shell] fill", e));
        }
      },

      agentState: id => lazy.TojiAgent.stateOf(tab(id)),
      onAgent: l => host.events.agent.on(l),
      onAgentPointer: l => host.events.agentPointer.on(l),
      onSpotlight: l => host.events.spotlight.on(l),
      agentSubmit: (id, text) => (tab(id) ? lazy.TojiAgent.submit(tab(id), String(text)) : "busy"),
      agentStop: id => tab(id) && lazy.TojiAgent.stop(tab(id)),
      agentAddFiles: (id, files) => (tab(id) ? lazy.TojiAgent.addFiles(tab(id), Array.from(files ?? [])) : Promise.resolve()),
      agentRemoveFile: (id, index) => tab(id) && lazy.TojiAgent.removeFile(tab(id), index),
      agentLimits: () => ({
        maxSteps: Services.prefs.getIntPref("toji.agent.maxSteps", 40),
        noLimit: Services.prefs.getBoolPref("toji.agent.noLimit", false),
      }),
      setAgentLimits({ maxSteps, noLimit }) {
        Services.prefs.setIntPref("toji.agent.maxSteps", Math.max(1, Math.round(Number(maxSteps) || 40)));
        Services.prefs.setBoolPref("toji.agent.noLimit", !!noLimit);
      },

      onReportBug: l => host.events.report.on(l),
      reportClosed() {},
      onReportTray: l => host.events.reportTray.on(l),
      retryReportTray: id => lazy.TojiBugReport.retryTray(host.win, String(id)),
      dismissReportTray: id => lazy.TojiBugReport.dismissTray(host.win, String(id)),
    };
  }

  /** window.toji for the shell: Toji's page API, as a page in this window's front tab would get it. */
  bridge() {
    const host = this;
    // TojiPageAPI's methods take their arguments as an array and the calling actor,
    // from which they read the window and the page's browser.
    const actor = {
      get browsingContext() {
        return {
          topChromeWindow: host.win,
          get top() {
            return { embedderElement: host.gBrowser.selectedBrowser };
          },
        };
      },
    };
    const call = (name, ...args) => lazy.TojiPageAPI.call(name, args, actor);
    const byBrowserId = id => host.gBrowser.browsers.find(b => b.browserId === id) ?? null;
    return {
      platform: lazy.TojiPageAPI.platform(),
      server: () => call("server"),
      containers: () => call("containers"),
      saveContainers: list => call("saveContainers", list),
      onContainersChanged: cb => host.events.containers.on(cb),
      windowContainer: () => call("windowContainer"),
      settings: () => call("settings"),
      setSetting: (key, value) => call("setSetting", key, value),
      openPage: (page, options) => call("openPage", page, options),
      clearContainer: id => call("clearContainer", id),
      torStatus: () => call("torStatus"),
      torStart: () => call("torStart"),
      torStop: () => call("torStop"),
      torNewCircuit: () => call("torNewCircuit"),
      onTorStatus(cb) {
        const off = lazy.TojiTor.onStatus(cb);
        return typeof off === "function" ? off : () => {};
      },
      vaultStatus: () => call("vaultStatus"),
      async vaultCommit(browserId) {
        const browser = byBrowserId(browserId);
        const saved = browser ? await lazy.TojiVault.commit(browser) : false;
        return saved ? { ok: true, value: true } : { ok: false, error: "The password could not be saved." };
      },
      async vaultDismiss(browserId) {
        const browser = byBrowserId(browserId);
        if (browser) {
          lazy.TojiVault.dismiss(browser);
        }
        return true;
      },
      bugReportAccount: options => call("bugReportAccount", options),
      submitBugReport: draft => call("submitBugReport", draft),
      revealBugReport: id => call("revealBugReport", id),
      onWindowCursor: cb => host.events.cursor.on(cb),
    };
  }

  // --- Firefox's own paths into the address bar and the bookmark star ----------------

  hookFirefox() {
    const win = this.win;
    const doc = win.document;
    const focusOmnibox = select => this.events.focus.emit(select);
    // The address bar Firefox focuses (⌘L, a new tab, a new window) is the shell's.
    const urlbar = win.gURLBar;
    if (urlbar) {
      urlbar.select = () => focusOmnibox(true);
      urlbar.focus = () => focusOmnibox(false);
      urlbar.restoreSelectionStateForBrowser = () => focusOmnibox(true);
      try {
        if (urlbar.view) {
          urlbar.view.autoOpen = () => false;
        }
      } catch {}
    }
    // After a tab switch Firefox gives the keys to the tab's page, or to its address
    // bar if that had them (a new tab's does). Firefox's own path to its address bar
    // waits for the bar to be updated first, and gives up if focus moved meanwhile;
    // the shell's omnibox needs neither, so it takes the keys as soon as the switch ends.
    const adjustFocus = win.gBrowser._adjustFocusAfterTabSwitch;
    const keepFocus = this.keepFocus;
    win.gBrowser._adjustFocusAfterTabSwitch = function (newTab) {
      const browser = this.getBrowserForTab(newTab);
      if (keepFocus.delete(browser)) {
        return;
      }
      if (!browser.hasAttribute("tabDialogShowing") && win.gURLBar.getBrowserState(browser).urlbarFocused) {
        focusOmnibox(true);
        return;
      }
      adjustFocus.call(this, newTab);
    };
    // Focus the window gets with nothing in it went to Firefox's (hidden) urlbar.
    doc.documentElement.removeAttribute("retargetdocumentfocus");
    // ⌘D bookmarks the page in front on the shell's bar, as the star does.
    if (win.PlacesCommandHook) {
      win.PlacesCommandHook.bookmarkPage = async () => {
        const browser = win.gBrowser.selectedBrowser;
        const url = browser?.currentURI?.spec ?? "";
        if (/^https?:/.test(url)) {
          await this.toggleBookmark(url, browser.contentTitle || url);
        }
      };
    }
    // Settings (⌘,, the app menu, a prompt's "Manage settings") are Toji's.
    win.openPreferences = () => this.openPage("settings");
    // ⌘R on an answer page asks again, as the shell's reload button does.
    const reloadWithFlags = win.gBrowser.reloadWithFlags;
    win.gBrowser.reloadWithFlags = function (...args) {
      for (const tab of this.selectedTabs ?? [this.selectedTab]) {
        if (tab.linkedBrowser?.currentURI?.schemeIs("toji")) {
          lazy.TojiAsk.markFresh(tab.linkedBrowser);
        }
      }
      return reloadWithFlags.apply(this, args);
    };

    // Tabs: every change the strip or address bar shows.
    const container = win.gBrowser.tabContainer;
    const flush = () => this.scheduleFlush();
    for (const type of ["TabOpen", "TabSelect", "TabMove", "TabAttrModified", "TabShow", "TabHide", "TabPinned", "TabUnpinned", "TabBrowserInserted", "TabBrowserDiscarded"]) {
      container.addEventListener(type, flush);
    }
    container.addEventListener("TabClose", e => {
      const closing = e.target;
      for (const [id, tab] of this.tabsById) {
        if (tab === closing) {
          this.tabsById.delete(id);
        }
      }
      const temp = this.throwaway.get(closing);
      if (temp) {
        this.throwaway.delete(closing);
        lazy.TojiContainers.releaseTemporary(temp).catch(err => console.error("[toji:shell] releasing", temp, err));
      }
      this.pruneGroups(closing);
      flush();
    });
    // A tab a page opened joins its opener's group, as in the Electron app (a duplicated,
    // reopened or restored tab brings its own from the session).
    container.addEventListener("TabOpen", e => {
      const tab = e.target;
      const group = tab.openerTab && this.groupOf(tab.openerTab);
      if (group && !this.groupOf(tab)) {
        this.setGroupOf(tab, group);
      }
    });
    // Firefox's prompts (permissions, add-on installs) hang from the address bar. Only a
    // XUL element works here: PopupNotifications takes the property, and an id string in
    // the attribute throws in Firefox 153 (it asks the string for its class name).
    const anchorBrowser = browser => {
      const anchor = doc.getElementById(ANCHOR_ID);
      if (browser && anchor) {
        browser.popupnotificationanchor = anchor;
      }
    };
    for (const browser of win.gBrowser.browsers) {
      anchorBrowser(browser);
    }
    container.addEventListener("TabBrowserInserted", e => anchorBrowser(e.target.linkedBrowser));
    container.addEventListener("TabOpen", e => anchorBrowser(e.target.linkedBrowser));
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          flush();
        }
      },
      onStateChange: (browser, webProgress, request, flags) => {
        if (webProgress?.isTopLevel && flags & (Ci.nsIWebProgressListener.STATE_START | Ci.nsIWebProgressListener.STATE_STOP)) {
          flush();
        }
      },
    });

    // The pointer over the window's own chrome, for the drag notch and the bookmarks bar.
    const cursor = (x, y, inside) => this.events.cursor.emit({ x, y, width: win.innerWidth, height: win.innerHeight, inside });
    win.addEventListener("mousemove", e => cursor(e.clientX, e.clientY, true), { capture: true, passive: true });
    win.addEventListener("mouseout", e => {
      if (!e.relatedTarget || e.relatedTarget.localName === "browser") {
        cursor(e.clientX, e.clientY, false);
      }
    }, { capture: true, passive: true });
    win.addEventListener("blur", () => cursor(-1, -1, false));
  }

  // --- Mounting ---------------------------------------------------------------------

  mount() {
    const win = this.win;
    const doc = win.document;
    const root = doc.documentElement;
    root.setAttribute("toji-shell", "true");
    try {
      win.windowUtils.loadSheetUsingURIString(`${SHELL}shell-global.css`, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("[toji:shell] global stylesheet", e);
    }
    const el = (id, parent = doc.body) => {
      let node = doc.getElementById(id);
      if (!node) {
        node = doc.createElementNS(XHTML_NS, "div");
        node.id = id;
        parent.append(node);
      }
      return node;
    };
    // macOS places the traffic lights on this box (see toji.css), where the Electron
    // app had them.
    el("toji-window-buttons");
    // What Firefox's prompts hang from: a XUL box, which PopupNotifications requires.
    if (!doc.getElementById(ANCHOR_ID)) {
      const anchor = doc.createXULElement("box");
      anchor.id = ANCHOR_ID;
      doc.body.append(anchor);
    }
    const shell = el("toji-shell");
    const shadow = shell.shadowRoot ?? shell.attachShadow({ mode: "open" });
    // Parsed now, so the window's first paint already has the shell's look.
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(Cu.readUTF8URI(Services.io.newURI(`${SHELL}shell.css`)));
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      console.error("[toji:shell] stylesheet, falling back to a link", e);
      const link = doc.createElementNS(XHTML_NS, "link");
      link.rel = "stylesheet";
      link.href = `${SHELL}shell.css`;
      shadow.append(link);
    }
    for (const browser of win.gBrowser.browsers) {
      browser.popupnotificationanchor = doc.getElementById(ANCHOR_ID);
    }
    win.toji = this.bridge();
    win.tojiShell = this.api();
    Services.scriptloader.loadSubScript(`${SHELL}shell.js`, win);
    win.tojiMountShell(shadow);
  }
}

let registered = false;

export const TojiShell = {
  init() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor("TojiEdge", {
      parent: { esModuleURI: "resource:///modules/toji/actors/TojiEdgeParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/toji/actors/TojiEdgeChild.sys.mjs",
        events: { mousemove: { passive: true }, mouseout: { passive: true } },
      },
      messageManagerGroups: ["browsers"],
    });
  },

  /** browser-window-domcontentloaded, from TojiWindows.init. */
  initWindow(win) {
    if (hosts.has(win)) {
      return;
    }
    this.init();
    const host = new Host(win);
    hosts.set(win, host);
    everyWindow.start();
    try {
      host.hookFirefox();
    } catch (e) {
      console.error("[toji:shell] hooking Firefox's chrome", e);
    }
    try {
      lazy.TojiFirefoxUI.initWindow(win);
    } catch (e) {
      console.error("[toji:shell] Firefox's menus", e);
    }
    host.mount();
  },

  uninitWindow(win) {
    // Reset-context identities die with their window.
    for (const id of hosts.get(win)?.throwaway.values() ?? []) {
      lazy.TojiContainers.releaseTemporary(id).catch(() => {});
    }
    hosts.delete(win);
  },

  /** The window's container changed (chosen, or the picker came back). */
  refresh(win) {
    hosts.get(win)?.scheduleFlush();
  },

  /** The window's tab groups and which of its tabs are in them, for moving them to another window. */
  groupsOf(win) {
    const host = hosts.get(win);
    if (!host) {
      return null;
    }
    const byTab = new Map();
    for (const tab of win.gBrowser.tabs) {
      const groupId = host.groupOf(tab);
      if (groupId) {
        byTab.set(tab, groupId);
      }
    }
    return { groups: host.groupList(), byTab };
  },

  /** Gives a window groups: `groupIds[i]` is the group of its i-th tab (or null). */
  adoptGroups(win, groups, groupIds) {
    const host = hosts.get(win);
    if (!host) {
      return;
    }
    host.writeGroups(groups.map(g => ({ ...g })));
    win.gBrowser.tabs.forEach((tab, i) => {
      if (groupIds[i]) {
        host.setGroupOf(tab, groupIds[i]);
      }
    });
  },

  focusOmnibox(win, select = true) {
    hosts.get(win)?.events.focus.emit(select);
  },

  // From TojiEdge: the pointer at the top of the page in front.
  pageTopEdge(browser, inside) {
    const win = browser?.ownerGlobal ?? browser?.ownerDocument?.defaultView;
    const host = win && hosts.get(win);
    if (host && win.gBrowser.selectedBrowser === browser) {
      host.events.topEdge.emit(!!inside);
    }
  },

  // From TojiVault.
  vaultMatches(browser, matches) {
    const win = browser?.ownerDocument?.defaultView;
    const host = win && hosts.get(win);
    const tab = host?.tabOfBrowser(browser);
    if (tab) {
      host.events.vaultMatches.emit(host.idOf(tab), matches);
    }
  },
  vaultPrompt(browser, pending) {
    const win = browser?.ownerDocument?.defaultView;
    const host = win && hosts.get(win);
    if (!host) {
      return;
    }
    if (!pending) {
      host.events.vaultPrompt.emit(null);
      return;
    }
    host.events.vaultPrompt.emit(
      {
        webContentsId: browser.browserId,
        origin: pending.origin ?? "",
        username: pending.username ?? "",
        containerId: pending.containerId ?? null,
        status: pending.status,
      },
      pending.error
    );
  },

  // From TojiAgent.
  agentChanged(win) {
    hosts.get(win)?.events.agent.emit();
  },
  agentPointer(win, pointer) {
    hosts.get(win)?.events.agentPointer.emit(pointer);
  },
  spotlight(win, target) {
    const host = hosts.get(win);
    if (!host) {
      return;
    }
    host.events.spotlight.emit(target && typeof target === "object" ? host.idOf(target) : target);
  },

  // From TojiWindows / TojiBugReport.
  reportBug(win, request) {
    hosts.get(win)?.events.report.emit(request);
  },
  reportTray(win, tray) {
    const host = hosts.get(win);
    if (!host) {
      return;
    }
    host.events.reportTray.emit(tray ? { ...tray, tabId: host.idOf(tray.tab), tab: undefined } : null);
  },
};
