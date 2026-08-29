import { ArrowLeft, ArrowRight, Copy, FolderPlus, Moon, MousePointer2, PanelLeft, PanelTop, Plus, RefreshCcw, RotateCw, Search, Settings, Sun, WandSparkles, X } from 'lucide-react';
import { AnimatePresence, motion, Reorder } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AgentSpotlight, type AgentLogEntry } from './components/AgentSpotlight';
import { WindowProfilePicker } from './components/WindowProfilePicker';
import { TorHoldButton } from './components/TorHoldButton';
import { TorStatusBar } from './components/TorStatusBar';
import { VaultFillButton, VaultPromptBar } from './components/VaultBar';
import { InternalPage } from './components/InternalPage';
import { PageView } from './components/PageView';
import { Sidebar } from './components/Sidebar';
import { WebView } from './components/WebView';
import { addMemory, agentResearch, agentStep, fetchPageSources, getReferences, librarian, pageStreamUrl, uploadFile } from './lib/api';
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
import { bridge, type TorStatus, type VaultEntry, type VaultPrompt } from './lib/bridge';
import { revealDragHandle } from './lib/dragHandle';
import { replacePristineTabWithWelcome, startBrowsingInTab } from './lib/tabLifecycle';
import { tabTitle } from './lib/tabPresentation';
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
const STARTUP_CONTAINER_ID = new URLSearchParams(window.location.search).get('container');

/**
 * The New Tab landing's big search box. Deliberately holds its own text: it is NOT
 * mirrored into the toolbar omnibox (typing in one showing up in the other read as a
 * glitch, not a feature).
 */
function LandingSearch({ onGo, onAi, torActive, onTorToggle }: { onGo: (value: string) => void; onAi: (value: string) => void; torActive: boolean; onTorToggle?: () => void }) {
  const [value, setValue] = useState('');
  const submit = () => {
    if (value.trim()) onGo(value);
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[9vh]">
      <img src={ICON} alt="Toji" className="mb-5 h-[72px] w-[72px] rounded-[20px] shadow-sm" />
      <h1 className="mb-7 text-2xl font-semibold tracking-tight">Toji</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex h-14 w-[min(600px,92vw)] items-center rounded-full border border-black/10 bg-white pl-5 pr-1.5 shadow-sm transition dark:border-white/12 dark:bg-neutral-900 dark:focus-within:border-white/30"
      >
        <Search size={18} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              if (value.trim()) onAi(value);
            }
          }}
          placeholder="search or enter a url"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-neutral-400"
        />
        <button type="button" aria-label="Generate an AI page" title="Generate an AI page  ⇧↵" onClick={() => value.trim() && onAi(value)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white mr-1.5">
          <WandSparkles size={18} />
        </button>
        <span className="mr-1"><TorHoldButton active={torActive} onGo={submit} onToggle={onTorToggle} /></span>
      </form>
    </div>
  );
}

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

