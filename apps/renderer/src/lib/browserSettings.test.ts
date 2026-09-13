import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSettings, TojiBridge } from './bridge';

const SETTINGS: BrowserSettings = {
  theme: 'light',
  layout: 'top',
  bookmarksBar: 'pinned',
  searchEngine: 'DuckDuckGo',
  searchEngines: [{ name: 'DuckDuckGo' }, { name: 'Google' }],
  vaultAutosave: true,
  replay: true,
  adblock: true
};

/** A fresh copy of the module (its store is module state) against a fake window.toji. */
async function load(toji: TojiBridge) {
  vi.resetModules();
  vi.stubGlobal('window', { toji });
  return import('./browserSettings');
}

/** A fake bridge whose settings live in memory, and which can announce changes. */
function fakeBridge(overrides: Partial<TojiBridge> = {}) {
  let current = { ...SETTINGS };
  const listeners: ((s: BrowserSettings) => void)[] = [];
  const toji: TojiBridge = {
    settings: vi.fn(async () => current),
    setSetting: vi.fn(async (key, value) => (current = { ...current, [key]: value })),
    onSettingsChanged: (callback) => {
      listeners.push(callback);
      return () => {};
    },
    ...overrides
  };
  const announce = (patch: Partial<BrowserSettings>) => {
    current = { ...current, ...patch };
    listeners.forEach((l) => l(current));
  };
  return { toji, announce };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser settings store', () => {
  it('reads once and follows onSettingsChanged', async () => {
    const { toji, announce } = fakeBridge();
    const store = await load(toji);
    expect(store.hasBrowserSettings()).toBe(true);
    const seen: string[] = [];
    store.watchBrowserSettings((s) => seen.push(s.theme));
    store.watchBrowserSettings(() => {});
    await flush();
    expect(toji.settings).toHaveBeenCalledTimes(1);
    announce({ theme: 'dark' });
    expect(seen).toEqual(['light', 'dark']);
    expect(store.currentBrowserSettings()?.theme).toBe('dark');
  });

  it('shows a change at once, then keeps what the browser answered', async () => {
    const { toji } = fakeBridge({ setSetting: vi.fn(async () => ({ ...SETTINGS, searchEngine: 'Google', layout: 'side' as const })) });
    const store = await load(toji);
    const seen: BrowserSettings[] = [];
    store.watchBrowserSettings((s) => seen.push(s));
    await flush();
    const pending = store.setBrowserSetting('searchEngine', 'Google');
    expect(store.currentBrowserSettings()?.searchEngine).toBe('Google');
    await pending;
    expect(toji.setSetting).toHaveBeenCalledWith('searchEngine', 'Google');
    expect(store.currentBrowserSettings()?.layout).toBe('side');
  });

  it('puts the browser value back when a change is refused', async () => {
    const { toji } = fakeBridge({ setSetting: vi.fn(async () => Promise.reject(new Error('locked'))) });
    const store = await load(toji);
    store.watchBrowserSettings(() => {});
    await flush();
    await store.setBrowserSetting('adblock', false);
    expect(store.currentBrowserSettings()?.adblock).toBe(true);
  });

  it('does nothing without the bridge', async () => {
    const store = await load({});
    expect(store.hasBrowserSettings()).toBe(false);
    const listener = vi.fn();
    store.watchBrowserSettings(listener);
    await store.setBrowserSetting('theme', 'dark');
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(store.currentBrowserSettings()).toBeNull();
  });
});

describe('isDarkTheme', () => {
  it("follows the browser's theme, or the system's without one", async () => {
    const { isDarkTheme } = await load({});
    expect(isDarkTheme({ theme: 'dark' }, false)).toBe(true);
    expect(isDarkTheme({ theme: 'light' }, true)).toBe(false);
    expect(isDarkTheme(null, true)).toBe(true);
    expect(isDarkTheme(null, false)).toBe(false);
  });
});
