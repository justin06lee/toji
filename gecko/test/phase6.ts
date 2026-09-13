#!/usr/bin/env bun
// Phase 6 (passwords, imports, uBlock Origin) against a built Toji.app. Nothing
// here touches the user's own data or their Keychain:
//
//  1. uBlock Origin is installed (the version gecko/addons.json pins), active,
//     and allowed in private windows.
//  2. It blocks: a web page's request to an ad server fails, while a request to
//     an ordinary site goes through.
//  3. Settings' ad-blocking switch disables it and turns it back on.
//  4. Bookmarks import from Helium, read from a fake home (TOJI_IMPORT_HOME), into
//     a "From Helium" folder; with no saved passwords there, no Keychain is asked.
//
// The vault itself (encryption through the macOS Keychain) is not exercised here:
// each rebuilt test app would raise a Keychain prompt on the user's screen.
//
// Usage: bun gecko/test/phase6.ts [Toji.app]

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const app = resolve(process.argv.slice(2).find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const UBLOCK = 'uBlock0@raymondhill.net';
const pinned = JSON.parse(readFileSync(join(GECKO, 'addons.json'), 'utf8'))[UBLOCK].version as string;
// A tracker beacon uBlock's default lists block outright. Not an ad *script*
// such as adsbygoogle.js (uBlock swaps those for a harmless stand-in, so the
// request "succeeds"), nor an ad click-through link (EasyList exempts those, or
// ad links would break).
const TRACKER_URL = 'https://www.google-analytics.com/collect?v=1&t=pageview&tid=UA-0-0&cid=toji';
const PLAIN_URL = 'https://example.com/';

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

// A web page to fetch from.
const webPort = await freePort();
const server: Server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>web</title><p>web page</p>');
});
server.listen(webPort, '127.0.0.1');

