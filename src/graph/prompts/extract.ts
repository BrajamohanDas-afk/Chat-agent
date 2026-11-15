import type { ChatMessage, EvidenceRow } from '../types.js';

export function extractMessages(input: {
  now: string;
  evidence: EvidenceRow[];
  targets: { name: string; plan: string | null }[];
}): ChatMessage[] {
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
- attribute should be stable and lower-case, e.g. "price.pro", "limit.storage", "status.availability".
- Prefer the vendor's own pricing or product page. Do not use community, support, blog, forum or review pages for a price when a pricing page is present.
- period is the cadence of the listed price. "$49/user/month billed annually" is period=month and conditions=["billed annually"]; do not set period=year.
- If the page shows "/user/mo" or "per seat per month", set mode=per_user, unit=user or seat, and period=month.
- Return at most eight observations. Prefer the named plan for each entity; do not enumerate every plan on the page.
- Ignore limited-time, promotional or "starting at" prices when a standard list price is present. Note a promotion in conditions if it is the only price.
- Canonical targets (entity â€” plan to prefer):
${input.targets.map((target) => `- ${target.name}${target.plan ? ` â€” ${target.plan}` : ''}`).join('\n') || 'none'}
Use the entity name exactly and put the preferred plan in the plan field. Do not create variants.`;

  const evidence = input.evidence
    .map(
      (e) =>
        `[${e.id}] ${e.title}\nURL: ${e.url}\nDomain: ${e.domain}\nPublished: ${e.publishedAt ?? 'unknown'}\nPassage:\n${e.passage.slice(0, 1000)}`,
    )
    .join('\n\n---\n\n');

  const user = `Observed at: ${input.now}\n\nEvidence:\n${evidence}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

