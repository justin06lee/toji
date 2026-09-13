import { describe, expect, test } from 'vitest';
import { addBookmarkCount, describeBookmarksFile, describeBrowser, describeImport, describePasswordsFile, planProfiles } from './browserImport';
import { DEFAULT_CONTAINERS } from './containers';

describe('planProfiles', () => {
  test('one profile goes where the window already is, and creates nothing', () => {
    const plan = planProfiles([{ dir: 'Default', name: 'You' }], DEFAULT_CONTAINERS, 'shopping');
    expect(plan).toEqual({ targets: [{ profile: { dir: 'Default', name: 'You' }, containerId: 'shopping', prefixFolders: false }], containers: DEFAULT_CONTAINERS, created: 0 });
  });

  test('several profiles become Toji profiles of their own, reusing a name that already exists', () => {
    const profiles = [
      { dir: 'Default', name: 'Justin' },
      { dir: 'Profile 1', name: 'work' },
      { dir: 'Profile 2', name: 'Side project' }
    ];
    const plan = planProfiles(profiles, DEFAULT_CONTAINERS, 'personal');
    expect(plan.created).toBe(2);
    expect(plan.targets.map((t) => t.containerId)).toEqual(['justin', 'work', 'side-project']);
    expect(plan.targets.every((t) => t.prefixFolders)).toBe(true);
    expect(plan.containers.slice(DEFAULT_CONTAINERS.length)).toMatchObject([
      { id: 'justin', name: 'Justin', egress: 'direct', ephemeral: false },
      { id: 'side-project', name: 'Side project', egress: 'direct', ephemeral: false }
    ]);
    // The built-in "Work" container was reused, not duplicated.
    expect(plan.containers.filter((c) => c.name.toLowerCase() === 'work')).toHaveLength(1);
  });

  test('two new profiles never collide on an id', () => {
    const plan = planProfiles([{ dir: 'Default', name: 'Me' }, { dir: 'Profile 1', name: 'me' }], DEFAULT_CONTAINERS, 'personal');
    expect(plan.created).toBe(1);
    expect(plan.targets.map((t) => t.containerId)).toEqual(['me', 'me']);
  });
});

describe('describeImport', () => {
  test('lists what arrived, in words', () => {
    expect(describeImport('Google Chrome', { bookmarks: 120, passwords: 1, profiles: 2 })).toEqual({ text: 'Imported 120 bookmarks, 1 password and 2 profiles from Google Chrome.', tone: 'ok' });
    expect(describeImport('Brave', { bookmarks: 3, passwords: 0, profiles: 0 })).toEqual({ text: 'Imported 3 bookmarks from Brave.', tone: 'ok' });
    expect(describeImport('Arc', { bookmarks: 0, passwords: 0, profiles: 0 })).toEqual({ text: 'Nothing new to import from Arc.', tone: 'ok' });
  });

  test('says why passwords were skipped', () => {
    expect(describeImport('Helium', { bookmarks: 5, passwords: 0, profiles: 0, passwordError: 'keychain-denied' })).toEqual({
      text: "Imported 5 bookmarks from Helium. macOS didn't let Toji read Helium's password key, so passwords were skipped.",
      tone: 'warn'
    });
    expect(describeImport('Dia', { bookmarks: 0, passwords: 0, profiles: 0, passwordError: 'keychain-missing' }).text).toContain('no password key in the keychain');
  });

  test('offers System Settings when Safari is behind Full Disk Access', () => {
    expect(describeImport('Safari', { bookmarks: 0, passwords: 0, profiles: 0, bookmarkError: 'needs-access' })).toEqual({
      text: "Nothing new to import from Safari. Toji needs Full Disk Access to read Safari's bookmarks.",
      tone: 'warn',
      settings: true
    });
    expect(describeImport('Safari', { bookmarks: 0, passwords: 0, profiles: 0, bookmarkError: 'missing' }).text).toContain('export them');
  });
});

