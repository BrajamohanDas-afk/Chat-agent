import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TurnStateType } from '../src/graph/state.js';

type Repo = typeof import('../src/db/repo.js');
type CompareNode = typeof import('../src/graph/nodes/compare.js').compareNode;

let repo: Repo;
let compareNode: CompareNode;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'since-compare-'));
  process.env.DB_PATH = join(dir, 'test.sqlite');
  repo = await import('../src/db/repo.js');
  ({ compareNode } = await import('../src/graph/nodes/compare.js'));
});

const NOW = '2026-11-14T09:00:00.000Z';
const OLD = '2026-11-03T00:00:00.000Z';

const price = (overrides: Record<string, unknown> = {}) => ({
  kind: 'price',
  amount: 20,
  currency: 'USD',
  period: 'month',
  mode: 'per_user',
  unit: 'user',
  plan: 'Pro',
  region: null,
  conditions: [],
  ...overrides,
});

function stateFor(
  entityName: string,
  observationValue: unknown,
  domain = 'vercel.com',
): TurnStateType {
  return {
    sessionId: 's1',
    turnId: 't1',
    userText: 'Has it changed?',
    now: NOW,
    timezone: 'Asia/Kolkata',
    isSynthetic: false,
    recent: [],
    analysis: {
      intent: 'recheck',
      entities: [{ name: entityName, domain, aliases: [] }],
      dateExpressions: [],
      resolvedDates: [],
      decisions: [],
      attributes: [],
      searchPlan: [],
      needsSearch: true,
      comparisonTargets: [entityName],
    },
    recall: null,
    evidence: [
      {
        id: 'e1',
        url: `https://${domain}/pricing`,
        title: 'Pricing',
        domain,
        snippet: 'price',
        passage: 'price',
        publishedAt: NOW,
        fetchedAt: NOW,
        sourceRank: 3,
      },
    ],
    observations: [
      {
        entity: entityName,
        entityId: null,
        attribute: 'price.pro',
        value: observationValue,
        plan: 'Pro',
        currency: 'USD',
        period: 'month',
        mode: 'per_user',
        unit: 'user',
        conditions: [],
        observedAt: NOW,
        publishedAt: NOW,
        effectiveFrom: null,
        evidenceId: 'e1',
        sourceUrl: `https://${domain}/pricing`,
        sourceType: 'web_observation',
        verification: 'verified',
        confidence: 'high',
      },
    ],
    comparison: [],
    draft: '',
    validation: null,
    repairPasses: 0,
    trace: [],
  };
}

describe('compareNode', () => {
  it('treats the same amount with a different billing unit as a change', async () => {
    const vercel = repo.upsertEntity({ name: 'Vercel', domain: 'vercel.com' });
    repo.insertClaim({
      id: 'c-unit',
      entity_id: vercel.id,
      attribute: 'price.pro',
      value: price(),
      source_type: 'assistant_statement',
      verification: 'unverified',
      observed_at: OLD,
      source_url: null,
      created_at: OLD,
    });

    const result = await compareNode(
      stateFor('Vercel', price({ mode: 'per_workspace', unit: 'workspace' })),
    );

    const rows = Array.isArray(result.comparison) ? result.comparison : [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('changed');
    expect(rows[0]?.reasons).toContain('unit_changed');
    expect(rows[0]?.reasons).toContain('baseline_unverified');
    expect(rows[0]?.baselineVerified).toBe(false);
  });

  it('reports a price increase against a verified baseline', async () => {
    const neon = repo.upsertEntity({ name: 'Neon', domain: 'neon.tech' });
    repo.insertClaim({
      id: 'c-increase',
      entity_id: neon.id,
      attribute: 'price.pro',
      value: price({ amount: 19 }),
      source_type: 'web_observation',
      verification: 'verified',
      observed_at: OLD,
      source_url: 'https://neon.tech/pricing',
      created_at: OLD,
    });

    const result = await compareNode(
      stateFor('Neon', price({ amount: 25 }), 'neon.tech'),
    );

    const rows = Array.isArray(result.comparison) ? result.comparison : [];
    expect(rows[0]?.verdict).toBe('changed');
    expect(rows[0]?.reasons).toContain('price_increased');
    expect(rows[0]?.baselineVerified).toBe(true);
  });

  it('does not invent a baseline when no prior claim exists', async () => {
    const result = await compareNode(stateFor('Supabase', price(), 'supabase.com'));

    const rows = Array.isArray(result.comparison) ? result.comparison : [];
    expect(rows[0]?.verdict).toBe('unclear');
    expect(rows[0]?.reasons).toContain('no_baseline');
    expect(rows[0]?.before).toBeNull();
  });
});

