// Pure parts of Toji's web agent (resource:///modules/toji/lib/agent.sys.mjs):
// coordinate mapping, the pointer's glide path, and the loop's small rules. The
// loop itself lives in the chrome module TojiAgent.sys.mjs.
//
// Perception is a screenshot and nothing else: the model points at what it
// sees, in the screenshot's own pixels, and Toji maps that to CSS pixels.

export interface Shot {
  /** Size of the image the model sees. */
  width: number;
  height: number;
  /** The page's CSS-pixel viewport. */
  viewport: { w: number; h: number };
}

/**
 * Screenshot pixels to page CSS pixels. A model that answers in 0..1 fractions
 * still lands in the right place; results are clamped inside the viewport.
 */
export function toPagePoint(x: number, y: number, shot: Partial<Shot>): { x: number; y: number } {
  const vw = shot.viewport?.w ?? 0;
  const vh = shot.viewport?.h ?? 0;
  if (!vw || !vh) return { x: Math.round(x), y: Math.round(y) };
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x: Math.round(x * vw), y: Math.round(y * vh) };
  const iw = shot.width || vw;
  const ih = shot.height || vh;
  const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(max - 1, v)));
  return { x: clamp((x * vw) / iw, vw), y: clamp((y * vh) / ih, vh) };
}

/** Scale for a capture whose long edge must not exceed `maxLongEdge` image pixels. */
export function captureScale(viewport: { w: number; h: number }, devicePixelRatio: number, maxLongEdge = 1400): number {
  const long = Math.max(viewport.w, viewport.h) || 1;
  return Math.min(devicePixelRatio || 1, maxLongEdge / long);
}

export interface GlidePoint {
  x: number;
  y: number;
  /** ms after the start of the glide. */
  at: number;
}

const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * The agent's pointer path from `from` to `to`: a cubic Bézier that bows to one
 * side by min(80, dist × 0.18) (the side alternates between moves), sampled at
 * clamp(round(dist/16), 10, 30) steps 11 ms apart with ease-in-out timing.
 */
export function glidePath(from: { x: number; y: number }, to: { x: number; y: number }, bowSign: 1 | -1): GlidePoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [{ x: Math.round(to.x), y: Math.round(to.y), at: 0 }];
  const bow = Math.min(80, dist * 0.18) * bowSign;
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1 = { x: from.x + dx * 0.33 + nx * bow, y: from.y + dy * 0.33 + ny * bow };
  const c2 = { x: from.x + dx * 0.66 + nx * bow, y: from.y + dy * 0.66 + ny * bow };
  const steps = Math.max(10, Math.min(30, Math.round(dist / 16)));
  const points: GlidePoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutQuad(i / steps);
    const u = 1 - t;
    const x = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x;
    const y = u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y;
    points.push({ x: Math.round(x), y: Math.round(y), at: i * 11 });
  }
  points[points.length - 1] = { x: Math.round(to.x), y: Math.round(to.y), at: steps * 11 };
  return points;
}

/** A wait action's duration: 800–8000 ms, 2500 by default. */
export function waitMs(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : 2500;
  return Math.max(800, Math.min(8000, n));
}

/** Keeps the tail of the run's memory under `max` characters. */
export function appendMemory(memory: string, text: string, max = 1400): string {
  const next = memory ? `${memory}\n${text}` : text;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The step budget: `noLimit` or a positive integer. */
export function stepBudget(maxSteps: number, noLimit: boolean): number {
  return noLimit ? Infinity : Math.max(1, Math.floor(maxSteps) || 1);
}

/** Truncates for history lines, adding an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whether a URL is one the agent can't act on and must navigate away from. */
export function isBlankPage(url: string | undefined | null): boolean {
  if (!url) return true;
  // The start page, and every page of the browser's own (Toji's Settings, Plans and
  // answer pages, Firefox's internals): nothing the agent may drive, as in the Electron
  // app, where those tabs had no web page at all. The model is asked to open a site.
  return /^(about:|chrome:|resource:|moz-extension:|view-source:|toji:)/i.test(url);
}

/** Key names the model may send for "press", mapped to KeyboardEvent key/code. */
export const PRESS_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  return: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 }
};

export function pressKey(name: string | undefined): { key: string; code: string; keyCode: number } | null {
  const k = (name ?? 'Enter').trim();
  const known = PRESS_KEYS[k.toLowerCase().replace(/[\s_-]/g, '')];
  if (known) return known;
  if (k.length === 1) return { key: k, code: '', keyCode: 0 };
  return null;
}
