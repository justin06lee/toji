import { useEffect, useRef, useState } from 'react';
import { bridge } from '../lib/bridge';
import type { LoadFailure } from '../lib/loadError';
import { SWIPE_NAV_JS } from '../lib/swipeNav';
import { LoadErrorPage } from './LoadErrorPage';

interface WebViewProps {
  url: string;
  loading: boolean;
  partition?: string;
  onNavigate: (url: string) => void;
  onTitle: (title: string) => void;
  onLoadingChange: (loading: boolean) => void;
  onHistory?: (canBack: boolean, canForward: boolean) => void;
  onFavicon?: (url: string | undefined) => void;
  /** Messages from the guest preload (login-form detection, submitted credentials). */
  onGuestMessage?: (channel: string, payload: unknown) => void;
  /** The tab browses through Tor, so a failed load may simply be Tor being down. */
  tor?: boolean;
  /** Silence the page's sound (the speaker on the tab). Survives reloads and navigation. */
  muted?: boolean;
  // Register the underlying <webview> element so the web agent can drive it
  // (executeJavaScript / capturePage) even while this tab is inactive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRegister?: (el: any | null) => void;
}

/**
 * Renders a real web page inside Toji using Electron's <webview>. Unlike an
 * iframe, a webview is a full browser view, so it isn't blocked by sites'
 * X-Frame-Options / frame-ancestors. Navigation and title changes flow back up so
 * the address bar and tab stay in sync; popups are routed into Toji by the main
 * process (web-contents-created → setWindowOpenHandler).
 */
export function WebView({ url, loading, partition, onNavigate, onTitle, onLoadingChange, onHistory, onFavicon, onGuestMessage, onRegister, tor, muted = false }: WebViewProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  // A main-frame load that failed. Chromium leaves the view blank; Toji draws its own
  // page over it (see LoadErrorPage) until the next navigation starts.
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [canBack, setCanBack] = useState(false);
  const registerRef = useRef(onRegister);
  registerRef.current = onRegister;
  // Applied once the guest exists (dom-ready) and again whenever it changes; before
  // attachment the call throws, so the value is kept here for the first dom-ready.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    registerRef.current?.(ref.current);
    return () => registerRef.current?.(null);
  }, []);

  useEffect(() => {
    try {
      ref.current?.setAudioMuted?.(muted);
    } catch {
      // Not attached yet — dom-ready below applies it.
    }
  }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reportHistory = () => {
      try {
        const back = el.canGoBack();
        setCanBack(back);
        onHistory?.(back, el.canGoForward());
      } catch {
        // webview not ready yet
      }
    };
    const onStart = () => {
      setFailure(null);
      onLoadingChange(true);
    };
    const onStop = () => {
      onLoadingChange(false);
      reportHistory();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNav = (e: any) => {
      if (e?.url) onNavigate(e.url);
      reportHistory();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onTitleUpdated = (e: any) => e?.title && onTitle(e.title);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFaviconUpdated = (e: any) => onFavicon?.(Array.isArray(e?.favicons) ? e.favicons[0] : undefined);
    const onDomReady = () => {
      try {
        el.executeJavaScript(SWIPE_NAV_JS);
      } catch {
        // ignore — re-injected on the next load
      }
      try {
        if (mutedRef.current) el.setAudioMuted(true);
      } catch {
        // the guest went away between events
      }
      reportHistory();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onIpc = (e: any) => onGuestMessage?.(e?.channel, e?.args?.[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFailLoad = (e: any) => {
      // -3 = ERR_ABORTED (a navigation was superseded) — harmless, ignore.
      if (e?.errorCode === -3 || e?.isMainFrame === false) return;
      setFailure({ code: Number(e?.errorCode) || 0, description: String(e?.errorDescription ?? ''), url: String(e?.validatedURL || url) });
      onLoadingChange(false);
      reportHistory();
    };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('page-title-updated', onTitleUpdated);
    el.addEventListener('page-favicon-updated', onFaviconUpdated);
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-fail-load', onFailLoad);
    el.addEventListener('ipc-message', onIpc);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('page-title-updated', onTitleUpdated);
      el.removeEventListener('page-favicon-updated', onFaviconUpdated);
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-fail-load', onFailLoad);
      el.removeEventListener('ipc-message', onIpc);
    };
  }, [onHistory, onLoadingChange, onNavigate, onTitle, onFavicon, onGuestMessage, url]);

  const retry = () => {
    const el = ref.current;
    if (!el || !failure) return;
    try {
      el.loadURL(failure.url);
    } catch {
      el.reload?.();
    }
  };
  const back = () => {
    try {
      ref.current?.goBack();
    } catch {
      // nothing to go back to
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      {failure && <LoadErrorPage failure={failure} tor={tor} canBack={canBack} onRetry={retry} onBack={back} />}
      {loading && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-[toji-load_1.1s_ease-in-out_infinite] bg-neutral-900/70 dark:bg-white/70" />
        </div>
      )}
      {/* backgroundThrottling=false keeps timers/JS running at full speed when this tab is
          backgrounded, so an agent can keep working on it after you switch tabs. */}
      {/* The guest preload is the page-side half of the password manager (see
          apps/desktop/guest-preload.cjs). Absent outside the Electron shell. */}
      {/* allowpopups must be there when the guest is created — set after the fact it is
          ignored, and a target=_blank link then does nothing. The main process also
          reasserts it (will-attach-webview) and turns each popup into a tab. React drops
          a boolean it does not know, so it goes in as the string Electron reads. */}
      <webview
        ref={ref}
        src={url}
        partition={partition}
        preload={bridge().guestPreload}
        {...({ allowpopups: 'true' } as Record<string, string>)}
        webpreferences="backgroundThrottling=false"
        className="flex min-h-0 flex-1 bg-white dark:bg-neutral-950"
      />
    </div>
  );
}
