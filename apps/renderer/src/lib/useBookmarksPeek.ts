import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';

/** How long the pointer rests under the address bar before the unpinned bookmarks bar shows. */
const BOOKMARKS_PEEK_DWELL_MS = 90;
/** How long the bar stays after the pointer leaves it. */
const BOOKMARKS_PEEK_LINGER_MS = 160;

export interface BookmarksPeek {
  open: boolean;
  /** The revealed bar itself, for the cursor-stream check. */
  ref: React.RefObject<HTMLDivElement | null>;
  show: () => void;
  hide: () => void;
}

/**
 * The unpinned bookmarks bar appears while the pointer rests where the bar would be:
 * the gap under the address bar and the top of the page (reported by the page, whose
 * mouse events never reach the chrome). It waits a moment before showing, so a pointer
 * merely passing through on its way to the omnibox does not flash it, and lingers a
 * moment after the pointer leaves.
 */
export function useBookmarksPeek(pinned: boolean): BookmarksPeek {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const show = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    if (openRef.current || showTimer.current !== null || pinnedRef.current) return;
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      setOpen(true);
    }, BOOKMARKS_PEEK_DWELL_MS);
  }, []);
  const hide = useCallback(() => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, BOOKMARKS_PEEK_LINGER_MS);
  }, []);
  useEffect(() => {
    if (pinned) setOpen(false);
  }, [pinned]);
  // The chrome above the bar is a native drag region, and macOS delivers no mouse events
  // over those — a pointer that leaves the bar upward can leave it hanging, its
  // mouseleave never fired. The cursor stream (the window-drag notch uses it for the same
  // reason) closes it once the pointer is clearly somewhere else.
  useEffect(() => {
    if (!open) return;
    return bridge().onWindowCursor?.((cursor) => {
      const zone = ref.current?.getBoundingClientRect();
      if (!zone) return;
      const over = cursor.inside && cursor.x >= zone.left && cursor.x <= zone.right && cursor.y >= zone.top && cursor.y <= zone.bottom;
      if (!over) hide();
    });
  }, [open, hide]);

  return { open, ref, show, hide };
}
