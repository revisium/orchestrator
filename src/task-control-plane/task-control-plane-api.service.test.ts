import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { InboxItem } from '../control-plane/inbox.js';
import type { DbosService } from '../engine/dbos.service.js';
import type { PipelineService } from '../pipeline/develop-task.workflow.js';
import type { InboxService } from '../revisium/inbox.service.js';
import type { PlaybooksService } from '../revisium/playbooks.service.js';
import type { RolesService } from '../revisium/roles.service.js';
import type { RunService } from '../revisium/run.service.js';
import { TaskControlPlaneApiService } from './task-control-plane-api.service.js';

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    kind: 'approval',
    runId: 'run-1',
    taskId: '',
    stepId: '',
    projectId: '',
    title: 'Plan approval',
    context: { topic: 'plan' },
    options: [],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-13T00:00:00.000Z',
    resolvedAt: '',
    ...overrides,
  };
}

function makeApi(overrides: {
  runService?: Partial<RunService>;
  inboxService?: Partial<InboxService>;
  rolesService?: Partial<RolesService>;
  playbooksService?: Partial<PlaybooksService>;
  pipelineService?: Partial<PipelineService>;
  dbosService?: Partial<DbosService>;
} = {}): TaskControlPlaneApiService {
  const runService: Partial<RunService> = {
    async createRun() {
      return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
    },
    async getRun() {
      return { rowId: 'run-1', data: { id: 'run-1' } };
    },
    async showRun() {
      return {
        run: {
          runId: 'run-1',
          title: 'Run',
          status: 'ready',
          priority: 0,
          createdAt: '2026-06-13T00:00:00.000Z',
          description: '',
          scope: '',
          repos: [],
        },
        tasks: [],
      };
    },
    async listRunEvents() {
      return [];
    },
    async listRunAttempts() {
      return [];
    },
    async appendEvent() {},
    async completeRun() {
      return null;
    },
    ...overrides.runService,
  };
  const inboxService: Partial<InboxService> = {
    async getInbox() {
      return makeInboxItem();
    },
    async resolveInbox(_id, answer) {
      return { status: 'pending' as const, answer };
    },
    async listInbox() {
      return [makeInboxItem()];
    },
    ...overrides.inboxService,
  };
  const rolesService: Partial<RolesService> = {
    async loadPipelinePolicy() {
      return { maxReviewIterations: 3, maxAttempts: 3, budgetUsd: 0, budgetTokens: 0 };
    },
    async listRoles() {
      return [
        {
          id: 'pb-developer',
          name: 'developer',
          modelLevel: 'standard',
          runner: 'claude-code',
          surface: 'any',
          rights: 'write-working-tree',
          playbookId: 'pb',
          playbookRoleId: 'developer',
        },
      ];
    },
    ...overrides.rolesService,
  };
  const playbooksService: Partial<PlaybooksService> = {
    async resolvePlaybook() {
      return {
        id: 'pb',
        name: 'PB',
        packageName: '@x/pb',
        version: '1.0.0',
        source: 'local:/pb',
        schemaVersion: 2,
      };
    },
    async listPipelines() {
      return [
        {
          id: 'pb-local-change',
          playbookId: 'pb',
          pipelineId: 'local-change',
          path: 'pipelines/local-change/PIPELINE.md',
          triggers: ['small local edit'],
          requiredRoles: ['developer'],
          alternativeRoles: [],
          optionalRoles: [],
          routeGates: [],
          executionPolicy: {},
        },
      ];
    },
    async resolvePipeline() {
      return {
        id: 'pb-local-change',
        playbookId: 'pb',
        pipelineId: 'local-change',
        path: 'pipelines/local-change/PIPELINE.md',
        triggers: ['small local edit'],
        requiredRoles: ['developer'],
        alternativeRoles: [],
        optionalRoles: [],
        routeGates: [],
        executionPolicy: {},
      };
    },
    async getPipeline() {
      return null;
    },
    ...overrides.playbooksService,
  };
  const pipelineService: Partial<PipelineService> = {
    async startDevelopTask(runId) {
      return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDevelopTask']>>;
    },
    ...overrides.pipelineService,
  };
  const dbosService: Partial<DbosService> = {
    async getWorkflowStatus() {
      return null;
    },
    async signal() {},
    ...overrides.dbosService,
  };
  return new TaskControlPlaneApiService(
    runService as RunService,
    inboxService as InboxService,
    rolesService as RolesService,
    playbooksService as PlaybooksService,
    pipelineService as PipelineService,
    dbosService as DbosService,
  );
}

