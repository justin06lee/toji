// The right-click menu for page content.
//
// Electron ships no context menu at all — a right-click on a <webview> does nothing
// until the app draws one. This rebuilds the plain Chromium menu: the same items, in
// the same order, for the same contexts. Nothing Toji-specific belongs in here; the
// point is that right-clicking a page in Toji is unremarkable.
//
// Building the template is kept separate from performing the actions so the shape of
// the menu — which items appear for which right-click — can be tested without an app.

/** Display names for the engines in the renderer's nav.ts. Kept in sync by a test. */
const SEARCH_ENGINE_NAMES = {
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  bing: 'Bing',
  brave: 'Brave Search',
  startpage: 'Startpage'
};

/** Chromium truncates the searched phrase in the label; long selections are common. */
function truncate(text, max = 24) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Describe the menu for one right-click.
 *
 * @param params the webContents 'context-menu' event params
 * @param state  what the app knows that params doesn't: `canGoBack` / `canGoForward`,
 *               the renderer's `searchEngine` id, and `chrome: true` when the click
 *               landed on Toji's own UI rather than a page (then only the editing
 *               items apply — the app shell has no history to go back through and no
 *               source to view).
 * @returns a flat template of `{ id, label, ... }` rows and separators. Callers bind
 *          the ids to actions; see contextMenuAction in main.cjs.
 */
function contextMenuTemplate(params = {}, state = {}) {
  const edit = params.editFlags || {};
  const selection = (params.selectionText || '').trim();
  const mediaType = params.mediaType || 'none';
  const groups = [];

  // Corrections sit above everything else, the way Chromium orders them.
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
    groups.push(
      suggestions.length
        ? suggestions.map((word) => ({ id: 'spelling:replace', label: word, word }))
        : [{ id: 'spelling:none', label: 'No Guesses Found', enabled: false }]
    );
    groups.push([{ id: 'spelling:add', label: 'Add to Dictionary' }]);
  }

  if (params.linkURL) {
    groups.push([
      { id: 'link:open', label: 'Open Link in New Tab' },
      { id: 'link:save', label: 'Save Link As…' },
      { id: 'link:copy', label: 'Copy Link Address' }
    ]);
  }

  if (mediaType === 'image' && params.hasImageContents) {
    groups.push([
      { id: 'image:open', label: 'Open Image in New Tab' },
      { id: 'image:save', label: 'Save Image As…' },
      { id: 'image:copy', label: 'Copy Image' },
      { id: 'image:copyLink', label: 'Copy Image Address' }
    ]);
  }

  // Playback state (play/pause, loop, controls) is Chromium's own and Electron exposes
  // no way to drive it, so the media block stays at the two items that are just a URL.
  if (mediaType === 'video' || mediaType === 'audio') {
    const kind = mediaType === 'video' ? 'Video' : 'Audio';
    groups.push([
      { id: 'media:save', label: `Save ${kind} As…` },
      { id: 'media:copyLink', label: `Copy ${kind} Address` }
    ]);
  }

  if (params.isEditable) {
    groups.push([
      { id: 'edit:undo', label: 'Undo', enabled: Boolean(edit.canUndo) },
      { id: 'edit:redo', label: 'Redo', enabled: Boolean(edit.canRedo) }
    ]);
    groups.push([
      { id: 'edit:cut', label: 'Cut', enabled: Boolean(edit.canCut) },
      { id: 'edit:copy', label: 'Copy', enabled: Boolean(edit.canCopy) },
      { id: 'edit:paste', label: 'Paste', enabled: Boolean(edit.canPaste) },
      { id: 'edit:pastePlain', label: 'Paste and Match Style', enabled: Boolean(edit.canPaste) },
      { id: 'edit:selectAll', label: 'Select All', enabled: edit.canSelectAll !== false }
    ]);
  } else if (selection) {
    const engine = SEARCH_ENGINE_NAMES[state.searchEngine] || SEARCH_ENGINE_NAMES.duckduckgo;
    groups.push([
      { id: 'edit:copy', label: 'Copy', enabled: edit.canCopy !== false },
      { id: 'selection:search', label: `Search ${engine} for “${truncate(selection)}”` }
    ]);
  }

  // Toji's own chrome is not a page: it has no history of its own to walk, nothing to
  // save or print, and no source. A right-click that hit no text there gets no menu.
  if (state.chrome) return flatten(groups);

  // Navigation and whole-page actions appear only when the click landed on the page
  // itself rather than on a link, an image, a selection or a field — same as Chromium.
  const plainPage = !params.linkURL && !params.isEditable && !selection && mediaType === 'none';
  if (plainPage) {
    groups.push([
      { id: 'page:back', label: 'Back', enabled: Boolean(state.canGoBack) },
      { id: 'page:forward', label: 'Forward', enabled: Boolean(state.canGoForward) },
      { id: 'page:reload', label: 'Reload' }
    ]);
    groups.push([
      { id: 'page:save', label: 'Save As…' },
      { id: 'page:print', label: 'Print…' }
    ]);
  }

  const tail = [];
  if (plainPage) tail.push({ id: 'page:viewSource', label: 'View Page Source' });
  tail.push({ id: 'page:inspect', label: 'Inspect' });
  groups.push(tail);

  return flatten(groups);
}

/** Join the non-empty groups with a separator between each. */
function flatten(groups) {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' }, ...group]));
}

module.exports = { contextMenuTemplate, SEARCH_ENGINE_NAMES };
