import { describe, it, expect } from 'vitest';
import { sessionToMarkdown, sessionToPortableJson } from './export.js';
import type { ResearchSessionState } from '../types.js';

function makeMinimalSession(overrides: Partial<ResearchSessionState> = {}): ResearchSessionState {
  return {
    id: 'test-session',
    mode: 'committed',
    query: 'What is TypeScript?',
    queryFingerprint: 'abc123',
    status: 'complete',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:01:00Z',
    options: { depth: 'standard', visualSnapshots: false, includeVisualAnalysis: false, freshness: 'auto' },
    plan: { goal: 'Research TypeScript', depth: 'standard', searchQueries: [], questions: [], sourceStrategy: [], riskControls: [], expectedOutput: [], steps: [] },
    tabs: [],
    sources: [],
    metrics: { tabsOpened: 0, pagesRead: 0, screenshotsCaptured: 0, cacheHits: 0, sourcesSummarized: 0, searchQueries: 0, searchResults: 0, startedAt: '2025-01-01T00:00:00Z' },
    depth: 'standard',
    ...overrides
  };
}

describe('sessionToMarkdown', () => {
  it('includes the query and status', () => {
    const md = sessionToMarkdown(makeMinimalSession());
    expect(md).toContain('**Query:** What is TypeScript?');
    expect(md).toContain('**Status:** complete');
  });

  it('includes the mode', () => {
    const md = sessionToMarkdown(makeMinimalSession({ mode: 'demo' }));
    expect(md).toContain('**Mode:** demo');
  });

  it('shows "No synthesis" when synthesis is undefined', () => {
    const md = sessionToMarkdown(makeMinimalSession());
    expect(md).toContain('No synthesis has been generated yet.');
  });

  it('includes synthesis summary when present', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      synthesis: {
        headline: 'TypeScript overview',
        summary: 'TypeScript is a typed superset of JavaScript.',
        sections: [],
        findings: [],
        citations: [],
        followUps: [],
        visualBlocks: [],
        overviewCards: [],
        sourceMap: [],
        markdown: ''
      }
    }));
    expect(md).toContain('TypeScript is a typed superset of JavaScript.');
  });

  it('renders visual blocks when present', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      synthesis: {
        headline: 'h', summary: 's',
        sections: [], findings: [], citations: [], followUps: [],
        visualBlocks: [{ title: 'Stars', value: '10k', caption: 'GitHub stars' }],
        overviewCards: [], sourceMap: [], markdown: ''
      }
    }));
    expect(md).toContain('**Stars:**');
    expect(md).toContain('10k');
  });

  it('renders findings with confidence', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      synthesis: {
        headline: 'h', summary: 's',
        sections: [],
        findings: [{ claim: 'TS is popular', evidenceUrl: 'https://example.com/ts', evidenceTitle: 'Survey', confidence: 'high' }],
        citations: [], followUps: [], visualBlocks: [], overviewCards: [], sourceMap: [], markdown: ''
      }
    }));
    expect(md).toContain('TS is popular');
    expect(md).toContain('high');
  });

  it('renders sections with source URLs', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      synthesis: {
        headline: 'h', summary: 's',
        sections: [{ title: 'Overview', body: 'TS overview body', sourceUrls: ['https://ts.dev'] }],
        findings: [], citations: [], followUps: [], visualBlocks: [], overviewCards: [], sourceMap: [], markdown: ''
      }
    }));
    expect(md).toContain('### Overview');
    expect(md).toContain('TS overview body');
    expect(md).toContain('https://ts.dev');
  });

  it('renders sources with key facts', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      sources: [{
        tabId: 't1', title: 'TS Docs', url: 'https://ts.dev', snippet: 'Official docs',
        summary: 'TypeScript documentation.', keyFacts: ['Typed superset'], quotes: [],
        credibility: 'strong', signals: [], capturedAt: '2025-01-01T00:00:00Z'
      }]
    }));
    expect(md).toContain('### TS Docs');
    expect(md).toContain('https://ts.dev');
    expect(md).toContain('Typed superset');
  });

  it('renders agent trace', () => {
    const md = sessionToMarkdown(makeMinimalSession({
      tabs: [{
        id: 'tab1', agentName: 'research', title: 'Tab 1', url: 'https://example.com',
        status: 'complete', progress: 1, evidenceCount: 2,
        actions: [{ at: '00:01', type: 'open', label: 'Opened page', detail: 'detail info' }]
      }]
    }));
    expect(md).toContain('### research: Tab 1');
    expect(md).toContain('Opened page');
    expect(md).toContain('detail info');
  });

  it('ends with a newline', () => {
    const md = sessionToMarkdown(makeMinimalSession());
    expect(md.endsWith('\n')).toBe(true);
  });

  it('does not produce triple newlines', () => {
    const md = sessionToMarkdown(makeMinimalSession());
    expect(md).not.toContain('\n\n\n');
  });
});

describe('sessionToPortableJson', () => {
  it('wraps session with exportedAt and app name', () => {
    const session = makeMinimalSession();
    const result = sessionToPortableJson(session);
    expect(result.app).toBe('Toji');
    expect(result.session).toBe(session);
    expect(result.exportedAt).toBeTruthy();
  });

  it('uses ISO timestamp for exportedAt', () => {
    const result = sessionToPortableJson(makeMinimalSession());
    expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
  });
});
