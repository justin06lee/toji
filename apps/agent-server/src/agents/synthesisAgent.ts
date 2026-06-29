import type { LinkCandidate, OverviewCard, SearchResult, SourceCredibility, SourceMapItem, SourceNote, SourceSignal, SynthesisFinding, SynthesisResult, SynthesisSection } from '../types.js';
import { compactText, firstSentences, normalizeWhitespace, safeHostname } from '../lib/text.js';
import { completeJSON, completeMultimodalJSON } from './model.js';
import { config } from '../config.js';

interface ExtractedPage {
  title: string;
  url: string;
  text: string;
  headings: string[];
  links: LinkCandidate[];
}

function credibilityFor(url: string): SourceCredibility {
  const host = safeHostname(url);
  if (/\.gov$|\.edu$|who\.int|nih\.gov|sec\.gov|federalreserve\.gov|census\.gov/i.test(host)) return 'primary';
  if (/docs\.|developer\.|github\.com|arxiv\.org|nature\.com|science\.org|cerebras\.ai|google\.|microsoft\.com|openai\.com|playwright\.dev|electronjs\.org/i.test(host)) {
    return 'strong';
  }
  if (/medium\.com|substack\.com|reddit\.com|quora\.com/i.test(host)) return 'mixed';
  return 'unknown';
}

function credibilityReason(url: string, credibility: SourceCredibility) {
  const host = safeHostname(url);
  if (credibility === 'primary') return `${host} has primary/official domain signals.`;
  if (credibility === 'strong') return `${host} has documentation, research, or major-organization authority signals.`;
  if (credibility === 'mixed') return `${host} may contain useful context but should be cross-checked.`;
  return `${host} has no special authority signal in the heuristic scorer.`;
}

function heuristicFacts(text: string, query: string) {
  const lowerTerms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 4)
    .slice(0, 10);
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 48 && sentence.length < 360)
    .filter((sentence) => lowerTerms.length === 0 || lowerTerms.some((term) => sentence.toLowerCase().includes(term)))
    .slice(0, 5);
}

function heuristicQuotes(text: string, query: string) {
  return heuristicFacts(text, query)
    .map((sentence) => sentence.slice(0, 240))
    .slice(0, 3);
}

