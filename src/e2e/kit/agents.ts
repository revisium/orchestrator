import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptResult, RunAgent } from '../../worker/runner.js';
import { getConfig } from '../../config.js';
import { worktreePathFor, worktreeMarkerFor, isWorktreeDir } from '../../control-plane/resolve-cwd.js';

/**
 * Worktree-aware developer write dir (plan 0017): when the run has an isolated worktree, the fake
 * developer must write THERE (the integrator commits from the worktree), not the registered base
 * checkout — otherwise the integrator sees no diff. Falls back to the registered path for non-live
 * (stub) scenarios that have no worktree.
 */
function resolveWriteDir(runId: string, registered: string | undefined): string | undefined {
  if (!registered) return undefined;
  const dataDir = getConfig().dataDir;
  const wt = worktreePathFor(dataDir, runId);
  if (isWorktreeDir(wt)) return wt;
  // Mirror resolveRunCwd's fail-loud: a live marker with no worktree means isolation broke — refuse to
  // dirty the shared base checkout (which would mask the failure) rather than silently falling back.
  if (existsSync(worktreeMarkerFor(dataDir, runId))) {
    throw new Error(
      `fake developer: live run ${runId} expects an isolated worktree at ${wt} but it is missing — ` +
        `refusing to write into the shared base checkout`,
    );
  }
  return registered;
}

/** One recorded agent invocation — lets tests assert who ran with which runner (scoped by runId). */
export type AgentCall = { role: string; runner: string; attemptId: string; runId: string; context: string };

/** runId → worktree path where the `developer` role should write a change file. */
export type DeveloperWrites = Map<string, string>;

/** Mutable recorders a harness exposes; passed to an agent factory so a custom agent records too. */
export type AgentSink = { agentCalls: AgentCall[]; developerWrites: DeveloperWrites };

/** Per-role behaviour for {@link scriptedAgent}/{@link routedScriptedAgent}. */
export type RoleBehavior =
  | { kind: 'pass' } //                                       output { verdict: 'PASS' }
  | { kind: 'verdict'; verdict: 'PASS' | 'MINOR' | 'MAJOR' | 'BLOCKER' } // structured verdict
  | { kind: 'domainVerdict'; verdict: string } //             arbitrary DOMAIN verdict label (0015 data-driven)
  | { kind: 'throw'; message?: string } //                    runner throws → step_failed, BLOCKER, needsHuman
  | { kind: 'needsHuman'; lesson?: string } //                parks the step (awaiting_approval)
  | { kind: 'cost'; inputTokens: number; outputTokens: number; costAmount: number }; // PASS + custom cost

/** A scripted plan: behaviour per logical role; arrays are consumed one entry per call (clamped). */
export type AgentSpec = {
  byRole?: Record<string, RoleBehavior | RoleBehavior[]>;
  default?: RoleBehavior;
};

function pickBehavior(spec: AgentSpec, role: string, callIndex: number): RoleBehavior {
  const entry = spec.byRole?.[role];
  if (Array.isArray(entry)) return entry[Math.min(callIndex, entry.length - 1)] ?? { kind: 'pass' };
  return entry ?? spec.default ?? { kind: 'pass' };
}

