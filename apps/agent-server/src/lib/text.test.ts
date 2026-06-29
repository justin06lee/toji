import { describe, it, expect } from 'vitest';
import {
  normalizeWhitespace,
  decodeEntities,
  stripHtml,
  fingerprintQuery,
  hashString,
  compactText,
  firstSentences,
  hostname,
  normalizeUrl,
  clamp,
  keywordSet,
  overlapScore,
  safeHostname
} from './text.js';

describe('normalizeWhitespace', () => {
  it('collapses multiple spaces', () => {
    expect(normalizeWhitespace('hello   world')).toBe('hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  hello  ')).toBe('hello');
  });

  it('collapses tabs and newlines', () => {
    expect(normalizeWhitespace('hello\t\n  world')).toBe('hello world');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   ')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeWhitespace('')).toBe('');
  });
});

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('&amp;')).toBe('&');
    expect(decodeEntities('&lt;')).toBe('<');
    expect(decodeEntities('&gt;')).toBe('>');
    expect(decodeEntities('&quot;')).toBe('"');
    expect(decodeEntities('&apos;')).toBe("'");
    expect(decodeEntities('&nbsp;')).toBe(' ');
  });

  it('decodes decimal numeric references', () => {
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&#65;')).toBe('A');
  });

  it('decodes hex numeric references', () => {
    expect(decodeEntities('&#x27;')).toBe("'");
    expect(decodeEntities('&#x41;')).toBe('A');
  });

  it('resolves double-encoded entities', () => {
    expect(decodeEntities('&amp;apos;')).toBe("'");
    expect(decodeEntities('&amp;amp;')).toBe('&');
  });

  it('leaves unknown named entities unchanged', () => {
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('decodes typographic entities', () => {
    expect(decodeEntities('&rsquo;')).toBe('\u2019');
    expect(decodeEntities('&mdash;')).toBe('\u2014');
    expect(decodeEntities('&hellip;')).toBe('\u2026');
  });

  it('passes through plain text unchanged', () => {
    expect(decodeEntities('hello world')).toBe('hello world');
  });
});

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>hello</p>')).toBe('hello');
  });

  it('removes script elements', () => {
    expect(stripHtml('before<script>alert("x")</script>after')).toBe('before after');
  });

  it('removes style elements', () => {
    expect(stripHtml('before<style>.x{color:red}</style>after')).toBe('before after');
  });

  it('decodes entities in stripped text', () => {
    expect(stripHtml('<p>&amp; hello</p>')).toBe('& hello');
  });

  it('normalizes whitespace in result', () => {
    expect(stripHtml('<div>  hello  </div>  <div>  world  </div>')).toBe('hello world');
  });
});

