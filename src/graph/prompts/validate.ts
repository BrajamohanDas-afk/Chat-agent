import type { ChatMessage, ComparisonRow } from '../types.js';

export type ValidationItem = {
  index: number;
  sentence: string;
  evidence: { id: string; passage: string }[];
};

export function validateMessages(
  items: ValidationItem[],
  comparison: ComparisonRow[],
): ChatMessage[] {
  const system = `You check whether cited evidence supports each sentence in an answer.

Return only JSON matching the schema. For every item, return:
- index: the item's index;
- status: supported only when the passages explicitly state the sentence's factual content; partial when they support part of it; unsupported when they do not;
- reason: one short sentence.

Rules:
- Do not use outside knowledge.
- A number that appears in the passage with a different unit, plan or period does not support the sentence.
- If the sentence says "changed" but the passages show only one value, mark it unsupported, unless it matches a deterministic comparison row below.
- Deterministic comparison rows are authoritative for change statements. A sentence that matches a row is supported even when no single passage contains both the old and new values.
- Be strict: a link existing is not support.`;

  const rows = comparison.length
    ? comparison
        .map(
          (row) =>
            `${row.entity} ${row.attribute}: ${row.verdict}; before ${JSON.stringify(row.before)} (${row.beforeDate ?? 'unknown'}, baselineVerified=${row.baselineVerified}); after ${JSON.stringify(row.after)} (${row.afterDate ?? 'unknown'}); reasons: ${row.reasons.join(', ')}`,
        )
        .join('\n')
    : 'none';

  const body = `Deterministic comparison rows:\n${rows}\n\n${items
    .map(
      (item) =>
        `Item ${item.index}\nSentence: ${item.sentence}\nEvidence:\n${item.evidence
          .map((e) => `[${e.id}] ${e.passage.slice(0, 900)}`)
          .join('\n')}`,
    )
    .join('\n\n---\n\n')}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ];
}
