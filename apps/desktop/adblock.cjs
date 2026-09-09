'use strict';

// Built-in ad and tracker blocking, on by default, for every container session.
//
// The engine is Ghostery's, fed the same lists uBlock Origin ships (EasyList, EasyPrivacy,
// uBlock's own filters and annoyance lists). It has two halves. The network half decides
// each request and joins the per-session request gate BEHIND the Tor kill switch, so a Tor
// container that is offline stays offline whatever the blocker would have said. The
// cosmetic half — element hiding, plus the scriptlets that keep video sites' players free
// of ads — runs from a preload registered on each session and asks back here for the
// rules that apply to the page.
//
// The lists are fetched once, parsed in a worker thread (see adblock-worker.cjs), and the
// finished engine is cached on disk; a launch after that loads in a moment, offline. Lists
// are refreshed in the background once the cache is a day old. Until an engine exists,
// pages simply load unfiltered — blocking is a comfort, never a gate on browsing.

const fs = require('node:fs');
const path = require('node:path');
const { addRequestCheck } = require('./request-gate.cjs');

const ENGINE_FILE = 'adblock-engine.bin';
const SETTINGS_FILE = 'adblock.json';
/** Lists are fetched again once the cached engine is older than this. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** The channels the Ghostery preload asks on; names are the library's. */
const IPC_COSMETICS = '@ghostery/adblocker/inject-cosmetic-filters';
const IPC_OBSERVER = '@ghostery/adblocker/is-mutation-observer-enabled';

/** Where the setting lives and what it says; absent means on. */
function readEnabled(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.enabled !== false;
  } catch {
    return true;
  }
}

class Adblock {
  /**
   * @param options.dataDir   where the engine cache and the setting are kept
   * @param options.ipcMain   Electron's ipcMain (injected so this can be tested without Electron)
   * @param options.buildEngine  builds a serialized engine from the lists (defaults to the worker)
   * @param options.deserialize  turns cached bytes back into an engine (defaults to ElectronBlocker)
   * @param options.preloadPath  the cosmetic preload to register on sessions
   */
  constructor({ dataDir, ipcMain = null, log = () => {}, buildEngine, deserialize, preloadPath, now = Date.now } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.ipcMain = ipcMain;
    this.now = now;
    this.engineFile = path.join(dataDir, ENGINE_FILE);
    this.settingsFile = path.join(dataDir, SETTINGS_FILE);
    this.enabled = readEnabled(this.settingsFile);
    this.engine = null;
    this.blocked = 0;
    this.cosmetics = 0; // pages that asked for element-hiding rules
    this.loading = null;
    this.refreshTimer = null;
    this.sessions = new Set();
    this.ipcInstalled = false;
    this.buildEngine = buildEngine || (() => buildInWorker());
    this.deserialize = deserialize || ((bytes) => require('@ghostery/adblocker-electron').ElectronBlocker.deserialize(bytes));
    this.preloadPath = preloadPath === undefined ? resolvePreload() : preloadPath;
  }

  /** What the settings page shows. */
  status() {
    return { enabled: this.enabled, ready: Boolean(this.engine), blocked: this.blocked, cosmetics: this.cosmetics, updatedAt: this.cachedAt() };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify({ enabled: this.enabled }));
    } catch (error) {
      this.log(`adblock: could not save setting: ${error && error.message}`);
    }
    return this.status();
  }

  cachedAt() {
    try {
      return fs.statSync(this.engineFile).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Load the engine: the on-disk cache when there is one (instant, offline), else the lists
   * (network, parsed off-thread). A stale cache is used at once and refreshed behind it.
   */
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const cachedAt = this.cachedAt();
      if (cachedAt !== null) {
        try {
          this.engine = this.deserialize(new Uint8Array(fs.readFileSync(this.engineFile)));
          this.log('adblock: engine loaded from cache');
        } catch (error) {
          this.log(`adblock: cached engine unusable (${error && error.message}); rebuilding`);
        }
      }
      if (!this.engine) await this.rebuild();
      else if (this.now() - cachedAt > REFRESH_MS) void this.rebuild();
      this.scheduleRefresh();
      return this.engine;
    })();
    return this.loading;
  }

  /** Fetch the lists and swap in a fresh engine; failures keep whatever was there. */
  async rebuild() {
    try {
      const bytes = await this.buildEngine();
      const engine = this.deserialize(bytes);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const temp = `${this.engineFile}.tmp`;
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, this.engineFile);
      this.engine = engine;
      this.log('adblock: engine built from the latest lists');
    } catch (error) {
      this.log(`adblock: could not build the engine: ${error && error.message}`);
    }
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const cachedAt = this.cachedAt();
    const due = cachedAt === null ? REFRESH_MS : Math.max(60_000, cachedAt + REFRESH_MS - this.now());
    this.refreshTimer = setTimeout(() => void this.rebuild().then(() => this.scheduleRefresh()), due);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  /** Whether the engine should act right now. */
  active() {
    return this.enabled && this.engine !== null;
  }

  /** Put blocking on a session: the request check, the CSP header pass, the cosmetic preload. */
  attach(sess) {
    if (!sess || this.sessions.has(sess)) return;
    this.sessions.add(sess);
    addRequestCheck(
      sess,
      'adblock',
      (details, callback) => {
        if (!this.active()) return callback({});
        this.engine.onBeforeRequest(details, (decision) => {
          if (decision && (decision.cancel || decision.redirectURL)) this.blocked += 1;
          callback(decision);
        });
      },
      10
    );
    if (sess.webRequest && typeof sess.webRequest.onHeadersReceived === 'function') {
      sess.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        if (!this.active()) return callback({});
        this.engine.onHeadersReceived(details, callback);
      });
    }
    if (this.preloadPath && typeof sess.registerPreloadScript === 'function') {
      try {
        sess.registerPreloadScript({ type: 'frame', filePath: this.preloadPath });
      } catch (error) {
        this.log(`adblock: cosmetic preload unavailable: ${error && error.message}`);
      }
    }
    this.installIpc();
  }

  /** The preload's two questions, answered once for every session. */
  installIpc() {
    if (this.ipcInstalled || !this.ipcMain) return;
    this.ipcInstalled = true;
    this.ipcMain.handle(IPC_COSMETICS, (event, url, message) => {
      if (!this.active()) return undefined;
      this.cosmetics += 1;
      return this.engine.onInjectCosmeticFilters(event, url, message);
    });
    this.ipcMain.handle(IPC_OBSERVER, () => this.active() && Boolean(this.engine.config && this.engine.config.enableMutationObserver));
  }
}

/** Parse the lists in a worker thread and hand back the serialized engine. */
function buildInWorker(lists) {
  return new Promise((resolve, reject) => {
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(path.join(__dirname, 'adblock-worker.cjs'), { workerData: { lists } });
    worker.once('message', (message) => {
      if (message && message.ok) resolve(message.engine);
      else reject(new Error((message && message.error) || 'engine build failed'));
      worker.terminate().catch(() => {});
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`engine worker exited with ${code}`));
    });
  });
}

function resolvePreload() {
  try {
    return require.resolve('@ghostery/adblocker-electron-preload');
  } catch {
    return null;
  }
}

module.exports = { Adblock, buildInWorker, readEnabled, REFRESH_MS, IPC_COSMETICS, IPC_OBSERVER };
