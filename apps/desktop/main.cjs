const { app, BrowserWindow, Menu, ipcMain, shell, nativeImage, webContents, dialog, session, screen, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const { applySessionPolicy, applyWebRtcPolicy, parsePartition } = require('./policy.cjs');
const { TorController } = require('./tor.cjs');
const { Vault, generatePassword } = require('./vault.cjs');
const { redactManifestValues } = require('./page-redaction.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// electron-chrome-web-store reads app.getName() for its install button label.
// Keep the human-facing product name independent of the internal package id.
app.setName('Toji');

const isDev = Boolean(process.env.ELECTRON_START_URL);
const SERVER_PORT = 8788;
const APP_ICON_PATH = path.join(__dirname, 'build', 'icon.png');
let serverProcess = null;

function appendServerLog(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'agent-server.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never block app startup.
  }
}

// Minimal .env parser (avoids depending on dotenv inside the Electron main process).
function parseEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[match[1]] = value;
    }
  } catch {
    // Missing/unreadable file → nothing to merge.
  }
  return out;
}

// GUI apps don't inherit the shell environment, and .env files aren't on the server's
// cwd when packaged — so load them here (bundled app dir first, then a user-writable
// override in userData) and forward the values (TOJI_AGENT, TOJI_AGENT_CMD, etc.) to the server.
function loadTojiEnv() {
  const candidates = [
    path.join(app.getAppPath(), '.env.local'),
    path.join(app.getAppPath(), '.env'),
    path.join(__dirname, '..', '..', '.env.local'),
    path.join(__dirname, '..', '..', '.env'),
    path.join(app.getPath('userData'), '.env.local'),
    path.join(app.getPath('userData'), '.env')
  ];
  const merged = {};
  for (const file of candidates) Object.assign(merged, parseEnvFile(file)); // later (userData) overrides earlier
  return merged;
}