// A fake home with one Helium profile holding bookmarks and no passwords.
const fakeHome = join(WORK, 'tmp', 'phase6-home');
rmSync(fakeHome, { recursive: true, force: true });
const helium = join(fakeHome, 'Library', 'Application Support', 'net.imput.helium');
mkdirSync(join(helium, 'Default'), { recursive: true });
writeFileSync(join(helium, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
writeFileSync(
  join(helium, 'Default', 'Bookmarks'),
  JSON.stringify({
    checksum: '',
    version: 1,
    roots: {
      bookmark_bar: {
        id: '1',
        name: 'Bookmarks bar',
        type: 'folder',
        children: [
          { id: '2', name: 'Toji test', type: 'url', url: 'https://example.com/toji-test' },
          { id: '3', name: 'Reading', type: 'folder', children: [{ id: '4', name: 'MDN', type: 'url', url: 'https://developer.mozilla.org/' }] }
        ]
      },
      other: { id: '5', name: 'Other bookmarks', type: 'folder', children: [] },
      synced: { id: '6', name: 'Mobile bookmarks', type: 'folder', children: [] }
    }
  })
);

const profile = join(WORK, 'profiles', 'phase6');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const port = await freePort();
writeFileSync(join(profile, 'user.js'), `user_pref("marionette.port", ${port});\nuser_pref("remote.prefs.recommended", false);\n`);
// Headless unless HEADED=1, so test windows never land on the user's screen.
const proc = Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, '--marionette', '-remote-allow-system-access'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: { ...process.env, TOJI_IMPORT_HOME: fakeHome, ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
});
const m = await Marionette.open(port);
await m.session();

const MODULES = `
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { TojiImport } = ChromeUtils.importESModule("resource:///modules/toji/TojiImport.sys.mjs");
  const { TojiPageAPI } = ChromeUtils.importESModule("resource:///modules/toji/TojiPages.sys.mjs");
  const { TojiWindows } = ChromeUtils.importESModule("resource:///modules/toji/TojiWindows.sys.mjs");
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
`;

/** From the web page: does a no-cors fetch of `url` go out (true) or get blocked (false)? */
const fetchGoesOut = (url: string) =>
  m.execAsync<boolean>(
    `const [url, done] = arguments;
     fetch(url, { mode: "no-cors", cache: "no-store" }).then(() => done(true), () => done(false));`,
    [url],
    30000
  );

try {
  await m.context('chrome');
  await Bun.sleep(3000);
  const handle = await m.execAsync<string>(`${MODULES}
    const done = arguments[0];
    await TojiWindows.choose(BrowserWindowTracker.getTopWindow(), "personal");
    await new Promise(r => setTimeout(r, 800));
    done(NavigableManager.getIdForBrowser(BrowserWindowTracker.getTopWindow().gBrowser.selectedBrowser));`);
  await m.send('WebDriver:SwitchToWindow', { handle, focus: false });

  // 1. Installed, active, allowed in private windows.
  const ub = await m.execAsync<{ found: boolean; version: string; active: boolean; privateOk: boolean }>(`${MODULES}
    const [id, done] = arguments;
    let addon = null;
    for (let i = 0; i < 40 && !addon; i++) {
      addon = await AddonManager.getAddonByID(id);
      if (!addon) await new Promise(r => setTimeout(r, 500));
    }
    const perms = addon ? await ExtensionPermissions.get(id) : { permissions: [] };
    done({
      found: !!addon, version: addon?.version ?? "", active: !!addon?.isActive,
      privateOk: perms.permissions.includes("internal:privateBrowsingAllowed"),
    });`, [UBLOCK]);
  say(ub.found && ub.version === pinned, 'uBlock Origin is installed at the pinned version', `${ub.version || 'missing'} (pinned ${pinned})`);
  say(ub.active, 'uBlock Origin is active in a new profile');
  say(ub.privateOk, 'uBlock Origin runs in private windows');

  // 2. It blocks. uBlock loads its filter lists after startup, so give it time.
  await m.context('content');
  await m.navigate(`http://127.0.0.1:${webPort}/`);
  /** Retries while uBlock (re)starts, until the tracker's fate is `want`. */
  const trackerGoesOut = async (want: boolean) => {
    let out = !want;
    for (let i = 0; i < 15 && out !== want; i++) {
      out = await fetchGoesOut(TRACKER_URL);
      if (out !== want) await Bun.sleep(2000);
    }
    return out;
  };
  const blockedOn = !(await trackerGoesOut(false));
  const plainGoesOut = await fetchGoesOut(PLAIN_URL);
  say(blockedOn && plainGoesOut, 'a tracker request is blocked while an ordinary one goes through', `tracker ${blockedOn ? 'blocked' : 'went out'}, example.com ${plainGoesOut ? 'went out' : 'blocked'}`);

  // 3. Settings' switch, and proof the blocking is uBlock's: off, the same
  // request goes out; back on, it's blocked again.
  const setAdblock = async (on: boolean) => {
    await m.context('chrome');
    const active = await m.execAsync<boolean>(`${MODULES}
      const [id, on, done] = arguments;
      await TojiPageAPI.setSetting(["adblock", on]);
      done((await AddonManager.getAddonByID(id)).isActive);`, [UBLOCK, on]);
    await m.context('content');
    return active;
  };
  const offActive = await setAdblock(false);
  const outWhenOff = await trackerGoesOut(true);
  const onActive = await setAdblock(true);
  const blockedAgain = !(await trackerGoesOut(false));
  say(!offActive && outWhenOff, "Settings' switch turns uBlock Origin off, and the tracker then goes out", `active ${offActive}, tracker ${outWhenOff ? 'went out' : 'blocked'}`);
  say(onActive && blockedAgain, 'switched back on, it blocks the tracker again', `active ${onActive}, tracker ${blockedAgain ? 'blocked' : 'went out'}`);
  await m.context('chrome');

  // 4. Bookmarks from Helium, out of the fake home.
  const imported = await m.execAsync<{ result: unknown; hits: string[]; folder: string | null }>(`${MODULES}
    const done = arguments[0];
    const result = await TojiImport.importBrowser({ browser: "helium", profile: "Default" });
    const hits = [];
    for (const url of ["https://example.com/toji-test", "https://developer.mozilla.org/"]) {
      const found = await PlacesUtils.bookmarks.search({ url });
      if (found.length) hits.push(url);
    }
    const folders = await PlacesUtils.bookmarks.search({ title: "From Helium (Personal)" });
    done({ result, hits, folder: folders[0]?.title ?? null });`);
  const r = imported.result as { bookmarks?: { count?: number; error?: string }; passwords?: { found?: number; error?: string } };
  say(r.bookmarks?.count === 2 && imported.hits.length === 2, 'Helium bookmarks import into Firefox bookmarks', `count ${r.bookmarks?.count}, found ${imported.hits.length}/2${r.bookmarks?.error ? `, error ${r.bookmarks.error}` : ''}`);
  say(imported.folder === 'From Helium (Personal)', 'they land in a folder named after the browser and profile', String(imported.folder));
  say(r.passwords?.found === 0 && !r.passwords?.error, 'a profile without saved passwords asks nothing of the Keychain', JSON.stringify(r.passwords));

  console.log('SKIP  the vault (encryption through the macOS Keychain; needs the user\'s go-ahead)');
} catch (e) {
  console.error(`ERROR  ${(e as Error).message}`);
  failures += 1;
} finally {
  await m.quit();
  proc.kill();
  await proc.exited;
  server.close();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll phase 6 checks passed.');
  process.exit(failures ? 1 : 0);
}
