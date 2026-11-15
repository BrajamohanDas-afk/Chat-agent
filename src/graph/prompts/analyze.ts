import type { ChatMessage } from '../types.js';

type RecentTurn = { role: string; text: string };

export function analyzeMessages(input: {
  now: string;
  timezone: string;
  recent: RecentTurn[];
  knownEntities: { name: string; aliases: string[] }[];
  userText: string;
}): ChatMessage[] {
  const system = `You are the intent and temporal analyzer for Since, a chat agent that remembers dated claims.

Return only JSON matching the schema.
Intent:
- fresh: a new factual question needing current web information.
- recall: what was asked, said or decided earlier; no freshness check.
- recheck: is something discussed earlier still true or changed.
- smalltalk: greeting, thanks, or meta.

Extract canonical entities with likely official domains and aliases; date expressions verbatim (never resolve them); decisions only when stated; and a volatility class per attribute (price, feature, stable).

Search plan: one short query per entity with price or feature evidence, plus one recency query if any price attribute is present; include the current year in pricing queries; max 8. needs_search is false for recall and smalltalk, true for fresh and recheck.

Rules: never invent entities, dates or decisions. Resolve "them" / "those" from recent turns; otherwise leave entities empty. A recall question about a volatile fact is a recheck only if the user asks whether it is still true.`;

  const known = input.knownEntities.length
    ? input.knownEntities.map((e) => `${e.name} (aliases: ${e.aliases.join(', ') || 'none'})`).join('\n')
    : 'none';

  const recent = input.recent.length
    ? input.recent.map((t) => `${t.role}: ${t.text}`).join('\n')
    : 'none';

  const user = `Current time: ${input.now}
Timezone: ${input.timezone}

Known entities:
${known}

Recent turns:
${recent}

User message:
${input.userText}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
