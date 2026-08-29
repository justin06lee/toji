// The password vault.
//
// Two rules shape this module:
//
//  1. Secrets never enter the renderer. The renderer can list entries (origin,
//     username, which container) and ask for one to be *filled*, but the password
//     itself goes main process → guest page directly. Model-facing page observations
//     are separately stripped of all form values before they leave the main process.
//
//  2. Credentials are scoped to a container. A login saved in Work is not offered in
//     Personal, because those are different identities — offering it there would undo
//     the separation containers exist to create.
//
// At rest the file is encrypted with Electron's safeStorage, which is backed by the OS
// keychain (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux). If the OS
// has no such facility the vault refuses to store anything rather than falling back to
// something weaker than the user would assume.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Ambiguous-looking characters are omitted so a generated password can be read aloud. */
const GEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';

/**
 * Cryptographically uniform random password. Rejection sampling avoids the modulo bias
 * that `randomBytes[i] % alphabet.length` would introduce.
 */
function generatePassword(length = 20, alphabet = GEN_ALPHABET) {
  const size = alphabet.length;
  const limit = 256 - (256 % size); // values at/above this would skew the distribution
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % size];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Normalize a URL to the origin we match credentials against. */
function originOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Human-facing credential name derived from the exact saved origin. */
function siteName(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./i, '') || origin;
  } catch {
    return origin;
  }
}

/**
 * Whether a saved entry may be offered for a page.
 *
 * Deliberately an exact origin match: no subdomain widening, no protocol downgrade
 * (an https credential is never offered to an http page). Anything looser is how
 * password managers end up handing credentials to the wrong site.
 */
function entryMatches(entry, origin, containerId) {
  if (!entry || !origin) return false;
  if (entry.origin !== origin) return false;
  return !containerId || !entry.containerId || entry.containerId === containerId;
}

class Vault {
  /** `safeStorage` is injected so this module stays testable outside Electron. */
  constructor({ file, safeStorage, log }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.log = log || (() => {});
    this.entries = null;
  }

  available() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  load() {
    if (this.entries) return this.entries;
    this.entries = [];
    if (!this.available()) return this.entries;
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
        if (Array.isArray(parsed)) this.entries = parsed;
      }
    } catch (error) {
      // A vault we cannot decrypt must never be silently replaced with an empty one —
      // that would destroy every saved password on the next write.
      this.log(`[vault] unreadable, refusing to overwrite: ${error.message}`);
      this.entries = null;
      throw new Error('vault could not be decrypted');
    }
    return this.entries;
  }

  persist() {
    if (!this.available()) throw new Error('no OS encryption available');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(this.entries ?? []));
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The temporary file may never have been created.
      }
      throw error;
    }
  }

  /** Entry metadata only — never the password. This is what the renderer may see. */
  list(containerId) {
    return this.load()
      .filter((entry) => !containerId || entry.containerId === containerId)
      .map(({ id, origin, username, containerId: cid, updatedAt, note }) => ({ id, name: siteName(origin), origin, username, containerId: cid, updatedAt, note }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  /** Metadata for the entries that may be offered on this page, in this container. */
  matchesFor(url, containerId) {
    const origin = originOf(url);
    if (!origin) return [];
    return this.load()
      .filter((entry) => entryMatches(entry, origin, containerId))
      .map(({ id, origin: o, username, containerId: cid }) => ({ id, name: siteName(o), origin: o, username, containerId: cid }));
  }

  save({ id, origin, username, password, containerId, note }) {
    const normalized = originOf(origin);
    if (!normalized) throw new Error('a credential needs an http(s) origin');
    if (!password) throw new Error('a credential needs a password');
    const entries = this.load();
    const now = new Date().toISOString();
    const existingIndex = id
      ? entries.findIndex((e) => e.id === id)
      : entries.findIndex((e) => e.origin === normalized && e.username === username && e.containerId === containerId);

    if (existingIndex >= 0) {
      entries[existingIndex] = { ...entries[existingIndex], username, password, note, updatedAt: now };
    } else {
      entries.push({
        id: crypto.randomUUID(),
        origin: normalized,
        username: username || '',
        password,
        containerId: containerId || null,
        note: note || '',
        createdAt: now,
        updatedAt: now
      });
    }
    this.persist();
    return true;
  }

  /**
   * Whether a credential the user just submitted is worth offering to save. Returning
   * 'same' is what stops the prompt appearing on every single sign-in.
   */
  captureStatus({ origin, username, password, containerId }) {
    const normalized = originOf(origin);
    if (!normalized || !password) return 'ignore';
    const existing = this.load().find(
      (entry) => entry.origin === normalized && entry.username === (username || '') && (entry.containerId ?? null) === (containerId ?? null)
    );
    if (!existing) return 'new';
    return existing.password === password ? 'same' : 'update';
  }

  remove(id) {
    const entries = this.load();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.entries = next;
    this.persist();
    return true;
  }

  /**
   * The secret, for filling. `expectedOrigin` is the page actually being filled: an
   * entry is only ever released for the origin it was saved against, so a redirect or
   * a navigation between the click and the fill cannot redirect a credential elsewhere.
   */
  secretFor(id, expectedOrigin, expectedContainerId) {
    const entry = this.load().find((e) => e.id === id);
    if (!entry) return null;
    if (expectedOrigin && entry.origin !== originOf(expectedOrigin)) {
      this.log(`[vault] refused fill: ${entry.origin} does not match ${expectedOrigin}`);
      return null;
    }
    if (expectedContainerId && entry.containerId && entry.containerId !== expectedContainerId) {
      this.log(`[vault] refused fill: ${entry.containerId} does not match container ${expectedContainerId}`);
      return null;
    }
    return { username: entry.username, password: entry.password };
  }
}

module.exports = { Vault, generatePassword, originOf, siteName, entryMatches, GEN_ALPHABET };
