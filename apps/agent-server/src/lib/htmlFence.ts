// Models asked for raw HTML still hand back a markdown code fence around it often
// enough to matter — the page then opens with a literal "```html" sitting above the
// title. The prompt already forbids it; this is the part that doesn't rely on the
// model obeying.
//
// It has to work mid-stream, because the page renders as it arrives: the opening
// fence is decided from the first few characters, and the closing one by holding a
// short tail back until the stream ends.

/** Longest tail worth withholding: "\n```\n" plus room for trailing whitespace. */
const TAIL = 16;
/** Enough leading characters to tell a fence from a document. */
const LOOKAHEAD = 3;

const OPENING_FENCE = /^\s*(?:`{3,}|~{3,})[^\n]*\n?/;
const CLOSING_FENCE = /\s*(?:`{3,}|~{3,})\s*$/;

export interface HtmlFenceStripper {
  /** Feed the next model chunk; returns the text safe to emit now (may be empty). */
  push(chunk: string): string;
  /** Flush what was held back, minus any closing fence. */
  end(): string;
}

/**
 * Strip a markdown code fence from a stream of HTML, without buffering the whole
 * document.
 *
 * The opening fence must be the first thing in the stream (bar whitespace) — a
 * ``` appearing later belongs to the page's own content, e.g. a <pre> block, and
 * is left alone. The closing fence is only removed at the very end, after trailing
 * whitespace, so a document that legitimately ends in </html> is untouched.
 */
export function createHtmlFenceStripper(): HtmlFenceStripper {
  // 'head' = still deciding whether this stream opens with a fence.
  let phase: 'head' | 'body' = 'head';
  let buffer = '';
  let fenced = false;

  const takeHead = (): string => {
    const match = buffer.match(OPENING_FENCE);
    if (match) {
      // A fence with no newline yet is an incomplete first line — wait for the rest,
      // otherwise "```ht" would be mistaken for the whole marker.
      if (!match[0].endsWith('\n') && buffer.length < match[0].length + 1 && !/\n/.test(buffer)) return '';
      fenced = true;
      phase = 'body';
      return buffer.slice(match[0].length);
    }
    // Not a fence: only conclude that once enough non-whitespace has arrived to be sure.
    if (buffer.replace(/^\s+/, '').length < LOOKAHEAD) return '';
    phase = 'body';
    return buffer;
  };

  return {
    push(chunk: string): string {
      if (!chunk) return '';
      buffer += chunk;
      if (phase === 'head') {
        const emitted = takeHead();
        if (phase === 'head') return ''; // still undecided; keep accumulating
        buffer = emitted;
      }
      // Hold a tail back so a closing fence can still be removed once the stream ends.
      if (!fenced) {
        const out = buffer;
        buffer = '';
        return out;
      }
      if (buffer.length <= TAIL) return '';
      const out = buffer.slice(0, buffer.length - TAIL);
      buffer = buffer.slice(buffer.length - TAIL);
      return out;
    },
    end(): string {
      // A stream that ended while still undecided was shorter than the lookahead —
      // emit it as-is rather than swallowing it.
      const rest = phase === 'head' ? (buffer.match(OPENING_FENCE) ? buffer.replace(OPENING_FENCE, '') : buffer) : buffer;
      buffer = '';
      phase = 'body';
      return fenced || rest !== '' ? rest.replace(CLOSING_FENCE, '') : rest;
    }
  };
}

/** The same rule applied to a whole string, for non-streaming callers and tests. */
export function stripHtmlFence(value: string): string {
  const stripper = createHtmlFenceStripper();
  return stripper.push(value) + stripper.end();
}
