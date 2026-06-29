import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { config, isBraveSearchEnabled } from './config.js';
import { ensureDataDirs, countSessions, loadSettings, removeSessionSnapshot, saveSettings } from './lib/storage.js';
import { addSocket, broadcast, sendToSocket } from './lib/events.js';
import { sessionToMarkdown, sessionToPortableJson } from './lib/export.js';
import { predictIntent } from './agents/predictionAgent.js';
import { researchOrchestrator } from './agents/researchAgent.js';
import { streamAnswerPage } from './agents/pageAgent.js';
import { gatherPageSources } from './agents/search.js';
import { getCachedPage, putCachedPage } from './lib/pageCache.js';
import { nextAgentAction, researchHelp } from './agents/webAgent.js';
import { agentAvailable, liveModelName } from './agents/model.js';
import { detectAgents, getEffectiveAgent, isValidAgentCmd, refreshDetection, setAgentChoice } from './agents/agentRuntime.js';
import type { UserSettings } from './types.js';

const app = express();

// Simple in-memory rate limiter for expensive endpoints.
// Prevents abuse from rogue local processes or DNS rebinding attacks.
function rateLimit(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    // Periodic cleanup to prevent memory leak.
    if (hits.size > 100) {
      for (const [k, v] of hits) {
        if (v.filter((t) => now - t < windowMs).length === 0) hits.delete(k);
      }
    }
    return next();
  };
}
const expensiveRateLimit = rateLimit(10_000, 10); // 10 requests per 10 seconds

// Only the local renderer needs cross-origin access. In the packaged desktop
// app the renderer is loaded via file:// (which sends `Origin: null`), and in
// dev it is served from a localhost dev server. Reject every other origin so a
// random website the user has open cannot reach the local agent API.
const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (same-origin, curl, native fetch) and
      // the file:// renderer (`Origin: null`) are trusted; everything else must
      // match a loopback origin.
      if (!origin || origin === 'null' || allowedOriginPattern.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: false
  })
);
// Limit is generous because the web agent's vision step posts a JPEG screenshot
// (a base64 data URI) alongside the page's elements.
app.use(express.json({ limit: '12mb' }));

const optionsSchema = z
  .object({
    depth: z.enum(['spark', 'quick', 'standard', 'deep']).optional(),
    maxTabs: z.number().int().min(1).max(config.maxAgentTabs).optional(),
    visualSnapshots: z.boolean().optional(),
    includeVisualAnalysis: z.boolean().optional(),
    freshness: z.enum(['auto', 'latest', 'timeless']).optional()
  })
  .optional();

const settingsPatchSchema = z
  .object({
    autoSpeculation: z.boolean().optional(),
    maxTabs: z.number().int().min(1).max(config.maxAgentTabs).optional(),
    defaultDepth: z.enum(['spark', 'quick', 'standard', 'deep']).optional(),
    defaultFreshness: z.enum(['auto', 'latest', 'timeless']).optional(),
    visualAnalysis: z.boolean().optional(),
    theme: z.enum(['dark', 'system']).optional(),
    agent: z.enum(['auto', 'claude', 'codex', 'opencode', 'off']).optional(),
    agentCmd: z.string().max(500).refine((val) => !val || isValidAgentCmd(val), { message: 'Invalid agent command: contains unsafe characters or references a disallowed binary' }).optional()
  })
  .strict();

async function buildStatusPayload() {
  return {
    ok: true,
    app: `${config.appName} agent server`,
    liveModelEnabled: agentAvailable(),
    model: liveModelName(),
    maxAgentTabs: config.maxAgentTabs,
    maxSpeculativeTabs: config.maxSpeculativeTabs,
    maxConcurrentTabs: config.maxConcurrentTabs,
    maxSearchQueries: config.maxSearchQueries,
    searchProvider: isBraveSearchEnabled ? 'brave' : config.searchProvider === 'brave' ? 'brave-disabled' : 'duckduckgo',
    visualAnalysisEnabled: config.enableVisualAnalysis,
    sessionsStored: await countSessions()
  };
}

