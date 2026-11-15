import type { TurnStateType } from './state.js';

export type NodeName =
  | 'analyze'
  | 'memory'
  | 'research'
  | 'normalize'
  | 'extract'
  | 'join'
  | 'compare'
  | 'generate'
  | 'validate'
  | 'repair'
  | 'persist';

/** One conditional edge; returns both branches when recall and search run together. */
export function routeAnalyze(state: TurnStateType): NodeName[] {
  const targets: NodeName[] = [];
  if (state.analysis?.intent !== 'smalltalk') targets.push('memory');
  if (state.analysis?.needsSearch) targets.push('research');
  return targets.length > 0 ? targets : ['join'];
}

export function routeExtract(state: TurnStateType): NodeName {
  return state.evidence.length > 0 ? 'extract' : 'generate';
}

export function routeCompare(state: TurnStateType): NodeName {
  return state.analysis?.intent === 'recheck' && state.analysis.comparisonTargets.length > 0
    ? 'compare'
    : 'generate';
}

export function routeRepair(state: TurnStateType): NodeName {
  return state.validation && state.validation.failed > 0 && state.repairPasses < 1
    ? 'repair'
    : 'persist';
}
