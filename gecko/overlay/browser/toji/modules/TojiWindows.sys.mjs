/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One window = one container. A window learns its container when it opens
// (Toji passes it in window.arguments), from the tab it adopts, from the page
// that opened it, or — if nothing says — from the "Who's browsing?" picker it
// shows instead of a page. From then on every tab created in it gets that
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
  TojiAsk: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiRecorder: "resource:///modules/toji/TojiRecorder.sys.mjs",
  TojiTorUI: "resource:///modules/toji/TojiTorUI.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ContainersLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/containers.sys.mjs")
);

const BAG_KEY = "toji-container";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const STYLESHEET = "chrome://toji/content/toji.css";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const CLEARED_TOPIC = "toji-container-cleared";
const CHANGED_TOPIC = "toji-containers-changed";

/** window -> { containerId, userContextId, pending: string[] } */
const windows = new WeakMap();
/** window -> Promise of the still taken when a bug report was opened */
const pendingScreenshots = new WeakMap();
/** window -> Promise of the last-15-seconds clip frozen when a report was opened */
const pendingClips = new WeakMap();

function isPrivate(win) {
  return lazy.PrivateBrowsingUtils.isWindowPrivate(win);
}

function avatarURL(c) {
  return c?.avatar ? `chrome://toji/content/${c.avatar}` : "";
}

function isStartPage(url, win) {
  if (!url) {
    return true;
  }
  if (
    [
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

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS(XHTML_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) {
      continue;
    }
    if (key === "class") {
      el.className = value;
    } else if (key.startsWith("on")) {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? "" : value);
    }
  }
  for (const child of children) {
    if (child != null) {
      el.append(child);
    }
  }
  return el;
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
    if (bound?.containerId) {
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
    return;
  }
  root.setAttribute("toji-container", c.id);
  root.setAttribute("toji-egress", c.egress);
  root.toggleAttribute("toji-ephemeral", c.ephemeral);
  root.toggleAttribute("toji-hold-tor", !!c.temporary);
  root.style.setProperty("--toji-container-color", c.color);
  lazy.TojiTorUI.refresh(win);
  const button = win.document.getElementById("toji-profile-button");
  if (button) {
    button.style.listStyleImage = `url("${avatarURL(c)}")`;
    button.setAttribute("tooltiptext", `${c.name} · ${lazy.ContainersLib.routeLabel(c)}`);
    button.setAttribute("label", c.name);
  }
}

function hidePicker(win) {
  win.document.getElementById("toji-picker")?.remove();
  win.document.documentElement.removeAttribute("toji-picking");
}

