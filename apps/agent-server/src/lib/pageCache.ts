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

function cacheKey(theme: string, query: string) {
  return hashString(`page|${theme}|${normalizeWhitespace(query).toLowerCase()}`);
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

/** Return a previously generated page for this exact (theme, query), if any. */
export async function getCachedPage(theme: string, query: string): Promise<string | undefined> {
  const state = await loadCache();
  const entry = state.entries[cacheKey(theme, query)];
  return entry && isFresh(entry.savedAt) ? entry.html : undefined;
}

/** Store a fully generated page. Serialized via a write chain; pruned to the newest MAX_ENTRIES. */
export function putCachedPage(theme: string, query: string, html: string) {
  writeChain = writeChain
    .then(async () => {
      const state = await loadCache();
      state.entries[cacheKey(theme, query)] = { savedAt: new Date().toISOString(), html };
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
      console.error('[toji] putCachedPage write failed:', error instanceof Error ? error.message : error);
    });
  return writeChain;
}
