import {
  integrate,
  confirmMerge,
  preflightLive,
  pollPr,
  overrideMerge,
  respondThreads,
  captureProducedChange,
  triageForRespondThreads,
  type CaptureProducedChangeInput,
  type ConfirmMergeOutput,
  type IntegratorBlocked,
  type IntegratorDeps,
  type IntegratorInput,
  type IntegratorOutput,
  type IntegratorService,
  type MergeOverrideOutput,
  type PrFeedback,
  type RespondThreadsOutput,
} from '../../runners/integrator.js';
import type { RunService } from '../../revisium/run.service.js';
import type { ExecGhFn } from '../../poller/pr-readiness.js';
import { execGit } from './git-target-repo.js';
import type { CasePlanRegistry } from './case-plan.js';

/**
 * Build an `IntegratorService`-shaped object wired to the real script functions with a real git
 * (on a temp repo) and a fake `gh`.
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
    runIntegrate: (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => integrate(input, deps),
    runConfirmMerge: (input: IntegratorInput): Promise<ConfirmMergeOutput | IntegratorBlocked> => confirmMerge(input, deps),
    runPreflight: (taskId: string, base: string): Promise<{ ok: true } | IntegratorBlocked> =>
      preflightLive(taskId, base, deps),
    runCaptureProducedChange: (input: CaptureProducedChangeInput) => captureProducedChange(input, deps),
    // plan 0018 — pollPr/respondThreads against the fake gh. pollPr's sleep is a no-op + a small poll cap
    // so the e2e gh emulator converges fast (CI/threads flip deterministically per call).
    runPollPr: (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> =>
      pollPr(input, { ...deps, sleep: () => Promise.resolve(), maxPolls: 30 }),
    runOverrideMerge: (input: IntegratorInput): Promise<MergeOverrideOutput | IntegratorBlocked> =>
      overrideMerge(input, deps),
    runRespondThreads: (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> =>
      respondThreads(triageForRespondThreads(input), deps),
  } as unknown as IntegratorService;
}

/** Per-run mocked integrate outcomes. Other script functions still delegate to the real fake integrator. */
export type IntegratorOutcome =
  | { kind: 'needsHuman'; lesson: string } // integrate → blocked (fail-loud gh identity D7; token-leak lesson D15)
  | { kind: 'throw'; message: string }; //    integrate throws → workflow's top-level catch failRuns it (D13)

/**
 * Wrap a base IntegratorService so tasks with an immutable case plan get a mocked integrate result
 * (needsHuman or throw); all others delegate to `base` (real integrate/preflight).
 * Mirrors the per-run gh/agent routers — the external boundary is mocked, the workflow is real.
 */
export function plannedIntegrator(
  casePlans: CasePlanRegistry,
  base: IntegratorService,
): IntegratorService {
  return {
    runIntegrate: (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
      const outcome = casePlans.get(input.taskId)?.integrator;
      if (outcome?.kind === 'throw') return Promise.reject(new Error(outcome.message));
      if (outcome?.kind === 'needsHuman') return Promise.resolve({ needsHuman: true, lesson: outcome.lesson });
      return base.runIntegrate(input);
    },
    runConfirmMerge: base.runConfirmMerge,
    runPreflight: base.runPreflight,
    runCaptureProducedChange: base.runCaptureProducedChange,
    runPollPr: base.runPollPr,
    runOverrideMerge: base.runOverrideMerge,
    runRespondThreads: base.runRespondThreads,
  } as unknown as IntegratorService;
}