async function ensureBundledAgentServer() {
  if (isDev || serverProcess) return;
  const serverPath = resolveProductionServerEntry();
  if (!serverPath) throw new Error('Bundled agent server entry point not found.');
  const runtime = resolveNodeRuntime();
  const tojiEnv = loadTojiEnv();
  appendServerLog(`starting ${serverPath} with ${runtime} (agent: ${tojiEnv.TOJI_AGENT_CMD || tojiEnv.TOJI_AGENT || 'claude'})`);

  serverProcess = spawn(runtime, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ...tojiEnv,
      ...(runtime === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      TOJI_DATA_DIR: process.env.TOJI_DATA_DIR ?? tojiEnv.TOJI_DATA_DIR ?? path.join(app.getPath('userData'), 'data')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout?.on('data', (chunk) => {
    const message = chunk.toString().trim();
    console.log(`[agent-server] ${message}`);
    appendServerLog(message);
  });
  serverProcess.stderr?.on('data', (chunk) => {
    const message = chunk.toString().trim();
    console.error(`[agent-server] ${message}`);
    appendServerLog(`stderr ${message}`);
  });
  serverProcess.on('error', (error) => {
    appendServerLog(`spawn error ${error.message}`);
  });
  serverProcess.on('exit', (code, signal) => {
    appendServerLog(`exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    serverProcess = null;
  });

  try {
    await waitForAgentServer(20000);
  } catch (error) {
    // Don't fall back to importing the server into the Electron main process: that
    // ran Express in-process, untracked (so before-quit couldn't kill it) and with
    // the main process's lifecycle. Instead, tear the child down and surface the
    // failure — createWindow() still opens, and the renderer shows a connection
    // error rather than the app silently degrading.
    appendServerLog(`child startup failed: ${error instanceof Error ? error.message : String(error)}`);
    serverProcess?.kill();
    serverProcess = null;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function resolveProductionServerEntry() {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'dist/server/index.js'),
    path.join(process.resourcesPath, 'app', 'dist/server/index.js'),
    path.join(app.getAppPath(), 'dist/server/index.js'),
    path.join(__dirname, '../../dist/server/index.js')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveNodeRuntime() {
  const candidates = [
    process.env.TOJI_NODE_BINARY,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    process.execPath
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? process.execPath;
}

async function waitForAgentServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the bundled server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for local agent server to start');
}

// --- Chrome extensions / Web Store -----------------------------------------
// Toji tabs each render in their own in-memory <webview> partition (toji-ctx-*), so an
// extension loaded into one session doesn't reach the others. We keep all installed
// extensions in one shared on-disk dir and load that dir into EVERY session — the default
// session plus each per-tab partition as it's created — so extensions apply across all tabs
// and persist across restarts. `installChromeWebStore` also wires up the "Add to Chrome"
// button so real Web Store pages can install into whichever session you're browsing in.
let webStore = null;
try {
  webStore = require('electron-chrome-web-store');
} catch (error) {
  appendServerLog(`electron-chrome-web-store unavailable: ${error && error.message}`);
}
function extensionsDir() {
  return process.env.TOJI_EXTENSIONS_DIR || path.join(app.getPath('userData'), 'Extensions');
}
const preparedSessions = new WeakSet();
const partitionSessions = new Set(); // live per-tab sessions, so unpacked loads reach open tabs

async function enableWebStore(sess) {
  if (!webStore || !sess || preparedSessions.has(sess)) return;
  preparedSessions.add(sess);
  try {
    fs.mkdirSync(extensionsDir(), { recursive: true });
    await webStore.installChromeWebStore({
      session: sess,
      extensionsPath: extensionsDir(),
      loadExtensions: true,
      allowUnpackedExtensions: true,
      autoUpdate: true
    });
  } catch (error) {
    appendServerLog(`web store setup failed: ${error && error.message}`);
  }
}

function setupExtensions() {
  // Default session powers the app shell (and any Web Store page opened without a partition).
  if (webStore) void enableWebStore(session.defaultSession);
  app.on('session-created', (sess) => {
    if (sess === session.defaultSession) return;
    partitionSessions.add(sess);
    // Re-apply if we already know this session's partition (see attachContainerPolicy,
    // which is where a container session's policy is normally installed).
    applyContainerPolicy(sess);
    if (webStore) void enableWebStore(sess);
  });
}

// --- Containers --------------------------------------------------------------
// Every tab browses inside a container: a named identity with its own Chromium
// partition, so cookies/storage/cache never cross between them. The container's
// egress (direct or Tor) is encoded in the partition name, which is what lets the
// policy be applied here, atomically, at session-creation time. See policy.cjs.

// The Tor controller. While Tor is not ready the kill switch in policy.cjs refuses all
// traffic from Tor containers — the safe default: they stay offline rather than quietly
// falling back to the direct connection. Constructed lazily because it needs app paths.
let tor = { isReady: () => false, socksPortFor: () => null, status: { ready: false, state: 'off', progress: 0, detail: 'Tor is not running', source: null } };

// Electron gives no public API for a session's own partition name, so remember it
// when we hand one out and read it back here.
const sessionPartitions = new WeakMap();

function applyContainerPolicy(sess, partition) {
  const name = partition || sessionPartitions.get(sess);
  if (!name) return;
  sessionPartitions.set(sess, name);
  const label = applySessionPolicy(sess, name, tor);
  if (label) appendServerLog(`container policy ${label} (${name})`);
}

/**
 * Install container policy on the window that hosts the tabs.
 *
 * 'will-attach-webview' is the earliest point at which the partition name is known,
 * and it fires before the guest webContents exists — so the proxy and kill switch are
 * always in place before the container can issue its first request. Doing this from
 * 'session-created' would be too late and too blind: that event carries no partition.
 */
function attachContainerPolicy(hostContents) {
  hostContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!params || !parsePartition(params.partition)) {
      event.preventDefault();
      appendServerLog('blocked webview without a valid Toji container partition');
      return;
    }
    // The renderer chooses the URL and container, but not the guest's security boundary.
    // Reassert these here so a renderer regression cannot turn page content into Node code.
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.preload = path.join(__dirname, 'guest-preload.cjs');
    applyContainerPolicy(session.fromPartition(params.partition), params.partition);
  });
  hostContents.on('did-attach-webview', (_event, guest) => {
    try {
      applyWebRtcPolicy(guest, sessionPartitions.get(guest.session));
    } catch {
      /* guest may already be gone */
    }
  });
}

// --- Password vault ----------------------------------------------------------
// Secrets live only in the main process. The renderer may list metadata and ask for one
// to be filled, but password data travels main → guest page and is never returned through
// IPC. Model-facing page manifests redact all form values (see page-redaction.cjs).

let vault = null;
function getVault() {
  if (!vault) {
    vault = new Vault({
      file: path.join(app.getPath('userData'), 'vault.bin'),
      safeStorage: require('electron').safeStorage,
      log: appendServerLog
    });
  }
  return vault;
}

/** Wrap a vault call so a failure surfaces as a message instead of an unhandled throw. */
function vaultTry(fn) {
  try {
    return { ok: true, value: fn(getVault()) };
  } catch (error) {
    appendServerLog(`vault error: ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
}

ipcMain.handle('toji:vault-status', () => {
  const v = getVault();
  const available = v.available();
  if (!available) {
    return { available: false, count: 0, error: 'This system offers no OS-backed encryption, so the vault is disabled.' };
  }
  const result = vaultTry((vlt) => vlt.list().length);
  return result.ok ? { available: true, count: result.value } : { available: true, count: 0, error: result.error };
});
ipcMain.handle('toji:vault-list', (_event, containerId) => vaultTry((v) => v.list(containerId)));
ipcMain.handle('toji:vault-matches', (event, webContentsId) => {
  if (!senderOwnsTarget(event, webContentsId)) return { ok: false, error: 'page does not belong to this window' };
  const wc = webContents.fromId(Number(webContentsId));
  return vaultTry((v) => v.matchesFor(wc.getURL(), containerOf(wc)));
});
ipcMain.handle('toji:vault-save', (_event, entry) => vaultTry((v) => v.save(entry)));
ipcMain.handle('toji:vault-delete', (_event, id) => vaultTry((v) => v.remove(id)));

// Passwords Toji generated recently. When one of these is later submitted on a page,
// the user clearly meant to use it — save it straight away instead of prompting.
const GENERATED_TTL_MS = 15 * 60 * 1000;
const recentGenerated = new Map(); // password → generated-at timestamp
function rememberGenerated(password) {
  const now = Date.now();
  for (const [value, at] of recentGenerated) {
    if (now - at > GENERATED_TTL_MS) recentGenerated.delete(value);
  }
  recentGenerated.set(password, now);
  // Bounded: the map only ever holds what the user generated in the last stretch.
  while (recentGenerated.size > 32) recentGenerated.delete(recentGenerated.keys().next().value);
}
function wasGenerated(password) {
  const at = recentGenerated.get(password);
  return typeof at === 'number' && Date.now() - at <= GENERATED_TTL_MS;
}

ipcMain.handle('toji:vault-generate', (_event, length) => {
  const password = generatePassword(Math.min(Math.max(Number(length) || 20, 8), 128));
  rememberGenerated(password);
  return password;
});

/** The container a guest webContents belongs to, derived from its session's partition. */
function containerOf(wc) {
  try {
    const name = sessionPartitions.get(wc.session);
    const policy = name ? parsePartition(name) : null;
    return policy ? policy.id : null;
  } catch {
    return null;
  }
}

// A credential the user just submitted, held in the main process until they decide.
// Keyed by webContents id. The renderer is told only the origin and username.
const pendingCaptures = new Map();

ipcMain.handle('toji:vault-captured', (event, { username, password }) => {
  const wc = event.sender;
  const url = wc.getURL();
  const containerId = containerOf(wc);
  const result = vaultTry((v) => v.captureStatus({ origin: url, username, password, containerId }));
  if (!result.ok || result.value === 'ignore' || result.value === 'same') return false;

  const owner = windowForContents(wc);
  const notify = (status) => {
    if (owner && !owner.isDestroyed()) {
      owner.webContents.send('toji:vault-prompt', {
        webContentsId: wc.id,
        origin: require('./vault.cjs').originOf(url),
        username: username || '',
        containerId,
        status
      });
    }
  };

  // A password Toji itself generated needs no confirmation — the user asked for it
  // moments ago and just used it. Save immediately and tell the renderer it's done.
  if (wasGenerated(password)) {
    const saved = vaultTry((v) => v.save({ origin: url, username, password, containerId }));
    if (saved.ok) {
      notify('saved');
      return true;
    }
  }

  pendingCaptures.set(wc.id, { url, username, password, containerId });
  wc.once('destroyed', () => pendingCaptures.delete(wc.id));
  notify(result.value);
  return true;
});

// Commit a held credential. The secret never left the main process.
ipcMain.handle('toji:vault-commit', (event, webContentsId) => {
  if (!senderOwnsTarget(event, webContentsId)) return { ok: false, error: 'page does not belong to this window' };
  const pending = pendingCaptures.get(webContentsId);
  if (!pending) return { ok: false, error: 'nothing to save' };
  pendingCaptures.delete(webContentsId);
  return vaultTry((v) =>
    v.save({ origin: pending.url, username: pending.username, password: pending.password, containerId: pending.containerId })
  );
});
ipcMain.handle('toji:vault-dismiss', (event, webContentsId) => senderOwnsTarget(event, webContentsId) && pendingCaptures.delete(webContentsId));

// Fill a credential into a guest page. The origin is re-checked here against the page's
// CURRENT url, so a navigation between the user's click and this call cannot steer a
// password to a different site.
ipcMain.handle('toji:vault-fill', (event, { webContentsId, entryId }) => {
  if (!senderOwnsTarget(event, webContentsId)) return false;
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return false;
  const result = vaultTry((v) => v.secretFor(entryId, wc.getURL(), containerOf(wc)));
  if (!result.ok || !result.value) return false;
  wc.send('toji-vault:fill', result.value);
  return true;
});

// --- Tor ---------------------------------------------------------------------

function broadcastTorStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('toji:tor-status', status);
  }
}

function setupTor() {
  tor = new TorController({
    dataDir: path.join(app.getPath('userData'), 'tor'),
    resourcesPath: process.resourcesPath,
    log: appendServerLog
  });
  tor.onStatus((status) => {
    broadcastTorStatus(status);
    // Sessions created while Tor was down have no proxy set and are being held offline
    // by the kill switch. Now that the port exists, push the proxy onto them — otherwise
    // a container that was opened during bootstrap would stay dark until it was reloaded.
    if (status.ready) reapplyTorPolicies();
  });
}

/** Re-run the egress policy for every live Tor container session. */
function reapplyTorPolicies() {
  for (const sess of partitionSessions) {
    const name = sessionPartitions.get(sess);
    const policy = name ? parsePartition(name) : null;
    if (policy && policy.egress === 'tor') applySessionPolicy(sess, name, tor);
  }
}

ipcMain.handle('toji:tor-status', () => tor.status);
ipcMain.handle('toji:tor-start', async () => {
  await tor.start();
  return tor.status;
});
ipcMain.handle('toji:tor-stop', () => {
  tor.stop();
  return tor.status;
});
ipcMain.handle('toji:tor-new-circuit', async () => {
  const ok = await tor.newCircuit();
  // New circuits mean new exits; drop cached connections so pages actually use them.
  if (ok) {
    for (const sess of partitionSessions) {
      const name = sessionPartitions.get(sess);
      const policy = name ? parsePartition(name) : null;
      if (policy && policy.egress === 'tor') sess.closeAllConnections().catch(() => {});
    }
  }
  return ok;
});

// Wipe everything a container has stored. The renderer simultaneously bumps the
// container's epoch, so live tabs land on a fresh partition rather than this one.
ipcMain.handle('toji:clear-container', async (_event, containerId) => {
  let cleared = 0;
  for (const sess of partitionSessions) {
    const name = sessionPartitions.get(sess);
    const policy = name ? parsePartition(name) : null;
    if (!policy || policy.id !== containerId) continue;
    try {
      await sess.clearStorageData();
      await sess.clearCache();
      await sess.clearAuthCache();
      cleared += 1;
    } catch (error) {
      appendServerLog(`clear-container ${containerId} failed: ${error && error.message}`);
    }
  }
  appendServerLog(`cleared container ${containerId} (${cleared} session(s))`);
  return true;
});

// The data dir the bundled server actually uses (see ensureBundledAgentServer): honors an
// explicit env override, then a value set in .env/.env.local, then the userData default.
function resolveDataDir() {
  return process.env.TOJI_DATA_DIR ?? loadTojiEnv().TOJI_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
}

const appWindows = new Set();

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() || [...appWindows].find((win) => !win.isDestroyed()) || null;
}

function windowForContents(contents) {
  if (!contents) return focusedWindow();
  return exactWindowForContents(contents) || focusedWindow();
}

function exactWindowForContents(contents) {
  if (!contents) return null;
  return BrowserWindow.fromWebContents(contents.hostWebContents || contents);
}

/** Prevent one profile window from inspecting, driving, or filling another one's tab. */
function senderOwnsTarget(event, webContentsId) {
  const id = Number(webContentsId);
  if (!Number.isInteger(id)) return false;
  let target = null;
  try {
    target = webContents.fromId(id);
  } catch {
    return false; // fail closed on a malformed id instead of rejecting the whole IPC call
  }
  const senderWindow = exactWindowForContents(event && event.sender);
  const targetWindow = exactWindowForContents(target);
  return Boolean(target && !target.isDestroyed() && senderWindow && targetWindow && senderWindow.id === targetWindow.id);
}

// Open an http(s) link inside Toji (as a new web tab) instead of an external browser.
function openInToji(url, targetWindow = focusedWindow()) {
  const win = targetWindow;
  if (win && !win.isDestroyed()) win.webContents.send('toji:open-url', url);
}

// The renderer reveals its window-drag notch when the pointer nears the top of the
// window. It cannot learn that from DOM events: the top chrome is largely a native
// drag region (-webkit-app-region: drag), and macOS delivers no mouse events over
// those. So while a window is focused, its cursor position is polled here and
// streamed to the renderer as window-relative coordinates.
const CURSOR_POLL_MS = 80;
// While the window is being moved or resized, the cursor and the window's bounds are
// changing together but are sampled independently, so the window-relative position
// this computes swings wildly for a frame or two and the notch flickers in and out.
// Reports are frozen for the move and resume once the window has been still this long.
const CHROME_SETTLE_MS = 220;

function attachCursorTracker(win) {
  let timer = null;
  let last = null;
  let settling = null;
  const send = (cursor) => {
    if (win.isDestroyed()) return;
    if (last && last.x === cursor.x && last.y === cursor.y && last.inside === cursor.inside) return;
    last = cursor;
    win.webContents.send('toji:window-cursor', cursor);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    if (win.isDestroyed()) return stop();
    if (settling !== null) return; // mid-move: whatever the renderer last heard is still the truth
    const point = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    send({ x, y, width: bounds.width, height: bounds.height, inside: x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height });
  };
  const start = () => {
    if (timer === null) timer = setInterval(tick, CURSOR_POLL_MS);
  };
  const settle = () => {
    if (settling !== null) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = null;
      tick();
    }, CHROME_SETTLE_MS);
  };
  win.on('focus', start);
  win.on('blur', () => {
    stop();
    send({ x: -1, y: -1, width: 0, height: 0, inside: false });
  });
  win.on('move', settle);
  win.on('resize', settle);
  win.on('closed', () => {
    stop();
    if (settling !== null) clearTimeout(settling);
  });
  if (win.isFocused()) start();
}

