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
export type AgentChoice = AgentId | 'auto' | 'off';

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
let userChoice: { agent: AgentChoice; agentCmd: string } | null = null;

export function setAgentChoice(choice: { agent: AgentChoice; agentCmd: string }) {
  userChoice = { agent: choice.agent, agentCmd: (choice.agentCmd ?? '').trim() };
}

function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.split(/\s+/).filter(Boolean);
  return { cmd: parts[0], args: parts.slice(1) };
}

function presetCommand(id: AgentId, source: EffectiveAgent['source']): EffectiveAgent {
  const preset = PRESETS[id];
  const found = detectedById(id)?.path;
  // Use the absolute path when detected (so a packaged GUI with a minimal PATH
  // still finds it); otherwise fall back to the bare name and rely on PATH.
  return { cmd: found ?? preset.bin, args: [...preset.args], label: preset.label, source };
}

function firstDetected(): EffectiveAgent | null {
  for (const id of PRESET_ORDER) {
    if (detectedById(id)?.available) return presetCommand(id, 'auto');
  }
  return null;
}

/**
 * Resolve the command Toji should run, or null to use deterministic fallbacks.
 * Precedence: env hard-override > UI custom command > UI preset > UI auto-detect >
 * env-seeded defaults (for scripts that never set a UI choice).
 */
export function getEffectiveAgent(): EffectiveAgent | null {
  // Env TOJI_AGENT_CMD is a deployment/debug hard-override that always wins.
  if (process.env.TOJI_AGENT_CMD && process.env.TOJI_AGENT_CMD.trim()) {
    const { cmd, args } = splitCommand(process.env.TOJI_AGENT_CMD.trim());
    return { cmd, args, label: `custom (${cmd})`, source: 'env' };
  }

  const choice = userChoice ?? envChoice();

  if (choice.agentCmd) {
    const { cmd, args } = splitCommand(choice.agentCmd);
    return { cmd, args, label: `custom (${cmd})`, source: 'custom' };
  }
  if (choice.agent === 'off') return null;
  if (choice.agent === 'auto') return firstDetected();
  return presetCommand(choice.agent, userChoice ? 'preset' : 'env');
}

/** Env-derived choice, used as the default before the UI sets one. */
function envChoice(): { agent: AgentChoice; agentCmd: string } {
  const agent = (['claude', 'codex', 'opencode', 'off'].includes(config.agent) ? config.agent : 'auto') as AgentChoice;
  return { agent, agentCmd: config.agentCmd };
}

export function agentAvailable(): boolean {
  return getEffectiveAgent() !== null;
}

export function effectiveCommand(): { cmd: string; args: string[] } | null {
  const eff = getEffectiveAgent();
  return eff ? { cmd: eff.cmd, args: eff.args } : null;
}

/** Default agent choice seed from env, used by storage.defaultSettings(). */
export function defaultAgentChoice(): { agent: AgentChoice; agentCmd: string } {
  return envChoice();
}
