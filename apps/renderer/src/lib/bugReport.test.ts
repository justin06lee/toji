import { describe, expect, test } from 'vitest';
import { draftProblem, formatBytes, imageProblem, issuePageState, MAX_IMAGE_BYTES, routeLine } from './bugReport';

describe('imageProblem', () => {
  test('takes the image types GitHub shows inline, up to its size limit', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(imageProblem({ name: 'a', type, size: 10 })).toBeNull();
    expect(imageProblem({ name: 'shot.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toMatch(/over 10 MB/);
    expect(imageProblem({ name: 'notes.pdf', type: 'application/pdf', size: 10 })).toMatch(/notes\.pdf isn't/);
    expect(imageProblem({ name: 'art.svg', type: 'image/svg+xml', size: 10 })).not.toBeNull();
  });
});

describe('formatBytes', () => {
  test('reads the way a person would say it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20_480)).toBe('20 KB');
    expect(formatBytes(4.25 * 1024 * 1024)).toBe('4.3 MB');
  });
});

describe('draftProblem', () => {
  test('a title always, a recording for a recording, words for a written report', () => {
    expect(draftProblem('recording', { title: ' ', description: '', hasRecording: true })).toMatch(/title/);
    expect(draftProblem('recording', { title: 'Tabs vanish', description: '', hasRecording: false })).toMatch(/no recording/);
    expect(draftProblem('recording', { title: 'Tabs vanish', description: '', hasRecording: true })).toBeNull();
    expect(draftProblem('written', { title: 'Tabs vanish', description: '  ', hasRecording: false })).toMatch(/Describe/);
    expect(draftProblem('written', { title: 'Tabs vanish', description: 'After a resize.', hasRecording: false })).toBeNull();
  });
});

describe('issuePageState', () => {
  const form = 'https://github.com/justin06lee/toji/issues/new?title=x&body=y&labels=bug';
  test('knows the form, with or without its query', () => {
    expect(issuePageState(form, form)).toEqual({ state: 'form' });
    expect(issuePageState('https://github.com/Justin06lee/Toji/issues/new/', form)).toEqual({ state: 'form' });
  });
  test('knows the issue the form created', () => {
    expect(issuePageState('https://github.com/justin06lee/toji/issues/412', form)).toEqual({ state: 'filed', number: 412 });
  });
  test('anything else is somewhere on the way', () => {
    expect(issuePageState('https://github.com/login?return_to=%2Fjustin06lee%2Ftoji%2Fissues%2Fnew', form)).toEqual({ state: 'elsewhere' });
    expect(issuePageState('https://github.com/someone/else/issues/3', form)).toEqual({ state: 'elsewhere' });
    expect(issuePageState('https://evil.test/justin06lee/toji/issues/new', form)).toEqual({ state: 'elsewhere' });
    expect(issuePageState(null, form)).toEqual({ state: 'elsewhere' });
  });
});

describe('routeLine', () => {
  test('says where the report goes before it goes', () => {
    expect(routeLine(null)).toMatch(/Checking/);
    expect(routeLine({ mode: 'direct', repo: 'justin06lee/toji', login: 'ada' })).toBe('Files to justin06lee/toji as @ada. Reports are public.');
    expect(routeLine({ mode: 'form', repo: 'justin06lee/toji', reason: 'no-login' })).toBe('It finishes on GitHub’s issue form, in a new tab. Reports are public.');
    expect(routeLine({ mode: 'form', repo: 'justin06lee/toji', login: 'ada', reason: 'no-access' })).toBe('@ada can’t file there directly, so it finishes on GitHub’s issue form, in a new tab. Reports are public.');
  });
});
