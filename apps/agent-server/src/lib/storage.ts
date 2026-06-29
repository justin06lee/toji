import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { defaultAgentChoice } from '../agents/agentRuntime.js';
import type { ResearchSessionState, UserSettings } from '../types.js';

const sessionsDir = path.join(config.dataDir, 'sessions');

/** Cap on snapshot files retained on disk; mirrors loadSessions' read window. */
const SNAPSHOT_RETENTION = Math.max(config.sessionHistoryLimit, 50);

/** Only plain identifiers are allowed in snapshot file paths (no separators). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && SESSION_ID_PATTERN.test(id);
}

export async function ensureDataDirs() {
  await fs.mkdir(sessionsDir, { recursive: true });
}

function fileForSession(id: string) {
  if (!isValidSessionId(id)) {
    throw new Error(`Invalid session id: ${String(id)}`);
  }
  const file = path.join(sessionsDir, `${id}.json`);
  // Defense in depth: ensure the resolved file never escapes the sessions dir.
  if (path.dirname(path.resolve(file)) !== path.resolve(sessionsDir)) {
    throw new Error(`Session path escapes sessions directory: ${id}`);
  }
  return file;
}

// Per-session write chain so saves/removes for one id never interleave and
// concurrent writers never clobber each other's temp file (see researchAgent emit()).
const writeChains = new Map<string, Promise<void>>();

function enqueueForSession<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(id) ?? Promise.resolve();
  const run = prev.then(() => task());
  // The chain used for sequencing must never reject, or the next task would be skipped.
  const chain = run.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(id, chain);
  void chain.finally(() => {
    if (writeChains.get(id) === chain) writeChains.delete(id);
  });
  return run;
}

/** Best-effort prune of the oldest snapshot files beyond the retention cap. */
async function pruneSnapshots() {
  try {
    const names = await fs.readdir(sessionsDir);
    const jsonFiles = names.filter((name) => name.endsWith('.json'));
    if (jsonFiles.length <= SNAPSHOT_RETENTION) return;
    const stats: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of jsonFiles) {
      const file = path.join(sessionsDir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) stats.push({ file, mtimeMs: stat.mtimeMs });
    }
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of stats.slice(SNAPSHOT_RETENTION)) {
      await fs.unlink(item.file).catch(() => undefined);
    }
  } catch {
    // Pruning is best-effort and must never block or fail a save.
  }
}

export async function saveSession(session: ResearchSessionState) {
  const id = session.id;
  return enqueueForSession(id, async () => {
    await ensureDataDirs();
    const file = fileForSession(id);
    // Unique temp name so overlapping writers never share a temp path.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(session, null, 2));
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
    await pruneSnapshots();
  });
}

/** Default missing/invalid array fields so partial snapshots can't break clients. */
function normalizeSession(session: ResearchSessionState): ResearchSessionState {
  return {
    ...session,
    tabs: Array.isArray(session.tabs) ? session.tabs : [],
    sources: Array.isArray(session.sources) ? session.sources : []
  };
}

export async function loadSessions(limit = config.sessionHistoryLimit): Promise<ResearchSessionState[]> {
  await ensureDataDirs();
  const names = await fs.readdir(sessionsDir).catch(() => []);
  const files = names.filter((name) => name.endsWith('.json')).map((name) => path.join(sessionsDir, name));
  const stats: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat) stats.push({ file, mtimeMs: stat.mtimeMs });
  }

  const sessions: ResearchSessionState[] = [];
  for (const item of stats.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)) {
    try {
      sessions.push(normalizeSession(JSON.parse(await fs.readFile(item.file, 'utf8')) as ResearchSessionState));
    } catch {
      // Ignore corrupt session snapshots instead of crashing startup.
    }
  }
  return sessions;
}

export async function countSessions() {
  await ensureDataDirs();
  const names = await fs.readdir(sessionsDir).catch(() => []);
  return names.filter((name) => name.endsWith('.json')).length;
}

export async function removeSessionSnapshot(id: string) {
  // Invalid ids can never correspond to a stored snapshot; treat as "nothing removed".
  if (!isValidSessionId(id)) return false;
  // Run through the same per-id chain so a delete always lands after any queued
  // save for that id, and an in-flight save can't resurrect a deleted snapshot.
  return enqueueForSession(id, async () => {
    const file = fileForSession(id);
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
}

export async function removeSessionSnapshots(ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  const removed: string[] = [];
  for (const id of uniqueIds) {
    if (await removeSessionSnapshot(id)) removed.push(id);
  }
  return removed;
}

const settingsFile = path.join(config.dataDir, 'settings.json');

export function defaultSettings(): UserSettings {
  const agentChoice = defaultAgentChoice();
  return {
    autoSpeculation: true,
    maxTabs: config.maxAgentTabs,
    defaultDepth: 'standard',
    defaultFreshness: 'auto',
    visualAnalysis: config.enableVisualAnalysis,
    theme: 'dark',
    agent: agentChoice.agent,
    agentCmd: agentChoice.agentCmd,
    agentModel: agentChoice.agentModel,
    agentThinking: agentChoice.agentThinking
  };
}

export async function loadSettings(): Promise<UserSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Partial<UserSettings>;
    return { ...defaultSettings(), ...raw };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings: UserSettings) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${settingsFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, settingsFile);
}
