// End-to-end check of Toji's Tor design against a REAL tor daemon.
//
// gecko/lib/tor.test.ts covers parsing and torrc generation offline. This starts
// an actual tor with Toji's own torrc (gecko/lib/tor.ts), sends traffic for two
// containers the way the browser does — the same SOCKS port, different SOCKS
// credentials — and proves the claim the isolation design rests on: tor keeps the
// two on different circuits that exit from different relays.
//
//   bun run tor:check          (needs a tor binary: brew install tor)
//
// The in-browser half (the proxy filter, fail-closed, .onion routing through a
// built Toji.app) is gecko/test/tor-browser.ts, run by `make tor-check` too.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTorrc,
  cookieHex,
  parseBootstrap,
  parseControlPortFile,
  parseReplies,
  parseSocksListener,
  socksCredentials,
  torBinaryCandidates,
  type ControlReply
} from '../gecko/lib/tor';

const BOOTSTRAP_TIMEOUT_MS = 180000;
const ONION = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';

let failures = 0;
const say = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

const binary = torBinaryCandidates({ env: process.env.TOJI_TOR_BINARY }).find((p) => existsSync(p));
if (!binary) {
  console.error('No tor binary found (brew install tor).');
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'toji-tor-live-'));
const torrc = join(dataDir, 'torrc');
const portFile = join(dataDir, 'control.port');
writeFileSync(torrc, buildTorrc({ dataDir, controlPortFile: portFile, ownerPid: process.pid }));
const tor = spawn(binary, ['-f', torrc, '--defaults-torrc', `${torrc}.defaults`], { stdio: ['ignore', 'pipe', 'pipe'] });

class Control {
  private socket = connect(parseControlPortFile(readFileSync(portFile, 'utf8'))!, '127.0.0.1');
  private buffer = '';
  private waiters: ((r: ControlReply) => void)[] = [];
  constructor() {
    this.socket.on('data', (chunk) => {
      const { replies, rest } = parseReplies(this.buffer + chunk.toString());
      this.buffer = rest;
      for (const r of replies) this.waiters.shift()?.(r);
    });
  }
  send(cmd: string): Promise<ControlReply> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.socket.write(`${cmd}\r\n`);
    });
  }
  close() {
    this.socket.destroy();
  }
}

const ready = new Promise<boolean>((resolve) => {
  let last = -1;
  let pending = '';
  const timer = setTimeout(() => resolve(false), BOOTSTRAP_TIMEOUT_MS);
  tor.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      if (process.env.VERBOSE) console.log(line);
      const boot = parseBootstrap(line);
      if (!boot) continue;
      if (boot.progress !== last) {
        last = boot.progress;
        process.stdout.write(`\r    bootstrapping ${String(boot.progress).padStart(3)}%  ${boot.detail.slice(0, 52).padEnd(52)}`);
      }
      if (boot.progress >= 100) {
        clearTimeout(timer);
        resolve(true);
      }
    }
  });
  tor.on('exit', () => resolve(false));
});

const curlVia = (port: number, creds: { username: string; password: string }, url: string, extra: string[] = []) =>
  execFileSync(
    'curl',
    ['-sS', '--max-time', '90', '-x', `socks5h://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@127.0.0.1:${port}`, ...extra, url],
    { encoding: 'utf8' }
  ).trim();

/** circuit id -> { exit fingerprint, SOCKS username } from GETINFO circuit-status. */
function circuitsByUser(reply: ControlReply) {
  const map = new Map<string, { id: string; exit: string }[]>();
  for (const line of reply.lines) {
    const m = /^(\d+) BUILT (\S+).*?SOCKS_USERNAME="([^"]*)"/.exec(line.replace(/^circuit-status=/, ''));
    if (!m) continue;
    const exit = m[2].split(',').pop()!.split(/[~=]/)[0];
    const list = map.get(m[3]) ?? [];
    list.push({ id: m[1], exit });
    map.set(m[3], list);
  }
  return map;
}

let control: Control | null = null;
try {
  const ok = await ready;
  process.stdout.write('\r' + ' '.repeat(78) + '\r');
  say(ok, 'tor bootstraps with Toji\'s torrc');
  if (!ok) throw new Error('tor did not bootstrap');

  control = new Control();
  const auth = await control.send(`AUTHENTICATE ${cookieHex(readFileSync(join(dataDir, 'control_auth_cookie')))}`);
  say(auth.code === 250, 'cookie authentication on the control port');
  const socksPort = parseSocksListener(await control.send('GETINFO net/listeners/socks'));
  say(!!socksPort, 'tor reports the SOCKS port it picked', String(socksPort));
  if (!socksPort) throw new Error('no SOCKS port');

  const nonce = Math.random().toString(16).slice(2);
  const onion = socksCredentials('onion', nonce);
  const work = socksCredentials('work', nonce);

  const a = JSON.parse(curlVia(socksPort, onion, 'https://check.torproject.org/api/ip'));
  const b = JSON.parse(curlVia(socksPort, work, 'https://check.torproject.org/api/ip'));
  say(a.IsTor === true && b.IsTor === true, 'both containers\' traffic exits through Tor', `${a.IP} / ${b.IP}`);

  const circuits = circuitsByUser(await control.send('GETINFO circuit-status'));
  const ca = circuits.get(onion.username) ?? [];
  const cb = circuits.get(work.username) ?? [];
  const sharedCircuit = ca.some((x) => cb.some((y) => y.id === x.id));
  say(ca.length > 0 && cb.length > 0 && !sharedCircuit, 'the two containers are on different circuits (IsolateSOCKSAuth)', `${ca.map((c) => c.id)} vs ${cb.map((c) => c.id)}`);

  // Different circuits usually exit at different relays; if tor happened to pick
  // the same exit twice, a fresh generation must still land elsewhere.
  let exitA = a.IP;
  let differentExits = a.IP !== b.IP;
  for (let gen = 1; !differentExits && gen <= 3; gen++) {
    exitA = JSON.parse(curlVia(socksPort, socksCredentials('onion', nonce, gen), 'https://check.torproject.org/api/ip')).IP;
    differentExits = exitA !== b.IP;
  }
  say(differentExits, 'the two containers exit from different relays', `${exitA} vs ${b.IP}`);

  const fresh = JSON.parse(curlVia(socksPort, socksCredentials('onion', nonce, 7), 'https://check.torproject.org/api/ip'));
  const after = circuitsByUser(await control.send('GETINFO circuit-status')).get(onion.username) ?? [];
  say(fresh.IsTor === true && after.length > ca.length, 'a new generation gives a container a new circuit', `${after.length} circuit(s) for ${onion.username}`);

  const status = curlVia(socksPort, onion, ONION, ['-o', '/dev/null', '-w', '%{http_code}']);
  say(status === '200', 'loads a real .onion hidden service', `HTTP ${status}`);

  const newnym = await control.send('SIGNAL NEWNYM');
  say(newnym.code === 250, 'NEWNYM succeeds over the control port');
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  control?.close();
  tor.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll Tor checks passed.');
  process.exit(failures ? 1 : 0);
}
