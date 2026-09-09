'use strict';

// Importing from other browsers: bookmarks, saved passwords and profiles.
//
// This runs in the main process on purpose. Passwords decrypted here go straight into the
// vault and never cross IPC to the renderer (see the vault notes in main.cjs); bookmarks and
// profile names are plain data and are handed back for the renderer to file. Every read is
// best-effort: a browser that is missing, locked or unreadable yields nothing, with a reason
// the UI can put into words.
//
// Chromium-family browsers (Chrome, Brave, Edge, Arc, Dia, Helium, Chromium) share one
// on-disk layout: a user-data folder with a `Local State` JSON naming the profiles, and per
// profile a `Bookmarks` JSON and a `Login Data` SQLite database whose passwords are
// AES-128-CBC encrypted under a key the browser keeps in the macOS keychain, as
// "<Browser> Safe Storage". Safari keeps bookmarks in a property list, which macOS wrote
// until Sequoia and plutil can turn into JSON, and its passwords in the system keychain,
// which nothing but Apple's own apps may read — so Safari's passwords arrive through the CSV
// the Passwords app exports, and its bookmarks through Safari's HTML export where the plist
// is gone. Both file formats are read here too; they are the same for every browser.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** Caps per import, matching the bookmark store's own ceiling. */
const MAX_BOOKMARKS = 5000;
const MAX_PASSWORDS = 5000;

/**
 * Where each browser keeps its data, relative to ~/Library/Application Support, and the
 * keychain item its password key lives under (service, account). A browser may have moved
 * between releases, so each lists every folder it has used; the first that exists wins.
 */
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', kind: 'chromium', dirs: ['Google/Chrome'], keychain: [['Chrome Safe Storage', 'Chrome']] },
  { id: 'brave', name: 'Brave', kind: 'chromium', dirs: ['BraveSoftware/Brave-Browser'], keychain: [['Brave Safe Storage', 'Brave']] },
  { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', dirs: ['Microsoft Edge'], keychain: [['Microsoft Edge Safe Storage', 'Microsoft Edge']] },
  { id: 'arc', name: 'Arc', kind: 'chromium', dirs: ['Arc/User Data'], keychain: [['Arc Safe Storage', 'Arc']] },
  { id: 'dia', name: 'Dia', kind: 'chromium', dirs: ['Dia/User Data', 'Dia'], keychain: [['Dia Safe Storage', 'Dia']] },
  {
    id: 'helium',
    name: 'Helium',
    kind: 'chromium',
    dirs: ['net.imput.helium'],
    // Helium is a lightly rebranded Chromium; its key may sit under either name.
    keychain: [
      ['Helium Safe Storage', 'Helium'],
      ['Chromium Safe Storage', 'Chromium']
    ]
  },
  { id: 'chromium', name: 'Chromium', kind: 'chromium', dirs: ['Chromium'], keychain: [['Chromium Safe Storage', 'Chromium']] },
  { id: 'safari', name: 'Safari', kind: 'safari' }
];

const exists = (file) => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};

const appSupport = (home) => path.join(home, 'Library', 'Application Support');
const safariBookmarksFile = (home) => path.join(home, 'Library', 'Safari', 'Bookmarks.plist');

function chromiumUserDataDir(browser, home) {
  for (const dir of browser.dirs) {
    const full = path.join(appSupport(home), dir);
    if (exists(path.join(full, 'Local State')) || exists(path.join(full, 'Default'))) return full;
  }
  return null;
}

/** What a browser calls a profile: its display name, else the account, else the folder. */
function profileName(info, dir) {
  for (const key of ['name', 'gaia_name', 'user_name']) {
    const value = info && info[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return dir;
}

/**
 * The profiles in a Chromium user-data folder, as `Local State` lists them; when there is
 * no such list, whichever profile folders actually hold data. "Default" always comes first.
 */
function chromiumProfiles(userDataDir) {
  const profiles = [];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const cache = state && state.profile && state.profile.info_cache;
    if (cache && typeof cache === 'object') {
      for (const [dir, info] of Object.entries(cache)) profiles.push({ dir, name: profileName(info, dir) });
    }
  } catch {
    /* no Local State, or not JSON: fall through to the folders */
  }
  if (!profiles.length) {
    let entries = [];
    try {
      entries = fs.readdirSync(userDataDir);
    } catch {
      return [];
    }
    for (const dir of entries) {
      if (!/^(Default|Profile \d+)$/.test(dir)) continue;
      const full = path.join(userDataDir, dir);
      if (exists(path.join(full, 'Bookmarks')) || exists(path.join(full, 'Login Data'))) profiles.push({ dir, name: dir });
    }
  }
  return profiles.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir)));
}

