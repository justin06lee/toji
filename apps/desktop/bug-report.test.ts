import { mkdtempSync, readFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ATTACHMENTS_MARKER,
  DEFAULT_TARGET,
  GitHubError,
  GitHubReporter,
  attachToIssueForm,
  checkDraft,
  isIssueForm,
  issueBody,
  newIssueUrl,
  newReportId,
  pruneReportDirs,
  readGhToken,
  reportTarget,
  resolveToken,
  writeReportFiles,
  type CheckedDraft,
  type Cdp
} from './bug-report.cjs';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 9]);

function recordingDraft(extra: Record<string, unknown> = {}) {
  return {
    kind: 'recording',
    title: '  Tabs   vanish after a resize ',
    description: 'Dragged the window edge; two tabs went blank.',
    seconds: 15.2,
    context: { window: '1480×960', layout: 'top', theme: 'dark' },
    files: [
      { name: '../../etc/passwd', type: 'video/mp4', role: 'recording', data: mp4 },
      { name: 'x', type: 'image/png', role: 'poster', data: png }
    ],
    ...extra
  };
}

const checked = (draft: unknown): CheckedDraft => {
  const result = checkDraft(draft);
  if (!result.draft) throw new Error(result.error);
  return result.draft;
};

describe('reportTarget', () => {
  test("defaults to Toji's repository on github.com", () => {
    expect(reportTarget({})).toEqual(DEFAULT_TARGET);
  });
  test('can be pointed elsewhere for a fork or a test double, but only at sane values', () => {
    expect(reportTarget({ TOJI_BUG_REPORT_REPO: 'me/fork', TOJI_GITHUB_API: 'http://127.0.0.1:9000/', TOJI_GITHUB_WEB: 'http://127.0.0.1:9001' })).toMatchObject({
      repo: 'me/fork',
      api: 'http://127.0.0.1:9000',
      web: 'http://127.0.0.1:9001'
    });
    expect(reportTarget({ TOJI_BUG_REPORT_REPO: 'no slash', TOJI_GITHUB_API: 'javascript:alert(1)' })).toEqual(DEFAULT_TARGET);
  });
});

