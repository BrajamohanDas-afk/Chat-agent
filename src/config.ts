import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const required = ['OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'GOOGLE_API_KEY'] as const;

export function assertEnv(): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in.',
    );
  }
}

export const config = {
  models: {
    fast: process.env.FAST_MODEL ?? 'anthropic/claude-haiku-5.5',
    strong: process.env.STRONG_MODEL ?? 'anthropic/claude-sonnet-5.5',
  },
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-2',
    dims: 1536,
  },
  caps: {
    parallelSearches: 8,
    searchBudgetMs: 6_000,
    callerTimeoutMs: 8_000,
    refinementCalls: 3,
    modelRetries: 2,
    repairPasses: 1,
  },
  ttlMs: {
    price: 10 * 60_000,
    feature: 24 * 60 * 60_000,
    stable: 30 * 24 * 60 * 60_000,
  },
  timezone: process.env.USER_TIMEZONE ?? 'Asia/Kolkata',
  dbPath: process.env.DB_PATH ?? 'data/since.sqlite',
  port: Number(process.env.PORT ?? 3000),
} as const;

export function ensureDbDir(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  if (!existsSync(dirname(config.dbPath))) {
    throw new Error(`Cannot create database directory for ${config.dbPath}`);
  }
}
