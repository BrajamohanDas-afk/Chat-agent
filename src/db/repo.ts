import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { db } from './client.js';

export type ChatRole = 'user' | 'assistant';
export type TurnStatus = 'pending' | 'completed' | 'failed';
export type SourceType = 'user_statement' | 'assistant_statement' | 'web_observation';
export type Verification = 'unverified' | 'verified' | 'disputed' | 'inaccessible';
export type DecisionType = 'shortlist' | 'selection' | 'rejection' | 'preference';
export type TtlClass = 'price' | 'feature' | 'stable';

const CHAT_ROLES: readonly ChatRole[] = ['user', 'assistant'];
const TURN_STATUSES: readonly TurnStatus[] = ['pending', 'completed', 'failed'];
const SOURCE_TYPES: readonly SourceType[] = [
  'user_statement',
  'assistant_statement',
  'web_observation',
];
const VERIFICATIONS: readonly Verification[] = [
  'unverified',
  'verified',
  'disputed',
  'inaccessible',
];
const DECISION_TYPES: readonly DecisionType[] = ['shortlist', 'selection', 'rejection', 'preference'];
const TTL_CLASSES: readonly TtlClass[] = ['price', 'feature', 'stable'];

export type SessionRow = {
  id: string;
  title: string;
  created_at: string;
  is_synthetic: boolean;
};

export type TurnRow = {
  id: string;
  session_id: string;
  role: ChatRole;
  text: string;
  status: TurnStatus;
  idempotency_key: string | null;
  trace_json: string | null;
  created_at: string;
  is_synthetic: boolean;
};

export type EpisodeRow = {
  id: string;
  session_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
  question: string;
  answer: string;
  entities: string[];
  embedding: Uint8Array | null;
  created_at: string;
  is_synthetic: boolean;
};

export type EntityRow = {
  id: string;
  canonical_name: string;
  domain: string | null;
  aliases: string[];
  embedding: Uint8Array | null;
  created_at: string;
};

export type ClaimRow = {
  id: string;
  entity_id: string;
  attribute: string;
  value: unknown;
  source_type: SourceType;
  verification: Verification;
  observed_at: string;
  published_at: string | null;
  effective_from: string | null;
  source_url: string | null;
  evidence_id: string | null;
  passage: string | null;
  content_hash: string | null;
  source_rank: number | null;
  supersedes_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  is_synthetic: boolean;
  created_at: string;
};

export type DecisionRow = {
  id: string;
  session_id: string;
  topic: string;
  type: DecisionType;
  entity_ids: string[];
  source_turn_id: string;
  created_at: string;
  is_synthetic: boolean;
};

export type CheckRow = {
  id: string;
  query: string;
  normalized_query: string;
  provider: string;
  results: unknown;
  fetched_at: string;
  ttl_class: TtlClass;
};

export type NewSession = {
  id: string;
  title: string;
  created_at?: string;
  isSynthetic?: boolean;
};

export type NewTurn = {
  id: string;
  session_id: string;
  role: ChatRole;
  text: string;
  status?: TurnStatus;
  idempotency_key?: string | null;
  trace_json?: string | null;
  created_at: string;
  isSynthetic?: boolean;
};

export type NewEpisode = {
  id: string;
  session_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
  question: string;
  answer: string;
  entities?: string[];
  embedding?: Uint8Array | null;
  created_at: string;
  isSynthetic?: boolean;
};

export type NewEntity = {
  name: string;
  domain?: string | null;
  aliases?: string[];
  embedding?: Uint8Array | null;
};

export type NewClaim = {
  id: string;
  entity_id: string;
  attribute: string;
  value: unknown;
  source_type: SourceType;
  verification: Verification;
  observed_at: string;
  published_at?: string | null;
  effective_from?: string | null;
  source_url?: string | null;
  evidence_id?: string | null;
  passage?: string | null;
  content_hash?: string | null;
  source_rank?: number | null;
  supersedes_id?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  is_synthetic?: boolean;
  created_at: string;
};

export type NewDecision = {
  id: string;
  session_id: string;
  topic: string;
  type: DecisionType;
  entity_ids: string[];
  source_turn_id: string;
  created_at: string;
  isSynthetic?: boolean;
};

export type NewCheck = {
  query: string;
  normalized_query: string;
  provider: string;
  results: unknown;
  fetched_at: string;
  ttl_class: TtlClass;
};

type RawRow = Record<string, SQLOutputValue>;

