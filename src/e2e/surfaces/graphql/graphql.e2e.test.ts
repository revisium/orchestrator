import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';
import {
  createGraphqlContext,
  graphqlStubAgentProfile,
  type GraphqlContext,
} from '../../support/graphql-context.js';

let graphql: GraphqlContext;

before(() => {
  if (!RUN_REAL_E2E) return;
  graphql = createGraphqlContext();
});

test('GraphQL HTTP and WebSocket preserve a filtered run lifecycle payload', { skip: e2eSkip }, async () => {
  const status = await graphql.execute<{
    status: { daemon: { running: boolean }; project: { org: string } };
  }>('query Status { status { daemon { running } project { org } } }');
  assert.equal(status.status, 200);
  assert.deepEqual(status.errors, []);
  assert.equal(status.data?.status.daemon.running, true);
  assert.equal(status.data?.status.project.org, 'admin');

  const events = graphql.subscribe<{ runEventAppended: { runId: string; type: string } }>(
    'subscription { runEventAppended { runId type } }',
  );
  await events.ready();
  const created = await graphql.execute<{ createRun: { runId: string } }>(
    'mutation($data: CreateRunInput!) { createRun(data: $data) { runId } }',
    {
      data: {
        title: 'GraphQL subscription e2e',
        repo: '.',
        playbookId: 'revisium-agent-playbook',
        pipelineId: 'local-change',
        profile: graphqlStubAgentProfile(),
        start: false,
      },
    },
  );
  assert.deepEqual(created.errors, []);
  const runId = created.data?.createRun.runId;
  assert.ok(runId);

  const detail = await graphql.execute<{
    run: { id: string; status: string; title: string };
    runWorkflow: {
      run: { id: string; status: string };
      pipeline: { pipelineId: string; playbookId: string; status: string };
      nodes: Array<{ id: string; kind: string; status: string }>;
      edges: Array<{ from: string; to: string; kind: string }>;
      currentNodeIds: string[];
      usage: { costAmount: number };
      pendingInbox: Array<{ id: string }>;
      activity: Array<{ type: string }>;
    };
    runAttempts: { totalCount: number };
  }>(
    [
      'query($id: ID!, $attempts: GetRunAttemptsInput!) {',
      '  run(id: $id) { id status title }',
      '  runWorkflow(id: $id) {',
      '    run { id status }',
      '    pipeline { pipelineId playbookId status }',
      '    nodes { id kind status }',
      '    edges { from to kind }',
      '    currentNodeIds',
      '    usage { costAmount }',
      '    pendingInbox { id }',
      '    activity { type }',
      '  }',
      '  runAttempts(data: $attempts) { totalCount }',
      '}',
    ].join('\n'),
    { id: runId, attempts: { runId } },
  );
  assert.deepEqual(detail.errors, []);
  assert.equal(detail.data?.run.id, runId);
  assert.equal(detail.data?.run.status, 'ready');
  assert.equal(detail.data?.run.title, 'GraphQL subscription e2e');
  assert.equal(detail.data?.runWorkflow.pipeline.pipelineId, 'local-change');
  assert.equal(detail.data?.runWorkflow.pipeline.playbookId, 'revisium-agent-playbook');
  assert.equal(detail.data?.runWorkflow.pipeline.status, 'NOT_STARTED');
  assert.ok(detail.data?.runWorkflow.nodes.some((node) => node.id === 'developer' && node.kind === 'agent'));
  assert.ok(detail.data?.runWorkflow.edges.some((edge) => edge.from === 'developer' && edge.to === 'doneEnd'));
  assert.deepEqual(detail.data?.runWorkflow.currentNodeIds, []);
  assert.equal(detail.data?.runWorkflow.usage.costAmount, 0);
  assert.equal(detail.data?.runWorkflow.pendingInbox.length, 0);
  assert.equal(detail.data?.runWorkflow.activity[0]?.type, 'run_created');
  assert.equal(detail.data?.runAttempts.totalCount, 0);

  const payload = await events.waitFor((result) =>
    result.data?.runEventAppended.runId === runId && result.data.runEventAppended.type === 'run_created',
  );
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.data?.runEventAppended.runId, runId);
});

test('GraphQL HTTP retains partial data and protocol-visible resolver errors', { skip: e2eSkip }, async () => {
  const result = await graphql.execute<{
    status: { daemon: { running: boolean } };
    runAgentActivity: null;
  }>(
    'query { status { daemon { running } } runAgentActivity(runId: "run_does_not_exist") { runId } }',
  );

  assert.equal(result.status, 200);
  assert.equal(result.data?.status.daemon.running, true);
  assert.equal(result.data?.runAgentActivity, null);
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0]?.message ?? '', /not found|does not exist/i);
  assert.deepEqual(result.errors[0]?.path, ['runAgentActivity']);
});
