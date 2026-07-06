import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react';
import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Reorder } from 'motion/react';
import { hostOf } from '../lib/nav';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from '../types';

const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

interface SidebarProps {
  tabs: BrowserTab[];
  groups: TabGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: (groupId: string | null) => void;
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

function tabLabel(tab: BrowserTab) {
  if (tab.mode === 'web') return tab.title || (tab.url ? hostOf(tab.url) : 'New Tab');
  return tab.query.trim() || 'New Tab';
}

function TabRow({
  tab,
  active,
  indent,
  onSelect,
  onClose,
  onContext
}: {
  tab: BrowserTab;
  active: boolean;
  indent: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContext: (e: ReactMouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContext}
      className={`no-drag group/tab flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 ${indent ? 'ml-4' : ''} ${
        active ? 'bg-black/[0.06] dark:bg-white/[0.12]' : 'text-neutral-500 hover:bg-black/[0.035] dark:text-neutral-400 dark:hover:bg-white/[0.06]'
      }`}
    >
      {tab.mode === 'web' && tab.favicon ? (
        <img src={tab.favicon} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[4px]" onError={(e) => ((e.currentTarget as HTMLImageElement).src = ICON)} />
      ) : (
        <img src={ICON} alt="" aria-hidden className="h-4 w-4 shrink-0 rounded-[5px]" />
      )}
      <span className={`flex-1 truncate text-[13px] ${active ? 'text-neutral-900 dark:text-neutral-100' : ''}`}>{tabLabel(tab)}</span>
      {tab.status === 'loading' && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" />}
      <button
        type="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition group-hover/tab:opacity-100 hover:bg-black/10 hover:text-neutral-900 dark:hover:bg-white/15 dark:hover:text-white"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function Sidebar({ tabs, groups, activeId, onSelect, onClose, onNewTab, peek, onToggleCollapse, onToggleGroup, onRenameGroup, onRemoveGroup, onTabContextMenu, onReorderUngrouped }: SidebarProps) {
  const contextHandler = (tabId: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    onTabContextMenu(tabId, e.clientX, e.clientY);
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const ungrouped = tabs.filter((t) => !t.groupId);
  // Row pitch for drag bounds: h-8 rows (32px) + space-y-0.5 gaps (2px).
  const ROW_PITCH = 34;

  return (
    <aside className="drag flex w-60 shrink-0 select-none flex-col border-r border-black/[0.07] bg-black/[0.015] dark:border-white/10 dark:bg-white/[0.02]">
      <div className="no-drag flex items-center gap-1 px-2 py-2">
        <button type="button" onClick={() => onNewTab(null)} className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100">
          <Plus size={15} /> New tab
        </button>
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

      <div className="no-drag flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
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
        <Reorder.Group as="div" axis="y" values={ungrouped} onReorder={(o) => onReorderUngrouped?.(o)} className="space-y-0.5">
          {ungrouped.map((tab, index) => (
            <Reorder.Item
              as="div"
              key={tab.id}
              value={tab}
              // Hard stop at the list's start (no sliding under the "New tab" row above);
              // downward is unbounded so a tab can be dragged to the bottom of the window.
              dragConstraints={{ top: -index * ROW_PITCH, bottom: window.innerHeight }}
              dragElastic={0}
              className="cursor-grab"
            >
              <TabRow tab={tab} active={tab.id === activeId} indent={false} onSelect={() => onSelect(tab.id)} onClose={() => onClose(tab.id)} onContext={contextHandler(tab.id)} />
            </Reorder.Item>
          ))}
        </Reorder.Group>
      </div>
    </aside>
  );
}