function text(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected a TEXT column, got ${typeof value}`);
  }
  return value;
}

function textOrNull(value: SQLOutputValue | undefined): string | null {
  if (value === null) {
    return null;
  }
  return text(value);
}

function integer(value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number') {
    throw new Error(`Expected an INTEGER column, got ${typeof value}`);
  }
  return value;
}

function integerOrNull(value: SQLOutputValue | undefined): number | null {
  if (value === null) {
    return null;
  }
  return integer(value);
}

function blobOrNull(value: SQLOutputValue | undefined): Uint8Array | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new Error(`Expected a BLOB column, got ${typeof value}`);
}

function oneOf<T extends string>(
  value: SQLOutputValue | undefined,
  allowed: readonly T[],
  field: string,
): T {
  const raw = text(value);
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Unexpected ${field}: ${raw}`);
  }
  return raw as T;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${field}`, { cause: error });
  }
}

function parseStringArray(value: string, field: string): string[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${field} is not a JSON string array`);
  }
  return parsed;
}

function toSession(row: RawRow): SessionRow {
  return {
    id: text(row.id),
    title: text(row.title),
    created_at: text(row.created_at),
    is_synthetic: integer(row.is_synthetic) !== 0,
  };
}

function toTurn(row: RawRow): TurnRow {
  return {
    id: text(row.id),
    session_id: text(row.session_id),
    role: oneOf(row.role, CHAT_ROLES, 'turns.role'),
    text: text(row.text),
    status: oneOf(row.status, TURN_STATUSES, 'turns.status'),
    idempotency_key: textOrNull(row.idempotency_key),
    trace_json: textOrNull(row.trace_json),
    created_at: text(row.created_at),
    is_synthetic: integer(row.is_synthetic) !== 0,
  };
}

function toEpisode(row: RawRow): EpisodeRow {
  return {
    id: text(row.id),
    session_id: text(row.session_id),
    user_turn_id: text(row.user_turn_id),
    assistant_turn_id: text(row.assistant_turn_id),
    question: text(row.question),
    answer: text(row.answer),
    entities: parseStringArray(text(row.entities_json), 'episodes.entities_json'),
    embedding: blobOrNull(row.embedding),
    created_at: text(row.created_at),
    is_synthetic: integer(row.is_synthetic) !== 0,
  };
}

function toEntity(row: RawRow): EntityRow {
  return {
    id: text(row.id),
    canonical_name: text(row.canonical_name),
    domain: textOrNull(row.domain),
    aliases: parseStringArray(text(row.aliases_json), 'entities.aliases_json'),
    embedding: blobOrNull(row.embedding),
    created_at: text(row.created_at),
  };
}

function toClaim(row: RawRow): ClaimRow {
  return {
    id: text(row.id),
    entity_id: text(row.entity_id),
    attribute: text(row.attribute),
    value: parseJson(text(row.value_json), 'claims.value_json'),
    source_type: oneOf(row.source_type, SOURCE_TYPES, 'claims.source_type'),
    verification: oneOf(row.verification, VERIFICATIONS, 'claims.verification'),
    observed_at: text(row.observed_at),
    published_at: textOrNull(row.published_at),
    effective_from: textOrNull(row.effective_from),
    source_url: textOrNull(row.source_url),
    evidence_id: textOrNull(row.evidence_id),
    passage: textOrNull(row.passage),
    content_hash: textOrNull(row.content_hash),
    source_rank: integerOrNull(row.source_rank),
    supersedes_id: textOrNull(row.supersedes_id),
    session_id: textOrNull(row.session_id),
    turn_id: textOrNull(row.turn_id),
    is_synthetic: integer(row.is_synthetic) !== 0,
    created_at: text(row.created_at),
  };
}

function toDecision(row: RawRow): DecisionRow {
  return {
    id: text(row.id),
    session_id: text(row.session_id),
    topic: text(row.topic),
    type: oneOf(row.type, DECISION_TYPES, 'decisions.type'),
    entity_ids: parseStringArray(text(row.entity_ids_json), 'decisions.entity_ids_json'),
    source_turn_id: text(row.source_turn_id),
    created_at: text(row.created_at),
    is_synthetic: integer(row.is_synthetic) !== 0,
  };
}

function toCheck(row: RawRow): CheckRow {
  return {
    id: text(row.id),
    query: text(row.query),
    normalized_query: text(row.normalized_query),
    provider: text(row.provider),
    results: parseJson(text(row.results_json), 'checks.results_json'),
    fetched_at: text(row.fetched_at),
    ttl_class: oneOf(row.ttl_class, TTL_CLASSES, 'checks.ttl_class'),
  };
}

