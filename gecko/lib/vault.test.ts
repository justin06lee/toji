import { describe, expect, it } from 'vitest';
import {
  GEN_ALPHABET,
  autosaveVerdict,
  captureStatus,
  entryMatches,
  generatePassword,
  list,
  matchesFor,
  originOf,
  parseEntries,
  secretFor,
  upsert,
  type VaultEntry
} from './vault';

let n = 0;
const id = () => `id-${++n}`;
const NOW = '2026-09-13T00:00:00.000Z';

function sample(): VaultEntry[] {
  let e: VaultEntry[] = [];
  e = upsert(e, { origin: 'https://github.com/login', username: 'me', password: 'p1', containerId: 'work' }, NOW, id);
  e = upsert(e, { origin: 'https://github.com', username: 'alt', password: 'p2', containerId: 'personal' }, NOW, id);
  e = upsert(e, { origin: 'https://example.com', username: 'x', password: 'p3', containerId: null }, NOW, id);
  return e;
}

describe('generatePassword', () => {
  it('uses the alphabet, clamps the length, and is unbiased by construction', () => {
    const p = generatePassword(20);
    expect(p).toHaveLength(20);
    expect([...p].every((c) => GEN_ALPHABET.includes(c))).toBe(true);
    expect(generatePassword(2)).toHaveLength(8);
    expect(generatePassword(999)).toHaveLength(128);
  });

  it('skips bytes that would bias the result', () => {
    const size = GEN_ALPHABET.length;
    const limit = 256 - (256 % size);
    const bytes = new Uint8Array(40).fill(limit); // all rejected…
    bytes[5] = 0; // …but one
    let calls = 0;
    const random = (k: number) => (calls++ === 0 ? bytes.slice(0, k) : new Uint8Array(k));
    expect(generatePassword(8, random)[0]).toBe(GEN_ALPHABET[0]);
  });
});

describe('matching', () => {
  it('matches only the exact origin', () => {
    expect(originOf('https://github.com/login?x=1')).toBe('https://github.com');
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(entryMatches({ origin: 'https://github.com', containerId: null }, 'http://github.com', null)).toBe(false);
    expect(entryMatches({ origin: 'https://github.com', containerId: null }, 'https://gist.github.com', null)).toBe(false);
  });

  it('keeps containers apart but offers container-less entries everywhere', () => {
    const e = sample();
    expect(matchesFor(e, 'https://github.com/x', 'work').map((m) => m.username)).toEqual(['me']);
    expect(matchesFor(e, 'https://github.com/x', 'personal').map((m) => m.username)).toEqual(['alt']);
    expect(matchesFor(e, 'https://example.com', 'work').map((m) => m.username)).toEqual(['x']);
  });

  it('never returns a password from list or matches', () => {
    const e = sample();
    for (const row of [...list(e), ...matchesFor(e, 'https://github.com', 'work')]) {
      expect(JSON.stringify(row)).not.toMatch(/p[123]/);
    }
  });
});

describe('secretFor', () => {
  it('releases only for the saved origin and container', () => {
    const e = sample();
    const work = e[0].id;
    expect(secretFor(e, work, 'https://github.com/session', 'work')).toEqual({ username: 'me', password: 'p1' });
    expect(secretFor(e, work, 'https://evil.example', 'work')).toBeNull();
    expect(secretFor(e, work, 'https://github.com', 'personal')).toBeNull();
    expect(secretFor(e, 'nope', 'https://github.com', 'work')).toBeNull();
  });
});

describe('upsert and capture', () => {
  it('updates in place and refuses bad drafts', () => {
    let e = sample();
    const count = e.length;
    e = upsert(e, { origin: 'https://github.com', username: 'me', password: 'new', containerId: 'work' }, NOW, id);
    expect(e).toHaveLength(count);
    expect(e[0].password).toBe('new');
    expect(() => upsert(e, { origin: 'ftp://x', password: 'a' }, NOW, id)).toThrow();
    expect(() => upsert(e, { origin: 'https://x.com', password: '' }, NOW, id)).toThrow();
  });

  it('classifies a submission', () => {
    const e = sample();
    expect(captureStatus(e, { url: 'https://github.com/l', username: 'me', password: 'p1', containerId: 'work' })).toBe('same');
    expect(captureStatus(e, { url: 'https://github.com/l', username: 'me', password: 'zz', containerId: 'work' })).toBe('update');
    expect(captureStatus(e, { url: 'https://github.com/l', username: 'me', password: 'p1', containerId: 'personal' })).toBe('new');
    expect(captureStatus(e, { url: 'about:blank', username: 'me', password: 'p1', containerId: null })).toBe('ignore');
  });

  it('parses stored files and drops malformed rows', () => {
    const e = sample();
    expect(parseEntries(JSON.stringify(e))).toHaveLength(e.length);
    expect(parseEntries(JSON.stringify({ entries: [...e, { id: 1 }] }))).toHaveLength(e.length);
  });
});

describe('autosaveVerdict', () => {
  it('saves when the sign-in evidently worked or nothing happened', () => {
    expect(autosaveVerdict('timeout', { submittedUrl: 'a', elapsedMs: 9999 })).toBe('save');
    expect(autosaveVerdict({ hasLogin: false, url: 'b' }, { submittedUrl: 'a', elapsedMs: 300 })).toBe('save');
  });

  it('waits out the form reacting, then asks if the login form is still there', () => {
    expect(autosaveVerdict({ hasLogin: true, url: 'a' }, { submittedUrl: 'a', elapsedMs: 200 })).toBe('wait');
    expect(autosaveVerdict({ hasLogin: true, url: 'a' }, { submittedUrl: 'a', elapsedMs: 2000 })).toBe('ask');
    expect(autosaveVerdict({ hasLogin: true, url: 'b' }, { submittedUrl: 'a', elapsedMs: 200 })).toBe('ask');
  });
});
