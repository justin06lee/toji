import { Bug, Camera, Check, CircleAlert, ExternalLink, FileText, ImagePlus, Loader2, Video, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bridge, type BridgeReplayClip, type BugReportAccount, type BugReportDraft, type BugReportFile } from '../lib/bridge';
import { useBrowserSettings } from '../lib/browserSettings';
import { draftProblem, formatBytes, MAX_IMAGES, REPLAY_SECONDS, routeLine } from '../lib/bugReport';
import { FIELD, FIELD_BUTTON, FIELD_BUTTON_QUIET, FIELD_TEXTAREA } from '../lib/fieldStyles';
import { hostOf } from '../lib/nav';
import { acceptImages, formRouteClose, type ReportRequest } from '../lib/reportPage';
import { Switch } from './Switch';

interface BugReportPageProps {
  /** What the browser opened about:report with (see readReportQuery). */
  request: ReportRequest;
  onOpenUrl: (url: string) => void;
  onOpenSettings: () => void;
  /** Close this page's tab. */
  onClose: () => void;
}

type Kind = 'recording' | 'written';
type ClipState = { status: 'loading' } | { status: 'ready'; clip: BridgeReplayClip; size: number; url: string } | { status: 'none' };
interface Attached {
  id: string;
  blob: Blob;
  name: string;
  url: string;
}

const SCREENSHOT_ID = 'window-screenshot';
const fieldLabel = 'mb-1.5 block text-[12px] font-medium text-neutral-500 dark:text-neutral-400';
let attachedCount = 0;

const toBlob = (part: { type: string; data: Uint8Array }) => new Blob([part.data as Uint8Array<ArrayBuffer>], { type: part.type });

/**
 * about:report — Help › Report a Bug… in the Gecko browser, as a page of its own rather
 * than a sheet over the window. The same report as components/BugReportSheet.tsx: a
 * written report with images (and the still the browser took as the report opened), or
 * the window's last seconds when the browser keeps them. Everything it needs from the
 * browser is feature-detected, so it still renders, calmly, without the bridge.
 */