export function createSession(input: NewSession): SessionRow {
  db.prepare(
    'INSERT INTO sessions (id, title, created_at, is_synthetic) VALUES (?, ?, ?, ?)',
  ).run(input.id, input.title, input.created_at ?? new Date().toISOString(), input.isSynthetic ? 1 : 0);
  return getSession(input.id)!;
}

export function getSession(id: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? toSession(row) : null;
}

export function listSessions(): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC')
    .all()
    .map(toSession);
}

export function createTurn(input: NewTurn): TurnRow {
  if (input.idempotency_key) {
    const existing = findTurnByIdempotencyKey(input.idempotency_key);
    if (existing) {
      return existing;
    }
  }
  db.prepare(
    `INSERT INTO turns (id, session_id, role, text, status, idempotency_key, trace_json, created_at, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.session_id,
    input.role,
    input.text,
    input.status ?? 'completed',
    input.idempotency_key ?? null,
    input.trace_json ?? null,
    input.created_at,
    input.isSynthetic ? 1 : 0,
  );
  return getTurn(input.id)!;
}

export function updateTurnStatus(id: string, status: TurnStatus, traceJson?: string): void {
  const result = db
    .prepare('UPDATE turns SET status = ?, trace_json = COALESCE(?, trace_json) WHERE id = ?')
    .run(status, traceJson ?? null, id);
  if (result.changes === 0) {
    throw new Error(`Turn not found: ${id}`);
  }
}

export function getTurn(id: string): TurnRow | null {
  const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
  return row ? toTurn(row) : null;
}

function findTurnByIdempotencyKey(key: string): TurnRow | null {
  const row = db.prepare('SELECT * FROM turns WHERE idempotency_key = ?').get(key);
  return row ? toTurn(row) : null;
}

/** Last `limit` turns in chronological order, ready for prompt context. */
export function recentTurns(sessionId: string, limit: number): TurnRow[] {
  return db
    .prepare(
      'SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(sessionId, limit)
    .reverse()
    .map(toTurn);
}

export function insertEpisode(input: NewEpisode): EpisodeRow {
  db.prepare(
    `INSERT INTO episodes (id, session_id, user_turn_id, assistant_turn_id, question, answer, entities_json, embedding, created_at, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.session_id,
    input.user_turn_id,
    input.assistant_turn_id,
    input.question,
    input.answer,
    JSON.stringify(input.entities ?? []),
    input.embedding ?? null,
    input.created_at,
    input.isSynthetic ? 1 : 0,
  );
  return getEpisode(input.id)!;
}

function getEpisode(id: string): EpisodeRow | null {
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  return row ? toEpisode(row) : null;
}

/** Episodes with `created_at` in the half-open interval [utcStart, utcEndExclusive). */
export function episodesInRange(utcStart: string, utcEndExclusive: string): EpisodeRow[] {
  return db
    .prepare(
      'SELECT * FROM episodes WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(utcStart, utcEndExclusive)
    .map(toEpisode);
}

export function allEpisodes(): EpisodeRow[] {
  return db
    .prepare('SELECT * FROM episodes ORDER BY created_at ASC, rowid ASC')
    .all()
    .map(toEpisode);
}

export function upsertEntity(input: NewEntity): EntityRow {
  const existing = findEntity(input.name);
  if (existing) {
    const aliases = [...new Set([...existing.aliases, ...(input.aliases ?? [])])];
    db.prepare(
      `UPDATE entities
       SET domain = COALESCE(?, domain), aliases_json = ?, embedding = COALESCE(?, embedding)
       WHERE id = ?`,
    ).run(input.domain ?? null, JSON.stringify(aliases), input.embedding ?? null, existing.id);
    return findEntity(input.name)!;
  }
  db.prepare(
    'INSERT INTO entities (id, canonical_name, domain, aliases_json, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    input.name,
    input.domain ?? null,
    JSON.stringify(input.aliases ?? []),
    input.embedding ?? null,
    new Date().toISOString(),
  );
  return findEntity(input.name)!;
}

export function findEntity(name: string): EntityRow | null {
  const row = db
    .prepare(
      `SELECT * FROM entities
       WHERE lower(canonical_name) = lower(?1)
          OR EXISTS (SELECT 1 FROM json_each(entities.aliases_json) WHERE lower(value) = lower(?1))
       ORDER BY (lower(canonical_name) = lower(?1)) DESC, created_at ASC
       LIMIT 1`,
    )
    .get(name);
  return row ? toEntity(row) : null;
}

export function allEntities(): EntityRow[] {
  return db
    .prepare('SELECT * FROM entities ORDER BY canonical_name COLLATE NOCASE ASC')
    .all()
    .map(toEntity);
}

export function insertClaim(input: NewClaim): ClaimRow {
  if (input.value === undefined) {
    throw new Error(`Claim ${input.id} has no value`);
  }
  db.prepare(
    `INSERT INTO claims (
       id, entity_id, attribute, value_json, source_type, verification, observed_at, published_at,
       effective_from, source_url, evidence_id, passage, content_hash, source_rank, supersedes_id,
       session_id, turn_id, is_synthetic, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.entity_id,
    input.attribute,
    JSON.stringify(input.value),
    input.source_type,
    input.verification,
    input.observed_at,
    input.published_at ?? null,
    input.effective_from ?? null,
    input.source_url ?? null,
    input.evidence_id ?? null,
    input.passage ?? null,
    input.content_hash ?? null,
    input.source_rank ?? null,
    input.supersedes_id ?? null,
    input.session_id ?? null,
    input.turn_id ?? null,
    input.is_synthetic ? 1 : 0,
    input.created_at,
  );
  return getClaim(input.id)!;
}

function getClaim(id: string): ClaimRow | null {
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  return row ? toClaim(row) : null;
}

/** Chain heads for an entity: every claim no other claim supersedes. */
export function currentClaims(entityId: string): ClaimRow[] {
  return db
    .prepare(
      `SELECT c.* FROM claims c
       WHERE c.entity_id = ?
         AND NOT EXISTS (SELECT 1 FROM claims n WHERE n.supersedes_id = c.id)
       ORDER BY c.observed_at DESC, c.rowid DESC`,
    )
    .all(entityId)
    .map(toClaim);
}

/** The whole supersession chain containing `claimId`, oldest first. */
export function supersessionChain(claimId: string): ClaimRow[] {
  return db
    .prepare(
      `WITH RECURSIVE
         ancestors(id) AS (
           SELECT id FROM claims WHERE id = ?
           UNION
           SELECT c.supersedes_id FROM claims c JOIN ancestors a ON c.id = a.id
           WHERE c.supersedes_id IS NOT NULL
         ),
         descendants(id) AS (
           SELECT id FROM claims WHERE id = ?
           UNION
           SELECT c.id FROM claims c JOIN descendants d ON c.supersedes_id = d.id
         )
       SELECT * FROM claims
       WHERE id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)
       ORDER BY observed_at ASC, rowid ASC`,
    )
    .all(claimId, claimId)
    .map(toClaim);
}

export function insertDecision(input: NewDecision): DecisionRow {
  db.prepare(
    `INSERT INTO decisions (id, session_id, topic, type, entity_ids_json, source_turn_id, created_at, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.session_id,
    input.topic,
    input.type,
    JSON.stringify(input.entity_ids),
    input.source_turn_id,
    input.created_at,
    input.isSynthetic ? 1 : 0,
  );
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(input.id);
  if (!row) {
    throw new Error(`Decision not found after insert: ${input.id}`);
  }
  return toDecision(row);
}

export function decisionsForSession(sessionId: string): DecisionRow[] {
  return db
    .prepare('SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(sessionId)
    .map(toDecision);
}

/** Newest check for this query fetched at or after `sinceIso`, if any. */
export function getCheck(normalizedQuery: string, sinceIso: string): CheckRow | null {
  const row = db
    .prepare(
      `SELECT * FROM checks
       WHERE normalized_query = ? AND fetched_at >= ?
       ORDER BY fetched_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(normalizedQuery, sinceIso);
  return row ? toCheck(row) : null;
}

export function putCheck(input: NewCheck): CheckRow {
  if (input.results === undefined) {
    throw new Error('Check results are required');
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO checks (id, query, normalized_query, provider, results_json, fetched_at, ttl_class)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.query,
    input.normalized_query,
    input.provider,
    JSON.stringify(input.results),
    input.fetched_at,
    input.ttl_class,
  );
  const row = db.prepare('SELECT * FROM checks WHERE id = ?').get(id);
  if (!row) {
    throw new Error(`Check not found after insert: ${id}`);
  }
  return toCheck(row);
}

export function getTrace(turnId: string): unknown[] | null {
  const row = db.prepare('SELECT trace_json FROM turns WHERE id = ?').get(turnId);
  if (!row) {
    return null;
  }
  const trace = textOrNull(row.trace_json);
  if (trace === null) {
    return null;
  }
  const parsed = parseJson(trace, `turns.trace_json for ${turnId}`);
  if (!Array.isArray(parsed)) {
    throw new Error(`Trace for turn ${turnId} is not a JSON array`);
  }
  return parsed;
}
