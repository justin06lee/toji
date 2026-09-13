import { Camera, Check, CircleAlert, ExternalLink, FileText, ImagePlus, Loader2, Video, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portalRoot';
import { bridge, type BugReportAccount, type BugReportDraft, type BugReportFile, type BugReportResult } from '../lib/bridge';
import { draftProblem, formatBytes, imageProblem, MAX_IMAGES, REPLAY_SECONDS, routeLine } from '../lib/bugReport';
import { FIELD, FIELD_BUTTON, FIELD_BUTTON_QUIET, FIELD_TEXTAREA } from '../lib/fieldStyles';
import { hostOf } from '../lib/nav';
import type { ReplayClip } from '../lib/replayRecorder';
import { Switch } from './Switch';

export type FormReportResult = Extract<BugReportResult, { ok: true; mode: 'form' }>;

/** What the window hands the sheet as it opens. */
export interface BugReportRequest {
  /** The recording, still being written as the sheet opens; null when there cannot be one. */
  clip: Promise<ReplayClip | null> | null;
  /** Why there is no recording: switched off, a private window, or nothing here to record with. */
  unavailable: 'off' | 'private' | 'unsupported' | null;
  /** A still of the window from just before the sheet covered it. */
  screenshot: Blob | null;
  /** The address of the page in front: offered, but only sent when chosen. */
  pageUrl: string | null;
  context: { window: string; layout: string; theme: string };
}

interface BugReportSheetProps {
  request: BugReportRequest;
  /** Pixels taken by the sidebar — the sheet centers over the rest. */
  insetLeft?: number;
  onOpenUrl: (url: string) => void;
  onOpenSettings: () => void;
  /** The form route: GitHub's form opens in a tab, and these files get dropped onto it. */
  onContinueOnGitHub: (result: FormReportResult) => void;
  onClose: () => void;
}

type Kind = 'recording' | 'written';
type ClipState = { status: 'loading' } | { status: 'ready'; clip: ReplayClip; url: string } | { status: 'none' };
interface Attached {
  id: string;
  blob: Blob;
  name: string;
  url: string;
}

const SCREENSHOT_ID = 'window-screenshot';
const fieldLabel = 'mb-1.5 block text-[12px] font-medium text-neutral-500 dark:text-neutral-400';
let attachedCount = 0;

/**
 * Help › Report a Bug…: the window's last 15 seconds, or a written report with images,
 * filed as an issue on Toji's GitHub repository. See apps/desktop/bug-report.cjs for how
 * it gets there.
 */
export function BugReportSheet({ request, insetLeft = 0, onOpenUrl, onOpenSettings, onContinueOnGitHub, onClose }: BugReportSheetProps) {
  const [kind, setKind] = useState<Kind>(request.clip ? 'recording' : 'written');
  // Once the reporter picks a mode themselves, nothing switches it for them.
  const kindChosen = useRef(false);
  const [clipState, setClipState] = useState<ClipState>(request.clip ? { status: 'loading' } : { status: 'none' });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<Attached[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [imageError, setImageError] = useState<string | null>(null);
  const [includePage, setIncludePage] = useState(false);
  const [account, setAccount] = useState<BugReportAccount | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; canUseForm: boolean } | null>(null);
  const [filed, setFiled] = useState<{ number: number; url: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const screenshotUrl = useObjectUrl(request.screenshot);

  // Each image's preview is released as it is removed, and the rest when the sheet closes.
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);
  useEffect(() => {
    void bridge()
      .bugReportAccount?.()
      .then(setAccount)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!request.clip) return;
    let alive = true;
    let url: string | null = null;
    void request.clip.then((clip) => {
      if (!alive) return;
      if (!clip) {
        setClipState({ status: 'none' });
        if (!kindChosen.current) setKind('written');
        return;
      }
      url = URL.createObjectURL(clip.blob);
      setClipState({ status: 'ready', clip, url });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [request.clip]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, sending]);

  const chooseKind = (next: Kind) => {
    kindChosen.current = true;
    setKind(next);
    setError(null);
  };

  const addImages = (files: Array<Blob & { name?: string }>, id?: string) => {
    const next = [...imagesRef.current];
    let problem: string | null = null;
    for (const file of files) {
      const name = file.name || 'Pasted image';
      const rejected = imageProblem({ name, type: file.type, size: file.size });
      if (rejected) {
        problem = rejected;
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        problem = `A report carries at most ${MAX_IMAGES} images.`;
        break;
      }
      next.push({ id: id ?? `image-${(attachedCount += 1)}`, blob: file, name, url: URL.createObjectURL(file) });
    }
    // Ahead of the render, so a second add in the same moment builds on this one.
    imagesRef.current = next;
    setImages(next);
    setImageError(problem);
  };

  /** Images pasted or dropped anywhere on the sheet make it a written report. */
  const takeImages = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return false;
    chooseKind('written');
    addImages(files);
    return true;
  };

  const clip = clipState.status === 'ready' ? clipState.clip : null;
  const problem = draftProblem(kind, { title, description, hasRecording: Boolean(clip) });

  const send = async (via?: 'form') => {
    if (sending || problem) return;
    const submit = bridge().submitBugReport;
    if (!submit) {
      setError({ message: 'Filing a report needs the Toji desktop app.', canUseForm: false });
      return;
    }
    setSending(true);
    setError(null);
    try {
      const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
      const files: BugReportFile[] = [];
      if (kind === 'recording' && clip) {
        files.push({ type: clip.type, role: 'recording', data: await bytes(clip.blob) });
        if (clip.poster) files.push({ type: 'image/png', role: 'poster', data: await bytes(clip.poster) });
      } else if (kind === 'written') {
        for (const image of images) files.push({ type: image.blob.type, role: 'image', data: await bytes(image.blob) });
      }
      const draft: BugReportDraft = {
        kind,
        title,
        description,
        pageUrl: includePage && request.pageUrl ? request.pageUrl : undefined,
        seconds: kind === 'recording' ? clip?.seconds : undefined,
        context: request.context,
        files,
        via
      };
      const result = await submit(draft);
      if (!result.ok) {
        setError({ message: result.error, canUseForm: Boolean(result.canUseForm) });
        return;
      }
      if (result.mode === 'form') {
        onContinueOnGitHub(result);
        onClose();
        return;
      }
      setFiled({ number: result.number, url: result.url });
    } catch (failure) {
      setError({ message: failure instanceof Error ? failure.message : String(failure), canUseForm: false });
    } finally {
      setSending(false);
    }
  };

  const tab = (value: Kind, icon: ReactNode, text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === value}
      onClick={() => chooseKind(value)}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition ${
        kind === value ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white' : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
      }`}
    >
      {icon}
      {text}
    </button>
  );

  const screenshotAdded = images.some((image) => image.id === SCREENSHOT_ID);

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]"
      style={{ paddingLeft: 24 + insetLeft }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1, ease: 'easeOut' }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug"
        data-testid="bug-report-sheet"
        className={`no-drag flex max-h-[min(780px,92vh)] w-[min(600px,92vw)] flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl transition-colors dark:bg-neutral-900 ${
          dragOver ? 'border-neutral-900/40 dark:border-white/40' : 'border-black/10 dark:border-white/12'
        }`}
        onPaste={(event) => {
          if (!filed && takeImages(event.clipboardData?.files)) event.preventDefault();
        }}
        onDragOver={(event) => {
          if (filed || !Array.from(event.dataTransfer.types).includes('Files')) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (!filed) takeImages(event.dataTransfer.files);
        }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
      >
        {filed ? (
          <div className="flex flex-col items-center px-8 py-10 text-center" data-testid="bug-report-filed">
            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
              <Check size={18} />
            </span>
            <h2 className="text-[15px] font-semibold">Filed as #{filed.number}</h2>
            <p className="mt-1 text-[13px] text-neutral-500">It’s on GitHub now. Thank you for sending it.</p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className={FIELD_BUTTON_QUIET}
                onClick={() => {
                  onOpenUrl(filed.url);
                  onClose();
                }}
              >
                <ExternalLink size={13} /> Open the issue
              </button>
              <button type="button" className={FIELD_BUTTON} onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 pt-4">
              <h2 className="text-[15px] font-semibold">Report a bug</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                disabled={sending}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-800 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X size={15} />
              </button>
            </div>
            <div className="px-5 pt-3">
              <div role="tablist" className="inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.07]">
                {tab('recording', <Video size={14} />, `Last ${REPLAY_SECONDS} seconds`)}
                {tab('written', <FileText size={14} />, 'Written report')}
              </div>
            </div>
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            >
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                {kind === 'recording' ? (
                  <RecordingPreview state={clipState} unavailable={request.unavailable} onOpenSettings={onOpenSettings} />
                ) : null}
                <div>
                  <label className={fieldLabel} htmlFor="bug-report-title">
                    Title
                  </label>
                  <input
                    id="bug-report-title"
                    autoFocus
                    value={title}
                    maxLength={256}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="What went wrong, in a few words"
                    className={FIELD}
                  />
                </div>
                <div>
                  <label className={fieldLabel} htmlFor="bug-report-description">
                    {kind === 'written' ? 'What happened' : 'Anything else'}
                    {kind === 'recording' && <span className="font-normal text-neutral-400"> (optional)</span>}
                  </label>
                  <textarea
                    id="bug-report-description"
                    rows={kind === 'written' ? 6 : 3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={
                      kind === 'written'
                        ? 'What you did, what happened, and what you expected instead. Steps that make it happen again help most.'
                        : 'What to look for in the recording, or what you expected to happen.'
                    }
                    className={FIELD_TEXTAREA}
                  />
                </div>
                {kind === 'written' && (
                  <div>
                    <span className={fieldLabel}>
                      Images <span className="font-normal text-neutral-400">(optional; paste or drop them here too)</span>
                    </span>
                    <div className="grid grid-cols-4 gap-2">
                      {images.map((image) => (
                        <div key={image.id} className="group relative aspect-square overflow-hidden rounded-lg border border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.04]">
                          <img src={image.url} alt={image.name} className="h-full w-full object-cover" />
                          <button
                            type="button"
                            aria-label={`Remove ${image.name}`}
                            onClick={() => {
                              URL.revokeObjectURL(image.url);
                              setImages((current) => current.filter((item) => item.id !== image.id));
                            }}
                            className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                      {screenshotUrl && request.screenshot && !screenshotAdded && images.length < MAX_IMAGES && (
                        <button
                          type="button"
                          title="Attach a screenshot of the window as it was"
                          onClick={() => request.screenshot && addImages([Object.assign(request.screenshot, { name: 'Window screenshot' })], SCREENSHOT_ID)}
                          className="group relative aspect-square overflow-hidden rounded-lg border border-dashed border-black/15 dark:border-white/15"
                        >
                          <img src={screenshotUrl} alt="" className="h-full w-full object-cover opacity-55 transition group-hover:opacity-90" />
                          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-white/90 py-1 text-[11px] font-medium text-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200">
                            <Camera size={11} /> Screenshot
                          </span>
                        </button>
                      )}
                      {images.length < MAX_IMAGES && (
                        <button
                          type="button"
                          onClick={() => fileInput.current?.click()}
                          className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-black/15 text-[11.5px] text-neutral-500 transition hover:border-black/30 hover:text-neutral-800 dark:border-white/15 dark:hover:border-white/30 dark:hover:text-neutral-200"
                        >
                          <ImagePlus size={16} /> Add images
                        </button>
                      )}
                    </div>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        addImages(Array.from(event.target.files ?? []));
                        event.target.value = '';
                      }}
                    />
                    {imageError && <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{imageError}</p>}
                  </div>
                )}
                {request.pageUrl && (
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-black/10 px-3 py-2.5 dark:border-white/10">
                    <div className="min-w-0">
                      <div className="text-[13px]">Include the page’s address</div>
                      <p className="truncate text-[12px] text-neutral-500">{hostOf(request.pageUrl) || request.pageUrl} stays out of the report unless you turn this on. Reports are public.</p>
                    </div>
                    <Switch checked={includePage} onChange={setIncludePage} label="Include the page’s address" />
                  </div>
                )}
              </div>
              <div className="border-t border-black/[0.06] px-5 py-3.5 dark:border-white/[0.08]">
                {error && (
                  <div className="mb-3 flex items-start gap-2 text-[12.5px] text-red-600 dark:text-red-400" role="alert">
                    <CircleAlert size={14} className="mt-0.5 shrink-0" />
                    <span>
                      {error.message}
                      {error.canUseForm && (
                        <>
                          {' '}
                          <button type="button" className="font-medium underline underline-offset-2" onClick={() => void send('form')}>
                            Finish on GitHub’s form instead
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <p className="min-w-0 flex-1 text-[12px] leading-snug text-neutral-500" data-testid="bug-report-route">
                    {routeLine(account)}
                  </p>
                  <button type="button" className={FIELD_BUTTON_QUIET} onClick={onClose} disabled={sending}>
                    Cancel
                  </button>
                  <button type="submit" className={FIELD_BUTTON} disabled={sending || Boolean(problem)} title={problem ?? undefined}>
                    {sending ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> Sending…
                      </>
                    ) : account?.mode === 'form' ? (
                      <>
                        Continue on GitHub <ExternalLink size={13} />
                      </>
                    ) : (
                      'Submit report'
                    )}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </motion.div>
    </motion.div>,
    portalRoot()
  );
}

/** An object URL for `blob` while the component shows it, released after. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function RecordingPreview({ state, unavailable, onOpenSettings }: { state: ClipState; unavailable: BugReportRequest['unavailable']; onOpenSettings: () => void }) {
  if (state.status === 'ready') {
    const { clip, url } = state;
    return (
      <div>
        <video
          src={url}
          controls
          autoPlay
          muted
          loop
          playsInline
          data-testid="bug-report-video"
          // Sized by the video's own shape within these limits, so it never gets bars.
          className="mx-auto block h-auto max-h-[300px] w-auto max-w-full rounded-xl bg-black"
        />
        <p className="mt-1.5 text-center text-[12px] text-neutral-500">
          {Math.round(clip.seconds)} s · {formatBytes(clip.blob.size)} · this window, up to the moment you opened the report
        </p>
      </div>
    );
  }
  const box = 'flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-xl bg-black/[0.04] px-6 text-center text-[12.5px] text-neutral-500 dark:bg-white/[0.05]';
  if (state.status === 'loading') {
    return (
      <div className={box}>
        <Loader2 size={16} className="animate-spin" />
        Preparing the recording…
      </div>
    );
  }
  return (
    <div className={box}>
      {unavailable === 'off' ? (
        <>
          <span>The rolling recording is switched off, so there’s nothing to send.</span>
          <button type="button" onClick={onOpenSettings} className="font-medium text-neutral-800 underline underline-offset-2 dark:text-neutral-200">
            Turn it on in Settings
          </button>
        </>
      ) : unavailable === 'private' ? (
        <span>Private and Tor windows are never recorded. Write the report instead; a screenshot can go with it.</span>
      ) : unavailable === 'unsupported' ? (
        <span>This copy of Toji can’t record its window here. Write the report instead.</span>
      ) : (
        <span>Nothing has been recorded yet. The window keeps its last {REPLAY_SECONDS} seconds from the moment it opens.</span>
      )}
    </div>
  );
}
