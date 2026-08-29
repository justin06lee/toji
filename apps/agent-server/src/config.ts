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

// Toji's "model" is the embedded yagami engine (the signed-in coding-agent CLIs on
// this machine — no keys), Cerebras, or a custom OpenAI-compatible endpoint configured
// in the UI. TOJI_AGENT=off forces the deterministic demo/heuristic fallbacks; any
// legacy value (claude/codex/opencode/…) means yagami now, which drives those same CLIs.
const rawAgent = (process.env.TOJI_AGENT ?? 'yagami').trim().toLowerCase();
const AGENT_CHOICES = new Set(['off', 'local', 'cerebras', 'yagami']);

export const config = {
  appName: 'Toji',
  port: numEnv('PORT', 8788),
  agent: (AGENT_CHOICES.has(rawAgent) ? rawAgent : 'yagami') as 'yagami' | 'cerebras' | 'local' | 'off',
  // Cerebras key from the environment (.env.local). Used as a fallback when Settings
  // holds no key, and deliberately never copied into settings.json — one secret, one home.
  cerebrasApiKey: (process.env.CEREBRAS_API_KEY ?? '').trim(),
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

// Whether a backend is actually available is resolved at runtime by agentRuntime
// (it depends on harness detection + user settings, not just env), so there is no
// static isLiveModelEnabled here — use agentAvailable() from agentRuntime/model.
export const isBraveSearchEnabled = config.searchProvider === 'brave' && Boolean(config.braveSearchApiKey);
