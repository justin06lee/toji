/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Importing from other browsers. Bookmarks go into Firefox's bookmarks (Places):
// through Firefox's own migrator where it has one, or read by Toji for the
// Chromium-family browsers it doesn't know (Arc, Dia, Helium). Passwords never
// go to Firefox's password manager: Toji reads them from the browser's
// `Login Data`, decrypts them with Firefox's ChromeMacOSLoginCrypto (the key comes
// from the macOS keychain, which asks the user first), and stores them in its
// own vault under the chosen container. They are never returned to a page.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BookmarkHTMLUtils: "resource://gre/modules/BookmarkHTMLUtils.sys.mjs",
  ChromeMacOSLoginCrypto: "resource:///modules/ChromeMacOSLoginCrypto.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ImportLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/imports.sys.mjs")
);

/** Toji's browser ids -> Firefox migrator keys (macOS). */
const FIREFOX_MIGRATORS = {
  chrome: "chrome",
  brave: "brave",
  edge: "chromium-edge",
  vivaldi: "vivaldi",
  opera: "opera",
  chromium: "chromium",
  safari: "safari",
};

const LOGINS_QUERY =
  "SELECT origin_url, signon_realm, username_value, password_value FROM logins " +
  "WHERE blacklisted_by_user = 0 AND length(password_value) > 0 " +
  "ORDER BY date_last_used DESC, date_created DESC";

function home() {
  return Services.env.get("TOJI_IMPORT_HOME") || Services.env.get("HOME");
}

function appSupport() {
  return PathUtils.join(home(), "Library", "Application Support");
}

async function exists(path) {
  try {
    return await IOUtils.exists(path);
  } catch {
    return false;
  }
}

async function userDataDir(browser) {
  for (const dir of browser.dirs ?? []) {
    const full = PathUtils.join(appSupport(), ...dir.split("/"));
    if (
      (await exists(PathUtils.join(full, "Local State"))) ||
      (await exists(PathUtils.join(full, "Default")))
    ) {
      return full;
    }
  }
  return null;
}

async function profilesIn(dir) {
  let localState = null;
  try {
    localState = await IOUtils.readUTF8(PathUtils.join(dir, "Local State"));
  } catch {}
  let folders = [];
  try {
    folders = (await IOUtils.getChildren(dir)).map(p => PathUtils.filename(p));
  } catch {}
  const withData = new Set();
  for (const f of folders.filter(lazy.ImportLib.isProfileDir)) {
    if (
      (await exists(PathUtils.join(dir, f, "Bookmarks"))) ||
      (await exists(PathUtils.join(dir, f, "Login Data")))
    ) {
      withData.add(f);
    }
  }
  return lazy.ImportLib.chromiumProfiles(localState, folders, f => withData.has(f));
}

async function importBookmarksViaFirefox(key, profileDir) {
  const migrator = await lazy.MigrationUtils.getMigrator(key);
  if (!migrator) {
    return { count: 0, error: "missing" };
  }
  const profiles = (await migrator.getSourceProfiles()) ?? [null];
  const profile = profiles.find(p => !p || p.id === profileDir) ?? profiles[0];
  const types = lazy.MigrationUtils.resourceTypes.BOOKMARKS;
  const available = await migrator.getMigrateData(profile);
  if (!(available & types)) {
    return { count: 0, error: key === "safari" ? "needs-access" : "missing" };
  }
  await new Promise(resolve => {
    migrator.migrate(types, false, profile, (_type, _success) => resolve());
  });
  return { count: null };
}

async function importChromiumBookmarks(browser, profileDir, profileName) {
  const file = PathUtils.join(profileDir, "Bookmarks");
  if (!(await exists(file))) {
    return { count: 0 };
  }
  const items = lazy.ImportLib.parseChromiumBookmarks(await IOUtils.readUTF8(file));
  if (!items.length) {
    return { count: 0 };
  }
  const title = profileName && profileName !== "Default" ? `From ${browser.name} (${profileName})` : `From ${browser.name}`;
  const tree = lazy.ImportLib.bookmarkTree(items, title);
  const P = lazy.PlacesUtils;
  await P.bookmarks.insertTree({
    guid: P.bookmarks.unfiledGuid,
    children: [
      {
        type: P.bookmarks.TYPE_FOLDER,
        title: tree.title,
        children: tree.children.map(child =>
          "url" in child
            ? { url: child.url, title: child.title }
            : {
                type: P.bookmarks.TYPE_FOLDER,
                title: child.title,
                children: child.children.map(c => ({ url: c.url, title: c.title })),
              }
        ),
      },
    ],
  });
  return { count: items.length };
}

