import { describe, expect, it } from 'vitest';
import {
  OFF_STATUS,
  buildTorrc,
  cookieHex,
  nextStatus,
  parseBootstrap,
  parseControlPortFile,
  parseReplies,
  parseSocksListener,
  socksCredentials,
  torBinaryCandidates
} from './tor';

describe('parseBootstrap', () => {
  it('reads progress and phase out of a notice line', () => {
    expect(parseBootstrap('Aug 19 12:00:00.000 [notice] Bootstrapped 0% (starting): Starting')).toEqual({ progress: 0, detail: 'Starting' });
    expect(parseBootstrap('[notice] Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors')).toEqual({
      progress: 45,
      detail: 'Asking for relay descriptors'
    });
    expect(parseBootstrap('[notice] Bootstrapped 100% (done): Done')).toEqual({ progress: 100, detail: 'Done' });
  });

  it('falls back to the phase tag, then to a percentage', () => {
    expect(parseBootstrap('Bootstrapped 10% (conn_done)')).toEqual({ progress: 10, detail: 'conn_done' });
    expect(parseBootstrap('Bootstrapped 5%')).toEqual({ progress: 5, detail: 'Bootstrapping 5%' });
  });

  it('ignores unrelated lines', () => {
    expect(parseBootstrap('[notice] Opening Socks listener on 127.0.0.1:9070')).toBeNull();
    expect(parseBootstrap('')).toBeNull();
  });
});

describe('buildTorrc', () => {
  const torrc = buildTorrc({ dataDir: '/Users/a/Library/Application Support/Toji/tor', controlPortFile: '/x/control.port', ownerPid: 42 });

  it('isolates circuits by SOCKS credentials on an auto-picked port', () => {
    expect(torrc).toMatch(/^SocksPort auto .*IsolateSOCKSAuth/m);
    expect(torrc).toContain('KeepAliveIsolateSOCKSAuth');
  });

  it('quotes paths with spaces', () => {
    expect(torrc).toContain('DataDirectory "/Users/a/Library/Application Support/Toji/tor"');
    expect(torrc).toContain('ControlPortWriteToFile "/x/control.port"');
  });

  it('has a cookie-authenticated control port and dies with its owner', () => {
    expect(torrc).toContain('ControlPort auto');
    expect(torrc).toContain('CookieAuthentication 1');
    expect(torrc).toContain('__OwningControllerProcess 42');
    expect(torrc).toContain('ClientOnly 1');
    expect(torrc).toContain('Log notice stdout');
  });

  it('omits the owner line without a pid', () => {
    expect(buildTorrc({ dataDir: '/d', controlPortFile: '/c' })).not.toContain('__OwningControllerProcess');
  });
});

describe('control protocol', () => {
  it('reads the port tor wrote', () => {
    expect(parseControlPortFile('PORT=127.0.0.1:9151\n')).toBe(9151);
    expect(parseControlPortFile('')).toBeNull();
  });

  it('splits complete replies and keeps partial ones', () => {
    const { replies, rest } = parseReplies('250 OK\r\n250-net/listeners/socks="127.0.0.1:9321"\r\n250 OK\r\n515 Auth');
    expect(replies).toEqual([
      { code: 250, lines: ['OK'] },
      { code: 250, lines: ['net/listeners/socks="127.0.0.1:9321"', 'OK'] }
    ]);
    expect(rest).toBe('515 Auth');
  });

  it('finishes a reply split across chunks', () => {
    const first = parseReplies('250-net/listeners/socks="127.0.0.1:9321"\r\n');
    expect(first.replies).toEqual([]);
    const second = parseReplies(first.rest + '250 OK\r\n');
    expect(second.replies[0].lines).toEqual(['net/listeners/socks="127.0.0.1:9321"', 'OK']);
  });

  it('reads data blocks (GETINFO circuit-status)', () => {
    const { replies, rest } = parseReplies(
      '250+circuit-status=\r\n7 BUILT $AAA~a,$BBB~b SOCKS_USERNAME="toji:onion"\r\n..dotted\r\n.\r\n250 OK\r\n'
    );
    expect(rest).toBe('');
    expect(replies).toEqual([
      { code: 250, lines: ['circuit-status=', '7 BUILT $AAA~a,$BBB~b SOCKS_USERNAME="toji:onion"', '.dotted', 'OK'] }
    ]);
  });

  it('waits for the end of a data block', () => {
    const first = parseReplies('250+circuit-status=\r\n7 BUILT $AAA~a\r\n');
    expect(first.replies).toEqual([]);
    const second = parseReplies(first.rest + '.\r\n250 OK\r\n');
    expect(second.replies[0].lines).toEqual(['circuit-status=', '7 BUILT $AAA~a', 'OK']);
  });

  it('reports failures by code', () => {
    expect(parseReplies('515 Authentication failed: Wrong length on authentication cookie.\r\n').replies[0].code).toBe(515);
  });

  it('finds the SOCKS listener', () => {
    expect(parseSocksListener({ code: 250, lines: ['net/listeners/socks="127.0.0.1:9321"', 'OK'] })).toBe(9321);
    expect(parseSocksListener({ code: 250, lines: ['net/listeners/socks=', 'OK'] })).toBeNull();
  });

  it('hex-encodes the cookie', () => {
    expect(cookieHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('socksCredentials', () => {
  it('differs per container and per generation, so circuits differ', () => {
    const a = socksCredentials('onion', 'n1');
    const b = socksCredentials('research', 'n1');
    const a2 = socksCredentials('onion', 'n1', 1);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(a2);
    expect(a.username).toBe(a2.username);
  });

  it('changes with every launch nonce', () => {
    expect(socksCredentials('onion', 'n1')).not.toEqual(socksCredentials('onion', 'n2'));
  });
});

describe('status', () => {
  it('derives ready and isolation from the state, not the caller', () => {
    const s = nextStatus(OFF_STATUS, { state: 'bootstrapping', progress: 99, ready: true, isolated: true });
    expect(s.ready).toBe(false);
    expect(s.isolated).toBe(false);
    const r = nextStatus(s, { state: 'ready', progress: 100 });
    expect(r.ready).toBe(true);
    expect(r.isolated).toBe(true);
  });
});

describe('torBinaryCandidates', () => {
  it('prefers the bundled binary, then the override', () => {
    expect(torBinaryCandidates({ bundled: '/app/tor', env: '/opt/tor' }).slice(0, 3)).toEqual(['/app/tor', '/opt/tor', '/opt/homebrew/bin/tor']);
    expect(torBinaryCandidates({})[0]).toBe('/opt/homebrew/bin/tor');
  });
});
