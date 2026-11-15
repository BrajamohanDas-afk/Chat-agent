import { allEntities, findEntity, upsertEntity, type EntityRow } from '../db/repo.js';
import { embed as realEmbed } from '../llm/embeddings.js';

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export type EntityDeps = {
  /** Injected for tests; defaults to the Gemini embedder. */
  embed?: EmbedFn;
};

const REUSE_THRESHOLD = 0.9;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

/**
 * Copy the bytes into an aligned buffer before reading them as floats: node:sqlite
 * may hand back a Uint8Array whose byteOffset is not a multiple of four.
 */
export function blobToVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % FLOAT_BYTES !== 0) {
    throw new Error(`Embedding blob has ${blob.byteLength} bytes; expected a multiple of 4`);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

async function embedOne(text: string, deps: EntityDeps): Promise<Float32Array> {
  const [vector] = await (deps.embed ?? realEmbed)([text]);
  if (vector === undefined) {
    throw new Error(`Embedding provider returned no vector for ${text}`);
  }
  return vector;
}

/** Alias exact match, then cosine similarity >= 0.9, then a new entity row. */
export async function resolveEntity(
  name: string,
  domainHint: string | null = null,
  deps: EntityDeps = {},
): Promise<EntityRow> {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error('Entity name is required');
  }

  const exact = findEntity(normalized);
  if (exact !== null) return exact;

  const vector = await embedOne(normalized, deps);
  let best: { entity: EntityRow; score: number } | null = null;
  for (const entity of allEntities()) {
    if (entity.embedding === null) continue;
    const score = cosineSimilarity(vector, blobToVector(entity.embedding));
    if (score >= REUSE_THRESHOLD && (best === null || score > best.score)) {
      best = { entity, score };
    }
  }
  if (best !== null) return best.entity;

  return upsertEntity({
    name: normalized,
    domain: domainHint,
    embedding: vectorToBlob(vector),
  });
}
