import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

// A simple bookmarks store (e.g. populated by importing from other browsers).
// Storage mirrors lib/storage.ts: atomic temp-file write + rename, guarded by an
// in-memory write chain so concurrent writers never clobber each other.

const bookmarksFile = path.join(config.dataDir, 'bookmarks.json');

/** Most bookmarks retained; imports past this are ignored. */
const MAX_BOOKMARKS = 5000;

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  folder?: string;
  addedAt: string;
}

let chain: Promise<void> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(() => task());
  // The chain promise must never reject, or a later task would be skipped.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function atomicWrite(contents: string): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${bookmarksFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, bookmarksFile);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function listBookmarks(): Promise<Bookmark[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(bookmarksFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Bookmark[]) : [];
  } catch {
    // Missing or corrupt file → no bookmarks yet.
    return [];
  }
}

/** Add bookmarks, deduping by URL against what's already stored. Returns the count added. */
export async function addBookmarks(items: { title: string; url: string; folder?: string }[]): Promise<number> {
  return enqueue(async () => {
    const existing = await listBookmarks();
    const seen = new Set(existing.map((b) => b.url));
    const now = new Date().toISOString();
    let added = 0;
    for (const item of items) {
      const url = String(item.url ?? '').trim();
      if (!url || seen.has(url)) continue;
      if (existing.length + added >= MAX_BOOKMARKS) break;
      seen.add(url);
      existing.push({ id: randomUUID(), title: String(item.title ?? url).trim().slice(0, 300), url, folder: item.folder, addedAt: now });
      added += 1;
    }
    if (added > 0) await atomicWrite(JSON.stringify(existing, null, 2));
    return added;
  });
}

export async function removeBookmark(id: string): Promise<boolean> {
  return enqueue(async () => {
    const existing = await listBookmarks();
    const next = existing.filter((b) => b.id !== id);
    if (next.length === existing.length) return false;
    await atomicWrite(JSON.stringify(next, null, 2));
    return true;
  });
}

export async function clearBookmarks(): Promise<void> {
  return enqueue(() => atomicWrite('[]'));
}
