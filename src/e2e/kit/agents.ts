import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptResult, RunAgent } from '../../worker/runner.js';

/**
 * Anti-masking write dir: parse the `Repo:` path from the agent context string, which build-context
 * sets to the run's isolated worktree for live runs (slice 143). Writing to the GIVEN path (not a
 * locally recomputed worktree path) means a regression in build-context's worktree rewrite surfaces
 * immediately — the developer writes to the base checkout, the worktree stays empty, and the integrator
 * blocks with the slice-143 lesson.
 */
export function resolveWriteDir(registered: string | undefined, context: string): string | undefined {
  if (!registered) return undefined;
  const match = /^Repo: (.+)$/m.exec(context);
  if (!match) return undefined;
  return match[1].trim();
}

/** One recorded agent invocation — lets tests assert who ran with which runner (scoped by runId). */
export type AgentCall = { role: string; runner: string; attemptId: string; runId: string; context: string };

/** runId → worktree path where the `developer` role should write a change file. */
export type DeveloperWrites = Map<string, string>;

/** Mutable recorders a harness exposes; passed to an agent factory so a custom agent records too. */
export type AgentSink = { agentCalls: AgentCall[]; developerWrites: DeveloperWrites };

/** Per-role behaviour for {@link scriptedAgent}/{@link routedScriptedAgent}. */
export type RoleBehavior =
  | { kind: 'pass' } //                                       top-level default domain verdict
  | { kind: 'verdict'; verdict: string } //                   top-level domain verdict
  | { kind: 'domainVerdict'; verdict: string } //             arbitrary DOMAIN verdict label (0015 data-driven)
  | { kind: 'invalidNoVerdict'; output?: string } //          malformed result: no top-level verdict
  | { kind: 'throw'; message?: string } //                    runner throws → step_failed, BLOCKER, needsHuman
  | { kind: 'needsHuman'; lesson?: string } //                parks the step (awaiting_approval)
  | { kind: 'cost'; inputTokens: number; outputTokens: number; costAmount: number }; // default verdict + custom cost

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

function defaultVerdictFor(role: string): string {
  return role === 'watcher' ? 'clean' : 'approved';
}

function runBehavior(
  behavior: RoleBehavior,
  ctx: { logicalRole: string; runner: string; attemptId: string; runId: string; level: string; context: string },
  sink: AgentSink,
): AttemptResult {
  if (behavior.kind === 'throw') {
    throw new Error(behavior.message ?? `scripted failure from ${ctx.logicalRole}`);
  }
  const writeRepo = ctx.logicalRole === 'developer' ? resolveWriteDir(sink.developerWrites.get(ctx.runId), ctx.context) : undefined;
  if (writeRepo && behavior.kind !== 'needsHuman') {
    writeFileSync(join(writeRepo, `developer-${ctx.attemptId}.txt`), `change from ${ctx.attemptId}\n`);
  }
  if (behavior.kind === 'invalidNoVerdict') {
    return {
      output: behavior.output ?? '# Plan approved\nLooks good.',
      nextSteps: [],
      costs: [],
      needsHuman: false,
    };
  }
  const verdict =
    behavior.kind === 'verdict' || behavior.kind === 'domainVerdict' ? behavior.verdict : defaultVerdictFor(ctx.logicalRole);
  const cost =
    behavior.kind === 'cost'
      ? { inputTokens: behavior.inputTokens, outputTokens: behavior.outputTokens, costAmount: behavior.costAmount }
      : { inputTokens: 10, outputTokens: 5, costAmount: 0.001 };
  return {
    output: { role: ctx.logicalRole, runner: ctx.runner },
    verdict,
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
      context,
    }, sink);
  };
}

/**
 * Agent that dispatches to a per-run {@link AgentSpec} from `specs` (keyed by runId), so one harness
 * can drive many runs with different failure scripts. Create the run with `start:false`, register its
 * spec in `specs`, then `startRun` — the workflow then reads this run's plan. Defaults to domain success.
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
      context,
    }, sink);
  };
}

/**
 * Deterministic test agent: records every call, returns a domain success verdict with fixed costs and a
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
    const writeRepo = logicalRole === 'developer' ? resolveWriteDir(developerWrites.get(step.runId), context) : undefined;
    if (writeRepo) {
      writeFileSync(join(writeRepo, `developer-${attemptId}.txt`), `change from ${attemptId}\n`);
    }
    return {
      output: {
        role: logicalRole,
        runner: role.runner,
      },
      verdict: defaultVerdictFor(logicalRole),
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