async function importChromiumPasswords(browser, profileDir, containerId) {
  const file = PathUtils.join(profileDir, "Login Data");
  if (!(await exists(file))) {
    return { found: 0, added: 0 };
  }
  let rows;
  try {
    rows = await lazy.MigrationUtils.getRowsFromDBWithoutLocks(file, "Toji password import", LOGINS_QUERY);
  } catch {
    return { found: 0, added: 0, error: "unreadable" };
  }
  // Read the rows first: a profile with nothing saved shouldn't raise a keychain dialog.
  if (!rows?.length) {
    return { found: 0, added: 0 };
  }
  let crypto = null;
  let denied = false;
  for (const [service, account] of browser.keychain ?? []) {
    try {
      crypto = new lazy.ChromeMacOSLoginCrypto(service, account);
      break;
    } catch (e) {
      if (!/not found|NS_ERROR_NOT_AVAILABLE/i.test(String(e?.message ?? e))) {
        denied = true;
      }
    }
  }
  if (!crypto) {
    return { found: 0, added: 0, error: denied ? "keychain-denied" : "keychain-missing" };
  }
  const drafts = [];
  let undecryptable = 0;
  for (const row of rows.slice(0, lazy.ImportLib.MAX_PASSWORDS)) {
    const origin = lazy.ImportLib.loginRowOrigin({
      origin_url: row.getResultByName("origin_url"),
      signon_realm: row.getResultByName("signon_realm"),
    });
    if (!origin) {
      continue;
    }
    let password;
    try {
      password = await crypto.decryptData(row.getResultByName("password_value"));
    } catch {
      undecryptable++;
      continue;
    }
    if (!password) {
      continue;
    }
    drafts.push({
      origin,
      username: row.getResultByName("username_value") || "",
      password,
      containerId: containerId || null,
    });
  }
  const added = drafts.length ? await lazy.TojiVault.saveMany(drafts) : 0;
  return { found: drafts.length, added, ...(undecryptable ? { undecryptable } : {}) };
}

function pickFile(win, title, filters) {
  return new Promise(resolve => {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, title, Ci.nsIFilePicker.modeOpen);
    for (const [label, pattern] of filters) {
      picker.appendFilter(label, pattern);
    }
    picker.open(result => resolve(result === Ci.nsIFilePicker.returnOK ? picker.file.path : null));
  });
}

export const TojiImport = {
  async detect() {
    const out = [];
    for (const browser of lazy.ImportLib.BROWSERS) {
      if (browser.kind === "safari") {
        const plist = PathUtils.join(home(), "Library", "Safari", "Bookmarks.plist");
        out.push({
          id: browser.id,
          name: browser.name,
          kind: browser.kind,
          available: await exists(plist),
          profiles: [{ dir: "", name: "Safari" }],
          passwords: false,
        });
        continue;
      }
      const dir = await userDataDir(browser);
      const profiles = dir ? await profilesIn(dir) : [];
      out.push({
        id: browser.id,
        name: browser.name,
        kind: browser.kind,
        available: profiles.length > 0,
        profiles,
        passwords: true,
      });
    }
    return out;
  },

  /** One profile of one browser: bookmarks into Places, passwords into the vault. */
  async importBrowser({ browser: id, profile = "Default", containerId = null }) {
    const browser = lazy.ImportLib.BROWSERS.find(b => b.id === id);
    if (!browser) {
      return { bookmarks: { items: [], count: 0 }, passwords: { found: 0, added: 0, error: "unknown-browser" } };
    }
    if (browser.kind === "safari") {
      let bookmarks;
      try {
        bookmarks = await importBookmarksViaFirefox("safari", null);
      } catch {
        bookmarks = { count: 0, error: "needs-access" };
      }
      return { bookmarks: { items: [], ...bookmarks }, passwords: { found: 0, added: 0, error: "unsupported" } };
    }
    const dir = await userDataDir(browser);
    if (!dir || !lazy.ImportLib.isProfileDir(profile)) {
      return { bookmarks: { items: [], count: 0, error: "missing" }, passwords: { found: 0, added: 0, error: "unreadable" } };
    }
    const profileDir = PathUtils.join(dir, profile);
    const profileName = (await profilesIn(dir)).find(p => p.dir === profile)?.name ?? profile;
    let bookmarks;
    try {
      bookmarks = FIREFOX_MIGRATORS[id]
        ? await importBookmarksViaFirefox(FIREFOX_MIGRATORS[id], profile)
        : await importChromiumBookmarks(browser, profileDir, profileName);
    } catch (e) {
      console.error("[toji:import] bookmarks", e);
      bookmarks = { count: 0, error: "unreadable" };
    }
    const passwords = await importChromiumPasswords(browser, profileDir, containerId).catch(e => {
      console.error("[toji:import] passwords", e);
      return { found: 0, added: 0, error: "unreadable" };
    });
    return { bookmarks: { items: [], ...bookmarks }, passwords };
  },

  async importBookmarksFile(win) {
    const path = await pickFile(win, "Import bookmarks", [["Bookmarks (HTML)", "*.html; *.htm"]]);
    if (!path) {
      return { canceled: true, bookmarks: [], count: 0 };
    }
    const count = await lazy.BookmarkHTMLUtils.importFromFile(path, { replace: false });
    return { canceled: false, bookmarks: [], count };
  },

  async importPasswordsFile(win, containerId) {
    const path = await pickFile(win, "Import passwords", [["Passwords (CSV)", "*.csv"]]);
    if (!path) {
      return { canceled: true, found: 0, added: 0, skipped: 0 };
    }
    let text;
    try {
      text = await IOUtils.readUTF8(path);
    } catch {
      return { canceled: false, found: 0, added: 0, skipped: 0, error: "unreadable" };
    }
    const { entries, skipped } = lazy.ImportLib.parsePasswordCsv(text);
    const status = await lazy.TojiVault.status();
    if (!status.available) {
      return { canceled: false, found: entries.length, added: 0, skipped, error: "no-vault" };
    }
    const added = await lazy.TojiVault.saveMany(
      entries.map(e => ({ ...e, containerId: containerId || null }))
    );
    return { canceled: false, found: entries.length, added, skipped };
  },

  openFullDiskAccess() {
    const uri = Services.io.newURI(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    );
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(uri);
  },
};
