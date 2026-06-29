import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { config } from '../config.js';
import type { LinkCandidate, ResearchMode, ResearchOptions, ResearchPlan, ResearchSessionState, SearchResult, TabAction, TabState } from '../types.js';
import { broadcast, logAgent } from '../lib/events.js';
import { compactText, fingerprintQuery, normalizeWhitespace, safeHostname } from '../lib/text.js';
import { countSessions, loadSessions, removeSessionSnapshots, saveSession } from '../lib/storage.js';
import { getCachedSource, putCachedSource } from '../lib/sourceCache.js';
import { predictIntent } from './predictionAgent.js';
import { buildResearchPlan, heuristicPlan } from './plannerAgent.js';
import { gatherSearchCandidates } from './search.js';
import { summarizeSource, synthesizeAnswer } from './synthesisAgent.js';

const AGENT_NAMES = ['Atlas', 'Nova', 'Kepler', 'Vega', 'Lyra', 'Orion', 'Mira', 'Sol'];
const ACTIVE_STATUSES = new Set(['queued', 'planning', 'searching', 'ranking', 'running', 'synthesizing']);

class SessionCancelledError extends Error {
  constructor() {
    super('Session cancelled');
  }
}

function now() {
  return new Date().toISOString();
}

/** True for IPv4 addresses that must never be reachable by the headless browser (loopback, link-local, RFC1918, CGNAT, multicast/reserved). Unknown shapes are treated as unsafe. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** True for IPv6 addresses that must never be reachable (loopback, unspecified, ULA, link-local, and IPv4-mapped private addresses). */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true; // link-local / ULA
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * SSRF guard: reject any URL that is not http(s) or that resolves to a loopback,
 * link-local, or private (RFC1918/ULA/CGNAT) address. Hostnames are resolved via
 * DNS so that a public name that points at an internal IP is still blocked.
 */
async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Blocked navigation to invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked navigation to non-http(s) URL (${parsed.protocol})`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const resolved = await lookup(host, { all: true });
    addresses = resolved.map((entry) => entry.address);
    if (addresses.length === 0) throw new Error(`Blocked navigation to unresolvable host: ${host}`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked navigation to private or internal host: ${host}`);
    }
  }
}

function action(type: TabAction['type'], label: string, detail?: string): TabAction {
  return { at: now(), type, label, detail };
}

function cloneSession(session: ResearchSessionState): ResearchSessionState {
  return JSON.parse(JSON.stringify(session)) as ResearchSessionState;
}

function emptyPlan(query: string): ResearchPlan {
  return {
    objective: `Research ${query}`,
    searchQueries: [],
    questions: [],
    sourceStrategy: ['Waiting for the planner agent.'],
    expectedOutputs: ['answer', 'citations'],
    stopConditions: ['planner not complete'],
    maxDepth: 1,
    stance: 'balanced',
    goal: `Research ${query}`,
    depth: 'standard',
    riskControls: ['No browser tabs open until planning completes.'],
    expectedOutput: ['answer', 'citations'],
    steps: [
      {
        id: 'predict',
        title: 'Understand intent',
        description: 'Predict intent before spending network work.',
        agent: 'prediction',
        status: 'queued',
        queries: [query],
        targetSources: ['typed query'],
        budgetTabs: 0
      }
    ]
  };
}

function markStep(plan: ResearchPlan | undefined, id: string, status: 'queued' | 'running' | 'complete' | 'skipped') {
  if (!plan?.steps) return;
  plan.steps = plan.steps.map((step) => (step.id === id ? { ...step, status } : step));
}

function defaultOptions(mode: ResearchMode, options: Partial<ResearchOptions> = {}): ResearchOptions {
  return {
    depth: options.depth ?? (mode === 'speculative' ? 'spark' : 'standard'),
    maxTabs: options.maxTabs,
    visualSnapshots: options.visualSnapshots ?? true,
    includeVisualAnalysis: options.includeVisualAnalysis ?? config.enableVisualAnalysis,
    freshness: options.freshness ?? 'auto'
  };
}

