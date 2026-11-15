import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { currentClaims, findEntity } from '../../db/repo.js';
import { compareLimit, comparePrices, type PriceValue } from '../../domain/pricing.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type {
  ChangeReason,
  ComparisonRow,
  Emit,
  Observation,
  TraceEvent,
} from '../types.js';

type PriceLike = {
  kind: 'price';
  amount: number;
  currency: string | null;
  period: 'month' | 'year' | 'one_time' | null;
  mode: 'flat' | 'per_user' | 'per_workspace' | null;
  unit: string | null;
  plan: string | null;
  region: string | null;
  conditions: string[];
};

type LimitLike = { kind: 'limit'; amount: number; unit: string | null };

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

function isPrice(value: unknown): value is PriceLike {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'price';
}

function isLimit(value: unknown): value is LimitLike {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'limit';
}

function isCompletePrice(value: PriceLike): value is PriceValue {
  return (
    typeof value.amount === 'number' &&
    Boolean(value.currency) &&
    Boolean(value.period) &&
    Boolean(value.mode) &&
    Boolean(value.unit) &&
    Boolean(value.plan)
  );
}

function planOf(value: unknown): string | null {
  if (isPrice(value)) return value.plan;
  return null;
}

function samePlan(before: unknown, after: Observation): boolean {
  const beforePlan = planOf(before);
  if (beforePlan === null || after.plan === null) return beforePlan === after.plan;
  return norm(beforePlan) === norm(after.plan);
}

function sameAttribute(before: string, after: string): boolean {
  return norm(before) === norm(after);
}

export async function compareNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  const targets = state.analysis?.comparisonTargets ?? [];
  const rows: ComparisonRow[] = [];

  for (const target of targets) {
    const entity = findEntity(target);
    if (!entity) {
      rows.push({
        entity: target,
        attribute: 'all',
        before: null,
        after: null,
        beforeDate: null,
        afterDate: null,
        verdict: 'unclear',
        reasons: ['no_baseline'],
        baselineVerified: false,
        effectiveFrom: null,
        sourceIds: [],
      });
      continue;
    }

    const oldClaims = currentClaims(entity.id);
    const fresh = state.observations.filter(
      (observation) => norm(observation.entity) === norm(entity.canonical_name) || norm(observation.entity) === norm(target),
    );

    if (fresh.length === 0) {
      rows.push({
        entity: entity.canonical_name,
        attribute: 'all',
        before: null,
        after: null,
        beforeDate: null,
        afterDate: null,
        verdict: 'unclear',
        reasons: ['insufficient_evidence'],
        baselineVerified: false,
        effectiveFrom: null,
        sourceIds: [],
      });
      continue;
    }

    for (const observation of fresh) {
      const previous = oldClaims.find(
        (claim) =>
          sameAttribute(claim.attribute, observation.attribute) &&
          samePlan(claim.value, observation),
      );

      const reasons: ChangeReason[] = [];
      const baselineVerified = previous?.verification === 'verified';
      if (previous && !baselineVerified) reasons.push('baseline_unverified');
      if (observation.effectiveFrom && observation.effectiveFrom > state.now) {
        reasons.push('future_announcement');
      }

      let verdict: ComparisonRow['verdict'];
      if (!previous) {
        verdict = 'unclear';
        reasons.push('no_baseline');
      } else if (isPrice(previous.value) && isPrice(observation.value)) {
        if (!isCompletePrice(previous.value) || !isCompletePrice(observation.value)) {
          verdict = 'unclear';
          reasons.push('insufficient_evidence');
        } else {
          const comparison = comparePrices(previous.value, observation.value);
          verdict = comparison.verdict;
          reasons.push(...comparison.reasons);
        }
      } else if (isLimit(previous.value) && isLimit(observation.value)) {
        const comparison = compareLimit(
          previous.value.amount,
          observation.value.amount,
          observation.value.unit ?? 'units',
        );
        verdict = comparison.verdict;
        reasons.push(...comparison.reasons);
      } else {
        verdict = 'unclear';
        reasons.push('insufficient_evidence');
      }

      rows.push({
        entity: entity.canonical_name,
        attribute: observation.attribute,
        before: previous?.value ?? null,
        after: observation.value,
        beforeDate: previous?.observed_at ?? null,
        afterDate: observation.observedAt,
        verdict,
        reasons: [...new Set(reasons)],
        baselineVerified,
        effectiveFrom: observation.effectiveFrom,
        sourceIds: [observation.evidenceId],
      });
    }
  }

  emit?.({ type: 'status', stage: 'compare', detail: `${rows.length} comparisons` });
  emit?.({ type: 'diff', rows });

  return {
    comparison: rows,
    trace: [event('compare', `${rows.length} rows; ${rows.filter((row) => row.verdict === 'changed').length} changed`, started)],
  };
}
