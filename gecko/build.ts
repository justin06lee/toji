#!/usr/bin/env bun
// Builds Toji's browser from Firefox ESR source.
//
//   bun gecko/build.ts prepare   download + verify source, apply patches, copy overlay
//   bun gecko/build.ts build     prepare, then ./mach build
//   bun gecko/build.ts faster    prepare, then ./mach build faster (JS/CSS/prefs only)
//   bun gecko/build.ts package   ./mach package (stages Toji.app and a .dmg)
//   bun gecko/build.ts install [dest]   copy the staged Toji.app to dest
//                                (default /Applications/Toji.app) and ad-hoc sign it
//   bun gecko/build.ts run [-- args]    run the staged app with a throwaway profile
//   bun gecko/build.ts app       prepare + build + package (what `make build` runs)
//   bun gecko/build.ts where     print the paths below
//
// Everything Firefox-sized lives in $TOJI_GECKO_WORK (default gecko/.work, which
// git ignores): the tarball cache, the unpacked tree, the objdir and sccache.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const GECKO = resolve(import.meta.dir);
const REPO = dirname(GECKO);
const version = JSON.parse(readFileSync(join(GECKO, 'version.json'), 'utf8')) as {
  version: string;
  source: string;
  sha256: string;
};

const WORK = resolve(process.env.TOJI_GECKO_WORK || join(GECKO, '.work'));
const CACHE = join(WORK, 'cache');
const SRC_PARENT = join(WORK, 'src');
const SRC = join(SRC_PARENT, `firefox-${version.version.replace(/esr$/, '')}`);
const OBJ = join(WORK, 'obj');
const APPLIED = join(WORK, 'applied-patches');
const OVERLAY = join(GECKO, 'overlay');
// Build outputs that are copied into the tree like the overlay: gecko/lib/*.ts
// bundled into standalone chrome modules (and, later, the React pages).
const GENERATED = join(WORK, 'generated');
const LIB = join(GECKO, 'lib');
const OVERLAY_LOG = join(WORK, 'overlay-files.json');
const TARBALL = join(CACHE, `firefox-${version.version}.source.tar.xz`);
const STAGED_APP = join(OBJ, 'dist', 'toji', 'Toji.app');

function log(msg: string) {
  console.log(`[gecko] ${msg}`);
}

