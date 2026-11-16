import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStateType } from '../src/graph/state.js';
import type { Analysis } from '../src/graph/types.js';

const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }));

vi.mock('../src/llm/openrouter.js', () => ({ chatJson }));

const dir = mkdtempSync(join(tmpdir(), 'since-analyze-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
const { analyzeNode } = await import('../src/graph/nodes/analyze.js');

beforeEach(() => {
  chatJson.mockReset();
});

function state(userText: string): TurnStateType {
  return {
    sessionId: 's1',
    turnId: 't1',
    userText,
    now: '2026-11-14T09:00:00+05:30',
    timezone: 'Asia/Kolkata',
    isSynthetic: false,
    recent: [],
    analysis: null,
    recall: null,
    evidence: [],
    observations: [],
    comparison: [],
    draft: '',
    validation: null,
    repairPasses: 0,
    trace: [],
  };
}

describe('analyzeNode', () => {
  it('resolves date expressions and keeps a recheck intent', async () => {
    chatJson.mockResolvedValue({
      data: {
        intent: 'recheck',
        entities: [{ name: 'Vercel', domain: 'vercel.com', aliases: [] }],
        date_expressions: ['3 November'],
        decisions: [],
        attributes: [{ entity: 'Vercel', attribute: 'price.pro', volatility: 'price' }],
        search_plan: [
          { query: 'Vercel Pro pricing 2026', entity: 'Vercel', recency_days: null, domains: [] },
        ],
        needs_search: true,
        comparison_targets: ['Vercel'],
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await analyzeNode(state('Is the Vercel price from 3 November still right?'));
    const analysis = result.analysis as Analysis | null;

    expect(analysis?.intent).toBe('recheck');
    expect(analysis?.needsSearch).toBe(true);
    expect(analysis?.resolvedDates[0]?.utcStart).toBe('2026-11-02T18:30:00.000Z');
    expect(analysis?.resolvedDates[0]?.utcEndExclusive).toBe('2026-11-03T18:30:00.000Z');
    expect(analysis?.searchPlan[0]?.query).toContain('Vercel');
  });

  it('answers greetings without a model call', async () => {
    const result = await analyzeNode(state('Hello, who are you?'));

    expect((result.analysis as Analysis | null)?.intent).toBe('chat');
    expect((result.analysis as Analysis | null)?.needsSearch).toBe(false);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('classifies general conversation as chat without searching', async () => {
    chatJson.mockResolvedValue({
      data: {
        intent: 'chat',
        entities: [],
        date_expressions: [],
        decisions: [],
        attributes: [],
        search_plan: [],
        needs_search: false,
        comparison_targets: [],
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await analyzeNode(state('Tell me a joke'));

    expect((result.analysis as Analysis | null)?.intent).toBe('chat');
    expect((result.analysis as Analysis | null)?.needsSearch).toBe(false);
    expect(chatJson).toHaveBeenCalledOnce();
  });

  it('does not treat a greeting with a real question as chat', async () => {
    chatJson.mockResolvedValue({
      data: {
        intent: 'fresh',
        entities: [{ name: 'HubSpot', domain: 'hubspot.com', aliases: [] }],
        date_expressions: [],
        decisions: [],
        attributes: [{ entity: 'HubSpot', attribute: 'price', volatility: 'price' }],
        search_plan: [
          { query: 'HubSpot pricing 2026', entity: 'HubSpot', recency_days: null, domains: [] },
        ],
        needs_search: true,
        comparison_targets: ['HubSpot'],
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await analyzeNode(state('Hello, has HubSpot changed pricing?'));

    expect(chatJson).toHaveBeenCalledOnce();
    expect((result.analysis as Analysis | null)?.intent).toBe('fresh');
  });
});