function runBehavior(
  behavior: RoleBehavior,
  ctx: { logicalRole: string; runner: string; attemptId: string; runId: string; level: string },
  sink: AgentSink,
): AttemptResult {
  if (behavior.kind === 'throw') {
    throw new Error(behavior.message ?? `scripted failure from ${ctx.logicalRole}`);
  }
  const writeRepo = ctx.logicalRole === 'developer' ? resolveWriteDir(ctx.runId, sink.developerWrites.get(ctx.runId)) : undefined;
  if (writeRepo && behavior.kind !== 'needsHuman') {
    writeFileSync(join(writeRepo, `developer-${ctx.attemptId}.txt`), `change from ${ctx.attemptId}\n`);
  }
  const verdict =
    behavior.kind === 'verdict' || behavior.kind === 'domainVerdict' ? behavior.verdict : 'PASS';
  const cost =
    behavior.kind === 'cost'
      ? { inputTokens: behavior.inputTokens, outputTokens: behavior.outputTokens, costAmount: behavior.costAmount }
      : { inputTokens: 10, outputTokens: 5, costAmount: 0.001 };
  return {
    output: { verdict, role: ctx.logicalRole, runner: ctx.runner },
    artifacts: {
      process: { ref: `test-artifacts/${ctx.attemptId}`, stdoutTail: `stdout from ${ctx.logicalRole}`, stderrTail: '' },
    },
    nextSteps: [],
    costs: [{ modelProfile: ctx.level, currency: 'USD', ...cost }],
    needsHuman: behavior.kind === 'needsHuman',
    lesson: behavior.kind === 'needsHuman' ? behavior.lesson : undefined,
  };
}

/** Agent driven by a single {@link AgentSpec} (same plan for every run). Records into `sink`. */
export function scriptedAgent(spec: AgentSpec, sink: AgentSink): RunAgent {
  const counts = new Map<string, number>();
  return async ({ role, profile, attemptId, step, context }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    sink.agentCalls.push({ role: logicalRole, runner: role.runner, attemptId, runId: step.runId, context });
    const n = counts.get(logicalRole) ?? 0;
    counts.set(logicalRole, n + 1);
    return runBehavior(pickBehavior(spec, logicalRole, n), {
      logicalRole,
      runner: role.runner,
      attemptId,
      runId: step.runId,
      level: profile.level,
    }, sink);
  };
}

/**
 * Agent that dispatches to a per-run {@link AgentSpec} from `specs` (keyed by runId), so one harness
 * can drive many runs with different failure scripts. Create the run with `start:false`, register its
 * spec in `specs`, then `startRun` — the workflow then reads this run's plan. Defaults to all-PASS.
 */
export function routedScriptedAgent(specs: Map<string, AgentSpec>, sink: AgentSink): RunAgent {
  const counts = new Map<string, number>();
  return async ({ role, profile, attemptId, step, context }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    sink.agentCalls.push({ role: logicalRole, runner: role.runner, attemptId, runId: step.runId, context });
    const key = `${step.runId}::${logicalRole}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const spec = specs.get(step.runId) ?? {};
    return runBehavior(pickBehavior(spec, logicalRole, n), {
      logicalRole,
      runner: role.runner,
      attemptId,
      runId: step.runId,
      level: profile.level,
    }, sink);
  };
}

/**
 * Deterministic test agent: records every call, returns a PASS verdict with fixed costs and a
 * process artifact. When the logical role is `developer` and a worktree is registered for the run,
 * it writes a file so the real integrator has a diff to commit.
 *
 * This is the default agent used by `createRunHarness()`; it replaces `claude-code` via
 * `executionProfile.runnerOverrides`, so no real `claude` process is ever spawned in e2e.
 */
export function deterministicAgent(
  agentCalls: AgentCall[],
  developerWrites: DeveloperWrites,
): RunAgent {
  return async ({ role, profile, attemptId, step, context }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    agentCalls.push({ role: logicalRole, runner: role.runner, attemptId, runId: step.runId, context });
    const writeRepo = logicalRole === 'developer' ? resolveWriteDir(step.runId, developerWrites.get(step.runId)) : undefined;
    if (writeRepo) {
      writeFileSync(join(writeRepo, `developer-${attemptId}.txt`), `change from ${attemptId}\n`);
    }
    return {
      output: {
        verdict: 'PASS',
        role: logicalRole,
        runner: role.runner,
      },
      artifacts: {
        process: {
          ref: `test-artifacts/${attemptId}`,
          stdoutTail: `stdout from ${logicalRole}`,
          stderrTail: '',
        },
      },
      nextSteps: [],
      costs: [{
        modelProfile: profile.level,
        inputTokens: 10,
        outputTokens: 5,
        costAmount: 0.001,
        currency: 'USD',
      }],
      needsHuman: false,
    };
  };
}
