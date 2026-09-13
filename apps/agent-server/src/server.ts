import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { config, isBraveSearchEnabled } from './config.js';
import { countSessions, loadSettings, removeSessionSnapshot, saveSettings } from './lib/storage.js';
import { addSocket, broadcast, sendToSocket } from './lib/events.js';
import { sessionToMarkdown, sessionToPortableJson } from './lib/export.js';
import { predictIntent } from './agents/predictionAgent.js';
import { researchOrchestrator } from './agents/researchAgent.js';
import { streamAnswerPage } from './agents/pageAgent.js';
import { gatherPageSources } from './agents/search.js';
import { getCachedPage, putCachedPage } from './lib/pageCache.js';
import { nextAgentAction, researchHelp } from './agents/webAgent.js';
import { agentAvailable, liveModelName } from './agents/model.js';
import { agentStatus, cerebrasCredentials, refreshDetection, setAgentChoice, setApiConfig } from './agents/agentRuntime.js';
import { listCerebrasModels } from './agents/cerebras.js';
import { plans, subscriptionStatus } from './lib/billing.js';
import { modelCatalog } from './agents/yagamiCatalog.js';
import { addFact, listFacts, removeFact, readPinned, writePinned, PINNED_CAPS } from './lib/memory.js';
import { listBookmarks, addBookmarks, removeBookmark } from './lib/bookmarks.js';
import { addReference, listReferences, removeReference } from './lib/references.js';
import { librarianDigest, pinnedDigest } from './agents/librarianAgent.js';
import { apiAuth, hostGuard, upgradeRefusal, type SecurityOptions } from './lib/security.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { UserSettings } from './types.js';

// The agent server's HTTP and WebSocket surface. index.ts boots the process (data dir,
// saved sessions, settings) and calls startServer; tests start it on a free port.
const routes = express.Router();

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

