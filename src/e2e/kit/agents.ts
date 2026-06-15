import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptResult, RunAgent } from '../../worker/runner.js';

/** One recorded agent invocation — lets tests assert who ran with which runner. */
export type AgentCall = { role: string; runner: string; attemptId: string };

/** runId → worktree path where the `developer` role should write a change file. */
export type DeveloperWrites = Map<string, string>;

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
  return async ({ role, profile, attemptId, step }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    agentCalls.push({ role: logicalRole, runner: role.runner, attemptId });
    const writeRepo = logicalRole === 'developer' ? developerWrites.get(step.runId) : undefined;
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
