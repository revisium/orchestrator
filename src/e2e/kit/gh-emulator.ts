import type { ExecGhFn } from '../../poller/pr-readiness.js';

const PR_URL = 'https://github.com/e2e/repo/pull/1';
const PR_URL_2 = 'https://github.com/e2e/repo/pull/2';
const BASE = 'master'; // createTargetRepo() bases every run on master

/**
 * Named `gh` behaviours. The shapes mirror what `integrator.ts` reads: `pr list --json
 * number,url,baseRefName`, `pr create` (url on stdout), `pr view --json number,url`. Pair with the
 * per-run {@link routedGhEmulator} so one harness can give each run a different gh outcome.
 */
export type GhScenario =
  | 'happy' //              list→[] , create→url , view→{number:1}
  | 'pr-already-exists' //  list→[one open PR on master] → integrator reuses it, no `pr create`
  | 'ambiguous-prs' //      list→[two open PRs on master] → integrator needsHuman (ambiguous)
  | 'pr-view-non-json' //   create succeeds but `pr view` returns non-JSON → needsHuman (never stub://)
  | 'gh-error' //           every gh call throws (rate-limit / network family) → DBOS retries the step
  | 'gh-token-leak'; //     throws an error embedding a gho_ token → asserts redaction in the lesson

function ghBehavior(scenario: GhScenario, args: string[]): string {
  if (scenario === 'gh-error') {
    throw new Error('gh: API rate limit exceeded for installation (e2e gh-error scenario)');
  }
  if (scenario === 'gh-token-leak') {
    throw new Error('gh: bad credentials using token gho_abcdEFGH1234567890LEAK rejected by server');
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    if (scenario === 'pr-already-exists') return JSON.stringify([{ number: 7, url: PR_URL, baseRefName: BASE }]);
    if (scenario === 'ambiguous-prs') {
      return JSON.stringify([
        { number: 7, url: PR_URL, baseRefName: BASE },
        { number: 8, url: PR_URL_2, baseRefName: BASE },
      ]);
    }
    return JSON.stringify([]);
  }
  if (args[0] === 'pr' && args[1] === 'create') return `${PR_URL}\n`;
  if (args[0] === 'pr' && args[1] === 'view') {
    return scenario === 'pr-view-non-json' ? 'not json — gh glitch' : JSON.stringify({ url: PR_URL, number: 1 });
  }
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
}

/** Single-scenario fake `gh`, recording argv into `calls`. (Default harness gh = `happy`.) */
export function createGhEmulator(calls: string[][], scenario: GhScenario = 'happy'): ExecGhFn {
  return (args: string[]): string => {
    calls.push(args);
    return ghBehavior(scenario, args);
  };
}

/**
 * Per-run fake `gh`: routes to a scenario by the feature branch (`feat/<taskId>-…`) present in the
 * gh argv, so one shared harness can drive many runs with different gh outcomes. Register a run's
 * scenario in `scenarios` (keyed by taskId) before starting it; unregistered runs get `happy`.
 */
export function routedGhEmulator(scenarios: Map<string, GhScenario>, calls: string[][]): ExecGhFn {
  return (args: string[]): string => {
    calls.push(args);
    const taskId = [...scenarios.keys()].find((id) => args.some((a) => a.startsWith(`feat/${id}-`)));
    const scenario = (taskId !== undefined ? scenarios.get(taskId) : undefined) ?? 'happy';
    return ghBehavior(scenario, args);
  };
}
