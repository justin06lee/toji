import Anthropic from '@anthropic-ai/sdk';
import type { ApiBackend, ThinkingLevel } from './agentRuntime.js';

// HTTP inference backends for model.ts: the Claude API (official @anthropic-ai/sdk),
// the OpenAI API, and any OpenAI-compatible endpoint (Ollama / LM Studio / vLLM / a
// home server). Keys come from the local settings store via agentRuntime.setApiConfig
// and are only ever sent to the provider the user chose.

export interface ApiCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Optional data-URI screenshot for vision-capable models. */
  imageDataUri?: string;
  signal?: AbortSignal;
}

// One SDK client per key, so a live key change in settings takes effect immediately.
const anthropicClients = new Map<string, Anthropic>();
function anthropicClient(apiKey: string): Anthropic {
  let client = anthropicClients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    anthropicClients.set(apiKey, client);
  }
  return client;
}

function parseDataUri(dataUri: string): { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string } {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(dataUri);
  if (match) {
    const mt = match[1].toLowerCase();
    return { mediaType: (mt === 'image/jpg' ? 'image/jpeg' : mt) as 'image/png' | 'image/jpeg' | 'image/webp', base64: match[2] };
  }
  return { mediaType: 'image/png', base64: dataUri.replace(/^data:[^,]*,/, '') };
}

// Toji's "Thinking" setting → Claude adaptive thinking + effort. 'default' sends no
// thinking config at all (fast, and valid on every model); an explicit level opts into
// adaptive thinking with that effort — supported on Opus 4.6+/Sonnet 4.6+ class models.
function anthropicThinkingParams(thinking: ThinkingLevel): Record<string, unknown> {
  if (thinking === 'default') return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort: thinking } };
}

function anthropicMessages(options: ApiCallOptions): Anthropic.MessageParam[] {
  if (!options.imageDataUri) return [{ role: 'user', content: options.user }];
  const img = parseDataUri(options.imageDataUri);
  return [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
        { type: 'text', text: options.user }
      ]
    }
  ];
}

async function anthropicComplete(backend: ApiBackend, options: ApiCallOptions): Promise<string> {
  const client = anthropicClient(backend.apiKey);
  const response = await client.messages.create(
    {
      model: backend.model,
      max_tokens: options.maxTokens ?? 1024,
      system: options.system,
      ...anthropicThinkingParams(backend.thinking),
      messages: anthropicMessages(options)
    },
    { signal: options.signal }
  );
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request (safety refusal)');
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function* anthropicStream(backend: ApiBackend, options: ApiCallOptions): AsyncGenerator<string, void, unknown> {
  const client = anthropicClient(backend.apiKey);
  const stream = client.messages.stream(
    {
      model: backend.model,
      max_tokens: options.maxTokens ?? 16000,
      system: options.system,
      ...anthropicThinkingParams(backend.thinking),
      messages: anthropicMessages(options)
    },
    { signal: options.signal }
  );
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
  }
}

// --- OpenAI-compatible chat completions (OpenAI API + self-hosted endpoints) ---

function openaiBody(backend: ApiBackend, options: ApiCallOptions, stream: boolean): Record<string, unknown> {
  const userContent = options.imageDataUri
    ? [
        { type: 'text', text: options.user },
        { type: 'image_url', image_url: { url: options.imageDataUri } }
      ]
    : options.user;
  const maxTokens = options.maxTokens ?? (stream ? 16000 : 1024);
  return {
    model: backend.model,
    stream,
    // api.openai.com deprecated max_tokens in favor of max_completion_tokens (required
    // for gpt-5/o-series); most self-hosted servers still expect max_tokens.
    ...(backend.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: userContent }
    ]
  };
}

async function openaiFetch(backend: ApiBackend, options: ApiCallOptions, stream: boolean): Promise<Response> {
  const response = await fetch(`${backend.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {})
    },
    body: JSON.stringify(openaiBody(backend, options, stream)),
    signal: options.signal ?? null
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${backend.label} error ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response;
}

async function openaiComplete(backend: ApiBackend, options: ApiCallOptions): Promise<string> {
  const response = await openaiFetch(backend, options, false);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${backend.label} returned an empty completion`);
  return content;
}

async function* openaiStream(backend: ApiBackend, options: ApiCallOptions): AsyncGenerator<string, void, unknown> {
  const response = await openaiFetch(backend, options, true);
  if (!response.body) throw new Error(`${backend.label} returned no stream body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE framing: one "data: {json}" line per chunk, "[DONE]" terminates.
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        } catch {
          /* partial/keepalive line — skip */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- Public dispatch ----------------------------------------------------------

export function apiComplete(backend: ApiBackend, options: ApiCallOptions): Promise<string> {
  return backend.provider === 'anthropic' ? anthropicComplete(backend, options) : openaiComplete(backend, options);
}

export function apiStream(backend: ApiBackend, options: ApiCallOptions): AsyncGenerator<string, void, unknown> {
  return backend.provider === 'anthropic' ? anthropicStream(backend, options) : openaiStream(backend, options);
}

/** Whether the backend can accept an inline image. Hosted APIs: yes (Claude and the
 *  OpenAI vision-capable models take image content parts). Self-hosted: unknown — most
 *  local text models reject image parts with an error, so we stay text-only. */
export function apiSupportsVision(backend: ApiBackend): boolean {
  return backend.provider !== 'local';
}
