import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStateType } from '../src/graph/state.js';
import type { Analysis } from '../src/graph/types.js';

const { chatTools, executeWebSearch } = vi.hoisted(() => ({
  chatTools: vi.fn(),
  executeWebSearch: vi.fn(),
}));

vi.mock('../src/llm/openrouter.js', () => ({ chatTools }));
vi.mock('../src/search/tool.js', () => ({
  executeWebSearch,
  webSearchTool: {
    type: 'function',
    function: { name: 'web_search', description: '', parameters: {} },
  },
}));
vi.mock('../src/search/db-cache.js', () => ({ dbCacheStore: {} }));

const { researchNode } = await import('../src/graph/nodes/research.js');

function state(analysis: Analysis): TurnStateType {
  return {
    sessionId: 's1',
    turnId: 't1',
    userText: 'What is X?',
    now: '2026-11-15T00:00:00.000Z',
    timezone: 'UTC',
    isSynthetic: false,
    recent: [],
    analysis,
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

const analysis: Analysis = {
  intent: 'fresh',
  entities: [],
  dateExpressions: [],
  resolvedDates: [],
  decisions: [],
  attributes: [],
  searchPlan: [{ query: 'X pricing', entity: null, recencyDays: null, domains: [] }],
  needsSearch: true,
  comparisonTargets: [],
};

describe('researchNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chatTools.mockReset();
    executeWebSearch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a search that outlives the six-second budget', async () => {
    let aborted = false;
    executeWebSearch.mockImplementation(
      (_args: unknown, deps: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          deps.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );

    const pending = researchNode(state(analysis));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(aborted).toBe(true);
    expect(result.evidence).toEqual([]);
    expect(result.trace).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('1 timed out') }),
    ]);
  });
});
