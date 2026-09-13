import { PageSources } from './PageSources';
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

      <PageSources sources={sources} onOpenSource={onOpenSource} />
    </div>
  );
}
