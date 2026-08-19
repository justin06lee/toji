import { Loader2, RefreshCw, Route, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { bridge, type TorStatus } from '../lib/bridge';
import type { Container } from '../lib/containers';

/**
 * A strip shown under the toolbar whenever the current tab is in a Tor container.
 *
 * It exists because the kill switch makes a Tor container genuinely offline until Tor
 * connects — without this the tab would just look broken. It says plainly what is
 * happening, and never claims protection that isn't in place yet.
 */
export function TorStatusBar({ container, status }: { container: Container; status: TorStatus }) {
  const [busy, setBusy] = useState(false);
  if (container.egress !== 'tor') return null;

  const bootstrapping = status.state === 'starting' || status.state === 'bootstrapping';
  const failed = status.state === 'error' || status.state === 'off';

  const tone = status.ready
    ? 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300'
    : failed
      ? 'border-rose-500/25 bg-rose-500/[0.07] text-rose-700 dark:text-rose-300'
      : 'border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300';

  const newCircuit = async () => {
    setBusy(true);
    try {
      await bridge().torNewCircuit?.();
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await bridge().torStart?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`no-drag flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-[12px] ${tone}`}>
      {bootstrapping ? <Loader2 size={13} className="shrink-0 animate-spin" /> : failed ? <TriangleAlert size={13} className="shrink-0" /> : <Route size={13} className="shrink-0" />}

      <span className="min-w-0 flex-1 truncate">
        {status.ready ? (
          <>
            <span className="font-medium">{container.name} is routed over Tor.</span>{' '}
            {status.isolated ? 'This container has its own circuits.' : 'Using an external Tor — all Tor containers share its circuits.'}
          </>
        ) : bootstrapping ? (
          <>
            <span className="font-medium">{container.name} is offline while Tor connects.</span> {status.detail}
          </>
        ) : (
          <>
            <span className="font-medium">{container.name} is offline.</span> {status.detail}
          </>
        )}
      </span>

      {bootstrapping && (
        <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-current/20">
          <span className="block h-full rounded-full bg-current transition-[width] duration-500" style={{ width: `${Math.max(4, status.progress)}%` }} />
        </span>
      )}

      {status.ready ? (
        <button type="button" onClick={newCircuit} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-current/10 disabled:opacity-40">
          <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} />
          New circuit
        </button>
      ) : failed ? (
        <button type="button" onClick={retry} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-current/10 disabled:opacity-40">
          <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} />
          Retry
        </button>
      ) : null}
    </div>
  );
}
