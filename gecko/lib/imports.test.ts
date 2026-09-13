import { describe, expect, it } from 'vitest';
import { BROWSERS, bookmarkTree, chromiumProfiles, loginRowOrigin, parseChromiumBookmarks, parseCsv, parsePasswordCsv, profileName } from './imports';

describe('browsers', () => {
  it('covers the Chromium family Firefox does not (Helium, Arc, Dia) and Safari', () => {
    const ids = BROWSERS.map((b) => b.id);
    for (const id of ['helium', 'arc', 'dia', 'chrome', 'brave', 'edge', 'safari']) expect(ids).toContain(id);
    expect(BROWSERS.find((b) => b.id === 'helium')!.keychain).toHaveLength(2);
  });
});

describe('profiles', () => {
  it('reads Local State, Default first', () => {
    const state = JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work' }, Default: { gaia_name: 'Me' } } } });
    expect(chromiumProfiles(state, [], () => false)).toEqual([
      { dir: 'Default', name: 'Me' },
      { dir: 'Profile 2', name: 'Work' }
    ]);
  });

  it('falls back to profile folders that hold data', () => {
    expect(chromiumProfiles(null, ['Default', 'Profile 1', 'System Profile', 'Crashpad'], (d) => d !== 'Profile 1')).toEqual([{ dir: 'Default', name: 'Default' }]);
    expect(chromiumProfiles('not json', ['Profile 3'], () => true)).toEqual([{ dir: 'Profile 3', name: 'Profile 3' }]);
  });

  it('names profiles', () => {
    expect(profileName({ name: ' ' , user_name: 'a@b.c' }, 'Default')).toBe('a@b.c');
    expect(profileName(undefined, 'Profile 1')).toBe('Profile 1');
  });
});

describe('Chromium bookmarks', () => {
  const file = JSON.stringify({
    roots: {
      bookmark_bar: {
        children: [
          { type: 'url', name: 'GitHub', url: 'https://github.com' },
          { type: 'folder', name: 'News', children: [{ type: 'url', name: '', url: 'https://example.com/n' }, { type: 'url', name: 'x', url: 'javascript:alert(1)' }] }
        ]
      },
      other: { children: [{ type: 'url', name: 'Other', url: 'http://other.test' }] }
    }
  });

  it('keeps web links with their innermost folder', () => {
    expect(parseChromiumBookmarks(file)).toEqual([
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'https://example.com/n', url: 'https://example.com/n', folder: 'News' },
      { title: 'Other', url: 'http://other.test' }
    ]);
    expect(parseChromiumBookmarks('nope')).toEqual([]);
  });

  it('groups them into a tree', () => {
    const tree = bookmarkTree(parseChromiumBookmarks(file), 'From Arc');
    expect(tree.title).toBe('From Arc');
    expect(tree.children[0]).toEqual({ title: 'News', children: [{ title: 'https://example.com/n', url: 'https://example.com/n' }] });
    expect(tree.children).toHaveLength(3);
  });
});

describe('login rows', () => {
  it('uses the origin, else the realm, else nothing', () => {
    expect(loginRowOrigin({ origin_url: 'https://a.test/login' })).toBe('https://a.test/login');
    expect(loginRowOrigin({ origin_url: 'android://x', signon_realm: 'https://b.test/' })).toBe('https://b.test/');
    expect(loginRowOrigin({ origin_url: 'ftp://c' })).toBeNull();
  });
});

describe('CSV', () => {
  it('parses quotes, commas and newlines', () => {
    expect(parseCsv('a,"b,""c""",d\r\n"multi\nline",2,3\n')).toEqual([
      ['a', 'b,"c"', 'd'],
      ['multi\nline', '2', '3']
    ]);
  });

  it('reads the Passwords app and Chrome exports, skipping unusable rows', () => {
    const apple = 'Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com,me,pw,hi,\nBad,,x,pw2,,\nSite,example.com,u,p3,,\n';
    const r = parsePasswordCsv(apple);
    expect(r.entries).toEqual([
      { origin: 'https://github.com', username: 'me', password: 'pw', note: 'hi' },
      { origin: 'https://example.com', username: 'u', password: 'p3' }
    ]);
    expect(r.skipped).toBe(1);
    const chrome = 'name,url,username,password,note\nx,https://a.test,u,p,\nx,https://a.test,u,p,\n';
    expect(parsePasswordCsv(chrome).entries).toHaveLength(1);
  });

  it('refuses a file without url or password columns', () => {
    expect(parsePasswordCsv('a,b\n1,2\n')).toEqual({ entries: [], skipped: 1 });
  });
});
