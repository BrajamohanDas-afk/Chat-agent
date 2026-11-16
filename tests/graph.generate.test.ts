import { describe, expect, it } from 'vitest';
import { generateMessages } from '../src/graph/prompts/generate.js';
import type { Analysis } from '../src/graph/types.js';

const analysis: Analysis = {
  intent: 'chat',
  entities: [],
  dateExpressions: [],
  resolvedDates: [],
  decisions: [],
  attributes: [],
  searchPlan: [],
  needsSearch: false,
  comparisonTargets: [],
};

const base = {
  now: '2026-11-15T10:00:00.000Z',
  timezone: 'Asia/Kolkata',
  userText: 'Hello',
  recent: [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: 'Hey!' },
  ],
  recall: null,
  evidence: [],
  comparison: [],
};

describe('generateMessages', () => {
  it('uses a natural chat prompt without the evidence rules', () => {
    const messages = generateMessages({ ...base, analysis });

    expect(messages[0]?.content).toContain('friendly chat assistant');
    expect(messages[0]?.content).not.toContain(
      'Every factual sentence needs at least one citation',
    );
    expect(messages[1]?.content).toContain('user: Hi');
  });

  it('keeps the evidence rules for fresh answers', () => {
    const messages = generateMessages({
      ...base,
      userText: 'What does Vercel Pro cost?',
      analysis: { ...analysis, intent: 'fresh', needsSearch: true },
    });

    expect(messages[0]?.content).toContain(
      'Every factual sentence needs at least one citation',
    );
    expect(messages[0]?.content).not.toContain('friendly chat assistant');
  });
});
