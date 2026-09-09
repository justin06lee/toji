import { describe, expect, it } from 'vitest';
import type { BrowserTab } from '../types';
import { insertTabAfter, replacePristineTabWithWelcome, startBrowsingInTab } from './tabLifecycle';

const makeTab = (next: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 'initial-tab',
  query: '',
  streamUrl: null,
  status: 'new',
  sources: [],
  groupId: null,
  mode: 'page',
  url: null,
  reloadKey: 0,
  contextKey: 0,
  containerId: 'personal',
  ...next
});

describe('first-run tab lifecycle', () => {
  it('puts Welcome in the initial pristine tab', () => {
    const result = replacePristineTabWithWelcome([makeTab()], 'initial-tab');
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ id: 'initial-tab', internal: 'welcome', status: 'ready' });
  });

  it('does not overwrite a tab that already contains user work', () => {
    expect(replacePristineTabWithWelcome([makeTab({ query: 'draft' })], 'initial-tab')).toBeNull();
  });

  it('turns Welcome into New Tab without replacing its identity', () => {
    const welcome = makeTab({ internal: 'welcome', status: 'ready', reloadKey: 4 });
    expect(startBrowsingInTab(welcome)).toMatchObject({ id: 'initial-tab', internal: undefined, status: 'new', reloadKey: 5 });
  });
});

describe('insertTabAfter', () => {
  const ids = (tabs: BrowserTab[]) => tabs.map((t) => t.id);
  const list = () => [makeTab({ id: 'a' }), makeTab({ id: 'b' }), makeTab({ id: 'c' })];

  it('puts a tab opened from a page right after that page', () => {
    expect(ids(insertTabAfter(list(), 'a', makeTab({ id: 'x', openerId: 'a' })))).toEqual(['a', 'x', 'b', 'c']);
  });

  it('keeps links opened from one page in the order they were opened', () => {
    let tabs = insertTabAfter(list(), 'a', makeTab({ id: 'x', openerId: 'a' }));
    tabs = insertTabAfter(tabs, 'a', makeTab({ id: 'y', openerId: 'a' }));
    expect(ids(tabs)).toEqual(['a', 'x', 'y', 'b', 'c']);
  });

  it('appends when the opener is gone or unknown', () => {
    expect(ids(insertTabAfter(list(), 'gone', makeTab({ id: 'x' })))).toEqual(['a', 'b', 'c', 'x']);
    expect(ids(insertTabAfter(list(), null, makeTab({ id: 'x' })))).toEqual(['a', 'b', 'c', 'x']);
  });
});
