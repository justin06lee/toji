import type { AgentsStatus, AppConfig, PageSource, PredictionResult, ResearchMode, ResearchOptions, ResearchSessionState, ServerEvent, UserSettings } from '../types';
import type { AgentStepResult } from './agentDom';

const DEFAULT_BASE = 'http://127.0.0.1:8787';
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
  scrollY?: number;
  maxScroll?: number;
  elements: Array<{ i: number; tag: string; role: string; name: string; value?: string; rect?: { x: number; y: number; w: number; h: number } }>;
  history?: Array<{ action: string; reason?: string }>;
  image?: string;
  viewport?: { w: number; h: number };
  cells?: Array<{ ref: string; cx: number; cy: number }>;
  credentials?: { name: string; keys: string[]; active?: boolean }[];
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
