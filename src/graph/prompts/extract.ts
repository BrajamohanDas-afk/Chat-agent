import type { ChatMessage, EvidenceRow } from '../types.js';

export function extractMessages(input: { now: string; evidence: EvidenceRow[] }): ChatMessage[] {
  const system = `You extract factual observations from web evidence for a claim ledger.

Return only JSON matching the provided schema. One observation per entity, attribute and plan.

Rules:
- Use only what the passage states. If a field is not stated, return null.
- Price observations must carry amount, currency, period, mode (flat, per_user, per_workspace), unit, plan and region when stated.
- Do not merge plans or regions into one observation.
- If a page announces a future change, set effective_from and keep the current value as the observation.
- If a page is a comparison article rather than the vendor's own page, set confidence to medium or low.
- evidence_id must be one of the IDs provided.
- Never infer a price from a percentage, a discount, or "contact us".
- attribute should be stable and lower-case, e.g. "price.pro", "limit.storage", "status.availability".`;

  const evidence = input.evidence
    .map(
      (e) =>
        `[${e.id}] ${e.title}\nURL: ${e.url}\nDomain: ${e.domain}\nPublished: ${e.publishedAt ?? 'unknown'}\nPassage:\n${e.passage.slice(0, 2000)}`,
    )
    .join('\n\n---\n\n');

  const user = `Observed at: ${input.now}\n\nEvidence:\n${evidence}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
