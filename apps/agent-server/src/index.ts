import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ensureDataDirs, loadSettings } from './lib/storage.js';
import { researchOrchestrator } from './agents/researchAgent.js';
import { agentAvailable, liveModelName } from './agents/model.js';
import { refreshDetection, setAgentChoice, setApiConfig } from './agents/agentRuntime.js';
import { warmCatalog } from './agents/yagamiCatalog.js';
import { startServer } from './server.js';

// The agent server's entry point, for every way it runs: from source (tsx), as the
// esbuild bundle the Electron app spawns, and as the compiled sidecar the Gecko browser
// spawns. The routes live in server.ts.
//
// What the spawning process can rely on:
//   stdout             exactly one line once listening: TOJI_SERVER_READY {"port":<n>}
//                      (human-readable status goes to stderr)
//   PORT               the port on 127.0.0.1; 0, or unset in the compiled binary, picks a free one
//   TOJI_DATA_DIR      where state lives; required by the compiled binary
//   TOJI_PARENT_PID    exit once this process is gone (polled every 2 s)
//   TOJI_RENDERER_DIR  a built renderer to serve as static files (optional)
//   TOJI_ENV_FILE      a .env file to load instead of ./.env.local and ./.env (optional)

// Fail loudly if the port is taken. Otherwise Toji silently never binds and the
// renderer (dev + packaged) ends up talking to whatever else is on this port —
// e.g. a stale dev server from another project — which is impossible to diagnose.
function isAddrInUse(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
function reportPortConflict(): never {
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
process.on('uncaughtException', (err) => {
  if (isAddrInUse(err)) reportPortConflict();
  console.error('[toji] uncaughtException:', err);
  process.exit(1);
});

/**
 * Exit once the process that spawned this server is gone, so a browser that crashed or
 * was force-quit never leaves an orphaned sidecar behind. Signal 0 only checks that
 * the pid exists; EPERM means it does but belongs to someone else, which still counts.
 */
function watchParent(pid: number) {
  const check = () => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      console.error(`[toji] parent process ${pid} is gone; exiting.`);
      process.exit(0);
    }
  };
  check();
  setInterval(check, 2_000).unref();
}

/**
 * The renderer to serve, if any. TOJI_RENDERER_DIR wins; the compiled sidecar serves
 * nothing without it; run from source or as the Electron bundle, the server keeps
 * serving the dist/renderer next to dist/server, which is how the packaged desktop app
 * loads its UI over http:// from the same origin as the API.
 */
function rendererDir(): string | undefined {
  if (config.rendererDir) return config.rendererDir;
  if (config.isCompiled) return undefined;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../renderer');
}

if (config.parentPid) watchParent(config.parentPid);

await ensureDataDirs();
await researchOrchestrator.hydrate();

// Seed the effective agent from persisted settings (falls back to env-derived
// defaults on first run), and detect installed yagami harnesses once at boot.
refreshDetection();
try {
  const settings = await loadSettings();
  setAgentChoice({ agent: settings.agent, agentModel: settings.agentModel, agentThinking: settings.agentThinking });
  setApiConfig(settings);
} catch (error) {
  // Defaults (env-seeded) apply if settings can't be read.
  console.warn('[toji] Failed to load settings at boot, using env defaults:', error instanceof Error ? error.message : error);
}
// Probe the harnesses for their models in the background: a saved bare model id can
// only be routed to its owning provider once the catalog knows who owns it.
warmCatalog();

const running = await startServer({ port: config.port, rendererDir: rendererDir() }).catch((error: unknown) => {
  if (isAddrInUse(error)) reportPortConflict();
  throw error;
});
// A later server error (after listening) is as fatal as it always was.
running.server.on('error', (err: NodeJS.ErrnoException) => {
  console.error('[toji] server error:', err);
  process.exit(1);
});

// The handshake: the only thing this process writes to stdout.
process.stdout.write(`TOJI_SERVER_READY ${JSON.stringify({ port: running.port })}\n`);
console.error(`[toji] agent server running at http://127.0.0.1:${running.port}`);
console.error(`[toji] inference mode: ${agentAvailable() ? liveModelName() : 'demo fallback (no agent)'}`);
