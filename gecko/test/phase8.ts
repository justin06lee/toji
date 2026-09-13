#!/usr/bin/env bun
// Phase 8 (moving the Electron app's data in) and the vault, against a built
// Toji.app and a COPY of the user's Electron data (the originals are only read):
//
//  1. The move runs once: containers, settings, bookmarks, the agent server's
//     data, and the vault (decrypted with the Electron app's Keychain key — the
//     Keychain asks once) land where the Gecko browser keeps them.
//  2. A second start moves nothing twice.
//  3. The vault: a saved login is offered and filled on its own site in its own
//     container only, and the vault file holds no password in the clear.
//
// Prints counts and names, never passwords or keys.
//
// Usage: bun gecko/test/phase8.ts [Toji.app]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { electronBookmarks, electronContainers, electronLocalStorage, electronSettings, readLevelDbLog } from '../lib/migrate';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const app = resolve(process.argv.slice(2).find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const ELECTRON = process.env.TOJI_ELECTRON_DATA || join(homedir(), 'Library', 'Application Support', 'Toji');

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

// A copy of what the move reads.
const from = join(WORK, 'tmp', 'phase8-from');
rmSync(from, { recursive: true, force: true });
mkdirSync(join(from, 'Local Storage', 'leveldb'), { recursive: true });
for (const f of readdirSync(join(ELECTRON, 'Local Storage', 'leveldb')).filter((f) => f.endsWith('.log'))) {
  cpSync(join(ELECTRON, 'Local Storage', 'leveldb', f), join(from, 'Local Storage', 'leveldb', f));
}
if (existsSync(join(ELECTRON, 'data'))) cpSync(join(ELECTRON, 'data'), join(from, 'data'), { recursive: true });
if (existsSync(join(ELECTRON, 'vault.bin'))) cpSync(join(ELECTRON, 'vault.bin'), join(from, 'vault.bin'));

// What the move should produce, read from the same copy.
const store = new Map<string, Uint8Array | null>();
for (const f of readdirSync(join(from, 'Local Storage', 'leveldb')).sort()) {
  for (const [k, v] of readLevelDbLog(new Uint8Array(readFileSync(join(from, 'Local Storage', 'leveldb', f))))) store.set(k, v);
}
const items = electronLocalStorage(store);
const expected = {
  settings: electronSettings(items),
  containerIds: (electronContainers(items) as { id?: string }[]).map((c) => c.id).filter(Boolean) as string[],
  bookmarks: existsSync(join(from, 'data', 'bookmarks.json')) ? electronBookmarks(JSON.parse(readFileSync(join(from, 'data', 'bookmarks.json'), 'utf8'))) : [],
  agent: existsSync(join(from, 'data', 'settings.json')) ? JSON.parse(readFileSync(join(from, 'data', 'settings.json'), 'utf8')).agent : undefined,
  vault: existsSync(join(from, 'vault.bin'))
};
console.log(
  `copy of the Electron data: ${Object.keys(items).length} localStorage keys, containers ${expected.containerIds.join(', ') || 'none'}, ` +
    `${expected.bookmarks.length} bookmarks, agent ${expected.agent ?? 'none'}, vault ${expected.vault ? 'yes' : 'no'}`
);

// A login page for the vault checks.
const webPort = await freePort();
const server: Server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>login</title><form action="/done" method="post">
    <input id="user" name="user" type="text"><input id="pass" name="pass" type="password"><button>Sign in</button></form>`);
});
server.listen(webPort, '127.0.0.1');
const LOGIN = `http://127.0.0.1:${webPort}/`;

const profile = join(WORK, 'profiles', 'phase8');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

