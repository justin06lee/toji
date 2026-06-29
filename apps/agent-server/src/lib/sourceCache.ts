import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SourceNote } from '../types.js';
import { hashString, normalizeUrl } from './text.js';

interface CacheEntry {
  savedAt: string;
  note: SourceNote;
}

interface CacheState {
  entries: Record<string, CacheEntry>;
}

const cachePath = path.join(config.dataDir, 'source-cache.json');
let writeChain = Promise.resolve();

// Authoritative in-memory copy of the cache state, loaded lazily from disk on
// first access. Because writeChain serializes all writes within this single
// process, mutating this object in place keeps it consistent with the file and
// avoids a full re-read/parse on every put.
let cacheStatePromise: Promise<CacheState> | undefined;

function loadCache(): Promise<CacheState> {
  if (!cacheStatePromise) {
    cacheStatePromise = readCache();
  }
  return cacheStatePromise;
}

function cacheKey(queryFingerprint: string, url: string) {
  return hashString(`${queryFingerprint}|${normalizeUrl(url)}`);
}

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function readCache(): Promise<CacheState> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as CacheState;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

const MAX_CACHE_ENTRIES = 500;

function isFresh(savedAt: string) {
  const ageMs = Date.now() - Date.parse(savedAt);
  return ageMs >= 0 && ageMs < config.cacheTtlHours * 60 * 60 * 1000;
}

/** Drop expired entries and cap the cache to its newest MAX_CACHE_ENTRIES. */
function pruneEntries(entries: Record<string, CacheEntry>): Record<string, CacheEntry> {
  const live = Object.entries(entries).filter(([, entry]) => isFresh(entry.savedAt));
  if (live.length <= MAX_CACHE_ENTRIES) return Object.fromEntries(live);
  live.sort(([, a], [, b]) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  return Object.fromEntries(live.slice(0, MAX_CACHE_ENTRIES));
}

export async function getCachedSource(queryFingerprint: string, url: string): Promise<SourceNote | undefined> {
  const state = await loadCache();
  const entry = state.entries[cacheKey(queryFingerprint, url)];
  if (!entry || !isFresh(entry.savedAt)) return undefined;
  return { ...entry.note, cacheHit: true };
}

export function putCachedSource(queryFingerprint: string, url: string, note: SourceNote) {
  writeChain = writeChain
    .then(async () => {
      const state = await loadCache();
      state.entries[cacheKey(queryFingerprint, url)] = {
        savedAt: new Date().toISOString(),
        note: { ...note, cacheHit: false }
      };
      state.entries = pruneEntries(state.entries);
      await ensureDir();
      const temp = `${cachePath}.tmp`;
      await fs.writeFile(temp, JSON.stringify(state, null, 2));
      await fs.rename(temp, cachePath);
    })
    .catch(() => undefined);
  return writeChain;
}
