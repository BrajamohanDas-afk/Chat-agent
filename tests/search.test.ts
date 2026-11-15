import { describe, expect, it } from 'vitest';
import {
  getCached,
  normalizeQuery,
  putCached,
  type CacheRow,
  type CacheStore,
} from '../src/search/cache.js';
import {
  normalizeTavilyResponse,
  tavilySearch,
  type SearchResult,
  type TavilySearchInput,
} from '../src/search/tavily.js';
import { executeWebSearch, WebSearchArgs, webSearchTool } from '../src/search/tool.js';

const RAW_CONTENT = 'Full page text. '.repeat(400);

const tavilyFixture = {
  query: 'hubspot pricing',
  results: [
    {
      title: ' HubSpot Pricing ',
      url: 'https://www.hubspot.com/pricing',
      content: 'HubSpot starts at $20 per seat.',
      raw_content: RAW_CONTENT,
      published_date: '2026-10-01T00:00:00Z',
      score: 0.99,
    },
    {
      title: 'HubSpot Review',
      url: 'https://www.g2.com/products/hubspot/reviews',
      content: ' Review snippet ',
      raw_content: null,
      published_date: null,
      score: 0.8,
    },
    {
      title: 'Not a URL',
      url: 'not a url',
      content: 'ignored',
    },
  ],
};

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: 'https://example.com/pricing',
    title: 'Example Pricing',
    snippet: 'Example starts at $10.',
    passage: 'Example starts at $10 per month.',
    publishedAt: '2026-10-01T00:00:00Z',
    domain: 'example.com',
    ...overrides,
  };
}

function memoryStore(): CacheStore & { rows: CacheRow[] } {
  const rows: CacheRow[] = [];
  return {
    rows,
    async get(normalizedQuery: string, sinceIso: string) {
      const newest = rows
        .filter(
          (row) =>
            row.normalizedQuery === normalizedQuery &&
            Date.parse(row.fetchedAt) >= Date.parse(sinceIso),
        )
        .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
      return newest ?? null;
    },
    async put(row: CacheRow) {
      rows.push(row);
    },
  };
}

describe('normalizeTavilyResponse', () => {
  it('normalizes domains, snippets, passages and publication dates', () => {
    const results = normalizeTavilyResponse(tavilyFixture);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      url: 'https://www.hubspot.com/pricing',
      title: 'HubSpot Pricing',
      snippet: 'HubSpot starts at $20 per seat.',
      passage: `HubSpot starts at $20 per seat.\n\n${RAW_CONTENT}`.slice(0, 4000),
      publishedAt: '2026-10-01T00:00:00Z',
      domain: 'hubspot.com',
    });
    expect(results[0]?.passage).toHaveLength(4000);
  });

  it('falls back to content when raw_content is missing', () => {
    const results = normalizeTavilyResponse(tavilyFixture);

    expect(results[1]?.title).toBe('HubSpot Review');
    expect(results[1]?.snippet).toBe('Review snippet');
    expect(results[1]?.passage).toBe('Review snippet');
    expect(results[1]?.publishedAt).toBeNull();
    expect(results[1]?.domain).toBe('g2.com');
  });

  it('returns an empty list for a response without results', () => {
    expect(normalizeTavilyResponse({})).toEqual([]);
  });
});

describe('tavilySearch', () => {
  async function captureBody(input: TavilySearchInput): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(tavilyFixture), { status: 200 });
    }) as typeof fetch;

    await tavilySearch(input, { fetch: fakeFetch, apiKey: 'test-key', sleep: async () => {} });
    return body;
  }

  it('posts an advanced search and retries a 5xx once', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let attempt = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      attempt += 1;
      calls.push({ url: String(input), init: init ?? {} });
      if (attempt === 1) return new Response('busy', { status: 500 });
      return new Response(JSON.stringify(tavilyFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const results = await tavilySearch(
      { query: 'hubspot pricing' },
      { fetch: fakeFetch, apiKey: 'test-key', sleep: async () => {} },
    );

    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: 'hubspot pricing',
      search_depth: 'advanced',
      topic: 'general',
      include_raw_content: true,
      include_published_date: true,
      max_results: 8,
    });
    expect(body.days).toBeUndefined();
    expect(body.time_range).toBeUndefined();
  });

  it('maps a 7-day recency to time_range week and requests published dates', async () => {
    const body = await captureBody({ query: 'ai pricing news', recencyDays: 7 });

    expect(body).toMatchObject({
      topic: 'news',
      time_range: 'week',
      include_published_date: true,
    });
    expect(body.days).toBeUndefined();
    expect(body.start_date).toBeUndefined();
  });

  it('keeps an explicit general topic when recencyDays is set', async () => {
    const body = await captureBody({
      query: 'hubspot pricing',
      recencyDays: 7,
      topic: 'general',
    });

    expect(body.topic).toBe('general');
    expect(body.time_range).toBe('week');
  });

  it.each([
    [1, 'day'],
    [7, 'week'],
    [31, 'month'],
    [90, 'year'],
  ] as const)('maps %i days to %s', async (days, expected) => {
    const body = await captureBody({ query: 'q', recencyDays: days });
    expect(body.time_range).toBe(expected);
  });

  it('does not retry a 400', async () => {
    let attempt = 0;
    const fakeFetch = (async () => {
      attempt += 1;
      return new Response('bad query', { status: 400 });
    }) as typeof fetch;

    await expect(
      tavilySearch(
        { query: 'x' },
        { fetch: fakeFetch, apiKey: 'test-key', sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ name: 'TavilyError', status: 400 });
    expect(attempt).toBe(1);
  });
});

