import { ArrowLeft, ArrowRight, Copy, FolderPlus, Globe, Moon, MousePointer2, PanelLeft, PanelTop, Plus, RefreshCcw, RotateCw, Search, Settings, Sun, X } from 'lucide-react';
import { AnimatePresence, motion, Reorder } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AgentSpotlight, type AgentLogEntry } from './components/AgentSpotlight';
import { ContainerPicker } from './components/ContainerPicker';
import { TorStatusBar } from './components/TorStatusBar';
import { VaultFillButton, VaultPromptBar } from './components/VaultBar';
import { credentialDirectory, loadCredentials, resolveSecrets, saveCredentials, unresolvedPlaceholders, type CredentialStore } from './lib/credentials';
import { InternalPage } from './components/InternalPage';
import { PageView } from './components/PageView';
import { Sidebar } from './components/Sidebar';
import { WebView } from './components/WebView';
import { addMemory, agentResearch, agentStep, fetchPageSources, getReferences, librarian, pageStreamUrl, uploadFile } from './lib/api';
import { eyesAct, eyesAvailable, eyesDiff, eyesLook, eyesObserve, PAGE_SIGNATURE_JS, type EyesElement } from './lib/agentDom';
import {
  DEFAULT_CONTAINER_ID,
  findContainer,
  loadContainers,
  partitionFor,
  saveContainers,
  tabSessionPartition,
  type Container
} from './lib/containers';
import { hostOf, isOnionUrl, looksLikeUrl, toUrl, webSearchUrl, type SearchEngineId } from './lib/nav';
import { bridge, type TorStatus, type VaultEntry, type VaultPrompt } from './lib/bridge';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from './types';

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
// In Electron, Cmd+W / Cmd+T are owned by the app menu; the keydown fallback below is
// only for running the renderer in a plain browser during development.
const isElectron = Boolean((window as unknown as { toji?: unknown }).toji);
const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

/** A tab's icon: the site's favicon for web tabs (falling back to the Toji mark), else the Toji mark. */
function TabFavicon({ tab }: { tab: BrowserTab }) {
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [tab.favicon]);
  if (tab.mode === 'web' && tab.favicon && !errored) {
    return <img src={tab.favicon} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[4px]" onError={() => setErrored(true)} />;
  }
  return <img src={ICON} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[5px]" />;
}

// Alternates the side each cursor arc bows toward, so repeated moves don't look mechanical.
let bowSign = 1;
let counter = 0;
function makeTab(groupId: string | null = null, containerId: string = DEFAULT_CONTAINER_ID): BrowserTab {
  counter += 1;
  return { id: `tab-${Date.now()}-${counter}`, query: '', streamUrl: null, status: 'new', sources: [], groupId, mode: 'page', url: null, reloadKey: 0, contextKey: 0, containerId };
}

function tabTitle(tab: BrowserTab) {
  if (tab.internal) return tab.internal === 'settings' ? 'Settings' : 'Welcome to Toji';
  if (tab.mode === 'web') return tab.title || (tab.url ? hostOf(tab.url) : 'New Tab');
  const q = tab.query.trim();
  if (!q) return 'New Tab';
  return q.length > 24 ? `${q.slice(0, 24)}…` : q;
}