app.get('/health', async (_req, res, next) => {
  try {
    res.json(await buildStatusPayload());
  } catch (error) {
    next(error);
  }
});

app.get('/api/status', async (_req, res, next) => {
  try {
    res.json(await buildStatusPayload());
  } catch (error) {
    next(error);
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    app: config.appName,
    liveModelEnabled: agentAvailable(),
    model: liveModelName(),
    maxAgentTabs: config.maxAgentTabs,
    maxSpeculativeTabs: config.maxSpeculativeTabs,
    maxConcurrentTabs: config.maxConcurrentTabs,
    visualAnalysisEnabled: config.enableVisualAnalysis,
    demoModeEnabled: config.demoModeEnabled,
    searchProvider: isBraveSearchEnabled ? 'brave' : config.searchProvider === 'brave' ? 'brave-disabled' : 'duckduckgo',
    maxSearchQueries: config.maxSearchQueries,
    sessionHistoryLimit: config.sessionHistoryLimit
  });
});


app.get('/api/settings', async (_req, res, next) => {
  try {
    res.json(await loadSettings());
  } catch (error) {
    next(error);
  }
});

app.patch('/api/settings', async (req, res, next) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const current = await loadSettings();
    const nextSettings: UserSettings = { ...current, ...patch };
    await saveSettings(nextSettings);
    // Apply the agent choice immediately so the change takes effect without a restart.
    setAgentChoice({ agent: nextSettings.agent, agentCmd: nextSettings.agentCmd });
    broadcast({ type: 'settings_update', settings: nextSettings });
    res.json(nextSettings);
  } catch (error) {
    next(error);
  }
});

// Which coding agents are installed, and which command Toji will actually run.
// The UI uses this to offer a zero-config picker with live detection status.
app.get('/api/agents', (_req, res) => {
  const detected = refreshDetection();
  const effective = getEffectiveAgent();
  res.json({
    detected,
    available: agentAvailable(),
    effective: effective
      ? { label: effective.label, source: effective.source, command: [effective.cmd, ...effective.args].join(' ') }
      : null
  });
});

app.post('/api/predict', async (req, res, next) => {
  try {
    const body = z.object({ query: z.string().max(1000) }).parse(req.body);
    const prediction = await predictIntent(body.query);
    broadcast({ type: 'prediction', prediction });
    res.json(prediction);
  } catch (error) {
    next(error);
  }
});

