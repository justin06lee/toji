import type { AgentsStatus, AppConfig, Billing, CerebrasModels, ModelCatalog, PageSource, PredictionResult, ResearchMode, ResearchOptions, ResearchSessionState, ServerEvent, UserSettings } from '../types';
import type { AgentStepResult } from './agentDom';

const DEFAULT_BASE = 'http://127.0.0.1:8788';
export const API_BASE = import.meta.env.VITE_AGENT_SERVER_URL || DEFAULT_BASE;

function wsUrl() {
  const url = new URL(API_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

export function getConfig() {
  return jsonFetch<AppConfig>('/api/config');
}

export function getSettings() {
  return jsonFetch<UserSettings>('/api/settings');
}

export function getAgents() {
  return jsonFetch<AgentsStatus>('/api/agents');
}

/** Every model every installed coding CLI reports. `refresh` re-probes the harnesses. */
export function getAgentModels(refresh = false) {
  return jsonFetch<ModelCatalog>(`/api/agents/models${refresh ? '?refresh=1' : ''}`);
}

/** Cerebras models the server's key can reach (the key stays server-side). */
/** The subscription tiers and whether this install has one. */
export function getBilling() {
  return jsonFetch<Billing>('/api/billing/plans');
}

export function getCerebrasModels(refresh = false) {
  return jsonFetch<CerebrasModels>(`/api/agents/cerebras-models${refresh ? '?refresh=1' : ''}`);
}

// --- Memory management ---
export interface MemoryFact {
  id: string;
  ts: string;
  text: string;
  tags: string[];
  sessionId?: string;
}
export function getMemoryFacts() {
  return jsonFetch<{ facts: MemoryFact[] }>('/api/memory');
}
export function deleteMemoryFact(id: string) {
  return jsonFetch<{ removed: boolean }>(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export interface PinnedMemory {
  memory: string;
  user: string;
  caps: { memory: number; user: number };
}
export function getPinnedMemory() {
  return jsonFetch<PinnedMemory>('/api/memory/pinned');
}
export function savePinnedMemory(patch: { memory?: string; user?: string }) {
  return jsonFetch<PinnedMemory>('/api/memory/pinned', { method: 'PUT', body: JSON.stringify(patch) });
}

// --- Reference documents (persistent files the agent can pull up) ---
export interface ReferenceDoc {
  id: string;
  name: string;
  mime: string;
  path: string;
  size: number;
  addedAt: string;
}
export function getReferences() {
  return jsonFetch<{ references: ReferenceDoc[] }>('/api/references');
}
export function addReference(name: string, mime: string, dataBase64: string) {
  return jsonFetch<ReferenceDoc>('/api/references', { method: 'POST', body: JSON.stringify({ name, mime, dataBase64 }) });
}
export function deleteReference(id: string) {
  return jsonFetch<{ removed: boolean }>(`/api/references/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Bookmark import ---
export interface DetectedBrowser {
  id: string;
  name: string;
  available: boolean;
}
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  folder?: string;
  addedAt: string;
}
export function getImportBrowsers() {
  return jsonFetch<{ browsers: DetectedBrowser[] }>('/api/import/browsers');
}
export function importBookmarks(browser: string) {
  return jsonFetch<{ found: number; added: number }>('/api/import/bookmarks', { method: 'POST', body: JSON.stringify({ browser }) });
}
export function getBookmarks() {
  return jsonFetch<{ bookmarks: Bookmark[] }>('/api/bookmarks');
}
export function deleteBookmark(id: string) {
  return jsonFetch<{ removed: boolean }>(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function saveSettings(patch: Partial<UserSettings>) {
  return jsonFetch<UserSettings>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

/** URL the page iframe streams its HTML from (rendered progressively by the browser).
 *  Pass reloadKey > 0 to force a fresh (uncached) regeneration on reload. */
export function pageStreamUrl(query: string, theme: 'light' | 'dark' = 'light', reloadKey = 0) {
  const base = `${API_BASE}/api/page/stream?q=${encodeURIComponent(query)}&theme=${theme}`;
  return reloadKey > 0 ? `${base}&fresh=1&n=${reloadKey}` : base;
}

export function fetchPageSources(query: string) {
  return jsonFetch<{ sources: PageSource[] }>(`/api/page/sources?q=${encodeURIComponent(query)}`);
}

export function agentStep(body: {
  goal: string;
  url: string;
  title?: string;
  history?: Array<{ action: string; reason?: string }>;
  /** The tab's current screenshot (data URI) — the agent's only view of the page. */
  image?: string;
  /** Pixel size of that screenshot: the coordinate space the model answers in. */
  image_size?: { w: number; h: number };
  credentialAccess?: boolean;
  files?: { index: number; name: string; mime?: string }[];
  memory?: string;
}) {
  return jsonFetch<AgentStepResult>('/api/agent/step', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function agentResearch(body: { question: string; goal?: string; url?: string }) {
  return jsonFetch<{ answer: string }>('/api/agent/research', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/** Upload a dropped file to the local server; returns its on-disk path so the agent can read/upload it. */
export function uploadFile(name: string, mime: string, dataBase64: string) {
  return jsonFetch<{ path: string; name: string; mime: string }>('/api/files', {
    method: 'POST',
    body: JSON.stringify({ name, mime, dataBase64 })
  });
}

/** Librarian: compact memory digest relevant to a goal, plus always-on pinned memory. */
export function librarian(goal: string, sessionId?: string) {
  return jsonFetch<{ digest: string; pinned: string }>('/api/agent/librarian', {
    method: 'POST',
    body: JSON.stringify({ goal, sessionId })
  });
}

/** Save a durable memory fact the agent learned. */
export function addMemory(text: string, tags?: string[], sessionId?: string) {
  return jsonFetch<{ id: string }>('/api/memory', {
    method: 'POST',
    body: JSON.stringify({ text, tags, sessionId })
  });
}

export function predict(query: string, signal?: AbortSignal) {
  return jsonFetch<PredictionResult>('/api/predict', {
    method: 'POST',
    body: JSON.stringify({ query }),
    signal
  });
}

export function startResearch(query: string, mode: ResearchMode, options?: Partial<ResearchOptions>, previousSessionId?: string) {
  return jsonFetch<ResearchSessionState>('/api/research/start', {
    method: 'POST',
    body: JSON.stringify({ query, mode, options, previousSessionId })
  });
}

export function startDemoResearch(query: string, options?: Partial<ResearchOptions>) {
  return jsonFetch<ResearchSessionState>('/api/research/demo', {
    method: 'POST',
    body: JSON.stringify({ query, options })
  });
}

export function commitResearch(id: string, query?: string) {
  return jsonFetch<ResearchSessionState>(`/api/research/${id}/commit`, {
    method: 'POST',
    body: JSON.stringify({ query })
  });
}

export function cancelResearch(id: string) {
  return jsonFetch<ResearchSessionState>(`/api/research/${id}/cancel`, {
    method: 'POST'
  });
}

export function listResearchSessions() {
  return jsonFetch<{ sessions: ResearchSessionState[] }>('/api/research');
}

export function getResearchSession(id: string) {
  return jsonFetch<ResearchSessionState>(`/api/research/${id}`);
}

export function exportUrl(id: string, format: 'markdown' | 'json' = 'markdown') {
  return `${API_BASE}/api/research/${id}/export?format=${format}`;
}

export function connectEvents(onEvent: (event: ServerEvent) => void, onState?: (connected: boolean) => void) {
  let closedByClient = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;

  const connect = () => {
    socket = new WebSocket(wsUrl());
    socket.onopen = () => onState?.(true);
    socket.onclose = () => {
      onState?.(false);
      if (!closedByClient) reconnectTimer = window.setTimeout(connect, 1200);
    };
    socket.onerror = () => onState?.(false);
    socket.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        // Ignore malformed events.
      }
    };
  };

  connect();

  return () => {
    closedByClient = true;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}
