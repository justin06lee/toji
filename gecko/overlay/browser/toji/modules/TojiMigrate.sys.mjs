/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Phase 8: a one-time move of the Electron app's data into this browser. The
// Electron app kept its data in the folder the profiles now live in
// (~/Library/Application Support/Toji). On the first start that finds it, this
// brings over the agent server's data (settings, saved answer pages), the
// containers and browser settings, the bookmarks, and the password vault —
// decrypted with the Electron app's Keychain key, then kept in Toji's own vault.
// The Electron files are only read, never changed.
//
// Site data (cookies, sign-ins, site storage) doesn't move: Chromium and Gecko
// store it in incompatible forms.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiPageAPI: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
});
// gecko/lib bundles export plain functions, so this holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "MigrateLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/migrate.sys.mjs")
);

const DONE_PREF = "toji.migration.electron";
const REPORT_FILE = "toji-migration.json";
// The Electron app's safeStorage key in the macOS Keychain.
const KEYCHAIN = ["Toji Safe Storage", "Toji Key"];

function log(...args) {
  console.log("[toji:migrate]", ...args);
}

/**
 * Where the Electron data is, or null. Only a profile in Toji's own Profiles
 * folder looks: test and scratch profiles elsewhere must not pick up the user's
 * data (or ask the Keychain for it). TOJI_MIGRATE_FROM points a test at a copy.
 */
function sourceDir() {
  const override = Services.env.get("TOJI_MIGRATE_FROM");
  if (override) {
    return override;
  }
  const root = Services.dirsvc.get("UAppData", Ci.nsIFile).path;
  const profiles = PathUtils.join(root, "Profiles");
  return PathUtils.profileDir.startsWith(`${profiles}/`) ? root : null;
}

async function readJSON(path) {
  try {
    return JSON.parse(await IOUtils.readUTF8(path));
  } catch {
    return undefined;
  }
}

/** The agent server's folder, minus what this browser keeps elsewhere. */
async function copyAgentServerData(dir) {
  const from = PathUtils.join(dir, "data");
  const to = PathUtils.join(PathUtils.profileDir, "agent-server");
  const copied = [];
  let children = [];
  try {
    children = await IOUtils.getChildren(from);
  } catch {
    return { copied };
  }
  await IOUtils.makeDirectory(to, { ignoreExisting: true });
  for (const src of children) {
    const name = PathUtils.filename(src);
    // Bookmarks become Firefox bookmarks (below).
    if (name === "bookmarks.json") {
      continue;
    }
    const dst = PathUtils.join(to, name);
    if (await IOUtils.exists(dst)) {
      continue;
    }
    await IOUtils.copy(src, dst, { recursive: true });
    copied.push(name);
  }
  return { copied };
}

async function localStorageItems(dir) {
  const folder = PathUtils.join(dir, "Local Storage", "leveldb");
  let files = [];
  try {
    files = await IOUtils.getChildren(folder);
  } catch {
    return { items: {}, tables: 0 };
  }
  // Older logs first, so later writes win.
  const logs = files.filter(f => f.endsWith(".log")).sort();
  const store = new Map();
  for (const file of logs) {
    for (const [key, value] of lazy.MigrateLib.readLevelDbLog(await IOUtils.read(file))) {
      store.set(key, value);
    }
  }
  return {
    items: lazy.MigrateLib.electronLocalStorage(store),
    tables: files.filter(f => f.endsWith(".ldb")).length,
  };
}

async function migrateContainers(items) {
  const list = lazy.MigrateLib.electronContainers(items);
  if (!list.length) {
    return { count: 0 };
  }
  const saved = await lazy.TojiContainers.replaceAll(list);
  return { count: saved.length };
}

function setPref(name, value) {
  const P = Services.prefs;
  if (typeof value === "boolean" && P.getPrefType(name) === P.PREF_INT) {
    P.setIntPref(name, value ? 1 : 0);
  } else if (typeof value === "boolean") {
    P.setBoolPref(name, value);
  } else {
    P.setIntPref(name, value);
  }
}

/** Through the same code Settings uses, so each lands where Settings expects it. */
async function applySettings(s) {
  const applied = [];
  const viaSettings = {
    theme: s.theme,
    layout: s.layout,
    bookmarksBar: s.bookmarksBar,
    searchEngine: s.searchEngine,
    vaultAutosave: s.vaultAutosave,
    replay: s.replay,
  };
  for (const [key, value] of Object.entries(viaSettings)) {
    if (value === undefined) {
      continue;
    }
    try {
      await lazy.TojiPageAPI.setSetting([key, value]);
      applied.push(key);
    } catch (e) {
      log(`setting ${key}`, e);
    }
  }
  if (s.onboarded) {
    Services.prefs.setBoolPref("toji.onboarded", true);
    applied.push("onboarded");
  }
  if (s.agentMaxSteps) {
    setPref("toji.agent.maxSteps", s.agentMaxSteps);
    applied.push("agentMaxSteps");
  }
  if (typeof s.agentNoLimit === "boolean") {
    setPref("toji.agent.noLimit", s.agentNoLimit);
    applied.push("agentNoLimit");
  }
  return { applied };
}

