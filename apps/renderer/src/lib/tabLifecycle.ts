import type { BrowserTab } from '../types';

/**
 * Where a tab opened FROM another tab goes: right after it, the way every browser does
 * it, so a run of links opened from one page sits together beside that page. With no
 * opener in the list (it closed meanwhile), the tab goes on the end.
 */
export function insertTabAfter(tabs: BrowserTab[], openerId: string | null | undefined, tab: BrowserTab): BrowserTab[] {
  const index = openerId ? tabs.findIndex((t) => t.id === openerId) : -1;
  if (index < 0) return [...tabs, tab];
  // Past any tabs already opened from this one, so they keep the order they were opened in.
  let end = index + 1;
  while (end < tabs.length && tabs[end].openerId === openerId) end += 1;
  return [...tabs.slice(0, end), tab, ...tabs.slice(end)];
}

/** Replace the initial untouched tab with onboarding instead of appending a second tab. */
export function replacePristineTabWithWelcome(tabs: BrowserTab[], activeId: string): BrowserTab[] | null {
  const active = tabs.find((tab) => tab.id === activeId);
  if (!active || active.status !== 'new' || active.internal || active.url || active.query.trim()) return null;
  return tabs.map((tab) => (tab.id === activeId ? { ...tab, internal: 'welcome', status: 'ready' } : tab));
}

/** Turn onboarding into the new-tab page without changing the tab's identity or position. */
export function startBrowsingInTab(tab: BrowserTab): BrowserTab {
  return {
    ...tab,
    internal: undefined,
    query: '',
    streamUrl: null,
    status: 'new',
    sources: [],
    mode: 'page',
    url: null,
    title: undefined,
    favicon: undefined,
    canBack: false,
    canForward: false,
    contextKey: 0,
    reloadKey: tab.reloadKey + 1
  };
}
