// The browser window's own UI in the Gecko browser: the Electron app's tab strip,
// address bar, bookmarks bar, sidebar and overlays, drawn from Firefox's tabs. Firefox
// keeps the tabs, pages, history and session (gBrowser); this draws them with the very
// components the Electron app used (BrowserFrame, TopTabStrip, AddressRow, Sidebar…), so
// the two cannot look different. The pages themselves sit underneath, in the viewport's
// place (see TojiShell.sys.mjs, which lays them out where the viewport reports it is).

import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AddressRow } from '../src/components/AddressRow';
import { AgentCursor, type AgentCursorAt } from '../src/components/AgentCursor';
import { AgentSpotlight } from '../src/components/AgentSpotlight';
import { BookmarksBar } from '../src/components/BookmarksBar';
import { BrowserFrame } from '../src/components/BrowserFrame';
import { BugReportSheet, type BugReportRequest } from '../src/components/BugReportSheet';
import { BugReportTray, type FormReport } from '../src/components/BugReportTray';
import { LoadErrorPage } from '../src/components/LoadErrorPage';
import { PageSources } from '../src/components/PageSources';
import { Sidebar } from '../src/components/Sidebar';
import { TabContextMenu, type TabMenuAt } from '../src/components/TabContextMenu';
import { TopTabStrip } from '../src/components/TopTabStrip';
import { TorStatusBar } from '../src/components/TorStatusBar';
import { VaultFillButton, VaultPromptBar } from '../src/components/VaultBar';
import { WindowDragHandle } from '../src/components/WindowDragHandle';
import { WindowProfilePicker } from '../src/components/WindowProfilePicker';
import { fetchPageSources, type Bookmark } from '../src/lib/api';
import { bridge, type BridgeContainer, type TorStatus, type VaultEntry, type VaultPrompt } from '../src/lib/bridge';
import { DEFAULT_CONTAINER_ID, findContainer, type Container } from '../src/lib/containers';
import { geckoLoadFailure } from '../src/lib/loadError';
import { hostOf, isBrowserAddress, looksLikeUrl, toUrl } from '../src/lib/nav';
import { tabTitle } from '../src/lib/tabPresentation';
import { useBookmarksPeek } from '../src/lib/useBookmarksPeek';
import type { BrowserTab, PageSource } from '../src/types';
import { shellHost, type ShellPrefs, type ShellReportTray, type ShellTabInfo, type ViewportRect } from './shellHost';
import { tabKind, toBrowserTab } from './shellTabs';

const sameRect = (a: ViewportRect | null, b: ViewportRect) => Boolean(a) && a!.x === b.x && a!.y === b.y && a!.width === b.width && a!.height === b.height;
// Unrounded: the page's edges meet the header's and the sidebar's exactly.
const rectOf = (el: Element): ViewportRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/**
 * Firefox's tabs as the Electron app's tab objects, keeping each object as long as
 * nothing about its tab changed. Motion's reordering follows tabs by object identity,
 * so a tab dragged along the strip must stay the same object while Firefox moves it.
 */
function useStableTabs(infos: ShellTabInfo[], containerId: string, typed: Record<string, string>): BrowserTab[] {
  const cache = useRef(new Map<string, { key: string; tab: BrowserTab }>());
  return useMemo(() => {
    const next = new Map<string, { key: string; tab: BrowserTab }>();
    const tabs = infos.map((info) => {
      const context = { containerId, groupId: info.groupId, query: typed[info.id] };
      const key = JSON.stringify([info, context]);
      const hit = cache.current.get(info.id);
      const entry = hit && hit.key === key ? hit : { key, tab: toBrowserTab(info, context) };
      next.set(info.id, entry);
      return entry.tab;
    });
    cache.current = next;
    return tabs;
  }, [infos, containerId, typed]);
}

