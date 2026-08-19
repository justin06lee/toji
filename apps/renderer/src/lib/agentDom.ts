// The web agent's perception/action types + the typed bridge to byakugan in the main
// process (window.toji.eyes*). Perception is no longer scraped in-page: byakugan reads
// what Chromium actually painted (over CDP) into a stable-ID text manifest and verifies
// every action against fresh geometry at dispatch time.

/** What the /api/agent/step endpoint returns — ONE next action chosen by the model. */
export interface AgentStepResult {
  action:
    | 'click'
    | 'type'
    | 'press'
    | 'select'
    | 'hover'
    | 'scroll'
    | 'navigate'
    | 'clickAt'
    | 'drag'
    | 'runJS'
    | 'research'
    | 'ask'
    | 'wait'
    | 'look'
    | 'uploadFile'
    | 'remember'
    | 'done';
  /** Byakugan manifest element id (click/type/select/hover/uploadFile/look). */
  id?: number;
  /** For "type": the text to enter ({{placeholders}} resolved locally, never seen by the model). */
  text?: string;
  /** For "press": a single key, e.g. "Enter", "Escape", "Tab". */
  key?: string;
  /** For "select": the option's visible text or value. */
  value?: string;
  url?: string;
  direction?: 'up' | 'down';
  /** For "ask": a question for the USER; the run pauses until they answer in the spotlight. */
  question?: string;
  /** For "runJS": JavaScript to evaluate in the page; its return value comes back as an observation. */
  code?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before re-checking the page. */
  ms?: number;
  /** For "clickAt": absolute viewport pixel where the click lands (canvas/visual targets). */
  x?: number;
  y?: number;
  /** For "drag": press at (fromX,fromY) and release at (toX,toY), in absolute viewport pixels. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  /** For "uploadFile": which dropped file (its index from the FILES list) to upload. */
  fileIndex?: number;
  done?: boolean;
  reason?: string;
  /** The model returned prose/refused instead of a JSON action; the loop counts these to stop a spin. */
  error?: boolean;
}

/** A cheap in-page signature so wait() can poll for change without consuming a byakugan diff. */
export const PAGE_SIGNATURE_JS = `(location.href + '||' + document.title + '||' + Array.from(document.querySelectorAll('a,button,input,[role=button]')).slice(0,40).map(e => (e.innerText||e.value||'').trim().slice(0,24)).join('~'))`;

// --- Byakugan bridge (preload → main process) --------------------------------

export interface EyesElement {
  id: number;
  role: string;
  label: string;
  bounds: { x: number; y: number; w: number; h: number };
}
export interface EyesMeta {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollPct: number;
  frameCount: number;
  tokens: number;
}
export interface EyesView {
  ok: boolean;
  error?: string;
  /** Manifest text (observe / full diff) or the compact diff text ("NO CHANGE" when idle). */
  text?: string;
  tokens?: number;
  /** diff() only: whether it fell back to the full manifest / a navigation happened. */
  full?: boolean;
  navigated?: boolean;
  meta?: EyesMeta;
  elements?: EyesElement[];
}
export type EyesActionVerb = 'click' | 'type' | 'press' | 'select' | 'hover' | 'scroll' | 'navigate';
export interface EyesActResult {
  ok: boolean;
  detail?: string;
  error?: string;
  /** What's covering the target when a verified action is refused (e.g. "div#cookie-banner"). */
  blockedBy?: string;
}
export interface EyesLookResult {
  ok: boolean;
  error?: string;
  dataUri?: string;
  width?: number;
  height?: number;
  tokens?: number;
  /** Where the crop sits in viewport CSS px, so screenshot pixels map back to clickAt coords. */
  crop?: { x: number; y: number; w: number; h: number };
}

interface TojiEyes {
  eyesObserve?: (webContentsId: number, maxTokens?: number) => Promise<EyesView>;
  eyesDiff?: (webContentsId: number, maxTokens?: number) => Promise<EyesView>;
  eyesAct?: (webContentsId: number, action: { verb: EyesActionVerb; id?: number; text?: string; key?: string; value?: string; url?: string; direction?: 'up' | 'down' }) => Promise<EyesActResult>;
  eyesLook?: (webContentsId: number, target?: { id?: number; rect?: { x: number; y: number; w: number; h: number }; maxLongEdge?: number }) => Promise<EyesLookResult>;
}

function bridge(): TojiEyes | undefined {
  return (window as unknown as { toji?: TojiEyes }).toji;
}

export function eyesAvailable(): boolean {
  const t = bridge();
  return Boolean(t?.eyesObserve && t.eyesDiff && t.eyesAct && t.eyesLook);
}

export function eyesObserve(webContentsId: number, maxTokens?: number): Promise<EyesView> {
  const fn = bridge()?.eyesObserve;
  return fn ? fn(webContentsId, maxTokens) : Promise.resolve({ ok: false, error: 'perception bridge unavailable' });
}
export function eyesDiff(webContentsId: number, maxTokens?: number): Promise<EyesView> {
  const fn = bridge()?.eyesDiff;
  return fn ? fn(webContentsId, maxTokens) : Promise.resolve({ ok: false, error: 'perception bridge unavailable' });
}
export function eyesAct(webContentsId: number, action: { verb: EyesActionVerb; id?: number; text?: string; key?: string; value?: string; url?: string; direction?: 'up' | 'down' }): Promise<EyesActResult> {
  const fn = bridge()?.eyesAct;
  return fn ? fn(webContentsId, action) : Promise.resolve({ ok: false, error: 'perception bridge unavailable' });
}
export function eyesLook(webContentsId: number, target?: { id?: number; rect?: { x: number; y: number; w: number; h: number }; maxLongEdge?: number }): Promise<EyesLookResult> {
  const fn = bridge()?.eyesLook;
  return fn ? fn(webContentsId, target) : Promise.resolve({ ok: false, error: 'perception bridge unavailable' });
}
