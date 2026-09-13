// The renderer's half of importing from another browser: which container each of the
// browser's profiles lands in, and the one line that reports how it went. The reading
// itself happens in the main process (apps/desktop/browser-import.cjs), which hands back
// bookmarks and files passwords into the vault without ever showing them here.

import { newContainer, type Container } from './containers';
import type { BookmarkImportError, BrowserProfile, ImportBrowser, PasswordImportError, PasswordsFileImport } from './bridge';

export interface ImportTarget {
  profile: BrowserProfile;
  /** The Toji container this profile's passwords go into. */
  containerId: string;
  /** With several profiles, bookmark folders are filed under the profile's name. */
  prefixFolders: boolean;
}

export interface ImportPlan {
  targets: ImportTarget[];
  /** The container list after any profiles were added. */
  containers: Container[];
  created: number;
}

/**
 * Where a browser's profiles land. A browser with one profile imports into the container
 * the window is already in — there is nothing to tell apart. Several profiles become Toji
 * profiles of their own, named as the browser named them, reusing a container that
 * already carries the name.
 */
export function planProfiles(profiles: BrowserProfile[], containers: Container[], currentId: string): ImportPlan {
  if (profiles.length <= 1) {
    return { targets: profiles.map((profile) => ({ profile, containerId: currentId, prefixFolders: false })), containers, created: 0 };
  }
  let next = containers;
  let created = 0;
  const targets = profiles.map((profile) => {
    const name = profile.name.trim() || profile.dir;
    const existing = next.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return { profile, containerId: existing.id, prefixFolders: true };
    const container = newContainer(name, next);
    next = [...next, container];
    created += 1;
    return { profile, containerId: container.id, prefixFolders: true };
  });
  return { targets, containers: next, created };
}

export interface ImportTotals {
  /** Null: the Gecko browser's migrator filed them into its bookmarks without a count. */
  bookmarks: number | null;
  passwords: number;
  profiles: number;
  /** The bookmarks went into the browser's own bookmarks (Gecko), not Toji's list. */
  nativeBookmarks?: boolean;
  bookmarkError?: BookmarkImportError;
  passwordError?: PasswordImportError;
}

export interface ImportMessage {
  text: string;
  tone: 'ok' | 'warn';
  /** Offer the Full Disk Access pane (Safari's data is behind it). */
  settings?: boolean;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const list = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * Under Gecko: the running count of bookmarks filed into the browser's bookmarks, adding
 * one profile's result. A profile imported without a count (Firefox's migrator did it)
 * makes the total unknown (null) from then on; one that failed adds nothing.
 */
export function addBookmarkCount(total: number | null, bookmarks: { count?: number | null; error?: string }): number | null {
  if (typeof bookmarks.count === 'number') return total === null ? null : total + Math.max(0, bookmarks.count);
  return bookmarks.error ? total : null;
}

/** Under Gecko: the line after an exported bookmarks file went into the browser's bookmarks. */
export function describeBookmarksFile(count: number | null): ImportMessage {
  if (count === null) return { text: 'Imported your bookmarks.', tone: 'ok' };
  if (count <= 0) return { text: 'No bookmarks found in that file.', tone: 'warn' };
  return { text: `Imported ${plural(count, 'bookmark')} into your bookmarks.`, tone: 'ok' };
}

/** What the row under the import list says once a browser has been imported. */
export function describeImport(browser: string, totals: ImportTotals): ImportMessage {
  const parts = [
    totals.bookmarks === null
      ? 'your bookmarks'
      : totals.bookmarks
        ? `${plural(totals.bookmarks, 'bookmark')}${totals.nativeBookmarks ? ' into your bookmarks' : ''}`
        : '',
    totals.passwords ? plural(totals.passwords, 'password') : '',
    totals.profiles ? plural(totals.profiles, 'profile') : ''
  ].filter(Boolean);
  const sentences = [parts.length ? `Imported ${list(parts)} from ${browser}.` : `Nothing new to import from ${browser}.`];
  let settings = false;
  switch (totals.bookmarkError) {
    case 'needs-access':
      sentences.push(`Toji needs Full Disk Access to read ${browser}'s bookmarks.`);
      settings = true;
      break;
    case 'missing':
      sentences.push(`${browser} keeps no bookmarks file on this Mac — export them (File → Export → Bookmarks…) and import the file below.`);
      break;
    case 'unreadable':
      sentences.push(`${browser}'s bookmarks couldn't be read.`);
      break;
  }
  switch (totals.passwordError) {
    case 'keychain-denied':
      sentences.push(`macOS didn't let Toji read ${browser}'s password key, so passwords were skipped.`);
      break;
    case 'keychain-missing':
      sentences.push(`${browser} has no password key in the keychain, so passwords were skipped.`);
      break;
    case 'unreadable':
      sentences.push(`${browser}'s saved passwords couldn't be read.`);
      break;
    case 'no-vault':
      sentences.push('Passwords were skipped: the vault is not available on this system.');
      break;
  }
  const warn = Boolean(totals.bookmarkError || totals.passwordError);
  return { text: sentences.join(' '), tone: warn ? 'warn' : 'ok', ...(settings ? { settings: true } : {}) };
}

/** The line after a passwords CSV was read. */
export function describePasswordsFile(result: PasswordsFileImport): ImportMessage {
  if (result.error === 'no-vault') return { text: 'Passwords were not imported: the vault is not available on this system.', tone: 'warn' };
  if (result.error === 'unreadable') return { text: 'That file could not be read.', tone: 'warn' };
  if (!result.found) return { text: 'No passwords found in that file — it needs website, username and password columns.', tone: 'warn' };
  const skipped = result.skipped ? ` ${plural(result.skipped, 'row')} had no website or password.` : '';
  return { text: `Imported ${plural(result.added, 'password')} from the file.${skipped}`, tone: result.skipped ? 'warn' : 'ok' };
}

/** The small print beside a browser's name: what an import would bring. */
export function describeBrowser(browser: ImportBrowser): string {
  if (!browser.available) return '';
  const profiles = browser.profiles.length > 1 ? `${plural(browser.profiles.length, 'profile')} · ` : '';
  return `${profiles}${browser.passwords ? 'bookmarks and passwords' : 'bookmarks'}`;
}
