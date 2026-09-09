import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptChromiumSecret,
  deriveChromiumKey,
  detectBrowsers,
  importFromBrowser,
  parseBookmarksHtml,
  parseCsv,
  parsePasswordCsv,
  parseSafariBookmarks,
  readChromiumBookmarks,
  readChromiumLogins,
  readSafariBookmarks
} from './browser-import.cjs';

// --- fixtures ---------------------------------------------------------------

/** A cell the way Chromium writes it on macOS: "v10" + AES-128-CBC under the derived key. */
const encrypt = (plain: string, secret: string) => {
  const cipher = createCipheriv('aes-128-cbc', deriveChromiumKey(secret), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain, 'utf8'), cipher.final()]);
};

const CHROME_BOOKMARKS = {
  roots: {
    bookmark_bar: {
      type: 'folder',
      name: 'Bookmarks bar',
      children: [
        { type: 'url', name: 'Toji', url: 'https://toji.example/' },
        {
          type: 'folder',
          name: 'Dev',
          children: [
            { type: 'url', name: 'GitHub', url: 'https://github.com/' },
            { type: 'url', name: 'Settings', url: 'chrome://settings' }
          ]
        }
      ]
    },
    other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: '', url: 'https://example.com/' }] },
    synced: { type: 'folder', name: 'Mobile bookmarks', children: [] }
  }
};

const SAFARI_BOOKMARKS = {
  WebBookmarkType: 'WebBookmarkTypeList',
  Title: '',
  Children: [
    { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History' },
    {
      WebBookmarkType: 'WebBookmarkTypeList',
      Title: 'BookmarksBar',
      Children: [
        { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://apple.com/', URIDictionary: { title: 'Apple' } },
        {
          WebBookmarkType: 'WebBookmarkTypeList',
          Title: 'News',
          Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://news.ycombinator.com/', URIDictionary: { title: 'HN' } }]
        }
      ]
    },
    {
      WebBookmarkType: 'WebBookmarkTypeList',
      Title: 'BookmarksMenu',
      Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.org/', URIDictionary: { title: 'Example' } }]
    },
    {
      WebBookmarkType: 'WebBookmarkTypeList',
      Title: 'com.apple.ReadingList',
      Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://read.example/', URIDictionary: { title: 'Read later' } }]
    }
  ]
};

const SECRET = 'bWVsb24tYm9hdC1zYWx0eQ==';

let home: string;
const support = (...parts: string[]) => path.join(home, 'Library', 'Application Support', ...parts);
const write = (file: string, content: string | object) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

/** A `Login Data` with the columns the import reads, populated like a real one. */
const writeLoginData = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE logins (origin_url TEXT, action_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_created INTEGER, date_last_used INTEGER)'
  );
  const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // A blob the key cannot open. Chosen by construction, so the test never depends on luck
  // with padding.
  let garbage: Buffer;
  do garbage = Buffer.concat([Buffer.from('v10'), randomBytes(16)]);
  while (decryptChromiumSecret(garbage, deriveChromiumKey(SECRET)) !== null);
  insert.run('https://github.com/login', 'https://github.com/session', 'https://github.com/', 'justin', encrypt('hunter2', SECRET), 0, 1, 9);
  insert.run('https://legacy.example/', '', 'https://legacy.example/', 'old', Buffer.from('plain'), 0, 1, 5);
  insert.run('https://blocked.example/', '', 'https://blocked.example/', 'never', encrypt('x', SECRET), 1, 1, 8);
  insert.run('android://hash@com.app/', '', 'android://hash@com.app/', 'app', encrypt('y', SECRET), 0, 1, 7);
  insert.run('https://bad.example/', '', 'https://bad.example/', 'c', garbage, 0, 1, 6);
  db.close();
};

