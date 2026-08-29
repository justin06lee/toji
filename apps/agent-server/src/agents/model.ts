import { config } from '../config.js';
import { agentAvailable, getActiveBackend } from './agentRuntime.js';
import { apiComplete, apiStream, apiSupportsVision } from './apiModel.js';
import { yagamiComplete, yagamiStream, yagamiSupportsVision } from './yagamiModel.js';

// Toji's "model" is the embedded yagami engine (the coding-agent CLIs already signed
// in on this machine, no keys) or a custom OpenAI-compatible endpoint. Which backend
// runs is resolved at call time by agentRuntime, so the user can switch live from
// the settings UI.

export { agentAvailable };

export function liveModelName() {
  const backend = getActiveBackend();
  if (!backend) return 'demo (no agent)';
  return backend.label;
}

export function modelSupportsVision(): boolean {
  if (!config.enableVisualAnalysis) return false;
  const backend = getActiveBackend();
  if (!backend) return false;
  return backend.kind === 'yagami' ? yagamiSupportsVision(backend.model) : apiSupportsVision(backend);
}

// Coding agents wrap answers in prose, ```fences```, or inline a <think> block.
// Strip those before JSON parsing.
function cleanJsonContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

function parseJsonLoose<T>(content: string, label: string): T {
  const cleaned = cleanJsonContent(content);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Slice the outermost {...} — handles a JSON object embedded in surrounding prose.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Agent returned non-JSON ${label}: ${cleaned.slice(0, 240)}`);
  }
}

const JSON_INSTRUCTION =
  'Respond with ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after it.';

/**
 * Stream a plain-text completion. Throws if no backend is configured (callers
 * fall back to a local generator in that case).
 */
export async function* streamText(options: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, unknown> {
  const backend = getActiveBackend();
  if (!backend) throw new Error('No inference backend available (agent disabled / nothing installed)');
  const call = { system: options.system, user: options.user, maxTokens: options.maxTokens, signal: options.signal };
  yield* backend.kind === 'yagami' ? yagamiStream(backend, call) : apiStream(backend, call);
}

export async function completeJSON<T>(options: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const backend = getActiveBackend();
  if (!backend) throw new Error('No inference backend available (agent disabled / nothing installed)');
  const call = { system: `${options.system}\n${JSON_INSTRUCTION}`, user: options.user, maxTokens: options.maxTokens, signal: options.signal };
  const out = backend.kind === 'yagami' ? await yagamiComplete(backend, call) : await apiComplete(backend, call);
  return parseJsonLoose<T>(out, 'content');
}

/** Vision path: the screenshot rides inline as an image content block. */
export async function completeMultimodalJSON<T>(options: {
  system: string;
  userText: string;
  imageDataUri: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const backend = getActiveBackend();
  if (!backend) throw new Error('No inference backend available (agent disabled / nothing installed)');
  const call = {
    system: `${options.system}\n${JSON_INSTRUCTION}`,
    user: options.userText,
    imageDataUri: options.imageDataUri,
    maxTokens: options.maxTokens,
    signal: options.signal
  };
  const out = backend.kind === 'yagami' ? await yagamiComplete(backend, call) : await apiComplete(backend, call);
  return parseJsonLoose<T>(out, 'multimodal content');
}
