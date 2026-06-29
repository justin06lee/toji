/// <reference types="vite/client" />

interface Window {
  toji?: {
    platform: string;
    versions: {
      chrome: string;
      electron: string;
    };
    quit?: () => void;
    onOpenUrl?: (callback: (url: string) => void) => () => void;
    onCloseTab?: (callback: () => void) => () => void;
    onNewTab?: (callback: () => void) => () => void;
  };
}

// Electron <webview> element used for real web pages inside Toji.
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: string;
        partition?: string;
        useragent?: string;
      };
    }
  }
}