// The drag notch moves the window from here instead of through a native
// -webkit-app-region: drag rect. Native regions swallow every mouse event over them,
// which cost the notch its grab cursor and its double-click, and left its reveal to
// race the window's own movement; following the cursor from the main process keeps
// all three, and works the same on Linux (where drag regions only apply to frameless
// windows) as on macOS.
const DRAG_FOLLOW_MS = 8;
// A drag ends on mouse-up in the renderer. If that message never arrives — a crashed
// or reloaded renderer — the window would follow the cursor forever, so every drag
// also expires on its own.
const DRAG_MAX_MS = 30_000;
const windowDrags = new WeakMap();

function stopWindowDrag(win) {
  const drag = windowDrags.get(win);
  if (!drag) return;
  clearInterval(drag.timer);
  clearTimeout(drag.expiry);
  windowDrags.delete(win);
}

function startWindowDrag(win) {
  stopWindowDrag(win);
  if (win.isFullScreen()) return; // a full-screen window has nowhere to go
  if (win.isMaximized()) win.unmaximize();
  const origin = screen.getCursorScreenPoint();
  const start = win.getBounds();
  const timer = setInterval(() => {
    if (win.isDestroyed()) return stopWindowDrag(win);
    const point = screen.getCursorScreenPoint();
    const x = start.x + point.x - origin.x;
    const y = start.y + point.y - origin.y;
    const now = win.getBounds();
    if (now.x === x && now.y === y) return;
    win.setBounds({ x, y, width: start.width, height: start.height });
  }, DRAG_FOLLOW_MS);
  windowDrags.set(win, { timer, expiry: setTimeout(() => stopWindowDrag(win), DRAG_MAX_MS) });
}

