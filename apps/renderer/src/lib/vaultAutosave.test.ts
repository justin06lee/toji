import { describe, expect, test } from 'vitest';
import { AUTOSAVE_SETTLE_MS, autosaveEnabled, autosaveVerdict, setAutosaveEnabled } from './vaultAutosave';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  };
}

describe('autosave preference', () => {
  test('is on by default and off only when switched off', () => {
    const store = memoryStore();
    expect(autosaveEnabled(store)).toBe(true);
    setAutosaveEnabled(false, store);
    expect(autosaveEnabled(store)).toBe(false);
    setAutosaveEnabled(true, store);
    expect(autosaveEnabled(store)).toBe(true);
  });
});

describe('autosaveVerdict', () => {
  const submitted = 'https://site.test/login';

  test('saves once the page moved on to somewhere without a password field', () => {
    expect(autosaveVerdict({ hasLogin: false, url: 'https://site.test/home' }, { submittedUrl: submitted, elapsedMs: 800 })).toBe('save');
    expect(autosaveVerdict({ hasLogin: false, url: submitted }, { submittedUrl: submitted, elapsedMs: 200 })).toBe('save');
  });

  test('saves when a site signs in without ever navigating', () => {
    expect(autosaveVerdict('timeout', { submittedUrl: submitted, elapsedMs: 6000 })).toBe('save');
  });

  test('ignores the form reacting to its own submit, then asks if the form is still there', () => {
    expect(autosaveVerdict({ hasLogin: true, url: submitted }, { submittedUrl: submitted, elapsedMs: 50 })).toBe('wait');
    expect(autosaveVerdict({ hasLogin: true, url: submitted }, { submittedUrl: submitted, elapsedMs: AUTOSAVE_SETTLE_MS + 1 })).toBe('ask');
  });

  test('asks at once when a different page still wants a password', () => {
    // A redirect straight back to the login page is how most sites say "wrong password".
    expect(autosaveVerdict({ hasLogin: true, url: 'https://site.test/login?error=1' }, { submittedUrl: submitted, elapsedMs: 50 })).toBe('ask');
  });

  test('never drops a login on its own', () => {
    const verdicts = new Set<string>();
    for (const hasLogin of [true, false]) for (const elapsedMs of [0, 500, 1500, 9000]) verdicts.add(autosaveVerdict({ hasLogin }, { submittedUrl: null, elapsedMs }));
    verdicts.add(autosaveVerdict('timeout', { submittedUrl: null, elapsedMs: 0 }));
    expect([...verdicts].every((v) => v === 'save' || v === 'ask' || v === 'wait')).toBe(true);
  });
});
