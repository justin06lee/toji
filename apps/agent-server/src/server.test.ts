import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

// The server as the browser sidecar sees it: started on a free port, its event stream,
// and the page stream it must stop generating when the viewer goes away.

// Records, per generation, whether it ran to the end or saw its signal abort; `result`
// is the PageOutcome a finished generation reports, `chunks` how long it runs.
const generations = vi.hoisted(() => ({
  outcomes: [] as Array<'aborted' | 'finished'>,
  result: 'model' as 'model' | 'partial' | 'error' | 'demo',
  chunks: 400
}));

vi.mock('./agents/pageAgent.js', () => ({
  async *streamAnswerPage(_query: string, signal?: AbortSignal) {
    for (let i = 0; i < generations.chunks; i += 1) {
      if (signal?.aborted) {
        generations.outcomes.push('aborted');
        return 'partial';
      }
      yield `<p>chunk ${i}</p>`;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    generations.outcomes.push('finished');
    return generations.result;
  }
}));

// No test may reach a real search engine.
vi.mock('./agents/search.js', () => ({
  gatherPageSources: async () => [],
  gatherSearchCandidates: async () => [],
  searchWeb: async () => []
}));

const dataDir = mkdtempSync(path.join(tmpdir(), 'toji-server-test-'));
process.env.TOJI_DATA_DIR = dataDir;
process.env.TOJI_AGENT = 'off';
const { startServer, UPLOAD_BASE64_MAX, UPLOAD_BODY_LIMIT_BYTES } = await import('./server.js');
const { getCachedPage } = await import('./lib/pageCache.js');
type Running = Awaited<ReturnType<typeof startServer>>;

let running: Running;
beforeAll(async () => {
  running = await startServer({ port: 0 });
});
afterAll(async () => {
  await running.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function post(port: number, pathname: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        answered = true;
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    // A server refusing an oversized body may close before the upload finishes; the
    // status it sent is still the answer.
    req.on('error', (error) => (answered ? undefined : reject(error)));
    req.end(body);
  });
}

function openSocket(url: string): Promise<{ status: number; firstMessage?: { type?: string } }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.once('message', (data) => {
      resolve({ status: 101, firstMessage: JSON.parse(String(data)) });
      socket.close();
    });
    socket.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once('error', () => resolve({ status: -1 }));
  });
}

describe('startServer', () => {
  test('asked for port 0, it binds a free port on loopback and reports it', async () => {
    expect(running.port).toBeGreaterThan(0);
    const address = running.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
    const health = await get(running.port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true });
  });

  test('serves the agent event stream on /ws', async () => {
    const socket = await openSocket(`ws://127.0.0.1:${running.port}/ws`);
    expect(socket.status).toBe(101);
    expect(socket.firstMessage?.type).toBe('hello');
  });

  test('refuses WebSocket upgrades on any other path', async () => {
    expect((await openSocket(`ws://127.0.0.1:${running.port}/elsewhere`)).status).toBe(400);
  });

  test('serves no static files unless given a renderer directory', async () => {
    expect((await get(running.port, '/')).status).toBe(404);
  });
});

describe('the answer-page stream', () => {
  afterEach(() => {
    generations.outcomes = [];
    generations.result = 'model';
    generations.chunks = 400;
  });

  test('stops generating when the viewer disconnects mid-stream', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: running.port, path: '/api/page/stream?q=disconnect%20test&fresh=1' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', (error) => ((error as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(error)));
    });
    await vi.waitFor(() => expect(generations.outcomes).toEqual(['aborted']), { timeout: 3_000 });
  });

  test('a viewer that stays gets the whole page', async () => {
    const page = await get(running.port, '/api/page/stream?q=complete%20test&fresh=1');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<p>chunk 399</p>');
    expect(generations.outcomes).toEqual(['finished']);
  }, 15_000);

  test('a complete model answer is cached and served again without regenerating', async () => {
    generations.chunks = 3;
    await get(running.port, '/api/page/stream?q=cache%20me');
    await vi.waitFor(async () => expect(await getCachedPage('cache me')).toContain('<p>chunk 2</p>'));
    const again = await get(running.port, '/api/page/stream?q=cache%20me');
    expect(again.body).toContain('<p>chunk 2</p>');
    expect(generations.outcomes).toEqual(['finished']);
  });

  test.each(['error', 'demo', 'partial'] as const)('a %s page is never cached', async (result) => {
    generations.chunks = 3;
    generations.result = result;
    const query = `not cached ${result}`;
    await get(running.port, `/api/page/stream?q=${encodeURIComponent(query)}`);
    await get(running.port, `/api/page/stream?q=${encodeURIComponent(query)}`);
    // Generated twice: the second request found nothing in the cache.
    expect(generations.outcomes).toEqual(['finished', 'finished']);
    expect(await getCachedPage(query)).toBeUndefined();
  });
});

describe('request body limits', () => {
  test('the upload routes accept everything their schemas allow', () => {
    // Base64 is ASCII, so characters are bytes; the rest is the JSON envelope.
    expect(UPLOAD_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(UPLOAD_BASE64_MAX + JSON.stringify({ name: 'x'.repeat(255), mime: 'x'.repeat(200), dataBase64: '' }).length);
  });

  test('a 10 MB file, over the old 12 MB JSON limit once encoded, uploads', async () => {
    const file = Buffer.alloc(10 * 1024 * 1024, 7);
    const body = JSON.stringify({ name: 'big.bin', mime: 'application/octet-stream', dataBase64: file.toString('base64') });
    expect(body.length).toBeGreaterThan(12 * 1024 * 1024);
    const upload = await post(running.port, '/api/files', body);
    expect(upload.status).toBe(200);
    expect(statSync(JSON.parse(upload.body).path).size).toBe(file.length);
    const reference = await post(running.port, '/api/references', body);
    expect(reference.status).toBe(200);
    expect(JSON.parse(reference.body).size).toBe(file.length);
  });

  test('every other route keeps the 12 MB limit, and says so with a 413', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(13 * 1024 * 1024) });
    expect((await post(running.port, '/api/memory', body)).status).toBe(413);
  });

  test('malformed JSON is the client’s 400, not a server error', async () => {
    expect((await post(running.port, '/api/memory', '{"text":')).status).toBe(400);
  });
});

describe('renderer serving', () => {
  test('serves TOJI_RENDERER_DIR with an SPA fallback, but never over /api', async () => {
    const rendererDir = mkdtempSync(path.join(tmpdir(), 'toji-renderer-test-'));
    mkdirSync(path.join(rendererDir, 'assets'));
    writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html><title>renderer marker</title>');
    writeFileSync(path.join(rendererDir, 'assets', 'app.js'), 'console.log(1)');
    const withRenderer = await startServer({ port: 0, rendererDir });
    try {
      expect((await get(withRenderer.port, '/')).body).toContain('renderer marker');
      expect((await get(withRenderer.port, '/settings/models')).body).toContain('renderer marker');
      expect((await get(withRenderer.port, '/assets/app.js')).body).toBe('console.log(1)');
      expect((await get(withRenderer.port, '/api/nope')).status).toBe(404);
    } finally {
      await withRenderer.close();
      rmSync(rendererDir, { recursive: true, force: true });
    }
  });
});
