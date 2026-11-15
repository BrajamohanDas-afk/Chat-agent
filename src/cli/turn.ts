import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

const args = process.argv.slice(2);
const scratch = args.includes('--scratch');
const message = args.filter((arg) => arg !== '--scratch').join(' ').trim();

if (!message) {
  console.error('usage: npm run turn -- "question" [--scratch]');
  process.exit(1);
}

if (scratch) {
  process.env.DB_PATH = 'data/scratch.sqlite';
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`data/scratch.sqlite${suffix}`, { force: true });
  }
}

const { config } = await import('../config.js');
const { createSession, createTurn, getSession, recentTurns } = await import('../db/repo.js');
const { runTurn } = await import('../graph/build.js');

const sessionId = 'cli-session';
const now = new Date().toISOString();
if (!getSession(sessionId)) {
  createSession({ id: sessionId, title: 'CLI', created_at: now });
}

const recent = recentTurns(sessionId, 8);
const turnId = randomUUID();
createTurn({
  id: turnId,
  session_id: sessionId,
  role: 'user',
  text: message,
  created_at: now,
});

const result = await runTurn({
  sessionId,
  turnId,
  userText: message,
  now,
  timezone: config.timezone,
  recent: recent.map((turn) => ({ role: turn.role, text: turn.text })),
  isSynthetic: false,
  emit: (event) => {
    if (event.type === 'token') {
      process.stdout.write(event.text);
    } else if (event.type === 'status') {
      process.stderr.write(`[${event.stage}] ${event.detail ?? ''}\n`);
    }
  },
});

process.stdout.write('\n\n--- trace ---\n');
for (const entry of result.trace) {
  process.stdout.write(`${entry.node.padEnd(10)} ${String(entry.ms ?? 0).padStart(6)}ms  ${entry.detail}\n`);
}

if (result.comparison.length > 0) {
  process.stdout.write('\n--- diff ---\n');
  for (const row of result.comparison) {
    process.stdout.write(`${row.entity}: ${row.verdict} (${row.reasons.join(', ')})\n`);
  }
}
