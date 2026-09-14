// The Gecko browser's shell: Toji's own tab strip, address bar, sidebar and overlays,
// drawn in every browser window in place of Firefox's (see gecko/overlay/browser/toji/
// modules/TojiShell.sys.mjs). One script and two stylesheets, which the browser copies
// verbatim into chrome://toji/content/shell/:
//
//   shell.js          an IIFE, loaded into the window with loadSubScript; defines
//                     window.tojiMountShell(container)
//   shell.css         everything, for the shell's shadow root (rem in px, see below)
//   shell-global.css  the @property rules Tailwind registers, which only take effect in
//                     a document's own stylesheets, never a shadow root's
//
//   bun run build:shell                 → dist/gecko-shell/
//   TOJI_SHELL_OUT=/some/dir bun run build:shell

import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { bundledPublicAssets, outputDir, root } from './vite.gecko.shared';

const CSS = 'shell.css';
const GLOBAL_CSS = 'shell-global.css';

/** One rem, in the Electron renderer (and any web page): the root's 16px. */
const REM_PX = 16;

/**
 * Two things the shadow root in the browser window needs that a page doesn't:
 *
 * - rem in pixels. A rem is the root element's font size, and the root here is the
 *   browser window's own document, whose font is the system's small UI font (11px on
 *   macOS), not a page's 16px. Every Tailwind size is in rem, so the whole shell would
 *   be drawn at two-thirds of the Electron app's size.
 * - @property rules moved out into a stylesheet the browser loads into the window's
 *   document, where custom property registrations work. Tailwind's shadows, rings,
 *   transforms and borders all read registered --tw-* properties.
 */
function shadowRootCss(): Plugin {
  return {
    name: 'toji-shell-shadow-root-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = bundle[CSS];
      if (!css || css.type !== 'asset') this.error(`${CSS} was not emitted`);
      const toPx = (text: string) => text.replace(/(-?(?:\d+\.?\d*|\.\d+))rem\b/g, (_m, n: string) => `${Number((Number(n) * REM_PX).toFixed(4))}px`);
      const source = toPx(String(css.source));
      const rules = source.match(/@property\s+--[\w-]+\s*\{[^{}]*\}/g) ?? [];
      css.source = rules.reduce((rest, rule) => rest.replace(rule, ''), source);
      this.emitFile({ type: 'asset', fileName: GLOBAL_CSS, source: `${rules.join('\n')}\n` });
    }
  };
}

export default defineConfig({
  root,
  // Anything not inlined would be looked for beside the script.
  base: 'chrome://toji/content/shell/',
  publicDir: false,
  plugins: [bundledPublicAssets(resolve(root, 'gecko/publicAsset.shell.ts')), react(), tailwindcss(), shadowRootCss()],
  // Library builds leave process.env alone; React picks its build from it.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: outputDir('TOJI_SHELL_OUT', 'dist/gecko-shell'),
    emptyOutDir: true,
    target: 'firefox140',
    reportCompressedSize: false,
    lib: {
      entry: resolve(root, 'gecko/shell.tsx'),
      formats: ['iife'],
      name: 'TojiShellBundle',
      fileName: () => 'shell.js',
      cssFileName: 'shell'
    }
  }
});