export function App() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [makeTab()]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('toji-theme') === 'dark' ? 'dark' : 'light'));
  const [layout, setLayout] = useState<'top' | 'side'>(() => (localStorage.getItem('toji-layout') === 'side' ? 'side' : 'top'));
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('toji-sidebar') !== 'closed');
  // Transient "peek": hovering the left edge opens the sidebar as an overlay until the mouse leaves.
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [containers, setContainers] = useState<Container[]>(loadContainers);
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveContainers(containers);
    // The main process enforces egress from the partition name alone, but it still
    // wants the table for labelling and for the Tor circuit pool.
    bridge().setContainers?.(containers);
  }, [containers]);

  // Tor runs in the main process; mirror its state so the UI can show what is reachable.
  useEffect(() => {
    void bridge().torStatus?.().then(setTorStatus);
    return bridge().onTorStatus?.(setTorStatus);
  }, []);

  // A login the user submitted; the password stays in the main process until they say so.
  useEffect(() => bridge().onVaultPrompt?.(setVaultPrompt), []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeContainer = findContainer(containers, activeTab?.containerId);

  const groupColor = (groupId: string | null) => {
    if (!groupId) return null;
    const idx = groups.findIndex((g) => g.id === groupId);
    return idx < 0 ? null : GROUP_COLORS[idx % GROUP_COLORS.length];
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('toji-theme', theme);
  }, [theme]);
  useEffect(() => localStorage.setItem('toji-layout', layout), [layout]);
  useEffect(() => localStorage.setItem('toji-sidebar', sidebarOpen ? 'open' : 'closed'), [sidebarOpen]);
  useEffect(() => {
    if (!tabMenu) return;
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setTabMenu(null);
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [tabMenu]);

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
      const container = findContainer(containersRef.current, tab.containerId);
      return tab.contextKey > 0 ? tabSessionPartition(container, tab.contextKey) : partitionFor(container, containerEpochs[container.id] ?? 0);
    },
    [containerEpochs]
  );

  /** Move a tab into another container. Its session changes, so the page reloads. */
  const setTabContainer = useCallback(
    (tabId: string, containerId: string) => {
      patchTab(tabId, (t) => ({ containerId, contextKey: 0, reloadKey: t.reloadKey + 1, status: t.url ? 'loading' : t.status }));
    },
    []
  );

  /** Wipe everything a container has stored, then reload the tabs sitting in it. */
  const clearContainer = useCallback((containerId: string) => {
    setContainerEpochs((e) => ({ ...e, [containerId]: (e[containerId] ?? 0) + 1 }));
    void bridge().clearContainer?.(containerId);
    setTabs((current) => current.map((t) => (t.containerId === containerId ? { ...t, contextKey: 0, reloadKey: t.reloadKey + 1 } : t)));
  }, []);

  // Navigate a tab to a real web URL (rendered by <webview> inside Toji).
  const navigateTab = useCallback(
    (tabId: string, url: string) => {
      patchTab(tabId, { mode: 'web', url, query: url, title: undefined, status: 'loading', sources: [], streamUrl: null });
    },
    [patchTab]
  );

  // Generate an AI answer page for a query.
  const generatePage = useCallback(
    (tabId: string, query: string) => {
      patchTab(tabId, { mode: 'page', url: null, query, streamUrl: pageStreamUrl(query, theme), status: 'loading', sources: [] });
      void fetchPageSources(query)
        .then((res) => patchTab(tabId, { sources: res.sources }))
        .catch(() => undefined);
    },
    [patchTab, theme]
  );

  // Omnibox submit. URLs always navigate; otherwise either a web search or an AI page.
  const go = useCallback(
    (tabId: string, raw: string, opts: { web?: boolean } = {}) => {
      const value = raw.trim();
      if (!value) return;
      if (looksLikeUrl(value)) {
        // A hidden service only resolves through Tor's own resolver, so a direct
        // container physically cannot load it. Move the tab into a Tor container
        // rather than letting it fail with a DNS error.
        if (isOnionUrl(value)) {
          const tab = tabsRef.current.find((t) => t.id === tabId);
          const here = findContainer(containersRef.current, tab?.containerId);
          if (here.egress !== 'tor') {
            const onion = containersRef.current.find((c) => c.egress === 'tor');
            if (onion) setTabContainer(tabId, onion.id);
          }
        }
        navigateTab(tabId, toUrl(value));
      }
      else if (opts.web) navigateTab(tabId, webSearchUrl(value, (localStorage.getItem('toji-search-engine') as SearchEngineId | null) ?? 'duckduckgo'));
      else generatePage(tabId, value);
    },
    [generatePage, navigateTab, setTabContainer]
  );

  const openTab = useCallback((groupId: string | null = null, containerId?: string) => {
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    const tab = makeTab(groupId, containerId ?? from?.containerId ?? DEFAULT_CONTAINER_ID);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Open (or focus) a built-in Toji page — Settings / Welcome — as a tab.
  const openInternal = useCallback((page: 'settings' | 'welcome') => {
    const existing = tabsRef.current.find((t) => t.internal === page);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    const tab = makeTab(from?.groupId ?? null, from?.containerId ?? DEFAULT_CONTAINER_ID);
    tab.internal = page;
    tab.status = 'ready';
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }, []);

  // First launch: show the welcome/onboarding page once.
  useEffect(() => {
    if (localStorage.getItem('toji-onboarded') !== '1') openInternal('welcome');
  }, [openInternal]);

  // Open an http(s) link (a source or an in-page link) as a new Toji web tab.
  const openWebTab = useCallback((url: string) => {
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    // A link opened from a page stays in that page's container, so following a link
    // never silently moves you into a different identity.
    const tab = makeTab(from?.groupId ?? null, from?.containerId ?? DEFAULT_CONTAINER_ID);
    tab.mode = 'web';
    tab.url = url;
    tab.query = url;
    tab.status = 'loading';
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }, []);

  // Links opened from the AI page iframe / webviews are routed here by the main process.
  useEffect(() => {
    const toji = (window as unknown as { toji?: { onOpenUrl?: (cb: (url: string) => void) => () => void } }).toji;
    return toji?.onOpenUrl?.(openWebTab);
  }, [openWebTab]);

  const closeTab = useCallback(
    (id: string) => {
      const current = tabsRef.current;
      if (current.length <= 1) {
        const toji = (window as unknown as { toji?: { quit?: () => void } }).toji;
        if (toji?.quit) toji.quit();
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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === 't' && !isElectron) {
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
  }, [closeTab, openTab]);

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

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (activeTab) go(activeTab.id, activeTab.query);
    inputRef.current?.blur();
  };

  // Plain Enter asks the AI (generates an answer page); Shift+Enter does a plain web search instead.
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      if (activeTab) go(activeTab.id, activeTab.query, { web: true });
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  const reloadTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const nextKey = tab.reloadKey + 1;
      if (tab.mode === 'web' && tab.url) {
        patchTab(tabId, { reloadKey: nextKey, status: 'loading' });
      } else if (tab.mode === 'page' && tab.query.trim()) {
        // Reload forces a fresh (uncached) regeneration.
        patchTab(tabId, { reloadKey: nextKey, streamUrl: pageStreamUrl(tab.query, theme, nextKey), status: 'loading' });
        void fetchPageSources(tab.query)
          .then((r) => patchTab(tabId, { sources: r.sources }))
          .catch(() => undefined);
      } else if (tab.query.trim()) {
        go(tabId, tab.query);
      }
    },
    [go, patchTab, theme]
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
  // Local credential vault (renderer-only; secrets are never sent to the model/server).
  const [credentials, setCredentials] = useState<CredentialStore>(loadCredentials);
  const credentialsRef = useRef(credentials);
  useEffect(() => {
    credentialsRef.current = credentials;
    saveCredentials(credentials);
  }, [credentials]);

  const agentLimitRef = useRef({ max: agentMaxSteps, noLimit: agentNoLimit });
  useEffect(() => {
    agentLimitRef.current = { max: agentMaxSteps, noLimit: agentNoLimit };
    localStorage.setItem('toji.agentMaxSteps', String(agentMaxSteps));
    localStorage.setItem('toji.agentNoLimit', agentNoLimit ? '1' : '0');
  }, [agentMaxSteps, agentNoLimit]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Messages from a tab's guest preload (see apps/desktop/guest-preload.cjs). */
  const onGuestMessage = useCallback((tabId: string, channel: string, payload: unknown) => {
    if (channel !== 'toji-vault:form') return;
    const { hasLogin, url } = (payload ?? {}) as { hasLogin?: boolean; url?: string };
    if (!hasLogin || !url) {
      setVaultMatches((m) => (m[tabId]?.length ? { ...m, [tabId]: [] } : m));
      return;
    }
    const tab = tabsRef.current.find((t) => t.id === tabId);
    void bridge()
      .vaultMatches?.(url, tab?.containerId ?? null)
      .then((result) => setVaultMatches((m) => ({ ...m, [tabId]: result?.ok ? result.value : [] })));
  }, []);

  /** Ask the main process to fill a credential into a tab's page. */
  const fillCredential = useCallback((tabId: string, entryId: string) => {
    const wv = webviewRefs.current[tabId] as unknown as { getWebContentsId?: () => number } | undefined;
    const wcId = wv?.getWebContentsId?.();
    if (wcId) void bridge().vaultFill?.(wcId, entryId);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerWebview = useCallback((tabId: string, el: any | null) => {
    if (el) webviewRefs.current[tabId] = el;
    else delete webviewRefs.current[tabId];
  }, []);

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

  // Run the agent loop on a specific tab. Perception + element actions go through byakugan
  // (main process, over CDP): a render-truthful manifest on step 1 and tiny diffs after,
  // with every click/type verified against fresh geometry — blocked actions come back as
  // "blocked by <element>" observations instead of clicking through.
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
      // Perception state: observe once (full manifest), then diff every step — byakugan holds the
      // stable-ID map in the main process. boundsById aims the animated cursor at act targets.
      let observedOnce = false;
      const boundsById = new Map<number, { x: number; y: number; w: number; h: number }>();
      // A look() the model requested last turn: null = none, {} = whole viewport, {id} = element crop.
      let pendingLook: { id?: number } | null = null;
      let stuck = 0;
      let waits = 0;
      let emptyViews = 0; // consecutive element-less manifests (SPA still hydrating)
      let completed = false;
      let acted = 0; // real (non-wait) actions performed so far
      let doneOverrides = 0; // times we've rejected a premature "done"
      let stepFailures = 0; // consecutive model-call failures
      let refusals = 0; // consecutive prose/refusal responses (model returned non-JSON)
      // Visual actions (clicking a canvas/board) change pixels but not the DOM, so the
      // signature can't see their effect — don't let them trip the "stuck" detector.
      let lastWasVisual = false;
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
              page: '(no page is open in this tab yet)',
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
        // Perceive through byakugan: a full render-truthful manifest on the first step, then only
        // a DIFF of what changed ("NO CHANGE" when idle) — byakugan itself falls back to a full
        // manifest on navigation or large change, and keeps element ids stable across steps.
        const view = observedOnce ? await eyesDiff(wcId) : await eyesObserve(wcId);
        if (agentCancel.current[tabId]) break;
        if (!view.ok || typeof view.text !== 'string') {
          stepFailures += 1;
          if (stepFailures >= 5) {
            logAgent(tabId, { role: 'system', text: `Could not read this page${view.error ? ` (${view.error})` : ''} — stopping.` });
            break;
          }
          await delay(600 * stepFailures);
          step -= 1;
          continue;
        }
        observedOnce = true;
        // SPAs (lichess, gmail, …) often finish "loading" before they render anything —
        // an empty manifest right after navigation means "not hydrated yet", not "blank
        // page". Re-observe briefly instead of asking the model to act on nothing.
        if ((view.elements?.length ?? 0) === 0 && emptyViews < 4) {
          emptyViews += 1;
          observedOnce = false; // next perception is a fresh full manifest
          await delay(900);
          step -= 1;
          continue;
        }
        if (view.elements?.length) emptyViews = 0;
        for (const el of view.elements ?? ([] as EyesElement[])) boundsById.set(el.id, el.bounds);
        // Stuck detection straight from the diff: "NO CHANGE" right after a real page action means
        // the action did nothing visible; three in a row means we're stuck. (The model sees the
        // same "NO CHANGE" as its PAGE, so it gets the signal too.)
        const noChange = view.text.trim() === 'NO CHANGE';
        if (step > 0 && noChange && !lastWasVisual) {
          stuck += 1;
        } else if (step > 0 && !noChange) {
          stuck = 0;
        }
        if (stuck >= 3) {
          logAgent(tabId, { role: 'system', text: "The page isn't responding to actions — stopping." });
          break;
        }
        // A look() the model requested last turn: capture the crop now — an element crop
        // when it named an id, else the whole visible viewport.
        let image: string | undefined;
        let crop: { x: number; y: number; w: number; h: number } | undefined;
        if (pendingLook) {
          const lk = await eyesLook(wcId, typeof pendingLook.id === 'number' ? { id: pendingLook.id } : undefined);
          if (lk.ok && lk.dataUri) {
            image = lk.dataUri;
            crop = lk.crop;
          } else {
            history.push({ action: 'note', reason: `look failed: ${lk.error ?? 'could not capture'}` });
          }
          pendingLook = null;
        }
        let action;
        try {
          action = await agentStep({
            goal,
            url: view.meta?.url ?? '',
            title: view.meta?.title,
            page: view.text,
            history: history.slice(-20),
            image,
            crop,
            viewport: view.meta ? { w: view.meta.viewport.width, h: view.meta.viewport.height } : undefined,
            credentials: credentialDirectory(credentialsRef.current),
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
        // runJS: the agent's escape hatch — evaluate its code in the page and feed the return
        // value back as an observation so it can derive things our extraction didn't capture
        // (e.g. measure a canvas board and compute square coordinates itself).
        if (action.action === 'runJS' && typeof action.code === 'string') {
          let result = '(no value)';
          try {
            const wrapped = `(() => { try { const __r = (function(){ ${action.code} })(); return __r === undefined ? '(no return)' : (typeof __r === 'string' ? __r : JSON.stringify(__r)); } catch (e) { return 'ERROR: ' + (e && e.message); } })()`;
            const raw = await wv.executeJavaScript(wrapped, true);
            result = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 1200);
          } catch {
            result = 'ERROR: could not run code';
          }
          history.push({ action: 'ranJS', reason: `returned: ${result}` });
          logAgent(tabId, { role: 'agent', text: `Ran code → ${result.slice(0, 200)}` });
          lastWasVisual = true; // inspecting code shouldn't count as a stuck/visual action
          step -= 1; // reading the page is cheap — don't burn the action budget
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many inspection steps — stopping.' });
            break;
          }
          continue;
        }
        // research: summon the research sub-agent for guidance when stuck/unsure, and feed its
        // answer back as an observation. General — works for any task.
        if (action.action === 'research' && typeof action.query === 'string') {
          logAgent(tabId, { role: 'agent', text: `Researching: ${action.query}` });
          let answer = '';
          try {
            const r = await agentResearch({ question: action.query, goal, url: view.meta?.url });
            answer = r.answer || '';
          } catch {
            answer = '';
          }
          const text = answer ? answer : 'No useful guidance found.';
          history.push({ action: 'researched', reason: `${action.query} → ${text}` });
          logAgent(tabId, { role: 'agent', text: `Guidance → ${text.slice(0, 240)}` });
          lastWasVisual = true;
          step -= 1; // research is an info-gathering step, not an action
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
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
          lastWasVisual = true; // pausing for input mustn't trip the stuck detector
          step -= 1; // asking is free
          continue;
        }
        // look: the agent decided it needs to SEE pixels — a cropped screenshot of one element
        // (or the viewport) is captured and attached next turn.
        if (action.action === 'look') {
          pendingLook = { id: typeof action.id === 'number' ? action.id : undefined };
          logAgent(tabId, { role: 'agent', text: typeof action.id === 'number' ? `Looking at [${action.id}]…` : 'Taking a look…' });
          history.push({ action: 'note', reason: 'look requested — the screenshot will be attached next turn' });
          lastWasVisual = true;
          step -= 1; // requesting a look is free
          if (++waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
            break;
          }
          continue;
        }
        // remember: persist a durable fact for future sessions (Hermes-style memory).
        if (action.action === 'remember' && typeof action.text === 'string' && action.text.trim()) {
          const note = action.text.trim().slice(0, 500);
          void addMemory(note, undefined, tabId).catch(() => {});
          memory = `${memory}\n- ${note}`.slice(-1400); // reflect it immediately this run too
          logAgent(tabId, { role: 'agent', text: `Remembered: ${note.slice(0, 120)}` });
          history.push({ action: 'remembered', reason: note.slice(0, 80) });
          lastWasVisual = true;
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
              ok = await toji.uploadToFileInput(wcId, file.path, 0, typeof action.id === 'number' ? action.id : undefined);
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
          lastWasVisual = true; // a no-op wait must not trip the stuck detector
          step -= 1; // don't burn a real step on waiting
          if (waits > 24) {
            logAgent(tabId, { role: 'system', text: 'Waited a long time without progress — stopping.' });
            break;
          }
          continue;
        }
        // Backstop: never type a {{placeholder}} that doesn't resolve to a saved credential — the
        // literal text would land in the page (e.g. "{{email}}" typed into Gmail). Bounce it back
        // to the model with the real credential directory so it asks the user instead.
        if (action.action === 'type' && unresolvedPlaceholders(action.text || '', credentialsRef.current).length) {
          const missing = unresolvedPlaceholders(action.text || '', credentialsRef.current);
          const dir = credentialDirectory(credentialsRef.current);
          const have = dir.length
            ? `The ONLY saved credentials are: ${dir.map((d) => `"${d.name}" (keys: ${d.keys.join(', ')})`).join('; ')}`
            : 'The user has NO saved credentials';
          logAgent(tabId, { role: 'system', text: `No saved credential matches ${missing.join(', ')} — the agent needs to ask you instead.` });
          history.push({ action: 'note', reason: `refused to type ${missing.join(', ')}: no such credential. ${have}. Use ask(question) to get what you need from the user.`.slice(0, 400) });
          lastWasVisual = true; // nothing was executed — don't trip the stuck detector
          step -= 1; // a blocked action shouldn't burn the budget — the retry is the real step
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
          } else if (action.action === 'clickAt' && typeof action.x === 'number' && typeof action.y === 'number') {
            // Raw pixel click for visual targets (canvas/board) with no manifest element.
            await realClickAt(tabId, action.x, action.y);
            await delay(1100);
          } else if (action.action === 'drag') {
            if (typeof action.fromX === 'number' && typeof action.fromY === 'number' && typeof action.toX === 'number' && typeof action.toY === 'number') {
              await realDrag(tabId, { x: action.fromX, y: action.fromY }, { x: action.toX, y: action.toY });
              await delay(1100);
            }
          } else {
            // Element/keyboard actions dispatched by byakugan in the main process: geometry is
            // re-resolved at click time and the target hit-tested, so a covered element is
            // REFUSED with {blockedBy} instead of clicked through.
            // Only real page verbs may reach the dispatcher. Anything else landing here is a
            // free-form action that arrived missing its required field (e.g. research with no
            // query) — bounce it back to the model instead of sending a bogus verb to byakugan.
            const verb = action.action;
            if (verb !== 'click' && verb !== 'type' && verb !== 'press' && verb !== 'select' && verb !== 'hover' && verb !== 'scroll') {
              history.push({ action: 'note', reason: `your "${verb}" action was missing its required field (research needs query, ask needs question, remember needs text, runJS needs code) — resend it complete` });
              lastWasVisual = true;
              step -= 1;
              if (++waits > 24) {
                logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
                break;
              }
              continue;
            }
            const needsId = verb === 'click' || verb === 'type' || verb === 'select' || verb === 'hover';
            if (needsId && typeof action.id !== 'number') {
              history.push({ action: 'note', reason: `${verb} needs an element id from the PAGE — e.g. click(17)` });
              lastWasVisual = true;
              step -= 1;
              if (++waits > 24) {
                logAgent(tabId, { role: 'system', text: 'Too many non-acting steps — stopping.' });
                break;
              }
              continue;
            }
            // Glide the visible cursor to the target — purely cosmetic; the verified dispatch in
            // the main process re-derives fresh coordinates itself.
            const b = typeof action.id === 'number' ? boundsById.get(action.id) : undefined;
            if (b) await glideCursor(tabId, Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2));
            // Substitute {{credential}} placeholders with the real secret HERE — at the last
            // moment, locally. The resolved value goes into the page, never to the model.
            const typed = verb === 'type' ? resolveSecrets(String(action.text ?? ''), credentialsRef.current) : undefined;
            const res = await eyesAct(wcId, { verb, id: action.id, text: typed, key: action.key, value: action.value, direction: action.direction });
            if (!res.ok) {
              const why = `${res.error ?? 'action failed'}${res.blockedBy ? ` — blocked by ${res.blockedBy}` : ''}`;
              // A stale id (element gone from the live page — dynamic sites churn constantly)
              // means the model's picture is out of date: re-ground it with a fresh FULL
              // manifest next turn instead of another diff against the world it mispredicted.
              const stale = (res.error ?? '').includes('no such element');
              if (stale) observedOnce = false;
              logAgent(tabId, { role: 'system', text: `Couldn't ${verb}${typeof action.id === 'number' ? ` [${action.id}]` : ''}: ${why}` });
              history.push({
                action: `${verb}${typeof action.id === 'number' ? ` [${action.id}]` : ''} FAILED`,
                reason: `${why}. ${stale ? 'That element is gone — a fresh PAGE manifest follows; pick from it.' : 'Deal with the blocker or pick a different element.'}`.slice(0, 300)
              });
              lastWasVisual = true; // nothing changed on the page
              step -= 1; // a refused action shouldn't burn the budget — the retry is the real step
              if (++waits > 24) {
                logAgent(tabId, { role: 'system', text: 'Too many blocked/non-acting steps — stopping.' });
                break;
              }
              continue;
            }
            if (verb === 'click') setAgentCursor((c) => (c ? { ...c, tick: c.tick + 1 } : c)); // ripple
            await delay(verb === 'click' ? 1100 : verb === 'type' ? 900 : verb === 'scroll' ? 700 : 500);
          }
        } catch {
          // keep going; the next diff reflects reality
        }
        acted += 1;
        // Canvas clicks/drags change pixels but often not the layout tree — don't trip "stuck".
        lastWasVisual = action.action === 'clickAt' || action.action === 'drag';
        const label =
          action.action === 'clickAt'
            ? `clickAt ${Math.round(action.x ?? 0)},${Math.round(action.y ?? 0)}`
            : action.action === 'drag'
                ? `drag ${Math.round(action.fromX ?? 0)},${Math.round(action.fromY ?? 0)}→${Math.round(action.toX ?? 0)},${Math.round(action.toY ?? 0)}`
                : `${action.action}${typeof action.id === 'number' ? ` [${action.id}]` : ''}${action.key ? ` ${action.key}` : ''}`;
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

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setTabs((current) => current.map((tab) => (tab.id === activeRef.current && tab.mode === 'page' && tab.query.trim() ? { ...tab, streamUrl: pageStreamUrl(tab.query, next), status: 'loading' } : tab)));
  }, [theme]);

  const isLanding = activeTab?.status === 'new';
  const canReload = Boolean(activeTab && (activeTab.url || activeTab.query.trim()));

  const iconBtn =
    'no-drag inline-flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-35 disabled:pointer-events-none';

  // A thin always-present drag region pinned to the very top of the window. Hovering
  // near the top slides a small "grip" pill down to signal you can grab here to move
  // the window — so the omnibox can sit flush at the top without a static title bar.
  // A thin invisible strip along the very top edge: hovering it pops down a little notch
  // handle (the ⠿ grip), and grabbing either the strip or the notch moves the window.
  const windowDragHandle = (
    <div className="drag-strip" aria-hidden>
      <span className="drag-notch">
        <span className="drag-grip">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      </span>
    </div>
  );

  const torBar = activeContainer.egress === 'tor' ? <TorStatusBar container={activeContainer} status={torStatus} /> : null;
  const vaultBar = vaultPrompt ? (
    <VaultPromptBar prompt={vaultPrompt} container={findContainer(containers, vaultPrompt.containerId ?? undefined)} onDone={() => setVaultPrompt(null)} />
  ) : null;

  const addressRow = (
    // In side-tab mode the omnibox row is the topmost row, so it needs the macOS traffic-light
    // offset (just enough to sit right beside them); in top-tab mode the TAB STRIP is above
    // it, so the row sits flush left.
    <div className={`flex items-center gap-1 ${isMac && layout === 'side' ? 'pl-[72px]' : ''}`}>
      <button type="button" aria-label="Back" title="Back  ⌘[" disabled={!activeTab?.canBack} onClick={goBack} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" aria-label="Forward" title="Forward  ⌘]" disabled={!activeTab?.canForward} onClick={goForward} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <ArrowRight size={15} />
      </button>
      <button type="button" aria-label="Reload" disabled={!canReload} onClick={reloadActive} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <RotateCw size={14} />
      </button>
      <ContainerPicker
        containers={containers}
        active={activeContainer}
        torReady={torStatus.ready}
        onSelect={(id) => activeTab && setTabContainer(activeTab.id, id)}
        onNewTabIn={(id) => openTab(activeTab?.groupId ?? null, id)}
        onClear={clearContainer}
        onManage={() => openInternal('settings')}
      />
      <form onSubmit={onSubmit} className="no-drag flex h-9 flex-1 items-center rounded-full border border-black/[0.09] bg-black/[0.03] pl-3.5 pr-1 transition focus-within:bg-transparent dark:border-white/12 dark:bg-white/[0.04] dark:focus-within:border-white/30">
        <Search size={15} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          ref={inputRef}
          value={activeTab?.query ?? ''}
          onChange={(e) => activeTab && patchTab(activeTab.id, { query: e.target.value })}
          onKeyDown={onSearchKeyDown}
          placeholder="Search, ask anything, or enter a URL"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
        {activeTab && <VaultFillButton matches={vaultMatches[activeTab.id] ?? []} onFill={(entryId) => fillCredential(activeTab.id, entryId)} />}
        <button type="button" aria-label="Search the web" title="Search the web" onClick={() => activeTab && go(activeTab.id, activeTab.query, { web: true })} className="inline-flex h-7 w-7 mr-1 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white">
          <Globe size={15} />
        </button>
        <button type="submit" aria-label="Go" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
          <ArrowRight size={15} />
        </button>
      </form>
      <button type="button" aria-label="Toggle tab layout" title={layout === 'side' ? 'Top tabs' : 'Side tabs'} onClick={() => setLayout((l) => (l === 'side' ? 'top' : 'side'))} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {layout === 'side' ? <PanelTop size={14} /> : <PanelLeft size={14} />}
      </button>
      <button type="button" aria-label="Toggle theme" onClick={toggleTheme} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button type="button" aria-label="Settings" title="Settings" onClick={() => openInternal('settings')} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        <Settings size={14} />
      </button>
    </div>
  );

  const landing = (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[9vh]">
      <img src={ICON} alt="Toji" className="mb-5 h-[72px] w-[72px] rounded-[20px] shadow-sm" />
      <h1 className="mb-7 text-2xl font-semibold tracking-tight">Toji</h1>
      <form onSubmit={onSubmit} className="flex h-14 w-[min(600px,92vw)] items-center rounded-full border border-black/10 bg-white pl-5 pr-1.5 shadow-sm transition dark:border-white/12 dark:bg-neutral-900 dark:focus-within:border-white/30">
        <Search size={18} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          value={activeTab?.query ?? ''}
          onChange={(e) => activeTab && patchTab(activeTab.id, { query: e.target.value })}
          onKeyDown={onSearchKeyDown}
          placeholder="Search the web, ask a question, or enter a URL…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-neutral-400"
        />
        <button type="button" aria-label="Search the web" title="Search the web" onClick={() => activeTab && go(activeTab.id, activeTab.query, { web: true })} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white mr-1.5">
          <Globe size={18} />
        </button>
        <button type="submit" aria-label="Go" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900 mr-1">
          <ArrowRight size={18} />
        </button>
      </form>
    </div>
  );

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
                store={credentials}
                onChange={setCredentials}
                containers={containers}
                onContainersChange={setContainers}
                onClearContainer={clearContainer}
                onOpenUrl={openWebTab}
                onGetStarted={() => {
                  localStorage.setItem('toji-onboarded', '1');
                  closeTab(tab.id);
                }}
              />
            </div>
          );
        }
        if (tab.mode === 'web' && tab.url) {
          return (
            <div key={tab.id} className={`absolute inset-0 ${visibility}`}>
              <WebView
                key={`${tab.id}:${tab.reloadKey}:${tab.contextKey}:${tab.containerId}`}
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

  // The agent's visible "own mouse" — glides to each target and ripples on click.
  const agentCursorEl =
    agentCursor &&
    createPortal(
      <motion.div className="pointer-events-none fixed left-0 top-0 z-[55]" animate={{ x: agentCursor.x, y: agentCursor.y }} transition={{ type: 'spring', stiffness: 240, damping: 24 }}>
        <MousePointer2 size={22} className="fill-white text-neutral-900 drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]" />
        <motion.span key={agentCursor.tick} className="absolute left-0 top-0 block h-5 w-5 rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.55)]" initial={{ scale: 0.3, opacity: 0.9 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 0.45 }} />
      </motion.div>,
      document.body
    );

  // Right-click menu for a tab — shared by the top tab strip AND the sidebar tab rows.
  const tabContextMenu =
    tabMenu &&
    (() => {
      const menuTab = tabs.find((t) => t.id === tabMenu.tabId);
      if (!menuTab) return null;
      const run = (fn: () => void) => () => {
        fn();
        setTabMenu(null);
      };
      const item =
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-black/[0.06] dark:text-neutral-200 dark:hover:bg-white/10';
      const sep = <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.08]" />;
      const otherGroups = groups.filter((g) => g.id !== menuTab.groupId);
      const hasContent = Boolean(menuTab.url || menuTab.query.trim());
      const left = Math.min(tabMenu.x, window.innerWidth - 224);
      const top = Math.min(tabMenu.y, window.innerHeight - 300);
      return createPortal(
        <>
          <div className="no-drag fixed inset-0 z-[100]" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div
            className="no-drag fixed z-[101] min-w-[200px] select-none rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
            style={{ left, top }}
          >
            <button type="button" className={item} onClick={run(() => duplicateTab(menuTab.id))}>
              <Copy size={14} /> Duplicate tab
            </button>
            {hasContent && (
              <button type="button" className={item} onClick={run(() => reloadTab(menuTab.id))}>
                <RotateCw size={14} /> Reload
              </button>
            )}
            {menuTab.mode === 'web' && menuTab.url && (
              <button type="button" className={item} onClick={run(() => resetContext(menuTab.id))}>
                <RefreshCcw size={14} /> Reset context
              </button>
            )}
            {sep}
            <button type="button" className={item} onClick={run(() => createGroup(menuTab.id))}>
              <FolderPlus size={14} /> New group
            </button>
            {otherGroups.map((g) => (
              <button key={g.id} type="button" className={item} onClick={run(() => addTabToGroup(menuTab.id, g.id))}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: GROUP_COLORS[groups.findIndex((x) => x.id === g.id) % GROUP_COLORS.length] }} />
                Add to {g.name}
              </button>
            ))}
            {menuTab.groupId && (
              <button type="button" className={item} onClick={run(() => ungroupTab(menuTab.id))}>
                <X size={14} /> Remove from group
              </button>
            )}
            {sep}
            <button type="button" className={item} onClick={run(() => closeTab(menuTab.id))}>
              <X size={14} /> Close tab
            </button>
            {tabs.length > 1 && (
              <button type="button" className={item} onClick={run(() => closeOtherTabs(menuTab.id))}>
                <X size={14} /> Close other tabs
              </button>
            )}
          </div>
        </>,
        document.body
      );
    })();

  // The sidebar element — reused both pinned-open and as the transient edge "peek". While
  // peeking, the collapse button becomes a PIN: pressing it keeps the sidebar open for good.
  const sidebarEl = (peek = false) => (
    <Sidebar
      tabs={tabs}
      groups={groups}
      activeId={activeId}
      peek={peek}
      onSelect={setActiveId}
      onClose={closeTab}
      onNewTab={openTab}
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
      onReorderUngrouped={(ordered) =>
        setTabs((cur) => {
          // Drop the reordered ungrouped tabs back into their original slots, leaving grouped tabs put.
          let k = 0;
          return cur.map((t) => (t.groupId ? t : ordered[k++] ?? t));
        })
      }
    />
  );

  if (layout === 'side') {
    return (
      <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {windowDragHandle}
        <header className="drag shrink-0 border-b border-black/[0.07] px-3 pt-2.5 pb-2.5 dark:border-white/10">
          {addressRow}
          {torBar && <div className="mt-2">{torBar}</div>}
        {vaultBar && <div className="mt-2">{vaultBar}</div>}
          {vaultBar && <div className="mt-2">{vaultBar}</div>}
        </header>
        <div className="relative flex min-h-0 flex-1">
          {sidebarOpen && sidebarEl()}
          {viewport}
          {!sidebarOpen && (
            <>
              {/* Thin left-edge trigger: hover to peek the sidebar open. */}
              <div className="absolute left-0 top-0 z-[70] h-full w-2" onMouseEnter={() => setSidebarPeek(true)} />
              <AnimatePresence>
                {sidebarPeek && (
                  <motion.div
                    // Looks exactly like the pinned sidebar (opaque, same border), just sliding
                    // in from the edge — no floating panel, no shadow.
                    className="absolute left-0 top-0 z-[75] flex h-full bg-white dark:bg-neutral-950"
                    onMouseLeave={() => setSidebarPeek(false)}
                    initial={{ x: -240 }}
                    animate={{ x: 0 }}
                    exit={{ x: -240 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                  >
                    {sidebarEl(true)}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
        {agentSpotlight}
        {agentCursorEl}
        {tabContextMenu}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {windowDragHandle}
      <header className="drag shrink-0 border-b border-black/[0.07] px-3 pt-2.5 pb-2.5 dark:border-white/10">
        {/* Tabs sit at the very top (offset past the macOS traffic lights); the omnibox lives
            just beneath them, flush left since nothing overlaps it there. */}
        {/* Tabs are drag-reorderable along the X axis only (they live in a horizontal strip). */}
        <Reorder.Group as="div" axis="x" values={tabs} onReorder={setTabs} className={`flex h-9 select-none items-center gap-1 overflow-x-auto ${isMac ? 'pl-[78px]' : ''}`}>
          {tabs.map((tab) => {
            const color = groupColor(tab.groupId);
            // Firefox-style container hint: a colored underline on any tab that isn't in
            // the default container, so you can never mistake which identity you're in.
            const container = findContainer(containers, tab.containerId);
            const containerAccent = container.id === DEFAULT_CONTAINER_ID ? null : container.color;
            return (
              <Reorder.Item
                as="div"
                key={tab.id}
                value={tab}
                onClick={() => setActiveId(tab.id)}
                onContextMenu={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  setActiveId(tab.id);
                  setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
                whileDrag={{ scale: 1.03, cursor: 'grabbing' }}
                title={container.id === DEFAULT_CONTAINER_ID ? undefined : `${tabTitle(tab)} — ${container.name}`}
                className={`no-drag group relative flex h-8 min-w-[120px] max-w-[210px] cursor-grab items-center gap-2 overflow-hidden rounded-xl px-2.5 transition-colors ${
                  tab.id === activeId ? 'bg-black/[0.06] dark:bg-white/[0.12]' : 'text-neutral-500 hover:bg-black/[0.035] dark:text-neutral-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                {containerAccent && <span aria-hidden className="pointer-events-none absolute inset-x-1.5 bottom-0 h-[2px] rounded-full" style={{ background: containerAccent }} />}
                {color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} /> : <TabFavicon tab={tab} />}
                <span className="flex-1 truncate text-[13px]">{tabTitle(tab)}</span>
                {agents[tab.id]?.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" title="Agent working" />}
                {tab.status === 'loading' && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" />}
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:bg-black/10 hover:text-neutral-900 dark:hover:bg-white/15 dark:hover:text-white"
                >
                  <X size={12} />
                </button>
              </Reorder.Item>
            );
          })}
          <button type="button" aria-label="New tab" onClick={() => openTab(null)} className={`${iconBtn} h-8 w-8 shrink-0`}>
            <Plus size={16} />
          </button>
        </Reorder.Group>
        {/* Same 10px rhythm as the header's top/bottom padding, so all three gaps match. */}
        <div className="mt-2.5">{addressRow}</div>
        {torBar && <div className="mt-2">{torBar}</div>}
      </header>
      {viewport}
      {agentSpotlight}
      {agentCursorEl}
      {tabContextMenu}
    </div>
  );
}
