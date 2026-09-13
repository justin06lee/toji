// The renderer's half of bug reports: whether the rolling recording is on, what may be
// attached, and how GitHub's pages relate to a report in progress. Filing happens in the
// main process (apps/desktop/bug-report.cjs), which is where the GitHub login lives.

import type { BugReportAccount } from './bridge';

/** How much the rolling recording keeps. */
export const REPLAY_SECONDS = 15;

const REPLAY_KEY = 'toji.replay';
/** Fired on this window when the setting changes; other windows hear 'storage'. */
export const REPLAY_EVENT = 'toji-replay-change';

/** The rolling recording is on unless it was switched off in Settings. */
export function replayEnabled(): boolean {
  try {
    return localStorage.getItem(REPLAY_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setReplayEnabled(enabled: boolean): void {
  localStorage.setItem(REPLAY_KEY, enabled ? 'on' : 'off');
  window.dispatchEvent(new Event(REPLAY_EVENT));
}

export const isReplayStorageKey = (key: string | null) => key === REPLAY_KEY;

export const MAX_IMAGES = 8;
/** GitHub refuses image attachments over 10 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Why an image cannot go on a report, or null when it can. */
export function imageProblem(file: { name: string; type: string; size: number }): string | null {
  const name = file.name || 'That file';
  if (!IMAGE_TYPES.includes(file.type)) return `${name} isn't a PNG, JPEG, GIF or WebP image.`;
  if (file.size > MAX_IMAGE_BYTES) return `${name} is over 10 MB, which GitHub won't accept.`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What still stops a report from being sent, as the sheet says it; null when it can go. */
export function draftProblem(kind: 'recording' | 'written', fields: { title: string; description: string; hasRecording: boolean }): string | null {
  if (!fields.title.trim()) return 'Give the report a title.';
  if (kind === 'recording' && !fields.hasRecording) return 'There is no recording to send.';
  if (kind === 'written' && !fields.description.trim()) return 'Describe what happened.';
  return null;
}

/**
 * Where a tab showing GitHub stands with a report being finished on GitHub's own form:
 * on the form (`formUrl` minus its query), on the issue that form created, or elsewhere
 * (GitHub's sign-in page, typically, on the way to the form).
 */
export function issuePageState(url: string | null | undefined, formUrl: string): { state: 'form' } | { state: 'filed'; number: number } | { state: 'elsewhere' } {
  let page: URL;
  let form: URL;
  try {
    page = new URL(url ?? '');
    form = new URL(formUrl);
  } catch {
    return { state: 'elsewhere' };
  }
  if (page.origin !== form.origin) return { state: 'elsewhere' };
  const repo = form.pathname.replace(/\/issues\/new\/?$/i, '').toLowerCase();
  const path = page.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === `${repo}/issues/new`) return { state: 'form' };
  const filed = new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/(\\d+)$`).exec(path);
  return filed ? { state: 'filed', number: Number(filed[1]) } : { state: 'elsewhere' };
}

/** Where the report will go, said before it goes (the sheet's and about:report's footer). */
export function routeLine(account: BugReportAccount | null): string {
  if (!account) return 'Checking your GitHub login…';
  if (account.mode === 'direct') return `Files to ${account.repo} as @${account.login}. Reports are public.`;
  const why = account.reason === 'no-access' && account.login ? ` @${account.login} can’t file there directly, so` : '';
  return `${why ? `${why.trim()} it` : 'It'} finishes on GitHub’s issue form, in a new tab. Reports are public.`;
}