test('TaskControlPlaneApiService.approveGate records retryable signal state around the DBOS signal', async () => {
  const calls: Array<
    | { kind: 'event'; type: string; stepKey: string; payload: unknown }
    | { kind: 'signal'; workflowId: string; topic: string; payload: unknown; key?: string }
  > = [];
  const api = makeApi({
    runService: {
      async appendEvent(input) {
        calls.push({ kind: 'event', type: input.type, stepKey: input.stepKey, payload: input.payload });
      },
    },
    dbosService: {
      async signal(workflowId, topic, payload, key) {
        calls.push({ kind: 'signal', workflowId, topic, payload, key });
      },
    },
  });

  const result = await api.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.equal(result.signaled, true);
  assert.equal(result.topic, 'plan');
  assert.deepEqual(calls, [
    {
      kind: 'event',
      type: 'gate_signal_pending',
      stepKey: 'gate:plan',
      payload: { inboxId: 'inbox-1', topic: 'plan' },
    },
    {
      kind: 'signal',
      workflowId: 'run-1',
      topic: 'plan',
      payload: { decision: 'approve', resolvedBy: 'tester' },
      key: 'inbox-1',
    },
    {
      kind: 'event',
      type: 'gate_signaled',
      stepKey: 'gate:plan',
      payload: { inboxId: 'inbox-1', topic: 'plan' },
    },
  ]);
});

test('TaskControlPlaneApiService.approveGate signals merge gates without completing the run', async () => {
  const completed: Array<{ runId: string; source?: string; actor?: string }> = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ title: 'Merge approval', context: { topic: 'merge' } });
      },
    },
    runService: {
      async completeRun(runId, opts) {
        completed.push({ runId, source: opts?.source, actor: opts?.actor });
        return { runId, previousStatus: 'ready', status: 'completed' };
      },
    },
  });

  const result = await api.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.equal(result.topic, 'merge');
  assert.deepEqual(completed, []);
});

test('TaskControlPlaneApiService.rejectGate signals merge gates without completing the run', async () => {
  const completed: Array<{ runId: string; source?: string; actor?: string }> = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ title: 'Merge rejection', context: { topic: 'merge' } });
      },
    },
    runService: {
      async completeRun(runId, opts) {
        completed.push({ runId, source: opts?.source, actor: opts?.actor });
        return { runId, previousStatus: 'ready', status: 'completed' };
      },
    },
  });

  const result = await api.rejectGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.equal(result.topic, 'merge');
  assert.deepEqual(completed, []);
});

test('TaskControlPlaneApiService.approveGate does NOT call completeRun for plan gates', async () => {
  let completeRunCalled = false;
  const api = makeApi({
    runService: {
      async completeRun() {
        completeRunCalled = true;
        return null;
      },
    },
  });

  const result = await api.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.equal(result.topic, 'plan');
  assert.equal(completeRunCalled, false, 'plan gates must not trigger completeRun');
});

test('TaskControlPlaneApiService.approveGate leaves pending signal state when DBOS signaling fails', async () => {
  const events: string[] = [];
  const api = makeApi({
    runService: {
      async appendEvent(input) {
        events.push(input.type);
      },
    },
    dbosService: {
      async signal() {
        throw new Error('signal failed');
      },
    },
  });

  await assert.rejects(() => api.approveGate({ inboxId: 'inbox-1' }), /signal failed/);
  assert.deepEqual(events, ['gate_signal_pending']);
});

