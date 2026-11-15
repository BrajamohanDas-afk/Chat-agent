import { z } from 'zod';
import { getCheck, putCheck } from '../db/repo.js';
import type { CacheRow, CacheStore } from './cache.js';

const ResultSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  passage: z.string(),
  publishedAt: z.string().nullable(),
  domain: z.string(),
});

const ResultsSchema = z.array(ResultSchema);

export const dbCacheStore: CacheStore = {
  async get(normalizedQuery: string, sinceIso: string): Promise<CacheRow | null> {
    const row = getCheck(normalizedQuery, sinceIso);
    if (!row) return null;
    const parsed = ResultsSchema.safeParse(row.results);
    if (!parsed.success) {
      console.warn('since: invalid cached search payload', {
        query: row.query,
        error: parsed.error.message,
      });
      return null;
    }
    return {
      query: row.query,
      normalizedQuery: row.normalized_query,
      provider: row.provider,
      results: parsed.data,
      fetchedAt: row.fetched_at,
      ttlClass: row.ttl_class,
    };
  },

  async put(row: CacheRow): Promise<void> {
    putCheck({
      query: row.query,
      normalized_query: row.normalizedQuery,
      provider: row.provider,
      results: row.results,
      fetched_at: row.fetchedAt,
      ttl_class: row.ttlClass,
    });
  },
};
