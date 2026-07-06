import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

// Persistent "reference documents" the user keeps in memory (e.g. a resume) that the
// agent can pull up at any time — to read for context or upload into a page's file input.
// Unlike per-tab dropped files (ephemeral), these live across sessions.

export interface ReferenceDoc {
  id: string;
  name: string;
  mime: string;
  path: string;
  size: number;
  addedAt: string;
}

const dir = path.join(config.dataDir, 'references');
const indexFile = path.join(dir, 'index.json');

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readIndex(): Promise<ReferenceDoc[]> {
  try {
    return JSON.parse(await fs.readFile(indexFile, 'utf8')) as ReferenceDoc[];
  } catch {
    return [];
  }
}

async function writeIndex(docs: ReferenceDoc[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${indexFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(docs, null, 2));
    await fs.rename(tmp, indexFile);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export function listReferences(): Promise<ReferenceDoc[]> {
  return enqueue(readIndex);
}

export function addReference(input: { name: string; mime?: string; dataBase64: string }): Promise<ReferenceDoc> {
  return enqueue(async () => {
    await fs.mkdir(dir, { recursive: true });
    const safe = input.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
    const id = randomUUID();
    const filePath = path.join(dir, `${id}-${safe}`);
    const buf = Buffer.from(input.dataBase64, 'base64');
    await fs.writeFile(filePath, buf);
    const doc: ReferenceDoc = { id, name: input.name, mime: input.mime ?? '', path: filePath, size: buf.length, addedAt: new Date().toISOString() };
    const docs = await readIndex();
    docs.push(doc);
    try {
      await writeIndex(docs);
    } catch (error) {
      await fs.unlink(filePath).catch(() => undefined);
      throw error;
    }
    return doc;
  });
}

export function removeReference(id: string): Promise<boolean> {
  return enqueue(async () => {
    const docs = await readIndex();
    const doc = docs.find((d) => d.id === id);
    if (!doc) return false;
    await fs.unlink(doc.path).catch(() => undefined);
    await writeIndex(docs.filter((d) => d.id !== id));
    return true;
  });
}
