// Where the local agent server is, and how to prove to it that a request comes from Toji.
//
// In the Electron app the server sits at a fixed address (VITE_AGENT_SERVER_URL or the
// default port) and asks for nothing. In the Gecko browser it is started per launch on
// a port of its own and requires a per-launch token; the page learns both from the
// bridge (`window.toji.server()`). The server may still be starting when a page first
// asks, so a null answer is retried a few times before giving up — and giving up is not
// cached, so the next request tries again.

import type { AgentServerInfo } from './bridge';

export interface ServerEndpoint {
  /** Base URL without a trailing slash, e.g. "http://127.0.0.1:8788". */
  base: string;
  /** Sent as `Authorization: Bearer <token>`; null when the server needs none. */
  token: string | null;
}

export interface EndpointSource {
  /** The bridge's server() call; absent outside the Gecko browser. */
  server?: () => Promise<AgentServerInfo | null>;
  /** Where the server is when there is no bridge to ask. */
  fallbackBase: string;
}

export interface ResolverOptions {
  /** How many times to ask before giving up. */
  attempts?: number;
  /** The first wait between attempts; each one after doubles it. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a failed lookup is answered from memory before the server is asked again. */
  failureMemoryMs?: number;
}

export const SERVER_ATTEMPTS = 6;
export const SERVER_RETRY_DELAY_MS = 200;

const trimBase = (url: string) => url.replace(/\/+$/, '');
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EndpointResolver {
  /** Resolves once; concurrent callers share the one lookup. Rejects if the server never answered. */
  get(): Promise<ServerEndpoint>;
  /** The endpoint if it is already known, for code that has to build a URL synchronously. */
  current(): ServerEndpoint | null;
}

/**
 * `source` is read on the first call rather than at creation, so a bridge installed
 * after this module loaded is still found.
 */
export function createEndpointResolver(source: () => EndpointSource, options: ResolverOptions = {}): EndpointResolver {
  const attempts = Math.max(1, options.attempts ?? SERVER_ATTEMPTS);
  const delayMs = options.delayMs ?? SERVER_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  let pending: Promise<ServerEndpoint> | null = null;
  let known: ServerEndpoint | null = null;
  // A failed lookup is remembered briefly: a burst of callers shares one answer instead
  // of each running the whole retry ladder.
  let failed: { at: number; error: unknown } | null = null;
  const failureMemoryMs = options.failureMemoryMs ?? 0;

  const lookup = async (): Promise<ServerEndpoint> => {
    const { server, fallbackBase } = source();
    if (!server) return { base: trimBase(fallbackBase), token: null };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const info = await server().catch(() => null);
      if (info && typeof info.url === 'string' && info.url && typeof info.token === 'string' && info.token) {
        return { base: trimBase(info.url), token: info.token };
      }
      if (attempt < attempts - 1) await sleep(delayMs * 2 ** attempt);
    }
    throw new Error('The Toji server is not running.');
  };

  return {
    get() {
      if (!pending && failed && Date.now() - failed.at < failureMemoryMs) return Promise.reject(failed.error);
      pending ??= lookup().then(
        (endpoint) => {
          known = endpoint;
          failed = null;
          return endpoint;
        },
        (error: unknown) => {
          // Not cached for long: the server may come up later, and a later request should find it.
          pending = null;
          failed = { at: Date.now(), error };
          throw error;
        }
      );
      return pending;
    },
    current: () => known
  };
}

/** Headers every request carries: JSON, plus the bearer token when the server wants one. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : { 'content-type': 'application/json' };
}

/**
 * URLs that are loaded rather than fetched (an iframe's src, a download, a WebSocket)
 * cannot carry a header, so they carry the token as a query parameter instead.
 */
export function withToken(url: string, token: string | null): string {
  if (!token) return url;
  const hash = url.indexOf('#');
  const [head, tail] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
  return `${head}${head.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${tail}`;
}

/** The server's event socket, on the same host as its HTTP API. */
export function eventsUrl(endpoint: ServerEndpoint): string {
  const url = new URL(endpoint.base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return withToken(url.toString(), endpoint.token);
}
