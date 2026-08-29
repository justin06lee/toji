import { config } from '../config.js';

// Cerebras: a hosted OpenAI-compatible endpoint, so inference itself reuses the
// custom-endpoint path in apiModel.ts. What lives here is everything specific to
// the service — its fixed base URL, the model catalog behind the key, and turning
// its error bodies into something a user can act on.

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/** One model the account can use. Cerebras reports ids only, so the id is the label. */
export interface CerebrasModel {
  id: string;
  label: string;
}

/** Where the key in use came from. The env key is never copied into settings.json. */
export type KeySource = 'settings' | 'env' | 'none';

export function cerebrasKeyFor(settingsKey: string): { key: string; source: KeySource } {
  const fromSettings = settingsKey.trim();
  if (fromSettings) return { key: fromSettings, source: 'settings' };
  if (config.cerebrasApiKey) return { key: config.cerebrasApiKey, source: 'env' };
  return { key: '', source: 'none' };
}

/**
 * Cerebras returns a JSON body with `message`/`code` on failure. Map the ones a
 * user can actually do something about; a 402 in particular is an account that
 * has no credits, not a broken key, and must not read as "invalid key".
 */
export function cerebrasErrorMessage(status: number, body: string): string {
  let detail = body.slice(0, 300);
  let code = '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === 'string') detail = parsed.message;
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    /* not JSON — keep the raw prefix */
  }
  if (status === 401 || status === 403) return `Cerebras rejected the API key (${detail})`;
  if (status === 402 || code === 'payment_required') return `Cerebras: ${detail} Add credits at https://cloud.cerebras.ai/ — the key itself is fine.`;
  if (status === 429) return `Cerebras rate limit reached: ${detail}`;
  return `Cerebras error ${status}: ${detail}`;
}

async function cerebrasFetch(path: string, key: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${CEREBRAS_BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: signal ?? null
  });
  if (!response.ok) throw new Error(cerebrasErrorMessage(response.status, await response.text().catch(() => '')));
  return response;
}

// Cached per key: the list only changes when Cerebras ships a model, and the settings
// UI asks for it on every open.
const TTL_MS = 10 * 60_000;
let cache: { key: string; at: number; models: CerebrasModel[] } | null = null;

/** Models the account can use. Throws a user-readable error when the key is bad. */
export async function listCerebrasModels(key: string, force = false): Promise<CerebrasModel[]> {
  if (!key) return [];
  if (!force && cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.models;
  const response = await cerebrasFetch('/models', key);
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const models = (payload.data ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter(Boolean)
    .sort()
    .map((id) => ({ id, label: id }));
  cache = { key, at: Date.now(), models };
  return models;
}

/** Drop the cached list (key changed, or the user asked for a rescan). */
export function clearCerebrasModels(): void {
  cache = null;
}
