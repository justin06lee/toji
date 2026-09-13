// A minimal Marionette client for driving a Toji build in tests: chrome-context
// scripts, content scripts, navigation and screenshots. Marionette's wire format
// is "<length>:<json>"; commands are [0, id, name, params], replies [1, id, err, result].

import { connect, type Socket } from 'node:net';

export class Marionette {
  private socket!: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private hello!: Promise<void>;

  static async open(port = 2828, host = '127.0.0.1', timeoutMs = 60000): Promise<Marionette> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const m = new Marionette();
        await m.connect(port, host);
        return m;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await Bun.sleep(500);
      }
    }
  }

  private connect(port: number, host: string): Promise<void> {
    return new Promise((ok, fail) => {
      let greeted: () => void;
      this.hello = new Promise((resolve) => (greeted = resolve));
      this.socket = connect(port, host);
      this.socket.once('error', fail);
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const colon = this.buffer.indexOf(':');
          if (colon < 0) return;
          const len = Number(this.buffer.subarray(0, colon).toString());
          if (this.buffer.length < colon + 1 + len) return;
          const body = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + len).toString());
          this.buffer = this.buffer.subarray(colon + 1 + len);
          if (!Array.isArray(body)) {
            greeted();
            continue;
          }
          const [, id, err, result] = body;
          const p = this.pending.get(id);
          if (!p) continue;
          this.pending.delete(id);
          if (err) p.fail(new Error(`${err.error}: ${err.message}`));
          else p.ok(result);
        }
      });
      this.socket.once('connect', () => this.hello.then(ok));
    });
  }

  /**
   * Sends a command. Every command gets a deadline, so a check that would hang
   * (a reply that never comes) fails instead, naming the command.
   */
  send(name: string, params: Record<string, unknown> = {}, timeoutMs = 120000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${name}: no reply within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => {
          clearTimeout(timer);
          ok(v);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        }
      });
    });
  }

  async session() {
    return this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  }

  async context(value: 'chrome' | 'content') {
    await this.send('Marionette:SetContext', { value });
  }

  /** Runs `script` (a function body; `arguments` holds args) and returns its value. */
  async exec<T = any>(script: string, args: unknown[] = [], sandbox?: string): Promise<T> {
    const r = await this.send('WebDriver:ExecuteScript', { script, args, ...(sandbox ? { sandbox } : {}) });
    return r?.value as T;
  }

  /**
   * Runs `script` as an async function body; the last entry of `arguments` is the
   * callback that returns a value. `await` works, and a throw fails the call.
   */
  async execAsync<T = any>(script: string, args: unknown[] = [], timeoutMs = 60000): Promise<T> {
    await this.send('WebDriver:SetTimeouts', { script: timeoutMs });
    // An arrow function keeps the outer `arguments`, so the body reads them as usual.
    const wrapped = `const __done = arguments[arguments.length - 1];
      (async () => {\n${script}\n})().catch((e) => __done({ __tojiError: String(e) + (e && e.stack ? "\\n" + e.stack : "") }));`;
    // The script's own timeout rules; the command deadline only catches a lost reply.
    const r = await this.send('WebDriver:ExecuteAsyncScript', { script: wrapped, args }, timeoutMs + 30000);
    const value = r?.value;
    if (value && typeof value === 'object' && '__tojiError' in value) throw new Error(`script error: ${value.__tojiError}`);
    return value as T;
  }

  async navigate(url: string) {
    await this.send('WebDriver:Navigate', { url });
  }

  /** PNG screenshot (base64) of the current context (content: viewport; chrome: whole window). */
  async screenshot(full = false): Promise<string> {
    const r = await this.send('WebDriver:TakeScreenshot', { full, hash: false });
    return r.value as string;
  }

  async quit() {
    try {
      await this.send('Marionette:Quit', { flags: ['eForceQuit'] });
    } catch {}
    this.socket.destroy();
  }

  close() {
    this.socket.destroy();
  }
}
