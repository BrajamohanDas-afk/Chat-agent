import type {
  Analysis,
  ComparisonRow,
  RetrievalResult,
  TraceEvent,
} from '../src/graph/types.js';

export type SourceRef = {
  id: string;
  url: string;
  title: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
};

export type ScenarioContext = {
  answer: string;
  analysis: Analysis | null;
  recall: RetrievalResult | null;
  comparison: ComparisonRow[];
  sources: SourceRef[];
  trace: TraceEvent[];
  latencyMs: number;
  firstTokenMs: number | null;
  searches: number;
  seed: { nov3: string; monday: string; tuesday: string };
};

export type Scenario = {
  id: string;
  category: string;
  messages: string[];
  live: boolean;
  assert: (ctx: ScenarioContext) => string[];
};

const CRM = ['HubSpot', 'Pipedrive', 'Zoho CRM', 'Close', 'Freshsales'];

function citations(answer: string): string[] {
  return [...answer.matchAll(/\[e(\d+)\]/g)].map((match) => `e${match[1]}`);
}

function citationCheck(ctx: ScenarioContext): string[] {
  const ids = citations(ctx.answer);
  if (ids.length === 0) return ['no evidence citation'];
  const available = new Set(ctx.sources.map((source) => source.id));
  const missing = ids.filter((id) => !available.has(id));
  return missing.length > 0 ? [`citations not in sources: ${missing.join(', ')}`] : [];
}

function mentions(ctx: ScenarioContext, names: string[]): string[] {
  const lower = ctx.answer.toLowerCase();
  const missing = names.filter((name) => !lower.includes(name.toLowerCase()));
  return missing.length > 0 ? [`missing entities: ${missing.join(', ')}`] : [];
}

function abstains(ctx: ScenarioContext): string[] {
  return /no record|don'?t have|haven'?t|nothing (remembered|about)|couldn'?t verify|could not verify|not (available|found)/i.test(
    ctx.answer,
  )
    ? []
    : ['did not abstain'];
}

function hasAsOf(ctx: ScenarioContext): string[] {
  if (/as of|checked|on \d{1,2}\s+\w+|november \d{1,2}/i.test(ctx.answer)) return [];
  // The UI footer renders the fetch timestamp; the eval checks the same evidence.
  return ctx.sources.some((source) => source.fetchedAt.length > 0) ? [] : ['no as-of date'];
}

function citedOrAbstained(ctx: ScenarioContext): string[] {
  if (citationCheck(ctx).length === 0) return [];
  if (abstains(ctx).length === 0) return [];
  return ['neither a citation nor an explicit abstention'];
}

function verdict(ctx: ScenarioContext, entity: string, expected: ComparisonRow['verdict']): string[] {
  const row = ctx.comparison.find((item) =>
    item.entity.toLowerCase().includes(entity.toLowerCase()),
  );
  if (!row) return [`${entity}: no comparison row`];
  return row.verdict === expected
    ? []
    : [`${entity}: expected ${expected}, got ${row.verdict} (${row.reasons.join(', ')})`];
}

function dateContains(ctx: ScenarioContext, key: 'nov3' | 'monday' | 'tuesday'): string[] {
  const range = ctx.analysis?.resolvedDates[0];
  if (!range) return ['no resolved date'];
  const target = ctx.seed[key];
  return target >= range.utcStart && target < range.utcEndExclusive
    ? []
    : [`${key} (${target}) not inside ${range.utcStart}..${range.utcEndExclusive}`];
}

function all(groups: string[][]): string[] {
  return groups.flat();
}

