import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// Toji's inference is a local CLI coding agent run in non-interactive print mode.
// This module decides WHICH agent runs and WHERE its binary is — so a freshly
// downloaded desktop build "just works" if the user has any supported agent
// installed, with no env files or manual paths. Everything here is synchronous so
// callers (including scripts that bypass server boot) can resolve a command
// without an async init step.

export type AgentId = 'claude' | 'codex' | 'opencode';
/** HTTP inference backends: hosted APIs with a user-saved key, or any OpenAI-compatible
 *  endpoint ('local' — Ollama on this machine, LM Studio, vLLM on a home server, …). */
export type ApiProvider = 'anthropic' | 'openai' | 'local';
export type AgentChoice = AgentId | ApiProvider | 'auto' | 'off';
export type ThinkingLevel = 'default' | 'low' | 'medium' | 'high';

const API_PROVIDERS: ApiProvider[] = ['anthropic', 'openai', 'local'];
export function isApiProvider(value: string): value is ApiProvider {
  return (API_PROVIDERS as string[]).includes(value);
}

interface AgentTuning {
  /** Model passed to the agent's --model flag. '' = the agent's default. */
  agentModel: string;
  /** Reasoning effort. 'default' = omit the flag entirely. */
  agentThinking: ThinkingLevel;
}

interface AgentPreset {
  id: AgentId;
  label: string;
  /** Bare binary name to look for on PATH / in install dirs. */
  bin: string;
  /** Flags that put the agent in non-interactive, unattended print mode. */
  args: string[];
  /** Agent-specific install dirs to probe in addition to the common ones. */
  extraDirs: string[];
}

const home = os.homedir();

// Common places CLI tools land that a GUI app's minimal PATH usually misses.
const COMMON_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  path.join(home, '.local', 'bin'),
  path.join(home, '.bun', 'bin'),
  path.join(home, 'bin')
];

const PRESETS: Record<AgentId, AgentPreset> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    args: ['-p', '--dangerously-skip-permissions'],
    extraDirs: [path.join(home, '.claude', 'local'), path.join(home, '.claude', 'bin')]
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
    extraDirs: [path.join(home, '.codex', 'bin')]
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    args: ['run'],
    extraDirs: [path.join(home, '.opencode', 'bin')]
  }
};

const PRESET_ORDER: AgentId[] = ['claude', 'codex', 'opencode'];

export interface DetectedAgent {
  id: AgentId;
  label: string;
  available: boolean;
  /** Absolute path to the binary when found, else null. */
  path: string | null;
}

