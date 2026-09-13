// What every one of Toji's pages in the Gecko browser shares: Poppins, the stylesheet,
// following the theme, and mounting into #root. Each page reaches the browser only
// through window.toji (see src/lib/bridge.ts), and every call is feature-detected, so a
// page opened in a plain browser still renders.

// Latin and Latin Extended subsets only, as in the Electron renderer (src/main.tsx).
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-ext-400.css';
import '@fontsource/poppins/latin-ext-500.css';
import '@fontsource/poppins/latin-ext-600.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import type { BrowserSettings } from '../src/lib/bridge';
import { hasBrowserSettings, isDarkTheme, watchBrowserSettings } from '../src/lib/browserSettings';
import '../src/styles.css';

/**
 * `.dark` on <html> when the browser's theme is dark, updated as it changes. Until the
 * browser answers — and always, without the bridge — the system's preference decides.
 */
function followTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let settings: BrowserSettings | null = null;
  const apply = () => document.documentElement.classList.toggle('dark', isDarkTheme(settings, media.matches));
  apply();
  media.addEventListener('change', apply);
  if (hasBrowserSettings()) {
    watchBrowserSettings((next) => {
      settings = next;
      apply();
    });
  }
}

export function mount(page: React.ReactNode) {
  followTheme();
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{page}</React.StrictMode>);
}
