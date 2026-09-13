// Toji's own pages for the Gecko browser: about:settings, about:welcome, about:plans,
// about:start and about:report. The browser copies the output directory verbatim into
// chrome://toji/content/pages/, so it must hold exactly the five HTML files and assets/,
// with relative URLs only and nothing fetched from the network.
//
//   bun run build:pages                 → dist/gecko-pages/
//   TOJI_PAGES_OUT=/some/dir bun run build:pages

import { dirname, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repo = dirname(fileURLToPath(import.meta.url));
const root = resolve(repo, 'apps/renderer');
const PAGES = ['settings', 'welcome', 'plans', 'start', 'report'] as const;
const SHARED_ASSETS = resolve(root, 'src/lib/publicAsset.ts');
const BUNDLED_ASSETS = resolve(root, 'gecko/publicAsset.ts');

/**
 * The output directory is emptied before every build, so refuse one that would take
 * something else with it: the filesystem root, the repository or anything above it, or
 * the renderer's sources.
 */
function outputDir(): string {
  const out = resolve(repo, process.env.TOJI_PAGES_OUT || 'dist/gecko-pages');
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
  if (out === parse(out).root || inside(out, repo) || inside(root, out)) {
    throw new Error(`TOJI_PAGES_OUT=${out} would be emptied before the build; point it at a directory of its own.`);
  }
  return out;
}

/** Swap src/lib/publicAsset.ts for gecko/publicAsset.ts, which bundles public/ into assets/. */
function bundledPublicAssets(): Plugin {
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

/**
 * Vite names each page after its path from the root (gecko/settings.html) and points it
 * at ../assets/. The browser wants the pages at the top of the output beside assets/, so
 * lift them up a level and re-point their asset URLs to match.
 */
function pagesAtTop(): Plugin {
  return {
    name: 'toji-gecko-pages-at-top',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // The pages are shown under about: addresses, and a relative URL can't
      // resolve against about:settings, so the HTML names its assets by their
      // chrome: URL. Inside the bundle, imports and CSS url()s resolve against
      // their own chrome: files and stay relative.
      const assets = 'chrome://toji/content/pages/assets/';
      for (const [fileName, output] of Object.entries(bundle)) {
        const page = /^gecko\/([^/]+\.html)$/.exec(fileName)?.[1];
        if (!page || output.type !== 'asset') continue;
        const html = String(output.source).replaceAll('"../assets/', `"${assets}`);
        if (/(?:src|href)="(?!chrome:\/\/toji\/content\/pages\/assets\/|data:|#)/.test(html)) {
          this.error(`${page} refers to something outside assets/`);
        }
        delete bundle[fileName];
        this.emitFile({ type: 'asset', fileName: page, source: html });
      }
    }
  };
}

export default defineConfig({
  root,
  base: './',
  // public/ is not copied beside the pages; what they use is bundled (see gecko/publicAsset.ts).
  publicDir: false,
  plugins: [bundledPublicAssets(), react(), tailwindcss(), pagesAtTop()],
  build: {
    outDir: outputDir(),
    emptyOutDir: true,
    // Firefox ESR 140 and later: nothing needs transpiling for older engines.
    target: 'firefox140',
    // Firefox has had modulepreload since 115; the polyfill would be dead weight.
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page, resolve(root, `gecko/${page}.html`)]))
    }
  }
});
