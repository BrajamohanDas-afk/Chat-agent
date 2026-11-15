import type { TurnStateType } from './state.js';

export type NodeName =
  | 'analyze'
  | 'gather'
  | 'normalize'
  | 'extract'
  | 'compare'
  | 'generate'
  | 'validate'
  | 'repair'
  | 'persist';

export function routeGather(state: TurnStateType): NodeName {
  return state.evidence.length > 0 ? 'normalize' : 'generate';
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
