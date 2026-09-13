import { describe, expect, test } from 'vitest';
import { describeLoadError, geckoLoadFailure, hostOfUrl } from './loadError';

const failure = (code: number, url = 'http://localhost:7333/', description = 'ERR_X') => ({ code, description, url });

describe('describeLoadError', () => {
  test('names the site in the common failures', () => {
    expect(describeLoadError(failure(-102))).toMatchObject({ kind: 'refused', title: 'localhost:7333 refused the connection', retry: true });
    expect(describeLoadError(failure(-105, 'https://nope.example/'))).toMatchObject({ kind: 'notfound', title: 'There is no site at nope.example' });
    expect(describeLoadError(failure(-7))).toMatchObject({ kind: 'timeout' });
    expect(describeLoadError(failure(-106))).toMatchObject({ kind: 'offline', title: 'You are offline' });
  });

  test('does not offer a retry for a certificate or address problem', () => {
    expect(describeLoadError(failure(-201, 'https://expired.example/'))).toMatchObject({ kind: 'insecure', retry: false });
    expect(describeLoadError(failure(-501))).toMatchObject({ kind: 'insecure' });
    expect(describeLoadError(failure(-300, 'nonsense'))).toMatchObject({ kind: 'address', retry: false });
  });

  test('explains a Tor container only where Tor could be the reason', () => {
    expect(describeLoadError(failure(-102), { tor: true }).detail).toContain('Tor');
    expect(describeLoadError(failure(-20), { tor: true }).detail).toContain('Tor');
    expect(describeLoadError(failure(-201), { tor: true }).detail).not.toContain('Tor');
    expect(describeLoadError(failure(-102), { tor: false }).detail).not.toContain('Tor');
  });

  test('falls back to a generic sentence for anything unmapped', () => {
    expect(describeLoadError(failure(-999, 'https://a.test/'))).toMatchObject({ kind: 'generic', title: 'This page cannot be shown', detail: 'a.test could not be loaded.' });
  });
});

describe('hostOfUrl', () => {
  test('keeps the port and survives junk', () => {
    expect(hostOfUrl('http://localhost:7333/x')).toBe('localhost:7333');
    expect(hostOfUrl('not a url')).toBe('not a url');
  });
});

describe('geckoLoadFailure', () => {
  test("reads the error from Firefox's error page address", () => {
    expect(geckoLoadFailure('about:neterror?e=dnsNotFound&u=https%3A//nope.invalid/&c=UTF-8', 'https://nope.invalid/')).toEqual({ code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://nope.invalid/' });
    expect(describeLoadError(geckoLoadFailure('about:neterror?e=connectionFailure', 'http://127.0.0.1:1/')!).kind).toBe('refused');
    expect(describeLoadError(geckoLoadFailure('about:certerror?e=nssBadCert', 'https://self-signed.test/')!).kind).toBe('insecure');
  });
  test('says Tor when a Tor container could not reach its proxy', () => {
    const copy = describeLoadError(geckoLoadFailure('about:neterror?e=proxyConnectFailure', 'https://example.com/')!, { tor: true });
    expect(copy.detail).toMatch(/Tor/);
  });
  test('covers blocked sites, crashes, unknown errors, and no error at all', () => {
    expect(geckoLoadFailure('about:blocked?e=malwareBlocked', 'https://bad.test/')?.code).toBe(-20);
    expect(geckoLoadFailure(null, 'https://a.test/', true)).toEqual({ code: 0, description: 'TAB_CRASHED', url: 'https://a.test/' });
    expect(geckoLoadFailure('about:neterror?e=somethingNew', 'https://a.test/')).toEqual({ code: 0, description: 'somethingNew', url: 'https://a.test/' });
    expect(geckoLoadFailure(null, 'https://a.test/')).toBeNull();
  });
});