function wordCount(text: string) {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

function signalsFor(page: ExtractedPage, result: SearchResult): SourceSignal[] {
  const host = safeHostname(page.url || result.url);
  const signals: SourceSignal[] = [
    { label: 'host', value: host },
    { label: 'search rank', value: result.rank ? `#${result.rank}` : 'fallback' }
  ];
  if (page.headings.length > 0) signals.push({ label: 'headings', value: String(page.headings.length) });
  if (page.text.length > 0) signals.push({ label: 'readable text', value: `${Math.round(page.text.length / 100) / 10}k chars` });
  if (result.score) signals.push({ label: 'rank score', value: result.score.toFixed(2) });
  return signals;
}

function normalizeLinks(links: LinkCandidate[]) {
  const seen = new Set<string>();
  return links
    .filter((link) => link.text && link.url.startsWith('http'))
    .filter((link) => {
      const key = link.url.replace(/#.*$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
}

export async function summarizeSource(
  query: string,
  page: ExtractedPage,
  result: SearchResult,
  tabId: string,
  screenshotDataUri?: string
): Promise<SourceNote> {
  const text = page.text || result.snippet || page.title;
  const credibility = credibilityFor(page.url || result.url);
  const fallback: SourceNote = {
    tabId,
    title: page.title || result.title,
    url: page.url || result.url,
    snippet: result.snippet,
    summary: firstSentences(text, 3) || 'The page was reachable but did not expose much readable text.',
    keyFacts: heuristicFacts(text, query),
    quotes: heuristicQuotes(text, query),
    credibility,
    credibilityReason: credibilityReason(page.url || result.url, credibility),
    signals: signalsFor(page, result),
    capturedAt: new Date().toISOString(),
    wordCount: wordCount(text),
    sourceScore: result.score ?? 0,
    discoveredLinks: normalizeLinks(page.links)
  };

  if (!page.text || page.text.length < 300) return fallback;

  try {
    const requestPayload = JSON.stringify({
      query,
      source: {
        title: page.title,
        url: page.url,
        snippet: result.snippet,
        headings: page.headings,
        outboundLinks: page.links.slice(0, 18),
        text: compactText(page.text, 9000)
      },
      visualInstruction:
        screenshotDataUri && config.enableVisualAnalysis
          ? 'Also inspect the browser screenshot. Use it to understand tables, charts, visual hierarchy, or error states, but do not invent facts absent from the page text or image.'
          : 'No screenshot is attached for this source.',
      requiredShape: {
        title: 'string',
        url: 'string',
        snippet: 'string',
        summary: '2 sentence string',
        keyFacts: ['short factual bullet grounded in source'],
        quotes: ['short direct extract or near-extract from source text, max 25 words each'],
        credibility: 'primary | strong | mixed | unknown',
        credibilityReason: 'short string explaining authority or caveat',
        signals: [{ label: 'string', value: 'string' }]
      }
    });

    let modelNote: Partial<SourceNote>;
    try {
      modelNote = screenshotDataUri && config.enableVisualAnalysis
        ? await completeMultimodalJSON<Partial<SourceNote>>({
            system:
              'You summarize one web source for a multimodal browser research agent. Extract only evidence relevant to the user query. Use both page text and screenshot. Do not cite facts absent from the supplied source.',
            userText: requestPayload,
            imageDataUri: screenshotDataUri,
            temperature: 0.1,
            maxTokens: 950
          })
        : await completeJSON<Partial<SourceNote>>({
            system:
              'You summarize one web source for a browser research agent. Extract only evidence relevant to the user query. Be concise and cite no facts not present in the page text.',
            user: requestPayload,
            temperature: 0.1,
            maxTokens: 950
          });
    } catch {
      modelNote = await completeJSON<Partial<SourceNote>>({
        system:
          'You summarize one web source for a browser research agent. Extract only evidence relevant to the user query. Be concise and cite no facts not present in the page text.',
        user: requestPayload,
        temperature: 0.1,
        maxTokens: 950
      });
    }

    const merged: SourceNote = {
      ...fallback,
      ...modelNote,
      tabId,
      title: modelNote.title || fallback.title,
      url: modelNote.url || fallback.url,
      keyFacts: Array.isArray(modelNote.keyFacts) && modelNote.keyFacts.length > 0 ? modelNote.keyFacts.slice(0, 6) : fallback.keyFacts,
      quotes: Array.isArray(modelNote.quotes) && modelNote.quotes.length > 0 ? modelNote.quotes.slice(0, 4) : fallback.quotes,
      signals: Array.isArray(modelNote.signals) && modelNote.signals.length > 0 ? modelNote.signals.slice(0, 8) : fallback.signals,
      credibility: modelNote.credibility ?? fallback.credibility,
      credibilityReason: modelNote.credibilityReason || credibilityReason(modelNote.url || fallback.url, modelNote.credibility ?? fallback.credibility),
      capturedAt: new Date().toISOString(),
      wordCount: fallback.wordCount,
      sourceScore: fallback.sourceScore,
      discoveredLinks: fallback.discoveredLinks
    };
    return merged;
  } catch {
    return fallback;
  }
}

function buildSourceMap(notes: SourceNote[]): SourceMapItem[] {
  const byDomain = new Map<string, SourceMapItem>();
  for (const note of notes) {
    const domain = safeHostname(note.url);
    const existing = byDomain.get(domain);
    if (existing) {
      existing.count += 1;
      existing.urls.push(note.url);
      if (existing.credibility !== 'primary' && note.credibility === 'primary') existing.credibility = 'primary';
      else if (existing.credibility === 'unknown' && note.credibility !== 'unknown') existing.credibility = note.credibility;
    } else {
      byDomain.set(domain, { domain, count: 1, credibility: note.credibility, urls: [note.url] });
    }
  }
  return [...byDomain.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function renderMarkdown(query: string, answer: Omit<SynthesisResult, 'markdown'>) {
  const lines: string[] = [`# Toji research brief`, '', `**Query:** ${query}`, '', `## ${answer.headline}`, '', answer.summary, ''];
  if (answer.findings.length > 0) {
    lines.push('## Key findings', '');
    for (const finding of answer.findings) {
      lines.push(`- **${finding.confidence}:** ${finding.claim} ([${finding.evidenceTitle}](${finding.evidenceUrl}))`);
    }
    lines.push('');
  }
  for (const section of answer.sections) {
    lines.push(`## ${section.title}`, '', section.body, '');
    if (section.sourceUrls.length) lines.push(`Sources: ${section.sourceUrls.join(', ')}`, '');
  }
  if (answer.citations.length > 0) {
    lines.push('## Citations', '');
    for (const citation of answer.citations) lines.push(`- [${citation.title}](${citation.url})${citation.credibility ? ` — ${citation.credibility}` : ''}`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function sanitizeSections(value: unknown): SynthesisSection[] {
  if (!Array.isArray(value)) return [];
  return value.map((s: any) => ({
    title: String(s?.title ?? ''),
    body: String(s?.body ?? ''),
    sourceUrls: Array.isArray(s?.sourceUrls) ? s.sourceUrls.filter((u: unknown): u is string => typeof u === 'string') : []
  }));
}

function sanitizeFindings(value: unknown): SynthesisFinding[] {
  if (!Array.isArray(value)) return [];
  return value.map((f: any) => ({
    claim: String(f?.claim ?? ''),
    evidenceUrl: String(f?.evidenceUrl ?? ''),
    evidenceTitle: String(f?.evidenceTitle ?? ''),
    confidence: f?.confidence === 'high' || f?.confidence === 'medium' || f?.confidence === 'low' ? f.confidence : 'low'
  }));
}

function sanitizeCitations(value: unknown): Array<{ title: string; url: string; credibility?: SourceCredibility }> {
  if (!Array.isArray(value)) return [];
  const validCredibility = new Set<SourceCredibility>(['primary', 'strong', 'mixed', 'unknown']);
  return value.map((c: any) => {
    const credibility = validCredibility.has(c?.credibility) ? (c.credibility as SourceCredibility) : undefined;
    return { title: String(c?.title ?? ''), url: String(c?.url ?? ''), ...(credibility ? { credibility } : {}) };
  });
}

function sanitizeOverviewCards(value: unknown): OverviewCard[] {
  if (!Array.isArray(value)) return [];
  return value.map((c: any) => ({
    label: String(c?.label ?? ''),
    value: String(c?.value ?? ''),
    detail: String(c?.detail ?? '')
  }));
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v: unknown): v is string => typeof v === 'string');
}

export async function synthesizeAnswer(query: string, notes: SourceNote[]): Promise<SynthesisResult> {
  const citations = notes.map((note) => ({ title: note.title, url: note.url, credibility: note.credibility }));
  const highCred = notes.filter((note) => note.credibility === 'primary' || note.credibility === 'strong').length;
  const overviewCards = [
    { label: 'Sources read', value: String(notes.length), detail: 'usable pages summarized by subagents' },
    { label: 'Evidence items', value: String(notes.reduce((sum, note) => sum + note.keyFacts.length, 0)), detail: 'candidate facts extracted before synthesis' },
    { label: 'Strong sources', value: String(highCred), detail: 'primary/strong credibility signals' }
  ];
  const visualBlocks = overviewCards.map((card) => ({ title: card.label, value: card.value, caption: card.detail }));
  const sourceMap = buildSourceMap(notes);
  const fallbackWithoutMarkdown: Omit<SynthesisResult, 'markdown'> = {
    headline: `Research brief: ${query}`,
    summary:
      notes.length > 0
        ? `Toji reviewed ${notes.length} source${notes.length === 1 ? '' : 's'} and extracted the most relevant evidence it could find. ${highCred} source${highCred === 1 ? '' : 's'} looked relatively strong or primary by domain signals.`
        : 'No usable sources were collected. Try a more specific query or check network access.',
    sections: [
      {
        title: 'What the research agent found',
        body: notes
          .map((note, index) => `${index + 1}. ${note.summary}`)
          .join('\n')
          .trim(),
        sourceUrls: notes.map((note) => note.url)
      }
    ],
    findings: notes.flatMap((note) =>
      note.keyFacts.slice(0, 2).map((fact) => ({
        claim: fact,
        evidenceUrl: note.url,
        evidenceTitle: note.title,
        confidence: note.credibility === 'primary' ? 'high' : note.credibility === 'strong' ? 'medium' : 'low'
      }))
    ),
    citations,
    followUps: ['Open the highest-confidence source', 'Run a broader source diversity pass', 'Compare opposing viewpoints'],
    overviewCards,
    visualBlocks,
    sourceMap
  };
  const fallback: SynthesisResult = { ...fallbackWithoutMarkdown, markdown: renderMarkdown(query, fallbackWithoutMarkdown) };

  if (notes.length === 0) return fallback;

  try {
    const answer = await completeJSON<Partial<SynthesisResult>>({
      system:
        'You are the synthesis agent for Toji, an AI browser. Convert source notes into a concise visual research answer with citations. Do not overstate certainty. Every finding must reference a provided source URL.',
      user: JSON.stringify({
        query,
        sourceNotes: notes,
        requiredShape: {
          headline: 'short headline',
          summary: '3-5 sentence answer',
          sections: [{ title: 'string', body: 'string', sourceUrls: ['url'] }],
          findings: [{ claim: 'string', evidenceUrl: 'url', evidenceTitle: 'string', confidence: 'high | medium | low' }],
          citations: [{ title: 'string', url: 'url', credibility: 'primary | strong | mixed | unknown' }],
          followUps: ['string'],
          overviewCards: [{ label: 'string', value: 'string', detail: 'string' }]
        }
      }),
      temperature: 0.18,
      maxTokens: 1600
    });

    const mergedWithoutMarkdown: Omit<SynthesisResult, 'markdown'> = {
      ...fallbackWithoutMarkdown,
      ...answer,
      sections: (() => {
        const sections = sanitizeSections(answer.sections);
        return sections.length > 0 ? sections : fallback.sections;
      })(),
      findings: (() => {
        const findings = sanitizeFindings(answer.findings);
        return findings.length > 0 ? findings : fallback.findings;
      })(),
      citations: (() => {
        const sanitized = sanitizeCitations(answer.citations);
        return sanitized.length > 0 ? sanitized : citations;
      })(),
      followUps: (() => {
        const followUps = sanitizeStringList(answer.followUps);
        return followUps.length > 0 ? followUps : fallback.followUps;
      })(),
      overviewCards: (() => {
        const cards = sanitizeOverviewCards(answer.overviewCards);
        return cards.length > 0 ? cards : overviewCards;
      })(),
      visualBlocks,
      sourceMap
    };
    return { ...mergedWithoutMarkdown, markdown: renderMarkdown(query, mergedWithoutMarkdown) };
  } catch {
    return fallback;
  }
}