// Only the local renderer needs cross-origin access. The packaged desktop app
// loads the renderer over http://127.0.0.1 and the server serves the static
// renderer same-origin; in dev it is served from a localhost dev server. Reject
// every other origin so a random website the user has open cannot reach the
// local agent API.
const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const corsMiddleware = cors({
  origin(origin, callback) {
    // Requests without an Origin header (same-origin, curl, native fetch) are
    // trusted; everything else must match a loopback origin. The literal
    // `Origin: null` (sandboxed iframes, data:/blob: documents) is rejected.
    if (!origin || allowedOriginPattern.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: false
});

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
    agent: z.enum(['toji', 'yagami', 'cerebras', 'local', 'off']).optional(),
    agentModel: z.string().max(160).optional(),
    agentThinking: z.enum(['default', 'low', 'medium', 'high']).optional(),
    cerebrasModel: z.string().max(160).optional(),
    cerebrasApiKey: z.string().max(400).optional(),
    localUrl: z
      .string()
      .max(400)
      .refine((val) => !val || /^https?:\/\//i.test(val.trim()), { message: 'Custom endpoint URL must start with http:// or https://' })
      .optional(),
    localModel: z.string().max(160).optional(),
    localApiKey: z.string().max(400).optional()
  })
  .strict();

// API keys are stored in the local settings.json but never echoed back over HTTP:
// responses carry a mask (so the UI can show "saved"), and a PATCH whose key value is
// still the mask leaves the stored key untouched.
const KEY_FIELDS = ['localApiKey', 'cerebrasApiKey'] as const;
const MASK_PREFIX = '••••';
const maskKey = (value: string) => (value ? `${MASK_PREFIX}${value.slice(-4)}` : '');
function maskSettings(settings: UserSettings): UserSettings {
  const masked = { ...settings };
  for (const field of KEY_FIELDS) masked[field] = maskKey(settings[field]);
  return masked;
}

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

routes.get('/health', async (_req, res, next) => {
  try {
    res.json(await buildStatusPayload());
  } catch (error) {
    next(error);
  }
});

routes.get('/api/status', async (_req, res, next) => {
  try {
    res.json(await buildStatusPayload());
  } catch (error) {
    next(error);
  }
});

routes.get('/api/config', (_req, res) => {
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


routes.get('/api/settings', async (_req, res, next) => {
  try {
    res.json(maskSettings(await loadSettings()));
  } catch (error) {
    next(error);
  }
});

routes.patch('/api/settings', async (req, res, next) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    // A key value that is still the mask means "unchanged" — drop it so the stored key
    // survives round-trips through the settings UI.
    for (const field of KEY_FIELDS) {
      if (typeof patch[field] === 'string' && patch[field]!.startsWith(MASK_PREFIX)) delete patch[field];
    }
    const current = await loadSettings();
    const nextSettings: UserSettings = { ...current, ...patch };
    await saveSettings(nextSettings);
    // Apply the choice + endpoint config immediately so changes take effect without a restart.
    setAgentChoice({ agent: nextSettings.agent, agentModel: nextSettings.agentModel, agentThinking: nextSettings.agentThinking });
    setApiConfig(nextSettings);
    broadcast({ type: 'settings_update', settings: maskSettings(nextSettings) });
    res.json(maskSettings(nextSettings));
  } catch (error) {
    next(error);
  }
});

// The Toji plans, and whether this install has a subscription. Served rather than
// hard-coded in the UI so the price a user is shown and the price the server believes
// in can never drift apart.
routes.get('/api/billing/plans', (_req, res) => {
  res.json({ plans: plans(), subscription: subscriptionStatus() });
});

// Which yagami harnesses are installed, whether the custom endpoint is configured,
// and what Toji will actually run. The UI uses this for the backend picker.
routes.get('/api/agents', (_req, res) => {
  refreshDetection();
  res.json({
    available: agentAvailable(),
    model: liveModelName(),
    ...agentStatus()
  });
});

// Every model every installed harness reports — the settings model picker. Probing
// spawns a short-lived process per harness, so results are cached; ?refresh=1 re-probes.
routes.get('/api/agents/models', async (req, res, next) => {
  try {
    res.json(await modelCatalog(req.query.refresh === '1'));
  } catch (error) {
    next(error);
  }
});

// Models the configured Cerebras key can use, for the settings model picker. The key
// stays server-side; only ids come back.
routes.get('/api/agents/cerebras-models', async (req, res) => {
  const { key, source } = cerebrasCredentials();
  if (!key) return res.json({ models: [], keySource: source, error: 'No Cerebras API key. Set CEREBRAS_API_KEY or paste one in Settings.' });
  try {
    return res.json({ models: await listCerebrasModels(key, req.query.refresh === '1'), keySource: source });
  } catch (error) {
    // A bad key or an empty balance is the user's to fix, so it is reported as data
    // rather than thrown — the picker stays usable and shows why it is empty.
    return res.json({ models: [], keySource: source, error: error instanceof Error ? error.message : String(error) });
  }
});

// Store a file the user dropped onto the agent (e.g. a resume). Written to the data
// dir so the local CLI agent can read it by path, or upload it into a page file-input.
routes.post('/api/files', async (req, res, next) => {
  try {
    const body = z
      .object({ name: z.string().min(1).max(255), mime: z.string().max(200).optional(), dataBase64: z.string().max(40_000_000) })
      .parse(req.body);
    const dir = path.join(config.dataDir, 'uploads');
    await mkdir(dir, { recursive: true });
    const safe = body.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
    const filePath = path.join(dir, `${randomUUID()}-${safe}`);
    await writeFile(filePath, Buffer.from(body.dataBase64, 'base64'));
    res.json({ path: filePath, name: body.name, mime: body.mime ?? '' });
  } catch (error) {
    next(error);
  }
});

// Reference documents kept in memory (e.g. a resume) that the agent can read or
// upload into a page at any time. Persist across sessions.
routes.get('/api/references', async (_req, res, next) => {
  try {
    res.json({ references: await listReferences() });
  } catch (error) {
    next(error);
  }
});
routes.post('/api/references', async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(255), mime: z.string().max(200).optional(), dataBase64: z.string().max(40_000_000) }).parse(req.body);
    res.json(await addReference(body));
  } catch (error) {
    next(error);
  }
});
routes.delete('/api/references/:id', async (req, res, next) => {
  try {
    res.json({ removed: await removeReference(req.params.id) });
  } catch (error) {
    next(error);
  }
});

// Memory: durable facts the agent remembers across sessions (Hermes-style).
routes.get('/api/memory', async (_req, res, next) => {
  try {
    res.json({ facts: await listFacts() });
  } catch (error) {
    next(error);
  }
});
routes.post('/api/memory', async (req, res, next) => {
  try {
    const body = z.object({ text: z.string().min(1).max(2000), tags: z.array(z.string().max(40)).max(20).optional(), sessionId: z.string().max(200).optional() }).parse(req.body);
    res.json(await addFact(body));
  } catch (error) {
    next(error);
  }
});
routes.delete('/api/memory/:id', async (req, res, next) => {
  try {
    res.json({ removed: await removeFact(req.params.id) });
  } catch (error) {
    next(error);
  }
});

