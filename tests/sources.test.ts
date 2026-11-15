import { describe, expect, it } from 'vitest';
import { chooseEvidence, sourceRank, type Observation } from '../src/domain/sources.js';

const observation = (sourceUrl: string, value: unknown): Observation => ({ sourceUrl, value });

describe('sourceRank', () => {
  it('ranks the official domain and its subdomains highest', () => {
    expect(sourceRank('https://vercel.com/pricing', 'vercel.com')).toBe(3);
    expect(sourceRank('https://www.vercel.com/pricing', 'vercel.com')).toBe(3);
    expect(sourceRank('https://pricing.vercel.com/pro', 'vercel.com')).toBe(3);
  });

  it('ranks known press second', () => {
    expect(sourceRank('https://techcrunch.com/2026/11/01/vercel', 'vercel.com')).toBe(2);
    expect(sourceRank('https://www.theverge.com/vercel', 'vercel.com')).toBe(2);
  });

  it('ranks community sites and unknown domains lowest', () => {
    expect(sourceRank('https://www.reddit.com/r/webdev', 'vercel.com')).toBe(1);
    expect(sourceRank('https://news.ycombinator.com/item?id=1', 'vercel.com')).toBe(1);
    expect(sourceRank('https://some-blog.example/vercel', 'vercel.com')).toBe(1);
  });

  it('ranks a vendor page as unknown when no official domain is known', () => {
    expect(sourceRank('https://vercel.com/pricing', null)).toBe(1);
  });
});

describe('chooseEvidence', () => {
  it('prefers an official page over a community page', () => {
    const result = chooseEvidence(
      [
        observation('https://www.reddit.com/r/webdev', 20),
        observation('https://vercel.com/pricing', 20),
      ],
      'vercel.com',
    );

    expect(result.primary?.sourceUrl).toBe('https://vercel.com/pricing');
    expect(result.primary?.rank).toBe(3);
    expect(result.supporting).toHaveLength(1);
    expect(result.supporting[0]?.rank).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.sufficient).toBe(true);
  });

  it('prefers an official page over newer press coverage', () => {
    const result = chooseEvidence(
      [
        {
          ...observation('https://techcrunch.com/2026/11/01/vercel', 20),
          publishedAt: '2026-11-12',
        },
        {
          ...observation('https://vercel.com/pricing', 20),
          publishedAt: '2026-11-01',
        },
      ],
      'vercel.com',
    );

    expect(result.primary?.sourceUrl).toBe('https://vercel.com/pricing');
    expect(result.primary?.rank).toBe(3);
    expect(result.supporting[0]?.rank).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(result.sufficient).toBe(true);
  });

  it('surfaces an official-vs-press disagreement as a conflict', () => {
    const official = observation('https://vercel.com/pricing', 20);
    const press = observation('https://techcrunch.com/2026/11/01/vercel', 25);
    const result = chooseEvidence([press, official], 'vercel.com');

    expect(result.primary?.sourceUrl).toBe(official.sourceUrl);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.map((item) => item.value)).toEqual(expect.arrayContaining([20, 25]));
  });

  it('picks the newest dated page within the highest rank', () => {
    const older = {
      ...observation('https://vercel.com/pricing', 20),
      publishedAt: '2026-11-01',
    };
    const newer = {
      ...observation('https://vercel.com/changelog', 20),
      publishedAt: '2026-11-10',
    };
    const result = chooseEvidence([older, newer], 'vercel.com');

    expect(result.primary?.sourceUrl).toBe(newer.sourceUrl);
    expect(result.conflicts).toEqual([]);
  });

  it('leaves undated pages last and breaks date ties by input order', () => {
    const undated = observation('https://vercel.com/pricing', 20);
    const first = {
      ...observation('https://vercel.com/docs/pricing', 20),
      publishedAt: '2026-11-10',
    };
    const second = {
      ...observation('https://vercel.com/changelog', 20),
      publishedAt: '2026-11-10',
    };
    const result = chooseEvidence([undated, first, second], 'vercel.com');

    expect(result.primary?.sourceUrl).toBe(first.sourceUrl);
  });

  it('marks community-only evidence as insufficient', () => {
    const result = chooseEvidence(
      [observation('https://www.reddit.com/r/webdev', 20)],
      'vercel.com',
    );

    expect(result.primary?.rank).toBe(1);
    expect(result.supporting).toEqual([]);
    expect(result.sufficient).toBe(false);
  });

  it('preserves a conflict between two official pages', () => {
    const result = chooseEvidence(
      [
        observation('https://vercel.com/pricing', 20),
        observation('https://vercel.com/docs/pricing', 25),
      ],
      'vercel.com',
    );

    expect(result.primary?.value).toBe(20);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.map((item) => item.value)).toEqual([20, 25]);
    expect(result.sufficient).toBe(true);
  });

  it('does not report a conflict when the top-ranked pages agree', () => {
    const result = chooseEvidence(
      [
        observation('https://vercel.com/pricing', 20),
        observation('https://vercel.com/docs/pricing', 20),
      ],
      'vercel.com',
    );

    expect(result.conflicts).toEqual([]);
  });

  it('returns an empty choice when there are no observations', () => {
    const result = chooseEvidence([], 'vercel.com');

    expect(result.primary).toBeNull();
    expect(result.supporting).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.sufficient).toBe(false);
  });
});
