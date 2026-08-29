import { ChevronDown, ChevronRight, FolderPlus, PanelLeftClose, PanelLeftOpen, Plus, WandSparkles, X } from 'lucide-react';
import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { motion, Reorder } from 'motion/react';
import { tabTitle } from '../lib/tabPresentation';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from '../types';

const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

interface SidebarProps {
  tabs: BrowserTab[];
  groups: TabGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: (groupId: string | null) => void;
  /** Hold-menu action: a fresh tab inside a fresh group. */
  onNewGroup?: () => void;
  /** Hold-menu action: a fresh tab with the AI agent ready. */
  onNewAgentTab?: () => void;
  /** True while the sidebar is the transient hover "peek" — the collapse button becomes a pin. */
  peek?: boolean;
  onToggleCollapse: () => void;
  onToggleGroup: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  onTabContextMenu: (tabId: string, x: number, y: number) => void;
  /** Reorder the ungrouped tabs (drag along the Y axis). */
  onReorderUngrouped?: (ordered: BrowserTab[]) => void;
}

function TabRow({
  tab,
  active,
  indent,
  onSelect,
  onClose,
  onContext,
  dragging = false
}: {
  tab: BrowserTab;
  active: boolean;
  indent: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContext: (e: ReactMouseEvent) => void;
  dragging?: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContext}
      className={`no-drag group/tab flex h-8 items-center gap-2 rounded-lg px-2 ${indent ? 'ml-4 cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${
        dragging || active ? 'bg-black/[0.06] dark:bg-white/[0.12]' : 'text-neutral-500 hover:bg-black/[0.035] dark:text-neutral-400 dark:hover:bg-white/[0.06]'
      }`}
    >
      {tab.mode === 'web' && tab.favicon ? (
        <img src={tab.favicon} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[4px]" onError={(e) => ((e.currentTarget as HTMLImageElement).src = ICON)} />
      ) : (
        <img src={ICON} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[5px]" />
      )}
      <span className={`flex-1 truncate text-[13px] ${active ? 'text-neutral-900 dark:text-neutral-100' : ''}`}>{tabTitle(tab)}</span>
      {tab.status === 'loading' && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" />}
      <button
        type="button"
        aria-label="Close tab"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-black/10 hover:text-neutral-900 dark:hover:bg-white/15 dark:hover:text-white ${active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * The new-tab affordance living directly under the last tab. A click opens a tab; a
 * HOLD charges the same ring as the Tor button, then the plus morphs into three
 * actions: new tab, new tab in a new group, and a new AI tab.
 */
function SidebarNewButton({ onNewTab, onNewGroup, onNewAgentTab }: { onNewTab: () => void; onNewGroup?: () => void; onNewAgentTab?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [charging, setCharging] = useState(false);
  const timer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const diameter = 28;
  const radius = diameter / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;

  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setCharging(false);
  };
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    setCharging(true);
    timer.current = window.setTimeout(() => {
      suppressClick.current = true;
      setCharging(false);
      setExpanded(true);
    }, 900);
  };

  const item =
    'inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100';

  const act = (fn?: () => void) => () => {
    setExpanded(false);
    fn?.();
  };

  return (
    <div className="no-drag mt-0.5 flex h-8 items-center px-0.5" onMouseLeave={() => setExpanded(false)}>
      {expanded ? (
        <motion.div initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.12, ease: 'easeOut' }} className="flex items-center gap-1">
          <button type="button" aria-label="New tab" title="New tab" onClick={act(onNewTab)} className={item}>
            <Plus size={15} />
          </button>
          <button type="button" aria-label="New tab in a new group" title="New tab in a new group" onClick={act(onNewGroup)} className={item}>
            <FolderPlus size={15} />
          </button>
          <button type="button" aria-label="New AI tab" title="New AI tab" onClick={act(onNewAgentTab)} className={item}>
            <WandSparkles size={15} />
          </button>
        </motion.div>
      ) : (
        <button
          type="button"
          aria-label="New tab. Hold for more"
          title="New tab — hold for more"
          onPointerDown={down}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerLeave={stop}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            onNewTab();
          }}
          className="relative inline-flex h-7 w-7 touch-none select-none items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          <Plus size={15} />
          <svg className="pointer-events-none absolute inset-0 -rotate-90 overflow-visible" width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} aria-hidden>
            <circle
              cx={diameter / 2}
              cy={diameter / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray={circumference}
              strokeDashoffset={charging ? 0 : circumference}
              className={charging ? 'transition-[stroke-dashoffset] duration-[900ms] ease-linear' : 'transition-none'}
            />
          </svg>
        </button>
      )}
    </div>
  );
}

