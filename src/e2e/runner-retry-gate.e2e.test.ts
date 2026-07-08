import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../config.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
import { coverageForScenario } from '../control-plane/pipeline-coverage-registry.js';
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

function analystAsksTwiceThenPasses(firstLesson: string, secondLesson: string): AgentSpec {
  return {
    byRole: {
      analyst: [
        { kind: 'needsHuman', lesson: firstLesson },
        { kind: 'needsHuman', lesson: secondLesson },
        { kind: 'pass' },
      ],
    },
  };
}

function repoLine(context: string): string {
  const line = /^Repo: (.+)$/m.exec(context)?.[1]?.trim();
  assert.ok(line, `agent context must include Repo line; got ${context}`);
  return line;
}

function retryContext(input: unknown): Record<string, unknown> {
  assert.ok(input !== null && typeof input === 'object' && !Array.isArray(input), `step input must be an object; got ${input}`);
  const value = (input as Record<string, unknown>)['retryContext'];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `step input must include retryContext; got ${JSON.stringify(input)}`);
  return value as Record<string, unknown>;
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

test('RG234-D: agent needsHuman question -> answer resumes the same run and reaches the retrying agent', {
  skip: e2eSkip,
}, async () => {
  const target = createTargetRepo();
  const providerAnswer = { provider: 'oauth', reason: 'use existing OAuth tenant' };
  const regionAnswer = { region: 'eu', reason: 'match customer data residency' };
  try {
    const { runId } = await pipelineScenario(h, runCases, {
      title: 'RG234-D: analyst question resumes with answer',
      playbook: 'default',
      repo: target,
      coverage: coverageForScenario('RG234-D-agent-question-resume'),
      agent: analystAsksTwiceThenPasses(
        'which auth provider should the feature use?',
        'which region should the feature use?',
      ),
      gates: [
        {
          topic: 'question',
          answer: providerAnswer,
          summaryIncludes: ['analyst', 'which auth provider should the feature use?'],
        },
        {
          topic: 'question',
          answer: regionAnswer,
          summaryIncludes: ['analyst', 'which region should the feature use?'],
        },
        ['plan', 'approved'],
        { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' },
      ],
      expect: {
        terminal: 'completed',
        events: ['agent_question_opened', 'agent_question_resolved', 'run_completed'],
        noEvents: ['pipeline_blocked', 'run_recovery_created'],
      },
    });

    const analystCalls = h.agentCalls.filter((call) => call.runId === runId && call.role === 'analyst');
    assert.equal(analystCalls.length, 3, 'answered questions must retry the same analyst node in the same run');
    const context = retryContext(analystCalls[1]?.stepInput);
    assert.equal(context['kind'], 'agent_question');
    assert.equal(context['nodeId'], 'analyst');
    assert.deepEqual(context['answer'], providerAnswer);
    assert.equal(context['lesson'], 'which auth provider should the feature use?');
    assert.match(String(context['inboxId']), /^inbox_/);
    assert.equal(context['resolvedBy'], 'e2e');
    const secondContext = retryContext(analystCalls[2]?.stepInput);
    assert.equal(secondContext['kind'], 'agent_question');
    assert.equal(secondContext['nodeId'], 'analyst');
    assert.deepEqual(secondContext['answer'], regionAnswer);
    assert.equal(secondContext['lesson'], 'which region should the feature use?');
    assert.match(String(secondContext['inboxId']), /^inbox_/);
    assert.notEqual(secondContext['inboxId'], context['inboxId']);
    assert.equal(secondContext['resolvedBy'], 'e2e');
  } finally {
    target.cleanup();
  }
});
