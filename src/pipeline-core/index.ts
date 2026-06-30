










export * from './types.js';
export { validateTemplate, classifyTemplateDiff } from './validate.js';
export type { DiffKind, TemplateDiff } from './validate.js';
export { step, initialState, evalCondition, selectJoinWinner, reduceJoinVerdict, applyCounterMutations, InterpretError } from './interpret.js';
