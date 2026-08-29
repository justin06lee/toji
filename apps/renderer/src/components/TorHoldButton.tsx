import { ArrowRight } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

function OnionIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3c0 3-5.5 5.2-5.5 10.4A5.5 5.5 0 0 0 12 19a5.5 5.5 0 0 0 5.5-5.6C17.5 8.2 12 6 12 3Z" />
      <path d="M12 7.2c0 2-2.7 3.8-2.7 6.5A2.7 2.7 0 0 0 12 16.5a2.7 2.7 0 0 0 2.7-2.8C14.7 11 12 9.2 12 7.2Z" />
      <path d="M9.5 21h5" />
    </svg>
  );
}

/** `onToggle` may be absent (an always-Tor profile has no direct route to fall back to) — holding then does nothing. */
export function TorHoldButton({ active, compact, onGo, onToggle }: { active: boolean; compact?: boolean; onGo: () => void; onToggle?: () => void }) {
  const [charging, setCharging] = useState(false);
  const timer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const diameter = compact ? 28 : 36;
  const radius = diameter / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;

  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setCharging(false);
  };
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !onToggle) return;
    suppressClick.current = false;
    setCharging(true);
    timer.current = window.setTimeout(() => {
      suppressClick.current = true;
      setCharging(false);
      onToggle();
    }, 900);
  };

  return (
    <button
      type="button"
      aria-label={onToggle ? (active ? 'Go. Hold to leave Tor mode' : 'Go. Hold for Tor mode') : 'Go'}
      title={onToggle ? (active ? 'Tor mode — hold to turn off' : 'Go — hold for Tor mode') : active ? 'This profile always routes over Tor' : 'Go'}
      onPointerDown={down}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onClick={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          suppressClick.current = false;
          return;
        }
        onGo();
      }}
      className={`relative inline-flex shrink-0 touch-none select-none items-center justify-center rounded-full transition ${compact ? 'h-7 w-7' : 'h-9 w-9'} ${active ? 'bg-rose-500/70 text-white/95 shadow-sm dark:bg-rose-400/65' : 'bg-neutral-900 text-white hover:opacity-85 dark:bg-white dark:text-neutral-900'}`}
    >
      {active ? <OnionIcon size={compact ? 15 : 18} /> : <ArrowRight size={compact ? 15 : 18} />}
      <svg className="pointer-events-none absolute inset-0 -rotate-90 overflow-visible" width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} aria-hidden>
        <circle cx={diameter / 2} cy={diameter / 2} r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={circumference} strokeDashoffset={charging ? 0 : circumference} className={charging ? 'transition-[stroke-dashoffset] duration-[900ms] ease-linear' : 'transition-none'} />
      </svg>
    </button>
  );
}
