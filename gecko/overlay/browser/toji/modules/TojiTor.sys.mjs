/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Toji's Tor client manager. Runs the real tor (never an implementation of our
// own), watches its bootstrap, and talks to its control port.
//
// Isolation is by SOCKS credentials: every Tor container sends its own
// username/password, and tor's IsolateSOCKSAuth keeps differently-credentialed
// streams on different circuits. That works on the managed tor and on an
// external one (Tor Browser, a system tor), which Chromium never could.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "TorLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/tor.sys.mjs")
);

const STATUS_TOPIC = "toji-tor-status";
const CONNECT_TIMEOUT_S = 2;

function log(...args) {
  console.log("[toji:tor]", ...args);
}

function randomNonce() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A line-oriented connection to tor's control port. Commands are sent one at a
 * time; each resolves with its reply ({ code, lines }).
 */
class ControlConnection {
  #transport = null;
  #out = null;
  #in = null;
  #buffer = "";
  #queue = [];
  #closed = false;
  onClose = null;

  static async open(port) {
    const conn = new ControlConnection();
    await conn.#connect(port);
    return conn;
  }

  #connect(port) {
    return new Promise((resolve, reject) => {
      const sts = Cc[
        "@mozilla.org/network/socket-transport-service;1"
      ].getService(Ci.nsISocketTransportService);
      this.#transport = sts.createTransport([], "127.0.0.1", port, null, null);
      this.#transport.setTimeout(
        Ci.nsISocketTransport.TIMEOUT_CONNECT,
        CONNECT_TIMEOUT_S
      );
      // Connected is a transport status, so nothing is sent to find out: before
      // authentication tor answers anything but PROTOCOLINFO/AUTHENTICATE with
      // 514 and hangs up, and a SOCKS port hangs up on stray bytes. A refused
      // or timed-out connect shows up in the input pump instead.
      let settled = false;
      const failed = error => {
        if (!settled) {
          settled = true;
          reject(new Error(`127.0.0.1:${port}: ${error.message}`));
        }
        this.#fail(error);
      };
      this.#transport.setEventSink(
        {
          onTransportStatus: (_transport, status) => {
            if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO && !settled) {
              settled = true;
              resolve();
            }
          },
        },
        Services.tm.mainThread
      );
      this.#out = this.#transport.openOutputStream(0, 0, 0);
      const raw = this.#transport.openInputStream(0, 0, 0);
      this.#in = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream
      );
      this.#in.init(raw);
      const pump = {
        onInputStreamReady: stream => {
          let chunk = "";
          try {
            const n = stream.available();
            chunk = n ? this.#in.readBytes(n) : "";
          } catch (e) {
            failed(e);
            return;
          }
          if (!chunk) {
            failed(new Error("connection closed"));
            return;
          }
          this.#receive(chunk);
          if (!this.#closed) {
            stream.asyncWait(pump, 0, 0, Services.tm.mainThread);
          }
        },
      };
      raw
        .QueryInterface(Ci.nsIAsyncInputStream)
        .asyncWait(pump, 0, 0, Services.tm.mainThread);
    });
  }

  #receive(chunk) {
    this.#buffer += chunk;
    const { replies, rest } = lazy.TorLib.parseReplies(this.#buffer);
    this.#buffer = rest;
    for (const reply of replies) {
      const waiter = this.#queue.shift();
      waiter?.resolve(reply);
    }
  }

  #fail(error) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#queue.splice(0)) {
      waiter.reject(error);
    }
    try {
      this.#transport?.close(Cr.NS_OK);
    } catch {}
    this.onClose?.(error);
  }

  send(command) {
    if (this.#closed) {
      return Promise.reject(new Error("control connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ resolve, reject });
      const line = `${command}\r\n`;
      this.#out.write(line, line.length);
    });
  }

  close() {
    this.#closed = true;
    try {
      this.#transport?.close(Cr.NS_OK);
    } catch {}
  }
}

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
async function probePort(port) {
  try {
    const conn = await ControlConnection.open(port);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path) {
  try {
    const info = await IOUtils.stat(path);
    return info.type === "regular" && (info.permissions & 0o111) !== 0;
  } catch {
    return false;
  }
}

class TorService {
  status = null;
  #listeners = new Set();
  #proc = null;
  #control = null;
  #socksPort = null;
  #source = null;
  #starting = null;
  #nonce = randomNonce();
  /** containerId -> generation; bumping it gives that container new circuits. */
  #generations = new Map();
  #readyWaiters = [];

  constructor() {
    this.status = { ...lazy.TorLib.OFF_STATUS };
  }

  get dataDir() {
    return PathUtils.join(PathUtils.profileDir, "tor");
  }

  onStatus(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setStatus(patch) {
    this.status = lazy.TorLib.nextStatus(this.status, patch);
    if (this.status.ready) {
      for (const waiter of this.#readyWaiters.splice(0)) {
        waiter(true);
      }
    } else if (this.status.state === "off" || this.status.state === "error") {
      for (const waiter of this.#readyWaiters.splice(0)) {
        waiter(false);
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener(this.status);
      } catch (e) {
        console.error(e);
      }
    }
    Services.obs.notifyObservers(
      null,
      STATUS_TOPIC,
      JSON.stringify(this.status)
    );
  }

  isReady() {
    return this.status.ready && this.#socksPort !== null;
  }

  /** True while tor is on its way up; requests may wait for it. */
  isStarting() {
    return (
      this.status.state === "starting" || this.status.state === "bootstrapping"
    );
  }

  /** Resolves true once ready, false if tor stops or fails, or after timeoutMs. */
  whenReady(timeoutMs) {
    if (this.isReady()) {
      return Promise.resolve(true);
    }
    if (!this.isStarting()) {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const i = this.#readyWaiters.indexOf(done);
        if (i >= 0) {
          this.#readyWaiters.splice(i, 1);
        }
        resolve(false);
      }, timeoutMs);
      const done = ok => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.#readyWaiters.push(done);
    });
  }

  /**
   * SOCKS endpoint and credentials for a Tor container, or null when tor is not
   * ready — callers must then fail closed.
   */
  socksFor(containerId) {
    if (!this.isReady()) {
      return null;
    }
    const generation = this.#generations.get(containerId) || 0;
    return {
      port: this.#socksPort,
      ...lazy.TorLib.socksCredentials(containerId, this.#nonce, generation),
    };
  }

  start() {
    if (this.isReady()) {
      return Promise.resolve(this.status);
    }
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => (this.#starting = null));
    }
    return this.#starting;
  }

  async #findBinary() {
    const bundled = PathUtils.join(
      Services.dirsvc.get("GreD", Ci.nsIFile).path,
      "tor",
      "tor"
    );
    const env = Services.env.get("TOJI_TOR_BINARY") || undefined;
    for (const candidate of lazy.TorLib.torBinaryCandidates({ bundled, env })) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  async #start() {
    this.#setStatus({ state: "starting", progress: 0, detail: "Starting Tor" });
    const binary = await this.#findBinary();
    if (!binary) {
      for (const port of lazy.TorLib.EXTERNAL_SOCKS_PORTS) {
        if (await probePort(port)) {
          this.#socksPort = port;
          this.#source = "external";
          this.#setStatus({
            state: "ready",
            progress: 100,
            detail: `Using Tor already running on port ${port}`,
            source: "external",
          });
          return this.status;
        }
      }
      this.#setStatus({
        state: "error",
        progress: 0,
        detail:
          "No Tor found. Install it (macOS: brew install tor) or start Tor Browser, then try again.",
        source: null,
      });
      return this.status;
    }

    try {
      await this.#spawn(binary);
    } catch (e) {
      log("start failed", e);
      this.#teardown();
      this.#setStatus({
        state: "error",
        progress: 0,
        detail: `Tor failed to start: ${e.message}`,
      });
    }
    return this.status;
  }

  async #spawn(binary) {
    const dir = this.dataDir;
    await IOUtils.makeDirectory(dir, { permissions: 0o700 });
    const torrc = PathUtils.join(dir, "torrc");
    const portFile = PathUtils.join(dir, "control.port");
    await IOUtils.remove(portFile, { ignoreAbsent: true });
    await IOUtils.writeUTF8(
      torrc,
      lazy.TorLib.buildTorrc({
        dataDir: dir,
        controlPortFile: portFile,
        ownerPid: Services.appinfo.processID,
      })
    );
    this.#source = "managed";
    this.#setStatus({
      state: "bootstrapping",
      progress: 0,
      detail: "Connecting to the Tor network",
      source: "managed",
    });
    const proc = await lazy.Subprocess.call({
      command: binary,
      arguments: ["-f", torrc, "--defaults-torrc", torrc + ".defaults"],
      stderr: "stdout",
    });
    this.#proc = proc;
    proc.wait().then(({ exitCode }) => {
      if (this.#proc !== proc) {
        return;
      }
      this.#proc = null;
      this.#teardown();
      if (this.status.state !== "off") {
        this.#setStatus({
          state: "error",
          progress: 0,
          detail: `Tor exited (code ${exitCode})`,
        });
      }
    });
    this.#readOutput(proc, portFile);
  }

  async #readOutput(proc, portFile) {
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
        if (!line.trim()) {
          continue;
        }
        log(line.trim());
        // tor logs two lines per listener; attach on the second, once.
        if (/Opened Control listener/.test(line)) {
          this.#attachControl(portFile).catch(e => this.#controlFailed(e));
        }
        const boot = lazy.TorLib.parseBootstrap(line);
        if (!boot) {
          continue;
        }
        if (boot.progress >= 100) {
          await this.#whenSocksKnown();
          if (this.#proc !== proc) {
            // Stopped, or given up on because its control port failed.
            return;
          }
          this.#setStatus({
            state: "ready",
            progress: 100,
            detail: "Connected to the Tor network",
          });
        } else {
          this.#setStatus({
            state: "bootstrapping",
            progress: boot.progress,
            detail: boot.detail,
          });
        }
      }
    }
  }

  #socksKnown = null;

  #whenSocksKnown() {
    if (this.#socksPort) {
      return Promise.resolve();
    }
    if (!this.#socksKnown) {
      this.#socksKnown = Promise.withResolvers();
    }
    return this.#socksKnown.promise;
  }

  #attaching = null;

  /** Once per tor process, however many listener lines announce the port. */
  #attachControl(portFile) {
    this.#attaching ??= this.#connectControl(portFile);
    return this.#attaching;
  }

  async #connectControl(portFile) {
    let port = null;
    for (let i = 0; i < 50 && port === null; i++) {
      try {
        port = lazy.TorLib.parseControlPortFile(await IOUtils.readUTF8(portFile));
      } catch {}
      if (port === null) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (port === null) {
      throw new Error("tor never wrote its control port");
    }
    // tor announces the listener before it writes the cookie; wait for it too.
    const cookiePath = PathUtils.join(this.dataDir, "control_auth_cookie");
    let cookie = null;
    for (let i = 0; i < 50 && cookie?.length !== 32; i++) {
      try {
        cookie = await IOUtils.read(cookiePath);
      } catch {}
      if (cookie?.length !== 32) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (cookie?.length !== 32) {
      throw new Error("tor never wrote its control cookie");
    }
    const conn = await ControlConnection.open(port);
    const auth = await conn.send(
      `AUTHENTICATE ${lazy.TorLib.cookieHex(cookie)}`
    );
    if (auth.code !== 250) {
      conn.close();
      throw new Error(`tor refused authentication (${auth.code})`);
    }
    // tor now exits if this connection (i.e. the browser) goes away.
    await conn.send("TAKEOWNERSHIP");
    const listeners = await conn.send("GETINFO net/listeners/socks");
    this.#socksPort = lazy.TorLib.parseSocksListener(listeners);
    if (!this.#socksPort) {
      conn.close();
      throw new Error("tor reported no SOCKS listener");
    }
    this.#control = conn;
    conn.onClose = () => {
      if (this.#control === conn) {
        this.#control = null;
      }
    };
    this.#socksKnown?.resolve();
    this.#socksKnown = null;
  }

  /**
   * Without its control port Toji can't learn the SOCKS port or own the
   * process, so this tor is no use: stop it and say why.
   */
  #controlFailed(error) {
    log("control port attach failed", error);
    const proc = this.#proc;
    this.#proc = null;
    this.#teardown();
    proc?.kill(500);
    this.#setStatus({
      state: "error",
      progress: 0,
      detail: `Tor's control port failed: ${error.message}`,
    });
  }

  #teardown() {
    this.#control?.close();
    this.#control = null;
    this.#attaching = null;
    this.#socksPort = null;
    this.#source = null;
    // Anyone waiting for the SOCKS port re-checks whether this tor still counts.
    this.#socksKnown?.resolve();
    this.#socksKnown = null;
  }

  stop() {
    const proc = this.#proc;
    this.#proc = null;
    this.#teardown();
    this.#setStatus({
      state: "off",
      progress: 0,
      detail: "Tor is not running",
      source: null,
    });
    proc?.kill(500);
    return this.status;
  }

  /**
   * New circuits. With a container id, only that container's (its credentials
   * change, so tor builds it a fresh circuit). Without, every container's, plus
   * SIGNAL NEWNYM so a managed tor also drops its cached circuits.
   */
  async newCircuit(containerId) {
    if (containerId) {
      this.#generations.set(
        containerId,
        (this.#generations.get(containerId) || 0) + 1
      );
      return true;
    }
    this.#nonce = randomNonce();
    this.#generations.clear();
    if (!this.#control) {
      return this.isReady();
    }
    try {
      const reply = await this.#control.send("SIGNAL NEWNYM");
      return reply.code === 250;
    } catch {
      return false;
    }
  }

  get source() {
    return this.#source;
  }
}

export const TojiTor = new TorService();

lazy.AsyncShutdown?.profileBeforeChange?.addBlocker(
  "Toji: stop tor",
  () => TojiTor.stop()
);
