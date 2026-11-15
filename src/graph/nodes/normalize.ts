import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { TurnStateType, TurnStateUpdate } from '../state.js';
import type { Emit, EvidenceRow, TraceEvent } from '../types.js';

function emitOf(config: LangGraphRunnableConfig | undefined): Emit | undefined {
  return config?.configurable?.emit as Emit | undefined;
}

function event(node: string, detail: string, started: number): TraceEvent {
  return { at: new Date().toISOString(), node, detail, ms: Date.now() - started };
}

/** Drop unusable rows, renumber evidence IDs once, and publish the source list. */
export async function normalizeNode(
  state: TurnStateType,
  config?: LangGraphRunnableConfig,
): Promise<TurnStateUpdate> {
  const started = Date.now();
  const emit = emitOf(config);
  const seen = new Set<string>();
  const evidence: EvidenceRow[] = [];

  for (const row of state.evidence) {
    if (!row.passage && !row.snippet) continue;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    evidence.push({
      ...row,
      id: `e${evidence.length + 1}`,
      passage: row.passage.slice(0, 4000),
    });
  }

  // Official pages first, then newest. Keep two per domain so every vendor has
  // a page, and cap the extractor's context so 40 results cannot become 30k tokens.
  const perDomain = new Map<string, number>();
  const capped: EvidenceRow[] = [];
  for (const row of evidence.sort(
    (left, right) =>
      right.sourceRank - left.sourceRank ||
      (Date.parse(right.publishedAt ?? '') || 0) - (Date.parse(left.publishedAt ?? '') || 0),
  )) {
    const used = perDomain.get(row.domain) ?? 0;
    if (used >= 2) continue;
    perDomain.set(row.domain, used + 1);
    capped.push({ ...row, id: `e${capped.length + 1}` });
    if (capped.length >= 8) break;
  }

  emit?.({
    type: 'sources',
    sources: capped.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      domain: row.domain,
      publishedAt: row.publishedAt,
    })),
  });

  return {
    evidence: capped,
    trace: [event('normalize', `${capped.length} usable sources`, started)],
  };
}
