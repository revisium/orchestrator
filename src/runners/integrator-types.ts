/**
 * integrator-types — the foundational shapes every integrator module shares.
 *
 * Lifted out of integrator.ts so the extracted git / remote helpers can take these by type without
 * importing back into the orchestrator (which would form a cycle). integrator.ts re-exports them, so
 * the public import path ('./integrator.js') — used by the test kit and fake-integrator — is unchanged.
 */

/** Synchronous executor for git commands in a given cwd. */
export type ExecFn = (args: string[], cwd: string) => string;

export type IntegratorBlocked = { needsHuman: true; lesson: string };
