import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { LinkCandidate } from '../types.js';

// How a research source gets read: a plain HTTP fetch and an HTML parse, with no
// browser engine. Readability picks the main article out of the page; when it cannot,
// the body text minus navigation chrome stands in, which is what the old headless
// Chromium path extracted.

export interface ExtractedPage {
  /** The document's <title>; empty when the page has none. */
  title: string;
  url: string;
  text: string;
  headings: string[];
  links: LinkCandidate[];
}

/** True for IPv4 addresses that must never be fetched (loopback, link-local, RFC1918, CGNAT, multicast/reserved). Unknown shapes are treated as unsafe. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** True for IPv6 addresses that must never be fetched (loopback, unspecified, ULA, link-local, and IPv4-mapped private addresses). */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true; // link-local / ULA
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * SSRF guard: reject any URL that is not http(s) or that resolves to a loopback,
 * link-local, or private (RFC1918/ULA/CGNAT) address. Hostnames are resolved via
 * DNS so that a public name that points at an internal IP is still blocked.
 *
 * The lookup here is separate from the one fetch makes when it connects, so a
 * DNS-rebinding attacker who flips the record between the two can still slip through;
 * closing that needs a connect-time check (a custom dispatcher/agent), which fetch in
 * both Node and Bun does not expose uniformly.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Blocked navigation to invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked navigation to non-http(s) URL (${parsed.protocol})`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const resolved = await lookup(host, { all: true });
    addresses = resolved.map((entry) => entry.address);
    if (addresses.length === 0) throw new Error(`Blocked navigation to unresolvable host: ${host}`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked navigation to private or internal host: ${host}`);
    }
  }
}

/** The source answered with something other than an HTML document (a PDF, JSON, an image…). */
export class NotHtmlError extends Error {
  constructor(readonly contentType: string) {
    super(`Not an HTML page (${contentType || 'no content type'})`);
    this.name = 'NotHtmlError';
  }
}

export interface FetchHtmlOptions {
  /** Aborts the whole read (every hop and the body). */
  signal?: AbortSignal;
  /** Budget for the whole read, redirects included. */
  timeoutMs: number;
  userAgent: string;
  /** Redirect hops followed before giving up. */
  maxRedirects?: number;
  /** Bytes of body read before the rest is dropped; bounds memory on huge pages. */
  maxBytes?: number;
  /** Called for each redirect hop, after the target passed the SSRF guard's input checks. */
  onRedirect?: (from: string, to: string) => void;
}

export interface FetchedHtml {
  /** Where the page finally came from, after redirects. */
  url: string;
  html: string;
  contentType: string;
  bytes: number;
  redirects: number;
  truncated: boolean;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Decode with the charset the header names, else the one a <meta> near the top names, else UTF-8. */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const fromHeader = contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  for (const label of [fromHeader, fromMeta]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown to this runtime's TextDecoder; try the next hint.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * GET an HTML page, following redirects by hand so the SSRF guard runs on every hop:
 * fetch's own redirect handling would connect to each target before anything here
 * could look at it. Non-HTML responses throw NotHtmlError without reading the body.
 */
export async function fetchHtml(rawUrl: string, options: FetchHtmlOptions): Promise<FetchedHtml> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  try {
    let current = rawUrl;
    for (let hop = 0; ; hop += 1) {
      await assertSafeUrl(current);
      signal.throwIfAborted();
      const response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': options.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.8'
        }
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await discard(response);
        if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}) starting from ${rawUrl}`);
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new Error(`Invalid redirect target: ${location}`);
        }
        options.onRedirect?.(current, next);
        current = next;
        continue;
      }

      if (!response.ok) {
        await discard(response);
        throw new Error(`HTTP ${response.status} from ${current}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!HTML_TYPE.test(contentType)) {
        await discard(response);
        throw new NotHtmlError(contentType);
      }
      const { bytes, truncated } = await readCapped(response, maxBytes);
      return { url: current, html: decodeHtml(bytes, contentType), contentType, bytes: bytes.byteLength, redirects: hop, truncated };
    }
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted) throw new Error(`Timed out after ${options.timeoutMs} ms reading ${rawUrl}`);
    throw error;
  }
}

