import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { InboxItem } from '../control-plane/inbox.js';
import type { DbosService } from '../engine/dbos.service.js';
import { AgentObservabilityError, AgentObservabilityService } from '../observability/index.js';
import type { PipelineService } from '../pipeline/pipeline.service.js';
import type { RouteDecision } from '../pipeline/route-contract.js';
import type { InboxService } from '../revisium/inbox.service.js';
import type { PlaybooksService } from '../revisium/playbooks.service.js';
import type { RolesService } from '../revisium/roles.service.js';
import type { RunService } from '../revisium/run.service.js';
import { CreateRunWorkflowError, previewCreateRunIds } from '../run/create-run.js';
import { TaskControlPlaneApiService } from './task-control-plane-api.service.js';

/**
 * A minimal VALID data-driven template (one developer agent → success terminal). The cutover (plan
 * 0015 slice 3) routes EVERY pipeline through the data-driven engine, so the fake `local-change`
 * pipeline must carry a template in its execution_policy or `start` would FAIL LOUD
 * (PIPELINE_NOT_DATA_DRIVEN). Validated by pipeline-core at run start.
 */
const LOCAL_CHANGE_TEMPLATE = {
  specVersion: '1.0',
  pipelineId: 'local-change',
  entry: 'developer',
  verdicts: { domain: ['approved'] },
  nodes: {
    developer: { id: 'developer', kind: 'agent', roleRef: 'role:developer', next: 'doneEnd', onFailure: 'abort' },
    doneEnd: { id: 'doneEnd', kind: 'terminal', status: 'succeeded' },
  },
};
const LOCAL_CHANGE_POLICY = { template_json: LOCAL_CHANGE_TEMPLATE };
const LOCAL_CHANGE_ROUTE: RouteDecision = {
  playbookId: 'pb',
  pipelineId: 'local-change',
  pipelineRowId: 'pb-local-change',
  source: 'explicit',
  roles: ['developer'],
  requiredRoles: ['developer'],
  optionalRoles: [],
  routeGates: [],
  executionPolicy: LOCAL_CHANGE_POLICY,
  executionProfile: { id: 'test', runnerOverrides: { 'claude-code': 'stub-agent' } },
  roleBindings: [
    {
      roleId: 'developer',
      rowId: 'pb-developer',
      modelLevel: 'standard',
      runnerId: 'claude-code',
      resolvedRunnerId: 'stub-agent',
      runnerSource: 'execution-profile',
    },
  ],
  params: { ticket: 'T-1' },
};

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
          executionPolicy: LOCAL_CHANGE_POLICY,
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
        executionPolicy: LOCAL_CHANGE_POLICY,
      };
    },
    async getPipeline() {
      return null;
    },
    ...overrides.playbooksService,
  };
  const pipelineService: Partial<PipelineService> = {
    async startDataDrivenTask(runId) {
      return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
    },
    ...overrides.pipelineService,
  };
  const dbosService: Partial<DbosService> = {
    async getWorkflowStatus() {
      return null;
    },
    async getEvent() {
      return null;
    },
    async *readStream() {},
    async signal() {},
    ...overrides.dbosService,
  };
  const artifactRoot = join(mkdtempSync(join(tmpdir(), 'revo-agent-observability-')), 'run-artifacts');
  const observabilityService = new AgentObservabilityService({
    artifactRoot,
    runExists: async (runId) => Boolean(await runService.getRun?.(runId)),
    dbos: {
      getEvent: (workflowID, key, opts) => dbosService.getEvent!(workflowID, key, opts),
      readStream: (workflowID, key) => dbosService.readStream!(workflowID, key),
    },
  });
  return new TaskControlPlaneApiService(
    runService as RunService,
    inboxService as InboxService,
    rolesService as RolesService,
    playbooksService as PlaybooksService,
    pipelineService as PipelineService,
    dbosService as DbosService,
    observabilityService,
  );
}

