import { Annotation } from '@langchain/langgraph';
import type {
  Analysis,
  ComparisonRow,
  EvidenceRow,
  Observation,
  RetrievalResult,
  TraceEvent,
  ValidationResult,
} from './types.js';

export const TurnState = Annotation.Root({
  sessionId: Annotation<string>(),
  turnId: Annotation<string>(),
  userText: Annotation<string>(),
  now: Annotation<string>(),
  timezone: Annotation<string>(),
  isSynthetic: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  recent: Annotation<{ role: 'user' | 'assistant'; text: string }[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  analysis: Annotation<Analysis | null>({ reducer: (_a, b) => b, default: () => null }),
  recall: Annotation<RetrievalResult | null>({ reducer: (_a, b) => b, default: () => null }),
  evidence: Annotation<EvidenceRow[]>({ reducer: (_a, b) => b, default: () => [] }),
  observations: Annotation<Observation[]>({ reducer: (_a, b) => b, default: () => [] }),
  comparison: Annotation<ComparisonRow[]>({ reducer: (_a, b) => b, default: () => [] }),
  draft: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  validation: Annotation<ValidationResult | null>({ reducer: (_a, b) => b, default: () => null }),
  repairPasses: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  trace: Annotation<TraceEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

export type TurnStateType = typeof TurnState.State;
export type TurnStateUpdate = typeof TurnState.Update;