function showPicker(win) {
  const doc = win.document;
  if (doc.getElementById("toji-picker")) {
    return;
  }
  doc.documentElement.setAttribute("toji-picking", "true");
  const root = h(doc, "div", {
    id: "toji-picker",
    role: "dialog",
    "aria-labelledby": "toji-picker-title",
  });
  let creating = false;
  let draftAvatar = null;

  const render = () => {
    const lib = lazy.ContainersLib;
    const containers = lazy.TojiContainers.list();
    draftAvatar ??= lib.PROFILE_AVATARS[containers.length % lib.PROFILE_AVATARS.length];
    const cards = containers.map(c =>
      h(
        doc,
        "button",
        {
          class: "toji-picker-card",
          type: "button",
          "data-container": c.id,
          onclick: () => TojiWindows.choose(win, c.id),
        },
        h(doc, "img", { class: "toji-avatar toji-avatar-lg", src: avatarURL(c), alt: "" }),
        h(doc, "span", { class: "toji-picker-name" }, c.name),
        h(doc, "span", { class: "toji-picker-route" }, lib.routeLabel(c))
      )
    );
    const add = h(
      doc,
      "button",
      {
        class: "toji-picker-card toji-picker-add",
        type: "button",
        onclick: () => {
          creating = true;
          render();
          root.querySelector(".toji-picker-create input")?.focus();
        },
      },
      h(doc, "span", { class: "toji-avatar toji-avatar-lg toji-picker-plus" }, "+"),
      h(doc, "span", { class: "toji-picker-name" }, "Add profile"),
      h(doc, "span", { class: "toji-picker-route" }, "New identity")
    );
    let create = null;
    if (creating) {
      const input = h(doc, "input", {
        type: "text",
        placeholder: "Profile name",
        "aria-label": "Profile name",
      });
      const submit = async () => {
        const name = input.value.trim();
        if (!name) {
          return;
        }
        const c = await lazy.TojiContainers.add(name, draftAvatar);
        TojiWindows.choose(win, c.id);
      };
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          submit();
        }
      });
      create = h(
        doc,
        "section",
        { class: "toji-picker-create", "aria-label": "Create profile" },
        h(
          doc,
          "button",
          {
            class: "toji-picker-close",
            type: "button",
            "aria-label": "Close",
            onclick: () => {
              creating = false;
              render();
            },
          },
          "×"
        ),
        h(doc, "p", { class: "toji-picker-label" }, "Choose a picture"),
        h(
          doc,
          "div",
          { class: "toji-picker-avatars" },
          ...lib.PROFILE_AVATARS.map(a =>
            h(
              doc,
              "button",
              {
                type: "button",
                class: `toji-picker-avatar${a === draftAvatar ? " selected" : ""}`,
                "aria-label": "Choose profile picture",
                onclick: () => {
                  draftAvatar = a;
                  const value = input.value;
                  render();
                  const again = root.querySelector(".toji-picker-create input");
                  if (again) {
                    again.value = value;
                    again.focus();
                  }
                },
              },
              h(doc, "img", { src: `chrome://toji/content/${a}`, alt: "" })
            )
          )
        ),
        h(
          doc,
          "div",
          { class: "toji-picker-row" },
          input,
          h(doc, "button", { class: "toji-picker-submit", type: "button", onclick: submit }, "Create")
        )
      );
    }
    root.replaceChildren(
      h(
        doc,
        "div",
        { class: "toji-picker-inner" },
        h(doc, "h1", { id: "toji-picker-title" }, "Who’s browsing?"),
        h(
          doc,
          "p",
          { class: "toji-picker-lede" },
          "Every tab in this window stays inside the profile you choose."
        ),
        h(doc, "div", { class: "toji-picker-grid" }, ...cards, add),
        create
      )
    );
  };
  render();
  doc.body.append(root);
  root.querySelector(".toji-picker-card")?.focus();
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
      applyContainer(win);
      if (win.document.getElementById("toji-picker")) {
        hidePicker(win);
        showPicker(win);
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
      lazy.TojiAsk.initWindow(win);
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
    if (windows.get(win).containerId) {
      applyContainer(win);
    } else {
      showPicker(win);
    }
  },

  /**
   * Hold-to-Tor. A direct window moves to a fresh ephemeral Tor identity (a new
   * private window in its place, the same pages reloaded through tor); a
   * hold-to-Tor window moves back to its profile's normal route and its Tor
   * identity is wiped. `load` replaces the page of the tab `from` (a .onion
   * address that sent the window to Tor).
   */
  async toggleTor(win, { load = null, from = null } = {}) {
    const state = windows.get(win);
    const c = state?.containerId ? lazy.TojiContainers.byId(state.containerId) : null;
    if (!c || (c.egress === "tor" && !c.temporary)) {
      return;
    }
    const urls = [];
    let selected = 0;
    for (const tab of win.gBrowser.tabs) {
      let spec = tab.linkedBrowser.currentURI?.spec;
      if (from && tab.linkedBrowser === from && load) {
        spec = load;
      }
      if (!spec || isStartPage(spec, win)) {
        continue;
      }
      if (tab.selected) {
        selected = urls.length;
      }
      urls.push(spec);
    }
    // Keep the selected page first so it opens in front.
    if (selected > 0) {
      urls.unshift(...urls.splice(selected, 1));
    }
    let target;
    if (c.temporary) {
      target = lazy.TojiContainers.byId(c.baseId);
    } else {
      target = lazy.TojiContainers.createTorOverlay(c);
    }
    if (!target) {
      return;
    }
    await this.openContainerWindow(target.id, { urls, like: win });
    win.close();
    if (c.temporary) {
      lazy.TojiContainers.releaseTemporary(c.id).catch(e =>
        console.error("[toji:windows] releasing", c.id, e)
      );
    }
  },

  // browser-window-unload-begin
  uninit(win) {
    const state = windows.get(win);
    windows.delete(win);
    if (!state?.containerId) {
      return;
    }
    const c = lazy.TojiContainers.byId(state.containerId);
    if (!c?.ephemeral) {
      return;
    }
    const stillOpen = lazy.BrowserWindowTracker.orderedWindows.some(
      w => w !== win && !w.closed && windows.get(w)?.containerId === c.id
    );
    if (stillOpen) {
      return;
    }
    const wipe = c.temporary
      ? lazy.TojiContainers.releaseTemporary(c.id)
      : lazy.TojiContainers.clear(c.id);
    wipe.catch(e => console.error("[toji:windows] wiping", c.id, e));
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
    const urls = pending.length ? pending : [win.BROWSER_NEW_TAB_URL];
    urls.forEach((url, i) =>
      gBrowser.addTrustedTab(url, { inBackground: i > 0 })
    );
    for (const tab of blank) {
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    }
    if (!pending.length) {
      win.gURLBar?.select();
    }
  },

  /** Opens a window in a container, at `like`'s position and size if given. */
  async openContainerWindow(containerId, { urls = [], like = null } = {}) {
    const c = lazy.TojiContainers.byId(containerId);
    if (!c) {
      throw new Error(`no container ${containerId}`);
    }
    const [first, ...rest] = urls;
    const url = first ?? (c.ephemeral ? "about:privatebrowsing" : "about:newtab");
    const win = lazy.BrowserWindowTracker.openWindow({
      private: c.ephemeral,
      args: windowArguments(url, c),
    });
    if (like && like.windowState !== like.STATE_MAXIMIZED) {
      win.addEventListener(
        "load",
        () => {
          win.resizeTo(like.outerWidth, like.outerHeight);
          win.moveTo(like.screenX, like.screenY);
        },
        { once: true }
      );
    }
    if (rest.length) {
      await whenDelayedStartup(win);
      for (const u of rest) {
        win.gBrowser.addTrustedTab(u, { inBackground: true });
      }
    }
    return win;
  },

  /**
   * Help › Report a Bug…: takes a still of the window first (so the sheet itself
   * isn't in it), then opens the report sheet beside the current tab.
   */
  async openBugReport(win) {
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return;
    }
    const browser = win.gBrowser.selectedBrowser;
    const pageUrl = browser.currentURI?.spec ?? "";
    pendingScreenshots.set(win, lazy.TojiBugReport.captureWindow(win).catch(() => null));
    // Freeze the last 15 seconds now, before the report page is on screen.
    pendingClips.set(win, lazy.TojiRecorder.clip(win).catch(() => null));
    const params = new URLSearchParams({
      page: /^https?:/.test(pageUrl) ? pageUrl : "",
      window: `${win.innerWidth}×${win.innerHeight}`,
      layout: Services.prefs.getBoolPref("sidebar.verticalTabs", false) ? "side" : "top",
      theme: Services.prefs.getStringPref("toji.theme", "light"),
    });
    win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(`about:report?${params}`, {
      relatedToCurrent: true,
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

  /** The profile button's menu: who this window is, clear it, open another. */
  showProfileMenu(win, anchor) {
    const doc = win.document;
    const state = windows.get(win);
    const c = state?.containerId ? lazy.TojiContainers.byId(state.containerId) : null;
    doc.getElementById("toji-profile-menu")?.remove();
    const popup = doc.createXULElement("menupopup");
    popup.id = "toji-profile-menu";
    const item = (label, command, disabled = false) => {
      const mi = doc.createXULElement("menuitem");
      mi.setAttribute("label", label);
      if (disabled) {
        mi.setAttribute("disabled", "true");
      }
      if (command) {
        mi.addEventListener("command", command);
      }
      popup.append(mi);
      return mi;
    };
    if (c) {
      item(`${c.name} · ${lazy.ContainersLib.routeLabel(c)}`, null, true);
      popup.append(doc.createXULElement("menuseparator"));
      item(`Clear ${c.name}…`, () => this.confirmClear(win, c.id));
    }
    item("New window…", () => win.OpenBrowserWindow());
    popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
    doc.getElementById("mainPopupSet").append(popup);
    popup.openPopup(anchor, "after_end");
  },

  async confirmClear(win, containerId) {
    const c = lazy.TojiContainers.byId(containerId);
    if (!c) {
      return;
    }
    const ok =
      c.ephemeral ||
      Services.prompt.confirm(
        win,
        `Clear ${c.name}?`,
        `Every cookie, cache and saved site setting in ${c.name} will be deleted, and its tabs reloaded. You will be signed out of sites in this profile.`
      );
    if (ok) {
      await lazy.TojiContainers.clear(c.id);
    }
  },
};
