// What the two Gecko builds share: the pages (vite.gecko.config.ts) and the browser
// window's shell (vite.shell.config.ts).

import { dirname, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const repo = dirname(fileURLToPath(import.meta.url));
export const root = resolve(repo, 'apps/renderer');
const SHARED_ASSETS = resolve(root, 'src/lib/publicAsset.ts');
const BUNDLED_ASSETS = resolve(root, 'gecko/publicAsset.ts');

/**
 * The output directory is emptied before every build, so refuse one that would take
 * something else with it: the filesystem root, the repository or anything above it, or
 * the renderer's sources.
 */
export function outputDir(variable: string, fallback: string): string {
  const out = resolve(repo, process.env[variable] || fallback);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
  if (out === parse(out).root || inside(out, repo) || inside(root, out)) {
    throw new Error(`${variable}=${out} would be emptied before the build; point it at a directory of its own.`);
  }
  return out;
}

/** Swap src/lib/publicAsset.ts for gecko/publicAsset.ts, which bundles public/ into assets/. */
export function bundledPublicAssets(): Plugin {
  return {
    name: 'toji-gecko-public-assets',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || !/(^|\/)publicAsset$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved?.id === SHARED_ASSETS ? BUNDLED_ASSETS : null;
    }
  };
}
