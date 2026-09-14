// Firefox's tabs as the shell's tab strip and address bar see them. Pure, so the
// mapping is tested without a browser (shellTabs.test.ts).

import type { BrowserTab, InternalPage } from '../src/types';
import type { ShellTabInfo } from './shellHost';

/**
 * Addresses that mean "a new tab": the start page, the pages Firefox opens before one, and
 * Firefox's home pages, which the browser serves as Toji's start page.
 */
const START_PAGES = new Set(['about:start', 'about:newtab', 'about:home', 'about:privatebrowsing', 'about:firefoxview', 'about:welcomeback', 'about:blank', '']);

const INTERNAL: Record<string, InternalPage> = {
  'about:settings': 'settings',
  // Firefox's names for its settings, which the browser serves as Toji's Settings.
  'about:preferences': 'settings',
  'about:logins': 'settings',
  'about:protections': 'settings',
  'about:welcome': 'welcome',
  'about:plans': 'plans'
};

export type TabKind = { kind: 'start' } | { kind: 'internal'; page: InternalPage } | { kind: 'answer'; query: string } | { kind: 'web' };

/** What a tab's address shows: the start page, one of Toji's pages, an AI answer, or the web. */
export function tabKind(url: string): TabKind {
  const bare = url.split(/[?#]/)[0];
  if (START_PAGES.has(bare)) return { kind: 'start' };
  if (bare in INTERNAL) return { kind: 'internal', page: INTERNAL[bare] };
  if (/^toji:(\/\/)?ask\b/i.test(url)) {
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1 || url.length)).get('q') ?? '';
    return { kind: 'answer', query };
  }
  return { kind: 'web' };
}

/** What the omnibox shows for a tab when nothing is being typed into it. */
export function omniboxText(info: Pick<ShellTabInfo, 'url'>): string {
  const kind = tabKind(info.url);
  if (kind.kind === 'web') return info.url;
  if (kind.kind === 'answer') return kind.query;
  // The plans page, sent there by a question: the question stays in the omnibox.
  if (kind.kind === 'internal' && kind.page === 'plans') return new URLSearchParams(info.url.split(/[?#]/)[1] ?? '').get('q') ?? '';
  return '';
}

export interface TabContext {
  containerId: string;
  groupId: string | null;
  /** What is typed into the omnibox for this tab, if anything. */
  query?: string;
}

/** A Firefox tab as the Electron app's tab model, so the same components draw it. */
export function toBrowserTab(info: ShellTabInfo, context: TabContext): BrowserTab {
  const kind = tabKind(info.url);
  const base: BrowserTab = {
    id: info.id,
    query: context.query ?? omniboxText(info),
    streamUrl: null,
    status: 'ready',
    sources: [],
    groupId: context.groupId,
    mode: 'page',
    url: null,
    reloadKey: 0,
    contextKey: 0,
    containerId: context.containerId,
    canBack: info.canBack,
    canForward: info.canForward,
    audible: info.audible,
    muted: info.muted
  };
  switch (kind.kind) {
    case 'start':
      return { ...base, status: 'new' };
    case 'internal':
      return { ...base, internal: kind.page };
    case 'answer':
      return { ...base, streamUrl: info.url, status: info.busy ? 'loading' : 'ready' };
    case 'web':
      return {
        ...base,
        mode: 'web',
        url: info.url,
        // An error page's title is Firefox's ("Problem loading page"); the tab names the site instead.
        title: info.errorPage || info.crashed ? undefined : info.title || undefined,
        // Firefox gives its error pages and crashed tabs its own icons; Toji's tabs show the
        // Toji mark there, as for any page without a favicon.
        favicon: info.errorPage || info.crashed ? undefined : info.favicon || undefined,
        status: info.busy ? 'loading' : 'ready'
      };
  }
}