/**
 * Every browser Toji can import from, with what it found. `available` means there is
 * something to read; Safari without its plist is listed anyway, so the UI can point at
 * the export route.
 */
function detectBrowsers({ home = os.homedir() } = {}) {
  return BROWSERS.map((browser) => {
    if (browser.kind === 'safari') {
      const file = safariBookmarksFile(home);
      return { id: browser.id, name: browser.name, kind: browser.kind, available: exists(file), profiles: [{ dir: '', name: 'Safari' }], passwords: false };
    }
    const dir = chromiumUserDataDir(browser, home);
    const profiles = dir ? chromiumProfiles(dir) : [];
    return { id: browser.id, name: browser.name, kind: browser.kind, available: profiles.length > 0, profiles, passwords: true };
  });
}

// --- Bookmarks ---------------------------------------------------------------

const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

function pushBookmark(out, title, url, folder) {
  if (out.length >= MAX_BOOKMARKS || !isWebUrl(url)) return;
  const name = typeof title === 'string' && title.trim() ? title.trim() : url;
  out.push({ title: name.slice(0, 300), url, ...(folder ? { folder } : {}) });
}

function walkChromium(node, folder, out) {
  if (!node || out.length >= MAX_BOOKMARKS) return;
  if (node.type === 'url') {
    pushBookmark(out, node.name, node.url, folder);
    return;
  }
  if (Array.isArray(node.children)) {
    const next = node.type === 'folder' && node.name ? node.name : folder;
    for (const child of node.children) walkChromium(child, next, out);
  }
}

/** The bookmarks in a Chromium profile's `Bookmarks` JSON, innermost folder attached. */
function readChromiumBookmarks(file) {
  const out = [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  const roots = (parsed && parsed.roots) || {};
  // Top-level containers (bar / other / synced) are locations, not folders the user named.
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = roots[key];
    if (root && Array.isArray(root.children)) for (const child of root.children) walkChromium(child, undefined, out);
  }
  return out;
}

const SAFARI_ROOTS = { BookmarksBar: 'Favorites', BookmarksMenu: undefined, 'com.apple.ReadingList': 'Reading List' };

function walkSafari(node, folder, out, depth) {
  if (!node || out.length >= MAX_BOOKMARKS) return;
  if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
    pushBookmark(out, node.URIDictionary && node.URIDictionary.title, node.URLString, folder);
    return;
  }
  if (!Array.isArray(node.Children)) return;
  // Safari's proxies (History, etc.) carry no children of their own; the root's Title is
  // a location, and one level down come the containers Safari names for itself.
  let next = folder;
  if (depth === 1) next = Object.prototype.hasOwnProperty.call(SAFARI_ROOTS, node.Title) ? SAFARI_ROOTS[node.Title] : node.Title;
  else if (depth > 1 && typeof node.Title === 'string' && node.Title) next = node.Title;
  for (const child of node.Children) walkSafari(child, next, out, depth + 1);
}

/** The bookmarks in Safari's Bookmarks.plist, once plutil has turned it into JSON. */
function parseSafariBookmarks(json) {
  const out = [];
  let parsed = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      return out;
    }
  }
  walkSafari(parsed, undefined, out, 0);
  return out;
}

