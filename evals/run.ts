import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgeJson } from '../src/graph/schemas.js';
import type {
  Analysis,
  ComparisonRow,
  RetrievalResult,
  TraceEvent,
} from '../src/graph/types.js';
import { scenarios, type ScenarioContext } from './scenarios.js';

if (!process.env.OPENROUTER_API_KEY || !process.env.GOOGLE_API_KEY) {
  console.error('Evals need OPENROUTER_API_KEY and GOOGLE_API_KEY. Live search also needs TAVILY_API_KEY.');
  process.exit(1);
}

const offline = process.argv.includes('--offline');
const liveEnabled = Boolean(process.env.TAVILY_API_KEY) && !offline;

const dir = mkdtempSync(join(tmpdir(), 'since-eval-'));
process.env.DB_PATH = join(dir, 'eval.sqlite');

const { config } = await import('../src/config.js');
const { seedDemo } = await import('../seed/demo.js');
const { demoSessionFixtures } = await import('../seed/fixtures.js');
const { runTurn } = await import('../src/graph/build.js');
const repo = await import('../src/db/repo.js');
const { chatJson } = await import('../src/llm/openrouter.js');
const { JudgeSchema } = await import('../src/graph/schemas.js');

const now = new Date();
const nowIso = now.toISOString();
const fixtures = demoSessionFixtures(now);
const seed = {
  nov3: fixtures.find((fixture) => fixture.key === 'vercel')?.createdAt ?? '',
  monday: fixtures.find((fixture) => fixture.key === 'crm')?.createdAt ?? '',
  tuesday: fixtures.find((fixture) => fixture.key === 'postgres')?.createdAt ?? '',
};

await seedDemo(now);

type Result = {
  id: string;
  category: string;
  live: boolean;
  skipped: boolean;
  failures: string[];
  error: string | null;
  latencyMs: number;
  firstTokenMs: number | null;
  searches: number;
  answer: string;
  judge: JudgeJson | null;
};

const results: Result[] = [];

async function judgeAnswer(
  question: string,
  answer: string,
  ctx: ScenarioContext,
): Promise<JudgeJson | null> {
  try {
    const memory = ctx.recall?.episodes.length
      ? ctx.recall.episodes
          .map(
            (episode, index) =>
              `[m${index + 1}] ${episode.createdAt.slice(0, 10)} Q: ${episode.question}\nA: ${episode.answer}`,
          )
          .join('\n\n')
      : 'none';
    const sources = ctx.sources.length
      ? ctx.sources.map((source) => `[${source.id}] ${source.domain} — ${source.title}`).join('\n')
      : 'none';

    const { data } = await chatJson({
      model: config.models.fast,
      messages: [
        {
          role: 'system',
          content:
            'Grade a chat answer. The context the agent actually had is included. Return JSON with 1-5 scores: answers_question, concise, honest (uncertainty stated, no invented facts), and one short note. Do not penalize recall that is supported by the remembered episodes.',
        },
        {
          role: 'user',
          content: `Context the agent had:\nRemembered episodes:\n${memory}\n\nWeb sources:\n${sources}\n\nQuestion: ${question}\n\nAnswer: ${answer}`,
        },
      ],
      schema: JudgeSchema,
      schemaName: 'since_judge',
      maxTokens: 300,
      reasoning: { enabled: false },
    });
    return data;
  } catch {
    return null;
  }
}

