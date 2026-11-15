import { config } from '../config.js';
import type { SearchResult } from './tavily.js';

export type TtlClass = keyof typeof config.ttlMs;

/** Price 10 minutes, feature 1 day, stable 30 days. */
export const TTL_MS: Readonly<Record<TtlClass, number>> = config.ttlMs;

export type CacheRow = {
  query: string;
  normalizedQuery: string;
  provider: string;
  results: SearchResult[];
  fetchedAt: string;
  ttlClass: TtlClass;
};

/**
 * Persistence seam for cached search results. The checks table keeps history:
 * `put` appends and nothing here or in the implementation may delete a row.
 */
export interface CacheStore {
  /** Newest row for the normalized query at or after `sinceIso`, or null. */
  get(normalizedQuery: string, sinceIso: string): Promise<CacheRow | null>;
  put(row: CacheRow): Promise<void>;
}

/** Lowercase, collapse whitespace, replace punctuation with spaces. */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Earliest fetchedAt that is still fresh for the given class. */
export function ttlStart(ttlClass: TtlClass, nowIso: string): string {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) throw new Error(`Invalid timestamp: ${nowIso}`);
  return new Date(now - TTL_MS[ttlClass]).toISOString();
}

export async function getCached(
  store: CacheStore,
  query: string,
  ttlClass: TtlClass,
  nowIso: string = new Date().toISOString(),
): Promise<SearchResult[] | null> {
  const sinceIso = ttlStart(ttlClass, nowIso);
  const row = await store.get(normalizeQuery(query), sinceIso);
  if (row === null) return null;
  // Recheck TTL here so a store that ignores `sinceIso` cannot serve stale data.
  return Date.parse(row.fetchedAt) >= Date.parse(sinceIso) ? row.results : null;
}

export async function putCached(
  store: CacheStore,
  input: {
    query: string;
    results: SearchResult[];
    ttlClass: TtlClass;
    provider?: string;
    fetchedAt?: string;
  },
): Promise<CacheRow> {
  const row: CacheRow = {
    query: input.query,
    normalizedQuery: normalizeQuery(input.query),
    provider: input.provider ?? 'tavily',
    results: input.results,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    ttlClass: input.ttlClass,
  };
  await store.put(row);
  return row;
}
