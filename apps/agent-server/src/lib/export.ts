import type { ResearchSessionState } from '../types.js';
import { hostname } from './text.js';

function list(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None captured';
}

export function sessionToMarkdown(session: ResearchSessionState) {
  const synthesis = session.synthesis;
  const lines = [
    `# Toji research brief`,
    '',
    `**Query:** ${session.query}`,
    `**Status:** ${session.status}`,
    `**Mode:** ${session.mode}`,
    `**Created:** ${session.createdAt}`,
    '',
    '## Objective',
    session.researchPlan?.objective ?? session.prediction?.draftIntent ?? session.query,
    '',
    '## Answer',
    synthesis?.summary ?? 'No synthesis has been generated yet.',
    ''
  ];

  if (synthesis?.visualBlocks?.length) {
    lines.push('## Snapshot', '');
    for (const block of synthesis.visualBlocks) lines.push(`- **${block.title}:** ${block.value} — ${block.caption}`);
    lines.push('');
  }

  if (synthesis?.findings?.length) {
    lines.push('## Key findings', list(synthesis.findings.map((finding) => `${finding.claim} (${finding.confidence}; ${hostname(finding.evidenceUrl)})`)), '');
  }

  if (synthesis?.sections?.length) {
    lines.push('## Sections');
    for (const section of synthesis.sections) {
      lines.push(`### ${section.title}`, section.body, `Sources: ${section.sourceUrls.join(', ')}`, '');
    }
  }

  lines.push('## Sources');
  for (const source of session.sources) {
    lines.push(`### ${source.title}`, source.url, source.summary, '', 'Facts:', list(source.keyFacts), '');
  }

  lines.push('## Agent trace');
  for (const tab of session.tabs) {
    lines.push(`### ${tab.agentName}: ${tab.title}`, `${tab.status} · ${tab.url}`);
    lines.push(list(tab.actions.map((item) => `${item.at}: ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)), '');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export function sessionToPortableJson(session: ResearchSessionState) {
  return { exportedAt: new Date().toISOString(), app: 'Toji', session };
}
