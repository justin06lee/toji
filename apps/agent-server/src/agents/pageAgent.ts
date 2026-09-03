import { normalizeWhitespace, safeHostname } from '../lib/text.js';
import type { PageSource } from '../types.js';
import { createHtmlFenceStripper } from '../lib/htmlFence.js';
import { agentAvailable, liveModelName, streamText } from './model.js';

export type PageTheme = 'light' | 'dark';

function themeRules(theme: PageTheme): string {
  return theme === 'dark'
    ? `THEME = DARK. Background: #000000. Primary text: #ffffff. Secondary text: rgba(255,255,255,0.6). Hairline borders: rgba(255,255,255,0.12). Subtle surface fill: rgba(255,255,255,0.04).`
    : `THEME = LIGHT. Background: #ffffff. Primary text: #0a0a0a. Secondary text: rgba(0,0,0,0.55). Hairline borders: rgba(0,0,0,0.10). Subtle surface fill: rgba(0,0,0,0.03).`;
}

function pageSystemPrompt(theme: PageTheme): string {
  return `You are Toji, an AI browser that answers a query by generating a single, complete, self-contained HTML web page explaining the topic — a clean, editorial, well-typeset article.

STRICT OUTPUT RULES:
- Output ONLY raw HTML. Start with <!DOCTYPE html> and end with </html>. No markdown, no code fences, no commentary.
- Inline all CSS in ONE <style> tag in the <head>. No external CSS/font/script files.
- Absolutely NO <script> tags and no inline event handlers — purely presentational.
- Any <a> links MUST include target="_blank" rel="noreferrer".

DESIGN SYSTEM (follow exactly — minimal, monochrome, editorial):
- ${themeRules(theme)}
- Font: system stack — font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif.
- NO gradients anywhere. NO colored accents. NO emojis. Monochrome only — build hierarchy with weight, size, and text opacity, not color.
- SQUARE corners only (border-radius: 0). Borders are 1px hairlines in the theme border color. Avoid drop shadows.
- Layout: a single centered column, max-width: 680px, margin: 0 auto, with generous horizontal padding (at least 28px) and ample top/bottom padding (~64px top). Comfortable reading: font-size 17px, line-height 1.7.
- Headings: font-weight 600, letter-spacing -0.01em. h1 ~38px. Clear vertical rhythm and whitespace between sections.
- Optional thin divider rules (1px border) between major sections. Keep it calm and uncluttered.

CONTENT:
- A clear <h1> answering/naming the topic and a one-line standfirst (secondary text).
- A short lead paragraph that directly answers the query.
- 3-6 well-organized sections with <h2> headings, clear prose, and lists where genuinely helpful.
- Be accurate, specific, and genuinely informative. End with a brief "Next" or summary section.
- GROUNDING: if a SOURCES list is given in the user message, base the page primarily on those sources — synthesize across them and reflect what they say. You may reference a source naturally in prose (e.g., "According to <site>…"). Do not contradict the sources, and do not invent statistics or quotes that aren't supported by them. You may add widely-known background context.

Write the page now.`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The chrome every locally-generated page shares: the same monochrome type and theme
 * the model is asked to produce, so a demo or an error still looks like Toji rather
 * than a browser error screen.
 */
function pageShell(title: string, theme: PageTheme, body: string): string {
  const dark = theme === 'dark';
  const bg = dark ? '#000000' : '#ffffff';
  const fg = dark ? '#ffffff' : '#0a0a0a';
  const muted = dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
  const border = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: ${bg}; }
  body {
    color: ${fg};
    font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 17px; line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 680px; margin: 0 auto; padding: 64px 28px 96px; }
  h1 { font-size: 38px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.15; margin: 0 0 10px; }
  .standfirst { color: ${muted}; font-size: 18px; margin: 0 0 36px; }
  h2 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 40px 0 12px; }
  p { margin: 0 0 18px; }
  ul { margin: 0 0 18px; padding-left: 20px; }
  li { margin: 0 0 8px; }
  hr { border: none; border-top: 1px solid ${border}; margin: 40px 0; }
  .meta { color: ${muted}; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 28px; }
  .detail { border: 1px solid ${border}; border-radius: 12px; padding: 16px 18px; margin: 0 0 28px; font-size: 15px; }
  a { color: ${fg}; text-underline-offset: 3px; }
  code { font-size: 0.92em; }
</style>
</head>
<body>
  <div class="wrap">
${body}
  </div>
