import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reads bookmarks from other macOS browsers so Toji can import them on first run.
// Chrome-family browsers (Chrome/Brave/Edge) store bookmarks as a JSON "Bookmarks"
// file with the same schema. Safari uses a binary plist which we don't parse without
// a dependency, so it's detected but importing returns []. Everything here is guarded
// so it never throws — a missing/locked/corrupt file just yields no bookmarks.

export interface ImportedBookmark {
  title: string;
  url: string;
  folder?: string;
}

export interface DetectedBrowser {
  id: string;
  name: string;
  available: boolean;
}

const home = os.homedir();
const appSupport = path.join(home, 'Library', 'Application Support');

// id → { name, kind, bookmark file path }. "chromium" files share the Chrome JSON schema.
const BROWSERS: { id: string; name: string; kind: 'chromium' | 'safari'; file: string }[] = [
  { id: 'chrome', name: 'Google Chrome', kind: 'chromium', file: path.join(appSupport, 'Google', 'Chrome', 'Default', 'Bookmarks') },
  { id: 'brave', name: 'Brave', kind: 'chromium', file: path.join(appSupport, 'BraveSoftware', 'Brave-Browser', 'Default', 'Bookmarks') },
  { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', file: path.join(appSupport, 'Microsoft Edge', 'Default', 'Bookmarks') },
  { id: 'arc', name: 'Arc', kind: 'chromium', file: path.join(appSupport, 'Arc', 'User Data', 'Default', 'Bookmarks') },
  { id: 'safari', name: 'Safari', kind: 'safari', file: path.join(home, 'Library', 'Safari', 'Bookmarks.plist') }
];

const MAX_BOOKMARKS = 2000;

export function detectBrowsers(): DetectedBrowser[] {
  return BROWSERS.map((b) => {
    let available = false;
    try {
      available = existsSync(b.file);
    } catch {
      available = false;
    }
    return { id: b.id, name: b.name, available };
  });
}

// A Chrome "Bookmarks" JSON node: either a folder (children[]) or a url leaf.
interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeNode[];
}

function walkChromium(node: ChromeNode | undefined, folder: string | undefined, out: ImportedBookmark[]): void {
  if (!node || out.length >= MAX_BOOKMARKS) return;
  if (node.type === 'url' && typeof node.url === 'string' && /^https?:\/\//i.test(node.url)) {
    out.push({ title: String(node.name ?? node.url).slice(0, 300), url: node.url, folder });
    return;
  }
  if (Array.isArray(node.children)) {
    const nextFolder = node.type === 'folder' && node.name ? node.name : folder;
    for (const child of node.children) {
      if (out.length >= MAX_BOOKMARKS) break;
      walkChromium(child, nextFolder, out);
    }
  }
}

export async function importBookmarks(browserId: string): Promise<ImportedBookmark[]> {
  const browser = BROWSERS.find((b) => b.id === browserId);
  if (!browser) return [];
  try {
    if (browser.kind === 'safari') {
      // Safari's Bookmarks.plist is a binary plist — skip without adding a dependency.
      return [];
    }
    const raw = await fs.readFile(browser.file, 'utf8');
    const parsed = JSON.parse(raw) as { roots?: Record<string, ChromeNode> };
    const out: ImportedBookmark[] = [];
    const roots = parsed.roots ?? {};
    for (const key of ['bookmark_bar', 'other', 'synced']) {
      walkChromium(roots[key], undefined, out);
      if (out.length >= MAX_BOOKMARKS) break;
    }
    return out;
  } catch {
    return [];
  }
}
