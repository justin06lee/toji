import { completeJSON, completeMultimodalJSON, modelSupportsVision } from './model.js';
import { gatherPageSources } from './search.js';

export interface AgentStepInput {
  goal: string;
  url: string;
  title?: string;
  /**
   * Byakugan view of the page: a render-truthful manifest of what is VISIBLE on screen
   * ("[id] role \"label\"" lines, ~200-800 tokens) on the first step, then a diff of only
   * what changed ("+"/"-"/"~" lines, or "NO CHANGE") on subsequent steps. Element ids are
   * stable across steps, so the model can refer to anything it has already seen.
   */
  page: string;
  history?: Array<{ action: string; reason?: string }>;
  /** Cropped screenshot the model requested via look() last turn (data URI). */
  image?: string;
  /** Where the screenshot crop sits in viewport CSS px — maps image pixels → clickAt coords. */
  crop?: { x: number; y: number; w: number; h: number };
  /** CSS pixel size of the page viewport. */
  viewport?: { w: number; h: number };
  /** Saved credential sets by name + field keys (NEVER values) the agent may fill via {{placeholder}}. */
  credentials?: { name: string; keys: string[]; active?: boolean }[];
  /** Files the user dropped onto the agent (e.g. a resume) — name + on-disk path the agent may read or upload. */
  files?: { index: number; name: string; mime?: string }[];
  /** Compact memory digest (from the librarian) of things worth remembering for this goal. */
  memory?: string;
}

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
  text?: string;
  /** For "press": one key, e.g. "Enter", "Escape", "Tab". */
  key?: string;
  /** For "select": the option's visible text or value. */
  value?: string;
  url?: string;
  direction?: 'down' | 'up';
  /** For "ask": a question for the USER; the run pauses and their answer comes back as an observation. */
  question?: string;
  /** For "runJS": JavaScript to evaluate in the page; its return value comes back as an observation. */
  code?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before re-checking the page. */
  ms?: number;
  /** For "clickAt": absolute viewport pixel where the click lands (canvas/visual targets only). */
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
  /** Set when the model returned prose/refused instead of a JSON action (client counts these to stop a spin). */
  error?: boolean;
}

// Kept deliberately short: a small model follows a tight prompt better than a long one.
const ACTIONS = `JSON only: {"action","id","text","key","value","url","direction","x","y","fromX","fromY","toX","toY","ms","question","reason"}.
- click(id) — click element [id]. type(id,text) — focus input [id] and type. select(id,value) — pick a dropdown option by its visible text. press(key) — one key ("Enter","Escape","Tab"). hover(id). scroll(direction "up"|"down").
  · Signing in / filling personal info: FIRST check CREDENTIALS. It lists every saved login set by name + field keys (never values), e.g. [{"name":"Primary","keys":["email","password"],"active":true},{"name":"School","keys":["email","password"]}] — those keys are the ONLY {{placeholders}} that exist. Pick the set that best matches the user's request ("my school email" → the "School" set), then type its placeholder: {{key}} uses the ACTIVE set, {{SetName:key}} uses a named set (e.g. {{School:email}}). The real value is filled in locally — you never see it. If CREDENTIALS is absent/empty or has no matching set/key, do NOT invent a placeholder or type a made-up value — use ask(question) to get what you need from the user. Never fabricate emails, usernames, or personal data; never ask for a password (ask the user to save it as a credential instead).
- Element actions are VERIFIED: if something (a cookie banner, modal, overlay) covers the target, the action is refused and your next observation says "blocked by <element>" — dismiss the blocker first, then retry. Never repeat an action that was just blocked.
- look(id?) — get a cropped SCREENSHOT of element [id] (or the whole viewport with no id) as your NEXT observation. Use it for anything flagged "text-blind", a <canvas>/board, an image/chart, or a visual layout the manifest can't capture. Don't request one every turn.
- clickAt(x,y) — click a raw viewport pixel; drag(fromX,fromY,toX,toY) — press at a source, release at a destination (REQUIRED to MOVE a piece/slider; a click does not move things). Pixel actions are ONLY for visual targets with no [id] (inside a canvas you have look()ed at). If you had a look(id) crop, CROP gives its viewport offset: viewportX = crop.x + imageX * crop.w / imageWidth.
- runJS(code) — evaluate JavaScript in the page and get its return value back as your next observation. Your ESCAPE HATCH: read page state the manifest misses (e.g. a <canvas> board — measure its rect and compute cell coordinates, then clickAt/drag those). Make the code RETURN a value.
- research(query) — ask a research sub-agent a question and get concrete step-by-step guidance back as your next observation. Use it when you are STUCK or don't know HOW to do something.
- ask(question) — pause and ask the USER a question; their answer arrives as your next observation. Use it whenever you need something only the user knows: which account/option to use, a missing credential or personal detail, a verification code, or a judgment call. Asking is cheap and encouraged — NEVER guess or fabricate personal information instead.
- uploadFile(fileIndex, id) — upload one of the user's dropped FILES (by its fileIndex) into file-input element [id]. To FILL text fields from a file's contents instead, read the file (its path is in FILES) and type the values.
- remember(text) — save a durable note about the user or this task for future sessions (a preference, a learned site quirk). Keep it short. Don't save secrets or one-off trivia.
- wait(ms?) — do nothing and re-check; use when it's not your turn or the page is still loading.
- navigate(url). done — only when the GOAL is fully achieved (say why).`;

