import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTAINERS, parsePartition as parseInRenderer, partitionFor, tabSessionPartition } from '../renderer/src/lib/containers';

const require = createRequire(import.meta.url);
const policy = require('./policy.cjs') as typeof import('./policy.cjs');

// The renderer names partitions and the main process reads policy back out of those
// names. If the two parsers ever disagree, a container could be handed the wrong
// egress — so pin them against each other rather than testing either alone.
describe('parsePartition agrees across the IPC boundary', () => {
  const samples = [
    ...DEFAULT_CONTAINERS.map((c) => partitionFor(c)),
    ...DEFAULT_CONTAINERS.map((c) => partitionFor(c, 4)),
    ...DEFAULT_CONTAINERS.map((c) => tabSessionPartition(c, 9)),
    'persist:toji-c-my-side-project-tor',
    'persist:some-other-app',
    'toji-ctx-tab-1-0',
    'persist:toji-c-personal',
    ''
  ];

  for (const partition of samples) {
    it(`matches for ${partition || '(empty)'}`, () => {
      expect(policy.parsePartition(partition)).toEqual(parseInRenderer(partition));
    });
  }
});

const fakeSession = () => ({ setProxy: vi.fn().mockResolvedValue(undefined), webRequest: { onBeforeRequest: vi.fn() } });

describe('applySessionPolicy', () => {
  it('leaves direct containers unproxied and installs no kill switch', () => {
    const sess = fakeSession();
    const label = policy.applySessionPolicy(sess, 'persist:toji-c-personal-direct', { isReady: () => false, socksPortFor: () => 9060 });
    expect(label).toBe('direct:personal');
    expect(sess.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(sess.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  });

  it('routes tor containers through their own SOCKS port with DNS at the proxy', () => {
    const sess = fakeSession();
    const label = policy.applySessionPolicy(sess, 'toji-c-onion-tor', { isReady: () => true, socksPortFor: () => 9063 });
    expect(label).toBe('tor:onion@9063');
    expect(sess.setProxy).toHaveBeenCalledWith({ proxyRules: 'socks5://127.0.0.1:9063', proxyBypassRules: '<-loopback>' });
  });

  it('ignores sessions that are not Toji containers', () => {
    const sess = fakeSession();
    expect(policy.applySessionPolicy(sess, 'persist:something-else', null)).toBeNull();
    expect(sess.setProxy).not.toHaveBeenCalled();
  });
});

describe('kill switch', () => {
  const runFilter = (torReady: boolean, url: string) => {
    const sess = fakeSession();
    policy.applySessionPolicy(sess, 'toji-c-onion-tor', { isReady: () => torReady, socksPortFor: () => 9063 });
    const filter = sess.webRequest.onBeforeRequest.mock.calls[0][0];
    const callback = vi.fn();
    filter({ url }, callback);
    return callback.mock.calls[0][0];
  };

  it('cancels web traffic while Tor is not ready', () => {
    expect(runFilter(false, 'https://example.com/')).toEqual({ cancel: true });
    expect(runFilter(false, 'http://example.com/')).toEqual({ cancel: true });
    expect(runFilter(false, 'wss://example.com/socket')).toEqual({ cancel: true });
  });

  it('allows web traffic once Tor is ready', () => {
    expect(runFilter(true, 'https://example.com/')).toEqual({ cancel: false });
  });

  it('never blocks non-network schemes, so the shell keeps working', () => {
    expect(runFilter(false, 'about:blank')).toEqual({});
    expect(runFilter(false, 'data:text/html,hi')).toEqual({});
    expect(runFilter(false, 'devtools://devtools/bundled/inspector.html')).toEqual({});
  });

  it('installs only one listener per session', () => {
    const sess = fakeSession();
    const tor = { isReady: () => true, socksPortFor: () => 9063 };
    policy.applySessionPolicy(sess, 'toji-c-onion-tor', tor);
    policy.applySessionPolicy(sess, 'toji-c-onion-tor', tor);
    expect(sess.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('applyWebRtcPolicy', () => {
  it('disables non-proxied UDP for tor and hides local IPs for direct', () => {
    const tor = { setWebRTCIPHandlingPolicy: vi.fn() };
    policy.applyWebRtcPolicy(tor, 'toji-c-onion-tor');
    expect(tor.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');

    const direct = { setWebRTCIPHandlingPolicy: vi.fn() };
    policy.applyWebRtcPolicy(direct, 'persist:toji-c-personal-direct');
    expect(direct.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('default_public_interface_only');
  });

  it('leaves non-container sessions alone', () => {
    const other = { setWebRTCIPHandlingPolicy: vi.fn() };
    policy.applyWebRtcPolicy(other, 'persist:whatever');
    expect(other.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
  });
});
