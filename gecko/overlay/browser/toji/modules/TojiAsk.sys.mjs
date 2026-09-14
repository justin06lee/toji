/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI answer pages. Shift+Enter in the address bar, the wand beside it, or the
// start page hands a question to the model, which builds a page that streams
// in with its sources.
//
// The page is served by Toji's agent server, but the tab shows
// toji://ask?q=<question>: a protocol handler registered here turns that into a
// channel to the server's stream (token included), with the toji: address as
// the document's URL. So the token never reaches the address bar or history,
// the page lives in an ordinary content process inside the window's container,
// and web pages can't link to it (the scheme is dangerous-to-load).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
});

// Browsers (by browserId) whose next answer load skips the saved page: a reload asks
// the model again. Kept here, never in the address, so Back, Forward, a duplicated tab
// or a restored session show the saved answer instead of paying for a new one.
const freshBrowsers = new Set();

function browserIdOf(loadInfo) {
  try {
    return (loadInfo.targetBrowsingContext ?? loadInfo.browsingContext)?.top?.browserId ?? 0;
  } catch {
    return 0;
  }
}

// Whether the Toji plan stands between a question and its answer. A "no" is kept for
// a minute (asking again is instant); a "yes" is checked every time, so choosing a
// backend on the plans page takes effect at once.
const CLEAR_FOR_MS = 60000;
let clearUntil = 0;

async function needsPlan() {
  if (Date.now() < clearUntil) {
    return false;
  }
  if (!(await lazy.TojiAgentServer.whenReady(10000))) {
    return false;
  }
  try {
    const agents = await (await lazy.TojiAgentServer.fetch("/api/agents")).json();
    const needed = agents?.choice === "toji" && !agents?.toji?.active;
    if (!needed) {
      clearUntil = Date.now() + CLEAR_FOR_MS;
    }
    return needed;
  } catch {
    return false;
  }
}

function errorChannel(uri, loadInfo, message) {
  const html = `<!doctype html><meta charset="utf-8"><title>Toji</title><body style="font:15px -apple-system,sans-serif;margin:48px;color:#737373">${message}</body>`;
  const channel = Services.io.newChannelFromURIWithLoadInfo(
    Services.io.newURI(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
    loadInfo
  );
  channel.originalURI = uri;
  return channel;
}

const NOT_FOUND = "Toji doesn't know that page.";
const NO_SERVER = "Toji's agent server isn't running yet. Reload in a moment.";
// The agent server's address (never its token), for content processes.
const SERVER_KEY = "toji:agent-server-url";

/**
 * The channel behind a toji: address. The parent opens it, with the token; the
 * tab's content process then builds the same channel without the token, as the
 * child it attaches to the parent's (it sends no request of its own, and one
 * that did would be refused for want of the token).
 */
function channelFor(uri, loadInfo, base, token, fresh = false) {
  if (uri.host !== "ask") {
    return errorChannel(uri, loadInfo, NOT_FOUND);
  }
  if (!base) {
    return errorChannel(uri, loadInfo, NO_SERVER);
  }
  const params = new URLSearchParams(uri.query);
  const stream = new URLSearchParams({ q: params.get("q") ?? "" });
  if (token) {
    stream.set("token", token);
  }
  if (fresh) {
    stream.set("fresh", "1");
  }
  const target = Services.io.newURI(`${base}/api/page/stream?${stream}`);
  const channel = Services.io.newChannelFromURIWithLoadInfo(target, loadInfo);
  channel.originalURI = uri;
  return channel;
}

class AskProtocol {
  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
  scheme = "toji";

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    const info = lazy.TojiAgentServer.info();
    // The content process builds its twin of this channel next, from the same
    // address; flushed now, the server's address reaches it before it asks.
    const shared = Services.ppmm.sharedData;
    if (info) {
      shared.set(SERVER_KEY, info.url);
    } else {
      shared.delete(SERVER_KEY);
    }
    shared.flush();
    const fresh = freshBrowsers.delete(browserIdOf(loadInfo));
    return channelFor(uri, loadInfo, info?.url, info?.token, fresh);
  }
}