type ExecCallback = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;
/** A `security` that answers from memory: a secret, a not-found, or a refusal. */
const fakeExec = (mode: 'secret' | 'missing' | 'denied', calls: string[][] = []) =>
  (command: string, args: string[], _options: object, callback: ExecCallback) => {
    calls.push([command, ...args]);
    if (command !== 'security') return callback(Object.assign(new Error(`unexpected ${command}`), { code: 1 }), '', '');
    if (mode === 'missing') return callback(Object.assign(new Error('nf'), { code: 44 }), '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    if (mode === 'denied') return callback(Object.assign(new Error('denied'), { code: 128 }), '', 'security: SecKeychainItemCopyContent: User interaction is not allowed.');
    return callback(null, `${SECRET}\n`, '');
  };

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'toji-import-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// --- tests ------------------------------------------------------------------

describe('detectBrowsers', () => {
  test('lists profiles as the browser names them, and Safari even when its plist is gone', () => {
    write(support('Google', 'Chrome', 'Local State'), { profile: { info_cache: { Default: { name: 'Justin', gaia_name: 'Justin L' }, 'Profile 1': { gaia_name: 'Work account' } } } });
    write(support('Google', 'Chrome', 'Default', 'Bookmarks'), CHROME_BOOKMARKS);
    const found = detectBrowsers({ home });
    expect(found.find((b) => b.id === 'chrome')).toEqual({
      id: 'chrome',
      name: 'Google Chrome',
      kind: 'chromium',
      available: true,
      passwords: true,
      profiles: [
        { dir: 'Default', name: 'Justin' },
        { dir: 'Profile 1', name: 'Work account' }
      ]
    });
    expect(found.find((b) => b.id === 'brave')).toMatchObject({ available: false, profiles: [] });
    expect(found.find((b) => b.id === 'safari')).toMatchObject({ available: false, passwords: false, profiles: [{ dir: '', name: 'Safari' }] });
  });

  test('falls back to the profile folders that hold data when there is no Local State', () => {
    write(support('net.imput.helium', 'Profile 3', 'Login Data'), '');
    write(support('net.imput.helium', 'Default', 'Bookmarks'), CHROME_BOOKMARKS);
    write(support('net.imput.helium', 'Guest Profile', 'Bookmarks'), CHROME_BOOKMARKS);
    expect(detectBrowsers({ home }).find((b) => b.id === 'helium')?.profiles).toEqual([
      { dir: 'Default', name: 'Default' },
      { dir: 'Profile 3', name: 'Profile 3' }
    ]);
  });

  test('Safari counts as available once its plist is there', () => {
    write(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'), 'bplist00');
    expect(detectBrowsers({ home }).find((b) => b.id === 'safari')?.available).toBe(true);
  });
});

describe('bookmarks', () => {
  test('Chromium: every web bookmark with its innermost folder, top-level roots not counted as folders', () => {
    const file = support('x', 'Bookmarks');
    write(file, CHROME_BOOKMARKS);
    expect(readChromiumBookmarks(file)).toEqual([
      { title: 'Toji', url: 'https://toji.example/' },
      { title: 'GitHub', url: 'https://github.com/', folder: 'Dev' },
      { title: 'https://example.com/', url: 'https://example.com/' }
    ]);
  });

  test('Chromium: a missing or corrupt file yields nothing', () => {
    expect(readChromiumBookmarks(support('nope'))).toEqual([]);
    const file = support('x', 'Bookmarks');
    write(file, '{not json');
    expect(readChromiumBookmarks(file)).toEqual([]);
  });

  test('Safari: Favorites, named folders, the menu and the Reading List', () => {
    expect(parseSafariBookmarks(JSON.stringify(SAFARI_BOOKMARKS))).toEqual([
      { title: 'Apple', url: 'https://apple.com/', folder: 'Favorites' },
      { title: 'HN', url: 'https://news.ycombinator.com/', folder: 'News' },
      { title: 'Example', url: 'https://example.org/' },
      { title: 'Read later', url: 'https://read.example/', folder: 'Reading List' }
    ]);
  });

  test('Safari: reads through plutil, and says why when it cannot', async () => {
    const file = path.join(home, 'Library', 'Safari', 'Bookmarks.plist');
    const plutil = (command: string, args: string[], _o: object, cb: ExecCallback) => {
      expect(command).toBe('plutil');
      expect(args).toEqual(['-convert', 'json', '-o', '-', file]);
      cb(null, JSON.stringify(SAFARI_BOOKMARKS), '');
    };
    expect(await readSafariBookmarks(file, { exec: plutil })).toMatchObject({ error: 'missing', bookmarks: [] });
    write(file, 'bplist00');
    expect((await readSafariBookmarks(file, { exec: plutil })).bookmarks).toHaveLength(4);
    chmodSync(file, 0o000);
    expect(await readSafariBookmarks(file, { exec: plutil })).toEqual({ error: 'needs-access', bookmarks: [] });
    chmodSync(file, 0o600);
  });
});

describe('passwords', () => {
  test('decrypts what Chromium encrypted, passes legacy plaintext through, and refuses garbage', () => {
    const key = deriveChromiumKey(SECRET);
    expect(decryptChromiumSecret(encrypt('hunter2', SECRET), key)).toBe('hunter2');
    expect(decryptChromiumSecret(encrypt('pässwörd — 🔑', SECRET), key)).toBe('pässwörd — 🔑');
    expect(decryptChromiumSecret(Buffer.from('plain'), key)).toBe('plain');
    expect(decryptChromiumSecret(Buffer.alloc(0), key)).toBe('');
    expect(decryptChromiumSecret(encrypt('hunter2', 'some-other-key'), key)).not.toBe('hunter2');
  });

  test('reads Login Data: skips blocked sites, non-web realms and rows the key cannot open', () => {
    const file = support('x', 'Login Data');
    writeLoginData(file);
    expect(readChromiumLogins(file, deriveChromiumKey(SECRET))).toEqual({
      logins: [
        { origin: 'https://github.com/login', username: 'justin', password: 'hunter2' },
        { origin: 'https://legacy.example/', username: 'old', password: 'plain' }
      ],
      undecryptable: 1
    });
  });
});

describe('importFromBrowser', () => {
  const chromeProfile = () => {
    write(support('Google', 'Chrome', 'Local State'), { profile: { info_cache: { Default: { name: 'Justin' } } } });
    write(support('Google', 'Chrome', 'Default', 'Bookmarks'), CHROME_BOOKMARKS);
    writeLoginData(support('Google', 'Chrome', 'Default', 'Login Data'));
  };

  test('hands bookmarks back and every password to the vault, never returning a secret', async () => {
    chromeProfile();
    const saved: object[] = [];
    const calls: string[][] = [];
    const result = await importFromBrowser({ browser: 'chrome', profile: 'Default', home, exec: fakeExec('secret', calls), saveSecret: (login) => saved.push(login) > 0 });
    expect(result.bookmarks.items).toHaveLength(3);
    expect(result.passwords).toEqual({ found: 2, added: 2, undecryptable: 1 });
    expect(saved).toEqual([
      { origin: 'https://github.com/login', username: 'justin', password: 'hunter2' },
      { origin: 'https://legacy.example/', username: 'old', password: 'plain' }
    ]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(calls).toEqual([['security', 'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome']]);
  });

  test('a keychain refusal skips passwords and says so; bookmarks still arrive', async () => {
    chromeProfile();
    const saved: object[] = [];
    const result = await importFromBrowser({ browser: 'chrome', home, exec: fakeExec('denied'), saveSecret: (login) => saved.push(login) > 0 });
    expect(result.bookmarks.items).toHaveLength(3);
    expect(result.passwords).toEqual({ found: 0, added: 0, error: 'keychain-denied' });
    expect(saved).toEqual([]);
  });

  test('tries every keychain name a browser has used before giving up', async () => {
    write(support('net.imput.helium', 'Default', 'Bookmarks'), CHROME_BOOKMARKS);
    writeLoginData(support('net.imput.helium', 'Default', 'Login Data'));
    const calls: string[][] = [];
    const result = await importFromBrowser({ browser: 'helium', home, exec: fakeExec('missing', calls), saveSecret: () => true });
    expect(result.passwords).toEqual({ found: 0, added: 0, error: 'keychain-missing' });
    expect(calls.map((c) => c[4])).toEqual(['Helium Safe Storage', 'Chromium Safe Storage']);
  });

  test('a profile with no Login Data is bookmarks only, and never touches the keychain', async () => {
    write(support('Google', 'Chrome', 'Local State'), { profile: { info_cache: { Default: { name: 'Justin' }, 'Profile 1': { name: 'Work' } } } });
    write(support('Google', 'Chrome', 'Profile 1', 'Bookmarks'), CHROME_BOOKMARKS);
    const calls: string[][] = [];
    const result = await importFromBrowser({ browser: 'chrome', profile: 'Profile 1', home, exec: fakeExec('secret', calls), saveSecret: () => true });
    expect(result.bookmarks.items).toHaveLength(3);
    expect(result.passwords).toEqual({ found: 0, added: 0 });
    expect(calls).toEqual([]);
  });

  test('a profile whose Login Data holds nothing never touches the keychain either', async () => {
    write(support('Google', 'Chrome', 'Local State'), { profile: { info_cache: { Default: { name: 'Justin' } } } });
    const file = support('Google', 'Chrome', 'Default', 'Login Data');
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_created INTEGER, date_last_used INTEGER)');
    db.close();
    const calls: string[][] = [];
    const result = await importFromBrowser({ browser: 'chrome', home, exec: fakeExec('secret', calls), saveSecret: () => true });
    expect(result.passwords).toEqual({ found: 0, added: 0 });
    expect(calls).toEqual([]);
  });

  test('refuses a profile name that is not one, and an unknown browser', async () => {
    chromeProfile();
    expect(await importFromBrowser({ browser: 'chrome', profile: '../../etc', home, exec: fakeExec('secret'), saveSecret: () => true })).toEqual({
      bookmarks: { items: [], error: 'missing' },
      passwords: { found: 0, added: 0, error: 'unreadable' }
    });
    expect((await importFromBrowser({ browser: 'netscape', home })).passwords.error).toBe('unknown-browser');
  });

  test('Safari: bookmarks through plutil, passwords declared unsupported', async () => {
    write(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'), 'bplist00');
    const plutil = (_c: string, _a: string[], _o: object, cb: ExecCallback) => cb(null, JSON.stringify(SAFARI_BOOKMARKS), '');
    const result = await importFromBrowser({ browser: 'safari', home, exec: plutil, saveSecret: () => true });
    expect(result.bookmarks.items).toHaveLength(4);
    expect(result.passwords).toEqual({ found: 0, added: 0, error: 'unsupported' });
  });
});

describe('parseCsv', () => {
  test('quoted commas, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","line 1\nline 2"\r\n\r\nlast,,\n')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line 1\nline 2'],
      ['last', '', '']
    ]);
  });
});

