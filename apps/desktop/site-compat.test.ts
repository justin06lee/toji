import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { chromeUserAgent, popupPlacement } = require('./site-compat.cjs') as typeof import('./site-compat.cjs');

describe('chromeUserAgent', () => {
  const electron = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) toji-agent-browser/0.3.0 Chrome/142.0.0.0 Electron/42.5.1 Safari/537.36';
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

  it('drops the app and Electron tokens and keeps everything else', () => {
    expect(chromeUserAgent(electron)).toBe(chrome);
  });

  it('handles the product name Electron uses once the app has been named', () => {
    expect(chromeUserAgent(electron.replace('toji-agent-browser/0.3.0', 'Toji/0.3.0'))).toBe(chrome);
  });

  it('leaves a string that is already plain Chrome alone', () => {
    expect(chromeUserAgent(chrome)).toBe(chrome);
  });

  it('works for the other platforms Chromium writes', () => {
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Toji/0.3.0 Chrome/142.0.0.0 Electron/42.5.1 Safari/537.36';
    expect(chromeUserAgent(linux)).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');
  });
});

describe('popupPlacement', () => {
  it('opens sized window.open() popups as real windows, so window.opener survives', () => {
    expect(popupPlacement({ url: 'https://accounts.google.com/o/oauth2/auth', disposition: 'new-window' })).toBe('window');
  });

  it('opens an empty popup the page will navigate itself as a window', () => {
    expect(popupPlacement({ url: 'about:blank', disposition: 'foreground-tab' })).toBe('window');
    expect(popupPlacement({ url: '', disposition: 'new-window' })).toBe('window');
  });

  it('turns target=_blank links and ⌘-clicks into tabs', () => {
    expect(popupPlacement({ url: 'https://example.com/', disposition: 'foreground-tab' })).toBe('tab');
    expect(popupPlacement({ url: 'http://example.com/', disposition: 'background-tab' })).toBe('tab');
    expect(popupPlacement({ url: 'https://example.com/', disposition: 'default' })).toBe('tab');
  });

  it('hands mailto: to the system and refuses the rest', () => {
    expect(popupPlacement({ url: 'mailto:someone@example.com', disposition: 'new-window' })).toBe('mail');
    expect(popupPlacement({ url: 'javascript:alert(1)', disposition: 'new-window' })).toBe('deny');
    expect(popupPlacement({ url: 'file:///etc/passwd', disposition: 'new-window' })).toBe('deny');
    expect(popupPlacement({ url: 'not a url', disposition: 'new-window' })).toBe('deny');
  });
});
