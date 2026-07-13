import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';
import {
  createMcpContext,
  type McpAttention,
  type McpContext,
} from '../../support/mcp-context.js';

let mcp: McpContext;

const PLAN_OPTIONS = ['approved', 'rework', 'cancel'] as const;
const MERGE_OPTIONS = [
  'approved',
  'recheck',
  'address_review_threads',
  'return_to_development',
  'override_merge',
  'cancel',
] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  mcp = await createMcpContext();
});

after(async () => {
  if (mcp) await mcp.close();
});

function value<T>(result: Readonly<{ isError: boolean; text: string; data?: T }>): T {
  assert.equal(result.isError, false, result.text);
  assert.notEqual(result.data, undefined, 'successful MCP result must contain parsed JSON');
  return result.data as T;
}

function inlineConsensusProfile(role: 'analyst' | 'developer', permissionMode: 'read-only' | 'workspace-write') {
  if (role === 'analyst') {
    return {
      schemaVersion: 'run-profile/v1',
      topology: { stages: { analyst: { mode: 'consensus', branches: 2 } } },
      bindings: {
        slots: {
          'node:analystPrimary': {
            runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {}, permissionMode,
          },
          'node:analystSecondary': {
            runnerId: 'claude-code', provider: 'anthropic', modelId: 'claude-opus-4-8', modelParams: {}, permissionMode: 'plan',
          },
        },
      },
    };
  }
  return {
    schemaVersion: 'run-profile/v1',
    topology: { stages: { [role]: { mode: 'consensus', branches: 2 } } },
    bindings: {
      slots: {
        [`role:${role}`]: {
          runnerId: 'codex',
          provider: 'openai',
          modelId: 'gpt-5.6-luna',
          modelParams: {},
          permissionMode,
        },
      },
    },
  };
}

async function expectGate(inboxId: string, topic: string, options: readonly string[]): Promise<void> {
  const gate = value(await mcp.gate(inboxId));
  assert.equal(gate.topic, topic);
  assert.deepEqual(gate.options, options);
  assert.ok(gate.options.includes('approved'));
}

test('H1: real stdio create/start/attention/get completes a local-change run', { skip: e2eSkip }, async () => {
  const tools = await mcp.toolNames();
  for (const name of ['create_run', 'start_run', 'get_run_attention', 'get_run']) {
    assert.ok(tools.includes(name), `stdio discovery must include ${name}`);
  }
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio local-change',
      pipelineId: 'local-change',
      start: false,
    }));
    runId = created.runId;
    value(await mcp.call('start_run', { runId }));
    const attention = value(await mcp.attentionUntil(runId, 'done'));
    assert.equal(attention.nextAction, 'done');
    const detail = value(await mcp.call<{ run: { status: string } }>('get_run', {
      runId,
      includeEvents: true,
    }));
    assert.equal(detail.run.status, 'completed');
  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});

test('H1b: real stdio simulate_route accepts analysis consensus and rejects developer consensus', { skip: e2eSkip }, async () => {
  const analysis = await mcp.call<Record<string, unknown>>('simulate_route', {
    title: 'MCP analysis consensus',
    pipelineId: 'analysis-only',
    profile: inlineConsensusProfile('analyst', 'read-only'),
    includeDetails: true,
  });
  const analysisRoute = value(analysis) as {
    executionPlan?: {
      selection?: { requestedPipelineId?: string; basePipelineId?: string };
      profile?: { source?: string; profileHash?: string; profileId?: string; profileVersion?: string };
      pipeline?: { executableGraph?: Record<string, unknown>; graphDigest?: string; materializerVersion?: string };
      agentBindings?: Array<Record<string, unknown>>;
      executionPlanDigest?: string;
    };
    executionPlanBytes?: string;
    executionPlanDigest?: string;
  };
  const analysisGraph = analysisRoute.executionPlan?.pipeline?.executableGraph;
  assert.equal((analysisGraph as { entry?: string } | undefined)?.entry, 'analystFanout');
  assert.deepEqual((analysisGraph as { nodes?: Record<string, { merge?: unknown }> } | undefined)?.nodes?.['analystJoin']?.merge, {
    analysis: 'appendByBranchOrder',
  });
  assert.equal(analysisRoute.executionPlan?.selection?.requestedPipelineId, 'analysis-only');
  assert.equal(analysisRoute.executionPlan?.selection?.basePipelineId, 'analysis-only');
  assert.equal(analysisRoute.executionPlan?.profile?.source, 'inline');
  assert.equal(analysisRoute.executionPlan?.profile?.profileId, undefined);
  assert.equal(analysisRoute.executionPlan?.profile?.profileVersion, undefined);
  assert.equal(analysisRoute.executionPlan?.pipeline?.materializerVersion, '2');
  assert.deepEqual(analysisRoute.executionPlan?.agentBindings?.map((binding) => ({
    slotKey: binding.slotKey, nodeId: binding.nodeId, roleId: binding.roleId, runnerId: binding.runnerId,
    provider: binding.provider, modelId: binding.modelId, permissionMode: binding.permissionMode, permissionSource: binding.permissionSource,
  })), [
    { slotKey: 'node:analystPrimary', nodeId: 'analystPrimary', roleId: 'analyst', runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', permissionMode: 'read-only', permissionSource: 'profile' },
    { slotKey: 'node:analystSecondary', nodeId: 'analystSecondary', roleId: 'analyst', runnerId: 'claude-code', provider: 'anthropic', modelId: 'claude-opus-4-8', permissionMode: 'plan', permissionSource: 'profile' },
  ]);

  const unsupported = await mcp.call('simulate_route', {
    title: 'MCP developer consensus must be rejected',
    pipelineId: 'local-change',
    profile: inlineConsensusProfile('developer', 'workspace-write'),
  });
  assert.equal(unsupported.isError, true);
  assert.equal(JSON.parse(unsupported.text).code, 'profile_topology_unsupported');
});

test('H2: real stdio drives plan and merge gates to a completed feature run', { skip: e2eSkip }, async () => {
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio feature gate',
      pipelineId: 'feature-development',
      start: false,
    }));
    runId = created.runId;
    value(await mcp.call('start_run', { runId }));
    for (const [topic, options] of [['plan', PLAN_OPTIONS], ['merge', MERGE_OPTIONS]] as const) {
      const attention: McpAttention = value<McpAttention>(await mcp.attentionUntil(runId, 'ask_human'));
      assert.equal(attention.nextAction, 'ask_human');
      assert.equal(attention.requiresAttention, true);
      assert.ok(attention.inbox?.id);
      await expectGate(attention.inbox.id, topic, options);
      value(await mcp.call('resolve_gate', {
        inboxId: attention.inbox.id,
        outcome: 'approved',
        resolvedBy: 'mcp-stdio-e2e',
      }));
    }
    const done = value(await mcp.attentionUntil(runId, 'done'));
    assert.equal(done.nextAction, 'done');
    const detail = value(await mcp.call<{ run: { status: string } }>('get_run', { runId }));
    assert.equal(detail.run.status, 'completed');
  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});

