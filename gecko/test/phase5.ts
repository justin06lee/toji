#!/usr/bin/env bun
// Phase 5 (agent server, AI pages, web agent) against a built Toji.app:
//
//  1. The agent server sidecar starts, answers /health, and refuses requests
//     without this launch's token.
//  2. /api/agents answers (which backends the machine has).
//  3. toji: is Toji's own: an unknown toji: page shows Toji's error, and a web
//     page can't navigate to toji: at all.
//  4. The agent spotlight opens in a window's chrome.
//  5. With --live only (it sends one question through the configured model):
//     an answer page streams in under its toji://ask address.
//
// Screenshots land in gecko/.work/phase5/. Usage: bun gecko/test/phase5.ts [Toji.app] [--live]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'phase5');
const args = process.argv.slice(2);
const app = resolve(args.find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const LIVE = args.includes('--live');

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

// A web page that tries to send itself to toji:.
const webPort = await freePort();
const server: Server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>web</title><p>web page</p>');
});
server.listen(webPort, '127.0.0.1');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'phase5');
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
  const { TojiAgentServer } = ChromeUtils.importESModule("resource:///modules/toji/TojiAgentServer.sys.mjs");
  const { TojiAgent } = ChromeUtils.importESModule("resource:///modules/toji/TojiAgent.sys.mjs");
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
`;
const shot = async (name: string) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));

/** Loads `url` in the front tab from chrome (as the address bar would) and waits. */
async function load(url: string, waitMs: number) {
  await m.context('chrome');
  await m.execAsync(
    `${MODULES}
     const [url, waitMs, done] = arguments;
     const win = BrowserWindowTracker.getTopWindow();
     win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     setTimeout(done, waitMs);`,
    [url, waitMs],
    waitMs + 30000
  );
}

try {
  await m.context('chrome');
  await Bun.sleep(3000);
  const handle = await m.execAsync<string>(`${MODULES}
    const done = arguments[0];
    await TojiWindows.choose(BrowserWindowTracker.getTopWindow(), "personal");
    await new Promise(r => setTimeout(r, 800));
    done(NavigableManager.getIdForBrowser(BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser));`);
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });

  // 1-2. The server.
  await m.context('chrome');
  const srv = await m.execAsync<Record<string, unknown>>(`${MODULES}
    const done = arguments[0];
    const info = await TojiAgentServer.whenReady(30000);
    const r = { ready: !!info };
    if (info) {
      const health = await TojiAgentServer.fetch("/health");
      r.health = health.status;
      const bare = await fetch(info.url + "/api/agents");
      r.withoutToken = bare.status;
      const agents = await TojiAgentServer.fetch("/api/agents");
      r.agents = agents.status;
      try { r.agentsBody = JSON.stringify(await agents.json()).slice(0, 300); } catch {}
    }
    done(r);`, [], 60000);
  say(srv.ready === true && srv.health === 200, 'the agent server starts and answers /health', `health ${srv.health}`);
  say(srv.withoutToken === 401 || srv.withoutToken === 403, 'the API refuses a request without the token', `status ${srv.withoutToken}`);
  say(srv.agents === 200, '/api/agents answers', String(srv.agentsBody ?? srv.agents));

  // 3. toji: stays Toji's. Driven from chrome: toji: is registered in the parent
  // process only, and a content-side navigation to it can stall Marionette.
  await load('toji://nothing', 2500);
  await m.context('chrome');
  const unknown = await m.exec<{ tab: string; title: string; console: string[] }>(`${MODULES}
    const b = BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser;
    return {
      tab: b.currentURI.spec,
      title: b.contentTitle,
      console: Services.console.getMessageArray()
        .map(m => m.message || m.errorMessage || "")
        .filter(s => /data:|toji/i.test(s)).slice(-4),
    };`);
  say(
    unknown.tab.startsWith('toji://nothing') && unknown.title === 'Toji',
    'an unknown toji: page shows Toji\'s own error page',
    `tab ${unknown.tab} "${unknown.title}" ${unknown.console.join(' | ').slice(0, 200)}`
  );
  // The ask path reaches the agent server. An empty question gets the server's
  // blank "Toji" page at once, with no model call.
  await load('toji://ask?q=', 3000);
  await m.context('chrome');
  const empty = await m.exec<{ tab: string; title: string }>(`${MODULES}
    const b = BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser;
    return { tab: b.currentURI.spec, title: b.contentTitle };`);
  say(empty.tab.startsWith('toji://ask') && empty.title === 'Toji', 'toji://ask reaches the agent server under its own address', `tab ${empty.tab} "${empty.title}"`);
  await load(`http://127.0.0.1:${webPort}/`, 1500);
  await m.context('chrome');
  const fromWeb = await m.execAsync<{ threw: string | null; tab: string }>(`${MODULES}
    const [webOrigin, done] = arguments;
    const b = BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser;
    let threw = null;
    try {
      b.loadURI(Services.io.newURI("toji://ask?q=hello"), {
        triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipalFromOrigin(webOrigin),
      });
    } catch (e) { threw = String(e.name || e); }
    await new Promise(r => setTimeout(r, 2000));
    done({ threw, tab: b.currentURI.spec });`, [`http://127.0.0.1:${webPort}`]);
  say(!fromWeb.tab.startsWith('toji:'), 'a web page cannot navigate to toji:', `${fromWeb.threw ?? 'no throw'}; tab ${fromWeb.tab}`);

  // 4. The spotlight.
  await m.context('chrome');
  const spot = await m.exec<{ open: boolean; ids: string[] }>(`${MODULES}
    const win = BrowserWindowTracker.getTopWindow();
    TojiAgent.openSpotlight(win);
    const found = [...win.document.querySelectorAll("[id^='toji-']")].map(e => e.id);
    return { open: found.some(id => /spotlight/.test(id)), ids: found };`);
  say(spot.open, 'the agent spotlight opens', spot.ids.join(', '));
  await Bun.sleep(500);
  await shot('spotlight');
  await m.exec(`${MODULES} TojiAgent.closeSpotlight(BrowserWindowTracker.getTopWindow()); return true;`);

  // 5. A live answer page.
  if (LIVE) {
    await load(`toji://ask?q=${encodeURIComponent('What is the capital of France? One sentence.')}`, 45000);
    await m.context('content');
    const page = await m.exec<{ url: string; text: string }>('return { url: document.documentURI, text: document.body ? document.body.innerText : "" }');
    say(page.url.startsWith('toji://ask') && !page.url.includes('token'), 'the answer page keeps its toji://ask address, no token', page.url.slice(0, 80));
    say(/paris/i.test(page.text), 'the answer streams in', page.text.slice(0, 120).replace(/\s+/g, ' '));
    await m.context('chrome');
    await shot('answer');
  } else {
    console.log('SKIP  live answer page (run with --live; it sends one question to the configured model)');
  }
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll agent checks passed.');
  process.exit(failures ? 1 : 0);
}
