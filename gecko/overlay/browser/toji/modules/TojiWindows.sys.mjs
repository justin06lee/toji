/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One window = one container. A window learns its container when it opens
// (Toji passes it in window.arguments), from the tab it adopts, from the page
// that opened it, or — if nothing says — from the "Who's browsing?" picker its
// shell shows instead of a page (TojiShell). From then on every tab created in it gets that
// container's userContextId, and tabs can't be dragged in from another one.
//
// Ephemeral containers live in private windows: Firefox never writes their
// history or session to disk, and Toji wipes the container when its last window
// closes (and at startup).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  TojiAgent: "resource:///modules/toji/TojiAgent.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiRecorder: "resource:///modules/toji/TojiRecorder.sys.mjs",
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
  TojiTorUI: "resource:///modules/toji/TojiTorUI.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ContainersLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/containers.sys.mjs")
);

const BAG_KEY = "toji-container";
const STYLESHEET = "chrome://toji/content/toji.css";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const CLEARED_TOPIC = "toji-container-cleared";
const CHANGED_TOPIC = "toji-containers-changed";
const START_PAGE = "about:start";

/** window -> { containerId, userContextId, pending: string[] } */
const windows = new WeakMap();
/** window -> Promise of the still taken when a bug report was opened */
const pendingScreenshots = new WeakMap();
/** window -> Promise of the last-15-seconds clip frozen when a report was opened */
const pendingClips = new WeakMap();

function isPrivate(win) {
  return lazy.PrivateBrowsingUtils.isWindowPrivate(win);
}