describe('resolveToken', () => {
  test("Toji's own variable wins, then the usual GitHub ones, then the CLI", async () => {
    const cli = async () => 'gho_cli';
    expect(await resolveToken({ TOJI_GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, cli)).toEqual({ token: 'a', source: 'TOJI_GITHUB_TOKEN' });
    expect(await resolveToken({ GH_TOKEN: ' b ', GITHUB_TOKEN: 'c' }, cli)).toEqual({ token: 'b', source: 'GH_TOKEN' });
    expect(await resolveToken({ GITHUB_TOKEN: '' }, cli)).toEqual({ token: 'gho_cli', source: 'gh' });
    expect(await resolveToken({}, async () => null)).toBeNull();
  });
});

describe('readGhToken', () => {
  test('asks each installed gh in turn and takes the first real answer', async () => {
    const asked: string[] = [];
    const execFile = (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      asked.push(`${file} ${args.join(' ')}`);
      if (file === '/usr/local/bin/gh') callback(null, 'gho_abc\n');
      else callback(new Error('not signed in'), '');
    };
    const token = await readGhToken(execFile, (file) => file === '/opt/homebrew/bin/gh' || file === '/usr/local/bin/gh');
    expect(token).toBe('gho_abc');
    expect(asked).toEqual(['/opt/homebrew/bin/gh auth token --hostname github.com', '/usr/local/bin/gh auth token --hostname github.com']);
  });
  test('no gh, or none signed in, is simply no token', async () => {
    const token = await readGhToken((_f: string, _a: string[], _o: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error('ENOENT'), ''), () => false);
    expect(token).toBeNull();
  });
});

describe('checkDraft', () => {
  test('normalises the title and renames every file', () => {
    const draft = checked(recordingDraft());
    expect(draft.title).toBe('Tabs vanish after a resize');
    expect(draft.files.map((f) => f.name)).toEqual(['recording.mp4', 'recording-poster.png']);
    expect(draft.seconds).toBe(15.2);
    expect(draft.via).toBe('auto');
  });

  test('numbers images and accepts ArrayBuffers', () => {
    const draft = checked({
      kind: 'written',
      title: 'Bookmarks bar flickers',
      description: 'On hover.',
      files: [
        { type: 'image/jpeg', role: 'image', data: png.buffer.slice(0) },
        { type: 'image/webp', role: 'image', data: png }
      ]
    });
    expect(draft.files.map((f) => f.name)).toEqual(['image-1.jpg', 'image-2.webp']);
  });

  test('refuses what cannot be filed', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /empty/],
      [{ ...recordingDraft(), kind: 'essay' }, /kind/],
      [{ ...recordingDraft(), title: '   ' }, /title/],
      [{ ...recordingDraft(), title: 'x'.repeat(300) }, /under 256/],
      [{ kind: 'written', title: 'Hi', description: '', files: [] }, /Describe/],
      [{ ...recordingDraft(), files: [] }, /no recording/],
      [{ ...recordingDraft(), files: [{ type: 'image/svg+xml', role: 'image', data: png }] }, /could not be read/],
      [{ ...recordingDraft(), files: [{ type: 'image/png', role: 'recording', data: png }] }, /not what it says/],
      [{ kind: 'written', title: 'Hi', description: 'x', files: [{ type: 'video/mp4', role: 'recording', data: mp4 }] }, /images only/],
      [{ kind: 'written', title: 'Hi', description: 'x', files: [{ type: 'image/png', role: 'image', data: new Uint8Array(10 * 1024 * 1024 + 1) }] }, /too large/]
    ];
    for (const [draft, message] of cases) expect(checkDraft(draft).error, JSON.stringify(draft)?.slice(0, 80)).toMatch(message);
  });

  test('keeps a page address only when it is a web address', () => {
    expect(checked(recordingDraft({ pageUrl: 'https://example.com/a?b' })).pageUrl).toBe('https://example.com/a?b');
    expect(checked(recordingDraft({ pageUrl: 'file:///Users/me/secret.html' })).pageUrl).toBeNull();
  });
});

describe('issueBody', () => {
  const facts = { app: '0.3.0', os: 'macOS 26.6 (arm64)', chrome: '146.0.0.0', electron: '42.5.1' };

  test('the direct route links the recording, shows its poster, and folds away the environment', () => {
    const draft = checked(recordingDraft({ pageUrl: 'https://example.com/' }));
    const body = issueBody(draft, facts, { 'recording.mp4': 'https://raw/x/recording.mp4', 'recording-poster.png': 'https://raw/x/recording-poster.png' });
    expect(body.startsWith('Dragged the window edge')).toBe(true);
    expect(body).toContain('**Recording of the last 15 seconds** (MP4, 0.0 MB) · [download](https://raw/x/recording.mp4)');
    expect(body).toContain('[![Recording of the last 15 seconds](https://raw/x/recording-poster.png)](https://raw/x/recording.mp4)');
    expect(body).toContain('<details><summary>Environment</summary>');
    expect(body).toContain('| Window | 1480×960, top tabs, dark |');
    expect(body).toContain('| Page | https://example.com/ |');
    expect(body).not.toContain(ATTACHMENTS_MARKER);
  });

  test('the form route leaves a marker where GitHub will write the files in', () => {
    const body = issueBody(checked(recordingDraft()), facts, null);
    expect(body).toContain(ATTACHMENTS_MARKER);
    expect(body).not.toContain('download');
    expect(body).not.toContain('| Page |');
    expect(body.indexOf(ATTACHMENTS_MARKER)).toBeLessThan(body.indexOf('<details>'));
  });

  test('table cells cannot break the table', () => {
    const body = issueBody(checked(recordingDraft({ context: { window: 'a|b\nc' } })), facts, null);
    expect(body).toContain('| Window | a\\|b c |');
  });
});

