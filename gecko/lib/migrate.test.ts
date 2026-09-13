import { describe, expect, it } from 'vitest';
import {
  chromiumString,
  crc32c,
  electronBookmarks,
  electronContainers,
  electronLocalStorage,
  electronSettings,
  electronVaultDrafts,
  maskCrc,
  readLevelDbLog,
  safeStorageDecrypt
} from './migrate';

/** What Electron's safeStorage writes on macOS, for the decrypt tests. */
async function safeStorageEncrypt(passphrase: string, text: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('saltysalt'), iterations: 1003, hash: 'SHA-1' },
    base,
    { name: 'AES-CBC', length: 128 },
    false,
    ['encrypt']
  );
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16).fill(0x20) }, key, encoder.encode(text)));
  const out = new Uint8Array(3 + cipher.length);
  out.set(encoder.encode('v10'));
  out.set(cipher, 3);
  return out;
}

describe('safeStorage', () => {
  it('decrypts what Electron wrote', async () => {
    const text = JSON.stringify([{ origin: 'https://a.test', username: 'me', password: 'pw ✓' }]);
    expect(await safeStorageDecrypt('Kq3/x9lB0aBbCcDdEeFf==', await safeStorageEncrypt('Kq3/x9lB0aBbCcDdEeFf==', text))).toBe(text);
  });

  it('refuses a wrong passphrase and data that is not safeStorage', async () => {
    const data = await safeStorageEncrypt('right', 'secret text that is long enough');
    await expect(safeStorageDecrypt('wrong', data)).rejects.toThrow();
    await expect(safeStorageDecrypt('right', new TextEncoder().encode('plain JSON, not encrypted'))).rejects.toThrow();
  });
});

// --- A small LevelDB log writer, as leveldb::log::Writer lays records out ---

const BLOCK = 32768;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

type Op = [key: Uint8Array, value: Uint8Array | null];

function batch(seq: number, ops: Op[]): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) bytes.push(i === 0 ? seq : 0);
  const count = ops.length;
  bytes.push(count & 0xff, (count >> 8) & 0xff, (count >> 16) & 0xff, (count >> 24) & 0xff);
  for (const [key, value] of ops) {
    bytes.push(value ? 1 : 0, ...varint(key.length), ...key);
    if (value) bytes.push(...varint(value.length), ...value);
  }
  return Uint8Array.from(bytes);
}

function record(type: number, payload: Uint8Array): number[] {
  const typed = new Uint8Array(payload.length + 1);
  typed[0] = type;
  typed.set(payload, 1);
  const crc = maskCrc(crc32c(typed));
  return [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff, payload.length & 0xff, payload.length >> 8, type, ...payload];
}

/** Lays batches out in 32 KiB blocks, splitting across blocks as LevelDB does. */
function log(batches: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const b of batches) {
    let rest = b;
    let first = true;
    while (true) {
      let left = BLOCK - (out.length % BLOCK);
      if (left < 7) {
        for (let i = 0; i < left; i++) out.push(0);
        left = BLOCK;
      }
      const room = left - 7;
      const piece = rest.subarray(0, room);
      const end = piece.length === rest.length;
      const type = first && end ? 1 : first ? 2 : end ? 4 : 3;
      out.push(...record(type, piece));
      rest = rest.subarray(piece.length);
      first = false;
      if (end) break;
    }
  }
  return Uint8Array.from(out);
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf16 = (s: string) => {
  const out = [0];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push(code & 0xff, code >> 8);
  }
  return Uint8Array.from(out);
};
const lsKey = (origin: string, key: string) => latin1(`_${origin}\x00\x01${key}`);
const lsValue = (value: string) => Uint8Array.from([1, ...latin1(value)]);
const ORIGIN = 'http://127.0.0.1:8788';

describe('LevelDB log', () => {
  it('replays puts and deletes in order', () => {
    const bytes = log([
      batch(1, [[latin1('a'), latin1('1')], [latin1('b'), latin1('2')]]),
      batch(3, [[latin1('a'), latin1('3')], [latin1('b'), null]])
    ]);
    const store = readLevelDbLog(bytes);
    expect(new TextDecoder().decode(store.get('a')!)).toBe('3');
    expect(store.get('b')).toBeNull();
  });

  it('joins a batch split across blocks', () => {
    const big = latin1('x'.repeat(50000));
    const store = readLevelDbLog(log([batch(1, [[latin1('pad'), latin1('y'.repeat(32000))]]), batch(2, [[latin1('big'), big]])]));
    expect(store.get('big')!.length).toBe(50000);
    expect(store.get('pad')!.length).toBe(32000);
  });

  it('skips a record whose checksum fails and stops at a torn tail', () => {
    const good = log([batch(1, [[latin1('k'), latin1('good')]])]);
    const bad = log([batch(2, [[latin1('k'), latin1('evil')]])]);
    bad[bad.length - 1] ^= 0xff; // corrupt the payload, not the header
    const joined = new Uint8Array(good.length + bad.length + 5);
    joined.set(good);
    joined.set(bad, good.length);
    joined.set([1, 2, 3, 4, 5], good.length + bad.length); // a torn header
    const store = readLevelDbLog(joined);
    expect(new TextDecoder().decode(store.get('k')!)).toBe('good');
  });

  it('reads nothing from garbage', () => {
    expect(readLevelDbLog(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9])).size).toBe(0);
  });
});

