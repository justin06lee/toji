// Bug reports, filed as issues on Toji's GitHub repository.
//
// A report reaches GitHub one of two ways, decided per report by the GitHub login this
// machine has:
//
//   direct — a token that can write to the repository: TOJI_GITHUB_TOKEN, GH_TOKEN or
//            GITHUB_TOKEN (environment or .env files), else the GitHub CLI's own login.
//            GitHub's API cannot attach a file to an issue, so the files go into the
//            repository as a commit no branch or tag points at — only
//            refs/bug-reports/<id> holds it, and `git clone` never fetches that — and the
//            issue links them from raw.githubusercontent.com, where images show inline.
//   form   — everyone else. The report opens GitHub's own new-issue form in a Toji tab
//            with the title and text filled in, and the files are dropped onto the form's
//            editor the way a person would drop them, so GitHub uploads them itself (the
//            video then plays on the issue). The reporter presses submit.
//
// The token never leaves the main process: the renderer is told only which login files.
// Everything except the network is pure here, and the network is a `fetch` handed in,
// so all of it is tested without GitHub.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TARGET = Object.freeze({
  repo: 'justin06lee/toji',
  api: 'https://api.github.com',
  web: 'https://github.com',
  raw: 'https://raw.githubusercontent.com'
});

/**
 * Where reports go: Toji's repository on github.com. TOJI_BUG_REPORT_REPO and the
 * TOJI_GITHUB_API / _WEB / _RAW bases point it at a fork, or at a local stand-in for
 * GitHub while testing.
 */
function reportTarget(env = {}) {
  const base = (value, fallback) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.replace(/\/+$/, '') : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    repo: /^[\w.-]+\/[\w.-]+$/.test(env.TOJI_BUG_REPORT_REPO || '') ? env.TOJI_BUG_REPORT_REPO : DEFAULT_TARGET.repo,
    api: base(env.TOJI_GITHUB_API, DEFAULT_TARGET.api),
    web: base(env.TOJI_GITHUB_WEB, DEFAULT_TARGET.web),
    raw: base(env.TOJI_GITHUB_RAW, DEFAULT_TARGET.raw)
  };
}

const TOKEN_VARIABLES = ['TOJI_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** The token to file with and where it came from, or null when this machine has none. */
async function resolveToken(env, readCliToken) {
  for (const name of TOKEN_VARIABLES) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) return { token: value, source: name };
  }
  const cli = readCliToken ? await readCliToken() : null;
  return cli ? { token: cli, source: 'gh' } : null;
}

/** Where the GitHub CLI usually lives. An app started from the Dock has no shell PATH. */
const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'];

/** The GitHub CLI's token for github.com, or null: not installed, not signed in, or too slow. */
function readGhToken(execFile, exists = fs.existsSync) {
  const candidates = [...GH_PATHS.filter((candidate) => exists(candidate)), 'gh'];
  return new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) return resolve(null);
      execFile(candidates[index], ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000 }, (error, stdout) => {
        const token = !error && typeof stdout === 'string' ? stdout.trim() : '';
        if (token) resolve(token);
        else attempt(index + 1);
      });
    };
    attempt(0);
  });
}

const LIMITS = Object.freeze({
  files: 10,
  title: 256,
  text: 20_000,
  imageBytes: 10 * 1024 * 1024,
  recordingBytes: 100 * 1024 * 1024
});

/** What may be attached, and the extension each is stored under. */
const FILE_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
});

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function webUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const short = (value) => (typeof value === 'string' ? value.slice(0, 80) : '');

/**
 * A report as the renderer sent it, checked and normalised, or the reason it cannot be
 * filed. File names are replaced outright, since they end up in URLs and a git tree.
 */
