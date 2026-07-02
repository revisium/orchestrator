import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'graphql-ws';
import { findFreePort } from '../config.js';
import { startGraphqlHost, type StartedGraphqlHost } from '../http/graphql-host.js';
import { RUN_REAL_E2E, e2eSkip } from './kit/index.js';

let host: StartedGraphqlHost | null = null;

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  assert.ok(host, 'GraphQL host must be started');
  const response = await fetch(host.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join('; '));
  }
  assert.ok(json.data, 'GraphQL response must include data');
  return json.data;
}

/**
 * Subscribe and buffer every payload; `waitFor` resolves with the first one `match` accepts
 * (buffered or future). The subscription is global and the control-plane is shared across
 * concurrently running e2e files, so "the first event" can belong to a neighbour file's run —
 * callers must select their own, and the matching payload may arrive before its id is even known
 * (hence the buffer, not a one-shot predicate).
 */
function subscribeCollect<T>(query: string, variables?: Record<string, unknown>) {
  assert.ok(host, 'GraphQL host must be started');
  const client = createClient({ url: host.url.replace('http://', 'ws://') });
  const buffer: T[] = [];
  let failure: unknown;
  let notify: (() => void) | undefined;
  const dispose = client.subscribe(
    { query, variables },
    {
      next(value) {
        buffer.push(value.data as T);
        notify?.();
      },
      error(error) {
        failure = error;
        notify?.();
      },
      complete() {},
    },
  );
  return {
    async waitFor(match: (payload: T) => boolean, timeoutMs = 10_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      try {
        for (;;) {
          if (failure) throw failure;
          const hit = buffer.find(match);
          if (hit) return hit;
          if (Date.now() >= deadline) throw new Error('subscription event not observed before timeout');
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, 100);
          });
        }
      } finally {
        dispose();
        void client.dispose();
      }
    },
  };
}

before(async () => {
  if (!RUN_REAL_E2E) return;
  host = await startGraphqlHost({ port: await findFreePort(19600) });
});

after(async () => {
  await host?.app.close();
  host = null;
});

test('GraphQL real host: read path → createRun mutation → subscription payload', { skip: e2eSkip }, async () => {
  const status = await graphql<{ status: { daemon: { running: boolean }; project: { org: string } } }>(
    'query Status { status { daemon { running } project { org } } }',
  );
  assert.equal(status.status.daemon.running, true);
  assert.equal(status.status.project.org, 'admin');

  const events = subscribeCollect<{ runEventAppended: { runId: string; type: string } }>(
    'subscription { runEventAppended { runId type } }',
  );
  const created = await graphql<{ createRun: { runId: string } }>(
    'mutation($data: CreateRunInput!) { createRun(data: $data) { runId } }',
    {
      data: {
        title: 'GraphQL subscription e2e',
        repo: '.',
        playbookId: 'revisium-agent-playbook',
        pipelineId: 'local-change',
        start: false,
      },
    },
  );
  const detail = await graphql<{ run: { id: string; status: string; title: string } }>(
    'query($id: ID!) { run(id: $id) { id status title } }',
    { id: created.createRun.runId },
  );
  const workflow = await graphql<{
    runWorkflow: {
      run: { id: string; status: string };
      pipeline: { pipelineId: string; playbookId: string; status: string };
      nodes: Array<{ id: string; kind: string; status: string }>;
      edges: Array<{ from: string; to: string; kind: string }>;
      currentNodeIds: string[];
      attempts: Array<{ id: string }>;
      usage: { inputTokens: number; outputTokens: number; costAmount: number };
      pendingInbox: Array<{ id: string }>;
      activity: Array<{ type: string }>;
    };
    runAttempts: { totalCount: number };
  }>(
    [
      'query($id: ID!, $attempts: GetRunAttemptsInput!) {',
      '  runWorkflow(id: $id) {',
      '    run { id status }',
      '    pipeline { pipelineId playbookId status }',
      '    nodes { id kind status }',
      '    edges { from to kind }',
      '    currentNodeIds',
      '    attempts { id }',
      '    usage { inputTokens outputTokens costAmount }',
      '    pendingInbox { id }',
      '    activity { type }',
      '  }',
      '  runAttempts(data: $attempts) { totalCount }',
      '}',
    ].join('\n'),
    { id: created.createRun.runId, attempts: { runId: created.createRun.runId } },
  );
  const payload = await events.waitFor(
    (p) => p.runEventAppended.runId === created.createRun.runId && p.runEventAppended.type === 'run_created',
  );
  assert.equal(detail.run.id, created.createRun.runId);
  assert.equal(detail.run.status, 'ready');
  assert.equal(detail.run.title, 'GraphQL subscription e2e');
  assert.equal(workflow.runWorkflow.run.id, created.createRun.runId);
  assert.equal(workflow.runWorkflow.pipeline.pipelineId, 'local-change');
  assert.equal(workflow.runWorkflow.pipeline.playbookId, 'revisium-agent-playbook');
  assert.equal(workflow.runWorkflow.pipeline.status, 'NOT_STARTED');
  assert.ok(workflow.runWorkflow.nodes.some((node) => node.id === 'developer' && node.kind === 'agent'));
  assert.ok(workflow.runWorkflow.edges.some((edge) => edge.from === 'developer' && edge.to === 'doneEnd'));
  assert.deepEqual(workflow.runWorkflow.currentNodeIds, []);
  assert.equal(workflow.runWorkflow.usage.costAmount, 0);
  assert.equal(workflow.runWorkflow.pendingInbox.length, 0);
  assert.equal(workflow.runWorkflow.activity[0]?.type, 'run_created');
  assert.equal(workflow.runAttempts.totalCount, 0);
  assert.equal(payload.runEventAppended.runId, created.createRun.runId);
  assert.equal(payload.runEventAppended.type, 'run_created');
});