/**
 * What double-clicking the window's title area does. On macOS that is whatever the
 * user set under Appearance ("Zoom", "Minimize", "Do Nothing"); everywhere else it
 * is the usual maximize/restore toggle.
 */
function titleBarDoubleClick(win) {
  if (process.platform === 'darwin') {
    let action = 'Maximize';
    try {
      action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') || 'Maximize';
    } catch {
      // No preference set (or unreadable): fall through to the system default, zoom.
    }
    if (action === 'Minimize') return win.minimize();
    if (action === 'None') return;
  }
  if (win.isFullScreen()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}

ipcMain.on('toji:window-drag-start', (event) => {
  const win = windowForContents(event.sender);
  if (win) startWindowDrag(win);
});
ipcMain.on('toji:window-drag-end', (event) => {
  const win = windowForContents(event.sender);
  if (win) stopWindowDrag(win);
});
ipcMain.on('toji:window-title-action', (event) => {
  const win = windowForContents(event.sender);
  if (win) {
    stopWindowDrag(win);
    titleBarDoubleClick(win);
  }
});

function createWindow(containerId = null) {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    title: 'Toji',
    backgroundColor: '#08090f',
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Vertically centered with the renderer's first toolbar row (36px tall, starting 10px
    // from the top → row center 28px; the lights are ~12px, so y = 28 - 6).
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 22 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  });
  appWindows.add(win);
  win.on('closed', () => {
    appWindows.delete(win);
    stopWindowDrag(win);
  });
  // Only macOS hides the title bar, so only macOS renders the drag notch the cursor
  // stream exists to reveal. Elsewhere the poll would run for nobody.
  if (process.platform === 'darwin') attachCursorTracker(win);
  attachContainerPolicy(win.webContents);

  // In production the bundled agent server serves the renderer over http:// so it
  // loads correctly (no file:// CSP/CORS issues) and is same-origin with the API.
  const startUrl = new URL(isDev ? process.env.ELECTRON_START_URL : `http://127.0.0.1:${SERVER_PORT}/`);
  if (containerId) startUrl.searchParams.set('container', containerId);

  // Keep the top-level app frame pinned to the renderer; never let it navigate away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== startUrl.toString()) event.preventDefault();
  });

  win.loadURL(startUrl.toString()).catch((err) => appendServerLog(`loadURL failed: ${err && err.message}`));
  return win;
}

