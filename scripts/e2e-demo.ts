import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = Number(process.env.TOJI_E2E_PORT ?? 8799);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(tmpdir(), 'toji-e2e-'));
const detached = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(pathName: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathName}`, init);
  if (!response.ok) throw new Error(`${pathName} failed with ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = spawn(process.execPath, [tsxCli, 'apps/agent-server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    TOJI_DATA_DIR: dataDir,
    TOJI_AGENT: 'off',
    DEMO_MODE_ENABLED: 'true'
  },
  detached,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout?.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr?.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

async function stopServer() {
  if (!server.pid) return;
  try {
    if (detached) process.kill(-server.pid, 'SIGTERM');
    else server.kill('SIGTERM');
  } catch {
    // The process may already have exited.
  }
  await sleep(350);
  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in local smoke runs.
  }
}

try {
  let healthy = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetchJson('/health');
      healthy = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!healthy) throw new Error(`Toji server did not become healthy. Output:\n${serverOutput}`);

  const initialSettings = await fetchJson<any>('/api/settings');
  if (typeof initialSettings.maxTabs !== 'number') throw new Error('Settings endpoint did not return maxTabs.');
  const savedSettings = await fetchJson<any>('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultDepth: 'deep', defaultFreshness: 'latest', maxTabs: 2 })
  });
  if (savedSettings.defaultDepth !== 'deep' || savedSettings.defaultFreshness !== 'latest' || savedSettings.maxTabs !== 2) {
    throw new Error('Settings patch did not persist expected values.');
  }

  const prediction = await fetchJson<any>('/api/predict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'compare gemma browser agents' })
  });
  if (!Array.isArray(prediction.suggestions) || prediction.suggestions.length < 3) {
    throw new Error(`Expected autocomplete suggestions, got ${prediction.suggestions?.length ?? 0}.`);
  }
  const firstSuggestion = prediction.suggestions[0];
  if (!firstSuggestion.completion || !firstSuggestion.label || !['complete', 'search', 'navigate'].includes(firstSuggestion.action)) {
    throw new Error(`Autocomplete suggestion contract is invalid: ${JSON.stringify(firstSuggestion)}`);
  }

  const started = await fetchJson<{ id: string; status: string; mode: string }>('/api/research/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Toji visible browser agent demo' })
  });

  let completed: any = started;
  for (let i = 0; i < 30; i += 1) {
    completed = await fetchJson(`/api/research/${started.id}`);
    if (completed.status === 'complete') break;
    await sleep(200);
  }

  if (completed.status !== 'complete') throw new Error(`Demo did not complete: ${completed.status}`);
  if ((completed.tabs?.length ?? 0) < 3 || (completed.sources?.length ?? 0) < 3) {
    throw new Error(`Expected demo tabs and sources, got tabs=${completed.tabs?.length ?? 0}, sources=${completed.sources?.length ?? 0}`);
  }
  if ((completed.prediction?.suggestions?.length ?? 0) < 3) throw new Error('Expected demo session to include autocomplete suggestions.');
  if (!completed.synthesis?.headline) throw new Error('Expected synthesis headline.');

  const deleted = await fetchJson<{ id: string; removed: boolean; fromMemory: boolean; persisted: boolean }>(`/api/research/${completed.id}`, {
    method: 'DELETE'
  });
  if (!deleted.removed) throw new Error('Expected delete endpoint to remove completed session.');
  const remaining = await fetchJson<{ sessions: Array<{ id: string }> }>(`/api/research`);
  if (remaining.sessions.some((session) => session.id === completed.id)) {
    throw new Error(`Deleted session still appears in /api/research: ${completed.id}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        server: baseUrl,
        sessionId: completed.id,
        status: completed.status,
        autocompleteSuggestions: prediction.suggestions.length,
        tabs: completed.tabs.length,
        sources: completed.sources.length,
        headline: completed.synthesis.headline,
        deleted: deleted.removed
      },
      null,
      2
    )
  );
} finally {
  await stopServer();
}
