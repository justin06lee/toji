// Reading the Electron app's data for the one-time move into the Gecko browser
// (TojiMigrate, phase 8 of docs/gecko.md). Pure functions over bytes and JSON;
// the chrome module does the file access.
//
// The Electron renderer kept its settings and containers in Chromium's
// localStorage, a LevelDB database. Toji's is small, so everything sits in the
// write-ahead log (NNNNNN.log); compacted table files (.ldb, snappy-compressed)
// are not read.

const BLOCK = 32768;
const HEADER = 7;
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli), as LevelDB uses. */
export function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** LevelDB stores CRCs masked, so a CRC of data containing CRCs stays useful. */
export function maskCrc(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function varint(bytes: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= bytes.length || shift > 28) throw new Error('bad varint');
    const c = bytes[i++];
    result |= (c & 0x7f) << shift;
    if (c < 0x80) return [result >>> 0, i];
    shift += 7;
  }
}

/** A WriteBatch: sequence (8 bytes), count (4), then put/delete records. */
function applyBatch(batch: Uint8Array, store: Map<string, Uint8Array | null>) {
  if (batch.length < 12) throw new Error('short batch');
  const count = new DataView(batch.buffer, batch.byteOffset + 8, 4).getUint32(0, true);
  const ops: [string, Uint8Array | null][] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const tag = batch[i++];
    let length: number;
    [length, i] = varint(batch, i);
    if (i + length > batch.length) throw new Error('short key');
    const key = latin1(batch.subarray(i, i + length));
    i += length;
    if (tag === 1) {
      [length, i] = varint(batch, i);
      if (i + length > batch.length) throw new Error('short value');
      ops.push([key, batch.slice(i, i + length)]);
      i += length;
    } else if (tag === 0) {
      ops.push([key, null]);
    } else {
      throw new Error('bad tag');
    }
  }
  // All or nothing: a batch that doesn't parse leaves the store as it was.
  for (const [key, value] of ops) store.set(key, value);
}

/**
 * Replays a LevelDB log into its final key → value map (a deletion maps to
 * null). Keys come back as Latin-1 strings of their bytes. Records failing their
 * checksum, and anything after a torn record, are skipped.
 */
export function readLevelDbLog(bytes: Uint8Array): Map<string, Uint8Array | null> {
  const store = new Map<string, Uint8Array | null>();
  let pos = 0;
  let parts: Uint8Array[] | null = null;
  while (pos + HEADER <= bytes.length) {
    const left = BLOCK - (pos % BLOCK);
    if (left < HEADER) {
      pos += left; // block trailer
      continue;
    }
    const stored = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0, true);
    const length = bytes[pos + 4] | (bytes[pos + 5] << 8);
    const type = bytes[pos + 6];
    const start = pos + HEADER;
    if (type === 0 && length === 0) {
      pos += left; // preallocated zeros: nothing more in this block
      continue;
    }
    if (start + length > bytes.length) break; // torn tail
    const payload = bytes.subarray(start, start + length);
    pos = start + length;
    if (maskCrc(crc32c(bytes.subarray(pos - length - 1, pos))) !== stored) {
      parts = null;
      continue;
    }
    try {
      if (type === FULL) {
        parts = null;
        applyBatch(payload, store);
      } else if (type === FIRST) {
        parts = [payload];
      } else if (type === MIDDLE && parts) {
        parts.push(payload);
      } else if (type === LAST && parts) {
        parts.push(payload);
        const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          whole.set(p, at);
          at += p.length;
        }
        parts = null;
        applyBatch(whole, store);
      }
    } catch {
      parts = null;
    }
  }
  return store;
}

