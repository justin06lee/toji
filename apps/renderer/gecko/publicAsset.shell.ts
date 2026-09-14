// The window shell's stand-in for src/lib/publicAsset.ts (see vite.shell.config.ts). The
// shell is one script with every asset inlined, so it bundles only what it draws: the
// tab slot's 32px mark and the profile avatars — never the 256px mark the pages show large.

const files = import.meta.glob<string>(['../public/toji-round-32.png', '../public/profiles/*.svg'], { eager: true, query: '?url', import: 'default' });

export function publicAsset(path: string): string {
  return files[`../public/${path}`] ?? '';
}
