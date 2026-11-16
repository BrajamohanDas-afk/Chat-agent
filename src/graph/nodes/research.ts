import type OpenAI from 'openai';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { sourceRank } from '../../domain/sources.js';
import { chatTools } from '../../llm/openrouter.js';
import { dbCacheStore } from '../../search/db-cache.js';
import { executeWebSearch, webSearchTool } from '../../search/tool.js';
import { researchMessages } from '../prompts/research.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, EvidenceRow, TraceEvent, Volatility } from '../types.js';

type PlannedQuery = {
  query: string;
  entity: string | null;
  recencyDays: number | null;
  domains: string[];
};

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

async function within<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const aborted = new Promise<null>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

function looksPriced(passage: string): boolean {
  return /[$€£]|\bpricing\b|per (user|seat|month|workspace)|\/mo\b/i.test(passage);
}

export async function researchNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  const analysis = state.analysis;
  if (!analysis || !analysis.needsSearch) {
    return { evidence: [], trace: [event('research', 'not needed', started)] };
  }

  emit?.({ type: 'status', stage: 'research', detail: 'searching the web' });

  const fetchedAt = new Date().toISOString();
  const domainByEntity = new Map(
    analysis.entities.map((entity) => [entity.name.trim().toLowerCase(), entity.domain]),
  );
  const volatilityByEntity = new Map<string, Volatility>();
  for (const attribute of analysis.attributes) {
    volatilityByEntity.set(attribute.entity.trim().toLowerCase(), attribute.volatility);
  }

  let plan: PlannedQuery[] = analysis.searchPlan.slice(0, appConfig.caps.parallelSearches);
  if (plan.length === 0) {
    plan = [{ query: state.userText, entity: null, recencyDays: null, domains: [] }];
  }

  const settled = await Promise.all(
    plan.map(async (item) => {
      const ttlClass = volatilityByEntity.get(item.entity?.trim().toLowerCase() ?? '') ?? 'price';
      const results = await within(
        (signal) =>
          executeWebSearch(
            {
              query: item.query,
              recency_days: item.recencyDays ?? undefined,
              topic: item.entity === null && item.recencyDays !== null ? 'news' : 'general',
              domains: item.domains.length > 0 ? item.domains : undefined,
            },
            { store: dbCacheStore, ttlClass, signal },
          ),
        appConfig.caps.searchBudgetMs,
      );
      return { item, results: results ?? [], timedOut: results === null };
    }),
  );

  const seen = new Set<string>();
  const evidence: EvidenceRow[] = [];
  let timedOut = 0;

  const rankFor = (url: string, item: PlannedQuery): number => {
    if (item.entity) {
      return sourceRank(url, domainByEntity.get(item.entity.trim().toLowerCase()) ?? null);
    }
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    for (const domain of domainByEntity.values()) {
      if (domain && (host === domain || host.endsWith(`.${domain}`))) {
        return sourceRank(url, domain);
      }
    }
    return sourceRank(url, null);
  };

  const push = (url: string, item: PlannedQuery, result: {
    title: string;
    snippet: string;
    passage: string;
    publishedAt: string | null;
    domain: string;
  }) => {
    if (seen.has(url)) return;
    seen.add(url);
    const id = `e${evidence.length + 1}`;
    evidence.push({
      id,
      url,
      title: result.title,
      domain: result.domain,
      snippet: result.snippet,
      passage: result.passage,
      publishedAt: result.publishedAt,
      fetchedAt,
      sourceRank: rankFor(url, item),
    });
  };

  for (const { item, results, timedOut: didTimeOut } of settled) {
    if (didTimeOut) timedOut += 1;
    for (const result of results) push(result.url, item, result);
  }

  const targets =
    analysis.comparisonTargets.length > 0
      ? analysis.comparisonTargets
      : analysis.entities.map((entity) => entity.name);

  const gapsFor = (): string[] =>
    targets.filter((target) => {
      const domain = domainByEntity.get(target.trim().toLowerCase()) ?? null;
      return !evidence.some(
        (row) =>
          (domain ? row.domain.endsWith(domain) : row.sourceRank >= 2) &&
          looksPriced(row.passage),
      );
    });

  let gaps = gapsFor();
  let refinementCalls = 0;

  if (gaps.length > 0) {
    emit?.({ type: 'status', stage: 'research.refine', detail: `filling ${gaps.length} gaps` });
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...researchMessages({
        targets,
        gaps,
        existing: evidence.map((row) => ({ title: row.title, url: row.url })),
      }),
    ];

    const refineDeadline = Date.now() + 4_000;
    // shortcut: the turn itself has no wall-clock deadline; add one in runTurn if providers stall.

    for (
      let round = 0;
      round < appConfig.caps.refinementCalls &&
      refinementCalls < appConfig.caps.refinementCalls;
      round += 1
    ) {
      const remaining = refineDeadline - Date.now();
      if (remaining <= 0) break;

      let response: Awaited<ReturnType<typeof chatTools>>;
      try {
        response = await chatTools({
          model: appConfig.models.fast,
          messages,
          tools: [webSearchTool],
          toolChoice: 'auto',
          maxTokens: 700,
          signal: AbortSignal.timeout(Math.min(remaining, 3_000)),
        });
      } catch {
        // Refinement is best effort; first-round evidence still answers the turn.
        break;
      }

      if (response.toolCalls.length === 0) break;

      messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of response.toolCalls) {
        if (refinementCalls >= appConfig.caps.refinementCalls) break;

        const remaining = refineDeadline - Date.now();
        if (remaining <= 0) break;

        refinementCalls += 1;

        let args: unknown;
        try {
          args = JSON.parse(call.arguments) as unknown;
        } catch {
          args = { query: call.arguments };
        }

        const results =
          (await within(
            (signal) => executeWebSearch(args, { store: dbCacheStore, ttlClass: 'price', signal }),
            Math.min(2_500, remaining),
          )) ?? [];
        for (const result of results.slice(0, 4)) {
          push(result.url, { query: call.arguments, entity: null, recencyDays: null, domains: [] }, result);
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(
            results.slice(0, 4).map((result) => ({
              title: result.title,
              url: result.url,
              snippet: result.snippet.slice(0, 500),
              publishedAt: result.publishedAt,
            })),
          ),
        });
      }

      gaps = gapsFor();
      if (gaps.length === 0) break;
    }
  }

  emit?.({ type: 'sources', sources: evidence.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    publishedAt: row.publishedAt,
  })) });
  emit?.({
    type: 'status',
    stage: 'research.done',
    detail: `${evidence.length} sources · ${refinementCalls} refinements`,
  });

  return {
    evidence,
    trace: [
      event(
        'research',
        `${plan.length} queries; ${evidence.length} sources; ${timedOut} timed out; ${refinementCalls} refinements`,
        started,
      ),
    ],
  };
}