// Detecting a tap of the Option/Alt key. A <webview> is a separate web-contents and
// swallows its own key events (they never reach the renderer window), so we watch every
// web-contents from the main process instead — this is why the agent bar toggle works even
// while a page is focused or the agent is running. "Tap" = press + release with no other key
// in between and within 400ms, so Option-as-a-modifier (typing accents, shortcuts) still works.
function watchOptionTap(contents) {
  let altDown = false;
  let altUsed = false;
  let altDownAt = 0;
  contents.on('before-input-event', (_e, input) => {
    const isAlt = input.code === 'AltLeft' || input.code === 'AltRight';
    if (input.type === 'keyDown' || input.type === 'rawKeyDown') {
      if (isAlt) {
        if (!altDown) {
          altDown = true;
          altUsed = false;
          altDownAt = Date.now();
        }
      } else if (altDown) {
        altUsed = true; // Option was used as a modifier, not a standalone tap.
      }
    } else if (input.type === 'keyUp' && isAlt) {
      const tapped = altDown && !altUsed && Date.now() - altDownAt < 400;
      altDown = false;
      const win = windowForContents(contents);
      if (tapped && win && !win.isDestroyed()) {
        win.webContents.send('toji:toggle-agent');
      }
    }
  });
}

// Any popup / target=_blank from the app shell, the AI page iframe, or a <webview>
// opens inside Toji as a new web tab (http/https); other schemes go to the OS.
app.on('web-contents-created', (_event, contents) => {
  watchOptionTap(contents);
  // Container tabs intentionally share a session partition. Drop it only after the last
  // webContents using that exact session is gone; deleting it when any one tab closed made
  // surviving tabs miss later Tor proxy/circuit updates.
  let contentsSession = null;
  try {
    contentsSession = contents.session;
  } catch {
    /* unavailable during very early creation */
  }
  contents.on('destroyed', () => {
    try {
      if (
        contentsSession &&
        contentsSession !== session.defaultSession &&
        !webContents.getAllWebContents().some((other) => !other.isDestroyed() && other.session === contentsSession)
      ) {
        partitionSessions.delete(contentsSession);
      }
    } catch {
      /* session already gone */
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'http:' || scheme === 'https:') {
        openInToji(url, windowForContents(contents));
        return { action: 'deny' };
      }
      if (scheme === 'mailto:') void shell.openExternal(url);
    } catch {
      // Ignore malformed URLs rather than handing them to the OS.
    }
    return { action: 'deny' };
  });
});

