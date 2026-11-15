import { pathToFileURL } from 'node:url';
import { db, transaction } from '../src/db/client.js';
import {
  createSession,
  createTurn,
  findEntity,
  insertClaim,
  insertDecision,
  insertEpisode,
  listSessions,
  upsertEntity,
} from '../src/db/repo.js';
import {
  DEMO_MARKER_TITLE,
  demoSessionFixtures,
  type DemoSessionFixture,
} from './fixtures.js';

export type SeedDemoResult = { sessionIds: string[] };

function isDemoSession(title: string): boolean {
  return title === DEMO_MARKER_TITLE || title.startsWith(`${DEMO_MARKER_TITLE} —`);
}

function existingDemoIds(): string[] {
  return listSessions()
    .filter((session) => isDemoSession(session.title))
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) || left.title.localeCompare(right.title),
    )
    .map((session) => session.id);
}

function writeSession(fixture: DemoSessionFixture, entityIds: Map<string, string>): string {
  const sessionId = `demo-${fixture.key}`;
  createSession({
    id: sessionId,
    title: fixture.title,
    created_at: fixture.createdAt,
    isSynthetic: true,
  });

  const userTurnId = `${sessionId}-user`;
  createTurn({
    id: userTurnId,
    session_id: sessionId,
    role: 'user',
    text: fixture.question,
    created_at: fixture.createdAt,
    isSynthetic: true,
  });
  const assistantTurnId = `${sessionId}-assistant`;
  createTurn({
    id: assistantTurnId,
    session_id: sessionId,
    role: 'assistant',
    text: fixture.answer,
    created_at: fixture.createdAt,
    isSynthetic: true,
  });

  insertEpisode({
    id: `${sessionId}-episode`,
    session_id: sessionId,
    user_turn_id: userTurnId,
    assistant_turn_id: assistantTurnId,
    question: fixture.question,
    answer: fixture.answer,
    entities: fixture.entities.map((entity) => entity.name),
    created_at: fixture.createdAt,
    isSynthetic: true,
  });

  fixture.claims.forEach((claim, index) => {
    const entityId = entityIds.get(claim.entity);
    if (entityId === undefined) {
      throw new Error(`Demo claim references an unknown entity: ${claim.entity}`);
    }
    insertClaim({
      id: `${sessionId}-claim-${index}`,
      entity_id: entityId,
      attribute: 'price',
      value: claim.value,
      source_type: 'assistant_statement',
      verification: 'unverified',
      observed_at: fixture.createdAt,
      session_id: sessionId,
      turn_id: assistantTurnId,
      is_synthetic: true,
      created_at: fixture.createdAt,
    });
  });

  if (fixture.decision) {
    const decision = fixture.decision;
    insertDecision({
      id: `${sessionId}-decision`,
      session_id: sessionId,
      topic: decision.topic,
      type: decision.type,
      entity_ids: decision.entities.map((name) => {
        const entityId = entityIds.get(name);
        if (entityId === undefined) {
          throw new Error(`Demo decision references an unknown entity: ${name}`);
        }
        return entityId;
      }),
      source_turn_id: userTurnId,
      created_at: fixture.createdAt,
      isSynthetic: true,
    });
  }

  return sessionId;
}

/**
 * Seed the labeled demo history once. A second call finds the `Demo history` marker
 * session and returns the existing ids without writing anything.
 */
export async function seedDemo(now: Date = new Date()): Promise<SeedDemoResult> {
  return transaction(() => {
    const existing = existingDemoIds();
    if (existing.length > 0) {
      return { sessionIds: existing };
    }

    const fixtures = demoSessionFixtures(now);
    const entityIds = new Map<string, string>();
    for (const fixture of fixtures) {
      for (const entity of fixture.entities) {
        const existed = findEntity(entity.name) !== null;
        const row = upsertEntity({
          name: entity.name,
          domain: entity.domain,
          aliases: entity.aliases,
        });
        // upsertEntity stamps created_at with now; a brand-new demo entity gets the session date.
        if (!existed) {
          db.prepare('UPDATE entities SET created_at = ? WHERE id = ?').run(
            fixture.createdAt,
            row.id,
          );
        }
        entityIds.set(entity.name, row.id);
      }
    }

    const created = fixtures
      .map((fixture) => ({ fixture, id: writeSession(fixture, entityIds) }))
      .sort(
        (left, right) =>
          left.fixture.createdAt.localeCompare(right.fixture.createdAt) ||
          left.fixture.title.localeCompare(right.fixture.title),
      );

    return { sessionIds: created.map((entry) => entry.id) };
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sessionIds } = await seedDemo();
  console.log(`Demo history ready: ${sessionIds.length} sessions (${sessionIds.join(', ')}).`);
}
