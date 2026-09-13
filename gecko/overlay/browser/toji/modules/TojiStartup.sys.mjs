/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's startup, run from the browser-before-ui-startup category (see
// Toji.manifest) before the first window exists.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  TojiAgent: "resource:///modules/toji/TojiAgent.sys.mjs",
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
  TojiMigrate: "resource:///modules/toji/TojiMigrate.sys.mjs",
  TojiAsk: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiPages: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiProxy: "resource:///modules/toji/TojiProxy.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
  TojiVaultForAgent: "resource:///modules/toji/TojiVault.sys.mjs",
  initVault: "resource:///modules/toji/TojiVault.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

/**
 * No WebRTC in Tor containers: tor carries no UDP, and Firefox can't send a
 * peer connection through a per-container SOCKS proxy, so the page is refused
 * rather than allowed to talk directly. Unknown containers are refused too. A
 * blocker that throws counts as "allow" in Firefox, so this one never throws.
 */
function blockPeerConnections(params) {
  try {
    const match = /\^.*\buserContextId=(\d+)/.exec(params?.origin ?? "");
    const userContextId = match ? Number(match[1]) : 0;
    if (!userContextId) {
      return "allow";
    }
    const c = lazy.TojiContainers.byUserContextId(userContextId);
    return !c || c.egress === "tor" ? "deny" : "allow";
  } catch {
    return "deny";
  }
}

function createWidgets() {
  lazy.CustomizableUI.createWidget({
    id: "toji-profile-button",
    type: "button",
    label: "Profile",
    tooltiptext: "Profile",
    defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
    onCommand(event) {
      const win = event.target.ownerDocument.defaultView;
      lazy.TojiWindows.showProfileMenu(win, event.target);
    },
  });
}

// Toji's light/dark toggle. Firefox's own look follows the system colour scheme,
// and pages' prefers-color-scheme follows the browser (content-override stays
// "auto"), so overriding the system scheme drives both at once.
const THEME_PREF = "toji.theme";

function applyTheme() {
  const dark = Services.prefs.getStringPref(THEME_PREF, "light") === "dark";
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", dark ? 1 : 0);
}

export const TojiStartup = {
  init() {
    applyTheme();
    Services.prefs.addObserver(THEME_PREF, applyTheme);
    // The proxy filter goes in first: nothing may load in a Tor container
    // before its route is enforced.
    lazy.TojiProxy.init();
    lazy.webrtcUI.addPeerConnectionBlocker(blockPeerConnections);
    lazy.TojiContainers.ensureLoaded();
    lazy.TojiContainers.wipeEphemeral().catch(e =>
      console.error("[toji] wiping ephemeral containers failed", e)
    );
    try {
      lazy.TojiPages.init();
      lazy.TojiAsk.init();
    } catch (e) {
      console.error("[toji] pages", e);
    }
    try {
      lazy.TojiAgent.init();
      lazy.initVault();
      lazy.TojiAgent.vault = lazy.TojiVaultForAgent;
    } catch (e) {
      console.error("[toji] agent/vault", e);
    }
    try {
      createWidgets();
    } catch (e) {
      console.error("[toji] widgets", e);
    }
    // The agent server isn't needed for the first paint; start it when idle.
    // After the Electron app, its agent server data moves in before the server
    // starts (TojiMigrate); the rest of the move carries on in the background.
    lazy.TojiMigrate.run().then(() =>
      Services.tm.idleDispatchToMainThread(() => lazy.TojiAgentServer.start(), 3000)
    );
    Services.tm.idleDispatchToMainThread(() => lazy.TojiBugReport.prune(), 10000);
  },
};
