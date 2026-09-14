/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Gives Toji's own pages window.toji: every method is a message to the parent
// (TojiPageAPI), every on<Event> a subscription. Nothing else from the browser
// is reachable through it.

/** window.toji method names -> parent API names (the same, bar a few). */
const METHODS = [
  "server",
  "containers",
  "saveContainers",
  "clearContainer",
  "windowContainer",
  "settings",
  "setSetting",
  "openTab",
  "openPage",
  "openAddons",
  "finishOnboarding",
  "navigate",
  "askAI",
  "torMode",
  "toggleTor",
  "bugReportAccount",
  "captureWindow",
  "submitBugReport",
  "attachBugReport",
  "revealBugReport",
  "closeReport",
  "replayClip",
  "openReport",
  "isDefaultBrowser",
  "setDefaultBrowser",
  "importBrowsers",
  "importBrowser",
  "importBookmarksFile",
  "importPasswordsFile",
  "openFullDiskAccess",
  "vaultStatus",
  "vaultList",
  "vaultDelete",
  "vaultSave",
  "vaultGenerate",
  "torStatus",
  "torStart",
  "torStop",
  "torNewCircuit",
];

/** window.toji.on<Name> -> event topic. */
const EVENTS = {
  onContainersChanged: "containers",
  onSettingsChanged: "settings",
  onTorStatus: "tor",
};

export class TojiPageChild extends JSWindowActorChild {
  #listeners = new Map();

  handleEvent(event) {
    if (event.type === "DOMDocElementInserted") {
      this.#expose();
    }
  }

  #expose() {
    const win = this.contentWindow;
    if (!win || !this.document.nodePrincipal.isSystemPrincipal) {
      return;
    }
    const api = Cu.createObjectIn(win);
    for (const name of METHODS) {
      Cu.exportFunction((...args) => this.#call(win, name, args), api, {
        defineAs: name,
      });
    }
    for (const [name, topic] of Object.entries(EVENTS)) {
      Cu.exportFunction(callback => this.#subscribe(win, topic, callback), api, {
        defineAs: name,
      });
    }
    api.platform = Services.appinfo.OS === "Darwin" ? "darwin" : Services.appinfo.OS.toLowerCase();
    Object.defineProperty(Cu.waiveXrays(win), "toji", {
      value: api,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  #call(win, name, args) {
    return new win.Promise((resolve, reject) => {
      this.sendQuery("call", { name, args: JSON.parse(JSON.stringify(args ?? [])) }).then(
        value => resolve(Cu.cloneInto(value ?? null, win)),
        error => reject(new win.Error(String(error?.message ?? error)))
      );
    });
  }

  #subscribe(win, topic, callback) {
    if (!this.#listeners.has(topic)) {
      this.#listeners.set(topic, new Set());
      this.sendAsyncMessage("subscribe", { topic });
    }
    this.#listeners.get(topic).add(callback);
    return Cu.exportFunction(() => this.#listeners.get(topic)?.delete(callback), win);
  }

  receiveMessage({ name, data }) {
    if (name !== "event") {
      return;
    }
    const win = this.contentWindow;
    for (const callback of this.#listeners.get(data.topic) ?? []) {
      try {
        callback(Cu.cloneInto(data.payload, win));
      } catch (e) {
        console.error("[toji:page] listener", e);
      }
    }
  }
}
