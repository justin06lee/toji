import { describe, it, expect } from 'vitest';
import { hostOf, isOnionUrl, looksLikeUrl, toUrl, webSearchUrl } from './nav.js';

describe('looksLikeUrl', () => {
  it('recognizes full URLs with scheme', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true);
    expect(looksLikeUrl('http://example.com/path')).toBe(true);
    expect(looksLikeUrl('ftp://files.example.com')).toBe(true);
  });

  it('recognizes bare domain-like inputs', () => {
    expect(looksLikeUrl('example.com')).toBe(true);
    expect(looksLikeUrl('docs.example.com')).toBe(true);
    expect(looksLikeUrl('example.com/path')).toBe(true);
  });

  it('recognizes localhost', () => {
    expect(looksLikeUrl('localhost')).toBe(true);
    expect(looksLikeUrl('localhost:3000')).toBe(true);
    expect(looksLikeUrl('localhost:8080/api')).toBe(true);
  });

  it('rejects plain search queries', () => {
    expect(looksLikeUrl('hello world')).toBe(false);
    expect(looksLikeUrl('what is javascript')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikeUrl('')).toBe(false);
  });

  it('handles domain with port', () => {
    expect(looksLikeUrl('example.com:8080')).toBe(true);
  });
});

describe('toUrl', () => {
  it('returns URLs with scheme unchanged', () => {
    expect(toUrl('https://example.com')).toBe('https://example.com');
    expect(toUrl('http://example.com')).toBe('http://example.com');
  });

  it('prepends https:// to bare domains', () => {
    expect(toUrl('example.com')).toBe('https://example.com');
    expect(toUrl('example.com/path')).toBe('https://example.com/path');
  });

  it('trims whitespace', () => {
    expect(toUrl('  example.com  ')).toBe('https://example.com');
  });
});

describe('webSearchUrl', () => {
  it('builds a DuckDuckGo search URL', () => {
    const url = webSearchUrl('test query');
    expect(url).toBe('https://duckduckgo.com/?q=test%20query');
  });

  it('encodes special characters', () => {
    const url = webSearchUrl('c++ programming');
    expect(url).toContain('c%2B%2B');
  });

  it('trims whitespace from query', () => {
    const url = webSearchUrl('  hello  ');
    expect(url).toBe('https://duckduckgo.com/?q=hello');
  });
});

describe('hostOf', () => {
  it('extracts hostname and strips www', () => {
    expect(hostOf('https://www.example.com/path')).toBe('example.com');
  });

  it('preserves non-www subdomains', () => {
    expect(hostOf('https://docs.example.com')).toBe('docs.example.com');
  });

  it('returns input for invalid URLs', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('isOnionUrl', () => {
  it('recognises hidden services with and without a scheme', () => {
    expect(isOnionUrl('http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/')).toBe(true);
    expect(isOnionUrl('duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion')).toBe(true);
    expect(isOnionUrl('example.onion/path?q=1')).toBe(true);
    expect(isOnionUrl('example.onion:8080')).toBe(true);
    expect(isOnionUrl('  EXAMPLE.ONION  ')).toBe(true);
  });

  it('does not fire on ordinary hosts or lookalikes', () => {
    expect(isOnionUrl('https://example.com/')).toBe(false);
    expect(isOnionUrl('onion.com')).toBe(false);
    expect(isOnionUrl('https://theonion.com/article')).toBe(false);
    expect(isOnionUrl('how to peel an onion')).toBe(false);
    expect(isOnionUrl('')).toBe(false);
  });

  it('treats an onion address as navigation, not a search', () => {
    expect(looksLikeUrl('duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion')).toBe(true);
  });
});
