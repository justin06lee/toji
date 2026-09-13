import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { BookmarksPeek } from '../lib/useBookmarksPeek';

interface BrowserFrameProps {
  layout: 'top' | 'side';
  /** The macOS window-drag notch, when there is one. */
  dragHandle?: ReactNode;
  topTabStrip: ReactNode;
  addressRow: ReactNode;
  bookmarksBar: ReactNode;
  bookmarksPinned: boolean;
  bookmarksPeek: BookmarksPeek;
  torBar: ReactNode;
  /** The side tab list; `peek` is the transient hover version. */
  sidebar: (peek: boolean) => ReactNode;
  sidebarOpen: boolean;
  sidebarPeek: boolean;
  onSidebarPeek: (open: boolean) => void;
  viewport: ReactNode;
  /**
   * The Gecko browser draws its pages underneath the shell, in the viewport's place, so
   * the frame lets the pointer through wherever the shell draws nothing (the viewport).
   */
  passThrough?: boolean;
  /** Overlays: the spotlight, the bug report, menus. */
  children?: ReactNode;
}

/**
 * The browser window's layout: the header (tabs, address row, bookmarks bar), the
 * sidebar, the viewport and the overlays. One tree for both layouts — the header
 * changes shape and the sidebar comes and goes, but the viewport keeps its place in the
 * tree, so switching between top and side tabs rearranges the chrome without reloading
 * a single tab. Shared by the Electron app and the Gecko browser's shell.
 */
export function BrowserFrame({ layout, dragHandle, topTabStrip, addressRow, bookmarksBar, bookmarksPinned, bookmarksPeek, torBar, sidebar, sidebarOpen, sidebarPeek, onSidebarPeek, viewport, passThrough = false, children }: BrowserFrameProps) {
  const sideTabs = layout === 'side';
  // Pass-through (the Gecko browser): the page sits underneath, so the frame itself is
  // transparent and takes no pointer; the header and sidebar paint the same white the
  // frame would have, and take the pointer themselves.
  const none = passThrough ? ' pointer-events-none' : '';
  const auto = passThrough ? ' pointer-events-auto' : '';
  const surface = passThrough ? ' bg-white dark:bg-neutral-950' : '';
  return (
    <div className={`flex h-screen flex-col text-neutral-900 dark:text-neutral-100${passThrough ? ' pointer-events-none' : ' bg-white dark:bg-neutral-950'}`}>
      {dragHandle}
      <header className={`drag relative shrink-0 border-b border-black/[0.07] px-3 pt-2.5 pb-2.5 dark:border-white/10${auto}${surface}`}>
        {!sideTabs && topTabStrip}
        {/* Same 10px rhythm as the header's top/bottom padding, so all three gaps match. */}
        <div className={sideTabs ? '' : 'mt-2.5'}>{addressRow}</div>
        {/* Tight under the address bar: the bar's own 3px chip inset plus 2px each side,
            and it eats most of the header's bottom padding so the border sits close too. */}
        {bookmarksPinned && <div className="mt-0.5 -mb-2">{bookmarksBar}</div>}
        {torBar}
        {!bookmarksPinned && (
          // Unpinned, the bar shows itself when the pointer rests anywhere in the gap
          // between the address bar and the header's bottom edge — over the page, never
          // moving it. The header is a native drag region, which never sees the pointer,
          // so the strip that senses it is carved out of that region. What appears is
          // laid out exactly as the pinned bar: same gaps, same border, no shadow.
          <div className="no-drag absolute inset-x-0 bottom-0 z-[60] h-2.5" onMouseEnter={bookmarksPeek.show} onMouseLeave={bookmarksPeek.hide} data-testid="bookmarks-bar-trigger">
            <AnimatePresence>
              {bookmarksPeek.open && (
                <motion.div
                  ref={bookmarksPeek.ref}
                  className="absolute inset-x-0 top-0 border-b border-black/[0.07] bg-white px-3 pt-0.5 pb-0.5 dark:border-white/10 dark:bg-neutral-950"
                  data-testid="bookmarks-bar-peek"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                >
                  {bookmarksBar}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </header>
      <div className={`relative flex min-h-0 flex-1${none}`}>
        {sideTabs && sidebarOpen && (passThrough ? <div className={`flex shrink-0${auto}${surface}`}>{sidebar(false)}</div> : sidebar(false))}
        {viewport}
        {sideTabs && !sidebarOpen && (
          <>
            <div className={`absolute left-0 top-0 z-[70] h-full w-3${auto}`} data-testid="sidebar-peek-trigger" onMouseEnter={() => onSidebarPeek(true)} />
            <AnimatePresence>
              {sidebarPeek && (
                <motion.div
                  className={`absolute left-0 top-0 z-[75] flex h-full bg-white dark:bg-neutral-950${auto}`}
                  data-testid="sidebar-peek"
                  onMouseLeave={() => onSidebarPeek(false)}
                  initial={{ x: -240 }}
                  animate={{ x: 0 }}
                  exit={{ x: -240 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                >
                  {sidebar(true)}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
      {children}
    </div>
  );
}
