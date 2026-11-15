import { END, START, StateGraph } from '@langchain/langgraph';
import { analyzeNode } from './nodes/analyze.js';
import { compareNode } from './nodes/compare.js';
import { extractNode } from './nodes/extract.js';
import { generateNode } from './nodes/generate.js';
import { normalizeNode } from './nodes/normalize.js';
import { persistNode } from './nodes/persist.js';
import { recallNode } from './nodes/recall.js';
import { repairNode } from './nodes/repair.js';
import { researchNode } from './nodes/research.js';
import { validateNode } from './nodes/validate.js';
import { routeAnalyze, routeCompare, routeExtract, routeRepair } from './routers.js';
import { TurnState, type TurnStateType, type TurnStateUpdate } from './state.js';
import type { Emit } from './types.js';

async function joinNode(_state: TurnStateType): Promise<TurnStateUpdate> {
  return {};
}

const graph = new StateGraph(TurnState)
  .addNode('analyze', analyzeNode)
  .addNode('memory', recallNode)
  .addNode('research', researchNode)
  .addNode('normalize', normalizeNode)
  .addNode('join', joinNode)
  .addNode('extract', extractNode)
  .addNode('compare', compareNode)
  .addNode('generate', generateNode)
  .addNode('validate', validateNode)
  .addNode('repair', repairNode)
  .addNode('persist', persistNode)
  .addEdge(START, 'analyze')
  .addConditionalEdges('analyze', routeAnalyze, ['memory', 'research', 'join'])
  .addEdge('memory', 'join')
  .addEdge('research', 'normalize')
  .addEdge('normalize', 'join')
  .addConditionalEdges('join', routeExtract, ['extract', 'generate'])
  .addConditionalEdges('extract', routeCompare, ['compare', 'generate'])
  .addEdge('compare', 'generate')
  .addEdge('generate', 'validate')
  .addConditionalEdges('validate', routeRepair, ['repair', 'persist'])
  .addEdge('repair', 'validate')
  .addEdge('persist', END)
  .compile();

export type TurnInput = {
  sessionId: string;
  turnId: string;
  userText: string;
  now: string;
  timezone: string;
  recent: { role: 'user' | 'assistant'; text: string }[];
  isSynthetic: boolean;
  emit?: Emit;
};

export async function runTurn(input: TurnInput): Promise<TurnStateType> {
  const result = await graph.invoke(
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userText: input.userText,
      now: input.now,
      timezone: input.timezone,
      recent: input.recent,
      isSynthetic: input.isSynthetic,
    },
    { configurable: { emit: input.emit } },
  );
  return result;
}