function checkDraft(draft) {
  if (!draft || typeof draft !== 'object') return { error: 'The report was empty.' };
  const kind = draft.kind === 'recording' || draft.kind === 'written' ? draft.kind : null;
  if (!kind) return { error: 'Toji does not know that kind of report.' };
  const title = typeof draft.title === 'string' ? draft.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return { error: 'The report needs a title.' };
  if (title.length > LIMITS.title) return { error: `Keep the title under ${LIMITS.title} characters.` };
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  if (description.length > LIMITS.text) return { error: 'The description is too long for a GitHub issue.' };
  if (kind === 'written' && !description) return { error: 'Describe what happened.' };
  const files = Array.isArray(draft.files) ? draft.files : [];
  if (files.length > LIMITS.files) return { error: `Attach at most ${LIMITS.files} files.` };
  const out = [];
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
  const recordings = out.filter((file) => file.role === 'recording').length;
  if (kind === 'recording' && recordings !== 1) return { error: 'There is no recording to send.' };
  if (kind === 'written' && (recordings || out.some((file) => file.role === 'poster'))) return { error: 'A written report carries images only.' };
  const context = draft.context && typeof draft.context === 'object' ? draft.context : {};
  const seconds = Number(draft.seconds);
  return {
    draft: {
      kind,
      title,
      description,
      pageUrl: webUrl(draft.pageUrl),
      seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null,
      files: out,
      context: { window: short(context.window), layout: short(context.layout), theme: short(context.theme) },
      via: draft.via === 'form' ? 'form' : 'auto'
    }
  };
}

const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The facts about this copy of Toji that go under every report, folded away. */
function environmentTable(facts) {
  const rows = [
    ['Toji', facts.app],
    ['OS', facts.os],
    ['Chromium', facts.chrome],
    ['Electron', facts.electron],
    ['Window', [facts.window, facts.layout && `${facts.layout} tabs`, facts.theme].filter(Boolean).join(', ')],
    ['Page', facts.pageUrl]
  ].filter(([, value]) => value);
  return ['<details><summary>Environment</summary>', '', '| | |', '|---|---|', ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`), '', '</details>'].join('\n');
}

/** Where GitHub's editor puts the files dropped onto the form: right under the description. */
const ATTACHMENTS_MARKER = '<!-- attachments -->';

/**
 * The issue's text. `links` maps each attachment's name to where it can be fetched. On
 * the form route there are none: GitHub's editor writes the markdown for the files
 * dropped onto it, at the marker.
 */
function issueBody(draft, facts, links = null) {
  const parts = [];
  if (draft.description) parts.push(draft.description);
  if (links) {
    const recording = draft.files.find((file) => file.role === 'recording');
    const poster = draft.files.find((file) => file.role === 'poster');
    if (recording && links[recording.name]) {
      const label = `Recording of the last ${Math.round(draft.seconds || 15)} seconds`;
      const format = recording.type === 'video/mp4' ? 'MP4' : 'WebM';
      parts.push(`**${label}** (${format}, ${megabytes(recording.bytes.length)}) · [download](${links[recording.name]})`);
      if (poster && links[poster.name]) parts.push(`[![${label}](${links[poster.name]})](${links[recording.name]})`);
    }
    for (const image of draft.files.filter((file) => file.role === 'image')) {
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
const MAX_FORM_URL = 7000;

/** GitHub's new-issue form, filled in. `overflow` means the body did not fit in the address. */
function newIssueUrl(target, title, body) {
  const url = (text) => `${target.web}/${target.repo}/issues/new?${new URLSearchParams({ title, body: text, labels: 'bug' })}`;
  const full = url(body);
  if (full.length <= MAX_FORM_URL) return { url: full, overflow: false };
  return { url: url('The report is on your clipboard. Paste it here, in place of this line.'), overflow: true };
}

/** Whether `url` is the repository's new-issue form — the only page files are dropped on. */
function isIssueForm(target, url) {
  try {
    const page = new URL(url);
    return page.origin === new URL(target.web).origin && page.pathname.replace(/\/+$/, '').toLowerCase() === `/${target.repo}/issues/new`.toLowerCase();
  } catch {
    return false;
  }
}

/** A report's id: the date, for anyone browsing the refs, and enough randomness to be unique. */
function newReportId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${new Date(now).toISOString().slice(0, 10)}-${suffix}`;
}

/** Write a report's files where the form route can drop them from; returns their paths. */
function writeReportFiles(baseDir, reportId, files) {
  const dir = path.join(baseDir, reportId);
  fs.mkdirSync(dir, { recursive: true });
  return files.map((file) => {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, file.bytes);
    return { name: file.name, type: file.type, path: filePath };
  });
}

