import type { WindowCursor } from './bridge';

// Vertical reveal bands for the window-drag notch, in CSS px from the window's top
// edge. The notch should appear when the pointer nears the top chrome — the omnibox
// row in side-tab mode (rows sit at y 10-46), the tab strip in top-tab mode — and
// never from anywhere else (in particular, not from the sidebar, which lives below
// y≈56). Hide sits lower than show so the boundary can't flicker, and clears the
// notch itself (bottom ≈ 22px) so riding the cursor down onto it keeps it alive.
const SHOW_ABOVE = { side: 52, top: 30 } as const;
const HIDE_BELOW = { side: 68, top: 48 } as const;

/**
 * How long the notch waits before hiding once the cursor says it should. The cursor
 * is sampled against the window's bounds from the main process, so a single reading
 * can be wrong for a frame while the window itself is moving — dwelling on the hide
 * turns that into nothing instead of a blink. Showing is never delayed.
 */
export const DRAG_HANDLE_DWELL_MS = 180;

/**
 * Whether the window-drag notch should be visible, given the tracked cursor.
 * Pure hysteresis: show inside the tight band, keep until the loose band is left.
 */
export function revealDragHandle(cursor: WindowCursor, prev: boolean, layout: 'top' | 'side'): boolean {
  if (!cursor.inside) return false;
  if (cursor.y < SHOW_ABOVE[layout]) return true;
  return prev && cursor.y < HIDE_BELOW[layout];
}
