










export * from './types.js';
export { validateTemplate, classifyTemplateDiff } from './validate.js';
export type { DiffKind, TemplateDiff } from './validate.js';
export { step, initialState, evalCondition, selectJoinWinner, reduceJoinVerdict, applyCounterMutations, InterpretError } from './interpret.js';
export { materializeTemplate, hashTemplate } from './materialize.js';
export type { TopologyProfile, ConsensusToggle, MaterializeCode, MaterializeDiagnostic, MaterializeResult } from './materialize.js';
export { MATERIALIZE_CODES } from './materialize.js';
