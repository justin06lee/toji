// The contract between the shell (React, in the browser window's shadow root) and the
// browser (TojiShell.sys.mjs, chrome JS in the same window). The browser puts this
// object on the window as `tojiShell` before it loads the shell, beside `toji`, the
// same window.toji bridge Toji's pages use (settings, containers, Tor, the vault's
// prompt answers, bug reports).
//
// Firefox keeps the tabs — gBrowser owns them, their pages, history and session — and
// the shell draws them. Everything here is plain data or a callback; nothing reaches
// the shell that a page could not also be shown.

import type { Bookmark } from '../src/lib/api';
import type { BridgeContainer, VaultEntry, VaultPrompt } from '../src/lib/bridge';
import type { AgentLogEntry } from '../src/components/AgentSpotlight';

/** One of gBrowser's tabs, as the shell sees it. */
export interface ShellTabInfo {
  id: string;
  /** The page's address (the one that failed, on an error page). */
  url: string;
  /** The page's own title; empty when it has none. */
  title: string;
  /** The favicon's URL; empty when there is none. */
  favicon: string;
  /** A document is loading. */
  busy: boolean;
  audible: boolean;
  muted: boolean;
  canBack: boolean;
  canForward: boolean;
  /** The error page Firefox loaded in place of the page (about:neterror?e=…), if any. */
  errorPage: string | null;
  /** The tab's content process went away. */
  crashed: boolean;
}

export interface ShellState {
  /** The window's container (profile); null while it asks "Who's browsing?". */
  containerId: string | null;
  tabs: ShellTabInfo[];
  selectedId: string | null;
}

export interface ShellAgentState {
  running: boolean;
  log: AgentLogEntry[];
  /** The question the agent is paused on. */
  ask: string | null;
  files: { index: number; name: string }[];
}

export interface ShellAgentLimits {
  maxSteps: number;
  noLimit: boolean;
}

/** Where the agent's pointer is, in window coordinates, and whether it just pressed. */
export interface ShellAgentPointer {
  x: number;
  y: number;
  pressed: boolean;
}

/** Help › Report a Bug…: the still and the clip, taken before the sheet was drawn. */
export interface ShellReportRequest {
  screenshot: { type: string; data: Uint8Array } | null;
  clip: Promise<{ type: string; data: Uint8Array; seconds: number; width: number; height: number; poster: { type: string; data: Uint8Array } | null } | null> | null;
  unavailable: 'off' | 'private' | 'unsupported' | null;
  pageUrl: string | null;
  context: { window: string; layout: string; theme: string };
}

/** A report being finished on GitHub's own form, in one of this window's tabs. */
export interface ShellReportTray {
  reportId: string;
  tabId: string;
  url: string;
  files: string[];
  bodyOnClipboard: boolean;
  status: 'waiting' | 'attaching' | 'attached' | 'failed' | 'filed';
  /** The tab is showing GitHub's issue form (not a sign-in page). */
  onForm: boolean;
  number?: number;
  error?: string;
}

/** What the shell's own look follows; read at once, so a new window never flashes the wrong one. */
export interface ShellPrefs {
  theme: 'light' | 'dark';
  layout: 'top' | 'side';
  bookmarksBar: 'pinned' | 'hover';
  sidebarOpen: boolean;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Off = () => void;

export interface ShellHost {
  platform: string;

  // --- Tabs: gBrowser's, drawn by the shell ---------------------------------
  state(): ShellState;
  onState(listener: (state: ShellState) => void): Off;
  select(tabId: string): void;
  close(tabId: string): void;
  /**
   * A new tab (the start page) at the end of the strip, selected; returns its id. The
   * omnibox takes the keys once Firefox has switched to it, unless `focusOmnibox` is false.
   */
  newTab(options?: { focusOmnibox?: boolean }): string;
  /** Put the tabs in this order (ids missing from it keep their places after). */
  reorder(tabIds: string[]): void;
  duplicate(tabId: string): void;
  closeOthers(tabId: string): void;
  /** Load an address in a tab. */
  load(tabId: string, url: string): void;
  /** Search the default engine for text, in a tab; returns the search's address. */
  search(tabId: string, text: string): string;
  /** An AI answer page for a question, in a tab; `fresh` skips the cache. */
  ask(tabId: string, query: string, fresh?: boolean): void;
  back(): void;
  forward(): void;
  reload(tabId: string): void;
  toggleMute(tabId: string): void;
  /** Settings, Welcome or Plans: the tab already showing it, or a new one. */
  openPage(page: 'settings' | 'welcome' | 'plans'): void;
  /** A web address in a new tab beside the current one. */
  openTab(url: string, options?: { background?: boolean }): void;
  /** Hand the keyboard to the page in front. */
  focusContent(): void;