// Pinned memory: the always-in-context MEMORY.md / USER.md files (editable in Settings).
routes.get('/api/memory/pinned', async (_req, res, next) => {
  try {
    const { memory, user } = await readPinned();
    res.json({ memory, user, caps: PINNED_CAPS });
  } catch (error) {
    next(error);
  }
});
routes.put('/api/memory/pinned', async (req, res, next) => {
  try {
    const body = z.object({ memory: z.string().max(5000).optional(), user: z.string().max(5000).optional() }).parse(req.body);
    if (body.memory !== undefined) await writePinned('memory', body.memory);
    if (body.user !== undefined) await writePinned('user', body.user);
    const { memory, user } = await readPinned();
    res.json({ memory, user, caps: PINNED_CAPS });
  } catch (error) {
    // writePinned throws a friendly message when over the char cap → surface as a 400.
    if (error instanceof Error && /cap/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

// Bookmarks store. Imports arrive as plain items: the desktop app reads other browsers
// (and exported files) itself, since that is where the vault for their passwords lives.
routes.post('/api/bookmarks', async (req, res, next) => {
  try {
    const body = z
      .object({
        items: z.array(z.object({ title: z.string().max(300), url: z.string().url().max(2048), folder: z.string().max(300).optional() })).max(5000)
      })
      .parse(req.body);
    res.json({ added: await addBookmarks(body.items) });
  } catch (error) {
    next(error);
  }
});
routes.get('/api/bookmarks', async (_req, res, next) => {
  try {
    res.json({ bookmarks: await listBookmarks() });
  } catch (error) {
    next(error);
  }
});
routes.delete('/api/bookmarks/:id', async (req, res, next) => {
  try {
    res.json({ removed: await removeBookmark(req.params.id) });
  } catch (error) {
    next(error);
  }
});

// The "librarian": returns a compact memory digest relevant to a goal, plus the
// always-on pinned memory, so the main agent gets only what it needs (token-cheap).
routes.post('/api/agent/librarian', async (req, res, next) => {
  try {
    const body = z.object({ goal: z.string().max(2000), sessionId: z.string().max(200).optional() }).parse(req.body);
    const [relevant, pinned] = await Promise.all([librarianDigest(body.goal, { sessionId: body.sessionId }), pinnedDigest()]);
    res.json({ digest: relevant.digest, pinned });
  } catch (error) {
    next(error);
  }
});

routes.post('/api/predict', async (req, res, next) => {
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
routes.get('/api/page/stream', expensiveRateLimit, async (req, res) => {
  const query = String(req.query.q ?? '').slice(0, 1200).trim();
  const fresh = req.query.fresh === '1';
  if (!query) {
    res.status(400).type('text/html').end('<!doctype html><title>Toji</title><body></body>');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  // This page may be loaded with ?token= in its URL; it must never hand that URL to the
  // image hosts it pulls from.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data: https://fonts.gstatic.com; base-uri 'none'; form-action 'none'"
  );

  // Serve an identical previously-generated page instantly (unless a reload forces fresh).
  if (!fresh) {
    const cached = await getCachedPage(query);
    if (cached) {
      res.end(cached);
      return;
    }
  }

  const controller = new AbortController();
  // The response's 'close' fires when the client goes away mid-stream, in Node and in
  // Bun alike; it also fires after a normal end, which writableFinished tells apart.
  // (req 'close' means "request body consumed" in modern Node, not "client gone".)
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  // Ground the page in the same web sources shown in the footer.
  const sources = await gatherPageSources(query).catch((error) => {
    console.warn('[toji] gatherPageSources failed for page stream:', error instanceof Error ? error.message : error);
    return [];
  });
  let full = '';
  try {
    for await (const chunk of streamAnswerPage(query, controller.signal, sources)) {
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
    void putCachedPage(query, full);
  }
});

// Web agent: given the byakugan page view (manifest or diff) + a goal, decide the next action.
routes.post('/api/agent/step', expensiveRateLimit, async (req, res, next) => {
  try {
    const body = z
      .object({
        goal: z.string().min(1).max(600),
        url: z.string().max(2000),
        title: z.string().max(400).optional(),
        history: z.array(z.object({ action: z.string(), reason: z.string().optional() })).max(20).optional(),
        // The tab's screenshot — the agent's only view of the page.
        image: z.string().max(12_000_000).optional(),
        image_size: z.object({ w: z.number(), h: z.number() }).optional(),
        credentialAccess: z.boolean().optional(),
        files: z
          .array(z.object({ index: z.number(), name: z.string().max(200), mime: z.string().max(120).optional() }))
          .max(40)
          .optional(),
        memory: z.string().max(4000).optional()
      })
      .parse(req.body);
    res.json(await nextAgentAction(body));
  } catch (error) {
    next(error);
  }
});

// Research sub-agent: the web agent calls this when stuck/unsure how to do something.
routes.post('/api/agent/research', async (req, res, next) => {
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
routes.get('/api/page/sources', async (req, res, next) => {
  try {
    const query = String(req.query.q ?? '').slice(0, 1200).trim();
    if (!query) return res.json({ sources: [] });
    return res.json({ sources: await gatherPageSources(query) });
  } catch (error) {
    return next(error);
  }
});

routes.post('/api/research/start', expensiveRateLimit, async (req, res, next) => {
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

routes.post('/api/research/demo', expensiveRateLimit, async (req, res, next) => {
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

routes.post('/api/research/:id/commit', async (req, res, next) => {
  try {
    const body = z.object({ query: z.string().max(1200).optional() }).parse(req.body ?? {});
    const session = await researchOrchestrator.commit(req.params.id, body.query);
    if (!session) return res.status(404).json({ error: 'session not found' });
    return res.json(session);
  } catch (error) {
    next(error);
  }
});

routes.post('/api/research/:id/cancel', async (req, res, next) => {
  try {
    const session = await researchOrchestrator.cancel(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    return res.json(session);
  } catch (error) {
    next(error);
  }
});

routes.delete('/api/research/:id', async (req, res, next) => {
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

routes.delete('/api/research', async (_req, res, next) => {
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

routes.get('/api/research/:id/export', (req, res) => {
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

routes.get('/api/research/:id/export.md', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.md"`);
  res.type('text/markdown').send(sessionToMarkdown(session));
});

routes.get('/api/research/:id/export.json', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.setHeader('content-disposition', `attachment; filename="toji-${session.id}.json"`);
  res.json(sessionToPortableJson(session));
});

routes.get('/api/research/:id', (req, res) => {
  const session = researchOrchestrator.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  return res.json(session);
});

routes.get('/api/research', (_req, res) => {
  res.json({ sessions: researchOrchestrator.listSessions() });
});

export interface AppOptions {
  /** A built renderer to serve as static files, with an SPA fallback; none when unset. */
  rendererDir?: string;
}

export function createApp(options: AppOptions, security: SecurityOptions) {
  const app = express();
  // First, ahead of CORS preflights and everything else: a request that does not
  // address this server by a loopback name (a DNS-rebinding page) gets nothing.
  app.use(hostGuard(security));
  app.use(corsMiddleware);
  // With a token configured, /health stays open to anything on loopback but says only
  // that the server is up; the full status needs the token, at /api/status.
  if (security.token) {
    app.get('/health', (_req, res) => {
      res.json({ ok: true, app: `${config.appName} agent server` });
    });
  }
  // Checked before bodies are parsed, so an unauthenticated upload is never read.
  app.use(apiAuth(security));
  // Limit is generous because the web agent's vision step posts a JPEG screenshot
  // (a base64 data URI) alongside the page's elements.
  app.use(express.json({ limit: '12mb' }));
  app.use(routes);

  // The packaged desktop app loads the renderer over http:// from this same origin —
  // avoiding file:// CSP/CORS issues and keeping the renderer same-origin with the API.
  const rendererDir = options.rendererDir;
  if (rendererDir && fs.existsSync(path.join(rendererDir, 'index.html'))) {
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
  return app;
}

/** Refuse a WebSocket upgrade with a plain HTTP response instead of a handshake. */
function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  socket.destroy();
}

export interface StartOptions extends AppOptions {
  /** Port on the host; 0 picks a free one. */
  port: number;
  /** Always loopback in production; exposed for completeness, not configuration. */
  host?: string;
  /** TOJI_SERVER_TOKEN: when set, /api/* and the /ws upgrade require it (lib/security.ts). */
  token?: string;
}

export interface RunningServer {
  server: http.Server;
  /** The port actually bound, which differs from the requested one when that was 0. */
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  // The Host guard needs the bound port, which exists only once listen() completes.
  let boundPort = 0;
  const security: SecurityOptions = { token: options.token, port: () => boundPort };
  const server = http.createServer(createApp(options, security));

  // The event stream is wired by hand rather than with ws's { server, path } option:
  // under Bun that route answers a refused handshake with a malformed status line, and
  // taking the upgrade here means every one can be vetted before a handshake starts.
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    addSocket(ws);
    sendToSocket(ws, { type: 'hello', app: config.appName, message: 'Connected to Toji agent stream.' });
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    const refusal = upgradeRefusal(req, security);
    if (refusal) return rejectUpgrade(socket, refusal.status, refusal.reason);
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/ws') return rejectUpgrade(socket, 400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host ?? '127.0.0.1');
  });
  const address = server.address();
  boundPort = typeof address === 'object' && address ? address.port : options.port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      })
  };
}
