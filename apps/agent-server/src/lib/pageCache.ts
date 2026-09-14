import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { hashString, normalizeWhitespace } from './text.js';

interface PageEntry {
  savedAt: string;
  html: string;
}

interface PageCacheState {
  entries: Record<string, PageEntry>;
}

const cachePath = path.join(config.dataDir, 'page-cache.json');
const MAX_ENTRIES = 200;
let writeChain = Promise.resolve();
let statePromise: Promise<PageCacheState> | undefined;

// Pages are theme-neutral (they follow prefers-color-scheme), so one entry serves both
// themes. The version tag retires entries from when pages were generated per theme.
function cacheKey(query: string) {
  return hashString(`page|v2|${normalizeWhitespace(query).toLowerCase()}`);
}

function isFresh(savedAt: string) {
  const ageMs = Date.now() - Date.parse(savedAt);
  return ageMs >= 0 && ageMs < config.cacheTtlHours * 60 * 60 * 1000;
}

async function readCache(): Promise<PageCacheState> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as PageCacheState;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

function loadCache(): Promise<PageCacheState> {
  if (!statePromise) statePromise = readCache();
  return statePromise;
}

/** Return a previously generated page for this exact query, if any. */
export async function getCachedPage(query: string): Promise<string | undefined> {
  const state = await loadCache();
  const entry = state.entries[cacheKey(query)];
  return entry && isFresh(entry.savedAt) ? entry.html : undefined;
}

const FLUSH_DELAY_MS = 1000;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushWaiters: Array<() => void> = [];

/** Writes the whole cache once, a moment after the last put; pruned to the newest MAX_ENTRIES. */
function scheduleFlush(): Promise<void> {
  return new Promise((resolve) => {
    flushWaiters.push(resolve);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      const waiters = flushWaiters;
      flushWaiters = [];
      writeChain = writeChain
        .then(async () => {
          const state = await loadCache();
          const entries = Object.entries(state.entries);
          if (entries.length > MAX_ENTRIES) {
            entries.sort(([, a], [, b]) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
            state.entries = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
          }
          await fs.mkdir(config.dataDir, { recursive: true });
          const temp = `${cachePath}.tmp`;
          await fs.writeFile(temp, JSON.stringify(state));
          await fs.rename(temp, cachePath);
        })
        .catch((error) => {
          console.error('[toji] page cache write failed:', error instanceof Error ? error.message : error);
        })
        .then(() => waiters.forEach((w) => w()));
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  });
}

/** Store a fully generated page: in memory at once, on disk a moment later. */
export async function putCachedPage(query: string, html: string) {
  const state = await loadCache();
  state.entries[cacheKey(query)] = { savedAt: new Date().toISOString(), html };
  return scheduleFlush();
}