describe('fingerprintQuery', () => {
  it('returns a 14-char hex string', () => {
    const fp = fingerprintQuery('hello world');
    expect(fp).toMatch(/^[0-9a-f]{14}$/);
  });

  it('produces same fingerprint for equivalent queries', () => {
    expect(fingerprintQuery('Hello World')).toBe(fingerprintQuery('hello   world'));
  });

  it('produces different fingerprints for different queries', () => {
    expect(fingerprintQuery('foo')).not.toBe(fingerprintQuery('bar'));
  });

  it('handles empty query', () => {
    const fp = fingerprintQuery('');
    expect(fp).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe('hashString', () => {
  it('returns a 24-char hex string', () => {
    const h = hashString('test');
    expect(h).toMatch(/^[0-9a-f]{24}$/);
  });

  it('produces deterministic output', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});

describe('compactText', () => {
  it('returns short text unchanged', () => {
    expect(compactText('short text', 100)).toBe('short text');
  });

  it('truncates long text with ellipsis marker', () => {
    const long = 'a'.repeat(20_000);
    const result = compactText(long, 12_000);
    expect(result.length).toBeLessThan(20_000);
    expect(result).toContain(' \u2026 ');
  });

  it('preserves head and tail portions', () => {
    const text = 'HEAD' + 'x'.repeat(500) + 'TAIL';
    const result = compactText(text, 100);
    expect(result.startsWith('HEAD')).toBe(true);
    expect(result.endsWith('TAIL')).toBe(true);
  });

  it('uses default maxChars of 12000', () => {
    const text = 'x'.repeat(11_000);
    expect(compactText(text)).toBe(text);
  });
});

describe('firstSentences', () => {
  it('extracts the first N sentences', () => {
    const text = 'First. Second. Third. Fourth.';
    expect(firstSentences(text, 2)).toBe('First. Second.');
  });

  it('handles text with fewer sentences than requested', () => {
    expect(firstSentences('Only one.', 3)).toBe('Only one.');
  });

  it('handles question marks and exclamation points', () => {
    expect(firstSentences('What? Yes! Done.', 2)).toBe('What? Yes!');
  });

  it('defaults to 3 sentences', () => {
    const text = 'One. Two. Three. Four. Five.';
    expect(firstSentences(text)).toBe('One. Two. Three.');
  });
});

describe('hostname', () => {
  it('extracts hostname from URL', () => {
    expect(hostname('https://www.example.com/path')).toBe('example.com');
  });

  it('strips www prefix', () => {
    expect(hostname('https://www.google.com')).toBe('google.com');
  });

  it('preserves non-www subdomains', () => {
    expect(hostname('https://docs.example.com')).toBe('docs.example.com');
  });

  it('returns input for invalid URLs', () => {
    expect(hostname('not a url')).toBe('not a url');
  });
});

describe('normalizeUrl', () => {
  it('strips hash fragments', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('removes tracking parameters', () => {
    const url = 'https://example.com/page?utm_source=test&key=value';
    const result = normalizeUrl(url);
    expect(result).toContain('key=value');
    expect(result).not.toContain('utm_source');
  });

  it('removes fbclid parameter', () => {
    const url = 'https://example.com/page?fbclid=abc123&real=1';
    const result = normalizeUrl(url);
    expect(result).not.toContain('fbclid');
    expect(result).toContain('real=1');
  });

  it('removes trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('handles invalid URLs gracefully', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('clamp', () => {
  it('clamps value within range', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it('returns min for NaN', () => {
    expect(clamp(NaN, 0, 1)).toBe(0);
  });

  it('uses default range of 0-1', () => {
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
  });

  it('works with custom ranges', () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe('keywordSet', () => {
  it('extracts lowercase keywords longer than 2 chars', () => {
    const result = keywordSet('Hello World Test');
    expect(result.has('hello')).toBe(true);
    expect(result.has('world')).toBe(true);
    expect(result.has('test')).toBe(true);
  });

  it('filters out short words', () => {
    const result = keywordSet('I am a big cat');
    expect(result.has('big')).toBe(true);
    expect(result.has('cat')).toBe(true);
    expect(result.has('am')).toBe(false);
    expect(result.has('a')).toBe(false);
  });

  it('deduplicates keywords', () => {
    const result = keywordSet('hello hello hello');
    expect(result.size).toBe(1);
  });

  it('limits to 80 keywords', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');
    const result = keywordSet(words);
    expect(result.size).toBeLessThanOrEqual(80);
  });

  it('returns empty set for empty input', () => {
    expect(keywordSet('').size).toBe(0);
  });
});

describe('overlapScore', () => {
  it('returns 1 for identical strings', () => {
    expect(overlapScore('hello world test', 'hello world test')).toBe(1);
  });

  it('returns 0 when either string is empty', () => {
    expect(overlapScore('', 'hello')).toBe(0);
    expect(overlapScore('hello', '')).toBe(0);
  });

  it('returns 0 for completely different strings', () => {
    expect(overlapScore('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns partial score for overlapping strings', () => {
    const score = overlapScore('hello world', 'hello earth');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('safeHostname', () => {
  it('delegates to hostname', () => {
    expect(safeHostname('https://www.example.com/path')).toBe('example.com');
  });

  it('handles invalid URLs', () => {
    expect(safeHostname('not a url')).toBe('not a url');
  });
});
