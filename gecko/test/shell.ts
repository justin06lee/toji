#!/usr/bin/env bun
// The window's UI is Toji's shell, not Firefox's, checked against a built Toji.app
// over Marionette. Everything is driven through the shell itself where it can be: real
// clicks on its buttons, real keys into its address bar.
//
//  1. Firefox's chrome is hidden (toolbars, sidebar, status panel); the shell is there.
//  2. "Who's browsing?" is the shell's; choosing a profile binds the window.
//  3. The first window shows Welcome once.
//  4. Typing an address into the omnibox loads it; the tab and omnibox follow the page.
//  5. The page is laid out exactly in the shell's viewport.
//  6. New tab, close tab, back, and Firefox's own address-bar focus go through the shell.
//  7. Side tabs, dark theme, the error page, the bookmark star, the agent spotlight.
//  8. The traffic lights' box, the trimmed menu bar and shortcuts.
//
// Screenshots land in gecko/.work/shell/. Usage: bun gecko/test/shell.ts [Toji.app]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'shell');
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

// Two plain pages to browse between.
const webPort = await freePort();
const server: Server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const name = (req.url ?? '/').replace(/[^a-z]/g, '') || 'home';
  const extra =
    name === 'prompt'
      ? '<script>setTimeout(() => alert("Hello from the page"), 300)</script>'
      : name === 'popup'
        ? '<script>setTimeout(() => window.open("/beta", "_blank", "popup"), 300)</script>'
        : name === 'geo'
          ? '<script>setTimeout(() => navigator.geolocation.getCurrentPosition(() => {}, () => {}), 300)</script>'
        : name === 'login'
          ? '<form action="/beta" method="get" style="margin:40px"><input id="u" name="u" autocomplete="username"><input id="p" name="p" type="password"><button>Sign in</button></form>'
          : '';
  res.end(`<title>Page ${name}</title><body style="margin:0;background:#dbeafe;font:24px sans-serif"><p style="margin:40px">page ${name}</p>${extra}`);
});
server.listen(webPort, '127.0.0.1');
const page = (name: string) => `http://127.0.0.1:${webPort}/${name}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'shell');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
writeFileSync(join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("remote.prefs.recommended", false);\n`);
const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
});
const m = await Marionette.open(port);
await m.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } } });

const shot = async (name: string) => writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));
const WIN = `const win = Services.wm.getMostRecentWindow("navigator:browser"); const doc = win.document; const shell = doc.getElementById("toji-shell")?.shadowRoot;`;

// Marionette's element commands work only in content, so input goes in the way a
// person's would reach the shell: mouse events at the element's centre, through the
// window's own hit testing (which also proves the page-through regions are right), and
// key events from a text input processor into whatever has focus.
async function click(css: string) {
  const ok = await m.exec<boolean | string>(`${WIN}
    const el = shell.querySelector(arguments[0]);
    if (!el) return "no " + arguments[0];
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = shell.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) return "covered by " + (hit ? hit.outerHTML.slice(0, 80) : "nothing");
    const mouse = (type, buttons, clickCount) =>
      win.synthesizeMouseEvent(type, x, y, { button: 0, buttons, clickCount, modifiers: 0 }, { isDOMEventSynthesized: true });
    mouse("mousemove", 0, 0);
    mouse("mousedown", 1, 1);
    mouse("mouseup", 0, 1);
    return true;`, [css]);
  if (ok !== true) throw new Error(`click ${css}: ${ok}`);
  await Bun.sleep(150);
}
/** Clicks into a field and types into it; `enter` presses Enter after. */
async function type(css: string, text: string, enter = false) {
  await click(css);
  await m.exec(`${WIN}
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const press = init => {
      const ev = new win.KeyboardEvent("", init);
      tip.keydown(ev);
      tip.keyup(ev);
    };
    for (const ch of arguments[0]) press({ key: ch });
    if (arguments[1]) press({ key: "Enter", code: "Enter", keyCode: 13 });`, [text, enter]);
  await Bun.sleep(150);
}

