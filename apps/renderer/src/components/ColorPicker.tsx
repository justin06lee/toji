import { Check, Pipette } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from '../lib/color';
import { FIELD_MONO } from '../lib/fieldStyles';

/**
 * The presets: the container accents, plus the rest of the same palette family so a
 * custom container can match a built-in one or sit beside it. No purple, as with
 * CONTAINER_COLORS — that hue is reserved for tab groups.
 */
export const COLOR_PRESETS = [
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#10b981', // emerald
  '#84cc16', // lime
  '#eab308', // yellow
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#f43f5e', // rose
  '#64748b' // slate
];

const HUE_BAR = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)';

interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A colour swatch that opens Toji's own picker: a row of presets for the common case,
 * then a saturation/brightness square, a hue bar and a hex field for everything else.
 * It replaces the native <input type="color">, whose panel is a system dialog with
 * numeric RGB fields that looks nothing like the rest of the app.
 *
 * Closes on outside click and Escape, like Dropdown. Every change is committed as it
 * happens, so the container's colour updates live while dragging.
 */
export function ColorPicker({ value, onChange, label, presets = COLOR_PRESETS }: { value: string; onChange: (hex: string) => void; label: string; presets?: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  // HSV is the working state (see lib/color.ts): hex forgets hue at zero saturation.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value);
  const current = hsvToHex(hsv);

  // Follow a value changed from outside (a preset in another row, an undo) without
  // clobbering the hue the user is holding when the hex is the same colour.
  useEffect(() => {
    const normalized = normalizeHex(value);
    if (normalized && normalized !== current) setHsv(hexToHsv(normalized));
    setHexText(normalized ?? value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex);
    if (hex !== normalizeHex(value)) onChange(hex);
  };
  const commitHex = (hex: string) => {
    const normalized = normalizeHex(hex);
    if (normalized) commit(hexToHsv(normalized));
  };

  // The square and the bar both read the pointer's position as a fraction of their box,
  // and keep receiving moves after the pointer leaves them (setPointerCapture) so a fast
  // drag past the edge pins to the edge instead of stopping.
  const fromArea = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box) return;
    commit({ ...hsv, s: clamp01((e.clientX - box.left) / box.width), v: 1 - clamp01((e.clientY - box.top) / box.height) });
  };
  const fromHue = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = hueRef.current?.getBoundingClientRect();
    if (!box) return;
    commit({ ...hsv, h: clamp01((e.clientX - box.left) / box.width) * 359.99 });
  };
  const drag = (read: (e: ReactPointerEvent<HTMLDivElement>) => void) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      read(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.buttons & 1) read(e);
    }
  });
  const arrows = (onArrow: (dx: number, dy: number) => void) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const delta = map[e.key];
    if (!delta) return;
    e.preventDefault();
    onArrow(...delta);
  };

  const eyeDropper = (window as unknown as { EyeDropper?: new () => EyeDropperApi }).EyeDropper;
  const pickFromScreen = async () => {
    if (!eyeDropper) return;
    try {
      commitHex((await new eyeDropper().open()).sRGBHex);
    } catch {
      // Cancelled with Escape — nothing to change.
    }
  };

  const swatchRing = 'border border-black/15 dark:border-white/20';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title="Change colour"
        onClick={() => setOpen((o) => !o)}
        className={`block h-6 w-6 rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-neutral-400 ${swatchRing}`}
        style={{ background: value }}
      />
      {open && (
        <div
          role="dialog"
          aria-label={label}
          data-testid="color-picker"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[240px] rounded-xl border border-black/10 bg-white p-3 shadow-lg dark:border-white/12 dark:bg-neutral-900"
        >
          <div className="grid grid-cols-6 gap-2">
            {presets.map((preset) => {
              const selected = preset === current;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-label={preset}
                  aria-pressed={selected}
                  title={preset}
                  onClick={() => commitHex(preset)}
                  className={`relative h-7 w-7 rounded-full transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-neutral-400 ${swatchRing}`}
                  style={{ background: preset }}
                >
                  {selected && <Check size={12} strokeWidth={3} className="absolute inset-0 m-auto text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" />}
                </button>
              );
            })}
          </div>

          <p className="mb-1.5 mt-3.5 text-[10.5px] font-medium uppercase tracking-wide text-neutral-400">Custom</p>
          <div
            ref={areaRef}
            role="slider"
            aria-label="Saturation and brightness"
            aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
            tabIndex={0}
            onKeyDown={arrows((dx, dy) => commit({ ...hsv, s: clamp01(hsv.s + dx), v: clamp01(hsv.v + dy) }))}
            {...drag(fromArea)}
            className="relative h-[120px] w-full cursor-crosshair touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
          >
            <span
              className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }}
            />
          </div>
          <div
            ref={hueRef}
            role="slider"
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            tabIndex={0}
            onKeyDown={arrows((dx) => commit({ ...hsv, h: (((hsv.h + dx * 360) % 360) + 360) % 360 }))}
            {...drag(fromHue)}
            className="relative mt-3 h-3 w-full cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
            style={{ background: HUE_BAR }}
          >
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className={`h-6 w-6 shrink-0 rounded-full ${swatchRing}`} style={{ background: current }} />
            <input
              value={hexText}
              onChange={(e) => {
                setHexText(e.target.value);
                commitHex(e.target.value);
              }}
              onBlur={() => setHexText(current)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Hex colour"
              className={`${FIELD_MONO} min-w-0 flex-1 uppercase`}
            />
            {eyeDropper && (
              <button
                type="button"
                aria-label="Pick a colour from the screen"
                title="Pick a colour from the screen"
                onClick={() => void pickFromScreen()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 text-neutral-500 transition hover:border-black/30 hover:text-neutral-900 dark:border-white/12 dark:text-neutral-400 dark:hover:border-white/30 dark:hover:text-white"
              >
                <Pipette size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