test('TaskControlPlaneApiService.answerQuestion refuses gate rows so workflows are not left parked', async () => {
  const api = makeApi();
  await assert.rejects(
    () => api.answerQuestion({ inboxId: 'inbox-1', answer: 'yes' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('TaskControlPlaneApiService.answerQuestion resolves non-gate questions without signaling DBOS', async () => {
  let signaled = false;
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ kind: 'question', context: { topic: 'clarification' }, runId: 'run-1' });
      },
    },
    dbosService: {
      async signal() {
        signaled = true;
      },
    },
  });

  const result = await api.answerQuestion({ inboxId: 'inbox-1', answer: 'answer' });

  assert.equal(result.signaled, false);
  assert.equal(signaled, false);
});

test('TaskControlPlaneApiService.createRun can immediately start the workflow', async () => {
  const starts: Array<{ runId: string; pipelineId?: string; override?: string }> = [];
  const api = makeApi({
    pipelineService: {
      async startDevelopTask(runId, opts) {
        starts.push({
          runId,
          pipelineId: opts.route?.pipelineId,
          override: opts.route?.executionProfile.runnerOverrides['claude-code'],
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDevelopTask']>>;
      },
    },
  });

  const result = await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: true,
  });

  assert.equal(result.started, true);
  assert.deepEqual(starts, [{ runId: 'run-1', pipelineId: 'local-change', override: 'stub-agent' }]);
});

test('TaskControlPlaneApiService.createRun persists canonical pipeline id', async () => {
  let persistedPipelineId = '';
  const api = makeApi({
    runService: {
      async createRun(input) {
        persistedPipelineId = input.pipelineId ?? '';
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
    },
  });

  await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
  });

  assert.equal(persistedPipelineId, 'local-change');
});

test('TaskControlPlaneApiService.createRun ignores public params for runner profile selection', async () => {
  const starts: Array<{ override?: string; params: Record<string, unknown> }> = [];
  const api = makeApi({
    pipelineService: {
      async startDevelopTask(runId, opts) {
        starts.push({
          override: opts.route?.executionProfile.runnerOverrides['claude-code'],
          params: opts.route?.params ?? {},
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDevelopTask']>>;
      },
    },
  });

  await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
    params: { executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } }, ticket: 'ABC-1' },
    start: true,
  });

  assert.deepEqual(starts, [{ override: undefined, params: { ticket: 'ABC-1' } }]);
});

