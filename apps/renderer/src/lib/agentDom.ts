// The web agent's perception/action contract.
//
// Perception is a SCREENSHOT and nothing else: every turn the agent sees the tab's
// current pixels, picks one action, and sees the result. There is no DOM manifest and
// there are no element ids — the model points at what it can see, in the screenshot's
// own pixel coordinates, and the client scales those to real mouse coordinates.
//
// Consequences worth knowing: the agent can only act on what is on screen (it must
// scroll to reach the rest), and native <select> popups are drawn by the OS outside the
// page, so they never appear in a capture.

/** What the /api/agent/step endpoint returns — ONE next action chosen by the model. */
export interface AgentStepResult {
  action:
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'hover'
    | 'drag'
    | 'navigate'
    | 'research'
    | 'ask'
    | 'wait'
    | 'uploadFile'
    | 'findCredentials'
    | 'fillCredential'
    | 'remember'
    | 'done';
  /** Click/hover/type target, in SCREENSHOT pixels (scaled to CSS px before dispatch). */
  x?: number;
  y?: number;
  /** For "type": the text to enter. With x/y, the point is clicked first to focus it. */
  text?: string;
  /** For "press": a single key, e.g. "Enter", "Escape", "Tab". */
  key?: string;
  url?: string;
  direction?: 'up' | 'down';
  /** For "drag": press at (fromX,fromY), release at (toX,toY) — screenshot pixels. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  /** For "ask": a question for the USER; the run pauses until they answer in the spotlight. */
  question?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before taking the next screenshot. */
  ms?: number;
  /** For "uploadFile": which dropped file (its index from the FILES list) to upload. */
  fileIndex?: number;
  /** Opaque vault metadata id returned by findCredentials. */
  credentialId?: string;
  done?: boolean;
  reason?: string;
  /** The model returned prose/refused instead of a JSON action; the loop counts these to stop a spin. */
  error?: boolean;
}

/** A cheap in-page signature so wait() can poll for change without spending a screenshot. */
export const PAGE_SIGNATURE_JS = `(location.href + '||' + document.title + '||' + Array.from(document.querySelectorAll('a,button,input,[role=button]')).slice(0,40).map(e => { const secret = e instanceof HTMLInputElement && e.type === 'password'; return (e.innerText || (secret ? '[password]' : e.value) || '').trim().slice(0,24); }).join('~'))`;

// --- Screenshot bridge (preload → main process) -------------------------------

export interface PageShot {
  ok: boolean;
  error?: string;
  /** PNG data URI of the tab's current viewport. */
  dataUri?: string;
  /** Size of the image the model sees — the coordinate space it answers in. */
  width?: number;
  height?: number;
  /** The page's CSS-pixel viewport, which is the coordinate space the mouse works in. */
  viewport?: { w: number; h: number };
}

/** Keyboard/scroll verbs that need no target — dispatched by byakugan in the main process. */
export type EyesActionVerb = 'press' | 'scroll';
export interface EyesActResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

interface TojiEyes {
  pageScreenshot?: (webContentsId: number, maxLongEdge?: number) => Promise<PageShot>;
  eyesAct?: (webContentsId: number, action: { verb: EyesActionVerb; key?: string; direction?: 'up' | 'down' }) => Promise<EyesActResult>;
}

function bridge(): TojiEyes | undefined {
  return (window as unknown as { toji?: TojiEyes }).toji;
}

export function eyesAvailable(): boolean {
  const t = bridge();
  return Boolean(t?.pageScreenshot && t.eyesAct);
}

export function pageScreenshot(webContentsId: number, maxLongEdge?: number): Promise<PageShot> {
  const fn = bridge()?.pageScreenshot;
  return fn ? fn(webContentsId, maxLongEdge) : Promise.resolve({ ok: false, error: 'screenshot bridge unavailable' });
}

export function eyesAct(webContentsId: number, action: { verb: EyesActionVerb; key?: string; direction?: 'up' | 'down' }): Promise<EyesActResult> {
  const fn = bridge()?.eyesAct;
  return fn ? fn(webContentsId, action) : Promise.resolve({ ok: false, error: 'action bridge unavailable' });
}

/**
 * Scale a point from screenshot pixels to page CSS pixels. The capture is downscaled for
 * token cost and taken in device pixels, so the two spaces rarely match; a model that
 * answers in CSS px anyway (or in 0..1 fractions) still lands in the right place.
 */
export function toPagePoint(x: number, y: number, shot: { width?: number; height?: number; viewport?: { w: number; h: number } }): { x: number; y: number } {
  const vw = shot.viewport?.w ?? 0;
  const vh = shot.viewport?.h ?? 0;
  if (!vw || !vh) return { x: Math.round(x), y: Math.round(y) };
  // A 0..1 fraction is unambiguous at this scale, and some models answer that way.
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x: Math.round(x * vw), y: Math.round(y * vh) };
  const iw = shot.width || vw;
  const ih = shot.height || vh;
  const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(max - 1, v)));
  return { x: clamp((x * vw) / iw, vw), y: clamp((y * vh) / ih, vh) };
}
