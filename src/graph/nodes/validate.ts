import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { chatJson } from '../../llm/openrouter.js';
import { validateMessages, type ValidationItem } from '../prompts/validate.js';
import { ValidationSchema } from '../schemas.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, TraceEvent, ValidationResult } from '../types.js';

export type Sentence = { index: number; text: string };

export function splitSentences(text: string): Sentence[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence, index) => ({ index, text: sentence.trim() }))
    .filter((sentence) => sentence.text.length > 0);
}

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

export function citedEvidenceIds(sentence: string): string[] {
  return [...sentence.matchAll(/\[e(\d+)\]/g)].map((match) => `e${match[1]}`);
}

export function hasMemoryCitation(sentence: string): boolean {
  return /\[m\d+\]/.test(sentence);
}

function looksFactual(sentence: string): boolean {
  return /\d|[$€£%]|\b(price|pricing|cost|costs|increased|decreased|announced|discontinued)\b/i.test(
    sentence,
  );
}

export async function validateNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  if (
    state.draft.trim() === '' ||
    state.analysis?.intent === 'smalltalk' ||
    state.analysis?.intent === 'recall'
  ) {
    return {
      validation: { verdicts: [], failed: 0 },
      trace: [
        event(
          'validate',
          state.draft.trim() === '' ? 'empty draft' : `${state.analysis?.intent} (no web claims)`,
          started,
        ),
      ],
    };
  }

  const byId = new Map(state.evidence.map((row) => [row.id, row]));
  const items: ValidationItem[] = [];
  const deterministicallyFailed: number[] = [];

  for (const sentence of splitSentences(state.draft)) {
    const ids = citedEvidenceIds(sentence.text);
    if (ids.length === 0) {
      if (looksFactual(sentence.text) && !hasMemoryCitation(sentence.text)) {
        deterministicallyFailed.push(sentence.index);
      }
      continue;
    }
    const evidence = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => ({ id: row.id, passage: row.passage }));
    if (evidence.length === 0) {
      deterministicallyFailed.push(sentence.index);
      continue;
    }
    items.push({ index: sentence.index, sentence: sentence.text, evidence });
  }

  let verdicts: ValidationResult['verdicts'] = deterministicallyFailed.map((index) => ({
    index,
    status: 'unsupported',
    reason: 'No retrievable evidence supports this sentence.',
  }));

  if (items.length > 0) {
    emit?.({ type: 'status', stage: 'validate', detail: `checking ${items.length} claims` });
    const result = await chatJson({
      model: appConfig.models.fast,
      messages: validateMessages(items),
      schema: ValidationSchema,
      schemaName: 'since_validation',
      maxTokens: 700,
      reasoning: { enabled: false },
    });
    verdicts = verdicts.concat(
      result.data.verdicts.filter((verdict) => items.some((item) => item.index === verdict.index)),
    );
  }

  const failed = verdicts.filter((verdict) => verdict.status !== 'supported').length;
  const verified = verdicts.filter((verdict) => verdict.status === 'supported').length;
  emit?.({ type: 'verification', verified, unverified: failed });

  return {
    validation: { verdicts, failed },
    trace: [event('validate', `${verified} supported; ${failed} failed`, started)],
  };
}
