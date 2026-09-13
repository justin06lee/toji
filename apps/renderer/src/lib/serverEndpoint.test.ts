import { describe, expect, it, vi } from 'vitest';
import type { AgentServerInfo } from './bridge';
import { authHeaders, createEndpointResolver, eventsUrl, withToken } from './serverEndpoint';

const FALLBACK = 'http://127.0.0.1:8788';

/** A fake bridge server() that answers from a script, one entry per call. */
function scripted(answers: (AgentServerInfo | null | Error)[]) {
  const server = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next instanceof Error) throw next;
    return next;
  });
  return server;
}

const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe('createEndpointResolver', () => {
  it('uses the fallback base with no token when there is no bridge', async () => {
    const resolver = createEndpointResolver(() => ({ fallbackBase: `${FALLBACK}/` }));
    await expect(resolver.get()).resolves.toEqual({ base: FALLBACK, token: null });
    expect(resolver.current()).toEqual({ base: FALLBACK, token: null });
  });

  it('takes the url and token from the bridge, without a trailing slash', async () => {
    const server = scripted([{ url: 'http://127.0.0.1:41234/', token: 'abc' }]);
    const resolver = createEndpointResolver(() => ({ server, fallbackBase: FALLBACK }));
    expect(resolver.current()).toBeNull();
    await expect(resolver.get()).resolves.toEqual({ base: 'http://127.0.0.1:41234', token: 'abc' });
    expect(resolver.current()).toEqual({ base: 'http://127.0.0.1:41234', token: 'abc' });
  });

  it('asks once for concurrent callers and caches the answer', async () => {
    const server = scripted([{ url: 'http://127.0.0.1:1', token: 't' }]);
    const resolver = createEndpointResolver(() => ({ server, fallbackBase: FALLBACK }));
    await Promise.all([resolver.get(), resolver.get(), resolver.get()]);
    await resolver.get();
    expect(server).toHaveBeenCalledTimes(1);
  });

  it('retries a server that is still starting, backing off between attempts', async () => {
    const server = scripted([null, new Error('not yet'), { url: 'http://127.0.0.1:2', token: '' }, { url: 'http://127.0.0.1:2', token: 'ok' }]);
    const { waits, sleep } = noSleep();
    const resolver = createEndpointResolver(() => ({ server, fallbackBase: FALLBACK }), { attempts: 5, delayMs: 100, sleep });
    await expect(resolver.get()).resolves.toEqual({ base: 'http://127.0.0.1:2', token: 'ok' });
    expect(server).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([100, 200, 400]);
  });

  it('gives up after the last attempt, and tries again on the next call', async () => {
    let calls = 0;
    // Down for the first three calls (one full round of attempts), up from the fourth.
    const server = vi.fn(async (): Promise<AgentServerInfo | null> => (++calls <= 3 ? null : { url: 'http://127.0.0.1:3', token: 'late' }));
    const { waits, sleep } = noSleep();
    const resolver = createEndpointResolver(() => ({ server, fallbackBase: FALLBACK }), { attempts: 3, delayMs: 50, sleep });
    await expect(resolver.get()).rejects.toThrow(/not running/);
    expect(waits).toEqual([50, 100]);
    expect(resolver.current()).toBeNull();
    await expect(resolver.get()).resolves.toEqual({ base: 'http://127.0.0.1:3', token: 'late' });
  });

  it('reads the bridge on first use, not when created', async () => {
    let bridgeServer: (() => Promise<AgentServerInfo | null>) | undefined;
    const resolver = createEndpointResolver(() => ({ server: bridgeServer, fallbackBase: FALLBACK }));
    bridgeServer = async () => ({ url: 'http://127.0.0.1:4', token: 'x' });
    await expect(resolver.get()).resolves.toEqual({ base: 'http://127.0.0.1:4', token: 'x' });
  });
});

describe('authHeaders', () => {
  it('adds a bearer token only when there is one', () => {
    expect(authHeaders(null)).toEqual({ 'content-type': 'application/json' });
    expect(authHeaders('s3cret')).toEqual({ 'content-type': 'application/json', authorization: 'Bearer s3cret' });
  });
});

describe('withToken', () => {
  it('leaves URLs alone when there is no token', () => {
    expect(withToken('http://h/api/page/stream?q=a', null)).toBe('http://h/api/page/stream?q=a');
  });

  it('appends to an existing query, or starts one, before any fragment', () => {
    expect(withToken('http://h/api/page/stream?q=a%20b', 't/1')).toBe('http://h/api/page/stream?q=a%20b&token=t%2F1');
    expect(withToken('http://h/api/export', 'tok')).toBe('http://h/api/export?token=tok');
    expect(withToken('http://h/x?y=1#top', 'tok')).toBe('http://h/x?y=1&token=tok#top');
  });
});

describe('eventsUrl', () => {
  it('points at /ws on the same host, over ws or wss, with the token', () => {
    expect(eventsUrl({ base: 'http://127.0.0.1:8788', token: null })).toBe('ws://127.0.0.1:8788/ws');
    expect(eventsUrl({ base: 'https://example.test', token: 'k' })).toBe('wss://example.test/ws?token=k');
  });
});
