import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentSpotlight, type AgentLogEntry } from './components/AgentSpotlight';
import { WindowProfilePicker } from './components/WindowProfilePicker';
import { LandingSearch } from './components/LandingSearch';
import { TorStatusBar } from './components/TorStatusBar';
import { VaultFillButton, VaultPromptBar } from './components/VaultBar';
import { InternalPage } from './components/InternalPage';
import { BugReportSheet, type BugReportRequest, type FormReportResult } from './components/BugReportSheet';
import { BugReportTray, type FormReport } from './components/BugReportTray';
import { PageView } from './components/PageView';
import { Sidebar } from './components/Sidebar';
import { BOOKMARKS_BAR_EVENT, BookmarksBar, bookmarksBarPinned, setBookmarksBarPinned } from './components/BookmarksBar';
import { AddressRow } from './components/AddressRow';
import { AgentCursor } from './components/AgentCursor';
import { BrowserFrame } from './components/BrowserFrame';
import { TabContextMenu, type TabMenuAt } from './components/TabContextMenu';
import { TopTabStrip } from './components/TopTabStrip';
import { WindowDragHandle } from './components/WindowDragHandle';
import { WebView } from './components/WebView';
import { addBookmarks, addMemory, agentResearch, agentStep, deleteBookmark, fetchPageSources, getAgents, getBookmarks, getReferences, librarian, pageStreamUrl, uploadFile, type Bookmark } from './lib/api';
import { eyesAct, eyesAvailable, pageScreenshot, toPagePoint, PAGE_SIGNATURE_JS } from './lib/agentDom';
import {
  CONTAINERS_STORAGE_KEY,
  DEFAULT_CONTAINER_ID,
  findContainer,
  loadContainers,
  partitionFor,
  saveContainers,
  tabSessionPartition,
  type Container
} from './lib/containers';
import { hostOf, isOnionUrl, looksLikeUrl, toUrl, webSearchUrl, type SearchEngineId } from './lib/nav';
import { bridge, type OpenUrlOptions, type TorStatus, type VaultEntry, type VaultPrompt } from './lib/bridge';
import { useBookmarksPeek } from './lib/useBookmarksPeek';
import { insertTabAfter, replacePristineTabWithWelcome, startBrowsingInTab } from './lib/tabLifecycle';
import { tabTitle } from './lib/tabPresentation';
import type { BrowserTab, TabGroup } from './types';
import { AUTOSAVE_TIMEOUT_MS, autosaveEnabled, autosaveVerdict } from './lib/vaultAutosave';
import { REPLAY_EVENT, isReplayStorageKey, issuePageState, replayEnabled } from './lib/bugReport';
import { ReplayRecorder, type ReplayState } from './lib/replayRecorder';

