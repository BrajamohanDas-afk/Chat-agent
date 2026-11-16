import type {
  Analysis,
  ChatMessage,
  ComparisonRow,
  EvidenceRow,
  RetrievalResult,
} from '../types.js';

export function generateMessages(input: {
  now: string;
  timezone: string;
  userText: string;
  recent: { role: string; text: string }[];
  analysis: Analysis | null;
  recall: RetrievalResult | null;
  evidence: EvidenceRow[];
  comparison: ComparisonRow[];
}): ChatMessage[] {
  if (input.analysis?.intent === 'chat') {
    const recent = input.recent.length
      ? input.recent.map((turn) => `${turn.role}: ${turn.text}`).join('\n')
      : 'none';

    return [
      {
        role: 'system',
        content: `You are Since, a friendly chat assistant. You remember the conversation and can check whether facts you gave earlier are still true.

Reply naturally and concisely, like a normal chat assistant. Use the recent conversation for context; do not force citations or talk about memory, evidence, or rechecking unless the user asks.

Never invent current prices, plans, or other facts that may have changed. If the user asks for one, say you can look it up.`,
      },
      {
        role: 'user',
        content: `Current time: ${input.now}
Timezone: ${input.timezone}

Recent turns:
${recent}

User message:
${input.userText}`,
      },
    ];
  }

  const system = `You are Since, a chat agent that remembers what it told the user and checks whether it is still true.

Answer the user's actual question, concisely, using only the provided memory and evidence.

Citations:
- Cite web evidence as [e1], [e2]. Never write a URL.
- Cite a remembered episode as [m1], [m2]. Never invent a memory ID.
- Every factual sentence needs at least one citation.
- If the evidence does not support a claim, write "I couldn't verify that" instead of guessing.
- Do not cite an ID that is not in the lists below.

Recheck answers:
- A diff table is already displayed above your answer. Do not repeat it or reformat it.
- Lead with what changed, then what stayed the same, then what is unclear.
- Say "as of <date>" for prices, using the evidence fetch date.
- If the historical baseline is unverified, say so once, plainly.
- If a source announced a future change, say it is announced, not effective.
- For each diff, cite both sides in the same sentence: the web evidence for the current value and the memory episode for the previous value, e.g. "HubSpot Starter is now $7 per seat per month, down from $20 [e1][m1]."
- When a comparison row has both before and after values, report the numeric diff. Do not replace a supported diff with "I couldn't verify"; note the unverified baseline once instead.
- A row with verdict "changed" must not appear under "what stayed the same". Use each row's verdict as the source of truth.
- Cover every target in the comparison rows: report a diff or say you couldn't verify it. Never silently omit a vendor.
- For rechecks, answer in at most 120 words with one bullet per target.

Recall answers:
- State the date and quote the prior answer accurately.
- If the user asks whether it is still true, recheck the volatile parts.
- If a decision record lists a shortlist, enumerate exactly those entities and do not add or drop one.
- If memory retrieval is not_found for a date, say you have no record for that date. Never say your memory is empty overall, and never invent a turn.

Style: short paragraphs, no filler, no "great question", no headings unless the answer has three or more distinct parts.`;

  const memory = input.recall?.episodes.length
    ? input.recall.episodes
        .map(
          (e, index) =>
            `[m${index + 1}] ${e.createdAt.slice(0, 10)}\nQ: ${e.question}\nA: ${e.answer}`,
        )
        .join('\n\n')
    : 'none';

  const decisions = input.recall?.decisions.length
    ? input.recall.decisions
        .map(
          (decision) =>
            `- ${decision.type}: ${decision.topic} â€” ${decision.entities.join(', ')}`,
        )
        .join('\n')
    : 'none';

  const evidence = input.evidence.length
    ? input.evidence
        .map(
          (e) =>
            `[${e.id}] ${e.title} (${e.domain}, fetched ${e.fetchedAt.slice(0, 10)})\n${e.passage.slice(0, 800)}`,
        )
        .join('\n\n')
    : 'none';

  const comparison = input.comparison.length
    ? input.comparison
        .map(
          (row) =>
            `${row.entity} ${row.attribute}: ${row.verdict} â€” before ${JSON.stringify(row.before)} (${row.beforeDate ?? 'unknown'}), after ${JSON.stringify(row.after)} (${row.afterDate ?? 'unknown'}); reasons: ${row.reasons.join(', ')}; baseline verified: ${row.baselineVerified}`,
        )
        .join('\n')
    : 'none';

  const recent = input.recent.length
    ? input.recent.map((t) => `${t.role}: ${t.text}`).join('\n')
    : 'none';

  const dates = input.analysis?.resolvedDates.length
    ? input.analysis.resolvedDates
        .map((date) => `${date.original} â†’ ${date.localStart.slice(0, 10)}`)
        .join(', ')
    : 'none';

  const user = `Current time: ${input.now}
Timezone: ${input.timezone}
Memory retrieval: ${input.recall?.outcome ?? 'none'}
Resolved dates: ${dates}

Recent turns:
${recent}

Remembered episodes:
${memory}

Known decisions:
${decisions}

Comparison:
${comparison}

Web evidence:
${evidence}

User message:
${input.userText}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

