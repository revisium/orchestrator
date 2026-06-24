import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  createTargetRepo,
  type TargetRepo,
  waitState,
  PLAYBOOK_ID,
} from './kit/index.js';
import { AGENT_OUTPUT_STREAM_KEY, type AgentOutputEvent } from '../observability/types.js';
import type { RunAgent } from '../worker/runner.js';

// Slice 128 — the "subscribe to updates from agents" feature. The agent-output DBOS stream must carry
// the agent's reporter events end-to-end through the REAL data-driven engine, so subscriptions stream
// live and `runAgentLog`/`runAgentActivity` serve them post-hoc.
//
// Why this test exists: every other e2e uses the default fake agent, which NEVER touches the reporter.
// That is the exact coverage gap that let the agent-output regression ship unnoticed — a real run wrote
// 0 stream events while everything looked green. This agent emits per-turn events like the real
// claude-code runner (started → spawned → output → parsed → finished) IN ADDITION to its final result.

const MARKER = 'AGENT-LOG-MARKER-128';

const reporterFiringAgent: RunAgent = async (args) => {
  args.reporter?.started();
  args.reporter?.spawned(4242);
  args.reporter?.output('stdout', `${MARKER} hello from the agent`);
  args.reporter?.parsed({ type: 'assistant', preview: 'doing the work' });
  args.reporter?.finished({ exitCode: 0, timedOut: false });
  return {
    output: { ok: true },
    verdict: 'approved',
    artifacts: { process: { ref: `test-artifacts/${args.attemptId}`, stdoutTail: MARKER, stderrTail: '' } },
    nextSteps: [],
    costs: [{ modelProfile: args.profile.level, currency: 'USD', inputTokens: 1, outputTokens: 1, costAmount: 0 }],
    needsHuman: false,
  };
};

let h: RunHarness;
let target: TargetRepo;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: () => reporterFiringAgent });
  await givenInstalledPlaybook(h);
  target = createTargetRepo();
});

after(async () => {
  await h?.close();
});

test('agent-output stream: a run persists the agent reporter events for later reads', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'agent observability stream e2e',
    description: 'slice 128 — reporter events must reach the agent-output stream',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'local-change',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  await h.api.startRun({ runId: created.runId });

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, 'completed', `local-change run must complete; got ${terminal.state}`);

  // The reporter events must be readable from the run's DBOS agent-output stream.
  const events: AgentOutputEvent[] = [];
  for await (const ev of h.dbos.readStream<AgentOutputEvent>(created.runId, AGENT_OUTPUT_STREAM_KEY)) {
    events.push(ev);
  }

  assert.ok(events.length > 0, `expected agent-output reporter events on the stream, got ${events.length}`);
  assert.ok(
    events.some((ev) => JSON.stringify(ev).includes(MARKER)),
    'the agent output emitted via the reporter must be retrievable from the stream',
  );
});
