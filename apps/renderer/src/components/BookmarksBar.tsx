import { Globe, Pin, PinOff, Trash2, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Bookmark } from '../lib/api';
import { hostOf } from '../lib/nav';

/** Where the bar's pin state lives; absent means pinned. */
export const BOOKMARKS_BAR_KEY = 'toji-bookmarks-bar';
/** Fired on the window whenever the pin state is changed, by whoever changed it. */
export const BOOKMARKS_BAR_EVENT = 'toji-bookmarks-bar';

export function bookmarksBarPinned(): boolean {
  return localStorage.getItem(BOOKMARKS_BAR_KEY) !== 'hover';
}

export function setBookmarksBarPinned(pinned: boolean) {
  localStorage.setItem(BOOKMARKS_BAR_KEY, pinned ? 'pinned' : 'hover');
  window.dispatchEvent(new Event(BOOKMARKS_BAR_EVENT));
}

interface BookmarksBarProps {
  bookmarks: Bookmark[];
  pinned: boolean;
  onTogglePinned: () => void;
  /** Open in the current tab. */
  onOpen: (url: string) => void;
  /** Open in a new tab behind this one. */
  onOpenInNewTab: (url: string) => void;
  onRemove: (id: string) => void;
}

/**
 * The bookmarks bar: a single row of the saved pages, under the address bar. Pinned, it
 * is part of the chrome and always there; unpinned, it slides over the page when the
 * pointer rests along the bottom of the address bar and goes away again after. The pin
 * at its right end switches between the two.
 */
export function BookmarksBar({ bookmarks, pinned, onTogglePinned, onOpen, onOpenInNewTab, onRemove }: BookmarksBarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; bookmark: Bookmark } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onEsc = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null);
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [menu]);

  const open = (bookmark: Bookmark, event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.button === 1) onOpenInNewTab(bookmark.url);
    else onOpen(bookmark.url);
  };

  const chip =
    'no-drag inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-neutral-600 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/[0.08] dark:hover:text-white';
  const item =
    'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-black/[0.06] dark:text-neutral-200 dark:hover:bg-white/10';

  return (
    <div className="flex h-[30px] items-center gap-0.5 pr-0.5" data-testid="bookmarks-bar">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {bookmarks.length === 0 ? (
          <span className="px-2 text-[12px] text-neutral-400">No bookmarks yet — press ⌘D on a page to keep it here.</span>
        ) : (
          bookmarks.map((bookmark) => (
            <button
              key={bookmark.id}
              type="button"
              title={bookmark.url}
              data-testid="bookmark-chip"
              onClick={(event) => open(bookmark, event)}
              onAuxClick={(event) => event.button === 1 && open(bookmark, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, bookmark });
              }}
              className={chip}
            >
              <Globe size={12} className="shrink-0 text-neutral-400" />
              <span className="truncate">{bookmark.title || hostOf(bookmark.url) || bookmark.url}</span>
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        aria-label={pinned ? 'Show the bookmarks bar only on hover' : 'Keep the bookmarks bar open'}
        aria-pressed={pinned}
        title={pinned ? 'Show only when hovering under the address bar' : 'Keep the bookmarks bar open'}
        onClick={onTogglePinned}
        data-testid="bookmarks-bar-pin"
        className="no-drag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:hover:bg-white/[0.08] dark:hover:text-white"
      >
        {pinned ? <PinOff size={12} /> : <Pin size={12} />}
      </button>
      {menu &&
        createPortal(
          <>
            <div
              className="no-drag fixed inset-0 z-[100]"
              onClick={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="no-drag fixed z-[101] min-w-[180px] select-none rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
              style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 120) }}
            >
              <button
                type="button"
                className={item}
                onClick={() => {
                  onOpenInNewTab(menu.bookmark.url);
                  setMenu(null);
                }}
              >
                <Globe size={14} /> Open in new tab
              </button>
              <button
                type="button"
                className={item}
                onClick={() => {
                  onRemove(menu.bookmark.id);
                  setMenu(null);
                }}
              >
                <Trash2 size={14} /> Remove bookmark
              </button>
              <button type="button" className={item} onClick={() => setMenu(null)}>
                <X size={14} /> Cancel
              </button>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
