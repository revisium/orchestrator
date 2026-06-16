/**
 * pipeline-core — the pure, framework-free pipeline state machine (plan 0015, slice 1).
 *
 * ZERO imports from NestJS / DBOS / Revisium / runners / any I/O; deterministic (no clocks/randomness).
 * The DBOS effect-adapter (slice 2) consumes this surface:
 *   - `validateTemplate` / `classifyTemplateDiff` — install-time validation (§12).
 *   - `step` — the pure reducer `(template, state, lastResult) -> { state, decision }` (§10).
 *   - `initialState` — build the entry cursor.
 *
 * The `kit/` sub-path is a TEST helper (builders/fixtures/drive/assertions) and is intentionally NOT
 * re-exported here — production code depends only on these primitives.
 */

export * from './types.js';
export { validateTemplate, classifyTemplateDiff } from './validate.js';
export type { DiffKind, TemplateDiff } from './validate.js';
export { step, initialState, evalCondition, selectJoinWinner, applyCounterMutations, InterpretError } from './interpret.js';
