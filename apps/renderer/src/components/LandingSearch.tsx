import { ArrowRight, Search, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import { publicAsset } from '../lib/publicAsset';
import { TorHoldButton } from './TorHoldButton';

interface LandingSearchProps {
  /** Enter or the Go button: the address or search as typed. */
  onGo: (value: string) => void;
  /** Shift+Enter or the wand: an AI page. Without it there is no wand, and Shift+Enter is Enter. */
  onAi?: (value: string) => void;
  /**
   * The Electron app's Go button doubles as the Tor switch (hold for Tor mode). Without
   * this it is a plain submit button of the same size and look.
   */
  tor?: { active: boolean; onToggle?: () => void };
  /**
   * Take the keys when it appears (the default). The Gecko browser's start page doesn't:
   * there, as in the Electron app, a new tab's keys go to the toolbar's omnibox, and a
   * page that focused itself would take them from it.
   */
  autoFocus?: boolean;
}

/**
 * The New Tab landing's big search box. Deliberately holds its own text: it is NOT
 * mirrored into the toolbar omnibox (typing in one showing up in the other read as a
 * glitch, not a feature).
 */
export function LandingSearch({ onGo, onAi, tor, autoFocus = true }: LandingSearchProps) {
  const [value, setValue] = useState('');
  const submit = () => {
    if (value.trim()) onGo(value);
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[9vh]">
      <img src={publicAsset('toji-round.png')} alt="Toji" className="mb-5 h-[72px] w-[72px] rounded-[20px] shadow-sm" />
      <h1 className="mb-7 text-2xl font-semibold tracking-tight">Toji</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex h-14 w-[min(600px,92vw)] items-center rounded-full border border-black/10 bg-white pl-5 pr-1.5 shadow-sm transition dark:border-white/12 dark:bg-neutral-900"
      >
        <Search size={18} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey && onAi) {
              e.preventDefault();
              if (value.trim()) onAi(value);
            }
          }}
          placeholder="search or enter a url"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-neutral-400"
        />
        {onAi && (
          <button type="button" aria-label="Generate an AI page" title="Generate an AI page  ⇧↵" onClick={() => value.trim() && onAi(value)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white mr-1.5">
            <WandSparkles size={18} />
          </button>
        )}
        <span className="mr-1">
          {tor ? (
            <TorHoldButton active={tor.active} onGo={submit} onToggle={tor.onToggle} />
          ) : (
            <button type="submit" aria-label="Go" title="Go" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
              <ArrowRight size={18} />
            </button>
          )}
        </span>
      </form>
    </div>
  );
}