function maxTabsFor(session: ResearchSessionState) {
  const runProfileCap = Math.max(1, Math.min(config.maxAgentTabs, session.options.maxTabs ?? config.maxAgentTabs));
  const predicted = Math.min(session.prediction?.budget.maxTabs ?? config.maxAgentTabs, runProfileCap);
  const depthCap =
    session.depth === 'deep'
      ? runProfileCap
      : session.depth === 'standard'
        ? Math.min(runProfileCap, predicted)
        : session.depth === 'quick'
          ? Math.min(4, runProfileCap, predicted)
          : Math.min(3, runProfileCap, predicted);
  if (session.mode === 'speculative') {
    return Math.max(1, Math.min(config.maxSpeculativeTabs, runProfileCap, session.prediction?.budget.speculativeTabs || 1, depthCap));
  }
  return Math.max(1, Math.min(runProfileCap, depthCap));
}

async function captureScreenshot(page: Page): Promise<string | undefined> {
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 58, fullPage: false, timeout: 6_000 });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function dismissOrExpandSafeControls(page: Page) {
  const labels = [/accept/i, /agree/i, /reject/i, /show more/i, /read more/i, /expand/i];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    try {
      await button.click({ timeout: 900 });
      return `Clicked “${label.source.replace(/\\/g, '')}” control`;
    } catch {
      // Keep trying safe controls.
    }
  }
  try {
    await page.locator('summary').first().click({ timeout: 900 });
    return 'Expanded a summary/details control';
  } catch {
    return undefined;
  }
}

async function extractPage(page: Page): Promise<{ title: string; url: string; text: string; headings: string[]; links: LinkCandidate[] }> {
  return page.evaluate(() => {
    const bodyClone = document.body?.cloneNode(true) as HTMLElement | undefined;
    bodyClone?.querySelectorAll('script, style, noscript, svg, canvas, iframe, nav, footer, aside, form').forEach((node) => node.remove());
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 18);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((node) => ({
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
        url: (node as HTMLAnchorElement).href
      }))
      .filter((link) => link.text && link.url.startsWith('http'))
      .slice(0, 30);
    const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    const text = [metaDescription, bodyClone?.innerText ?? document.body?.innerText ?? '']
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      title: document.title || location.hostname,
      url: location.href,
      headings,
      links,
      text
    };
  });
}

export class ResearchOrchestrator {
  private sessions = new Map<string, ResearchSessionState>();
  private abortControllers = new Map<string, AbortController>();
  private browsers = new Map<string, Browser>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly SAVE_DEBOUNCE_MS = 400;

  async hydrate() {
    const saved = await loadSessions();
    for (const session of saved) {
      if (ACTIVE_STATUSES.has(session.status)) {
        session.status = 'cancelled';
        session.error = 'Interrupted when the Toji server restarted.';
      }
      this.sessions.set(session.id, session);
    }
  }

  async storedSessionCount() {
    return countSessions();
  }

  getSession(id: string) {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  async removeSession(id: string, options?: { skipActive?: boolean }) {
    const session = this.sessions.get(id);
    if (!session) return { removed: false, wasActive: false, fromMemory: false };

    const isActive = ACTIVE_STATUSES.has(session.status);
    if (isActive && options?.skipActive) {
      return { removed: false, wasActive: true, fromMemory: true };
    }

    if (isActive) {
      this.abortControllers.get(id)?.abort();
      const browser = this.browsers.get(id);
      if (browser) await browser.close().catch(() => undefined);
      session.status = 'cancelled';
      session.metrics.completedAt = now();
      if (session.metrics.startedAt) session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
      logAgent(session.id, 'Session cancelled.', 'warn');
    }
    this.cancelPendingSave(id);
    this.sessions.delete(id);
    this.abortControllers.delete(id);
    this.browsers.delete(id);
    await removeSessionSnapshots([id]);
    return { removed: true, wasActive: isActive, fromMemory: true };
  }

  /**
   * Keep the in-memory maps bounded. Without this the sessions / abortControllers /
   * browsers maps grow for the lifetime of the process. We only ever evict *inactive*
   * sessions (running ones own a browser + abort controller), oldest first.
   */
  private evictStaleSessions() {
    const maxInMemory = Math.max(config.sessionHistoryLimit * 3, 24);
    if (this.sessions.size <= maxInMemory) return;

    const evictable = [...this.sessions.values()]
      .filter((session) => !ACTIVE_STATUSES.has(session.status))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

    let overflow = this.sessions.size - maxInMemory;
    for (const session of evictable) {
      if (overflow <= 0) break;
      this.cancelPendingSave(session.id);
      this.sessions.delete(session.id);
      this.abortControllers.delete(session.id);
      this.browsers.delete(session.id);
      overflow -= 1;
    }
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, config.sessionHistoryLimit)
      .map(cloneSession);
  }

