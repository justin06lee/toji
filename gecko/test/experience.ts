#!/usr/bin/env bun
// The Electron app's experience on Gecko, checked against a built Toji.app over
// Marionette, through the shell itself where it can be (real clicks and holds on its
// buttons, real keys into its address bar), headless.
//
//  1. Containers are Toji's own: Firefox's container feature is off, Toji numbers them.
//  2. Nothing Firefox draws shows in the window; Firefox's pages go to Toji's.
//  3. Shift+Enter on an address opens it (only a question becomes an answer page).
//  4. Hold-to-Tor keeps the window's place, size, tabs, tab in front and groups, shows
//     Tor mode, and wakes no background tab; holding again comes back.
//  5. Groups: a duplicated tab keeps its group; a group left empty goes.
//  6. Reset context: the tab in a throwaway identity of its own, cookies gone.
//  7. The agent never drives Toji's own privileged pages.
//  8. The start page's Go button knows Tor mode (hold-to-Tor lives there too).
//  9. Side tabs: the collapsed sidebar peeks on hover.
// 10. A popup a page opens is just the page.
//
// Screenshots land in gecko/.work/experience/. Usage: bun gecko/test/experience.ts [Toji.app]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'experience');
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
  const name = (req.url ?? '/').replace(/[^a-z]/g, '') || 'home';
  if (name === 'setcookie') res.setHeader('Set-Cookie', 'toji=1; Path=/; SameSite=Lax');
  res.setHeader('Content-Type', 'text/html');
  const cookie = req.headers.cookie ?? '';
  const body =
    name === 'popup'
      ? `<button id="open" style="margin:40px;font-size:24px" onclick="window.open('/beta','signin','width=520,height=420')">Open</button>`
      : `<p style="margin:40px">page ${name}</p>`;
  res.end(`<title>${name === 'cookie' || name === 'setcookie' ? `cookie:${cookie}` : `Page ${name}`}</title><body style="margin:0;background:#dbeafe;font:24px sans-serif">${body}`);
});
server.listen(webPort, '127.0.0.1');
const page = (name: string) => `http://127.0.0.1:${webPort}/${name}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'experience');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
// Tor stays off: a Tor window's pages fail closed, which is all these checks need.
writeFileSync(
  join(profile, 'user.js'),
  [`user_pref("marionette.port", ${port});`, 'user_pref("remote.prefs.recommended", false);', 'user_pref("toji.onboarded", true);', 'user_pref("toji.tor.autostart", false);', ''].join('\n')
);
const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
});
const m = await Marionette.open(port);
await m.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } } });

const shot = async (name: string) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));
// The browser window (not a popup), whichever it currently is: hold-to-Tor replaces it.
const WIN = `const win = [...Services.wm.getEnumerator("navigator:browser")].reverse().find(w => !w.closed && w.toolbar.visible); const doc = win.document; const shell = doc.getElementById("toji-shell")?.shadowRoot; const host = win.tojiShell;`;
const exec = <T,>(body: string, args: unknown[] = []) => m.exec<T>(`${WIN} ${body}`, args);

/** Polls a chrome-context expression until it is truthy (or times out); returns its last value. */
async function until<T>(expr: string, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await exec<T>(`return (${expr});`).catch(() => null as T);
    if (v || Date.now() > deadline) return v;
    await Bun.sleep(250);
  }
}

/** Mouse input at an element of the shell's, through the window's own hit testing. */
async function mouse(css: string, type: 'mousemove' | 'mousedown' | 'mouseup', buttons: number) {
  const ok = await exec<boolean | string>(
    `const el = shell.querySelector(arguments[0]);
    if (!el) return "no " + arguments[0];
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (arguments[1] === "mousedown") {
      const hit = shell.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit))) return "covered by " + (hit ? hit.outerHTML.slice(0, 80) : "nothing");
    }
    win.synthesizeMouseEvent(arguments[1], x, y, { button: 0, buttons: arguments[2], clickCount: 1, modifiers: 0 }, { isDOMEventSynthesized: true });
    return true;`,
    [css, type, buttons]
  );
  if (ok !== true) throw new Error(`${type} ${css}: ${ok}`);
}
async function click(css: string) {
  await mouse(css, 'mousemove', 0);
  await mouse(css, 'mousedown', 1);
  await mouse(css, 'mouseup', 0);
  await Bun.sleep(150);
}
/** Types into the shell's omnibox; `enter` presses Enter after it, with Shift if asked. */
async function typeOmnibox(text: string, enter: 'plain' | 'shift' | null = 'plain') {
  await click('input[aria-label="Search"]');
  await exec(
    `const input = shell.querySelector('input[aria-label="Search"]');
    input.select();
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const press = init => { const ev = new win.KeyboardEvent("", init); tip.keydown(ev); tip.keyup(ev); };
    for (const ch of arguments[0]) press({ key: ch });
    const shift = new win.KeyboardEvent("", { key: "Shift", code: "ShiftLeft", keyCode: 16 });
    if (arguments[1] === "shift") tip.keydown(shift);
    if (arguments[1]) press({ key: "Enter", code: "Enter", keyCode: 13 });
    if (arguments[1] === "shift") tip.keyup(shift);`,
    [text, enter]
  );
  await Bun.sleep(150);
}
const load = (url: string) => exec(`win.gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [url]);
const selectedUrl = () => exec<string>(`return win.gBrowser.selectedBrowser.currentURI.spec;`);
/** Marionette's window is the one hold-to-Tor closed: follow the browser window. */
async function followWindow() {
  // The old window is gone; every handle left belongs to the window that replaced it.
  const handles = await m.send<string[] | { value: string[] }>('WebDriver:GetWindowHandles', {});
  const list = Array.isArray(handles) ? handles : handles.value;
  await m.send('WebDriver:SwitchToWindow', { handle: list[0], focus: false });
  await m.context('chrome');
}

