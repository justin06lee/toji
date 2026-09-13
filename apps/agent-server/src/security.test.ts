import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

// The sidecar's two guards, against real listeners: the Host check that stops DNS
// rebinding (always on), and the bearer token (when one is configured).

vi.mock('./agents/pageAgent.js', () => ({
  async *streamAnswerPage() {
    yield '<!doctype html><p>streamed page</p>';
  }
}));
vi.mock('./agents/search.js', () => ({
  gatherPageSources: async () => [],
  gatherSearchCandidates: async () => [],
  searchWeb: async () => []
}));

const dataDir = mkdtempSync(path.join(tmpdir(), 'toji-security-test-'));
process.env.TOJI_DATA_DIR = dataDir;
process.env.TOJI_AGENT = 'off';
const { startServer } = await import('./server.js');
const { bearerToken, isAllowedHost, tokensMatch } = await import('./lib/security.js');

const TOKEN = 'correct-horse-battery-staple';
let open: Awaited<ReturnType<typeof startServer>>;
let locked: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  open = await startServer({ port: 0 });
  locked = await startServer({ port: 0, token: TOKEN });
});
afterAll(async () => {
  await Promise.all([open.close(), locked.close()]);
  rmSync(dataDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with full control over headers, Host included. */
function request(port: number, pathname: string, init: { method?: string; headers?: Record<string, string>; host?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: init.method ?? 'GET',
        headers: { host: init.host ?? `127.0.0.1:${port}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

function upgrade(port: number, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; hello?: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
    socket.once('message', (data) => {
      resolve({ status: 101, hello: JSON.parse(String(data)).type });
      socket.close();
    });
    socket.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once('error', () => resolve({ status: -1 }));
  });
}

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

describe('token helpers', () => {
  test('tokensMatch compares whole tokens, whatever their lengths', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('wrong', TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
  });

  test('bearerToken reads only the Bearer scheme', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc  ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  test('isAllowedHost accepts only loopback names on this port', () => {
    expect(isAllowedHost('127.0.0.1:4000', 4000)).toBe(true);
    expect(isAllowedHost('LOCALHOST:4000', 4000)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4001', 4000)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 4000)).toBe(false);
    expect(isAllowedHost('attacker.example:4000', 4000)).toBe(false);
    expect(isAllowedHost('[::1]:4000', 4000)).toBe(false);
    expect(isAllowedHost(undefined, 4000)).toBe(false);
  });
});

describe('Host guard (DNS rebinding), with or without a token', () => {
  test('requests naming this server by loopback address or localhost go through', async () => {
    expect((await request(open.port, '/api/config')).status).toBe(200);
    expect((await request(open.port, '/api/config', { host: `localhost:${open.port}` })).status).toBe(200);
  });

  test('a request under any other name is refused, /health included', async () => {
    for (const host of [`rebind.attacker.example:${open.port}`, `127.0.0.1:${open.port + 1}`, '127.0.0.1']) {
      const reply = await request(open.port, '/health', { host });
      expect(reply.status, host).toBe(421);
    }
    expect((await request(open.port, '/api/settings', { host: `evil.example:${open.port}` })).status).toBe(421);
  });

  test('a valid token does not get a foreign Host through', async () => {
    expect((await request(locked.port, '/api/config', { host: `evil.example:${locked.port}`, headers: bearer() })).status).toBe(421);
  });

  test('WebSocket upgrades are held to the same Host rule', async () => {
    expect((await upgrade(open.port, '/ws', { host: `evil.example:${open.port}` })).status).toBe(421);
    expect((await upgrade(open.port, '/ws')).status).toBe(101);
  });

  test('without a token configured, /api needs no credentials (the Electron app)', async () => {
    expect((await request(open.port, '/api/settings')).status).toBe(200);
    expect(JSON.parse((await request(open.port, '/health')).body)).toHaveProperty('sessionsStored');
  });
});

describe('bearer token', () => {
  test('/health stays open but says only that the server is up', async () => {
    const reply = await request(locked.port, '/health');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ ok: true, app: 'Toji agent server' });
  });

  test('/api/* without the token is 401 with a Bearer challenge', async () => {
    const reply = await request(locked.port, '/api/status');
    expect(reply.status).toBe(401);
    expect(reply.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await request(locked.port, '/api/memory', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(401);
    expect((await request(locked.port, '/api/research/some-id', { method: 'DELETE' })).status).toBe(401);
  });

  test('a wrong token is refused; the right one gets through', async () => {
    expect((await request(locked.port, '/api/status', { headers: bearer('nope') })).status).toBe(401);
    expect((await request(locked.port, '/api/status', { headers: { authorization: TOKEN } })).status).toBe(401);
    const reply = await request(locked.port, '/api/status', { headers: bearer() });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toHaveProperty('sessionsStored');
  });

  test('?token= is honoured on GET /api/page/stream only', async () => {
    const page = await request(locked.port, `/api/page/stream?q=hello&token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('streamed page');
    // The token rides in this page's URL, so the page must never leak it in a Referer.
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect((await request(locked.port, '/api/page/stream?q=hello')).status).toBe(401);
    expect((await request(locked.port, '/api/page/stream?q=hello&token=nope')).status).toBe(401);
    expect((await request(locked.port, '/api/page/stream?q=hello', { headers: bearer() })).status).toBe(200);
    expect((await request(locked.port, `/api/status?token=${TOKEN}`)).status).toBe(401);
  });

  test('the /ws upgrade needs the bearer header', async () => {
    expect((await upgrade(locked.port, '/ws')).status).toBe(401);
    expect((await upgrade(locked.port, '/ws', bearer('nope'))).status).toBe(401);
    expect((await upgrade(locked.port, `/ws?token=${TOKEN}`)).status).toBe(401);
    expect(await upgrade(locked.port, '/ws', bearer())).toEqual({ status: 101, hello: 'hello' });
  });

  test('CORS preflights from the loopback renderer still succeed, so it can send the header', async () => {
    const reply = await request(locked.port, '/api/status', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }
    });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(String(reply.headers['access-control-allow-headers'])).toMatch(/authorization/i);
  });

  test('other origins still get no CORS grant', async () => {
    const reply = await request(locked.port, '/api/status', { headers: { origin: 'https://attacker.example', ...bearer() } });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });
});