function die(msg: string): never {
  console.error(`[gecko] error: ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['inherit', 'inherit', 'inherit']
  });
  const code = await proc.exited;
  if (code !== 0) die(`${cmd.join(' ')} exited with ${code}`);
}

function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => ok(hash.digest('hex')))
      .on('error', fail);
  });
}

async function fetchSource() {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(TARBALL)) {
    log(`downloading ${version.source}`);
    const res = await fetch(version.source);
    if (!res.ok || !res.body) die(`download failed: HTTP ${res.status}`);
    const part = `${TARBALL}.part`;
    await Bun.write(part, res);
    renameSync(part, TARBALL);
  }
  const sum = await sha256File(TARBALL);
  if (sum !== version.sha256) {
    unlinkSync(TARBALL);
    die(`checksum mismatch for ${TARBALL} (got ${sum}); deleted it, run again to re-download`);
  }
}

async function extractSource() {
  const stamp = join(SRC, '.toji-source');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version.sha256) return;
  if (existsSync(SRC)) die(`${SRC} exists but is not a clean ${version.version} tree; remove it first`);
  mkdirSync(SRC_PARENT, { recursive: true });
  log(`unpacking ${version.version} (a few minutes)`);
  await run(['tar', '-xJf', TARBALL, '-C', SRC_PARENT]);
  if (!existsSync(SRC)) die(`expected ${SRC} after unpacking`);
  writeFileSync(stamp, `${version.sha256}\n`);
  rmSync(APPLIED, { recursive: true, force: true });
  rmSync(OVERLAY_LOG, { force: true });
}

// Patches are applied once and remembered in APPLIED, so re-running never
// re-extracts the tree (that would touch every mtime and force a full
// rebuild). A patch that changed or disappeared is reversed first.
async function applyPatches() {
  mkdirSync(APPLIED, { recursive: true });
  const wanted = readdirSync(join(GECKO, 'patches'))
    .filter((f) => f.endsWith('.patch'))
    .sort();
  const applied = readdirSync(APPLIED)
    .filter((f) => f.endsWith('.patch'))
    .sort();
  const same = (f: string) =>
    wanted.includes(f) &&
    readFileSync(join(APPLIED, f), 'utf8') === readFileSync(join(GECKO, 'patches', f), 'utf8');

  const stale = applied.filter((f) => !same(f)).reverse();
  for (const f of stale) {
    log(`reversing ${f}`);
    await run(['patch', '-p1', '-R', '--silent', '-d', SRC, '-i', join(APPLIED, f)]);
    unlinkSync(join(APPLIED, f));
  }
  for (const f of wanted) {
    if (existsSync(join(APPLIED, f))) continue;
    log(`applying ${f}`);
    await run(['patch', '-p1', '--forward', '--silent', '--no-backup-if-mismatch', '-d', SRC, '-i', join(GECKO, 'patches', f)]);
    copyFileSync(join(GECKO, 'patches', f), join(APPLIED, f));
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Bundles each gecko/lib/*.ts (not tests) into a standalone ES module at
// browser/toji/modules/lib/<name>.sys.mjs, i.e. resource:///modules/toji/lib/.
// No code splitting: chrome modules import each other by full URL, so every
// bundle carries what it needs.
async function generate() {
  const out = join(GENERATED, 'browser', 'toji', 'modules', 'lib');
  if (!existsSync(LIB)) return;
  const entries = readdirSync(LIB)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(LIB, f));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (!entries.length) return;
  const result = await Bun.build({
    entrypoints: entries,
    outdir: out,
    target: 'browser',
    format: 'esm',
    splitting: false,
    naming: '[name].sys.mjs'
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    die('bundling gecko/lib failed');
  }
  await bundleAddons();
  await buildPages();
  await buildShell();
  await buildServer();
}

// Toji's pages (Settings, Welcome, Plans, start, report): the React build that
// ships at chrome://toji/content/pages/.
async function buildPages() {
  const out = join(GENERATED, 'browser', 'toji', 'content', 'pages');
  await run(['bun', 'run', 'build:pages'], { cwd: REPO, env: { TOJI_PAGES_OUT: out } });
}

// The browser window's shell (Toji's tab strip, address bar, sidebar, overlays in
// place of Firefox's): the React build that ships at chrome://toji/content/shell/.
async function buildShell() {
  const out = join(GENERATED, 'browser', 'toji', 'content', 'shell');
  await run(['bun', 'run', 'build:shell'], { cwd: REPO, env: { TOJI_SHELL_OUT: out } });
}

// The agent server as one executable (bun build --compile), shipped as
// Toji.app/Contents/Resources/toji-agent-server. Ad-hoc signed so macOS runs it
// from inside the bundle.
async function buildServer() {
  const out = join(GENERATED, 'browser', 'toji', 'bin', 'toji-agent-server');
  mkdirSync(dirname(out), { recursive: true });
  await run(['bun', 'scripts/build-server.ts', '--compile', '--outfile', out], { cwd: REPO });
  if (process.platform === 'darwin') {
    await run(['codesign', '--force', '--sign', '-', out]);
  }
}

// Built-in add-ons (gecko/addons.json): the AMO-signed XPI, pinned by version
// and SHA-256, shipped in distribution/extensions so every new profile gets it.
async function bundleAddons() {
  const manifest = join(GECKO, 'addons.json');
  if (!existsSync(manifest)) return;
  const addons = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, { version: string; url: string; sha256: string }>;
  const out = join(GENERATED, 'browser', 'toji', 'distribution', 'extensions');
  mkdirSync(out, { recursive: true });
  for (const [id, addon] of Object.entries(addons)) {
    const cached = join(CACHE, `${id}-${addon.version}.xpi`);
    if (!existsSync(cached) || (await sha256File(cached)) !== addon.sha256) {
      log(`downloading ${id} ${addon.version}`);
      const res = await fetch(addon.url);
      if (!res.ok) die(`download of ${id} failed: HTTP ${res.status}`);
      await Bun.write(cached, res);
      const sum = await sha256File(cached);
      if (sum !== addon.sha256) {
        unlinkSync(cached);
        die(`checksum mismatch for ${id} ${addon.version} (got ${sum})`);
      }
    }
    copyFileSync(cached, join(out, `${id}.xpi`));
  }
}

// Copies gecko/overlay/** and the generated files into the tree, touching only
// files whose bytes changed so the build system rebuilds as little as possible.
function copyOverlay() {
  const sources = new Map<string, string>();
  for (const root of [OVERLAY, GENERATED]) {
    if (!existsSync(root)) continue;
    for (const f of walk(root)) sources.set(relative(root, f), f);
  }
  const files = [...sources.keys()];
  let changed = 0;
  for (const rel of files) {
    const from = sources.get(rel)!;
    const to = join(SRC, rel);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    changed++;
  }
  const previous: string[] = existsSync(OVERLAY_LOG) ? JSON.parse(readFileSync(OVERLAY_LOG, 'utf8')) : [];
  for (const rel of previous) {
    if (files.includes(rel)) continue;
    rmSync(join(SRC, rel), { force: true });
    log(`removed ${rel} (no longer in the overlay)`);
  }
  writeFileSync(OVERLAY_LOG, JSON.stringify(files, null, 2));
  log(`overlay: ${files.length} files, ${changed} updated`);
}

function machEnv(): Record<string, string> {
  const memGb = totalmem() / 2 ** 30;
  // ~1.3 GB per job keeps an 8 GB machine out of heavy swap during the Rust
  // and link steps; bigger machines get every core.
  const jobs = process.env.TOJI_JOBS || String(Math.max(2, Math.min(cpus().length, Math.floor(memGb / 1.3))));
  return {
    MOZCONFIG: join(GECKO, 'mozconfig'),
    TOJI_OBJDIR: OBJ,
    TOJI_SCCACHE_DIR: join(WORK, 'sccache'),
    TOJI_JOBS: jobs,
    MOZBUILD_STATE_PATH: process.env.MOZBUILD_STATE_PATH || join(process.env.HOME || '', '.mozbuild'),
    MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE: 'system',
    // mach trims its output to warnings and errors when it detects a coding
    // agent, which hides configure failures; build logs should be complete.
    CLAUDECODE: '',
    CODEX_SANDBOX: '',
    GEMINI_CLI: '',
    OPENCODE: ''
  };
}

async function prepare() {
  await fetchSource();
  await extractSource();
  await applyPatches();
  await generate();
  copyOverlay();
}

async function mach(...args: string[]) {
  await run([join(SRC, 'mach'), ...args], { cwd: SRC, env: machEnv() });
}

async function install(dest: string) {
  if (!existsSync(STAGED_APP)) die(`no staged app at ${STAGED_APP}; run \`bun gecko/build.ts package\``);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  await run(['ditto', STAGED_APP, dest]);
  // Ad-hoc signature over the whole bundle: TCC and the keychain need one to
  // attribute permissions to Toji rather than to an anonymous binary.
  await run(['codesign', '--force', '--deep', '--sign', '-', dest]);
  log(`installed ${dest}`);
}

async function main() {
  const [cmd = 'app', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'prepare':
      await prepare();
      break;
    case 'configure':
      await prepare();
      await mach('configure');
      break;
    case 'build':
      await prepare();
      await mach('build');
      break;
    case 'faster':
      await prepare();
      await mach('build', 'faster');
      break;
    case 'package':
      await mach('package');
      break;
    case 'app':
      await prepare();
      await mach('build');
      await mach('package');
      break;
    case 'install':
      await install(resolve(rest[0] || '/Applications/Toji.app'));
      break;
    case 'run': {
      const app = existsSync(STAGED_APP) ? STAGED_APP : join(OBJ, 'dist', 'Toji.app');
      const profile = join(WORK, 'profiles', 'run');
      mkdirSync(profile, { recursive: true });
      const extra = rest[0] === '--' ? rest.slice(1) : rest;
      await run([join(app, 'Contents', 'MacOS', 'toji'), '-no-remote', '-profile', profile, ...extra]);
      break;
    }
    case 'where':
      console.log(JSON.stringify({ WORK, SRC, OBJ, STAGED_APP, TARBALL }, null, 2));
      break;
    default:
      die(`unknown command ${cmd}`);
  }
}

await main();
