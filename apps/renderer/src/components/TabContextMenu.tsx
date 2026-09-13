import { Copy, FolderPlus, RefreshCcw, RotateCw, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portalRoot';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from '../types';

export interface TabMenuAt {
  x: number;
  y: number;
  tabId: string;
}

interface TabContextMenuProps {
  menu: TabMenuAt;
  tabs: BrowserTab[];
  groups: TabGroup[];
  onDismiss: () => void;
  onDuplicate: (tabId: string) => void;
  onReload: (tabId: string) => void;
  /** Absent where a tab cannot be given a fresh session of its own. */
  onResetContext?: (tabId: string) => void;
  onToggleMute: (tabId: string) => void;
  onNewGroup: (tabId: string) => void;
  onAddToGroup: (tabId: string, groupId: string) => void;
  onUngroup: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
}

/** Right-click menu for a tab — shared by the top tab strip AND the sidebar tab rows. */
export function TabContextMenu({ menu, tabs, groups, onDismiss, onDuplicate, onReload, onResetContext, onToggleMute, onNewGroup, onAddToGroup, onUngroup, onClose, onCloseOthers }: TabContextMenuProps) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss();
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onDismiss]);

  const menuTab = tabs.find((t) => t.id === menu.tabId);
  if (!menuTab) return null;
  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };
  const item =
    'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-700 hover:bg-black/[0.06] dark:text-neutral-200 dark:hover:bg-white/10';
  const sep = <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.08]" />;
  const otherGroups = groups.filter((g) => g.id !== menuTab.groupId);
  const hasContent = Boolean(menuTab.url || menuTab.query.trim());
  const left = Math.min(menu.x, window.innerWidth - 224);
  const top = Math.min(menu.y, window.innerHeight - 300);
  return createPortal(
    <>
      <div className="no-drag fixed inset-0 z-[100]" onClick={onDismiss} onContextMenu={(e) => { e.preventDefault(); onDismiss(); }} />
      <div
        className="no-drag fixed z-[101] min-w-[200px] select-none rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
        style={{ left, top }}
      >
        <button type="button" className={item} onClick={run(() => onDuplicate(menuTab.id))}>
          <Copy size={14} /> Duplicate tab
        </button>
        {hasContent && (
          <button type="button" className={item} onClick={run(() => onReload(menuTab.id))}>
            <RotateCw size={14} /> Reload
          </button>
        )}
        {menuTab.mode === 'web' && menuTab.url && onResetContext && (
          <button type="button" className={item} onClick={run(() => onResetContext(menuTab.id))}>
            <RefreshCcw size={14} /> Reset context
          </button>
        )}
        {menuTab.mode === 'web' && menuTab.url && (
          <button type="button" className={item} onClick={run(() => onToggleMute(menuTab.id))}>
            {menuTab.muted ? <Volume2 size={14} /> : <VolumeX size={14} />} {menuTab.muted ? 'Unmute tab' : 'Mute tab'}
          </button>
        )}
        {sep}
        <button type="button" className={item} onClick={run(() => onNewGroup(menuTab.id))}>
          <FolderPlus size={14} /> New group
        </button>
        {otherGroups.map((g) => (
          <button key={g.id} type="button" className={item} onClick={run(() => onAddToGroup(menuTab.id, g.id))}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: GROUP_COLORS[groups.findIndex((x) => x.id === g.id) % GROUP_COLORS.length] }} />
            Add to {g.name}
          </button>
        ))}
        {menuTab.groupId && (
          <button type="button" className={item} onClick={run(() => onUngroup(menuTab.id))}>
            <X size={14} /> Remove from group
          </button>
        )}
        {sep}
        <button type="button" className={item} onClick={run(() => onClose(menuTab.id))}>
          <X size={14} /> Close tab
        </button>
        {tabs.length > 1 && (
          <button type="button" className={item} onClick={run(() => onCloseOthers(menuTab.id))}>
            <X size={14} /> Close other tabs
          </button>
        )}
      </div>
    </>,
    portalRoot()
  );
}
