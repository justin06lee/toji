import { ArrowUp, Minus, MousePointer2, Plus, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface AgentLogEntry {
  role: 'you' | 'agent' | 'system';
  text: string;
}

interface AgentSpotlightProps {
  target: string; // tab title / host the agent acts on
  running: boolean;
  log: AgentLogEntry[];
  maxSteps: number;
  noLimit: boolean;
  onMaxSteps: (n: number) => void;
  onNoLimit: (b: boolean) => void;
  onSubmit: (goal: string) => void;
  onStop: () => void;
  onClose: () => void;
}

/** A macOS-Spotlight-style chat overlay for directing the per-tab web agent. */
export function AgentSpotlight({ target, running, log, maxSteps, noLimit, onMaxSteps, onNoLimit, onSubmit, onStop, onClose }: AgentSpotlightProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="no-drag w-[min(640px,92vw)] overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/12 dark:bg-neutral-900/95"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {log.length > 0 && (
          <div ref={logRef} className="max-h-[42vh] space-y-2 overflow-y-auto border-b border-black/[0.06] px-4 py-4 dark:border-white/[0.08]">
            {log.map((l, i) => (
              <div key={i} className={`flex gap-2 ${l.role === 'you' ? 'justify-end' : ''}`}>
                {l.role !== 'you' && <MousePointer2 size={14} className="mt-1 shrink-0 text-neutral-400" />}
                <div
                  className={`max-w-[82%] rounded-xl px-3 py-1.5 text-[13px] ${
                    l.role === 'you'
                      ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                      : l.role === 'system'
                        ? 'text-[12.5px] text-neutral-400'
                        : 'bg-black/[0.05] text-neutral-700 dark:bg-white/10 dark:text-neutral-200'
                  }`}
                >
                  {l.text}
                </div>
              </div>
            ))}
            {running && <div className="flex items-center gap-2 text-[12.5px] text-neutral-400"><span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current/30 border-t-current" /> Working…</div>}
          </div>
        )}
        <form
          className="flex items-center gap-3 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (!v) return;
            onSubmit(v);
            setValue('');
          }}
        >
          <MousePointer2 size={19} className="ml-1 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Tell the agent what to do on ${target}…`}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white"
          />
          {running ? (
            <button type="button" onClick={onStop} title="Stop" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/90 text-white transition hover:bg-red-500">
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" aria-label="Run" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
              <ArrowUp size={17} />
            </button>
          )}
        </form>
        <div className="flex select-none items-center gap-2.5 border-t border-black/[0.06] px-3.5 py-2 text-[11.5px] text-neutral-400 dark:border-white/[0.08]">
          <span>Runs until done.</span>
          <span className="text-neutral-300 dark:text-neutral-600">·</span>
          <span>Step limit</span>
          <div className={`inline-flex items-center overflow-hidden rounded-lg border border-black/10 transition dark:border-white/15 ${noLimit ? 'pointer-events-none opacity-40' : ''}`}>
            <button
              type="button"
              aria-label="Fewer steps"
              onClick={() => onMaxSteps(Math.max(1, maxSteps - 5))}
              className="flex h-6 w-6 items-center justify-center text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Minus size={12} />
            </button>
            <span className="w-8 text-center font-medium tabular-nums text-neutral-700 dark:text-neutral-200">{maxSteps}</span>
            <button
              type="button"
              aria-label="More steps"
              onClick={() => onMaxSteps(maxSteps + 5)}
              className="flex h-6 w-6 items-center justify-center text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Plus size={12} />
            </button>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={noLimit}
            onClick={() => onNoLimit(!noLimit)}
            className="inline-flex cursor-pointer items-center gap-1.5"
          >
            <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${noLimit ? 'bg-neutral-800 dark:bg-white' : 'bg-black/15 dark:bg-white/20'}`}>
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition dark:bg-neutral-900 ${noLimit ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </span>
            <span className={noLimit ? 'text-neutral-600 dark:text-neutral-300' : ''}>No limit</span>
          </button>
          {noLimit && <span className="text-amber-500">⚠ may run long — Stop to halt</span>}
        </div>
      </div>
    </div>,
    document.body
  );
}