  // --- The window -------------------------------------------------------------
  /** Where the pages go: the viewport's box in the window, in CSS pixels. */
  setViewport(rect: ViewportRect): void;
  /** Where Firefox's own prompts (permissions, add-on installs) hang from. */
  setPromptAnchor(rect: ViewportRect): void;
  /** Firefox asks for the address bar (⌘L, a new tab); `select` selects its text. */
  onFocusOmnibox(listener: (select: boolean) => void): Off;
  /** The picker's choice for this window. */
  chooseContainer(containerId: string): Promise<void>;
  /** Hold-to-Tor: move this window to Tor, or back. */
  toggleTor(): void;
  prefs(): ShellPrefs;
  onPrefs(listener: (prefs: ShellPrefs) => void): Off;
  setPref<K extends keyof ShellPrefs>(key: K, value: ShellPrefs[K]): void;
  /** Toji's containers (profiles), for the picker and the window's own. */
  containers(): BridgeContainer[];
  onContainers(listener: (containers: BridgeContainer[]) => void): Off;
  /** The pointer is over the top edge of the page in front (for the bookmarks bar). */
  onPageTopEdge(listener: (inside: boolean) => void): Off;

  // --- Bookmarks (Firefox's, on the bookmarks toolbar) -------------------------
  bookmarks(): Promise<Bookmark[]>;
  onBookmarksChanged(listener: () => void): Off;
  /** Bookmark the page, or remove it if it already is one. */
  toggleBookmark(url: string, title: string): Promise<void>;
  removeBookmark(id: string): Promise<void>;

  // --- Vault ------------------------------------------------------------------
  /** Saved logins that may be filled into a tab's page (metadata only). */
  onVaultMatches(listener: (tabId: string, matches: VaultEntry[]) => void): Off;
  /** A submitted login waiting on the user, or null once decided. */
  onVaultPrompt(listener: (prompt: VaultPrompt | null, error?: string) => void): Off;
  vaultFill(tabId: string, entryId: string): void;

  // --- The web agent ------------------------------------------------------------
  agentState(tabId: string): ShellAgentState;
  onAgent(listener: (tabId: string) => void): Off;
  onAgentPointer(listener: (pointer: ShellAgentPointer | null) => void): Off;
  /** A tap of Option (open or close), or a new AI tab (open on it). */
  onSpotlight(listener: (tabId: string | null | 'toggle') => void): Off;
  /** What was typed into the spotlight: an answer if the agent asked, else a new run. */
  agentSubmit(tabId: string, text: string): 'answered' | 'started' | 'busy';
  agentStop(tabId: string): void;
  agentAddFiles(tabId: string, files: File[]): Promise<void>;
  agentRemoveFile(tabId: string, index: number): void;
  agentLimits(): ShellAgentLimits;
  setAgentLimits(limits: ShellAgentLimits): void;

  // --- Bug reports ----------------------------------------------------------------
  onReportBug(listener: (request: ShellReportRequest) => void): Off;
  /** The report sheet closed (it pauses the recording while open). */
  reportClosed(): void;
  onReportTray(listener: (tray: ShellReportTray | null) => void): Off;
  retryReportTray(reportId: string): void;
  dismissReportTray(reportId: string): void;
}

export function shellHost(): ShellHost {
  const host = (window as unknown as { tojiShell?: ShellHost }).tojiShell;
  if (!host) throw new Error('The shell runs only in the browser window (window.tojiShell is missing).');
  return host;
}
