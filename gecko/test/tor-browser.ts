#!/usr/bin/env bun
// The in-browser half of `make tor-check`, against a built Toji.app:
//
//  1. Fail-closed: with tor off (and auto-start disabled for the test), a Tor
//     container's request errors instead of going out directly.
//  2. Isolation: two Tor containers load check.torproject.org through tor and
//     come out of different relays; a direct container does not use tor.
//  3. .onion: a hidden service loads in the Onion container.
//
// Usage: bun gecko/test/tor-browser.ts [path/to/Toji.app]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const app = resolve(process.argv.slice(2).find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const CHECK = 'https://check.torproject.org/api/ip';
const ONION = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';

let failures = 0;
const say = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const profile = join(WORK, 'profiles', 'tor-browser');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
writeFileSync(
  join(profile, 'user.js'),
  [`user_pref("marionette.port", ${port});`, `user_pref("remote.prefs.recommended", false);`, `user_pref("toji.tor.autostart", false);`].join('\n') + '\n'
);
// Headless unless HEADED=1, so test windows never land on the user's screen.
const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
});
const m = await Marionette.open(port);
await m.session();

const MODULES = `
  const { TojiTor } = ChromeUtils.importESModule("resource:///modules/toji/TojiTor.sys.mjs");
  const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
`;

async function handles(): Promise<string[]> {
  const r = await m.send('WebDriver:GetWindowHandles');
  return Array.isArray(r) ? r : (r?.value ?? []);
}

/**
 * Opens a window in `containerId` at `url`; resolves to its tab's Marionette
 * handle — the one handle that wasn't there before (handles are Marionette's
 * own ids, not browserIds).
 */
async function openIn(containerId: string, url: string): Promise<string> {
  const before = new Set(await handles());
  await m.context('chrome');
  await m.execAsync(
    `${MODULES}
     const [containerId, url, done] = arguments;
     const win = await TojiWindows.openContainerWindow(containerId, { urls: [url] });
     await new Promise(r => win.addEventListener("load", r, { once: true }));
     await new Promise(r => setTimeout(r, 500));
     done(true);`,
    [containerId, url],
    60000
  );
  const added = (await handles()).filter((h) => !before.has(h));
  if (added.length !== 1) throw new Error(`expected one new window handle, got ${added.length}`);
  return added[0];
}

/** Waits for the tab to finish loading and returns its text (or the error page's). */
async function textOf(handle: string, timeoutMs = 90000): Promise<{ url: string; text: string }> {
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });
  await m.context('content');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await m.exec<{ state: string; url: string; text: string }>(
      'return { state: document.readyState, url: document.documentURI, text: document.body ? document.body.innerText : "" }'
    );
    if ((r.state === 'complete' && r.text.trim()) || Date.now() > deadline) return r;
    await Bun.sleep(1000);
  }
}

try {
  await m.context('chrome');
  await m.exec(`${MODULES}
    TojiTor.stop();
    const list = TojiContainers.list();
    if (!list.some(c => c.id === "tor-two")) {
      return TojiContainers.replaceAll([...list, { id: "tor-two", name: "Tor two", color: "#06b6d4", egress: "tor", ephemeral: false }]);
    }`);

  // 1. Fail-closed.
  const closed = await textOf(await openIn('onion', CHECK), 30000);
  say(!/"IsTor"/.test(closed.text), 'tor off: a Tor container cannot reach the web', closed.url.slice(0, 80));

  // 2. Isolation.
  await m.context('chrome');
  const ready = await m.execAsync<boolean>(
    `${MODULES} const done = arguments[0]; await TojiTor.start(); done(await TojiTor.whenReady(180000));`,
    [],
    200000
  );
  say(ready, 'tor starts and bootstraps inside the browser');
  const a = await textOf(await openIn('onion', CHECK));
  const b = await textOf(await openIn('tor-two', CHECK));
  const direct = await textOf(await openIn('personal', CHECK));
  const ja = JSON.parse(a.text || '{}');
  const jb = JSON.parse(b.text || '{}');
  const jd = JSON.parse(direct.text || '{}');
  say(ja.IsTor === true && jb.IsTor === true, 'both Tor containers exit through tor', `${ja.IP} / ${jb.IP}`);
  say(ja.IP && jb.IP && ja.IP !== jb.IP, 'two Tor containers exit from different relays', `${ja.IP} vs ${jb.IP}`);
  say(jd.IsTor === false, 'a direct container does not use tor', jd.IP);

  // 3. .onion.
  const onion = await textOf(await openIn('onion', ONION));
  say(/duckduckgo/i.test(onion.text) || /duckduckgo/i.test(onion.url), 'a .onion loads in the Onion container', onion.url.slice(0, 80));
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll in-browser Tor checks passed.');
  process.exit(failures ? 1 : 0);
}
