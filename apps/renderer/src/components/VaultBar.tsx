import { Check, KeyRound, ShieldOff, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { bridge, type VaultEntry, type VaultPrompt } from '../lib/bridge';
import type { Container } from '../lib/containers';

/**
 * Ask whether to keep a login the user just submitted.
 *
 * Shown only when automatic saving is off (see lib/vaultAutosave.ts) or when Toji could
 * not tell whether the sign-in worked. A small bubble hanging off the omnibox — the key,
 * who and where, a tick and a cross — rather than a bar that pushed the page down.
 *
 * The password is held in the main process and never reaches this component: the prompt
 * only knows which site and account it is for, which is all it needs to show.
 */
export function VaultPromptBar({
  prompt,
  container,
  onDone,
  error: initialError
}: {
  prompt: VaultPrompt;
  container: Container;
  onDone: () => void;
  /** A failure from an automatic save, so the bubble opens already explaining it. */
  error?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

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
    if (prompt.status !== 'saved' && !error) await bridge().vaultDismiss?.(prompt.webContentsId);
    onDone();
  };

  const site = prompt.origin.replace(/^https?:\/\//, '');
  const who = prompt.username || site;
  const verb = prompt.status === 'update' ? 'Update the password' : 'Save the password';
  const question = `${verb} for ${who}${prompt.username ? ` on ${site}` : ''} in ${container.name}?`;
  // A password Toji generated was used on this site — it is already in the vault, so
  // there is nothing to decide, only to notice.
  const decided = Boolean(error) || prompt.status === 'saved';
  const ghost =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-500 transition enabled:hover:bg-black/[0.06] enabled:hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:enabled:hover:bg-white/10 dark:enabled:hover:text-white';

  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      role="dialog"
      aria-label={error ? `Could not save: ${error}` : prompt.status === 'saved' ? `Saved the password for ${who}` : question}
      data-testid="vault-prompt"
      className="no-drag absolute right-0 top-[calc(100%+9px)] z-50 flex h-9 max-w-[min(440px,80vw)] items-center rounded-xl border border-black/10 bg-white pl-3 pr-1 text-[12.5px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)] dark:border-white/12 dark:bg-neutral-900"
    >
      {/* The tail, pointing up at the omnibox this belongs to. */}
      <span aria-hidden className="absolute -top-[6px] right-[15px] h-[11px] w-[11px] rotate-45 rounded-[2px] border-l border-t border-black/10 bg-white dark:border-white/12 dark:bg-neutral-900" />
      <KeyRound size={13} className="shrink-0 text-neutral-500 dark:text-neutral-400" />
      <span className="mx-2 min-w-0 truncate text-neutral-600 dark:text-neutral-300" title={question}>
        {error ? (
          <span className="text-rose-600 dark:text-rose-400">{error}</span>
        ) : (
          <>
            <span className="font-medium text-neutral-900 dark:text-neutral-100">{who}</span>
            {prompt.username && <span className="text-neutral-400"> · {site}</span>}
            {prompt.status === 'saved' && <span className="text-neutral-400"> · saved</span>}
            {prompt.status === 'update' && <span className="text-neutral-400"> · new password</span>}
          </>
        )}
      </span>
      <span className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: container.color }} title={`${container.name} container`} />
      {!decided && (
        <button type="button" onClick={save} disabled={busy} aria-label={prompt.status === 'update' ? 'Update password' : 'Save password'} title={prompt.status === 'update' ? 'Update' : 'Save'} className={ghost}>
          <Check size={14} />
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label={decided ? 'Close' : 'Not now'} title={decided ? 'Close' : 'Not now'} className={ghost}>
        <X size={14} />
      </button>
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