const RULES = `Rules:
- The PAGE is the live page THIS turn. Element [id]s are STABLE: an element keeps its id until a "- [id]" line removes it, so you may act on ids from earlier turns that a DIFF did not remove. Never invent an id you were never shown.
- The manifest shows only the CURRENT VIEWPORT — scroll to reveal more. "…and N more similar" rows are real elements; the ids in their [a-b] range are actionable.
- NEVER invent URLs, ids, game codes, or paths. Only navigate to a URL the user gave you, one visible in the PAGE, or a site's plain homepage. To find a specific thing on a site, go to its homepage and use the site's own links/search.
- If the PAGE shows an error (404 / not found), the URL you guessed was wrong — navigate to the site's homepage and use its UI. Do not retry variations of a guessed URL.
- research guidance is ADVICE, not ground truth: the live PAGE always wins. If guidance names buttons that are not in the PAGE, they do not exist — ignore them.
- Pick ONE action toward the GOAL. Keep going until it is truly complete — do not stop early; only "done" when finished.
- "NO CHANGE" means your last action changed nothing visible — do something DIFFERENT (dismiss a blocker, scroll, wait, or research); never repeat it.
- Don't undo progress: never cancel, close, delete, reset, resign, log out, go back, or navigate away unless the GOAL asks.
- reason < 12 words.`;

// Coding CLIs (Claude Code, Codex, …) sometimes hedge — "I don't have browser-control tools" —
// because they think they must call a tool. They don't: they are the decision core and Toji
// executes the single JSON action they return. This line kills that failure mode.
const NO_REFUSAL = `You are the decision core of Toji's built-in browser automation. You do NOT call tools and need NO permissions — Toji executes the ONE JSON action you return, then shows you the new page. You already have full control of this real browser tab. NEVER refuse, apologize, or say you can't control the browser / lack tools / lack access — that is false here. Every turn, output exactly one JSON action. If unsure how, use research or look — never decline.`;

const SYSTEM_TEXT = `${NO_REFUSAL}

You operate a real browser tab with a real mouse to achieve the user's GOAL. Each turn you get the PAGE — a render-truthful text view of what is VISIBLE on screen — and choose ONE next action.

How to read the PAGE:
- The first step is a full manifest: a header line, then "[id] role \"label\"" lines for every interactive element (with input values, checked/selected state) and plain lines for visible text.
- Later steps are a DIFF of the last manifest: "+" appeared, "~" changed, "-" disappeared, "NO CHANGE" = nothing visible changed. Everything not mentioned is unchanged and still valid.
- "canvas … text-blind; use look(N)" marks pixels-only content (games, charts, cross-origin frames): look(N) to see it, then clickAt/drag raw coordinates inside it.

If MEMORY is present, it holds things you've learned about the user/their tasks — use it. If FILES are present, the user dropped them for you (e.g. a resume); read a file's path to use its contents, or uploadFile it into a file-input.

${ACTIONS}

${RULES}`;

