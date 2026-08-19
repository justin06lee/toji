const { app, BrowserWindow, Menu, ipcMain, shell, nativeImage, webContents, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const { applySessionPolicy, applyWebRtcPolicy, parsePartition } = require('./policy.cjs');
const fs = require('node:fs');
const path = require('node:path');

const isDev = Boolean(process.env.ELECTRON_START_URL);
const SERVER_PORT = 8787;
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

// The Tor controller. Until Tor is wired up this reports "not ready", which makes the
// kill switch in policy.cjs refuse all traffic from Tor containers — the safe default:
// they stay offline rather than quietly falling back to the direct connection.
const tor = { isReady: () => false, socksPortFor: () => null };

// The renderer's container table, for labelling and Tor circuit assignment only —
// never for deciding egress (that comes from the partition name).
let containerTable = [];
ipcMain.on('toji:set-containers', (_event, containers) => {
  if (Array.isArray(containers)) containerTable = containers;
});

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
  hostContents.on('will-attach-webview', (_event, _webPreferences, params) => {
    if (!params || !params.partition) return;
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

let mainWindow = null;

// Open an http(s) link inside Toji (as a new web tab) instead of an external browser.
function openInToji(url) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toji:open-url', url);
}

function createWindow() {
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
  mainWindow = win;
  attachContainerPolicy(win.webContents);

  // In production the bundled agent server serves the renderer over http:// so it
  // loads correctly (no file:// CSP/CORS issues) and is same-origin with the API.
  const startUrl = isDev ? process.env.ELECTRON_START_URL : `http://127.0.0.1:${SERVER_PORT}/`;

  // Keep the top-level app frame pinned to the renderer; never let it navigate away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== startUrl) event.preventDefault();
  });

  win.loadURL(startUrl).catch((err) => appendServerLog(`loadURL failed: ${err && err.message}`));
}

// Detecting a tap of the Option/Alt key. A <webview> is a separate web-contents and
// swallows its own key events (they never reach the renderer window), so we watch every
// web-contents from the main process instead — this is why the agent bar toggle works even
// while a page is focused or the agent is running. "Tap" = press + release with no other key
// in between and within 400ms, so Option-as-a-modifier (typing accents, shortcuts) still works.
let altDown = false;
let altUsed = false;
let altDownAt = 0;
function watchOptionTap(contents) {
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
      if (tapped && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toji:toggle-agent');
      }
    }
  });
}

// Any popup / target=_blank from the app shell, the AI page iframe, or a <webview>
// opens inside Toji as a new web tab (http/https); other schemes go to the OS.
app.on('web-contents-created', (_event, contents) => {
  watchOptionTap(contents);
  // Drop the per-tab session from partitionSessions when its webContents is torn down.
  // Toji tabs are 1:1 partition-per-webview (popups are denied and reopened as new tabs
  // with their own partitions), so a destroyed webContents' session has no other live users.
  contents.on('destroyed', () => {
    try {
      if (contents.session && contents.session !== session.defaultSession) partitionSessions.delete(contents.session);
    } catch {
      /* session already gone */
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'http:' || scheme === 'https:') {
        openInToji(url);
        return { action: 'deny' };
      }
      shell.openExternal(url);
    } catch {
      // Ignore malformed URLs rather than handing them to the OS.
    }
    return { action: 'deny' };
  });
});

// The renderer asks to quit when the last tab is closed.
ipcMain.on('toji:quit', () => app.quit());

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

// --- Byakugan page perception ------------------------------------------------
// The web agent's eyes: @justin06lee/byakugan reads what Chromium actually PAINTED
// (DOMSnapshot layout tree over CDP) into a compact, stable-ID text manifest, emits tiny
// diffs between steps, verifies every click/type against fresh geometry at dispatch time
// (blocked actions return {ok:false, blockedBy}), and serves cropped screenshots via look().
// The package is ESM-only and this file is CJS, so it's loaded via dynamic import().
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

ipcMain.handle('toji:eyes-observe', async (_event, { webContentsId, maxTokens }) => {
  try {
    const eyes = await eyesFor(webContentsId);
    const m = await eyes.observe(maxTokens ? { maxTokens } : undefined);
    return { ok: true, text: m.text, tokens: m.meta.tokens, meta: m.meta, elements: pickElements(m) };
  } catch (error) {
    appendServerLog(`eyes-observe error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

ipcMain.handle('toji:eyes-diff', async (_event, { webContentsId, maxTokens }) => {
  try {
    const eyes = await eyesFor(webContentsId);
    const d = await eyes.diff(maxTokens ? { maxTokens } : undefined);
    return { ok: true, text: d.text, tokens: d.tokens, full: d.full, navigated: d.navigated, meta: d.manifest.meta, elements: pickElements(d.manifest) };
  } catch (error) {
    appendServerLog(`eyes-diff error ${error && error.message}`);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

// Verified input dispatch on manifest IDs. A blocked/failed action comes back as
// {ok:false, error, blockedBy} — the renderer feeds that to the model as an observation.
ipcMain.handle('toji:eyes-act', async (_event, { webContentsId, action }) => {
  try {
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

// Cropped, downscaled screenshot of one element (by manifest id) or a viewport region —
// the agent's escalation sense for canvas / images / text-blind iframes.
ipcMain.handle('toji:eyes-look', async (_event, { webContentsId, id, rect, maxLongEdge }) => {
  try {
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
ipcMain.handle('toji:upload-file-input', async (_event, { webContentsId, filePath, inputIndex, elementId }) => {
  try {
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
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };
  const template = [
    ...(isMacOS ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
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
});
