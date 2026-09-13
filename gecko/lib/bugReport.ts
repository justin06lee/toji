// Pure parts of Toji's bug reporter (resource:///modules/toji/lib/bugReport.sys.mjs),
// ported from the Electron app's bug-report.cjs.
//
// A report reaches GitHub one of two ways, decided by the GitHub login this machine has:
//   direct — a token that can write to the repository (TOJI_GITHUB_TOKEN, GH_TOKEN,
//            GITHUB_TOKEN, else the GitHub CLI's login). The API can't attach files to an
//            issue, so they're committed with no parent under refs/bug-reports/<id> (a ref
//            `git clone` never fetches) and linked from raw.githubusercontent.com.
//   form   — everyone else: GitHub's new-issue form opens in a tab, filled in, and Toji
//            drops the files onto it so GitHub uploads them itself.
// The token never leaves the browser's parent process.

export interface ReportTarget {
  repo: string;
  api: string;
  web: string;
  raw: string;
}

export const DEFAULT_TARGET: ReportTarget = Object.freeze({
  repo: 'justin06lee/toji',
  api: 'https://api.github.com',
  web: 'https://github.com',
  raw: 'https://raw.githubusercontent.com'
});

/** TOJI_BUG_REPORT_REPO and TOJI_GITHUB_API/_WEB/_RAW point reports at a fork or a local fake. */
export function reportTarget(env: Record<string, string | undefined> = {}): ReportTarget {
  const base = (value: string | undefined, fallback: string) => {
    try {
      const url = new URL(value ?? '');
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.replace(/\/+$/, '') : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    repo: /^[\w.-]+\/[\w.-]+$/.test(env.TOJI_BUG_REPORT_REPO || '') ? (env.TOJI_BUG_REPORT_REPO as string) : DEFAULT_TARGET.repo,
    api: base(env.TOJI_GITHUB_API, DEFAULT_TARGET.api),
    web: base(env.TOJI_GITHUB_WEB, DEFAULT_TARGET.web),
    raw: base(env.TOJI_GITHUB_RAW, DEFAULT_TARGET.raw)
  };
}

export const TOKEN_VARIABLES = ['TOJI_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** The token to file with and where it came from, or null. */
export async function resolveToken(
  env: Record<string, string | undefined>,
  readCliToken?: () => Promise<string | null>
): Promise<{ token: string; source: string } | null> {
  for (const name of TOKEN_VARIABLES) {
    const value = typeof env[name] === 'string' ? env[name]!.trim() : '';
    if (value) return { token: value, source: name };
  }
  const cli = readCliToken ? await readCliToken() : null;
  return cli ? { token: cli, source: 'gh' } : null;
}

/** Where the GitHub CLI usually lives; an app started from the Dock has no shell PATH. */
export const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'];

export const LIMITS = Object.freeze({
  files: 10,
  title: 256,
  text: 20_000,
  imageBytes: 10 * 1024 * 1024,
  recordingBytes: 100 * 1024 * 1024
});

export const FILE_TYPES: Record<string, string> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
});

export interface DraftFile {
  type: string;
  role: 'recording' | 'poster' | 'image';
  data: Uint8Array | ArrayBuffer;
}

export interface Draft {
  kind: 'recording' | 'written';
  title: string;
  description: string;
  pageUrl?: string;
  seconds?: number;
  context?: { window?: string; layout?: string; theme?: string };
  files?: DraftFile[];
  via?: 'form';
}

