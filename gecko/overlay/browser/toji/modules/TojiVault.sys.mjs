/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Toji's password vault. Firefox's own password manager is locked off
// (toji.cfg): it has no notion of containers and would offer a Work login in
// Personal.
//
//  - At rest: <profile>/toji-vault.json holds only ciphertext, encrypted with a
//    key kept in the macOS Keychain ("Toji Encrypted Storage", via OSKeyStore).
//    A vault that can't be decrypted is never overwritten.
//  - Scoped per container, and a secret is released only for the exact origin
//    it was saved on, re-checked in the page before the fill.
//  - Nothing hands a password to Toji's pages or to the agent: they get
//    metadata and may ask for a fill by id.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "VaultLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/vault.sys.mjs")
);

const FILE_NAME = "toji-vault.json";
const GENERATED_TTL_MS = 15 * 60 * 1000;
const KEY_PATH =
  "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z";

function log(...args) {
  console.log("[toji:vault]", ...args);
}

function containerOfBrowser(browser) {
  const uc = browser?.browsingContext?.originAttributes?.userContextId ?? 0;
  const c = uc ? lazy.TojiContainers.byUserContextId(uc) : null;
  // A hold-to-Tor window saves under its profile, as the Electron app did.
  return c ? (c.baseId ?? c.id) : null;
}

function originOfBrowser(browser) {
  return lazy.VaultLib.originOf(browser?.currentURI?.spec ?? "");
}


class Vault {
  #entries = null;
  #broken = null;
  #loading = null;
  /** browser -> a submitted login waiting on autosave or the user */
  #pending = new WeakMap();
  /** browser -> the page's last login-form report */
  #forms = new WeakMap();
  #generated = [];

