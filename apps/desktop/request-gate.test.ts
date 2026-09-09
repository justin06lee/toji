import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const gate = require('./request-gate.cjs') as typeof import('./request-gate.cjs');

const fakeSession = () => ({ webRequest: { onBeforeRequest: vi.fn() } });

/** Run the session's single listener against a URL and return what it told Electron. */
function ask(sess: ReturnType<typeof fakeSession>, url: string) {
  const listener = sess.webRequest.onBeforeRequest.mock.calls[0][1];
  const callback = vi.fn();
  listener({ url }, callback);
  return callback.mock.calls[0][0];
}

describe('request gate', () => {
  it('installs exactly one Electron listener however many checks join', () => {
    const sess = fakeSession();
    gate.addRequestCheck(sess, 'a', (_d, cb) => cb({}));
    gate.addRequestCheck(sess, 'b', (_d, cb) => cb({}));
    gate.addRequestCheck(sess, 'a', (_d, cb) => cb({}));
    expect(sess.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(sess.webRequest.onBeforeRequest.mock.calls[0][0]).toEqual({ urls: ['<all_urls>'] });
    expect(gate.requestGate(sess).checks.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('lets a request through only when every check does', () => {
    const sess = fakeSession();
    gate.addRequestCheck(sess, 'first', (_d, cb) => cb({ cancel: false }));
    gate.addRequestCheck(sess, 'second', (_d, cb) => cb({}));
    expect(ask(sess, 'https://example.com/')).toEqual({});
  });

  it('the first cancel is final and later checks are not consulted', () => {
    const sess = fakeSession();
    const later = vi.fn((_d: unknown, cb: (r?: { cancel?: boolean; redirectURL?: string }) => void) => cb({}));
    gate.addRequestCheck(sess, 'kill-switch', (_d, cb) => cb({ cancel: true }), 0);
    gate.addRequestCheck(sess, 'adblock', later, 10);
    expect(ask(sess, 'https://example.com/')).toEqual({ cancel: true });
    expect(later).not.toHaveBeenCalled();
  });

  it('runs checks by priority, not by the order they were added', () => {
    const sess = fakeSession();
    const order: string[] = [];
    gate.addRequestCheck(
      sess,
      'adblock',
      (_d, cb) => {
        order.push('adblock');
        cb({});
      },
      10
    );
    gate.addRequestCheck(
      sess,
      'kill-switch',
      (_d, cb) => {
        order.push('kill-switch');
        cb({});
      },
      0
    );
    ask(sess, 'https://example.com/');
    expect(order).toEqual(['kill-switch', 'adblock']);
  });

  it('passes a redirect through as the answer', () => {
    const sess = fakeSession();
    gate.addRequestCheck(sess, 'adblock', (_d, cb) => cb({ redirectURL: 'data:text/plain,' }));
    expect(ask(sess, 'https://ads.example/pixel.gif')).toEqual({ redirectURL: 'data:text/plain,' });
  });

  it('a check that throws counts as letting the request through', () => {
    const sess = fakeSession();
    gate.addRequestCheck(sess, 'broken', () => {
      throw new Error('boom');
    });
    expect(ask(sess, 'https://example.com/')).toEqual({});
  });

  it('a removed check is no longer asked', () => {
    const sess = fakeSession();
    gate.addRequestCheck(sess, 'adblock', (_d, cb) => cb({ cancel: true }));
    gate.removeRequestCheck(sess, 'adblock');
    expect(ask(sess, 'https://example.com/')).toEqual({});
  });
});
