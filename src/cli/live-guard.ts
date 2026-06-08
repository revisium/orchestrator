/**
 * live-guard.ts — shared cost-guard helpers used by CLI commands that can spawn real runners.
 *
 * WHY: the cost guard ("no real claude/git/gh without explicit --live") must be enforced
 * in ONE place with ONE warning string, so both `run start` and `revo work` use identical
 * semantics and the warning cannot drift.
 *
 * Exports:
 *   - LIVE_COST_WARNING  — the canonical one-line warning string (import for tests).
 *   - warnLiveCost()     — emits LIVE_COST_WARNING to console.warn.
 *   - assertNoStubLive() — validates that --stub and --live are not both set; sets exitCode=1
 *                          and returns false when contradictory.
 *   - requireLiveFlag()  — asserts that --live is set when a real runner is requested;
 *                          sets exitCode=1 and returns false otherwise.
 */

/** Canonical cost/side-effect warning — must match between run start and revo work. */
export const LIVE_COST_WARNING =
  'WARNING: --live runs real Claude (claude -p) and incurs token cost on ' +
  'architect/developer/reviewer, AND the real integrator will push a branch and open a draft PR.';

/** Emit the cost warning to stderr. */
export function warnLiveCost(): void {
  console.warn(LIVE_COST_WARNING);
}

/**
 * Validate that --stub and --live are not both set.
 * Sets process.exitCode=1 and returns false when contradictory; returns true when valid.
 */
export function assertNoStubLive(stub: boolean, live: boolean): boolean {
  if (stub && live) {
    console.error('Error: choose either --stub or --live, not both');
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Assert that --live is explicitly set when a real runner is requested.
 * Used by `revo work --runner auto` to block real execution without --live.
 * Sets process.exitCode=1 and returns false when --live is absent; returns true otherwise.
 */
export function requireLiveFlag(live: boolean, runnerMode: string): boolean {
  if (!live) {
    console.error(
      `Error: --runner ${runnerMode} requires --live (runs real Claude and incurs cost). ` +
        'Pass --live explicitly to confirm, or omit --runner to use the zero-cost stub.',
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}
