#!/usr/bin/env bun
// Phase 1 verification against a built Toji.app:
//
//  1. Network: a brand-new profile runs idle for IDLE_S seconds behind a logging
//     proxy, with no automation attached (Marionette would change prefs), and
//     every host it contacts is classified as intended or unexpected.
//  2. Identity: the same profile relaunches under Marionette (with its
//     "recommended prefs" off) and loads gecko/test/probe.html: user agent,
//     client hints, window.chrome, permission states, Widevine.
//  3. Permissions: asking for location opens Firefox's prompt instead of
//     resolving silently.
//  4. Sites that broke under Electron: each loads, with a screenshot, and no
//     "unsupported browser" wall.
//
// Usage: bun gecko/test/phase1.ts [path/to/Toji.app] [--idle 180] [--skip-idle]
// Results land in gecko/.work/phase1/.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Marionette } from './marionette';
import { type Hit, startProxy } from './proxy-log';

const GECKO = resolve(import.meta.dir, '..');
const WORK = process.env.TOJI_GECKO_WORK || join(GECKO, '.work');
const OUT = join(WORK, 'phase1');
const args = process.argv.slice(2);
const app = resolve(args.find((a) => a.endsWith('.app')) || join(WORK, 'obj/dist/toji/Toji.app'));
const idleIdx = args.indexOf('--idle');
const IDLE_S = idleIdx >= 0 ? Number(args[idleIdx + 1]) : 180;
const skipIdle = args.includes('--skip-idle');

// Mozilla hosts Toji still talks to on purpose (docs/gecko.md, "Kept on purpose").
const INTENDED: [RegExp, string][] = [
  [/^firefox\.settings\.services\.mozilla\.com$/, 'Remote Settings: add-on blocklist, CRLite, intermediates'],
  [/^firefox-settings-attachments\.cdn\.mozilla\.net$/, 'Remote Settings attachments (CRLite filters)'],
  [/^content-signature-2\.cdn\.mozilla\.net$/, 'Remote Settings signature chain'],
  [/^aus5\.mozilla\.org$/, 'GMP manifest (Widevine / OpenH264)'],
  // Widevine arrives from Google's component updater (update.googleapis.com,
  // then www.google.com/dl/...). A clean profile at idle contacts Google only for this.
  [/(^|\.)gvt1\.com$|^dl\.google\.com$|(^|\.)googleapis\.com$|^www\.google\.com$/, 'Widevine CDM download from Google (component updater)'],
  [/^ciscobinary\.openh264\.org$/, 'OpenH264 codec download (WebRTC)'],
  // The built-in blocker (uBlock Origin, bundled) fetches its filter lists on first
  // launch and refreshes them after: its own hosts, the lists' publishers, the PSL.
  [/^(ublockorigin\.(github\.io|pages\.dev)|cdn\.jsdelivr\.net|pgl\.yoyo\.org|malware-filter\.gitlab\.io|publicsuffix\.org|easylist\.to|secure\.fanboy\.co\.nz|raw\.githubusercontent\.com)$/, "uBlock Origin's filter lists"]
];

function classify(host: string): string | null {
  for (const [re, why] of INTENDED) if (re.test(host)) return why;
  return null;
}

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

// Headless unless HEADED=1, so test windows never land on the user's screen.
function launch(profile: string, extra: string[] = []) {
  return Bun.spawn([join(app, 'Contents/MacOS/toji'), '-no-remote', '-profile', profile, ...extra], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1', ...(process.env.HEADED ? {} : { MOZ_HEADLESS: '1' }) }
  });
}

async function stop(proc: ReturnType<typeof launch>) {
  proc.kill('SIGTERM');
  const t = setTimeout(() => proc.kill('SIGKILL'), 8000);
  await proc.exited;
  clearTimeout(t);
}

const report: Record<string, unknown> = { app, at: new Date().toISOString() };
mkdirSync(OUT, { recursive: true });
const profile = join(WORK, 'profiles', 'phase1');
if (!skipIdle) rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const proxyPort = await freePort();
const marionettePort = await freePort();
const hits: Hit[] = [];
const proxy = startProxy(proxyPort, (h) => hits.push(h));
writeFileSync(
  join(profile, 'user.js'),
  [
    `user_pref("network.proxy.type", 1);`,
    `user_pref("network.proxy.http", "127.0.0.1");`,
    `user_pref("network.proxy.http_port", ${proxyPort});`,
    `user_pref("network.proxy.ssl", "127.0.0.1");`,
    `user_pref("network.proxy.ssl_port", ${proxyPort});`,
    `user_pref("network.proxy.share_proxy_settings", true);`,
    `user_pref("network.proxy.no_proxies_on", "");`,
    `user_pref("network.proxy.allow_hijacking_localhost", true);`,
    `user_pref("marionette.port", ${marionettePort});`,
    `user_pref("remote.prefs.recommended", false);`
  ].join('\n') + '\n'
);

// 1. Network, no automation.
if (!skipIdle) {
  console.log(`[phase1] idle run: ${IDLE_S}s behind proxy :${proxyPort}`);
  const proc = launch(profile);
  await Bun.sleep(IDLE_S * 1000);
  await stop(proc);
}
const idleHits = hits.splice(0);
const hosts = new Map<string, { count: number; first: number; why: string | null }>();
for (const h of idleHits) {
  const cur = hosts.get(h.host) || { count: 0, first: h.at, why: classify(h.host) };
  cur.count++;
  hosts.set(h.host, cur);
}
report.network = {
  idleSeconds: skipIdle ? 0 : IDLE_S,
  hosts: [...hosts].map(([host, v]) => ({ host, ...v })).sort((a, b) => a.first - b.first),
  unexpected: [...hosts].filter(([, v]) => !v.why).map(([host]) => host)
};
console.log('[phase1] hosts contacted:', JSON.stringify(report.network, null, 2));

