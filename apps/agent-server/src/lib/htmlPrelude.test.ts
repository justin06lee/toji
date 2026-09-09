import { describe, expect, test } from 'vitest';
import { createPreludeInjector, injectPrelude } from './htmlPrelude.js';

const PRELUDE = '<style>:root{--bg:#fff}</style>';

/** Feed a document through the injector in fixed-size pieces, as a stream would. */
function streamed(input: string, size: number): string {
  const injector = createPreludeInjector(PRELUDE);
  let out = '';
  for (let i = 0; i < input.length; i += size) out += injector.push(input.slice(i, i + size));
  return out + injector.end();
}

const DOC = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Hi</title></head>\n<body><h1>Hi</h1></body>\n</html>';

describe('injectPrelude', () => {
  test('goes right after the doctype, so the page stays in standards mode', () => {
    expect(injectPrelude(DOC, PRELUDE)).toBe('<!DOCTYPE html>' + PRELUDE + DOC.slice('<!DOCTYPE html>'.length));
  });

  test('goes first when there is no doctype', () => {
    expect(injectPrelude('<html><body>x</body></html>', PRELUDE)).toBe(PRELUDE + '<html><body>x</body></html>');
    expect(injectPrelude('<h1>bare</h1>', PRELUDE)).toBe(PRELUDE + '<h1>bare</h1>');
  });

  test('is case-insensitive about the doctype and keeps leading whitespace', () => {
    expect(injectPrelude('\n<!doctype html><p>x</p>', PRELUDE)).toBe('\n<!doctype html>' + PRELUDE + '<p>x</p>');
  });

  test('an empty document gets nothing at all', () => {
    expect(injectPrelude('', PRELUDE)).toBe('');
  });
});

describe('streaming', () => {
  test('lands in the same place whatever the chunking', () => {
    const whole = injectPrelude(DOC, PRELUDE);
    for (const size of [1, 2, 3, 5, 8, 13, 40, 1000]) expect(streamed(DOC, size)).toBe(whole);
  });

  test('waits for a doctype that is still arriving rather than guessing', () => {
    const injector = createPreludeInjector(PRELUDE);
    expect(injector.push('<!DOC')).toBe('');
    expect(injector.push('TYPE ht')).toBe('');
    expect(injector.push('ml><p>')).toBe('<!DOCTYPE html>' + PRELUDE + '<p>');
    expect(injector.push('x</p>')).toBe('x</p>');
    expect(injector.end()).toBe('');
  });

  test('gives up on a "doctype" that never closes', () => {
    const injector = createPreludeInjector(PRELUDE);
    const junk = '<!doctype ' + 'x'.repeat(200);
    expect(injector.push(junk)).toBe(PRELUDE + junk);
  });
});
