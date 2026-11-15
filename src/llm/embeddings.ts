import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

const MAX_ATTEMPTS = 3;

export class EmbeddingError extends Error {
  readonly model: string;
  readonly status: number | null;

  constructor(
    message: string,
    model: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EmbeddingError';
    this.model = model;
    this.status = options.status ?? null;
  }
}

export type EmbedDeps = {
  /** Injected for tests; defaults to the real Gemini client. */
  ai?: GoogleGenAI;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

let sdkClient: GoogleGenAI | undefined;

function defaultClient(): GoogleGenAI {
  sdkClient ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  return sdkClient;
}

/** HTTP status from the Google SDK error shapes: status, response.status or code. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return null;
}

function isRetryableError(error: unknown): boolean {
  // Retry the embedding-count/values contract checks too.
  if (error instanceof EmbeddingError) return true;
  const status = statusOf(error);
  if (status !== null) return status === 429 || status >= 500;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    return /fetch failed|network|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket/i.test(
      error.message,
    );
  }
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Embed texts with Gemini. Returns one vector per input, in input order. */
export async function embed(texts: string[], deps: EmbedDeps = {}): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const ai = deps.ai ?? defaultClient();
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const model = config.embedding.model;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      // gemini-embedding-2 treats a `contents` array as one document and returns
      // a single vector. Request one document per call so the result count is exact.
      const responses = await Promise.all(
        texts.map((text) =>
          ai.models.embedContent({
            model,
            contents: [text],
            config: { outputDimensionality: config.embedding.dims },
          }),
        ),
      );

      const vectors: Float32Array[] = [];
      for (const response of responses) {
        const embedding = response.embeddings?.[0];
        if (!embedding?.values || embedding.values.length === 0) {
          throw new EmbeddingError('Embedding response contained no vector values', model);
        }
        vectors.push(Float32Array.from(embedding.values));
      }
      return vectors;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) {
        if (error instanceof EmbeddingError) throw error;
        const status = statusOf(error);
        throw new EmbeddingError(
          `Embedding request failed for model ${model} (status ${status ?? 'unknown'}): ${messageOf(error)}`,
          model,
          { status, cause: error },
        );
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(200 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      if (error instanceof EmbeddingError) throw error;
    }
  }

  throw new EmbeddingError(
    `Embedding request failed after ${MAX_ATTEMPTS} attempts for model ${model}`,
    model,
    { status: statusOf(lastError), cause: lastError },
  );
}