  get path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  async #load() {
    if (this.#entries) {
      return this.#entries;
    }
    if (this.#broken) {
      throw this.#broken;
    }
    this.#loading ??= (async () => {
      if (!(await IOUtils.exists(this.path))) {
        this.#entries = [];
        return this.#entries;
      }
      try {
        const data = await IOUtils.readJSON(this.path);
        const plain = await lazy.OSKeyStore.decrypt(data.cipher, "toji_vault");
        this.#entries = lazy.VaultLib.parseEntries(plain);
      } catch (e) {
        // Never replaced with an empty vault: the next write would destroy
        // every saved password.
        log("unreadable, refusing to overwrite", e);
        this.#broken = new Error("The vault could not be decrypted.");
        throw this.#broken;
      }
      return this.#entries;
    })().finally(() => (this.#loading = null));
    return this.#loading;
  }

  async #persist() {
    if (this.#broken) {
      throw this.#broken;
    }
    const cipher = await lazy.OSKeyStore.encrypt(
      JSON.stringify({ version: 1, entries: this.#entries ?? [] })
    );
    await IOUtils.writeJSON(
      this.path,
      { version: 1, cipher },
      { tmpPath: `${this.path}.tmp` }
    );
    await IOUtils.setPermissions(this.path, 0o600).catch(() => {});
  }

  async status() {
    try {
      const entries = await this.#load();
      return { available: true, count: entries.length };
    } catch (e) {
      return { available: false, count: 0, error: e.message };
    }
  }

  async list(containerId = null) {
    return lazy.VaultLib.list(await this.#load(), containerId);
  }

  /** Entries that may be offered on this tab's page, in its container. */
  async matches(browser) {
    return lazy.VaultLib.matchesFor(
      await this.#load(),
      browser.currentURI?.spec ?? "",
      containerOfBrowser(browser)
    );
  }

  /** Fills one entry into this tab's page; false when refused. */
  async fill(browser, id) {
    const origin = originOfBrowser(browser);
    const secret = lazy.VaultLib.secretFor(
      await this.#load(),
      id,
      browser.currentURI?.spec ?? "",
      containerOfBrowser(browser)
    );
    if (!secret || !origin) {
      return false;
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("TojiVault");
    if (!actor) {
      return false;
    }
    return !!(await actor.sendQuery("fill", { ...secret, origin }));
  }

  async save(draft) {
    const entries = await this.#load();
    this.#entries = lazy.VaultLib.upsert(
      entries,
      draft,
      new Date().toISOString(),
      () => crypto.randomUUID()
    );
    await this.#persist();
    return true;
  }

  /** An import: one write for many rows; malformed rows are skipped. */
  async saveMany(drafts) {
    let entries = await this.#load();
    let stored = 0;
    const now = new Date().toISOString();
    for (const draft of drafts) {
      try {
        entries = lazy.VaultLib.upsert(entries, draft, now, () => crypto.randomUUID());
        stored++;
      } catch {}
    }
    if (stored) {
      this.#entries = entries;
      await this.#persist();
    }
    return stored;
  }

  async remove(id) {
    const entries = await this.#load();
    const next = entries.filter(e => e.id !== id);
    if (next.length === entries.length) {
      return false;
    }
    this.#entries = next;
    await this.#persist();
    return true;
  }

  generate(length = 20) {
    const password = lazy.VaultLib.generatePassword(length);
    const now = Date.now();
    this.#generated = this.#generated
      .filter(g => now - g.at < GENERATED_TTL_MS)
      .slice(-31);
    this.#generated.push({ password, at: now });
    return password;
  }

  // --- From the page (TojiVaultParent) --------------------------------------

  /** A page reported whether it has a login form (and keeps reporting). */
  async formReport(browser, report) {
    this.#forms.set(browser, report);
    const pending = this.#pending.get(browser);
    if (pending?.watching) {
      const verdict = lazy.VaultLib.autosaveVerdict(report, {
        submittedUrl: pending.url,
        elapsedMs: Date.now() - pending.at,
      });
      if (verdict === "save") {
        await this.commit(browser);
      } else if (verdict === "ask") {
        this.#stopWatching(pending);
        this.#showBubble(browser, pending);
      }
    }
    this.#updateKeyButton(browser);
  }

  /** A sign-in was submitted. The origin comes from the page we know, not the message. */
  async captured(browser, { username, password }) {
    const url = browser.currentURI?.spec ?? "";
    const containerId = containerOfBrowser(browser);
    let status;
    try {
      status = lazy.VaultLib.captureStatus(await this.#load(), {
        url,
        username,
        password,
        containerId,
      });
    } catch {
      return;
    }
    if (status === "ignore" || status === "same") {
      return;
    }
    const pending = {
      origin: lazy.VaultLib.originOf(url),
      url,
      username,
      password,
      containerId,
      status,
      at: Date.now(),
      watching: false,
      timer: null,
    };
    this.#dropPending(browser);
    this.#pending.set(browser, pending);
    // A password Toji generated a moment ago is stored at once — silently when logins
    // save themselves, with a "saved" note otherwise (as in the Electron app).
    if (this.#generated.some(g => g.password === password && Date.now() - g.at < GENERATED_TTL_MS)) {
      await this.commit(browser, Services.prefs.getBoolPref("toji.vault.autosave", true) ? null : "saved");
      return;
    }
    if (Services.prefs.getBoolPref("toji.vault.autosave", true)) {
      pending.watching = true;
      pending.timer = setTimeout(() => this.commit(browser), lazy.VaultLib.AUTOSAVE_TIMEOUT_MS);
    } else {
      this.#showBubble(browser, pending);
    }
  }

  async commit(browser, shownStatus = null) {
    const pending = this.#pending.get(browser);
    if (!pending) {
      return false;
    }
    this.#stopWatching(pending);
    try {
      await this.save({
        origin: pending.origin,
        username: pending.username,
        password: pending.password,
        containerId: pending.containerId,
      });
    } catch (e) {
      pending.error = e.message;
      this.#showBubble(browser, pending);
      return false;
    }
    this.#pending.delete(browser);
    if (shownStatus) {
      this.#showBubble(browser, { ...pending, status: shownStatus, password: null });
    } else {
      this.#hideBubble(browser);
    }
    this.#updateKeyButton(browser);
    return true;
  }

  dismiss(browser) {
    this.#dropPending(browser);
    this.#hideBubble(browser);
  }

  #stopWatching(pending) {
    pending.watching = false;
    clearTimeout(pending.timer);
  }

  #dropPending(browser) {
    const pending = this.#pending.get(browser);
    if (pending) {
      this.#stopWatching(pending);
      this.#pending.delete(browser);
    }
  }

  forget(browser) {
    this.#dropPending(browser);
    this.#forms.delete(browser);
  }

  // --- The shell's key button and save bubble ------------------------------------

  initWindow(win) {
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      const browser = win.gBrowser.selectedBrowser;
      this.#updateKeyButton(browser);
      const pending = this.#pending.get(browser);
      if (pending && !pending.watching) {
        this.#showBubble(browser, pending);
      } else {
        lazy.TojiShell.vaultPrompt(browser, null);
      }
    });
    win.gBrowser.tabContainer.addEventListener("TabClose", e => this.forget(e.target.linkedBrowser));
  }

  /** The logins the key button offers on this tab's page: none without a login form on it. */
  async #updateKeyButton(browser) {
    const form = this.#forms.get(browser);
    const sameUrl = form?.url && form.url === browser?.currentURI?.spec;
    const matches = form?.hasLogin && sameUrl ? await this.matches(browser).catch(() => []) : [];
    lazy.TojiShell.vaultMatches(browser, matches);
  }

  #hideBubble(browser) {
    lazy.TojiShell.vaultPrompt(browser, null);
  }

  #showBubble(browser, pending) {
    const win = browser.ownerDocument.defaultView;
    if (!win?.gBrowser || win.gBrowser.selectedBrowser !== browser) {
      return;
    }
    lazy.TojiShell.vaultPrompt(browser, {
      origin: pending.origin,
      username: pending.username,
      containerId: pending.containerId,
      status: pending.status,
      error: pending.error,
    });
  }
}

export const TojiVault = new Vault();

/** The agent's two credential tools; see TojiAgent. */
export const TojiVaultForAgent = {
  matches: browser => TojiVault.matches(browser),
  fill: (browser, id) => TojiVault.fill(browser, id),
};

let registered = false;

export function initVault() {
  if (registered) {
    return;
  }
  registered = true;
  ChromeUtils.registerWindowActor("TojiVault", {
    parent: { esModuleURI: "resource:///modules/toji/actors/TojiVaultParent.sys.mjs" },
    child: {
      esModuleURI: "resource:///modules/toji/actors/TojiVaultChild.sys.mjs",
      events: {
        DOMContentLoaded: {},
        pageshow: {},
        submit: { capture: true, mozSystemGroup: true },
        click: { capture: true, mozSystemGroup: true },
      },
    },
    allFrames: false,
    messageManagerGroups: ["browsers"],
  });
}
