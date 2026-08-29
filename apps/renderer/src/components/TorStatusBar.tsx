import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { bridge, type TorStatus } from '../lib/bridge';
import type { Container } from '../lib/containers';

/**
 * Tor signal pinned to the toolbar's lower edge, shown while the active identity routes
 * over Tor. While bootstrapping it is a non-layout-affecting 2px progress line. When Tor
 * is down (off/error) the container is genuinely offline — the kill switch cancels its
 * traffic rather than falling back to a direct connection — so that state gets a real,
 * readable strip with a retry: the UI must SAY the container is offline, never imply
 * protection that isn't there. Nothing is shown once Tor is ready.
 */
export function TorStatusBar({ container, status }: { container: Container; status: TorStatus }) {
  const [busy, setBusy] = useState(false);
  if (container.egress !== 'tor') return null;

  const bootstrapping = status.state === 'starting' || status.state === 'bootstrapping';
  const failed = status.state === 'error' || status.state === 'off';

  if (bootstrapping) {
    const progress = Math.max(3, Math.min(100, status.progress));
    const label = `${container.name} is connecting to Tor: ${status.progress}%`;
    return (
      <div className="pointer-events-none absolute inset-x-0 -bottom-px z-40 h-[2px] overflow-hidden" role="status" aria-label={label} title={status.detail}>
        <span
          className="block h-full bg-amber-400/35 transition-[width] duration-500 ease-out dark:bg-amber-300/30"
          style={{ width: `${progress}%` }}
        />
      </div>
    );
  }

  if (!failed) return null;

  const retry = async () => {
    setBusy(true);
    try {
      await bridge().torStart?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-drag absolute inset-x-0 top-full z-40 flex items-center gap-2 border-b border-rose-500/20 bg-rose-50 px-3 py-1 text-[12px] text-rose-700 dark:bg-rose-950 dark:text-rose-300" role="alert">
      <TriangleAlert size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{container.name} is offline.</span> {status.detail}
      </span>
      <button type="button" onClick={retry} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-rose-500/10 disabled:opacity-40">
        <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} />
        Retry
      </button>
    </div>
  );
}
