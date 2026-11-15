import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { splitSentences } from './validate.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

const UNVERIFIED = "I couldn't verify that from the sources I found.";

/**
 * Deterministic repair: replace each failed sentence with an explicit
 * unverified line. No second model call, no chance of inventing new facts.
 */
export async function repairNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  const failed = new Set(
    (state.validation?.verdicts ?? [])
      .filter((verdict) => verdict.status !== 'supported')
      .map((verdict) => verdict.index),
  );

  const sentences = splitSentences(state.draft);
  const kept = sentences
    .filter((sentence) => !failed.has(sentence.index))
    .map((sentence) => sentence.text);
  const repaired =
    kept.length === 0 ? UNVERIFIED : `${kept.join(' ')}${failed.size > 0 ? ` ${UNVERIFIED}` : ''}`;

  emit?.({ type: 'status', stage: 'repair', detail: `${failed.size} claims replaced` });
  emit?.({ type: 'patch', text: repaired });

  return {
    draft: repaired,
    repairPasses: state.repairPasses + 1,
    validation: null,
    trace: [event('repair', `${failed.size} sentences marked unverified`, started)],
  };
}