try {
  await m.context('chrome');
  await until('win && win.gBrowser && shell && shell.querySelector(".toji-shell")', 30000);
  await exec(`win.resizeTo(1280, 800);`);
  await until('shell.textContent.includes("Who’s browsing?")');
  await click('main[aria-labelledby="profile-picker-title"] button');
  await until('host.state().containerId === "personal"');

  // 1. Toji's own containers.
  const ids = await exec<{ enabled: boolean; ucids: number[]; tab: number; personal: number; firefoxKnows: string[] }>(
    `const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
    const { ContextualIdentityService } = ChromeUtils.importESModule("resource://gre/modules/ContextualIdentityService.sys.mjs");
    const list = TojiContainers.list();
    const ucids = new Set(list.map(c => c.userContextId));
    return {
      enabled: Services.prefs.getBoolPref("privacy.userContext.enabled"),
      ucids: list.map(c => c.userContextId),
      tab: win.gBrowser.selectedTab.userContextId,
      personal: list.find(c => c.id === "personal").userContextId,
      firefoxKnows: ContextualIdentityService.getPublicIdentities().filter(i => ucids.has(i.userContextId)).map(i => i.name || i.l10nId),
    };`
  );
  say(
    !ids.enabled && ids.ucids.every((n) => n >= 10000 && n < 1000000) && ids.tab === ids.personal && ids.firefoxKnows.length === 0,
    "containers are Toji's own: numbered by Toji, unknown to Firefox's identity service, its container feature off",
    JSON.stringify(ids)
  );

  // 2. Nothing Firefox draws shows; its pages go to Toji's.
  await load(page('alpha'));
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page alpha"`);
  await Bun.sleep(600);
  const audit = await exec<string[]>(
    `// Everything with a box on screen that isn't the shell, a page (a <browser>), the
    // traffic lights' box, or merely a container holding one of those.
    const allowed = [doc.getElementById("toji-shell"), doc.getElementById("toji-window-buttons"), doc.getElementById("toji-prompt-anchor"), ...doc.querySelectorAll("browser")].filter(Boolean);
    const shown = el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = win.getComputedStyle(el);
      return s.visibility === "visible" && s.display !== "none" && Number(s.opacity) > 0;
    };
    const paints = el => {
      const s = win.getComputedStyle(el);
      const bg = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
      const border = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth) > 0 && s.borderTopStyle !== "none";
      const text = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      const image = s.backgroundImage !== "none" || s.listStyleImage !== "none" || ["image", "img", "canvas", "svg"].includes(el.localName);
      return bg || border || text || image || s.boxShadow !== "none" || s.appearance !== "none";
    };
    const out = [];
    for (const el of doc.querySelectorAll("*")) {
      // The shell, a page, and what merely holds them (which paints only the window's
      // background, the shell's colour — toji.css).
      if (allowed.some(a => a === el || a.contains(el) || el.contains(a))) continue;
      // Closed popups and non-visual elements.
      if (el.closest("menupopup, panel, tooltip, popupset, keyset, commandset, broadcasterset, template, script, style, link, linkset")) continue;
      if (shown(el) && paints(el)) out.push(el.localName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : ""));
    }
    return out.slice(0, 20);`
  );
  say(audit.length === 0, 'nothing Firefox draws has a box on screen: the window is the shell and the page', JSON.stringify(audit));
  // Toji's pages are the ones whose assets come from chrome://toji/content/pages/.
  // The tab's title arrives after the page's script runs; wait for the page's own.
  const tojiPage = (url: string, title: RegExp) =>
    until<string>(
      `(() => { const t = shell.querySelector("[data-testid=top-tab][data-active]")?.textContent; return win.gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && win.gBrowser.selectedBrowser.contentDocument?.documentElement?.innerHTML.includes("chrome://toji/content/pages/") && ${title}.test(t ?? "") && t; })()`
    );
  await typeOmnibox('about:preferences');
  const prefs = await tojiPage('about:preferences', /Settings/);
  await load('about:home');
  const home = await tojiPage('about:home', /New Tab/);
  say(/Settings/.test(prefs ?? '') && /New Tab/.test(home ?? ''), "Firefox's own pages are Toji's: about:preferences is Settings, about:home the start page", JSON.stringify({ prefs, home }));

  // 3. Shift+Enter on an address opens it.
  await typeOmnibox(page('beta'), 'shift');
  const shifted = await until<string>(`win.gBrowser.selectedBrowser.contentTitle === "Page beta" && win.gBrowser.selectedBrowser.currentURI.spec`);
  say(shifted === page('beta'), 'Shift+Enter on an address opens it, as the Electron app did', String(shifted || (await selectedUrl())));

  // 7. The agent never drives Toji's privileged pages (checked here, while in a direct window).
  await load('about:settings');
  await until(`win.gBrowser.selectedBrowser.currentURI.spec.startsWith("about:settings") && win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal`);
  const refused = await m.execAsync<string>(
    `${WIN}
    const actor = win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("TojiAgent");
    try { await actor.act("info"); __done("answered"); } catch (e) { __done("refused: " + (e.message || e)); }`,
    [],
    20000
  );
  const lib = await exec<boolean>(`return ChromeUtils.importESModule("resource:///modules/toji/lib/agent.sys.mjs").isBlankPage("about:settings");`);
  say(/refused/.test(refused) && lib, "the agent can't read or drive Settings (the loop treats it as no page; the page side refuses)", refused);

  // 8. The start page's Go button knows Tor mode.
  await load('about:start');
  const startGo = await until<string>(`win.gBrowser.selectedBrowser.contentDocument?.querySelector('button[aria-label^="Go"]')?.getAttribute("aria-label")`);
  say(startGo === 'Go. Hold for Tor mode', "the start page's Go button holds for Tor mode, as in the Electron app", String(startGo));

  // 5. Groups: kept by a duplicated tab, gone when empty.
  await load(page('alpha'));
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page alpha"`);
  const groupId = await exec<string>(`return host.createGroup([host.state().selectedId]);`);
  await exec(`host.duplicate(host.state().selectedId);`);
  const dup = await until<{ tabs: number; grouped: number; groups: number }>(
    `(() => { const s = host.state(); const g = s.tabs.filter(t => t.groupId === ${JSON.stringify(groupId)}).length; return g === 2 && { tabs: s.tabs.length, grouped: g, groups: s.groups.length }; })()`
  );
  say(Boolean(dup), 'a duplicated tab keeps its group (kept with the session, not in the shell)', JSON.stringify(dup));
  await exec(`host.close(host.state().selectedId);`);
  const kept = await until<boolean>(`host.state().groups.some(g => g.id === ${JSON.stringify(groupId)})`);
  say(Boolean(kept), 'closing one of its tabs leaves the group');

  // 4. Hold-to-Tor, seamless: alpha (grouped) | start page | beta (in front).
  await exec(`host.newTab();`);
  await Bun.sleep(300);
  await exec(`host.openTab(arguments[0]);`, [page('beta')]);
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page beta"`);
  // The new tabs joined no group: host.openTab from a grouped tab would have; ungroup them.
  await exec(`for (const t of host.state().tabs) if (t.id !== host.state().tabs[0].id) host.setTabGroup(t.id, null);`);
  const before = await exec<{ frame: number[]; tabs: string[]; selected: number; groups: (string | null)[] }>(
    `const s = host.state();
    return { frame: [win.screenX, win.screenY, win.outerWidth, win.outerHeight], tabs: s.tabs.map(t => t.url), selected: s.tabs.findIndex(t => t.id === s.selectedId), groups: s.tabs.map(t => t.groupId) };`
  );
  await mouse('button[aria-label^="Go"]', 'mousemove', 0);
  await mouse('button[aria-label^="Go"]', 'mousedown', 1);
  await Bun.sleep(400);
  await shot('holding');
  await Bun.sleep(900);
  await mouse('button[aria-label^="Go"]', 'mouseup', 0).catch(() => {});
  await Bun.sleep(1500);
  await followWindow();
  await until('win && host && host.state().container?.egress === "tor"', 20000);
  const after = await exec<{ frame: number[]; tabs: string[]; selected: number; groups: (string | null)[]; windows: number; private: boolean; label: string; lazy: boolean[] }>(
    `const s = host.state();
    return {
      frame: [win.screenX, win.screenY, win.outerWidth, win.outerHeight],
      tabs: s.tabs.map(t => t.url),
      selected: s.tabs.findIndex(t => t.id === s.selectedId),
      groups: s.tabs.map(t => t.groupId ? "grouped" : null),
      windows: [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed).length,
      private: win.document.documentElement.hasAttribute("privatebrowsingmode"),
      label: shell.querySelector('button[aria-label^="Go"]')?.getAttribute("aria-label"),
      lazy: win.gBrowser.tabs.map(t => !t.selected && !t.linkedBrowser.isConnected),
    };`
  );
  await Bun.sleep(600);
  await shot('tor-window');
  const sameFrame = before.frame.every((v, i) => Math.abs(v - after.frame[i]) <= 2);
  say(after.windows === 1 && after.private && sameFrame, 'holding Go replaces the window in place: one window, same place and size, private', JSON.stringify({ before: before.frame, after: after.frame, windows: after.windows }));
  say(
    JSON.stringify(after.tabs) === JSON.stringify(before.tabs) && after.selected === before.selected && JSON.stringify(after.groups) === JSON.stringify(before.groups.map((g) => (g ? 'grouped' : null))),
    'every tab comes along in its place, the one in front still in front, groups kept',
    JSON.stringify({ before, after: { tabs: after.tabs, selected: after.selected, groups: after.groups } })
  );
  say(after.label === 'Go. Hold to leave Tor mode', 'the window shows Tor mode (the onion Go button)', String(after.label));
  say(after.lazy.filter(Boolean).length === after.tabs.length - 1, 'the tabs behind wait until chosen (none woken)', JSON.stringify(after.lazy));
  const tempId = await exec<string>(`return host.state().containerId;`);
  await mouse('button[aria-label^="Go"]', 'mousemove', 0);
  await mouse('button[aria-label^="Go"]', 'mousedown', 1);
  await Bun.sleep(1300);
  await mouse('button[aria-label^="Go"]', 'mouseup', 0).catch(() => {});
  await Bun.sleep(1500);
  await followWindow();
  const back = await until<{ container: string; tabs: string[]; released: boolean }>(
    `(() => { const s = host.state(); if (s.containerId !== "personal") return null;
      const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
      return { container: s.containerId, tabs: s.tabs.map(t => t.url), released: !TojiContainers.byId(${JSON.stringify(tempId)}) }; })()`,
    20000
  );
  say(Boolean(back) && JSON.stringify(back.tabs) === JSON.stringify(before.tabs) && back.released, 'holding again comes back to Personal with the same tabs, and the Tor identity is wiped', JSON.stringify(back));

  // 6. Reset context.
  await exec(`host.select(host.state().tabs[0].id);`);
  // The tab slept through Tor mode; session restore wakes it on selection, and a load
  // issued before that lands is replaced by the restore (as it would be in Firefox).
  await until(`!win.gBrowser.selectedTab.hasAttribute("pending") && win.gBrowser.selectedBrowser.currentURI.spec.endsWith("/alpha") && win.gBrowser.selectedBrowser.contentTitle === "Page alpha"`);
  await load(page('setcookie'));
  await until(`win.gBrowser.selectedBrowser.contentTitle.startsWith("cookie:")`);
  await load(page('cookie'));
  const had = await until<string>(`win.gBrowser.selectedBrowser.contentTitle === "cookie:toji=1" && win.gBrowser.selectedBrowser.contentTitle`);
  const shellId = await exec<string>(`return host.state().selectedId;`);
  await exec(`host.resetContext(arguments[0]);`, [shellId]);
  const reset = await until<{ id: string; ucid: number; throwaway: boolean; title: string }>(
    `(() => { const s = host.state(); const t = s.tabs.find(t => t.id === s.selectedId);
      const b = win.gBrowser.selectedBrowser;
      return t && t.throwaway && b.contentTitle.startsWith("cookie:") && { id: t.id, ucid: win.gBrowser.selectedTab.userContextId, throwaway: t.throwaway, title: b.contentTitle }; })()`
  );
  say(
    Boolean(had) && Boolean(reset) && reset.id === shellId && reset.ucid > 1000000 && reset.title === 'cookie:',
    'Reset context reloads the tab in an identity of its own: same tab, no cookies from before',
    JSON.stringify({ had, reset })
  );
  // Closing the tab releases its identity at once (its data is wiped after).
  const released = await exec<boolean>(
    `const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
    const ucid = win.gBrowser.selectedTab.userContextId;
    host.close(host.state().selectedId);
    return !TojiContainers.byUserContextId(ucid);`
  );
  say(released, 'closing it wipes the throwaway identity');

  // 9. Side tabs: the collapsed sidebar peeks on hover.
  await exec(`host.setPref("layout", "side"); host.setPref("sidebarOpen", false);`);
  await until(`shell.querySelector("[data-testid=sidebar-peek-trigger]")`);
  await mouse('[data-testid="sidebar-peek-trigger"]', 'mousemove', 0);
  const peek = await until<boolean>(`!!shell.querySelector("[data-testid=sidebar-peek] [data-testid=sidebar]")`, 5000);
  await Bun.sleep(400);
  await shot('sidebar-peek');
  // A pointer that brought it out crosses it on the way back to the page.
  await exec(`const move = (x, y) => win.synthesizeMouseEvent("mousemove", x, y, { button: 0, buttons: 0, clickCount: 0, modifiers: 0 }, { isDOMEventSynthesized: true });
    const peek = shell.querySelector("[data-testid=sidebar-peek]").getBoundingClientRect();
    move(peek.left + peek.width / 2, peek.top + peek.height / 2);
    const r = win.gBrowser.selectedBrowser.getBoundingClientRect();
    move(r.left + r.width - 40, r.top + r.height / 2);`);
  const peekGone = await until<boolean>(`!shell.querySelector("[data-testid=sidebar-peek]")`, 5000);
  say(peek && peekGone, 'the collapsed sidebar comes out on hover at the left edge and goes again');
  await exec(`host.setPref("layout", "top"); host.setPref("sidebarOpen", true);`);

  // 10. A popup is just the page.
  await load(page('popup'));
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page popup"`);
  const handle = await exec<string>(`const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs"); return NavigableManager.getIdForBrowser(win.gBrowser.selectedBrowser);`);
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });
  await m.context('content');
  const button = await m.send<{ value: Record<string, string> } | Record<string, string>>('WebDriver:FindElement', { using: 'css selector', value: '#open' });
  const element = 'value' in button ? button.value : button;
  await m.send('WebDriver:ElementClick', { id: Object.values(element)[0] });
  await m.context('chrome');
  const popup = await until<{ frame: boolean; strip: boolean; fill: boolean; container: string }>(
    `(() => {
      const p = [...Services.wm.getEnumerator("navigator:browser")].find(w => !w.closed && !w.toolbar.visible);
      const root = p?.document.getElementById("toji-shell")?.shadowRoot;
      if (!root?.querySelector("[data-testid=popup-frame]") || p.gBrowser.selectedBrowser.contentTitle !== "Page beta") return null;
      const r = p.gBrowser.selectedBrowser.getBoundingClientRect();
      return { frame: true, strip: !!root.querySelector("[data-testid=top-tab-strip]"), fill: r.left <= 1 && r.top <= 1 && Math.abs(r.width - p.innerWidth) <= 1 && Math.abs(r.height - p.innerHeight) <= 1, container: p.tojiShell.state().containerId };
    })()`
  );
  say(Boolean(popup) && !popup.strip && popup.fill && popup.container === 'personal', "a page's popup is just the page, in its opener's profile", JSON.stringify(popup));
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
  await shot('error-state').catch(() => {});
} finally {
  const errors = await m
    .exec<string[]>(`return Services.console.getMessageArray().map(e => e.message || String(e)).filter(t => /toji|TypeError|ReferenceError/i.test(t) && !/SourceMap|Content-Security|addons\\.xpi/i.test(t)).slice(-25);`)
    .catch(() => [] as string[]);
  if (errors.length) console.log(`\nConsole:\n  ${errors.map((e) => e.slice(0, 300)).join('\n  ')}`);
  await m.quit().catch(() => {});
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll experience checks passed.');
  process.exit(failures ? 1 : 0);
}
