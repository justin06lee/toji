import { completeJSON, completeMultimodalJSON, modelSupportsVision } from './model.js';
import { gatherPageSources } from './search.js';

export interface AgentStepInput {
  goal: string;
  url: string;
  title?: string;
  history?: Array<{ action: string; reason?: string }>;
  /** The tab's current screenshot (data URI) — the agent's ONLY view of the page. */
  image?: string;
  /** Pixel size of that screenshot: the coordinate space the model must answer in. */
  image_size?: { w: number; h: number };
  /** Whether the OS-backed credential tools are available for this tab. */
  credentialAccess?: boolean;
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
  /** Click/hover/type target in SCREENSHOT pixels. */
  x?: number;
  y?: number;
  text?: string;
  /** For "press": one key, e.g. "Enter", "Escape", "Tab". */
  key?: string;
  url?: string;
  direction?: 'down' | 'up';
  /** For "ask": a question for the USER; the run pauses and their answer comes back as an observation. */
  question?: string;
  /** For "research": a question for the research sub-agent; its answer comes back as an observation. */
  query?: string;
  /** For "wait": how long to pause (ms) before re-checking the page. */
  ms?: number;
  /** For "drag": press at (fromX,fromY) and release at (toX,toY), in screenshot pixels. */
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  /** For "uploadFile": which dropped file (its index from the FILES list) to upload. */
  fileIndex?: number;
  /** Opaque metadata id returned by findCredentials; never a secret. */
  credentialId?: string;
  done?: boolean;
  reason?: string;
  /** Set when the model returned prose/refused instead of a JSON action (client counts these to stop a spin). */
  error?: boolean;
}

// Kept deliberately short: a small model follows a tight prompt better than a long one.
const ACTIONS = `JSON only: {"action","x","y","text","key","url","direction","fromX","fromY","toX","toY","ms","question","query","fileIndex","credentialId","reason"}.
Coordinates are PIXELS IN THE SCREENSHOT you were just given (its size is IMAGE_SIZE). Aim at the CENTRE of what you want to hit.
- click(x,y) — click that point. hover(x,y) — move the mouse there (opens hover menus).
- type(text, x, y) — click (x,y) to focus the field, then type text. Omit x,y only to type into what is already focused.
- press(key) — one key: "Enter", "Escape", "Tab", "Backspace", "ArrowDown".
- scroll(direction "up"|"down") — the page only shows one screenful; scroll to see the rest.
- drag(fromX,fromY,toX,toY) — press at the source and release at the destination. REQUIRED to move a piece/slider/card; a click does not move things.
  · Signing in: if CREDENTIAL_ACCESS is true, FIRST use findCredentials(query) with the current website name. It searches only credentials matching this exact page origin and container and returns account metadata (name, username, opaque id), never secrets. Then use fillCredential(credentialId) to fill the selected login directly. Never type password placeholders and never ask the user for a password; if nothing matches, ask them to save a login in Toji.
- research(query) — ask a research sub-agent a question and get concrete step-by-step guidance back as your next observation. Use it when you are STUCK or don't know HOW to do something.
- ask(question) — pause and ask the USER a question; their answer arrives as your next observation. Use it whenever you need something only the user knows: which account/option to use, a missing credential or personal detail, a verification code, or a judgment call. Asking is cheap and encouraged — NEVER guess or fabricate personal information instead.
- uploadFile(fileIndex) — upload one of the user's dropped FILES into the page's file input. To FILL text fields from a file's contents instead, read the file (its path is in FILES) and type the values.
- remember(text) — save a durable note about the user or this task for future sessions (a preference, a learned site quirk). Keep it short. Don't save secrets or one-off trivia.
- wait(ms?) — do nothing and look again; use when it's not your turn or the page is still loading.
- navigate(url). done — only when the GOAL is fully achieved (say why).`;

const RULES = `Rules:
- The SCREENSHOT is the live page THIS turn and your ONLY view of it. Act only on what you can actually SEE in it; never act on something you merely remember or assume is there.
- You see ONE screenful. Anything below the fold does not exist until you scroll(down) and look again.
- Read coordinates off the image carefully: aim at the centre of the button/field/link, not its edge or its label's first letter.
- After acting you get a fresh screenshot. If it looks unchanged, your action missed or did nothing — do something DIFFERENT (aim again more carefully, dismiss an overlay, scroll, wait, or research). Never repeat an action that changed nothing.
- Cookie banners, consent walls and modals block everything underneath: dismiss them FIRST.
- Native dropdown popups (<select>) are drawn by the OS and CANNOT be captured — after clicking one, use press("ArrowDown")/press("Enter") to choose, or prefer a different control.
- NEVER invent URLs, game codes, or paths. Only navigate to a URL the user gave you, one visible on the page, or a site's plain homepage. To find a specific thing on a site, go to its homepage and use the site's own links/search.
- If the page shows an error (404 / not found), the URL you guessed was wrong — navigate to the site's homepage and use its UI. Do not retry variations of a guessed URL.
- research guidance is ADVICE, not ground truth: the live page always wins. If guidance names buttons that are not on screen, they do not exist — ignore them.
- Pick ONE action toward the GOAL. Keep going until it is truly complete — do not stop early; only "done" when finished.
- Don't undo progress: never cancel, close, delete, reset, resign, log out, go back, or navigate away unless the GOAL asks.
- reason < 12 words.`;

