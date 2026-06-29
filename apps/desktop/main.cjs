const { app, BrowserWindow, Menu, ipcMain, shell, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
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
      TOJI_DATA_DIR: process.env.TOJI_DATA_DIR ?? path.join(app.getPath('userData'), 'data')
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
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 17 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  });
  mainWindow = win;

  // In production the bundled agent server serves the renderer over http:// so it
  // loads correctly (no file:// CSP/CORS issues) and is same-origin with the API.
  const startUrl = isDev ? process.env.ELECTRON_START_URL : `http://127.0.0.1:${SERVER_PORT}/`;

  // Keep the top-level app frame pinned to the renderer; never let it navigate away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== startUrl) event.preventDefault();
  });

  win.loadURL(startUrl);
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
