import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptResult, RunAgent } from '../../worker/runner.js';
import type { AgentActivityReporter } from '../../observability/agent-activity-reporter.js';
import type { CasePlanRegistry } from './case-plan.js';

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
export type AgentCall = {
  role: string;
  runner: string;
  attemptId: string;
  runId: string;
  taskId: string;
  context: string;
  stepInput: unknown;
  nodeId?: string;
};

export type AgentSink = { agentCalls: AgentCall[]; casePlans: CasePlanRegistry };

export type TriageDecision = 'fix' | 'wontfix' | 'question';

/** Per-role behaviour selected by the immutable plan consumed by {@link plannedAgent}. */
export type RoleBehavior =
  | { kind: 'pass' } //                                       top-level default domain verdict
  | { kind: 'verdict'; verdict: string } //                   top-level domain verdict
  | { kind: 'domainVerdict'; verdict: string } //             arbitrary DOMAIN verdict label (0015 data-driven)
  | { kind: 'triage'; decisions: TriageDecision[]; threadId?: string; guidance?: string; replyText?: string }
  | { kind: 'invalidNoVerdict'; output?: string } //          malformed result: no top-level verdict
  | { kind: 'throw'; message?: string } //                    runner throws → step_failed, BLOCKER, needsHuman
  | { kind: 'needsHuman'; lesson?: string } //                parks the step (awaiting_approval)
  | { kind: 'reporter'; marker: string }
  | { kind: 'cost'; inputTokens: number; outputTokens: number; costAmount: number }; // default verdict + custom cost

/** A scripted plan: behaviour per logical role; arrays are consumed one entry per call (clamped). */
export type AgentSpec = {
  readonly byRole?: Readonly<Record<string, RoleBehavior | readonly RoleBehavior[]>>;
  readonly default?: RoleBehavior;
};

function pickBehavior(spec: AgentSpec, role: string, callIndex: number): RoleBehavior {
  const entry = spec.byRole?.[role];
  if (Array.isArray(entry)) return entry[Math.min(callIndex, entry.length - 1)] ?? { kind: 'pass' };
  return (entry as RoleBehavior | undefined) ?? spec.default ?? { kind: 'pass' };
}

function nodeIdFromStepInput(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const nodeId = (input as Record<string, unknown>).nodeId;
  return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined;
}

function recordAgentCall(agentCalls: AgentCall[], input: {
  logicalRole: string;
  runner: string;
  attemptId: string;
  runId: string;
  taskId: string;
  context: string;
  stepInput: unknown;
}): void {
  const nodeId = nodeIdFromStepInput(input.stepInput);
  agentCalls.push({
    role: input.logicalRole,
    runner: input.runner,
    attemptId: input.attemptId,
    runId: input.runId,
    taskId: input.taskId,
    context: input.context,
    stepInput: input.stepInput,
    ...(nodeId ? { nodeId } : {}),
  });
}

function defaultVerdictFor(role: string): string {
  return role === 'watcher' ? 'clean' : 'approved';
}

function runBehavior(
  behavior: RoleBehavior,
  ctx: { logicalRole: string; runnerId: string; provider: string; modelId: string; attemptId: string; runId: string; taskId: string; context: string },
  sink: AgentSink,
  callIndex: number,
  reporter?: AgentActivityReporter,
): AttemptResult {
  if (behavior.kind === 'throw') {
    throw new Error(behavior.message ?? `scripted failure from ${ctx.logicalRole}`);
  }
  if (behavior.kind === 'triage') {
    const decision = behavior.decisions[Math.min(callIndex, behavior.decisions.length - 1)] ?? 'fix';
    return {
      output: {
        items: [{
          threadId: behavior.threadId ?? 'PRRT_T1',
          decision,
          guidance: behavior.guidance ?? 'address the review comment',
          replyText: behavior.replyText ?? 'done in the latest push',
        }],
        needsHuman: decision === 'question',
      },
      verdict: decision,
      nextSteps: [],
      costs: [{ runnerId: ctx.runnerId, provider: ctx.provider, modelId: ctx.modelId, currency: 'USD', inputTokens: 10, outputTokens: 5, costAmount: 0.001 }],
      needsHuman: false,
    };
  }
  if (behavior.kind === 'reporter') {
    reporter?.started();
    reporter?.spawned(4242);
    reporter?.output('stdout', `${behavior.marker} hello from the agent`);
    reporter?.parsed({ type: 'assistant', preview: 'doing the work' });
    reporter?.finished({ exitCode: 0, timedOut: false });
    return {
      output: { ok: true },
      verdict: 'approved',
      artifacts: { process: { ref: `test-artifacts/${ctx.attemptId}`, stdoutTail: behavior.marker, stderrTail: '' } },
      nextSteps: [],
      costs: [{ runnerId: ctx.runnerId, provider: ctx.provider, modelId: ctx.modelId, currency: 'USD', inputTokens: 1, outputTokens: 1, costAmount: 0 }],
      needsHuman: false,
    };
  }
  const registeredWrite = sink.casePlans.get(ctx.taskId)?.developerWrite;
  const writeRepo = ctx.logicalRole === 'developer' ? resolveWriteDir(registeredWrite, ctx.context) : undefined;
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
    output: { role: ctx.logicalRole, runner: ctx.runnerId },
    verdict,
    artifacts: {
      process: { ref: `test-artifacts/${ctx.attemptId}`, stdoutTail: `stdout from ${ctx.logicalRole}`, stderrTail: '' },
    },
    nextSteps: [],
    costs: [{ runnerId: ctx.runnerId, provider: ctx.provider, modelId: ctx.modelId, currency: 'USD', ...cost }],
    needsHuman: behavior.kind === 'needsHuman',
    lesson: behavior.kind === 'needsHuman' ? behavior.lesson : undefined,
  };
}

export function plannedAgent(sink: AgentSink): RunAgent {
  const counts = new Map<string, number>();
  return async ({ role, binding, attemptId, step, context, reporter }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    recordAgentCall(sink.agentCalls, { logicalRole, runner: binding.runner.runnerId, attemptId, runId: step.runId, taskId: step.taskId, context, stepInput: step.input });
    const key = `${step.taskId}::${logicalRole}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const spec = sink.casePlans.get(step.taskId)?.agent ?? {};
    return runBehavior(pickBehavior(spec, logicalRole, n), {
      logicalRole,
      runnerId: binding.runner.runnerId,
      attemptId,
      runId: step.runId,
      taskId: step.taskId,
      provider: binding.provider,
      modelId: binding.modelId,
      context,
    }, sink, n, reporter);
  };
}
