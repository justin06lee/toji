import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type express from 'express';

// The agent server listens on loopback, but loopback is not a trust boundary: every
// page the user has open can send it requests. Two guards stand in front of it.
//
//   Host guard   (always on) — a request must name this server as 127.0.0.1:<port>
//                or localhost:<port>. A DNS-rebinding page reaches the port under its
//                own hostname, so its requests carry that hostname and are refused.
//   Bearer token (when TOJI_SERVER_TOKEN is set) — every /api/* request and the /ws
//                upgrade must carry `Authorization: Bearer <token>`. The one exception
//                is GET /api/page/stream, which the browser loads directly as a page and
//                so may pass `?token=<token>` instead.

export interface SecurityOptions {
  /** The shared secret; no token means no authentication (the Electron app's mode). */
  token?: string;
  /** The port actually bound, known only once the server is listening. */
  port: () => number;
}

/** Compare a presented token with the real one without leaking either through timing. Hashing first makes both inputs the same length, so the length of the secret leaks nothing either. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** The token in an `Authorization: Bearer <token>` header, if that is what the header is. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match?.[1];
}

/** Whether a Host header names this server: its loopback address or localhost, on its port. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host || !port) return false;
  const value = host.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function hasValidBearer(req: IncomingMessage, token: string): boolean {
  const presented = bearerToken(req.headers.authorization);
  return presented !== undefined && tokensMatch(presented, token);
}

/** Refuse, before anything else runs, any request that does not address this server by a loopback name. */
export function hostGuard(options: SecurityOptions): express.RequestHandler {
  return (req, res, next) => {
    if (isAllowedHost(req.headers.host, options.port())) return next();
    // 421 Misdirected Request: this server does not answer for the name that was used.
    res.status(421).json({ error: 'This server only answers requests addressed to 127.0.0.1 or localhost.' });
  };
}

/** Require the bearer token on /api/*; the answer-page stream may carry it as ?token= instead. */
export function apiAuth(options: SecurityOptions): express.RequestHandler {
  return (req, res, next) => {
    const token = options.token;
    if (!token || !req.path.startsWith('/api/')) return next();
    if (hasValidBearer(req, token)) return next();
    if (req.method === 'GET' && req.path === '/api/page/stream') {
      const presented = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (presented !== undefined && tokensMatch(presented, token)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="toji"');
    res.status(401).json({ error: 'Missing or invalid bearer token.' });
  };
}

/** Why a WebSocket upgrade must be refused (status + reason), or undefined when it may proceed. */
export function upgradeRefusal(req: IncomingMessage, options: SecurityOptions): { status: number; reason: string } | undefined {
  if (!isAllowedHost(req.headers.host, options.port())) return { status: 421, reason: 'Misdirected Request' };
  if (options.token && !hasValidBearer(req, options.token)) return { status: 401, reason: 'Unauthorized' };
  return undefined;
}
