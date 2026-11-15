import type OpenAI from 'openai';
import { z } from 'zod';
import { getCached, putCached, type CacheStore, type TtlClass } from './cache.js';
import { tavilySearch, type SearchResult, type TavilySearchInput } from './tavily.js';

export const WebSearchArgs = z.strictObject({
  query: z.string().min(1),
  topic: z.enum(['general', 'news']).optional(),
  recency_days: z.number().int().positive().optional(),
  domains: z.array(z.string().min(1)).optional(),
});

export type WebSearchArgs = z.infer<typeof WebSearchArgs>;

/** The one agent-visible tool. Keep this the only function tool defined in src/. */
export const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the public web. Returns titles, URLs, snippets and extracted page text. Use the returned results as evidence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The search query.' },
        topic: {
          type: 'string',
          enum: ['general', 'news'],
          description: 'Use news only for a dedicated recency query; pricing lookups stay general.',
        },
        recency_days: {
          type: 'number',
          description: 'Only include results published in the last N days.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict results to these domains.',
        },
      },
      required: ['query'],
    },
  },
} satisfies OpenAI.Chat.ChatCompletionTool;

export type WebSearchDeps = {
  store: CacheStore;
  /** Injected in tests; defaults to Tavily. */
  search?: (input: TavilySearchInput) => Promise<SearchResult[]>;
  ttlClass?: TtlClass;
  now?: () => string;
};

export async function executeWebSearch(
  args: unknown,
  deps: WebSearchDeps,
): Promise<SearchResult[]> {
  const parsed = WebSearchArgs.parse(args);
  const ttlClass = deps.ttlClass ?? 'price';
  const nowIso = deps.now?.() ?? new Date().toISOString();

  const cached = await getCached(deps.store, parsed.query, ttlClass, nowIso);
  if (cached !== null) return cached;

  const search = deps.search ?? tavilySearch;
  const results = await search({
    query: parsed.query,
    topic: parsed.topic,
    recencyDays: parsed.recency_days,
    domains: parsed.domains,
  });

  await putCached(deps.store, {
    query: parsed.query,
    results,
    ttlClass,
    fetchedAt: nowIso,
  });
  return results;
}
