import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { ResearchMode, ResearchOptions, ResearchPlan, ResearchSessionState, SearchResult, TabAction, TabState } from '../types.js';
import { broadcast, logAgent } from '../lib/events.js';
import { compactText, fingerprintQuery, normalizeWhitespace, safeHostname } from '../lib/text.js';
import { countSessions, loadSessions, removeSessionSnapshots, saveSession } from '../lib/storage.js';
import { getCachedSource, putCachedSource } from '../lib/sourceCache.js';
import { predictIntent } from './predictionAgent.js';
import { buildResearchPlan, heuristicPlan } from './plannerAgent.js';
import { gatherSearchCandidates } from './search.js';
import { extractPage, fetchHtml, NotHtmlError } from './readPage.js';
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

function finalizeMetrics(session: ResearchSessionState) {
  session.metrics.completedAt = now();
  if (session.metrics.startedAt) {
    session.metrics.elapsedMs = Date.parse(session.metrics.completedAt) - Date.parse(session.metrics.startedAt);
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

export class ResearchOrchestrator {
  private sessions = new Map<string, ResearchSessionState>();
  private abortControllers = new Map<string, AbortController>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly SAVE_DEBOUNCE_MS = 400;
  private hydrated: Promise<void> | null = null;

  /** Saved sessions are read once, when something first asks for them, never at boot. */
  hydrate() {
    return (this.hydrated ??= this.load());
  }

  private async load() {
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
      // Aborting the controller cancels every in-flight source fetch for this session.
      this.abortControllers.get(id)?.abort();
      session.status = 'cancelled';
      finalizeMetrics(session);
      logAgent(session.id, 'Session cancelled.', 'warn');
    }
    this.cancelPendingSave(id);
    this.sessions.delete(id);
    this.abortControllers.delete(id);
    await removeSessionSnapshots([id]);
    return { removed: true, wasActive: isActive, fromMemory: true };
  }

  /**
   * Keep the in-memory maps bounded. Without this the sessions / abortControllers maps
   * grow for the lifetime of the process. We only ever evict *inactive* sessions
   * (running ones own an abort controller), oldest first.
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
    session.status = 'cancelled';
    finalizeMetrics(session);
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
    finalizeMetrics(session);
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
    logAgent(session.id, `Ranked ${searchResults.length} candidate source${searchResults.length === 1 ? '' : 's'} and selected ${Math.min(searchResults.length, maxTabs)} to read.`);
    this.emit(session);
    markStep(session.researchPlan, 'browse', 'running');
    session.status = 'running';
    this.emit(session);

    // Each "tab" is a source being read over plain HTTP; MAX_CONCURRENT_TABS bounds how
    // many are in flight at once.
    const queue = searchResults.slice(0, maxTabs);
    const workers = Array.from({ length: Math.min(config.maxConcurrentTabs, queue.length) }, async () => {
      while (queue.length > 0) {
        const result = queue.shift();
        if (!result) return;
        this.assertNotCancelled(session, controller);
        await this.runSourceAgent(session, result, controller);
      }
    });
    await Promise.allSettled(workers);

    this.assertNotCancelled(session, controller);
    markStep(session.researchPlan, 'browse', 'complete');
    markStep(session.researchPlan, 'synthesize', 'running');
    session.status = 'synthesizing';
    logAgent(session.id, `Synthesizing ${session.sources.length} source notes into an answer canvas.`);
    this.emit(session);

    session.synthesis = await synthesizeAnswer(session.query, session.sources);
    markStep(session.researchPlan, 'synthesize', 'complete');
    session.status = 'complete';
    finalizeMetrics(session);
    this.emit(session);
    logAgent(session.id, 'Research complete.');
  }

  private async runSourceAgent(session: ResearchSessionState, result: SearchResult, controller: AbortController) {
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

    try {
      this.assertNotCancelled(session, controller);
      tab.status = 'navigating';
      tab.progress = 0.14;
      tab.actions.push(action('navigate', 'Opening source', result.url));
      this.emit(session);

      // fetchHtml follows redirects itself and runs the SSRF guard on every hop before
      // requesting it, so a public source cannot bounce the read into an internal service.
      const fetched = await fetchHtml(result.url, {
        signal: controller.signal,
        timeoutMs: config.requestTimeoutMs,
        userAgent: config.userAgent,
        onRedirect: (_from, to) => {
          tab.url = to;
          tab.domain = safeHostname(to);
          tab.actions.push(action('navigate', 'Followed redirect', to));
          this.emit(session);
        }
      });
      this.assertNotCancelled(session, controller);
      tab.url = fetched.url;
      tab.domain = safeHostname(fetched.url);
      tab.status = 'reading';
      tab.progress = 0.4;
      tab.actions.push(action('read', 'Fetched the page', `${Math.max(1, Math.round(fetched.bytes / 1024)).toLocaleString()} KB of HTML${fetched.truncated ? ' (truncated)' : ''}`));
      this.emit(session);

      const extracted = extractPage(fetched.html, fetched.url);
      tab.title = extracted.title || result.title;
      if (!extracted.title) extracted.title = new URL(fetched.url).hostname;
      extracted.text = compactText(extracted.text, session.depth === 'deep' ? 22_000 : 14_000);
      tab.evidenceCount = Math.max(1, extracted.headings.length + Math.min(4, extracted.links.length));
      tab.readableChars = extracted.text.length;
      tab.discoveredLinks = extracted.links;
      tab.actions.push(action('scan', 'Extracted readable page text', `${extracted.text.length.toLocaleString()} characters`));
      tab.status = 'summarizing';
      tab.progress = 0.76;
      session.metrics.pagesRead += 1;
      this.emit(session);

      // Sources are read as text, with no renderer behind them, so there is no
      // screenshot to hand the model; the note comes from the page text alone.
      const note = await summarizeSource(session.query, extracted, result, tab.id);
      session.sources.push(note);
      // In memory at once, on disk a moment later: the run never waits for the write.
      void putCachedSource(session.queryFingerprint, result.url, note).catch(() => undefined);
      tab.summary = note.summary;
      tab.evidenceCount = Math.max(tab.evidenceCount, note.keyFacts.length + note.quotes.length);
      tab.credibility = note.credibility;
      tab.status = 'complete';
      tab.progress = 1;
      tab.actions.push(action('summarize', 'Created source note', note.summary));
      this.emit(session);
    } catch (error) {
      if (error instanceof NotHtmlError && !controller.signal.aborted) {
        // A PDF, feed or download is not a failed run, just not something this reader
        // handles: the tab says so and the session carries on without that source.
        tab.status = 'complete';
        tab.progress = 1;
        tab.summary = `Skipped: ${error.message}.`;
        tab.actions.push(action('read', 'Skipped a source that is not a web page', error.contentType || undefined));
        this.emit(session);
        return;
      }
      if (controller.signal.aborted) {
        tab.status = 'error';
        tab.error = 'Cancelled before this tab finished.';
      } else {
        tab.status = 'error';
        tab.error = error instanceof Error ? error.message : String(error);
      }
      tab.actions.push(action('error', 'Tab agent stopped', tab.error));
      this.emit(session);
    }
  }
  private async runDemo(session: ResearchSessionState, controller: AbortController) {
    const steps = [
      { title: 'Cerebras inference docs', url: 'https://inference-docs.cerebras.ai', summary: 'Documents low-latency chat completions and multimodal image inputs for Gemma workflows.' },
      { title: 'Mozilla Readability', url: 'https://github.com/mozilla/readability', summary: 'Readability pulls the main article out of a fetched page, so each Toji source agent reads a page without rendering it.' },
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
    finalizeMetrics(session);
    this.emit(session);
  }

}

export const researchOrchestrator = new ResearchOrchestrator();
