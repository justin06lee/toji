import { Globe, Link2 } from 'lucide-react';
import { useState } from 'react';
import { hostOf } from '../lib/nav';
import type { PageSource } from '../types';

/**
 * The web sources under an AI answer page: a bar that says how many, and the list,
 * shown until hidden. Shared by the Electron app's page view and the Gecko browser's
 * shell, which draws it under the answer's tab.
 */
export function PageSources({ sources, onOpenSource }: { sources: PageSource[]; onOpenSource: (url: string) => void }) {
  const [showSources, setShowSources] = useState(true);
  if (sources.length === 0) return null;
  return (
    <div className="max-h-[38%] shrink-0 overflow-hidden border-t border-black/[0.07] bg-white dark:border-white/10 dark:bg-neutral-950">
      <button type="button" onClick={() => setShowSources((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-xs text-neutral-500 transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
        <Globe size={13} />
        <span>{sources.length} sources</span>
        <span className="ml-auto text-neutral-400">{showSources ? 'Hide' : 'Show'}</span>
      </button>
      {showSources && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 overflow-y-auto px-3 pb-3">
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              onClick={(e) => {
                e.preventDefault();
                onOpenSource(source.url);
              }}
              title={source.summary || source.url}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-black/[0.08] px-3 py-2.5 no-underline transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/5"
            >
              <Link2 size={12} className="shrink-0 text-neutral-400" />
              <span className="flex-1 truncate text-[12.5px] text-neutral-800 dark:text-neutral-200">{source.title || hostOf(source.url)}</span>
              <span className="shrink-0 text-[11px] text-neutral-400">{hostOf(source.url)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
