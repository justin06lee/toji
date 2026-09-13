import { describe, expect, it } from 'vitest';
import {
  ATTACHMENTS_MARKER,
  DEFAULT_TARGET,
  GitHubReporter,
  checkDraft,
  isIssueForm,
  issueBody,
  issuePageState,
  newIssueUrl,
  newReportId,
  reportTarget,
  resolveToken,
  type CheckedDraft
} from './bugReport';

const FACTS = { app: '0.4.0', os: 'macOS 26.6', gecko: '153.2.0' };
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

describe('target and token', () => {
  it('uses Toji’s repository unless overridden with safe values', () => {
    expect(reportTarget({})).toEqual(DEFAULT_TARGET);
    const t = reportTarget({ TOJI_BUG_REPORT_REPO: 'me/fork', TOJI_GITHUB_API: 'http://127.0.0.1:9/', TOJI_GITHUB_WEB: 'javascript:x' });
    expect(t).toMatchObject({ repo: 'me/fork', api: 'http://127.0.0.1:9', web: DEFAULT_TARGET.web });
  });

  it('prefers the environment, then the GitHub CLI', async () => {
    expect(await resolveToken({ GH_TOKEN: ' a ' }, async () => 'cli')).toEqual({ token: 'a', source: 'GH_TOKEN' });
    expect(await resolveToken({}, async () => 'cli')).toEqual({ token: 'cli', source: 'gh' });
    expect(await resolveToken({}, async () => null)).toBeNull();
  });
});

describe('checkDraft', () => {
  it('needs a title, and text for a written report', () => {
    expect(checkDraft({ kind: 'written', title: ' ', description: 'x' })).toEqual({ error: 'The report needs a title.' });
    expect(checkDraft({ kind: 'written', title: 't', description: '' })).toEqual({ error: 'Describe what happened.' });
  });

  it('names files itself and checks their roles', () => {
    const ok = checkDraft({ kind: 'written', title: 'T', description: 'd', files: [{ type: 'image/png', role: 'image', data: png }] });
    expect('draft' in ok && ok.draft.files[0].name).toBe('image-1.png');
    expect(checkDraft({ kind: 'written', title: 'T', description: 'd', files: [{ type: 'video/mp4', role: 'image', data: png }] })).toEqual({
      error: 'One of the attachments is not what it says it is.'
    });
    expect(checkDraft({ kind: 'recording', title: 'T', description: '' })).toEqual({ error: 'There is no recording to send.' });
  });

  it('drops a non-web page address', () => {
    const ok = checkDraft({ kind: 'written', title: 'T', description: 'd', pageUrl: 'about:start' });
    expect('draft' in ok && ok.draft.pageUrl).toBeNull();
  });
});

describe('issue text and form', () => {
  const draft = (checkDraft({ kind: 'written', title: 'Broken', description: 'It broke.', files: [{ type: 'image/png', role: 'image', data: png }] }) as { draft: CheckedDraft }).draft;

  it('marks where the form route’s files go, and reports Gecko facts', () => {
    const body = issueBody(draft, FACTS);
    expect(body).toContain(ATTACHMENTS_MARKER);
    expect(body).toContain('| Gecko | 153.2.0 |');
    expect(body).not.toContain('Chromium');
  });

  it('links files on the direct route', () => {
    expect(issueBody(draft, FACTS, { 'image-1.png': 'https://raw/x.png' })).toContain('![image-1.png](https://raw/x.png)');
  });

  it('falls back to the clipboard for long bodies', () => {
    expect(newIssueUrl(DEFAULT_TARGET, 't', 'short').overflow).toBe(false);
    expect(newIssueUrl(DEFAULT_TARGET, 't', 'x'.repeat(9000)).overflow).toBe(true);
  });

  it('recognises the form and the filed issue', () => {
    expect(isIssueForm(DEFAULT_TARGET, 'https://github.com/justin06lee/toji/issues/new?title=x')).toBe(true);
    expect(isIssueForm(DEFAULT_TARGET, 'https://evil.test/justin06lee/toji/issues/new')).toBe(false);
    expect(issuePageState(DEFAULT_TARGET, 'https://github.com/justin06lee/toji/issues/42')).toBe('filed');
    expect(issuePageState(DEFAULT_TARGET, 'https://github.com/login')).toBe('elsewhere');
  });

  it('makes dated ids', () => {
    expect(newReportId(Date.UTC(2026, 8, 13), () => 0.5)).toMatch(/^2026-09-13-[0-9a-z]{6}$/);
  });
});

describe('GitHubReporter against a fake API', () => {
  function fake(push: boolean) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetch = async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      const path = new URL(url).pathname;
      const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
      if (path === '/user') return reply({ login: 'me' });
      if (path === '/repos/justin06lee/toji') return reply({ permissions: { push } });
      if (path.endsWith('/git/blobs')) return reply({ sha: 'blob1' });
      if (path.endsWith('/git/trees')) return reply({ sha: 'tree1' });
      if (path.endsWith('/git/commits')) return reply({ sha: 'commit1' });
      if (path.endsWith('/git/refs')) return reply({});
      if (path.endsWith('/issues')) return reply({ number: 7, html_url: 'http://fake/issues/7' });
      return reply({ message: 'nope' }, 404);
    };
    const reporter = new GitHubReporter({
      target: { ...DEFAULT_TARGET, api: 'http://fake' },
      fetch,
      token: async () => ({ token: 't', source: 'GH_TOKEN' })
    });
    return { reporter, calls };
  }

  it('files directly with push access, committing files under a bug-report ref', async () => {
    const { reporter, calls } = fake(true);
    expect(await reporter.account()).toMatchObject({ mode: 'direct', login: 'me' });
    const draft = (checkDraft({ kind: 'written', title: 'T', description: 'd', files: [{ type: 'image/png', role: 'image', data: png }] }) as { draft: CheckedDraft }).draft;
    expect(await reporter.fileIssue(draft, FACTS, '2026-09-13-abcdef')).toEqual({ number: 7, url: 'http://fake/issues/7' });
    const ref = calls.find((c) => c.url.endsWith('/git/refs'));
    expect(ref?.body).toEqual({ ref: 'refs/bug-reports/2026-09-13-abcdef', sha: 'commit1' });
    const commit = calls.find((c) => c.url.endsWith('/git/commits'));
    expect((commit?.body as { parents: unknown[] }).parents).toEqual([]);
  });

  it('routes to the form without push access', async () => {
    expect(await fake(false).reporter.account()).toMatchObject({ mode: 'form', reason: 'no-access' });
  });
});
