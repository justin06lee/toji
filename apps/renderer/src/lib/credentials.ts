// A local-only credential vault. Secrets live in the renderer (localStorage) and are substituted
// into typed text at the moment the agent types — they are NEVER placed in the model's context or
// sent to the agent server. The model only ever sees placeholder names like {{password}}.

export interface CredentialField {
  key: string;
  value: string;
}
export interface CredentialSet {
  id: string;
  name: string;
  fields: CredentialField[];
}
export interface CredentialStore {
  activeId: string | null;
  sets: CredentialSet[];
}

const STORAGE_KEY = 'toji.credentials';

export function loadCredentials(): CredentialStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sets)) return parsed as CredentialStore;
    }
  } catch {
    /* fall through to empty */
  }
  return { activeId: null, sets: [] };
}

export function saveCredentials(store: CredentialStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export function activeSet(store: CredentialStore): CredentialSet | undefined {
  return store.sets.find((s) => s.id === store.activeId) ?? store.sets[0];
}

/** The placeholder keys available to the agent (NEVER the values). */
export function availableKeys(store: CredentialStore): string[] {
  const set = activeSet(store);
  if (!set) return [];
  return set.fields.map((f) => f.key.trim()).filter(Boolean);
}

export interface CredentialInfo {
  name: string;
  keys: string[];
  active: boolean;
}

/**
 * A directory of every saved set by NAME and its field KEYS (never values), so the agent can
 * choose the right one from the user's request ("my school email" → the "School" set) and fill it
 * via {{Name:key}}. Names/keys are not secret; values stay local.
 */
export function credentialDirectory(store: CredentialStore): CredentialInfo[] {
  const act = activeSet(store);
  return store.sets
    .map((s) => ({ name: s.name, keys: s.fields.map((f) => f.key.trim()).filter(Boolean), active: s.id === act?.id }))
    .filter((s) => s.keys.length > 0);
}

/**
 * Replace {{key}} (active set) or {{setName:key}} with the real secret value — locally, at
 * type-time only. Unknown placeholders are left as-is so a missing credential is visible. The
 * resolved string is typed into the page but never returned to the model or the network.
 */
export function resolveSecrets(text: string, store: CredentialStore): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, body) => {
    const raw = String(body).trim();
    const sep = raw.indexOf(':');
    const setName = sep > -1 ? raw.slice(0, sep).trim() : '';
    const key = (sep > -1 ? raw.slice(sep + 1) : raw).trim();
    const set = setName ? store.sets.find((s) => s.name.toLowerCase() === setName.toLowerCase()) : activeSet(store);
    const field = set?.fields.find((f) => f.key.trim().toLowerCase() === key.toLowerCase());
    return field ? field.value : full;
  });
}
