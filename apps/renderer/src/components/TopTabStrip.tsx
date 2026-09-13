import { X } from 'lucide-react';
import { AnimatePresence, motion, Reorder } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { dragBoundsX, type DragBoundsX } from '../lib/dragBounds';
import { TAB_ENTER, TAB_EXIT, TAB_REST, TAB_TRANSITION } from '../lib/tabMotion';
import { tabTitle } from '../lib/tabPresentation';
import { GROUP_COLORS, type BrowserTab, type TabGroup } from '../types';
import { NewTabButton } from './NewTabButton';
import { TabMarks, TabStatus } from './TabStatus';

interface TopTabStripProps {
  tabs: BrowserTab[];
  groups: TabGroup[];
  activeId: string;
  /** Leave room at the left end for the macOS traffic lights. */
  trafficLights: boolean;
  /** Tabs the agent is driving; they carry its cursor mark. */
  agentTabIds: Set<string>;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** The whole list in its new order, as a drag passes each neighbour. */
  onReorder: (tabs: BrowserTab[]) => void;
  onContextMenu: (tabId: string, x: number, y: number) => void;
  onToggleMute: (tabId: string) => void;
  onNewTab: () => void;
  onNewGroup: () => void;
  onNewAgentTab: () => void;
  /** Whether the row has filled up (the new-tab button pins to the corner, the drag notch may show). */
  onCrowdedChange?: (crowded: boolean) => void;
}

/**
 * The top tab strip. Tabs sit at the very top (offset past the macOS traffic lights);
 * the omnibox lives just beneath them. Tabs are drag-reorderable along the X axis only.
 * Shared by the Electron app and the Gecko browser's shell so the two never drift apart.
 */
