/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Supervises Toji's agent server: a single compiled binary (bun build
// --compile) shipped in the app bundle, so nobody needs Node installed. It
// listens on 127.0.0.1 only, on a port it picks, and refuses requests without
// this launch's token. It exits with the browser (TOJI_PARENT_PID) and is
// restarted with a backoff if it dies.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const BINARY_NAME = "toji-agent-server";
const READY_PREFIX = "TOJI_SERVER_READY ";
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60000;
const LOG_LINES = 400;

function log(...args) {
  console.log("[toji:server]", ...args);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function isExecutable(path) {
  try {
    const info = await IOUtils.stat(path);
    return info.type === "regular" && (info.permissions & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * A GUI-launched app gets a bare PATH, and the coding-agent CLIs the server
 * drives (claude, codex, opencode…) live in the user's shell PATH. Ask the
 * login shell once; fall back to the usual install locations.
 */
async function loginPath() {
  const home = Services.env.get("HOME");
  const fallback = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const shell = Services.env.get("SHELL") || "/bin/zsh";
  try {
    const proc = await lazy.Subprocess.call({
      command: shell,
      arguments: ["-lc", 'printf "%s" "$PATH"'],
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 3000);
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    clearTimeout(timer);
    await proc.wait();
    out = out.trim();
    return out ? `${out}:${fallback}` : fallback;
  } catch {
    return fallback;
  }
}

class AgentServer {
  #proc = null;
  #info = null;
  #token = randomToken();
  #starting = null;
  #waiters = [];
  #restarts = [];
  #lines = [];
  #stopped = false;

  /** { url, token } once the server is listening, else null. */
  info() {
    return this.#info;
  }

  get logLines() {
    return this.#lines.slice();
  }

  /** Resolves to info() once the server listens, or null after timeoutMs. */
  whenReady(timeoutMs = 15000) {
    if (this.#info) {
      return Promise.resolve(this.#info);
    }
    this.start();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(done);
        if (i >= 0) {
          this.#waiters.splice(i, 1);
        }
        resolve(null);
      }, timeoutMs);
      const done = info => {
        clearTimeout(timer);
        resolve(info);
      };
      this.#waiters.push(done);
    });
  }

  start() {
    this.#stopped = false;
    if (this.#proc || this.#starting) {
      return this.#starting ?? Promise.resolve(this.#info);
    }
    this.#starting = this.#spawn()
      .catch(e => {
        log("could not start", e);
        return null;
      })
      .finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #findBinary() {
    const override = Services.env.get("TOJI_AGENT_SERVER_BIN");
    const bundled = PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      BINARY_NAME
    );
    for (const candidate of [override, bundled]) {
      if (candidate && (await isExecutable(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  async #spawn() {
    const binary = await this.#findBinary();
    if (!binary) {
      log("no agent server binary in the app; AI features are off");
      return null;
    }
    const dataDir = PathUtils.join(PathUtils.profileDir, "agent-server");
    await IOUtils.makeDirectory(dataDir, { permissions: 0o700 });
    const envFile = PathUtils.join(dataDir, ".env");
    const env = {
      PATH: await loginPath(),
      PORT: "0",
      NODE_ENV: "production",
      TOJI_DATA_DIR: dataDir,
      TOJI_SERVER_TOKEN: this.#token,
      TOJI_PARENT_PID: String(Services.appinfo.processID),
    };
    if (await IOUtils.exists(envFile)) {
      env.TOJI_ENV_FILE = envFile;
    }
    const proc = await lazy.Subprocess.call({
      command: binary,
      arguments: [],
      environment: env,
      environmentAppend: true,
      workdir: dataDir,
      stderr: "stdout",
    });
    this.#proc = proc;
    this.#read(proc);
    proc.wait().then(({ exitCode }) => this.#exited(proc, exitCode));
    return this.whenReady();
  }

  async #read(proc) {
    let pending = "";
    for (;;) {
      let chunk;
      try {
        chunk = await proc.stdout.readString();
      } catch {
        return;
      }
      if (!chunk) {
        return;
      }
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        this.#lines.push(line);
        if (this.#lines.length > LOG_LINES) {
          this.#lines.shift();
        }
        if (line.startsWith(READY_PREFIX)) {
          try {
            const { port } = JSON.parse(line.slice(READY_PREFIX.length));
            this.#info = { url: `http://127.0.0.1:${port}`, token: this.#token };
            log(`listening on ${this.#info.url}`);
            for (const waiter of this.#waiters.splice(0)) {
              waiter(this.#info);
            }
          } catch (e) {
            log("bad ready line", line, e);
          }
        }
      }
    }
  }

  #exited(proc, exitCode) {
    if (this.#proc !== proc) {
      return;
    }
    this.#proc = null;
    this.#info = null;
    if (this.#stopped) {
      return;
    }
    log(`exited with ${exitCode}`);
    const now = Date.now();
    this.#restarts = this.#restarts.filter(t => now - t < RESTART_WINDOW_MS);
    if (this.#restarts.length >= MAX_RESTARTS) {
      log("restarting too often; giving up until the next launch");
      return;
    }
    this.#restarts.push(now);
    setTimeout(() => this.start(), 500 * 2 ** this.#restarts.length);
  }

  stop() {
    this.#stopped = true;
    const proc = this.#proc;
    this.#proc = null;
    this.#info = null;
    proc?.kill(1000);
  }

  /** fetch() against the server with the token attached. */
  async fetch(path, init = {}) {
    const info = await this.whenReady();
    if (!info) {
      throw new Error("Toji's agent server is not running");
    }
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${info.token}`);
    return fetch(`${info.url}${path}`, { ...init, headers });
  }
}

export const TojiAgentServer = new AgentServer();

lazy.AsyncShutdown?.profileBeforeChange?.addBlocker(
  "Toji: stop the agent server",
  () => TojiAgentServer.stop()
);
