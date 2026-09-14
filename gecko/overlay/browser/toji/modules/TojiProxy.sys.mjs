/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Per-container egress. One channel filter decides, from the channel's
// userContextId, whether a request goes through tor or the normal route.
//
// Fail closed: a Tor container's request never goes direct. While tor is on its
// way up the request waits for it; when tor is off, failed, or anything here goes
// wrong, the request gets a SOCKS proxy on a port nothing listens on and no
// failover, so it errors instead of leaking. Builds are configured with
// --disable-proxy-direct-failover and --enable-proxy-bypass-protection, and
// toji.cfg locks the prefs that could otherwise route around a proxy.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  isAskChannel: "resource:///modules/toji/TojiAsk.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiTor: "resource:///modules/toji/TojiTor.sys.mjs",
});

const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
  Ci.nsIProtocolProxyService
);
const RESOLVES_HOST = Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST;
// Seconds a failed proxy stays disabled; failover is null so there's nowhere
// else to go.
const FAILOVER_TIMEOUT = 5;
// How long a Tor container's request may wait for tor to finish bootstrapping.
const WAIT_FOR_TOR_MS = 60000;

function deadProxy(userContextId) {
  // Port 1 on loopback: nothing listens there, the connection is refused, and
  // with no failover proxy the channel fails.
  return pps.newProxyInfoWithAuth(
    "socks",
    "127.0.0.1",
    1,
    "toji-offline",
    "toji-offline",
    "",
    `toji-offline-${userContextId}`,
    RESOLVES_HOST,
    FAILOVER_TIMEOUT,
    null
  );
}

function torProxy(userContextId, socks) {
  return pps.newProxyInfoWithAuth(
    "socks",
    "127.0.0.1",
    socks.port,
    socks.username,
    socks.password,
    "",
    `toji-tor-${userContextId}`,
    RESOLVES_HOST,
    FAILOVER_TIMEOUT,
    null
  );
}

async function decide(channel, defaultProxy) {
  const userContextId = channel.loadInfo?.originAttributes?.userContextId ?? 0;
  if (!userContextId) {
    // Browser-internal requests (updates of add-on lists, CRLite, GMP) and
    // anything outside a container follow Firefox's own proxy settings.
    return defaultProxy;
  }
  let container;
  try {
    container = lazy.TojiContainers.byUserContextId(userContextId);
  } catch (e) {
    console.error("[toji:proxy] container lookup failed", e);
    return deadProxy(userContextId);
  }
  if (!container) {
    // A userContextId Toji doesn't know (a stale tab, an extension's
    // container): refuse rather than guess.
    return deadProxy(userContextId);
  }
  if (container.egress !== "tor") {
    return defaultProxy;
  }
  // Toji's own answer page (toji://ask) is served from the local agent server;
  // it is the one loopback load a Tor container may make. Everything else on
  // loopback goes to tor, which refuses it (allow_hijacking_localhost is locked
  // on so Firefox doesn't route loopback around the filter).
  if (lazy.isAskChannel(channel)) {
    return null;
  }
  const tor = lazy.TojiTor;
  if (!tor.isReady()) {
    // A Tor container's first request starts tor on demand (tests turn this
    // off to watch requests fail closed while tor is down).
    if (
      !tor.isStarting() &&
      tor.status.state !== "error" &&
      Services.prefs.getBoolPref("toji.tor.autostart", true)
    ) {
      tor.start();
    }
    await tor.whenReady(WAIT_FOR_TOR_MS);
  }
  const socks = tor.socksFor(container.torIdentity || container.id);
  return socks ? torProxy(userContextId, socks) : deadProxy(userContextId);
}

const filter = {
  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
  applyFilter(channel, defaultProxy, callback) {
    // A filter that throws makes Firefox keep the previous (direct) result, so
    // everything is wrapped and the callback always runs exactly once.
    let answered = false;
    const answer = proxy => {
      if (!answered) {
        answered = true;
        callback.onProxyFilterResult(proxy);
      }
    };
    // Every request of every page comes through here. Outside a Tor container the
    // answer is known at once, so it is given at once: no promise, no deferred start.
    try {
      const userContextId = channel.loadInfo?.originAttributes?.userContextId ?? 0;
      if (!userContextId) {
        answer(defaultProxy);
        return;
      }
      const container = lazy.TojiContainers.byUserContextId(userContextId);
      if (!container) {
        answer(deadProxy(userContextId));
        return;
      }
      if (container.egress !== "tor") {
        answer(defaultProxy);
        return;
      }
    } catch (e) {
      console.error("[toji:proxy]", e);
      const uc = channel.loadInfo?.originAttributes?.userContextId ?? 0;
      answer(uc ? deadProxy(uc) : defaultProxy);
      return;
    }
    decide(channel, defaultProxy).then(answer, e => {
      console.error("[toji:proxy]", e);
      const uc = channel.loadInfo?.originAttributes?.userContextId ?? 0;
      answer(uc ? deadProxy(uc) : defaultProxy);
    });
  },
};

let registered = false;

export const TojiProxy = {
  init() {
    if (registered) {
      return;
    }
    registered = true;
    // Position 0: run before any extension's proxy filter, so an add-on can
    // only see (and change) what Toji decided, never pre-empt it.
    pps.registerChannelFilter(filter, 0);
  },

  uninit() {
    if (registered) {
      pps.unregisterChannelFilter(filter);
      registered = false;
    }
  },

  // For tests: the decision for a synthetic channel.
  _decide: decide,
};
