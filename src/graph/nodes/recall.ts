import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { retrieve } from '../../memory/retrieve.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

export async function recallNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  if (!state.analysis || state.analysis.intent === 'smalltalk') {
    return { recall: null, trace: [event('recall', 'skipped', started)] };
  }

  emit?.({ type: 'status', stage: 'recall', detail: 'searching memory' });
  const recall = await retrieve(state.userText, state.sessionId, state.analysis);

  emit?.({
    type: 'status',
    stage: 'recall.done',
    detail: `${recall.outcome} · ${recall.episodes.length} episodes · ${recall.claims.length} claims`,
  });

  return {
    recall,
    trace: [
      event(
        'recall',
        `${recall.outcome}; ${recall.episodes.length} episodes; ${recall.claims.length} claims`,
        started,
      ),
    ],
  };
}