test('TaskControlPlaneApiService.simulateRoute rejects omitted pipelineId when no trigger matches', async () => {
  const api = makeApi();

  await assert.rejects(
    () => api.simulateRoute({ title: 'unrelated request text' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('pipelineId'),
  );
});

test('TaskControlPlaneApiService.simulateRoute rejects ambiguous positive auto-route decisions', async () => {
  const api = makeApi({
    playbooksService: {
      async listPipelines() {
        return [
          {
            id: 'pb-a',
            playbookId: 'pb',
            pipelineId: 'a',
            path: 'pipelines/a/PIPELINE.md',
            triggers: ['review task'],
            requiredRoles: ['developer'],
            alternativeRoles: [],
            optionalRoles: [],
            routeGates: [],
            executionPolicy: {},
          },
          {
            id: 'pb-b',
            playbookId: 'pb',
            pipelineId: 'b',
            path: 'pipelines/b/PIPELINE.md',
            triggers: ['review task'],
            requiredRoles: ['developer'],
            alternativeRoles: [],
            optionalRoles: [],
            routeGates: [],
            executionPolicy: {},
          },
        ];
      },
    },
  });

  await assert.rejects(
    () => api.simulateRoute({ title: 'review task' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('pipelineId'),
  );
});

test('TaskControlPlaneApiService.simulateRoute allows a positive confident installed route decision', async () => {
  const api = makeApi();

  const route = await api.simulateRoute({ title: 'small local edit' });

  assert.equal(route.pipelineId, 'local-change');
  assert.deepEqual(route.roles, ['developer']);
});

test('TaskControlPlaneApiService rejects stub-agent from production playbook role bindings', async () => {
  const api = makeApi({
    rolesService: {
      async listRoles() {
        return [
          {
            id: 'pb-developer',
            name: 'developer',
            modelLevel: 'standard',
            runner: 'stub-agent',
            surface: 'any',
            rights: 'write-working-tree',
            playbookId: 'pb',
            playbookRoleId: 'developer',
          },
        ];
      },
    },
  });

  await assert.rejects(
    () => api.simulateRoute({ title: 'small local edit' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('stub-agent'),
  );
});

test('TaskControlPlaneApiService.simulateRoute binds every required playbook role in order', async () => {
  const api = makeApi({
    rolesService: {
      async listRoles() {
        return [
          {
            id: 'pb-architect',
            name: 'architect',
            modelLevel: 'deep',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'architect',
          },
          {
            id: 'pb-analyst',
            name: 'analyst',
            modelLevel: 'standard',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'analyst',
          },
          {
            id: 'pb-watcher',
            name: 'watcher',
            modelLevel: 'cheap',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'watcher',
          },
        ];
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-analysis-only',
          playbookId: 'pb',
          pipelineId: 'analysis-only',
          path: 'pipelines/analysis-only/PIPELINE.md',
          triggers: ['analysis'],
          requiredRoles: ['architect', 'analyst', 'watcher'],
          alternativeRoles: [],
          optionalRoles: [],
          routeGates: [],
          executionPolicy: {},
        };
      },
    },
  });

  const route = await api.simulateRoute({ title: 'Analyze this', pipeline: 'analysis-only' });

  assert.deepEqual(route.requiredRoles, ['architect', 'analyst', 'watcher']);
  assert.deepEqual(route.roleBindings.map((item) => item.roleId), ['architect', 'analyst', 'watcher']);
  assert.deepEqual(route.roleBindings.map((item) => item.rowId), ['pb-architect', 'pb-analyst', 'pb-watcher']);
});

test('TaskControlPlaneApiService.simulateRoute binds canonical feature-development roles and gates', async () => {
  const api = makeApi({
    rolesService: {
      async listRoles() {
        return [
          {
            id: 'pb-orchestrator',
            name: 'orchestrator',
            modelLevel: 'standard',
            runner: 'claude-code',
            surface: 'any',
            rights: 'state and routing only',
            playbookId: 'pb',
            playbookRoleId: 'orchestrator',
          },
          {
            id: 'pb-analyst',
            name: 'analyst',
            modelLevel: 'deep',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'analyst',
          },
          {
            id: 'pb-reviewer',
            name: 'reviewer',
            modelLevel: 'deep',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'reviewer',
          },
          {
            id: 'pb-developer',
            name: 'developer',
            modelLevel: 'standard',
            runner: 'claude-code',
            surface: 'any',
            rights: 'write-working-tree',
            playbookId: 'pb',
            playbookRoleId: 'developer',
          },
          {
            id: 'pb-integrator',
            name: 'integrator',
            modelLevel: 'standard',
            runner: 'revo-integrator',
            surface: 'repo',
            rights: 'git and GitHub writes',
            playbookId: 'pb',
            playbookRoleId: 'integrator',
          },
          {
            id: 'pb-watcher',
            name: 'watcher',
            modelLevel: 'cheap',
            runner: 'claude-code',
            surface: 'repo',
            rights: 'read-only PR inspection',
            playbookId: 'pb',
            playbookRoleId: 'watcher',
          },
        ];
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-feature-development',
          playbookId: 'pb',
          pipelineId: 'feature-development',
          path: 'pipelines/feature-development/PIPELINE.md',
          triggers: ['new feature'],
          requiredRoles: ['orchestrator', 'analyst', 'reviewer', 'developer', 'integrator', 'watcher'],
          alternativeRoles: [],
          optionalRoles: [],
          routeGates: ['task spec approval', 'merge approval'],
          executionPolicy: {},
        };
      },
    },
  });

  const route = await api.simulateRoute({ title: 'Build feature', pipeline: 'feature-development' });

  assert.deepEqual(route.requiredRoles, ['orchestrator', 'analyst', 'reviewer', 'developer', 'integrator', 'watcher']);
  assert.deepEqual(route.roleBindings.map((item) => item.roleId), [
    'orchestrator',
    'analyst',
    'reviewer',
    'developer',
    'integrator',
    'watcher',
  ]);
  assert.deepEqual(route.routeGates, ['plan', 'merge']);
  assert.equal(route.roleBindings.find((item) => item.roleId === 'watcher')?.rowId, 'pb-watcher');
});

test('TaskControlPlaneApiService.validateRepository reports non-existent paths without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  const result = await makeApi().validateRepository(join(dir, 'missing'));

  assert.equal(result.exists, false);
  assert.equal(result.isDirectory, false);
  assert.equal(result.gitRoot, '');
  assert.equal(result.error, 'Path does not exist.');
});

test('TaskControlPlaneApiService.getRepositoryContext reports malformed package metadata without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8');

  const result = await makeApi().getRepositoryContext(dir);

  assert.notEqual(result.gitRoot, '');
  assert.equal(result.packageName, '');
  assert.deepEqual(result.scripts, []);
  assert.match(result.packageError, /JSON/);
});

test('TaskControlPlaneApiService.getRepositoryContext ignores non-object package scripts metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', scripts: 'oops' }), 'utf8');

  const result = await makeApi().getRepositoryContext(dir);

  assert.equal(result.packageName, 'pkg');
  assert.deepEqual(result.scripts, []);
  assert.equal(result.packageError, '');
});

