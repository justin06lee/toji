import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

// The server as the browser sidecar sees it: started on a free port, its event stream,
// and the page stream it must stop generating when the viewer goes away.

// Records, per generation, whether it ran to the end or saw its signal abort.
const generations = vi.hoisted(() => ({ outcomes: [] as Array<'aborted' | 'finished'> }));

vi.mock('./agents/pageAgent.js', () => ({
  async *streamAnswerPage(_query: string, signal?: AbortSignal) {
    for (let i = 0; i < 400; i += 1) {
      if (signal?.aborted) {
        generations.outcomes.push('aborted');
        return;
      }
      yield `<p>chunk ${i}</p>`;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    generations.outcomes.push('finished');
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
const { startServer } = await import('./server.js');
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