for (const scenario of scenarios) {
  if (scenario.live && !liveEnabled) {
    results.push({
      id: scenario.id,
      category: scenario.category,
      live: true,
      skipped: true,
      failures: [],
      error: null,
      latencyMs: 0,
      firstTokenMs: null,
      searches: 0,
      answer: '',
      judge: null,
    });
    continue;
  }

  const sessionId = `eval-${scenario.id}`;
  repo.createSession({ id: sessionId, title: scenario.id, created_at: nowIso });

  let result: Awaited<ReturnType<typeof runTurn>> | null = null;
  let firstTokenMs: number | null = null;
  let latencyMs = 0;
  let error: string | null = null;

  try {
    for (const message of scenario.messages) {
      const recent = repo.recentTurns(sessionId, 8);
      const turnId = randomUUID();
      repo.createTurn({
        id: turnId,
        session_id: sessionId,
        role: 'user',
        text: message,
        created_at: new Date().toISOString(),
      });

      const started = Date.now();
      result = await runTurn({
        sessionId,
        turnId,
        userText: message,
        now: nowIso,
        timezone: config.timezone,
        recent: recent.map((turn) => ({ role: turn.role, text: turn.text })),
        isSynthetic: false,
        emit: (event) => {
          if (event.type === 'token' && firstTokenMs === null) {
            firstTokenMs = Date.now() - started;
          }
        },
      });
      latencyMs = Date.now() - started;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  if (result === null || error !== null) {
    results.push({
      id: scenario.id,
      category: scenario.category,
      live: scenario.live,
      skipped: false,
      failures: [],
      error: error ?? 'no result',
      latencyMs,
      firstTokenMs,
      searches: 0,
      answer: '',
      judge: null,
    });
    continue;
  }

  const answer = result.draft;
  const analysis = result.analysis as Analysis | null;
  const recall = result.recall as RetrievalResult | null;
  const comparison: ComparisonRow[] = Array.isArray(result.comparison)
    ? result.comparison
    : [];
  const trace: TraceEvent[] = result.trace;
  const sources = result.evidence.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    publishedAt: row.publishedAt,
  }));

  const ctx: ScenarioContext = {
    answer,
    analysis,
    recall,
    comparison,
    sources,
    trace,
    latencyMs,
    firstTokenMs,
    searches: analysis?.searchPlan.length ?? 0,
    seed,
  };

  const failures = scenario.assert(ctx);
  const judge = await judgeAnswer(
    scenario.messages[scenario.messages.length - 1] ?? '',
    answer,
    ctx,
  );

  results.push({
    id: scenario.id,
    category: scenario.category,
    live: scenario.live,
    skipped: false,
    failures,
    error: null,
    latencyMs,
    firstTokenMs,
    searches: ctx.searches,
    answer,
    judge,
  });
}

const passed = results.filter(
  (result) => !result.skipped && result.error === null && result.failures.length === 0,
);
const failed = results.filter(
  (result) => !result.skipped && (result.error !== null || result.failures.length > 0),
);
const skipped = results.filter((result) => result.skipped);

const latencies = passed.map((result) => result.latencyMs).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const judges = results.flatMap((result) => (result.judge ? [result.judge] : []));
const meanJudge = (key: keyof Omit<JudgeJson, 'note'>) =>
  judges.length === 0
    ? 0
    : judges.reduce((sum, judge) => sum + judge[key], 0) / judges.length;

console.log('\nSince eval\n');
console.log(
  'id'.padEnd(22),
  'category'.padEnd(10),
  'status'.padEnd(8),
  'ms'.padStart(6),
  'first'.padStart(6),
  'search'.padStart(6),
  'judge'.padStart(5),
);
for (const result of results) {
  const status = result.skipped
    ? 'SKIP'
    : result.error !== null || result.failures.length > 0
      ? 'FAIL'
      : 'PASS';
  const judge = result.judge
    ? ((result.judge.answers_question + result.judge.concise + result.judge.honest) / 3).toFixed(1)
    : '-';
  console.log(
    result.id.padEnd(22),
    result.category.padEnd(10),
    status.padEnd(8),
    String(result.latencyMs).padStart(6),
    String(result.firstTokenMs ?? '-').padStart(6),
    String(result.searches).padStart(6),
    judge.padStart(5),
  );
  if (result.error) console.log(`  error: ${result.error}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}

console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped. ` +
    `p50 ${p50}ms, p95 ${p95}ms. Judge mean: ${meanJudge('answers_question').toFixed(2)} answers, ` +
    `${meanJudge('concise').toFixed(2)} concise, ${meanJudge('honest').toFixed(2)} honest.`,
);

mkdirSync('evals/results', { recursive: true });
const stamp = nowIso.replace(/[:.]/g, '-');
const report = {
  ranAt: nowIso,
  live: liveEnabled,
  counts: { passed: passed.length, failed: failed.length, skipped: skipped.length },
  latency: { p50, p95 },
  judge: {
    answers: meanJudge('answers_question'),
    concise: meanJudge('concise'),
    honest: meanJudge('honest'),
  },
  results,
};
writeFileSync(join('evals/results', `${stamp}.json`), JSON.stringify(report, null, 2));
console.log(`Report: evals/results/${stamp}.json`);

if (failed.length > 0) process.exitCode = 1;