async function launch() {
  const port = await freePort();
  writeFileSync(join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("remote.prefs.recommended", false);\n`);
  // Headless unless HEADED=1; the Keychain's own prompt still appears on screen.
  const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, TOJI_MIGRATE_FROM: from, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
  });
  try {
    const m = await Marionette.open(port);
    await m.session();
    await m.context('chrome');
    return { m, proc };
  } catch (e) {
    // A browser that never answered must not outlive the test.
    proc.kill('SIGKILL');
    await proc.exited;
    throw e;
  }
}

const MODULES = `
  const { TojiMigrate } = ChromeUtils.importESModule("resource:///modules/toji/TojiMigrate.sys.mjs");
  const { TojiContainers } = ChromeUtils.importESModule("resource:///modules/toji/TojiContainers.sys.mjs");
  const { TojiVault } = ChromeUtils.importESModule("resource:///modules/toji/TojiVault.sys.mjs");
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
`;

/** Everything the move should have changed, as the browser sees it now. */
const snapshot = (m: Marionette) =>
  m.execAsync<Record<string, unknown>>(`${MODULES}
    const [urls, done] = arguments;
    const P = Services.prefs;
    const toolbar = [];
    for (const url of urls) if ((await PlacesUtils.bookmarks.search({ url })).length) toolbar.push(url);
    let agent;
    try { agent = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "agent-server", "settings.json"))).agent; } catch {}
    let report = null;
    try { report = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "toji-migration.json"))); } catch {}
    await SearchService.init();
    done({
      report,
      containers: TojiContainers.list().map(c => c.id),
      theme: P.getStringPref("toji.theme", ""),
      layout: P.getStringPref("toji.layout", "top"),
      bookmarksBar: P.getStringPref("browser.toolbars.bookmarks.visibility", ""),
      vaultAutosave: P.getBoolPref("toji.vault.autosave", true),
      onboarded: P.getBoolPref("toji.onboarded", false),
      engine: (await SearchService.getDefault())?.name ?? "",
      bookmarksFound: toolbar.length,
      bookmarkRows: (await PlacesUtils.bookmarks.search({})).filter(b => b.url).length,
      agent,
      vaultCount: (await TojiVault.list()).length,
    });`, [expected.bookmarks.map((b) => b.url)], 200000);

try {
  // 1. The move.
  let { m, proc } = await launch();
  const report = await m.execAsync<unknown>(`${MODULES}
    const done = arguments[0];
    TojiMigrate.run();
    // The Keychain prompt may wait for the user.
    done(await TojiMigrate.whenDone());`, [], 200000);
  const snap = await snapshot(m);
  const r = (report ?? {}) as Record<string, { error?: string; count?: number; added?: number; found?: number; applied?: string[]; copied?: string[] }>;
  console.log('move report:', JSON.stringify({ ...r, from: undefined }));
  const s = expected.settings;
  say(!!report, 'the move runs and writes its report');
  say(
    expected.containerIds.every((id) => (snap.containers as string[]).includes(id)),
    "the Electron app's containers are the browser's",
    (snap.containers as string[]).join(', ')
  );
  say(
    (!s.theme || snap.theme === s.theme) &&
      (!s.layout || snap.layout === (s.layout === 'side' ? 'side' : 'top')) &&
      (!s.bookmarksBar || snap.bookmarksBar === (s.bookmarksBar === 'pinned' ? 'always' : 'never')) &&
      (s.vaultAutosave === undefined || snap.vaultAutosave === s.vaultAutosave) &&
      (!s.onboarded || snap.onboarded === true) &&
      (!s.searchEngine || snap.engine === s.searchEngine),
    'its settings carry over',
    JSON.stringify({ theme: snap.theme, layout: snap.layout, bookmarksBar: snap.bookmarksBar, vaultAutosave: snap.vaultAutosave, onboarded: snap.onboarded, engine: snap.engine })
  );
  say(snap.bookmarksFound === expected.bookmarks.length, 'its bookmarks are on the toolbar', `${snap.bookmarksFound}/${expected.bookmarks.length}`);
  say(expected.agent === undefined || snap.agent === expected.agent, "the agent server's settings moved in", `agent ${snap.agent}`);
  say(
    !expected.vault || (!r.vault?.error && (r.vault?.added ?? 0) === (r.vault?.found ?? -1) && (snap.vaultCount as number) >= (r.vault?.added ?? 0)),
    'its vault moved into Toji\'s vault',
    `found ${r.vault?.found ?? 0}, added ${r.vault?.added ?? 0}, vault now ${snap.vaultCount}${r.vault?.error ? `, error ${r.vault.error}` : ''}`
  );
  await m.quit();
  proc.kill();
  await proc.exited;

  // 2. A second start moves nothing twice.
  ({ m, proc } = await launch());
  await Bun.sleep(4000);
  const again = await snapshot(m);
  say(
    again.bookmarkRows === snap.bookmarkRows && again.vaultCount === snap.vaultCount,
    'a second start moves nothing twice',
    `bookmarks ${again.bookmarkRows}/${snap.bookmarkRows}, vault ${again.vaultCount}/${snap.vaultCount}`
  );

  // 3. The vault: own site, own container, nothing in the clear.
  const vault = await m.execAsync<Record<string, unknown>>(`${MODULES}
    const [login, done] = arguments;
    const secret = "toji-test-" + Math.random().toString(36).slice(2);
    await TojiVault.save({ origin: new URL(login).origin, username: "alice", password: secret, containerId: "work", note: "" });
    const opened = async (containerId) => {
      const win = await TojiWindows.openContainerWindow(containerId, { urls: [login] });
      await new Promise(r => win.addEventListener("load", r, { once: true }));
      await new Promise(r => setTimeout(r, 2500));
      return win;
    };
    const work = await opened("work");
    const b = work.gBrowser.selectedBrowser;
    const offered = await TojiVault.matches(b);
    const mine = offered.find(e => e.username === "alice");
    const filled = mine ? await TojiVault.fill(b, mine.id) : false;
    const principalOrigin = b.contentPrincipal?.origin ?? "";
    const personal = await opened("personal");
    const elsewhere = (await TojiVault.matches(personal.gBrowser.selectedBrowser)).filter(e => e.username === "alice").length;
    const file = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "toji-vault.json"));
    done({ offered: !!mine, offeredCount: offered.length, filled, principalOrigin, elsewhere, clear: file.includes(secret) || file.includes("alice") });`, [LOGIN], 120000);
  say(vault.offered === true, 'a saved login is offered on its site, in its container', `${vault.offeredCount} offered; page principal ${vault.principalOrigin}`);
  say(vault.filled === true, 'and it fills the login form', `fill returned ${vault.filled}`);
  say(vault.elsewhere === 0, 'another container is not offered it');
  say(vault.clear === false, 'the vault file holds no username or password in the clear');
  await m.quit();
  proc.kill();
  await proc.exited;
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll phase 8 checks passed.');
  process.exit(failures ? 1 : 0);
}