export interface CheckedFile {
  name: string;
  type: string;
  role: 'recording' | 'poster' | 'image';
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

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return null;
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const short = (value: unknown) => (typeof value === 'string' ? value.slice(0, 80) : '');

/** A report as the sheet sent it, checked and normalised, or why it can't be filed. */
export function checkDraft(draft: unknown): { draft: CheckedDraft } | { error: string } {
  if (!draft || typeof draft !== 'object') return { error: 'The report was empty.' };
  const d = draft as Draft;
  const kind = d.kind === 'recording' || d.kind === 'written' ? d.kind : null;
  if (!kind) return { error: 'Toji does not know that kind of report.' };
  const title = typeof d.title === 'string' ? d.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return { error: 'The report needs a title.' };
  if (title.length > LIMITS.title) return { error: `Keep the title under ${LIMITS.title} characters.` };
  const description = typeof d.description === 'string' ? d.description.trim() : '';
  if (description.length > LIMITS.text) return { error: 'The description is too long for a GitHub issue.' };
  if (kind === 'written' && !description) return { error: 'Describe what happened.' };
  const files = Array.isArray(d.files) ? d.files : [];
  if (files.length > LIMITS.files) return { error: `Attach at most ${LIMITS.files} files.` };
  const out: CheckedFile[] = [];
  let images = 0;
  for (const file of files) {
    const ext = file && FILE_TYPES[file.type];
    const bytes = file ? toBytes(file.data) : null;
    if (!ext || !bytes || !bytes.length) return { error: 'One of the attachments could not be read.' };
    const role = file.role === 'recording' || file.role === 'poster' ? file.role : 'image';
    const video = file.type.startsWith('video/');
    if (video !== (role === 'recording')) return { error: 'One of the attachments is not what it says it is.' };
    if (bytes.length > (video ? LIMITS.recordingBytes : LIMITS.imageBytes)) return { error: `${video ? 'The recording' : 'An image'} is too large for GitHub.` };
    const name = role === 'recording' ? `recording.${ext}` : role === 'poster' ? `recording-poster.${ext}` : `image-${(images += 1)}.${ext}`;
    out.push({ name, type: file.type, role, bytes });
  }
  const recordings = out.filter((f) => f.role === 'recording').length;
  if (kind === 'recording' && recordings !== 1) return { error: 'There is no recording to send.' };
  if (kind === 'written' && (recordings || out.some((f) => f.role === 'poster'))) return { error: 'A written report carries images only.' };
  const context = d.context && typeof d.context === 'object' ? d.context : {};
  const seconds = Number(d.seconds);
  return {
    draft: {
      kind,
      title,
      description,
      pageUrl: webUrl(d.pageUrl),
      seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null,
      files: out,
      context: { window: short(context.window), layout: short(context.layout), theme: short(context.theme) },
      via: d.via === 'form' ? 'form' : 'auto'
    }
  };
}

export interface Facts {
  app: string;
  os: string;
  gecko: string;
}

const cell = (value: unknown) => String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The facts about this copy of Toji that go under every report, folded away. */
export function environmentTable(facts: Facts & { window?: string; layout?: string; theme?: string; pageUrl?: string | null }): string {
  const rows = [
    ['Toji', facts.app],
    ['OS', facts.os],
    ['Gecko', facts.gecko],
    ['Window', [facts.window, facts.layout && `${facts.layout} tabs`, facts.theme].filter(Boolean).join(', ')],
    ['Page', facts.pageUrl]
  ].filter(([, value]) => value);
  return ['<details><summary>Environment</summary>', '', '| | |', '|---|---|', ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`), '', '</details>'].join('\n');
}

/** Where GitHub's editor puts the files dropped onto the form: right under the description. */
export const ATTACHMENTS_MARKER = '<!-- attachments -->';

/** The issue's text. `links` maps attachment names to URLs (direct route only). */
export function issueBody(draft: CheckedDraft, facts: Facts, links: Record<string, string> | null = null): string {
  const parts: string[] = [];
  if (draft.description) parts.push(draft.description);
  if (links) {
    const recording = draft.files.find((f) => f.role === 'recording');
    const poster = draft.files.find((f) => f.role === 'poster');
    if (recording && links[recording.name]) {
      const label = `Recording of the last ${Math.round(draft.seconds || 15)} seconds`;
      const format = recording.type === 'video/mp4' ? 'MP4' : 'WebM';
      parts.push(`**${label}** (${format}, ${megabytes(recording.bytes.length)}) · [download](${links[recording.name]})`);
      if (poster && links[poster.name]) parts.push(`[![${label}](${links[poster.name]})](${links[recording.name]})`);
    }
    for (const image of draft.files.filter((f) => f.role === 'image')) {
      if (links[image.name]) parts.push(`![${image.name}](${links[image.name]})`);
    }
  } else if (draft.files.length) {
    parts.push(ATTACHMENTS_MARKER);
  }
  parts.push(environmentTable({ ...facts, ...draft.context, pageUrl: draft.pageUrl }));
  parts.push('<sub>Filed with Toji’s bug reporter.</sub>');
  return parts.join('\n\n');
}

/** GitHub turns URLs much past 8 KB away; beyond this the text goes by clipboard. */
export const MAX_FORM_URL = 7000;

export function newIssueUrl(target: ReportTarget, title: string, body: string): { url: string; overflow: boolean } {
  const url = (text: string) => `${target.web}/${target.repo}/issues/new?${new URLSearchParams({ title, body: text, labels: 'bug' })}`;
  const full = url(body);
  if (full.length <= MAX_FORM_URL) return { url: full, overflow: false };
  return { url: url('The report is on your clipboard. Paste it here, in place of this line.'), overflow: true };
}

/** Whether `url` is the repository's new-issue form — the only page files are dropped on. */
export function isIssueForm(target: ReportTarget, url: string): boolean {
  try {
    const page = new URL(url);
    return page.origin === new URL(target.web).origin && page.pathname.replace(/\/+$/, '').toLowerCase() === `/${target.repo}/issues/new`.toLowerCase();
  } catch {
    return false;
  }
}

/** Where a tab showing a report's GitHub page is: the form, the filed issue, or elsewhere. */
export function issuePageState(target: ReportTarget, url: string): 'form' | 'filed' | 'elsewhere' {
  if (isIssueForm(target, url)) return 'form';
  try {
    const page = new URL(url);
    if (page.origin === new URL(target.web).origin && new RegExp(`^/${target.repo}/issues/\\d+/?$`, 'i').test(page.pathname)) return 'filed';
  } catch {}
  return 'elsewhere';
}

export function newReportId(now = Date.now(), random = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${new Date(now).toISOString().slice(0, 10)}-${suffix}`;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function githubMessage(status: number, data: { message?: string } | null): string {
  const detail = data && typeof data.message === 'string' ? data.message : '';
  if (status === 401) return 'GitHub did not accept the login (401). Sign in to the GitHub CLI again, or check the token.';
  if (status === 403 && /rate limit/i.test(detail)) return 'GitHub’s rate limit is used up for now. Try again in a few minutes.';
  if (status === 403 || status === 404) return `This GitHub login cannot write to the repository (${status}).`;
  return `GitHub answered ${status}${detail ? `: ${detail}` : ''}.`;
}

export interface Account {
  mode: 'direct' | 'form';
  repo: string;
  login?: string;
  source?: string;
  reason?: 'no-login' | 'no-access' | 'bad-login' | 'unreachable';
}

const ACCOUNT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class GitHubReporter {
  private cached: { at: number; value: Account } | null = null;
  private looking: Promise<Account> | null = null;

  constructor(
    private options: {
      target: ReportTarget;
      fetch: Fetch;
      token: () => Promise<{ token: string; source: string } | null>;
      log?: (message: string) => void;
      now?: () => number;
    }
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** Which login files reports, looked up at most every few minutes. */
  account({ refresh = false } = {}): Promise<Account> {
    if (!refresh && this.cached && this.now() - this.cached.at < ACCOUNT_TTL_MS) return Promise.resolve(this.cached.value);
    if (!refresh && this.looking) return this.looking;
    const looking = this.lookUpAccount().then((value) => {
      this.cached = { at: this.now(), value };
      return value;
    });
    this.looking = looking;
    const clear = () => {
      if (this.looking === looking) this.looking = null;
    };
    looking.then(clear, clear);
    return looking;
  }

  private async lookUpAccount(): Promise<Account> {
    const { repo } = this.options.target;
    let credential: { token: string; source: string } | null = null;
    try {
      credential = await this.options.token();
    } catch {
      credential = null;
    }
    if (!credential) return { mode: 'form', repo, reason: 'no-login' };
    try {
      const user = (await this.request('GET', '/user', undefined, credential.token)) as { login?: string } | null;
      const repository = (await this.request('GET', `/repos/${repo}`, undefined, credential.token)) as { permissions?: { push?: boolean } } | null;
      const login = String(user?.login || '');
      if (repository?.permissions?.push) return { mode: 'direct', repo, login, source: credential.source };
      return { mode: 'form', repo, login, source: credential.source, reason: 'no-access' };
    } catch (error) {
      this.options.log?.(`bug report: account check failed: ${(error as Error).message}`);
      return { mode: 'form', repo, source: credential.source, reason: (error as GitHubError).status === 401 ? 'bad-login' : 'unreachable' };
    }
  }

  /** Files a checked draft as an issue, its files committed alongside. */
  async fileIssue(draft: CheckedDraft, facts: Facts, reportId: string): Promise<{ number: number; url: string }> {
    const credential = await this.options.token();
    if (!credential) throw new GitHubError(401, 'There is no GitHub login on this machine to file with.');
    const { repo, raw } = this.options.target;
    const token = credential.token;
    let links: Record<string, string> | null = null;
    if (draft.files.length) {
      const tree = [];
      for (const file of draft.files) {
        const blob = (await this.request('POST', `/repos/${repo}/git/blobs`, { content: base64(file.bytes), encoding: 'base64' }, token)) as { sha: string };
        tree.push({ path: file.name, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const created = (await this.request('POST', `/repos/${repo}/git/trees`, { tree }, token)) as { sha: string };
      const commit = (await this.request('POST', `/repos/${repo}/git/commits`, { message: `Attachments for bug report ${reportId}\n\n${draft.title}`, tree: created.sha, parents: [] }, token)) as { sha: string };
      try {
        await this.request('POST', `/repos/${repo}/git/refs`, { ref: `refs/bug-reports/${reportId}`, sha: commit.sha }, token);
      } catch (error) {
        this.options.log?.(`bug report: ref for ${reportId} not created: ${(error as Error).message}`);
      }
      links = Object.fromEntries(draft.files.map((f) => [f.name, `${raw}/${repo}/${commit.sha}/${f.name}`]));
    }
    const issue = (await this.request('POST', `/repos/${repo}/issues`, { title: draft.title, body: issueBody(draft, facts, links), labels: ['bug'] }, token)) as { number: number; html_url: string };
    return { number: issue.number, url: issue.html_url };
  }

  private async request(method: string, apiPath: string, body: unknown, token: string): Promise<unknown> {
    const response = await this.options.fetch(`${this.options.target.api}${apiPath}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Toji-bug-reporter',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    let data: { message?: string } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new GitHubError(response.status, githubMessage(response.status, data));
    return data;
  }
}
