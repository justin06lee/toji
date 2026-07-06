import { agentAvailable, completeJSON } from './model.js';
import { listFacts, readPinned, PINNED_CAPS, type MemoryFact } from '../lib/memory.js';
import { searchFacts } from '../lib/retrieval.js';

// The "librarian": a cheap retrieval pass that hands the main agent only the
// memories relevant to its current goal — never the whole store. It lexically
// retrieves candidates (BM25), then (when an agent is available) has a cheap model
// condense them into a tiny digest; otherwise it falls back to a heuristic digest.

const MAX_DIGEST_CHARS = 900;
const FALLBACK_DIGEST_CHARS = 600;

const SYSTEM = `You are a librarian for an autonomous web agent. Given the agent's GOAL and CANDIDATE memories (id + text), return ONLY the memories that are genuinely useful for this goal, condensed into a compact digest the agent can act on. Omit irrelevant ones. Hard cap ~150 tokens. Respond as JSON {"digest": string, "used": string[] (ids)}.`;

export async function librarianDigest(
  goal: string,
  opts?: { sessionId?: string; maxTokens?: number }
): Promise<{ digest: string; usedIds: string[] }> {
  const facts = await listFacts();
  const candidates = searchFacts(facts, goal, 20);
  if (candidates.length === 0) return { digest: '', usedIds: [] };

  const knownIds = new Set(candidates.map((c) => c.id));

  if (agentAvailable()) {
    try {
      const res = await completeJSON<{ digest: string; used: string[] }>({
        system: SYSTEM,
        user: JSON.stringify({ GOAL: goal, CANDIDATES: candidates.map((c) => ({ id: c.id, text: c.text })) }),
        maxTokens: opts?.maxTokens ?? 220
      });
      const digest = String(res?.digest ?? '').trim().slice(0, MAX_DIGEST_CHARS);
      const usedIds = Array.isArray(res?.used) ? res.used.filter((id) => knownIds.has(id)) : [];
      if (digest) return { digest, usedIds };
      // Empty digest → fall through to the heuristic.
    } catch {
      // Model unavailable/failed → heuristic fallback below.
    }
  }

  return heuristicDigest(candidates);
}

/** No-model fallback: bullet the top few candidate texts within a tight budget. */
function heuristicDigest(candidates: MemoryFact[]): { digest: string; usedIds: string[] } {
  const used: string[] = [];
  const lines: string[] = [];
  let length = 0;
  for (const fact of candidates.slice(0, 5)) {
    const line = `- ${fact.text.trim()}`;
    if (length + line.length + 1 > FALLBACK_DIGEST_CHARS) break;
    lines.push(line);
    used.push(fact.id);
    length += line.length + 1;
  }
  return { digest: lines.join('\n'), usedIds: used };
}

/** The always-on pinned context (agent notes + user profile), compacted. */
export async function pinnedDigest(): Promise<string> {
  const { memory, user } = await readPinned();
  const sections: string[] = [];
  const mem = memory.trim().slice(0, PINNED_CAPS.memory);
  const usr = user.trim().slice(0, PINNED_CAPS.user);
  if (mem) sections.push(`MEMORY:\n${mem}`);
  if (usr) sections.push(`USER:\n${usr}`);
  return sections.join('\n\n');
}
