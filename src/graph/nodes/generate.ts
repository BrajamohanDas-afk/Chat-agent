import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { chatStream } from '../../llm/openrouter.js';
import { generateMessages } from '../prompts/generate.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

export async function generateNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  emit?.({ type: 'status', stage: 'generate', detail: 'writing the answer' });

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let draft = '';

  const stream = chatStream({
    model: appConfig.models.strong,
    messages: generateMessages({
      now: state.now,
      timezone: state.timezone,
      userText: state.userText,
      recent: state.recent.slice(-4).map((turn) => ({
        role: turn.role,
        text: turn.text.slice(0, 500),
      })),
      analysis: state.analysis,
      recall: state.recall,
      evidence: state.evidence,
      comparison: state.comparison,
    }),
    maxTokens: 900,
    onUsage: (next) => {
      usage.promptTokens = next.promptTokens;
      usage.completionTokens = next.completionTokens;
      usage.totalTokens = next.totalTokens;
    },
  });

  for await (const token of stream) {
    draft += token;
    emit?.({ type: 'token', text: token });
  }

  return {
    draft,
    trace: [
      event(
        'generate',
        `${draft.split(/\s+/).length} words; ${usage.totalTokens} tokens`,
        started,
      ),
    ],
  };
}