export function BugReportPage({ request, onOpenUrl, onOpenSettings, onClose }: BugReportPageProps) {
  const toji = bridge();
  // No replayClip call, no recording: the page is a written report and never mentions one.
  const canRecord = Boolean(toji.replayClip);
  const canSubmit = Boolean(toji.submitBugReport);
  const canAsk = Boolean(toji.bugReportAccount);
  const settings = useBrowserSettings();

  const [kind, setKind] = useState<Kind>(canRecord ? 'recording' : 'written');
  // Once the reporter picks a mode themselves, nothing switches it for them.
  const kindChosen = useRef(false);
  const [clipState, setClipState] = useState<ClipState>(canRecord ? { status: 'loading' } : { status: 'none' });
  const [screenshot, setScreenshot] = useState<Blob | null>(null);
  const screenshotUrl = useObjectUrl(screenshot);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<Attached[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [imageError, setImageError] = useState<string | null>(null);
  const [includePage, setIncludePage] = useState(false);
  const [account, setAccount] = useState<BugReportAccount | null>(null);
  const [accountFailed, setAccountFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; canUseForm: boolean } | null>(null);
  const [filed, setFiled] = useState<{ number: number; url: string } | null>(null);
  // GitHub's form has taken over in another tab; the page is on its way out.
  const [handedOff, setHandedOff] = useState<{ notice: string | null } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  // Each image's preview is released as it is removed, and the rest when the page goes.
  useEffect(
    () => () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
      window.clearTimeout(closeTimer.current);
    },
    []
  );
  useEffect(() => {
    let alive = true;
    const toji = bridge();
    if (toji.bugReportAccount) {
      toji.bugReportAccount().then(
        (next) => alive && setAccount(next),
        () => alive && setAccountFailed(true)
      );
    }
    void toji
      .captureWindow?.()
      .then((shot) => {
        if (alive && shot?.data?.length) setScreenshot(toBlob(shot));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const replayClip = bridge().replayClip;
    if (!replayClip) return;
    let alive = true;
    let url: string | null = null;
    const none = () => {
      if (!alive) return;
      setClipState({ status: 'none' });
      if (!kindChosen.current) setKind('written');
    };
    replayClip().then((clip) => {
      if (!alive) return;
      if (!clip?.data?.length) return none();
      const blob = toBlob(clip);
      url = URL.createObjectURL(blob);
      setClipState({ status: 'ready', clip, size: blob.size, url });
    }, none);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const chooseKind = (next: Kind) => {
    kindChosen.current = true;
    setKind(next);
    setError(null);
  };

  const addImages = (files: Array<Blob & { name?: string }>, id?: string) => {
    const { accepted, problem } = acceptImages(files, imagesRef.current.length);
    const next = [...imagesRef.current, ...accepted.map((file) => ({ id: id ?? `image-${(attachedCount += 1)}`, blob: file, name: file.name || 'Pasted image', url: URL.createObjectURL(file) }))];
    // Ahead of the render, so a second add in the same moment builds on this one.
    imagesRef.current = next;
    setImages(next);
    setImageError(problem);
  };

  /** Images pasted or dropped anywhere on the page make it a written report. */
  const takeImages = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return false;
    chooseKind('written');
    addImages(files);
    return true;
  };

  const removeImage = (image: Attached) => {
    URL.revokeObjectURL(image.url);
    const next = imagesRef.current.filter((item) => item.id !== image.id);
    imagesRef.current = next;
    setImages(next);
    setImageError(null);
  };

  const clip = clipState.status === 'ready' ? clipState.clip : null;
  const problem = draftProblem(kind, { title, description, hasRecording: Boolean(clip) });
  const done = Boolean(filed || handedOff);

  const send = async (via?: 'form') => {
    if (sending || done || problem) return;
    const submit = bridge().submitBugReport;
    if (!submit) {
      setError({ message: 'Sending a report needs the Toji browser.', canUseForm: false });
      return;
    }
    setSending(true);
    setError(null);
    try {
      const files: BugReportFile[] = [];
      if (kind === 'recording' && clip) {
        files.push({ type: clip.type, role: 'recording', data: clip.data });
        if (clip.poster?.data?.length) files.push({ type: clip.poster.type, role: 'poster', data: clip.poster.data });
      } else if (kind === 'written') {
        for (const image of images) files.push({ type: image.blob.type, role: 'image', data: new Uint8Array(await image.blob.arrayBuffer()) });
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
        const { notice, closeAfterMs } = formRouteClose(result);
        setHandedOff({ notice });
        if (closeAfterMs) closeTimer.current = window.setTimeout(onClose, closeAfterMs);
        else onClose();
        return;
      }
      setFiled({ number: result.number, url: result.url });
    } catch (failure) {
      setError({ message: failure instanceof Error ? failure.message : String(failure), canUseForm: false });
    } finally {
      setSending(false);
    }
  };

  // The page is the whole document, so its keys and pastes are the window's.
  const latest = useRef({ send, takeImages, sending, done, onClose });
  latest.current = { send, takeImages, sending, done, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current;
      if (event.key === 'Escape' && !now.sending) {
        event.preventDefault();
        now.onClose();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !now.done) {
        event.preventDefault();
        void now.send();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!latest.current.done && latest.current.takeImages(event.clipboardData?.files)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  const route = !canSubmit
    ? 'Sending a report needs the Toji browser.'
    : !canAsk || accountFailed
      ? 'It becomes an issue on Toji’s GitHub repository. Reports are public.'
      : routeLine(account);

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

  return (
    <div
      className="relative h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
      data-testid="bug-report-page"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        // Always taken, so a file dropped here never replaces the page.
        event.preventDefault();
        if (!done) setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (!done) takeImages(event.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none fixed inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-900/30 bg-white/70 text-[13px] font-medium text-neutral-600 dark:border-white/30 dark:bg-neutral-950/70 dark:text-neutral-300">
          Drop images to attach them
        </div>
      )}
      <div className="mx-auto w-[min(640px,92vw)] px-6 py-12">
        {filed ? (
          <div className="flex flex-col items-center pt-10 text-center" data-testid="bug-report-filed">
            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
              <Check size={18} />
            </span>
            <h1 className="text-[17px] font-semibold">Filed as #{filed.number}</h1>
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
        ) : handedOff ? (
          <div className="flex flex-col items-center pt-10 text-center" data-testid="bug-report-handed-off">
            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
              <ExternalLink size={17} />
            </span>
            <h1 className="text-[17px] font-semibold">Continuing on GitHub</h1>
            <p className="mt-1 max-w-sm text-[13px] text-neutral-500">GitHub’s issue form is open in a new tab, with the files ready to attach there.</p>
            {handedOff.notice && (
              <p className="mt-3 max-w-sm text-[13px] text-neutral-700 dark:text-neutral-300" data-testid="bug-report-clipboard">
                {handedOff.notice}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="mb-6 flex items-center gap-2">
              <Bug size={18} className="text-neutral-500" />
              <h1 className="text-2xl font-semibold tracking-tight">Report a bug</h1>
            </div>
            {canRecord && (
              <div role="tablist" className="mb-5 inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.07]">
                {tab('recording', <Video size={14} />, `Last ${REPLAY_SECONDS} seconds`)}
                {tab('written', <FileText size={14} />, 'Written report')}
              </div>
            )}
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {kind === 'recording' && <RecordingPreview state={clipState} replayOff={settings?.replay === false} onOpenSettings={onOpenSettings} />}
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
                  rows={kind === 'written' ? 7 : 3}
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
                          onClick={() => removeImage(image)}
                          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                    {screenshot && screenshotUrl && !screenshotAdded && images.length < MAX_IMAGES && (
                      <button
                        type="button"
                        title="Attach a screenshot of the window as it was"
                        data-testid="bug-report-screenshot"
                        onClick={() => addImages([new File([screenshot], 'Window screenshot', { type: screenshot.type })], SCREENSHOT_ID)}
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
              <div className="border-t border-black/[0.06] pt-4 dark:border-white/[0.08]">
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
                    {route}
                  </p>
                  <button type="button" className={FIELD_BUTTON_QUIET} onClick={onClose} disabled={sending}>
                    Cancel
                  </button>
                  <button type="submit" className={FIELD_BUTTON} disabled={sending || !canSubmit || Boolean(problem)} title={problem ?? undefined}>
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
      </div>
    </div>
  );
}

/** An object URL for `blob` while the page shows it, released after. */
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

function RecordingPreview({ state, replayOff, onOpenSettings }: { state: ClipState; replayOff: boolean; onOpenSettings: () => void }) {
  if (state.status === 'ready') {
    return (
      <div>
        <video
          src={state.url}
          controls
          autoPlay
          muted
          loop
          playsInline
          data-testid="bug-report-video"
          // Sized by the video's own shape within these limits, so it never gets bars.
          className="mx-auto block h-auto max-h-[340px] w-auto max-w-full rounded-xl bg-black"
        />
        <p className="mt-1.5 text-center text-[12px] text-neutral-500">
          {Math.round(state.clip.seconds)} s · {formatBytes(state.size)} · the window, up to the moment you opened the report
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
      {replayOff ? (
        <>
          <span>The rolling recording is switched off, so there’s nothing to send.</span>
          <button type="button" onClick={onOpenSettings} className="font-medium text-neutral-800 underline underline-offset-2 dark:text-neutral-200">
            Turn it on in Settings
          </button>
        </>
      ) : (
        <span>There’s no recording of this window. Private and Tor windows are never recorded, and a window keeps its last {REPLAY_SECONDS} seconds only from the moment it opens. Write the report instead; a screenshot can go with it.</span>
      )}
    </div>
  );
}
