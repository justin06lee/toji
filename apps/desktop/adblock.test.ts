import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { Adblock, REFRESH_MS } = require('./adblock.cjs') as typeof import('./adblock.cjs');

const dirs: string[] = [];
const freshDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'toji-adblock-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in engine that blocks one host and hides one element. */
function fakeEngine(tag = 'v1') {
  return {
    tag,
    onBeforeRequest: vi.fn((details: { url: string }, cb: (d: unknown) => void) => cb(details.url.includes('ads.example') ? { cancel: true } : {})),
    onHeadersReceived: vi.fn((_d: unknown, cb: (d: unknown) => void) => cb({})),
    onInjectCosmeticFilters: vi.fn(async () => 'injected'),
    config: { enableMutationObserver: true }
  };
}

const fakeSession = () => ({
  webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
  registerPreloadScript: vi.fn()
});

function make(dir: string, overrides: Partial<ConstructorParameters<typeof Adblock>[0]> = {}) {
  const ipcMain = { handle: vi.fn() };
  const built = new Uint8Array([1, 2, 3]);
  const adblock = new Adblock({
    dataDir: dir,
    ipcMain,
    buildEngine: vi.fn(async () => built),
    deserialize: vi.fn((bytes: Uint8Array) => fakeEngine(bytes.length === 3 ? 'built' : 'cached')),
    preloadPath: '/fake/preload.cjs',
    ...overrides
  });
  return { adblock, ipcMain };
}

/** Run the request gate the blocker joined and return its decision. */
function decide(sess: ReturnType<typeof fakeSession>, url: string) {
  const listener = sess.webRequest.onBeforeRequest.mock.calls[0][1];
  const callback = vi.fn();
  listener({ url }, callback);
  return callback.mock.calls[0][0];
}

describe('Adblock', () => {
  it('is on by default and remembers being switched off', () => {
    const dir = freshDir();
    const { adblock } = make(dir);
    expect(adblock.status().enabled).toBe(true);
    adblock.setEnabled(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'adblock.json'), 'utf8'))).toEqual({ enabled: false });
    expect(make(dir).adblock.status().enabled).toBe(false);
  });

  it('builds the engine when nothing is cached and caches what it built', async () => {
    const dir = freshDir();
    const { adblock } = make(dir);
    await adblock.load();
    expect(adblock.status().ready).toBe(true);
    expect(Array.from(readFileSync(path.join(dir, 'adblock-engine.bin')))).toEqual([1, 2, 3]);
  });

  it('loads a fresh cache without touching the network', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'adblock-engine.bin'), new Uint8Array([9, 9]));
    const build = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const { adblock } = make(dir, { buildEngine: build });
    await adblock.load();
    expect((adblock.engine as unknown as { tag: string }).tag).toBe('cached');
    expect(build).not.toHaveBeenCalled();
  });

  it('uses a stale cache at once and refreshes it behind the page', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'adblock-engine.bin');
    writeFileSync(file, new Uint8Array([9, 9]));
    const old = (Date.now() - REFRESH_MS - 60_000) / 1000;
    utimesSync(file, old, old);
    let resolveBuild: (bytes: Uint8Array) => void = () => {};
    const build = vi.fn(() => new Promise<Uint8Array>((resolve) => (resolveBuild = resolve)));
    const { adblock } = make(dir, { buildEngine: build });
    await adblock.load();
    expect((adblock.engine as unknown as { tag: string }).tag).toBe('cached');
    expect(build).toHaveBeenCalledTimes(1);
    resolveBuild(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect((adblock.engine as unknown as { tag: string }).tag).toBe('built'));
  });

  it('a failed build keeps the engine that was there', async () => {
    const dir = freshDir();
    const { adblock } = make(dir, { buildEngine: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await adblock.load();
    expect(adblock.status().ready).toBe(false);
    expect(adblock.active()).toBe(false);
  });

  it('joins the session behind the kill switch, and passes everything until an engine exists', async () => {
    const dir = freshDir();
    const { adblock } = make(dir);
    const sess = fakeSession();
    adblock.attach(sess);
    const { requestGate } = require('./request-gate.cjs') as typeof import('./request-gate.cjs');
    expect(requestGate(sess).checks.map((c) => [c.name, c.priority])).toEqual([['adblock', 10]]);
    expect(decide(sess, 'https://ads.example/x.js')).toEqual({});
    await adblock.load();
    expect(decide(sess, 'https://ads.example/x.js')).toEqual({ cancel: true });
    expect(decide(sess, 'https://example.com/')).toEqual({});
    expect(adblock.status().blocked).toBe(1);
  });

  it('stands down entirely when switched off', async () => {
    const dir = freshDir();
    const { adblock, ipcMain } = make(dir);
    const sess = fakeSession();
    adblock.attach(sess);
    await adblock.load();
    adblock.setEnabled(false);
    expect(decide(sess, 'https://ads.example/x.js')).toEqual({});
    const cosmetics = ipcMain.handle.mock.calls.find(([channel]) => channel === '@ghostery/adblocker/inject-cosmetic-filters')![1];
    expect(cosmetics({}, 'https://example.com/')).toBeUndefined();
    adblock.setEnabled(true);
    await expect(cosmetics({}, 'https://example.com/')).resolves.toBe('injected');
  });

  it('registers the cosmetic preload once per session and the IPC answers once overall', () => {
    const dir = freshDir();
    const { adblock, ipcMain } = make(dir);
    const a = fakeSession();
    const b = fakeSession();
    adblock.attach(a);
    adblock.attach(a);
    adblock.attach(b);
    expect(a.registerPreloadScript).toHaveBeenCalledTimes(1);
    expect(a.registerPreloadScript).toHaveBeenCalledWith({ type: 'frame', filePath: '/fake/preload.cjs' });
    expect(b.registerPreloadScript).toHaveBeenCalledTimes(1);
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel).sort()).toEqual(['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled']);
  });
});
