import { ArrowLeft, Ban, Clock, Globe, RotateCw, ShieldAlert, Unplug, WifiOff, type LucideIcon } from 'lucide-react';
import { describeLoadError, hostOfUrl, type LoadErrorKind, type LoadFailure } from '../lib/loadError';
import { FIELD_BUTTON, FIELD_BUTTON_QUIET } from '../lib/fieldStyles';

const ICONS: Record<LoadErrorKind, LucideIcon> = {
  offline: WifiOff,
  notfound: Globe,
  refused: Unplug,
  timeout: Clock,
  interrupted: Unplug,
  insecure: ShieldAlert,
  blocked: Ban,
  address: Globe,
  generic: Globe
};

/**
 * What a tab shows instead of Chromium's blank page when a load fails: a sentence
 * about the site, the address, the code for anyone who wants it, and a way forward.
 * Drawn in Toji's own chrome so it reads as part of the browser, not as a page.
 */
export function LoadErrorPage({ failure, tor, canBack, onRetry, onBack }: { failure: LoadFailure; tor?: boolean; canBack?: boolean; onRetry: () => void; onBack: () => void }) {
  const copy = describeLoadError(failure, { tor });
  const Icon = ICONS[copy.kind];
  return (
    <div data-testid="load-error" className="absolute inset-0 z-10 flex items-center justify-center bg-white px-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex w-[min(460px,100%)] flex-col items-center pb-[8vh] text-center">
        <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-full bg-black/[0.05] text-neutral-600 dark:bg-white/[0.07] dark:text-neutral-300">
          <Icon size={24} strokeWidth={1.75} />
        </span>
        <h1 className="text-[20px] font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-neutral-500">{copy.detail}</p>
        <p className="mt-4 max-w-full truncate rounded-lg bg-black/[0.04] px-2.5 py-1 font-mono text-[11.5px] text-neutral-500 dark:bg-white/[0.06]" title={failure.url}>
          {hostOfUrl(failure.url) === failure.url ? failure.url : failure.url}
          {failure.description && <span className="text-neutral-400"> · {failure.description}</span>}
        </p>
        <div className="mt-6 flex items-center gap-2">
          {canBack && (
            <button type="button" onClick={onBack} className={FIELD_BUTTON_QUIET}>
              <ArrowLeft size={13} /> Go back
            </button>
          )}
          {copy.retry && (
            <button type="button" onClick={onRetry} className={FIELD_BUTTON}>
              <RotateCw size={13} /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
