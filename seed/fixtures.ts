import type { PriceValue } from '../src/domain/pricing.js';

/** The first demo session carries the exact marker title used for idempotency. */
export const DEMO_MARKER_TITLE = 'Demo history';

export type DemoEntityFixture = {
  name: string;
  domain: string;
  aliases: string[];
};

export type DemoClaimFixture = {
  entity: string;
  value: PriceValue;
};

export type DemoSessionFixture = {
  key: string;
  title: string;
  createdAt: string;
  question: string;
  answer: string;
  entities: DemoEntityFixture[];
  claims: DemoClaimFixture[];
  decision?: { topic: string; type: 'shortlist'; entities: string[] };
};

const SEED_HOUR_UTC = 9;

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDay(date: Date): string {
  return DAY_FORMAT.format(date);
}

/** Most recent 3 November at 09:00 UTC that is at or before `now`. */
export function mostRecentNovember3(now: Date): Date {
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), 10, 3, SEED_HOUR_UTC));
  if (candidate.getTime() > now.getTime()) {
    candidate.setUTCFullYear(candidate.getUTCFullYear() - 1);
  }
  return candidate;
}

/** Most recent given weekday (0 = Sunday) strictly before `now`'s UTC calendar day. */
export function lastWeekdayBefore(now: Date, weekday: number): Date {
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, SEED_HOUR_UTC),
  );
  while (cursor.getUTCDay() !== weekday) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor;
}

function monthlyPrice(
  amount: number,
  plan: string,
  mode: PriceValue['mode'],
  unit: string,
): PriceValue {
  return {
    kind: 'price',
    amount,
    currency: 'USD',
    period: 'month',
    mode,
    unit,
    plan,
    region: null,
    conditions: [],
  };
}

export function demoSessionFixtures(now: Date): DemoSessionFixture[] {
  const nov3 = mostRecentNovember3(now);
  const monday = lastWeekdayBefore(now, 1);
  const tuesday = lastWeekdayBefore(now, 2);
  const nov3Iso = nov3.toISOString();
  const mondayIso = monday.toISOString();
  const tuesdayIso = tuesday.toISOString();

  const vercel: DemoEntityFixture = {
    name: 'Vercel',
    domain: 'vercel.com',
    aliases: ['Vercel Inc'],
  };
  const crm: DemoEntityFixture[] = [
    { name: 'HubSpot', domain: 'hubspot.com', aliases: ['HubSpot CRM'] },
    { name: 'Pipedrive', domain: 'pipedrive.com', aliases: ['Pipedrive CRM'] },
    { name: 'Zoho CRM', domain: 'zoho.com', aliases: ['Zoho'] },
    { name: 'Close', domain: 'close.com', aliases: ['Close CRM'] },
    { name: 'Freshsales', domain: 'freshworks.com', aliases: ['Freshworks CRM'] },
  ];
  const postgres: DemoEntityFixture = {
    name: 'Postgres',
    domain: 'postgresql.org',
    aliases: ['PostgreSQL'],
  };
  const hosting: DemoEntityFixture[] = [
    { name: 'Neon', domain: 'neon.com', aliases: ['Neon Postgres'] },
    { name: 'Supabase', domain: 'supabase.com', aliases: [] },
    {
      name: 'Amazon RDS',
      domain: 'aws.amazon.com',
      aliases: ['RDS', 'Amazon Relational Database Service'],
    },
  ];

  return [
    {
      key: 'vercel',
      title: DEMO_MARKER_TITLE,
      createdAt: nov3Iso,
      question: 'What does Vercel Pro cost for a small team?',
      answer:
        `As of ${formatDay(nov3)}, Vercel Pro was $20 per user per month with monthly billing. ` +
        'This is a synthetic demo answer: an unverified assistant statement from that date, not a verified baseline.',
      entities: [vercel],
      claims: [{ entity: 'Vercel', value: monthlyPrice(20, 'Pro', 'per_user', 'user') }],
    },
    {
      key: 'crm',
      title: `${DEMO_MARKER_TITLE} — CRM shortlist`,
      createdAt: mondayIso,
      question: 'Shortlist five CRM tools for a 20-person sales team.',
      answer:
        `On ${formatDay(monday)}, the shortlist for a 20-person sales team was:\n` +
        '- HubSpot — Starter Customer Platform at $20 per user per month\n' +
        '- Pipedrive — Growth at $49 per user per month\n' +
        '- Zoho CRM — Standard at $20 per user per month\n' +
        '- Close — Essentials at $49 per user per month\n' +
        '- Freshsales — Growth at $47 per user per month\n' +
        'These were synthetic, unverified assistant statements from that date, not verified vendor quotes, so they are not a verified price baseline.',
      entities: crm,
      claims: [
        { entity: 'HubSpot', value: monthlyPrice(20, 'Starter Customer Platform', 'per_user', 'user') },
        { entity: 'Pipedrive', value: monthlyPrice(49, 'Growth', 'per_user', 'user') },
        { entity: 'Zoho CRM', value: monthlyPrice(20, 'Standard', 'per_user', 'user') },
        { entity: 'Close', value: monthlyPrice(49, 'Essentials', 'per_user', 'user') },
        { entity: 'Freshsales', value: monthlyPrice(47, 'Growth', 'per_user', 'user') },
      ],
      decision: {
        topic: 'CRM tools for a 20-person sales team',
        type: 'shortlist',
        entities: crm.map((entity) => entity.name),
      },
    },
    {
      key: 'postgres',
      title: `${DEMO_MARKER_TITLE} — Postgres hosting`,
      createdAt: tuesdayIso,
      question: 'Compare Postgres hosting for a small app.',
      answer:
        `On ${formatDay(tuesday)}, the comparison for a small app was:\n` +
        '- Neon — Launch at $19 per month\n' +
        '- Supabase — Pro at $25 per month\n' +
        '- Amazon RDS — db.t4g.micro Single-AZ at $13 per month\n' +
        'These are synthetic, unverified assistant statements from that date, not a verified baseline.',
      entities: [postgres, ...hosting],
      claims: [
        { entity: 'Neon', value: monthlyPrice(19, 'Launch', 'flat', 'account') },
        { entity: 'Supabase', value: monthlyPrice(25, 'Pro', 'flat', 'project') },
        { entity: 'Amazon RDS', value: monthlyPrice(13, 'db.t4g.micro Single-AZ', 'flat', 'instance') },
      ],
    },
  ];
}

