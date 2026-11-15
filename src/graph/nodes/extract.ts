import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
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

  const result = await chatJson({
    model: appConfig.models.fast,
    messages: extractMessages({ now: state.now, evidence: state.evidence }),
    schema: ExtractionSchema,
    schemaName: 'since_extraction',
    maxTokens: 2400,
    reasoning: { enabled: false },
  });

  const byId = new Map(state.evidence.map((row) => [row.id, row]));
  const observations: Observation[] = [];
  let dropped = 0;

  for (const item of result.data.observations) {
    const evidence = byId.get(item.evidence_id);
    if (!evidence) {
      dropped += 1;
      continue;
    }

    const value = item.kind === 'price' ? priceValue(item) : item.value;
    if (value === null) {
      dropped += 1;
      continue;
    }

    observations.push({
      entity: item.entity,
      entityId: null,
      attribute: item.attribute,
      value,
      plan: item.plan,
      currency: item.currency,
      period: item.period,
      mode: item.mode,
      unit: item.unit,
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
    });
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
