import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { allEntities } from '../../db/repo.js';
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

export async function analyzeNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  const smalltalk =
    /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))([!,. ]+(who are you|what are you|there))?[!?., ]*$/i.test(
      state.userText.trim(),
    ) || /^(who|what) are you[?.! ]*$/i.test(state.userText.trim());

  if (smalltalk) {
    return {
      analysis: {
        intent: 'smalltalk',
        entities: [],
        dateExpressions: [],
        resolvedDates: [],
        decisions: [],
        attributes: [],
        searchPlan: [],
        needsSearch: false,
        comparisonTargets: [],
      },
      trace: [event('analyze', 'deterministic smalltalk', started)],
    };
  }

  emit?.({ type: 'status', stage: 'analyze', detail: 'reading the question' });

  const context = [state.userText, ...state.recent.slice(-4).map((turn) => turn.text)]
    .join(' ')
    .toLowerCase();
  const knownEntities = allEntities()
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

  const analysis: Analysis = {
    intent: result.data.intent,
    entities: result.data.entities,
    dateExpressions: result.data.date_expressions,
    resolvedDates,
    decisions: result.data.decisions,
    attributes: result.data.attributes,
    searchPlan: result.data.search_plan.slice(0, appConfig.caps.parallelSearches).map((plan) => ({
      query: plan.query,
      entity: plan.entity,
      recencyDays: plan.recency_days,
      domains: plan.domains,
    })),
    needsSearch: result.data.intent !== 'smalltalk' && result.data.needs_search,
    comparisonTargets: result.data.comparison_targets,
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