/**
 * Remove report folders older than `maxAgeMs`; everything, with 0. (Said outright rather
 * than left to the age test: a folder made this very millisecond carries a sub-millisecond
 * mtime that reads as slightly in the future.)
 */
function pruneReportDirs(baseDir, maxAgeMs, now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    try {
      if (maxAgeMs <= 0 || now - fs.statSync(dir).mtimeMs >= maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function githubMessage(status, data) {
  const detail = data && typeof data.message === 'string' ? data.message : '';
  if (status === 401) return 'GitHub did not accept the login (401). Sign in to the GitHub CLI again, or check the token.';
  if (status === 403 && /rate limit/i.test(detail)) return 'GitHub’s rate limit is used up for now. Try again in a few minutes.';
  if (status === 403 || status === 404) return `This GitHub login cannot write to the repository (${status}).`;
  return `GitHub answered ${status}${detail ? `: ${detail}` : ''}.`;
}

const ACCOUNT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;

class GitHubReporter {
  /**
   * @param {object} options
   * @param {{repo: string, api: string, web: string, raw: string}} options.target
   * @param {typeof fetch} options.fetch
   * @param {() => Promise<{token: string, source: string} | null>} options.token
   */
  constructor({ target, fetch, token, log = () => {}, now = Date.now }) {
    this.target = target;
    this.fetch = fetch;
    this.token = token;
    this.log = log;
    this.now = now;
    this.cached = null;
    this.looking = null;
  }

  /**
   * Which login files reports, and so which route they take. Looked up at most every few
   * minutes, and askers who arrive while a lookup is under way share it.
   */
  account({ refresh = false } = {}) {
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

  async lookUpAccount() {
    const { repo } = this.target;
    let credential = null;
    try {
      credential = await this.token();
    } catch {
      credential = null;
    }
    if (!credential) return { mode: 'form', repo, reason: 'no-login' };
    try {
      const user = await this.request('GET', '/user', undefined, credential.token);
      const repository = await this.request('GET', `/repos/${repo}`, undefined, credential.token);
      const login = String((user && user.login) || '');
      if (repository && repository.permissions && repository.permissions.push) return { mode: 'direct', repo, login, source: credential.source };
      return { mode: 'form', repo, login, source: credential.source, reason: 'no-access' };
    } catch (error) {
      this.log(`bug report: account check failed: ${error.message}`);
      return { mode: 'form', repo, source: credential.source, reason: error.status === 401 ? 'bad-login' : 'unreachable' };
    }
  }

  /** File a checked draft as an issue, its files committed alongside. Returns the issue. */
  async fileIssue(draft, facts, reportId) {
    const credential = await this.token();
    if (!credential) throw new GitHubError(401, 'There is no GitHub login on this machine to file with.');
    const { repo, raw } = this.target;
    const token = credential.token;
    let links = null;
    if (draft.files.length) {
      const tree = [];
      for (const file of draft.files) {
        const blob = await this.request('POST', `/repos/${repo}/git/blobs`, { content: Buffer.from(file.bytes).toString('base64'), encoding: 'base64' }, token);
        tree.push({ path: file.name, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const created = await this.request('POST', `/repos/${repo}/git/trees`, { tree }, token);
      const commit = await this.request('POST', `/repos/${repo}/git/commits`, { message: `Attachments for bug report ${reportId}\n\n${draft.title}`, tree: created.sha, parents: [] }, token);
      try {
        await this.request('POST', `/repos/${repo}/git/refs`, { ref: `refs/bug-reports/${reportId}`, sha: commit.sha }, token);
      } catch (error) {
        // Unreferenced, GitHub may garbage-collect the files some weeks from now. The
        // issue is still worth filing, so this is noted rather than fatal.
        this.log(`bug report: ref for ${reportId} not created: ${error.message}`);
      }
      links = Object.fromEntries(draft.files.map((file) => [file.name, `${raw}/${repo}/${commit.sha}/${file.name}`]));
    }
    const issue = await this.request('POST', `/repos/${repo}/issues`, { title: draft.title, body: issueBody(draft, facts, links), labels: ['bug'] }, token);
    return { number: issue.number, url: issue.html_url };
  }

  async request(method, apiPath, body, token) {
    const response = await this.fetch(`${this.target.api}${apiPath}`, {
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
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new GitHubError(response.status, githubMessage(response.status, data));
    return data;
  }
}

// --- Dropping files onto GitHub's issue form -----------------------------------------

/**
 * Page script: find the issue description editor, make it ready for a drop (in view,
 * focused, caret at the attachments marker), tag it and the file input beside it, and
 * say where it is on screen.
 */
const FIND_EDITOR_JS = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 80 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const areas = Array.from(document.querySelectorAll('textarea')).filter(shown);
  if (!areas.length) return null;
  const words = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
  const area = areas.find((el) => /body|description|comment|markdown/i.test(words(el))) || areas.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  area.setAttribute('data-toji-report-body', '');
  area.scrollIntoView({ block: 'center' });
  area.focus();
  const marker = area.value.indexOf(${JSON.stringify(ATTACHMENTS_MARKER)});
  const caret = marker >= 0 ? marker + ${ATTACHMENTS_MARKER.length} : area.value.length;
  try { area.setSelectionRange(caret, caret); } catch {}
  let input = null;
  for (let node = area.parentElement; node && !input; node = node.parentElement) input = node.querySelector('input[type=file]');
  if (input) input.setAttribute('data-toji-report-files', '');
  const r = area.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 80)), value: area.value, input: Boolean(input) };
})()`;

const EDITOR_VALUE_JS = `(() => { const area = document.querySelector('[data-toji-report-body]'); return area ? area.value : null; })()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Put the report's files into GitHub's issue form: dropped onto the description editor,
 * as a person would, which has GitHub upload them and write their markdown in. If the
 * drop goes unnoticed, the editor's own file input is set instead. `cdp` sends one
 * DevTools Protocol command to the page; success is read off the editor's text changing.
 */
async function attachToIssueForm(cdp, files, { wait = sleep, timeoutMs = 20_000, now = Date.now } = {}) {
  const evaluate = async (expression) => {
    const reply = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    return reply && reply.result ? reply.result.value : null;
  };
  // The form renders client-side, possibly a moment after the page loads.
  let editor = null;
  for (const deadline = now() + timeoutMs; !editor && now() < deadline; ) {
    editor = await evaluate(FIND_EDITOR_JS);
    if (!editor) await wait(300);
  }
  if (!editor) return { ok: false, error: 'The issue form never showed its description box.' };
  const changed = async () => {
    for (let i = 0; i < 20; i += 1) {
      const value = await evaluate(EDITOR_VALUE_JS);
      if (typeof value === 'string' && value !== editor.value) return true;
      await wait(200);
    }
    return false;
  };
  const data = { items: [], files: files.map((file) => file.path), dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: editor.x, y: editor.y, data });
  if (await changed()) return { ok: true, method: 'drop' };
  if (editor.input) {
    const { root } = await cdp('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-toji-report-files]' });
    if (nodeId) {
      await cdp('DOM.setFileInputFiles', { nodeId, files: files.map((file) => file.path) });
      if (await changed()) return { ok: true, method: 'input' };
    }
  }
  return { ok: false, error: 'GitHub did not take the files.' };
}

module.exports = {
  ATTACHMENTS_MARKER,
  DEFAULT_TARGET,
  GitHubError,
  GitHubReporter,
  LIMITS,
  attachToIssueForm,
  checkDraft,
  environmentTable,
  isIssueForm,
  issueBody,
  newIssueUrl,
  newReportId,
  pruneReportDirs,
  readGhToken,
  reportTarget,
  resolveToken,
  writeReportFiles
};