describe('newIssueUrl', () => {
  test('fills in the form, labelled as a bug', () => {
    const { url, overflow } = newIssueUrl(DEFAULT_TARGET, 'Tabs vanish', 'Line one\n\nLine two');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/justin06lee/toji/issues/new');
    expect(parsed.searchParams.get('title')).toBe('Tabs vanish');
    expect(parsed.searchParams.get('body')).toBe('Line one\n\nLine two');
    expect(parsed.searchParams.get('labels')).toBe('bug');
    expect(overflow).toBe(false);
  });
  test('a body too long for an address goes by clipboard instead', () => {
    const { url, overflow } = newIssueUrl(DEFAULT_TARGET, 'Long', 'x'.repeat(9000));
    expect(overflow).toBe(true);
    expect(url.length).toBeLessThan(7000);
    expect(new URL(url).searchParams.get('body')).toMatch(/clipboard/);
  });
});

describe('isIssueForm', () => {
  test("only the repository's own new-issue form", () => {
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com/justin06lee/toji/issues/new?title=a')).toBe(true);
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com/Justin06lee/Toji/issues/new/')).toBe(true);
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com/justin06lee/toji/issues/5')).toBe(false);
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com/someone/else/issues/new')).toBe(false);
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com.evil.test/justin06lee/toji/issues/new')).toBe(false);
    expect(isIssueForm(DEFAULT_TARGET, 'not a url')).toBe(false);
  });
});

describe('report files', () => {
  test('ids carry the date and differ', () => {
    expect(newReportId(Date.UTC(2026, 8, 11), () => 0.5)).toMatch(/^2026-09-11-[0-9a-z]{6}$/);
    expect(newReportId(0, () => 0.1)).not.toBe(newReportId(0, () => 0.2));
  });
  test('are written under the report id and pruned by age', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'toji-reports-'));
    const written = writeReportFiles(base, 'r1', checked(recordingDraft()).files);
    expect(written.map((f) => path.basename(f.path))).toEqual(['recording.mp4', 'recording-poster.png']);
    expect(new Uint8Array(readFileSync(written[0].path))).toEqual(mp4);
    writeReportFiles(base, 'r2', checked(recordingDraft()).files);
    const old = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(path.join(base, 'r1'), old, old);
    pruneReportDirs(base, 86_400_000);
    expect(readdirSync(base)).toEqual(['r2']);
    pruneReportDirs(base, 0);
    expect(readdirSync(base)).toEqual([]);
    pruneReportDirs(path.join(base, 'missing'), 0);
    expect(existsSync(base)).toBe(true);
  });
});

/** A stand-in for GitHub's REST API that records every call. */
function fakeGitHub(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const apiPath = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: apiPath, body, auth: new Headers(init.headers).get('authorization') });
    const route = routes[`${method} ${apiPath}`];
    const reply = route ? route(body) : { status: 404, json: { message: 'Not Found' } };
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const repoPath = '/repos/justin06lee/toji';