/** The Electron bookmarks bar becomes the bookmarks toolbar; no address twice. */
async function migrateBookmarks(dir) {
  const list = lazy.MigrateLib.electronBookmarks(
    await readJSON(PathUtils.join(dir, "data", "bookmarks.json"))
  );
  if (!list.length) {
    return { count: 0, added: 0 };
  }
  const P = lazy.PlacesUtils;
  const fresh = [];
  for (const b of list) {
    if (!(await P.bookmarks.search({ url: b.url })).length) {
      fresh.push(b);
    }
  }
  if (fresh.length) {
    await P.bookmarks.insertTree({
      guid: P.bookmarks.toolbarGuid,
      children: fresh.map(b => ({ url: b.url, title: b.title })),
    });
  }
  return { count: list.length, added: fresh.length };
}

/** Resolves once the first browser window has finished starting. */
function firstWindowReady() {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  if (win?.gBrowserInit?.delayedStartupFinished) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const observer = () => {
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      resolve();
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  });
}

/**
 * The Electron app's safeStorage passphrase, through macOS's `security` tool.
 * Firefox's own Keychain call (ChromeMacOSLoginCrypto) is synchronous — even
 * when handed a passphrase it looks the item up first — so its prompt froze the
 * whole browser; `security`'s prompt leaves the browser running.
 */
async function electronPassphrase() {
  const proc = await lazy.Subprocess.call({
    command: "/usr/bin/security",
    arguments: ["find-generic-password", "-w", "-s", KEYCHAIN[0], "-a", KEYCHAIN[1]],
    stderr: "pipe",
  });
  let out = "";
  for (;;) {
    const chunk = await proc.stdout.readString();
    if (!chunk) {
      break;
    }
    out += chunk;
  }
  const { exitCode } = await proc.wait();
  if (exitCode !== 0) {
    // 44: no such item (errSecItemNotFound); anything else: refused or failed.
    throw new Error(exitCode === 44 ? "keychain-missing" : "keychain-denied");
  }
  return out.replace(/\n$/, "");
}

/** vault.bin: safeStorage ciphertext ("v10…") under the Electron app's Keychain key. */
async function migrateVault(dir) {
  const file = PathUtils.join(dir, "vault.bin");
  if (!(await IOUtils.exists(file))) {
    return { found: 0, added: 0 };
  }
  // The Keychain prompt comes with a window on screen, not during startup.
  await firstWindowReady();
  let passphrase;
  try {
    passphrase = await electronPassphrase();
  } catch (e) {
    log("keychain", e);
    return { found: 0, added: 0, error: e.message === "keychain-missing" ? "keychain-missing" : "keychain-denied" };
  }
  let plain;
  try {
    plain = await lazy.MigrateLib.safeStorageDecrypt(passphrase, await IOUtils.read(file));
  } catch (e) {
    log("decrypt", e);
    return { found: 0, added: 0, error: "undecryptable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return { found: 0, added: 0, error: "unreadable" };
  }
  const drafts = lazy.MigrateLib.electronVaultDrafts(parsed);
  const added = drafts.length ? await lazy.TojiVault.saveMany(drafts) : 0;
  return { found: drafts.length, added };
}

async function step(report, name, work) {
  try {
    report[name] = await work();
  } catch (e) {
    log(name, e);
    report[name] = { error: String(e?.message ?? e) };
  }
}

let started = null;

export const TojiMigrate = {
  /**
   * Starts the move if it's due. Resolves once the agent server's data is in
   * place (the server may start then); the rest — which may raise one Keychain
   * prompt — carries on in the background. Never rejects.
   */
  run() {
    if (started) {
      return started.early;
    }
    let early = Promise.resolve();
    let done = Promise.resolve(null);
    const dir = Services.prefs.getStringPref(DONE_PREF, "") ? null : sourceDir();
    if (dir) {
      const report = { at: new Date().toISOString(), from: dir };
      early = step(report, "agentServer", () => copyAgentServerData(dir));
      done = early
        .then(async () => {
          const { items, tables } = await localStorageItems(dir);
          report.localStorage = { keys: Object.keys(items).length, tablesSkipped: tables };
          await step(report, "containers", () => migrateContainers(items));
          await step(report, "settings", () => applySettings(lazy.MigrateLib.electronSettings(items)));
          await step(report, "bookmarks", () => migrateBookmarks(dir));
          await step(report, "vault", () => migrateVault(dir));
          await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, REPORT_FILE), report);
          // Done even if a part failed: the report says what, and a retry would
          // raise the same Keychain prompt at every start.
          Services.prefs.setStringPref(DONE_PREF, "done");
          log("done", JSON.stringify(report));
          return report;
        })
        .catch(e => {
          log(e);
          return null;
        });
    }
    started = { early: early.catch(() => {}), done };
    return started.early;
  },

  /** The whole move's report (null when there was nothing to move). */
  whenDone() {
    return started?.done ?? Promise.resolve(null);
  },
};
