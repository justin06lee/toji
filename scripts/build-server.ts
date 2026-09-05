// Bundle the agent server into one file.
//
// The packaged app used to ship dist/server as tsc output plus every production
// dependency in node_modules — 97 packages, 145 modules resolved at every launch, and
// one of them (@anthropic-ai/claude-agent-sdk-darwin-arm64) carrying a 345 MB copy of
// the `claude` binary that Toji never runs: yagami hands the SDK the user's own
// signed-in `claude` from PATH. Bundling inlines everything the server needs into a
// single ESM file, so only the packages below stay real packages on disk:
//
//   playwright                     launches its browser driver from files in the package
//   @anthropic-ai/claude-agent-sdk yagami probes its version with require.resolve, so it
//                                  must exist as a package — its platform binaries do not
//                                  (electron-builder excludes them; see package.json)
//   bufferutil / utf-8-validate    ws's optional native accelerators, deliberately absent
//
// Everything else (express, ws, zod, dotenv, yagami, the ACP SDK, hono) is a build-time
// input and lives in devDependencies.
import { build } from 'esbuild';
import { rm, stat } from 'node:fs/promises';

const EXTERNAL = ['playwright', '@anthropic-ai/claude-agent-sdk', 'bufferutil', 'utf-8-validate'];

await rm('dist/server', { recursive: true, force: true });

await build({
  entryPoints: ['apps/agent-server/src/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: EXTERNAL,
  // Smaller and faster to parse, but identifiers are kept so stack traces in
  // agent-server.log still name the function that failed.
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  // The CommonJS dependencies being inlined (express and friends) expect these globals,
  // which an ESM file does not have.
  banner: {
    js: [
      "import { createRequire as __tojiCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tojiFileURLToPath } from 'node:url';",
      "import { dirname as __tojiDirname } from 'node:path';",
      'const require = __tojiCreateRequire(import.meta.url);',
      'const __filename = __tojiFileURLToPath(import.meta.url);',
      'const __dirname = __tojiDirname(__filename);'
    ].join('\n')
  },
  logLevel: 'warning'
});

const { size } = await stat('dist/server/index.js');
console.log(`dist/server/index.js  ${(size / 1024).toFixed(0)} KB`);
