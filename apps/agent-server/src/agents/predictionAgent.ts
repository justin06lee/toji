import { config } from '../config.js';
import type { FreshnessMode, PredictionBudget, PredictionResult, PredictionSuggestion, SearchPath, TypingStage, WasteGuard } from '../types.js';
import { completeJSON } from './model.js';
import { canonicalUrl, clamp, fallbackIfEmpty, fingerprintQuery, isUrlLike, normalizeWhitespace, overlapScore } from '../lib/text.js';

function inferStage(clean: string, confidence: number): TypingStage {
  if (clean.length < 3) return 'too-early';
  if (clean.length < 8) return 'autocomplete';
  if (clean.length < 18 || confidence < 0.72) return 'intent-shaping';
  return 'safe-prewarm';
}

function buildSearchPlan(base: string, looksResearch: boolean, looksLatest: boolean, looksCompare: boolean): SearchPath[] {
  if (isUrlLike(base)) {
    return [{ query: canonicalUrl(base), intent: 'direct navigation', priority: 1, freshness: 'auto' }];
  }

  const plan: SearchPath[] = [
    { query: base, intent: 'broad source discovery', priority: 1, freshness: looksLatest ? 'latest' : 'auto' },
    { query: `${base} official source`, intent: 'primary or official evidence', priority: 0.92, freshness: 'auto' }
  ];

  if (looksResearch) {
    plan.push({ query: `${base} analysis evidence`, intent: 'independent analysis and context', priority: 0.78, freshness: looksLatest ? 'latest' : 'auto' });
  }
  if (looksCompare) {
    plan.push({ query: `${base} comparison pros cons`, intent: 'comparison and tradeoff evidence', priority: 0.72, freshness: 'auto' });
  }
  if (looksLatest) {
    plan.push({ query: `${base} 2026 latest update`, intent: 'recent update check', priority: 0.68, freshness: 'latest' });
  }

  return plan.slice(0, config.maxSearchQueries);
}

