import type { ExecGhFn } from '../../poller/pr-readiness.js';

const PR_URL = 'https://github.com/e2e/repo/pull/1';

/**
 * Named `gh` behaviours. `'happy'` is the default used by the lifecycle test.
 * The two failure scenarios are base-independent (they don't depend on which branch the run
 * targets), so they are safe to use from any future Group-D test without extra wiring.
 *
 * Base-dependent scenarios (existing-PR reuse, ambiguous PRs, wrong-base) need the run's `base`
 * to build a matching `pr list` payload — add them alongside their tests, parameterised by base.
 */
export type GhScenario =
  | 'happy' //            list→[] , create→url , view→{number:1}
  | 'pr-view-non-json' // create succeeds but `pr view` returns non-JSON → integrator needsHuman (m1)
  | 'gh-error'; //        every gh call throws (auth / rate-limit / network family) → DBOS retry / block

/**
 * Build a fake `gh` for tests. Records every argv into `calls` (so tests can assert the exact
 * command sequence), then branches on the subcommand. `git` is NOT faked — tests use a real
 * temporary repo (see {@link ./git-target-repo.ts}). The shapes mirror what `integrator.ts` reads:
 * `pr list --json number,url,baseRefName`, `pr create` (url on stdout), `pr view --json number,url`.
 */
export function createGhEmulator(calls: string[][], scenario: GhScenario = 'happy'): ExecGhFn {
  return (args: string[]): string => {
    calls.push(args);
    if (scenario === 'gh-error') {
      throw new Error('gh: API rate limit exceeded (e2e gh-error scenario)');
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'pr' && args[1] === 'create') return `${PR_URL}\n`;
    if (args[0] === 'pr' && args[1] === 'view') {
      return scenario === 'pr-view-non-json'
        ? 'not json — gh glitch'
        : JSON.stringify({ url: PR_URL, number: 1 });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}
