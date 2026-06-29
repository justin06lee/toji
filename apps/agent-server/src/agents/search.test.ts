import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and isBraveSearchEnabled before importing the module
vi.mock('../config.js', () => ({
  config: {
    userAgent: 'TestAgent/1.0',
    braveSearchApiKey: '',
    searchProvider: 'duckduckgo'
  },
  isBraveSearchEnabled: false
}));

import { searchWeb } from './search.js';

describe('searchWeb', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns direct result for URL-like queries', async () => {
    const results = await searchWeb('https://example.com', 5);
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('example.com');
    expect(results[0].source).toBe('direct');
    expect(results[0].score).toBe(1);
  });

  it('returns direct result for bare domain queries', async () => {
    const results = await searchWeb('github.com/user/repo', 5);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('direct');
  });

  it('returns fallback results on search failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    const results = await searchWeb('test query', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('fallback');
  });

  it('limits direct results to the requested count', async () => {
    const results = await searchWeb('https://example.com', 1);
    expect(results).toHaveLength(1);
  });

  it('returns fallback results when search yields empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>', { status: 200 }));
    const results = await searchWeb('obscure query', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('fallback');
  });

  it('parses DuckDuckGo HTML response', async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>
        <div class="result__snippet">A snippet about the page.</div>
      </div>
    `;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(html, { status: 200 }));
    const results = await searchWeb('example query', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].url).toContain('example.com');
    expect(results[0].title).toBe('Example Page');
  });
});
