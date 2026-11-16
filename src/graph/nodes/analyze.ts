import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { allEntities, currentClaims, episodesInRange } from '../../db/repo.js';
import { resolveDate } from '../../domain/dates.js';
import { chatJson } from '../../llm/openrouter.js';
import { analyzeMessages } from '../prompts/analyze.js';
import { AnalysisSchema } from '../schemas.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Analysis, DateRange, Emit, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return {
    at: new Date().toISOString(),
    node,
    detail,
    ms: Date.now() - started,
  };
}

function planOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'plan' in value) {
    const plan = (value as { plan?: unknown }).plan;
    return typeof plan === 'string' ? plan : null;
  }
  return null;
}

export async function analyzeNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  const chat =
    /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))([!,. ]+(who are you|what are you|there))?[!?., ]*$/i.test(
      state.userText.trim(),
    ) || /^(who|what) are you[?.! ]*$/i.test(state.userText.trim());

  if (chat) {
    return {
      analysis: {
        intent: 'chat',
        entities: [],
        dateExpressions: [],
        resolvedDates: [],
        decisions: [],
        attributes: [],
        searchPlan: [],
        needsSearch: false,
        comparisonTargets: [],
      },
      trace: [event('analyze', 'deterministic chat', started)],
    };
  }

  emit?.({ type: 'status', stage: 'analyze', detail: 'reading the question' });

  const entityRows = allEntities();
  const context = [state.userText, ...state.recent.slice(-4).map((turn) => turn.text)]
    .join(' ')
    .toLowerCase();
  const knownEntities = entityRows
    .filter(
      (entity) =>
        context.includes(entity.canonical_name.toLowerCase()) ||
        entity.aliases.some((alias) => context.includes(alias.toLowerCase())),
    )
    .map((entity) => ({
      name: entity.canonical_name,
      aliases: entity.aliases,
    }));

  const result = await chatJson({
    model: appConfig.models.fast,
    messages: analyzeMessages({
      now: state.now,
      timezone: state.timezone,
      recent: state.recent.slice(-3).map((turn) => ({
        role: turn.role,
        text: turn.text.slice(0, 300),
      })),
      knownEntities,
      userText: state.userText,
    }),
    schema: AnalysisSchema,
    schemaName: 'since_analysis',
    maxTokens: 700,
    reasoning: { enabled: false },
  });

  const resolvedDates: DateRange[] = [];
  const unparsedDates: string[] = [];
  for (const expression of result.data.date_expressions) {
    try {
      resolvedDates.push(resolveDate(expression, state.now, state.timezone));
    } catch {
      // A date we cannot parse is omitted, not guessed. The trace keeps the reason.
      unparsedDates.push(expression);
    }
  }

  const intent = result.data.intent;
  const needsSearch = intent === 'fresh' || intent === 'recheck';

  // "them" / "those" in a follow-up can only be resolved from the episode the
  // date points at. Backfill entities from that episode before planning search.
  const byName = new Map<string, { name: string; domain: string | null; aliases: string[] }>();
  for (const entity of result.data.entities) {
    byName.set(entity.name.toLowerCase(), entity);
  }

  const recalledText: string[] = [];
  if (intent === 'recall' || intent === 'recheck') {
    for (const range of resolvedDates) {
      if (!range.utcStart) continue;
      for (const episode of episodesInRange(range.utcStart, range.utcEndExclusive)) {
        recalledText.push(`${episode.question} ${episode.answer}`);
        for (const name of episode.entities) {
          const key = name.toLowerCase();
          if (byName.has(key)) continue;
          const row = entityRows.find(
            (entity) =>
              entity.canonical_name.toLowerCase() === key ||
              entity.aliases.some((alias) => alias.toLowerCase() === key),
          );
          byName.set(key, {
            name: row?.canonical_name ?? name,
            domain: row?.domain ?? null,
            aliases: row?.aliases ?? [],
          });
        }
      }
    }
  }

  const entities = [...byName.values()];
  const year = new Date(state.now).getUTCFullYear();
  const categoryText = [state.userText, ...recalledText].join(' ').toLowerCase();
  const category = categoryText.includes('crm')
    ? 'CRM'
    : /postgres|database|hosting/.test(categoryText)
      ? 'Postgres hosting'
      : '';

  const queryFor = (entity: { name: string }): string => {
    const row = entityRows.find(
      (candidate) => candidate.canonical_name.toLowerCase() === entity.name.toLowerCase(),
    );
    const plan = row
      ? currentClaims(row.id)
          .map((claim) => planOf(claim.value))
          .find((value): value is string => value !== null)
      : undefined;
    const parts = [entity.name];
    if (category && !entity.name.toLowerCase().includes(category.toLowerCase())) {
      parts.push(category);
    }
    if (plan) parts.push(plan);
    parts.push('pricing', String(year));
    return parts.join(' ');
  };
  let searchPlan: Analysis['searchPlan'] = result.data.search_plan.map((plan) => ({
    query: plan.query,
    entity: plan.entity,
    recencyDays: plan.recency_days,
    domains: plan.domains,
  }));

  // Generic "CRM pricing" queries cannot answer a per-vendor recheck. When the
  // entities are known, replace a fully generic plan with one query per entity.
  if (needsSearch && entities.length > 0 && searchPlan.every((plan) => plan.entity === null)) {
    searchPlan = entities.map((entity) => ({
      query: queryFor(entity),
      entity: entity.name,
      recencyDays: null,
      domains: entity.domain ? [entity.domain] : [],
    }));
    searchPlan.push({
      query: `pricing changes ${year}`,
      entity: null,
      recencyDays: 30,
      domains: [],
    });
  }

  for (const entity of entities) {
    if (searchPlan.length >= appConfig.caps.parallelSearches) break;
    if (searchPlan.some((plan) => plan.entity?.toLowerCase() === entity.name.toLowerCase())) {
      continue;
    }
    searchPlan.push({
      query: queryFor(entity),
      entity: entity.name,
      recencyDays: null,
      domains: entity.domain ? [entity.domain] : [],
    });
  }
  searchPlan = searchPlan.slice(0, appConfig.caps.parallelSearches);

  const comparisonTargets =
    intent === 'recheck'
      ? [...new Set([...result.data.comparison_targets, ...entities.map((entity) => entity.name)])]
      : result.data.comparison_targets;

  const analysis: Analysis = {
    intent,
    entities,
    dateExpressions: result.data.date_expressions,
    resolvedDates,
    decisions: result.data.decisions,
    attributes: result.data.attributes,
    searchPlan,
    needsSearch,
    comparisonTargets,
  };

  emit?.({
    type: 'status',
    stage: 'analyze.done',
    detail: `${analysis.intent} · ${analysis.entities.length} entities · ${analysis.needsSearch ? 'searching' : 'memory only'}`,
  });

  return {
    analysis,
    trace: [
      event(
        'analyze',
        `${analysis.intent}; ${analysis.entities.map((entity) => entity.name).join(', ') || 'no entities'}; ${analysis.resolvedDates.length} dates; ${unparsedDates.length} unparsed; ${result.usage.totalTokens} tokens`,
        started,
      ),
    ],
  };
}
