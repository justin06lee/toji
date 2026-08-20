// End-to-end check of the Tor layer against a REAL tor daemon.
//
// The unit tests in apps/desktop/tor.test.ts cover parsing, torrc generation, port
// allocation and circuit assignment without a network. This one starts an actual Tor,
// makes real requests through it, and verifies the claim the whole isolation design
// rests on: that two containers assigned different SocksPorts genuinely exit through
// different relays. Run it after touching tor.cjs.
//
//   bun run tor:check          (needs a tor binary: brew install tor)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TorController } = require('../apps/desktop/tor.cjs');

const BOOTSTRAP_TIMEOUT_MS = 120000;
const ONION = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toji-tor-live-'));
const tor = new TorController({ dataDir, log: (m) => process.env.VERBOSE && console.log(m) });

let failures = 0;
const say = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

const curlThrough = (port, url, extra = []) =>
  execFileSync('curl', ['-sS', '--max-time', '60', '--socks5-hostname', `127.0.0.1:${port}`, ...extra, url], {
    encoding: 'utf8'
  }).trim();

// Tor keeps writing to its DataDirectory for a moment after the kill signal, so give it
// time to exit before removing the temp dir — and never fail the check over cleanup.
const cleanup = async () => {
  try {
    tor.stop();
  } catch {
    /* already down */
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      /* still holding the directory; retry */
    }
  }
  console.log(`note: left ${dataDir} behind`);
};

(async () => {
  let last = -1;
  tor.onStatus((s) => {
    if (s.progress !== last && s.state === 'bootstrapping') {
      last = s.progress;
      process.stdout.write(`\r    bootstrapping ${String(s.progress).padStart(3)}%  ${s.detail.slice(0, 52).padEnd(52)}`);
    }
  });

  await tor.start();
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  while (!tor.isReady() && tor.status.state !== 'error' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 400));
  process.stdout.write('\r' + ' '.repeat(78) + '\r');

  say(tor.isReady(), 'Tor bootstraps to ready', tor.status.detail);
  if (!tor.isReady()) return;

  say(tor.status.source === 'managed', 'runs a Toji-managed instance', tor.status.source);
  say(tor.socksPorts.length > 1, 'opens the SocksPort pool', tor.socksPorts.join(', '));
  say(tor.status.isolated, 'reports per-container circuit isolation as available');

  const onionPort = tor.socksPortFor('onion');
  const workPort = tor.socksPortFor('work');
  say(onionPort !== workPort, 'two containers get different SOCKS ports', `${onionPort} vs ${workPort}`);
  say(tor.socksPortFor('onion') === onionPort, 'a container keeps its port across calls');

  // The isolation claim itself: different ports must mean different exits.
  const a = JSON.parse(curlThrough(onionPort, 'https://check.torproject.org/api/ip'));
  const b = JSON.parse(curlThrough(workPort, 'https://check.torproject.org/api/ip'));
  say(a.IsTor === true && b.IsTor === true, 'traffic actually exits through Tor', `${a.IP} / ${b.IP}`);
  say(a.IP !== b.IP, 'the two containers exit from different relays', `${a.IP} vs ${b.IP}`);

  const status = curlThrough(onionPort, ONION, ['-o', '/dev/null', '-w', '%{http_code}']);
  say(status === '200', 'loads a real .onion hidden service', `HTTP ${status}`);

  say(await tor.newCircuit(), 'NEWNYM succeeds over the control port');

  tor.stop();
  await new Promise((r) => setTimeout(r, 300));
  say(!tor.isReady() && tor.socksPortFor('onion') === null, 'stop() tears down and drops assignments');
})()
  .catch((error) => {
    console.error(`ERROR  ${error.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll Tor checks passed.');
    process.exit(failures ? 1 : 0);
  });