// 2-4. Under Marionette.
const proc = launch(profile, ['--marionette', '-remote-allow-system-access']);
const m = await Marionette.open(marionettePort);
await m.session();
try {
  await m.context('content');
  await m.navigate(`file://${join(GECKO, 'test/probe.html')}`);
  for (let i = 0; i < 60; i++) {
    if ((await m.exec<string>('return document.title')) === 'Toji probe: done') break;
    await Bun.sleep(500);
  }
  report.probe = await m.exec('return window.__probe');
  writeFileSync(join(OUT, 'probe.png'), Buffer.from(await m.screenshot(), 'base64'));
  console.log('[phase1] probe:', JSON.stringify(report.probe, null, 2));

  // Location: the page asks; Firefox must show its own prompt.
  await m.exec(`document.getElementById('geo').click()`);
  await Bun.sleep(1500);
  await m.context('chrome');
  report.geolocationPrompt = await m.exec(`
    const n = PopupNotifications.getNotification('geolocation', gBrowser.selectedBrowser);
    return { shown: !!n, panel: document.getElementById('notification-popup')?.state ?? null };
  `);
  writeFileSync(join(OUT, 'geolocation-prompt.png'), Buffer.from(await m.screenshot(), 'base64'));
  report.identity = await m.exec(`
    return {
      name: Services.appinfo.name, vendor: Services.appinfo.vendor, version: Services.appinfo.version,
      ua: Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler).userAgent,
      profileDir: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
      bundleIdLocked: Services.prefs.prefIsLocked('toolkit.telemetry.enabled'),
      policies: Services.policies.status === Services.policies.ACTIVE,
      widevine: Services.prefs.getStringPref('media.gmp-widevinecdm.version', '')
    };
  `);
  console.log('[phase1] identity + prompt:', JSON.stringify({ identity: report.identity, prompt: report.geolocationPrompt }, null, 2));
  await m.context('content');

  const sites: [string, string][] = [
    ['google-signin', 'https://accounts.google.com/'],
    ['instagram-reels', 'https://www.instagram.com/reels/'],
    ['zoho-mail', 'https://mail.zoho.com/'],
    ['netflix', 'https://www.netflix.com/'],
    ['widevine-playback', `file://${join(GECKO, 'test/widevine.html')}`]
  ];
  const results: Record<string, unknown> = {};
  for (const [name, url] of sites) {
    try {
      await m.navigate(url);
    } catch (e) {
      results[name] = { error: String(e) };
      continue;
    }
    await Bun.sleep(name === 'widevine-playback' ? 4000 : 6000);
    if (name === 'widevine-playback') {
      await m.exec(`const v = document.querySelector('video'); if (v) { v.muted = true; v.play(); }`);
      await Bun.sleep(12000);
    }
    results[name] = await m.exec(`
      const text = document.body ? document.body.innerText : '';
      const v = document.querySelector('video');
      return {
        url: location.href, title: document.title,
        unsupported: /(browser (is )?(not|isn't) supported|unsupported browser|update your browser|may not be secure)/i.test(text),
        video: v ? { currentTime: v.currentTime, paused: v.paused, error: v.error && v.error.code, keys: !!v.mediaKeys } : null,
        drm: window.__widevine ?? null
      };
    `);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(await m.screenshot(), 'base64'));
    console.log(`[phase1] ${name}:`, JSON.stringify(results[name]));
  }
  report.sites = results;
  report.sitesNetwork = [...new Set(hits.map((h) => h.host))];
} finally {
  await m.quit();
  await stop(proc);
  proxy.close();
}

// Verdict: what phase 1 promises, checked against the report.
type Probe = { userAgentData: unknown; windowChrome: string; permissions: Record<string, string>; eme: Record<string, string> };
type Site = { error?: string; unsupported?: boolean; drm?: { loaded?: boolean; error?: unknown } | null };
const probe = report.probe as Probe;
const identity = report.identity as { name: string; vendor: string; bundleIdLocked: boolean; policies: boolean };
const failures: string[] = [];
for (const host of (report.network as { unexpected: string[] }).unexpected) failures.push(`unexpected host at idle: ${host}`);
if (probe.userAgentData !== null) failures.push('navigator.userAgentData is exposed');
if (probe.windowChrome !== 'undefined') failures.push('window.chrome is defined');
for (const [name, state] of Object.entries(probe.permissions)) if (state === 'granted') failures.push(`permission ${name} pre-granted`);
if (!probe.eme['com.widevine.alpha']?.startsWith('available')) failures.push('Widevine unavailable');
if (!(report.geolocationPrompt as { shown: boolean }).shown) failures.push('no geolocation prompt');
if (identity.name !== 'Toji' || identity.vendor !== 'Toji') failures.push(`identity is ${identity.vendor} ${identity.name}`);
if (!identity.bundleIdLocked) failures.push('toji.cfg prefs are not locked');
if (!identity.policies) failures.push('enterprise policies are not active');
for (const [name, r] of Object.entries(report.sites as Record<string, Site>)) {
  if (r.error) failures.push(`${name}: ${r.error}`);
  else if (r.unsupported) failures.push(`${name}: unsupported-browser wall`);
}
const drm = (report.sites as Record<string, Site>)['widevine-playback']?.drm;
if (!drm?.loaded || drm.error) failures.push('Widevine playback did not start');
report.failures = failures;

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`[phase1] report written to ${join(OUT, 'report.json')}`);
if (failures.length) {
  console.error(`[phase1] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('[phase1] PASS');
