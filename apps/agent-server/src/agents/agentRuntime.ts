import { detectProviders, type DetectedProvider } from '@justin06lee/yagami';
import { config } from '../config.js';
import { cachedCatalog, capabilitiesFor, findModel, qualifyModel } from './yagamiCatalog.js';
import { CEREBRAS_BASE_URL, cerebrasKeyFor, clearCerebrasModels, type KeySource } from './cerebras.js';

// Toji's inference runs through yagami: an embedded, zero-config engine that drives
// the coding-agent CLIs already installed and signed in on this machine (Claude Code,
// Codex, opencode, Gemini CLI, any ACP agent). No API keys, nothing to paste — the
// library auto-detects the CLIs and stays in sync with a `yagami` binary's config.
// The one alternative backend is a custom OpenAI-compatible endpoint (URL + key) for
// self-hosted models; everything else was folded into yagami.

export type AgentChoice = 'yagami' | 'cerebras' | 'local' | 'off';
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
  if (v === 'cerebras') return 'cerebras';
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
  /** Cerebras: model id and an optional key that overrides CEREBRAS_API_KEY from env. */
  cerebrasModel: string;
  cerebrasApiKey: string;
}

let apiConfig: ApiConfig = { localUrl: '', localModel: '', localApiKey: '', cerebrasModel: '', cerebrasApiKey: '' };

export function setApiConfig(cfg: Partial<ApiConfig>) {
  const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const previousKey = apiConfig.cerebrasApiKey;
  apiConfig = {
    localUrl: trim(cfg.localUrl) ?? apiConfig.localUrl,
    localModel: trim(cfg.localModel) ?? apiConfig.localModel,
    localApiKey: trim(cfg.localApiKey) ?? apiConfig.localApiKey,
    cerebrasModel: trim(cfg.cerebrasModel) ?? apiConfig.cerebrasModel,
    cerebrasApiKey: trim(cfg.cerebrasApiKey) ?? apiConfig.cerebrasApiKey
  };
  // A different key means a different account, so its model list no longer applies.
  if (apiConfig.cerebrasApiKey !== previousKey) clearCerebrasModels();
}

/** The Cerebras key in effect (Settings wins over the env key) and where it came from. */
export function cerebrasCredentials(): { key: string; source: KeySource } {
  return cerebrasKeyFor(apiConfig.cerebrasApiKey);
}

// --- Backends ------------------------------------------------------------------

export interface YagamiBackend {
  kind: 'yagami';
  /** Qualified `provider:model` ('' routes to yagami's default provider/model). */
  model: string;
  label: string;
  thinking: ThinkingLevel;
  /** False when the model's provider ignores reasoning effort (most ACP harnesses). */
  supportsEffort: boolean;
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
  // Qualify before use: a bare id like "gpt-5.6-luna" would otherwise be routed to
  // the default provider (Claude Code) and rejected on every single call.
  const model = qualifyModel(tuning.agentModel);
  const entry = findModel(model);
  const label = entry ? `${entry.providerLabel} · ${entry.label}` : model || 'auto';
  return {
    kind: 'yagami',
    model,
    label: `Yagami · ${label}`,
    thinking: tuning.agentThinking,
    supportsEffort: capabilitiesFor(model)?.effort ?? true
  };
}

/** Cerebras speaks OpenAI's wire format, so it rides the same ApiBackend path. */
function cerebrasBackend(tuning: AgentTuning): ApiBackend | null {
  const { key } = cerebrasCredentials();
  if (!key || !apiConfig.cerebrasModel) return null;
  return {
    kind: 'api',
    baseUrl: CEREBRAS_BASE_URL,
    apiKey: key,
    model: apiConfig.cerebrasModel,
    label: `Cerebras · ${apiConfig.cerebrasModel}`,
    thinking: tuning.agentThinking
  };
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
 * The active inference backend: the embedded yagami engine, Cerebras, a custom
 * OpenAI-compatible endpoint, or null (demo mode). model.ts dispatches on this.
 */
export function getActiveBackend(): Backend | null {
  const choice = userChoice ?? envChoice();
  const tuning: AgentTuning = { agentModel: choice.agentModel, agentThinking: choice.agentThinking };
  if (choice.agent === 'off') return null;
  if (choice.agent === 'local') return localBackend(tuning);
  if (choice.agent === 'cerebras') return cerebrasBackend(tuning);
  return yagamiBackend(tuning);
}

export function agentAvailable(): boolean {
  return getActiveBackend() !== null;
}

/** Backend status for the settings UI (never exposes key values). */
export function agentStatus() {
  const choice = userChoice ?? envChoice();
  const catalog = cachedCatalog();
  const model = qualifyModel(choice.agentModel, catalog);
  const entry = findModel(model, catalog);
  const capabilities = capabilitiesFor(model, catalog);
  // A model the catalog has probed and does not have is one no harness can run —
  // report it so the UI doesn't say "Ready" while every call fails.
  const unknownModel = Boolean(model) && catalog.models.length > 0 && !entry && !catalog.providers.some((p) => p.id === model);
  return {
    choice: choice.agent,
    yagami: {
      providers: detectHarnesses().map(({ id, label, installed }) => {
        const probed = catalog.providers.find((p) => p.id === id);
        return {
          id,
          label,
          installed,
          usable: probed?.usable ?? installed,
          ...(probed?.error ? { error: probed.error } : {})
        };
      }),
      anyInstalled: yagamiUsable(),
      model,
      ...(entry ? { modelLabel: entry.label, modelProvider: entry.providerLabel } : {}),
      unknownModel,
      supportsEffort: capabilities?.effort ?? true,
      supportsVision: capabilities?.images ?? false
    },
    cerebras: {
      // Never the key itself — only whether one exists and where it came from, so the
      // UI can say "using the key from .env.local" without ever handling it.
      keySource: cerebrasCredentials().source,
      configured: Boolean(cerebrasCredentials().key && apiConfig.cerebrasModel),
      model: apiConfig.cerebrasModel
    },
    local: { configured: Boolean(apiConfig.localUrl && apiConfig.localModel), url: apiConfig.localUrl, model: apiConfig.localModel }
  };
}