// Coding CLIs (Claude Code, Codex, …) sometimes hedge — "I don't have browser-control tools" —
// because they think they must call a tool. They don't: they are the decision core and Toji
// executes the single JSON action they return. This line kills that failure mode.
const NO_REFUSAL = `You are the decision core of Toji's built-in browser automation. You do NOT call tools and need NO permissions — Toji executes the ONE JSON action you return, then shows you the new page. You already have full control of this real browser tab. NEVER refuse, apologize, or say you can't control the browser / lack tools / lack access — that is false here. Every turn, output exactly one JSON action. If unsure how, use research or look — never decline.`;

const SYSTEM_VISION = `${NO_REFUSAL}

You operate a real browser tab with a real mouse and keyboard to achieve the user's GOAL.

Each turn you SEE a screenshot of the tab exactly as it looks right now, and you choose ONE action. Toji performs it and sends you the next screenshot. Look, act, look, act — that is the whole loop. The screenshot is your only sense: there is no text listing of the page, so read the image and point at what you see.

If MEMORY is present, it holds things you've learned about the user/their tasks — use it. If FILES are present, the user dropped them for you (e.g. a resume); read a file's path to use its contents, or uploadFile it into the page's file input.

${ACTIONS}

${RULES}`;

// Before anything is open there is nothing to screenshot, so this one turn is spent
// choosing where to go. Coordinates are impossible here — only navigate/ask make sense.
const SYSTEM_BOOTSTRAP = `${NO_REFUSAL}

You operate a real browser tab to achieve the user's GOAL. NO page is open yet, so there is nothing to see this turn — your only job is to decide which URL to open first.

Reply {"action":"navigate","url":"...","reason":"..."} with the site the GOAL needs: the URL the user named, or that site's plain HOMEPAGE. NEVER invent a deep link, game code, or path — open the homepage and navigate with the site's own UI once you can see it.
If the GOAL names no site and you cannot tell which one to use, reply {"action":"ask","question":"..."}.
From the next turn on you will SEE a screenshot of the page and act on it.`;

// Fallback for a backend that cannot accept images at all. It has no view of the page, so
// the only honest move is to say so rather than let it act blind on a page it cannot see.
const SYSTEM_BLIND = `${NO_REFUSAL}

You operate a real browser tab, but the current model CANNOT see images and Toji's web agent is screenshot-only, so you have NO view of the page this turn.

Do not guess coordinates — a blind click can do real damage. Reply with {"action":"ask","question":"..."} telling the user that browsing needs a vision-capable model (Claude Code or Codex via Yagami), or {"action":"done","reason":"..."} if the goal needs no page interaction.`;

