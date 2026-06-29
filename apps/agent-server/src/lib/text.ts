import { createHash } from 'node:crypto';

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€'
};

function decodeEntitiesOnce(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Decode HTML character references: named (&amp;), decimal (&#39;) and hex (&#x27;).
 *  Iterates a few passes so double-encoded entities (e.g. &amp;apos;) fully resolve. */
export function decodeEntities(value: string) {
  let out = value;
  for (let i = 0; i < 3; i += 1) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function stripHtml(value: string) {
  return normalizeWhitespace(
    decodeEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

export function fingerprintQuery(query: string) {
  const normalized = normalizeWhitespace(query.toLowerCase())
    .replace(/[^a-z0-9\s:/._-]+/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 18)
    .join(' ');
  const collapsed = normalizeWhitespace(query.toLowerCase());
  return createHash('sha1').update(normalized || collapsed || 'empty-query').digest('hex').slice(0, 14);
}

export function hashString(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function compactText(text: string, maxChars = 12_000) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  const headLength = Math.floor(maxChars * 0.7);
  const tailLength = Math.max(300, maxChars - headLength - 40);
  return `${clean.slice(0, headLength)} … ${clean.slice(-tailLength)}`;
}

export function firstSentences(text: string, maxSentences = 3) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, maxSentences)
    .join(' ');
}

export function hostname(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

export function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return normalizeWhitespace(value).replace(/\/$/, '');
  }
}

export function clamp(value: number, min = 0, max = 1) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function keywordSet(input: string) {
  return new Set(
    normalizeWhitespace(input)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2)
      .slice(0, 80)
  );
}

export function overlapScore(a: string, b: string) {
  const left = keywordSet(a);
  const right = keywordSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const term of left) if (right.has(term)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

export function safeHostname(value: string) {
  return hostname(value);
}

export function isUrlLike(input: string) {
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/.*)?$/i.test(input.trim());
}

export function canonicalUrl(input: string) {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

export function wordCount(text: string) {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

export function fallbackIfEmpty<T>(value: unknown, fallback: T[] | undefined): T[] {
  if (Array.isArray(value) && value.length > 0) return value as T[];
  return fallback ?? [];
}

const AUTHORITY_PRIMARY_RE = /\.gov$|\.edu$|who\.int|nih\.gov|sec\.gov|fda\.gov|federalreserve\.gov|census\.gov/i;
const AUTHORITY_STRONG_RE = /docs\.|developer\.|github\.com|arxiv\.org|nature\.com|science\.org|cerebras\.ai|google\.|microsoft\.com|openai\.com|playwright\.dev|electronjs\.org/i;
const AUTHORITY_MIXED_RE = /medium\.com|substack\.com|reddit\.com|quora\.com/i;

export function isAuthorityPrimary(host: string) {
  return AUTHORITY_PRIMARY_RE.test(host);
}
export function isAuthorityStrong(host: string) {
  return AUTHORITY_STRONG_RE.test(host);
}
export function isAuthorityMixed(host: string) {
  return AUTHORITY_MIXED_RE.test(host);
}
