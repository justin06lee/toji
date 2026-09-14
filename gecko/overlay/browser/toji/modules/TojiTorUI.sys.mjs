/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor in the window. The round Go button (hold it to switch the window's Tor mode)
// and the status line under the toolbar are the shell's; what stays here is .onion
// addresses moving a direct window to Tor on their own, and starting tor for a Tor
// window.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiTor: "resource:///modules/toji/TojiTor.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
});

function windowContainer(win) {
  const id = lazy.TojiWindows.containerOf(win);
  return id ? lazy.TojiContainers.byId(id) : null;
}

function isOnionHost(uri) {
  try {
    return /\.onion$/i.test(uri.host);
  } catch {
    return false;
  }
}

function onionListener(win) {
  return {
    onStateChange(browser, webProgress, request, flags) {
      if (
        !webProgress?.isTopLevel ||
        !(flags & Ci.nsIWebProgressListener.STATE_START) ||
        !(flags & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT)
      ) {
        return;
      }
      let uri = null;
      try {
        uri = request.QueryInterface(Ci.nsIChannel).URI;
      } catch {
        return;
      }
      const c = windowContainer(win);
      if (!c || c.egress === "tor" || !isOnionHost(uri)) {
        return;
      }
      // Only an address the user went to — typed into the omnibox (the browser's own
      // load) or a link they clicked — moves the window. A page can't send the whole
      // window to Tor by itself; its .onion load just fails, as any direct one does.
      const loadInfo = request.loadInfo;
      const userMeant =
        loadInfo?.triggeringPrincipal?.isSystemPrincipal || loadInfo?.hasValidUserGestureActivation;
      if (!userMeant) {
        return;
      }
      // A hidden service only resolves through tor: move the window there.
      browser.stop();
      lazy.TojiWindows.toggleTor(win, { load: uri.spec, from: browser });
    },
  };
}

export const TojiTorUI = {
  initWindow(win) {
    win.gBrowser.addTabsProgressListener(onionListener(win));
  },

  /** Re-reads the window's container (after it is bound or switched): a Tor window starts tor. */
  refresh(win) {
    const c = windowContainer(win);
    if (c?.egress === "tor" && !lazy.TojiTor.isReady() && !lazy.TojiTor.isStarting()) {
      if (Services.prefs.getBoolPref("toji.tor.autostart", true)) {
        lazy.TojiTor.start();
      }
    }
  },
};