// Closing the final tab closes only its window; other profile windows keep running.
ipcMain.on('toji:close-window', (event) => windowForContents(event.sender)?.close());

// Register Toji as the OS handler for http/https (the macOS "default browser").
ipcMain.handle('toji:set-default-browser', () => {
  try {
    return app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  } catch {
    return false;
  }
});
ipcMain.handle('toji:is-default-browser', () => {
  try {
    return app.isDefaultProtocolClient('http');
  } catch {
    return false;
  }
});
// Load an unpacked Chrome extension folder into the default session AND every open per-tab
// session, so it takes effect on the pages you're browsing right away (Web Store installs
// go through electron-chrome-web-store instead — see setupExtensions).
ipcMain.handle('toji:add-extension', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select an unpacked extension folder' });
    if (canceled || !filePaths || !filePaths[0]) return null;
    const ext = await session.defaultSession.loadExtension(filePaths[0], { allowFileAccess: true });
    for (const sess of partitionSessions) {
      try {
        await sess.loadExtension(filePaths[0], { allowFileAccess: true });
      } catch {
        /* a session may have gone away; ignore */
      }
    }
    return { id: ext.id, name: ext.name };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
});
ipcMain.handle('toji:list-extensions', () => {
  try {
    return session.defaultSession.getAllExtensions().map((e) => ({ id: e.id, name: e.name }));
  } catch {
    return [];
  }
});
// Whether real Chrome Web Store installs are wired up (the package loaded successfully).
ipcMain.handle('toji:web-store-available', () => Boolean(webStore));

// A sandboxed preload cannot import node:path/node:url. Resolve the guest preload here,
// where Node APIs belong, and return only the file URL needed by the renderer.
ipcMain.on('toji:guest-preload-url', (event) => {
  event.returnValue = pathToFileURL(path.join(__dirname, 'guest-preload.cjs')).toString();
});

// --- Byakugan page perception ------------------------------------------------
// @justin06lee/byakugan reads what Chromium actually PAINTED (DOMSnapshot layout tree over
// CDP) into a compact, stable-ID text manifest, emits tiny diffs between steps, and verifies
// actions against fresh geometry at dispatch time. The package is ESM-only and this file is
// CJS, so it's loaded via dynamic import().
//
// The web agent is now SCREENSHOT-ONLY (see toji:page-screenshot): it has no manifest and no
// element ids, so of the handlers below only eyes-act is on the agent's path, and only for
// its targetless verbs (press/scroll). observe/diff/look are kept — working and reachable —
// because they are the whole DOM-perception capability, and dropping them would make going
// back to (or blending in) manifest perception a rewrite rather than a switch.
let byakuganPromise = null;
function loadByakugan() {
  if (!byakuganPromise) {
    byakuganPromise = Promise.all([import('@justin06lee/byakugan'), import('@justin06lee/byakugan/transports')]).then(
      ([core, transports]) => ({ Byakugan: core.Byakugan, fromElectronDebugger: transports.fromElectronDebugger })
    );
    byakuganPromise.catch((error) => {
      appendServerLog(`byakugan unavailable: ${error && error.message}`);
      byakuganPromise = null;
    });
  }
  return byakuganPromise;
}

