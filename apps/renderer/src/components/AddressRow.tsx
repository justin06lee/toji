import { ArrowLeft, ArrowRight, Moon, PanelLeft, PanelTop, RotateCw, Search, Settings, Star, Sun, WandSparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { TorHoldButton } from './TorHoldButton';

export const ICON_BUTTON =
  'no-drag inline-flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-35 disabled:pointer-events-none';

interface AddressRowProps {
  /** Side tabs on macOS: the row is the topmost one and starts past the traffic lights. */
  trafficLights: boolean;
  layout: 'top' | 'side';
  theme: 'light' | 'dark';
  canBack: boolean;
  canForward: boolean;
  canReload: boolean;
  /** What the omnibox shows: the page's address, or what is being typed. */
  value: string;
  onValueChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Enter, or the Go button: go to the address or search for it. */
  onGo: () => void;
  /** Shift+Enter or the wand: an AI answer page. */
  onAi: () => void;
  /** The key button for a saved login, when the page has one to fill. */
  vaultButton?: ReactNode;
  /** The star, for a web page: whether it is bookmarked, and how to change that. */
  star?: { bookmarked: boolean; onToggle: () => void } | null;
  torMode: boolean;
  /** Holding Go switches the window's Tor mode; absent for always-Tor profiles. */
  onToggleTor?: () => void;
  /** The save-password bubble, hung off the omnibox's right edge. */
  vaultBar?: ReactNode;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleLayout: () => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  /** Re-measures the long-address fade when the sidebar changes the row's width. */
  sidebarOpen?: boolean;
}

/**
 * Back, forward, reload, the omnibox and the three toggles. Shared by the Electron app
 * and the Gecko browser's shell.
 */
export function AddressRow({
  trafficLights,
  layout,
  theme,
  canBack,
  canForward,
  canReload,
  value,
  onValueChange,
  inputRef,
  onGo,
  onAi,
  vaultButton,
  star,
  torMode,
  onToggleTor,
  vaultBar,
  onBack,
  onForward,
  onReload,
  onToggleLayout,
  onToggleTheme,
  onSettings,
  sidebarOpen
}: AddressRowProps) {
  // A long address is cut off by the star at the omnibox's right end. While it is
  // longer than the box (and not being edited) its tail fades out just before the
  // buttons instead of stopping dead against them.
  const [overflows, setOverflows] = useState(false);
  // One observer for the box's size, kept for the input's life; the text's width is
  // re-read when the value changes, not by tearing the observer down per keystroke.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const observer = new ResizeObserver(() => setOverflows(input.scrollWidth > input.clientWidth + 1));
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const frame = requestAnimationFrame(() => setOverflows(input.scrollWidth > input.clientWidth + 1));
    return () => cancelAnimationFrame(frame);
  }, [inputRef, value, layout, sidebarOpen]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    onGo();
    inputRef.current?.blur();
  };
  // Plain Enter searches/navigates like any browser (form submit); Shift+Enter asks the AI for an answer page.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      onAi();
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  return (
    // In side-tab mode the omnibox row is the topmost row, so it needs the macOS traffic-light
    // offset (just enough to sit right beside them); in top-tab mode the TAB STRIP is above
    // it, so the row sits flush left.
    <div className={`flex items-center gap-1 ${trafficLights && layout === 'side' ? 'pl-[72px]' : ''}`}>
      <button type="button" aria-label="Back" title="Back  ⌘[" disabled={!canBack} onClick={onBack} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" aria-label="Forward" title="Forward  ⌘]" disabled={!canForward} onClick={onForward} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <ArrowRight size={15} />
      </button>
      <button type="button" aria-label="Reload" disabled={!canReload} onClick={onReload} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <RotateCw size={14} />
      </button>
      {/* The omnibox and everything anchored to it: the save-password card hangs off
          this box's right edge rather than pushing the page down. */}
      <div className="relative flex min-w-0 flex-1">
      <form onSubmit={onSubmit} className="no-drag flex h-9 w-full min-w-0 items-center rounded-full border border-black/[0.09] bg-black/[0.03] pl-3.5 pr-1 transition focus-within:bg-transparent dark:border-white/12 dark:bg-white/[0.04]">
        <Search size={15} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="search or enter a url"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search"
          className={`min-w-0 flex-1 bg-transparent pr-3 text-sm outline-none placeholder:text-neutral-400${overflows ? ' omnibox-overflowing' : ''}`}
        />
        {vaultButton}
        {star && (
          <button
            type="button"
            aria-label={star.bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
            aria-pressed={star.bookmarked}
            title={star.bookmarked ? 'Remove bookmark  ⌘D' : 'Bookmark this page  ⌘D'}
            onClick={star.onToggle}
            className="inline-flex h-7 w-7 mr-0.5 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white"
          >
            <Star size={15} className={star.bookmarked ? 'fill-current' : ''} />
          </button>
        )}
        <button type="button" aria-label="Generate an AI page" title="Generate an AI page  ⇧↵" onClick={onAi} className="inline-flex h-7 w-7 mr-1 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white">
          <WandSparkles size={15} />
        </button>
        <TorHoldButton compact active={torMode} onGo={onGo} onToggle={onToggleTor} />
      </form>
      {vaultBar}
      </div>
      <button type="button" aria-label="Toggle tab layout" title={layout === 'side' ? 'Top tabs' : 'Side tabs'} onClick={onToggleLayout} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {layout === 'side' ? <PanelTop size={14} /> : <PanelLeft size={14} />}
      </button>
      <button type="button" aria-label="Toggle theme" onClick={onToggleTheme} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button type="button" aria-label="Settings" title="Settings" onClick={onSettings} className={`${ICON_BUTTON} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <Settings size={14} />
      </button>
    </div>
  );
}
