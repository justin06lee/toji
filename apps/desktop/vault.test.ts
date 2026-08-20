import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Vault, generatePassword, originOf, entryMatches, GEN_ALPHABET } = require('./vault.cjs') as typeof import('./vault.cjs');

// Stand-in for Electron's safeStorage. Reversible, not secure — the point is to test
// the vault's logic, not to re-test the OS keychain.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf: Buffer) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  }
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toji-vault-'));
  file = path.join(dir, 'vault.bin');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const makeVault = (available = true) => new Vault({ file, safeStorage: fakeSafeStorage(available), log: () => {} });

describe('generatePassword', () => {
  it('produces the requested length from the safe alphabet', () => {
    const password = generatePassword(32);
    expect(password).toHaveLength(32);
    for (const ch of password) expect(GEN_ALPHABET).toContain(ch);
  });

  it('omits characters that are easy to misread', () => {
    for (const ambiguous of ['0', 'O', 'l', '1', 'I']) expect(GEN_ALPHABET).not.toContain(ambiguous);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword(16)));
    expect(seen.size).toBe(200);
  });

  it('stays uniform across the alphabet rather than favouring low bytes', () => {
    // Rejection sampling should keep every character roughly equally likely; modulo
    // bias would over-represent the front of the alphabet.
    const counts = new Map<string, number>();
    for (const ch of generatePassword(20000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = 20000 / GEN_ALPHABET.length;
    for (const ch of GEN_ALPHABET) expect(counts.get(ch) ?? 0).toBeGreaterThan(expected * 0.6);
  });
});

describe('originOf', () => {
  it('reduces a URL to its origin', () => {
    expect(originOf('https://github.com/user/repo?x=1#y')).toBe('https://github.com');
    expect(originOf('http://localhost:3000/login')).toBe('http://localhost:3000');
  });

  it('rejects anything that is not http(s)', () => {
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('entryMatches', () => {
  const entry = { origin: 'https://example.com', containerId: 'work' };

  it('requires an exact origin', () => {
    expect(entryMatches(entry, 'https://example.com', 'work')).toBe(true);
    // No subdomain widening: a credential for the apex is not for a subdomain.
    expect(entryMatches(entry, 'https://login.example.com', 'work')).toBe(false);
    expect(entryMatches(entry, 'https://example.com.evil.test', 'work')).toBe(false);
  });

  it('never downgrades an https credential to http', () => {
    expect(entryMatches(entry, 'http://example.com', 'work')).toBe(false);
  });

  it('keeps credentials inside their container', () => {
    expect(entryMatches(entry, 'https://example.com', 'personal')).toBe(false);
  });
});

describe('Vault', () => {
  it('round-trips through the encrypted file', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com/login', username: 'ada', password: 'hunter2', containerId: 'work' });

    const reopened = makeVault();
    expect(reopened.list()).toEqual([expect.objectContaining({ origin: 'https://example.com', username: 'ada', containerId: 'work' })]);
  });

  it('writes ciphertext, never the password in the clear', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'correct-horse', containerId: null });
    // The fake cipher is reversible, so assert on the framing our code controls.
    expect(fs.readFileSync(file, 'utf8').startsWith('enc:')).toBe(true);
  });

  it('never includes passwords in what the renderer can list', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'hunter2', containerId: 'work' });
    const listed = vault.list();
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(listed[0]).not.toHaveProperty('password');
  });

  it('scopes listing and matching to a container', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'work-acct', password: 'a', containerId: 'work' });
    vault.save({ origin: 'https://example.com', username: 'home-acct', password: 'b', containerId: 'personal' });

    expect(vault.list('work').map((e) => e.username)).toEqual(['work-acct']);
    expect(vault.matchesFor('https://example.com/login', 'personal').map((e) => e.username)).toEqual(['home-acct']);
    expect(vault.matchesFor('https://other.com/login', 'work')).toEqual([]);
  });

  it('updates an existing credential instead of duplicating it', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'old', containerId: 'work' });
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'new', containerId: 'work' });
    expect(vault.list()).toHaveLength(1);
    expect(vault.secretFor(vault.list()[0].id, 'https://example.com')?.password).toBe('new');
  });

  it('treats the same login in two containers as two credentials', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'a', containerId: 'work' });
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'b', containerId: 'personal' });
    expect(vault.list()).toHaveLength(2);
  });

  it('releases a secret only for the origin it was saved against', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'hunter2', containerId: null });
    const { id } = vault.list()[0];
    expect(vault.secretFor(id, 'https://example.com/login')?.password).toBe('hunter2');
    // A navigation between the click and the fill must not redirect the credential.
    expect(vault.secretFor(id, 'https://evil.test/login')).toBeNull();
    expect(vault.secretFor(id, 'http://example.com')).toBeNull();
  });

  it('removes entries', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'x', containerId: null });
    const { id } = vault.list()[0];
    expect(vault.remove(id)).toBe(true);
    expect(vault.remove(id)).toBe(false);
    expect(makeVault().list()).toEqual([]);
  });

  it('rejects credentials without an http(s) origin or a password', () => {
    const vault = makeVault();
    expect(() => vault.save({ origin: 'file:///tmp', username: 'a', password: 'b' })).toThrow(/origin/);
    expect(() => vault.save({ origin: 'https://example.com', username: 'a', password: '' })).toThrow(/password/);
  });

  it('refuses to store anything when the OS offers no encryption', () => {
    const vault = makeVault(false);
    expect(vault.available()).toBe(false);
    expect(() => vault.save({ origin: 'https://example.com', username: 'a', password: 'b' })).toThrow(/encryption/);
  });

  it('refuses to overwrite a vault it cannot decrypt, rather than wiping it', () => {
    fs.writeFileSync(file, Buffer.from('this is not our ciphertext'));
    const vault = makeVault();
    expect(() => vault.load()).toThrow(/decrypt/);
    // The damaged file is still on disk, recoverable, not replaced with an empty vault.
    expect(fs.readFileSync(file, 'utf8')).toBe('this is not our ciphertext');
  });
});

describe('captureStatus', () => {
  it('classifies a submitted login against what is already stored', () => {
    const vault = makeVault();
    vault.save({ origin: 'https://example.com', username: 'ada', password: 'hunter2', containerId: 'work' });

    const base = { origin: 'https://example.com/login', username: 'ada', containerId: 'work' };
    expect(vault.captureStatus({ ...base, password: 'hunter2' })).toBe('same');
    expect(vault.captureStatus({ ...base, password: 'rotated' })).toBe('update');
    expect(vault.captureStatus({ ...base, username: 'grace', password: 'x' })).toBe('new');
    // Same site and account, different identity → a separate credential.
    expect(vault.captureStatus({ ...base, containerId: 'personal', password: 'hunter2' })).toBe('new');
  });

  it('ignores submissions with no password or no usable origin', () => {
    const vault = makeVault();
    expect(vault.captureStatus({ origin: 'https://example.com', username: 'a', password: '' })).toBe('ignore');
    expect(vault.captureStatus({ origin: 'about:blank', username: 'a', password: 'b' })).toBe('ignore');
  });
});
