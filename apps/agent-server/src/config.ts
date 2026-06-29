import dotenv from 'dotenv';
import path from 'node:path';

// Load .env.local first so it takes precedence (matching Vite's resolution),
// since dotenv does not overwrite already-set keys. Then fall back to .env.
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function numEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const projectRoot = process.cwd();

// Toji's "model" is a local CLI coding agent (Claude Code, Codex, opencode, …)
// driven in non-interactive print mode. `agent` selects a built-in preset; set it
// to 'off' to force Toji's deterministic demo/heuristic fallbacks. `agentCmd` is a
// full command override (e.g. "claude -p --dangerously-skip-permissions") that wins
// over the preset — useful to pin an absolute binary path in a packaged app where
// the GUI process has a minimal PATH.
const rawAgent = (process.env.TOJI_AGENT ?? 'claude').trim().toLowerCase();

export const config = {
  appName: 'Toji',
  port: numEnv('PORT', 8787),
  agent: (['claude', 'codex', 'opencode', 'off'].includes(rawAgent) ? rawAgent : 'claude') as
    | 'claude'
    | 'codex'
    | 'opencode'
    | 'off',
  agentCmd: (process.env.TOJI_AGENT_CMD ?? '').trim(),
  agentTimeoutMs: Math.max(5_000, numEnv('TOJI_AGENT_TIMEOUT_MS', 120_000)),
  maxAgentTabs: Math.max(1, numEnv('MAX_AGENT_TABS', 8)),
  maxSpeculativeTabs: Math.max(0, numEnv('MAX_SPECULATIVE_TABS', 2)),
  maxConcurrentTabs: Math.max(1, numEnv('MAX_CONCURRENT_TABS', 3)),
  maxSearchQueries: Math.max(1, numEnv('MAX_SEARCH_QUERIES', 4)),
  sessionHistoryLimit: Math.max(1, numEnv('SESSION_HISTORY_LIMIT', 24)),
  agentBrowserHeadless: boolEnv('AGENT_BROWSER_HEADLESS', true),
  enableVisualAnalysis: boolEnv('ENABLE_VISUAL_ANALYSIS', true),
  requestTimeoutMs: numEnv('AGENT_REQUEST_TIMEOUT_MS', 18_000),
  cacheTtlHours: Math.max(1, numEnv('SOURCE_CACHE_TTL_HOURS', 72)),
  dataDir: process.env.TOJI_DATA_DIR ?? path.join(projectRoot, '.toji-data'),
  searchProvider: (process.env.SEARCH_PROVIDER ?? 'duckduckgo') as 'duckduckgo' | 'brave',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? '',
  demoModeEnabled: boolEnv('DEMO_MODE_ENABLED', true),
  userAgent:
    process.env.AGENT_USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Toji/0.2'
};

// Whether a CLI agent is actually available is resolved at runtime by agentRuntime
// (it depends on detection + user settings, not just env), so there is no static
// isLiveModelEnabled here — use agentAvailable() from agentRuntime/model instead.
export const isBraveSearchEnabled = config.searchProvider === 'brave' && Boolean(config.braveSearchApiKey);
