import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const tor = require('./tor.cjs') as typeof import('./tor.cjs');

describe('parseBootstrap', () => {
  // Real notice lines from tor 0.4.x.
  it('reads progress and phase out of a notice line', () => {
    expect(tor.parseBootstrap('Aug 19 12:00:00.000 [notice] Bootstrapped 0% (starting): Starting')).toEqual({
      progress: 0,
      detail: 'Starting'
    });
    expect(tor.parseBootstrap('[notice] Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors')).toEqual({
      progress: 45,
      detail: 'Asking for relay descriptors'
    });
    expect(tor.parseBootstrap('[notice] Bootstrapped 100% (done): Done')).toEqual({ progress: 100, detail: 'Done' });
  });

  it('falls back to the phase tag when there is no description', () => {
    expect(tor.parseBootstrap('Bootstrapped 10% (conn_done)')).toEqual({ progress: 10, detail: 'conn_done' });
  });

  it('ignores unrelated log lines', () => {
    expect(tor.parseBootstrap('[notice] Opening Socks listener on 127.0.0.1:9070')).toBeNull();
    expect(tor.parseBootstrap('')).toBeNull();
  });
});

describe('buildTorrc', () => {
  const torrc = tor.buildTorrc({ dataDir: '/tmp/toji-tor', socksPorts: [9070, 9071, 9072], controlPort: 9069 });

  it('gives every SOCKS port its own session group, so circuits stay apart', () => {
    expect(torrc).toContain('SocksPort 127.0.0.1:9070 SessionGroup=1');
    expect(torrc).toContain('SocksPort 127.0.0.1:9071 SessionGroup=2');
    expect(torrc).toContain('SocksPort 127.0.0.1:9072 SessionGroup=3');
    const groups = torrc.match(/SessionGroup=\d+/g) ?? [];
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('enables a cookie-authenticated control port for NEWNYM', () => {
    expect(torrc).toContain('ControlPort 127.0.0.1:9069');
    expect(torrc).toContain('CookieAuthentication 1');
  });

  it('runs client-only and logs bootstrap progress where we can read it', () => {
    expect(torrc).toContain('ClientOnly 1');
    expect(torrc).toContain('Log notice stdout');
    expect(torrc).toContain('DataDirectory /tmp/toji-tor');
  });
});

describe('controlCommands', () => {
  it('authenticates before signalling and quits after', () => {
    expect(tor.controlCommands('abc123', ['SIGNAL NEWNYM'])).toBe('AUTHENTICATE abc123\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
  });
});

describe('port helpers', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      const server = net.createServer();
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

  it('reports a bound port as taken and detects it as an external listener', async () => {
    const port = await listen();
    expect(await tor.portIsFree(port)).toBe(false);
    expect(await tor.probePort(port)).toBe(true);
  });

  it('allocates the requested number of distinct free ports', async () => {
    const ports = await tor.allocatePorts(9400, 3);
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(port).toBeGreaterThanOrEqual(9400);
  });

  it('skips over ports that are already in use', async () => {
    const taken = await listen();
    const ports = await tor.allocatePorts(taken, 2);
    expect(ports).not.toContain(taken);
  });
});

describe('findTorBinary', () => {
  it('returns null when nothing executable is present', () => {
    // The bundled path is checked first; point it somewhere that cannot exist.
    const found = tor.findTorBinary(path.join(os.tmpdir(), 'toji-no-such-resources'));
    // On a machine that does have tor installed this legitimately finds it.
    expect(found === null || found.endsWith('tor')).toBe(true);
  });
});

describe('TorController circuit assignment', () => {
  const make = () => new tor.TorController({ dataDir: path.join(os.tmpdir(), 'toji-tor-test'), log: () => {} });

  it('hands out no port until Tor is ready', () => {
    const controller = make();
    expect(controller.isReady()).toBe(false);
    expect(controller.socksPortFor('personal')).toBeNull();
  });

  it('gives each container its own SOCKS port, stably', () => {
    const controller = make();
    controller.socksPorts = [9070, 9071, 9072];
    controller.setStatus({ state: 'ready', source: 'managed' });

    const first = controller.socksPortFor('onion');
    const second = controller.socksPortFor('research');
    expect(first).not.toBe(second);
    // Same container must keep the same circuits across calls.
    expect(controller.socksPortFor('onion')).toBe(first);
    expect(controller.isolated).toBe(true);
  });

  it('wraps around once the pool is exhausted rather than failing', () => {
    const controller = make();
    controller.socksPorts = [9070, 9071];
    controller.setStatus({ state: 'ready', source: 'managed' });
    const ports = ['a', 'b', 'c'].map((id) => controller.socksPortFor(id));
    expect(ports.every((p) => p !== null)).toBe(true);
    expect(ports[0]).toBe(ports[2]);
  });

  it('shares the single port of an external Tor, and reports isolation as unavailable', () => {
    const controller = make();
    controller.externalPort = 9150;
    controller.setStatus({ state: 'ready', source: 'external' });
    expect(controller.socksPortFor('onion')).toBe(9150);
    expect(controller.socksPortFor('research')).toBe(9150);
    expect(controller.isolated).toBe(false);
  });

  it('drops assignments and reports not-ready after stop', () => {
    const controller = make();
    controller.socksPorts = [9070, 9071];
    controller.setStatus({ state: 'ready', source: 'managed' });
    controller.socksPortFor('onion');
    controller.stop();
    expect(controller.isReady()).toBe(false);
    expect(controller.socksPortFor('onion')).toBeNull();
  });

  it('notifies status listeners and stops after unsubscribe', () => {
    const controller = make();
    const seen: string[] = [];
    const off = controller.onStatus((s) => seen.push(s.state));
    controller.setStatus({ state: 'bootstrapping', progress: 20 });
    controller.setStatus({ state: 'ready' });
    off();
    controller.setStatus({ state: 'off' });
    expect(seen).toEqual(['bootstrapping', 'ready']);
  });

  it('derives `ready` from the state rather than trusting the caller', () => {
    const controller = make();
    controller.setStatus({ state: 'bootstrapping', progress: 99, ready: true } as never);
    expect(controller.status.ready).toBe(false);
  });
});
