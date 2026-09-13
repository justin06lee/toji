import { beforeEach, describe, expect, test, vi } from 'vitest';

// The model layer is the only thing streamAnswerPage talks to, so it is the seam:
// each test decides what the backend is and what it does, and asserts which page the
// user ends up looking at.
const state = {
  available: true,
  label: 'Cerebras · gpt-oss-120b',
  chunks: [] as string[],
  error: null as string | null
};

vi.mock('./model.js', () => ({
  agentAvailable: () => state.available,
  liveModelName: () => state.label,
  // eslint-disable-next-line require-yield
  streamText: async function* () {
    for (const chunk of state.chunks) yield chunk;
    if (state.error) throw new Error(state.error);
  }
}));

const { streamAnswerPage, THEME_PRELUDE } = await import('./pageAgent.js');

async function render(): Promise<string> {
  let out = '';
  for await (const chunk of streamAnswerPage('dubai work visa')) out += chunk;
  return out;
}

beforeEach(() => {
  state.available = true;
  state.label = 'Cerebras · gpt-oss-120b';
  state.chunks = [];
  state.error = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('streamAnswerPage', () => {
  test('passes the model page through, minus the code fence it wrapped it in', async () => {
    state.chunks = ['```html\n<!DOCTYPE html><h1>Dubai</h1>', '</html>\n```'];
    expect(await render()).toBe(`<!DOCTYPE html>${THEME_PRELUDE}<h1>Dubai</h1></html>`);
  });

  test('every page carries the theme prelude, so a theme switch restyles it in place', async () => {
    state.chunks = ['<html><body><h1>No doctype</h1></body></html>'];
    expect(await render()).toBe(`${THEME_PRELUDE}<html><body><h1>No doctype</h1></body></html>`);
    expect(THEME_PRELUDE).toContain('prefers-color-scheme:dark');
    expect(THEME_PRELUDE).toContain('--bg:');
  });

  test('a failing backend explains itself instead of claiming none is configured', async () => {
    state.error = 'Cerebras: Payment required to access this resource.';
    const html = await render();
    expect(html).toContain('Payment required to access this resource.');
    expect(html).toContain('Cerebras · gpt-oss-120b');
    expect(html).not.toContain('demo mode');
  });

  test('a backend that streams nothing counts as a failure, not an empty page', async () => {
    const html = await render();
    expect(html).toContain('could not generate');
    expect(html).not.toContain('demo mode');
  });

  test('no backend at all still gets the demo page', async () => {
    state.available = false;
    const html = await render();
    expect(html).toContain('demo mode');
    expect(html).not.toContain('could not generate');
  });

  test('an error after the page started streaming leaves the partial page alone', async () => {
    // Two documents glued together would be worse than a page that stops early.
    state.chunks = ['<!DOCTYPE html><h1>Dubai</h1>'];
    state.error = 'connection reset';
    const html = await render();
    expect(html).toBe(`<!DOCTYPE html>${THEME_PRELUDE}<h1>Dubai</h1>`);
    expect(html).not.toContain('could not generate');
  });

  test('the reason is escaped, so an error body cannot inject markup into the page', async () => {
    state.error = 'bad <script>alert(1)</script>';
    const html = await render();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// The outcome is what decides whether a page is cached, so every path must report it.
describe('streamAnswerPage outcome', () => {
  async function outcome() {
    const stream = streamAnswerPage('dubai work visa');
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
    }
  }

  test('a complete model page is the one "model" outcome, the only kind worth caching', async () => {
    state.chunks = ['<!DOCTYPE html><h1>Dubai</h1></html>'];
    expect(await outcome()).toBe('model');
  });

  test('a failing backend and an empty page both end as "error"', async () => {
    state.error = 'Cerebras: Payment required to access this resource.';
    expect(await outcome()).toBe('error');
    state.error = null;
    expect(await outcome()).toBe('error');
  });

  test('no backend at all ends as "demo"', async () => {
    state.available = false;
    expect(await outcome()).toBe('demo');
  });

  test('a page cut short by an error ends as "partial"', async () => {
    state.chunks = ['<!DOCTYPE html><h1>Dubai</h1>'];
    state.error = 'connection reset';
    expect(await outcome()).toBe('partial');
  });
});