describe('bookmarks filed into the browser (Gecko)', () => {
  test('the import line counts them into your bookmarks, or just says they arrived', () => {
    expect(describeImport('Google Chrome', { bookmarks: 12, passwords: 0, profiles: 0, nativeBookmarks: true })).toEqual({
      text: 'Imported 12 bookmarks into your bookmarks from Google Chrome.',
      tone: 'ok'
    });
    expect(describeImport('Brave', { bookmarks: null, passwords: 3, profiles: 0, nativeBookmarks: true }).text).toBe('Imported your bookmarks and 3 passwords from Brave.');
    expect(describeImport('Arc', { bookmarks: 0, passwords: 0, profiles: 0, nativeBookmarks: true }).text).toBe('Nothing new to import from Arc.');
  });

  test('password messages stay as they are', () => {
    expect(describeImport('Helium', { bookmarks: null, passwords: 0, profiles: 0, nativeBookmarks: true, passwordError: 'keychain-denied' })).toEqual({
      text: "Imported your bookmarks from Helium. macOS didn't let Toji read Helium's password key, so passwords were skipped.",
      tone: 'warn'
    });
  });

  test('profile counts add up; one without a count makes the total unknown; a failed one adds nothing', () => {
    expect(addBookmarkCount(0, { count: 4 })).toBe(4);
    expect(addBookmarkCount(4, { count: 6 })).toBe(10);
    expect(addBookmarkCount(4, { count: null })).toBeNull();
    expect(addBookmarkCount(null, { count: 6 })).toBeNull();
    expect(addBookmarkCount(4, { count: null, error: 'unreadable' })).toBe(4);
    expect(addBookmarkCount(4, { error: 'missing' })).toBe(4);
    expect(addBookmarkCount(4, {})).toBeNull();
  });

  test('an exported file', () => {
    expect(describeBookmarksFile(1)).toEqual({ text: 'Imported 1 bookmark into your bookmarks.', tone: 'ok' });
    expect(describeBookmarksFile(null)).toEqual({ text: 'Imported your bookmarks.', tone: 'ok' });
    expect(describeBookmarksFile(0)).toEqual({ text: 'No bookmarks found in that file.', tone: 'warn' });
  });
});

describe('describePasswordsFile', () => {
  test('counts, skipped rows, and files that are not password exports', () => {
    expect(describePasswordsFile({ canceled: false, found: 12, added: 12, skipped: 0 })).toEqual({ text: 'Imported 12 passwords from the file.', tone: 'ok' });
    expect(describePasswordsFile({ canceled: false, found: 2, added: 2, skipped: 1 })).toEqual({ text: 'Imported 2 passwords from the file. 1 row had no website or password.', tone: 'warn' });
    expect(describePasswordsFile({ canceled: false, found: 0, added: 0, skipped: 4 }).tone).toBe('warn');
    expect(describePasswordsFile({ canceled: false, found: 0, added: 0, skipped: 0, error: 'no-vault' }).text).toContain('vault');
  });
});

describe('describeBrowser', () => {
  test('what an import would bring', () => {
    const base = { id: 'chrome', name: 'Google Chrome', kind: 'chromium' as const, passwords: true };
    expect(describeBrowser({ ...base, available: true, profiles: [{ dir: 'Default', name: 'You' }] })).toBe('bookmarks and passwords');
    expect(describeBrowser({ ...base, available: true, profiles: [{ dir: 'Default', name: 'A' }, { dir: 'Profile 1', name: 'B' }] })).toBe('2 profiles · bookmarks and passwords');
    expect(describeBrowser({ id: 'safari', name: 'Safari', kind: 'safari', passwords: false, available: true, profiles: [{ dir: '', name: 'Safari' }] })).toBe('bookmarks');
    expect(describeBrowser({ ...base, available: false, profiles: [] })).toBe('');
  });
});