const SYSTEM_VISION = `${NO_REFUSAL}

You operate a real browser tab with a real mouse to achieve the user's GOAL. This turn you ALSO get the SCREENSHOT you requested via look() — a crop of one element or the viewport — alongside the PAGE text view; choose ONE next action.

- Prefer acting on PAGE element [id]s (click/type/select) — they are exact and verified.
- Use the screenshot to understand visuals (a board, chart, image). For a visual target with NO [id], use clickAt/drag with viewport pixels; CROP gives the crop's viewport offset and size: viewportX = crop.x + imageX * crop.w / imageWidth (same for y).

${ACTIONS}

${RULES}`;

function sanitize(raw: AgentStepResult | undefined): AgentStepResult {
  const coord = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
  // Normalize the action case-insensitively to its canonical name (models return "Click",
  // " clickAt ", "RUNJS", etc.). Crucially, an UNRECOGNIZED action must NOT fall back to "done"
  // — that silently terminates the run. We fall back to "wait" so the loop re-checks instead.
  const canon: Record<string, AgentStepResult['action']> = {
    click: 'click', type: 'type', press: 'press', select: 'select', hover: 'hover', scroll: 'scroll',
    navigate: 'navigate', clickat: 'clickAt', drag: 'drag', runjs: 'runJS', research: 'research',
    ask: 'ask', wait: 'wait', look: 'look', screenshot: 'look', uploadfile: 'uploadFile', remember: 'remember', done: 'done'
  };
  const rawAction = typeof raw?.action === 'string' ? raw.action.trim().toLowerCase() : '';
  const action = canon[rawAction] ?? 'wait';
  // Models sometimes put the element id in "index" (the old contract) — accept both.
  const legacyIndex = (raw as { index?: unknown } | undefined)?.index;
  const id = typeof raw?.id === 'number' && Number.isFinite(raw.id) ? Math.round(raw.id) : typeof legacyIndex === 'number' && Number.isFinite(legacyIndex) ? Math.round(legacyIndex) : undefined;
  const out: AgentStepResult = {
    action,
    id,
    text: typeof raw?.text === 'string' ? raw.text : undefined,
    key: typeof raw?.key === 'string' ? raw.key.trim().slice(0, 24) : undefined,
    value: typeof raw?.value === 'string' ? raw.value.slice(0, 200) : undefined,
    url: typeof raw?.url === 'string' ? raw.url : undefined,
    direction: raw?.direction === 'up' ? 'up' : raw?.direction === 'down' ? 'down' : undefined,
    x: coord(raw?.x),
    y: coord(raw?.y),
    fromX: coord(raw?.fromX),
    fromY: coord(raw?.fromY),
    toX: coord(raw?.toX),
    toY: coord(raw?.toY),
    ms: typeof raw?.ms === 'number' && Number.isFinite(raw.ms) ? raw.ms : undefined,
    code: typeof raw?.code === 'string' ? raw.code.slice(0, 4000) : undefined,
    query: typeof raw?.query === 'string' ? raw.query.slice(0, 300) : undefined,
    question: typeof raw?.question === 'string' ? raw.question.slice(0, 300) : undefined,
    fileIndex: typeof raw?.fileIndex === 'number' && raw.fileIndex >= 0 ? Math.round(raw.fileIndex) : undefined,
    // Only a genuine "done" action ends the run — never a stray done:true beside a real action.
    done: action === 'done',
    reason: typeof raw?.reason === 'string' ? raw.reason.slice(0, 100) : undefined
  };
  // Models frequently put a free-form action's payload in the wrong field ("research"
  // with the question in `text`, "ask" with it in `query`). Coalesce so the action still
  // carries its required field instead of arriving hollow at the client.
  if (out.action === 'research' && !out.query) out.query = out.question ?? out.text?.slice(0, 300);
  if (out.action === 'ask' && !out.question) out.question = out.query ?? out.text?.slice(0, 300);
  if (out.action === 'remember' && !out.text) out.text = out.query ?? out.question;
  return out;
}

/**
 * Research sub-agent: the main agent calls this when it's stuck or unsure HOW to accomplish
 * something. Pulls a few real web sources for the question and synthesizes concrete, step-by-step
 * guidance the agent can act on. General — works for any task, not just one site.
 */
