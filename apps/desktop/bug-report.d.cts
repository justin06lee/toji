export interface ReportTarget {
  repo: string;
  api: string;
  web: string;
  raw: string;
}
export interface Credential {
  token: string;
  source: string;
}
export type FileRole = 'recording' | 'poster' | 'image';
export interface CheckedFile {
  name: string;
  type: string;
  role: FileRole;
  bytes: Uint8Array;
}
export interface CheckedDraft {
  kind: 'recording' | 'written';
  title: string;
  description: string;
  pageUrl: string | null;
  seconds: number | null;
  files: CheckedFile[];
  context: { window: string; layout: string; theme: string };
  via: 'form' | 'auto';
}
export interface Facts {
  app?: string;
  os?: string;
  chrome?: string;
  electron?: string;
  window?: string;
  layout?: string;
  theme?: string;
  pageUrl?: string | null;
}
export type Account =
  | { mode: 'direct'; repo: string; login: string; source: string }
  | { mode: 'form'; repo: string; login?: string; source?: string; reason: 'no-login' | 'no-access' | 'bad-login' | 'unreachable' };
export interface WrittenFile {
  name: string;
  type: string;
  path: string;
}
export type Cdp = (method: string, params?: Record<string, unknown>) => Promise<any>;

export const ATTACHMENTS_MARKER: string;
export const DEFAULT_TARGET: Readonly<ReportTarget>;
export const LIMITS: Readonly<{ files: number; title: number; text: number; imageBytes: number; recordingBytes: number }>;
export function reportTarget(env?: Record<string, string | undefined>): ReportTarget;
export function resolveToken(env: Record<string, string | undefined>, readCliToken?: () => Promise<string | null>): Promise<Credential | null>;
export function readGhToken(
  execFile: (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => unknown,
  exists?: (file: string) => boolean
): Promise<string | null>;
export function checkDraft(draft: unknown): { draft: CheckedDraft; error?: undefined } | { error: string; draft?: undefined };
export function environmentTable(facts: Facts): string;
export function issueBody(draft: CheckedDraft, facts: Facts, links?: Record<string, string> | null): string;
export function newIssueUrl(target: ReportTarget, title: string, body: string): { url: string; overflow: boolean };
export function isIssueForm(target: ReportTarget, url: string): boolean;
export function newReportId(now?: number, random?: () => number): string;
export function writeReportFiles(baseDir: string, reportId: string, files: CheckedFile[]): WrittenFile[];
export function pruneReportDirs(baseDir: string, maxAgeMs: number, now?: number): void;
export function attachToIssueForm(
  cdp: Cdp,
  files: WrittenFile[],
  options?: { wait?: (ms: number) => Promise<void>; timeoutMs?: number; now?: () => number }
): Promise<{ ok: true; method: 'drop' | 'input' } | { ok: false; error: string }>;
export class GitHubError extends Error {
  constructor(status: number, message: string);
  status: number;
}
export class GitHubReporter {
  constructor(options: {
    target: ReportTarget;
    fetch: typeof fetch;
    token: () => Promise<Credential | null>;
    log?: (message: string) => void;
    now?: () => number;
  });
  account(options?: { refresh?: boolean }): Promise<Account>;
  fileIssue(draft: CheckedDraft, facts: Facts, reportId: string): Promise<{ number: number; url: string }>;
}
