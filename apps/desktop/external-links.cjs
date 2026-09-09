// Links handed to Toji from outside: the OS ("open this in the default browser"), a
// second launch with an address on its command line, or an .html file dropped on the
// icon. Pure — no Electron here — so the rules are testable and main.cjs only wires.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * The address to open, or null when this is not something a browser should open on
 * request from another program: http(s) and file URLs are accepted; javascript:, data:,
 * custom schemes and plain words are refused. An absolute path to an HTML file on disk
 * becomes its file URL.
 */
function externalUrl(candidate) {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:' ? parsed.href : null;
  } catch {
    if (/\.x?html?$/i.test(value) && path.isAbsolute(value) && fs.existsSync(value)) return pathToFileURL(value).href;
    return null;
  }
}

/** The addresses on a command line. Flags and the executable/script paths are not addresses. */
function urlsFromArgv(argv) {
  return (Array.isArray(argv) ? argv : [])
    .filter((arg) => typeof arg === 'string' && !arg.startsWith('-'))
    .map(externalUrl)
    .filter(Boolean);
}

/**
 * Where a link waits until a window can take it.
 *
 * On a cold start the OS hands over the URL before Electron is even ready, let alone
 * before a renderer exists to open a tab; `push` tries to deliver at once and otherwise
 * holds the link until a renderer asks for what is pending with `take`.
 */
class ExternalLinkQueue {
  constructor() {
    this.pending = [];
  }

  /** True when the address was accepted (delivered or held); false when it was refused. */
  push(candidate, deliver) {
    const url = externalUrl(candidate);
    if (!url) return false;
    if (typeof deliver === 'function' && deliver(url)) return true;
    this.pending.push(url);
    return true;
  }

  /** Everything held, in arrival order; the queue is empty afterwards. */
  take() {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  get size() {
    return this.pending.length;
  }
}

module.exports = { externalUrl, urlsFromArgv, ExternalLinkQueue };
