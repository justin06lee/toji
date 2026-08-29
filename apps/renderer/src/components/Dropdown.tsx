import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Optional short muted text on the right of the row. */
  hint?: string;
  /** Optional small status dot color (e.g. availability). */
  dotColor?: string;
  /** Shown but not selectable (e.g. a feature still under construction). */
  disabled?: boolean;
  /** Section this option belongs to; consecutive options sharing one get a header. */
  group?: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/** Minimal custom select: a button + popover list. Closes on outside-click / Escape. */
export function Dropdown<T extends string>({ value, options, onChange, disabled, placeholder, className }: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-black/10 bg-transparent px-2.5 py-2 text-left text-[13px] outline-none transition hover:border-black/20 focus:border-black/30 disabled:opacity-50 dark:border-white/12 dark:hover:border-white/20 dark:focus:border-white/30"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.dotColor && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: selected.dotColor }} />}
          <span className="truncate">{selected ? selected.label : placeholder ?? 'Select…'}</span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-neutral-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-[320px] overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/12 dark:bg-neutral-900">
          {options.map((opt, i) => {
            const active = opt.value === value;
            const header = opt.group && opt.group !== options[i - 1]?.group ? opt.group : null;
            return (
              <div key={opt.value}>
                {header && (
                  <div className="px-2.5 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{header}</div>
                )}
                <button
                  type="button"
                  disabled={opt.disabled}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  title={opt.hint ? `${opt.label} — ${opt.hint}` : opt.label}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] transition ${
                    opt.disabled
                      ? 'cursor-default text-neutral-400 opacity-60 dark:text-neutral-500'
                      : active
                        ? 'bg-black/[0.05] dark:bg-white/10'
                        : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.07]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {opt.dotColor && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: opt.dotColor }} />}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {opt.hint && <span className="max-w-[130px] truncate text-[11px] text-neutral-400">{opt.hint}</span>}
                    {active && <Check size={13} className="text-neutral-500 dark:text-neutral-300" />}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
