// Build the agent server, in one of two shapes.
//
//   bun scripts/build-server.ts
//     One ESM file, dist/server/index.js, for the Electron app to run with Node.
//
//   bun scripts/build-server.ts --compile [--target bun-darwin-arm64|bun-darwin-x64|bun-linux-x64|bun-linux-arm64] [--outfile path]
//     One self-contained executable (Bun runtime + bundle) for the Gecko browser to
//     spawn as a sidecar. Defaults: the host's target, dist/server/toji-agent-server.
//
// The packaged app used to ship dist/server as tsc output plus every production
// dependency in node_modules — 97 packages, 145 modules resolved at every launch, and
// one of them (@anthropic-ai/claude-agent-sdk-darwin-arm64) carrying a 345 MB copy of
// the `claude` binary that Toji never runs: yagami hands the SDK the user's own
// signed-in `claude` from PATH. Bundling inlines everything the server needs into a
// single ESM file, so only the packages below stay real packages on disk:
//
//   @anthropic-ai/claude-agent-sdk yagami probes its version with require.resolve, so it
//                                  must exist as a package — its platform binaries do not
//                                  (electron-builder excludes them; see package.json)
//   bufferutil / utf-8-validate    ws's optional native accelerators, deliberately absent
//   canvas                         linkedom's optional peer, tried in a try/catch and
//                                  shimmed when absent (research never draws)
//
// Everything else (express, ws, zod, dotenv, yagami, the ACP SDK, hono, Readability,
// linkedom) is a build-time input and lives in devDependencies.
//
// The compiled binary inlines the Agent SDK's JavaScript too. The SDK only looks for its
// platform package at run time, through a computed require.resolve, and only when no
// pathToClaudeCodeExecutable is given, so the ~350 MB `claude` binary is never embedded.
// MAX_BINARY_BYTES turns any regression of that into a failed build.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const ENTRY = 'apps/agent-server/src/index.ts';
const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', 'bufferutil', 'utf-8-validate', 'canvas'];

const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64'] as const;
type Target = (typeof TARGETS)[number];
const DEFAULT_BINARY = 'dist/server/toji-agent-server';
// The Bun runtime is ~60 MB and the bundle a few more; a `claude` binary would add
// hundreds, so anything past this means something was embedded that must not be.
const MAX_BINARY_BYTES = 150 * 1024 * 1024;

function fail(message: string): never {
  console.error(`build-server: ${message}`);
  process.exit(1);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

function hostTarget(): Target {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
  if (!os || !arch) fail(`no compile target for ${process.platform}-${process.arch}; pass --target (${TARGETS.join(', ')})`);
  return `bun-${os}-${arch}`;
}

async function bundleForElectron() {
  await rm('dist/server', { recursive: true, force: true });

  await build({
    entryPoints: [ENTRY],
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
}

async function compileBinary(args: string[]) {
  const target = (flagValue(args, '--target') ?? hostTarget()) as Target;
  if (!TARGETS.includes(target)) fail(`unknown --target ${target}; expected one of ${TARGETS.join(', ')}`);
  const outfile = path.resolve(flagValue(args, '--outfile') ?? DEFAULT_BINARY);

  await mkdir(path.dirname(outfile), { recursive: true });
  await rm(outfile, { force: true });

  // This script runs under Bun (see package.json), so process.execPath is bun.
  const result = spawnSync(
    process.execPath,
    [
      'build',
      ENTRY,
      '--compile',
      `--target=${target}`,
      '--outfile',
      outfile,
      '--minify-syntax',
      '--minify-whitespace',
      // A compiled Bun binary otherwise reads .env and bunfig.toml from whatever
      // directory it is started in, before any of our code runs: config would depend on
      // where the browser spawned us, and a stray bunfig.toml could preload code.
      // config.ts decides which .env files count (TOJI_ENV_FILE, else the cwd's).
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      // Only linkedom's optional canvas stays external; its require sits in a try/catch
      // and falls back to a shim. Everything else, the Agent SDK's JS included, is inlined.
      '--external',
      'canvas',
      // Tells config.ts it is running as the sidecar (see isCompiled there).
      '--define',
      'process.env.TOJI_COMPILED_BINARY="1"'
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) fail(`bun build --compile failed (exit ${result.status ?? result.signal})`);

  const { size } = await stat(outfile);
  const mb = (size / 1024 / 1024).toFixed(1);
  if (size > MAX_BINARY_BYTES) {
    fail(`${outfile} is ${mb} MB, over the ${MAX_BINARY_BYTES / 1024 / 1024} MB ceiling — check that no @anthropic-ai/claude-agent-sdk-* platform binary was embedded`);
  }
  console.log(`${path.relative(process.cwd(), outfile)}  ${mb} MB  (${target})`);
}

const args = process.argv.slice(2);
if (args.includes('--compile')) await compileBinary(args);
else await bundleForElectron();