// ── resolveInboxItem smoke: merge gate completion ─────────────────────────────

test('TaskControlPlaneApiService.resolveInboxItem: merge gate signals without completing run when signalGate is true', async () => {
  const completed: Array<{ runId: string; source?: string; actor?: string }> = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ title: 'Merge approval', context: { topic: 'merge' } });
      },
    },
    runService: {
      async completeRun(runId, opts) {
        completed.push({ runId, source: opts?.source, actor: opts?.actor });
        return { runId, previousStatus: 'ready', status: 'completed' };
      },
    },
  });

  const result = await api.resolveInboxItem({ inboxId: 'inbox-1', answer: { decision: 'approve' } });

  assert.equal(result.topic, 'merge');
  assert.equal(result.signaled, true);
  assert.deepEqual(completed, []);
});

test('TaskControlPlaneApiService.resolveInboxItem: merge gate skips completeRun when signalGate is false', async () => {
  let completeRunCalled = false;
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ title: 'Merge approval', context: { topic: 'merge' } });
      },
    },
    runService: {
      async completeRun() {
        completeRunCalled = true;
        return null;
      },
    },
  });

  const result = await api.resolveInboxItem({ inboxId: 'inbox-1', answer: { decision: 'approve' }, signalGate: false });

  assert.equal(result.signaled, false);
  assert.equal(completeRunCalled, false, 'completeRun must not be called when signalGate is false');
});

test('TaskControlPlaneApiService.resolveInboxItem: plan gate does not call completeRun', async () => {
  let completeRunCalled = false;
  const api = makeApi({
    runService: {
      async completeRun() {
        completeRunCalled = true;
        return null;
      },
    },
  });

  const result = await api.resolveInboxItem({ inboxId: 'inbox-1', answer: { decision: 'approve' } });

  assert.equal(result.topic, 'plan');
  assert.equal(result.signaled, true);
  assert.equal(completeRunCalled, false, 'plan gates must not trigger completeRun');
});