test('TaskControlPlaneApiService.getRunProgress reads DBOS status and graph cursor through sealed verbs', async () => {
  const api = makeApi({
    dbosService: {
      async getWorkflowStatus(runId: string) {
        assert.equal(runId, 'run-1');
        return {
          workflowID: 'run-1',
          status: 'PENDING',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-20T09:00:00.000Z'),
          updatedAt: Date.parse('2026-06-20T09:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
      async getEvent<T>(workflowID: string, key: string, opts?: { timeoutSeconds?: number }): Promise<T> {
        assert.equal(workflowID, 'run-1');
        assert.equal(key, 'run-progress');
        assert.deepEqual(opts, { timeoutSeconds: 0 });
        return { activeNodeIds: ['developer'], scopedCounters: { review: 1 }, status: 'running' } as T;
      },
    },
  });

  const progress = await api.getRunProgress('run-1');

  assert.equal(progress.workflowStatus, 'PENDING');
  assert.deepEqual(progress.graphCursor, { activeNodeIds: ['developer'], scopedCounters: { review: 1 }, status: 'running' });
  assert.equal(progress.updatedAt.toISOString(), '2026-06-20T09:00:01.000Z');
});

test('TaskControlPlaneApiService.getRunProgress returns NOT_STARTED when DBOS has no workflow yet', async () => {
  const api = makeApi();

  const progress = await api.getRunProgress('run-1');

  assert.equal(progress.workflowStatus, 'NOT_STARTED');
  assert.equal(progress.graphCursor, null);
  assert.equal(progress.updatedAt.toISOString(), '2026-06-13T00:00:00.000Z');
});

test('TaskControlPlaneApiService agent observability reads DBOS activity through sealed verbs', async () => {
  const api = makeApi({
    dbosService: {
      async getEvent<T>(workflowID: string, key: string, opts?: { timeoutSeconds?: number }): Promise<T> {
        assert.equal(workflowID, 'run-1');
        assert.equal(key, 'agent-activity');
        assert.deepEqual(opts, { timeoutSeconds: 0 });
        return {
          runId: 'run-1',
          aggregateStatus: 'running',
          latestActivityAt: '2026-06-20T10:00:01.000Z',
          attempts: [{
            runId: 'run-1',
            attemptId: 'attempt-1',
            stepId: 'step-1',
            role: 'developer',
            runner: 'claude-code',
            status: 'running',
            startedAt: '2026-06-20T10:00:00.000Z',
            lastEventAt: '2026-06-20T10:00:01.000Z',
            stdoutBytes: 0,
            stderrBytes: 0,
            eventCount: 1,
            artifactRef: 'run-1/attempt-1',
          }],
        } as T;
      },
    },
  });

  const activity = await api.getAgentActivity('run-1');

  assert.equal(activity?.runId, 'run-1');
  assert.equal(activity?.attempts[0]?.attemptId, 'attempt-1');
});

test('TaskControlPlaneApiService reads bounded agent output events through sealed observability verbs', async () => {
  const api = makeApi({
    dbosService: {
      async *readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown> {
        assert.equal(workflowID, 'run-1');
        assert.equal(key, 'agent-output');
        yield {
          cursor: 'cursor-1',
          runId: 'run-1',
          attemptId: 'attempt-1',
          stepId: 'step-1',
          at: '2026-06-20T10:00:00.000Z',
          kind: 'output',
          stream: 'stdout',
          preview: 'hello',
        } as T;
      },
    },
  });

  const page = await api.readAgentOutputEvents({ runId: 'run-1', limit: 1, timeoutMs: 1 });

  assert.equal(page.runId, 'run-1');
  assert.equal(page.events[0]?.cursor, 'cursor-1');
  assert.equal(page.nextCursor, 'cursor-1');
  assert.equal(page.cursorExpired, false);
});

test('TaskControlPlaneApiService agent observability preserves existing-run empty states', async () => {
  const api = makeApi();

  assert.equal(await api.getAgentActivity('run-1'), null);
  assert.deepEqual(await api.getAgentAttempts('run-1'), []);
  await assert.rejects(
    () => api.getAgentLog({ runId: 'run-1', stream: 'stdout' }),
    (error: unknown) => error instanceof AgentObservabilityError && error.code === 'NO_AGENT_ATTEMPT_AVAILABLE',
  );
});

test('TaskControlPlaneApiService agent observability reports missing runs as application errors', async () => {
  let streamRead = false;
  const api = makeApi({
    runService: {
      async getRun() {
        return null;
      },
    },
    dbosService: {
      readStream() {
        streamRead = true;
        return (async function* () {})();
      },
    },
  });

  await assert.rejects(
    () => api.getAgentActivity('missing-run'),
    (error: unknown) => error instanceof AgentObservabilityError && error.code === 'RUN_NOT_FOUND',
  );
  await assert.rejects(
    () => api.readAgentOutputEvents({ runId: 'missing-run', timeoutMs: 1 }),
    (error: unknown) => error instanceof AgentObservabilityError && error.code === 'RUN_NOT_FOUND',
  );
  assert.equal(streamRead, false);
});

test('TaskControlPlaneApiService.getRunWorkflow returns UI projection through sealed verbs', async () => {
  const api = makeApi({
    runService: {
      async getRun() {
        return {
          rowId: 'run-1',
          data: {
            id: 'run-1',
            title: 'Run',
            playbook_id: 'pb',
            pipeline_id: 'local-change',
            route_decision: {
              playbookId: 'pb',
              pipelineId: 'local-change',
              pipelineRowId: 'pb-local-change',
              source: 'explicit',
              roles: ['developer'],
              requiredRoles: ['developer'],
              optionalRoles: [],
              routeGates: [],
              executionPolicy: LOCAL_CHANGE_POLICY,
              executionProfile: { id: 'default', runnerOverrides: {} },
              roleBindings: [{
                roleId: 'developer',
                rowId: 'pb-developer',
                modelLevel: 'standard',
                runnerId: 'claude-code',
                resolvedRunnerId: 'claude-code',
                runnerSource: 'playbook',
              }],
              params: {},
            },
          },
        };
      },
      async showRun() {
        return {
          run: {
            runId: 'run-1',
            title: 'Run',
            status: 'paused',
            priority: 2,
            createdAt: '2026-06-13T00:00:00.000Z',
            description: 'Desc',
            scope: 'ci',
            repos: ['.'],
          },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-2',
            type: 'gate_opened',
            actor: 'orchestrator',
            createdAt: '2026-06-13T00:00:59.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: { stepKey: 'developer', attemptId: 'attempt-1', output: 'not terminal' },
          },
          {
            eventId: 'event-1',
            type: 'step_succeeded',
            actor: 'orchestrator',
            createdAt: '2026-06-13T00:01:00.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: { stepKey: 'developer', attemptId: 'attempt-1', output: 'done' },
          },
        ];
      },
      async listRunAttempts() {
        return [
          {
            attemptId: 'attempt-1',
            stepId: 'pstep-1',
            iteration: 0,
            status: 'succeeded',
            verdict: 'approved',
            modelProfile: 'standard',
            inputTokens: 10,
            outputTokens: 5,
            costAmount: 0.2,
            currency: 'USD',
            durationMs: 100,
            outputSummary: 'done',
            artifactRef: '',
            stdoutTail: '',
            stderrTail: '',
            lesson: '',
            error: '',
            startedAt: '2026-06-13T00:00:30.000Z',
          },
        ];
      },
    },
    inboxService: {
      async listInbox() {
        return [makeInboxItem({ id: 'inbox-plan', context: { topic: 'plan', summary: { nodeId: 'developer' } } })];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-20T09:00:00.000Z'),
          updatedAt: Date.parse('2026-06-20T09:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
      async getEvent<T>(): Promise<T> {
        return { activeNodeIds: ['doneEnd'], status: 'blocked' } as T;
      },
    },
  });

  const workflow = await api.getRunWorkflow('run-1');

  assert.equal(workflow.run.id, 'run-1');
  assert.equal(workflow.run.status, 'blocked');
  assert.equal(workflow.pipeline.status, 'blocked');
  assert.equal(workflow.nodes.find((node) => node.id === 'developer')?.status, 'awaiting_approval');
  assert.equal(workflow.nodes.find((node) => node.id === 'developer')?.attemptCount, 1);
  assert.equal(workflow.pendingInbox[0]?.createdAt instanceof Date, true);
  assert.equal(workflow.usage.costAmount, 0.2);
  assert.equal(workflow.activity[0]?.summary, 'done');
});

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

test('TaskControlPlaneApiService.waitForRun reports paused runs as blocked', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: {
            runId: 'run-1',
            title: 'Run',
            status: 'paused',
            priority: 0,
            createdAt: '2026-06-13T00:00:00.000Z',
            description: '',
            scope: '',
            repos: [],
          },
          tasks: [],
        };
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return { status: 'SUCCESS' } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  const state = await api.waitForRun({ runId: 'run-1' });

  assert.equal(state.state, 'blocked');
  assert.equal(state.runStatus, 'paused');
  assert.equal(state.workflowStatus, 'SUCCESS');
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
      async startDataDrivenTask(runId, opts) {
        starts.push({
          runId,
          pipelineId: opts.route.pipelineId,
          override: opts.route.executionProfile.runnerOverrides['claude-code'],
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
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

test('TaskControlPlaneApiService.startRun reports terminal preflight recovery without retrying', async () => {
  let started = false;
  const api = makeApi({
    runService: {
      async getRun() {
        return {
          rowId: 'run-1',
          data: {
            id: 'run-1',
            status: 'paused',
            route_decision: LOCAL_CHANGE_ROUTE,
          },
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-preflight',
            type: 'pipeline_blocked',
            actor: 'pipeline',
            createdAt: '2026-06-27T10:00:00.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: { reason: 'preflight', lesson: 'dirty repo' },
          },
        ];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
    pipelineService: {
      async startDataDrivenTask(runId) {
        started = true;
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const result = await api.startRun({ runId: 'run-1' });
  const record = result as Record<string, unknown>;

  assert.equal(started, false, 'recoverable parent must not be restarted by startRun');
  assert.equal(record.recoverable, true);
  assert.equal(record.retryStarted, false);
  assert.equal(record.nextAction, 'resume_run');
  assert.equal(record.workflowID, 'run-1');
  assert.equal(record.workflowStatus, 'SUCCESS');
  assert.equal(record.blockedEventId, 'event-preflight');
  assert.equal(record.blockedReason, 'preflight');
  assert.equal(record.alreadyStarted, true);
  assert.equal(record.engine, 'data-driven');
  assert.equal((record.route as RouteDecision).pipelineId, 'local-change');
});

test('TaskControlPlaneApiService.resumeRun creates and reuses a preflight recovery child run', async () => {
  const parentData = {
    id: 'run-parent',
    title: 'Recover dirty preflight',
    description: 'Parent description',
    status: 'paused',
    repos: [process.cwd()],
    scope: 'Parent scope',
    priority: 7,
    playbook_id: 'pb',
    pipeline_id: 'local-change',
    params: { ticket: 'T-1' },
    route_decision: LOCAL_CHANGE_ROUTE,
    execution_profile: LOCAL_CHANGE_ROUTE.executionProfile,
  };
  const childRows = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<{
    runId?: string;
    eventId: string;
    type: string;
    actor: string;
    createdAt: string;
    taskId: string;
    stepId: string;
    payload: unknown;
  }>>([
    ['run-parent', [
      {
        eventId: 'event-preflight',
        type: 'pipeline_blocked',
        actor: 'pipeline',
        createdAt: '2026-06-27T10:00:00.000Z',
        taskId: 'task-parent',
        stepId: '',
        payload: { reason: 'preflight', lesson: 'dirty repo' },
      },
    ]],
  ]);
  const createInputs: unknown[] = [];
  const starts: string[] = [];
  const workflowStatus = new Map<string, string>([['run-parent', 'SUCCESS']]);

  const api = makeApi({
    runService: {
      async getRun(runId) {
        if (runId === 'run-parent') return { rowId: runId, data: parentData };
        const child = childRows.get(runId);
        return child ? { rowId: runId, data: child } : null;
      },
      async showRun(runId) {
        if (runId === 'run-parent') {
          return {
            run: {
              runId,
              title: String(parentData.title),
              status: String(parentData.status),
              priority: Number(parentData.priority),
              createdAt: '2026-06-27T09:00:00.000Z',
              description: String(parentData.description),
              scope: String(parentData.scope),
              repos: [process.cwd()],
            },
            tasks: [{ taskId: 'task-parent', title: String(parentData.title), status: 'paused', roleHint: 'developer' }],
          };
        }
        const child = childRows.get(runId);
        if (!child) return null;
        return {
          run: {
            runId,
            title: String(child.title),
            status: String(child.status),
            priority: Number(child.priority),
            createdAt: String(child.created_at),
            description: String(child.description),
            scope: String(child.scope),
            repos: [process.cwd()],
          },
          tasks: [{ taskId: `task-${runId}`, title: String(child.title), status: String(child.status), roleHint: 'developer' }],
        };
      },
      async listRunEvents(runId) {
        return events.get(runId) ?? [];
      },
      async createRun(input) {
        createInputs.push(input);
        const runId = 'run-recovery';
        childRows.set(runId, {
          id: runId,
          title: input.title,
          description: input.description ?? '',
          status: 'ready',
          repos: [input.repo],
          scope: input.scope ?? '',
          priority: input.priority ?? 0,
          playbook_id: input.playbookId ?? '',
          pipeline_id: input.pipelineId ?? '',
          params: input.params ?? {},
          route_decision: input.routeDecision ?? {},
          execution_profile: input.executionProfile ?? {},
          created_at: input.now?.toISOString() ?? '',
        });
        return { runId, taskId: `task-${runId}`, eventId: 'event-recovery-created', status: 'ready' };
      },
      async appendEvent(input) {
        const list = events.get(input.runId) ?? [];
        list.push({
          runId: input.runId,
          eventId: `${input.type}-${list.length + 1}`,
          type: input.type,
          actor: input.actor ?? '',
          createdAt: '',
          taskId: input.taskId,
          stepId: input.stepId,
          payload: input.payload,
        });
        events.set(input.runId, list);
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus(runId) {
        const status = workflowStatus.get(runId);
        if (!status) return null;
        return {
          workflowID: runId,
          status,
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
    pipelineService: {
      async startDataDrivenTask(runId) {
        starts.push(runId);
        workflowStatus.set(runId, 'PENDING');
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const first = await api.resumeRun({ runId: 'run-parent' });
  const second = await api.resumeRun({ runId: 'run-parent' });
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  const firstRecovery = firstRecord.recovery as Record<string, unknown>;
  const secondRecovery = secondRecord.recovery as Record<string, unknown>;

  assert.equal(firstRecord.runId, 'run-recovery');
  assert.equal(firstRecord.workflowID, 'run-recovery');
  assert.equal(firstRecord.recovered, true);
  assert.equal(firstRecovery.parentRunId, 'run-parent');
  assert.equal(firstRecovery.recoveryRunId, 'run-recovery');
  assert.equal(firstRecovery.blockedEventId, 'event-preflight');
  assert.equal(firstRecovery.reason, 'preflight');
  assert.equal(secondRecord.runId, 'run-recovery');
  assert.equal(secondRecovery.recoveryRunId, 'run-recovery');
  assert.equal(createInputs.length, 1, 'second resume must reuse the recovery run');
  assert.deepEqual(starts, ['run-recovery', 'run-recovery']);

  const copied = createInputs[0] as Record<string, unknown>;
  assert.equal(copied.title, parentData.title);
  assert.equal(copied.repo, process.cwd());
  assert.equal(copied.description, parentData.description);
  assert.equal(copied.scope, parentData.scope);
  assert.equal(copied.priority, parentData.priority);
  assert.equal(copied.role, 'developer');
  assert.equal(copied.playbookId, parentData.playbook_id);
  assert.equal(copied.pipelineId, parentData.pipeline_id);
  assert.deepEqual(copied.routeDecision, parentData.route_decision);
  assert.deepEqual(copied.executionProfile, parentData.execution_profile);
  assert.deepEqual(copied.params, { ticket: 'T-1' }, 'recovery metadata must not be stored in public params');
  assert.deepEqual((copied.now as Date).toISOString(), '2026-06-27T10:00:00.000Z');
  assert.equal(typeof copied.idSuffix, 'string');

  const parentRecoveryEvent = events.get('run-parent')?.find((event) => event.type === 'run_recovery_created');
  const childRecoveryEvent = events.get('run-recovery')?.find((event) => event.type === 'run_recovery_parent');
  assert.ok(parentRecoveryEvent, 'parent recovery event must be written');
  assert.ok(childRecoveryEvent, 'child recovery parent event must be written');
  assert.equal(parentRecoveryEvent.runId, 'run-parent');
  assert.equal(parentRecoveryEvent.taskId, 'task-parent');
  assert.equal(parentRecoveryEvent.stepId, '');
  assert.equal(parentRecoveryEvent.actor, 'orchestrator');
  assert.equal(childRecoveryEvent.runId, 'run-recovery');
  assert.equal(childRecoveryEvent.taskId, 'task-run-recovery');
  assert.equal(childRecoveryEvent.stepId, '');
  assert.equal(childRecoveryEvent.actor, 'orchestrator');
  assert.deepEqual(parentRecoveryEvent.payload, {
    parentRunId: 'run-parent',
    recoveryRunId: 'run-recovery',
    blockedEventId: 'event-preflight',
    reason: 'preflight',
  });
  assert.deepEqual(parentRecoveryEvent.payload, childRecoveryEvent.payload);
});

test('TaskControlPlaneApiService.resumeRun does not create recovery runs for non-preflight blocks', async () => {
  const createInputs: unknown[] = [];
  const starts: string[] = [];
  const api = makeApi({
    runService: {
      async getRun() {
        return {
          rowId: 'run-1',
          data: {
            id: 'run-1',
            status: 'paused',
            route_decision: LOCAL_CHANGE_ROUTE,
          },
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-integrate',
            type: 'pipeline_blocked',
            actor: 'pipeline',
            createdAt: '2026-06-27T10:00:00.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: { reason: 'integrate', lesson: 'manual merge needed' },
          },
        ];
      },
      async createRun(input) {
        createInputs.push(input);
        return { runId: 'run-recovery', taskId: 'task-recovery', eventId: 'event-recovery', status: 'ready' };
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
    pipelineService: {
      async startDataDrivenTask(runId) {
        starts.push(runId);
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const result = await api.resumeRun({ runId: 'run-1' });
  const record = result as Record<string, unknown>;

  assert.equal(record.runId, 'run-1');
  assert.equal(record.workflowID, 'run-1');
  assert.deepEqual(createInputs, []);
  assert.deepEqual(starts, ['run-1']);
});

test('TaskControlPlaneApiService.resumeRun rejects preflight recovery when the parent repo is missing', async () => {
  const api = makeApi({
    runService: {
      async getRun() {
        return {
          rowId: 'run-parent',
          data: {
            id: 'run-parent',
            title: 'Recover dirty preflight',
            status: 'paused',
            route_decision: LOCAL_CHANGE_ROUTE,
            execution_profile: LOCAL_CHANGE_ROUTE.executionProfile,
          },
        };
      },
      async showRun() {
        return {
          run: {
            runId: 'run-parent',
            title: 'Recover dirty preflight',
            status: 'paused',
            priority: 0,
            createdAt: '2026-06-27T09:00:00.000Z',
            description: '',
            scope: '',
            repos: [],
          },
          tasks: [{ taskId: 'task-parent', title: 'Recover dirty preflight', status: 'paused', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-preflight',
            type: 'pipeline_blocked',
            actor: 'pipeline',
            createdAt: '2026-06-27T10:00:00.000Z',
            taskId: 'task-parent',
            stepId: '',
            payload: { reason: 'preflight', lesson: 'missing repo' },
          },
        ];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-parent',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('parent repo is missing'),
  );
});

type RecoveryTestEvent = {
  eventId: string;
  type: string;
  actor: string;
  createdAt: string;
  taskId: string;
  stepId: string;
  payload: unknown;
};

function pausedRecoveryParentData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-parent',
    title: 'Recover preflight',
    status: 'paused',
    repos: [process.cwd()],
    route_decision: LOCAL_CHANGE_ROUTE,
    execution_profile: LOCAL_CHANGE_ROUTE.executionProfile,
    ...overrides,
  };
}

function preflightBlockedEvent(overrides: Partial<RecoveryTestEvent> = {}): RecoveryTestEvent {
  return {
    eventId: 'event-preflight',
    type: 'pipeline_blocked',
    actor: 'pipeline',
    createdAt: '2026-06-27T10:00:00.000Z',
    taskId: 'task-parent',
    stepId: '',
    payload: { reason: 'preflight', lesson: 'dirty repo' },
    ...overrides,
  };
}

function recoveryWorkflowStatus(runId = 'run-parent'): Awaited<ReturnType<DbosService['getWorkflowStatus']>> {
  return {
    workflowID: runId,
    status: 'SUCCESS',
    workflowName: 'dataDrivenTask',
    workflowClassName: 'PipelineService',
    createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
    updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
    priority: 0,
    applicationID: 'test',
  } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
}

function recoveryRunDetail(
  runId = 'run-parent',
  title = 'Recover preflight',
  tasks = [{ taskId: 'task-parent', title, status: 'paused', roleHint: 'developer' }],
) {
  return {
    run: {
      runId,
      title,
      status: 'paused',
      priority: 0,
      createdAt: '2026-06-27T09:00:00.000Z',
      description: '',
      scope: '',
      repos: [process.cwd()],
    },
    tasks,
  };
}

test('TaskControlPlaneApiService.resumeRun rejects preflight recovery when the parent title is missing', async () => {
  const parentData = pausedRecoveryParentData({ title: undefined });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', '');
      },
      async listRunEvents() {
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'missing title' } })];
      },
      async createRun() {
        assert.fail('invalid recovery input must not create a child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('parent title is missing'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects preflight recovery when the parent task is missing', async () => {
  const parentData = pausedRecoveryParentData({ title: 'Recover missing task' });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', String(parentData.title), []);
      },
      async listRunEvents() {
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'missing task' } })];
      },
      async createRun() {
        assert.fail('recovery without a parent task must not create a child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'ROW_NOT_FOUND' &&
      error.message.includes('parent task is missing'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects stale recovery lineage that points at a missing child run', async () => {
  const parentData = pausedRecoveryParentData({ title: 'Recover stale lineage' });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun(runId) {
        if (runId === 'run-missing') return null;
        return recoveryRunDetail(runId, String(parentData.title));
      },
      async listRunEvents() {
        return [
          preflightBlockedEvent(),
          {
            eventId: 'event-lineage',
            type: 'run_recovery_created',
            actor: 'orchestrator',
            createdAt: '2026-06-27T10:00:01.000Z',
            taskId: 'task-parent',
            stepId: '',
            payload: {
              parentRunId: 'run-parent',
              recoveryRunId: 'run-missing',
              blockedEventId: 'event-preflight',
              reason: 'preflight',
            },
          },
        ];
      },
      async createRun() {
        assert.fail('stale recovery lineage must not create another child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'ROW_NOT_FOUND' &&
      error.message.includes('recovery run run-missing referenced by lineage event is missing'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects recovery when the parent task role is missing', async () => {
  const parentData = pausedRecoveryParentData({ title: 'Recover missing role' });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', String(parentData.title), [
          { taskId: 'task-parent', title: String(parentData.title), status: 'paused', roleHint: '' },
        ]);
      },
      async listRunEvents() {
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'missing role hint' } })];
      },
      async createRun() {
        assert.fail('recovery without a role hint must not create a child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('parent task role_hint is missing'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects recovery when route_decision is not a record', async () => {
  const parentData = pausedRecoveryParentData({
    title: 'Recover invalid route decision',
    route_decision: 'not-a-record',
  });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', String(parentData.title));
      },
      async listRunEvents() {
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'bad route decision' } })];
      },
      async createRun() {
        assert.fail('recovery with invalid route_decision must not create a child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('parent route_decision is not a record'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects recovery when execution_profile is not a record', async () => {
  const parentData = pausedRecoveryParentData({
    title: 'Recover invalid execution profile',
    execution_profile: 1,
  });
  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', String(parentData.title));
      },
      async listRunEvents() {
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'bad execution profile' } })];
      },
      async createRun() {
        assert.fail('recovery with invalid execution_profile must not create a child run');
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      error.message.includes('parent execution_profile is not a record'),
  );
});

test('TaskControlPlaneApiService.resumeRun ignores lineage for another blocked event and creates a fresh child', async () => {
  const parentData = pausedRecoveryParentData({ title: 'Recover current block' });
  const childRows = new Map<string, Record<string, unknown>>();
  const events = new Map<string, RecoveryTestEvent[]>([
    ['run-parent', [
      preflightBlockedEvent({ eventId: 'event-current' }),
      {
        eventId: 'event-old-lineage',
        type: 'run_recovery_created',
        actor: 'orchestrator',
        createdAt: '2026-06-27T09:59:00.000Z',
        taskId: 'task-parent',
        stepId: '',
        payload: {
          parentRunId: 'run-parent',
          recoveryRunId: 'run-old-recovery',
          blockedEventId: 'event-old',
          reason: 'preflight',
        },
      },
      {
        eventId: 'event-note',
        type: 'step_succeeded',
        actor: 'orchestrator',
        createdAt: '2026-06-27T10:00:01.000Z',
        taskId: 'task-parent',
        stepId: '',
        payload: { stepKey: 'developer', output: 'previous attempt finished' },
      },
    ]],
  ]);
  const createInputs: unknown[] = [];
  const starts: string[] = [];

  const api = makeApi({
    runService: {
      async getRun(runId) {
        if (runId === 'run-parent') return { rowId: runId, data: parentData };
        const child = childRows.get(runId);
        return child ? { rowId: runId, data: child } : null;
      },
      async showRun(runId) {
        if (runId === 'run-parent') return recoveryRunDetail(runId, String(parentData.title));
        const child = childRows.get(runId);
        if (!child) return null;
        return recoveryRunDetail(runId, String(child.title), []);
      },
      async listRunEvents(runId) {
        return events.get(runId) ?? [];
      },
      async createRun(input) {
        createInputs.push(input);
        const runId = 'run-current-recovery';
        childRows.set(runId, {
          id: runId,
          title: input.title,
          status: 'ready',
          repos: [input.repo],
          route_decision: input.routeDecision ?? {},
          execution_profile: input.executionProfile ?? {},
        });
        return { runId, taskId: 'task-current-recovery', eventId: 'event-current-recovery', status: 'ready' };
      },
      async appendEvent(input) {
        const list = events.get(input.runId) ?? [];
        list.push({
          eventId: `${input.type}-${list.length + 1}`,
          type: input.type,
          actor: input.actor ?? '',
          createdAt: '',
          taskId: input.taskId,
          stepId: input.stepId,
          payload: input.payload,
        });
        events.set(input.runId, list);
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus(runId) {
        if (runId !== 'run-parent') return null;
        return recoveryWorkflowStatus(runId);
      },
    },
    pipelineService: {
      async startDataDrivenTask(runId) {
        starts.push(runId);
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const result = await api.resumeRun({ runId: 'run-parent' });
  const record = result as Record<string, unknown>;
  const recovery = record.recovery as Record<string, unknown>;

  assert.equal(record.runId, 'run-current-recovery');
  assert.equal(recovery.blockedEventId, 'event-current');
  assert.equal(createInputs.length, 1, 'stale lineage must not suppress fresh recovery creation');
  assert.deepEqual(starts, ['run-current-recovery']);
});

test('TaskControlPlaneApiService.resumeRun reuses the expected recovery run after a partial create conflict', async () => {
  const parentData = {
    id: 'run-parent',
    title: 'Recover partial child create',
    status: 'paused',
    repos: [process.cwd()],
    playbook_id: 'pb',
    pipeline_id: 'local-change',
    route_decision: LOCAL_CHANGE_ROUTE,
    execution_profile: LOCAL_CHANGE_ROUTE.executionProfile,
  };
  const childRows = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<{
    eventId: string;
    type: string;
    actor: string;
    createdAt: string;
    taskId: string;
    stepId: string;
    payload: unknown;
  }>>([
    ['run-parent', [
      {
        eventId: 'event-preflight',
        type: 'pipeline_blocked',
        actor: 'pipeline',
        createdAt: '2026-06-27T10:00:00.000Z',
        taskId: 'task-parent',
        stepId: '',
        payload: { reason: 'preflight', lesson: 'dirty repo' },
      },
    ]],
  ]);
  const createInputs: unknown[] = [];
  const starts: string[] = [];
  let expectedRecoveryRunId = '';

  const api = makeApi({
    runService: {
      async getRun(runId) {
        if (runId === 'run-parent') return { rowId: runId, data: parentData };
        const child = childRows.get(runId);
        return child ? { rowId: runId, data: child } : null;
      },
      async showRun(runId) {
        if (runId === 'run-parent') {
          return {
            run: {
              runId,
              title: String(parentData.title),
              status: String(parentData.status),
              priority: 0,
              createdAt: '2026-06-27T09:00:00.000Z',
              description: '',
              scope: '',
              repos: [process.cwd()],
            },
            tasks: [{ taskId: 'task-parent', title: String(parentData.title), status: 'paused', roleHint: 'developer' }],
          };
        }
        const child = childRows.get(runId);
        if (!child) return null;
        return {
          run: {
            runId,
            title: String(child.title),
            status: String(child.status),
            priority: 0,
            createdAt: String(child.created_at),
            description: '',
            scope: '',
            repos: [process.cwd()],
          },
          tasks: [{ taskId: `task-${runId}`, title: String(child.title), status: String(child.status), roleHint: 'developer' }],
        };
      },
      async listRunEvents(runId) {
        return events.get(runId) ?? [];
      },
      async createRun(input) {
        createInputs.push(input);
        const expected = previewCreateRunIds(input);
        expectedRecoveryRunId = expected.runId;
        childRows.set(expected.runId, {
          id: expected.runId,
          title: input.title,
          status: 'ready',
          repos: [input.repo],
          route_decision: input.routeDecision ?? {},
          execution_profile: input.executionProfile ?? {},
          created_at: input.now?.toISOString() ?? '',
        });
        throw new CreateRunWorkflowError('partial create', { runId: expected.runId }, new Error('row conflict'));
      },
      async appendEvent(input) {
        const list = events.get(input.runId) ?? [];
        list.push({
          eventId: `${input.type}-${list.length + 1}`,
          type: input.type,
          actor: input.actor ?? '',
          createdAt: '',
          taskId: input.taskId,
          stepId: input.stepId,
          payload: input.payload,
        });
        events.set(input.runId, list);
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus(runId) {
        if (runId !== 'run-parent') return null;
        return {
          workflowID: runId,
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
    pipelineService: {
      async startDataDrivenTask(runId) {
        starts.push(runId);
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const result = await api.resumeRun({ runId: 'run-parent' });
  const record = result as Record<string, unknown>;
  const recovery = record.recovery as Record<string, unknown>;

  assert.equal(record.runId, expectedRecoveryRunId);
  assert.equal(record.workflowID, expectedRecoveryRunId);
  assert.equal(recovery.recoveryRunId, expectedRecoveryRunId);
  assert.deepEqual(starts, [expectedRecoveryRunId]);
  assert.equal(createInputs.length, 1);

  const copied = createInputs[0] as Record<string, unknown>;
  assert.deepEqual(copied.params, {}, 'missing parent params recover as an empty public params object');
  assert.equal(copied.description, undefined);
  assert.equal(copied.scope, undefined);

  const parentRecoveryEvent = events.get('run-parent')?.find((event) => event.type === 'run_recovery_created');
  const childRecoveryEvent = events.get(expectedRecoveryRunId)?.find((event) => event.type === 'run_recovery_parent');
  assert.ok(parentRecoveryEvent, 'parent recovery event must be written after partial create reuse');
  assert.ok(childRecoveryEvent, 'child recovery event must be written after partial create reuse');
  assert.deepEqual(parentRecoveryEvent.payload, childRecoveryEvent.payload);
});

test('TaskControlPlaneApiService.resumeRun rethrows partial create conflicts when the expected recovery row is missing', async () => {
  const parentData = {
    id: 'run-parent',
    title: 'Recover missing partial child',
    status: 'paused',
    repos: [process.cwd()],
    route_decision: LOCAL_CHANGE_ROUTE,
    execution_profile: LOCAL_CHANGE_ROUTE.executionProfile,
  };

  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun(runId) {
        if (runId !== 'run-parent') return null;
        return {
          run: {
            runId,
            title: String(parentData.title),
            status: String(parentData.status),
            priority: 0,
            createdAt: '2026-06-27T09:00:00.000Z',
            description: '',
            scope: '',
            repos: [process.cwd()],
          },
          tasks: [{ taskId: 'task-parent', title: String(parentData.title), status: 'paused', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-preflight',
            type: 'pipeline_blocked',
            actor: 'pipeline',
            createdAt: '2026-06-27T10:00:00.000Z',
            taskId: 'task-parent',
            stepId: '',
            payload: { reason: 'preflight', lesson: 'dirty repo' },
          },
        ];
      },
      async createRun(input) {
        const expected = previewCreateRunIds(input);
        throw new CreateRunWorkflowError('partial create', { runId: expected.runId }, new Error('row conflict'));
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-parent',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-27T10:00:00.000Z'),
          updatedAt: Date.parse('2026-06-27T10:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) => error instanceof CreateRunWorkflowError,
  );
});

test('TaskControlPlaneApiService.resumeRun rethrows unexpected recovery child create failures', async () => {
  const createFailure = new Error('storage unavailable');
  const parentData = pausedRecoveryParentData({ title: 'Recover create failure' });

  const api = makeApi({
    runService: {
      async getRun() {
        return { rowId: 'run-parent', data: parentData };
      },
      async showRun() {
        return recoveryRunDetail('run-parent', String(parentData.title));
      },
      async listRunEvents() {
        return [preflightBlockedEvent()];
      },
      async createRun() {
        throw createFailure;
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return recoveryWorkflowStatus();
      },
    },
  });

  await assert.rejects(
    () => api.resumeRun({ runId: 'run-parent' }),
    (error: unknown) => error === createFailure,
  );
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
      async startDataDrivenTask(runId, opts) {
        starts.push({
          override: opts.route.executionProfile.runnerOverrides['claude-code'],
          params: opts.route.params ?? {},
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
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

test('TaskControlPlaneApiService.simulateRoute binds an unknown-id role purely from pipeline data (no kind)', async () => {
  const api = makeApi({
    rolesService: {
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
          {
            id: 'pb-pr-poller',
            name: 'pr-poller',
            modelLevel: 'cheap',
            runner: 'claude-code',
            surface: 'any',
            rights: 'read-only',
            playbookId: 'pb',
            playbookRoleId: 'pr-poller',
          },
        ];
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-poll',
          playbookId: 'pb',
          pipelineId: 'poll',
          path: 'pipelines/poll/PIPELINE.md',
          triggers: ['poll'],
          requiredRoles: ['developer', 'pr-poller'],
          alternativeRoles: [],
          optionalRoles: [],
          routeGates: [],
          executionPolicy: {},
        };
      },
    },
  });

  const route = await api.simulateRoute({ title: 'route poll', pipeline: 'poll' });

  // The binding resolves the unknown-id role by id alone; the route carries NO role `kind` (the
  // role-kind machinery was removed in slice 4 — the data-driven engine reads no `kind`).
  const pollerBinding = route.roleBindings.find((item) => item.roleId === 'pr-poller');
  assert.ok(pollerBinding, 'pr-poller binds purely from the pipeline data');
  assert.equal('kind' in (pollerBinding ?? {}), false, 'no kind is threaded onto any binding');
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

// Plan 0015 slice 3: the old phase-order hardcode (`insertBeforeFirstDeveloperRole`) was removed with
// the hardcoded engine. Route role ORDER is no longer load-bearing — the data-driven template owns node
// sequencing — so an alternative-group selection (analyst for bugfix's defect-analysis group) now simply
// APPENDS. The route's job is to BIND the right capability handles, not to order them.
test('TaskControlPlaneApiService.simulateRoute binds the bugfix defect-analysis alternative role (appended; order no longer load-bearing)', async () => {
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
          id: 'pb-bugfix',
          playbookId: 'pb',
          pipelineId: 'bugfix',
          path: 'pipelines/bugfix/PIPELINE.md',
          triggers: ['known defect'],
          requiredRoles: ['orchestrator', 'developer', 'integrator', 'watcher'],
          alternativeRoles: [{ group_id: 'defect-analysis', roles: ['analyst', 'reviewer'], resolution: 'at_least_one' }],
          optionalRoles: [],
          routeGates: ['merge'],
          executionPolicy: {},
        };
      },
    },
  });

  const route = await api.simulateRoute({ title: 'Fix bug', pipeline: 'bugfix' });

  assert.deepEqual(route.requiredRoles, ['orchestrator', 'developer', 'integrator', 'watcher']);
  // analyst (the resolved defect-analysis alternative) is appended after the required roles; the
  // data-driven `bugfix` template sequences analyst→developer→… itself, so this order is fine.
  assert.deepEqual(route.roleBindings.map((item) => item.roleId), [
    'orchestrator',
    'developer',
    'integrator',
    'watcher',
    'analyst',
  ]);
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

// ─────────────────────── blockedReason ───────────────────────

test('resolveRunState: surfaces blockedReason from pipeline_blocked event reason', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'running', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [
          { eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'plan gate rejected', nodeId: 'reviewer' } },
        ];
      },
    },
    inboxService: {
      async listInbox() { return []; },
    },
    dbosService: {
      async getWorkflowStatus() { return null; },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'blocked');
  assert.equal(state.blockedReason, 'plan gate rejected');
});

test('resolveRunState: blockedReason is undefined when no pipeline_blocked event', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'running', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() { return []; },
    },
    inboxService: {
      async listInbox() { return []; },
    },
    dbosService: {
      async getWorkflowStatus() { return null; },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.blockedReason, undefined);
});

test('resolveRunState: paused run surfaces blockedReason when pipeline_blocked event exists', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'paused', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [
          { eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'reviewer blocked' } },
        ];
      },
    },
    inboxService: {
      async listInbox() { return []; },
    },
    dbosService: {
      async getWorkflowStatus() { return null; },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'blocked');
  assert.equal(state.blockedReason, 'reviewer blocked');
});

test('getRunDigest: includes blockedReason when pipeline_blocked event exists', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'paused', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [
          { eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'no budget' } },
        ];
      },
      async listRunAttempts() { return []; },
    },
    inboxService: {
      async listInbox() { return []; },
    },
  });

  const digest = await api.getRunDigest('run-1');

  assert.equal(digest.blockedReason, 'no budget');
});

test('getRunDigest: blockedReason absent when no pipeline_blocked event', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'running', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() { return []; },
      async listRunAttempts() { return []; },
    },
    inboxService: {
      async listInbox() { return []; },
    },
  });

  const digest = await api.getRunDigest('run-1');

  assert.equal(digest.blockedReason, undefined);
});