test('H3: real stdio create/cancel exposes cancelled state', { skip: e2eSkip }, async () => {
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio cancel',
      pipelineId: 'local-change',
      start: false,
    }));
    runId = created.runId;
    const cancelled = value(await mcp.call<{ status: string }>('cancel_run', { runId }));
    assert.equal(cancelled.status, 'cancelled');
    const detail = value(await mcp.call<{ run: { status: string } }>('get_run', { runId }));
    assert.equal(detail.run.status, 'cancelled');
  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});

test('H5: real stdio schema failure resolves as an actionable MCP error result', { skip: e2eSkip }, async () => {
  const result = await mcp.call('create_run', { repo: 'schema-only-repo' });
  assert.equal(result.isError, true);
  assert.match(result.text, /title/i);
});

test('H6: real stdio application failure resolves as an actionable MCP error result', { skip: e2eSkip }, async () => {
  const result = await mcp.call('get_run', { runId: 'run_does_not_exist' });
  assert.equal(result.isError, true);
  assert.match(result.text, /ROW_NOT_FOUND|not found/i);
});

test('H7: real stdio gate verb failures remain resolved MCP error results', { skip: e2eSkip }, async () => {
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio gate verb validation',
      pipelineId: 'feature-development',
      start: true,
    }));
    runId = created.runId;
    const attention = value(await mcp.attentionUntil(runId, 'ask_human'));
    assert.ok(attention.inbox?.id);

    const answer = await mcp.call('answer_question', {
      inboxId: attention.inbox.id,
      answer: { value: true },
    });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /gate|resolve_gate|VALIDATION_FAILURE/i);

    const approve = await mcp.call('approve_gate', { inboxId: attention.inbox.id });
    assert.equal(approve.isError, true);
    assert.match(approve.text, /resolve_gate|named gate|VALIDATION_FAILURE/i);

    const missing = await mcp.call('approve_gate', { inboxId: 'inbox_missing' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /ROW_NOT_FOUND|not found/i);

  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});

test('H10: real stdio inspection tools expose terminal events and digest', { skip: e2eSkip }, async () => {
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio inspection',
      pipelineId: 'local-change',
      start: true,
    }));
    runId = created.runId;
    value(await mcp.attentionUntil(runId, 'done'));
    const events = value(await mcp.eventsUntil(runId, 'run_completed'));
    assert.ok(events.some((event) => event.type === 'run_completed'));
    const digest = value(await mcp.call<{ run: { status: string } }>('get_run_digest', { runId }));
    assert.equal(digest.run.status, 'completed');
  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});

test('H11: real stdio cursor advances across both gates and completed terminal', { skip: e2eSkip }, async () => {
  let runId: string | undefined;
  try {
    const created = value(await mcp.createRun({
      title: 'E2E MCP stdio watch cursor',
      pipelineId: 'feature-development',
      start: true,
    }));
    runId = created.runId;
    let cursor: string | undefined;
    for (const [topic, options] of [['plan', PLAN_OPTIONS], ['merge', MERGE_OPTIONS]] as const) {
      const gate = await mcp.watchUntil(runId, 'pending_gate', cursor);
      assert.equal(gate.result.isError, false, gate.result.text);
      assert.ok(gate.cursor);
      assert.notEqual(gate.cursor, cursor);
      assert.ok(gate.inboxId);
      await expectGate(gate.inboxId, topic, options);
      value(await mcp.call('resolve_gate', {
        inboxId: gate.inboxId,
        outcome: 'approved',
        resolvedBy: 'mcp-stdio-e2e',
      }));
      cursor = gate.cursor;
    }
    const terminal = await mcp.watchUntil(runId, 'completed', cursor);
    assert.equal(terminal.result.isError, false, terminal.result.text);
    assert.notEqual(terminal.cursor, cursor);
    const detail = value(await mcp.call<{ run: { status: string } }>('get_run', { runId }));
    assert.equal(detail.run.status, 'completed');
  } finally {
    if (runId) await mcp.cleanupRun(runId);
  }
});
