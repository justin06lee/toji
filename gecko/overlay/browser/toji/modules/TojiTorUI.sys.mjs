/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor in the window: the round Go button at the end of the address bar (a click
// goes, holding it 900 ms toggles Tor for the window), the thin status bar under
// the toolbar while a Tor window's tor is connecting or down, and .onion
// addresses switching a direct window to Tor on their own.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiTor: "resource:///modules/toji/TojiTor.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const HOLD_MS = 900;

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

function svg(doc, tag, attrs) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function goButton(win) {
  const doc = win.document;
  const button = doc.createElementNS(XHTML_NS, "button");
  button.id = "toji-go-button";
  button.type = "button";
  button.setAttribute("aria-label", "Go");
  const ring = svg(doc, "svg", { class: "toji-go-ring", viewBox: "0 0 28 28", "aria-hidden": "true" });
  ring.append(svg(doc, "circle", { cx: "14", cy: "14", r: "12.75", pathLength: "100" }));
  const arrow = svg(doc, "svg", { class: "toji-go-arrow", viewBox: "0 0 16 16", "aria-hidden": "true" });
  arrow.append(svg(doc, "path", { d: "M3 8h10M9 4l4 4-4 4" }));
  const onion = svg(doc, "svg", { class: "toji-go-onion", viewBox: "0 0 16 16", "aria-hidden": "true" });
  onion.append(
    svg(doc, "circle", { cx: "8", cy: "9", r: "5.5" }),
    svg(doc, "circle", { cx: "8", cy: "9", r: "3.2" }),
    svg(doc, "circle", { cx: "8", cy: "9", r: "1.1" }),
    svg(doc, "path", { d: "M8 3.5V1.5" })
  );
  button.append(ring, arrow, onion);

  let timer = null;
  let held = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    button.removeAttribute("holding");
  };
  const swallow = e => {
    e.stopPropagation();
  };
  // The urlbar focuses its input on mousedown; keep our clicks to ourselves.
  button.addEventListener("mousedown", swallow);
  button.addEventListener("pointerdown", e => {
    e.stopPropagation();
    if (e.button !== 0) {
      return;
    }
    held = false;
    const c = windowContainer(win);
    if (!c || (c.egress === "tor" && !c.temporary)) {
      return; // always-Tor profiles have nothing to toggle
    }
    button.setAttribute("holding", "true");
    timer = setTimeout(() => {
      timer = null;
      held = true;
      button.removeAttribute("holding");
      lazy.TojiWindows.toggleTor(win);
    }, HOLD_MS);
  });
  button.addEventListener("pointerup", cancel);
  button.addEventListener("pointerleave", cancel);
  button.addEventListener("click", e => {
    e.stopPropagation();
    if (held) {
      held = false;
      return;
    }
    win.gURLBar.handleCommand(e);
  });
  return button;
}

function statusBar(win) {
  const doc = win.document;
  const bar = doc.createElementNS(XHTML_NS, "div");
  bar.id = "toji-tor-status";
  bar.setAttribute("role", "status");
  const progress = doc.createElementNS(XHTML_NS, "div");
  progress.className = "toji-tor-progress";
  const offline = doc.createElementNS(XHTML_NS, "div");
  offline.className = "toji-tor-offline";
  const text = doc.createElementNS(XHTML_NS, "span");
  const retry = doc.createElementNS(XHTML_NS, "button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => lazy.TojiTor.start());
  offline.append(text, retry);
  bar.append(progress, offline);
  return bar;
}

function updateStatus(win) {
  const bar = win.document.getElementById("toji-tor-status");
  if (!bar) {
    return;
  }
  const c = windowContainer(win);
  const s = lazy.TojiTor.status;
  if (!c || c.egress !== "tor" || s.ready) {
    bar.removeAttribute("state");
    return;
  }
  if (s.state === "starting" || s.state === "bootstrapping") {
    bar.setAttribute("state", "connecting");
    bar.querySelector(".toji-tor-progress").style.width = `${Math.max(3, s.progress)}%`;
    bar.setAttribute("title", s.detail);
  } else {
    bar.setAttribute("state", "offline");
    bar.querySelector(".toji-tor-offline span").textContent =
      s.state === "error" ? `${c.name} is offline. ${s.detail}` : `${c.name} is offline.`;
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
      // A hidden service only resolves through tor: move the window there.
      browser.stop();
      lazy.TojiWindows.toggleTor(win, { load: uri.spec, from: browser });
    },
  };
}

let observing = false;

export const TojiTorUI = {
  initWindow(win) {
    const doc = win.document;
    const actions = doc.getElementById("page-action-buttons");
    if (actions && !doc.getElementById("toji-go-button")) {
      actions.append(goButton(win));
    }
    const toolbox = doc.getElementById("navigator-toolbox");
    if (toolbox && !doc.getElementById("toji-tor-status")) {
      toolbox.after(statusBar(win));
    }
    win.gBrowser.addTabsProgressListener(onionListener(win));
    updateStatus(win);
    if (!observing) {
      observing = true;
      lazy.TojiTor.onStatus(() => {
        for (const w of Services.wm.getEnumerator("navigator:browser")) {
          updateStatus(w);
        }
      });
    }
  },

  /** Re-reads the window's container (after it is bound or switched). */
  refresh(win) {
    updateStatus(win);
    const c = windowContainer(win);
    const button = win.document.getElementById("toji-go-button");
    if (button) {
      button.toggleAttribute("tor", c?.egress === "tor");
      button.toggleAttribute("locked", c?.egress === "tor" && !c?.temporary);
    }
    if (c?.egress === "tor" && !lazy.TojiTor.isReady() && !lazy.TojiTor.isStarting()) {
      if (Services.prefs.getBoolPref("toji.tor.autostart", true)) {
        lazy.TojiTor.start();
      }
    }
  },
};
