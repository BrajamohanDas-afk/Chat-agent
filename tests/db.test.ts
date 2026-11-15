import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'since-db-'));
const dbPath = join(dir, 'test.sqlite');
process.env.DB_PATH = dbPath;

const { db, openDb, transaction, enqueue } = await import('../src/db/client.js');
const repo = await import('../src/db/repo.js');

const T0 = '2026-11-03T10:00:00.000Z';
const T1 = '2026-11-14T10:00:00.000Z';

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sqlite ledger', () => {
  it('applies the schema twice without error', () => {
    const second = openDb(dbPath);
    try {
      const tables = second
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));

      for (const table of [
        'sessions',
        'turns',
        'episodes',
        'episodes_fts',
        'entities',
        'claims',
        'decisions',
        'checks',
      ]) {
        expect(tables).toContain(table);
      }

      expect(second.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(second.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
      expect(second.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000);
    } finally {
      second.close();
    }
  });

  it('stores a caller-supplied backdated session timestamp', () => {
    const backdated = '2026-11-03T00:00:00.000Z';
    repo.createSession({ id: 's-backdated', title: '3 November', created_at: backdated });
    expect(repo.getSession('s-backdated')?.created_at).toBe(backdated);
  });

  it('indexes episodes in FTS5 and finds them', () => {
    repo.createSession({ id: 's-fts', title: 'FTS' });
    const userTurn = repo.createTurn({
      id: 't-fts-u',
      session_id: 's-fts',
      role: 'user',
      text: 'What does HubSpot CRM cost?',
      created_at: T0,
    });
    const assistantTurn = repo.createTurn({
      id: 't-fts-a',
      session_id: 's-fts',
      role: 'assistant',
      text: 'It starts at $20 per seat.',
      created_at: T0,
    });
    const episode = repo.insertEpisode({
      id: 'e-fts',
      session_id: 's-fts',
      user_turn_id: userTurn.id,
      assistant_turn_id: assistantTurn.id,
      question: 'What does HubSpot CRM cost?',
      answer: 'HubSpot CRM starts at $20 per seat per month.',
      entities: ['HubSpot'],
      created_at: T0,
    });

    const hits = db
      .prepare(
        `SELECT e.id AS id FROM episodes_fts f
         JOIN episodes e ON e.rowid = f.rowid
         WHERE episodes_fts MATCH ?
         ORDER BY rank`,
      )
      .all('hubspot')
      .map((row) => String(row.id));
    expect(hits).toContain(episode.id);

    expect(repo.allEpisodes().find((e) => e.id === episode.id)?.entities).toEqual(['HubSpot']);
    expect(repo.episodesInRange(T0, '2026-11-15T00:00:00.000Z').map((e) => e.id)).toContain(
      episode.id,
    );
    expect(repo.episodesInRange('2026-11-01T00:00:00.000Z', T0).map((e) => e.id)).not.toContain(
      episode.id,
    );
    expect(repo.recentTurns('s-fts', 8).map((t) => t.id)).toEqual([userTurn.id, assistantTurn.id]);
  });

  it('hides superseded claims from currentClaims but keeps history', () => {
    const entity = repo.upsertEntity({
      name: 'Vercel Probe',
      domain: 'vercel.com',
      aliases: ['Vercel Inc'],
    });
    expect(repo.findEntity('vercel inc')?.id).toBe(entity.id);

    const oldClaim = repo.insertClaim({
      id: 'c-old',
      entity_id: entity.id,
      attribute: 'price',
      value: { amount: 20, currency: 'USD', period: 'month' },
      source_type: 'web_observation',
      verification: 'unverified',
      observed_at: T0,
      created_at: T0,
    });
    const newClaim = repo.insertClaim({
      id: 'c-new',
      entity_id: entity.id,
      attribute: 'price',
      value: { amount: 25, currency: 'USD', period: 'month' },
      source_type: 'web_observation',
      verification: 'verified',
      observed_at: T1,
      created_at: T1,
      supersedes_id: oldClaim.id,
    });

    expect(repo.currentClaims(entity.id).map((c) => c.id)).toEqual([newClaim.id]);

    const chain = repo.supersessionChain(oldClaim.id);
    expect(chain.map((c) => c.id)).toEqual([oldClaim.id, newClaim.id]);
    expect(chain[0]?.value).toEqual({ amount: 20, currency: 'USD', period: 'month' });
  });

  it('returns the existing turn for a duplicate idempotency key', () => {
    repo.createSession({ id: 's-idem', title: 'Idempotency' });
    const first = repo.createTurn({
      id: 't-idem-1',
      session_id: 's-idem',
      role: 'user',
      text: 'Hello',
      idempotency_key: 'key-1',
      created_at: T0,
    });
    const duplicate = repo.createTurn({
      id: 't-idem-2',
      session_id: 's-idem',
      role: 'user',
      text: 'Hello again',
      idempotency_key: 'key-1',
      created_at: T1,
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.text).toBe('Hello');
    expect(repo.getTurn('t-idem-2')).toBeNull();
    expect(repo.recentTurns('s-idem', 10).map((t) => t.id)).toEqual([first.id]);

    repo.updateTurnStatus(first.id, 'completed', JSON.stringify([{ stage: 'persist' }]));
    expect(repo.getTrace(first.id)).toEqual([{ stage: 'persist' }]);
  });

  it('commits or rolls back a transaction as a unit', () => {
    transaction(() => {
      repo.createSession({ id: 's-commit', title: 'Commit' });
    });
    expect(repo.getSession('s-commit')).not.toBeNull();

    expect(() =>
      transaction(() => {
        repo.createSession({ id: 's-rollback', title: 'Rollback' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.getSession('s-rollback')).toBeNull();
  });

  it('serializes jobs per session and keeps the queue alive after failures', async () => {
    const events: string[] = [];
    const slow = enqueue('s-queue', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('slow');
    });
    const failing = enqueue('s-queue', async () => {
      events.push('failing');
      throw new Error('job failed');
    });
    const after = enqueue('s-queue', async () => {
      events.push('after');
      return 'done';
    });

    await expect(failing).rejects.toThrow('job failed');
    await expect(slow).resolves.toBeUndefined();
    await expect(after).resolves.toBe('done');
    expect(events).toEqual(['slow', 'failing', 'after']);
  });

  it('round-trips checks and respects the freshness window', () => {
    const stored = repo.putCheck({
      query: 'HubSpot CRM pricing',
      normalized_query: 'hubspot crm pricing',
      provider: 'tavily',
      results: [{ url: 'https://hubspot.com/pricing' }],
      fetched_at: T1,
      ttl_class: 'price',
    });

    expect(repo.getCheck('hubspot crm pricing', T1)).toMatchObject({
      id: stored.id,
      ttl_class: 'price',
      results: [{ url: 'https://hubspot.com/pricing' }],
    });
    expect(repo.getCheck('hubspot crm pricing', '2026-11-14T10:00:00.001Z')).toBeNull();
  });

  it('round-trips decisions with parsed entity ids', () => {
    repo.createSession({ id: 's-dec', title: 'Decisions' });
    const turn = repo.createTurn({
      id: 't-dec',
      session_id: 's-dec',
      role: 'user',
      text: 'Shortlist CRMs',
      created_at: T0,
    });
    repo.insertDecision({
      id: 'd-1',
      session_id: 's-dec',
      topic: 'CRM',
      type: 'shortlist',
      entity_ids: ['e-hubspot', 'e-pipedrive'],
      source_turn_id: turn.id,
      created_at: T0,
    });

    const decisions = repo.decisionsForSession('s-dec');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: 'd-1',
      type: 'shortlist',
      entity_ids: ['e-hubspot', 'e-pipedrive'],
      is_synthetic: false,
    });
  });
});