describe('cache', () => {
  it('normalizes queries', () => {
    expect(normalizeQuery('  HubSpot   Pricing! ')).toBe('hubspot pricing');
    expect(normalizeQuery('Postgres vs. Neon?')).toBe('postgres vs neon');
  });

  it('serves a hit within TTL and ignores an expired row', async () => {
    const store = memoryStore();
    const result = makeResult();
    await putCached(store, {
      query: 'HubSpot   Pricing!',
      results: [result],
      ttlClass: 'price',
      fetchedAt: '2026-11-14T09:00:00.000Z',
    });

    const hit = await getCached(
      store,
      'hubspot pricing',
      'price',
      '2026-11-14T09:05:00.000Z',
    );
    const expired = await getCached(
      store,
      'hubspot pricing',
      'price',
      '2026-11-14T09:11:00.000Z',
    );

    expect(hit).toEqual([result]);
    expect(expired).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.normalizedQuery).toBe('hubspot pricing');
  });

  it('rejects a stale row even when the store ignores the cutoff', async () => {
    const stale: CacheRow = {
      query: 'q',
      normalizedQuery: 'q',
      provider: 'tavily',
      results: [makeResult()],
      fetchedAt: '2026-11-01T00:00:00.000Z',
      ttlClass: 'price',
    };
    const store: CacheStore = {
      get: async () => stale,
      put: async () => {},
    };

    expect(await getCached(store, 'q', 'price', '2026-11-14T09:00:00.000Z')).toBeNull();
  });

  it('keeps the 30-day stable TTL while never deleting history', async () => {
    const store = memoryStore();
    await putCached(store, {
      query: 'q',
      results: [makeResult()],
      ttlClass: 'stable',
      fetchedAt: '2026-10-20T00:00:00.000Z',
    });
    await putCached(store, {
      query: 'q',
      results: [makeResult({ title: 'Newer' })],
      ttlClass: 'stable',
      fetchedAt: '2026-11-14T00:00:00.000Z',
    });

    const hit = await getCached(store, 'q', 'stable', '2026-11-14T00:00:00.000Z');

    expect(hit?.[0]?.title).toBe('Newer');
    expect(store.rows).toHaveLength(2);
  });
});

describe('web_search tool', () => {
  it('is one function tool with the agreed argument schema', () => {
    expect(webSearchTool.type).toBe('function');
    expect(webSearchTool.function.name).toBe('web_search');
    expect(webSearchTool.function.parameters.additionalProperties).toBe(false);
    expect(Object.keys(webSearchTool.function.parameters.properties).sort()).toEqual([
      'domains',
      'query',
      'recency_days',
      'topic',
    ]);
    expect(webSearchTool.function.parameters.properties.topic).toMatchObject({
      type: 'string',
      enum: ['general', 'news'],
    });
    expect(webSearchTool.function.parameters.required).toEqual(['query']);
  });

  it('validates arguments', () => {
    expect(() => WebSearchArgs.parse({ query: '' })).toThrow();
    expect(() => WebSearchArgs.parse({ query: 'x', topic: 'academic' })).toThrow();
    expect(WebSearchArgs.parse({ query: 'x' })).toEqual({ query: 'x' });
  });

  it('uses the cache for equivalent queries and passes refinements through', async () => {
    const store = memoryStore();
    const searches: TavilySearchInput[] = [];
    const result = makeResult();
    const search = async (input: TavilySearchInput) => {
      searches.push(input);
      return [result];
    };
    let clock = '2026-11-14T09:00:00.000Z';
    const deps = { store, search, now: () => clock };

    const first = await executeWebSearch({ query: 'HubSpot Pricing' }, deps);
    const cached = await executeWebSearch({ query: ' hubspot,  pricing! ' }, deps);

    expect(cached).toEqual(first);
    expect(searches).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.normalizedQuery).toBe('hubspot pricing');

    await executeWebSearch(
      { query: 'other', topic: 'news', recency_days: 7, domains: ['example.com'] },
      deps,
    );
    expect(searches[1]).toEqual({
      query: 'other',
      topic: 'news',
      recencyDays: 7,
      domains: ['example.com'],
    });

    clock = '2026-11-14T09:11:00.000Z';
    await executeWebSearch({ query: 'HubSpot Pricing' }, deps);
    expect(searches).toHaveLength(3);
  });

  it('rejects malformed arguments before searching', async () => {
    const store = memoryStore();
    let called = false;
    const search = async () => {
      called = true;
      return [];
    };

    await expect(
      executeWebSearch({ query: 42 }, { store, search }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
