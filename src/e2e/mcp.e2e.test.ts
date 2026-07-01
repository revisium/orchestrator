import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  createTargetRepo,
  createMcpInvoker,
  type McpInvoker,
} from './kit/index.js';

// Group H — the MCP SURFACE (the AI-client-facing interface). Every tool runs through the REAL MCP
// layer: createMcpInvoker builds the McpFacadeService + registered handlers and invokes them by name,
// so each call exercises the same zod validation, dispatch, error mapping, and JSON result shape the
// live stdio server uses. One shared host.

let h: RunHarness;
let mcp: McpInvoker;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
  mcp = createMcpInvoker(h.api);
});

after(async () => {
  if (h) await h.close();
});

/** Invoke a tool by name, typed as the parsed JSON the client would receive. */
const inv = <T = Record<string, unknown>>(name: string, args?: Record<string, unknown>) =>
  mcp.invoke(name, args) as Promise<T>;

type AttentionResult = { runId: string; state: string; nextAction: string; requiresAttention: boolean; inbox?: { id: string } };
type WatchChangesResult = { transitions: Array<{ runId: string; state: string; inbox?: { id: string } }>; cursor: string; timedOut: boolean };

/**
 * Poll get_run_attention until nextAction reaches the target value or 'done'.
 * Bounded by retries to keep the suite wait-bounded (e2e perf contract).
 */
async function attentionUntil(runId: string, target: string, retries = 20): Promise<AttentionResult> {
  for (let i = 0; i < retries; i++) {
    const att = await inv<AttentionResult>('get_run_attention', { runId });
    if (att.nextAction === target || att.nextAction === 'done') return att;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`run ${runId} did not reach nextAction=${target} after ${retries} retries`);
}

test('H1: create_run → start_run → get_run_attention → get_run round-trips a run to completion', { skip: e2eSkip }, async () => {
  // MCP strips runner overrides (safety), so the real runner runs a live preflight — use a clean
  // throwaway repo so local-change reaches completion.
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP local-change',
      repo: target.worktree,
      pipelineId: 'local-change',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await inv('start_run', { runId: created.runId });
    const settled = await attentionUntil(created.runId, 'done');
    assert.equal(settled.nextAction, 'done');
    const detail = await inv<{ run: { status: string } }>('get_run', { runId: created.runId, includeEvents: true });
    assert.equal(detail.run.status, 'completed');
  } finally {
    target.cleanup();
  }
});

test('H2: a feature run drives plan + merge gates entirely through MCP tools', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP feature gates',
      repo: target.worktree,
      pipelineId: 'feature-development',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree); // faked developer change so the real integrator has a diff
    await inv('start_run', { runId: created.runId });

    for (let i = 0; i < 2; i++) {
      const att = await attentionUntil(created.runId, 'ask_human');
      assert.equal(att.nextAction, 'ask_human', `gate ${i + 1} should require attention`);
      assert.ok(att.inbox?.id, 'pending_gate must surface the inbox item');
      assert.equal(att.requiresAttention, true);
      await inv('resolve_gate', { inboxId: att.inbox.id, outcome: 'approved', resolvedBy: 'mcp-e2e' });
    }
    const done = await attentionUntil(created.runId, 'done');
    assert.equal(done.nextAction, 'done');
  } finally {
    target.cleanup();
  }
});

test('H11: watch_run_changes delivers gates and terminal under a single advancing cursor', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP watch-changes cursor',
      repo: target.worktree,
      pipelineId: 'feature-development',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await inv('start_run', { runId: created.runId });

    let cursor: string | undefined;

    const nextTransition = async (targetState: string): Promise<string | undefined> => {
      for (let i = 0; i < 6; i++) {
        const res = await inv<WatchChangesResult>('watch_run_changes', {
          runId: created.runId,
          timeoutMs: 10_000,
          ...(cursor ? { cursor } : {}),
        });
        cursor = res.cursor;
        const match = res.transitions.find((t) => t.state === targetState);
        if (match) return match.inbox?.id;
      }
      return undefined;
    };

    for (let g = 0; g < 2; g++) {
      const inboxId = await nextTransition('pending_gate');
      assert.ok(inboxId, `gate ${g + 1} inbox must be surfaced via watch_run_changes`);
      await inv('resolve_gate', { inboxId, outcome: 'approved', resolvedBy: 'mcp-e2e' });
    }

    let completed = false;
    for (let i = 0; i < 6 && !completed; i++) {
      const res = await inv<WatchChangesResult>('watch_run_changes', {
        runId: created.runId,
        timeoutMs: 10_000,
        ...(cursor ? { cursor } : {}),
      });
      cursor = res.cursor;
      completed = res.transitions.some((t) => t.state === 'completed');
    }
    assert.ok(completed, 'watch_run_changes surfaces the terminal transition under advancing cursor');
  } finally {
    target.cleanup();
  }
});

