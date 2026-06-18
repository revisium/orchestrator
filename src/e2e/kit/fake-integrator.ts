import {
  integrate,
  preflightLive,
  stubIntegrate,
  type IntegratorBlocked,
  type IntegratorDeps,
  type IntegratorInput,
  type IntegratorOutput,
  type IntegratorService,
} from '../../runners/integrator.js';
import type { RunService } from '../../revisium/run.service.js';
import type { ExecGhFn } from '../../poller/pr-readiness.js';
import { execGit } from './git-target-repo.js';

/**
 * Build an `IntegratorService`-shaped object wired to the real `integrate`/`preflightLive`/
 * `stubIntegrate` with a real git (on a temp repo) and a fake `gh`.
 *
 * Deliberately bypasses `IntegratorService.runIntegrate`'s `resolvePinnedGh()` step — tests have no
 * real gh identity to pin. Scenarios that must exercise the fail-loud gh-account pinning (D7) should
 * drive the real `IntegratorService` instead of this fake.
 */
export function createFakeIntegrator(runs: RunService, execGh: ExecGhFn): IntegratorService {
  const deps: IntegratorDeps = {
    execGit,
    execGh,
    resolveTaskCwd: runs.makeResolveTaskCwd(),
    resolveRunCwd: runs.makeResolveRunCwd(),
  };
  return {
    runIntegrate: (input): Promise<IntegratorOutput | IntegratorBlocked> => integrate(input, deps),
    runStub: (input): IntegratorOutput => stubIntegrate(input),
    runPreflight: (taskId, base): Promise<{ ok: true } | IntegratorBlocked> =>
      preflightLive(taskId, base, deps),
  } as IntegratorService;
}

/** Per-run mocked integrate outcomes. preflight/stub still delegate to the real fake integrator. */
export type IntegratorOutcome =
  | { kind: 'needsHuman'; lesson: string } // integrate → blocked (fail-loud gh identity D7; token-leak lesson D15)
  | { kind: 'throw'; message: string }; //    integrate throws → workflow's top-level catch failRuns it (D13)

/**
 * Wrap a base IntegratorService so runs whose taskId is registered in `outcomes` get a mocked
 * integrate result (needsHuman or throw); all others delegate to `base` (real integrate/preflight).
 * Mirrors the per-run gh/agent routers — the external boundary is mocked, the workflow is real.
 */
export function routedIntegrator(
  outcomes: Map<string, IntegratorOutcome>,
  base: IntegratorService,
): IntegratorService {
  return {
    runIntegrate: (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
      const outcome = outcomes.get(input.taskId);
      if (outcome?.kind === 'throw') return Promise.reject(new Error(outcome.message));
      if (outcome?.kind === 'needsHuman') return Promise.resolve({ needsHuman: true, lesson: outcome.lesson });
      return base.runIntegrate(input);
    },
    runStub: base.runStub,
    runPreflight: base.runPreflight,
  } as IntegratorService;
}
