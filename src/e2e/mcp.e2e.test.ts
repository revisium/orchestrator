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

test('H1: create_run → start_run → wait_for_run → get_run round-trips a run to completion', { skip: e2eSkip }, async () => {
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

test('H11: wait_for_any_gate / watch_runs drive a feature run to completion with the gate inbox inline', { skip: e2eSkip }, async () => {
  type WatchResult = {
    transitions: Array<{ runId: string; state: string; inbox?: { id: string } }>;
    cursor: string;
    timedOut: boolean;
  };
  const target = createTargetRepo();
  try {
    const created = await inv<{ runId: string }>('create_run', {
      title: 'E2E MCP watch gates',
      repo: target.worktree,
      pipelineId: 'feature-development',
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await inv('start_run', { runId: created.runId });

    let cursor: string | undefined;
    // wait_for_any_gate holds the request open and polls; a few bounded re-calls cover a slow first gate.
    const nextGate = async (): Promise<string> => {
      for (let i = 0; i < 6; i++) {
        const res = await inv<WatchResult>('wait_for_any_gate', { runIds: [created.runId], timeoutMs: 10_000, cursor });
        cursor = res.cursor;
        const gate = res.transitions.find((t) => t.state === 'pending_gate');
        if (gate) {
          assert.equal(gate.runId, created.runId);
          assert.ok(gate.inbox?.id, 'wait_for_any_gate returns the gate inbox inline (no get_agent_attempts dig)');
          return gate.inbox.id;
        }
      }
      throw new Error('no gate surfaced via wait_for_any_gate');
    };

    for (let g = 0; g < 2; g++) {
      const inboxId = await nextGate(); // a NEW gate id each round → the cursor reports it past the prior one
      await inv('approve_gate', { inboxId, resolvedBy: 'mcp-e2e' });
    }

    let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      const res = await inv<WatchResult>('watch_runs', { runIds: [created.runId], timeoutMs: 10_000, cursor });
      cursor = res.cursor;
      done = res.transitions.some((t) => t.state === 'completed');
    }
    assert.ok(done, 'watch_runs surfaces the terminal transition');
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
    await assert.rejects(
      () => mcp.invoke('answer_question', { inboxId, answer: { nope: true } }),
      (err: unknown) => (err as { code?: string }).code === 'VALIDATION_FAILURE',
    );
    await assert.rejects(
      () => mcp.invoke('approve_gate', { inboxId: 'inbox_missing' }),
      (err: unknown) => (err as { code?: string }).code === 'ROW_NOT_FOUND',
    );
    // Settle cleanly: reject the plan gate so the workflow terminates and the shared harness stays clean.
    await inv('reject_gate', { inboxId });
  } finally {
    target.cleanup();
  }
});

test('H8: get_capabilities advertises the full stdio tool set', { skip: e2eSkip }, async () => {
  const caps = await inv<{ transport: string; auth: string; tools: string[] }>('get_capabilities');
  assert.equal(caps.transport, 'stdio');
  assert.equal(caps.auth, 'none');
  assert.deepEqual([...caps.tools].sort(), [...mcp.toolNames].sort(), 'advertised tools match the registered handlers');
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
    // Poll for run_completed. completeRun writes the event BEFORE patching the run-row status
    // (event-first), and it is an awaited workflow step — so by the time the workflow is terminal the
    // event is committed. But under load the events-table read can lag the run-row read just after the
    // run settles, so a single read taken when wait_for_run returns can miss it; poll until the read
    // path converges. The 15s ceiling is only spent on a rare slow runner — the common case exits on
    // poll #1-2 (it returns the instant run_completed is seen).
    let events = await inv<Array<{ type: string }>>('get_run_events', { runId: created.runId });
    for (let waited = 0; waited < 15_000 && !events.some((e) => e.type === 'run_completed'); waited += 250) {
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
