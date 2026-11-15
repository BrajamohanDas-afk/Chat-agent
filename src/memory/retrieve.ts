import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  allEntities,
  allEpisodes,
  currentClaims,
  decisionsForSession,
  episodesInRange,
  findEntity,
  type ClaimRow,
  type EpisodeRow,
} from '../db/repo.js';
import type {
  Analysis,
  ClaimHit,
  DateRange,
  DecisionHit,
  EpisodeHit,
  RetrievalOutcome,
  RetrievalResult,
} from '../graph/types.js';
import { embed as realEmbed } from '../llm/embeddings.js';
import { chatJson } from '../llm/openrouter.js';
import { blobToVector, cosineSimilarity, type EmbedFn } from './entities.js';

const CANDIDATE_LIMIT = 20;
const SELECTOR_LIMIT = 10;
const RRF_K = 60;
const MIN_FUSED = 0.01;

export const RetrievalSelectionSchema = z.strictObject({
  selected_ids: z.array(z.string()),
  outcome: z.enum(['exact', 'likely', 'multiple']),
});

export type RetrievalSelection = z.infer<typeof RetrievalSelectionSchema>;

export type SelectorCandidate = {
  id: string;
  date: string;
  question: string;
  entities: string[];
};

export type SelectorInput = {
  query: string;
  candidates: SelectorCandidate[];
};

export type Selector = (input: SelectorInput) => Promise<RetrievalSelection>;

export type RetrievalDeps = {
  /** Injected for tests; defaults to the Gemini embedder. */
  embed?: EmbedFn;
  /** Injected for tests; defaults to a haiku call over the top candidates. */
  select?: Selector;
};

const SELECTOR_SYSTEM = `You select which prior conversation episodes answer the user's question.
Return only JSON matching the schema: selected_ids (ids from the candidate list, best first) and outcome.
Use outcome "exact" when one episode directly answers, "likely" when one is the best match but the wording is loose, and "multiple" when several episodes fit and the user must disambiguate.
Never invent ids. Do not answer the question yourself.`;

async function haikuSelect(input: SelectorInput): Promise<RetrievalSelection> {
  const { data } = await chatJson({
    model: config.models.fast,
    schema: RetrievalSelectionSchema,
    schemaName: 'retrieval_selection',
    maxTokens: 400,
    messages: [
      { role: 'system', content: SELECTOR_SYSTEM },
      { role: 'user', content: JSON.stringify(input) },
    ],
  });
  return data;
}

function emptyResult(outcome: RetrievalOutcome): RetrievalResult {
  return { outcome, episodes: [], claims: [], decisions: [], scores: [] };
}

function toEpisodeHit(episode: EpisodeRow): EpisodeHit {
  return {
    id: episode.id,
    createdAt: episode.created_at,
    question: episode.question,
    answer: episode.answer,
    entities: episode.entities,
    isSynthetic: episode.is_synthetic,
  };
}

function toCandidate(episode: EpisodeRow): SelectorCandidate {
  return {
    id: episode.id,
    date: episode.created_at,
    question: episode.question,
    entities: episode.entities,
  };
}

function toClaimHit(claim: ClaimRow, entity: string): ClaimHit {
  return {
    id: claim.id,
    entity,
    attribute: claim.attribute,
    value: claim.value,
    observedAt: claim.observed_at,
    publishedAt: claim.published_at,
    effectiveFrom: claim.effective_from,
    verification: claim.verification,
    sourceUrl: claim.source_url,
    sourceRank: claim.source_rank,
  };
}

/** Current claims for every entity named by the selected episodes. */
function claimHits(episodes: EpisodeRow[]): ClaimHit[] {
  const entities = new Map<string, string>();
  for (const episode of episodes) {
    for (const name of episode.entities) {
      const entity = findEntity(name);
      if (entity !== null) entities.set(entity.id, entity.canonical_name);
    }
  }

  const seen = new Set<string>();
  const claims: ClaimHit[] = [];
  for (const [entityId, entityName] of entities) {
    for (const claim of currentClaims(entityId)) {
      if (seen.has(claim.id)) continue;
      seen.add(claim.id);
      claims.push(toClaimHit(claim, entityName));
    }
  }
  return claims;
}

/** Explicit shortlists/decisions attached to the selected episodes' sessions. */
function decisionHits(episodes: EpisodeRow[], query: string): DecisionHit[] {
  if (episodes.length === 0) return [];
  const wantsDecision = /shortlist|shortlisted|decide|decided|choice|selected|picked/i.test(query);
  const sessions = new Set(episodes.map((episode) => episode.session_id));
  const names = new Map(allEntities().map((entity) => [entity.id, entity.canonical_name]));
  const lowerQuery = query.toLowerCase();
  const hits: DecisionHit[] = [];

  for (const sessionId of sessions) {
    for (const decision of decisionsForSession(sessionId)) {
      const topicMatch = decision.topic
        .toLowerCase()
        .split(/\s+/)
        .some((word) => word.length > 4 && lowerQuery.includes(word));
      if (!wantsDecision && !topicMatch) continue;
      hits.push({
        id: decision.id,
        topic: decision.topic,
        type: decision.type,
        entities: decision.entity_ids.map((id) => names.get(id) ?? id),
      });
    }
  }

  return hits.slice(0, 3);
}

