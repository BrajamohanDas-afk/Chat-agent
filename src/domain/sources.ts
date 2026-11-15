const PRESS = new Set([
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'arstechnica.com',
  'reuters.com',
  'bloomberg.com',
  'ft.com',
  'cnbc.com',
  'zdnet.com',
  'cnet.com',
]);
const COMMUNITY = new Set([
  'reddit.com',
  'news.ycombinator.com',
  'stackoverflow.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  'g2.com',
  'capterra.com',
  'quora.com',
]);

export type Rank = 0 | 1 | 2 | 3;

export type Observation = {
  sourceUrl: string;
  value: unknown;
  publishedAt?: string | null;
  rank?: Rank;
};

export type EvidenceChoice = {
  primary: Observation | null;
  supporting: Observation[];
  conflicts: Observation[];
  sufficient: boolean;
};

export function sourceRank(url: string, officialDomain: string | null): Rank {
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  const official = officialDomain?.replace(/^www\./, '').toLowerCase() ?? null;
  if (official && (host === official || host.endsWith(`.${official}`))) return 3;
  if (PRESS.has(host)) return 2;
  if (COMMUNITY.has(host)) return 1;
  return 1;
}

function publishedTime(observation: Observation): number | null {
  if (!observation.publishedAt) return null;
  const time = Date.parse(observation.publishedAt);
  return Number.isNaN(time) ? null : time;
}

function newest(observations: Observation[]): Observation | null {
  let best: Observation | null = null;
  let bestTime: number | null = null;
  for (const observation of observations) {
    const time = publishedTime(observation);
    if (best === null || (time !== null && (bestTime === null || time > bestTime))) {
      best = observation;
      bestTime = time;
    }
  }
  return best;
}

export function chooseEvidence(
  observations: Observation[],
  officialDomain: string | null,
): EvidenceChoice {
  const ranked = observations.map((observation) => ({
    ...observation,
    rank: sourceRank(observation.sourceUrl, officialDomain),
  }));
  const max = Math.max(0, ...ranked.map((observation) => observation.rank));
  const top = ranked.filter((observation) => observation.rank === max);
  const reliable = ranked.filter((observation) => observation.rank >= 2);
  const byValue = new Map<string, Observation>();
  for (const observation of reliable) {
    const key = JSON.stringify(observation.value);
    if (!byValue.has(key)) byValue.set(key, observation);
  }
  return {
    primary: newest(top),
    supporting: ranked.filter((observation) => observation.rank < max),
    conflicts: byValue.size > 1 ? [...byValue.values()] : [],
    sufficient: reliable.length > 0,
  };
}
