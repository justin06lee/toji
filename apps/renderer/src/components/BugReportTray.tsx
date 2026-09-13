import { Check, CircleAlert, FolderOpen, Loader2, Paperclip, RotateCw, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portalRoot';
import { bridge } from '../lib/bridge';
import type { FormReportResult } from './BugReportSheet';

export type TrayStatus = 'waiting' | 'attaching' | 'attached' | 'failed' | 'filed';

/** A report being finished on GitHub's own form, in the tab `tabId`. */
export interface FormReport {
  result: FormReportResult;
  tabId: string;
  status: TrayStatus;
  /** The issue GitHub created, once the form was submitted. */
  number?: number;
  error?: string;
}

const small =
  'inline-flex h-7 items-center gap-1.5 rounded-lg border border-black/10 px-2 text-[12px] text-neutral-700 transition hover:border-black/30 dark:border-white/12 dark:text-neutral-200 dark:hover:border-white/30';

/**
 * The note that rides along over GitHub's issue form while a report is finished there:
 * sign in first, the files are being attached, they are attached, or — when attaching by
 * itself failed — the files themselves, to drag onto the form by hand.
 */
export function BugReportTray({ report, onForm, onRetry, onDismiss }: { report: FormReport; onForm: boolean; onRetry: () => void; onDismiss: () => void }) {
  const { result, status } = report;
  const files = result.files;
  const what = files.length === 1 ? (files[0].startsWith('recording.') ? 'your recording' : 'your image') : 'your files';
  const isMacOS = bridge().platform === 'darwin';

  let icon: ReactNode;
  let heading: string;
  let message: string | null;
  switch (status) {
    case 'attaching':
      icon = <Loader2 size={15} className="animate-spin" />;
      heading = 'Attaching…';
      message = `Adding ${what} to the issue.`;
      break;
    case 'attached':
      icon = <Check size={15} />;
      heading = 'Attached';
      message = 'Look the issue over, then submit it on GitHub.';
      break;
    case 'failed':
      icon = <CircleAlert size={15} className="text-amber-500" />;
      heading = 'Drag the files in';
      message = `Toji couldn’t attach ${what} by itself. Drag ${files.length === 1 ? 'it' : 'them'} onto the issue’s description:`;
      break;
    case 'filed':
      icon = <Check size={15} />;
      heading = report.number ? `Filed as #${report.number}` : 'Filed';
      message = 'Thank you for sending it.';
      break;
    default:
      icon = <Loader2 size={15} className="animate-spin" />;
      heading = 'Finishing on GitHub';
      message = !files.length ? null : onForm ? 'Opening the form…' : `Sign in to GitHub in this tab. Toji attaches ${what} once the issue form opens.`;
  }

  return createPortal(
    <motion.div
      className="no-drag fixed bottom-4 right-4 z-[110] w-[330px] rounded-2xl border border-black/10 bg-white/95 p-3.5 shadow-xl backdrop-blur-xl dark:border-white/12 dark:bg-neutral-900/95"
      data-testid="bug-report-tray"
      data-status={status}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px shrink-0 text-neutral-500">{icon}</span>
        <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
          <div className="font-medium text-neutral-900 dark:text-neutral-100">{heading}</div>
          {message && <p className="mt-0.5 text-neutral-500">{message}</p>}
          {result.bodyOnClipboard && status !== 'filed' && (
            <p className="mt-1 text-neutral-500">The description was too long for the link, so it’s on your clipboard. Paste it into the form.</p>
          )}
          {status === 'failed' && (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((name) => (
                  <span
                    key={name}
                    draggable
                    onDragStart={(event) => {
                      // The drag itself is the operating system's, started from the main
                      // process, so it carries the real file.
                      event.preventDefault();
                      bridge().dragBugReportFile?.(result.reportId, name);
                    }}
                    title="Drag onto the issue’s description"
                    className="inline-flex cursor-grab items-center gap-1.5 rounded-lg bg-black/[0.05] px-2 py-1 text-[12px] text-neutral-700 active:cursor-grabbing dark:bg-white/10 dark:text-neutral-200"
                  >
                    <Paperclip size={12} className="shrink-0" />
                    {name}
                  </span>
                ))}
              </div>
              <div className="mt-2.5 flex gap-2">
                <button type="button" className={small} onClick={onRetry}>
                  <RotateCw size={12} /> Try again
                </button>
                <button type="button" className={small} onClick={() => void bridge().revealBugReport?.(result.reportId)}>
                  <FolderOpen size={12} /> {isMacOS ? 'Show in Finder' : 'Show in folder'}
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
    </motion.div>,
    portalRoot()
  );
}
