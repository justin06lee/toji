import { useEffect, useRef } from 'react';
import { bridge } from '../lib/bridge';
import { SWIPE_NAV_JS } from '../lib/swipeNav';

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
export function WebView({ url, loading, partition, onNavigate, onTitle, onLoadingChange, onHistory, onFavicon, onGuestMessage, onRegister }: WebViewProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const registerRef = useRef(onRegister);
  registerRef.current = onRegister;

  useEffect(() => {
    registerRef.current?.(ref.current);
    return () => registerRef.current?.(null);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('allowpopups', 'true');
    const reportHistory = () => {
      try {
        onHistory?.(el.canGoBack(), el.canGoForward());
      } catch {
        // webview not ready yet
      }
    };
    const onStart = () => onLoadingChange(true);
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
      reportHistory();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onIpc = (e: any) => onGuestMessage?.(e?.channel, e?.args?.[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFailLoad = (e: any) => {
      // -3 = ERR_ABORTED (a navigation was superseded) — harmless, ignore.
      if (e?.errorCode === -3 || e?.isMainFrame === false) return;
      onLoadingChange(false);
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
  }, [onHistory, onLoadingChange, onNavigate, onTitle, onFavicon, onGuestMessage]);

  return (
    <div className="relative flex min-h-0 flex-1">
      {loading && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-[toji-load_1.1s_ease-in-out_infinite] bg-neutral-900/70 dark:bg-white/70" />
        </div>
      )}
      {/* backgroundThrottling=false keeps timers/JS running at full speed when this tab is
          backgrounded, so an agent can keep working on it after you switch tabs. */}
      {/* The guest preload is the page-side half of the password manager (see
          apps/desktop/guest-preload.cjs). Absent outside the Electron shell. */}
      <webview
        ref={ref}
        src={url}
        partition={partition}
        preload={bridge().guestPreload}
        webpreferences="backgroundThrottling=false"
        className="flex min-h-0 flex-1 bg-white dark:bg-neutral-950"
      />
    </div>
  );
}
