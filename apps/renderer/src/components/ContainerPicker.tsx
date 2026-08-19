import { Check, ChevronDown, EyeOff, Plus, Route, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Container } from '../lib/containers';

interface ContainerPickerProps {
  containers: Container[];
  active: Container;
  /** Move the current tab into another container (its session changes, so it reloads). */
  onSelect: (containerId: string) => void;
  onNewTabIn: (containerId: string) => void;
  onClear: (containerId: string) => void;
  onManage: () => void;
  /** Whether Tor is currently usable; Tor containers are offline until it is. */
  torReady: boolean;
}

/** Small colored dot with the container's accent. */
export function ContainerDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="shrink-0 rounded-full" style={{ background: color, width: size, height: size }} />;
}

/** The badges that describe a container's behavior at a glance. */
function Badges({ container, torReady }: { container: Container; torReady: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {container.ephemeral && (
        <span title="Ephemeral — everything is discarded when the last tab closes" className="text-neutral-400">
          <EyeOff size={12} />
        </span>
      )}
      {container.egress === 'tor' && (
        <span
          title={torReady ? 'Routed over Tor' : 'Routed over Tor — offline until Tor connects'}
          className={torReady ? 'text-emerald-500' : 'text-amber-500'}
        >
          <Route size={12} />
        </span>
      )}
    </span>
  );
}

/**
 * The container switcher that lives in the toolbar. It shows which identity the
 * current tab is browsing as, and is the fastest way to move a tab between them.
 */
export function ContainerPicker({ containers, active, onSelect, onNewTabIn, onClear, onManage, torReady }: ContainerPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Container: ${active.name}`}
        aria-label={`Container: ${active.name}`}
        className="flex h-9 max-w-[190px] items-center gap-2 rounded-full border px-3 text-[13px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.07]"
        style={{ borderColor: `${active.color}59` }}
      >
        <ContainerDot color={active.color} />
        <span className="truncate">{active.name}</span>
        <Badges container={active} torReady={torReady} />
        <ChevronDown size={13} className={`shrink-0 text-neutral-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-[268px] overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-xl dark:border-white/12 dark:bg-neutral-900">
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">Move this tab to</p>
          {containers.map((container) => (
            <button
              key={container.id}
              type="button"
              onClick={act(() => onSelect(container.id))}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition ${
                container.id === active.id ? 'bg-black/[0.05] dark:bg-white/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.07]'
              }`}
            >
              <ContainerDot color={container.color} />
              <span className="min-w-0 flex-1 truncate">{container.name}</span>
              <Badges container={container} torReady={torReady} />
              {container.id === active.id && <Check size={13} className="shrink-0 text-neutral-500 dark:text-neutral-300" />}
            </button>
          ))}

          <div className="my-1 h-px bg-black/[0.07] dark:bg-white/10" />

          <button type="button" onClick={act(() => onNewTabIn(active.id))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.07]">
            <Plus size={13} className="shrink-0 text-neutral-400" />
            New tab in {active.name}
          </button>
          <button type="button" onClick={act(() => onClear(active.id))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.07]">
            <Trash2 size={13} className="shrink-0 text-neutral-400" />
            Clear {active.name}
          </button>
          <button type="button" onClick={act(onManage)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.07]">
            <Settings2 size={13} className="shrink-0 text-neutral-400" />
            Manage containers…
          </button>
        </div>
      )}
    </div>
  );
}