interface AgentState {
  running: boolean;
  log: AgentLogEntry[];
  /** A question the agent is waiting on the user to answer (the run is paused). */
  ask?: string;
}
/** A file the user dropped onto a tab's agent: a stable index, display name, mime, and server path. */
interface AgentFile {
  index: number;
  name: string;
  mime: string;
  path: string;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_AGENT_MAX_STEPS = 40;

const isMac = (window as unknown as { toji?: { platform?: string } }).toji?.platform === 'darwin';
// Only macOS hides the native title bar (titleBarStyle: 'hiddenInset'), so only macOS
// needs a stand-in for it. On Linux and Windows the window is framed and the real title
// bar already drags, zooms on double-click, and shows the right cursor — putting our own
// notch there would duplicate it, and under Wayland it could not move the window anyway.
const hasCustomTitleBar = isMac;
// In Electron, Cmd+W / Cmd+T are owned by the app menu; the keydown fallback below is
// only for running the renderer in a plain browser during development.
const isElectron = Boolean((window as unknown as { toji?: unknown }).toji);
const STARTUP_CONTAINER_ID = new URLSearchParams(window.location.search).get('container');

/** A tab's icon: the site's favicon for web tabs (falling back to the Toji mark), else the Toji mark. */

// Alternates the side each cursor arc bows toward, so repeated moves don't look mechanical.
let bowSign = 1;
let counter = 0;
function makeTab(groupId: string | null = null, containerId: string = DEFAULT_CONTAINER_ID): BrowserTab {
  counter += 1;
  return { id: `tab-${Date.now()}-${counter}`, query: '', streamUrl: null, status: 'new', sources: [], groupId, mode: 'page', url: null, reloadKey: 0, contextKey: 0, containerId };
}

export function App() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [makeTab(null, STARTUP_CONTAINER_ID ?? DEFAULT_CONTAINER_ID)]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('toji-theme') === 'dark' ? 'dark' : 'light'));
  const [layout, setLayout] = useState<'top' | 'side'>(() => (localStorage.getItem('toji-layout') === 'side' ? 'side' : 'top'));
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('toji-sidebar') !== 'closed');
  const [sidebarPeek, setSidebarPeek] = useState(false);
  // The bookmarks bar: part of the chrome when pinned, a hover reveal under the address
  // bar when not. The pin state is shared with Settings through localStorage.
  const [bookmarksPinned, setBookmarksPinned] = useState(bookmarksBarPinned);
  const bookmarksPeek = useBookmarksPeek(bookmarksPinned);
  // Whether the top tab row has filled up (the window-drag notch shows then).
  const [topTabsCrowded, setTopTabsCrowded] = useState(false);
  const [tabMenu, setTabMenu] = useState<TabMenuAt | null>(null);
  const [containers, setContainers] = useState<Container[]>(loadContainers);
  // Bookmarks live in the server's store (the import panel fills it too); the omnibox
  // star reads and toggles the entry for the page on screen.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const bookmarksRef = useRef<Bookmark[]>([]);
  bookmarksRef.current = bookmarks;
  const [windowContainerId, setWindowContainerId] = useState<string | null>(STARTUP_CONTAINER_ID);
  const [profilePickerOpen, setProfilePickerOpen] = useState(!STARTUP_CONTAINER_ID);
  const [forceTor, setForceTor] = useState(false);
  // Bumped when a container is cleared, which strands its old partition and hands the
  // next tab a brand-new store.
  const [containerEpochs, setContainerEpochs] = useState<Record<string, number>>({});
  const [torStatus, setTorStatus] = useState<TorStatus>({ ready: false, state: 'off', progress: 0, detail: 'Tor is not running' });
  // Saved credentials that match the page each tab is on (metadata only — no passwords).
  const [vaultMatches, setVaultMatches] = useState<Record<string, VaultEntry[]>>({});
  const [vaultPrompt, setVaultPrompt] = useState<VaultPrompt | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const containersRef = useRef(containers);
  containersRef.current = containers;
  const windowContainerRef = useRef(windowContainerId);
  windowContainerRef.current = windowContainerId;
  const forceTorRef = useRef(forceTor);
  forceTorRef.current = forceTor;
  // Bumped every time hold-to-Tor is engaged, so each stint gets a brand-new in-memory
  // partition — cookies from a previous Tor session in this window can never carry over.
  const torHoldEpoch = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveContainers(containers);
  }, [containers]);

  // Profile edits made in another Toji window should appear here immediately.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === CONTAINERS_STORAGE_KEY) setContainers(loadContainers());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useEffect(() => {
    if (windowContainerId && containers.some((container) => container.id === windowContainerId)) return;
    setWindowContainerId(null);
    setProfilePickerOpen(true);
  }, [containers, windowContainerId]);

  // Tor runs in the main process; mirror its state so the UI can show what is reachable.
  useEffect(() => {
    void bridge().torStatus?.().then(setTorStatus);
    return bridge().onTorStatus?.(setTorStatus);
  }, []);
  // A login the user submitted; the password stays in the main process until they say so.
  const [vaultPromptError, setVaultPromptError] = useState<string | undefined>(undefined);
  // A submitted login being judged for automatic saving (see lib/vaultAutosave.ts).
  const autosaveWatch = useRef<{ prompt: VaultPrompt; tabId: string | null; submittedUrl: string | null; startedAt: number; timer: number } | null>(null);
  const settleAutosave = useCallback(async (verdict: 'save' | 'ask') => {
    const watch = autosaveWatch.current;
    if (!watch) return;
    window.clearTimeout(watch.timer);
    autosaveWatch.current = null;
    if (verdict === 'ask') {
      setVaultPromptError(undefined);
      setVaultPrompt(watch.prompt);
      return;
    }
    const result = await bridge().vaultCommit?.(watch.prompt.webContentsId);
    if (result && !result.ok) {
      // Saving failed (the vault refused, the page went away): say so rather than lose it quietly.
      setVaultPromptError(result.error);
      setVaultPrompt(watch.prompt);
    }
  }, []);
  useEffect(
    () =>
      bridge().onVaultPrompt?.((prompt) => {
        if (!autosaveEnabled()) {
          setVaultPromptError(undefined);
          setVaultPrompt(prompt);
          return;
        }
        // Already stored (a password Toji generated) — with autosave on, nothing to show.
        if (prompt.status === 'saved') return;
        const tabId = Object.keys(webviewRefs.current).find((id) => webviewRefs.current[id]?.getWebContentsId?.() === prompt.webContentsId) ?? null;
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (autosaveWatch.current) window.clearTimeout(autosaveWatch.current.timer);
        autosaveWatch.current = {
          prompt,
          tabId,
          submittedUrl: tab?.url ?? null,
          startedAt: Date.now(),
          timer: window.setTimeout(() => void settleAutosave('save'), AUTOSAVE_TIMEOUT_MS)
        };
      }),
    [settleAutosave]
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const baseContainer = findContainer(containers, windowContainerId ?? activeTab?.containerId);
  const torMode = baseContainer.egress === 'tor' || forceTor;
  const activeContainer: Container = torMode
    ? { ...baseContainer, egress: 'tor', ephemeral: forceTor || baseContainer.ephemeral }
    : baseContainer;
  useEffect(() => {
    if (torMode) void bridge().torStart?.();
  }, [torMode]);


  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('toji-theme', theme);
    // Every page follows: sites with a dark mode switch to it, and the AI answer pages
    // restyle in place (they carry both palettes) rather than being generated again.
    bridge().setTheme?.(theme);
  }, [theme]);
  useEffect(() => {
    const sync = () => setBookmarksPinned(bookmarksBarPinned());
    window.addEventListener(BOOKMARKS_BAR_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(BOOKMARKS_BAR_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => localStorage.setItem('toji-layout', layout), [layout]);
  useEffect(() => localStorage.setItem('toji-sidebar', sidebarOpen ? 'open' : 'closed'), [sidebarOpen]);

  // Tap the ⌥ Option key to toggle the agent spotlight for the active tab.
  // (Tap detection so Option-as-a-modifier for typing accents still works.)
  useEffect(() => {
    const toggle = () => setSpotlight((s) => (s ? null : activeRef.current));
    // In Electron, a focused <webview> swallows key events before they reach this window,
    // so the main process watches every web-contents and notifies us — this makes the toggle
    // work even while a page is focused or the agent is running.
    const toji = (window as unknown as { toji?: { onToggleAgent?: (cb: () => void) => () => void } }).toji;
    if (toji?.onToggleAgent) return toji.onToggleAgent(toggle);

    // Browser/dev fallback: detect a tap of either Option key on the window.
    let down = false;
    let used = false;
    let at = 0;
    const isAlt = (e: KeyboardEvent) => e.code === 'AltRight' || e.code === 'AltLeft';
    const onDown = (e: KeyboardEvent) => {
      if (isAlt(e)) {
        if (!down) {
          down = true;
          used = false;
          at = Date.now();
        }
      } else if (down) {
        used = true;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isAlt(e)) return;
      down = false;
      if (!used && Date.now() - at < 400) toggle();
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<BrowserTab> | ((tab: BrowserTab) => Partial<BrowserTab>)) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab)));
  }, []);

  /** The Chromium partition a tab browses in: its container's, or a tab-local throwaway. */
  const tabPartition = useCallback(
    (tab: BrowserTab) => {
      const base = findContainer(containersRef.current, windowContainerRef.current ?? tab.containerId);
      const container: Container = forceTor ? { ...base, egress: 'tor', ephemeral: true } : base;
      if (tab.contextKey > 0) return tabSessionPartition(container, tab.contextKey);
      // Hold-to-Tor sessions are versioned by their own epoch so every stint starts clean.
      return partitionFor(container, forceTor ? torHoldEpoch.current : containerEpochs[container.id] ?? 0);
    },
    [containerEpochs, forceTor]
  );

  /** Select the identity for this entire window; every existing and future tab follows it. */
  const selectWindowContainer = useCallback((containerId: string) => {
    // Re-picking the current profile (with no Tor override to unwind) is a no-op —
    // don't reload every tab just because the picker was opened and dismissed this way.
    if (containerId === windowContainerRef.current && !forceTorRef.current) {
      setProfilePickerOpen(false);
      return;
    }
    setWindowContainerId(containerId);
    setForceTor(false);
    setProfilePickerOpen(false);
    setVaultMatches({});
    setTabs((current) =>
      current.map((tab) => ({
        ...tab,
        containerId,
        contextKey: 0,
        reloadKey: tab.reloadKey + 1,
        status: tab.url ? 'loading' : tab.status
      }))
    );
  }, []);

  /** Engage hold-to-Tor for this window on a brand-new ephemeral session. */
  const enableForceTor = useCallback(() => {
    torHoldEpoch.current += 1;
    setForceTor(true);
    setTabs((current) => current.map((tab) => ({ ...tab, contextKey: 0, reloadKey: tab.reloadKey + 1, status: tab.url ? 'loading' : tab.status })));
  }, []);

  const toggleWindowTor = useCallback(() => {
    const base = findContainer(containersRef.current, windowContainerRef.current ?? undefined);
    if (base.egress === 'tor') return;
    if (!forceTorRef.current) {
      enableForceTor();
      return;
    }
    setForceTor(false);
    setTabs((current) => current.map((tab) => ({ ...tab, contextKey: 0, reloadKey: tab.reloadKey + 1, status: tab.url ? 'loading' : tab.status })));
  }, [enableForceTor]);

  /** Wipe everything a container has stored, then reload the tabs sitting in it. */
  const clearContainer = useCallback((containerId: string) => {
    setContainerEpochs((e) => ({ ...e, [containerId]: (e[containerId] ?? 0) + 1 }));
    void bridge().clearContainer?.(containerId);
    setTabs((current) => current.map((t) => (t.containerId === containerId ? { ...t, contextKey: 0, reloadKey: t.reloadKey + 1 } : t)));
  }, []);

  // Navigate a tab to a real web URL (rendered by <webview> inside Toji).
  const navigateTab = useCallback(
    (tabId: string, url: string) => {
      // The address a web tab is already at: load it again, as any browser does on Enter.
      // Writing the same URL into the tab would change nothing the page could see and
      // leave the tab marked loading for good.
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab && tab.mode === 'web' && !tab.internal && tab.url === url) {
        try {
          const result = webviewRefs.current[tabId]?.loadURL?.(url);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          patchTab(tabId, (t) => ({ reloadKey: t.reloadKey + 1 }));
        }
        return;
      }
      // `internal` must go too: a URL typed into the welcome or settings tab otherwise
      // kept showing that page, spinning, with the webview never mounted.
      patchTab(tabId, { internal: undefined, mode: 'web', url, query: url, title: undefined, status: 'loading', sources: [], streamUrl: null });
    },
    [patchTab]
  );

  // Generate an AI answer page for a query.
  const generatePage = useCallback(
    (tabId: string, query: string) => {
      // On the Toji plan without a subscription, the page would be generated by the
      // fallback CLI without the user ever being told the plan they are on does
      // nothing yet. Show the plans page instead — the tab keeps its query, so
      // Continue picks the question back up wherever they leave off.
      if (paywalledRef.current) {
        patchTab(tabId, { internal: 'plans', mode: 'page', url: null, query, streamUrl: null, status: 'ready', sources: [] });
        setActiveId(tabId);
        return;
      }
      patchTab(tabId, { internal: undefined, mode: 'page', url: null, query, streamUrl: pageStreamUrl(query), status: 'loading', sources: [] });
      void fetchPageSources(query)
        .then((res) => patchTab(tabId, { sources: res.sources }))
        .catch(() => undefined);
    },
    [patchTab]
  );

  // Omnibox submit. URLs always navigate; otherwise either a web search or an AI page.
  const go = useCallback(
    (tabId: string, raw: string, opts: { ai?: boolean } = {}) => {
      const value = raw.trim();
      if (!value) return;
      if (looksLikeUrl(value)) {
        // A hidden service only resolves through Tor's own resolver, so a direct
        // container physically cannot load it. Move the tab into a Tor container
        // rather than letting it fail with a DNS error.
        if (isOnionUrl(value)) {
          const here = findContainer(containersRef.current, windowContainerRef.current ?? tabsRef.current.find((t) => t.id === tabId)?.containerId);
          if (here.egress !== 'tor' && !forceTorRef.current) enableForceTor();
        }
        navigateTab(tabId, toUrl(value));
      }
      // Plain Enter behaves like any browser: search. Shift+Enter asks the model to
      // build an answer page instead.
      else if (opts.ai) generatePage(tabId, value);
      else navigateTab(tabId, webSearchUrl(value, (localStorage.getItem('toji-search-engine') as SearchEngineId | null) ?? 'duckduckgo'));
    },
    [enableForceTor, generatePage, navigateTab]
  );

  const openTab = useCallback((groupId: string | null = null, containerId?: string) => {
    const tab = makeTab(groupId, windowContainerRef.current ?? containerId ?? DEFAULT_CONTAINER_ID);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** Sidebar hold-menu: a fresh group holding a fresh tab. */
  const openTabInNewGroup = useCallback(() => {
    const id = `grp-${Date.now()}-${(counter += 1)}`;
    const tab = makeTab(id, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
    setGroups((gs) => [...gs, { id, name: `Group ${gs.length + 1}`, collapsed: false }]);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** Sidebar hold-menu: a fresh tab with the agent spotlight open, ready for an AI task. */
  const openAgentTab = useCallback(() => {
    const tab = makeTab(null, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setSpotlight(tab.id);
  }, []);

  // Open (or focus) a built-in Toji page — Settings / Welcome — as a tab.
  const openInternal = useCallback((page: 'settings' | 'welcome' | 'plans') => {
    const existing = tabsRef.current.find((t) => t.internal === page);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    // On first launch, Welcome owns the initial blank tab instead of creating a
    // throwaway New Tab beside it. This also keeps Start browsing in the same tab.
    const welcomeTabs = page === 'welcome' ? replacePristineTabWithWelcome(tabsRef.current, activeRef.current) : null;
    if (welcomeTabs && from) {
      const next = welcomeTabs;
      tabsRef.current = next;
      setTabs(next);
      setActiveId(from.id);
      return;
    }
    const tab = makeTab(from?.groupId ?? null, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
    tab.internal = page;
    tab.status = 'ready';
    // Update the ref synchronously as well as state. React Strict Mode replays mount
    // effects before a queued state update renders; without this, onboarding could add
    // the same Welcome tab twice.
    const next = [...tabsRef.current, tab];
    tabsRef.current = next;
    setTabs(next);
    setActiveId(tab.id);
  }, []);

  // First launch: show the welcome/onboarding page once.
  useEffect(() => {
    if (localStorage.getItem('toji-onboarded') !== '1') openInternal('welcome');
  }, [openInternal]);

  // Open an http(s) link (a source or an in-page link) as a new Toji web tab.
  /**
   * A link from outside Toji: another app, the OS, the command line. It lands in the
   * window's container — and if no profile has been chosen yet, in the default one,
   * because a link someone just clicked should open, not wait behind a picker.
   */
  const openExternalLink = useCallback(
    (url: string) => {
      const containerId = windowContainerRef.current ?? DEFAULT_CONTAINER_ID;
      if (!windowContainerRef.current) selectWindowContainer(containerId);
      const tab = makeTab(null, containerId);
      tab.mode = 'web';
      tab.url = url;
      tab.query = url;
      tab.status = 'loading';
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
    },
    [selectWindowContainer]
  );

  /**
   * A link opened from the page on screen: a popup, a ⌘-click, "Open Link in New Tab",
   * a source under an answer. The tab goes right beside the one it came from, and with
   * `background` it opens without taking the screen — the way a ⌘-click should.
   */
  const openWebTab = useCallback((url: string, options: OpenUrlOptions = {}) => {
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    // A link opened from a page stays in that page's container, so following a link
    // never silently moves you into a different identity.
    const tab = makeTab(from?.groupId ?? null, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
    tab.mode = 'web';
    tab.url = url;
    tab.query = url;
    tab.status = 'loading';
    tab.openerId = from?.id;
    setTabs((current) => insertTabAfter(current, from?.id, tab));
    if (!options.background) setActiveId(tab.id);
  }, []);

  // Whether the chosen backend is a Toji plan with no subscription behind it. Kept in a
  // ref because generatePage reads it when a query fires, not when it re-renders. It is
  // deliberately narrow: any other backend, and a query goes straight to the page.
  const paywalledRef = useRef(false);
  const refreshPlanGate = useCallback(async () => {
    try {
      const agents = await getAgents();
      paywalledRef.current = agents.choice === 'toji' && !agents.toji.active;
    } catch {
      paywalledRef.current = false; // the server being down is not a paywall
    }
  }, []);
  useEffect(() => {
    void refreshPlanGate();
  }, [refreshPlanGate]);

  // Links the main process hands over: from a page (a popup, a ⌘-click, the context
  // menu — beside the page's tab, in the background when asked) or from another app.
  useEffect(() => {
    const off = bridge().onOpenUrl?.((url, options) => {
      if (options?.fromPage) openWebTab(url, options);
      else openExternalLink(url);
    });
    // Links that arrived before this window's renderer existed — a click in another app
    // that started Toji cold. Asking for them also tells the main process this window
    // can take the next one directly.
    void bridge()
      .takeExternalUrls?.()
      .then((urls) => urls.forEach(openExternalLink))
      .catch(() => {});
    return off;
  }, [openExternalLink, openWebTab]);

  // "Search <engine> for …" in the page context menu. The main process sends the phrase;
  // the engine it should go to is a setting only the renderer knows.
  useEffect(() => {
    const toji = (window as unknown as { toji?: { onSearch?: (cb: (text: string) => void) => () => void } }).toji;
    return toji?.onSearch?.((text) => {
      const query = text.trim();
      if (query) openWebTab(webSearchUrl(query, (localStorage.getItem('toji-search-engine') as SearchEngineId | null) ?? 'duckduckgo'));
    });
  }, [openWebTab]);

  const closeTab = useCallback(
    (id: string) => {
      const current = tabsRef.current;
      if (current.length <= 1) {
        const toji = (window as unknown as { toji?: { closeWindow?: () => void } }).toji;
        if (toji?.closeWindow) toji.closeWindow();
        else window.close();
        return;
      }
      const index = current.findIndex((t) => t.id === id);
      const next = current.filter((t) => t.id !== id);
      setTabs(next);
      setVaultMatches((m) => {
        if (!(id in m)) return m;
        const { [id]: _gone, ...rest } = m;
        return rest;
      });
      if (id === activeRef.current) setActiveId(next[Math.min(index, next.length - 1)].id);
      const surviving = new Set(next.map((t) => t.groupId).filter(Boolean) as string[]);
      setGroups((gs) => gs.filter((g) => surviving.has(g.id)));
      // Prune per-tab agent state/refs so long sessions that open and close many tabs
      // don't leak entries in these keyed maps.
      // Release an agent paused on a question, or its loop would await the answer forever.
      agentCancel.current[id] = true;
      agentAskResolve.current[id]?.(null);
      delete agentAskResolve.current[id];
      delete agentCancel.current[id];
      delete cursorPos.current[id];
      setAgents((a) => {
        const { [id]: _drop, ...rest } = a;
        return rest;
      });
      setAgentFiles((m) => {
        const { [id]: _drop, ...rest } = m;
        return rest;
      });
    },
    []
  );

  const createGroup = useCallback((tabId?: string) => {
    const target = tabId ?? activeRef.current;
    const id = `grp-${Date.now()}-${(counter += 1)}`;
    setGroups((gs) => [...gs, { id, name: `Group ${gs.length + 1}`, collapsed: false }]);
    setTabs((ts) => ts.map((t) => (t.id === target ? { ...t, groupId: id } : t)));
  }, []);

  const removeGroup = useCallback((id: string) => {
    setTabs((ts) => ts.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)));
    setGroups((gs) => gs.filter((g) => g.id !== id));
  }, []);

  const addTabToGroup = useCallback((tabId: string, groupId: string) => patchTab(tabId, { groupId }), [patchTab]);
  const ungroupTab = useCallback((tabId: string) => patchTab(tabId, { groupId: null }), [patchTab]);

  const toggleGroup = useCallback((id: string) => setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g))), []);
  const renameGroup = useCallback((id: string, name: string) => setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g))), []);

  const refreshBookmarks = useCallback(async () => {
    try {
      setBookmarks((await getBookmarks()).bookmarks);
    } catch {
      // No server yet — the star stays hollow and the landing row stays empty.
    }
  }, []);
  useEffect(() => {
    void refreshBookmarks();
  }, [refreshBookmarks]);

  const removeBookmark = useCallback(
    async (id: string) => {
      try {
        await deleteBookmark(id);
      } catch {
        return;
      }
      await refreshBookmarks();
    },
    [refreshBookmarks]
  );

  /** Bookmark the page a web tab is showing, or remove it if it already is one. */
  const toggleBookmark = useCallback(
    async (tab: BrowserTab | undefined) => {
      if (!tab || tab.mode !== 'web' || !tab.url) return;
      const existing = bookmarksRef.current.find((b) => b.url === tab.url);
      try {
        if (existing) await deleteBookmark(existing.id);
        else await addBookmarks([{ title: tabTitle(tab), url: tab.url }]);
      } catch {
        return;
      }
      await refreshBookmarks();
    },
    [refreshBookmarks]
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === 'd') {
        event.preventDefault();
        void toggleBookmark(tabsRef.current.find((t) => t.id === activeRef.current));
      } else if (event.key === 't' && !isElectron) {
        event.preventDefault();
        openTab(null);
      } else if (event.key === 'w' && !isElectron) {
        event.preventDefault();
        closeTab(activeRef.current);
      } else if (event.key === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const list = tabsRef.current;
        const target = event.key === '9' ? list[list.length - 1] : list[Number(event.key) - 1];
        if (target) setActiveId(target.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeTab, openTab, toggleBookmark]);

  // Menu accelerators from the main process (Cmd+W closes the active tab, Cmd+T opens one).
  useEffect(() => {
    const toji = (window as unknown as { toji?: { onCloseTab?: (cb: () => void) => () => void; onNewTab?: (cb: () => void) => () => void } }).toji;
    const offClose = toji?.onCloseTab?.(() => closeTab(activeRef.current));
    const offNew = toji?.onNewTab?.(() => openTab(null));
    return () => {
      offClose?.();
      offNew?.();
    };
  }, [closeTab, openTab]);


  const reloadTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const nextKey = tab.reloadKey + 1;
      if (tab.mode === 'web' && tab.url) {
        patchTab(tabId, { reloadKey: nextKey, status: 'loading' });
      } else if (tab.mode === 'page' && tab.query.trim()) {
        // Reload forces a fresh (uncached) regeneration.
        patchTab(tabId, { reloadKey: nextKey, streamUrl: pageStreamUrl(tab.query, nextKey), status: 'loading' });
        void fetchPageSources(tab.query)
          .then((r) => patchTab(tabId, { sources: r.sources }))
          .catch(() => undefined);
      } else if (tab.query.trim()) {
        go(tabId, tab.query);
      }
    },
    [go, patchTab]
  );
  const reloadActive = () => activeTab && reloadTab(activeTab.id);

  const duplicateTab = useCallback((tabId: string) => {
    const src = tabsRef.current.find((t) => t.id === tabId);
    if (!src) return;
    const dup = makeTab(src.groupId, src.containerId);
    dup.mode = src.mode;
    dup.url = src.url;
    dup.query = src.query;
    dup.streamUrl = src.streamUrl; // page tabs reuse the cached stream URL → instant clone
    dup.sources = src.sources;
    dup.title = src.title;
    dup.status = src.streamUrl || src.url ? 'loading' : 'new';
    setTabs((current) => {
      const idx = current.findIndex((t) => t.id === tabId);
      const next = [...current];
      next.splice(idx < 0 ? current.length : idx + 1, 0, dup);
      return next;
    });
    setActiveId(dup.id);
  }, []);

  const closeOtherTabs = useCallback((tabId: string) => {
    const keep = tabsRef.current.find((t) => t.id === tabId);
    if (!keep) return;
    setTabs([keep]);
    setActiveId(keep.id);
    setGroups((gs) => gs.filter((g) => g.id === keep.groupId));
  }, []);

  // ---- Per-tab web agent ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRefs = useRef<Record<string, any>>({});
  const agentCancel = useRef<Record<string, boolean>>({});
  // Pending "ask the user" resolver per tab: the agent loop awaits it; the spotlight submit (or a
  // Stop, which resolves null) fulfills it.
  const agentAskResolve = useRef<Record<string, ((answer: string | null) => void) | undefined>>({});
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  // Files the user dropped onto a tab's agent (e.g. a resume): a server path + a stable index.
  const [agentFiles, setAgentFiles] = useState<Record<string, AgentFile[]>>({});
  const agentFilesRef = useRef(agentFiles);
  useEffect(() => {
    agentFilesRef.current = agentFiles;
  }, [agentFiles]);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [agentCursor, setAgentCursor] = useState<{ x: number; y: number; tick: number } | null>(null);
  // Hide the agent cursor when you switch away from the tab it's acting on.
  useEffect(() => setAgentCursor(null), [activeId]);

  // How long the agent persists on a goal. It runs until the goal is done (or you Stop);
  // the step cap is a safety backstop the user can raise or remove (persisted locally).
  const [agentMaxSteps, setAgentMaxSteps] = useState<number>(() => {
    const v = Number(localStorage.getItem('toji.agentMaxSteps'));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_AGENT_MAX_STEPS;
  });
  const [agentNoLimit, setAgentNoLimit] = useState<boolean>(() => localStorage.getItem('toji.agentNoLimit') === '1');
  const agentLimitRef = useRef({ max: agentMaxSteps, noLimit: agentNoLimit });
  useEffect(() => {
    agentLimitRef.current = { max: agentMaxSteps, noLimit: agentNoLimit };
    localStorage.setItem('toji.agentMaxSteps', String(agentMaxSteps));
    localStorage.setItem('toji.agentNoLimit', agentNoLimit ? '1' : '0');
  }, [agentMaxSteps, agentNoLimit]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Messages from a tab's guest preload (see apps/desktop/guest-preload.cjs). */
  const onGuestMessage = useCallback((tabId: string, channel: string, payload: unknown) => {
    if (channel === 'toji:top-edge') {
      // The pointer entered or left the top of the page — where the unpinned bookmarks
      // bar goes. Only the page in front can be under the pointer at all.
      if (tabId !== activeRef.current) return;
      if ((payload as { inside?: boolean } | undefined)?.inside) bookmarksPeek.show();
      else bookmarksPeek.hide();
      return;
    }
    if (channel !== 'toji-vault:form') return;
    const { hasLogin, url: reportedUrl } = (payload ?? {}) as { hasLogin?: boolean; url?: string };
    const watch = autosaveWatch.current;
    if (watch && watch.tabId === tabId) {
      const verdict = autosaveVerdict({ hasLogin: Boolean(hasLogin), url: reportedUrl }, { submittedUrl: watch.submittedUrl, elapsedMs: Date.now() - watch.startedAt });
      if (verdict !== 'wait') void settleAutosave(verdict);
    }
    if (!hasLogin) {
      setVaultMatches((m) => (m[tabId]?.length ? { ...m, [tabId]: [] } : m));
      return;
    }
    const webContentsId = webviewRefs.current[tabId]?.getWebContentsId?.();
    if (!webContentsId) return;
    void bridge()
      .vaultMatches?.(webContentsId)
      .then((result) => setVaultMatches((m) => ({ ...m, [tabId]: result?.ok ? result.value : [] })));
  }, [bookmarksPeek.hide, bookmarksPeek.show]);

  /** Ask the main process to fill a credential into a tab's page. */
  const fillCredential = useCallback((tabId: string, entryId: string) => {
    const wv = webviewRefs.current[tabId] as unknown as { getWebContentsId?: () => number } | undefined;
    const wcId = wv?.getWebContentsId?.();
    if (wcId) void bridge().vaultFill?.(wcId, entryId);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerWebview = useCallback(
    (tabId: string, el: any | null) => {
      if (el) webviewRefs.current[tabId] = el;
      else {
        delete webviewRefs.current[tabId];
        // A page that went away (reload, navigation to a new context) is silent until
        // Chromium says otherwise about the next one.
        setTabs((current) => (current.some((t) => t.id === tabId && t.audible) ? current.map((t) => (t.id === tabId ? { ...t, audible: false } : t)) : current));
      }
    },
    []
  );

  // Sound: Chromium reports per page (by webContents id) when it starts and stops; the
  // tab shows a speaker meanwhile. The mute is the tab's own state, applied by WebView.
  useEffect(
    () =>
      bridge().onTabAudio?.(({ webContentsId, audible }) => {
        const tabId = Object.keys(webviewRefs.current).find((id) => webviewRefs.current[id]?.getWebContentsId?.() === webContentsId);
        if (!tabId) return;
        setTabs((current) => (current.some((t) => t.id === tabId && Boolean(t.audible) !== audible) ? current.map((t) => (t.id === tabId ? { ...t, audible } : t)) : current));
      }),
    []
  );
  const toggleMute = useCallback((tabId: string) => patchTab(tabId, (t) => ({ muted: !t.muted })), [patchTab]);

  // Back / forward through the active web tab's history (webview history).
  const goBack = useCallback(() => {
    const wv = webviewRefs.current[activeRef.current];
    if (wv?.canGoBack?.()) wv.goBack();
  }, []);
  const goForward = useCallback(() => {
    const wv = webviewRefs.current[activeRef.current];
    if (wv?.canGoForward?.()) wv.goForward();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '[') {
        e.preventDefault();
        goBack();
      } else if (e.key === ']') {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, goForward]);

  const logAgent = useCallback((tabId: string, entry: AgentLogEntry) => {
    setAgents((a) => ({ ...a, [tabId]: { ...a[tabId], running: a[tabId]?.running ?? true, log: [...(a[tabId]?.log ?? []), entry] } }));
  }, []);

  const stopAgent = useCallback((tabId: string) => {
    agentCancel.current[tabId] = true;
    // If the agent is paused on a question, release it so the loop can observe the cancel.
    agentAskResolve.current[tabId]?.(null);
    agentAskResolve.current[tabId] = undefined;
    setAgentCursor(null);
    setAgents((a) => ({ ...a, [tabId]: { running: false, log: a[tabId]?.log ?? [], ask: undefined } }));
  }, []);

  // Reset a tab's browsing context (fresh, isolated session) and reload it.
  const resetContext = useCallback(
    (tabId: string) => {
      stopAgent(tabId);
      patchTab(tabId, (t) => ({ contextKey: t.contextKey + 1, reloadKey: t.reloadKey + 1, status: 'loading' }));
    },
    [patchTab, stopAgent]
  );

  // Last known cursor position (in guest CSS px) per tab, so each glide starts where
  // the previous one ended and traces a continuous, human-looking path.
  const cursorPos = useRef<Record<string, { x: number; y: number }>>({});

  // Glide the real mouse from its last position to (toX,toY) along a cubic Bézier curve
  // with a slight perpendicular bow and eased timing — sending intermediate mouseMove
  // events so hover-driven UI reacts naturally, instead of teleporting straight there.
  const glideCursor = useCallback(async (tabId: string, toX: number, toY: number) => {
    const wv = webviewRefs.current[tabId];
    if (!wv) return;
    const box = tabId === activeRef.current ? wv.getBoundingClientRect?.() : null;
    const from = cursorPos.current[tabId] ?? { x: toX, y: toY };
    const dx = toX - from.x;
    const dy = toY - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector → bow the arc to one side (alternating each move).
    const px = -dy / dist;
    const py = dx / dist;
    const bow = Math.min(80, dist * 0.18) * bowSign;
    bowSign *= -1;
    const c1x = from.x + dx * 0.33 + px * bow;
    const c1y = from.y + dy * 0.33 + py * bow;
    const c2x = from.x + dx * 0.66 + px * bow;
    const c2y = from.y + dy * 0.66 + py * bow;
    const steps = Math.max(10, Math.min(30, Math.round(dist / 16)));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      // easeInOutQuad: accelerate then settle, like a real hand.
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const mt = 1 - e;
      const x = mt ** 3 * from.x + 3 * mt ** 2 * e * c1x + 3 * mt * e ** 2 * c2x + e ** 3 * toX;
      const y = mt ** 3 * from.y + 3 * mt ** 2 * e * c1y + 3 * mt * e ** 2 * c2y + e ** 3 * toY;
      try {
        wv.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      } catch {
        /* webview not ready */
      }
      if (box) setAgentCursor((c) => ({ x: box.left + x, y: box.top + y, tick: c?.tick ?? 0 }));
      await delay(11);
    }
    cursorPos.current[tabId] = { x: toX, y: toY };
  }, []);

  // Glide to a point and fire a real mouse click there (with the ripple animation).
  const clickPoint = useCallback(
    async (tabId: string, cx: number, cy: number) => {
      const wv = webviewRefs.current[tabId];
      if (!wv) return false;
      await glideCursor(tabId, cx, cy);
      await delay(120);
      try {
        wv.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
        wv.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        wv.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        setAgentCursor((c) => (c ? { ...c, tick: c.tick + 1 } : c));
      } catch {
        return false;
      }
      return true;
    },
    [glideCursor]
  );

  // Real mouse click at an absolute viewport PIXEL coordinate — for visual targets (chess
  // squares, canvases, images) with no DOM element. The model reads the grid's pixel labels
  // and returns pixels; if it ever returns a 0..1 fraction instead, we scale it up.
  const realClickAt = useCallback(
    async (tabId: string, x: number, y: number) => {
      const wv = webviewRefs.current[tabId];
      if (!wv) return false;
      let size: { w: number; h: number };
      try {
        size = await wv.executeJavaScript('({ w: innerWidth, h: innerHeight })', true);
      } catch {
        return false;
      }
      let px = x;
      let py = y;
      if (x <= 1 && y <= 1) {
        px = x * size.w;
        py = y * size.h;
      }
      const cx = Math.round(Math.max(0, Math.min(size.w, px)));
      const cy = Math.round(Math.max(0, Math.min(size.h, py)));
      return clickPoint(tabId, cx, cy);
    },
    [clickPoint]
  );

  // Real mouse DRAG — presses at the source, glides to the destination with the button held,
  // releases. Needed to MOVE things (chess pieces, sliders, drag-and-drop); a plain click can't.
  // Endpoints are absolute viewport pixels (0..1 fractions accepted as a fallback).
  const realDrag = useCallback(
    async (tabId: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
      const wv = webviewRefs.current[tabId];
      if (!wv) return false;
      let size: { w: number; h: number };
      try {
        size = await wv.executeJavaScript('({ w: innerWidth, h: innerHeight })', true);
      } catch {
        return false;
      }
      const resolve = (p: { x: number; y: number }) => {
        const frac = p.x <= 1 && p.y <= 1;
        return {
          x: Math.round(Math.max(0, Math.min(size.w, frac ? p.x * size.w : p.x))),
          y: Math.round(Math.max(0, Math.min(size.h, frac ? p.y * size.h : p.y)))
        };
      };
      const s = resolve(from);
      const d = resolve(to);
      try {
        await glideCursor(tabId, s.x, s.y);
        wv.sendInputEvent({ type: 'mouseMove', x: s.x, y: s.y });
        wv.sendInputEvent({ type: 'mouseDown', x: s.x, y: s.y, button: 'left', clickCount: 1 });
        await delay(140);
        // Glide to the destination with the button held — sends intermediate mouseMoves.
        await glideCursor(tabId, d.x, d.y);
        wv.sendInputEvent({ type: 'mouseMove', x: d.x, y: d.y });
        await delay(120);
        wv.sendInputEvent({ type: 'mouseUp', x: d.x, y: d.y, button: 'left', clickCount: 1 });
        setAgentCursor((c) => (c ? { ...c, tick: c.tick + 1 } : c));
      } catch {
        return false;
      }
      return true;
    },
    [glideCursor]
  );

  // Type into whatever currently has focus, as real key events. Screenshot mode has no
  // element ids to target, so text always goes to the focus a click just established.
  const typeText = useCallback(async (tabId: string, text: string) => {
    const wv = webviewRefs.current[tabId];
    if (!wv) return false;
    try {
      for (const ch of text) {
        wv.sendInputEvent({ type: 'char', keyCode: ch });
        await delay(12);
      }
    } catch {
      return false;
    }
    return true;
  }, []);

  // Run the agent loop on a specific tab: screenshot → action → screenshot → action.
  // The model's ONLY view of the page is the capture, and it answers in that image's
  // pixel coordinates, which are scaled to CSS px and dispatched as real mouse/key input.
  const runAgent = useCallback(
    async (tabId: string, goal: string) => {
      agentCancel.current[tabId] = false;
      setAgents((a) => ({ ...a, [tabId]: { running: true, log: [...(a[tabId]?.log ?? []), { role: 'you', text: goal }] } }));
      const history: Array<{ action: string; reason?: string }> = [];
      // Hermes-style memory: ask the librarian once for a compact digest relevant to this goal
      // (plus always-on pinned memory). Injected into every step so the agent has context without
      // us pushing the whole memory store. Best-effort — never blocks the run.
      let memory = '';
      try {
        const lib = await librarian(goal, tabId);
        memory = [lib.pinned, lib.digest].filter((s) => s && s.trim()).join('\n\n').slice(0, 1400);
      } catch {
        /* memory is optional */
      }
      // Persistent reference documents (e.g. a resume kept in memory) — available to the agent for
      // the whole run alongside any files dropped on this tab. High indices avoid colliding with
      // dropped-file indices.
      let references: AgentFile[] = [];
      try {
        const r = await getReferences();
        references = r.references.map((d, i) => ({ index: 100000 + i, name: d.name, mime: d.mime, path: d.path }));
      } catch {
        /* references are optional */
      }
      const allFiles = () => [...(agentFilesRef.current[tabId] ?? []), ...references];
      let waits = 0;
      let shotFailures = 0; // consecutive screenshots that came back empty/failed
      let completed = false;
      let acted = 0; // real (non-wait) actions performed so far
      let doneOverrides = 0; // times we've rejected a premature "done"
      let stepFailures = 0; // consecutive model-call failures
      let refusals = 0; // consecutive prose/refusal responses (model returned non-JSON)
      // Loop until the goal is done (or the user Stops). The cap is just a runaway backstop;
      // the user can raise it or turn it off entirely in the spotlight.
      const { max, noLimit } = agentLimitRef.current;
      const maxSteps = noLimit ? Infinity : Math.max(1, max);
      let step = 0;
      for (; step < maxSteps; step += 1) {
        if (agentCancel.current[tabId]) break;
        let wv = webviewRefs.current[tabId];
        if (!wv) {
          // No website is open on this tab yet — let the agent decide where to go from the goal
          // (e.g. "go to lichess.org and …"), navigate there, then continue once the page mounts.
          let nav;
          try {
            nav = await agentStep({
              goal,
              url: 'about:blank',
              title: 'New Tab',
              // No image: there is no page to capture yet, so this turn is deliberately
              // the one step the agent takes without seeing anything.
              // The server accepts at most 20 history entries — send the most recent ones.
              history: [...history.slice(-19), { action: 'note', reason: 'No website is open yet. Use "navigate" with the URL the goal needs to begin.' }]
            });
          } catch {
            stepFailures += 1;
            if (stepFailures >= 5) {
              logAgent(tabId, { role: 'system', text: 'The model kept failing to respond — stopping.' });
              break;
            }
            await delay(1000 * stepFailures);
            step -= 1;
            continue;
          }
          if (agentCancel.current[tabId]) break;
          if (nav.reason) logAgent(tabId, { role: 'agent', text: nav.reason });
          if (nav.action === 'done') {
            completed = true;
            break;
          }
          if (nav.action !== 'navigate' || !nav.url) {
            logAgent(tabId, { role: 'system', text: 'No page is open — tell me a site to go to (e.g. "go to lichess.org and play a game").' });
            break;
          }
          const dest = toUrl(nav.url);
          logAgent(tabId, { role: 'agent', text: `Opening ${dest}` });
          navigateTab(tabId, dest);
          history.push({ action: 'navigate', reason: nav.reason });
          // Wait for the <webview> to mount + begin loading before the loop reads the page.
          for (let k = 0; k < 60; k += 1) {
            if (agentCancel.current[tabId]) break;
            if (webviewRefs.current[tabId]) break;
            await delay(100);
          }
          await delay(1200);
          step -= 1; // navigation setup shouldn't consume the action budget
          continue;
        }
        // Let the page settle before reading it, so the agent never acts on a half-loaded page.
        for (let i = 0; i < 25; i += 1) {
          if (!wv.isLoading?.()) break;
          await delay(100);
        }
        if (agentCancel.current[tabId]) break;
        const wcId = (wv as unknown as { getWebContentsId?: () => number }).getWebContentsId?.();
        if (typeof wcId !== 'number' || !eyesAvailable()) {
          logAgent(tabId, { role: 'system', text: 'Page perception is unavailable — the agent needs the Toji desktop app.' });
          break;
        }
        // The one observation of the turn: what this tab looks like right now. Captured
        // over CDP, so a background tab yields real pixels rather than a blank frame.
        const shot = await pageScreenshot(wcId);
        if (agentCancel.current[tabId]) break;
        if (!shot.ok || !shot.dataUri) {
          shotFailures += 1;
          if (shotFailures >= 5) {
            logAgent(tabId, { role: 'system', text: `Could not see this page${shot.error ? ` (${shot.error})` : ''} — stopping.` });
            break;
          }
          await delay(600 * shotFailures);
          step -= 1;
          continue;
        }
        shotFailures = 0;
        const image = shot.dataUri;
        const imageSize = shot.width && shot.height ? { w: shot.width, h: shot.height } : undefined;
        let action;
        try {
          action = await agentStep({
            goal,
            url: wv.getURL?.() ?? '',
            title: wv.getTitle?.(),
            history: history.slice(-20),
            image,
            image_size: imageSize,
            credentialAccess: Boolean(bridge().vaultMatches && bridge().vaultFill),
            files: allFiles().map((f) => ({ index: f.index, name: f.name, mime: f.mime })),
            memory
          });
          stepFailures = 0;
        } catch {
          // A transient model/network hiccup (rate-limit, timeout) shouldn't kill the run — retry
          // several times with growing backoff before giving up.
          stepFailures += 1;
          if (stepFailures >= 5) {
            logAgent(tabId, { role: 'system', text: 'The model kept failing to respond (rate-limit or network?) — stopping.' });
            break;
          }
          logAgent(tabId, { role: 'system', text: `Model didn't respond — retrying (${stepFailures}/5)…` });
          await delay(1000 * stepFailures);
          step -= 1; // don't burn a real step on a transient failure
          continue;
        }
        if (agentCancel.current[tabId]) break;
        // The model returned prose/refused ("I don't have browser-control tools") instead of a JSON
        // action. The server already retried once; don't surface the raw refusal or spin forever —
        // nudge it via history and give up after a few in a row with a clear message.
        if (action.error) {
          refusals += 1;
          if (refusals >= 3) {
            logAgent(tabId, { role: 'system', text: 'The agent kept replying with text instead of taking an action — it may be declining the task. Stopping.' });
            break;
          }
          history.push({ action: 'note', reason: 'you replied with prose, not a JSON action — you DO control this browser; return one JSON action' });
          await delay(500);
          step -= 1; // a refusal shouldn't consume the action budget
          continue;
        }
        refusals = 0;
        if (action.reason) logAgent(tabId, { role: 'agent', text: action.reason });
        if (action.action === 'done' || action.done) {
          // Reject a "done" before the agent has actually done anything — a weak model often
          // declares victory immediately. Push it back once to make it actually act.
          if (acted === 0 && doneOverrides < 1) {
            doneOverrides += 1;
            history.push({ action: 'note', reason: "don't say done before doing anything — actually perform the task first" });
            step -= 1;
            continue;
          }
          completed = true;
          break;
        }
        // research: summon the research sub-agent for guidance when stuck/unsure, and feed its
        // answer back as an observation. General — works for any task.
        if (action.action === 'research' && typeof action.query === 'string') {
          logAgent(tabId, { role: 'agent', text: `Researching: ${action.query}` });
          let answer = '';
          try {
            const r = await agentResearch({ question: action.query, goal, url: wv.getURL?.() ?? '' });
            answer = r.answer || '';
          } catch {
            answer = '';
          }
          const text = answer ? answer : 'No useful guidance found.';
          history.push({ action: 'researched', reason: `${action.query} → ${text}` });
          logAgent(tabId, { role: 'agent', text: `Guidance → ${text.slice(0, 240)}` });
          step -= 1; // research is an info-gathering step, not an action
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
          }
          continue;
        }
        // Credential discovery is an explicit, site-scoped tool call. The model receives
        // only metadata matching the current origin + container, never a global directory
        // and never a password.
        if (action.action === 'findCredentials') {
          const currentUrl = wv.getURL?.() ?? '';
          const result = await bridge().vaultMatches?.(wcId);
          const matches = result?.ok ? result.value : [];
          const summary = matches.length
            ? matches.map((entry) => ({ credentialId: entry.id, name: entry.name, username: entry.username }))
            : [];
          history.push({ action: 'findCredentials', reason: summary.length ? `matches: ${JSON.stringify(summary)}` : 'no saved login matches this exact website and profile' });
          logAgent(tabId, { role: 'agent', text: summary.length ? `Found ${summary.length} saved login${summary.length === 1 ? '' : 's'} for ${hostOf(currentUrl)}.` : `No saved login for ${hostOf(currentUrl) || 'this site'}.` });
          step -= 1;
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
          }
          continue;
        }
        if (action.action === 'fillCredential' && typeof action.credentialId === 'string') {
          const ok = (await bridge().vaultFill?.(wcId, action.credentialId)) ?? false;
          history.push({ action: 'fillCredential', reason: ok ? 'saved login filled securely' : 'fill refused: credential, origin, or profile did not match' });
          logAgent(tabId, { role: ok ? 'agent' : 'system', text: ok ? 'Filled the saved login.' : 'Could not fill that login on this website/profile.' });
          if (ok) {
            acted += 1;
            await delay(700);
          } else {
            // A refused fill is free, but capped — a model looping on a bad id must not spin forever.
            step -= 1;
            if (++waits > 24) {
              logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
              break;
            }
          }
          continue;
        }
        // ask: the agent needs something only the user knows (which account, a missing credential,
        // a code, a choice). Pause the run, surface the question in the spotlight, and resume with
        // the user's answer as an observation.
        if (action.action === 'ask' && typeof action.question === 'string' && action.question.trim()) {
          const question = action.question.trim();
          logAgent(tabId, { role: 'agent', text: question });
          setAgents((a) => ({ ...a, [tabId]: { ...a[tabId], running: true, log: a[tabId]?.log ?? [], ask: question } }));
          setSpotlight(tabId); // bring the chat up so the user sees the question
          const answer = await new Promise<string | null>((resolve) => {
            agentAskResolve.current[tabId] = resolve;
          });
          agentAskResolve.current[tabId] = undefined;
          setAgents((a) => ({ ...a, [tabId]: { ...a[tabId], running: a[tabId]?.running ?? true, log: a[tabId]?.log ?? [], ask: undefined } }));
          if (answer === null || agentCancel.current[tabId]) break;
          history.push({ action: 'asked user', reason: `${question} → ${answer}`.slice(0, 400) });
          step -= 1; // asking is free
          continue;
        }
        // remember: persist a durable fact for future sessions (Hermes-style memory).
        if (action.action === 'remember' && typeof action.text === 'string' && action.text.trim()) {
          const note = action.text.trim().slice(0, 500);
          void addMemory(note, undefined, tabId).catch(() => {});
          memory = `${memory}\n- ${note}`.slice(-1400); // reflect it immediately this run too
          logAgent(tabId, { role: 'agent', text: `Remembered: ${note.slice(0, 120)}` });
          history.push({ action: 'remembered', reason: note.slice(0, 80) });
          step -= 1; // remembering is free
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
          }
          continue;
        }
        // uploadFile: put one of the dropped files into a page file-input (e.g. attach a resume).
        // The manifest id (action.id) targets the exact input; the Nth-input fallback covers a
        // model that omitted it.
        if (action.action === 'uploadFile') {
          const files = allFiles();
          const file = files.find((f) => f.index === action.fileIndex) ?? files[0];
          const toji = (window as unknown as { toji?: { uploadToFileInput?: (id: number, filePath: string, inputIndex: number, elementId?: number) => Promise<boolean> } }).toji;
          let ok = false;
          if (file && toji?.uploadToFileInput) {
            try {
              // No manifest ids in screenshot mode, so this targets the page's first file input.
              ok = await toji.uploadToFileInput(wcId, file.path, 0, undefined);
            } catch {
              ok = false;
            }
          }
          logAgent(tabId, { role: ok ? 'agent' : 'system', text: ok ? `Uploaded ${file?.name}` : 'Could not upload the file (no file-input found).' });
          history.push({ action: 'uploadFile', reason: ok ? `uploaded ${file?.name}` : 'upload failed' });
          await delay(900);
          acted += 1;
          continue;
        }
        // Wait: do nothing and re-check. Poll the page signature so we resume as soon as the
        // opponent moves / the page updates, else pause the full interval. Waiting is "free" —
        // it doesn't consume the action budget — but is capped so it can't loop forever.
        if (action.action === 'wait') {
          waits += 1;
          const ms = Math.min(8000, Math.max(800, typeof action.ms === 'number' ? action.ms : 2500));
          // Poll a cheap in-page signature (NOT a byakugan diff — that would consume the change
          // before the model sees it) so we resume as soon as the page updates.
          let base = '';
          try {
            base = await wv.executeJavaScript(PAGE_SIGNATURE_JS, true);
          } catch {
            /* poll blindly */
          }
          const start = Date.now();
          while (Date.now() - start < ms) {
            if (agentCancel.current[tabId]) break;
            await delay(1000);
            let s = base;
            try {
              s = await wv.executeJavaScript(PAGE_SIGNATURE_JS, true);
            } catch {
              /* keep waiting */
            }
            if (s !== base) break;
          }
          history.push({ action: 'wait', reason: action.reason });
          step -= 1; // don't burn a real step on waiting
          if (waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Waited a long time without progress — stopping.' });
            break;
          }
          continue;
        }
        // Coordinates arrive in the screenshot's pixel space; the mouse works in the page's
        // CSS pixels, so every point is scaled through the capture that produced it.
        const point = (x: unknown, y: unknown) =>
          typeof x === 'number' && typeof y === 'number' ? toPagePoint(x, y, shot) : undefined;
        const target = point(action.x, action.y);
        // A pointing action with no point is unusable — bounce it back rather than
        // clicking (0,0), which lands on whatever happens to be in the corner.
        if ((action.action === 'click' || action.action === 'hover') && !target) {
          history.push({ action: 'note', reason: `${action.action} needs x and y in screenshot pixels — look again and give the centre of the target` });
          step -= 1;
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
          }
          continue;
        }
        try {
          if (action.action === 'navigate' && action.url) {
            navigateTab(tabId, toUrl(action.url));
            await delay(2000);
          } else if (action.action === 'click' && target) {
            await realClickAt(tabId, target.x, target.y);
            await delay(1100);
          } else if (action.action === 'hover' && target) {
            await glideCursor(tabId, target.x, target.y);
            await delay(700);
          } else if (action.action === 'type') {
            // Click first when a point is given, so the text lands in the intended field.
            if (target) {
              await realClickAt(tabId, target.x, target.y);
              await delay(350);
            }
            await typeText(tabId, String(action.text ?? ''));
            await delay(600);
          } else if (action.action === 'drag') {
            const from = point(action.fromX, action.fromY);
            const to = point(action.toX, action.toY);
            if (from && to) {
              await realDrag(tabId, from, to);
              await delay(1100);
            }
          } else {
            // press/scroll need no target and are dispatched in the main process.
            const verb = action.action;
            if (verb !== 'press' && verb !== 'scroll') {
              history.push({ action: 'note', reason: `your "${verb}" action was missing its required field (research needs query, ask needs question, remember needs text, fillCredential needs credentialId) — resend it complete` });
              step -= 1;
              if (++waits > 24) {
                logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
                break;
              }
              continue;
            }
            const res = await eyesAct(wcId, { verb, key: action.key, direction: action.direction });
            if (!res.ok) {
              logAgent(tabId, { role: 'system', text: `Couldn't ${verb}: ${res.error ?? 'action failed'}` });
              history.push({ action: `${verb} FAILED`, reason: (res.error ?? 'action failed').slice(0, 200) });
              step -= 1; // a refused action shouldn't burn the budget — the retry is the real step
              if (++waits > 24) {
                logAgent(tabId, { role: 'system', text: 'Too many blocked/non-acting steps — stopping.' });
                break;
              }
              continue;
            }
            await delay(verb === 'scroll' ? 700 : 500);
          }
        } catch {
          // keep going; the next screenshot reflects reality
        }
        acted += 1;
        const at = target ? ` ${target.x},${target.y}` : '';
        const label =
          action.action === 'drag'
            ? `drag ${Math.round(action.fromX ?? 0)},${Math.round(action.fromY ?? 0)}→${Math.round(action.toX ?? 0)},${Math.round(action.toY ?? 0)}`
            : `${action.action}${at}${action.key ? ` ${action.key}` : ''}`;
        history.push({ action: label, reason: action.reason });
      }
      setAgentCursor(null);
      if (!agentCancel.current[tabId]) {
        // Only report the step-limit message if we actually exhausted a finite limit; otherwise an
        // earlier break already logged the real reason (model failures, stuck, etc.).
        if (completed) logAgent(tabId, { role: 'system', text: 'Done.' });
        else if (Number.isFinite(maxSteps) && step >= maxSteps) logAgent(tabId, { role: 'system', text: 'Hit the step limit — raise it or turn off the limit to keep going.' });
      }
      setAgents((a) => ({ ...a, [tabId]: { running: false, log: a[tabId]?.log ?? [] } }));
    },
    [glideCursor, logAgent, navigateTab, realClickAt, realDrag]
  );

  // Only the theme changes. The AI pages carry both palettes and follow it through
  // prefers-color-scheme (see the theme effect), so nothing reloads or regenerates.
  const toggleTheme = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), []);

  // ---- Bug reports ----
  // Each window keeps a rolling recording of itself (lib/replayRecorder.ts) unless that is
  // switched off in Settings; private and Tor windows are never recorded. Help › Report a
  // Bug… (⌥⇧I) takes the clip and a still of the window, and opens the report sheet.
  const [replayOn, setReplayOn] = useState(replayEnabled);
  const [replayState, setReplayState] = useState<ReplayState>('idle');
  const recorderRef = useRef<ReplayRecorder | null>(null);
  const recordable = !activeContainer.ephemeral && activeContainer.egress !== 'tor';
  const replayLive = useRef({ on: replayOn, recordable, state: replayState });
  replayLive.current = { on: replayOn, recordable, state: replayState };
  useEffect(() => {
    const sync = () => setReplayOn(replayEnabled());
    const fromAnotherWindow = (event: StorageEvent) => {
      if (isReplayStorageKey(event.key)) sync();
    };
    window.addEventListener(REPLAY_EVENT, sync);
    window.addEventListener('storage', fromAnotherWindow);
    return () => {
      window.removeEventListener(REPLAY_EVENT, sync);
      window.removeEventListener('storage', fromAnotherWindow);
    };
  }, []);
  useEffect(() => {
    const sourceId = bridge().replaySourceId;
    // Not before the window has a profile (there is nothing to record yet, and it may turn
    // out private), and not at all while it is private or on Tor: the capture stops
    // outright, and whatever it held goes with it.
    if (!replayOn || profilePickerOpen || !recordable || !sourceId) return;
    const recorder = new ReplayRecorder(sourceId, setReplayState);
    recorderRef.current = recorder;
    void recorder.start();
    return () => {
      recorder.stop();
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, [replayOn, profilePickerOpen, recordable]);

  const [bugReport, setBugReport] = useState<BugReportRequest | null>(null);
  const bugReportOpen = useRef(false);
  const pickerOpenRef = useRef(profilePickerOpen);
  pickerOpenRef.current = profilePickerOpen;
  const openBugReport = useCallback(async () => {
    // Before the window has a profile there is nothing to report on, and the picker covers
    // the whole window, so a sheet opened now would only turn up later, out of date.
    if (bugReportOpen.current || pickerOpenRef.current) return;
    bugReportOpen.current = true;
    const recorder = recorderRef.current;
    recorder?.pause('report');
    const live = replayLive.current;
    const unavailable: BugReportRequest['unavailable'] = !live.on
      ? 'off'
      : !live.recordable
        ? 'private'
        : !recorder || live.state === 'unsupported' || live.state === 'failed'
          ? 'unsupported'
          : null;
    const clip = recorder && !unavailable ? recorder.snapshot().catch(() => null) : null;
    // The still is taken before the sheet paints over the window.
    const shot = (await bridge().captureWindow?.().catch(() => null)) ?? null;
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    setBugReport({
      clip,
      unavailable,
      screenshot: shot ? new Blob([shot.data as Uint8Array<ArrayBuffer>], { type: shot.type }) : null,
      pageUrl: tab && tab.mode === 'web' && !tab.internal && tab.url ? tab.url : null,
      context: { window: `${window.innerWidth}×${window.innerHeight}`, layout, theme }
    });
  }, [layout, theme]);
  const closeBugReport = useCallback(() => {
    bugReportOpen.current = false;
    setBugReport(null);
    recorderRef.current?.resume('report');
  }, []);
  useEffect(() => bridge().onReportBug?.(() => void openBugReport()), [openBugReport]);
  // The picker can come back mid-session (the window's profile was deleted); a report
  // open underneath it closes rather than reappearing stale afterwards.
  useEffect(() => {
    if (profilePickerOpen && bugReportOpen.current) closeBugReport();
  }, [closeBugReport, profilePickerOpen]);

  // A report finished on GitHub's own form: it opens in a tab beside this one, and once
  // the form is showing (after a sign-in, if need be) the files are dropped onto it.
  const [formReport, setFormReport] = useState<FormReport | null>(null);
  const formReportRef = useRef(formReport);
  formReportRef.current = formReport;
  const continueOnGitHub = useCallback((result: FormReportResult) => {
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    const tab = makeTab(from?.groupId ?? null, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
    tab.mode = 'web';
    tab.url = result.url;
    tab.query = result.url;
    tab.status = 'loading';
    tab.openerId = from?.id;
    setTabs((current) => insertTabAfter(current, from?.id, tab));
    setActiveId(tab.id);
    setFormReport(result.files.length || result.bodyOnClipboard ? { result, tabId: tab.id, status: 'waiting' } : null);
  }, []);
  const formTab = formReport ? tabs.find((t) => t.id === formReport.tabId) : undefined;
  const formPage = formReport && formTab ? issuePageState(formTab.url, formReport.result.url) : null;
  const formPageState = formPage?.state ?? null;
  const filedNumber = formPage?.state === 'filed' ? formPage.number : null;
  const formTabReady = formTab?.status === 'ready';
  const formTabGone = Boolean(formReport) && !formTab;
  useEffect(() => {
    if (formTabGone) setFormReport(null);
  }, [formTabGone]);
  const attachingReport = useRef(false);
  const attachReportFiles = useCallback(async () => {
    const report = formReportRef.current;
    const webContentsId = report ? webviewRefs.current[report.tabId]?.getWebContentsId?.() : undefined;
    if (!report || attachingReport.current || typeof webContentsId !== 'number') return;
    const reportId = report.result.reportId;
    attachingReport.current = true;
    setFormReport((current) => (current && current.result.reportId === reportId ? { ...current, status: 'attaching' } : current));
    const outcome = await bridge().attachBugReport?.(webContentsId, reportId).catch(() => null);
    attachingReport.current = false;
    setFormReport((current) =>
      current && current.result.reportId === reportId ? { ...current, status: outcome?.ok ? 'attached' : 'failed', error: outcome && !outcome.ok ? outcome.error : undefined } : current
    );
  }, []);
  useEffect(() => {
    if (!formReport) return;
    if (filedNumber !== null) {
      if (formReport.status !== 'filed') setFormReport({ ...formReport, status: 'filed', number: filedNumber });
      return;
    }
    if (formPageState === 'form' && formTabReady && formReport.status === 'waiting' && formReport.result.files.length) void attachReportFiles();
  }, [attachReportFiles, filedNumber, formPageState, formReport, formTabReady]);
  // Once GitHub shows the filed issue, the note lingers a moment, then goes.
  const formReportStatus = formReport?.status;
  useEffect(() => {
    if (formReportStatus !== 'filed') return;
    const timer = window.setTimeout(() => setFormReport(null), 6000);
    return () => window.clearTimeout(timer);
  }, [formReportStatus]);

  const canReload = Boolean(activeTab && (activeTab.url || activeTab.query.trim()));
  const activeBookmarked = Boolean(activeTab?.url && bookmarks.some((b) => b.url === activeTab.url));

  const torBar = activeContainer.egress === 'tor' ? <TorStatusBar container={activeContainer} status={torStatus} /> : null;
  const vaultBar = vaultPrompt ? (
    <VaultPromptBar prompt={vaultPrompt} container={findContainer(containers, vaultPrompt.containerId ?? undefined)} error={vaultPromptError} onDone={() => setVaultPrompt(null)} />
  ) : null;
  const profilePicker = profilePickerOpen ? (
    <WindowProfilePicker
      containers={containers}
      currentId={windowContainerId}
      onSelect={selectWindowContainer}
      onContainersChange={setContainers}
      onClose={windowContainerId ? () => setProfilePickerOpen(false) : undefined}
      onManage={() => {
        if (!windowContainerRef.current) selectWindowContainer(DEFAULT_CONTAINER_ID);
        else setProfilePickerOpen(false);
        openInternal('settings');
      }}
    />
  ) : null;

  const addressRow = (
    <AddressRow
      trafficLights={isMac}
      layout={layout}
      theme={theme}
      canBack={Boolean(activeTab?.canBack)}
      canForward={Boolean(activeTab?.canForward)}
      canReload={canReload}
      value={activeTab?.query ?? ''}
      onValueChange={(value) => activeTab && patchTab(activeTab.id, { query: value })}
      inputRef={inputRef}
      onGo={() => activeTab && go(activeTab.id, activeTab.query)}
      onAi={() => activeTab && go(activeTab.id, activeTab.query, { ai: true })}
      vaultButton={activeTab && <VaultFillButton matches={vaultMatches[activeTab.id] ?? []} onFill={(entryId) => fillCredential(activeTab.id, entryId)} />}
      star={activeTab?.mode === 'web' && activeTab.url ? { bookmarked: activeBookmarked, onToggle: () => void toggleBookmark(activeTab) } : null}
      torMode={torMode}
      onToggleTor={baseContainer.egress === 'tor' ? undefined : toggleWindowTor}
      vaultBar={vaultBar}
      onBack={goBack}
      onForward={goForward}
      onReload={reloadActive}
      onToggleLayout={() => setLayout((l) => (l === 'side' ? 'top' : 'side'))}
      onToggleTheme={toggleTheme}
      onSettings={() => openInternal('settings')}
      sidebarOpen={sidebarOpen}
    />
  );

  const landing = activeTab ? (
    <LandingSearch
      key={activeTab.id}
      tor={{ active: torMode, onToggle: baseContainer.egress === 'tor' ? undefined : toggleWindowTor }}
      onGo={(value) => go(activeTab.id, value)}
      onAi={(value) => go(activeTab.id, value, { ai: true })}
    />
  ) : null;

  const viewport = (
    <main className="relative flex min-h-0 flex-1">
      {/* All tabs stay mounted (hidden when inactive) so switching is instant and
          preserves state — web pages keep their scroll/session, and AI pages aren't
          regenerated. */}
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        // A tab with a RUNNING agent stays laid out + painted instead of display:none, so the
        // agent's clicks land (rects stay valid) and its JS keeps running — but at opacity 0
        // (not just a lower z-index) so it can't show through transparent surfaces like the
        // New Tab landing. Idle inactive tabs are hidden (asleep) as before.
        const keepAlive = !isActive && Boolean(agents[tab.id]?.running);
        const visibility = isActive ? 'flex z-10' : keepAlive ? 'flex z-0 opacity-0 pointer-events-none' : 'hidden';
        if (tab.internal) {
          return (
            <div key={tab.id} className={`absolute inset-0 ${visibility}`}>
              <InternalPage
                page={tab.internal}
                containers={containers}
                containerId={tab.containerId}
                onContainersChange={setContainers}
                onClearContainer={clearContainer}
                onOpenUrl={openWebTab}
                pendingQuery={tab.internal === 'plans' ? tab.query.trim() || undefined : undefined}
                onShowPlans={() => openInternal('plans')}
                onReportBug={() => void openBugReport()}
                onContinue={() => {
                  // Whatever they changed on the plans page decides where this goes, so
                  // re-check the gate before handing the question back.
                  void refreshPlanGate().then(() => generatePage(tab.id, tab.query));
                }}
                onGetStarted={() => {
                  localStorage.setItem('toji-onboarded', '1');
                  patchTab(tab.id, startBrowsingInTab(tab));
                  setActiveId(tab.id);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              />
            </div>
          );
        }
        if (tab.mode === 'web' && tab.url) {
          return (
            <div key={tab.id} className={`absolute inset-0 ${visibility}`}>
              <WebView
                key={`${tab.id}:${tab.reloadKey}:${tab.contextKey}:${tab.containerId}:${torMode ? 'tor' : 'direct'}`}
                url={tab.url}
                partition={tabPartition(tab)}
                loading={tab.status === 'loading'}
                onNavigate={(url) => patchTab(tab.id, { url, query: url })}
                onTitle={(title) => patchTab(tab.id, { title })}
                onLoadingChange={(l) => patchTab(tab.id, { status: l ? 'loading' : 'ready' })}
                onHistory={(canBack, canForward) => patchTab(tab.id, { canBack, canForward })}
                onFavicon={(favicon) => patchTab(tab.id, { favicon })}
                onGuestMessage={(channel, payload) => onGuestMessage(tab.id, channel, payload)}
                onRegister={(el) => registerWebview(tab.id, el)}
                tor={torMode}
                muted={Boolean(tab.muted)}
              />
            </div>
          );
        }
        if (tab.mode === 'page' && tab.streamUrl) {
          return (
            <div key={tab.id} className={`absolute inset-0 ${visibility}`}>
              <PageView streamUrl={tab.streamUrl} loading={tab.status === 'loading'} sources={tab.sources} onOpenSource={openWebTab} onReady={() => patchTab(tab.id, { status: 'ready' })} />
            </div>
          );
        }
        return null;
      })}
      {activeTab && activeTab.status === 'new' && <div className="absolute inset-0 flex">{landing}</div>}
    </main>
  );

  // Upload dropped files to the local server (so the CLI agent can read/upload them by path) and
  // attach them to this tab's agent with a stable index the model can reference.
  const addAgentFiles = useCallback(async (tabId: string, fileList: FileList | File[]) => {
    for (const file of Array.from(fileList)) {
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error('read failed'));
          reader.readAsDataURL(file);
        });
        const up = await uploadFile(file.name, file.type, dataBase64);
        setAgentFiles((m) => {
          const cur = m[tabId] ?? [];
          const index = cur.length ? Math.max(...cur.map((f) => f.index)) + 1 : 0;
          return { ...m, [tabId]: [...cur, { index, name: up.name, mime: up.mime, path: up.path }] };
        });
      } catch {
        /* skip files that fail to upload */
      }
    }
  }, []);
  const removeAgentFile = useCallback((tabId: string, index: number) => {
    setAgentFiles((m) => ({ ...m, [tabId]: (m[tabId] ?? []).filter((f) => f.index !== index) }));
  }, []);

  const agentSpotlight =
    spotlight &&
    (() => {
      const tab = tabs.find((t) => t.id === spotlight);
      if (!tab) return null;
      const target = tab.mode === 'web' ? (tab.title || (tab.url ? hostOf(tab.url) : 'this tab')) : tab.query.trim() || 'this tab';
      const agent = agents[tab.id];
      return (
        <AgentSpotlight
          target={target}
          // Center over the page area, not the whole window — lined up with the omnibox
          // behind it even while the sidebar takes the left edge.
          insetLeft={layout === 'side' && sidebarOpen ? 240 : 0}
          running={Boolean(agent?.running)}
          pendingAsk={agent?.ask}
          log={agent?.log ?? []}
          maxSteps={agentMaxSteps}
          noLimit={agentNoLimit}
          onMaxSteps={setAgentMaxSteps}
          onNoLimit={setAgentNoLimit}
          files={(agentFiles[tab.id] ?? []).map((f) => ({ index: f.index, name: f.name }))}
          onDropFiles={(fl) => void addAgentFiles(tab.id, fl)}
          onRemoveFile={(index) => removeAgentFile(tab.id, index)}
          onSubmit={(goal) => {
            // If the agent is paused on a question, this submission is the ANSWER — resume the run.
            const resolveAsk = agentAskResolve.current[tab.id];
            if (resolveAsk) {
              logAgent(tab.id, { role: 'you', text: goal });
              resolveAsk(goal);
              return; // keep the spotlight open so the user sees the agent continue
            }
            if (agents[tab.id]?.running) return; // don't start a second concurrent loop on this tab
            void runAgent(tab.id, goal);
            setSpotlight(null); // hide so you can watch the agent; reopen with right ⌥
          }}
          onStop={() => stopAgent(tab.id)}
          onClose={() => setSpotlight(null)}
        />
      );
    })();


  // Right-click menu for a tab — shared by the top tab strip AND the sidebar tab rows.
  const tabContextMenu = tabMenu && (
    <TabContextMenu
      menu={tabMenu}
      tabs={tabs}
      groups={groups}
      onDismiss={() => setTabMenu(null)}
      onDuplicate={duplicateTab}
      onReload={reloadTab}
      onResetContext={resetContext}
      onToggleMute={toggleMute}
      onNewGroup={createGroup}
      onAddToGroup={addTabToGroup}
      onUngroup={ungroupTab}
      onClose={closeTab}
      onCloseOthers={closeOtherTabs}
    />
  );

  // Which tabs the agent is driving — the side strip marks them the same way the top one does.
  const agentTabIds = new Set(Object.entries(agents).filter(([, a]) => a?.running).map(([id]) => id));

  const sidebarEl = (peek = false) => (
    <Sidebar
      tabs={tabs}
      groups={groups}
      activeId={activeId}
      peek={peek}
      onSelect={setActiveId}
      onClose={closeTab}
      onNewTab={openTab}
      onNewGroup={openTabInNewGroup}
      onNewAgentTab={openAgentTab}
      onToggleCollapse={() => {
        setSidebarOpen(peek);
        setSidebarPeek(false);
      }}
      onToggleGroup={toggleGroup}
      onRenameGroup={renameGroup}
      onRemoveGroup={removeGroup}
      onTabContextMenu={(tabId, x, y) => {
        setActiveId(tabId);
        setTabMenu({ x, y, tabId });
      }}
      onToggleMute={toggleMute}
      onReorderUngrouped={(ordered) =>
        setTabs((cur) => {
          // Drop the reordered ungrouped tabs back into their original slots, leaving grouped tabs put.
          let k = 0;
          return cur.map((t) => (t.groupId ? t : ordered[k++] ?? t));
        })
      }
      agentTabIds={agentTabIds}
    />
  );

  // The picker only ever shows before this window has an identity (fresh window, or
  // its profile was deleted underneath it) — a window's profile is fixed once chosen,
  // so there is no mid-session picker and nothing underneath worth keeping mounted.
  if (profilePickerOpen) {
    return (
      <div className="relative h-screen bg-white dark:bg-neutral-950">
        <div className="drag fixed inset-x-0 top-0 z-50 h-16" data-testid="profile-drag-region" aria-hidden />
        {profilePicker}
      </div>
    );
  }

  const bookmarksBar = (
    <BookmarksBar
      bookmarks={bookmarks}
      pinned={bookmarksPinned}
      onTogglePinned={() => setBookmarksBarPinned(!bookmarksPinned)}
      onOpen={(url) => activeTab && navigateTab(activeTab.id, url)}
      onOpenInNewTab={(url) => openWebTab(url, { background: true })}
      onRemove={(id) => void removeBookmark(id)}
    />
  );

  const topTabStrip = (
    <TopTabStrip
      tabs={tabs}
      groups={groups}
      activeId={activeId}
      trafficLights={isMac}
      agentTabIds={agentTabIds}
      onSelect={setActiveId}
      onClose={closeTab}
      onReorder={setTabs}
      onContextMenu={(tabId, x, y) => {
        setActiveId(tabId);
        setTabMenu({ x, y, tabId });
      }}
      onToggleMute={toggleMute}
      onNewTab={() => openTab(null)}
      onNewGroup={openTabInNewGroup}
      onNewAgentTab={openAgentTab}
      onCrowdedChange={setTopTabsCrowded}
    />
  );


  return (
    <BrowserFrame
      layout={layout}
      dragHandle={hasCustomTitleBar && <WindowDragHandle layout={layout} crowded={topTabsCrowded} />}
      topTabStrip={topTabStrip}
      addressRow={addressRow}
      bookmarksBar={bookmarksBar}
      bookmarksPinned={bookmarksPinned}
      bookmarksPeek={bookmarksPeek}
      torBar={torBar}
      sidebar={sidebarEl}
      sidebarOpen={sidebarOpen}
      sidebarPeek={sidebarPeek}
      onSidebarPeek={setSidebarPeek}
      viewport={viewport}
    >
      <AnimatePresence>{agentSpotlight}</AnimatePresence>
      <AnimatePresence>
        {bugReport && (
          <BugReportSheet
            key="bug-report"
            request={bugReport}
            insetLeft={layout === 'side' && sidebarOpen ? 240 : 0}
            onOpenUrl={(url) => openWebTab(url)}
            onOpenSettings={() => {
              closeBugReport();
              openInternal('settings');
            }}
            onContinueOnGitHub={continueOnGitHub}
            onClose={closeBugReport}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {formReport && formReport.tabId === activeId && (
          <BugReportTray
            key="bug-report-tray"
            report={formReport}
            onForm={formPageState === 'form'}
            onRetry={() => setFormReport((current) => (current ? { ...current, status: 'waiting', error: undefined } : current))}
            onDismiss={() => setFormReport(null)}
          />
        )}
      </AnimatePresence>
      <AgentCursor cursor={agentCursor} />
      {tabContextMenu}
    </BrowserFrame>
  );
}