/** Chromium's localStorage strings: a leading 1 means Latin-1, 0 UTF-16LE. */
export function chromiumString(bytes: Uint8Array): string | null {
  if (!bytes.length) return '';
  const body = bytes.subarray(1);
  if (bytes[0] === 1) return latin1(body);
  if (bytes[0] === 0) {
    let s = '';
    for (let i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode(body[i] | (body[i + 1] << 8));
    return s;
  }
  return null;
}

/**
 * The Electron renderer's localStorage out of the replayed log: key → value for
 * the origin holding Toji's keys (the app served its UI from a loopback address;
 * a development server may have left another origin behind).
 */
export function electronLocalStorage(store: Map<string, Uint8Array | null>): Record<string, string> {
  const byOrigin = new Map<string, Record<string, string>>();
  for (const [rawKey, value] of store) {
    if (!rawKey.startsWith('_')) continue;
    const sep = rawKey.indexOf('\x00');
    if (sep < 0) continue;
    const origin = rawKey.slice(1, sep);
    const key = chromiumString(Uint8Array.from(rawKey.slice(sep + 1), (ch) => ch.charCodeAt(0)));
    if (key === null) continue;
    const items = byOrigin.get(origin) ?? {};
    if (value === null) {
      delete items[key];
    } else {
      const text = chromiumString(value);
      if (text !== null) items[key] = text;
    }
    byOrigin.set(origin, items);
  }
  let best: Record<string, string> = {};
  let bestScore = 0;
  for (const items of byOrigin.values()) {
    const score = Object.keys(items).filter((k) => k.startsWith('toji')).length;
    if (score > bestScore) {
      best = items;
      bestScore = score;
    }
  }
  return best;
}

export interface MigratedSettings {
  theme?: 'light' | 'dark';
  layout?: 'top' | 'side';
  bookmarksBar?: 'pinned' | 'hover';
  /** The engine's display name, as Firefox's search service knows it. */
  searchEngine?: string;
  vaultAutosave?: boolean;
  replay?: boolean;
  onboarded?: boolean;
  agentMaxSteps?: number;
  agentNoLimit?: boolean;
}

const ENGINES: Record<string, string> = {
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  bing: 'Bing',
  brave: 'Brave',
  startpage: 'Startpage'
};

/** The Electron app's localStorage settings, in the Gecko browser's terms. */
export function electronSettings(items: Record<string, string>): MigratedSettings {
  const s: MigratedSettings = {};
  const theme = items['toji-theme'];
  if (theme === 'light' || theme === 'dark') s.theme = theme;
  const layout = items['toji-layout'];
  if (layout === 'top' || layout === 'side') s.layout = layout;
  const bar = items['toji-bookmarks-bar'];
  if (bar === 'pinned' || bar === 'hover') s.bookmarksBar = bar;
  const engine = ENGINES[(items['toji-search-engine'] ?? '').toLowerCase()];
  if (engine) s.searchEngine = engine;
  if ('toji-vault-autosave' in items) s.vaultAutosave = items['toji-vault-autosave'] !== 'off';
  if ('toji.replay' in items) s.replay = items['toji.replay'] !== 'off';
  if (items['toji-onboarded'] === '1') s.onboarded = true;
  const steps = Number(items['toji.agentMaxSteps']);
  if (Number.isInteger(steps) && steps > 0 && steps <= 500) s.agentMaxSteps = steps;
  if ('toji.agentNoLimit' in items) s.agentNoLimit = items['toji.agentNoLimit'] === '1';
  return s;
}

/** The container list the renderer saved (TojiContainers normalizes it). */
export function electronContainers(items: Record<string, string>): unknown[] {
  try {
    const list = JSON.parse(items['toji.containers'] ?? 'null');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The agent server's bookmarks.json: web links only, titled. */
export function electronBookmarks(value: unknown): { title: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { title: string; url: string }[] = [];
  for (const b of value) {
    if (!b || typeof b !== 'object') continue;
    const entry = b as Record<string, unknown>;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 500) : url;
    out.push({ title, url });
  }
  return out.slice(0, 5000);
}

/**
 * Decrypts Electron's `safeStorage` data on macOS (Chromium's os_crypt): "v10",
 * then AES-128-CBC with a key of PBKDF2-HMAC-SHA1(passphrase, "saltysalt", 1003
 * rounds) and an IV of 16 spaces. The passphrase is the app's Keychain item.
 * Rejects on anything else, or on a wrong passphrase (the padding won't check).
 */
export async function safeStorageDecrypt(passphrase: string, data: Uint8Array): Promise<string> {
  if (data.length < 19 || data[0] !== 0x76 || data[1] !== 0x31 || data[2] !== 0x30) {
    throw new Error('not safeStorage v10 data');
  }
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('saltysalt'), iterations: 1003, hash: 'SHA-1' },
    base,
    { name: 'AES-CBC', length: 128 },
    false,
    ['decrypt']
  );
  // slice, not subarray: WebCrypto takes ArrayBuffer-backed views only.
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16).fill(0x20) }, key, data.slice(3));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

export interface VaultDraft {
  origin: string;
  username: string;
  password: string;
  containerId: string | null;
  note: string;
}

/** The decrypted Electron vault (an array, or { entries }), as vault drafts. */
export function electronVaultDrafts(value: unknown): VaultDraft[] {
  const list = Array.isArray(value) ? value : Array.isArray((value as { entries?: unknown })?.entries) ? (value as { entries: unknown[] }).entries : [];
  const out: VaultDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.origin !== 'string' || !/^https?:\/\/[^/]+$/i.test(e.origin)) continue;
    if (typeof e.password !== 'string' || !e.password) continue;
    out.push({
      origin: e.origin,
      username: typeof e.username === 'string' ? e.username : '',
      password: e.password,
      containerId: typeof e.containerId === 'string' && e.containerId ? e.containerId : null,
      note: typeof e.note === 'string' ? e.note : ''
    });
  }
  return out;
}
