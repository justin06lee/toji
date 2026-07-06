import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

// Hermes-style agent memory: two pinned Markdown files (always-on context) plus an
// append log of discrete "facts" that the librarian retrieves on demand. Storage
// mirrors lib/storage.ts: atomic temp-file write + rename, guarded by an in-memory
// write chain so concurrent writers never clobber each other.

const memoryDir = path.join(config.dataDir, 'memory');
const factsFile = path.join(memoryDir, 'facts.json');
const memoryFile = path.join(memoryDir, 'MEMORY.md');
const userFile = path.join(memoryDir, 'USER.md');

/** Char caps on the always-in-context pinned files (≈800 / ≈500 tokens). */
export const PINNED_CAPS = { memory: 2200, user: 1400 } as const;

/** Most facts retained on disk; oldest are dropped past this. */
const MAX_FACTS = 1000;
/** Max length of a single fact's text. */
const MAX_FACT_CHARS = 500;

export interface MemoryFact {
  id: string;
  ts: string;
  text: string;
  tags: string[];
  sessionId?: string;
}

// Per-file write chain so overlapping writes to the same file serialize. The chain
// promise must never reject, or a later task would be skipped.
const writeChains = new Map<string, Promise<void>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(() => task());
  const chain = run.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(key, chain);
  void chain.finally(() => {
    if (writeChains.get(key) === chain) writeChains.delete(key);
  });
  return run;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function listFacts(): Promise<MemoryFact[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(factsFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as MemoryFact[]) : [];
  } catch {
    // Missing or corrupt file → no facts yet.
    return [];
  }
}

export async function addFact(input: { text: string; tags?: string[]; sessionId?: string }): Promise<MemoryFact> {
  const fact: MemoryFact = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    text: String(input.text ?? '').trim().slice(0, MAX_FACT_CHARS),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    ...(input.sessionId ? { sessionId: input.sessionId } : {})
  };
  return enqueue('facts', async () => {
    const facts = await listFacts();
    facts.push(fact);
    // Keep the newest MAX_FACTS (drop oldest from the front).
    const trimmed = facts.length > MAX_FACTS ? facts.slice(facts.length - MAX_FACTS) : facts;
    await atomicWrite(factsFile, JSON.stringify(trimmed, null, 2));
    return fact;
  });
}

export async function removeFact(id: string): Promise<boolean> {
  return enqueue('facts', async () => {
    const facts = await listFacts();
    const next = facts.filter((f) => f.id !== id);
    if (next.length === facts.length) return false;
    await atomicWrite(factsFile, JSON.stringify(next, null, 2));
    return true;
  });
}

export async function readPinned(): Promise<{ memory: string; user: string }> {
  const read = async (file: string) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  };
  const [memory, user] = await Promise.all([read(memoryFile), read(userFile)]);
  return { memory, user };
}

export async function writePinned(kind: 'memory' | 'user', content: string): Promise<void> {
  const cap = PINNED_CAPS[kind];
  if (content.length > cap) {
    throw new Error(`${kind === 'memory' ? 'MEMORY.md' : 'USER.md'} exceeds its ${cap}-character cap (got ${content.length}). Consolidate or remove entries first.`);
  }
  const file = kind === 'memory' ? memoryFile : userFile;
  return enqueue(kind, () => atomicWrite(file, content));
}
