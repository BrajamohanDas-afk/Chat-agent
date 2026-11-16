import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { config as appConfig } from '../../config.js';
import { chatJson } from '../../llm/openrouter.js';
import { validateMessages, type ValidationItem } from '../prompts/validate.js';
import { ValidationSchema } from '../schemas.js';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { ComparisonRow, Emit, TraceEvent, ValidationResult } from '../types.js';

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

function looksFactual(sentence: string): boolean {
  return /\d|[$€£%]|\b(price|pricing|cost|costs|increased|decreased|announced|discontinued)\b/i.test(
    sentence,
  );
}

function amountOf(value: unknown): number | null {
  if (typeof value === 'object' && value !== null && 'amount' in value) {
    const amount = (value as { amount?: unknown }).amount;
    return typeof amount === 'number' ? amount : null;
  }
  return null;
}

/**
 * A sentence that states a diff the comparison engine computed is supported by
 * that row, even if no single passage contains both values. This is the whole
 * point of computing the diff deterministically.
 */
function matchesComparison(sentence: string, rows: ComparisonRow[]): boolean {
  const text = sentence.toLowerCase();
  return rows.some((row) => {
    if (row.verdict === 'unclear' || row.before === null || row.after === null) return false;
    const before = amountOf(row.before);
    const after = amountOf(row.after);
    if (before === null || after === null) return false;
    return (
      text.includes(row.entity.toLowerCase()) &&
      text.includes(String(after)) &&
      (text.includes(String(before)) || /(down|up) from|now|unchanged/.test(text))
    );
  });
}

export async function validateNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);

  if (
    state.draft.trim() === '' ||
    state.analysis?.intent === 'chat' ||
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
  const memoryById = new Map(
    (state.recall?.episodes ?? []).map((episode, index) => [
      `m${index + 1}`,
      `${episode.question}\n${episode.answer}`,
    ]),
  );
  const items: ValidationItem[] = [];
  const deterministicallyFailed: number[] = [];
  const comparisonSupported: number[] = [];

  for (const sentence of splitSentences(state.draft)) {
    if (matchesComparison(sentence.text, state.comparison)) {
      comparisonSupported.push(sentence.index);
      continue;
    }

    const evidenceIds = citedEvidenceIds(sentence.text);
    const memoryIds = [...sentence.text.matchAll(/\[m(\d+)\]/g)].map((match) => `m${match[1]}`);

    if (evidenceIds.length === 0 && memoryIds.length === 0) {
      if (looksFactual(sentence.text)) {
        deterministicallyFailed.push(sentence.index);
      }
      continue;
    }

    const evidence = evidenceIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => ({ id: row.id, passage: row.passage }));

    // A recheck sentence often cites the old value from memory ([m1]) and the
    // new value from the web ([e1]). The validator must see both sides.
    for (const id of memoryIds) {
      const passage = memoryById.get(id);
      if (passage) evidence.push({ id, passage });
    }

    if (evidence.length === 0) {
      deterministicallyFailed.push(sentence.index);
      continue;
    }
    items.push({ index: sentence.index, sentence: sentence.text, evidence });
  }

  let verdicts: ValidationResult['verdicts'] = [
    ...comparisonSupported.map((index) => ({
      index,
      status: 'supported' as const,
      reason: 'Matches a deterministic comparison row.',
    })),
    ...deterministicallyFailed.map((index) => ({
      index,
      status: 'unsupported' as const,
      reason: 'No retrievable evidence supports this sentence.',
    })),
  ];

  if (items.length > 0) {
    emit?.({ type: 'status', stage: 'validate', detail: `checking ${items.length} claims` });
    const result = await chatJson({
      model: appConfig.models.fast,
      messages: validateMessages(items, state.comparison),
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
