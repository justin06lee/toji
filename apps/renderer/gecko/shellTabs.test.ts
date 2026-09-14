import { describe, expect, it } from 'vitest';
import { tabTitle } from '../src/lib/tabPresentation';
import { omniboxText, tabKind, toBrowserTab } from './shellTabs';
import type { ShellTabInfo } from './shellHost';

const info = (over: Partial<ShellTabInfo>): ShellTabInfo => ({
  id: 't1',
  url: 'about:start',
  title: '',
  favicon: '',
  busy: false,
  audible: false,
  muted: false,
  canBack: false,
  canForward: false,
  errorPage: null,
  crashed: false,
  groupId: null,
  throwaway: false,
  ...over
});
const ctx = { containerId: 'work', groupId: null };

describe('tabKind', () => {
  it('reads the start pages as a new tab', () => {
    for (const url of ['about:start', 'about:newtab', 'about:home', 'about:privatebrowsing', 'about:blank', '']) {
      expect(tabKind(url)).toEqual({ kind: 'start' });
    }
  });
  it("reads Toji's pages, with or without a query", () => {
    expect(tabKind('about:settings')).toEqual({ kind: 'internal', page: 'settings' });
    expect(tabKind('about:plans?q=why')).toEqual({ kind: 'internal', page: 'plans' });
    expect(tabKind('about:welcome')).toEqual({ kind: 'internal', page: 'welcome' });
  });
  it('reads an answer page and its question', () => {
    expect(tabKind('toji://ask?q=what%20is%20tor&fresh=1')).toEqual({ kind: 'answer', query: 'what is tor' });
  });
  it('reads everything else as the web', () => {
    expect(tabKind('https://example.com/')).toEqual({ kind: 'web' });
    expect(tabKind('about:addons')).toEqual({ kind: 'web' });
  });
});

describe('omniboxText', () => {
  it('shows the address of a web page, the question of an answer, and nothing otherwise', () => {
    expect(omniboxText({ url: 'https://example.com/a?b' })).toBe('https://example.com/a?b');
    expect(omniboxText({ url: 'toji://ask?q=hello' })).toBe('hello');
    expect(omniboxText({ url: 'about:start' })).toBe('');
    expect(omniboxText({ url: 'about:settings' })).toBe('');
  });

  it("treats Firefox's names for its settings and home pages as Toji's", () => {
    expect(tabKind('about:preferences#privacy')).toEqual({ kind: 'internal', page: 'settings' });
    expect(tabKind('about:home')).toEqual({ kind: 'start' });
    expect(tabKind('about:firefoxview')).toEqual({ kind: 'start' });
  });

  it('keeps the question on the plans page a question was sent to', () => {
    expect(omniboxText({ url: 'about:plans?q=why%20is%20the%20sky%20blue' })).toBe('why is the sky blue');
    expect(omniboxText({ url: 'about:plans' })).toBe('');
  });
});

describe('toBrowserTab', () => {
  it('draws a new tab as the landing, titled New Tab', () => {
    const tab = toBrowserTab(info({ busy: true }), ctx);
    expect(tab.status).toBe('new');
    expect(tabTitle(tab)).toBe('New Tab');
  });
  it('names a web page by its title, or its host without one', () => {
    expect(tabTitle(toBrowserTab(info({ url: 'https://example.com/x', title: 'Example' }), ctx))).toBe('Example');
    expect(tabTitle(toBrowserTab(info({ url: 'https://example.com/x' }), ctx))).toBe('example.com');
  });
  it("names an error page's tab by the site, not Firefox's error title", () => {
    const tab = toBrowserTab(info({ url: 'https://nope.invalid/', title: 'Problem loading page', errorPage: 'about:neterror?e=dnsNotFound' }), ctx);
    expect(tabTitle(tab)).toBe('nope.invalid');
  });
  it("shows no Firefox icon on an error page's tab", () => {
    const tab = toBrowserTab(info({ url: 'https://nope.invalid/', favicon: 'chrome://global/skin/icons/info.svg', errorPage: 'about:neterror?e=dnsNotFound' }), ctx);
    expect(tab.favicon).toBeUndefined();
    expect(toBrowserTab(info({ url: 'https://a.test/', favicon: 'https://a.test/favicon.ico' }), ctx).favicon).toBe('https://a.test/favicon.ico');
  });
  it('spins while a web page or an answer loads', () => {
    expect(toBrowserTab(info({ url: 'https://example.com/', busy: true }), ctx).status).toBe('loading');
    expect(toBrowserTab(info({ url: 'toji://ask?q=x', busy: true }), ctx).status).toBe('loading');
    expect(toBrowserTab(info({ url: 'about:settings', busy: true }), ctx).status).toBe('ready');
  });
  it('keeps what is being typed, and otherwise shows the page', () => {
    expect(toBrowserTab(info({ url: 'https://example.com/' }), { ...ctx, query: 'typed' }).query).toBe('typed');
    expect(toBrowserTab(info({ url: 'https://example.com/' }), ctx).query).toBe('https://example.com/');
  });
  it('carries sound, history, container and group', () => {
    const tab = toBrowserTab(info({ url: 'https://a.test/', audible: true, muted: true, canBack: true }), { containerId: 'work', groupId: 'g1' });
    expect(tab).toMatchObject({ audible: true, muted: true, canBack: true, canForward: false, containerId: 'work', groupId: 'g1', mode: 'web' });
  });
  it("titles Toji's pages the way the Electron app did", () => {
    expect(tabTitle(toBrowserTab(info({ url: 'about:settings' }), ctx))).toBe('Settings');
    expect(tabTitle(toBrowserTab(info({ url: 'about:plans' }), ctx))).toBe('Toji plans');
    expect(tabTitle(toBrowserTab(info({ url: 'toji://ask?q=a%20question' }), ctx))).toBe('a question');
  });
});
