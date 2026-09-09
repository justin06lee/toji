import { FolderPlus, Plus, WandSparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** How long the plus must be held before it opens into the three choices. */
export const NEW_TAB_HOLD_MS = 350;

interface NewTabButtonProps {
  onNewTab: () => void;
  /** Hold-menu action: a fresh tab inside a fresh group. */
  onNewGroup?: () => void;
  /** Hold-menu action: a fresh tab with the AI agent ready. */
  onNewAgentTab?: () => void;
  /** Extra classes for the wrapper (placement only — the button itself is fixed). */
  className?: string;
  'data-testid'?: string;
}

/**
 * The new-tab plus, the same in the side strip and the top one. A click opens a tab; a
 * HOLD charges the same ring as the Tor button, then the plus morphs into three actions:
 * new tab, new tab in a new group, and a new AI tab.
 */
export function NewTabButton({ onNewTab, onNewGroup, onNewAgentTab, className = '', 'data-testid': testId }: NewTabButtonProps) {
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
    }, NEW_TAB_HOLD_MS);
  };

  const item =
    'inline-flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100';

  const act = (fn?: () => void) => () => {
    setExpanded(false);
    fn?.();
  };

  return (
    <div className={`no-drag relative z-30 flex h-8 shrink-0 items-center justify-center ${className}`} onMouseLeave={() => setExpanded(false)} data-testid={testId}>
      {expanded ? (
        <motion.div initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.12, ease: 'easeOut' }} className="flex items-center gap-1" data-testid="new-tab-choices">
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
              style={{ transition: charging ? `stroke-dashoffset ${NEW_TAB_HOLD_MS}ms linear` : 'none' }}
            />
          </svg>
        </button>
      )}
    </div>
  );
}
