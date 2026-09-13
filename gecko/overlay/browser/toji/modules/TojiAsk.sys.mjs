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

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
// lucide WandSparkles (the wand is the one sparkle-family icon Toji keeps).
const WAND_PATHS = [
  "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72",
  "m14 7 3 3",
  "M5 6v4",
  "M19 14v4",
  "M10 2v2",
  "M7 8H3",
  "M21 16h-4",
  "M11 3H9",
];

function errorChannel(uri, loadInfo, message) {
  const html = `<!doctype html><meta charset="utf-8"><title>Toji</title><body style="font:15px -apple-system,sans-serif;margin:48px;color:#737373">${message}</body>`;
  const channel = Services.io.newChannelFromURIWithLoadInfo(
    Services.io.newURI(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
    loadInfo
  );
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
    if (uri.host !== "ask") {
      return errorChannel(uri, loadInfo, "Toji doesn't know that page.");
    }
    if (!info) {
      return errorChannel(uri, loadInfo, "Toji's agent server isn't running yet. Reload in a moment.");
    }
    const params = new URLSearchParams(uri.query);
    const q = params.get("q") ?? "";
    const stream = new URLSearchParams({ q, token: info.token });
    if (params.get("fresh") === "1") {
      stream.set("fresh", "1");
    }
    const target = Services.io.newURI(`${info.url}/api/page/stream?${stream}`);
    const channel = Services.io.newChannelFromURIWithLoadInfo(target, loadInfo);
    channel.originalURI = uri;
    return channel;
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

function wand(doc) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.classList.add("toji-icon");
  for (const d of WAND_PATHS) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

let registered = false;

export const TojiAsk = {
  init() {
    if (registered) {
      return;
    }
    registered = true;
    const P = Ci.nsIProtocolHandler;
    Services.io.registerProtocolHandler(
      "toji",
      new AskProtocol(),
      P.URI_NORELATIVE | P.URI_NOAUTH | P.URI_DANGEROUS_TO_LOAD | P.URI_NON_PERSISTABLE,
      -1
    );
  },

  /**
   * Opens an answer page for `query` in `browser`. With the Toji plan and no
   * subscription, opens the plans page instead, carrying the question.
   */
  async ask(browser, query, { fresh = false } = {}) {
    const q = String(query ?? "").trim();
    if (!q || !browser) {
      return;
    }
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    const info = await lazy.TojiAgentServer.whenReady(10000);
    if (info) {
      try {
        const res = await lazy.TojiAgentServer.fetch("/api/agents");
        const agents = await res.json();
        if (agents?.choice === "toji" && !agents?.toji?.active) {
          browser.loadURI(Services.io.newURI(`about:plans?q=${encodeURIComponent(q)}`), {
            triggeringPrincipal: system,
          });
          return;
        }
      } catch {}
    }
    const url = `toji://ask?q=${encodeURIComponent(q)}${fresh ? "&fresh=1" : ""}`;
    browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: system });
  },

  initWindow(win) {
    const doc = win.document;
    const urlbar = win.gURLBar;
    // Shift+Enter asks the model instead of navigating.
    urlbar?.inputField?.addEventListener(
      "keydown",
      e => {
        if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const value = urlbar.value;
          urlbar.handleRevert?.();
          urlbar.blur();
          this.ask(win.gBrowser.selectedBrowser, value);
        }
      },
      { capture: true }
    );
    const actions = doc.getElementById("page-action-buttons");
    const go = doc.getElementById("toji-go-button");
    if (actions && !doc.getElementById("toji-wand-button")) {
      const button = doc.createElementNS(XHTML_NS, "button");
      button.id = "toji-wand-button";
      button.type = "button";
      button.title = "Build a page with AI (Shift+Enter)";
      button.setAttribute("aria-label", "Build a page with AI");
      button.append(wand(doc));
      button.addEventListener("mousedown", e => e.stopPropagation());
      button.addEventListener("click", e => {
        e.stopPropagation();
        const value = urlbar.value;
        urlbar.handleRevert?.();
        this.ask(win.gBrowser.selectedBrowser, value);
      });
      actions.insertBefore(button, go ?? null);
    }
    // The address bar shows the question for an answer page, not the toji: URL.
    if (Array.isArray(win.gInitialPages) === false) {
      return;
    }
  },
};
