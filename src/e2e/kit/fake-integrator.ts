import {
  integrate,
  preflightLive,
  stubIntegrate,
  type IntegratorBlocked,
  type IntegratorDeps,
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
  };
  return {
    runIntegrate: (input): Promise<IntegratorOutput | IntegratorBlocked> => integrate(input, deps),
    runStub: (input): IntegratorOutput => stubIntegrate(input),
    runPreflight: (taskId, base): Promise<{ ok: true } | IntegratorBlocked> =>
      preflightLive(taskId, base, deps),
  } as IntegratorService;
}
