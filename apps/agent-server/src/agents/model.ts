import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { agentAvailable, effectiveCommand, getActiveBackend } from './agentRuntime.js';
import { apiComplete, apiStream, apiSupportsVision } from './apiModel.js';

// Toji's "model" is either a local CLI coding agent (Claude Code / Codex / opencode)
// driven in non-interactive "print" mode — prompt piped to stdin, answer read from
// stdout — or an HTTP backend: the Claude API, the OpenAI API, or any self-hosted
// OpenAI-compatible endpoint. Which backend runs is resolved at call time by
// agentRuntime, so the user can switch backends (and paste keys) live from the UI.

export { agentAvailable };

export function liveModelName() {
  const backend = getActiveBackend();
  if (!backend) return 'demo (no agent)';
  return backend.kind === 'api' ? `api: ${backend.label}` : `cli: ${backend.label}`;
}

// CLI agents get vision via the temp-file image path below (any agent that can read a
// local image file); API backends take inline image content where the provider
// supports it. Gated on the visual-analysis flag either way.
export function modelSupportsVision(): boolean {
  if (!config.enableVisualAnalysis) return false;
  const backend = getActiveBackend();
  if (!backend) return false;
  return backend.kind === 'api' ? apiSupportsVision(backend) : true;
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

function buildPrompt(system: string, user: string): string {
  return `${system}\n\n${user}`;
}

const JSON_INSTRUCTION =
  'Respond with ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after it.';

/**
 * Spawn the configured CLI agent, pipe `prompt` to stdin, and resolve with its
 * full stdout. `onDelta` (optional) receives stdout chunks as they arrive so a
 * caller can stream. Throws if no agent is configured, on spawn error, on
 * timeout, or on a non-zero exit with no output.
 */
function runAgent(
  prompt: string,
  opts: { signal?: AbortSignal; onDelta?: (chunk: string) => void; timeoutMs?: number } = {}
): Promise<string> {
  const resolved = effectiveCommand();
  if (!resolved) {
    return Promise.reject(new Error('No CLI agent available (none detected / agent disabled)'));
  }
  const { cmd, args } = resolved;
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`Agent timed out after ${opts.timeoutMs ?? config.agentTimeoutMs}ms`)));
    }, opts.timeoutMs ?? config.agentTimeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Agent call aborted')));
    };
    opts.signal?.addEventListener('abort', onAbort);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      opts.onDelta?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      // Some agents exit non-zero yet still print a usable answer; accept any run
      // that produced output, and only reject when there's nothing to work with.
      if (out.trim().length > 0) finish(() => resolve(out));
      else finish(() => reject(new Error(`Agent exited ${code ?? 'null'} with no output: ${err.slice(0, 300)}`)));
    });

    // Swallow stdin errors: if the agent fails to spawn or closes stdin early, the
    // write emits EPIPE/ENOENT on this stream. Without a listener that becomes an
    // uncaught exception that crashes the server. Success/failure is decided by the
    // 'close' handler above, so we deliberately do not reject here.
    child.stdin?.on('error', () => {});
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/**
 * Stream a plain-text completion. Yields stdout chunks from the CLI agent as they
 * arrive. Throws if no agent is configured (callers fall back to a local
 * generator in that case).
 */
export async function* streamText(options: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, unknown> {
  const backend = getActiveBackend();
  if (!backend) throw new Error('No CLI agent available (none detected / agent disabled)');
  if (backend.kind === 'api') {
    yield* apiStream(backend, { system: options.system, user: options.user, maxTokens: options.maxTokens, signal: options.signal });
    return;
  }

  const prompt = buildPrompt(options.system, options.user);
  const queue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    wake?.();
    wake = null;
  };

  runAgent(prompt, {
    signal: options.signal,
    onDelta: (chunk) => {
      queue.push(chunk);
      signal();
    }
  })
    .then(() => {
      done = true;
      signal();
    })
    .catch((e) => {
      error = e instanceof Error ? e : new Error(String(e));
      done = true;
      signal();
    });

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (error) throw error;
    if (done) return;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

export async function completeJSON<T>(options: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const backend = getActiveBackend();
  if (backend?.kind === 'api') {
    const out = await apiComplete(backend, {
      system: `${options.system}\n${JSON_INSTRUCTION}`,
      user: options.user,
      maxTokens: options.maxTokens,
      signal: options.signal
    });
    return parseJsonLoose<T>(out, 'content');
  }
  const prompt = buildPrompt(`${options.system}\n${JSON_INSTRUCTION}`, options.user);
  const out = await runAgent(prompt, { signal: options.signal });
  return parseJsonLoose<T>(out, 'content');
}

/**
 * Vision path: write the screenshot to a temp image file and ask the agent to read
 * it. CLI coding agents can't take an inline base64 image the way a chat API can,
 * but they can open a local file — so we hand them a path and clean it up after.
 */
export async function completeMultimodalJSON<T>(options: {
  system: string;
  userText: string;
  imageDataUri: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const backend = getActiveBackend();
  if (backend?.kind === 'api') {
    const out = await apiComplete(backend, {
      system: `${options.system}\n${JSON_INSTRUCTION}`,
      user: options.userText,
      imageDataUri: options.imageDataUri,
      maxTokens: options.maxTokens,
      signal: options.signal
    });
    return parseJsonLoose<T>(out, 'multimodal content');
  }
  const imagePath = await writeImageTemp(options.imageDataUri);
  try {
    const prompt = buildPrompt(
      `${options.system}\n${JSON_INSTRUCTION}`,
      `${options.userText}\n\nA screenshot of the current page is saved at this local path:\n${imagePath}\nOpen and view that image file to see the page, then respond.`
    );
    const out = await runAgent(prompt, { signal: options.signal });
    return parseJsonLoose<T>(out, 'multimodal content');
  } finally {
    await rm(path.dirname(imagePath), { recursive: true, force: true }).catch(() => {});
  }
}

async function writeImageTemp(dataUri: string): Promise<string> {
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUri);
  const ext = match ? (match[1].toLowerCase().startsWith('jp') ? 'jpg' : match[1].toLowerCase()) : 'png';
  const base64 = match ? match[2] : dataUri.replace(/^data:[^,]*,/, '');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'toji-img-'));
  const file = path.join(dir, `page.${ext}`);
  await writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}
