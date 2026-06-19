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

// Group H — the MCP SURFACE (the AI-client-facing interface). Every tool is exercised through the
// REAL MCP layer: createMcpInvoker builds the McpFacadeService + the registered tool handlers and
// invokes them by name, so each call runs the same zod validation, dispatch, error mapping, and
// JSON result shape the live stdio server uses — not just the underlying API. One shared host.

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

// Small typed helpers — the invoker returns the parsed JSON the client would receive.
const inv = <T = Record<string, unknown>>(name: string, args?: Record<string, unknown>) =>
  mcp.invoke(name, args) as Promise<T>;

test('H1: create_run → start_run → wait_for_run → get_run round-trips a run to completion', { skip: e2eSkip }, async () => {
  // MCP strips runner overrides (safety), so the run uses the real runner — which runs a live
  // preflight. Use a CLEAN throwaway repo (not the dirty cwd) so local-change reaches completion.
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
    const settled = await inv<{ state: string }>('wait_for_run', { runId: created.runId, timeoutMs: 10_000, intervalMs: 500 });
    assert.equal(settled.state, 'completed');
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

    // plan gate → approve, merge gate → approve, then completed — all observed/resolved via MCP.
    for (let i = 0; i < 2; i++) {
      const st = await inv<{ state: string; inbox?: { id: string } }>('wait_for_run', {
        runId: created.runId,
        timeoutMs: 10_000,
        intervalMs: 500,
      });
      assert.equal(st.state, 'pending_gate', `gate ${i + 1} should park`);
      const inboxId = st.inbox?.id;
      assert.ok(inboxId, 'pending_gate must surface the inbox item');
      await inv('approve_gate', { inboxId, resolvedBy: 'mcp-e2e' });
    }
    const done = await inv<{ state: string }>('wait_for_run', { runId: created.runId, timeoutMs: 10_000, intervalMs: 500 });
    assert.equal(done.state, 'completed');
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
    const st = await inv<{ state: string; inbox?: { id: string } }>('wait_for_run', {
      runId: created.runId,
      timeoutMs: 10_000,
      intervalMs: 500,
    });
    assert.equal(st.state, 'pending_gate');
    const inboxId = st.inbox?.id;
    assert.ok(inboxId, 'pending_gate must surface the inbox item');
    // answer_question on a gate → VALIDATION_FAILURE (gates must use approve/reject)
    await assert.rejects(
      () => mcp.invoke('answer_question', { inboxId, answer: { nope: true } }),
      (err: unknown) => (err as { code?: string }).code === 'VALIDATION_FAILURE',
    );
    // approve_gate on an unknown inbox → ROW_NOT_FOUND
    await assert.rejects(
      () => mcp.invoke('approve_gate', { inboxId: 'inbox_missing' }),
      (err: unknown) => (err as { code?: string }).code === 'ROW_NOT_FOUND',
    );
    await inv('reject_gate', { inboxId }); // settle cleanly: reject the plan gate → cancelled, workflow terminates
  } finally {
    target.cleanup();
  }
});

test('H8: get_capabilities advertises the full stdio tool set', { skip: e2eSkip }, async () => {
  const caps = await inv<{ transport: string; auth: string; tools: string[] }>('get_capabilities');
  assert.equal(caps.transport, 'stdio');
  assert.equal(caps.auth, 'none');
  // The advertised tools match the handlers actually registered on the server.
  assert.deepEqual([...caps.tools].sort(), [...mcp.toolNames].sort());
  for (const t of ['create_run', 'start_run', 'wait_for_run', 'approve_gate', 'get_run']) {
    assert.ok(caps.tools.includes(t), `capabilities must list ${t}`);
  }
});

test('H9: catalog tools reflect the installed playbook', { skip: e2eSkip }, async () => {
  const pipelines = await inv<unknown[]>('list_pipelines');
  const roles = await inv<unknown[]>('list_roles');
  const playbooks = await inv<Array<{ id: string }>>('list_playbooks');
  assert.ok(pipelines.length > 0, 'list_pipelines must return the installed catalog');
  assert.ok(roles.length > 0, 'list_roles must return the installed catalog');
  assert.ok(playbooks.some((p) => p.id === PLAYBOOK_ID), 'list_playbooks must include the installed playbook');
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
    const settled = await inv<{ state: string }>('wait_for_run', { runId: created.runId, timeoutMs: 10_000, intervalMs: 500 });
    assert.equal(settled.state, 'completed');
    // Poll for the terminal `run_completed` event: it is appended just AFTER the run-row status patch,
    // so a read taken the instant wait_for_run returns can race the append (terminal-event-visibility flake).
    let events = await inv<Array<{ type: string }>>('get_run_events', { runId: created.runId });
    for (let waited = 0; waited < 5_000 && !events.some((e) => e.type === 'run_completed'); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      events = await inv<Array<{ type: string }>>('get_run_events', { runId: created.runId });
    }
    assert.ok(events.some((e) => e.type === 'run_completed'), 'get_run_events must show run_completed');
    const digest = await inv<{ run: { status: string } }>('get_run_digest', { runId: created.runId });
    assert.equal(digest.run.status, 'completed');
  } finally {
    target.cleanup();
  }
});