describe('Chromium localStorage', () => {
  it('decodes Latin-1 and UTF-16 strings', () => {
    expect(chromiumString(Uint8Array.from([1, 104, 105]))).toBe('hi');
    expect(chromiumString(utf16('héllo ✓'))).toBe('héllo ✓');
    expect(chromiumString(Uint8Array.from([7, 1]))).toBeNull();
  });

  it("picks the origin that holds Toji's keys, latest write winning", () => {
    const store = readLevelDbLog(
      log([
        batch(1, [
          [latin1('VERSION'), latin1('1')],
          [lsKey('http://localhost:5173', 'other'), lsValue('x')],
          [lsKey(ORIGIN, 'toji-theme'), lsValue('dark')],
          [lsKey(ORIGIN, 'toji-layout'), lsValue('top')]
        ]),
        batch(5, [
          [lsKey(ORIGIN, 'toji-theme'), lsValue('light')],
          [lsKey(ORIGIN, 'toji-layout'), null]
        ])
      ])
    );
    expect(electronLocalStorage(store)).toEqual({ 'toji-theme': 'light' });
  });
});

describe('settings', () => {
  it("maps the Electron app's keys", () => {
    expect(
      electronSettings({
        'toji-theme': 'light',
        'toji-layout': 'side',
        'toji-bookmarks-bar': 'hover',
        'toji-search-engine': 'duckduckgo',
        'toji-vault-autosave': 'off',
        'toji.replay': 'on',
        'toji-onboarded': '1',
        'toji.agentMaxSteps': '40',
        'toji.agentNoLimit': '0'
      })
    ).toEqual({
      theme: 'light',
      layout: 'side',
      bookmarksBar: 'hover',
      searchEngine: 'DuckDuckGo',
      vaultAutosave: false,
      replay: true,
      onboarded: true,
      agentMaxSteps: 40,
      agentNoLimit: false
    });
  });

  it('ignores values it does not know', () => {
    expect(electronSettings({ 'toji-theme': 'neon', 'toji-search-engine': 'altavista', 'toji.agentMaxSteps': '-3' })).toEqual({});
  });

  it('reads the container list', () => {
    expect(electronContainers({ 'toji.containers': '[{"id":"work","name":"Work"}]' })).toEqual([{ id: 'work', name: 'Work' }]);
    expect(electronContainers({ 'toji.containers': 'nope' })).toEqual([]);
    expect(electronContainers({})).toEqual([]);
  });
});

describe('bookmarks and vault', () => {
  it('keeps titled web bookmarks', () => {
    expect(
      electronBookmarks([
        { id: '1', title: 'Docs', url: 'https://developer.mozilla.org/', addedAt: '' },
        { id: '2', title: '', url: 'http://example.com' },
        { id: '3', title: 'Script', url: 'javascript:alert(1)' },
        null
      ])
    ).toEqual([
      { title: 'Docs', url: 'https://developer.mozilla.org/' },
      { title: 'http://example.com', url: 'http://example.com' }
    ]);
    expect(electronBookmarks({})).toEqual([]);
  });

  it('turns vault entries into drafts, skipping the unusable', () => {
    const entries = [
      { id: 'a', origin: 'https://a.test', username: 'me', password: 'pw', containerId: 'work', note: 'n' },
      { id: 'b', origin: 'https://b.test/path', username: 'x', password: 'pw' },
      { id: 'c', origin: 'https://c.test', username: 'x', password: '' },
      { id: 'd', origin: 'https://d.test', password: 'pw', containerId: '' }
    ];
    const expected = [
      { origin: 'https://a.test', username: 'me', password: 'pw', containerId: 'work', note: 'n' },
      { origin: 'https://d.test', username: '', password: 'pw', containerId: null, note: '' }
    ];
    expect(electronVaultDrafts(entries)).toEqual(expected);
    expect(electronVaultDrafts({ entries })).toEqual(expected);
    expect(electronVaultDrafts('nope')).toEqual([]);
  });
});
