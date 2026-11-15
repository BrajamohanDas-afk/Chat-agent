import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'since-seed-'));
process.env.DB_PATH = join(dir, 'test.sqlite');

const { db } = await import('../src/db/client.js');
const repo = await import('../src/db/repo.js');
const { seedDemo } = await import('../seed/demo.js');

/** Saturday 14 November 2026, 09:00 in the default user timezone. */
const NOW = new Date('2026-11-14T09:00:00+05:30');

const TABLES = ['sessions', 'turns', 'episodes', 'entities', 'claims', 'decisions'] as const;

function rowCounts(): Record<string, number> {
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1),
    ]),
  );
}

function countWhere(table: string, sessionId: string): number {
  return Number(
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)?.n ?? -1,
  );
}

let sessionIds: string[] = [];

beforeAll(async () => {
  ({ sessionIds } = await seedDemo(NOW));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('seedDemo', () => {
  it('creates three synthetic sessions and labels every history row', () => {
    expect(sessionIds).toHaveLength(3);
    expect(repo.listSessions()).toHaveLength(3);
    expect(repo.listSessions().map((session) => session.is_synthetic)).toEqual([true, true, true]);

    for (const table of ['turns', 'episodes', 'decisions'] as const) {
      const rows = db.prepare(`SELECT is_synthetic FROM ${table}`).all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.is_synthetic === 1)).toBe(true);
    }
  });

  it('links exactly five entities in the CRM shortlist decision', () => {
    const crm = repo.listSessions().find((session) => session.title.includes('CRM shortlist'));
    expect(crm).toBeDefined();

    const decisions = repo.decisionsForSession(crm!.id);
    expect(decisions).toHaveLength(1);
    const [decision] = decisions;
    expect(decision?.type).toBe('shortlist');
    expect(decision?.is_synthetic).toBe(true);
    expect(decision?.entity_ids).toHaveLength(5);
    expect(new Set(decision?.entity_ids).size).toBe(5);

    const names = repo
      .allEntities()
      .filter((entity) => decision?.entity_ids.includes(entity.id))
      .map((entity) => entity.canonical_name)
      .sort();
    expect(names).toEqual(['Close', 'Freshsales', 'HubSpot', 'Pipedrive', 'Zoho CRM']);

    const answer = repo.allEpisodes().find((episode) => episode.session_id === crm!.id)?.answer;
    for (const name of names) {
      expect(answer).toContain(name);
    }
    expect(countWhere('claims', crm!.id)).toBe(5);
  });

  it('marks every old claim as an unverified assistant statement', () => {
    const claims = db
      .prepare('SELECT source_type, verification, effective_from, is_synthetic FROM claims')
      .all();
    expect(claims).toHaveLength(9);
    for (const claim of claims) {
      expect(claim.source_type).toBe('assistant_statement');
      expect(claim.verification).toBe('unverified');
      expect(claim.effective_from).toBeNull();
      expect(claim.is_synthetic).toBe(1);
    }
  });

  it('is idempotent: a second run returns the same ids and writes nothing', async () => {
    const before = rowCounts();

    const again = await seedDemo(NOW);

    expect(again.sessionIds).toEqual(sessionIds);
    expect(rowCounts()).toEqual(before);
  });

  it('dates every session in the past and uses 3 Nov, last Monday and last Tuesday', () => {
    const byTitle = new Map(repo.listSessions().map((session) => [session.title, session]));

    expect(byTitle.get('Demo history')?.created_at).toBe('2026-11-03T09:00:00.000Z');
    expect(byTitle.get('Demo history — CRM shortlist')?.created_at).toBe(
      '2026-11-09T09:00:00.000Z',
    );
    expect(byTitle.get('Demo history — Postgres hosting')?.created_at).toBe(
      '2026-11-10T09:00:00.000Z',
    );

    for (const session of repo.listSessions()) {
      expect(Date.parse(session.created_at)).toBeLessThan(NOW.getTime());
    }
    for (const table of ['turns', 'episodes', 'entities', 'claims', 'decisions'] as const) {
      const rows = db.prepare(`SELECT created_at FROM ${table}`).all();
      for (const row of rows) {
        expect(Date.parse(String(row.created_at))).toBeLessThan(NOW.getTime());
      }
    }
  });
});
