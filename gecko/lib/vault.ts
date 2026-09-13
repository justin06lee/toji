// Pure parts of Toji's password vault (resource:///modules/toji/lib/vault.sys.mjs).
//
// Two rules shape it:
//  1. Secrets never reach Toji's pages or the agent. They see metadata (site,
//     username, container) and may ask for an entry to be filled; the password goes
//     from the vault straight into the page's field.
//  2. Credentials are scoped to a container and released only for the exact origin
//     they were saved on — no subdomain widening, no https→http downgrade.

export interface VaultEntry {
  id: string;
  origin: string;
  username: string;
  password: string;
  containerId: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** What may leave the vault: never the password. */
export interface VaultEntryInfo {
  id: string;
  name: string;
  origin: string;
  username: string;
  containerId: string | null;
  updatedAt?: string;
  note?: string;
}

/** Look-alike characters are left out so a generated password can be read aloud. */
export const GEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';

/** Uniformly random password; rejection sampling avoids modulo bias. */
export function generatePassword(length = 20, random: (n: number) => Uint8Array = defaultRandom, alphabet = GEN_ALPHABET): string {
  const n = Math.max(8, Math.min(128, Math.floor(length) || 20));
  const size = alphabet.length;
  const limit = 256 - (256 % size);
  let out = '';
  while (out.length < n) {
    for (const byte of random(n * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % size];
      if (out.length === n) break;
    }
  }
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** The origin credentials are matched against, or null for non-web URLs. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function siteName(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./i, '') || origin;
  } catch {
    return origin;
  }
}

/** Exact origin, and the entry's container (an entry without one is offered everywhere). */
export function entryMatches(entry: Pick<VaultEntry, 'origin' | 'containerId'>, origin: string | null, containerId: string | null): boolean {
  if (!entry || !origin) return false;
  if (entry.origin !== origin) return false;
  return !containerId || !entry.containerId || entry.containerId === containerId;
}

export function info(entry: VaultEntry): VaultEntryInfo {
  return {
    id: entry.id,
    name: siteName(entry.origin),
    origin: entry.origin,
    username: entry.username,
    containerId: entry.containerId,
    updatedAt: entry.updatedAt,
    note: entry.note
  };
}

export function list(entries: VaultEntry[], containerId?: string | null): VaultEntryInfo[] {
  return entries
    .filter((e) => !containerId || e.containerId === containerId)
    .map(info)
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
}

export function matchesFor(entries: VaultEntry[], url: string, containerId: string | null): VaultEntryInfo[] {
  const origin = originOf(url);
  if (!origin) return [];
  return entries.filter((e) => entryMatches(e, origin, containerId)).map((e) => ({ ...info(e), note: undefined, updatedAt: undefined }));
}

export interface Draft {
  id?: string;
  origin: string;
  username?: string;
  password: string;
  containerId?: string | null;
  note?: string;
}

/** Adds or updates an entry; returns the new list. Throws on a non-web origin or empty password. */
export function upsert(entries: VaultEntry[], draft: Draft, now: string, newId: () => string): VaultEntry[] {
  const origin = originOf(draft.origin);
  if (!origin) throw new Error('a credential needs an http(s) origin');
  if (!draft.password) throw new Error('a credential needs a password');
  const username = draft.username ?? '';
  const containerId = draft.containerId ?? null;
  const next = entries.slice();
  const i = draft.id
    ? next.findIndex((e) => e.id === draft.id)
    : next.findIndex((e) => e.origin === origin && e.username === username && e.containerId === containerId);
  if (i >= 0) {
    next[i] = { ...next[i], username, password: draft.password, note: draft.note ?? next[i].note, updatedAt: now };
  } else {
    next.push({ id: newId(), origin, username, password: draft.password, containerId, note: draft.note ?? '', createdAt: now, updatedAt: now });
  }
  return next;
}

/** Whether a just-submitted login is new, a password change, or nothing to save. */
export function captureStatus(entries: VaultEntry[], c: { url: string; username: string; password: string; containerId: string | null }): 'ignore' | 'new' | 'update' | 'same' {
  const origin = originOf(c.url);
  if (!origin || !c.password) return 'ignore';
  const existing = entries.find((e) => e.origin === origin && e.username === (c.username || '') && (e.containerId ?? null) === (c.containerId ?? null));
  if (!existing) return 'new';
  return existing.password === c.password ? 'same' : 'update';
}

/** The secret for a fill, only for the entry's exact origin and container. */
export function secretFor(entries: VaultEntry[], id: string, pageUrl: string, containerId: string | null): { username: string; password: string } | null {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  if (entry.origin !== originOf(pageUrl)) return null;
  if (containerId && entry.containerId && entry.containerId !== containerId) return null;
  return { username: entry.username, password: entry.password };
}

/** A decrypted vault file's entries; anything malformed is dropped, not guessed at. */
export function parseEntries(json: string): VaultEntry[] {
  const data = JSON.parse(json);
  const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
  return rows.filter((r): r is VaultEntry => {
    const e = r as VaultEntry;
    return !!e && typeof e.id === 'string' && typeof e.origin === 'string' && typeof e.password === 'string';
  });
}

// --- Autosave: store a submitted login only once the sign-in evidently worked ---

/** Reports from the same page within this window are the form reacting, not the outcome. */
export const AUTOSAVE_SETTLE_MS = 1000;
/** How long to wait for an outcome before saving anyway. */
export const AUTOSAVE_TIMEOUT_MS = 6000;

export type AutosaveVerdict = 'save' | 'ask' | 'wait';

export function autosaveVerdict(report: { hasLogin: boolean; url?: string } | 'timeout', context: { submittedUrl: string | null; elapsedMs: number }): AutosaveVerdict {
  if (report === 'timeout') return 'save';
  if (!report.hasLogin) return 'save';
  const samePage = !report.url || !context.submittedUrl || report.url === context.submittedUrl;
  if (samePage && context.elapsedMs < AUTOSAVE_SETTLE_MS) return 'wait';
  return 'ask';
}
