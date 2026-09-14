#!/usr/bin/env bun
// Turns edits made in the unpacked Firefox tree into a patch in gecko/patches.
//
//   bun gecko/scripts/mkpatch.ts NNNN-name path/in/tree ...
//
// Each path is diffed against its pristine copy from the source tarball; the
// result is written to gecko/patches/NNNN-name.patch and marked as applied, so
// the next `bun gecko/build.ts prepare` leaves the tree as it is. Files that an
// earlier patch already touches are refused (their pristine state isn't the
// tarball's) — fold the edit into that patch instead. Re-running with the same
// name regenerates the patch from the tree's current state.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const GECKO = resolve(import.meta.dir, '..');
const version = JSON.parse(readFileSync(join(GECKO, 'version.json'), 'utf8')) as { version: string };
const WORK = resolve(process.env.TOJI_GECKO_WORK || join(GECKO, '.work'));
const TREE = `firefox-${version.version.replace(/esr$/, '')}`;
const SRC = join(WORK, 'src', TREE);
const TARBALL = join(WORK, 'cache', `firefox-${version.version}.source.tar.xz`);
const PATCHES = join(GECKO, 'patches');
const APPLIED = join(WORK, 'applied-patches');

const [name, ...files] = process.argv.slice(2);
if (!name || !files.length || !/^\d{4}-[a-z0-9-]+$/.test(name)) {
  console.error('usage: bun gecko/scripts/mkpatch.ts NNNN-name path/in/tree ...');
  process.exit(2);
}
const patchFile = join(PATCHES, `${name}.patch`);

// A file another patch already changes must be edited through that patch.
for (const f of readdirSync(PATCHES)) {
  if (!f.endsWith('.patch') || f === `${name}.patch`) continue;
  const text = readFileSync(join(PATCHES, f), 'utf8');
  const touched = [...text.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
  const clash = files.filter((p) => touched.includes(p));
  if (clash.length) {
    console.error(`${f} already touches ${clash.join(', ')}; edit that patch instead`);
    process.exit(1);
  }
}

const pristine = join(WORK, 'tmp', 'pristine');
rmSync(pristine, { recursive: true, force: true });
mkdirSync(pristine, { recursive: true });
const members = files.map((p) => `${TREE}/${p}`);
const tar = Bun.spawnSync(['tar', '-xJf', TARBALL, '-C', pristine, ...members]);
if (tar.exitCode !== 0) {
  console.error(tar.stderr.toString());
  process.exit(1);
}

let out = '';
for (const p of files) {
  const a = join(pristine, TREE, p);
  const b = join(SRC, p);
  if (!existsSync(b)) {
    console.error(`${p} is not in the tree (deleted files belong in gecko/strip.txt)`);
    process.exit(1);
  }
  const diff = Bun.spawnSync(['diff', '-u', '--label', `a/${p}`, '--label', `b/${p}`, a, b]);
  if (diff.exitCode === 0) {
    console.log(`${p}: unchanged`);
    continue;
  }
  if (diff.exitCode !== 1) {
    console.error(diff.stderr.toString());
    process.exit(1);
  }
  out += diff.stdout.toString();
}
if (!out) {
  console.error('nothing changed; no patch written');
  process.exit(1);
}
writeFileSync(patchFile, out);
mkdirSync(APPLIED, { recursive: true });
copyFileSync(patchFile, join(APPLIED, `${name}.patch`));
console.log(`wrote ${patchFile} (${files.length} file(s)); marked as applied`);