export interface EffectiveAgent {
  cmd: string;
  args: string[];
  label: string;
  /** The resolved preset id, or null for a custom command. Surfaced to the UI. */
  id: AgentId | null;
  /** How this command was chosen — surfaced in the UI. */
  source: 'custom' | 'preset' | 'auto' | 'env';
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** Find a binary by name across preset-specific dirs, common dirs, and PATH. */
function findBinary(preset: AgentPreset): string | null {
  const dirs = [...preset.extraDirs, ...COMMON_DIRS, ...pathDirs()];
  for (const dir of dirs) {
    const candidate = path.join(dir, preset.bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

let detectionCache: DetectedAgent[] | null = null;

/** Detect which supported agents are installed. Cached; call refreshDetection() to rescan. */
export function detectAgents(): DetectedAgent[] {
  if (detectionCache) return detectionCache;
  detectionCache = PRESET_ORDER.map((id) => {
    const preset = PRESETS[id];
    const found = findBinary(preset);
    return { id, label: preset.label, available: Boolean(found), path: found };
  });
  return detectionCache;
}

export function refreshDetection(): DetectedAgent[] {
  detectionCache = null;
  return detectAgents();
}

function detectedById(id: AgentId): DetectedAgent | undefined {
  return detectAgents().find((d) => d.id === id);
}

// User-chosen agent settings, set by the server once settings are loaded and again
// on every settings PATCH. When unset (e.g. a script that bypasses server boot),
// resolution falls back to the env-derived defaults in `config`.
type Choice = { agent: AgentChoice; agentCmd: string } & AgentTuning;
let userChoice: Choice | null = null;

// --- HTTP inference backends (Claude API / OpenAI API / self-hosted) ----------
// Keys and URLs come from the persisted UserSettings (local settings.json) and are
// pushed here at boot and on every settings PATCH, like the CLI choice above.

export interface ApiConfig {
  anthropicApiKey: string;
  anthropicModel: string;
  openaiApiKey: string;
  openaiModel: string;
  localUrl: string;
  localModel: string;
  localApiKey: string;
}

let apiConfig: ApiConfig = {
  anthropicApiKey: '',
  anthropicModel: '',
  openaiApiKey: '',
  openaiModel: '',
  localUrl: '',
  localModel: '',
  localApiKey: ''
};

export function setApiConfig(cfg: Partial<ApiConfig>) {
  const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  apiConfig = {
    anthropicApiKey: trim(cfg.anthropicApiKey) ?? apiConfig.anthropicApiKey,
    anthropicModel: trim(cfg.anthropicModel) ?? apiConfig.anthropicModel,
    openaiApiKey: trim(cfg.openaiApiKey) ?? apiConfig.openaiApiKey,
    openaiModel: trim(cfg.openaiModel) ?? apiConfig.openaiModel,
    localUrl: trim(cfg.localUrl) ?? apiConfig.localUrl,
    localModel: trim(cfg.localModel) ?? apiConfig.localModel,
    localApiKey: trim(cfg.localApiKey) ?? apiConfig.localApiKey
  };
}

export interface ApiBackend {
  kind: 'api';
  provider: ApiProvider;
  /** OpenAI-compatible base URL ('' for Anthropic — the SDK owns the endpoint). */
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
  thinking: ThinkingLevel;
}

export type Backend = ({ kind: 'cli' } & EffectiveAgent) | ApiBackend;

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';
export const OPENAI_DEFAULT_MODEL = 'gpt-5.1';

/** The configured API backend for a provider, or null when it isn't set up yet. */
function apiBackendFor(provider: ApiProvider, thinking: ThinkingLevel): ApiBackend | null {
  if (provider === 'anthropic') {
    if (!apiConfig.anthropicApiKey) return null;
    const model = apiConfig.anthropicModel || ANTHROPIC_DEFAULT_MODEL;
    return { kind: 'api', provider, baseUrl: '', apiKey: apiConfig.anthropicApiKey, model, label: `Claude API · ${model}`, thinking };
  }
  if (provider === 'openai') {
    if (!apiConfig.openaiApiKey) return null;
    const model = apiConfig.openaiModel || OPENAI_DEFAULT_MODEL;
    return { kind: 'api', provider, baseUrl: 'https://api.openai.com/v1', apiKey: apiConfig.openaiApiKey, model, label: `OpenAI API · ${model}`, thinking };
  }
  // local: URL + model are required; the bearer token is optional (most local servers have none).
  if (!apiConfig.localUrl || !apiConfig.localModel) return null;
  return {
    kind: 'api',
    provider,
    baseUrl: apiConfig.localUrl.replace(/\/+$/, ''),
    apiKey: apiConfig.localApiKey,
    model: apiConfig.localModel,
    label: `self-hosted · ${apiConfig.localModel}`,
    thinking
  };
}

/** Per-provider configuration status for the settings UI (never exposes key values). */
export function apiStatus() {
  return {
    anthropic: { configured: Boolean(apiConfig.anthropicApiKey), model: apiConfig.anthropicModel || ANTHROPIC_DEFAULT_MODEL },
    openai: { configured: Boolean(apiConfig.openaiApiKey), model: apiConfig.openaiModel || OPENAI_DEFAULT_MODEL },
    local: { configured: Boolean(apiConfig.localUrl && apiConfig.localModel), url: apiConfig.localUrl, model: apiConfig.localModel }
  };
}

/**
 * Validate that a custom agent command looks like a legitimate CLI agent binary
 * path rather than an arbitrary shell command. Rejects shell metacharacters,
 * pipelines, redirections, and commands that don't look like a path to a binary
 * with optional flags.
 */
export function isValidAgentCmd(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true; // empty means "use preset"
  // Block shell metacharacters that could be used for command injection.
  if (/[;|&`$(){}\\<>!\n\r]/.test(trimmed)) return false;
  // The first token (the binary) must look like a filesystem path or bare name
  // (letters, digits, hyphens, underscores, dots, forward slashes).
  const parts = trimmed.split(/\s+/);
  const binary = parts[0];
  if (!binary || !/^[a-zA-Z0-9_.\/-]+$/.test(binary)) return false;
  // Reject obviously dangerous binaries.
  const dangerousBins = ['rm', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh',
    'python', 'python3', 'perl', 'ruby', 'node', 'curl', 'wget', 'nc', 'ncat',
    'cat', 'dd', 'chmod', 'chown', 'sudo', 'su', 'kill', 'pkill', 'env', 'xargs'];
  const binaryBase = binary.split('/').pop()?.toLowerCase() ?? '';
  if (dangerousBins.includes(binaryBase)) return false;
  return true;
}

export function setAgentChoice(choice: { agent: AgentChoice; agentCmd: string } & Partial<AgentTuning>) {
  const cmd = (choice.agentCmd ?? '').trim();
  if (!isValidAgentCmd(cmd)) {
    throw new Error(`Rejected unsafe agent command: ${cmd.slice(0, 80)}`);
  }
  userChoice = {
    agent: choice.agent,
    agentCmd: cmd,
    agentModel: (choice.agentModel ?? '').trim(),
    agentThinking: choice.agentThinking ?? 'default'
  };
}

function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.split(/\s+/).filter(Boolean);
  return { cmd: parts[0], args: parts.slice(1) };
}

// Map model + thinking onto each agent's verified CLI flags. 'default'/'' = omit.
function tuningArgs(id: AgentId, tuning: AgentTuning): string[] {
  const out: string[] = [];
  const model = tuning.agentModel.trim();
  const effort = tuning.agentThinking;
  if (model) out.push('--model', model); // claude/codex/opencode all accept --model
  if (effort !== 'default') {
    if (id === 'claude') out.push('--effort', effort);
    else if (id === 'codex') out.push('-c', `model_reasoning_effort=${effort}`);
    else if (id === 'opencode') out.push('--variant', effort);
  }
  return out;
}

function presetCommand(id: AgentId, source: EffectiveAgent['source'], tuning: AgentTuning): EffectiveAgent {
  const preset = PRESETS[id];
  const found = detectedById(id)?.path;
  const extra = tuningArgs(id, tuning);
  // codex's base args end with a trailing '-' (read prompt from stdin); model/effort
  // flags must come before it, so splice them in ahead of the final arg.
  let args: string[];
  if (id === 'codex' && preset.args[preset.args.length - 1] === '-') {
    args = [...preset.args.slice(0, -1), ...extra, '-'];
  } else {
    args = [...preset.args, ...extra];
  }
  // Use the absolute path when detected (so a packaged GUI with a minimal PATH
  // still finds it); otherwise fall back to the bare name and rely on PATH.
  return { cmd: found ?? preset.bin, args, label: preset.label, id, source };
}

function firstDetected(tuning: AgentTuning): EffectiveAgent | null {
  for (const id of PRESET_ORDER) {
    if (detectedById(id)?.available) return presetCommand(id, 'auto', tuning);
  }
  return null;
}

/**
 * Resolve the CLI command Toji should run, or null when the active choice is not a
 * CLI (off, an API backend, or nothing available). Precedence: env hard-override >
 * UI custom command > UI preset > UI auto-detect > env-seeded defaults.
 */
export function getEffectiveAgent(): EffectiveAgent | null {
  // Env TOJI_AGENT_CMD is a deployment/debug hard-override that always wins. The
  // user owns the full command, so we never append model/effort flags to it.
  if (process.env.TOJI_AGENT_CMD && process.env.TOJI_AGENT_CMD.trim()) {
    const { cmd, args } = splitCommand(process.env.TOJI_AGENT_CMD.trim());
    return { cmd, args, label: `custom (${cmd})`, id: null, source: 'env' };
  }

  const choice = userChoice ?? envChoice();
  const tuning: AgentTuning = { agentModel: choice.agentModel, agentThinking: choice.agentThinking };

  // A custom command is user-controlled; don't append model/effort flags.
  if (choice.agentCmd) {
    const { cmd, args } = splitCommand(choice.agentCmd);
    return { cmd, args, label: `custom (${cmd})`, id: null, source: 'custom' };
  }
  if (choice.agent === 'off' || isApiProvider(choice.agent)) return null;
  if (choice.agent === 'auto') return firstDetected(tuning);
  return presetCommand(choice.agent, userChoice ? 'preset' : 'env', tuning);
}

/**
 * The active inference backend: a CLI agent to spawn, an HTTP API backend, or null
 * (demo mode). This is what model.ts dispatches on. 'auto' prefers a detected CLI
 * (zero-config), then falls back to the first CONFIGURED API backend.
 */
export function getActiveBackend(): Backend | null {
  const choice = userChoice ?? envChoice();

  // An explicitly chosen API provider wins over CLI resolution (env cmd override
  // excluded — that's a deployment escape hatch and getEffectiveAgent handles it).
  if (!process.env.TOJI_AGENT_CMD?.trim() && !choice.agentCmd && isApiProvider(choice.agent)) {
    return apiBackendFor(choice.agent, choice.agentThinking);
  }

  const cli = getEffectiveAgent();
  if (cli) return { kind: 'cli', ...cli };
  if (choice.agent === 'off') return null;

  // 'auto' with no CLI installed: use whichever API backend the user has configured.
  if (choice.agent === 'auto') {
    for (const provider of API_PROVIDERS) {
      const backend = apiBackendFor(provider, choice.agentThinking);
      if (backend) return backend;
    }
  }
  return null;
}

/** Env-derived choice, used as the default before the UI sets one. */
function envChoice(): Choice {
  const agent = (['claude', 'codex', 'opencode', 'off'].includes(config.agent) ? config.agent : 'auto') as AgentChoice;
  const thinking = (process.env.TOJI_AGENT_THINKING ?? 'default').trim().toLowerCase();
  return {
    agent,
    agentCmd: config.agentCmd,
    agentModel: (process.env.TOJI_AGENT_MODEL ?? '').trim(),
    agentThinking: (['low', 'medium', 'high'].includes(thinking) ? thinking : 'default') as ThinkingLevel
  };
}

export function agentAvailable(): boolean {
  return getActiveBackend() !== null;
}

export function effectiveCommand(): { cmd: string; args: string[] } | null {
  const eff = getEffectiveAgent();
  return eff ? { cmd: eff.cmd, args: eff.args } : null;
}

/** Default agent choice seed from env, used by storage.defaultSettings(). */
export function defaultAgentChoice(): Choice {
  return envChoice();
}
