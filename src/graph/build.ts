import { END, START, StateGraph } from '@langchain/langgraph';
import { analyzeNode } from './nodes/analyze.js';
import { compareNode } from './nodes/compare.js';
import { extractNode } from './nodes/extract.js';
import { gatherNode } from './nodes/gather.js';
import { generateNode } from './nodes/generate.js';
import { normalizeNode } from './nodes/normalize.js';
import { persistNode } from './nodes/persist.js';
import { repairNode } from './nodes/repair.js';
import { validateNode } from './nodes/validate.js';
import { routeCompare, routeGather, routeRepair } from './routers.js';
import { TurnState, type TurnStateType } from './state.js';
import type { Emit } from './types.js';

const graph = new StateGraph(TurnState)
  .addNode('analyze', analyzeNode)
  .addNode('gather', gatherNode)
  .addNode('normalize', normalizeNode)
  .addNode('extract', extractNode)
  .addNode('compare', compareNode)
  .addNode('generate', generateNode)
  .addNode('validate', validateNode)
  .addNode('repair', repairNode)
  .addNode('persist', persistNode)
  .addEdge(START, 'analyze')
  .addEdge('analyze', 'gather')
  .addConditionalEdges('gather', routeGather, ['normalize', 'generate'])
  .addEdge('normalize', 'extract')
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