export function App() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [makeTab(null, STARTUP_CONTAINER_ID ?? DEFAULT_CONTAINER_ID)]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('toji-theme') === 'dark' ? 'dark' : 'light'));
  const [layout, setLayout] = useState<'top' | 'side'>(() => (localStorage.getItem('toji-layout') === 'side' ? 'side' : 'top'));
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('toji-sidebar') !== 'closed');
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [dragHandleVisible, setDragHandleVisible] = useState(false);
  const [topTabsCrowded, setTopTabsCrowded] = useState(false);
  const [draggingTopTabId, setDraggingTopTabId] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [containers, setContainers] = useState<Container[]>(loadContainers);
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
  const topTabStripRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => bridge().onVaultPrompt?.(setVaultPrompt), []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const baseContainer = findContainer(containers, windowContainerId ?? activeTab?.containerId);
  const torMode = baseContainer.egress === 'tor' || forceTor;
  const activeContainer: Container = torMode
    ? { ...baseContainer, egress: 'tor', ephemeral: forceTor || baseContainer.ephemeral }
    : baseContainer;
  useEffect(() => {
    if (torMode) void bridge().torStart?.();
  }, [torMode]);

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
    if (layout !== 'top') {
      setTopTabsCrowded(false);
      return;
    }
    const strip = topTabStripRef.current;
    if (!strip) return;
    const measure = () => {
      const items = Array.from(strip.querySelectorAll<HTMLElement>('[data-testid="top-tab"]'));
      const occupied = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) + Math.max(0, items.length - 1) * 4;
      setTopTabsCrowded(strip.clientWidth - occupied < 120);
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [layout, tabs.length]);
  // The window-drag notch reveals from the tracked cursor position streamed by the
  // main process, never from DOM hover: the top chrome is a native drag region, so
  // mouse events over it are swallowed by the OS (hover state there never fired, and
  // flickered once the notch — itself a drag region — appeared under the pointer).
  useEffect(() => {
    setDragHandleVisible(false);
    return bridge().onWindowCursor?.((cursor) => setDragHandleVisible((prev) => revealDragHandle(cursor, prev, layout)));
  }, [layout]);
  // Vertical wheel scrolls the horizontal tab strip. Registered natively because React
  // attaches onWheel as a PASSIVE listener, where preventDefault() is a no-op.
  useEffect(() => {
    if (layout !== 'top') return;
    const strip = topTabStripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [layout]);
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
  const openInternal = useCallback((page: 'settings' | 'welcome') => {
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
  const openWebTab = useCallback((url: string) => {
    const from = tabsRef.current.find((t) => t.id === activeRef.current);
    // A link opened from a page stays in that page's container, so following a link
    // never silently moves you into a different identity.
    const tab = makeTab(from?.groupId ?? null, windowContainerRef.current ?? DEFAULT_CONTAINER_ID);
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

  // Plain Enter searches/navigates like any browser (form submit); Shift+Enter asks the AI for an answer page.
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      if (activeTab) go(activeTab.id, activeTab.query, { ai: true });
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
    const { hasLogin } = (payload ?? {}) as { hasLogin?: boolean };
    if (!hasLogin) {
      setVaultMatches((m) => (m[tabId]?.length ? { ...m, [tabId]: [] } : m));
      return;
    }
    const webContentsId = webviewRefs.current[tabId]?.getWebContentsId?.();
    if (!webContentsId) return;
    void bridge()
      .vaultMatches?.(webContentsId)
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

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setTabs((current) => current.map((tab) => (tab.id === activeRef.current && tab.mode === 'page' && tab.query.trim() ? { ...tab, streamUrl: pageStreamUrl(tab.query, next), status: 'loading' } : tab)));
  }, [theme]);

  const canReload = Boolean(activeTab && (activeTab.url || activeTab.query.trim()));

  const iconBtn =
    'no-drag inline-flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-35 disabled:pointer-events-none';

  // The visible "grab here" notch, itself a native drag region. It mounts only while
  // revealDragHandle says the tracked cursor is near the top band (see the
  // onWindowCursor effect) — it must unmount when hidden, because a merely
  // transparent drag region would still steal clicks from the tabs beneath it.
  const windowDragHandle = (placement: 'side' | 'tabs') => (
    <div className={`drag-strip drag-strip-${placement}`} data-testid="window-drag-handle" aria-hidden>
      <span className="drag-notch">
        <span className="drag-grip">
          {Array.from({ length: 12 }, (_, i) => (
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
      <form onSubmit={onSubmit} className="no-drag flex h-9 flex-1 items-center rounded-full border border-black/[0.09] bg-black/[0.03] pl-3.5 pr-1 transition focus-within:bg-transparent dark:border-white/12 dark:bg-white/[0.04] dark:focus-within:border-white/30">
        <Search size={15} className="shrink-0 text-neutral-400 mr-2.5 mb-0.25" />
        <input
          ref={inputRef}
          value={activeTab?.query ?? ''}
          onChange={(e) => activeTab && patchTab(activeTab.id, { query: e.target.value })}
          onKeyDown={onSearchKeyDown}
          placeholder="search or enter a url"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
        {activeTab && <VaultFillButton matches={vaultMatches[activeTab.id] ?? []} onFill={(entryId) => fillCredential(activeTab.id, entryId)} />}
        <button type="button" aria-label="Generate an AI page" title="Generate an AI page  ⇧↵" onClick={() => activeTab && go(activeTab.id, activeTab.query, { ai: true })} className="inline-flex h-7 w-7 mr-1 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white">
          <WandSparkles size={15} />
        </button>
        <TorHoldButton compact active={torMode} onGo={() => activeTab && go(activeTab.id, activeTab.query)} onToggle={baseContainer.egress === 'tor' ? undefined : toggleWindowTor} />
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

  const landing = activeTab ? (
    <LandingSearch
      key={activeTab.id}
      torActive={torMode}
      onTorToggle={baseContainer.egress === 'tor' ? undefined : toggleWindowTor}
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
                onContainersChange={setContainers}
                onClearContainer={clearContainer}
                onOpenUrl={openWebTab}
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
      onReorderUngrouped={(ordered) =>
        setTabs((cur) => {
          // Drop the reordered ungrouped tabs back into their original slots, leaving grouped tabs put.
          let k = 0;
          return cur.map((t) => (t.groupId ? t : ordered[k++] ?? t));
        })
      }
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

  if (layout === 'side') {
    return (
      <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {dragHandleVisible && windowDragHandle('side')}
        <header className="drag relative shrink-0 border-b border-black/[0.07] px-3 pt-2.5 pb-2.5 dark:border-white/10">
          {addressRow}
          {vaultBar && <div className="mt-2">{vaultBar}</div>}
          {torBar}
        </header>
        <div className="relative flex min-h-0 flex-1">
          {sidebarOpen && sidebarEl()}
          {viewport}
          {!sidebarOpen && (
            <>
              <div className="absolute left-0 top-0 z-[70] h-full w-3" data-testid="sidebar-peek-trigger" onMouseEnter={() => setSidebarPeek(true)} />
              <AnimatePresence>
                {sidebarPeek && (
                  <motion.div
                    className="absolute left-0 top-0 z-[75] flex h-full bg-white dark:bg-neutral-950"
                    data-testid="sidebar-peek"
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
        <AnimatePresence>{agentSpotlight}</AnimatePresence>
        {agentCursorEl}
        {tabContextMenu}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {topTabsCrowded && dragHandleVisible && windowDragHandle('tabs')}
      <header className="drag relative shrink-0 border-b border-black/[0.07] px-3 pt-2.5 pb-2.5 dark:border-white/10">
        {/* Tabs sit at the very top (offset past the macOS traffic lights); the omnibox lives
            just beneath them, flush left since nothing overlaps it there. */}
        {/* Tabs are drag-reorderable along the X axis only (they live in a horizontal strip). */}
        <div className="flex h-9">
          {isMac && <div aria-hidden className="w-[82px] shrink-0" />}
          <Reorder.Group
            ref={topTabStripRef}
            as="div"
            axis="x"
            values={tabs}
            onReorder={setTabs}
            layoutScroll
            data-testid="top-tab-strip"
            className="tab-strip flex min-w-0 flex-1 select-none items-center gap-1 overflow-x-auto overflow-y-hidden"
          >
          {tabs.map((tab) => {
            const color = groupColor(tab.groupId);
            return (
              <Reorder.Item
                as="div"
                key={tab.id}
                value={tab}
                dragConstraints={topTabStripRef}
                dragElastic={0}
                dragMomentum={false}
                data-testid="top-tab"
                data-tab-id={tab.id}
                onClick={() => setActiveId(tab.id)}
                onDragStart={() => {
                  setDraggingTopTabId(tab.id);
                  setActiveId(tab.id);
                }}
                onDragEnd={() => setDraggingTopTabId(null)}
                onContextMenu={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  setActiveId(tab.id);
                  setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
                whileDrag={{ cursor: 'grabbing', zIndex: 90 }}
                className={`no-drag group relative flex h-8 w-[210px] min-w-[120px] max-w-[210px] flex-[1_1_210px] cursor-grab items-center gap-2 overflow-hidden rounded-xl px-2.5 transition-colors ${
                  draggingTopTabId === tab.id
                    ? 'top-tab-dragging bg-black/[0.06] dark:bg-white/[0.12]'
                    : tab.id === activeId
                      ? 'bg-black/[0.06] dark:bg-white/[0.12]'
                      : 'bg-black/[0.02] text-neutral-500 hover:bg-black/[0.035] dark:bg-white/[0.03] dark:text-neutral-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                {color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} /> : <TabFavicon tab={tab} />}
                <span className="flex-1 truncate text-[13px]">{tabTitle(tab)}</span>
                {agents[tab.id]?.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" title="Agent working" />}
                {tab.status === 'loading' && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" />}
                <button
                  type="button"
                  aria-label="Close tab"
                  onPointerDown={(event) => event.stopPropagation()}
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
          {/* New-tab sits right beside the last tab; once the row fills up it pins to the corner. */}
          {!topTabsCrowded && (
            <button type="button" aria-label="New tab" onClick={() => openTab(null)} className={`${iconBtn} ml-0.5 h-8 w-8 shrink-0`}>
              <Plus size={16} />
            </button>
          )}
          </Reorder.Group>
          {topTabsCrowded && (
            <button type="button" aria-label="New tab" onClick={() => openTab(null)} className={`${iconBtn} ml-1.5 h-8 w-8 shrink-0`}>
              <Plus size={16} />
            </button>
          )}
        </div>
        {/* Same 10px rhythm as the header's top/bottom padding, so all three gaps match. */}
        <div className="mt-2.5">{addressRow}</div>
        {vaultBar && <div className="mt-2">{vaultBar}</div>}
        {torBar}
      </header>
      {viewport}
      <AnimatePresence>{agentSpotlight}</AnimatePresence>
      {agentCursorEl}
      {tabContextMenu}
    </div>
  );
}