function isOnion(url) {
  try {
    return /\.onion$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Whether a window's container is `id`, or a throwaway identity standing in for it (hold-to-Tor). */
function inFamily(win, id) {
  const own = windows.get(win)?.containerId;
  if (!own) {
    return false;
  }
  return own === id || lazy.TojiContainers.byId(own)?.baseId === id;
}

function isStartPage(url, win) {
  if (!url) {
    return true;
  }
  if (
    [
      "about:start",
      "about:home",
      "about:newtab",
      "about:privatebrowsing",
      "about:blank",
      "about:welcome",
    ].includes(url)
  ) {
    return true;
  }
  const home = Services.prefs.getStringPref(
    "browser.startup.homepage",
    "about:home"
  );
  if (url === home || home.split("|").includes(url)) {
    return true;
  }
  try {
    return url === win?.BrowserHandler?.defaultArgs;
  } catch {
    return false;
  }
}

function urlsFromArgument(arg) {
  if (!arg) {
    return [];
  }
  if (typeof arg === "string") {
    return [arg];
  }
  if (arg instanceof Ci.nsIArray) {
    return Array.from(arg.enumerate(Ci.nsISupportsString), s => s.data);
  }
  if (arg instanceof Ci.nsISupportsString) {
    return [arg.data];
  }
  return [];
}

function openWindowInfoOf(win) {
  try {
    return (
      win.docShell.treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow).initialOpenWindowInfo ||
      win.arguments?.[11] ||
      null
    );
  } catch {
    return null;
  }
}

function resolveContainer(win) {
  const containers = lazy.TojiContainers;
  const args = win.arguments;
  const bag = args?.[1];
  if (bag instanceof Ci.nsIPropertyBag2 && bag.hasKey(BAG_KEY)) {
    const c = containers.byId(bag.getPropertyAsAString(BAG_KEY));
    if (c) {
      return c;
    }
  }
  // Dragging a tab out into its own window: it keeps its container.
  const tab = win.gBrowserInit?.getTabToAdopt?.();
  const tabUc = tab?.getAttribute?.("usercontextid");
  if (tabUc) {
    return containers.byUserContextId(parseInt(tabUc, 10));
  }
  // window.open() popups: the opener's container.
  const info = openWindowInfoOf(win);
  if (info?.originAttributes?.userContextId) {
    return containers.byUserContextId(info.originAttributes.userContextId);
  }
  if (typeof args?.[5] === "number" && args[5] > 0) {
    return containers.byUserContextId(args[5]);
  }
  // "Open Link in New Window" from a container window: same container. A
  // plain new window (⌘N) carries the home page and gets the picker.
  const opener = win.opener;
  const openerState = opener && windows.get(opener);
  if (
    openerState?.containerId &&
    urlsFromArgument(args?.[0]).some(u => !isStartPage(u, win))
  ) {
    const c = containers.byId(openerState.containerId);
    if (c && c.ephemeral === isPrivate(win)) {
      return c;
    }
  }
  // ⌘⇧N: a private window nobody chose a container for is Private.
  if (isPrivate(win)) {
    const c = lazy.ContainersLib.defaultPrivateContainer(containers.list());
    return c ? containers.byId(c.id) : null;
  }
  return null;
}

/**
 * Makes the first tab (tabbrowser reads arguments[5]) and the first URL load
 * (openLinkIn reads [5] when there are 3+ arguments) use the container.
 * A window opened with just a URL string gets the full argument form, which
 * also needs a triggering principal or nothing would load.
 */
function setUserContextArgument(win, userContextId) {
  const args = win.arguments;
  if (!args) {
    return;
  }
  if (args.length < 3) {
    args[1] = null;
    args[2] = null;
    args[3] = null;
    args[4] = false;
    args[6] = undefined;
    args[7] = undefined;
    args[8] = Services.scriptSecurityManager.getSystemPrincipal();
  }
  args[5] = userContextId;
}

/** window.arguments for a new window in a container (see browser-init.js). */
function windowArguments(url, container) {
  const sa = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  const wuri = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  wuri.data = url;
  const bag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag2
  );
  bag.setPropertyAsAString(BAG_KEY, container.id);
  const fixup = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
    Ci.nsISupportsPRBool
  );
  fixup.data = false;
  const uc = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(
    Ci.nsISupportsPRUint32
  );
  uc.data = container.userContextId;
  sa.appendElement(wuri);
  sa.appendElement(bag);
  sa.appendElement(null); // referrerInfo
  sa.appendElement(null); // postData
  sa.appendElement(fixup);
  sa.appendElement(uc);
  sa.appendElement(null); // originPrincipal
  sa.appendElement(null); // originStoragePrincipal
  sa.appendElement(Services.scriptSecurityManager.getSystemPrincipal());
  sa.appendElement(null); // allowInheritPrincipal
  sa.appendElement(null); // policyContainer
  return sa;
}