export function TopTabStrip({ tabs, groups, activeId, trafficLights, agentTabIds, onSelect, onClose, onReorder, onContextMenu, onToggleMute, onNewTab, onNewGroup, onNewAgentTab, onCrowdedChange }: TopTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [crowded, setCrowded] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // How far the tab under the pointer may be dragged before it leaves the strip. Measured
  // on pointer-down (Motion reads it as the gesture starts) rather than handed over as a
  // ref, which would put Motion's own resize listener in charge of every tab's offset.
  const [dragBounds, setDragBounds] = useState<{ id: string; bounds: DragBoundsX } | null>(null);
  const crowdedChange = useRef(onCrowdedChange);
  crowdedChange.current = onCrowdedChange;

  useEffect(() => {
    crowdedChange.current?.(crowded);
  }, [crowded]);
  useEffect(() => () => crowdedChange.current?.(false), []);

  const groupColor = (groupId: string | null) => {
    if (!groupId) return null;
    const idx = groups.findIndex((g) => g.id === groupId);
    return idx < 0 ? null : GROUP_COLORS[idx % GROUP_COLORS.length];
  };

  // Keep the active tab in view: after a switch or a resize the strip may have scrolled
  // it out of sight.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const frame = requestAnimationFrame(() => {
      const el = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
      el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, crowded]);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const items = Array.from(strip.querySelectorAll<HTMLElement>('[data-testid="top-tab"]'));
      const occupied = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) + Math.max(0, items.length - 1) * 4;
      setCrowded(strip.clientWidth - occupied < 120);
      // Shrinking the window can leave the active tab past the strip's edge; bring it back.
      if (strip.scrollWidth > strip.clientWidth) strip.querySelector<HTMLElement>('[data-testid="top-tab"][data-active]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [tabs.length]);
  // Vertical wheel scrolls the horizontal tab strip. Registered natively because React
  // attaches onWheel as a PASSIVE listener, where preventDefault() is a no-op.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="flex h-9">
      {trafficLights && <div aria-hidden className="w-[82px] shrink-0" />}
      <Reorder.Group
        ref={stripRef}
        as="div"
        axis="x"
        values={tabs}
        onReorder={onReorder}
        layoutScroll
        data-testid="top-tab-strip"
        // Positioned so a closing tab, popped out of the flow while it fades, stays put.
        className="tab-strip relative flex min-w-0 flex-1 select-none items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        {/* A closing tab leaves the flow at once (popLayout) so its neighbours slide
            into the gap while it fades where it was. */}
        <AnimatePresence initial={false} mode="popLayout">
          {tabs.map((tab) => {
            const color = groupColor(tab.groupId);
            return (
              <Reorder.Item
                as="div"
                key={tab.id}
                value={tab}
                // Only positions animate. Animating size too squashed the titles while
                // the row reflowed — on every open, close and window resize.
                layout="position"
                initial={TAB_ENTER.x}
                animate={TAB_REST}
                exit={TAB_EXIT}
                transition={TAB_TRANSITION}
                dragConstraints={dragBounds?.id === tab.id ? dragBounds.bounds : undefined}
                dragElastic={0}
                dragMomentum={false}
                data-testid="top-tab"
                data-tab-id={tab.id}
                data-active={tab.id === activeId || undefined}
                onPointerDownCapture={(event: React.PointerEvent<HTMLDivElement>) => {
                  const strip = stripRef.current;
                  if (event.button !== 0 || !strip) return;
                  flushSync(() => setDragBounds({ id: tab.id, bounds: dragBoundsX(event.currentTarget.getBoundingClientRect(), strip.getBoundingClientRect()) }));
                }}
                onClick={() => onSelect(tab.id)}
                onDragStart={() => {
                  setDraggingId(tab.id);
                  onSelect(tab.id);
                }}
                onDragEnd={() => setDraggingId(null)}
                onContextMenu={(e: React.MouseEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  onContextMenu(tab.id, e.clientX, e.clientY);
                }}
                whileDrag={{ cursor: 'grabbing', zIndex: 90 }}
                // Tabs share the row evenly and shrink together as it fills, down to a
                // width that still shows the favicon and a word of the title; past that
                // the strip scrolls. Nothing depends on the window being any one size.
                className={`no-drag group relative flex h-8 w-[210px] min-w-[104px] max-w-[210px] flex-[1_1_210px] cursor-grab items-center gap-2 overflow-hidden rounded-xl px-2.5 transition-colors ${
                  draggingId === tab.id || tab.id === activeId
                    ? `bg-[var(--tab-active)]${draggingId === tab.id ? ' top-tab-dragging' : ''}`
                    : 'bg-[var(--tab)] text-neutral-500 hover:bg-[var(--tab-hover)] dark:text-neutral-400'
                }`}
              >
                <TabStatus tab={tab} color={color} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{tabTitle(tab)}</span>
                {/* Sound first, then the agent's mark, then close; the title, not the
                    favicon, gives up room for them. */}
                <TabMarks tab={tab} agentRunning={agentTabIds.has(tab.id)} onToggleMute={() => onToggleMute(tab.id)} />
                <button
                  type="button"
                  aria-label="Close tab"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:bg-black/10 hover:text-neutral-900 dark:hover:bg-white/15 dark:hover:text-white"
                >
                  <X size={12} />
                </button>
              </Reorder.Item>
            );
          })}
        </AnimatePresence>
        {/* New-tab sits right beside the last tab and slides along with it as tabs come
            and go; once the row fills up it pins to the corner. */}
        {!crowded && (
          <motion.div layout="position" transition={TAB_TRANSITION} className="flex shrink-0">
            <NewTabButton className="ml-0.5" onNewTab={onNewTab} onNewGroup={onNewGroup} onNewAgentTab={onNewAgentTab} data-testid="top-new-tab" />
          </motion.div>
        )}
      </Reorder.Group>
      {crowded && <NewTabButton className="ml-1.5" onNewTab={onNewTab} onNewGroup={onNewGroup} onNewAgentTab={onNewAgentTab} data-testid="top-new-tab" />}
    </div>
  );
}