export function GeckoShell({ root }: { root: HTMLElement }) {
  const host = shellHost();
  const isMac = host.platform === 'darwin';
  const [state, setState] = useState(() => host.state());
  const [prefs, setPrefs] = useState<ShellPrefs>(() => host.prefs());
  const [containers, setContainers] = useState<BridgeContainer[]>(() => host.containers());
  useEffect(() => host.onState(setState), [host]);
  useEffect(() => host.onPrefs(setPrefs), [host]);
  useEffect(() => host.onContainers(setContainers), [host]);
  const { theme, layout, sidebarOpen } = prefs;
  const bookmarksPinned = prefs.bookmarksBar === 'pinned';
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const bookmarksPeek = useBookmarksPeek(bookmarksPinned);
  const [topTabsCrowded, setTopTabsCrowded] = useState(false);
  const [tabMenu, setTabMenu] = useState<TabMenuAt | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const holeRef = useRef<HTMLDivElement>(null);

  // Groups are the window's own, as they were in the Electron app: a colour and a name
  // over some of its tabs. The browser keeps them with the session (a duplicated,
  // reopened or restored tab keeps its group), so they come with the tabs.
  const groups = state.groups;
  // What is typed into the omnibox, per tab, until that tab goes somewhere.
  const [typed, setTyped] = useState<Record<string, string>>({});
  // Tabs whose question has been asked and whose answer page hasn't started loading.
  const [asking, setAsking] = useState<Record<string, true>>({});
  const lastUrl = useRef<Record<string, string>>({});

  const containerId = state.containerId;
  const windowContainer: Container = (state.container as Container | null) ?? findContainer(containers as Container[], containerId ?? undefined);
  const tabs = useStableTabs(state.tabs, containerId ?? DEFAULT_CONTAINER_ID, typed);
  const activeId = state.selectedId ?? tabs[0]?.id ?? '';
  const activeTab = tabs.find((t) => t.id === activeId);
  const activeInfo = state.tabs.find((t) => t.id === activeId);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Hold-to-Tor is a Tor container of its own (temporary), so the route is the container's.
  const torMode = windowContainer.egress === 'tor';
  const canToggleTor = !torMode || Boolean(state.container?.temporary);

  // A tab that went somewhere shows where it went; what was typed into it is dropped.
  useEffect(() => {
    const gone: string[] = [];
    for (const info of state.tabs) {
      if (lastUrl.current[info.id] !== undefined && lastUrl.current[info.id] !== info.url) gone.push(info.id);
      lastUrl.current[info.id] = info.url;
    }
    const alive = new Set(state.tabs.map((t) => t.id));
    for (const id of Object.keys(lastUrl.current)) if (!alive.has(id)) delete lastUrl.current[id];
    const drop = <T,>(current: Record<string, T>) => {
      const stale = Object.keys(current).filter((id) => gone.includes(id) || !alive.has(id));
      if (!stale.length) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    };
    setTyped(drop);
    // An answer that started loading shows the tab's own loading state from then on.
    const started = new Set(state.tabs.filter((t) => t.busy).map((t) => t.id));
    setAsking((current) => {
      const next = drop(current);
      return Object.keys(next).some((id) => started.has(id)) ? Object.fromEntries(Object.entries(next).filter(([id]) => !started.has(id))) : next;
    });
  }, [state.tabs]);

  // The theme is the whole window's: the shell here, every page through
  // prefers-color-scheme (TojiStartup follows the same pref).
  useEffect(() => {
    root.classList.toggle('dark', theme === 'dark');
  }, [root, theme]);

  // Where the pages go: the box the viewport takes, reported whenever it moves.
  const viewportSent = useRef<ViewportRect | null>(null);
  const anchorSent = useRef<ViewportRect | null>(null);
  const measure = useCallback(() => {
    const hole = holeRef.current;
    if (hole) {
      const rect = rectOf(hole);
      if (!sameRect(viewportSent.current, rect)) {
        viewportSent.current = rect;
        host.setViewport(rect);
      }
    }
    const input = inputRef.current;
    const page = holeRef.current?.getBoundingClientRect();
    if (input || page) {
      // Firefox's prompts hang from the left end of the address bar, under its icon (in a
      // popup, which has none, from the top left of the page).
      const r = input?.getBoundingClientRect();
      const anchor = r ? { x: Math.round(r.left - 18), y: Math.round(r.bottom + 6), width: 16, height: 1 } : { x: Math.round(page!.left + 12), y: Math.round(page!.top + 4), width: 16, height: 1 };
      if (!sameRect(anchorSent.current, anchor)) {
        anchorSent.current = anchor;
        host.setPromptAnchor(anchor);
      }
    }
  }, [host]);
  useLayoutEffect(measure);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (holeRef.current) observer.observe(holeRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, containerId]);

  // Firefox asks for the address bar: ⌘L, a new tab, a new window.
  useEffect(
    () =>
      host.onFocusOmnibox((select) => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        if (select) input.select();
      }),
    [host]
  );

  // ---- Tabs ----
  const setQuery = useCallback((tabId: string, query: string) => setTyped((t) => ({ ...t, [tabId]: query })), []);

  // Omnibox submit. Addresses load; anything else is a web search, or with Shift+Enter
  // (or the wand) an AI answer page. A .onion address moves the window to Tor on its
  // own (TojiTorUI watches for it).
  const go = useCallback(
    (tabId: string, raw: string, opts: { ai?: boolean } = {}) => {
      const value = raw.trim();
      if (!value) return;
      // An address opens even with Shift+Enter or the wand, as in the Electron app; the
      // browser's own (about:settings…) open as typed.
      if (isBrowserAddress(value)) {
        setQuery(tabId, value);
        host.load(tabId, value);
      } else if (looksLikeUrl(value)) {
        const url = toUrl(value);
        setQuery(tabId, url);
        host.load(tabId, url);
      } else if (opts.ai) {
        setQuery(tabId, value);
        // Loading from now: the browser may first wait for the agent server.
        setAsking((a) => ({ ...a, [tabId]: true }));
        window.setTimeout(() => setAsking(({ [tabId]: _done, ...rest }) => rest), 20000);
        host.ask(tabId, value);
      } else {
        setQuery(tabId, host.search(tabId, value));
      }
    },
    [host, setQuery]
  );

  const openTab = useCallback(
    (groupId: string | null = null) => {
      const id = host.newTab();
      if (groupId) host.setTabGroup(id, groupId);
      return id;
    },
    [host]
  );
  const openTabInNewGroup = useCallback(() => {
    host.createGroup([host.newTab()]);
  }, [host]);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  // The spotlight takes the keys on this one, not the omnibox.
  const openAgentTab = useCallback(() => {
    const id = host.newTab({ focusOmnibox: false });
    setSpotlight(id);
  }, [host]);
  const closeTab = useCallback((id: string) => host.close(id), [host]);
  const createGroup = useCallback((tabId?: string) => void host.createGroup([tabId ?? activeRef.current]), [host]);
  const removeGroup = useCallback((id: string) => host.removeGroup(id), [host]);
  const addTabToGroup = useCallback((tabId: string, groupId: string) => host.setTabGroup(tabId, groupId), [host]);
  const ungroupTab = useCallback((tabId: string) => host.setTabGroup(tabId, null), [host]);
  const toggleGroup = useCallback((id: string) => host.toggleGroup(id), [host]);
  const renameGroup = useCallback((id: string, name: string) => host.renameGroup(id, name), [host]);
  // The groups of the closed tabs go with them.
  const closeOtherTabs = useCallback((tabId: string) => host.closeOthers(tabId), [host]);
  const reloadTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const info = state.tabs.find((t) => t.id === tabId);
      const kind = info ? tabKind(info.url) : null;
      // An answer page reloads as a fresh answer, never the saved one (the browser
      // marks the reload), with its sources looked up again.
      if (kind?.kind === 'answer') {
        setSources(({ [kind.query]: _stale, ...rest }) => rest);
        host.reload(tabId);
      } else if (tab.mode === 'web' && tab.url) host.reload(tabId);
      else if (tab.query.trim()) go(tabId, tab.query);
    },
    [go, host, state.tabs]
  );
  const toggleMute = useCallback((tabId: string) => host.toggleMute(tabId), [host]);
  const openInternal = useCallback((page: 'settings' | 'welcome' | 'plans') => host.openPage(page), [host]);
  const openWebTab = useCallback((url: string, options: { background?: boolean } = {}) => host.openTab(url, options), [host]);

  // ---- Bookmarks (Firefox's bookmarks toolbar) ----
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    const refresh = () => void host.bookmarks().then(setBookmarks, () => {});
    refresh();
    return host.onBookmarksChanged(refresh);
  }, [host]);
  const activeBookmarked = Boolean(activeTab?.url && bookmarks.some((b) => b.url === activeTab.url));
  // The page's pointer at its top edge shows the unpinned bar, as the gap under the address
  // bar does. Leaving the edge only cancels a bar still waiting to show: once the bar is down
  // it covers the edge, the page reports the pointer gone (late, over IPC) while it is on the
  // bar, and the bar's own hover decides when it goes.
  const peekOpenRef = useRef(bookmarksPeek.open);
  peekOpenRef.current = bookmarksPeek.open;
  useEffect(
    () =>
      host.onPageTopEdge((inside) => {
        if (inside) bookmarksPeek.show();
        else if (!peekOpenRef.current) bookmarksPeek.hide();
      }),
    [host, bookmarksPeek.show, bookmarksPeek.hide]
  );

  // ---- Tor ----
  const [torStatus, setTorStatus] = useState<TorStatus>({ ready: false, state: 'off', progress: 0, detail: 'Tor is not running' });
  useEffect(() => {
    void bridge().torStatus?.().then(setTorStatus);
    return bridge().onTorStatus?.(setTorStatus);
  }, []);

  // ---- Vault ----
  const [vaultMatches, setVaultMatches] = useState<Record<string, VaultEntry[]>>({});
  const [vaultPrompt, setVaultPrompt] = useState<{ prompt: VaultPrompt; error?: string } | null>(null);
  useEffect(() => host.onVaultMatches((tabId, matches) => setVaultMatches((m) => ({ ...m, [tabId]: matches }))), [host]);
  useEffect(() => host.onVaultPrompt((prompt, error) => setVaultPrompt(prompt ? { prompt, error } : null)), [host]);

  // ---- The web agent ----
  const [, setAgentTick] = useState(0);
  useEffect(() => host.onAgent(() => setAgentTick((n) => n + 1)), [host]);
  const [agentCursor, setAgentCursor] = useState<AgentCursorAt | null>(null);
  useEffect(
    () =>
      host.onAgentPointer((pointer) =>
        setAgentCursor((c) => (pointer ? { x: pointer.x, y: pointer.y, tick: (c?.tick ?? 0) + (pointer.pressed ? 1 : 0) } : null))
      ),
    [host]
  );
  useEffect(
    () =>
      host.onSpotlight((target) => {
        if (target === 'toggle') setSpotlight((s) => (s ? null : activeRef.current || null));
        else setSpotlight(target);
      }),
    [host]
  );
  const [agentLimits, setAgentLimitsState] = useState(() => host.agentLimits());
  const setAgentLimits = (next: typeof agentLimits) => {
    setAgentLimitsState(next);
    host.setAgentLimits(next);
  };
  const agentTabIds = new Set(tabs.filter((t) => host.agentState(t.id).running).map((t) => t.id));

  // ---- Answer pages: the sources under them ----
  const [sources, setSources] = useState<Record<string, PageSource[]>>({});
  const activeAnswer = activeInfo ? tabKind(activeInfo.url) : null;
  const answerQuery = activeAnswer?.kind === 'answer' ? activeAnswer.query : null;
  // A failed lookup (the server still starting) is tried again, a few times.
  const sourceTries = useRef<Record<string, number>>({});
  const [sourcesRetry, setSourcesRetry] = useState(0);
  useEffect(() => {
    if (!answerQuery || sources[answerQuery]) return;
    let live = true;
    void fetchPageSources(answerQuery)
      .then((res) => live && setSources((s) => ({ ...s, [answerQuery]: res.sources })))
      .catch(() => {
        const tries = (sourceTries.current[answerQuery] = (sourceTries.current[answerQuery] ?? 0) + 1);
        if (live && tries < 4) window.setTimeout(() => setSourcesRetry((n) => n + 1), 2500 * tries);
      });
    return () => {
      live = false;
    };
  }, [answerQuery, sources, sourcesRetry]);

  // ---- Bug reports ----
  const [bugReport, setBugReport] = useState<BugReportRequest | null>(null);
  useEffect(
    () =>
      host.onReportBug((request) => {
        const blob = (file: { type: string; data: Uint8Array }) => new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.type });
        setBugReport({
          screenshot: request.screenshot ? blob(request.screenshot) : null,
          clip: request.clip
            ? request.clip.then((clip) => (clip ? { blob: blob(clip), type: clip.type, seconds: clip.seconds, width: clip.width, height: clip.height, poster: clip.poster ? blob(clip.poster) : null } : null))
            : null,
          unavailable: request.unavailable,
          pageUrl: request.pageUrl,
          context: request.context
        });
      }),
    [host]
  );
  const closeBugReport = useCallback(() => {
    setBugReport(null);
    host.reportClosed();
  }, [host]);
  const [tray, setTray] = useState<ShellReportTray | null>(null);
  useEffect(() => host.onReportTray(setTray), [host]);
  const formReport: FormReport | null = tray
    ? {
        result: { ok: true, mode: 'form', reportId: tray.reportId, url: tray.url, files: tray.files, bodyOnClipboard: tray.bodyOnClipboard },
        tabId: tray.tabId,
        status: tray.status,
        number: tray.number,
        error: tray.error
      }
    : null;

  // ---- The picker: this window has no profile yet ----
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  if (!containerId) {
    return (
      <div className="pointer-events-auto relative h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <div className="drag fixed inset-x-0 top-0 z-50 h-16" data-testid="profile-drag-region" aria-hidden />
        <WindowProfilePicker
          containers={containers as Container[]}
          currentId={null}
          onSelect={(id) => void pendingSave.current.then(() => host.chooseContainer(id))}
          onContainersChange={(list) => {
            setContainers(list as BridgeContainer[]);
            pendingSave.current = bridge().saveContainers?.(list as BridgeContainer[]) ?? Promise.resolve();
          }}
          onManage={() =>
            void host.chooseContainer(DEFAULT_CONTAINER_ID).then(() => openInternal('settings'))
          }
        />
      </div>
    );
  }

  const canReload = Boolean(activeTab && (activeTab.url || activeTab.query.trim()));
  const failure = activeInfo ? geckoLoadFailure(activeInfo.errorPage, activeInfo.url, activeInfo.crashed) : null;
  const loading = Boolean(activeTab && (activeTab.status === 'loading' || asking[activeTab.id]) && !failure);
  // What the Electron app drew over its pages: the loading bar, and Toji's error page in
  // place of Firefox's.
  const pageOverlays = (
    <>
      {loading && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-[toji-load_1.1s_ease-in-out_infinite] bg-neutral-900/70 dark:bg-white/70" />
        </div>
      )}
      {failure && activeTab && (
        <div className="pointer-events-auto absolute inset-0">
          <LoadErrorPage failure={failure} tor={torMode} canBack={Boolean(activeTab.canBack)} onRetry={() => host.reload(activeTab.id)} onBack={() => host.back()} />
        </div>
      )}
    </>
  );

  // A popup a page opened (a sign-in or payment window): just the page, as the Electron
  // app's popups were. A login submitted in it still asks to be saved, over its top right.
  if (state.popup) {
    return (
      <div className="pointer-events-none relative flex h-screen flex-col text-neutral-900 dark:text-neutral-100" data-testid="popup-frame">
        <main className="relative flex min-h-0 flex-1 flex-col" data-testid="viewport">
          <div ref={holeRef} className="relative min-h-0 flex-1" data-testid="viewport-page">
            {pageOverlays}
          </div>
        </main>
        {vaultPrompt && (
          <div className="pointer-events-auto absolute right-3 top-0 h-0 w-[440px] max-w-[80vw]">
            <VaultPromptBar
              prompt={vaultPrompt.prompt}
              container={findContainer(containers as Container[], vaultPrompt.prompt.containerId ?? undefined)}
              error={vaultPrompt.error}
              onDone={() => setVaultPrompt(null)}
            />
          </div>
        )}
      </div>
    );
  }

  const addressRow = (
    <AddressRow
      trafficLights={isMac}
      layout={layout}
      theme={theme}
      canBack={Boolean(activeTab?.canBack)}
      canForward={Boolean(activeTab?.canForward)}
      canReload={canReload}
      value={activeTab?.query ?? ''}
      onValueChange={(value) => activeTab && setQuery(activeTab.id, value)}
      inputRef={inputRef}
      onGo={() => activeTab && go(activeTab.id, activeTab.query)}
      onAi={() => activeTab && go(activeTab.id, activeTab.query, { ai: true })}
      vaultButton={activeTab && <VaultFillButton matches={vaultMatches[activeTab.id] ?? []} onFill={(entryId) => host.vaultFill(activeTab.id, entryId)} />}
      star={activeTab?.mode === 'web' && activeTab.url ? { bookmarked: activeBookmarked, onToggle: () => void host.toggleBookmark(activeTab.url!, tabTitle(activeTab)) } : null}
      torMode={torMode}
      onToggleTor={canToggleTor ? () => host.toggleTor() : undefined}
      vaultBar={
        vaultPrompt && (
          <VaultPromptBar
            prompt={vaultPrompt.prompt}
            container={findContainer(containers as Container[], vaultPrompt.prompt.containerId ?? undefined)}
            error={vaultPrompt.error}
            onDone={() => setVaultPrompt(null)}
          />
        )
      }
      onBack={() => host.back()}
      onForward={() => host.forward()}
      onReload={() => activeTab && reloadTab(activeTab.id)}
      onToggleLayout={() => host.setPref('layout', layout === 'side' ? 'top' : 'side')}
      onToggleTheme={() => host.setPref('theme', theme === 'dark' ? 'light' : 'dark')}
      onSettings={() => openInternal('settings')}
      sidebarOpen={sidebarOpen}
    />
  );

  const bookmarksBar = (
    <BookmarksBar
      bookmarks={bookmarks}
      pinned={bookmarksPinned}
      onTogglePinned={() => host.setPref('bookmarksBar', bookmarksPinned ? 'hover' : 'pinned')}
      onOpen={(url) => activeTab && host.load(activeTab.id, url)}
      onOpenInNewTab={(url) => openWebTab(url, { background: true })}
      onRemove={(id) => void host.removeBookmark(id)}
    />
  );

  const topTabStrip = (
    <TopTabStrip
      tabs={tabs}
      groups={groups}
      activeId={activeId}
      trafficLights={isMac}
      agentTabIds={agentTabIds}
      onSelect={(id) => host.select(id)}
      onClose={closeTab}
      onReorder={(next) => host.reorder(next.map((t) => t.id))}
      onContextMenu={(tabId, x, y) => {
        host.select(tabId);
        setTabMenu({ x, y, tabId });
      }}
      onToggleMute={toggleMute}
      onNewTab={() => openTab(null)}
      onNewGroup={openTabInNewGroup}
      onNewAgentTab={openAgentTab}
      onCrowdedChange={setTopTabsCrowded}
    />
  );

  const sidebarEl = (peek = false) => (
    <Sidebar
      tabs={tabs}
      groups={groups}
      activeId={activeId}
      peek={peek}
      onSelect={(id) => host.select(id)}
      onClose={closeTab}
      onNewTab={openTab}
      onNewGroup={openTabInNewGroup}
      onNewAgentTab={openAgentTab}
      onToggleCollapse={() => {
        host.setPref('sidebarOpen', peek);
        setSidebarPeek(false);
      }}
      onToggleGroup={toggleGroup}
      onRenameGroup={renameGroup}
      onRemoveGroup={removeGroup}
      onTabContextMenu={(tabId, x, y) => {
        host.select(tabId);
        setTabMenu({ x, y, tabId });
      }}
      onToggleMute={toggleMute}
      onReorderUngrouped={(ordered) => {
        // Drop the reordered ungrouped tabs back into their slots, leaving grouped tabs put.
        let k = 0;
        host.reorder(tabsRef.current.map((t) => (t.groupId ? t : ordered[k++] ?? t)).map((t) => t.id));
      }}
      agentTabIds={agentTabIds}
    />
  );

  // The viewport is a hole: Firefox's page for the tab in front shows through it. On top
  // of it go only what the Electron app drew over its pages — the loading bar, Toji's
  // error page in place of Firefox's — and, under an answer, its sources.
  const viewport = (
    <main className="relative flex min-h-0 flex-1 flex-col" data-testid="viewport">
      <div ref={holeRef} className="relative min-h-0 flex-1" data-testid="viewport-page">
        {pageOverlays}
      </div>
      {answerQuery && (sources[answerQuery]?.length ?? 0) > 0 && (
        <div className="pointer-events-auto contents">
          <PageSources sources={sources[answerQuery]} onOpenSource={(url) => openWebTab(url)} />
        </div>
      )}
    </main>
  );

  const spotlightTab = spotlight ? tabs.find((t) => t.id === spotlight) : undefined;
  const spotlightAgent = spotlightTab ? host.agentState(spotlightTab.id) : null;

  return (
    <BrowserFrame
      layout={layout}
      dragHandle={isMac && <WindowDragHandle layout={layout} crowded={topTabsCrowded} />}
      topTabStrip={topTabStrip}
      addressRow={addressRow}
      bookmarksBar={bookmarksBar}
      bookmarksPinned={bookmarksPinned}
      bookmarksPeek={bookmarksPeek}
      torBar={torMode ? <TorStatusBar container={windowContainer} status={torStatus} /> : null}
      sidebar={sidebarEl}
      sidebarOpen={sidebarOpen}
      sidebarPeek={sidebarPeek}
      onSidebarPeek={setSidebarPeek}
      viewport={viewport}
      passThrough
    >
      <AnimatePresence>
        {spotlightTab && spotlightAgent && (
          <AgentSpotlight
            key="spotlight"
            target={spotlightTab.mode === 'web' ? spotlightTab.title || (spotlightTab.url ? hostOf(spotlightTab.url) : 'this tab') : spotlightTab.query.trim() || 'this tab'}
            // Center over the page area, not the whole window — lined up with the omnibox
            // behind it even while the sidebar takes the left edge.
            insetLeft={layout === 'side' && sidebarOpen ? 240 : 0}
            running={spotlightAgent.running}
            pendingAsk={spotlightAgent.ask ?? undefined}
            log={spotlightAgent.log}
            maxSteps={agentLimits.maxSteps}
            noLimit={agentLimits.noLimit}
            onMaxSteps={(maxSteps) => setAgentLimits({ ...agentLimits, maxSteps })}
            onNoLimit={(noLimit) => setAgentLimits({ ...agentLimits, noLimit })}
            files={spotlightAgent.files}
            onDropFiles={(files) => void host.agentAddFiles(spotlightTab.id, Array.from(files))}
            onRemoveFile={(index) => host.agentRemoveFile(spotlightTab.id, index)}
            onSubmit={(goal) => {
              // An answer keeps the spotlight open so the user sees the agent continue;
              // a new run hides it so they can watch (a tap of Option brings it back).
              if (host.agentSubmit(spotlightTab.id, goal) === 'started') setSpotlight(null);
            }}
            onStop={() => host.agentStop(spotlightTab.id)}
            onClose={() => setSpotlight(null)}
          />
        )}
      </AnimatePresence>
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
            // The browser has already opened GitHub's form beside this tab, and its tray
            // (below) follows the report from there.
            onContinueOnGitHub={() => {}}
            onClose={closeBugReport}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {formReport && tray && formReport.tabId === activeId && (
          <BugReportTray
            key="bug-report-tray"
            report={formReport}
            onForm={tray.onForm}
            onRetry={() => host.retryReportTray(tray.reportId)}
            onDismiss={() => host.dismissReportTray(tray.reportId)}
          />
        )}
      </AnimatePresence>
      <AgentCursor cursor={agentCursor} />
      {tabMenu && (
        <TabContextMenu
          menu={tabMenu}
          tabs={tabs}
          groups={groups}
          onDismiss={() => setTabMenu(null)}
          onDuplicate={(id) => host.duplicate(id)}
          onReload={reloadTab}
          onToggleMute={toggleMute}
          onNewGroup={createGroup}
          onAddToGroup={addTabToGroup}
          onUngroup={ungroupTab}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onResetContext={(id) => host.resetContext(id)}
        />
      )}
    </BrowserFrame>
  );
}
