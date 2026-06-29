import { completeJSON, completeMultimodalJSON, modelSupportsVision } from './model.js';
import { gatherPageSources } from './search.js';

export interface AgentStepInput {
  goal: string;
  url: string;
  title?: string;
  scrollY?: number;
  maxScroll?: number;
  /** Each element carries its on-screen pixel rect so text-only models can clickAt/drag it too. */
  elements: Array<{ i: number; tag: string; role: string; name: string; value?: string; rect?: { x: number; y: number; w: number; h: number } }>;
  history?: Array<{ action: string; reason?: string }>;
  /** Optional JPEG/PNG data URI of the visible page, enabling vision (canvases, game boards, images). */
  image?: string;
  /** CSS pixel size of the captured viewport, so the model can reason about scale if needed. */
  viewport?: { w: number; h: number };
  /**
   * The labeled board/grid cells (ref + exact pixel center) when the page is a board. Sent for
   * EVERY model — a text-only model has no screenshot, so this list is how it "sees" the grid and
   * picks drag(fromCell,toCell) moves. Empty/absent when there's no board.
   */
  cells?: Array<{ ref: string; cx: number; cy: number }>;
  /** Saved credential sets by name + field keys (NEVER values) the agent may fill via {{placeholder}}. */
  credentials?: { name: string; keys: string[]; active?: boolean }[];
}

export interface AgentStepResult {
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'clickAt' | 'drag' | 'runJS' | 'research' | 'wait' | 'done';
  index?: number;
  text?: string;
  url?: string;
  direction?: 'down' | 'up';
  /** For "runJS": JavaScript to evaluate in the page; its return value comes back as an observation. */
  code?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before re-checking the page. */
  ms?: number;
  /** For "clickAt": absolute viewport pixel where the click lands. */
  x?: number;
  y?: number;
  /** For "drag": press at (fromX,fromY) and release at (toX,toY), in absolute pixels. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  /** For "drag": use an element index as the exact source/destination instead of pixels. */
  fromIndex?: number;
  toIndex?: number;
  /** For "drag" on a labeled board: source/destination square refs, e.g. "e2" → "e4". */
  fromCell?: string;
  toCell?: string;
  /** For "cell": the numbered grid cell (red overlay) to click. */
  cellId?: number;
  done?: boolean;
  reason?: string;
}

// Kept deliberately short: a small model follows a tight prompt better than a long one.
const ACTIONS = `JSON only: {"action","index","text","url","direction","x","y","fromCell","toCell","fromIndex","toIndex","fromX","fromY","toX","toY","ms","reason"}.
- click(index) — click element by its index. type(index,text) — focus an input and type. scroll(direction "up"|"down").
  · To sign in, use a SAVED credential. CREDENTIALS lists your login sets by name + field keys (never values), e.g. [{"name":"Primary","keys":["email","password"],"active":true},{"name":"School","keys":["email","password"]}]. Pick the set that best matches the user's request ("my school email" → the "School" set), then type its placeholder: {{key}} uses the ACTIVE set, {{SetName:key}} uses a named set (e.g. {{School:email}}, {{School:password}}). The real value is filled in locally — you never see it. NEVER guess, invent, or ask for a password; only use these {{placeholders}}.
- clickAt(x,y) — single click a visual target with no element label, at absolute pixels x,y.
- drag — press at a source and release at a destination. REQUIRED to MOVE something (a board piece, slider, drag-and-drop; a single click does NOT move a piece). On a LABELED BOARD use square refs: drag(fromCell,toCell) e.g. fromCell "e2", toCell "e4". Otherwise use element indexes drag(fromIndex,toIndex) or pixels drag(fromX,fromY,toX,toY).
- runJS(code) — evaluate JavaScript in the page and get its return value back as your next observation. Your ESCAPE HATCH: use it to inspect the DOM, find/measure things the labels miss, or read the page's own state (e.g. a <canvas> board with no piece elements — measure its rect and compute square coordinates, then clickAt/drag those). Make the code RETURN a value.
- research(query) — ask a research sub-agent a question and get concrete step-by-step guidance back as your next observation. Use it when you are STUCK or don't know HOW to do something (e.g. "how do I start a 10-minute game on lichess?", "how to check out as a guest on this site?").
- wait(ms?) — do nothing and re-check; use when it's not your turn or the page is still loading.
- navigate(url). done — only when the GOAL is fully achieved (say why).`;

