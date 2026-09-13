// Settings the Gecko browser owns (theme, layout, search engine, bookmarks bar, vault
// autosave, the replay buffer, ad blocking), read and written through window.toji and
// shared by every section of a page that shows one. One read and one subscription per
// page, however many sections ask.
//
// In the Electron app these are localStorage keys and none of this runs:
// hasBrowserSettings() is false there, and each section keeps its localStorage path.

import { useSyncExternalStore } from 'react';
import { bridge, type BrowserSettings } from './bridge';

let snapshot: BrowserSettings | null = null;
let started = false;
const listeners = new Set<(settings: BrowserSettings) => void>();

function publish(next: BrowserSettings) {
  snapshot = next;
  for (const listener of [...listeners]) listener(next);
}

function start() {
  if (started) return;
  started = true;
  const toji = bridge();
  if (!toji.settings) return;
  void toji.settings().then(publish, () => {});
  toji.onSettingsChanged?.(publish);
}

/** True when the browser owns these settings (the Gecko bridge is present). */
export const hasBrowserSettings = (): boolean => Boolean(bridge().settings);

/** The latest settings, or null until the browser has answered. */
export const currentBrowserSettings = (): BrowserSettings | null => snapshot;

/** Follow the settings; called at once if they are already known. Returns the unsubscribe. */
export function watchBrowserSettings(listener: (settings: BrowserSettings) => void): () => void {
  listeners.add(listener);
  start();
  if (snapshot) listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

/** The browser's settings in a component; null without the bridge or before the first answer. */
export function useBrowserSettings(): BrowserSettings | null {
  return useSyncExternalStore(watchBrowserSettings, currentBrowserSettings, currentBrowserSettings);
}

/**
 * Change one setting. The page shows the new value at once; the browser's answer (or
 * the next onSettingsChanged) is what sticks, and a refusal puts the browser's value back.
 */
export async function setBrowserSetting<K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]): Promise<void> {
  const toji = bridge();
  if (!toji.setSetting) return;
  if (snapshot) publish({ ...snapshot, [key]: value });
  try {
    const next = await toji.setSetting(key, value);
    if (next) publish(next);
  } catch {
    const actual = await toji.settings?.().catch(() => null);
    if (actual) publish(actual);
  }
}

/** Dark when the browser says so; without the browser's settings, follow the system. */
export function isDarkTheme(settings: Pick<BrowserSettings, 'theme'> | null, systemPrefersDark: boolean): boolean {
  return settings ? settings.theme === 'dark' : systemPrefersDark;
}
