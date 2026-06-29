import { config } from '../config.js';
import type { PredictionResult, ResearchMode, ResearchPlan, ResearchPlanStep } from '../types.js';
import { completeJSON } from './model.js';

function stepsFor(searchQueries: string[], mode: ResearchMode, maxTabs: number): ResearchPlanStep[] {
  return [
    {
      id: 'predict',
      title: 'Understand intent',
      description: 'Infer the user goal, confidence, and minimum safe execution budget.',
      agent: 'prediction',
      status: 'queued',
      queries: [],
      targetSources: ['typed prefix'],
      budgetTabs: 0
    },
    {
      id: 'search',
      title: 'Discover sources',
      description: 'Fan out across ranked search paths while preserving source diversity.',
      agent: 'research',
      status: 'queued',
      queries: searchQueries,
      targetSources: ['official sources', 'independent analysis', 'recent updates'],
      budgetTabs: mode === 'speculative' ? Math.min(2, maxTabs) : maxTabs
    },
    {
      id: 'browse',
      title: 'Read visible tabs',
      description: 'Open real Chromium tabs, interact with pages, capture screenshots, and extract readable evidence.',
      agent: 'research',
      status: 'queued',
      queries: searchQueries,
      targetSources: ['web pages'],
      budgetTabs: mode === 'speculative' ? Math.min(2, maxTabs) : maxTabs
    },
    {
      id: 'synthesize',
      title: 'Build answer canvas',
      description: 'Convert source notes into a visual answer with findings, source map, citations, and exports.',
      agent: 'synthesis',
      status: 'queued',
      queries: [],
      targetSources: ['source notes'],
      budgetTabs: 0
    }
  ];
}

export function heuristicPlan(query: string, prediction: PredictionResult, mode: ResearchMode): ResearchPlan {
  const deep = prediction.complexity === 'deep-research';
  const depth: ResearchPlan['depth'] = mode === 'speculative' ? 'spark' : deep ? 'deep' : prediction.complexity === 'quick-answer' ? 'quick' : 'standard';
  const searchQueries = (prediction.searchPlan.length ? prediction.searchPlan.map((path) => path.query) : prediction.searchPaths).slice(0, config.maxSearchQueries);
  const maxTabs = mode === 'speculative' ? Math.max(1, prediction.budget.speculativeTabs || 1) : prediction.budget.maxTabs;
  return {
    goal: prediction.draftIntent || `Research ${query}`,
    depth,
    objective: prediction.draftIntent || `Research ${query}`,
    searchQueries: searchQueries.length ? searchQueries : [query],
    questions: [
      `What is the most direct answer to: ${query}?`,
      'Which sources are strongest or primary?',
      'What caveats or opposing evidence should be surfaced?'
    ],
    sourceStrategy: [
      'Prefer primary, official, documentation, academic, or clearly attributable sources.',
      'Deduplicate URLs and keep domain diversity in the tab budget.',
      mode === 'speculative' ? 'Keep the prewarm budget tiny and cancellable.' : 'Collect enough evidence for synthesis with citations.'
    ],
    riskControls: prediction.wasteGuard.reasons.length
      ? prediction.wasteGuard.reasons
      : ['Cancel speculative work on query fingerprint drift.', 'Do not overstate findings beyond collected sources.'],
    expectedOutput: ['summary', 'findings', 'visual cards', 'source map', 'citations', 'markdown export'],
    expectedOutputs: ['summary', 'findings', 'visual cards', 'source map', 'citations', 'markdown export'],
    stopConditions: ['tab budget reached', 'source diversity is sufficient', 'session cancelled'],
    maxDepth: ({ spark: 1, quick: 1, standard: 2, deep: 3 } as Record<ResearchPlan['depth'], number>)[depth],
    stance: mode === 'speculative' ? 'fast' : depth === 'deep' ? 'exhaustive' : 'balanced',
    steps: stepsFor(searchQueries.length ? searchQueries : [query], mode, maxTabs)
  };
}

export async function buildResearchPlan(query: string, prediction: PredictionResult, mode: ResearchMode): Promise<ResearchPlan> {
  const fallback = heuristicPlan(query, prediction, mode);
  try {
    const planned = await completeJSON<Partial<ResearchPlan>>({
      system:
        'You are the Toji planner agent. Turn a prediction object into a concise browser research plan. Be practical: limit search queries, use reliable source strategy, and keep speculative plans cheap. Return JSON only.',
      user: JSON.stringify({
        query,
        mode,
        prediction,
        limits: { maxSearchQueries: config.maxSearchQueries, maxTabs: config.maxAgentTabs, maxSpeculativeTabs: config.maxSpeculativeTabs },
        requiredShape: {
          goal: 'string',
          depth: 'spark | quick | standard | deep',
          searchQueries: ['string'],
          questions: ['string'],
          sourceStrategy: ['string'],
          riskControls: ['string'],
          expectedOutput: ['string'],
          steps: [{ id: 'string', title: 'string', description: 'string', agent: 'prediction | research | synthesis | safety', status: 'queued', queries: ['string'], targetSources: ['string'], budgetTabs: 'number' }]
        }
      }),
      temperature: 0.12,
      maxTokens: 1200
    });
    const searchQueries = Array.isArray(planned.searchQueries) && planned.searchQueries.length > 0 ? planned.searchQueries.slice(0, config.maxSearchQueries) : fallback.searchQueries;
    return {
      ...fallback,
      ...planned,
      goal: planned.goal || fallback.goal,
      depth: planned.depth === 'spark' || planned.depth === 'quick' || planned.depth === 'standard' || planned.depth === 'deep' ? planned.depth : fallback.depth,
      searchQueries,
      questions: Array.isArray(planned.questions) && planned.questions.length > 0 ? planned.questions : fallback.questions,
      sourceStrategy: Array.isArray(planned.sourceStrategy) && planned.sourceStrategy.length > 0 ? planned.sourceStrategy : fallback.sourceStrategy,
      riskControls: Array.isArray(planned.riskControls) && planned.riskControls.length > 0 ? planned.riskControls : fallback.riskControls,
      expectedOutput: Array.isArray(planned.expectedOutput) && planned.expectedOutput.length > 0 ? planned.expectedOutput : fallback.expectedOutput,
      expectedOutputs: Array.isArray(planned.expectedOutputs) && planned.expectedOutputs.length > 0 ? planned.expectedOutputs : fallback.expectedOutputs,
      stopConditions: Array.isArray(planned.stopConditions) && planned.stopConditions.length > 0 ? planned.stopConditions : fallback.stopConditions,
      maxDepth: Number(planned.maxDepth ?? fallback.maxDepth),
      stance: planned.stance ?? fallback.stance,
      steps: Array.isArray(planned.steps) && planned.steps.length > 0 ? planned.steps : stepsFor(searchQueries, mode, mode === 'speculative' ? Math.min(2, fallback.steps[1]?.budgetTabs ?? 1) : fallback.steps[1]?.budgetTabs ?? config.maxAgentTabs)
    };
  } catch (error) {
    console.warn('[toji] buildResearchPlan model call failed, using heuristic plan:', error instanceof Error ? error.message : error);
    return fallback;
  }
}