  start(query: string, mode: ResearchMode = 'committed', options: Partial<ResearchOptions> = {}, previousSessionId?: string) {
    const clean = normalizeWhitespace(query);
    const sessionOptions = defaultOptions(mode, options);
    const session: ResearchSessionState = {
      id: randomUUID(),
      mode,
      query: clean,
      queryFingerprint: fingerprintQuery(clean),
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
      depth: sessionOptions.depth,
      options: sessionOptions,
      plan: emptyPlan(clean),
      searchPlan: [],
      researchPlan: emptyPlan(clean),
      tabs: [],
      sources: [],
      metrics: {
        tabsOpened: 0,
        pagesRead: 0,
        screenshotsCaptured: 0,
        cacheHits: 0,
        sourcesSummarized: 0,
        searchQueries: 0,
        searchResults: 0,
        startedAt: now()
      },
      previousSessionId
    };

    const controller = new AbortController();
    this.sessions.set(session.id, session);
    this.abortControllers.set(session.id, controller);
    this.evictStaleSessions();
    this.emit(session);
    if (mode === 'demo') void this.runDemo(session, controller).catch((error) => this.handleRunError(session, controller, error));
    else void this.run(session, controller).catch((error) => this.handleRunError(session, controller, error));
    return cloneSession(session);
  }

