import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { currentClaims, findEntity } from '../../db/repo.js';
import { planKey } from '../../domain/pricing.js';
import { chatJson } from '../../llm/openrouter.js';
import { extractMessages } from '../prompts/extract.js';
import { ExtractionSchema } from '../schemas.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, Observation, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

function planOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'plan' in value) {
    const plan = (value as { plan?: unknown }).plan;
    return typeof plan === 'string' ? plan : null;
  }
  return null;
}

type Billing = {
  period: 'month' | 'year' | 'one_time' | null;
  mode: 'flat' | 'per_user' | 'per_workspace' | null;
  unit: string | null;
};

/**
 * Pricing pages often say "$49/user/month billed annually". The extractor tends
 * to read that as period=year. The price cadence is monthly; only the commitment
 * is annual. Fix the unambiguous cases deterministically from the passage.
 */
function inferBilling(passage: string, item: Billing): Billing {
  const monthly = /(?:\/|per\s+)(?:user|seat|workspace|account|project)?\s*(?:\/|per\s+)?(?:month|mo)\b|\/mo\b/i.test(
    passage,
  );
  const annual = /(?:\/|per\s+)(?:user|seat|workspace|account|project)?\s*(?:\/|per\s+)?(?:year|yr)\b|\/yr\b/i.test(
    passage,
  );
  const unitMatch = /(?:\/|per\s+)(user|seat|workspace|account|project)\b/i.exec(passage);

  const unit = item.unit ?? unitMatch?.[1] ?? null;
  const period = monthly ? 'month' : annual ? 'year' : item.period;
  const mode =
    item.mode ??
    (unit === 'user' || unit === 'seat'
      ? 'per_user'
      : unit
        ? 'per_workspace'
        : null);

  return { period, mode, unit };
}

type PartialPrice = {
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

function priceValue(item: {
  value: number | string | boolean;
  plan: string | null;
  currency: string | null;
  period: 'month' | 'year' | 'one_time' | null;
  mode: 'flat' | 'per_user' | 'per_workspace' | null;
  unit: string | null;
  region: string | null;
  conditions: string[];
}): PartialPrice | null {
  if (typeof item.value !== 'number') return null;
  return {
    kind: 'price',
    amount: item.value,
    currency: item.currency,
    period: item.period,
    mode: item.mode,
    unit: item.unit,
    plan: item.plan,
    region: item.region,
    conditions: item.conditions,
  };
}

export async function extractNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  if (state.evidence.length === 0) {
    emit?.({ type: 'status', stage: 'extract', detail: 'no evidence to extract' });
    return {
      observations: [],
      trace: [event('extract', 'skipped: no evidence', started)],
    };
  }

  emit?.({ type: 'status', stage: 'extract', detail: `reading ${state.evidence.length} sources` });

  const targets = (state.analysis?.entities ?? []).map((entity) => {
    const row = findEntity(entity.name);
    const plan = row
      ? (currentClaims(row.id)
          .map((claim) => planOf(claim.value))
          .find((value): value is string => value !== null) ?? null)
      : null;
    return { name: entity.name, plan };
  });

  const result = await chatJson({
    model: appConfig.models.fast,
    messages: extractMessages({ now: state.now, evidence: state.evidence, targets }),
    schema: ExtractionSchema,
    schemaName: 'since_extraction',
    maxTokens: 4000,
    reasoning: { enabled: false },
  });

  const byId = new Map(state.evidence.map((row) => [row.id, row]));
  const targetPlan = new Map(
    targets.map((target) => [
      target.name.toLowerCase(),
      target.plan ? planKey(target.plan) : null,
    ]),
  );
  const observations: Observation[] = [];
  const byKey = new Map<string, Observation>();
  let dropped = 0;
  const promotional = (observation: Observation): boolean =>
    observation.conditions.some((condition) => /promo|limited|discount|offer/i.test(condition));

  for (const item of result.data.observations) {
    const evidence = byId.get(item.evidence_id);
    if (!evidence) {
      dropped += 1;
      continue;
    }

    const billing =
      item.kind === 'price'
        ? inferBilling(evidence.passage, {
            period: item.period,
            mode: item.mode,
            unit: item.unit,
          })
        : { period: item.period, mode: item.mode, unit: item.unit };

    const value =
      item.kind === 'price' ? priceValue({ ...item, ...billing }) : item.value;
    if (value === null) {
      dropped += 1;
      continue;
    }

    const observation: Observation = {
      entity: item.entity,
      entityId: null,
      attribute: item.attribute,
      value,
      plan: item.plan,
      currency: item.currency,
      period: billing.period,
      mode: billing.mode,
      unit: billing.unit,
      conditions: item.conditions,
      observedAt: evidence.fetchedAt,
      publishedAt: item.published_at ?? evidence.publishedAt,
      effectiveFrom: item.effective_from,
      evidenceId: item.evidence_id,
      sourceUrl: evidence.url,
      sourceType: 'web_observation',
      verification:
        item.confidence === 'high' && evidence.sourceRank >= 2 ? 'verified' : 'unverified',
      confidence: item.confidence,
    };

    if (targetPlan.size > 0 && !targetPlan.has(observation.entity.toLowerCase())) {
      continue;
    }
    const wantedPlan = targetPlan.get(observation.entity.toLowerCase());
    if (item.kind === 'price' && wantedPlan && observation.plan && planKey(observation.plan) !== wantedPlan) {
      continue;
    }
    if (item.kind === 'limit' && wantedPlan && !observation.plan) continue;

    const key = `${observation.entity.toLowerCase()}|${observation.attribute}|${observation.plan ?? ''}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, observation);
      observations.push(observation);
    } else if (promotional(existing) && !promotional(observation)) {
      // Keep the standard list price over a limited-time offer.
      byKey.set(key, observation);
      const index = observations.indexOf(existing);
      if (index >= 0) observations[index] = observation;
    }
  }

  emit?.({
    type: 'status',
    stage: 'extract.done',
    detail: `${observations.length} observations · ${dropped} dropped`,
  });

  return {
    observations,
    trace: [
      event(
        'extract',
        `${observations.length} observations; ${dropped} invalid evidence ids; ${result.usage.totalTokens} tokens`,
        started,
      ),
    ],
  };
}