test('H3: create_run → cancel_run marks the run cancelled', { skip: e2eSkip }, async () => {
  const created = await inv<{ runId: string }>('create_run', {
    title: 'E2E MCP cancel',
    repo: process.cwd(),
    pipelineId: 'local-change',
    start: false,
  });
  const res = await inv<{ status: string }>('cancel_run', { runId: created.runId });
  assert.equal(res.status, 'cancelled');
  const detail = await inv<{ run: { status: string } }>('get_run', { runId: created.runId });
  assert.equal(detail.run.status, 'cancelled');
});

test('H4: simulate_route strips runner-override smuggling from public params', { skip: e2eSkip }, async () => {
  const route = await inv<{ executionProfile: { runnerOverrides: Record<string, string> }; params: Record<string, unknown> }>(
    'simulate_route',
    {
      title: 'E2E MCP route safety',
      pipeline: 'local-change',
      includeDetails: true,
      params: {
        executionProfile: { runnerOverrides: { 'claude-code': 'must-not-leak' } },
        runnerOverrides: { 'claude-code': 'must-not-leak' },
        feature: 'ok-public-param',
      },
    },
  );
  assert.deepEqual(route.executionProfile.runnerOverrides, {}, 'public params must not smuggle runner overrides via MCP');
  assert.ok(!('runnerOverrides' in route.params), 'sanitized params must drop runnerOverrides');
  assert.ok(!('executionProfile' in route.params), 'sanitized params must drop executionProfile');
});

test('H5: create_run with a missing required field is rejected by schema validation', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () => mcp.invoke('create_run', { repo: process.cwd() }), // no title
    (err: unknown) => (err as Error).name === 'ZodError',
    'missing title must fail zod validation before reaching the API',
  );
});

test('H6: get_run on an unknown run maps to ROW_NOT_FOUND', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () => mcp.invoke('get_run', { runId: 'run_does_not_exist' }),
    (err: unknown) => (err as { code?: string }).code === 'ROW_NOT_FOUND',
  );
});

test('H7: gate-only verbs are enforced — answer_question on a gate is rejected; approve_gate on an unknown id is ROW_NOT_FOUND', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP gate enforcement',
      repo: target.worktree,
      pipelineId: 'feature-development',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await inv('start_run', { runId: created.runId });
    const att = await attentionUntil(created.runId, 'ask_human');
    assert.equal(att.nextAction, 'ask_human');
    const inboxId = att.inbox?.id;
    assert.ok(inboxId, 'pending_gate must surface the inbox item');
    await assert.rejects(
      () => mcp.invoke('answer_question', { inboxId, answer: { nope: true } }),
      (err: unknown) => (err as { code?: string }).code === 'VALIDATION_FAILURE',
    );
    await assert.rejects(
      () => mcp.invoke('approve_gate', { inboxId: 'inbox_missing' }),
      (err: unknown) => (err as { code?: string }).code === 'ROW_NOT_FOUND',
    );
    // Settle cleanly: cancel the named plan gate so the workflow terminates and the shared harness stays clean.
    await inv('resolve_gate', { inboxId, outcome: 'cancel', resolvedBy: 'mcp-e2e' });
  } finally {
    target.cleanup();
  }
});

test('H8: get_capabilities advertises the full stdio tool set with new observation names', { skip: e2eSkip }, async () => {
  const caps = await inv<{ transport: string; auth: string; tools: string[] }>('get_capabilities');
  assert.equal(caps.transport, 'stdio');
  assert.equal(caps.auth, 'none');
  assert.deepEqual([...caps.tools].sort(), [...mcp.toolNames].sort(), 'advertised tools match the registered handlers');
  for (const t of ['create_run', 'start_run', 'get_run_attention', 'get_run_status', 'watch_run_changes', 'approve_gate', 'resolve_gate', 'get_run']) {
    assert.ok(caps.tools.includes(t), `capabilities must list ${t}`);
  }
  assert.equal(caps.tools.includes('observe_run'), false, 'observe_run must not be advertised');
  assert.equal(caps.tools.includes('wait_for_run'), false, 'wait_for_run must not be advertised');
  assert.equal(caps.tools.includes('wait_for_any_gate'), false, 'wait_for_any_gate must not be advertised');
  assert.equal(caps.tools.includes('watch_runs'), false, 'watch_runs must not be advertised');
});

