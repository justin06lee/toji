export interface ImportedBookmark {
  title: string;
  url: string;
  folder?: string;
}

export interface ImportedLogin {
  origin: string;
  username: string;
  password: string;
  note?: string;
}

export interface BrowserProfile {
  /** The profile folder inside the browser's user-data dir ("Default", "Profile 2"). */
  dir: string;
  /** What the browser shows for it. */
  name: string;
}

export interface DetectedBrowser {
  id: string;
  name: string;
  kind: 'chromium' | 'safari';
  /** There is something on disk to read. */
  available: boolean;
  profiles: BrowserProfile[];
  /** Whether Toji can read this browser's saved passwords at all. */
  passwords: boolean;
}

export type BookmarkImportError = 'missing' | 'needs-access' | 'unreadable';
export type PasswordImportError = 'keychain-denied' | 'keychain-missing' | 'unreadable' | 'unsupported' | 'no-vault' | 'unknown-browser';

export interface ImportResult {
  bookmarks: { items: ImportedBookmark[]; error?: BookmarkImportError };
  passwords: { found: number; added: number; undecryptable?: number; error?: PasswordImportError };
}

type ExecFileLike = (command: string, args: string[], options: object, callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void) => unknown;

export const BROWSERS: { id: string; name: string; kind: 'chromium' | 'safari'; dirs?: string[]; keychain?: [string, string][] }[];

export function detectBrowsers(options?: { home?: string }): DetectedBrowser[];
export function chromiumProfiles(userDataDir: string): BrowserProfile[];
export function readChromiumBookmarks(file: string): ImportedBookmark[];
export function parseSafariBookmarks(json: string | unknown): ImportedBookmark[];
export function readSafariBookmarks(file: string, options?: { exec?: ExecFileLike }): Promise<{ bookmarks: ImportedBookmark[]; error?: BookmarkImportError }>;
export function deriveChromiumKey(secret: string): Buffer;
/** The plaintext, '' for an empty cell, or null when the key does not open the cell. */
export function decryptChromiumSecret(blob: Buffer, key: Buffer): string | null;
export function readChromiumLogins(file: string, key: Buffer, options?: { sqlite?: unknown }): { logins: ImportedLogin[]; undecryptable: number };
export function keychainSecret(candidates: [string, string][], options?: { exec?: ExecFileLike }): Promise<{ secret: string; error?: undefined } | { secret?: undefined; error: 'denied' | 'missing' }>;
export function importFromBrowser(options: {
  browser: string;
  profile?: string;
  /** Receives each decrypted login; return true when it was stored. */
  saveSecret?: (login: ImportedLogin) => boolean;
  home?: string;
  exec?: ExecFileLike;
  sqlite?: unknown;
}): Promise<ImportResult>;
export function parseCsv(text: string): string[][];
export function parsePasswordCsv(text: string): { entries: ImportedLogin[]; skipped: number };
export function parseBookmarksHtml(text: string): ImportedBookmark[];
