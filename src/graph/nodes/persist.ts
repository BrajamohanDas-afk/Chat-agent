import { randomUUID } from 'node:crypto';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { transaction } from '../../db/client.js';
import {
  createTurn,
  currentClaims,
  findEntity,
  insertClaim,
  insertDecision,
  insertEpisode,
  updateTurnStatus,
  upsertEntity,
} from '../../db/repo.js';
import { embed } from '../../llm/embeddings.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

function planOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'plan' in value) {
    const plan = (value as { plan?: unknown }).plan;
    return typeof plan === 'string' ? plan : null;
  }
  return null;
}

function samePlan(before: unknown, after: string | null): boolean {
  const plan = planOf(before);
  if (plan === null || after === null) return plan === after;
  return norm(plan) === norm(after);
}

function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export async function persistNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  emit?.({ type: 'status', stage: 'persist', detail: 'writing the ledger' });

  const names = [
    ...new Set(
      [
        ...state.observations.map((observation) => observation.entity),
        ...(state.analysis?.decisions.flatMap((decision) => decision.entities) ?? []),
      ].filter((name) => name.trim() !== ''),
    ),
  ];
  const missing = names.filter((name) => !findEntity(name));

  let vectors: Float32Array[] = [];
  let embeddingNote = 'episode embedded';
  try {
    vectors = await embed([`${state.userText}\n\n${state.draft}`, ...missing]);
  } catch (error) {
    embeddingNote = `embedding failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const episodeVector = vectors[0] ?? null;
  const entityVectors = new Map(
    missing.map((name, index) => [norm(name), vectors[index + 1] ?? null]),
  );

  const entityIds = new Map<string, string>();
  for (const name of names) {
    const found = findEntity(name);
    if (found) {
      entityIds.set(norm(name), found.id);
      continue;
    }
    const vector = entityVectors.get(norm(name)) ?? null;
    const created = upsertEntity({
      name,
      embedding: vector ? vectorBytes(vector) : null,
      aliases: [],
    });
    entityIds.set(norm(name), created.id);
  }

  const assistantTurnId = randomUUID();
  const persistEvent = event('persist', embeddingNote, started);
  const fullTrace = state.trace.concat(persistEvent);

  transaction(() => {
    createTurn({
      id: assistantTurnId,
      session_id: state.sessionId,
      role: 'assistant',
      text: state.draft,
      status: 'completed',
      trace_json: JSON.stringify(fullTrace),
      created_at: state.now,
      isSynthetic: state.isSynthetic,
    });

    insertEpisode({
      id: randomUUID(),
      session_id: state.sessionId,
      user_turn_id: state.turnId,
      assistant_turn_id: assistantTurnId,
      question: state.userText,
      answer: state.draft,
      entities: names,
      embedding: episodeVector ? vectorBytes(episodeVector) : null,
      created_at: state.now,
      isSynthetic: state.isSynthetic,
    });

    for (const observation of state.observations) {
      const entityId = entityIds.get(norm(observation.entity));
      if (!entityId) continue;
      const evidence = state.evidence.find((row) => row.id === observation.evidenceId);
      const previous = currentClaims(entityId).find(
        (claim) =>
          norm(claim.attribute) === norm(observation.attribute) &&
          samePlan(claim.value, observation.plan),
      );
      insertClaim({
        id: randomUUID(),
        entity_id: entityId,
        attribute: observation.attribute,
        value: observation.value,
        source_type: observation.sourceType,
        verification: observation.verification,
        observed_at: observation.observedAt,
        published_at: observation.publishedAt,
        effective_from: observation.effectiveFrom,
        source_url: observation.sourceUrl,
        evidence_id: observation.evidenceId,
        passage: evidence?.passage?.slice(0, 4000) ?? null,
        content_hash: null,
        source_rank: evidence?.sourceRank ?? null,
        supersedes_id: previous?.id ?? null,
        session_id: state.sessionId,
        turn_id: state.turnId,
        is_synthetic: state.isSynthetic,
        created_at: state.now,
      });
    }

    for (const decision of state.analysis?.decisions ?? []) {
      const ids = decision.entities
        .map((name) => entityIds.get(norm(name)) ?? findEntity(name)?.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) continue;
      insertDecision({
        id: randomUUID(),
        session_id: state.sessionId,
        topic: decision.topic,
        type: decision.type,
        entity_ids: ids,
        source_turn_id: state.turnId,
        created_at: state.now,
        isSynthetic: state.isSynthetic,
      });
    }

    updateTurnStatus(state.turnId, 'completed', JSON.stringify(fullTrace));
  });

  emit?.({ type: 'status', stage: 'persist.done', detail: embeddingNote });

  return {
    trace: [persistEvent],
  };
}
