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

const { streamAnswerPage } = await import('./pageAgent.js');

async function render(): Promise<string> {
  let out = '';
  for await (const chunk of streamAnswerPage('dubai work visa', 'light')) out += chunk;
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
    expect(await render()).toBe('<!DOCTYPE html><h1>Dubai</h1></html>');
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
    expect(html).toBe('<!DOCTYPE html><h1>Dubai</h1>');
    expect(html).not.toContain('could not generate');
  });

  test('the reason is escaped, so an error body cannot inject markup into the page', async () => {
    state.error = 'bad <script>alert(1)</script>';
    const html = await render();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
