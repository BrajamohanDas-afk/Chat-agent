import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Analysis } from '../src/graph/types.js';
import type { EmbedFn } from '../src/memory/entities.js';
import type { RetrievalSelection, Selector, SelectorInput } from '../src/memory/retrieve.js';

const dir = mkdtempSync(join(tmpdir(), 'since-retrieval-'));
process.env.DB_PATH = join(dir, 'test.sqlite');

const { db } = await import('../src/db/client.js');
const repo = await import('../src/db/repo.js');
const { blobToVector, resolveEntity, vectorToBlob } = await import('../src/memory/entities.js');
const { retrieve } = await import('../src/memory/retrieve.js');

const T = {
  vercel: '2026-11-03T10:00:00.000Z',
  hubspot: '2026-11-09T10:00:00.000Z',
  postgres: '2026-11-10T10:00:00.000Z',
  neon: '2026-11-11T09:00:00.000Z',
  supabase: '2026-11-11T11:00:00.000Z',
} as const;

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

/** Bytes at a non-zero offset force readers to copy instead of viewing `blob.buffer`. */
function misalignedBlob(values: number[]): Uint8Array {
  const vector = Float32Array.from(values);
  const bytes = new Uint8Array(vector.byteLength + 2);
  bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), 2);
  return bytes.subarray(2);
}

/** Offline stand-in for Gemini: topic keywords map to the seeded basis vectors. */
const queryEmbed: EmbedFn = async (texts) =>
  texts.map((text) => {
    const query = text.toLowerCase();
    if (query.includes('postgres')) return vec(1, 0, 0, 0);
    if (query.includes('hubspot') || query.includes('crm')) return vec(0, 0, 1, 0);
    if (query.includes('vercel')) return vec(0, 1, 0, 0);
    if (query.includes('neon') || query.includes('supabase')) return vec(0, 0, 0, 1);
    return vec(0, 0, 0, 0);
  });

function analysisWith(overrides: Partial<Analysis> = {}): Analysis {
  return {
    intent: 'recall',
    entities: [],
    dateExpressions: [],
    resolvedDates: [],
    decisions: [],
    attributes: [],
    searchPlan: [],
    needsSearch: false,
    comparisonTargets: [],
    ...overrides,
  };
}

function dateRange(utcStart: string, utcEndExclusive: string): Analysis['resolvedDates'][number] {
  return {
    original: '3 November',
    timezone: 'UTC',
    referenceIso: '2026-11-14T09:00:00.000Z',
    localStart: utcStart,
    localEndExclusive: utcEndExclusive,
    utcStart,
    utcEndExclusive,
    confidence: 'high',
  };
}

type SelectorHarness = { select: Selector; calls: SelectorInput[] };

