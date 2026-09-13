// The Gecko build's stand-in for src/lib/publicAsset.ts, swapped in by
// vite.gecko.config.ts. The pages are copied verbatim into chrome://toji/content/pages/,
// which holds only their HTML and assets/, so files from public/ are bundled into
// assets/ like any other import instead of being served beside the HTML.

const files = import.meta.glob<string>('../public/**/*.{png,svg}', { eager: true, query: '?url', import: 'default' });

export function publicAsset(path: string): string {
  return files[`../public/${path}`] ?? '';
}
