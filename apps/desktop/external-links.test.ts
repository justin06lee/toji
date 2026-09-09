import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ExternalLinkQueue, externalUrl, urlsFromArgv } from './external-links.cjs';

describe('externalUrl', () => {
  test('accepts web and file addresses and normalises them', () => {
    expect(externalUrl('https://example.com')).toBe('https://example.com/');
    expect(externalUrl('  http://localhost:7333/x?y=1 ')).toBe('http://localhost:7333/x?y=1');
    expect(externalUrl('file:///Users/me/page.html')).toBe('file:///Users/me/page.html');
  });

  test('turns an existing html file path into its file url', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toji-links-'));
    const file = path.join(dir, 'page.html');
    writeFileSync(file, '<p>hi</p>');
    expect(externalUrl(file)).toBe(pathToFileURL(file).href);
    expect(externalUrl(path.join(dir, 'missing.html'))).toBeNull();
    expect(externalUrl(path.join(dir, 'notes.txt'))).toBeNull();
  });

  test('refuses everything a browser must not open on request from another program', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'toji://settings', 'chrome://gpu', 'example.com', '', undefined, 42]) {
      expect(externalUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('urlsFromArgv', () => {
  test('finds the addresses among flags and program paths', () => {
    expect(urlsFromArgv(['/Applications/Toji.app/Contents/MacOS/Toji', '--user-data-dir=/tmp/x', 'https://a.test/', '-v', 'http://b.test/'])).toEqual([
      'https://a.test/',
      'http://b.test/'
    ]);
    expect(urlsFromArgv(['electron', 'apps/desktop/main.cjs'])).toEqual([]);
    expect(urlsFromArgv(undefined)).toEqual([]);
  });
});

describe('ExternalLinkQueue', () => {
  test('delivers at once when a window can take the link', () => {
    const queue = new ExternalLinkQueue();
    const delivered: string[] = [];
    expect(queue.push('https://a.test', (url) => (delivered.push(url), true))).toBe(true);
    expect(delivered).toEqual(['https://a.test/']);
    expect(queue.size).toBe(0);
  });

  test('holds links until asked for, in arrival order, then empties', () => {
    const queue = new ExternalLinkQueue();
    queue.push('https://a.test', () => false);
    queue.push('https://b.test');
    expect(queue.size).toBe(2);
    expect(queue.take()).toEqual(['https://a.test/', 'https://b.test/']);
    expect(queue.take()).toEqual([]);
  });

  test('never holds a refused address', () => {
    const queue = new ExternalLinkQueue();
    expect(queue.push('javascript:alert(1)')).toBe(false);
    expect(queue.size).toBe(0);
  });
});
