import { Check, KeyRound, ShieldOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bridge, type VaultEntry, type VaultPrompt } from '../lib/bridge';
import type { Container } from '../lib/containers';

/**
 * Offer to save a login the user just submitted.
 *
 * The password is held in the main process and never reaches this component — the
 * prompt only knows which site and account it is for, which is all it needs to show.
 */
export function VaultPromptBar({
  prompt,
  container,
  onDone
}: {
  prompt: VaultPrompt;
  container: Container;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    const result = await bridge().vaultCommit?.(prompt.webContentsId);
    setBusy(false);
    if (result && !result.ok) {
      setError(result.error);
      return;
    }
    onDone();
  };

  const dismiss = async () => {
    if (prompt.status !== 'saved') await bridge().vaultDismiss?.(prompt.webContentsId);
    onDone();
  };

  const site = prompt.origin.replace(/^https?:\/\//, '');

  return (
    <div className="no-drag flex items-center gap-2.5 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-1.5 text-[12px] dark:border-white/12 dark:bg-white/[0.05]">
      <KeyRound size={13} className="shrink-0 text-neutral-400" />
      <span className="min-w-0 flex-1 truncate">
        {error ? (
          <span className="text-rose-600 dark:text-rose-400">Could not save: {error}</span>
        ) : prompt.status === 'saved' ? (
          // A password Toji generated was used on this site — it's already in the vault.
          <>
            Saved the login for <span className="font-medium">{prompt.username || site}</span>
            {prompt.username && <span className="text-neutral-400"> on {site}</span>} in{' '}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: container.color }} />
              {container.name}
            </span>
            .
          </>
        ) : (
          <>
            {prompt.status === 'update' ? 'Update the password' : 'Save the password'} for{' '}
            <span className="font-medium">{prompt.username || site}</span>
            {prompt.username && <span className="text-neutral-400"> on {site}</span>} in{' '}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: container.color }} />
              {container.name}
            </span>
            ?
          </>
        )}
      </span>
      {!error && prompt.status !== 'saved' && (
        <button type="button" onClick={save} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-neutral-900 px-2 py-1 text-white transition hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
          <Check size={11} />
          {prompt.status === 'update' ? 'Update' : 'Save'}
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-black/10 hover:text-neutral-900 dark:hover:bg-white/15 dark:hover:text-white">
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * The key button in the omnibox. Appears only when the page has a password field and
 * this container holds a credential for that exact origin. Clicking asks the main
 * process to fill it — the password goes main → page, never through here.
 */
export function VaultFillButton({ matches, onFill }: { matches: VaultEntry[]; onFill: (entryId: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!matches.length) return null;

  const click = () => {
    // One credential is the overwhelmingly common case: fill it without a menu.
    if (matches.length === 1) onFill(matches[0].id);
    else setOpen((o) => !o);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={click}
        title={matches.length === 1 ? `Fill password for ${matches[0].username || 'this site'}` : 'Fill a saved password'}
        aria-label="Fill saved password"
        className="mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white"
      >
        <KeyRound size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[220px] overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/12 dark:bg-neutral-900">
          {matches.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                onFill(entry.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.07]"
            >
              <KeyRound size={12} className="shrink-0 text-neutral-400" />
              <span className="truncate">{entry.username || '(no username)'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown in settings when the OS gives us nowhere safe to keep secrets. */
export function VaultUnavailable({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] p-3 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
      <ShieldOff size={13} className="mt-px shrink-0" />
      {message}
    </p>
  );
}