/** Polls a chrome-context expression until it is truthy (or times out); returns its last value. */
async function until<T>(expr: string, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await m.exec<T>(`${WIN} return (${expr});`);
    if (v || Date.now() > deadline) return v;
    await Bun.sleep(250);
  }
}

try {
  await m.context('chrome');
  await until('win && win.gBrowser && shell && shell.querySelector(".toji-shell")', 30000);
  await m.exec(`${WIN} win.resizeTo(1280, 800);`);
  await Bun.sleep(800);

  // 1. Firefox's chrome is gone; the shell is there.
  const hidden = await m.exec<Record<string, string>>(`${WIN}
    const display = sel => { const el = doc.querySelector(sel); return el ? win.getComputedStyle(el).display : "absent"; };
    return { tabs: display("#TabsToolbar"), navBar: display("#nav-bar"), bookmarks: display("#PersonalToolbar"), menubar: display("#toolbar-menubar"), status: display("#statuspanel"), sidebar: display("#sidebar-container"), sidebarBox: display("#sidebar-box") };`);
  say(Object.values(hidden).every((d) => d === 'none' || d === 'absent'), "Firefox's toolbars, sidebar and status panel are hidden", JSON.stringify(hidden));
  say(Boolean(await m.exec(`${WIN} return !!shell.querySelector(".toji-shell .toji-app");`)), 'the shell is mounted in its shadow root');

  // 2. The picker is the shell's.
  const pickerText = await until<string>('shell.textContent.includes("Who’s browsing?") && shell.textContent');
  say(Boolean(pickerText), '"Who\'s browsing?" is drawn by the shell');
  await shot('picker');
  await click('main[aria-labelledby="profile-picker-title"] button');
  const bound = await until<string>('win.tojiShell.state().containerId');
  say(bound === 'personal', 'clicking a profile binds the window', String(bound));

  // 3. Welcome, once.
  const welcome = await until<string>('win.gBrowser.selectedBrowser.currentURI.spec.startsWith("about:welcome") && win.gBrowser.selectedBrowser.currentURI.spec');
  say(Boolean(welcome), 'the first window opens Welcome', String(welcome));
  const welcomeTab = await until<string>('shell.querySelector("[data-testid=top-tab][data-active]")?.textContent');
  say(welcomeTab?.includes('Welcome to Toji') ?? false, 'the tab strip names it the way the Electron app did', String(welcomeTab));
  await Bun.sleep(1200);
  await shot('welcome');

  // 4. The omnibox loads what is typed into it.
  await type('input[aria-label="Search"]', page('alpha'), true);
  const loaded = await until<string>(`win.gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(page('alpha'))} && win.gBrowser.selectedBrowser.contentTitle === "Page alpha" && "yes"`);
  say(loaded === 'yes', 'typing an address and Enter loads it in the tab in front');
  const strip = await until<{ title: string; omnibox: string }>(`(() => { const t = shell.querySelector("[data-testid=top-tab][data-active]")?.textContent ?? ""; const o = shell.querySelector('input[aria-label="Search"]').value; return t.includes("Page alpha") && { title: t, omnibox: o }; })()`);
  say(Boolean(strip) && strip.omnibox === page('alpha'), 'the tab shows the page title and the omnibox its address', JSON.stringify(strip));
  await Bun.sleep(600);
  await shot('web');

  // 5. The page sits exactly in the shell's viewport.
  const boxes = await m.exec<{ page: DOMRect; view: DOMRect }>(`${WIN}
    const r = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { page: r(win.gBrowser.selectedBrowser), view: r(shell.querySelector("[data-testid=viewport-page]")) };`);
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  say(near(boxes.page.x, boxes.view.x) && near(boxes.page.y, boxes.view.y) && near(boxes.page.width, boxes.view.width) && near(boxes.page.height, boxes.view.height), "the page fills the shell's viewport, no more and no less", JSON.stringify(boxes));

  // 6. Tabs and navigation through the shell.
  await m.exec(`${WIN} win.gBrowser.selectedBrowser.fixupAndLoadURIString(${JSON.stringify(page('beta'))}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page beta"`);
  await until(`!shell.querySelector('button[aria-label="Back"]').disabled`);
  await click('button[aria-label="Back"]');
  const back = await until<string>(`win.gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(page('alpha'))} && "yes"`);
  say(back === 'yes', 'the Back button goes back');
  const before = await m.exec<number>(`${WIN} return win.gBrowser.tabs.length;`);
  await click('[data-testid="top-new-tab"] button');
  const opened = await until<{ tabs: number; url: string }>(`win.gBrowser.tabs.length === ${before + 1} && win.gBrowser.selectedBrowser.currentURI.spec === "about:start" && { tabs: win.gBrowser.tabs.length, url: win.gBrowser.selectedBrowser.currentURI.spec }`);
  say(Boolean(opened), 'the new-tab button opens the start page in a new tab', JSON.stringify(opened));
  const focused = await until<boolean>(`shell.activeElement?.getAttribute("aria-label") === "Search"`, 5000);
  say(Boolean(focused), 'and puts the cursor in the omnibox', String(await m.exec(`${WIN} return (shell.activeElement?.outerHTML ?? doc.activeElement?.localName ?? "none").slice(0, 80);`)));
  await Bun.sleep(1200);
  await shot('newtab');
  await click('[data-testid="top-tab"][data-active] button[aria-label="Close tab"]');
  const closed = await until<number>(`win.gBrowser.tabs.length === ${before} && win.gBrowser.tabs.length`);
  say(closed === before, 'the close button closes the tab', String(closed));
  await m.exec(`${WIN} win.gBrowser.selectedBrowser.focus(); win.gURLBar.select();`);
  const refocused = await until<boolean>(`shell.activeElement?.getAttribute("aria-label") === "Search"`);
  say(Boolean(refocused), "Firefox's address-bar focus (⌘L, new windows) lands in the shell's omnibox");

  // 7. Layout, theme, errors, bookmarks, the spotlight.
  await click('button[aria-label="Bookmark this page"]');
  const starred = await until<string>(`shell.querySelector("[data-testid=bookmark-chip]")?.textContent`);
  say(starred?.includes('Page alpha') ?? false, 'the star bookmarks the page onto the bookmarks bar', String(starred));
  await click('button[aria-label="Toggle tab layout"]');
  const side = await until<{ left: number }>(`shell.querySelector("[data-testid=sidebar]") && !shell.querySelector("[data-testid=top-tab-strip]") && win.gBrowser.selectedBrowser.getBoundingClientRect().left >= 239 && { left: win.gBrowser.selectedBrowser.getBoundingClientRect().left }`, 5000);
  say(Boolean(side) && side.left >= 239, 'side tabs: the sidebar takes the left and the page moves over', JSON.stringify(side));
  await Bun.sleep(700);
  await shot('side');
  await click('button[aria-label="Toggle theme"]');
  const dark = await until<boolean>(`shell.querySelector(".toji-shell").classList.contains("dark") && Services.prefs.getStringPref("toji.theme") === "dark"`);
  say(Boolean(dark), 'the theme toggle turns the shell and the pref dark');
  await Bun.sleep(700);
  await shot('side-dark');
  await click('button[aria-label="Toggle tab layout"]');
  await click('button[aria-label="Toggle theme"]');
  // Nothing listens on a port that was free a moment ago (port 1 would be refused as unsafe).
  const deadPort = await freePort();
  await m.exec(`${WIN} win.gBrowser.selectedBrowser.fixupAndLoadURIString("http://127.0.0.1:${deadPort}/", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
  const error = await until<string>(`shell.querySelector("[data-testid=load-error]")?.textContent`);
  say(error?.includes('refused the connection') ?? false, "a failed load shows Toji's error page, not Firefox's", String(error).slice(0, 80));
  await Bun.sleep(500);
  await shot('error');
  // Firefox's own surfaces over the page, in the shell's look.
  const load = (url: string) => m.exec(`${WIN} win.gBrowser.selectedBrowser.fixupAndLoadURIString(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
  await load(page('prompt'));
  const dialog = await until<{ radius: string; body: string }>(`(() => {
    // The box holding the prompt's own document (Firefox keeps spare, empty boxes beside it).
    const frame = [...doc.querySelectorAll(".dialogFrame")].find(f => f.currentURI?.spec === "chrome://global/content/commonDialog.xhtml");
    const box = frame?.closest(".dialogBox");
    const body = frame?.contentDocument?.getElementById("infoBody")?.textContent;
    return box && body && { radius: win.getComputedStyle(box).borderTopLeftRadius, body };
  })()`);
  say(dialog?.radius === '16px' && /Hello from the page/.test(dialog.body), "a page's alert() is Firefox's prompt in the shell's look", JSON.stringify(dialog));
  await Bun.sleep(600);
  await shot('alert');
  await m.exec(`${WIN} [...doc.querySelectorAll(".dialogFrame")].forEach(f => f.contentDocument?.querySelector("dialog")?.acceptDialog?.());`);
  await load(page('popup'));
  const bar = await until<{ radius: string; text: string }>(`(() => {
    const n = [...doc.querySelectorAll("notification-message")].find(e => e.getBoundingClientRect().width > 0);
    return n && { radius: win.getComputedStyle(n).getPropertyValue("--message-bar-border-radius").trim(), text: n.textContent || n.getAttribute("message-bar-type") || "" };
  })()`);
  say(bar?.radius === '12px', 'a blocked popup is announced in a bar in the shell\'s look', JSON.stringify(bar));
  await Bun.sleep(600);
  await shot('popup-blocked');
  await m.exec(`${WIN} win.gBrowser.getNotificationBox().removeAllNotifications(true);`);

  // A permission request: Firefox's prompt, hung from the shell's address bar.
  await m.exec(`Services.console.reset();`);
  await load(page('geo'));
  const prompt = await until<{ anchor: string | null; box: { x: number; y: number } }>(`(() => {
    const n = win.PopupNotifications.getNotification("geolocation", win.gBrowser.selectedBrowser);
    if (!n) return null;
    const a = doc.getElementById("toji-prompt-anchor").getBoundingClientRect();
    const input = shell.querySelector('input[aria-label="Search"]').getBoundingClientRect();
    return { anchor: n.anchorElement?.id ?? null, box: { x: Math.round(a.x - input.x), y: Math.round(a.y - input.bottom) } };
  })()`);
  const promptErrors = await m.exec<string[]>(`return Services.console.getMessageArray().map(e => e.message || String(e)).filter(t => /PopupNotifications|getClassName/.test(t));`);
  say(prompt?.anchor === 'toji-prompt-anchor' && Math.abs(prompt.box.y) <= 10 && promptErrors.length === 0, "a page's permission request hangs from the shell's address bar", JSON.stringify({ prompt, promptErrors }));
  await m.exec(`${WIN} win.PopupNotifications.getNotification("geolocation", win.gBrowser.selectedBrowser)?.remove();`);

  // The vault's save bubble (autosave off: the shell asks), from a real form submit.
  await m.exec(`Services.prefs.setBoolPref("toji.vault.autosave", false);`);
  await load(page('login'));
  await until(`win.gBrowser.selectedBrowser.contentTitle === "Page login"`);
  const handle = await m.exec<string>(`${WIN} const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs"); return NavigableManager.getIdForBrowser(win.gBrowser.selectedBrowser);`);
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });
  await m.context('content');
  await m.exec(`document.getElementById("u").value = "alice"; document.getElementById("p").value = "correct horse"; document.forms[0].requestSubmit();`);
  await m.context('chrome');
  const bubble = await until<string>(`shell.querySelector("[data-testid=vault-prompt]")?.getAttribute("aria-label")`);
  say(/alice/.test(bubble ?? ''), 'a submitted login asks in the shell\'s save bubble', String(bubble));
  await Bun.sleep(400);
  await shot('vault-bubble');
  await click('[data-testid="vault-prompt"] button[aria-label="Not now"]');
  const gone = await until<boolean>(`!shell.querySelector("[data-testid=vault-prompt]")`);
  say(Boolean(gone), '"Not now" closes it without saving');

  // The unpinned bookmarks bar comes down when the pointer reaches the top of the page.
  await m.exec(`Services.prefs.setStringPref("browser.toolbars.bookmarks.visibility", "never");`);
  await until(`!shell.querySelector("[data-testid=bookmarks-bar]")`);
  await m.context('content');
  const pointer = (actions: unknown[]) => m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  await pointer([{ type: 'pointerMove', x: 300, y: 200, origin: 'viewport', duration: 0 }, { type: 'pointerMove', x: 300, y: 3, origin: 'viewport', duration: 50 }]);
  await m.context('chrome');
  const peek = await until<boolean>(`!!shell.querySelector("[data-testid=bookmarks-bar-peek]")`, 5000);
  say(Boolean(peek), 'hover mode: the pointer at the top of the page brings the bookmarks bar down');
  await Bun.sleep(300);
  await shot('bookmarks-peek');
  // A real pointer that brought it down is now on the bar, which covers the page's top
  // edge; it leaves through the window's own hit testing (Marionette's content actions
  // bypass that), onto the bar and then out over the page.
  await m.exec(`${WIN}
    const bar = shell.querySelector("[data-testid=bookmarks-bar-peek]").getBoundingClientRect();
    const move = (x, y) => win.synthesizeMouseEvent("mousemove", x, y, { button: 0, buttons: 0, clickCount: 0, modifiers: 0 }, { isDOMEventSynthesized: true });
    move(bar.left + 300, bar.top + bar.height / 2);
    move(bar.left + 300, bar.bottom + 200);`);
  const up = await until<boolean>(`!shell.querySelector("[data-testid=bookmarks-bar-peek]")`, 5000);
  say(Boolean(up), 'and it goes again when the pointer leaves');
  await m.exec(`Services.prefs.setStringPref("browser.toolbars.bookmarks.visibility", "always");`);

  // The page's right-click menu: the Electron app's items, not Firefox's extras.
  await m.context('content');
  await pointer([{ type: 'pointerMove', x: 600, y: 400, origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 2 }, { type: 'pointerUp', button: 2 }]);
  await m.send('WebDriver:ReleaseActions');
  await m.context('chrome');
  const menu = await until<string[]>(`(() => {
    const popup = doc.getElementById("contentAreaContextMenu");
    if (popup.state !== "open") return null;
    return [...popup.querySelectorAll("menuitem, menu")].filter(i => !i.hidden && !i.closest("[hidden]")).map(i => i.id);
  })()`, 8000);
  const unwanted = ['context-bookmarkpage', 'context-take-screenshot', 'context-inspect-a11y', 'context-savelinktopocket', 'context-sendpagetodevice', 'context-translate-selection', 'context-ask-chat'];
  say(Array.isArray(menu) && menu.includes('context-back') && menu.includes('context-inspect') && !menu.some((id) => unwanted.includes(id)), 'the right-click menu has only what the Electron app\'s had', JSON.stringify(menu));
  await m.exec(`${WIN} doc.getElementById("contentAreaContextMenu").hidePopup();`);

  await m.exec(`${WIN} ChromeUtils.importESModule("resource:///modules/toji/TojiAgent.sys.mjs").TojiAgent.toggleSpotlight(win);`);
  const spotlight = await until<string>(`shell.querySelector('input[placeholder^="Tell the agent"]')?.placeholder`);
  say(Boolean(spotlight), 'tapping Option opens the shell\'s agent spotlight', String(spotlight));
  await Bun.sleep(500);
  await shot('spotlight');
  await type('input[placeholder^="Tell the agent"]', 'Say hello', true);
  const run = await until<{ closed: boolean; first: string; mark: boolean }>(`(() => {
    const { TojiAgent } = ChromeUtils.importESModule("resource:///modules/toji/TojiAgent.sys.mjs");
    const state = TojiAgent.stateOf(win.gBrowser.selectedTab);
    return state.log.length && { closed: !shell.querySelector('input[placeholder^="Tell the agent"]'), first: state.log[0].text, mark: state.running ? !!shell.querySelector("[data-testid=tab-agent-cursor]") : true };
  })()`);
  say(Boolean(run) && run.closed && run.first === 'Say hello' && run.mark, 'a goal typed into the spotlight starts the agent on the tab, and the tab carries its mark', JSON.stringify(run));
  await m.exec(`${WIN} const { TojiAgent } = ChromeUtils.importESModule("resource:///modules/toji/TojiAgent.sys.mjs"); TojiAgent.stop(win.gBrowser.selectedTab);`);

  // 8. The window around it.
  const chrome = await m.exec<Record<string, unknown>>(`${WIN}
    const buttons = doc.getElementById("toji-window-buttons");
    // As macOS opens the menu: Firefox may have unhidden items since.
    const filePopup = doc.getElementById("menu_FilePopup");
    filePopup.dispatchEvent(new win.Event("popupshowing"));
    const appMenu = ["menu_FileQuitItem", "menu_preferences", "menu_settings", "menu_mac_services", "menu_mac_hide_app", "menu_mac_hide_others", "menu_mac_show_all", "menu_mac_touch_bar", "aboutName"];
    const file = [...filePopup.children].filter(i => !i.hidden && !appMenu.includes(i.id)).map(i => i.id || i.localName);
    return {
      customTitlebar: doc.documentElement.hasAttribute("customtitlebar"),
      buttons: buttons ? { appearance: win.getComputedStyle(buttons).appearance, width: buttons.getBoundingClientRect().width, height: buttons.getBoundingClientRect().height } : "absent",
      // Gone from the tree now; hidden was the earlier state.
      historyMenu: !doc.getElementById("history-menu") || doc.getElementById("history-menu").hidden,
      toolsMenu: !doc.getElementById("tools-menu") || doc.getElementById("tools-menu").hidden,
      file,
      // Emptied, not removed (Firefox's code looks some keys up): no key, no command.
      findKey: (k => !!k && (k.hasAttribute("key") || k.hasAttribute("command")) && !k.hasAttribute("disabled"))(doc.getElementById("key_find")),
      privateKey: doc.getElementById("key_privatebrowsing")?.getAttribute("modifiers") + "+" + doc.getElementById("key_privatebrowsing")?.getAttribute("key"),
    };`);
  const box = chrome.buttons as { appearance: string; width: number; height: number };
  say(chrome.customTitlebar === true && box?.appearance === 'auto' && box.width > 0 && box.height > 0, "the traffic lights have the shell's box to sit on", JSON.stringify({ customTitlebar: chrome.customTitlebar, buttons: chrome.buttons }));
  say(chrome.historyMenu === true && chrome.toolsMenu === true, 'the menu bar has no History, Bookmarks or Tools menus');
  say(JSON.stringify(chrome.file) === JSON.stringify(['menu_newNavigator', 'menu_newPrivateWindow', 'menuseparator', 'menu_newNavigatorTab', 'menu_close', 'menuseparator', 'menu_closeWindow']), "the File menu is the Electron app's", JSON.stringify(chrome.file));
  say(chrome.findKey === false && chrome.privateKey === 'accel,shift+N', '⌘F opens no Firefox find bar; ⌘⇧N is a private window', JSON.stringify({ find: chrome.findKey, priv: chrome.privateKey }));
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
  await shot('error-state').catch(() => {});
} finally {
  const errors = await m
    .exec<string[]>(`return Services.console.getMessageArray().map(e => e.message || String(e)).filter(t => /toji|TypeError|ReferenceError/i.test(t) && !/SourceMap|Content-Security/i.test(t)).slice(-25);`)
    .catch(() => [] as string[]);
  if (errors.length) console.log(`\nConsole:\n  ${errors.map((e) => e.slice(0, 300)).join('\n  ')}`);
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll shell checks passed.');
  process.exit(failures ? 1 : 0);
}
