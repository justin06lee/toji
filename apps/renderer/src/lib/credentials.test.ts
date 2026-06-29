import { describe, it, expect } from 'vitest';
import type { CredentialStore, CredentialSet } from './credentials.js';
import { activeSet, availableKeys, credentialDirectory, resolveSecrets } from './credentials.js';

function makeStore(sets: CredentialSet[], activeId: string | null = null): CredentialStore {
  return { activeId, sets };
}

const WORK_SET: CredentialSet = {
  id: 'work',
  name: 'Work',
  fields: [
    { key: 'email', value: 'me@work.com' },
    { key: 'password', value: 's3cret' }
  ]
};

const SCHOOL_SET: CredentialSet = {
  id: 'school',
  name: 'School',
  fields: [
    { key: 'username', value: 'student' },
    { key: 'password', value: 'p@ss' }
  ]
};

describe('activeSet', () => {
  it('returns the set matching activeId', () => {
    const store = makeStore([WORK_SET, SCHOOL_SET], 'school');
    expect(activeSet(store)?.id).toBe('school');
  });

  it('falls back to the first set when activeId is null', () => {
    const store = makeStore([WORK_SET, SCHOOL_SET], null);
    expect(activeSet(store)?.id).toBe('work');
  });

  it('falls back to the first set when activeId does not match', () => {
    const store = makeStore([WORK_SET, SCHOOL_SET], 'nonexistent');
    expect(activeSet(store)?.id).toBe('work');
  });

  it('returns undefined for empty store', () => {
    const store = makeStore([], null);
    expect(activeSet(store)).toBeUndefined();
  });
});

describe('availableKeys', () => {
  it('returns keys from the active set', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(availableKeys(store)).toEqual(['email', 'password']);
  });

  it('filters out blank keys', () => {
    const store = makeStore([{ id: '1', name: 'Test', fields: [{ key: '', value: 'v' }, { key: 'real', value: 'v' }] }], '1');
    expect(availableKeys(store)).toEqual(['real']);
  });

  it('returns empty array for empty store', () => {
    expect(availableKeys(makeStore([], null))).toEqual([]);
  });
});

describe('credentialDirectory', () => {
  it('lists sets with their keys and active status', () => {
    const store = makeStore([WORK_SET, SCHOOL_SET], 'work');
    const dir = credentialDirectory(store);
    expect(dir).toHaveLength(2);
    expect(dir[0]).toEqual({ name: 'Work', keys: ['email', 'password'], active: true });
    expect(dir[1]).toEqual({ name: 'School', keys: ['username', 'password'], active: false });
  });

  it('omits sets with no valid keys', () => {
    const emptyFieldsSet: CredentialSet = { id: 'e', name: 'Empty', fields: [{ key: '', value: 'v' }] };
    const store = makeStore([WORK_SET, emptyFieldsSet], 'work');
    const dir = credentialDirectory(store);
    expect(dir).toHaveLength(1);
    expect(dir[0].name).toBe('Work');
  });
});

describe('resolveSecrets', () => {
  it('replaces {{key}} with active set value', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('user: {{email}}', store)).toBe('user: me@work.com');
  });

  it('replaces {{setName:key}} with the named set value', () => {
    const store = makeStore([WORK_SET, SCHOOL_SET], 'work');
    expect(resolveSecrets('{{School:username}}', store)).toBe('student');
  });

  it('is case-insensitive for set names and keys', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('{{EMAIL}}', store)).toBe('me@work.com');
    expect(resolveSecrets('{{work:EMAIL}}', store)).toBe('me@work.com');
  });

  it('leaves unknown placeholders unchanged', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('{{unknown_key}}', store)).toBe('{{unknown_key}}');
  });

  it('handles text without placeholders', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('no placeholders here', store)).toBe('no placeholders here');
  });

  it('returns empty string for empty input', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('', store)).toBe('');
  });

  it('handles multiple placeholders in one string', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('{{email}} / {{password}}', store)).toBe('me@work.com / s3cret');
  });

  it('trims whitespace inside placeholders', () => {
    const store = makeStore([WORK_SET], 'work');
    expect(resolveSecrets('{{ email }}', store)).toBe('me@work.com');
  });
});