// Attach the Chrome DevTools Protocol to a guest webContents (idempotent). We keep it
// attached for the life of the page — the agent perceives every step, so repeated
// attach/detach would add latency and flakiness. Detached when the webContents dies.
function ensureDebugger(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    dbg.attach('1.3');
    wc.once('destroyed', () => {
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        /* already gone */
      }
    });
  }
  return dbg;
}

// One stateful Byakugan instance per guest webContents (it owns the stable-ID map and the
// last manifest, which is what makes diff() small). Dropped when the webContents dies.
const eyesByWc = new Map(); // webContentsId → Promise<Byakugan>
function eyesFor(webContentsId) {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return Promise.reject(new Error('page is gone'));
  let entry = eyesByWc.get(webContentsId);
  if (!entry) {
    entry = loadByakugan().then(({ Byakugan, fromElectronDebugger }) => {
      ensureDebugger(wc); // attach first so byakugan's transport shares (and never detaches) it
      return Byakugan.attach(fromElectronDebugger(wc));
    });
    eyesByWc.set(webContentsId, entry);
    entry.catch(() => eyesByWc.delete(webContentsId));
    wc.once('destroyed', () => eyesByWc.delete(webContentsId));
  }
  return entry;
}

// The renderer only needs each element's id + bounds (to aim the animated cursor); the
// model-facing content travels as manifest/diff TEXT.
const pickElements = (manifest) => manifest.elements.map((e) => ({ id: e.id, role: e.role, label: e.label, bounds: e.bounds }));

