/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's startup, run from the browser-before-ui-startup category (see
// Toji.manifest) before the first window exists.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiAgent: "resource:///modules/toji/TojiAgent.sys.mjs",
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
  TojiMigrate: "resource:///modules/toji/TojiMigrate.sys.mjs",
  TojiAsk: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiBugReport: "resource:///modules/toji/TojiBugReport.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiPages: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiProxy: "resource:///modules/toji/TojiProxy.sys.mjs",
  TojiFirefoxUI: "resource:///modules/toji/TojiFirefoxUI.sys.mjs",
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
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

// The tab layout was Firefox's vertical-tabs pref before the shell drew Toji's own;
// it is Toji's pref now, and Firefox's vertical tabs stay off.
function migrateLayout() {
  const p = Services.prefs;
  if (p.prefHasUserValue("sidebar.verticalTabs")) {
    if (!p.prefHasUserValue("toji.layout")) {
      p.setStringPref("toji.layout", p.getBoolPref("sidebar.verticalTabs", false) ? "side" : "top");
    }
    p.clearUserPref("sidebar.verticalTabs");
  }
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
    lazy.TojiContainers.ensureLoaded();
    // Nothing can load in an ephemeral container before a window exists, and the
    // wipe (cookies, cache, quota storage) is a safety net for a crash: off the
    // startup path, like the WebRTC blocker (webrtcUI is not a small module).
    Services.tm.idleDispatchToMainThread(() => {
      try {
        lazy.webrtcUI.addPeerConnectionBlocker(blockPeerConnections);
      } catch (e) {
        console.error("[toji] webrtc blocker", e);
      }
      lazy.TojiContainers.wipeEphemeral().catch(e =>
        console.error("[toji] wiping ephemeral containers failed", e)
      );
    }, 2000);
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
      migrateLayout();
      lazy.TojiFirefoxUI.init();
      lazy.TojiShell.init();
    } catch (e) {
      console.error("[toji] shell", e);
    }
    // The agent server starts on first use (every consumer goes through
    // whenReady), not at launch: a session that never asks the AI anything keeps
    // no second process. toji.agent.autostart brings the warm start back. After
    // the Electron app, its agent server data moves in before the server can
    // start (TojiMigrate; the server waits for it); the rest of the move carries
    // on in the background.
    lazy.TojiMigrate.run().then(() => {
      if (Services.prefs.getBoolPref("toji.agent.autostart", false)) {
        Services.tm.idleDispatchToMainThread(() => lazy.TojiAgentServer.start(), 3000);
      }
    });
    Services.tm.idleDispatchToMainThread(() => lazy.TojiBugReport.prune(), 10000);
  },
};
