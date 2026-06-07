/**
 * Public type re-exports for the engine layer.
 *
 * `src/pipeline/*` must NOT import from `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * This file re-exports only the minimal structural types needed by pipeline callers
 * so they can annotate return values without touching @dbos-inc directly.
 *
 * `WorkflowHandle<T>` is re-exported from the SDK through this shim.
 */
export type { WorkflowHandle } from '@dbos-inc/dbos-sdk';
