import test from 'node:test';
import assert from 'node:assert/strict';
import { InboxResolver } from './inbox/inbox.resolver.js';
import { MethodResolver } from './method/method.resolver.js';
import { PrResolver } from './pr/pr.resolver.js';
import { RunDigestResolver } from './runs/run-digest.resolver.js';
import { RunEventsResolver } from './runs/run-events.resolver.js';
import { RunProgressResolver } from './runs/run-progress.resolver.js';
import { RunsResolver } from './runs/runs.resolver.js';

test('read-model resolvers delegate to domain api services', async () => {
  const calls: string[] = [];
  const runsApi = {
    listRuns: (data: unknown) => (calls.push(`runs:${JSON.stringify(data)}`), 'runs'),
    getRun: (data: unknown) => (calls.push(`run:${JSON.stringify(data)}`), 'run'),
    getRunEvents: (data: unknown) => (calls.push(`events:${JSON.stringify(data)}`), 'events'),
    getRunProgress: (data: unknown) => (calls.push(`progress:${JSON.stringify(data)}`), 'progress'),
    getRunDigest: (data: unknown) => (calls.push(`digest:${JSON.stringify(data)}`), 'digest'),
    simulateRoute: (data: unknown) => (calls.push(`route:${JSON.stringify(data)}`), 'route'),
  };
  const inboxApi = {
    listInbox: (data: unknown) => (calls.push(`inbox:${JSON.stringify(data)}`), 'inbox'),
    getInboxItem: (data: unknown) => (calls.push(`inboxItem:${JSON.stringify(data)}`), 'inboxItem'),
    pendingDecisions: (data: unknown) => (calls.push(`pending:${JSON.stringify(data)}`), 'pending'),
    gateRisk: (data: unknown) => (calls.push(`risk:${JSON.stringify(data)}`), 'risk'),
  };
  const methodApi = {
    listRoles: (data: unknown) => (calls.push(`roles:${JSON.stringify(data)}`), 'roles'),
    getRole: (data: unknown) => (calls.push(`role:${JSON.stringify(data)}`), 'role'),
    listPlaybooks: (data: unknown) => (calls.push(`playbooks:${JSON.stringify(data)}`), 'playbooks'),
    listPipelines: (data: unknown) => (calls.push(`pipelines:${JSON.stringify(data)}`), 'pipelines'),
    getPipeline: (data: unknown) => (calls.push(`pipeline:${JSON.stringify(data)}`), 'pipeline'),
  };
  const prApi = {
    prReadiness: (data: unknown) => (calls.push(`readiness:${JSON.stringify(data)}`), 'readiness'),
    prFeedback: (data: unknown) => (calls.push(`feedback:${JSON.stringify(data)}`), 'feedback'),
  };

  assert.equal(new RunsResolver(runsApi as never).runs(), 'runs');
  assert.equal(new RunsResolver(runsApi as never).run('run_1'), 'run');
  assert.equal(new RunsResolver(runsApi as never).runEvents({ runId: 'run_1', first: 1 }), 'events');
  assert.equal(new RunsResolver(runsApi as never).runDigest('run_1'), 'digest');
  assert.equal(new RunsResolver(runsApi as never).simulateRoute({ title: 'Build' }), 'route');
  assert.equal(new RunEventsResolver(runsApi as never).events({ id: 'run_1' } as never, 'created', 1, 'cursor'), 'events');
  assert.equal(new RunProgressResolver(runsApi as never).runProgress('run_1'), 'progress');
  assert.equal(new RunProgressResolver(runsApi as never).progress({ id: 'run_1' } as never), 'progress');
  assert.equal(new RunDigestResolver(runsApi as never).digest({ id: 'run_1' } as never), 'digest');
  assert.equal(new InboxResolver(inboxApi as never).inbox(), 'inbox');
  assert.equal(new InboxResolver(inboxApi as never).inboxItem('inbox_1'), 'inboxItem');
  assert.equal(new InboxResolver(inboxApi as never).pendingDecisions('run_1'), 'pending');
  assert.equal(new InboxResolver(inboxApi as never).gateRisk('inbox_1'), 'risk');
  assert.equal(new MethodResolver(methodApi as never).roles(), 'roles');
  assert.equal(new MethodResolver(methodApi as never).role('role_1'), 'role');
  assert.equal(new MethodResolver(methodApi as never).playbooks(), 'playbooks');
  assert.equal(new MethodResolver(methodApi as never).pipelines(), 'pipelines');
  assert.equal(new MethodResolver(methodApi as never).pipeline('pipe_1'), 'pipeline');
  assert.equal(new PrResolver(prApi as never).prReadiness({ repo: 'revisium/orchestrator' }), 'readiness');
  assert.equal(new PrResolver(prApi as never).prFeedback({ repo: 'revisium/orchestrator' }), 'feedback');
  assert.ok(calls.some((call) => call === 'digest:{"runId":"run_1"}'));
  assert.ok(calls.some((call) => call === 'events:{"runId":"run_1","type":"created","first":1,"after":"cursor"}'));
  assert.equal(calls.filter((call) => call === 'progress:{"runId":"run_1"}').length, 2);
});