const RULES = `Rules:
- The ELEMENTS and screenshot are the LIVE page THIS turn. Decide ONLY from them — never from memory or assumptions about earlier turns. The page changes every turn, so your memory is stale; never reference an item/position not in the current ELEMENTS.
- Pick ONE action toward the GOAL. Keep going until it is truly complete — do not stop early; only "done" when finished.
- Never repeat an action that didn't change the page (check history); choose something different, scroll, wait, or — if you're stuck or unsure HOW to proceed — use research to get guidance.
- Don't undo progress: never cancel, close, delete, reset, resign, log out, go back, or navigate away unless the GOAL asks.
- reason < 12 words.`;

const SYSTEM_TEXT = `You operate a real browser tab with a real mouse to achieve the user's GOAL. Each turn you get the page's interactive ELEMENTS; choose ONE next action.

How to read the page (no screenshot — use these instead):
- Each ELEMENT line is "[index] role name (x,y)" where (x,y) is its exact on-screen pixel center. Prefer click(index) — it's exact. For a visual target with NO element label, use clickAt(x,y), aiming at a listed (x,y) or interpolating between nearby ones.
- If LIVE_STATE is present, the page is a BOARD/grid and LIVE_STATE is the authoritative cell→occupant map for THIS turn (e.g. {"e2":"white pawn"}). BOARD_CELLS lists every valid cell ref. To MOVE an occupant you MUST use drag(fromCell,toCell) with cell refs (e.g. fromCell "e2", toCell "e4") — a click does NOT move it. YOU control the pieces nearest the BOTTOM (the low ranks); move one of them toward higher ranks; do NOT assume you are White. Only "wait" right after you have moved, for the opponent to reply.

${ACTIONS}

${RULES}`;

const SYSTEM_VISION = `You operate a real browser tab with a real mouse to achieve the user's GOAL. Each turn you get a SCREENSHOT and the page's ELEMENTS; choose ONE next action.

The screenshot is annotated:
- BLUE numbers mark interactive elements (= their index). Click with click(index) — exact, prefer over pixels.
- If a BOARD/grid is present, each cell is labeled with a red ref (e.g. "e4") and LIVE_STATE is the authoritative cell→occupant map for THIS turn (e.g. {"e2":"white pawn"}). Trust LIVE_STATE as the true current position — read it fresh every turn, do not assume it from memory. To move an occupant you MUST use drag(fromCell,toCell) with cell refs (e.g. fromCell "e2", toCell "e4"). Do NOT use fromIndex/toIndex or pixels for board moves — the destination cell usually has no element.
- YOU control the pieces nearest the BOTTOM (the low ranks, 1–2). They are all one colour — that is YOUR colour (do NOT assume White). On your turn, MOVE one of your bottom pieces forward (toward higher ranks); never "wait" for your own side. Only "wait" right after you have moved, for the opponent (top side) to reply.
- Otherwise a RED grid labels intersections with pixel coords "x,y"; use clickAt(x,y) or drag(fromX,fromY,toX,toY) for unlabeled visual targets.

${ACTIONS}

${RULES}`;