const PROTOCOL_FLAGS =
  Ci.nsIProtocolHandler.URI_NORELATIVE |
  Ci.nsIProtocolHandler.URI_NOAUTH |
  Ci.nsIProtocolHandler.URI_DANGEROUS_TO_LOAD |
  Ci.nsIProtocolHandler.URI_NON_PERSISTABLE;

// Loaded into every content process by init().
const PROCESS_SCRIPT = "chrome://toji/content/ask-process.js";

/**
 * toji: in a content process. A runtime-registered scheme exists only in the
 * process that registered it; a content process that doesn't know toji: gives
 * it the unknown-scheme flags (URI_DOES_NOT_RETURN_DATA), so its docshell
 * treats a navigation as another app's protocol and no page ever loads.
 *
 * Registered here, toji: gets its real flags, and this handler builds the
 * content side of each load: after the parent opens the real channel
 * (AskProtocol), the tab's process makes a matching child channel for the same
 * address and attaches it to the parent's. The child is built without the
 * token, from the server address the parent shares.
 */
class ContentAskProtocol {
  QueryInterface = ChromeUtils.generateQI(["nsIProtocolHandler"]);
  scheme = "toji";

  allowPort() {
    return false;
  }

  newChannel(uri, loadInfo) {
    return channelFor(uri, loadInfo, Services.cpmm.sharedData.get(SERVER_KEY), null);
  }
}

/** The toji:// channel's real destination, for the proxy filter's loopback exemption. */
export function isAskChannel(channel) {
  try {
    return channel.originalURI?.scheme === "toji";
  } catch {
    return false;
  }
}


let registered = false;

export const TojiAsk = {
  init() {
    if (registered) {
      return;
    }
    registered = true;
    Services.io.registerProtocolHandler("toji", new AskProtocol(), PROTOCOL_FLAGS, -1);
    // Content processes need the scheme too, now and in every later process.
    Services.ppmm.loadProcessScript(PROCESS_SCRIPT, true);
  },

  /** In each content process, from the process script: toji:'s flags there. */
  initContentProcess() {
    if (Services.appinfo.processType === Services.appinfo.PROCESS_TYPE_DEFAULT) {
      return;
    }
    try {
      Services.io.registerProtocolHandler("toji", new ContentAskProtocol(), PROTOCOL_FLAGS, -1);
    } catch (e) {
      if (e.result !== Cr.NS_ERROR_FACTORY_EXISTS) {
        throw e;
      }
    }
  },

  /**
   * Opens an answer page for `query` in `browser`; `fresh` asks the model again
   * rather than showing the saved answer. With the Toji plan and no subscription,
   * opens the plans page instead, carrying the question.
   */
  async ask(browser, query, { fresh = false } = {}) {
    const q = String(query ?? "").trim();
    if (!q || !browser) {
      return;
    }
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    if (await needsPlan()) {
      browser.loadURI(Services.io.newURI(`about:plans?q=${encodeURIComponent(q)}`), {
        triggeringPrincipal: system,
      });
      return;
    }
    const url = `toji://ask?q=${encodeURIComponent(q)}`;
    if (fresh) {
      this.markFresh(browser);
      // The same question again: a reload, not another entry in the tab's history.
      if (browser.currentURI?.spec === url) {
        browser.reload();
        return;
      }
    }
    browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: system });
  },

  /** The next answer page this browser loads (a reload) is asked of the model again. */
  markFresh(browser) {
    if (browser?.browserId) {
      freshBrowsers.add(browser.browserId);
      // A reload that never becomes an answer page (stopped, gone elsewhere, tab
      // closed) must not leave the mark for a later browser with the same id.
      const id = browser.browserId;
      const tab = browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser);
      tab?.addEventListener("TabClose", () => freshBrowsers.delete(id), { once: true });
    }
  },
};
