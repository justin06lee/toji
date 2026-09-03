export interface ContextMenuItem {
  id?: string;
  label?: string;
  type?: 'separator';
  enabled?: boolean;
  /** The replacement word, on a spelling suggestion row. */
  word?: string;
}

export interface ContextMenuState {
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** A SearchEngineId from the renderer's nav.ts; unknown ids fall back to DuckDuckGo. */
  searchEngine?: string;
  /** True when the right-click landed on Toji's own UI rather than page content. */
  chrome?: boolean;
}

export function contextMenuTemplate(params?: Record<string, unknown>, state?: ContextMenuState): ContextMenuItem[];

export const SEARCH_ENGINE_NAMES: Record<string, string>;
