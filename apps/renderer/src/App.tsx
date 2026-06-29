import { ArrowLeft, ArrowRight, Copy, FolderPlus, Globe, Moon, MousePointer2, PanelLeft, PanelLeftClose, PanelLeftOpen, PanelTop, Plus, RefreshCcw, RotateCw, Search, Settings, Sun, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AgentSpotlight, type AgentLogEntry } from './components/AgentSpotlight';
import { SettingsModal } from './components/SettingsModal';
import { credentialDirectory, loadCredentials, resolveSecrets, saveCredentials, type CredentialStore } from './lib/credentials';
import { PageView } from './components/PageView';
import { Sidebar } from './components/Sidebar';
import { WebView } from './components/WebView';
import { agentResearch, agentStep, fetchPageSources, pageStreamUrl } from './lib/api';
import { type AgentCell, CLEAR_MARKS_JS, locateScript, marksScript, PAGE_SIGNATURE_JS, scrollScript, SNAPSHOT_JS } from './lib/agentDom';
import { hostOf, looksLikeUrl, toUrl, webSearchUrl } from './lib/nav';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from './types';

interface AgentState {
  running: boolean;
  log: AgentLogEntry[];
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_AGENT_MAX_STEPS = 40;

const isMac = (window as unknown as { toji?: { platform?: string } }).toji?.platform === 'darwin';
// In Electron, Cmd+W / Cmd+T are owned by the app menu; the keydown fallback below is
// only for running the renderer in a plain browser during development.
const isElectron = Boolean((window as unknown as { toji?: unknown }).toji);
const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

// Alternates the side each cursor arc bows toward, so repeated moves don't look mechanical.
let bowSign = 1;
let counter = 0;
function makeTab(groupId: string | null = null): BrowserTab {
  counter += 1;
  return { id: `tab-${Date.now()}-${counter}`, query: '', streamUrl: null, status: 'new', sources: [], groupId, mode: 'page', url: null, reloadKey: 0, contextKey: 0 };
}

function tabTitle(tab: BrowserTab) {
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
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [hoverTab, setHoverTab] = useState<{ tabId: string; rect: DOMRect } | null>(null);
  const hoverShowTimer = useRef<number | null>(null);
  const hoverHideTimer = useRef<number | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
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
      if (looksLikeUrl(value)) navigateTab(tabId, toUrl(value));
      else if (opts.web) navigateTab(tabId, webSearchUrl(value));
      else generatePage(tabId, value);
    },
    [generatePage, navigateTab]
  );

  const openTab = useCallback((groupId: string | null = null) => {
    const tab = makeTab(groupId);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Open an http(s) link (a source or an in-page link) as a new Toji web tab.
  const openWebTab = useCallback((url: string) => {
    const tab = makeTab(tabsRef.current.find((t) => t.id === activeRef.current)?.groupId ?? null);
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
      if (id === activeRef.current) setActiveId(next[Math.min(index, next.length - 1)].id);
      const surviving = new Set(next.map((t) => t.groupId).filter(Boolean) as string[]);
      setGroups((gs) => gs.filter((g) => surviving.has(g.id)));
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
    const dup = makeTab(src.groupId);
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
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setAgents((a) => ({ ...a, [tabId]: { running: a[tabId]?.running ?? true, log: [...(a[tabId]?.log ?? []), entry] } }));
  }, []);

  const stopAgent = useCallback((tabId: string) => {
    agentCancel.current[tabId] = true;
    setAgentCursor(null);
    setAgents((a) => ({ ...a, [tabId]: { running: false, log: a[tabId]?.log ?? [] } }));
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

  // Real mouse click on a DOM element: locate it, then glide + click its center.
  const realClick = useCallback(
    async (tabId: string, index: number) => {
      const wv = webviewRefs.current[tabId];
      if (!wv) return false;
      let res;
      try {
        res = await wv.executeJavaScript(locateScript(index), true);
      } catch {
        return false;
      }
      if (!res?.ok || !res.rect) return false;
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      return clickPoint(tabId, cx, cy);
    },
    [clickPoint]
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
  // Each end can be an exact DOM element (by index) or absolute pixels (0..1 fractions accepted).
  const realDrag = useCallback(
    async (tabId: string, from: { index?: number; x?: number; y?: number }, to: { index?: number; x?: number; y?: number }) => {
      const wv = webviewRefs.current[tabId];
      if (!wv) return false;
      let size: { w: number; h: number };
      try {
        size = await wv.executeJavaScript('({ w: innerWidth, h: innerHeight })', true);
      } catch {
        return false;
      }
      const resolve = async (p: { index?: number; x?: number; y?: number }) => {
        if (typeof p.index === 'number') {
          try {
            const res = await wv.executeJavaScript(locateScript(p.index), true);
            if (res?.ok && res.rect) return { x: Math.round(res.rect.x + res.rect.w / 2), y: Math.round(res.rect.y + res.rect.h / 2) };
          } catch {
            /* fall through to pixels */
          }
        }
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          const frac = p.x <= 1 && p.y <= 1;
          return {
            x: Math.round(Math.max(0, Math.min(size.w, frac ? p.x * size.w : p.x))),
            y: Math.round(Math.max(0, Math.min(size.h, frac ? p.y * size.h : p.y)))
          };
        }
        return null;
      };
      const s = await resolve(from);
      const d = await resolve(to);
      if (!s || !d) return false;
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

  // Grab a screenshot of the tab's visible viewport as a data URI (for the vision step).
  // Only works while the tab is painting (i.e. it's the active tab); returns undefined
  // otherwise so the agent falls back to DOM-only reasoning.
  const captureScreenshot = useCallback(async (tabId: string): Promise<string | undefined> => {
    const wv = webviewRefs.current[tabId];
    if (!wv?.capturePage || tabId !== activeRef.current) return undefined;
    try {
      const img = await wv.capturePage();
      const size = img?.getSize?.();
      if (!size || !size.width) return undefined;
      // Downscale wide captures, then re-encode PNG→JPEG to cut the upload ~5-10x (big context
      // saving on the vision call). Falls back to the PNG if the canvas re-encode fails.
      const scaled = size.width > 1024 ? img.resize({ width: 1024 }) : img;
      const png = scaled.toDataURL();
      if (typeof png !== 'string' || png.length < 64) return undefined;
      const jpeg = await new Promise<string | undefined>((resolve) => {
        const im = new Image();
        im.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            const ctx = c.getContext('2d');
            if (!ctx) return resolve(undefined);
            ctx.drawImage(im, 0, 0);
            resolve(c.toDataURL('image/jpeg', 0.6));
          } catch {
            resolve(undefined);
          }
        };
        im.onerror = () => resolve(undefined);
        im.src = png;
      });
      return jpeg && jpeg.length > 64 ? jpeg : png;
    } catch {
      return undefined;
    }
  }, []);

  const realType = useCallback(
    async (tabId: string, index: number, text: string) => {
      const focused = await realClick(tabId, index);
      if (!focused) return false;
      const wv = webviewRefs.current[tabId];
      await delay(140);
      // Substitute any {{credential}} placeholders with the real secret HERE — at the last moment,
      // locally. The resolved value is typed into the page but was never in the model's context.
      const resolved = resolveSecrets(String(text), credentialsRef.current);
      try {
        for (const ch of resolved) wv.sendInputEvent({ type: 'char', keyCode: ch });
      } catch {
        return false;
      }
      return true;
    },
    [realClick]
  );

  // Run the agent loop on a specific tab. Uses real mouse/keyboard input so it works on
  // complex sites, detects when an action didn't change the page, and stops if stuck.
  const runAgent = useCallback(
    async (tabId: string, goal: string) => {
      agentCancel.current[tabId] = false;
      setAgents((a) => ({ ...a, [tabId]: { running: true, log: [...(a[tabId]?.log ?? []), { role: 'you', text: goal }] } }));
      const history: Array<{ action: string; reason?: string }> = [];
      let lastSig = '';
      let stuck = 0;
      let waits = 0;
      let completed = false;
      let acted = 0; // real (non-wait) actions performed so far
      let doneOverrides = 0; // times we've rejected a premature "done"
      let stepFailures = 0; // consecutive model-call failures
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
              elements: [],
              history: [...history, { action: 'note', reason: 'No website is open yet. Use "navigate" with the URL the goal needs to begin.' }]
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
        const onScreen = tabId === activeRef.current;
        let snap: { url: string; title: string; scrollY: number; maxScroll: number; elements: Array<{ i: number; tag: string; role: string; name: string; value?: string; rect?: { x: number; y: number; w: number; h: number } }>; cells: AgentCell[] };
        // Vision step on the visible tab: draw the Set-of-Marks overlay (numbered element
        // badges + a labeled grid on any board/canvas), capture it, then remove it — so the
        // model picks discrete labels with exact known coordinates instead of guessing pixels.
        let image: string | undefined;
        try {
          if (onScreen && wv.capturePage) {
            snap = await wv.executeJavaScript(marksScript(10), true);
            await delay(40); // let the overlay paint before the capture
            image = await captureScreenshot(tabId);
            try {
              await wv.executeJavaScript(CLEAR_MARKS_JS, true);
            } catch {
              /* overlay is re-drawn next step anyway */
            }
          } else {
            const s = await wv.executeJavaScript(SNAPSHOT_JS, true);
            snap = { ...s, cells: [] };
          }
        } catch {
          logAgent(tabId, { role: 'system', text: 'Could not read this page.' });
          break;
        }
        let sig = snap.url;
        try {
          sig = await wv.executeJavaScript(PAGE_SIGNATURE_JS, true);
        } catch {
          /* fall back to url */
        }
        if (step > 0 && sig === lastSig && !lastWasVisual) {
          stuck += 1;
          history.push({ action: 'note', reason: 'the previous action did not change the page' });
        } else if (step > 0) {
          stuck = 0;
        }
        lastSig = sig;
        if (stuck >= 3) {
          logAgent(tabId, { role: 'system', text: "The page isn't responding to actions — stopping." });
          break;
        }
        let viewport: { w: number; h: number } | undefined;
        if (image) {
          try {
            viewport = await wv.executeJavaScript('({ w: innerWidth, h: innerHeight })', true);
          } catch {
            /* optional */
          }
        }
        let action;
        try {
          action = await agentStep({ goal, url: snap.url, title: snap.title, scrollY: snap.scrollY, maxScroll: snap.maxScroll, elements: snap.elements, history, image, viewport, cells: snap.cells, credentials: credentialDirectory(credentialsRef.current) });
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
            const r = await agentResearch({ question: action.query, goal, url: snap.url });
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
        // Wait: do nothing and re-check. Poll the page signature so we resume as soon as the
        // opponent moves / the page updates, else pause the full interval. Waiting is "free" —
        // it doesn't consume the action budget — but is capped so it can't loop forever.
        if (action.action === 'wait') {
          waits += 1;
          const ms = Math.min(8000, Math.max(800, typeof action.ms === 'number' ? action.ms : 2500));
          const base = lastSig;
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
        try {
          if (action.action === 'navigate' && action.url) {
            navigateTab(tabId, toUrl(action.url));
            await delay(2000);
          } else if (action.action === 'type' && typeof action.index === 'number') {
            await realType(tabId, action.index, action.text || '');
            await delay(900);
          } else if (action.action === 'scroll') {
            await wv.executeJavaScript(scrollScript(action.direction === 'up' ? 'up' : 'down'), true);
            await delay(700);
          } else if (action.action === 'click' && typeof action.index === 'number') {
            await realClick(tabId, action.index);
            await delay(1100);
          } else if (action.action === 'clickAt' && typeof action.x === 'number' && typeof action.y === 'number') {
            await realClickAt(tabId, action.x, action.y);
            await delay(1100);
          } else if (action.action === 'drag') {
            // Resolve each end to coordinates: a board square ref (exact), an element index
            // (exact), or absolute pixels — in that order of preference.
            const endpoint = (cell?: string, index?: number, x?: number, y?: number) => {
              if (cell) {
                const c = snap.cells.find((k) => k.ref === cell);
                if (c) return { x: c.cx, y: c.cy };
              }
              if (typeof index === 'number') return { index };
              if (typeof x === 'number' && typeof y === 'number') return { x, y };
              return null;
            };
            const from = endpoint(action.fromCell, action.fromIndex, action.fromX, action.fromY);
            const to = endpoint(action.toCell, action.toIndex, action.toX, action.toY);
            if (from && to) {
              await realDrag(tabId, from, to);
              await delay(1100);
            }
          }
        } catch {
          // keep going; the next snapshot reflects reality
        }
        acted += 1;
        // Board/canvas clicks/drags change pixels but not the DOM, so don't let them trip "stuck".
        lastWasVisual = action.action === 'clickAt' || action.action === 'drag';
        const label =
          action.action === 'clickAt'
            ? `clickAt ${Math.round(action.x ?? 0)},${Math.round(action.y ?? 0)}`
            : action.action === 'drag'
                ? `drag ${action.fromCell ?? (typeof action.fromIndex === 'number' ? `#${action.fromIndex}` : `${Math.round(action.fromX ?? 0)},${Math.round(action.fromY ?? 0)}`)}→${action.toCell ?? (typeof action.toIndex === 'number' ? `#${action.toIndex}` : `${Math.round(action.toX ?? 0)},${Math.round(action.toY ?? 0)}`)}`
                : `${action.action}${typeof action.index === 'number' ? ` #${action.index}` : ''}`;
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
    [captureScreenshot, clickPoint, logAgent, navigateTab, realClick, realClickAt, realDrag, realType]
  );

  // Tab hover preview ("bubble"): delayed show, brief hide grace so the cursor can
  // travel into the bubble. Direction (down vs right) is chosen at render by layout.
  const showTabHover = useCallback((tabId: string, el: HTMLElement) => {
    if (hoverHideTimer.current) window.clearTimeout(hoverHideTimer.current);
    if (hoverShowTimer.current) window.clearTimeout(hoverShowTimer.current);
    const rect = el.getBoundingClientRect();
    hoverShowTimer.current = window.setTimeout(() => setHoverTab({ tabId, rect }), 300);
  }, []);
  const hideTabHover = useCallback(() => {
    if (hoverShowTimer.current) window.clearTimeout(hoverShowTimer.current);
    hoverHideTimer.current = window.setTimeout(() => setHoverTab(null), 140);
  }, []);
  const keepTabHover = useCallback(() => {
    if (hoverHideTimer.current) window.clearTimeout(hoverHideTimer.current);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setTabs((current) => current.map((tab) => (tab.id === activeRef.current && tab.mode === 'page' && tab.query.trim() ? { ...tab, streamUrl: pageStreamUrl(tab.query, next), status: 'loading' } : tab)));
  }, [theme]);

  const isLanding = activeTab?.status === 'new';
  const canReload = Boolean(activeTab && (activeTab.url || activeTab.query.trim()));

  const iconBtn =
    'no-drag inline-flex items-center justify-center rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-35 disabled:pointer-events-none';

  const addressRow = (
    <div className="flex items-center gap-1">
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
          placeholder="Search, ask anything, or enter a URL"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
        <button type="button" aria-label="Search the web" title="Search the web" onClick={() => activeTab && go(activeTab.id, activeTab.query, { web: true })} className="inline-flex h-7 w-7 mr-1 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-white">
          <Globe size={15} />
        </button>
        <button type="submit" aria-label="Go" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
          <ArrowRight size={15} />
        </button>
      </form>
      {layout === 'side' && !sidebarOpen && (
        <button type="button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarOpen(true)} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
          <PanelLeftOpen size={14} />
        </button>
      )}
      <button type="button" aria-label="Toggle tab layout" title={layout === 'side' ? 'Top tabs' : 'Side tabs'} onClick={() => setLayout((l) => (l === 'side' ? 'top' : 'side'))} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {layout === 'side' ? <PanelTop size={14} /> : <PanelLeft size={14} />}
      </button>
      <button type="button" aria-label="Toggle theme" onClick={toggleTheme} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button type="button" aria-label="Settings" title="Settings & credentials" onClick={() => setSettingsOpen(true)} className={`${iconBtn} h-9 w-9 border border-black/[0.08] dark:border-white/10`}>
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
        const visibility = tab.id === activeId ? 'flex' : 'hidden';
        if (tab.mode === 'web' && tab.url) {
          return (
            <div key={tab.id} className={`absolute inset-0 ${visibility}`}>
              <WebView
                key={`${tab.id}:${tab.reloadKey}:${tab.contextKey}`}
                url={tab.url}
                partition={`toji-ctx-${tab.id}-${tab.contextKey}`}
                loading={tab.status === 'loading'}
                onNavigate={(url) => patchTab(tab.id, { url, query: url })}
                onTitle={(title) => patchTab(tab.id, { title })}
                onLoadingChange={(l) => patchTab(tab.id, { status: l ? 'loading' : 'ready' })}
                onHistory={(canBack, canForward) => patchTab(tab.id, { canBack, canForward })}
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

  // A small circular "agent" button that appears on tab hover — below for top tabs,
  // to the right for sidebar tabs. Clicking it opens the agent spotlight for that tab.
  const tabHoverBubble =
    hoverTab &&
    (() => {
      const tab = tabs.find((t) => t.id === hoverTab.tabId);
      if (!tab) return null;
      const r = hoverTab.rect;
      const side = layout === 'side';
      const size = 34;
      const rawLeft = side ? r.right + 8 : r.left + r.width / 2 - size / 2;
      const rawTop = side ? r.top + r.height / 2 - size / 2 : r.bottom + 6;
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - size - 8));
      const top = Math.max(8, Math.min(rawTop, window.innerHeight - size - 8));
      const running = agents[tab.id]?.running;
      return createPortal(
        <motion.button
          type="button"
          onMouseEnter={keepTabHover}
          onMouseLeave={hideTabHover}
          onClick={() => {
            setHoverTab(null);
            setSpotlight(tab.id);
          }}
          title="Ask the agent to do something on this tab"
          initial={{ scale: 0.3, opacity: 0, y: side ? 0 : -6, x: side ? -6 : 0 }}
          animate={{ scale: 1, opacity: 1, y: 0, x: 0 }}
          transition={{ type: 'spring', stiffness: 520, damping: 20 }}
          whileHover={{ scale: 1.14, rotate: -6 }}
          whileTap={{ scale: 0.9 }}
          className="no-drag fixed z-[90] inline-flex items-center justify-center rounded-full border border-black/10 bg-white text-neutral-700 shadow-lg dark:border-white/12 dark:bg-neutral-800 dark:text-neutral-100"
          style={{ left, top, width: size, height: size }}
        >
          {running ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-[2px] border-current/30 border-t-current" />
          ) : (
            <MousePointer2 size={15} className="-translate-x-px" />
          )}
        </motion.button>,
        document.body
      );
    })();

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
          log={agent?.log ?? []}
          maxSteps={agentMaxSteps}
          noLimit={agentNoLimit}
          onMaxSteps={setAgentMaxSteps}
          onNoLimit={setAgentNoLimit}
          onSubmit={(goal) => {
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
        <motion.span key={agentCursor.tick} className="absolute left-0 top-0 block h-5 w-5 rounded-full border-2 border-violet-500" initial={{ scale: 0.3, opacity: 0.8 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 0.45 }} />
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

  if (layout === 'side') {
    return (
      <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {/* Draggable title strip — gives a grab area to move the window (and clears the macOS
            traffic lights), since the address bar below is full of non-draggable controls. */}
        <div className="drag h-7 shrink-0" />
        <header className="drag shrink-0 border-b border-black/[0.07] px-3 pb-2.5 dark:border-white/10">{addressRow}</header>
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && (
            <Sidebar
              tabs={tabs}
              groups={groups}
              activeId={activeId}
              onSelect={setActiveId}
              onClose={closeTab}
              onNewTab={openTab}
              onToggleCollapse={() => setSidebarOpen(false)}
              onToggleGroup={toggleGroup}
              onRenameGroup={renameGroup}
              onRemoveGroup={removeGroup}
              onTabHover={showTabHover}
              onTabHoverEnd={hideTabHover}
              onTabContextMenu={(tabId, x, y) => {
                setActiveId(tabId);
                setTabMenu({ x, y, tabId });
              }}
            />
          )}
          {viewport}
        </div>
        {tabHoverBubble}
        {agentSpotlight}
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} store={credentials} onChange={setCredentials} />
        {agentCursorEl}
        {tabContextMenu}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="drag shrink-0 border-b border-black/[0.07] px-3 pt-2 pb-2.5 dark:border-white/10">
        <div className={`flex h-9 select-none items-center gap-1 overflow-x-auto ${isMac ? 'pl-[72px]' : ''}`}>
          {tabs.map((tab) => {
            const color = groupColor(tab.groupId);
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                onMouseEnter={(e) => showTabHover(tab.id, e.currentTarget)}
                onMouseLeave={hideTabHover}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveId(tab.id);
                  setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
                className={`no-drag group flex h-8 min-w-[120px] max-w-[210px] cursor-pointer items-center gap-2 rounded-xl px-2.5 transition-colors ${
                  tab.id === activeId ? 'bg-black/[0.06] dark:bg-white/[0.12]' : 'text-neutral-500 hover:bg-black/[0.035] dark:text-neutral-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                {color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} /> : <img src={ICON} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[5px]" />}
                <span className="flex-1 truncate text-[13px]">{tabTitle(tab)}</span>
                {agents[tab.id]?.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" title="Agent working" />}
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
              </div>
            );
          })}
          <button type="button" aria-label="New tab" onClick={() => openTab(null)} className={`${iconBtn} h-8 w-8 shrink-0`}>
            <Plus size={16} />
          </button>
        </div>
        <div className="mt-2">{addressRow}</div>
      </header>
      {viewport}
      {tabHoverBubble}
      {agentSpotlight}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} store={credentials} onChange={setCredentials} />
      {agentCursorEl}
      {tabContextMenu}
    </div>
  );
}