</body>
</html>`;
}

/** A self-contained, themed, monochrome HTML page used when no model is configured (demo / offline). */
export function fallbackPageHtml(query: string, theme: PageTheme = 'light'): string {
  const clean = escapeHtml(normalizeWhitespace(query) || 'Toji');
  return pageShell(
    clean,
    theme,
    `    <p class="meta">Toji · demo render</p>
    <h1>${clean}</h1>
    <p class="standfirst">A live, AI-generated page answering your query.</p>
    <p>This page is rendered by Toji in demo mode, because no model is configured. With one connected, Toji streams a full, original explainer about <strong>${clean}</strong> as it generates.</p>
    <hr />
    <h2>How it works</h2>
    <p>When you search, Toji asks a fast model to write a complete, self-contained web page about your topic. The HTML streams straight into this view and renders as it arrives, so reading begins almost immediately.</p>
    <h2>Grounded in the background</h2>
    <p>While the page streams, Toji gathers real sources in the background. Citations appear in the bar below the page once research completes.</p>
    <h2>Next</h2>
    <ul>
      <li>Refine your query to go deeper on a specific angle.</li>
      <li>Open a new tab to research a related topic in parallel.</li>
      <li>Pick a model in Settings — a signed-in coding-agent CLI, Cerebras, or your own endpoint.</li>
    </ul>`
  );
}

/**
 * Shown when a model IS configured and the call failed. Previously this case fell
 * through to the demo page above, which told the user no agent was configured — so a
 * Cerebras account out of credits, an expired login or an unreachable endpoint all
 * read as "you never set this up", and the message explaining the real problem was
 * only ever written to the server log.
 */
export function errorPageHtml(query: string, theme: PageTheme, backend: string, reason: string): string {
  const clean = escapeHtml(normalizeWhitespace(query) || 'Toji');
  return pageShell(
    clean,
    theme,
    `    <p class="meta">Toji · could not generate</p>
    <h1>${clean}</h1>
    <p class="standfirst">The page didn't generate — ${escapeHtml(backend)} returned an error.</p>
    <p class="detail">${escapeHtml(reason)}</p>
    <h2>What to try</h2>
    <ul>
      <li>Open <strong>Settings</strong> and pick a different model — every signed-in coding-agent CLI is listed there.</li>
      <li>If this is a hosted model, check the account behind the key: credit balance and rate limits fail the same way a bad key does.</li>
      <li>Search again once it's sorted; nothing about this query was saved.</li>
    </ul>`
  );
}

/**
 * Stream a themed, monochrome HTML answer page for a query. Yields HTML chunks.
 * Uses the live model when configured; otherwise streams the local fallback page
 * in small chunks so streaming still works offline / in demo mode.
 */
export async function* streamAnswerPage(
  query: string,
  theme: PageTheme = 'light',
  signal?: AbortSignal,
  sources?: PageSource[]
): AsyncGenerator<string, void, unknown> {
  const clean = normalizeWhitespace(query);
  const grounded = Array.isArray(sources) && sources.length > 0;
  const sourceBlock = grounded
    ? `\n\nSOURCES (base the page on these real web results):\n${sources!
        .map((s, i) => `${i + 1}. ${s.title} — ${safeHostname(s.url)}\n${normalizeWhitespace(s.summary || '').slice(0, 320)}`)
        .join('\n\n')}`
    : '';
  let failure: string | null = null;
  const backend = liveModelName();
  if (agentAvailable()) {
    let produced = 0;
    try {
      // Models hand back a ```html fence around the page often enough that the prompt
      // saying not to is not enough; strip it as the page streams.
      const fence = createHtmlFenceStripper();
      for await (const delta of streamText({
        system: pageSystemPrompt(theme),
        user: `User query: ${clean}${sourceBlock}\n\nGenerate the complete HTML page now${grounded ? ', grounded in the sources above' : ''}.`,
        temperature: grounded ? 0.35 : 0.5,
        maxTokens: 3200,
        signal
      })) {
        const html = fence.push(delta);
        if (html) {
          produced += html.length;
          yield html;
        }
      }
      const tail = fence.end();
      if (tail) {
        produced += tail.length;
        yield tail;
      }
      if (produced > 0) return;
      failure = 'The model returned an empty page.';
    } catch (error) {
      // Half a page followed by an error page would be two documents glued together;
      // stop instead, and leave the partial page on screen.
      if (produced > 0) return;
      failure = error instanceof Error ? error.message : String(error);
    }
    console.warn(`[toji] streamAnswerPage failed on ${backend}: ${failure}`);
  }

  // No model at all is the demo case; a model that failed gets told why.
  const html = failure ? errorPageHtml(clean, theme, backend, failure) : fallbackPageHtml(clean, theme);
  const step = 120;
  for (let i = 0; i < html.length; i += step) {
    if (signal?.aborted) return;
    yield html.slice(i, i + step);
    await new Promise((resolve) => setTimeout(resolve, 26));
  }
}
