import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../config.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenSeededDefaultPlaybook,
  createTargetRepo,
  routedGhEmulator,
  routedRunCaseAgent,
  pipelineScenario,
  type AgentSpec,
  type RunCase,
} from './kit/index.js';

const LIVE_AGENT_STUB = { runnerOverrides: { 'claude-code': 'stub-agent' } };

let h: RunHarness;
const runCases = new Map<string, RunCase>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({
    gh: (calls) => routedGhEmulator(runCases, calls),
    agent: (sink) => routedRunCaseAgent(runCases, sink),
  });
  await givenSeededDefaultPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

function developerFailsThenPasses(reason: string): AgentSpec {
  return {
    byRole: {
      developer: [
        { kind: 'throw', message: reason },
        { kind: 'throw', message: reason },
        { kind: 'pass' },
      ],
    },
  };
}

function developerFails(reason: string): AgentSpec {
  return {
    byRole: {
      developer: [
        { kind: 'throw', message: reason },
        { kind: 'throw', message: reason },
      ],
    },
  };
}

function repoLine(context: string): string {
  const line = /^Repo: (.+)$/m.exec(context)?.[1]?.trim();
  assert.ok(line, `agent context must include Repo line; got ${context}`);
  return line;
}

test('RG234-A: exhausted transient developer failure -> retry gate -> retry completes in the same run/worktree', {
  skip: e2eSkip,
}, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await pipelineScenario(h, runCases, {
      title: 'RG234-A: retry transient developer failure',
      playbook: 'default',
      repo: target,
      executionProfile: LIVE_AGENT_STUB,
      agent: developerFailsThenPasses('scripted developer crash: transport disconnected'),
      gates: [
        ['plan', 'approved'],
        {
          topic: 'retry',
          outcome: 'retry',
          reconcile: 'keep',
          summaryIncludes: ['transient_retry', 'developer', 'attemptsExhausted'],
        },
        { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' },
      ],
      expect: {
        terminal: 'completed',
        events: ['runner_retry_exhausted', 'run_completed'],
        noEvents: ['run_recovery_created'],
      },
    });

    const developerCalls = h.agentCalls.filter((call) => call.runId === runId && call.role === 'developer');
    assert.equal(developerCalls.length, 3, 'two automatic attempts plus one manual retry developer attempt');
    const executionWorktree = worktreePathFor(getConfig().dataDir, runId);
    assert.deepEqual(
      [...new Set(developerCalls.map((call) => repoLine(call.context)))],
      [executionWorktree],
      'manual retry must reuse the same run worktree',
    );
    assert.equal(
      h.agentCalls.filter((call) => call.runId === runId && call.role === 'analyst').length,
      1,
      'manual retry must not recompute earlier analyst output',
    );

    const events = await h.api.getRunEvents({ runId, limit: 500 });
    assert.ok(
      events.some((event) => {
        const payload = event.payload as { stepKey?: unknown; attemptNo?: unknown };
        return event.type === 'step_succeeded' && payload.stepKey === 'developer#2' && payload.attemptNo === 1;
      }),
      'manual retry must re-enter developer with fresh ordinal developer#2 and a fresh physical attempt',
    );
  } finally {
    target.cleanup();
  }
});

test('RG234-B: exhausted transient developer failure -> retry gate -> give_up preserves blocked behavior', {
  skip: e2eSkip,
}, async () => {
  const target = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG234-B: give up transient developer failure',
      playbook: 'default',
      repo: target,
      executionProfile: LIVE_AGENT_STUB,
      agent: developerFails('scripted developer crash: transport disconnected'),
      gates: [
        ['plan', 'approved'],
        {
          topic: 'retry',
          outcome: 'give_up',
          summaryIncludes: ['transient_retry', 'developer', 'attemptsExhausted'],
        },
      ],
      expect: {
        terminal: 'blocked',
        events: ['runner_retry_exhausted', 'pipeline_blocked'],
        noEvents: ['run_completed', 'run_recovery_created'],
      },
    });
  } finally {
    target.cleanup();
  }
});

test('RG234-C: 529 Overloaded is transient enough to reach the manual retry gate', {
  skip: e2eSkip,
}, async () => {
  const target = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG234-C: 529 overloaded reaches retry gate',
      playbook: 'default',
      repo: target,
      executionProfile: LIVE_AGENT_STUB,
      agent: developerFails('provider 529 Overloaded; please retry later'),
      gates: [
        ['plan', 'approved'],
        {
          topic: 'retry',
          outcome: 'give_up',
          summaryIncludes: ['transient_retry', 'overloaded', '529'],
        },
      ],
      expect: {
        terminal: 'blocked',
        events: ['runner_retry_exhausted', 'pipeline_blocked'],
      },
    });
  } finally {
    target.cleanup();
  }
});