describe('GitHubReporter.account', () => {
  const reporter = (routes: Parameters<typeof fakeGitHub>[0], token: () => Promise<{ token: string; source: string } | null>) =>
    new GitHubReporter({ target: DEFAULT_TARGET, fetch: fakeGitHub(routes).fetch, token });
  const signedIn = async () => ({ token: 't', source: 'gh' });

  test('no login on this machine: the form route', async () => {
    expect(await reporter({}, async () => null).account()).toEqual({ mode: 'form', repo: 'justin06lee/toji', reason: 'no-login' });
  });
  test('a login that can push files directly', async () => {
    const account = await reporter({ 'GET /user': () => ({ json: { login: 'justin06lee' } }), [`GET ${repoPath}`]: () => ({ json: { permissions: { push: true } } }) }, signedIn).account();
    expect(account).toEqual({ mode: 'direct', repo: 'justin06lee/toji', login: 'justin06lee', source: 'gh' });
  });
  test('a login without write access uses the form, and says why', async () => {
    const account = await reporter({ 'GET /user': () => ({ json: { login: 'someone' } }), [`GET ${repoPath}`]: () => ({ json: { permissions: { push: false } } }) }, signedIn).account();
    expect(account).toMatchObject({ mode: 'form', login: 'someone', reason: 'no-access' });
  });
  test('a rejected token is reported as such', async () => {
    const account = await reporter({ 'GET /user': () => ({ status: 401, json: { message: 'Bad credentials' } }) }, signedIn).account();
    expect(account).toMatchObject({ mode: 'form', reason: 'bad-login' });
  });
  test('is looked up once and then cached until refreshed', async () => {
    let lookups = 0;
    const r = reporter({ 'GET /user': () => ((lookups += 1), { json: { login: 'a' } }), [`GET ${repoPath}`]: () => ({ json: { permissions: { push: true } } }) }, signedIn);
    await r.account();
    await r.account();
    expect(lookups).toBe(1);
    await r.account({ refresh: true });
    expect(lookups).toBe(2);
  });
  test('askers who arrive during a lookup share it', async () => {
    let lookups = 0;
    const r = reporter({ 'GET /user': () => ((lookups += 1), { json: { login: 'a' } }), [`GET ${repoPath}`]: () => ({ json: { permissions: { push: true } } }) }, signedIn);
    const [first, second] = await Promise.all([r.account(), r.account()]);
    expect(first).toEqual(second);
    expect(lookups).toBe(1);
  });
});

