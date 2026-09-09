import { Check, KeyRound, ShieldOff, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { bridge, type VaultEntry, type VaultPrompt } from '../lib/bridge';
import type { Container } from '../lib/containers';

/**
 * Offer to save a login the user just submitted.
 *
 * A card hanging off the omnibox — the way every browser asks — rather than a bar that
 * shoves the page down. The password is held in the main process and never reaches
 * this component: the prompt only knows which site and account it is for, which is
 * all it needs to show.
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
  const title = error
    ? 'Could not save'
    : prompt.status === 'saved'
      ? 'Password saved'
      : prompt.status === 'update'
        ? 'Update password?'
        : 'Save password?';
  // A password Toji generated was used on this site — it is already in the vault, so
  // there is nothing to decide, only to notice.
  const decided = Boolean(error) || prompt.status === 'saved';

  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      role="dialog"
      aria-label={title}
      data-testid="vault-prompt"
      className="no-drag absolute right-0 top-[calc(100%+8px)] z-50 w-[340px] rounded-2xl border border-black/10 bg-white p-4 text-neutral-900 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.35)] dark:border-white/12 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
          <KeyRound size={16} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13.5px] font-semibold leading-tight">{title}</p>
          <p className="mt-1 truncate text-[12.5px] text-neutral-500" title={error ?? `${prompt.username || site} on ${site}`}>
            {error ? (
              <span className="text-rose-600 dark:text-rose-400">{error}</span>
            ) : (
              <>
                <span className="font-medium text-neutral-700 dark:text-neutral-300">{prompt.username || site}</span>
                {prompt.username && <> · {site}</>}
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={decided ? 'Close' : 'Not now'}
          className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-3.5 flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11.5px] text-neutral-600 dark:bg-white/10 dark:text-neutral-300" title={`Saved in the ${container.name} container`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: container.color }} />
          <span className="truncate">{container.name}</span>
        </span>
        {!decided && (
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              <Check size={12} />
              {prompt.status === 'update' ? 'Update' : 'Save'}
            </button>
          </span>
        )}
      </div>
    </motion.div>
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
