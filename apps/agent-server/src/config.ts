import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

/**
 * True inside the single executable `bun build --compile` produces (the sidecar the
 * Gecko browser spawns). The build defines TOJI_COMPILED_BINARY; the $bunfs check is a
 * backstop, since a compiled binary serves its own modules from Bun's virtual
 * filesystem. In that mode nothing may be assumed about the working directory or the
 * files next to the executable.
 */
export const isCompiled = process.env.TOJI_COMPILED_BINARY === '1' || /\/\$bunfs\/|~BUN[\\/]/.test(import.meta.url);

/**
 * .env files are optional and never located relative to the code: TOJI_ENV_FILE names
 * one explicitly, otherwise .env.local then .env in the working directory are used if
 * they exist (.env.local first so it wins — dotenv never overwrites a set key — which
 * matches Vite). A missing or unreadable file is never fatal, and dotenv is kept quiet
 * because stdout carries the TOJI_SERVER_READY handshake.
 */
function loadEnvFiles() {
  const explicit = process.env.TOJI_ENV_FILE?.trim();
  const files = explicit ? [path.resolve(explicit)] : [path.resolve('.env.local'), path.resolve('.env')];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) {
        if (explicit) console.warn(`[toji] TOJI_ENV_FILE ${file} does not exist; continuing without it.`);
        continue;
      }
      const result = dotenv.config({ path: file, quiet: true });
      if (result.error) console.warn(`[toji] could not read ${file}: ${result.error.message}`);
    } catch (error) {
      console.warn(`[toji] could not read ${file}:`, error instanceof Error ? error.message : error);
    }
  }
}
loadEnvFiles();

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function numEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function portEnv() {
  // The sidecar has no fixed port: unset or 0 means "any free port", reported on the
  // READY line. Run from source (dev, the Electron bundle) the default stays 8788.
  const fallback = isCompiled ? 0 : 8788;
  const raw = process.env.PORT?.trim();
  if (!raw) return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

function dataDirEnv() {
  const fromEnv = process.env.TOJI_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (isCompiled) {
    // Exiting here, before any module computes a path from it, beats a stack trace or a
    // .toji-data directory created wherever the browser happened to spawn us.
    console.error(
      '[toji] TOJI_DATA_DIR is not set. The compiled agent server keeps sessions, settings, caches and uploads there, ' +
        'so the process that launches it must set TOJI_DATA_DIR to a writable directory (it is created if missing).'
    );
    process.exit(2);
  }
  return path.join(process.cwd(), '.toji-data');
}

function pidEnv(name: string) {
  const pid = Number(process.env[name]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Toji's "model" is the embedded yagami engine (the signed-in coding-agent CLIs on
// this machine — no keys), Cerebras, or a custom OpenAI-compatible endpoint configured
// in the UI. TOJI_AGENT=off forces the deterministic demo/heuristic fallbacks; any
// legacy value (claude/codex/opencode/…) means yagami now, which drives those same CLIs.
const rawAgent = (process.env.TOJI_AGENT ?? 'yagami').trim().toLowerCase();
const AGENT_CHOICES = new Set(['off', 'local', 'cerebras', 'yagami', 'toji']);

const rendererDirEnv = process.env.TOJI_RENDERER_DIR?.trim();

export const config = {
  appName: 'Toji',
  isCompiled,
  port: portEnv(),
  // A fresh install lands on the Toji plan: the point of it is that a new user gets
  // working inference without installing a CLI or pasting a key. Existing settings
  // files keep whatever they already say (see loadSettings).
  agent: (AGENT_CHOICES.has(rawAgent) ? rawAgent : 'toji') as 'toji' | 'yagami' | 'cerebras' | 'local' | 'off',
  // Cerebras key from the environment (.env.local). Used as a fallback when Settings
  // holds no key, and deliberately never copied into settings.json — one secret, one home.
  cerebrasApiKey: (process.env.CEREBRAS_API_KEY ?? '').trim(),
  agentTimeoutMs: Math.max(5_000, numEnv('TOJI_AGENT_TIMEOUT_MS', 120_000)),
  maxAgentTabs: Math.max(1, numEnv('MAX_AGENT_TABS', 8)),
  maxSpeculativeTabs: Math.max(0, numEnv('MAX_SPECULATIVE_TABS', 2)),
  maxConcurrentTabs: Math.max(1, numEnv('MAX_CONCURRENT_TABS', 3)),
  maxSearchQueries: Math.max(1, numEnv('MAX_SEARCH_QUERIES', 4)),
  sessionHistoryLimit: Math.max(1, numEnv('SESSION_HISTORY_LIMIT', 24)),
  enableVisualAnalysis: boolEnv('ENABLE_VISUAL_ANALYSIS', true),
  requestTimeoutMs: numEnv('AGENT_REQUEST_TIMEOUT_MS', 18_000),
  cacheTtlHours: Math.max(1, numEnv('SOURCE_CACHE_TTL_HOURS', 72)),
  dataDir: dataDirEnv(),
  // The built renderer to serve as static files, if any. Unset means none is served,
  // except that a server run from source or the Electron bundle still finds the
  // dist/renderer next to itself (see index.ts) — that is how the packaged desktop app
  // loads its UI.
  rendererDir: rendererDirEnv ? path.resolve(rendererDirEnv) : undefined,
  // The process that spawned this server. When it disappears the server exits, so a
  // crashed browser never leaves an orphaned sidecar holding a port.
  parentPid: pidEnv('TOJI_PARENT_PID'),
  searchProvider: (process.env.SEARCH_PROVIDER ?? 'duckduckgo') as 'duckduckgo' | 'brave',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? '',
  demoModeEnabled: boolEnv('DEMO_MODE_ENABLED', true),
  userAgent:
    process.env.AGENT_USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Toji/0.2'
};

// Whether a backend is actually available is resolved at runtime by agentRuntime
// (it depends on harness detection + user settings, not just env), so there is no
// static isLiveModelEnabled here — use agentAvailable() from agentRuntime/model.
export const isBraveSearchEnabled = config.searchProvider === 'brave' && Boolean(config.braveSearchApiKey);
