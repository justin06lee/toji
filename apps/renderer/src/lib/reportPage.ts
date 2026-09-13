// about:report's own logic, kept out of the component so it can be tested: what the
// browser opened the page with, which images fit on a report, and how the page leaves
// once GitHub's form has taken over. See components/BugReportPage.tsx.

import { imageProblem, MAX_IMAGES } from './bugReport';
import { queryParam } from './pageQuery';

/** What the browser tells about:report about the window the report is about. */
export interface ReportRequest {
  /** The address of the page in front: offered, but only sent when chosen. */
  pageUrl: string | null;
  context: { window: string; layout: string; theme: string };
}

const oneOf = (value: string | null, allowed: readonly string[]) => (value && allowed.includes(value) ? value : '');

/** Only web pages are offered: the browser drops any other address from a report anyway. */
function webPage(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The query the browser opens the page with:
 * `about:report?page=<url or empty>&window=<W×H>&layout=<top|side>&theme=<light|dark>`.
 * Anything missing or malformed stays blank rather than guessed, since it goes into a
 * public issue as fact.
 */
export function readReportQuery(href: string): ReportRequest {
  const size = /^(\d{1,5})\s*[×x]\s*(\d{1,5})$/.exec(queryParam(href, 'window')?.trim() ?? '');
  return {
    pageUrl: webPage(queryParam(href, 'page')?.trim() ?? ''),
    context: {
      window: size ? `${size[1]}×${size[2]}` : '',
      layout: oneOf(queryParam(href, 'layout'), ['top', 'side']),
      theme: oneOf(queryParam(href, 'theme'), ['light', 'dark'])
    }
  };
}

/**
 * Which of `files` can join a report that already holds `held` images, in order, and
 * what to say about the ones that can't (the last reason wins, as the form shows one).
 */
export function acceptImages<T extends { name?: string; type: string; size: number }>(files: T[], held: number): { accepted: T[]; problem: string | null } {
  const accepted: T[] = [];
  let problem: string | null = null;
  for (const file of files) {
    const rejected = imageProblem({ name: file.name || 'Pasted image', type: file.type, size: file.size });
    if (rejected) {
      problem = rejected;
      continue;
    }
    if (held + accepted.length >= MAX_IMAGES) {
      problem = `A report carries at most ${MAX_IMAGES} images.`;
      break;
    }
    accepted.push(file);
  }
  return { accepted, problem };
}

/** How long the clipboard line stays up before the page closes. */
export const CLIPBOARD_NOTICE_MS = 2000;

/**
 * After the form route the browser has already opened GitHub's form, with the files on a
 * tray there, so the page closes. When the text was too long for the form's link it went
 * to the clipboard instead, and the page says so for a moment first.
 */
export function formRouteClose(result: { bodyOnClipboard: boolean }): { notice: string | null; closeAfterMs: number } {
  return result.bodyOnClipboard
    ? { notice: 'The description was too long for the link, so it’s on your clipboard. Paste it into GitHub’s form.', closeAfterMs: CLIPBOARD_NOTICE_MS }
    : { notice: null, closeAfterMs: 0 };
}
