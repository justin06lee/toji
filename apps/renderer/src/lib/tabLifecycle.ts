import type { BrowserTab } from '../types';

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