export function sanitize(raw: AgentStepResult | undefined): AgentStepResult {
  const coord = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
  // Normalize the action case-insensitively to its canonical name (models return "Click",
  // " clickAt ", "FINDCREDENTIALS", etc.). Crucially, an UNRECOGNIZED action must NOT fall back
  // to "done" — that silently terminates the run. We fall back to "wait" so the loop re-checks instead.
  const canon: Record<string, AgentStepResult['action']> = {
    click: 'click', clickat: 'click', tap: 'click', type: 'type', typeat: 'type', press: 'press',
    key: 'press', hover: 'hover', moveto: 'hover', scroll: 'scroll',
    navigate: 'navigate', goto: 'navigate', drag: 'drag', dragand: 'drag', research: 'research',
    ask: 'ask', wait: 'wait', uploadfile: 'uploadFile',
    findcredentials: 'findCredentials', fillcredential: 'fillCredential', remember: 'remember', done: 'done',
    // Screenshot-only has no manifest ids, so these no longer exist. They map to the
    // nearest real behaviour rather than to 'wait', which would silently stall the run:
    // a screenshot arrives every turn anyway, and select() is done by keyboard.
    look: 'wait', screenshot: 'wait', select: 'press'
  };
  const rawAction = typeof raw?.action === 'string' ? raw.action.trim().toLowerCase() : '';
  const action = canon[rawAction] ?? 'wait';
  const out: AgentStepResult = {
    action,
    text: typeof raw?.text === 'string' ? raw.text : undefined,
    key: typeof raw?.key === 'string' ? raw.key.trim().slice(0, 24) : undefined,
    url: typeof raw?.url === 'string' ? raw.url : undefined,
    direction: raw?.direction === 'up' ? 'up' : raw?.direction === 'down' ? 'down' : undefined,
    x: coord(raw?.x),
    y: coord(raw?.y),
    fromX: coord(raw?.fromX),
    fromY: coord(raw?.fromY),
    toX: coord(raw?.toX),
    toY: coord(raw?.toY),
    ms: typeof raw?.ms === 'number' && Number.isFinite(raw.ms) ? raw.ms : undefined,
    query: typeof raw?.query === 'string' ? raw.query.slice(0, 300) : undefined,
    question: typeof raw?.question === 'string' ? raw.question.slice(0, 300) : undefined,
    fileIndex: typeof raw?.fileIndex === 'number' && raw.fileIndex >= 0 ? Math.round(raw.fileIndex) : undefined,
    credentialId: typeof raw?.credentialId === 'string' ? raw.credentialId.trim().slice(0, 200) : undefined,
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
  // fillCredential's opaque id also lands in text/query/value; the vault re-validates it
  // anyway. `value` is no longer part of the contract but models still emit it, so it is
  // read off the raw object rather than dropped.
  if (out.action === 'fillCredential' && !out.credentialId) {
    const rawValue = (raw as { value?: unknown } | undefined)?.value;
    const fallback = out.text ?? out.query ?? (typeof rawValue === 'string' ? rawValue : undefined);
    if (typeof fallback === 'string' && fallback.trim()) out.credentialId = fallback.trim().slice(0, 200);
  }
  // A drag whose endpoints arrived as x/y + toX/toY is still a drag — take the start point
  // from x/y rather than dropping the action for a missing field.
  if (out.action === 'drag' && out.fromX === undefined && out.fromY === undefined) {
    out.fromX = out.x;
    out.fromY = out.y;
  }
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

/** True when the configured backend can accept the screenshot this agent runs on. */
export function webAgentCanSee(): boolean {
  return modelSupportsVision();
}

export async function nextAgentAction(input: AgentStepInput): Promise<AgentStepResult> {
  const vision = modelSupportsVision();
  const user = JSON.stringify({
    GOAL: input.goal,
    url: input.url,
    title: input.title ?? '',
    IMAGE_SIZE: input.image_size,
    CREDENTIAL_ACCESS: input.credentialAccess || undefined,
    FILES: input.files && input.files.length ? input.files : undefined,
    MEMORY: input.memory && input.memory.trim() ? input.memory.trim() : undefined,
    history: (input.history ?? []).slice(-6)
  });

  // A firm nudge appended on a retry: models that reply with prose/refusal on the first pass
  // usually comply when reminded the ONLY valid output is the JSON action.
  const RETRY_NUDGE = `${user}\n\nREMINDER: Return ONLY the JSON action object — no prose, no refusal. You DO control this browser; pick the single best next action from the screenshot now.`;

  // Unlike prediction/planning/synthesis, a browser action can't be produced by a
  // deterministic heuristic — it's fundamentally model-driven. So if the agent is
  // unavailable (not configured, missing binary, timeout, non-JSON), degrade to a
  // "wait" step instead of throwing: the client loop pauses and surfaces the reason
  // rather than the route returning a 500.
  try {
    // The screenshot IS the observation: perception and reasoning are one call.
    if (input.image && vision) {
      let raw: AgentStepResult;
      try {
        raw = await completeMultimodalJSON<AgentStepResult>({ system: SYSTEM_VISION, userText: user, imageDataUri: input.image, temperature: 0.1, maxTokens: 320 });
      } catch {
        raw = await completeMultimodalJSON<AgentStepResult>({ system: SYSTEM_VISION, userText: RETRY_NUDGE, imageDataUri: input.image, temperature: 0.1, maxTokens: 320 });
      }
      return sanitize(raw);
    }
    // A vision backend with no image means no page is open yet: pick where to go.
    // A backend that cannot see images at all can never drive this agent — say so
    // rather than let it guess coordinates for a page it has no view of.
    const raw = await completeJSON<AgentStepResult>({ system: vision ? SYSTEM_BOOTSTRAP : SYSTEM_BLIND, user, temperature: 0.1, maxTokens: 200 });
    return sanitize(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'agent unavailable';
    // Flag it as an error (not a genuine wait) so the client can count refusals and stop the spin.
    return { ...sanitize({ action: 'wait', ms: 1200, reason: reason.slice(0, 100) }), error: true };
  }
}
