import { z } from 'zod';
import { config } from '../config.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const PASSAGE_LIMIT = 4000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_ATTEMPTS = 2;

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  passage: string;
  publishedAt: string | null;
  domain: string;
};

export type TavilySearchInput = {
  query: string;
  topic?: 'general' | 'news';
  recencyDays?: number;
  domains?: string[];
  maxResults?: number;
  signal?: AbortSignal;
};

export class TavilyError extends Error {
  readonly status: number | null;
  readonly body: string | null;

  constructor(
    message: string,
    details: { status?: number | null; body?: string | null; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'TavilyError';
    this.status = details.status ?? null;
    this.body = details.body ?? null;
  }
}

const TavilyResultSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  raw_content: z.string().nullish(),
  published_date: z.string().nullish(),
});

const TavilyResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Normalize one recorded Tavily payload. Rows without a usable URL are dropped. */
export function normalizeTavilyResponse(response: unknown): SearchResult[] {
  const parsed = TavilyResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new TavilyError('Invalid Tavily response body', {
      status: 200,
      body: JSON.stringify(response ?? null).slice(0, 500),
    });
  }

  const results: SearchResult[] = [];
  for (const raw of parsed.data.results ?? []) {
    const row = TavilyResultSchema.safeParse(raw);
    if (!row.success) continue;

    const domain = domainOf(row.data.url);
    if (domain === null) continue;

    const content = (row.data.content ?? '').trim();
    const rawContent = row.data.raw_content?.trim() ?? '';
    const passage = (rawContent.length > 0 ? rawContent : content).slice(0, PASSAGE_LIMIT);

    results.push({
      url: row.data.url,
      title: row.data.title?.trim() ?? '',
      snippet: content,
      passage,
      publishedAt: row.data.published_date ?? null,
      domain,
    });
  }
  return results;
}

export type TavilyDeps = {
  fetch?: typeof fetch;
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
};

function isRetryable(error: unknown): boolean {
  if (error instanceof TavilyError) {
    return error.status === 429 || (error.status !== null && error.status >= 500);
  }
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError')
  );
}

/** Tavily has no `days` field; recency maps onto its four supported ranges. */
function timeRangeFor(days: number): 'day' | 'week' | 'month' | 'year' {
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

export async function tavilySearch(
  input: TavilySearchInput,
  deps: TavilyDeps = {},
): Promise<SearchResult[]> {
  const doFetch = deps.fetch ?? fetch;
  const apiKey = deps.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new TavilyError('TAVILY_API_KEY is not set');
  }

  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify({
    query: input.query,
    search_depth: 'advanced',
    topic: input.topic ?? (input.recencyDays ? 'news' : 'general'),
    time_range:
      input.recencyDays === undefined ? undefined : timeRangeFor(input.recencyDays),
    include_domains: input.domains,
    max_results: input.maxResults ?? DEFAULT_MAX_RESULTS,
    include_raw_content: true,
    include_published_date: true,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(config.caps.callerTimeoutMs);
      const signal =
        input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
      const response = await doFetch(TAVILY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal,
      });

      if (!response.ok) {
        throw new TavilyError(`Tavily search failed with status ${response.status}`, {
          status: response.status,
          body: (await response.text()).slice(0, 500),
        });
      }

      return normalizeTavilyResponse(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(error)) break;
      await sleep(250 + Math.random() * 100);
    }
  }

  throw lastError instanceof TavilyError
    ? lastError
    : new TavilyError('Tavily search failed', { cause: lastError });
}
