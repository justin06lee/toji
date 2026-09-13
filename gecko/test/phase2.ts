#!/usr/bin/env bun
// Phase 2 (containers) against a built Toji.app, driven over Marionette:
//
//  1. A new window shows the "Who's browsing?" picker and loads nothing.
//  2. Choosing Work binds the window; new tabs get Work's userContextId.
//  3. A private window nobody chose a container for is Private.
//  4. A cookie set in Private is gone once Private's last window closes.
//  5. Clear container removes Work's cookies.
//  6. toji-containers.json holds the five built-in containers with identities.
//
// A tiny local server sets the cookies. Usage: bun gecko/test/phase2.ts [Toji.app]

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'phase2');
const app = resolve(process.argv.slice(2).find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));

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

// Sets a cookie named after the query, so each container's jar can be checked.
const cookiePort = await freePort();
const server: Server = createServer((req, res) => {
  const name = new URL(req.url ?? '/', 'http://x').searchParams.get('c') ?? 'toji';
  res.setHeader('Set-Cookie', `${name}=1; Path=/; Max-Age=3600`);
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>cookie ${name}</title><p>set ${name}</p>`);
});
server.listen(cookiePort, '127.0.0.1');

mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'phase2');
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
await m.context('chrome');

const MODULES = `
  const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
`;
const shot = async (name: string) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));
const cookies = (host: string, attrs: Record<string, number>) =>
  m.exec<string[]>(`return Services.cookies.getCookiesFromHost(arguments[0], arguments[1]).map(c => c.name);`, [host, attrs]);

try {
  await Bun.sleep(3000);
  // 1. The picker.
  const picker = await m.exec<{ picking: boolean; picker: boolean; tabs: string[] }>(`${MODULES}
    const win = BrowserWindowTracker.getTopWindow();
    return {
      picking: win.document.documentElement.hasAttribute("toji-picking"),
      // "Who's browsing?" is drawn by the window's shell, in its shadow root.
      picker: (win.document.getElementById("toji-shell")?.shadowRoot?.textContent ?? "").includes("Who’s browsing?"),
      tabs: win.gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec),
    };`);
  say(picker.picking && picker.picker, 'a new window shows "Who’s browsing?"');
  say(picker.tabs.every((u) => u === 'about:blank'), 'it loads nothing until a profile is chosen', picker.tabs.join(', '));
  await shot('picker');

  // 2. Choose Work.
  const work = await m.execAsync<{ container: string; uc: number; tabUcs: number[] }>(`${MODULES}
    const done = arguments[0];
    const win = BrowserWindowTracker.getTopWindow();
    await TojiWindows.choose(win, "work");
    await new Promise(r => setTimeout(r, 800));
    win.BrowserCommands.openTab();
    await new Promise(r => setTimeout(r, 800));
    done({
      container: TojiWindows.containerOf(win),
      uc: TojiContainers.byId("work").userContextId,
      tabUcs: win.gBrowser.tabs.map(t => t.userContextId),
    });`);
  say(work.container === 'work', 'choosing Work binds the window', work.container);
  say(work.tabUcs.length >= 2 && work.tabUcs.every((u) => u === work.uc), 'every tab, including ⌘T, gets Work’s userContextId', `${work.tabUcs} vs ${work.uc}`);
  await shot('work');

  // Work sets a cookie in its own jar.
  await m.execAsync(
    `const [url, done] = arguments;
     const win = Services.wm.getMostRecentWindow("navigator:browser");
     win.gBrowser.selectedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     setTimeout(done, 1500);`,
    [`http://127.0.0.1:${cookiePort}/?c=work`]
  );
  say((await cookies('127.0.0.1', { userContextId: work.uc })).includes('work'), 'Work keeps its own cookie');

  // 3. A private window with no container named is Private.
  const priv = await m.execAsync<{ container: string; private: boolean; uc: number; tabUc: number }>(`${MODULES}
    const [url, done] = arguments;
    const win = BrowserWindowTracker.openWindow({ private: true });
    await new Promise(r => Services.obs.addObserver(function o(s) { if (s === win) { Services.obs.removeObserver(o, "browser-delayed-startup-finished"); r(); } }, "browser-delayed-startup-finished"));
    win.gBrowser.selectedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    await new Promise(r => setTimeout(r, 1500));
    done({
      container: TojiWindows.containerOf(win),
      private: PrivateBrowsingUtils.isWindowPrivate(win),
      uc: TojiContainers.byId("private").userContextId,
      tabUc: win.gBrowser.selectedTab.userContextId,
    });`,
    [`http://127.0.0.1:${cookiePort}/?c=private`]
  );
  say(priv.container === 'private' && priv.private && priv.tabUc === priv.uc, '⌘⇧N gives a Private window', JSON.stringify(priv));
  const privAttrs = { userContextId: priv.uc, privateBrowsingId: 1 };
  say((await cookies('127.0.0.1', privAttrs)).includes('private'), 'Private has its cookie while open');
  say(!(await cookies('127.0.0.1', { userContextId: work.uc })).includes('private'), 'Work never sees Private’s cookie');

  // 4. Close Private: its data is wiped.
  await m.execAsync(`${MODULES}
    const done = arguments[0];
    const win = BrowserWindowTracker.orderedWindows.find(w => TojiWindows.containerOf(w) === "private");
    win.close();
    setTimeout(done, 2500);`);
  say((await cookies('127.0.0.1', privAttrs)).length === 0, 'closing Private’s last window wipes it');

  // 5. Clear container. Work's tabs reload after a clear, so the tab first
  // leaves the page that sets the cookie.
  await m.execAsync(`${MODULES}
    const done = arguments[0];
    const win = BrowserWindowTracker.orderedWindows.find(w => TojiWindows.containerOf(w) === "work");
    for (const tab of win.gBrowser.tabs) {
      tab.linkedBrowser.fixupAndLoadURIString("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }
    await new Promise(r => setTimeout(r, 800));
    await TojiContainers.clear("work");
    setTimeout(done, 1000);`);
  say((await cookies('127.0.0.1', { userContextId: work.uc })).length === 0, 'Clear container empties Work’s cookie jar');

  // 6. The stored list.
  const stored = JSON.parse(readFileSync(join(profile, 'toji-containers.json'), 'utf8'));
  const ids = stored.containers.map((c: { id: string }) => c.id);
  say(['personal', 'work', 'shopping', 'private', 'onion'].every((id) => ids.includes(id)), 'the five built-in containers are stored', ids.join(', '));
  say(stored.containers.every((c: { userContextId?: number }) => (c.userContextId ?? 0) > 0), 'each has a Gecko identity');
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll container checks passed.');
  process.exit(failures ? 1 : 0);
}