export async function researchHelp(input: { question: string; goal?: string; url?: string }): Promise<string> {
  const gathered = await gatherPageSources(input.question).catch((error) => {
    console.warn('[toji] researchHelp source gathering failed:', error instanceof Error ? error.message : error);
    return [];
  });
  // Drop the search pipeline's placeholder "sources" (links to google/DDG results pages,
  // emitted when real search fails) — passing those as SOURCES makes the model believe it
  // is grounded when it has nothing, and it then invents UI with full confidence.
  const sources = gathered.filter((s) => !/duckduckgo\.com\/html|google\.com\/search/i.test(s.url));
  const sourceText = sources
    .slice(0, 5)
    .map((s, i) => `[${i + 1}] ${s.title}${s.summary ? ` — ${s.summary}` : ''} (${s.url})`)
    .join('\n');
  const grounding = sourceText
    ? 'Ground in SOURCES when relevant; do not invent UI that may not exist.'
    : 'You have NO web sources for this question. Answer ONLY from well-established knowledge of widely used websites. If you are not confident the UI you would describe actually exists, respond {"answer": ""} — a wrong answer sends the agent chasing buttons that do not exist, which is far worse than no answer.';
  try {
    const res = await completeJSON<{ answer: string }>({
      system: `You are a research assistant for a web-automation agent that is stuck. Given the QUESTION (and the agent's GOAL/URL), give SHORT, concrete, ordered steps the agent can directly act on (name the buttons/links/fields and the order). ${grounding} Never invent URLs, ids, or codes. Under 80 words. Respond as JSON {"answer": string}.`,
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
  const vision = modelSupportsVision();
  const user = JSON.stringify({
    GOAL: input.goal,
    url: input.url,
    title: input.title ?? '',
    viewport: input.viewport,
    CREDENTIALS: input.credentials && input.credentials.length ? input.credentials : undefined,
    FILES: input.files && input.files.length ? input.files : undefined,
    MEMORY: input.memory && input.memory.trim() ? input.memory.trim() : undefined,
    CROP: input.image && vision ? input.crop : undefined,
    // The model asked to look but can't see images (text-only backend). Say so explicitly,
    // or a small model loops "taking a look…" forever learning nothing each time.
    NOTE: input.image && !vision ? 'Your model CANNOT see images — "look" does nothing for you. Never use it again; work from the PAGE text and runJS instead.' : undefined,
    PAGE: input.page,
    history: (input.history ?? []).slice(-6)
  });

  // A firm nudge appended on a retry: models that reply with prose/refusal on the first pass
  // usually comply when reminded the ONLY valid output is the JSON action.
  const RETRY_NUDGE = `${user}\n\nREMINDER: Return ONLY the JSON action object — no prose, no refusal. You DO control this browser; pick the single best next action now.`;

  // Vision path: ONLY when the model requested a look() last turn AND actually accepts image
  // input. Text stays the default sense — that's what keeps per-step cost at manifest/diff size.
  if (input.image && vision) {
    try {
      let raw: AgentStepResult;
      try {
        raw = await completeMultimodalJSON<AgentStepResult>({ system: SYSTEM_VISION, userText: user, imageDataUri: input.image, temperature: 0.1, maxTokens: 320 });
      } catch {
        // One firm retry before giving up on the vision path.
        raw = await completeMultimodalJSON<AgentStepResult>({ system: SYSTEM_VISION, userText: RETRY_NUDGE, imageDataUri: input.image, temperature: 0.1, maxTokens: 320 });
      }
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
    let raw: AgentStepResult;
    try {
      raw = await completeJSON<AgentStepResult>({ system: SYSTEM_TEXT, user, temperature: 0.1, maxTokens: 300 });
    } catch {
      // The model returned prose/refused — retry once with a firm reminder to emit JSON only.
      raw = await completeJSON<AgentStepResult>({ system: SYSTEM_TEXT, user: RETRY_NUDGE, temperature: 0.1, maxTokens: 300 });
    }
    return sanitize(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'agent unavailable';
    // Flag it as an error (not a genuine wait) so the client can count refusals and stop the spin.
    return { ...sanitize({ action: 'wait', ms: 1200, reason: reason.slice(0, 100) }), error: true };
  }
}
