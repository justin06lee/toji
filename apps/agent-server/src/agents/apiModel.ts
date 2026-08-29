import type { ApiBackend } from './agentRuntime.js';

// The custom-endpoint backend: any OpenAI-compatible /chat/completions server
// (Ollama, LM Studio, vLLM, a home server) reached with a user-entered URL and an
// optional bearer key. Everything hosted-API-shaped that Toji used to speak
// directly now routes through the embedded yagami engine instead.

export interface ApiCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Optional data-URI screenshot for vision-capable models. */
  imageDataUri?: string;
  signal?: AbortSignal;
}

export function parseDataUri(dataUri: string): { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string } {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(dataUri);
  if (match) {
    const mt = match[1].toLowerCase();
    return { mediaType: (mt === 'image/jpg' ? 'image/jpeg' : mt) as 'image/png' | 'image/jpeg' | 'image/webp', base64: match[2] };
  }
  return { mediaType: 'image/png', base64: dataUri.replace(/^data:[^,]*,/, '') };
}

function openaiBody(backend: ApiBackend, options: ApiCallOptions, stream: boolean): Record<string, unknown> {
  const userContent = options.imageDataUri
    ? [
        { type: 'text', text: options.user },
        { type: 'image_url', image_url: { url: options.imageDataUri } }
      ]
    : options.user;
  return {
    model: backend.model,
    stream,
    max_tokens: options.maxTokens ?? (stream ? 16000 : 1024),
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

export async function apiComplete(backend: ApiBackend, options: ApiCallOptions): Promise<string> {
  const response = await openaiFetch(backend, options, false);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${backend.label} returned an empty completion`);
  return content;
}

export async function* apiStream(backend: ApiBackend, options: ApiCallOptions): AsyncGenerator<string, void, unknown> {
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

/** Custom endpoints are unknown hardware: most local text models reject image parts, so stay text-only. */
export function apiSupportsVision(_backend: ApiBackend): boolean {
  return false;
}
