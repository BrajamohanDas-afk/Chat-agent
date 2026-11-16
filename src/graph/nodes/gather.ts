import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, EvidenceRow, RetrievalResult, TraceEvent } from '../types.js';
import { recallNode } from './recall.js';
import { researchNode } from './research.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

/**
 * Run memory recall and web research concurrently, then join once.
 * LangGraph's multi-edge fan-in can execute the downstream chain twice when the
 * branches finish in different supersteps; this node makes the join deterministic.
 */
export async function gatherNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  const tasks: Promise<TurnStateUpdate>[] = [];

  if (state.analysis?.intent !== 'chat') tasks.push(recallNode(state, config));
  if (state.analysis?.needsSearch) tasks.push(researchNode(state, config));

  const results = await Promise.all(tasks);
  let recall: RetrievalResult | null = null;
  const evidence: EvidenceRow[] = [];
  const trace: TraceEvent[] = [];

  for (const result of results) {
    if (result.recall !== undefined) recall = result.recall as RetrievalResult | null;
    if (result.evidence !== undefined) evidence.push(...(result.evidence as EvidenceRow[]));
    if (result.trace !== undefined) trace.push(...(result.trace as TraceEvent[]));
  }

  emit?.({
    type: 'status',
    stage: 'gather.done',
    detail: `${recall?.outcome ?? 'no recall'} · ${evidence.length} sources`,
  });

  return {
    recall,
    evidence,
    trace: trace.concat({
      at: new Date().toISOString(),
      node: 'gather',
      detail: `${recall?.outcome ?? 'no recall'}; ${evidence.length} sources`,
      ms: Date.now() - started,
    }),
  };
}