// Stream the AI-generated HTML page straight to an <iframe src>. The browser's
// native parser renders it progressively as it arrives (correct handling of
// <style> across chunks, no flicker). The response carries a strict CSP so the
// generated page can use inline styles + images but never run scripts.
app.get('/api/page/stream', expensiveRateLimit, async (req, res) => {
  const query = String(req.query.q ?? '').slice(0, 1200).trim();
  const theme = req.query.theme === 'dark' ? 'dark' : 'light';
  const fresh = req.query.fresh === '1';
  if (!query) {
    res.status(400).type('text/html').end('<!doctype html><title>Toji</title><body></body>');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data: https://fonts.gstatic.com; base-uri 'none'; form-action 'none'"
  );

  // Serve an identical previously-generated page instantly (unless a reload forces fresh).
  if (!fresh) {
    const cached = await getCachedPage(theme, query);
    if (cached) {
      res.end(cached);
      return;
    }
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  // Ground the page in the same web sources shown in the footer.
  const sources = await gatherPageSources(query).catch((error) => {
    console.warn('[toji] gatherPageSources failed for page stream:', error instanceof Error ? error.message : error);
    return [];
  });
  let full = '';
  try {
    for await (const chunk of streamAnswerPage(query, theme, controller.signal, sources)) {
      if (controller.signal.aborted) break;
      full += chunk;
      res.write(chunk);
    }
  } catch {
    // The browser keeps whatever rendered; nothing more to send.
  }
  res.end();
  // Cache only complete generations (not aborted / not the offline fallback page).
  if (!controller.signal.aborted && full.length > 0 && !full.includes('Toji · demo render')) {
    void putCachedPage(theme, query, full);
  }
});

// Web agent: given the page's interactive elements + a goal, decide the next action.
app.post('/api/agent/step', expensiveRateLimit, async (req, res, next) => {
  try {
    const body = z
      .object({
        goal: z.string().min(1).max(600),
        url: z.string().max(2000),
        title: z.string().max(400).optional(),
        scrollY: z.number().optional(),
        maxScroll: z.number().optional(),
        elements: z
          .array(
            z.object({
              i: z.number(),
              tag: z.string(),
              role: z.string(),
              name: z.string(),
              value: z.string().optional(),
              rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional()
            })
          )
          .max(80),
        history: z.array(z.object({ action: z.string(), reason: z.string().optional() })).max(20).optional(),
        image: z.string().max(12_000_000).optional(),
        viewport: z.object({ w: z.number(), h: z.number() }).optional(),
        cells: z.array(z.object({ ref: z.string().max(6), cx: z.number(), cy: z.number() })).max(400).optional(),
        credentials: z
          .array(z.object({ name: z.string().max(60), keys: z.array(z.string().max(60)).max(20), active: z.boolean().optional() }))
          .max(20)
          .optional()
      })
      .parse(req.body);
    res.json(await nextAgentAction(body));
  } catch (error) {
    next(error);
  }
});

// Research sub-agent: the web agent calls this when stuck/unsure how to do something.
app.post('/api/agent/research', async (req, res, next) => {
  try {
    const body = z
      .object({ question: z.string().min(1).max(400), goal: z.string().max(600).optional(), url: z.string().max(2000).optional() })
      .parse(req.body);
    res.json({ answer: await researchHelp(body) });
  } catch (error) {
    next(error);
  }
});

// Real web sources gathered for the page, fetched by the client in parallel.
app.get('/api/page/sources', async (req, res, next) => {
  try {
    const query = String(req.query.q ?? '').slice(0, 1200).trim();
    if (!query) return res.json({ sources: [] });
    return res.json({ sources: await gatherPageSources(query) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/research/start', expensiveRateLimit, async (req, res, next) => {
  try {
    const body = z
      .object({
        query: z.string().min(1).max(1200),
        mode: z.enum(['speculative', 'committed']).default('committed'),
        options: optionsSchema,
        previousSessionId: z.string().optional(),
        supersedesSessionId: z.string().optional()
      })
      .parse(req.body);
    const session = researchOrchestrator.start(body.query, body.mode, body.options ?? {}, body.previousSessionId ?? body.supersedesSessionId);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

app.post('/api/research/demo', expensiveRateLimit, async (req, res, next) => {
  try {
    if (!config.demoModeEnabled) return res.status(403).json({ error: 'demo mode is disabled' });
    const body = z
      .object({
        query: z.string().max(1200).optional(),
        options: optionsSchema
      })
      .parse(req.body);
    const session = researchOrchestrator.start(body.query || 'Show how Toji researches with visible browser agents', 'demo', body.options ?? {});
    return res.json(session);
  } catch (error) {
    next(error);
  }
});

app.post('/api/research/:id/commit', async (req, res, next) => {
  try {
    const body = z.object({ query: z.string().max(1200).optional() }).parse(req.body ?? {});
    const session = await researchOrchestrator.commit(req.params.id, body.query);
    if (!session) return res.status(404).json({ error: 'session not found' });
    return res.json(session);
  } catch (error) {
    next(error);
  }
});

app.post('/api/research/:id/cancel', async (req, res, next) => {
  try {
    const session = await researchOrchestrator.cancel(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    return res.json(session);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/research/:id', async (req, res, next) => {
  try {
    const result = await researchOrchestrator.removeSession(req.params.id);
    if (!result.removed) {
      const snapshotRemoved = await removeSessionSnapshot(req.params.id);
      if (!snapshotRemoved) return res.status(404).json({ error: 'session not found' });
      return res.json({ id: req.params.id, removed: true, fromMemory: false, persisted: true });
    }
    return res.json({ id: req.params.id, removed: true, fromMemory: result.fromMemory, fromActive: result.wasActive, persisted: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/research', async (_req, res, next) => {
  try {
    const result = await researchOrchestrator.clearSessions();
    if (result.skipped.length) {
      return res.status(409).json({ error: 'active sessions remain', removed: result.removed, skipped: result.skipped });
    }
    return res.json({ removed: result.removed });
  } catch (error) {
    next(error);
  }
});

app.get('/api/research/:id/export', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const format = String(req.query.format ?? 'markdown');
  if (format === 'json') {
    res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.json"`);
    return res.json(sessionToPortableJson(session));
  }
  res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.md"`);
  return res.type('text/markdown').send(sessionToMarkdown(session));
});

app.get('/api/research/:id/export.md', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.md"`);
  res.type('text/markdown').send(sessionToMarkdown(session));
});

app.get('/api/research/:id/export.json', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.json"`);
  res.json(sessionToPortableJson(session));
});

app.get('/api/research/:id', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  return res.json(session);
});

app.get('/api/research', (_req, res) => {
  res.json({ sessions: researchOrchestrator.listSessions() });
});

// In production the bundled server also serves the built renderer, so the packaged
// app loads over http:// from this same origin — avoiding file:// CSP/CORS issues and
// keeping the renderer same-origin with the API.
const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../renderer');
if (fs.existsSync(path.join(rendererDir, 'index.html'))) {
  app.use(express.static(rendererDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path === '/ws') return next();
    return res.sendFile(path.join(rendererDir, 'index.html'));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: error.message });
  }
  console.error('[toji] request error:', error);
  return res.status(500).json({ error: 'internal server error' });
});

await ensureDataDirs();
await researchOrchestrator.hydrate();

// Seed the effective agent from persisted settings (falls back to env-derived
// defaults on first run), and detect installed agents once at boot.
detectAgents();
try {
  const settings = await loadSettings();
  setAgentChoice({ agent: settings.agent, agentCmd: settings.agentCmd });
} catch (error) {
  console.warn('[toji] Failed to load settings at boot, using env defaults:', error instanceof Error ? error.message : error);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  addSocket(ws);
  sendToSocket(ws, { type: 'hello', app: config.appName, message: 'Connected to Toji agent stream.' });
});

// Fail loudly if the port is taken. Otherwise Toji silently never binds and the
// renderer (dev + packaged) ends up talking to whatever else is on this port —
// e.g. a stale dev server from another project — which is impossible to diagnose.
function isAddrInUse(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
function reportPortConflict() {
  console.error(
    `[toji] Port ${config.port} is already in use by another process. ` +
      `Toji's server cannot start. Stop whatever is on :${config.port} ` +
      `(e.g. \`lsof -nP -i :${config.port}\` then kill it), or set PORT to a free port.`
  );
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('[toji] unhandledRejection:', reason);
});
// A failed listen surfaces here (not always on the server 'error' event under the
// top-level-await module), so catch the port conflict explicitly and exit clean.
process.on('uncaughtException', (err) => {
  if (isAddrInUse(err)) reportPortConflict();
  console.error('[toji] uncaughtException:', err);
});

// Backup path: if the listen error does arrive as a server 'error' event, handle it too.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (isAddrInUse(err)) reportPortConflict();
  console.error('[toji] server error:', err);
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Toji agent server running at http://127.0.0.1:${config.port}`);
  console.log(`Inference mode: ${agentAvailable() ? liveModelName() : 'demo fallback (no agent)'}`);
});
