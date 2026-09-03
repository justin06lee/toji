import { describe, expect, test } from 'vitest';
import { contextMenuTemplate, SEARCH_ENGINE_NAMES } from './context-menu.cjs';
import { SEARCH_ENGINES } from '../renderer/src/lib/nav';

/** The params Chromium hands a right-click on empty page background. */
const pageClick = (next: Record<string, unknown> = {}) => ({
  x: 120,
  y: 240,
  pageURL: 'https://example.com/',
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  editFlags: {},
  ...next
});

const labels = (items: { label?: string; type?: string }[]) => items.filter((i) => i.type !== 'separator').map((i) => i.label);
const ids = (items: { id?: string; type?: string }[]) => items.filter((i) => i.type !== 'separator').map((i) => i.id);

describe('contextMenuTemplate', () => {
  test('a plain page gets the browser menu: history, save/print, source, inspect', () => {
    expect(labels(contextMenuTemplate(pageClick(), { canGoBack: true }))).toEqual([
      'Back',
      'Forward',
      'Reload',
      'Save As…',
      'Print…',
      'View Page Source',
      'Inspect'
    ]);
  });

  test('history items reflect where the tab actually is', () => {
    const stuck = contextMenuTemplate(pageClick(), { canGoBack: false, canGoForward: false });
    const deep = contextMenuTemplate(pageClick(), { canGoBack: true, canGoForward: true });
    expect(stuck.find((i) => i.id === 'page:back')?.enabled).toBe(false);
    expect(stuck.find((i) => i.id === 'page:forward')?.enabled).toBe(false);
    expect(deep.find((i) => i.id === 'page:back')?.enabled).toBe(true);
    expect(deep.find((i) => i.id === 'page:forward')?.enabled).toBe(true);
  });

  test('a link replaces the page block, keeping only Inspect at the end', () => {
    const items = contextMenuTemplate(pageClick({ linkURL: 'https://example.com/a' }), {});
    expect(labels(items)).toEqual(['Open Link in New Tab', 'Save Link As…', 'Copy Link Address', 'Inspect']);
    expect(labels(items)).not.toContain('View Page Source');
  });

  test('an image offers the image actions', () => {
    const items = contextMenuTemplate(pageClick({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.com/a.png' }), {});
    expect(labels(items)).toEqual(['Open Image in New Tab', 'Save Image As…', 'Copy Image', 'Copy Image Address', 'Inspect']);
  });

  test('a broken image is not an image menu', () => {
    expect(labels(contextMenuTemplate(pageClick({ mediaType: 'image', hasImageContents: false }), {}))).toEqual(['Inspect']);
  });

  test('an editable field gets the editing block, gated on what is actually possible', () => {
    const items = contextMenuTemplate(pageClick({ isEditable: true, editFlags: { canUndo: true, canPaste: true, canSelectAll: true } }), {});
    expect(labels(items)).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Select All', 'Inspect']);
    expect(items.find((i) => i.id === 'edit:undo')?.enabled).toBe(true);
    expect(items.find((i) => i.id === 'edit:redo')?.enabled).toBe(false);
    expect(items.find((i) => i.id === 'edit:cut')?.enabled).toBe(false);
  });

  test('a misspelling puts corrections above everything else', () => {
    const items = contextMenuTemplate(
      pageClick({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea'], editFlags: { canPaste: true } }),
      {}
    );
    expect(labels(items).slice(0, 4)).toEqual(['the', 'ten', 'tea', 'Add to Dictionary']);
    expect(items.filter((i) => i.id === 'spelling:replace').map((i) => i.word)).toEqual(['the', 'ten', 'tea']);
  });

  test('a misspelling with no suggestions still says so, disabled', () => {
    const items = contextMenuTemplate(pageClick({ isEditable: true, misspelledWord: 'qwrx', dictionarySuggestions: [] }), {});
    expect(items[0]).toMatchObject({ label: 'No Guesses Found', enabled: false });
  });

  test('a selection offers copy and a search, naming the chosen engine', () => {
    const items = contextMenuTemplate(pageClick({ selectionText: 'ambient  light  sensor', editFlags: { canCopy: true } }), { searchEngine: 'brave' });
    expect(labels(items)).toEqual(['Copy', 'Search Brave Search for “ambient light sensor”', 'Inspect']);
  });

  test('a long selection is truncated in the label', () => {
    const items = contextMenuTemplate(pageClick({ selectionText: 'a'.repeat(80) }), {});
    expect(items.find((i) => i.id === 'selection:search')?.label).toBe(`Search DuckDuckGo for “${'a'.repeat(24)}…”`);
  });

  test('an unknown engine falls back to the same default the renderer uses', () => {
    const items = contextMenuTemplate(pageClick({ selectionText: 'x' }), { searchEngine: 'nonesuch' });
    expect(items.find((i) => i.id === 'selection:search')?.label).toContain('DuckDuckGo');
  });

  test("Toji's own chrome gets editing only — no history, no source, no inspect", () => {
    expect(labels(contextMenuTemplate(pageClick({ isEditable: true, editFlags: { canPaste: true } }), { chrome: true }))).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Paste and Match Style',
      'Select All'
    ]);
  });

  test('a right-click on chrome that hit no text opens no menu at all', () => {
    expect(contextMenuTemplate(pageClick(), { chrome: true })).toEqual([]);
  });

  test('groups are separated, and never start or end with a separator', () => {
    const items = contextMenuTemplate(pageClick(), {});
    expect(items[0].type).not.toBe('separator');
    expect(items[items.length - 1].type).not.toBe('separator');
    expect(items.filter((i) => i.type === 'separator')).toHaveLength(2);
  });

  test('every id the template can emit is one the main process handles', () => {
    const emitted = new Set<string>();
    for (const params of [
      pageClick(),
      pageClick({ linkURL: 'https://example.com/a' }),
      pageClick({ mediaType: 'image', hasImageContents: true }),
      pageClick({ mediaType: 'video' }),
      pageClick({ mediaType: 'audio' }),
      pageClick({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'] }),
      pageClick({ selectionText: 'hello' })
    ]) {
      for (const id of ids(contextMenuTemplate(params, {}))) if (id) emitted.add(id);
    }
    // Mirrors the switch in main.cjs's runContextMenuItem.
    const handled = new Set([
      'spelling:replace',
      'spelling:add',
      'spelling:none',
      'link:open',
      'link:save',
      'link:copy',
      'image:open',
      'image:save',
      'image:copy',
      'image:copyLink',
      'media:save',
      'media:copyLink',
      'edit:undo',
      'edit:redo',
      'edit:cut',
      'edit:copy',
      'edit:paste',
      'edit:pastePlain',
      'edit:selectAll',
      'selection:search',
      'page:back',
      'page:forward',
      'page:reload',
      'page:save',
      'page:print',
      'page:viewSource',
      'page:inspect'
    ]);
    expect([...emitted].filter((id) => !handled.has(id))).toEqual([]);
  });

  test('the engine names match the ones the renderer offers', () => {
    expect(SEARCH_ENGINE_NAMES).toEqual(Object.fromEntries(SEARCH_ENGINES.map((e) => [e.id, e.name])));
  });
});