describe('parsePasswordCsv', () => {
  test('the Passwords app export, bare hosts made into origins, rows without a password skipped', () => {
    const csv = ['Title,URL,Username,Password,Notes,OTPAuth', 'GitHub,https://github.com,justin,"pa,ss""word",note here,', 'Bare,example.com,me,secret,,', 'Nothing,https://nopass.example,me,,,'].join('\n');
    expect(parsePasswordCsv(csv)).toEqual({
      entries: [
        { origin: 'https://github.com', username: 'justin', password: 'pa,ss"word', note: 'note here' },
        { origin: 'https://example.com', username: 'me', password: 'secret' }
      ],
      skipped: 1
    });
  });

  test('Chrome and Firefox column names, and a duplicate row only once', () => {
    expect(parsePasswordCsv('name,url,username,password,note\nX,https://x.example/,u,p,\nX,https://x.example/,u,p,\n').entries).toEqual([{ origin: 'https://x.example/', username: 'u', password: 'p' }]);
    expect(parsePasswordCsv('"url","username","password","httpRealm","formActionOrigin","guid"\n"https://f.example","fox","den","","",""\n').entries).toEqual([
      { origin: 'https://f.example', username: 'fox', password: 'den' }
    ]);
  });

  test('a file without website and password columns imports nothing', () => {
    expect(parsePasswordCsv('title,secret\na,b\n')).toEqual({ entries: [], skipped: 1 });
    expect(parsePasswordCsv('')).toEqual({ entries: [], skipped: 0 });
  });
});

describe('parseBookmarksHtml', () => {
  test('nested folders, entities, and no bookmarklets', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Bar</H3>
    <DL><p>
        <DT><A HREF="https://toji.example/" ADD_DATE="1" ICON="data:image/png;base64,AAAA">Toji &amp; friends</A>
        <DT><H3>Dev</H3>
        <DL><p>
            <DT><A HREF="https://github.com/">GitHub</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">bookmarklet</A>
    <DT><A HREF="https://example.com/?a=1&amp;b=2">Example &#x2014; two</A>
</DL><p>`;
    expect(parseBookmarksHtml(html)).toEqual([
      { title: 'Toji & friends', url: 'https://toji.example/' },
      { title: 'GitHub', url: 'https://github.com/', folder: 'Dev' },
      { title: 'Example — two', url: 'https://example.com/?a=1&b=2' }
    ]);
  });
});
