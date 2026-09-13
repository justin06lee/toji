#!/usr/bin/env bun
// Phase 7 (bug reports, shortcuts, default browser, links from other apps)
// against a built Toji.app. Nothing is filed and no system setting changes:
//
//  1. A link handed over on the command line (as another app does) waits while
//     "Who's browsing?" shows, and opens in the container chosen.
//  2. An external open into a container window lands in that window's
//     container, not the default one.
//  3. ⌥⇧I and Help › Report a Bug… exist; the shortcut opens about:report beside
//     the tab with the page and window size filled in; the window still is an image.
//  4. isDefaultBrowser() answers (read-only).
//  5. Tapping Option opens the agent spotlight.
//
// Usage: bun gecko/test/phase7.ts [Toji.app]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
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

const webPort = await freePort();
const server: Server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>${req.url}</title><p>${req.url}</p>`);
});
server.listen(webPort, '127.0.0.1');
const FROM_CLI = `http://127.0.0.1:${webPort}/from-cli`;
const FROM_APP = `http://127.0.0.1:${webPort}/from-app`;

const profile = join(WORK, 'profiles', 'phase7');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
writeFileSync(join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("remote.prefs.recommended", false);\n`);
// Headless unless HEADED=1, so test windows never land on the user's screen.
const proc = Bun.spawn(
  [join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access', FROM_CLI],
  { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) } }
);
const m = await Marionette.open(port);
await m.session();

const MODULES = `
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
  const { TojiBugReport } = ChromeUtils.importESModule("resource:///modules/toji/TojiBugReport.sys.mjs");
  const { TojiPageAPI } = ChromeUtils.importESModule("resource:///modules/toji/TojiPages.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
`;

try {
  await m.context('chrome');
  await Bun.sleep(3000);

  // 1. The command-line link waits for the pick, then opens in Work.
  const held = await m.exec<{ picking: boolean; tabs: string[] }>(`${MODULES}
    const win = BrowserWindowTracker.getTopWindow();
    return {
      picking: win.document.documentElement.hasAttribute("toji-picking"),
      tabs: win.gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec),
    };`);
  say(held.picking && held.tabs.every((u) => u === 'about:blank'), 'a link from another app waits while "Who\'s browsing?" shows', held.tabs.join(', '));
  const picked = await m.execAsync<{ tabs: { url: string; uc: number }[]; work: number }>(`${MODULES}
    const [url, done] = arguments;
    const win = BrowserWindowTracker.getTopWindow();
    await TojiWindows.choose(win, "work");
    for (let i = 0; i < 40; i++) {
      if (win.gBrowser.tabs.some(t => t.linkedBrowser.currentURI.spec === url)) break;
      await new Promise(r => setTimeout(r, 250));
    }
    done({
      tabs: win.gBrowser.tabs.map(t => ({ url: t.linkedBrowser.currentURI.spec, uc: t.userContextId })),
      work: TojiContainers.byId("work").userContextId,
    });`, [FROM_CLI]);
  const opened = picked.tabs.find((t) => t.url === FROM_CLI);
  say(!!opened && opened.uc === picked.work, 'after choosing Work, it opens there, in Work', JSON.stringify(picked.tabs));

  // 2. An external open (another app's link, Toji already running).
  const external = await m.execAsync<{ url: string; uc: number; work: number }>(`${MODULES}
    const [url, done] = arguments;
    const win = BrowserWindowTracker.getTopWindow();
    win.browserDOMWindow.openURI(
      Services.io.newURI(url), null,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB, Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
      Services.scriptSecurityManager.getSystemPrincipal()
    );
    let tab = null;
    for (let i = 0; i < 40 && !tab; i++) {
      tab = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === url) ?? null;
      if (!tab) await new Promise(r => setTimeout(r, 250));
    }
    done({ url: tab?.linkedBrowser.currentURI.spec ?? "", uc: tab?.userContextId ?? -1, work: TojiContainers.byId("work").userContextId });`, [FROM_APP]);
  say(external.url === FROM_APP && external.uc === external.work, 'an external link lands in the window\'s own container', `uc ${external.uc} (Work ${external.work})`);

  // 3. The bug report: shortcut, menu item, the sheet, the still.
  const report = await m.execAsync<{ key: string | null; menu: boolean; request: { pageUrl: string | null; window: string } | null; sheet: boolean; shot: { kind: string; size: number } }>(`${MODULES}
    const done = arguments[0];
    const win = BrowserWindowTracker.getTopWindow();
    const doc = win.document;
    const key = doc.getElementById("key_tojiReportBug");
    // { type, data: Uint8Array } — the image's bytes.
    const shot = await TojiBugReport.captureWindow(win);
    const bytes = shot?.data ?? new Uint8Array();
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const size = png && shot.type === "image/png" ? bytes.length : 0;
    // The window's shell draws the sheet from what the browser hands it.
    let request = null;
    const off = win.tojiShell.onReportBug(r => (request = { pageUrl: r.pageUrl, window: r.context.window }));
    key?.doCommand();
    await new Promise(r => setTimeout(r, 1500));
    off();
    const shadow = doc.getElementById("toji-shell")?.shadowRoot;
    done({
      key: key ? key.getAttribute("modifiers") + "+" + key.getAttribute("key") : null,
      menu: !!doc.getElementById("toji-report-bug"),
      request,
      sheet: !!shadow?.querySelector('[role="dialog"]') && /report/i.test(shadow.textContent),
      shot: { kind: shot?.type ?? "null", size },
    });`);
  say(report.key === 'alt,shift+I' && report.menu, '⌥⇧I and Help › Report a Bug… are there', `${report.key}, menu ${report.menu}`);
  say(
    report.sheet && report.request?.pageUrl === FROM_APP && /\d+×\d+/.test(report.request?.window ?? ''),
    'the shortcut opens the report sheet over the window, with the page and window size',
    JSON.stringify({ sheet: report.sheet, request: report.request })
  );
  say(report.shot.size > 1000, 'the window still is a PNG', `${report.shot.kind}, ${report.shot.size} bytes`);

  // 4. Default browser, read-only.
  const isDefault = await m.execAsync<unknown>(`${MODULES} const done = arguments[0]; done(await TojiPageAPI.isDefaultBrowser());`);
  say(typeof isDefault === 'boolean', 'isDefaultBrowser() answers', String(isDefault));

  // 5. An Option tap opens the spotlight.
  const spot = await m.execAsync<{ open: boolean }>(`${MODULES}
    const done = arguments[0];
    const win = BrowserWindowTracker.getTopWindow();
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const alt = new win.KeyboardEvent("", { key: "Alt", code: "AltLeft" });
    tip.keydown(alt);
    await new Promise(r => setTimeout(r, 80));
    tip.keyup(alt);
    await new Promise(r => setTimeout(r, 600));
    const shadow = win.document.getElementById("toji-shell")?.shadowRoot;
    done({ open: !!shadow?.querySelector('input[placeholder^="Tell the agent"]') });`);
  say(spot.open, 'tapping Option opens the agent spotlight');
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll phase 7 checks passed.');
  process.exit(failures ? 1 : 0);
}
