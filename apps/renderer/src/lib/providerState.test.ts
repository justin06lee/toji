import { describe, expect, test } from 'vitest';
import { providerNote } from './providerState';

describe('providerNote', () => {
  test('a CLI that answered its probe needs no note', () => {
    expect(providerNote({ usable: true })).toBeNull();
    expect(providerNote({ usable: true, error: 'stale error from an earlier probe' })).toBeNull();
  });

  test('recognises every way a CLI says "log in first"', () => {
    for (const error of [
      'codex: not logged in. Run: codex login',
      'gemini: Login required',
      'claude: Please run /login',
      'goose: not signed in',
      'You are signed out of Codex',
      'authentication_error: invalid x-api-key',
      'Invalid API key',
      '401 Unauthorized',
      'credentials are expired',
      'token has expired',
      'no credentials found'
    ]) {
      expect(providerNote({ usable: false, error }), error).toBe('signed out');
    }
  });

  test('anything else is merely unavailable', () => {
    expect(providerNote({ usable: false, error: 'gemini: ACP connection closed' })).toBe('unavailable');
    expect(providerNote({ usable: false, error: 'spawn ENOENT' })).toBe('unavailable');
    expect(providerNote({ usable: false })).toBe('unavailable');
  });
});