function whenDelayedStartup(win) {
  return new Promise(resolve => {
    const observer = subject => {
      if (subject === win) {
        Services.obs.removeObserver(
          observer,
          "browser-delayed-startup-finished"
        );
        resolve();
      }
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  });
}

function wrapTabbrowser(win) {
  const gBrowser = win.gBrowser;

  const addTab = gBrowser.addTab;
  gBrowser.addTab = function (uri, params = {}) {
    const state = windows.get(win);
    if (state && !state.containerId) {
      // Session restore into an unassigned window names its container.
      const restored = params.userContextId
        ? lazy.TojiContainers.byUserContextId(params.userContextId)
        : null;
      if (restored) {
        TojiWindows.bind(win, restored);
      } else if (uri && !isStartPage(uri, win)) {
        // Nothing may load outside a container; keep it for after the pick.
        state.pending.push(uri);
        uri = "about:blank";
      }
    }
    const bound = windows.get(win);
    // Every tab is in the window's container, but a Reset context tab: an identity of its own.
    if (bound?.containerId && !params.tojiOwnContext) {
      params = { ...params, userContextId: bound.userContextId };
    }
    return addTab.call(this, uri, params);
  };

  const adoptTab = gBrowser.adoptTab;
  gBrowser.adoptTab = function (tab, options) {
    const state = windows.get(win);
    if (state?.containerId && tab.userContextId !== state.userContextId) {
      return null;
    }
    return adoptTab.call(this, tab, options);
  };

  const dnd = gBrowser.tabContainer?.tabDragAndDrop;
  if (dnd?.getDropEffectForTabDrag) {
    const getDropEffect = dnd.getDropEffectForTabDrag;
    dnd.getDropEffectForTabDrag = function (event) {
      const effect = getDropEffect.call(this, event);
      if (effect === "move" || effect === "copy") {
        const source = event.dataTransfer.mozGetDataAt(TAB_DROP_TYPE, 0);
        const sourceWin = source?.documentGlobal ?? source?.ownerDocument?.defaultView;
        if (
          sourceWin &&
          sourceWin !== win &&
          windows.get(sourceWin)?.containerId !==
            windows.get(win)?.containerId
        ) {
          return "none";
        }
      }
      return effect;
    };
  }
}

function applyContainer(win) {
  const state = windows.get(win);
  const c = state?.containerId
    ? lazy.TojiContainers.byId(state.containerId)
    : null;
  const root = win.document.documentElement;
  if (!c) {
    root.removeAttribute("toji-container");
    lazy.TojiShell.refresh(win);
    return;
  }
  root.setAttribute("toji-container", c.id);
  root.setAttribute("toji-egress", c.egress);
  root.toggleAttribute("toji-ephemeral", c.ephemeral);
  root.toggleAttribute("toji-hold-tor", !!c.temporary);
  root.style.setProperty("--toji-container-color", c.color);
  lazy.TojiTorUI.refresh(win);
  lazy.TojiShell.refresh(win);
}

// "Who's browsing?" is the shell's: it shows while the window has no container.
function hidePicker(win) {
  win.document.documentElement.removeAttribute("toji-picking");
  lazy.TojiShell.refresh(win);
}

function showPicker(win) {
  win.document.documentElement.setAttribute("toji-picking", "true");
  lazy.TojiShell.refresh(win);
}

/**
 * The window's profile was deleted (its data is already gone): its pages stop, and it
 * asks "Who's browsing?" again, as the Electron app did.
 */
function orphan(win) {
  windows.set(win, { containerId: null, userContextId: 0, pending: [] });
  const system = Services.scriptSecurityManager.getSystemPrincipal();
  for (const tab of win.gBrowser.tabs) {
    try {
      tab.linkedBrowser.loadURI(Services.io.newURI("about:blank"), { triggeringPrincipal: system });
    } catch {}
  }
  win.document.documentElement.removeAttribute("toji-container");
  showPicker(win);
}

function reloadContainerTabs(containerId) {
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (windows.get(win)?.containerId !== containerId) {
      continue;
    }
    for (const tab of win.gBrowser.tabs) {
      if (!tab.hasAttribute("pending")) {
        win.gBrowser.reloadTab(tab);
      }
    }
  }
}

let observing = false;
function observeOnce() {
  if (observing) {
    return;
  }
  observing = true;
  Services.obs.addObserver((subject, topic, data) => {
    reloadContainerTabs(data);
  }, CLEARED_TOPIC);
  Services.obs.addObserver(() => {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      const id = windows.get(win)?.containerId;
      if (id && !lazy.TojiContainers.byId(id)) {
        orphan(win);
      } else {
        applyContainer(win);
      }
    }
  }, CHANGED_TOPIC);
}

