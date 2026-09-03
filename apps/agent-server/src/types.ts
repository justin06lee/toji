export type ResearchMode = 'speculative' | 'committed' | 'demo';
export type ResearchDepth = 'spark' | 'quick' | 'standard' | 'deep';
export type SessionStatus = 'queued' | 'planning' | 'searching' | 'ranking' | 'running' | 'synthesizing' | 'complete' | 'cancelled' | 'error';
export type TabStatus = 'queued' | 'navigating' | 'reading' | 'interacting' | 'summarizing' | 'complete' | 'cached' | 'error';
export type PredictionStance = 'observe' | 'shape' | 'prewarm' | 'commit';
export type TypingStage = 'too-early' | 'autocomplete' | 'intent-shaping' | 'safe-prewarm' | 'submitted';
export type SourceCredibility = 'primary' | 'strong' | 'mixed' | 'unknown';
export type FreshnessMode = 'auto' | 'latest' | 'timeless';
export type SearchProvider = 'duckduckgo' | 'brave' | 'fallback' | 'direct' | 'demo' | 'serpapi';
export type PlanStepStatus = 'queued' | 'running' | 'complete' | 'skipped';

export interface ResearchOptions {
  depth: ResearchDepth;
  maxTabs?: number;
  visualSnapshots: boolean;
  includeVisualAnalysis: boolean;
  freshness: FreshnessMode;
}

export interface SearchPath {
  query: string;
  intent: string;
  priority: number;
  freshness: FreshnessMode;
}

