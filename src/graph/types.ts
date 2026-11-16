import type { ChangeReason as PriceChangeReason } from '../domain/pricing.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type Intent = 'fresh' | 'recall' | 'recheck' | 'chat';
export type Volatility = 'price' | 'feature' | 'stable';
export type SourceType = 'user_statement' | 'assistant_statement' | 'web_observation';
export type Verification = 'unverified' | 'verified' | 'disputed' | 'inaccessible';
export type RetrievalOutcome =
  | 'exact'
  | 'likely'
  | 'multiple'
  | 'not_found'
  | 'insufficient_context';

export type DateRange = {
  original: string;
  timezone: string;
  referenceIso: string;
  localStart: string;
  localEndExclusive: string;
  utcStart: string;
  utcEndExclusive: string;
  confidence: 'high' | 'medium' | 'low';
};

export type DecisionType = 'shortlist' | 'selection' | 'rejection' | 'preference';

export type Analysis = {
  intent: Intent;
  entities: { name: string; domain: string | null; aliases: string[] }[];
  dateExpressions: string[];
  resolvedDates: DateRange[];
  decisions: { topic: string; type: DecisionType; entities: string[] }[];
  attributes: { entity: string; attribute: string; volatility: Volatility }[];
  searchPlan: { query: string; entity: string | null; recencyDays: number | null; domains: string[] }[];
  needsSearch: boolean;
  comparisonTargets: string[];
};

export type EvidenceRow = {
  id: string;
  url: string;
  title: string;
  domain: string;
  snippet: string;
  passage: string;
  publishedAt: string | null;
  fetchedAt: string;
  sourceRank: number;
};

export type Observation = {
  entity: string;
  entityId: string | null;
  attribute: string;
  value: unknown;
  plan: string | null;
  currency: string | null;
  period: 'month' | 'year' | 'one_time' | null;
  mode: 'flat' | 'per_user' | 'per_workspace' | null;
  unit: string | null;
  conditions: string[];
  observedAt: string;
  publishedAt: string | null;
  effectiveFrom: string | null;
  evidenceId: string;
  sourceUrl: string;
  sourceType: SourceType;
  verification: Verification;
  confidence: 'high' | 'medium' | 'low';
};

export type ChangeReason =
  | PriceChangeReason
  | 'no_baseline'
  | 'baseline_unverified'
  | 'future_announcement';

export type ComparisonRow = {
  entity: string;
  attribute: string;
  before: unknown | null;
  after: unknown | null;
  beforeDate: string | null;
  afterDate: string | null;
  verdict: 'changed' | 'unchanged' | 'unclear';
  reasons: ChangeReason[];
  baselineVerified: boolean;
  effectiveFrom: string | null;
  sourceIds: string[];
};

export type EpisodeHit = {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  entities: string[];
  isSynthetic: boolean;
};

export type ClaimHit = {
  id: string;
  entity: string;
  attribute: string;
  value: unknown;
  observedAt: string;
  publishedAt: string | null;
  effectiveFrom: string | null;
  verification: Verification;
  sourceUrl: string | null;
  sourceRank: number | null;
};

export type DecisionHit = {
  id: string;
  topic: string;
  type: DecisionType;
  entities: string[];
};

export type RetrievalResult = {
  outcome: RetrievalOutcome;
  episodes: EpisodeHit[];
  claims: ClaimHit[];
  decisions: DecisionHit[];
  scores: { id: string; fts: number; vector: number; fused: number }[];
};

export type ValidationVerdict = {
  index: number;
  status: 'supported' | 'partial' | 'unsupported';
  reason: string;
};

export type ValidationResult = {
  verdicts: ValidationVerdict[];
  failed: number;
};

export type TraceEvent = {
  at: string;
  node: string;
  detail: string;
  ms?: number;
};

export type Emit = (event: StreamEvent) => void;

export type StreamEvent =
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'token'; text: string }
  | { type: 'diff'; rows: ComparisonRow[] }
  | { type: 'sources'; sources: { id: string; url: string; title: string; domain: string; publishedAt: string | null }[] }
  | { type: 'verification'; verified: number; unverified: number }
  | { type: 'patch'; text: string }
  | { type: 'done'; turnId: string; sessionId: string; latencyMs: number }
  | { type: 'error'; message: string };