describe('GitHubReporter.fileIssue', () => {
  const routes = (overrides: Parameters<typeof fakeGitHub>[0] = {}) => ({
    [`POST ${repoPath}/git/blobs`]: (body: any) => ({ status: 201, json: { sha: `blob-${body.content.length}` } }),
    [`POST ${repoPath}/git/trees`]: () => ({ status: 201, json: { sha: 'tree1' } }),
    [`POST ${repoPath}/git/commits`]: () => ({ status: 201, json: { sha: 'c0ffee' } }),
    [`POST ${repoPath}/git/refs`]: () => ({ status: 201, json: {} }),
    [`POST ${repoPath}/issues`]: () => ({ status: 201, json: { number: 42, html_url: 'https://github.com/justin06lee/toji/issues/42' } }),
    ...overrides
  });

  test('commits the files under a ref of their own, then files the issue linking them', async () => {
    const { fetch, calls } = fakeGitHub(routes());
    const logs: string[] = [];
    const reporter = new GitHubReporter({ target: DEFAULT_TARGET, fetch, token: async () => ({ token: 'secret', source: 'gh' }), log: (m) => logs.push(m) });
    const result = await reporter.fileIssue(checked(recordingDraft()), { app: '0.3.0' }, '2026-09-11-abc123');
    expect(result).toEqual({ number: 42, url: 'https://github.com/justin06lee/toji/issues/42' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${repoPath}/git/blobs`,
      `POST ${repoPath}/git/blobs`,
      `POST ${repoPath}/git/trees`,
      `POST ${repoPath}/git/commits`,
      `POST ${repoPath}/git/refs`,
      `POST ${repoPath}/issues`
    ]);
    expect(calls.every((c) => c.auth === 'Bearer secret')).toBe(true);
    expect(Buffer.from(calls[0].body.content, 'base64')).toEqual(Buffer.from(mp4));
    expect(calls[2].body.tree.map((t: any) => t.path)).toEqual(['recording.mp4', 'recording-poster.png']);
    expect(calls[3].body.parents).toEqual([]);
    expect(calls[4].body).toEqual({ ref: 'refs/bug-reports/2026-09-11-abc123', sha: 'c0ffee' });
    expect(calls[5].body.title).toBe('Tabs vanish after a resize');
    expect(calls[5].body.labels).toEqual(['bug']);
    expect(calls[5].body.body).toContain('https://raw.githubusercontent.com/justin06lee/toji/c0ffee/recording.mp4');
    expect(logs).toEqual([]);
  });

  test('a report without files is just an issue', async () => {
    const { fetch, calls } = fakeGitHub(routes());
    const reporter = new GitHubReporter({ target: DEFAULT_TARGET, fetch, token: async () => ({ token: 't', source: 'gh' }) });
    await reporter.fileIssue(checked({ kind: 'written', title: 'Hi', description: 'It broke.', files: [] }), {}, 'r');
    expect(calls.map((c) => c.path)).toEqual([`${repoPath}/issues`]);
  });

  test('a refused ref is noted, not fatal', async () => {
    const { fetch } = fakeGitHub(routes({ [`POST ${repoPath}/git/refs`]: () => ({ status: 422, json: { message: 'Reference name invalid' } }) }));
    const logs: string[] = [];
    const reporter = new GitHubReporter({ target: DEFAULT_TARGET, fetch, token: async () => ({ token: 't', source: 'gh' }), log: (m) => logs.push(m) });
    expect((await reporter.fileIssue(checked(recordingDraft()), {}, 'r')).number).toBe(42);
    expect(logs[0]).toMatch(/ref for r not created: GitHub answered 422: Reference name invalid/);
  });

  test('a refused upload stops with a readable reason', async () => {
    const { fetch } = fakeGitHub(routes({ [`POST ${repoPath}/git/blobs`]: () => ({ status: 403, json: { message: 'Resource not accessible' } }) }));
    const reporter = new GitHubReporter({ target: DEFAULT_TARGET, fetch, token: async () => ({ token: 't', source: 'gh' }) });
    const error = await reporter.fileIssue(checked(recordingDraft()), {}, 'r').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/cannot write to the repository/);
  });
});

describe('attachToIssueForm', () => {
  const files = [{ name: 'recording.mp4', type: 'video/mp4', path: '/tmp/r/recording.mp4' }];
  const noWait = async () => {};

  /** A page whose editor text changes when the given way of attaching is used. */
  function page(accepts: 'drop' | 'input' | 'nothing', editor: unknown = { x: 300, y: 200, value: 'Body', input: true }) {
    let value = 'Body';
    const sent: string[] = [];
    const cdp: Cdp = async (method, params = {}) => {
      sent.push(method === 'Input.dispatchDragEvent' ? `${method}:${params.type}` : method);
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        return { result: { value: expression.includes('scrollIntoView') ? editor : value } };
      }
      if (method === 'Input.dispatchDragEvent' && params.type === 'drop' && accepts === 'drop') value += '\n![Uploading recording.mp4…]()';
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 7 };
      if (method === 'DOM.setFileInputFiles' && accepts === 'input') value += '\n![Uploading recording.mp4…]()';
      return {};
    };
    return { cdp, sent };
  }

  test('drops the files on the editor, like a person', async () => {
    const { cdp, sent } = page('drop');
    expect(await attachToIssueForm(cdp, files, { wait: noWait })).toEqual({ ok: true, method: 'drop' });
    expect(sent.filter((m) => m.startsWith('Input'))).toEqual(['Input.dispatchDragEvent:dragEnter', 'Input.dispatchDragEvent:dragOver', 'Input.dispatchDragEvent:drop']);
    expect(sent).not.toContain('DOM.setFileInputFiles');
  });

  test("falls back to the editor's file input when the drop goes unnoticed", async () => {
    const { cdp } = page('input');
    expect(await attachToIssueForm(cdp, files, { wait: noWait })).toEqual({ ok: true, method: 'input' });
  });

  test('says so when neither works, or the form never appears', async () => {
    expect(await attachToIssueForm(page('nothing').cdp, files, { wait: noWait })).toMatchObject({ ok: false, error: /did not take/ });
    let clock = 0;
    const result = await attachToIssueForm(page('drop', null).cdp, files, { wait: noWait, timeoutMs: 1000, now: () => (clock += 400) });
    expect(result).toMatchObject({ ok: false, error: /never showed/ });
  });
});