async function selectEpisodes(
  query: string,
  candidates: EpisodeRow[],
  deps: RetrievalDeps,
  singleOutcome: RetrievalOutcome,
): Promise<{ episodes: EpisodeRow[]; outcome: RetrievalOutcome }> {
  if (candidates.length === 1) {
    return { episodes: candidates, outcome: singleOutcome };
  }

  const visible = candidates.slice(0, SELECTOR_LIMIT);
  const selection = await (deps.select ?? haikuSelect)({
    query,
    candidates: visible.map(toCandidate),
  });

  const visibleIds = new Set(visible.map((episode) => episode.id));
  const unknown = selection.selected_ids.filter((id) => !visibleIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`Selector returned unknown episode ids: ${unknown.join(', ')}`);
  }

  const selectedIds = new Set(selection.selected_ids);
  const selected = visible.filter((episode) => selectedIds.has(episode.id));
  if (selection.outcome === 'multiple') {
    return { episodes: selected.length > 0 ? selected : visible, outcome: 'multiple' };
  }
  if (selected.length === 0) {
    // A selector saying "exact" but naming nothing means no usable memory.
    // This is a fresh-question path, not a fatal error.
    return { episodes: [], outcome: 'not_found' };
  }
  return { episodes: selected, outcome: selection.outcome };
}

/** 1-based BM25 positions; quoted terms keep FTS operators in the query from parsing. */
function ftsRanks(query: string): Map<string, number> {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (terms.length === 0) return new Map();

  const match = terms.map((term) => `"${term}"`).join(' OR ');
  const rows = db
    .prepare(
      `SELECT e.id AS id FROM episodes_fts f
       JOIN episodes e ON e.rowid = f.rowid
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, CANDIDATE_LIMIT);
  return new Map(rows.map((row, index) => [String(row.id), index + 1]));
}

/** 1-based cosine positions, limited to positive similarity. */
async function vectorRanks(
  query: string,
  episodes: EpisodeRow[],
  deps: RetrievalDeps,
): Promise<Map<string, number>> {
  const embedded = episodes.flatMap((episode) =>
    episode.embedding === null ? [] : [{ id: episode.id, embedding: episode.embedding }],
  );
  if (embedded.length === 0) return new Map();

  const [queryVector] = await (deps.embed ?? realEmbed)([query]);
  if (queryVector === undefined) {
    throw new Error('Embedding provider returned no vector for the query');
  }

  return new Map(
    embedded
      .map((episode) => ({
        id: episode.id,
        score: cosineSimilarity(queryVector, blobToVector(episode.embedding)),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_LIMIT)
      .map((hit, index) => [hit.id, index + 1]),
  );
}

async function dateRetrieve(
  query: string,
  range: DateRange,
  deps: RetrievalDeps,
): Promise<RetrievalResult> {
  const matches = episodesInRange(range.utcStart, range.utcEndExclusive);
  if (matches.length === 0) return emptyResult('not_found');

  const { episodes, outcome } = await selectEpisodes(query, matches, deps, 'exact');
  return {
    outcome,
    episodes: episodes.map(toEpisodeHit),
    claims: claimHits(episodes),
    decisions: decisionHits(episodes, query),
    scores: matches.map((episode) => ({ id: episode.id, fts: 0, vector: 0, fused: 1 })),
  };
}

async function hybridRetrieve(query: string, deps: RetrievalDeps): Promise<RetrievalResult> {
  const episodes = allEpisodes();
  if (episodes.length === 0) return emptyResult('not_found');

  const fts = ftsRanks(query);
  const vector = await vectorRanks(query, episodes, deps);
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));

  const candidates = [...new Set([...fts.keys(), ...vector.keys()])]
    .flatMap((id) => {
      const episode = byId.get(id);
      if (episode === undefined) return [];
      const ftsRank = fts.get(id) ?? 0;
      const vectorRank = vector.get(id) ?? 0;
      const fused =
        (ftsRank > 0 ? 1 / (RRF_K + ftsRank) : 0) +
        (vectorRank > 0 ? 1 / (RRF_K + vectorRank) : 0);
      return [{ episode, score: { id, fts: ftsRank, vector: vectorRank, fused } }];
    })
    .filter((candidate) => candidate.score.fused > MIN_FUSED)
    .sort((a, b) => b.score.fused - a.score.fused);

  if (candidates.length === 0) return emptyResult('not_found');

  const { episodes: selected, outcome } = await selectEpisodes(
    query,
    candidates.map((candidate) => candidate.episode),
    deps,
    'likely',
  );

  return {
    outcome,
    episodes: selected.map(toEpisodeHit),
    claims: claimHits(selected),
    decisions: decisionHits(selected, query),
    scores: candidates.map((candidate) => candidate.score),
  };
}

/**
 * `sessionId` is accepted for the recall node's call shape; history recall spans
 * sessions, so it does not filter the candidate set.
 */
export async function retrieve(
  query: string,
  sessionId: string,
  analysis: Analysis,
  deps: RetrievalDeps = {},
): Promise<RetrievalResult> {
  // A recall question with a date should filter by that date even when the
  // expression is a bare weekday (medium confidence); "Monday" in the past tense
  // means the most recent one, which resolveDate already computed.
  const dated =
    analysis.resolvedDates.find((range) => range.confidence === 'high') ??
    (analysis.intent === 'recall' ? analysis.resolvedDates[0] : undefined);
  if (dated !== undefined) return dateRetrieve(query, dated, deps);
  return hybridRetrieve(query, deps);
}

