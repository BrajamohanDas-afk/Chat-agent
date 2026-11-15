import type { ChatMessage } from '../types.js';

export function researchMessages(input: {
  targets: string[];
  gaps: string[];
  existing: { title: string; url: string }[];
}): ChatMessage[] {
  const system = `You are the research planner for Since. You have exactly one tool: web_search.

Your job is to fill evidence gaps, not to write the answer. Call web_search only when a gap needs it. Never repeat a query. Never search for something already covered by an existing result. Stop after at most three calls.

Typical gaps: no official pricing page for an entity, a plan name unknown, a price page without plan details. Prefer the vendor's own domain when you know it.`;

  const existing = input.existing.length
    ? input.existing.map((e) => `- ${e.title} (${e.url})`).join('\n')
    : 'none';

  const user = `Targets: ${input.targets.join(', ') || 'none'}
Gaps: ${input.gaps.join('; ') || 'none'}

Existing results:
${existing}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
