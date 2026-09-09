import type { BrowserTab } from '../types';
import { hostOf } from './nav';

/** The status marks a tab can carry at its trailing end, before the close button. */
export type TabMark = 'audible' | 'muted' | 'agent';

/**
 * Which marks a tab shows, in the order they appear: sound (the speaker, or the crossed
 * one for a muted tab) always comes first, then the agent's cursor. A muted tab shows
 * the crossed speaker whether or not it is making sound, so it can be unmuted.
 */
export function tabMarks(tab: BrowserTab, agentRunning: boolean): TabMark[] {
  const marks: TabMark[] = [];
  if (tab.muted) marks.push('muted');
  else if (tab.audible) marks.push('audible');
  if (agentRunning) marks.push('agent');
  return marks;
}

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
