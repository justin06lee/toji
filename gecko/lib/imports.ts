// Pure parts of importing from other browsers (resource:///modules/toji/lib/imports.sys.mjs).
//
// Firefox's own migrators bring bookmarks and history from the browsers they know.
// Toji adds what they don't cover — Helium, Arc and Dia, whose data uses Chromium's
// layout — and sends every imported password to Toji's vault rather than Firefox's
// password manager. Chromium-family browsers keep a `Local State` JSON naming the
// profiles, a `Bookmarks` JSON per profile, and a `Login Data` SQLite database whose
// passwords are encrypted under a key in the macOS keychain ("<Browser> Safe Storage").

export const MAX_BOOKMARKS = 5000;
export const MAX_PASSWORDS = 5000;

export interface BrowserSource {
  id: string;
  name: string;
  kind: 'chromium' | 'safari';
  /** Folders under ~/Library/Application Support, first existing wins. */
  dirs?: string[];
  /** Keychain (service, account) pairs for the password key, tried in order. */
  keychain?: [string, string][];
}

export const BROWSERS: BrowserSource[] = [
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
    // A lightly rebranded Chromium; its key may sit under either name.
    keychain: [
      ['Helium Safe Storage', 'Helium'],
      ['Chromium Safe Storage', 'Chromium']
    ]
  },
  { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', dirs: ['Vivaldi'], keychain: [['Vivaldi Safe Storage', 'Vivaldi']] },
  { id: 'opera', name: 'Opera', kind: 'chromium', dirs: ['com.operasoftware.Opera'], keychain: [['Opera Safe Storage', 'Opera']] },
  { id: 'chromium', name: 'Chromium', kind: 'chromium', dirs: ['Chromium'], keychain: [['Chromium Safe Storage', 'Chromium']] },
  { id: 'safari', name: 'Safari', kind: 'safari' }
];

export interface ProfileRef {
  dir: string;
  name: string;
}

/** What a browser calls a profile: its display name, else the account, else the folder. */
export function profileName(info: Record<string, unknown> | undefined, dir: string): string {
  for (const key of ['name', 'gaia_name', 'user_name']) {
    const value = info?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return dir;
}

/**
 * Profiles from a `Local State` file's text; when it names none, whichever of `folders`
 * look like profile folders (and pass `hasData`). "Default" always comes first.
 */
export function chromiumProfiles(localState: string | null, folders: string[], hasData: (dir: string) => boolean): ProfileRef[] {
  const profiles: ProfileRef[] = [];
  if (localState) {
    try {
      const cache = JSON.parse(localState)?.profile?.info_cache;
      if (cache && typeof cache === 'object') {
        for (const [dir, info] of Object.entries(cache)) profiles.push({ dir, name: profileName(info as Record<string, unknown>, dir) });
      }
    } catch {
      // not JSON: fall back to the folders
    }
  }
  if (!profiles.length) {
    for (const dir of folders) {
      if (/^(Default|Profile \d+)$/.test(dir) && hasData(dir)) profiles.push({ dir, name: dir });
    }
  }
  return profiles.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir)));
}

export const isProfileDir = (dir: string) => /^(Default|Profile \d+)$/.test(dir);

export interface ImportedBookmark {
  title: string;
  url: string;
  folder?: string;
}

const isWebUrl = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url);

function pushBookmark(out: ImportedBookmark[], title: unknown, url: unknown, folder?: string) {
  if (out.length >= MAX_BOOKMARKS || !isWebUrl(url)) return;
  const name = typeof title === 'string' && title.trim() ? title.trim() : url;
  out.push({ title: name.slice(0, 300), url, ...(folder ? { folder } : {}) });
}

interface ChromiumNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromiumNode[];
}

function walkChromium(node: ChromiumNode | undefined, folder: string | undefined, out: ImportedBookmark[]) {
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

/** A Chromium `Bookmarks` file's links, each with its innermost folder. */
export function parseChromiumBookmarks(text: string): ImportedBookmark[] {
  const out: ImportedBookmark[] = [];
  let parsed: { roots?: Record<string, ChromiumNode> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const roots = parsed?.roots ?? {};
  // The bar / other / synced roots are locations, not folders the user named.
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = roots[key];
    if (root && Array.isArray(root.children)) for (const child of root.children) walkChromium(child, undefined, out);
  }
  return out;
}

/** Groups bookmarks by folder, for inserting as a tree. */
export function bookmarkTree(bookmarks: ImportedBookmark[], rootTitle: string): { title: string; children: ({ title: string; url: string } | { title: string; children: { title: string; url: string }[] })[] } {
  const loose: { title: string; url: string }[] = [];
  const folders = new Map<string, { title: string; url: string }[]>();
  for (const b of bookmarks) {
    if (!b.folder) {
      loose.push({ title: b.title, url: b.url });
      continue;
    }
    if (!folders.has(b.folder)) folders.set(b.folder, []);
    folders.get(b.folder)!.push({ title: b.title, url: b.url });
  }
  return {
    title: rootTitle,
    children: [...[...folders].map(([title, children]) => ({ title, children })), ...loose]
  };
}

export interface LoginRow {
  origin_url?: unknown;
  signon_realm?: unknown;
  username_value?: unknown;
}

/** The web origin a Chromium login row belongs to, or null. */
export function loginRowOrigin(row: LoginRow): string | null {
  if (isWebUrl(row.origin_url)) return row.origin_url;
  if (isWebUrl(row.signon_realm)) return row.signon_realm;
  return null;
}

/** RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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
  note: ['note', 'notes', 'comments', 'extra']
};

function column(header: string[], names: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

export interface CsvLogin {
  origin: string;
  username: string;
  password: string;
  note?: string;
}

/**
 * Passwords from a CSV export — Apple's Passwords app, Chrome, Firefox, Brave, Edge and
 * most managers share these column names. Rows without a website or password are skipped.
 */
export function parsePasswordCsv(text: string): { entries: CsvLogin[]; skipped: number } {
  const rows = parseCsv(String(text || ''));
  if (rows.length < 2) return { entries: [], skipped: 0 };
  const header = rows[0];
  const col = {
    url: column(header, CSV_COLUMNS.url),
    username: column(header, CSV_COLUMNS.username),
    password: column(header, CSV_COLUMNS.password),
    note: column(header, CSV_COLUMNS.note)
  };
  if (col.url < 0 || col.password < 0) return { entries: [], skipped: rows.length - 1 };
  const entries: CsvLogin[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    if (entries.length >= MAX_PASSWORDS) break;
    const cell = (i: number) => (i >= 0 && typeof row[i] === 'string' ? row[i].trim() : '');
    let origin = cell(col.url);
    if (origin && !/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) origin = `https://${origin}`;
    const password = cell(col.password);
    if (!isWebUrl(origin) || !password) {
      skipped += 1;
      continue;
    }
    const username = cell(col.username);
    const key = `${origin}|${username}|${password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const note = cell(col.note);
    entries.push({ origin, username, password, ...(note ? { note: note.slice(0, 2000) } : {}) });
  }
  return { entries, skipped };
}