function fakeSelector(result: RetrievalSelection): SelectorHarness {
  const calls: SelectorInput[] = [];
  return {
    calls,
    select: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

function seedEpisode(input: {
  id: string;
  question: string;
  answer: string;
  entities: string[];
  embedding: Uint8Array;
  createdAt: string;
}): void {
  const userTurn = repo.createTurn({
    id: `${input.id}-u`,
    session_id: 's-main',
    role: 'user',
    text: input.question,
    created_at: input.createdAt,
  });
  const assistantTurn = repo.createTurn({
    id: `${input.id}-a`,
    session_id: 's-main',
    role: 'assistant',
    text: input.answer,
    created_at: input.createdAt,
  });
  repo.insertEpisode({
    id: input.id,
    session_id: 's-main',
    user_turn_id: userTurn.id,
    assistant_turn_id: assistantTurn.id,
    question: input.question,
    answer: input.answer,
    entities: input.entities,
    embedding: input.embedding,
    created_at: input.createdAt,
  });
}

let postgresId = '';

beforeAll(() => {
  repo.createSession({ id: 's-main', title: 'Retrieval fixtures' });

  const postgres = repo.upsertEntity({
    name: 'Postgres',
    domain: 'postgresql.org',
    aliases: ['PostgreSQL'],
    embedding: vectorToBlob(vec(1, 0, 0, 0)),
  });
  postgresId = postgres.id;
  repo.upsertEntity({
    name: 'HubSpot',
    domain: 'hubspot.com',
    embedding: vectorToBlob(vec(0, 0, 1, 0)),
  });
  repo.upsertEntity({
    name: 'Vercel',
    domain: 'vercel.com',
    embedding: vectorToBlob(vec(0, 1, 0, 0)),
  });

  repo.insertClaim({
    id: 'c-postgres-price',
    entity_id: postgres.id,
    attribute: 'price',
    value: { amount: 19, currency: 'USD', period: 'month' },
    source_type: 'assistant_statement',
    verification: 'unverified',
    observed_at: T.postgres,
    source_url: 'https://neon.com/pricing',
    source_rank: 3,
    session_id: 's-main',
    created_at: T.postgres,
  });

  seedEpisode({
    id: 'ep-vercel',
    question: 'What does Vercel Pro cost for a small team?',
    answer: 'Vercel Pro is $20 per user per month as of 3 November.',
    entities: ['Vercel'],
    embedding: vectorToBlob(vec(0, 1, 0, 0)),
    createdAt: T.vercel,
  });
  seedEpisode({
    id: 'ep-hubspot',
    question: 'Shortlist five CRM tools for a 20-person sales team.',
    answer: 'HubSpot, Pipedrive, Zoho CRM, Close and Freshsales.',
    entities: ['HubSpot'],
    embedding: vectorToBlob(vec(0, 0, 1, 0)),
    createdAt: T.hubspot,
  });
  seedEpisode({
    id: 'ep-postgres',
    question: 'Compare Postgres hosting for a small app.',
    answer: 'Neon, Supabase and RDS; Neon starts at $19 per month.',
    entities: ['Postgres'],
    embedding: misalignedBlob([1, 0, 0, 0]),
    createdAt: T.postgres,
  });
  seedEpisode({
    id: 'ep-neon',
    question: 'What did we decide about the Neon backup plan?',
    answer: 'Use the Neon Growth plan.',
    entities: ['Neon'],
    embedding: vectorToBlob(vec(0, 0, 0, 1)),
    createdAt: T.neon,
  });
  seedEpisode({
    id: 'ep-supabase',
    question: 'What did we decide about Supabase pricing?',
    answer: 'Stay on the Supabase Pro plan.',
    entities: ['Supabase'],
    embedding: vectorToBlob(vec(0, 0, 0, 1)),
    createdAt: T.supabase,
  });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('entity resolution', () => {
  it('resolves a canonical name or alias exactly', async () => {
    const byAlias = await resolveEntity('PostgreSQL', null, { embed: queryEmbed });
    const byName = await resolveEntity('  postgres  ', null, { embed: queryEmbed });

    expect(byAlias.id).toBe(postgresId);
    expect(byName.id).toBe(postgresId);
  });

  it('reuses an existing entity at or above the 0.9 cosine threshold', async () => {
    const reused = await resolveEntity('Postgres database', null, { embed: queryEmbed });

    expect(reused.id).toBe(postgresId);
    expect(reused.canonical_name).toBe('Postgres');
  });

  it('creates an entity when no name or embedding matches', async () => {
    const created = await resolveEntity('Redis', null, {
      embed: async () => [vec(0, 0, 0, 1)],
    });

    expect(created.canonical_name).toBe('Redis');
    expect(created.id).not.toBe(postgresId);
    expect(created.embedding).not.toBeNull();
  });

  it('reads a BLOB whose byte offset is not float-aligned', () => {
    const source = vec(0.25, -0.5, 1.5);

    expect([...blobToVector(misalignedBlob([...source]))]).toEqual([...source]);
  });
});

describe('retrieve', () => {
  it('returns the single episode inside a high-confidence date range', async () => {
    const result = await retrieve(
      'What did I ask on 3 November?',
      's-main',
      analysisWith({
        resolvedDates: [dateRange('2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z')],
      }),
      {
        embed: async () => {
          throw new Error('date retrieval must not embed');
        },
        select: async () => {
          throw new Error('a single date match must not call the selector');
        },
      },
    );

    expect(result.outcome).toBe('exact');
    expect(result.episodes.map((episode) => episode.id)).toEqual(['ep-vercel']);
    expect(result.claims).toEqual([]);
  });

  it('fuses FTS and vector hits and includes claims for selected entities', async () => {
    const selector = fakeSelector({ selected_ids: ['ep-postgres'], outcome: 'likely' });

    const result = await retrieve('the Postgres thing', 's-main', analysisWith(), {
      embed: queryEmbed,
      select: selector.select,
    });

    expect(result.outcome).toBe('likely');
    expect(result.episodes.map((episode) => episode.id)).toEqual(['ep-postgres']);
    expect(selector.calls).toHaveLength(1);

    const score = result.scores.find((entry) => entry.id === 'ep-postgres');
    expect(score?.vector).toBe(1);
    expect(score?.fts).toBeGreaterThan(0);
    expect(score?.fused).toBeGreaterThan(0.01);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      entity: 'Postgres',
      attribute: 'price',
      verification: 'unverified',
    });
  });

  it('returns multiple when two episodes share a date and the selector does not choose', async () => {
    const selector = fakeSelector({ selected_ids: [], outcome: 'multiple' });

    const result = await retrieve(
      'What happened on 11 November?',
      's-main',
      analysisWith({
        resolvedDates: [dateRange('2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z')],
      }),
      { embed: queryEmbed, select: selector.select },
    );

    expect(result.outcome).toBe('multiple');
    expect(result.episodes.map((episode) => episode.id).sort()).toEqual([
      'ep-neon',
      'ep-supabase',
    ]);
    expect(selector.calls[0]?.candidates).toHaveLength(2);
  });

  it('honours the selector choice for a shared date', async () => {
    const selector = fakeSelector({ selected_ids: ['ep-supabase'], outcome: 'likely' });

    const result = await retrieve(
      'What happened on 11 November?',
      's-main',
      analysisWith({
        resolvedDates: [dateRange('2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z')],
      }),
      { embed: queryEmbed, select: selector.select },
    );

    expect(result.outcome).toBe('likely');
    expect(result.episodes.map((episode) => episode.id)).toEqual(['ep-supabase']);
  });

  it('returns not_found when nothing matches', async () => {
    const result = await retrieve('quantum banana', 's-main', analysisWith(), {
      embed: async () => [vec(0, 0, 0, 0)],
      select: async () => {
        throw new Error('no candidates should reach the selector');
      },
    });

    expect(result).toEqual({
      outcome: 'not_found',
      episodes: [],
      claims: [],
      decisions: [],
      scores: [],
    });
  });

  it('finds an exact FTS term without calling the selector', async () => {
    const result = await retrieve('HubSpot?! *', 's-main', analysisWith(), {
      embed: async () => [vec(0, 0, 1, 0)],
      select: async () => {
        throw new Error('a single obvious match must skip the selector');
      },
    });

    expect(result.outcome).toBe('likely');
    expect(result.episodes.map((episode) => episode.id)).toEqual(['ep-hubspot']);
  });
});