function sanitize(raw: AgentStepResult | undefined): AgentStepResult {
  // x,y are absolute viewport pixels now (a 0..1 fraction is also accepted as a fallback).
  const coord = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
  // Normalize the action case-insensitively to its canonical name (models return "Click",
  // " clickAt ", "RUNJS", etc.). Crucially, an UNRECOGNIZED action must NOT fall back to "done"
  // — that silently terminates the run. We fall back to "wait" so the loop re-checks instead.
  const canon: Record<string, AgentStepResult['action']> = {
    click: 'click', type: 'type', scroll: 'scroll', navigate: 'navigate', clickat: 'clickAt', drag: 'drag', runjs: 'runJS', research: 'research', wait: 'wait', done: 'done'
  };
  const rawAction = typeof raw?.action === 'string' ? raw.action.trim().toLowerCase() : '';
  const action = canon[rawAction] ?? 'wait';
  return {
    action,
    index: typeof raw?.index === 'number' ? raw.index : undefined,
    text: typeof raw?.text === 'string' ? raw.text : undefined,
    url: typeof raw?.url === 'string' ? raw.url : undefined,
    direction: raw?.direction === 'up' ? 'up' : raw?.direction === 'down' ? 'down' : undefined,
    x: coord(raw?.x),
    y: coord(raw?.y),
    fromX: coord(raw?.fromX),
    fromY: coord(raw?.fromY),
    toX: coord(raw?.toX),
    toY: coord(raw?.toY),
    fromIndex: typeof raw?.fromIndex === 'number' ? raw.fromIndex : undefined,
    toIndex: typeof raw?.toIndex === 'number' ? raw.toIndex : undefined,
    fromCell: typeof raw?.fromCell === 'string' ? raw.fromCell.trim().toLowerCase().slice(0, 4) : undefined,
    toCell: typeof raw?.toCell === 'string' ? raw.toCell.trim().toLowerCase().slice(0, 4) : undefined,
    ms: typeof raw?.ms === 'number' && Number.isFinite(raw.ms) ? raw.ms : undefined,
    code: typeof raw?.code === 'string' ? raw.code.slice(0, 4000) : undefined,
    query: typeof raw?.query === 'string' ? raw.query.slice(0, 300) : undefined,
    cellId: typeof raw?.cellId === 'number' && raw.cellId >= 0 ? Math.round(raw.cellId) : undefined,
    // Only a genuine "done" action ends the run — never a stray done:true beside a real action.
    done: action === 'done',
    reason: typeof raw?.reason === 'string' ? raw.reason.slice(0, 100) : undefined
  };
}

// When the page is a grid/board, the snapshot tags each occupant with its cell (e.g.
// "white pawn @e2"). Restate those as a clean cell→occupant map so the model treats it as the
// authoritative current state rather than relying on (often wrong) memory. General — any labeled
// grid, not just chess. Returns undefined when there's no board.
const CELL_RE = /@\s*([a-z]?\d{1,2})\s*$/i;
function liveState(elements: AgentStepInput['elements']): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const e of elements) {
    const m = /(.*?)\s*@\s*([a-z]?\d{1,2})$/i.exec(e.name || '');
    if (m) map[m[2].toLowerCase()] = m[1].trim();
  }
  return Object.keys(map).length ? map : undefined;
}

// Compact, deduped element list for the prompt: one short string per control instead of a fat
// JSON object, and we DROP grid occupants (they're already in LIVE_STATE) — big token saving on
// any board/grid page, fully general. Each line ends with the element's on-screen pixel center
// "(x,y)" so a text-only model (no screenshot) can still aim clickAt/drag at exact coordinates.
function compactElements(elements: AgentStepInput['elements']): string[] {
  const out: string[] = [];
  for (const e of elements) {
    if (CELL_RE.test(e.name || '')) continue; // occupant → lives in LIVE_STATE
    const v = e.value ? ` ="${e.value.slice(0, 40)}"` : '';
    const at = e.rect ? ` (${Math.round(e.rect.x + e.rect.w / 2)},${Math.round(e.rect.y + e.rect.h / 2)})` : '';
    out.push(`[${e.i}] ${e.role} ${e.name}`.replace(/\s+/g, ' ').trim() + v + at);
  }
  return out;
}

// Compact board descriptor for text-only models: the ref scheme plus the exact pixel center of
// every cell, so the model can pick drag(fromCell,toCell) moves (or clickAt a square) without a
// screenshot. General — any labeled grid, not just chess. Returns undefined when there's no board.
function boardCells(cells: AgentStepInput['cells']): { refs: string; coords: Record<string, string> } | undefined {
  if (!cells || !cells.length) return undefined;
  const coords: Record<string, string> = {};
  for (const c of cells) coords[c.ref] = `${Math.round(c.cx)},${Math.round(c.cy)}`;
  return { refs: cells.map((c) => c.ref).join(' '), coords };
}