export interface WasteGuard {
  shouldPrewarm: boolean;
  cancelOnFingerprintChange: boolean;
  reusePolicy: string;
  expectedWaste: 'none' | 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface PredictionBudget {
  maxTabs: number;
  maxSources: number;
  speculativeTabs: number;
  maxSearchQueries: number;
  parallelTabs: number;
  stopIfConfidenceBelow: number;
  idlePrewarmMs?: number;
}

export interface PredictionSuggestion {
  id: string;
  label: string;
  completion: string;
  detail: string;
  action: 'complete' | 'search' | 'navigate';
  confidence: number;
  searchPath?: SearchPath;
}

export interface PredictionResult {
  query: string;
  queryFingerprint: string;
  draftIntent: string;
  likelyCompletions: string[];
  suggestions: PredictionSuggestion[];
  searchPaths: string[];
  searchPlan: SearchPath[];
  confidence: number;
  stance: PredictionStance;
  typingStage: TypingStage;
  complexity: 'navigation' | 'quick-answer' | 'deep-research';
  risk: 'low' | 'medium' | 'high';
  budget: PredictionBudget;
  wasteGuard: WasteGuard;
  rationale: string;
  avoidedWork?: string[];
}

export interface ResearchPlanStep {
  id: string;
  title: string;
  description: string;
  agent: 'prediction' | 'research' | 'synthesis' | 'safety';
  status: PlanStepStatus;
  queries: string[];
  targetSources: string[];
  budgetTabs: number;
}

export interface ResearchPlan {
  goal: string;
  depth: ResearchDepth;
  searchQueries: string[];
  questions: string[];
  sourceStrategy: string[];
  riskControls: string[];
  expectedOutput: string[];
  steps: ResearchPlanStep[];
  objective?: string;
  expectedOutputs?: string[];
  stopConditions?: string[];
  maxDepth?: number;
  stance?: 'fast' | 'balanced' | 'exhaustive';
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: SearchProvider;
  query: string;
  score: number;
  rank?: number;
  domain?: string;
  reason?: string;
}

export interface TabAction {
  at: string;
  type: 'open' | 'navigate' | 'scroll' | 'click' | 'read' | 'screenshot' | 'snapshot' | 'extract' | 'scan' | 'summarize' | 'rank' | 'cache' | 'error';
  label: string;
  detail?: string;
}

export interface LinkCandidate {
  text: string;
  url: string;
}

export interface TabState {
  id: string;
  agentName: string;
  title: string;
  url: string;
  status: TabStatus;
  screenshot?: string;
  progress: number;
  evidenceCount: number;
  summary?: string;
  actions: TabAction[];
  discoveredLinks?: LinkCandidate[];
  sourceScore?: number;
  agentGoal?: string;
  credibility?: SourceCredibility;
  readableChars?: number;
  domain?: string;
  cacheHit?: boolean;
  error?: string;
}

export interface SourceSignal {
  label: string;
  value: string;
}

export interface SourceNote {
  tabId: string;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  keyFacts: string[];
  quotes: string[];
  credibility: SourceCredibility;
  signals: SourceSignal[];
  capturedAt: string;
  credibilityReason?: string;
  wordCount?: number;
  sourceScore?: number;
  discoveredLinks?: LinkCandidate[];
  cacheHit?: boolean;
  domain?: string;
  sourceType?: string;
  visualEvidence?: string;
}

export interface SynthesisSection {
  title: string;
  body: string;
  sourceUrls: string[];
}

export interface SynthesisFinding {
  claim: string;
  evidenceUrl: string;
  evidenceTitle: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface VisualBlock {
  title: string;
  value: string;
  caption: string;
}

export interface OverviewCard {
  label: string;
  value: string;
  detail: string;
}

export interface SourceMapItem {
  domain: string;
  count: number;
  credibility: SourceCredibility;
  urls: string[];
}

export interface SynthesisResult {
  headline: string;
  summary: string;
  sections: SynthesisSection[];
  findings: SynthesisFinding[];
  citations: Array<{ title: string; url: string; credibility?: SourceCredibility }>;
  followUps: string[];
  visualBlocks: VisualBlock[];
  overviewCards: OverviewCard[];
  sourceMap: SourceMapItem[];
  markdown: string;
}

export interface ResearchMetrics {
  tabsOpened: number;
  pagesRead: number;
  screenshotsCaptured: number;
  cacheHits: number;
  sourcesSummarized: number;
  searchQueries: number;
  searchResults: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
}

export interface ResearchSessionState {
  id: string;
  mode: ResearchMode;
  query: string;
  queryFingerprint: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  prediction?: PredictionResult;
  options: ResearchOptions;
  plan: ResearchPlan;
  searchPlan?: SearchPath[];
  researchPlan?: ResearchPlan;
  tabs: TabState[];
  sources: SourceNote[];
  synthesis?: SynthesisResult;
  metrics: ResearchMetrics;
  previousSessionId?: string;
  supersedesSessionId?: string;
  depth: ResearchDepth;
  error?: string;
}

export interface PageSource {
  title: string;
  url: string;
  credibility?: SourceCredibility;
  summary?: string;
}

export type ServerEvent = (
  | { type: 'hello'; message: string; app?: string }
  | { type: 'session_update'; session: ResearchSessionState }
  | { type: 'agent_log'; sessionId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'prediction'; prediction: PredictionResult }
  | { type: 'settings_update'; settings: UserSettings }
  | { type: 'page_start'; pageId: string; query: string }
  | { type: 'page_delta'; pageId: string; chunk: string }
  | { type: 'page_complete'; pageId: string }
  | { type: 'page_error'; pageId: string; message: string }
  | { type: 'page_sources'; pageId: string; sources: PageSource[] }
) & { at?: string };

export interface UserSettings {
  autoSpeculation: boolean;
  maxTabs: number;
  defaultDepth: ResearchDepth;
  defaultFreshness: FreshnessMode;
  visualAnalysis: boolean;
  theme: 'dark' | 'system';
  /** What powers inference. 'yagami' embeds the yagami engine (the signed-in
   *  coding-agent CLIs on this machine — no keys); 'local' is any OpenAI-compatible
   *  endpoint (Ollama, LM Studio, vLLM, a home server); 'off' forces the
   *  deterministic demo/heuristic fallbacks. URL/key live only in settings.json. */
  agent: 'toji' | 'yagami' | 'cerebras' | 'local' | 'off';
  /** Yagami model id ('' = the engine's default; supports "provider:model"). */
  agentModel: string;
  /** Reasoning/thinking effort. 'default' = omit. */
  agentThinking: 'default' | 'low' | 'medium' | 'high';
  /** Cerebras model id (e.g. gpt-oss-120b). */
  cerebrasModel: string;
  /** Optional Cerebras key. Empty means fall back to CEREBRAS_API_KEY from the
   *  environment, which is never copied in here. */
  cerebrasApiKey: string;
  /** Custom endpoint: OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1 for Ollama). */
  localUrl: string;
  /** Custom endpoint model name (e.g. llama3.2). */
  localModel: string;
  /** Optional bearer token for the custom endpoint. */
  localApiKey: string;
}

export interface AppConfig {
  app: string;
  liveModelEnabled: boolean;
  model: string;
  maxAgentTabs: number;
  maxSpeculativeTabs: number;
  maxConcurrentTabs: number;
  maxSearchQueries: number;
  visualAnalysisEnabled: boolean;
  demoModeEnabled: boolean;
  searchProvider: string;
  sessionHistoryLimit: number;
}
