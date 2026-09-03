import { describe, expect, test } from 'vitest';
import { createHtmlFenceStripper, stripHtmlFence } from './htmlFence.js';

/** Feed a document through the stripper in fixed-size pieces, as a stream would. */
function streamed(input: string, size: number): string {
  const stripper = createHtmlFenceStripper();
  let out = '';
  for (let i = 0; i < input.length; i += size) out += stripper.push(input.slice(i, i + size));
  return out + stripper.end();
}

const DOC = '<!DOCTYPE html>\n<html lang="en">\n<body><h1>Hi</h1></body>\n</html>';

describe('stripHtmlFence', () => {
  test('removes the ```html wrapper a model adds around the page', () => {
    expect(stripHtmlFence('```html\n' + DOC + '\n```')).toBe(DOC);
  });

  test('removes a bare ``` wrapper, and a ~~~ one', () => {
    expect(stripHtmlFence('```\n' + DOC + '\n```')).toBe(DOC);
    expect(stripHtmlFence('~~~html\n' + DOC + '\n~~~')).toBe(DOC);
  });

  test('leaves an unfenced document exactly as it is', () => {
    expect(stripHtmlFence(DOC)).toBe(DOC);
  });

  test('handles an opening fence with no closing one (a truncated stream)', () => {
    expect(stripHtmlFence('```html\n' + DOC)).toBe(DOC);
  });

  test('leaves fences inside the page alone — they belong to its content', () => {
    const withCode = '<!DOCTYPE html>\n<pre><code>```bash\nls\n```</code></pre>\n</html>';
    expect(stripHtmlFence(withCode)).toBe(withCode);
  });

  test('only strips a trailing fence at the very end, past whitespace', () => {
    expect(stripHtmlFence('```html\n' + DOC + '\n```\n\n')).toBe(DOC);
  });

  test('tolerates leading whitespace before the fence', () => {
    expect(stripHtmlFence('\n  ```html\n' + DOC + '\n```')).toBe(DOC);
  });

  test('passes short non-HTML output through instead of swallowing it', () => {
    expect(stripHtmlFence('no')).toBe('no');
    expect(stripHtmlFence('')).toBe('');
  });
});

describe('createHtmlFenceStripper (streaming)', () => {
  const fenced = '```html\n' + DOC + '\n```';

  test('gives the same result at every chunk size, including one character at a time', () => {
    for (const size of [1, 2, 3, 4, 7, 16, 64, 1000]) {
      expect(streamed(fenced, size)).toBe(DOC);
      expect(streamed(DOC, size)).toBe(DOC);
    }
  });

  test('does not mistake a half-arrived fence for content', () => {
    const stripper = createHtmlFenceStripper();
    // "``" and "```ht" are prefixes of a fence marker, so nothing may be emitted yet.
    let out = stripper.push('``');
    expect(out).toBe('');
    out += stripper.push('`ht');
    expect(out).toBe('');
    out += stripper.push('ml\n<!DOCTYPE html>') + stripper.end();
    expect(out).toBe('<!DOCTYPE html>');
  });

  test('emits an unfenced document immediately rather than holding it back', () => {
    const stripper = createHtmlFenceStripper();
    // No fence, so nothing needs withholding: the first sizeable chunk flows straight out.
    expect(stripper.push('<!DOCTYPE html><body>')).toBe('<!DOCTYPE html><body>');
    expect(stripper.push('<h1>Hi</h1>')).toBe('<h1>Hi</h1>');
    expect(stripper.end()).toBe('');
  });

  test('withholds only a short tail while fenced, so the page still renders as it streams', () => {
    const stripper = createHtmlFenceStripper();
    const body = 'x'.repeat(500);
    const emitted = stripper.push('```html\n' + body);
    expect(emitted.length).toBe(body.length - 16);
    expect(emitted + stripper.end()).toBe(body);
  });
});