function titleCaseFragment(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 9)
    .map((word) => (word.length <= 3 ? word.toUpperCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ');
}

function sanitizeFreshness(value: unknown): FreshnessMode {
  return value === 'latest' || value === 'timeless' ? value : 'auto';
}

function buildSuggestions(clean: string, completions: string[], searchPlan: SearchPath[], confidence: number, complexity: PredictionResult['complexity']): PredictionSuggestion[] {
  const seen = new Set<string>();
  const suggestions: PredictionSuggestion[] = [];

  for (const [index, completion] of completions.entries()) {
    const normalized = normalizeWhitespace(completion);
    if (!normalized || normalized.length <= clean.length || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    suggestions.push({
      id: `completion-${index}`,
      label: normalized,
      completion: normalized,
      detail: index === 0 ? 'Predicted full prompt' : 'Alternate intent',
      action: isUrlLike(normalized) ? 'navigate' : 'complete',
      confidence: clamp(confidence - index * 0.07, 0.18, 0.98),
      searchPath: searchPlan[index]
    });
  }

  for (const [index, path] of searchPlan.entries()) {
    const normalized = normalizeWhitespace(path.query);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    suggestions.push({
      id: `path-${index}`,
      label: normalized,
      completion: normalized,
      detail: path.intent || (complexity === 'navigation' ? 'Open directly' : 'Search path'),
      action: complexity === 'navigation' || isUrlLike(normalized) ? 'navigate' : 'search',
      confidence: clamp((confidence * 0.92) - index * 0.06, 0.16, 0.96),
      searchPath: path
    });
  }

  return suggestions.slice(0, 5);
}

function budgetFor(complexity: PredictionResult['complexity'], confidence: number): PredictionBudget {
  const deepTabs = complexity === 'deep-research' ? config.maxAgentTabs : complexity === 'quick-answer' ? Math.min(4, config.maxAgentTabs) : 1;
  const speculativeTabs = confidence >= 0.78 ? Math.min(config.maxSpeculativeTabs, 2) : confidence >= 0.72 ? Math.min(config.maxSpeculativeTabs, 1) : 0;
  return {
    maxTabs: Math.max(1, deepTabs),
    maxSources: Math.max(1, Math.min(config.maxAgentTabs + 4, deepTabs + 2)),
    speculativeTabs,
    maxSearchQueries: complexity === 'deep-research' ? Math.min(config.maxSearchQueries, 4) : 1,
    parallelTabs: Math.min(config.maxConcurrentTabs, Math.max(1, deepTabs)),
    idlePrewarmMs: confidence >= 0.82 ? 360 : confidence >= 0.72 ? 520 : 760,
    stopIfConfidenceBelow: 0.55
  };
}

function wasteGuardFor(confidence: number, clean: string, stage: TypingStage, budget: PredictionBudget): WasteGuard {
  const shouldPrewarm = stage === 'safe-prewarm' && confidence >= 0.72 && budget.speculativeTabs > 0;
  const reasons = shouldPrewarm
    ? ['prefix is semantically stable', 'budget is capped to speculative tabs', 'work is cancelled on fingerprint drift']
    : clean.length < 18
      ? ['prefix is still short', 'research waits until the intent stabilizes']
      : ['confidence is below prewarm threshold', 'Toji will keep planning without opening tabs'];

  return {
    shouldPrewarm,
    cancelOnFingerprintChange: true,
    reusePolicy: 'source notes are reusable only when normalized query intent and URL both match',
    expectedWaste: shouldPrewarm ? 'low' : 'none',
    reasons
  };
}

function heuristicPrediction(query: string): PredictionResult {
  const clean = normalizeWhitespace(query);
  const wordCount = clean.split(' ').filter(Boolean).length;
  const looksUrl = isUrlLike(clean);
  const looksLatest = /(latest|today|current|news|2026|recent|now|this week|this month)/i.test(clean);
  const looksCompare = /(compare|vs|versus|difference|better|pros|cons|tradeoff)/i.test(clean);
  const looksResearch = /(compare|research|deep|latest|why|how|what|analyze|explain|paper|market|history|best|evidence|sources|citations)/i.test(clean);
  const base = clean.replace(/[?!.]+$/g, '');
  const confidence = clamp(
    clean.length / 46 + (looksResearch ? 0.22 : 0) + (looksCompare ? 0.08 : 0) + (wordCount >= 6 ? 0.13 : 0) + (looksUrl ? 0.28 : 0),
    clean.length > 0 ? 0.08 : 0,
    0.94
  );
  const complexity = looksUrl ? 'navigation' : looksResearch || wordCount > 5 ? 'deep-research' : 'quick-answer';
  const budget = budgetFor(complexity, confidence);
  const typingStage = inferStage(clean, confidence);
  const searchPlan = buildSearchPlan(base, looksResearch, looksLatest, looksCompare);
  const guard = wasteGuardFor(confidence, clean, typingStage, budget);
  const stance = typingStage === 'too-early' ? 'observe' : typingStage === 'safe-prewarm' && budget.speculativeTabs > 0 ? 'prewarm' : 'shape';
  const completionTail = looksResearch ? ' with sources, tradeoffs, and recent context' : looksUrl ? '' : ' explained clearly';
  const likelyCompletions = [
    looksUrl ? canonicalUrl(base) : `${base}${completionTail}`,
    `${base} key facts and citations`,
    `${base} summary for a decision`,
    looksCompare ? `${base} best option by use case` : `${base} latest credible sources`
  ].filter((item, index, arr) => item.length > clean.length && arr.indexOf(item) === index);

  return {
    query: clean,
    queryFingerprint: fingerprintQuery(clean),
    draftIntent: looksUrl ? `Open ${clean}` : looksResearch ? `Research ${base}` : `Find an answer for ${base}`,
    likelyCompletions,
    suggestions: buildSuggestions(clean, likelyCompletions, searchPlan, confidence, complexity),
    searchPaths: searchPlan.map((path) => path.query),
    searchPlan,
    confidence,
    stance,
    typingStage,
    complexity,
    risk: confidence < 0.55 ? 'medium' : looksLatest ? 'medium' : 'low',
    budget,
    wasteGuard: guard,
    avoidedWork: guard.reasons,
    rationale:
      stance === 'prewarm'
        ? 'The prefix is stable enough to prewarm a tiny, cancellable tab budget.'
        : stance === 'observe'
          ? 'The prefix is too short for reliable prediction.'
          : 'Toji is shaping intent but holding network work until confidence improves.'
  };
}

function sanitizePrediction(predicted: Partial<PredictionResult>, fallback: PredictionResult): PredictionResult {
  const searchPlan = Array.isArray(predicted.searchPlan) && predicted.searchPlan.length > 0
    ? predicted.searchPlan
        .filter((path): path is SearchPath => Boolean(path?.query))
        .map((path, index) => ({
          query: normalizeWhitespace(String(path.query)),
          intent: String(path.intent || 'source discovery'),
          priority: clamp(Number(path.priority ?? 1 - index * 0.1), 0, 1),
          freshness: sanitizeFreshness(path.freshness)
        }))
        .slice(0, config.maxSearchQueries)
    : fallback.searchPlan;

  const predictedCompletions = Array.isArray(predicted.likelyCompletions)
    ? predicted.likelyCompletions
        .map((item) => normalizeWhitespace(String(item)))
        .filter((item, index, arr) => item.length > fallback.query.length && arr.indexOf(item) === index)
        .slice(0, 5)
    : fallback.likelyCompletions;

  const merged: PredictionResult = {
    ...fallback,
    ...predicted,
    query: fallback.query,
    queryFingerprint: fingerprintQuery(fallback.query),
    likelyCompletions: predictedCompletions.length ? predictedCompletions : fallback.likelyCompletions,
    searchPlan,
    searchPaths: searchPlan.map((path) => path.query),
    budget: {
      ...fallback.budget,
      ...(predicted.budget ?? {})
    },
    wasteGuard: {
      ...fallback.wasteGuard,
      ...(predicted.wasteGuard ?? {})
    }
  } as PredictionResult;

  const num = (v: unknown, d: number | undefined): number =>
    Number.isFinite(Number(v)) ? Number(v) : (Number.isFinite(Number(d)) ? Number(d) : 0);
  merged.confidence = clamp(num(merged.confidence, fallback.confidence), 0, 1);
  merged.budget.maxTabs = Math.max(1, Math.min(config.maxAgentTabs, num(merged.budget.maxTabs, fallback.budget.maxTabs)));
  merged.budget.maxSources = Math.max(1, Math.min(config.maxAgentTabs + 4, num(merged.budget.maxSources, fallback.budget.maxSources)));
  merged.budget.speculativeTabs = Math.max(0, Math.min(config.maxSpeculativeTabs, num(merged.budget.speculativeTabs, fallback.budget.speculativeTabs)));
  merged.budget.maxSearchQueries = Math.max(1, Math.min(config.maxSearchQueries, num(merged.budget.maxSearchQueries, fallback.budget.maxSearchQueries)));
  merged.budget.parallelTabs = Math.max(1, Math.min(config.maxConcurrentTabs, num(merged.budget.parallelTabs, fallback.budget.parallelTabs)));
  merged.budget.idlePrewarmMs = Math.max(220, Math.min(1500, num(merged.budget.idlePrewarmMs, fallback.budget.idlePrewarmMs)));
  merged.avoidedWork = fallbackIfEmpty(merged.avoidedWork, fallback.avoidedWork).slice(0, 5);
  if (merged.stance === 'commit') merged.stance = 'prewarm';
  merged.typingStage = inferStage(merged.query, merged.confidence);
  merged.wasteGuard = wasteGuardFor(merged.confidence, merged.query, merged.typingStage, merged.budget);
  merged.suggestions = sanitizeSuggestions(predicted.suggestions, merged, fallback);

  const bestCompletion = merged.likelyCompletions?.[0] ?? '';
  if (bestCompletion && overlapScore(merged.query, bestCompletion) < 0.2 && !isUrlLike(merged.query)) {
    merged.likelyCompletions = fallback.likelyCompletions;
    merged.suggestions = fallback.suggestions;
    merged.confidence = Math.min(merged.confidence, 0.68);
    merged.stance = 'shape';
    merged.wasteGuard = wasteGuardFor(merged.confidence, merged.query, merged.typingStage, merged.budget);
  }
  return merged;
}

function sanitizeSuggestions(raw: unknown, merged: PredictionResult, fallback: PredictionResult): PredictionSuggestion[] {
  const fromModel = Array.isArray(raw)
    ? raw
        .map((item, index): PredictionSuggestion | null => {
          const value = item as Partial<PredictionSuggestion> | undefined;
          const completion = normalizeWhitespace(String(value?.completion || value?.label || ''));
          if (!completion || completion.length <= merged.query.length) return null;
          const action = value?.action === 'navigate' || value?.action === 'search' || value?.action === 'complete' ? value.action : isUrlLike(completion) ? 'navigate' : 'complete';
          const plan = value?.searchPath?.query
            ? {
                query: normalizeWhitespace(String(value.searchPath.query)),
                intent: String(value.searchPath.intent || 'suggested search path'),
                priority: clamp(Number(value.searchPath.priority ?? 0.8), 0, 1),
                freshness: sanitizeFreshness(value.searchPath.freshness)
              }
            : merged.searchPlan[index];
          return {
            id: String(value?.id || `suggestion-${index}`),
            label: normalizeWhitespace(String(value?.label || completion)),
            completion,
            detail: normalizeWhitespace(String(value?.detail || plan?.intent || 'Suggested completion')),
            action,
            confidence: clamp(Number(value?.confidence ?? merged.confidence - index * 0.06), 0, 1),
            searchPath: plan
          };
        })
        .filter((item): item is PredictionSuggestion => Boolean(item))
    : [];

  const suggestions = fromModel.length
    ? fromModel
    : buildSuggestions(merged.query, merged.likelyCompletions, merged.searchPlan, merged.confidence, merged.complexity);

  const seen = new Set<string>();
  const cleaned = suggestions
    .filter((item) => {
      const key = item.completion.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return overlapScore(merged.query, item.completion) >= 0.2 || isUrlLike(merged.query) || isUrlLike(item.completion);
    })
    .map((item, index) => ({
      ...item,
      id: item.id || `suggestion-${index}`,
      label: item.label || titleCaseFragment(item.completion),
      confidence: clamp(item.confidence, 0, 1)
    }))
    .slice(0, 5);
  return cleaned.length ? cleaned : fallback.suggestions;
}

export async function predictIntent(query: string): Promise<PredictionResult> {
  const fallback = heuristicPrediction(query);
  if (!query.trim()) return fallback;

  try {
    const predicted = await completeJSON<Partial<PredictionResult>>({
      system:
        'You are the prediction agent inside Toji, a speculative AI browser. Infer user intent from a partially typed browser/search prompt. Be conservative about opening tabs. Return valid JSON matching the requested fields.',
      user: JSON.stringify({
        query,
        constraints: {
          maxTabsHardCap: config.maxAgentTabs,
          maxSpeculativeTabs: config.maxSpeculativeTabs,
          maxSearchQueries: config.maxSearchQueries,
          stanceMeaning: {
            observe: 'too early, no network work',
            shape: 'predict and plan only',
            prewarm: 'safe to open a tiny speculative tab budget',
            commit: 'explicit user submission only; do not return this for typing prediction'
          }
        },
        requiredShape: {
          query: 'string',
          queryFingerprint: 'string',
          draftIntent: 'string',
          likelyCompletions: ['string'],
          suggestions: [
            {
              id: 'stable short id',
              label: 'visible suggestion text',
              completion: 'full query to place into the omnibox',
              detail: 'why this suggestion is useful',
              action: 'complete | search | navigate',
              confidence: 'number between 0 and 1',
              searchPath: { query: 'string', intent: 'string', priority: '0-1 number', freshness: 'auto | latest | timeless' }
            }
          ],
          searchPaths: ['string'],
          searchPlan: [{ query: 'string', intent: 'string', priority: '0-1 number', freshness: 'auto | latest | timeless' }],
          confidence: 'number between 0 and 1',
          stance: 'observe | shape | prewarm',
          typingStage: 'too-early | autocomplete | intent-shaping | safe-prewarm',
          complexity: 'navigation | quick-answer | deep-research',
          risk: 'low | medium | high',
          budget: {
            maxTabs: 'number',
            maxSources: 'number',
            speculativeTabs: '0, 1, or 2',
            maxSearchQueries: 'number',
            parallelTabs: 'number',
            idlePrewarmMs: 'milliseconds to wait after typing pause before prewarm',
            stopIfConfidenceBelow: 'number between 0 and 1'
          },
          wasteGuard: {
            shouldPrewarm: 'boolean',
            cancelOnFingerprintChange: 'boolean',
            reusePolicy: 'short string',
            expectedWaste: 'none | low | medium | high',
            reasons: ['string']
          },
          avoidedWork: ['short description of work avoided by not opening tabs yet'],
          rationale: 'short string'
        }
      }),
      temperature: 0.05,
      maxTokens: 1100
    });

    return sanitizePrediction(predicted, fallback);
  } catch (error) {
    console.warn('[toji] predictIntent model call failed, using heuristic prediction:', error instanceof Error ? error.message : error);
    return fallback;
  }
}
