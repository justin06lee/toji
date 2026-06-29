import { Globe, Link2 } from 'lucide-react';
import { useState } from 'react';
import { hostOf } from '../lib/nav';
import type { PageSource } from '../types';

interface PageViewProps {
  streamUrl: string | null;
  loading: boolean;
  sources: PageSource[];
  onReady: () => void;
  onOpenSource: (url: string) => void;
}

/**
 * Renders the AI page by pointing an iframe at the server's streaming HTML
 * endpoint. The browser's native parser renders the document progressively as it
 * downloads — so the page builds and styles itself live, with no flicker. The
 * server sends a strict CSP (no scripts); links open externally.
 */
export function PageView({ streamUrl, loading, sources, onReady, onOpenSource }: PageViewProps) {
  const [showSources, setShowSources] = useState(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        {/* Indeterminate top progress bar while the page streams in. */}
        {loading && (
          <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-transparent">
            <div className="h-full w-1/3 animate-[toji-load_1.1s_ease-in-out_infinite] bg-neutral-900/70 dark:bg-white/70" />
          </div>
        )}
        {streamUrl ? (
          <iframe
            key={streamUrl}
            src={streamUrl}
            onLoad={onReady}
            className="h-full w-full border-0 bg-white dark:bg-neutral-950"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            title="Toji page"
          />
        ) : (
          <div className="absolute inset-0" />
        )}
      </div>

      {sources.length > 0 && (
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
      )}
    </div>
  );
}
