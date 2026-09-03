import type { BrowserTab } from '../types';
import { hostOf } from './nav';

/**
 * A tab label describes the last committed navigation. Text currently being edited
 * in the omnibox deliberately stays out of the tab strip until navigation begins.
 */
export function tabTitle(tab: BrowserTab): string {
  if (tab.internal) {
    if (tab.internal === 'settings') return 'Settings';
    if (tab.internal === 'plans') return 'Toji plans';
    return 'Welcome to Toji';
  }
  if (tab.status === 'new') return 'New Tab';
  if (tab.mode === 'web') return tab.title || (tab.url ? hostOf(tab.url) : 'New Tab');
  const query = tab.query.trim();
  if (!query) return 'New Tab';
  return query.length > 24 ? `${query.slice(0, 24)}…` : query;
}
