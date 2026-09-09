// The theme prelude (see pageAgent.ts) has to reach the browser before anything the
// model wrote, and the page arrives as a stream. It goes right after the doctype when
// there is one, so the document stays in standards mode — a <style> ahead of the doctype
// would drop the page into quirks mode. A page with no doctype gets it first.

/** Enough of the head to know whether it is a doctype: "<!doctype" is nine characters. */
const DOCTYPE_PREFIX = '<!doctype';
/** A doctype longer than this is not one; stop waiting for its closing bracket. */
const MAX_DOCTYPE = 120;

export interface PreludeInjector {
  /** Feed the next chunk; returns what may be emitted now (possibly empty). */
  push(chunk: string): string;
  /** Flush anything held back. */
  end(): string;
}

export function createPreludeInjector(prelude: string): PreludeInjector {
  let done = false;
  let buffer = '';

  const emit = (text: string): string => {
    done = true;
    buffer = '';
    return text;
  };

  return {
    push(chunk: string): string {
      if (done) return chunk;
      if (!chunk) return '';
      buffer += chunk;
      const trimmed = buffer.replace(/^\s+/, '');
      const head = trimmed.slice(0, DOCTYPE_PREFIX.length).toLowerCase();
      // Still could be a doctype: wait for enough characters to tell.
      if (head.length < DOCTYPE_PREFIX.length && DOCTYPE_PREFIX.startsWith(head)) return '';
      if (head !== DOCTYPE_PREFIX) return emit(prelude + buffer);
      const close = buffer.indexOf('>');
      if (close < 0) return buffer.length > MAX_DOCTYPE ? emit(prelude + buffer) : '';
      return emit(buffer.slice(0, close + 1) + prelude + buffer.slice(close + 1));
    },
    end(): string {
      if (done) return '';
      return buffer ? emit(prelude + buffer) : emit('');
    }
  };
}

/** One-shot form, for documents that are already whole. */
export function injectPrelude(html: string, prelude: string): string {
  const injector = createPreludeInjector(prelude);
  return injector.push(html) + injector.end();
}
