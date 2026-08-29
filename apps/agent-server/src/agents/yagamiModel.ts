import { AuthRequiredError, ProviderNotInstalledError, Yagami, type MessagesRequest } from '@justin06lee/yagami';
import { config } from '../config.js';
import type { YagamiBackend } from './agentRuntime.js';
import { parseDataUri, type ApiCallOptions } from './apiModel.js';

// The embedded yagami engine: Anthropic-shaped completions on top of whichever
// coding-agent CLIs are installed and signed in on this machine. One shared client
// per process — it holds the provider set, model probes, and the session cache.

let client: Yagami | null = null;
export function yagamiClient(): Yagami {
  if (!client) client = new Yagami();
  return client;
}

/** Whether the provider a model id routes to can take an inline image. */
export function yagamiSupportsVision(model: string): boolean {
  try {
    return yagamiClient().engine.resolve(model || undefined).provider.capabilities.images;
  } catch {
    return false;
  }
}

// Reasoning effort is honored by Claude Code and Codex; ACP harnesses (Gemini, Goose,
// OpenCode, …) have no notion of it, so it is left off rather than sent to be dropped.
function effortFor(backend: YagamiBackend): string | undefined {
  if (!backend.supportsEffort || backend.thinking === 'default') return undefined;
  return backend.thinking;
}

function requestFor(backend: YagamiBackend, options: ApiCallOptions, maxTokensFallback: number): MessagesRequest {
  const content = options.imageDataUri
    ? (() => {
        const img = parseDataUri(options.imageDataUri!);
        return [
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
          { type: 'text', text: options.user }
        ];
      })()
    : options.user;
  return {
    model: backend.model || undefined,
    system: options.system,
    max_tokens: options.maxTokens ?? maxTokensFallback,
    effort: effortFor(backend),
    messages: [{ role: 'user', content }]
  };
}

/** Map yagami's typed failures onto messages a user can actually act on. */
function friendly(error: unknown): Error {
  if (error instanceof AuthRequiredError) return new Error(`${error.provider} is installed but not signed in — run \`${error.loginCommand}\``);
  if (error instanceof ProviderNotInstalledError) return new Error(`${error.provider} is not installed (${error.installHint})`);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Bound a promise by the agent timeout and the caller's abort signal. The underlying
 * turn keeps running (the engine has no cancellation), but the caller stops waiting.
 */
function bounded<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadlineAt: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`yagami timed out after ${config.agentTimeoutMs}ms`)), Math.max(0, deadlineAt - Date.now()));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('yagami call aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, (error) => reject(friendly(error)))
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      });
  });
}

export async function yagamiComplete(backend: YagamiBackend, options: ApiCallOptions): Promise<string> {
  const deadline = Date.now() + config.agentTimeoutMs;
  const response = await bounded(yagamiClient().messages.create({ ...requestFor(backend, options, 1024), stream: false }), options.signal, deadline);
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('');
}

export async function* yagamiStream(backend: YagamiBackend, options: ApiCallOptions): AsyncGenerator<string, void, unknown> {
  const deadline = Date.now() + config.agentTimeoutMs;
  const stream = yagamiClient().messages.stream(requestFor(backend, options, 16000));
  try {
    while (true) {
      const next = await bounded(stream.next(), options.signal, deadline);
      if (next.done) return;
      const event = next.value as { type?: string; delta?: { type?: string; text?: unknown } };
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        yield event.delta.text;
      }
    }
  } finally {
    void stream.return?.(undefined);
  }
}