/**
 * Research sub-agent: the main agent calls this when it's stuck or unsure HOW to accomplish
 * something. Pulls a few real web sources for the question and synthesizes concrete, step-by-step
 * guidance the agent can act on. General — works for any task, not just one site.
 */
export async function researchHelp(input: { question: string; goal?: string; url?: string }): Promise<string> {
  const sources = await gatherPageSources(input.question).catch((error) => {
    console.warn('[toji] researchHelp source gathering failed:', error instanceof Error ? error.message : error);
    return [];
  });
  const sourceText = sources
    .slice(0, 5)
    .map((s, i) => `[${i + 1}] ${s.title}${s.summary ? ` — ${s.summary}` : ''} (${s.url})`)
    .join('\n');
  try {
    const res = await completeJSON<{ answer: string }>({
      system:
        'You are a research assistant for a web-automation agent that is stuck. Given the QUESTION (and the agent\'s GOAL/URL), give SHORT, concrete, ordered steps the agent can directly act on (name the buttons/links/fields and the order). Ground in SOURCES when relevant; do not invent UI that may not exist. Under 80 words. Respond as JSON {"answer": string}.',
      user: JSON.stringify({ QUESTION: input.question, GOAL: input.goal, URL: input.url, SOURCES: sourceText || undefined }),
      temperature: 0.2,
      maxTokens: 320
    });
    return (res?.answer || '').toString().slice(0, 700);
  } catch (error) {
    console.warn('[toji] researchHelp agent call failed:', error instanceof Error ? error.message : error);
    return '';
  }
}

export async function nextAgentAction(input: AgentStepInput): Promise<AgentStepResult> {
  const board = boardCells(input.cells);
  const user = JSON.stringify({
    GOAL: input.goal,
    page: { url: input.url, title: input.title ?? '', scrollY: input.scrollY ?? 0, maxScroll: input.maxScroll ?? 0, viewport: input.viewport },
    // If the page is a grid/board, restate the occupied cells as the authoritative live position
    // (derived from this turn's ELEMENTS) so the model reads it instead of confabulating.
    LIVE_STATE: liveState(input.elements),
    // The full set of move targets (text models can't see the screenshot's labeled grid).
    BOARD_CELLS: board?.refs,
    CREDENTIALS: input.credentials && input.credentials.length ? input.credentials : undefined,
    ELEMENTS: compactElements(input.elements),
    history: (input.history ?? []).slice(-6)
  });

  // Vision path: ONLY for models that actually accept image input. Letting the model see the page
  // lets it act on canvases / boards / images with no DOM element. Text-only models (gpt-oss, glm,
  // …) skip this — they get the same grounding as text (element coords + BOARD_CELLS + LIVE_STATE).
  if (input.image && modelSupportsVision()) {
    try {
      const raw = await completeMultimodalJSON<AgentStepResult>({
        system: SYSTEM_VISION,
        userText: user,
        imageDataUri: input.image,
        temperature: 0.1,
        maxTokens: 320
      });
      return sanitize(raw);
    } catch (error) {
      console.warn('[toji] vision agent step failed, falling back to text-only:', error instanceof Error ? error.message : error);
    }
  }

  // Unlike prediction/planning/synthesis, a browser action can't be produced by a
  // deterministic heuristic — it's fundamentally model-driven. So if the agent is
  // unavailable (not configured, missing binary, timeout, non-JSON), degrade to a
  // "wait" step instead of throwing: the client loop pauses and surfaces the reason
  // rather than the route returning a 500.
  try {
    const raw = await completeJSON<AgentStepResult>({
      system: SYSTEM_TEXT,
      user,
      temperature: 0.1,
      maxTokens: 300
    });
    return sanitize(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'agent unavailable';
    return sanitize({ action: 'wait', ms: 1200, reason: reason.slice(0, 100) });
  }
}