ipcMain.handle('toji:eyes-observe', async (event, { webContentsId, maxTokens }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) throw new Error('page does not belong to this window');
    const eyes = await eyesFor(webContentsId);
    const m = await eyes.observe(maxTokens ? { maxTokens } : undefined);
    return { ok: true, text: redactManifestValues(m.text), tokens: m.meta.tokens, meta: m.meta, elements: pickElements(m) };
  } catch (error) {
    appendServerLog(`eyes-observe error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

ipcMain.handle('toji:eyes-diff', async (event, { webContentsId, maxTokens }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) throw new Error('page does not belong to this window');
    const eyes = await eyesFor(webContentsId);
    const d = await eyes.diff(maxTokens ? { maxTokens } : undefined);
    return { ok: true, text: redactManifestValues(d.text), tokens: d.tokens, full: d.full, navigated: d.navigated, meta: d.manifest.meta, elements: pickElements(d.manifest) };
  } catch (error) {
    appendServerLog(`eyes-diff error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// Verified input dispatch on manifest IDs. A blocked/failed action comes back as
// {ok:false, error, blockedBy} — the renderer feeds that to the model as an observation.
ipcMain.handle('toji:eyes-act', async (event, { webContentsId, action }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) throw new Error('page does not belong to this window');
    const eyes = await eyesFor(webContentsId);
    const a = action || {};
    switch (a.verb) {
      case 'click':
        return await eyes.act.click(Number(a.id));
      case 'type':
        return await eyes.act.type(Number(a.id), String(a.text ?? ''));
      case 'press':
        return await eyes.act.press(String(a.key ?? 'Enter'));
      case 'select':
        return await eyes.act.select(Number(a.id), String(a.value ?? ''));
      case 'hover':
        return await eyes.act.hover(Number(a.id));
      case 'scroll':
        return await eyes.act.scroll(a.direction === 'up' ? 'up' : 'down');
      case 'navigate':
        return await eyes.act.navigate(String(a.url ?? ''));
      default:
        return { ok: false, error: `unknown action verb: ${a.verb}` };
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// The screenshot-driven agent's single sense: what the tab looks like right now.
//
// Deliberately independent of byakugan — no DOM snapshot, no manifest, no stable ids.
// It captures over CDP rather than webContents.capturePage() so a BACKGROUND tab (the
// agent often runs on one) still yields real pixels instead of a blank frame.
//
// The shot is in DEVICE pixels (2x on a retina display) and then downscaled for token
// cost, so it reports the page's CSS viewport separately: the model answers in image
// pixels and the caller scales those back to CSS px to aim the mouse.
ipcMain.handle('toji:page-screenshot', async (event, { webContentsId, maxLongEdge }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) throw new Error('page does not belong to this window');
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('page is gone');
    const dbg = ensureDebugger(wc);
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    // cssVisualViewport is the CSS-pixel viewport; older builds only expose visualViewport.
    const vp = metrics.cssVisualViewport || metrics.visualViewport || {};
    const viewport = {
      w: Math.round(vp.clientWidth || metrics.cssLayoutViewport?.clientWidth || 0),
      h: Math.round(vp.clientHeight || metrics.cssLayoutViewport?.clientHeight || 0)
    };
    const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    let image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    const size = image.getSize();
    const longEdge = Math.max(size.width, size.height);
    const limit = maxLongEdge || 1400;
    if (longEdge > limit) {
      const scale = limit / longEdge;
      image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' });
    }
    const out = image.getSize();
    return { ok: true, dataUri: image.toDataURL(), width: out.width, height: out.height, viewport };
  } catch (error) {
    appendServerLog(`page-screenshot error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// Cropped, downscaled screenshot of one element (by manifest id) or a viewport region —
// the agent's escalation sense for canvas / images / text-blind iframes.
ipcMain.handle('toji:eyes-look', async (event, { webContentsId, id, rect, maxLongEdge }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) throw new Error('page does not belong to this window');
    const eyes = await eyesFor(webContentsId);
    let target = typeof id === 'number' ? id : rect;
    if (!target && target !== 0) {
      // No target → the whole visible viewport.
      const meta = eyes.lastManifest ? eyes.lastManifest.meta : (await eyes.observe()).meta;
      target = { x: 0, y: 0, w: meta.viewport.width, h: meta.viewport.height };
    }
    // Where the crop sits in viewport coords, so the model can convert screenshot pixels
    // back to clickAt/drag coordinates.
    const crop = typeof target === 'number' ? eyes.resolve(target).bounds : target;
    const shot = await eyes.look(target, maxLongEdge ? { maxLongEdge } : undefined);
    return { ok: true, dataUri: `data:image/png;base64,${Buffer.from(shot.data).toString('base64')}`, width: shot.width, height: shot.height, tokens: shot.tokens, crop };
  } catch (error) {
    appendServerLog(`eyes-look error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// Set a local file onto a <input type=file> inside a guest <webview>. The renderer
// can't do this (security), so we drive it via the Chrome DevTools Protocol on the
// guest's webContents. Best-effort: targets the Nth file input on the page.
ipcMain.handle('toji:upload-file-input', async (event, { webContentsId, filePath, inputIndex, elementId }) => {
  try {
    if (!senderOwnsTarget(event, webContentsId)) return false;
    const wc = webContents.fromId(webContentsId);
    if (!wc) return false;
    // Only allow files the app itself produced (uploads/references under the data dir). Without
    // this a compromised renderer could attach an arbitrary local file (e.g. ~/.ssh/id_rsa) to a
    // file input on an attacker page and exfiltrate it via DOM.setFileInputFiles.
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
    const resolved = path.resolve(filePath);
    const dataDir = resolveDataDir();
    const allowed = [path.join(dataDir, 'uploads'), path.join(dataDir, 'references')];
    if (!allowed.some((d) => resolved === d || resolved.startsWith(d + path.sep))) return false;
    try {
      if (!fs.statSync(resolved).isFile()) return false;
    } catch {
      return false;
    }
    const dbg = ensureDebugger(wc);
    await dbg.sendCommand('DOM.enable');
    // Preferred path: the agent names the exact file-input by its byakugan manifest id.
    if (typeof elementId === 'number') {
      try {
        const eyes = await eyesFor(webContentsId);
        const rec = eyes.resolve(elementId);
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [resolved], backendNodeId: rec.backendNodeId });
        return true;
      } catch {
        /* fall back to the Nth file input below */
      }
    }
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeIds || !nodeIds.length) return false;
    const idx = Math.min(Math.max(0, Number(inputIndex) || 0), nodeIds.length - 1);
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [resolved], nodeId: nodeIds[idx] });
    return true;
  } catch (error) {
    appendServerLog(`upload-file-input error ${error && error.message}`);
    return false;
  }
});

// Install an app menu so Cmd+W closes the active TAB (not the window). Window-close
// moves to Cmd+Shift+W. Standard roles keep copy/paste/quit/devtools intact.
function buildAppMenu() {
  const isMacOS = process.platform === 'darwin';
  const send = (channel) => {
    const win = focusedWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };
  const template = [
    ...(isMacOS ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow('private') },
        { type: 'separator' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('toji:new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('toji:close-tab') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMacOS ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMacOS ? [{ role: 'front' }] : [])] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON_PATH)) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
    } catch {
      // Dock icon is cosmetic; never block startup on it.
    }
  }
  buildAppMenu();
  setupTor();
  setupExtensions();
  try {
    await ensureBundledAgentServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendServerLog(`agent server failed to start: ${message}`);
    console.error(`[agent-server] failed to start: ${message}`);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverProcess?.kill();
  serverProcess = null;
  try {
    tor.stop();
  } catch {
    /* already down */
  }
});
