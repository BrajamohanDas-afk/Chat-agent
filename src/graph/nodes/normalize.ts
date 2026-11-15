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

  emit?.({
    type: 'sources',
    sources: evidence.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      domain: row.domain,
      publishedAt: row.publishedAt,
    })),
  });

  return {
    evidence,
    trace: [event('normalize', `${evidence.length} usable sources`, started)],
  };
}
