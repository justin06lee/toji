import { detectProviders, type DetectedProvider } from '@justin06lee/yagami';
import { config } from '../config.js';

// Toji's inference runs through yagami: an embedded, zero-config engine that drives
// the coding-agent CLIs already installed and signed in on this machine (Claude Code,
// Codex, opencode, Gemini CLI, any ACP agent). No API keys, nothing to paste — the
// library auto-detects the CLIs and stays in sync with a `yagami` binary's config.
// The one alternative backend is a custom OpenAI-compatible endpoint (URL + key) for
// self-hosted models; everything else was folded into yagami.

export type AgentChoice = 'yagami' | 'local' | 'off';
export type ThinkingLevel = 'default' | 'low' | 'medium' | 'high';

/**
 * Settings written by older Toji builds (and env files) name backends that no longer
 * exist as separate choices — the CLI presets and hosted-API keys all route through
 * yagami now. Anything unrecognized lands on yagami, the default.
 */
export function normalizeAgentChoice(value: unknown): AgentChoice {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'off') return 'off';
  if (v === 'local') return 'local';
  return 'yagami';
}

// --- Yagami harness detection -------------------------------------------------
// detectProviders() is cheap (filesystem lookups only — no processes spawned), but
// cache it anyway so hot paths (backend resolution per model call) stay instant.

let detectionCache: DetectedProvider[] | null = null;

export function detectHarnesses(): DetectedProvider[] {
  if (!detectionCache) {
    try {
      detectionCache = detectProviders();
    } catch {
      detectionCache = [];
    }
  }
  return detectionCache;
}

export function refreshDetection(): DetectedProvider[] {
  detectionCache = null;
  return detectHarnesses();
}

function yagamiUsable(): boolean {
  return detectHarnesses().some((p) => p.installed);
}

// --- User choice (from settings, pushed at boot and on every settings PATCH) ---

interface AgentTuning {
  /** Yagami model id ('' = the engine's default; supports "provider:model"). */
  agentModel: string;
  /** Reasoning effort. 'default' = omit entirely. */
  agentThinking: ThinkingLevel;
}

type Choice = { agent: AgentChoice } & AgentTuning;
let userChoice: Choice | null = null;

export function setAgentChoice(choice: { agent: AgentChoice | string } & Partial<AgentTuning>) {
  userChoice = {
    agent: normalizeAgentChoice(choice.agent),
    agentModel: (choice.agentModel ?? '').trim(),
    agentThinking: choice.agentThinking ?? 'default'
  };
}

/** Env-derived choice, used as the default before the UI sets one. */
function envChoice(): Choice {
  const thinking = (process.env.TOJI_AGENT_THINKING ?? 'default').trim().toLowerCase();
  return {
    agent: config.agent,
    agentModel: (process.env.TOJI_AGENT_MODEL ?? '').trim(),
    agentThinking: (['low', 'medium', 'high'].includes(thinking) ? thinking : 'default') as ThinkingLevel
  };
}

/** Default agent choice seed from env, used by storage.defaultSettings(). */
export function defaultAgentChoice(): Choice {
  return envChoice();
}

// --- Custom endpoint (OpenAI-compatible URL + optional key) --------------------

export interface ApiConfig {
  localUrl: string;
  localModel: string;
  localApiKey: string;
}

let apiConfig: ApiConfig = { localUrl: '', localModel: '', localApiKey: '' };

export function setApiConfig(cfg: Partial<ApiConfig>) {
  const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  apiConfig = {
    localUrl: trim(cfg.localUrl) ?? apiConfig.localUrl,
    localModel: trim(cfg.localModel) ?? apiConfig.localModel,
    localApiKey: trim(cfg.localApiKey) ?? apiConfig.localApiKey
  };
}

// --- Backends ------------------------------------------------------------------

export interface YagamiBackend {
  kind: 'yagami';
  /** '' routes to yagami's default provider/model. */
  model: string;
  label: string;
  thinking: ThinkingLevel;
}

export interface ApiBackend {
  kind: 'api';
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
  thinking: ThinkingLevel;
}

export type Backend = YagamiBackend | ApiBackend;

function yagamiBackend(tuning: AgentTuning): YagamiBackend | null {
  if (!yagamiUsable()) return null;
  const model = tuning.agentModel;
  return { kind: 'yagami', model, label: `Yagami · ${model || 'auto'}`, thinking: tuning.agentThinking };
}

function localBackend(tuning: AgentTuning): ApiBackend | null {
  // URL + model are required; the bearer token is optional (most local servers have none).
  if (!apiConfig.localUrl || !apiConfig.localModel) return null;
  return {
    kind: 'api',
    baseUrl: apiConfig.localUrl.replace(/\/+$/, ''),
    apiKey: apiConfig.localApiKey,
    model: apiConfig.localModel,
    label: `custom endpoint · ${apiConfig.localModel}`,
    thinking: tuning.agentThinking
  };
}

/**
 * The active inference backend: the embedded yagami engine, a custom
 * OpenAI-compatible endpoint, or null (demo mode). model.ts dispatches on this.
 */
export function getActiveBackend(): Backend | null {
  const choice = userChoice ?? envChoice();
  const tuning: AgentTuning = { agentModel: choice.agentModel, agentThinking: choice.agentThinking };
  if (choice.agent === 'off') return null;
  if (choice.agent === 'local') return localBackend(tuning);
  return yagamiBackend(tuning);
}

export function agentAvailable(): boolean {
  return getActiveBackend() !== null;
}

/** Backend status for the settings UI (never exposes key values). */
export function agentStatus() {
  const choice = userChoice ?? envChoice();
  return {
    choice: choice.agent,
    yagami: {
      providers: detectHarnesses().map(({ id, label, installed }) => ({ id, label, installed })),
      anyInstalled: yagamiUsable(),
      model: choice.agentModel
    },
    local: { configured: Boolean(apiConfig.localUrl && apiConfig.localModel), url: apiConfig.localUrl, model: apiConfig.localModel }
  };
}