export function Sidebar({ tabs, groups, activeId, onSelect, onClose, onNewTab, onNewGroup, onNewAgentTab, peek, onToggleCollapse, onToggleGroup, onRenameGroup, onRemoveGroup, onTabContextMenu, onReorderUngrouped }: SidebarProps) {
  const contextHandler = (tabId: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    onTabContextMenu(tabId, e.clientX, e.clientY);
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const ungroupedListRef = useRef<HTMLDivElement>(null);
  const ungrouped = tabs.filter((t) => !t.groupId);

  return (
    // While peeking, the sidebar must NOT be a native drag region: drag regions swallow
    // mouse events, which made the peek instantly read "pointer left" and slam shut.
    <aside
      className={`${peek ? '' : 'drag '}relative flex w-60 shrink-0 select-none flex-col border-r border-black/[0.07] bg-black/[0.015] dark:border-white/10 dark:bg-white/[0.02]`}
      data-testid="sidebar"
    >
      {/* The whole left rail moves the window — kept clear of tab rows (they start at
          ml-5) so a wide grab area never steals their clicks. */}
      {!peek && <div className="drag absolute inset-y-0 left-0 z-20 w-5" data-testid="sidebar-drag-edge" aria-hidden />}
      <div className="no-drag ml-5 flex items-center justify-end py-2 pr-2">
        <button
          type="button"
          aria-label={peek ? 'Show sidebar' : 'Hide sidebar'}
          title={peek ? 'Show sidebar (keep it open)' : 'Hide sidebar'}
          onClick={onToggleCollapse}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          {peek ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <div className="no-drag ml-5 flex-1 space-y-0.5 overflow-y-auto pr-2 pb-2">
        {groups.map((group, index) => {
          const color = GROUP_COLORS[index % GROUP_COLORS.length];
          const groupTabs = tabs.filter((t) => t.groupId === group.id);
          return (
            <div key={group.id} className="group/grp">
              <div className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                <button type="button" aria-label={group.collapsed ? 'Expand group' : 'Collapse group'} onClick={() => onToggleGroup(group.id)} className="inline-flex h-5 w-5 items-center justify-center text-neutral-400">
                  {group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                {editingId === group.id ? (
                  <input
                    autoFocus
                    defaultValue={group.name}
                    onBlur={(e) => {
                      onRenameGroup(group.id, e.target.value.trim() || group.name);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        (e.target as HTMLInputElement).value = group.name;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="min-w-0 flex-1 select-text rounded bg-transparent text-[12.5px] font-medium outline-none"
                  />
                ) : (
                  <span onDoubleClick={() => setEditingId(group.id)} className="flex-1 truncate text-[12.5px] font-medium text-neutral-700 dark:text-neutral-300" title="Double-click to rename">
                    {group.name}
                  </span>
                )}
                <span className="text-[11px] text-neutral-400">{groupTabs.length}</span>
                <button type="button" aria-label="Add tab to group" onClick={() => onNewTab(group.id)} className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 opacity-0 transition hover:bg-black/10 hover:text-neutral-900 group-hover/grp:opacity-100 dark:hover:bg-white/15 dark:hover:text-white">
                  <Plus size={13} />
                </button>
                <button type="button" aria-label="Remove group" onClick={() => onRemoveGroup(group.id)} className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 opacity-0 transition hover:bg-black/10 hover:text-neutral-900 group-hover/grp:opacity-100 dark:hover:bg-white/15 dark:hover:text-white">
                  <X size={13} />
                </button>
              </div>
              {!group.collapsed &&
                groupTabs.map((tab) => (
                  <TabRow key={tab.id} tab={tab} active={tab.id === activeId} indent onSelect={() => onSelect(tab.id)} onClose={() => onClose(tab.id)} onContext={contextHandler(tab.id)} />
                ))}
            </div>
          );
        })}

        {ungrouped.length > 0 && groups.length > 0 && <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.06]" />}
        {/* Ungrouped tabs drag-reorder along the Y axis only (vertical list). */}
        <Reorder.Group ref={ungroupedListRef} as="div" axis="y" values={ungrouped} onReorder={(o) => onReorderUngrouped?.(o)} layoutScroll data-testid="sidebar-tab-list" className="space-y-0.5">
          {ungrouped.map((tab) => (
            <DraggableTabRow key={tab.id} tab={tab} active={tab.id === activeId} constraintsRef={ungroupedListRef} onSelect={() => onSelect(tab.id)} onClose={() => onClose(tab.id)} onContext={contextHandler(tab.id)} />
          ))}
        </Reorder.Group>
        <SidebarNewButton onNewTab={() => onNewTab(null)} onNewGroup={onNewGroup} onNewAgentTab={onNewAgentTab} />
      </div>
    </aside>
  );
}

function DraggableTabRow({ tab, active, constraintsRef, onSelect, onClose, onContext }: { tab: BrowserTab; active: boolean; constraintsRef: RefObject<HTMLDivElement | null>; onSelect: () => void; onClose: () => void; onContext: (e: ReactMouseEvent) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <Reorder.Item
      as="div"
      value={tab}
      data-testid="sidebar-tab"
      data-tab-id={tab.id}
      dragConstraints={constraintsRef}
      dragElastic={0}
      dragMomentum={false}
      onDragStart={() => {
        setDragging(true);
        onSelect();
      }}
      onDragEnd={() => setDragging(false)}
      whileDrag={{ zIndex: 50 }}
      className={`relative rounded-lg ${dragging ? 'sidebar-tab-dragging bg-black/[0.06] dark:bg-white/[0.12]' : ''}`}
    >
      <TabRow tab={tab} active={active} indent={false} dragging={dragging} onSelect={onSelect} onClose={onClose} onContext={onContext} />
    </Reorder.Item>
  );
}