function run(exec, command, args) {
  return new Promise((resolve, reject) => {
    exec(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(String(stderr || error.message || '').trim());
        err.code = error.code;
        reject(err);
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Safari's bookmarks. The plist is binary, so plutil converts it. ~/Library/Safari is
 * behind macOS privacy protection: without Full Disk Access the read fails with EPERM,
 * which surfaces as `needsAccess` so the UI can send the user to System Settings.
 */
async function readSafariBookmarks(file, { exec = execFile } = {}) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { bookmarks: [], error: 'missing' };
    return { bookmarks: [], error: 'needs-access' };
  }
  try {
    const json = await run(exec, 'plutil', ['-convert', 'json', '-o', '-', file]);
    return { bookmarks: parseSafariBookmarks(json) };
  } catch (error) {
    return { bookmarks: [], error: /not permitted|permission denied/i.test(error.message) ? 'needs-access' : 'unreadable' };
  }
}

// --- Passwords ---------------------------------------------------------------

/**
 * Chromium's macOS key derivation: the keychain secret through PBKDF2-SHA1 with the salt
 * "saltysalt" and 1003 rounds, to a 16-byte AES key.
 */
function deriveChromiumKey(secret) {
  return crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * One `password_value` cell. Encrypted cells start with "v10" and hold AES-128-CBC under
 * an IV of sixteen spaces; anything else is a legacy cell stored in the clear. Returns
 * null when the key does not fit.
 */
function decryptChromiumSecret(cell, key) {
  // SQLite hands blobs back as Uint8Array; Buffer views the same bytes.
  const blob = Buffer.isBuffer(cell) ? cell : cell instanceof Uint8Array ? Buffer.from(cell.buffer, cell.byteOffset, cell.byteLength) : null;
  if (!blob || !blob.length) return '';
  const prefix = blob.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The still-encrypted login rows in a profile's `Login Data`. The database is copied first:
 * the browser keeps it open, and SQLite will not hand a read-only handle to a file another
 * process is writing. Blocked sites ("never save for this site") are left out here.
 */
function loadLoginRows(file, sqlite = require('node:sqlite')) {
  const copy = path.join(os.tmpdir(), `toji-import-${crypto.randomUUID()}.sqlite`);
  fs.copyFileSync(file, copy);
  try {
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    try {
      return db
        .prepare(
          'SELECT origin_url, signon_realm, username_value, password_value FROM logins ' +
            'WHERE blacklisted_by_user = 0 AND length(password_value) > 0 ORDER BY date_last_used DESC, date_created DESC'
        )
        .all();
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

/** Decrypt loaded rows; non-web realms and rows the key cannot open are skipped. */
function decryptLoginRows(rows, key) {
  const out = [];
  let undecryptable = 0;
  for (const row of rows) {
    if (out.length >= MAX_PASSWORDS) break;
    const origin = isWebUrl(row.origin_url) ? row.origin_url : isWebUrl(row.signon_realm) ? row.signon_realm : null;
    if (!origin) continue;
    const password = decryptChromiumSecret(row.password_value, key);
    if (password === null) {
      undecryptable += 1;
      continue;
    }
    if (!password) continue;
    out.push({ origin, username: typeof row.username_value === 'string' ? row.username_value : '', password });
  }
  return { logins: out, undecryptable };
}

/** The saved logins in a profile's `Login Data`, decrypted. */
function readChromiumLogins(file, key, { sqlite } = {}) {
  return decryptLoginRows(loadLoginRows(file, sqlite), key);
}

/**
 * The browser's password key from the keychain, via the `security` tool. macOS asks the
 * user before handing it over; a refusal is a real answer, reported as 'denied'. Tries
 * each (service, account) the browser has been known to use before concluding 'missing'.
 */
async function keychainSecret(candidates, { exec = execFile } = {}) {
  let denied = false;
  for (const [service, account] of candidates) {
    try {
      const secret = (await run(exec, 'security', ['find-generic-password', '-w', '-s', service, '-a', account])).trim();
      if (secret) return { secret };
    } catch (error) {
      if (!/could not be found/i.test(error.message || '')) denied = true;
    }
  }
  return { error: denied ? 'denied' : 'missing' };
}

// --- The import itself -------------------------------------------------------

/**
 * Import one profile of one browser. Bookmarks come back for the caller to store; each
 * password is handed to `saveSecret` (the vault) and never returned. `passwords.error`
 * explains a skipped password import: 'keychain-denied', 'keychain-missing', 'unreadable',
 * or 'unsupported' for Safari. `bookmarks.error` covers Safari: 'missing', 'needs-access',
 * 'unreadable'.
 */
async function importFromBrowser({ browser: id, profile = 'Default', saveSecret, home = os.homedir(), exec = execFile, sqlite } = {}) {
  const browser = BROWSERS.find((b) => b.id === id);
  if (!browser) return { bookmarks: { items: [] }, passwords: { found: 0, added: 0, error: 'unknown-browser' } };

  if (browser.kind === 'safari') {
    const { bookmarks, error } = await readSafariBookmarks(safariBookmarksFile(home), { exec });
    return { bookmarks: { items: bookmarks, ...(error ? { error } : {}) }, passwords: { found: 0, added: 0, error: 'unsupported' } };
  }

  const dir = chromiumUserDataDir(browser, home);
  const profileDir = dir && /^(Default|Profile \d+)$/.test(profile) ? path.join(dir, profile) : null;
  if (!profileDir || !exists(profileDir)) return { bookmarks: { items: [], error: 'missing' }, passwords: { found: 0, added: 0, error: 'unreadable' } };

  const bookmarks = { items: exists(path.join(profileDir, 'Bookmarks')) ? readChromiumBookmarks(path.join(profileDir, 'Bookmarks')) : [] };

  const loginData = path.join(profileDir, 'Login Data');
  if (!exists(loginData)) return { bookmarks, passwords: { found: 0, added: 0 } };
  // Read the rows before asking the keychain: a profile with nothing saved should not put
  // a permission dialog in front of the user.
  let rows;
  try {
    rows = loadLoginRows(loginData, sqlite);
  } catch {
    return { bookmarks, passwords: { found: 0, added: 0, error: 'unreadable' } };
  }
  if (!rows.length) return { bookmarks, passwords: { found: 0, added: 0 } };
  if (typeof saveSecret !== 'function') return { bookmarks, passwords: { found: 0, added: 0, error: 'no-vault' } };

  const key = await keychainSecret(browser.keychain, { exec });
  if (key.error) return { bookmarks, passwords: { found: 0, added: 0, error: `keychain-${key.error}` } };

  const logins = decryptLoginRows(rows, deriveChromiumKey(key.secret));
  let added = 0;
  for (const login of logins.logins) {
    try {
      if (saveSecret(login)) added += 1;
    } catch {
      /* one bad row must not stop the rest */
    }
  }
  return { bookmarks, passwords: { found: logins.logins.length, added, ...(logins.undecryptable ? { undecryptable: logins.undecryptable } : {}) } };
}

// --- Files other browsers export ---------------------------------------------

/** RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

const CSV_COLUMNS = {
  url: ['url', 'login_uri', 'website', 'web site', 'site', 'hostname', 'origin'],
  username: ['username', 'user name', 'login_username', 'login', 'user', 'email'],
  password: ['password', 'login_password', 'pass'],
  title: ['title', 'name'],
  note: ['note', 'notes', 'comments', 'extra']
};

function csvColumnIndex(header, names) {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const index = lower.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Passwords from a CSV export — the Passwords app (Title, URL, Username, Password, Notes,
 * OTPAuth), Chrome (name, url, username, password, note), Firefox, Brave, Edge and most
 * managers share these column names. Rows without a website or a password are skipped.
 */
function parsePasswordCsv(text) {
  const rows = parseCsv(String(text || ''));
  if (rows.length < 2) return { entries: [], skipped: 0 };
  const header = rows[0];
  const col = {
    url: csvColumnIndex(header, CSV_COLUMNS.url),
    username: csvColumnIndex(header, CSV_COLUMNS.username),
    password: csvColumnIndex(header, CSV_COLUMNS.password),
    title: csvColumnIndex(header, CSV_COLUMNS.title),
    note: csvColumnIndex(header, CSV_COLUMNS.note)
  };
  if (col.url < 0 || col.password < 0) return { entries: [], skipped: rows.length - 1 };
  const entries = [];
  let skipped = 0;
  const seen = new Set();
  for (const row of rows.slice(1)) {
    if (entries.length >= MAX_PASSWORDS) break;
    const cell = (index) => (index >= 0 && typeof row[index] === 'string' ? row[index].trim() : '');
    let origin = cell(col.url);
    if (origin && !/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) origin = `https://${origin}`;
    const password = cell(col.password);
    if (!isWebUrl(origin) || !password) {
      skipped += 1;
      continue;
    }
    const username = cell(col.username);
    const dedupe = `${origin}|${username}|${password}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const note = cell(col.note);
    entries.push({ origin, username, password, ...(note ? { note: note.slice(0, 2000) } : {}) });
  }
  return { entries, skipped };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : match;
  });
}

/**
 * Bookmarks from the HTML file every browser exports (the Netscape bookmark format):
 * folders are <H3> headings followed by a <DL> list; links are <A HREF>. The innermost
 * folder is attached to each bookmark, as with the Chromium import.
 */
function parseBookmarksHtml(text) {
  const out = [];
  const stack = [];
  let pending = null; // a folder name whose <DL> has not opened yet
  const token = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dl\b[^>]*>|<\/dl>/gi;
  let match;
  while ((match = token.exec(String(text || ''))) && out.length < MAX_BOOKMARKS) {
    const tag = match[0].slice(0, 3).toLowerCase();
    if (tag === '<h3') {
      pending = decodeEntities(match[1].replace(/<[^>]*>/g, '')).trim();
    } else if (tag === '<dl') {
      stack.push(pending);
      pending = null;
    } else if (tag === '</d') {
      stack.pop();
    } else {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2] || '');
      const url = href ? decodeEntities(href[1] ?? href[2] ?? href[3]) : '';
      const title = decodeEntities(match[3].replace(/<[^>]*>/g, ''));
      const folder = [...stack].reverse().find((name) => name && !/^(bookmarks|bookmarks bar|bookmarks menu|favorites|other bookmarks|toolbar)$/i.test(name));
      pushBookmark(out, title, url, folder);
    }
  }
  return out;
}

module.exports = {
  BROWSERS,
  detectBrowsers,
  chromiumProfiles,
  readChromiumBookmarks,
  parseSafariBookmarks,
  readSafariBookmarks,
  deriveChromiumKey,
  decryptChromiumSecret,
  readChromiumLogins,
  keychainSecret,
  importFromBrowser,
  parseCsv,
  parsePasswordCsv,
  parseBookmarksHtml
};