// --- Extraction ---------------------------------------------------------------------

/** Chrome stripped from the body before its text is used (the old headless-browser extraction). */
const BODY_NOISE = 'script, style, noscript, svg, canvas, iframe, nav, footer, aside, form';

/** Elements whose text never shows up in rendered output. */
const INVISIBLE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);

/** Elements that break a line when rendered; their text must not run into a neighbour's. */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

interface TextNodeLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<TextNodeLike>;
  hasAttribute?: (name: string) => boolean;
}

/**
 * Rendered-ish text of a subtree: what innerText gives in a browser, minus layout.
 * linkedom's textContent glues adjacent blocks together ("<p>a</p><p>b</p>" → "ab"),
 * so block boundaries become spaces here. Iterative, so pathological nesting can't
 * blow the stack.
 */
function readableText(root: TextNodeLike | null | undefined): string {
  if (!root) return '';
  const parts: string[] = [];
  const stack: Array<TextNodeLike | ' '> = [root];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item === ' ') {
      parts.push(' ');
      continue;
    }
    if (item.nodeType === 3) {
      parts.push(item.textContent ?? '');
      continue;
    }
    if (item.nodeType !== 1 && item.nodeType !== 9 && item.nodeType !== 11) continue;
    const tag = item.nodeName.toUpperCase();
    if (INVISIBLE.has(tag) || item.hasAttribute?.('hidden')) continue;
    const block = BLOCK.has(tag);
    if (block) {
      parts.push(' ');
      stack.push(' ');
    }
    const children = item.childNodes;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function collapse(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function resolveHref(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return '';
  }
}

/**
 * Pull what the research model sees out of an HTML document: title, h1–h3 headings
 * (≤18), outbound http links (≤30, text ≤90 chars), and the meta description plus the
 * main text. The main text is Readability's article when it finds one, else the body
 * with script/style/noscript/svg/canvas/iframe/nav/footer/aside/form removed.
 */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const { document } = parseHTML(html);

  const baseHref = document.querySelector('base[href]')?.getAttribute('href');
  const base = (baseHref && resolveHref(baseHref, pageUrl)) || pageUrl;

  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((node) => collapse(node.textContent))
    .filter(Boolean)
    .slice(0, 18);
  const links: LinkCandidate[] = Array.from(document.querySelectorAll('a[href]'))
    .map((node) => ({
      text: collapse(node.textContent).slice(0, 90),
      url: resolveHref(node.getAttribute('href') ?? '', base)
    }))
    .filter((link) => link.text && link.url.startsWith('http'))
    .slice(0, 30);
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const title = collapse(document.title);

  // The fallback needs the body as it arrived, and Readability rewrites the document
  // it is given, so the copy is taken first.
  const root = (document.body ?? document.documentElement) as unknown as TextNodeLike & { cloneNode(deep: boolean): unknown } | null;
  const bodyCopy = root ? (root.cloneNode(true) as { querySelectorAll(selector: string): ArrayLike<{ remove(): void }> } & TextNodeLike) : null;

  let articleText = '';
  try {
    const article = new Readability(document as unknown as Document, {
      // Hand back the element rather than serialized HTML, so its text can be read
      // with block boundaries intact instead of re-parsing the markup.
      serializer: (node: Node) => node
    }).parse();
    articleText = article?.content ? readableText(article.content as unknown as TextNodeLike) : '';
  } catch {
    // Readability can trip over malformed documents; the body text still stands.
  }

  let mainText = articleText;
  if (!mainText && bodyCopy) {
    for (const node of Array.from(bodyCopy.querySelectorAll(BODY_NOISE))) node.remove();
    mainText = readableText(bodyCopy);
  }

  return {
    title,
    url: pageUrl,
    headings,
    links,
    text: collapse([metaDescription, mainText].join('\n'))
  };
}
