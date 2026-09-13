#!/usr/bin/env bun
// Phase 4 (Toji's pages) against a built Toji.app, driven over Marionette:
//
//  1. about:settings, about:welcome, about:plans, about:start and about:report
//     load, render, and get window.toji (with its platform).
//  2. window.toji round-trips: containers() lists the built-ins, and
//     saveContainers(containers()) stores the same list back.
//  3. New tabs open about:start.
//  4. A web page gets no window.toji.
//
// Screenshots land in gecko/.work/phase4/. Usage: bun gecko/test/phase4.ts [Toji.app]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'phase4');
const app = resolve(process.argv.slice(2).find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const PAGES = ['settings', 'welcome', 'plans', 'start', 'report'];

let failures = 0;
const say = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

const freePort = () =>
  new Promise<number>((ok) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

// A plain web page, to check that window.toji stays out of the web.
const webPort = await freePort();
const server: Server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>web</title><p>an ordinary web page</p>');
});
server.listen(webPort, '127.0.0.1');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'phase4');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
writeFileSync(join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("remote.prefs.recommended", false);\n`);
// Headless unless HEADED=1, so test windows never land on the user's screen.
const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
});
const m = await Marionette.open(port);
await m.session();

const MODULES = `
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
`;
const shot = async (name: string) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));

/**
 * Waits until the page has rendered (some text, or a text field: the start page
 * is little more than a search box); returns what it shows.
 */
async function rendered(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await m.exec<{ url: string; text: string; fields: number; toji: string; platform: string | null }>(`
      return {
        url: document.documentURI,
        text: document.body ? document.body.innerText.trim() : "",
        fields: document.querySelectorAll("input, textarea").length,
        toji: typeof window.toji,
        platform: window.toji ? window.toji.platform : null,
      };`);
    if (r.text.length > 20 || r.fields > 0 || Date.now() > deadline) return r;
    await Bun.sleep(500);
  }
}

try {
  // The first window asks "Who's browsing?"; choose Personal so tabs load.
  await m.context('chrome');
  await Bun.sleep(3000);
  const handle = await m.execAsync<string>(`${MODULES}
    const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
    const done = arguments[0];
    await TojiWindows.choose(BrowserWindowTracker.getTopWindow(), "personal");
    await new Promise(r => setTimeout(r, 800));
    // Choosing can replace the picker's tab, so drive whatever tab is in front now.
    done(NavigableManager.getIdForBrowser(BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser));`);
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });

  // 1. Each page.
  await m.context('content');
  for (const page of PAGES) {
    try {
      await m.navigate(`about:${page}`);
    } catch (e) {
      say(false, `about:${page} loads`, (e as Error).message);
      continue;
    }
    const r = await rendered();
    say(r.url.startsWith(`about:${page}`) && (r.text.length > 20 || r.fields > 0), `about:${page} renders`, `${r.text.length} chars, ${r.fields} fields`);
    say(r.toji === 'object' && r.platform === 'darwin', `about:${page} has window.toji`, `${r.toji}, ${r.platform}`);
    await shot(page);
  }

  // 2. Round-trip through window.toji on about:settings.
  await m.navigate('about:settings');
  await rendered();
  const trip = await m.execAsync<{ before: string[]; after: string[] }>(`
    const done = arguments[0];
    const before = await window.toji.containers();
    await window.toji.saveContainers(before);
    const after = await window.toji.containers();
    done({ before: before.map(c => c.id), after: after.map(c => c.id) });`);
  say(['personal', 'work', 'shopping', 'private', 'onion'].every((id) => trip.before.includes(id)), 'containers() lists the built-ins', trip.before.join(', '));
  say(trip.after.join(',') === trip.before.join(','), 'saveContainers(containers()) keeps the same list', trip.after.join(', '));

  // 3. New tabs open the start page.
  await m.context('chrome');
  const newTab = await m.execAsync<string>(`
    const done = arguments[0];
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.BrowserCommands.openTab();
    await new Promise(r => setTimeout(r, 1500));
    done(win.gBrowser.selectedBrowser.currentURI.spec);`);
  say(newTab === 'about:start', '⌘T opens about:start', newTab);

  // 4. The web gets nothing.
  await m.context('content');
  await m.navigate(`http://127.0.0.1:${webPort}/`);
  const web = await m.exec<string>('return typeof window.toji');
  say(web === 'undefined', 'a web page has no window.toji', web);
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll page checks passed.');
  process.exit(failures ? 1 : 0);
}