export const scenarios: Scenario[] = [
  {
    id: 'recall-nov3',
    category: 'recall',
    messages: ['What did I ask you on 3 November?'],
    live: false,
    assert: (ctx) =>
      all([
        mentions(ctx, ['Vercel']),
        ctx.analysis?.intent === 'recall' ? [] : [`intent ${ctx.analysis?.intent}, expected recall`],
        ctx.analysis?.needsSearch === false ? [] : ['recall turn triggered a web search'],
      ]),
  },
  {
    id: 'recall-monday',
    category: 'recall',
    messages: ['What did we shortlist last Monday?'],
    live: false,
    assert: (ctx) =>
      all([
        mentions(ctx, CRM),
        ctx.recall?.decisions.length ? [] : ['no decision record retrieved'],
      ]),
  },
  {
    id: 'recall-last-tuesday',
    category: 'recall',
    messages: ['What did I ask you last Tuesday?'],
    live: false,
    assert: (ctx) => mentions(ctx, ['Postgres', 'Neon']),
  },
  {
    id: 'missing-history',
    category: 'honesty',
    messages: ['What did I ask you on 12 October?'],
    live: false,
    assert: (ctx) => abstains(ctx),
  },
  {
    id: 'date-nov3',
    category: 'dates',
    messages: ['What did I ask you on 3 November?'],
    live: false,
    assert: (ctx) => dateContains(ctx, 'nov3'),
  },
  {
    id: 'date-last-tuesday',
    category: 'dates',
    messages: ['What did I ask you last Tuesday?'],
    live: false,
    assert: (ctx) => dateContains(ctx, 'tuesday'),
  },
  {
    id: 'chat-greeting',
    category: 'chat',
    messages: ['Hello'],
    live: false,
    assert: (ctx) =>
      all([
        ctx.analysis?.intent === 'chat' ? [] : [`intent ${ctx.analysis?.intent}`],
        ctx.searches === 0 ? [] : [`${ctx.searches} searches on chat`],
        ctx.answer.length < 600 ? [] : ['chat answer too long'],
      ]),
  },
  {
    id: 'chat-general',
    category: 'chat',
    messages: ['How are you?'],
    live: false,
    assert: (ctx) =>
      all([
        ctx.analysis?.intent === 'chat' ? [] : [`intent ${ctx.analysis?.intent}`],
        ctx.searches === 0 ? [] : [`${ctx.searches} searches on chat`],
        /recheck|remembered answers|web evidence/i.test(ctx.answer)
          ? ['canned evidence reply']
          : [],
      ]),
  },
  {
    id: 'synthetic-label',
    category: 'honesty',
    messages: ['What did I ask you on 3 November?'],
    live: false,
    assert: (ctx) => {
      const episodes = ctx.recall?.episodes ?? [];
      if (episodes.length === 0) return ['no recalled episode'];
      const real = episodes.filter((episode) => !episode.isSynthetic);
      return real.length === 0 ? [] : [`${real.length} non-synthetic episodes mixed in`];
    },
  },
  {
    id: 'followup',
    category: 'recall',
    messages: ['What did I ask you on 3 November?', 'And what did that answer say?'],
    live: false,
    assert: (ctx) => all([mentions(ctx, ['Vercel']), mentions(ctx, ['20'])]),
  },
  {
    id: 'no-fabrication',
    category: 'honesty',
    messages: ['What did I ask you on 3 November about Kubernetes?'],
    live: false,
    assert: (ctx) =>
      // Only an affirmative claim of a 3 Nov conversation is fabrication; a
      // conditional "if you asked about Kubernetes..." is a correct denial.
      /(^|[.!?]\s+)(on 3 november( 2026)?,? )?you asked (me )?about kubernetes/i.test(
        ctx.answer,
      )
        ? ['fabricated a Kubernetes conversation']
        : [],
  },
  {
    id: 'crm-recheck',
    category: 'recheck',
    messages: [
      'Last Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    ],
    live: true,
    assert: (ctx) =>
      all([
        citationCheck(ctx),
        hasAsOf(ctx),
        ctx.comparison.length >= 3 ? [] : [`only ${ctx.comparison.length} comparison rows`],
        mentions(ctx, CRM.slice(0, 3)),
      ]),
  },
  {
    id: 'postgres-recheck',
    category: 'recheck',
    messages: ['Has Neon changed pricing since last Tuesday?'],
    live: true,
    assert: (ctx) =>
      all([
        citedOrAbstained(ctx),
        hasAsOf(ctx),
        ctx.comparison.some((row) => row.entity.includes('Neon'))
          ? []
          : ['no Neon comparison row'],
      ]),
  },
  {
    id: 'fresh-hubspot',
    category: 'fresh',
    messages: ["What is HubSpot's current Starter price?"],
    live: true,
    assert: (ctx) => all([citationCheck(ctx), hasAsOf(ctx)]),
  },
  {
    id: 'unverified-baseline',
    category: 'honesty',
    messages: ['Is your answer from 3 November still correct?'],
    live: true,
    assert: (ctx) => {
      const row = ctx.comparison.find((item) => item.entity === 'Vercel');
      if (!row) return abstains(ctx);
      return row.baselineVerified ? ['presented the unverified seed as a verified baseline'] : [];
    },
  },
  {
    id: 'citation-support',
    category: 'evidence',
    messages: ['What is the current price of Vercel Pro?'],
    live: true,
    assert: (ctx) => all([citedOrAbstained(ctx), hasAsOf(ctx)]),
  },
];
