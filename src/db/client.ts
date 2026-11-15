import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

// DB_PATH is read once, when this module loads: tests set process.env.DB_PATH before importing.
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function openDb(path: string = config.dbPath): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const connection = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000, // wait up to 5s for a write lock instead of failing with SQLITE_BUSY
  });
  connection.exec(schema);
  return connection;
}

export const db: DatabaseSync = openDb(config.dbPath);

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}

const queues = new Map<string, Promise<unknown>>();

export function enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(sessionId, next.catch(() => undefined));
  return next;
}
