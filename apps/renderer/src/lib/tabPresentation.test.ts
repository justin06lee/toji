import { describe, expect, test } from 'vitest';
import type { BrowserTab } from '../types';
import { tabTitle } from './tabPresentation';

const tab = (next: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 'tab-1',
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

describe('tabTitle', () => {
  test('does not expose live omnibox text before navigation', () => {
    expect(tabTitle(tab({ query: 'still typing this' }))).toBe('New Tab');
  });

  test('names each built-in page rather than the query that led there', () => {
    // A paywalled question turns its tab into the plans page while keeping the query,
    // so the label has to come from the page, not from tab.query.
    expect(tabTitle(tab({ internal: 'plans', query: 'a submitted question', status: 'ready' }))).toBe('Toji plans');
    expect(tabTitle(tab({ internal: 'settings' }))).toBe('Settings');
    expect(tabTitle(tab({ internal: 'welcome' }))).toBe('Welcome to Toji');
  });

  test('shows a committed generated-page query', () => {
    expect(tabTitle(tab({ query: 'a submitted question', status: 'loading' }))).toBe('a submitted question');
  });

  test('prefers a web page title and otherwise uses its host', () => {
    expect(tabTitle(tab({ mode: 'web', status: 'ready', url: 'https://example.com/path', title: 'Example' }))).toBe('Example');
    expect(tabTitle(tab({ mode: 'web', status: 'loading', url: 'https://example.com/path' }))).toBe('example.com');
  });
});
