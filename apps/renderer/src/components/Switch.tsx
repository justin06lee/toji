/** The one toggle used across settings: a small pill, filled when on. Neutral, no green. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:cursor-default disabled:opacity-40 ${
        checked ? 'bg-neutral-900 dark:bg-white' : 'bg-black/15 dark:bg-white/20'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition dark:bg-neutral-900 ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}