export const TojiWindows = {
  /** The container id a window belongs to, or null while it shows the picker. */
  containerOf(win) {
    return windows.get(win)?.containerId ?? null;
  },

  userContextIdOf(win) {
    return windows.get(win)?.userContextId ?? 0;
  },

  // browser-window-domcontentloaded-before-tabbrowser
  beforeTabbrowser(win) {
    try {
      const container = resolveContainer(win);
      if (container) {
        windows.set(win, {
          containerId: container.id,
          userContextId: container.userContextId,
          pending: [],
        });
        if (!win.gBrowserInit?.getTabToAdopt?.() && !openWindowInfoOf(win)) {
          setUserContextArgument(win, container.userContextId);
        }
        // Firefox forces a private window's first page to about:privatebrowsing.
        const first = urlsFromArgument(win.arguments?.[0]);
        if (first.length === 1 && first[0] === "about:privatebrowsing") {
          win.arguments[0] = START_PAGE;
        }
        return;
      }
      const pending = urlsFromArgument(win.arguments?.[0]).filter(
        u => !isStartPage(u, win)
      );
      if (win.arguments?.length) {
        // Load nothing until a container is chosen.
        win.arguments[0] = null;
      }
      // updateBookmarkToolbarVisibility() already read and cached the URI to
      // load in onBeforeInitialXULLayout, so the first tab would still get it.
      // null is what gBrowserInit uses for "nothing to load".
      if (win.gBrowserInit) {
        Object.defineProperty(win.gBrowserInit, "uriToLoadPromise", {
          value: null,
          writable: true,
          configurable: true,
        });
      }
      windows.set(win, { containerId: null, userContextId: 0, pending });
    } catch (e) {
      console.error("[toji:windows] beforeTabbrowser", e);
      windows.set(win, { containerId: null, userContextId: 0, pending: [] });
    }
  },

  // browser-window-domcontentloaded
  init(win) {
    observeOnce();
    // The start page shows an empty address bar, as Firefox's new tab page does.
    if (Array.isArray(win.gInitialPages) && !win.gInitialPages.includes("about:start")) {
      win.gInitialPages.push("about:start");
    }
    try {
      win.windowUtils.loadSheetUsingURIString(
        STYLESHEET,
        win.windowUtils.AUTHOR_SHEET
      );
    } catch (e) {
      console.error("[toji:windows] stylesheet", e);
    }
    if (!windows.has(win)) {
      windows.set(win, { containerId: null, userContextId: 0, pending: [] });
    }
    wrapTabbrowser(win);
    try {
      lazy.TojiTorUI.initWindow(win);
    } catch (e) {
      console.error("[toji:windows] tor ui", e);
    }
    try {
      lazy.TojiAgent.initWindow(win);
    } catch (e) {
      console.error("[toji:windows] agent", e);
    }
    try {
      lazy.TojiVault.initWindow(win);
    } catch (e) {
      console.error("[toji:windows] vault", e);
    }
    try {
      lazy.TojiBugReport.initWindow(win, w => this.openBugReport(w));
      lazy.TojiRecorder.initWindow(win);
    } catch (e) {
      console.error("[toji:windows] bug report", e);
    }
    // Toji's own UI for the window, in place of Firefox's.
    try {
      lazy.TojiShell.initWindow(win);
    } catch (e) {
      console.error("[toji:windows] shell", e);
    }
    if (windows.get(win).containerId) {
      applyContainer(win);
    } else {
      showPicker(win);
    }
  },

  /**
   * Hold-to-Tor. A direct window moves to a fresh ephemeral Tor identity; a
   * hold-to-Tor window moves back to its profile's normal route and its Tor
   * identity is wiped. `load` replaces the page of the tab `from` (a .onion
   * address that sent the window to Tor).
   *
   * The Electron app reloaded the window's tabs in place. Gecko decides private
   * browsing per window, never per tab, and a Tor identity must stay off disk, so
   * the window is replaced instead — at the same place and size, with every tab in
   * its place (the one in front still in front, the rest loading when chosen) and
   * its groups; the old window closes only once the new one is up.
   */
  async toggleTor(win, { load = null, from = null } = {}) {
    const state = windows.get(win);
    const c = state?.containerId ? lazy.TojiContainers.byId(state.containerId) : null;
    if (!c || (c.egress === "tor" && !c.temporary) || state.swapping) {
      return;
    }
    const target = c.temporary
      ? lazy.TojiContainers.byId(c.baseId)
      : lazy.TojiContainers.createTorOverlay(c);
    if (!target) {
      return;
    }
    state.swapping = true;
    const grouped = lazy.TojiShell.groupsOf(win);
    const tabs = win.gBrowser.tabs
      .filter(tab => !tab.closing && !tab.hidden)
      .map(tab => {
        const browser = tab.linkedBrowser;
        let url = browser?.currentURI?.spec ?? "";
        if (tab.hasAttribute("pending") && (!url || url === "about:blank")) {
          url = win.SessionStore?.getLazyTabValue?.(tab, "url") || url;
        }
        if (from && browser === from && load) {
          url = load;
        }
        // Leaving Tor, a .onion page can't come along (it would send the window straight back).
        const stays = url && !isStartPage(url, win) && !(c.temporary && isOnion(url));
        return {
          url: stays ? url : START_PAGE,
          title: tab.label || "",
          selected: tab.selected,
          groupId: grouped?.byTab.get(tab) ?? null,
        };
      });
    try {
      const next = await this.openContainerWindow(target.id, { tabs, like: win });
      if (grouped?.groups.length) {
        lazy.TojiShell.adoptGroups(next, grouped.groups, tabs.map(t => t.groupId));
      }
    } catch (e) {
      state.swapping = false;
      console.error("[toji:windows] hold-to-Tor", e);
      if (!c.temporary) {
        lazy.TojiContainers.releaseTemporary(target.id).catch(() => {});
      }
      return;
    }
    // Its Tor identity is wiped as it goes (uninit).
    win.close();
  },

  // browser-window-unload-begin
  uninit(win) {
    const state = windows.get(win);
    windows.delete(win);
    lazy.TojiShell.uninitWindow(win);
    if (!state?.containerId) {
      return;
    }
    const c = lazy.TojiContainers.byId(state.containerId);
    if (!c) {
      return;
    }
    // A hold-to-Tor identity is its window's alone.
    if (c.temporary) {
      lazy.TojiContainers.releaseTemporary(c.id).catch(e => console.error("[toji:windows] releasing", c.id, e));
    }
    // An ephemeral profile is wiped once none of its windows is left — counting the
    // hold-to-Tor window that replaced this one, so Tor and back keeps Private's pages.
    const base = c.temporary ? lazy.TojiContainers.byId(c.baseId) : c;
    if (!base?.ephemeral || base.temporary) {
      return;
    }
    const stillOpen = lazy.BrowserWindowTracker.orderedWindows.some(
      w => w !== win && !w.closed && inFamily(w, base.id)
    );
    if (!stillOpen) {
      lazy.TojiContainers.clear(base.id).catch(e => console.error("[toji:windows] wiping", base.id, e));
    }
  },

  /** Binds an unassigned window to a container (no tabs are touched). */
  bind(win, container) {
    const state = windows.get(win) ?? { pending: [] };
    windows.set(win, {
      containerId: container.id,
      userContextId: container.userContextId,
      pending: state.pending ?? [],
    });
    hidePicker(win);
    applyContainer(win);
  },

  /** The picker's choice: bind this window, or replace it when private-ness differs. */
  async choose(win, containerId) {
    const c = lazy.TojiContainers.byId(containerId);
    const state = windows.get(win);
    if (!c || !state) {
      return;
    }
    const pending = state.pending.splice(0);
    if (c.ephemeral !== isPrivate(win)) {
      await this.openContainerWindow(c.id, { urls: pending, like: win });
      win.close();
      return;
    }
    this.bind(win, c);
    const gBrowser = win.gBrowser;
    const blank = [...gBrowser.tabs];
    // The first window after installing shows Welcome, once.
    const welcome = !pending.length && !Services.prefs.getBoolPref("toji.onboarded", false);
    const urls = pending.length ? pending : [welcome ? "about:welcome" : win.BROWSER_NEW_TAB_URL];
    urls.forEach((url, i) =>
      gBrowser.addTrustedTab(url, { inBackground: i > 0 })
    );
    for (const tab of blank) {
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    }
    if (!pending.length && !welcome) {
      lazy.TojiShell.focusOmnibox(win);
    }
  },

  /**
   * Opens a window in a container, at `like`'s place and size if given, and
   * resolves once it is up. `urls` open in order with the first in front; `tabs`
   * ({url, title, selected}) keep their order with the selected one in front and
   * the others loading only when chosen.
   */
  async openContainerWindow(containerId, { urls = [], tabs = null, like = null } = {}) {
    const c = lazy.TojiContainers.byId(containerId);
    if (!c) {
      throw new Error(`no container ${containerId}`);
    }
    const list = tabs ?? urls.map((url, i) => ({ url, title: "", selected: i === 0 }));
    const front = Math.max(0, list.findIndex(t => t.selected));
    const maximized = like && like.windowState === like.STATE_MAXIMIZED;
    // Placed by the window features, so it never shows anywhere else first.
    const frame =
      like && !maximized && like.windowState !== like.STATE_FULLSCREEN
        ? `left=${like.screenX},top=${like.screenY},outerWidth=${like.outerWidth},outerHeight=${like.outerHeight}`
        : undefined;
    const win = lazy.BrowserWindowTracker.openWindow({
      private: c.ephemeral,
      features: frame,
      args: windowArguments(list[front]?.url ?? START_PAGE, c),
    });
    if (maximized) {
      win.addEventListener("load", () => win.maximize(), { once: true });
    }
    await whenDelayedStartup(win);
    list.forEach((t, i) => {
      if (i !== front) {
        // Tabs before the front one go in front of it, the rest after: every tab at its index.
        win.gBrowser.addTrustedTab(t.url, {
          tabIndex: i,
          inBackground: true,
          createLazyBrowser: true,
          lazyTabTitle: t.title || undefined,
        });
      }
    });
    return win;
  },

  /**
   * Help › Report a Bug…: takes a still of the window and freezes the last 15
   * seconds first (so the sheet itself is in neither), then opens the shell's
   * report sheet over the window, as the Electron app did.
   */
  async openBugReport(win) {
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return;
    }
    const browser = win.gBrowser.selectedBrowser;
    const pageUrl = browser.currentURI?.spec ?? "";
    const c = lazy.TojiContainers.byId(windows.get(win)?.containerId ?? "");
    const recordable = !!c && !c.ephemeral && c.egress !== "tor";
    const replayOn = Services.prefs.getBoolPref("toji.replay", true);
    const clip = replayOn && recordable ? lazy.TojiRecorder.clip(win).catch(() => null) : null;
    const screenshot = await lazy.TojiBugReport.captureWindow(win).catch(() => null);
    const unavailable = !replayOn ? "off" : !recordable ? "private" : clip ? null : "unsupported";
    lazy.TojiShell.reportBug(win, {
      screenshot,
      clip: clip?.then(v =>
        v ? { type: v.type, data: v.data, seconds: v.seconds, width: v.width ?? 0, height: v.height ?? 0, poster: v.poster ?? null } : null
      ) ?? null,
      unavailable,
      pageUrl: /^https?:/.test(pageUrl) ? pageUrl : null,
      context: {
        window: `${win.innerWidth}×${win.innerHeight}`,
        layout: Services.prefs.getStringPref("toji.layout", "top") === "side" ? "side" : "top",
        theme: Services.prefs.getStringPref("toji.theme", "light"),
      },
    });
  },

  /** The still taken when the report was opened, for the sheet to offer. */
  takeReportScreenshot(win) {
    const shot = pendingScreenshots.get(win) ?? null;
    pendingScreenshots.delete(win);
    return shot;
  },

  /** The clip frozen when the report was opened (null: nothing recorded). */
  takeReportClip(win) {
    const clip = pendingClips.get(win) ?? null;
    pendingClips.delete(win);
    return clip;
  },


};