  async commit(id: string, queryOverride?: string) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const query = normalizeWhitespace(queryOverride || session.query);
    if (ACTIVE_STATUSES.has(session.status)) await this.cancel(id);
    const nextDepth = session.depth === 'spark' ? 'standard' : session.depth ?? 'standard';
    return this.start(query, 'committed', { ...session.options, depth: nextDepth }, id);
  }

  async clearSessions() {
    const sessions = [...this.sessions.values()];
    const removed: string[] = [];
    const skipped: string[] = [];

    for (const session of sessions) {
      if (ACTIVE_STATUSES.has(session.status)) {
        skipped.push(session.id);
        continue;
      }
      this.cancelPendingSave(session.id);
      this.sessions.delete(session.id);
      this.abortControllers.delete(session.id);
      this.browsers.delete(session.id);
      removed.push(session.id);
    }

    const removedSnapshots = await removeSessionSnapshots(removed);
    return { removed: removedSnapshots, skipped };
  }

  async cancel(id: string) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.abortControllers.get(id)?.abort();
    this.abortControllers.delete(id);
    const browser = this.browsers.get(id);
    if (browser) await browser.close().catch(() => undefined);
    this.browsers.delete(id);
    session.status = 'cancelled';
    session.metrics.completedAt = now();
    if (session.metrics.startedAt) session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
    this.emit(session);
    logAgent(session.id, 'Session cancelled.', 'warn');
    return cloneSession(session);
  }

  private emit(session: ResearchSessionState) {
    if (!this.sessions.has(session.id)) return;
    session.updatedAt = now();
    session.metrics.tabsOpened = session.tabs.length;
    session.metrics.sourcesSummarized = session.sources.length;
    // broadcast() serializes its argument synchronously and keeps no reference, so
    // the live session can be passed directly (no defensive deep clone needed).
    broadcast({ type: 'session_update', session });
    this.persist(session);
  }

  private flushSave(session: ResearchSessionState) {
    void saveSession(session).catch((error) => console.error(`[toji] failed to persist session ${session.id}:`, error));
  }

  private cancelPendingSave(id: string) {
    const timer = this.saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.saveTimers.delete(id);
    }
  }

  /**
   * Coalesce disk persistence. emit() fires dozens of times per tab and each session
   * can carry large base64 screenshots, so writing on every call is heavy. Terminal
   * states flush synchronously (durability of the final snapshot); intermediate states
   * are debounced into a single trailing write.
   */
  private persist(session: ResearchSessionState) {
    this.cancelPendingSave(session.id);
    const terminal = session.status === 'complete' || session.status === 'error' || session.status === 'cancelled';
    if (terminal) {
      this.flushSave(session);
      return;
    }
    const timer = setTimeout(() => {
      this.saveTimers.delete(session.id);
      if (!this.sessions.has(session.id)) return;
      this.flushSave(session);
    }, ResearchOrchestrator.SAVE_DEBOUNCE_MS);
    timer.unref?.();
    this.saveTimers.set(session.id, timer);
  }

  private handleRunError(session: ResearchSessionState, controller: AbortController, error: unknown) {
    if (controller.signal.aborted || error instanceof SessionCancelledError || session.status === 'cancelled') {
      session.status = 'cancelled';
      this.emit(session);
      return;
    }
    this.fail(session, error);
  }

  private fail(session: ResearchSessionState, error: unknown) {
    session.status = 'error';
    session.error = error instanceof Error ? error.message : String(error);
    session.metrics.completedAt = now();
    if (session.metrics.startedAt) session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
    logAgent(session.id, session.error, 'error');
    this.emit(session);
  }

  private assertNotCancelled(session: ResearchSessionState, controller: AbortController) {
    if (controller.signal.aborted || session.status === 'cancelled') throw new SessionCancelledError();
  }

  private async run(session: ResearchSessionState, controller: AbortController) {
    session.status = 'planning';
    markStep(session.researchPlan, 'predict', 'running');
    logAgent(session.id, `${session.mode === 'speculative' ? 'Speculative' : 'Committed'} research session started.`);
    this.emit(session);

    const prediction = await predictIntent(session.query);
    this.assertNotCancelled(session, controller);
    session.prediction = prediction;
    session.queryFingerprint = prediction.queryFingerprint;
    broadcast({ type: 'prediction', prediction });
    markStep(session.researchPlan, 'predict', 'complete');
    this.emit(session);

    const plan = await buildResearchPlan(session.query, prediction, session.mode);
    this.assertNotCancelled(session, controller);
    const profileDepth = session.options.depth ?? plan.depth;
    session.researchPlan = { ...plan, depth: profileDepth };
    session.plan = session.researchPlan;
    session.depth = profileDepth;
    markStep(session.researchPlan, 'search', 'running');
    this.emit(session);

    const maxTabs = maxTabsFor(session);
    const searchPlan = prediction.searchPlan.length > 0 ? prediction.searchPlan : plan.searchQueries.map((query: string, index: number) => ({ query, intent: 'planned search', priority: Math.max(0.4, 1 - index * 0.14), freshness: session.options.freshness }));
    const boundedSearchPlan = searchPlan.slice(0, session.mode === 'speculative' ? 1 : prediction.budget.maxSearchQueries);

    session.status = 'searching';
    logAgent(session.id, `Searching ${boundedSearchPlan.length} path${boundedSearchPlan.length === 1 ? '' : 's'} with a ${maxTabs}-tab budget.`);
    this.emit(session);

    const searchResults = await gatherSearchCandidates(boundedSearchPlan, maxTabs);
    this.assertNotCancelled(session, controller);
    session.metrics.searchQueries = boundedSearchPlan.length;
    session.metrics.searchResults = searchResults.length;
    markStep(session.researchPlan, 'search', 'complete');
    session.status = 'ranking';
    logAgent(session.id, `Ranked ${searchResults.length} candidate source${searchResults.length === 1 ? '' : 's'} and selected ${Math.min(searchResults.length, maxTabs)} for visible browsing.`);
    this.emit(session);
    markStep(session.researchPlan, 'browse', 'running');
    session.status = 'running';
    this.emit(session);

    const browser = await chromium.launch({ headless: config.agentBrowserHeadless });
    this.browsers.set(session.id, browser);
    let context: BrowserContext | undefined;

    try {
      const activeContext = await browser.newContext({
        viewport: { width: 1365, height: 768 },
        userAgent: config.userAgent
      });
      context = activeContext;
      const queue = searchResults.slice(0, maxTabs);
      const workers = Array.from({ length: Math.min(config.maxConcurrentTabs, queue.length) }, async () => {
        while (queue.length > 0) {
          const result = queue.shift();
          if (!result) return;
          this.assertNotCancelled(session, controller);
          await this.runSourceAgent(session, activeContext, result, controller);
        }
      });
      await Promise.allSettled(workers);
    } finally {
      if (context) await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      this.browsers.delete(session.id);
    }

    this.assertNotCancelled(session, controller);
    markStep(session.researchPlan, 'browse', 'complete');
    markStep(session.researchPlan, 'synthesize', 'running');
    session.status = 'synthesizing';
    logAgent(session.id, `Synthesizing ${session.sources.length} source notes into an answer canvas.`);
    this.emit(session);

    session.synthesis = await synthesizeAnswer(session.query, session.sources);
    markStep(session.researchPlan, 'synthesize', 'complete');
    session.status = 'complete';
    session.metrics.completedAt = now();
    if (session.metrics.startedAt) session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
    this.emit(session);
    logAgent(session.id, 'Research complete.');
  }

  private async runSourceAgent(session: ResearchSessionState, context: BrowserContext, result: SearchResult, controller: AbortController) {
    const tab: TabState = {
      id: randomUUID(),
      agentName: AGENT_NAMES[session.tabs.length % AGENT_NAMES.length],
      agentGoal: result.reason || `Inspect ${safeHostname(result.url)} for evidence about the query.`,
      title: result.title,
      url: result.url,
      domain: result.domain || safeHostname(result.url),
      status: 'queued',
      progress: 0,
      evidenceCount: 0,
      readableChars: 0,
      discoveredLinks: [],
      sourceScore: result.score,
      actions: [action('open', 'Queued a new research tab', result.snippet)]
    };

    session.tabs.push(tab);
    this.emit(session);

    const cached = await getCachedSource(session.queryFingerprint, result.url);
    if (cached) {
      const note = { ...cached, tabId: tab.id, cacheHit: true };
      tab.status = 'cached';
      tab.progress = 1;
      tab.summary = note.summary;
      tab.evidenceCount = note.keyFacts.length + note.quotes.length;
      tab.readableChars = note.wordCount;
      tab.credibility = note.credibility;
      tab.discoveredLinks = note.discoveredLinks;
      tab.cacheHit = true;
      tab.actions.push(action('cache', 'Reused cached source note', safeHostname(note.url)));
      session.sources.push(note);
      session.metrics.cacheHits += 1;
      this.emit(session);
      return;
    }

    const page = await context.newPage();
    page.setDefaultTimeout(config.requestTimeoutMs);
    const onFrameNavigated = (frame: Frame) => {
      if (frame === page.mainFrame()) {
        tab.url = frame.url();
        tab.domain = safeHostname(frame.url());
        tab.actions.push(action('navigate', 'Navigated', frame.url()));
        this.emit(session);
      }
    };
    page.on('framenavigated', onFrameNavigated);

    try {
      this.assertNotCancelled(session, controller);
      tab.status = 'navigating';
      tab.progress = 0.14;
      tab.actions.push(action('navigate', 'Opening source', result.url));
      this.emit(session);

      await assertSafeUrl(result.url);
      await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: config.requestTimeoutMs });
      // page.goto transparently follows redirects; re-validate the landed URL so a
      // public source cannot 30x-redirect the browser into an internal service.
      await assertSafeUrl(page.url());
      tab.title = (await page.title().catch(() => result.title)) || result.title;
      tab.url = page.url();
      tab.domain = safeHostname(tab.url);
      tab.status = 'reading';
      tab.progress = 0.32;
      if (session.options.visualSnapshots) {
        tab.screenshot = await captureScreenshot(page);
        if (tab.screenshot) session.metrics.screenshotsCaptured += 1;
        tab.actions.push(action('screenshot', 'Captured above-the-fold view'));
      } else {
        tab.actions.push(action('snapshot', 'Visual snapshots disabled in run profile'));
      }
      this.emit(session);

      this.assertNotCancelled(session, controller);
      tab.status = 'interacting';
      const clickDetail = await dismissOrExpandSafeControls(page);
      if (clickDetail) tab.actions.push(action('click', clickDetail));
      else tab.actions.push(action('click', 'Focused the page surface without changing route'));
      await page.mouse.wheel(0, 820).catch(() => undefined);
      await page.waitForTimeout(520).catch(() => undefined);
      if (session.options.visualSnapshots) {
        tab.screenshot = await captureScreenshot(page);
        if (tab.screenshot) session.metrics.screenshotsCaptured += 1;
      }
      tab.actions.push(action('scroll', 'Scrolled for more evidence'));
      tab.progress = 0.52;
      this.emit(session);

      const extracted = await extractPage(page);
      extracted.text = compactText(extracted.text, session.depth === 'deep' ? 22_000 : 14_000);
      tab.evidenceCount = Math.max(1, extracted.headings.length + Math.min(4, extracted.links.length));
      tab.readableChars = extracted.text.length;
      tab.discoveredLinks = extracted.links;
      tab.actions.push(action('scan', 'Extracted readable page text', `${extracted.text.length.toLocaleString()} characters`));
      tab.status = 'summarizing';
      tab.progress = 0.76;
      session.metrics.pagesRead += 1;
      this.emit(session);

      const note = await summarizeSource(session.query, extracted, result, tab.id, session.options.includeVisualAnalysis ? tab.screenshot : undefined);
      session.sources.push(note);
      await putCachedSource(session.queryFingerprint, result.url, note).catch(() => undefined);
      tab.summary = note.summary;
      tab.evidenceCount = Math.max(tab.evidenceCount, note.keyFacts.length + note.quotes.length);
      tab.credibility = note.credibility;
      tab.status = 'complete';
      tab.progress = 1;
      tab.actions.push(action('summarize', 'Created source note', note.summary));
      this.emit(session);
    } catch (error) {
      if (controller.signal.aborted) {
        tab.status = 'error';
        tab.error = 'Cancelled before this tab finished.';
      } else {
        tab.status = 'error';
        tab.error = error instanceof Error ? error.message : String(error);
      }
      tab.actions.push(action('error', 'Tab agent stopped', tab.error));
      this.emit(session);
    } finally {
      page.off('framenavigated', onFrameNavigated);
      await page.close().catch(() => undefined);
    }
  }
  private async runDemo(session: ResearchSessionState, controller: AbortController) {
    const steps = [
      { title: 'Cerebras inference docs', url: 'https://inference-docs.cerebras.ai', summary: 'Documents low-latency chat completions and multimodal image inputs for Gemma workflows.' },
      { title: 'Playwright tab workspace', url: 'https://playwright.dev/docs/api/class-page', summary: 'A Playwright Page maps cleanly to a visible browser tab that Toji can navigate, scroll, screenshot, and summarize.' },
      { title: 'Toji synthesis canvas', url: 'https://toji.local/demo', summary: 'The synthesis agent turns source notes into visual blocks, findings, and citations.' }
    ];

    session.status = 'planning';
    session.prediction = await predictIntent(session.query || 'Toji agent browser demo');
    session.searchPlan = session.prediction.searchPlan.slice(0, 2);
    session.researchPlan = heuristicPlan(session.query || 'Toji demo', session.prediction, 'committed');
    session.plan = session.researchPlan;
    this.emit(session);

    session.status = 'running';
    logAgent(session.id, 'Demo mode is replaying a deterministic Toji research trace.');
    this.emit(session);

    for (const [index, step] of steps.entries()) {
      this.assertNotCancelled(session, controller);
      const tab: TabState = {
        id: randomUUID(),
        agentName: AGENT_NAMES[index],
        agentGoal: 'Replay a demo source interaction without network access.',
        title: step.title,
        url: step.url,
        domain: safeHostname(step.url),
        status: 'interacting',
        screenshot: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" rx="36" fill="#101827"/><text x="90" y="180" fill="#fff" font-size="54" font-family="Arial">${step.title}</text><text x="90" y="250" fill="#a7abc3" font-size="26" font-family="Arial">${safeHostname(step.url)}</text></svg>`).toString('base64')}`,
        progress: 0.65,
        evidenceCount: 1,
        readableChars: step.summary.length,
        discoveredLinks: [],
        sourceScore: 0.9,
        actions: [action('open', 'Opened demo research tab'), action('scroll', 'Scrolled through demo page'), action('read', 'Read source summary')]
      };
      session.tabs.push(tab);
      session.metrics.screenshotsCaptured += 1;
      this.emit(session);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const note = {
        tabId: tab.id,
        title: step.title,
        url: step.url,
        snippet: step.summary,
        summary: step.summary,
        keyFacts: [step.summary, 'This demo note is generated locally so Toji works without API keys or network access.'],
        quotes: ['Demo trace generated locally by Toji.'],
        credibility: 'strong' as const,
        signals: [
          { label: 'mode', value: 'demo' },
          { label: 'host', value: safeHostname(step.url) }
        ],
        capturedAt: now(),
        wordCount: step.summary.split(/\s+/).length,
        sourceScore: 0.9,
        discoveredLinks: []
      };
      session.sources.push(note);
      tab.status = 'complete';
      tab.progress = 1;
      tab.summary = note.summary;
      tab.credibility = note.credibility;
      tab.actions.push(action('summarize', 'Created demo source note'));
      this.emit(session);
    }

    session.status = 'synthesizing';
    this.emit(session);
    session.synthesis = await synthesizeAnswer(session.query, session.sources);
    session.status = 'complete';
    session.metrics.completedAt = now();
    session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
    this.emit(session);
  }

}

export const researchOrchestrator = new ResearchOrchestrator();