test('H9: catalog tools reflect the installed playbook', { skip: e2eSkip }, async () => {
  const pipelines = await inv<unknown[]>('list_pipelines');
  const roles = await inv<unknown[]>('list_roles');
  const playbooks = await inv<Array<{ id: string }>>('list_playbooks');
  assert.ok(pipelines.length > 0, 'list_pipelines must return the installed catalog');
  assert.ok(roles.length > 0, 'list_roles must return the installed catalog');
  assert.ok(playbooks.some((p) => p.id === PLAYBOOK_ID), 'list_playbooks must include the installed playbook');
});

test('H12: create_run response includes monitoring directive by default (shape-only, no run completion)', { skip: e2eSkip }, async () => {
  const created = await inv<{ runId: string; monitoring?: Record<string, unknown> }>('create_run', {
    title: 'E2E monitoring directive shape',
    repo: process.cwd(),
    pipelineId: 'local-change',
    start: false,
  });
  try {
    assert.equal(created.monitoring?.nextAction, 'monitor', 'monitoring.nextAction must be "monitor"');
    assert.equal(created.monitoring?.pollTool, 'get_run_attention', 'monitoring.pollTool must be get_run_attention');
    assert.equal(created.monitoring?.runId, created.runId, 'monitoring.runId must match runId');
    assert.ok(Array.isArray(created.monitoring?.protocol) && (created.monitoring.protocol as unknown[]).length > 0, 'monitoring.protocol must be a non-empty array');
    assert.equal(created.monitoring?.role, 'operator/humanGate', 'monitoring.role must be operator/humanGate');
    assert.equal((created.monitoring?.clientHints as Record<string, unknown>)?.advisory, true, 'clientHints.advisory must be true');
  } finally {
    await inv('cancel_run', { runId: created.runId });
  }
});

test('H12b: create_run with includeMonitoringGuidance:false omits the monitoring directive', { skip: e2eSkip }, async () => {
  const created = await inv<{ runId: string; monitoring?: Record<string, unknown> }>('create_run', {
    title: 'E2E no monitoring directive',
    repo: process.cwd(),
    pipelineId: 'local-change',
    start: false,
    includeMonitoringGuidance: false,
  });
  try {
    assert.equal('monitoring' in created, false, 'monitoring must be absent when includeMonitoringGuidance is false');
  } finally {
    await inv('cancel_run', { runId: created.runId });
  }
});

test('H12c: start_run response includes monitoring directive', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E start_run monitoring',
      repo: target.worktree,
      pipelineId: 'local-change',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    const started = await inv<{ runId?: string; monitoring?: Record<string, unknown> }>('start_run', { runId: created.runId });
    assert.equal(started.monitoring?.nextAction, 'monitor', 'start_run monitoring.nextAction must be "monitor"');
    assert.equal(started.monitoring?.pollTool, 'get_run_attention', 'start_run monitoring.pollTool must be get_run_attention');
  } finally {
    target.cleanup();
  }
});

test('H10: inspection tools reflect a completed run', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP inspection',
      repo: target.worktree,
      pipelineId: 'local-change',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await inv('start_run', { runId: created.runId });
    const settled = await attentionUntil(created.runId, 'done');
    assert.equal(settled.nextAction, 'done');
    let events = await inv<Array<{ type: string }>>('get_run_events', { runId: created.runId, limit: 500 });
    for (let waited = 0; waited < 15_000 && !events.some((e) => e.type === 'run_completed'); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      events = await inv<Array<{ type: string }>>('get_run_events', { runId: created.runId, limit: 500 });
    }
    assert.ok(events.some((e) => e.type === 'run_completed'), 'MCP get_run_events must show run_completed');
    const digest = await inv<{ run: { status: string } }>('get_run_digest', { runId: created.runId });
    assert.equal(digest.run.status, 'completed');
  } finally {
    target.cleanup();
  }
});
