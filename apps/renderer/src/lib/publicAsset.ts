/**
 * A file from apps/renderer/public by its path there ('toji-round.png',
 * 'profiles/work.svg'). The Electron build serves public/ beside index.html. The Gecko
 * pages may ship nothing but their HTML and an assets/ directory, so vite.gecko.config.ts
 * swaps this module for apps/renderer/gecko/publicAsset.ts, which bundles the files.
 */
export function publicAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}
