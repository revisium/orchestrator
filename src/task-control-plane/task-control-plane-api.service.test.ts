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
import { hasWorkflowProgress, TaskControlPlaneApiService } from './task-control-plane-api.service.js';
import { hashTemplate, MATERIALIZER_VERSION } from '../pipeline-core/materialize.js';
import { compileExecutionPlan } from '../control-plane/run-profile-contract.js';
import { executionPlanFromRouteDecision, routeDecisionFromCompiledPlan } from '../pipeline/route-contract.js';
import { runnerManifests } from '../runners/runner-manifest.js';
import { POLICY_VERSION } from '../control-plane/default-playbook-policy.js';
import { INTEGRATOR_PROGRESS_EVENT_TYPES } from '../pipeline/data-driven-task.workflow.js';
import { focusedCaseTitle } from '../testing/policy/non-dsl-ownership.js';
import type { Template } from '../pipeline-core/types.js';

const focusedOwner = 'src/task-control-plane/task-control-plane-api.service.test.ts';

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
const LOCAL_CHANGE_PROFILE = {
  schemaVersion: 'run-profile/v1',
  topology: { stages: { developer: { mode: 'single' } } },
  bindings: {
    slots: {
      'node:developer': {
        runnerId: 'codex',
        provider: 'openai',
        modelId: 'gpt-5.6-luna',
        modelParams: {},
        permissionMode: 'workspace-write',
      },
    },
  },
};
function routeForTemplate(template: Template, pipelineId = template.pipelineId): RouteDecision {
  const manifest = runnerManifests().codex!;
  const agentBindings = Object.values(template.nodes).flatMap((node) => {
    if (node.kind !== 'agent') return [];
    const roleId = node.roleRef.replace(/^role:/, '');
    return [{
      slotKey: `node:${node.id}`,
      nodeId: node.id,
      roleId,
      roleDocumentId: roleId,
      runnerId: 'codex',
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
      modelParams: {},
      permissionMode: 'workspace-write',
      permissionSource: 'profile' as const,
      runner: manifest,
    }];
  });
  const scriptBindings = Object.values(template.nodes).flatMap((node) => node.kind === 'script'
    ? [{ nodeId: node.id, scriptRef: node.scriptRef, accountAliases: { github: 'profile-bot' } }]
    : []);
  return routeDecisionFromCompiledPlan(compileExecutionPlan({
    selection: { playbookId: 'pb', pipelineId, pipelineRowId: `pb-${pipelineId}`, source: 'explicit' },
    businessParams: {},
    profile: { source: 'inline', profileHash: `sha256:${'0'.repeat(64)}` },
    pipeline: {
      executableGraph: template,
      graphDigest: hashTemplate(template),
      materializerVersion: MATERIALIZER_VERSION,
      policyVersion: POLICY_VERSION,
      routeGates: [],
      executionPolicy: { template_json: template },
    },
    agentBindings,
    scriptBindings,
  }));
}

const LOCAL_CHANGE_MANIFEST = runnerManifests().codex!;
const LOCAL_CHANGE_ROUTE: RouteDecision = routeDecisionFromCompiledPlan(compileExecutionPlan({
  selection: {
    playbookId: 'pb',
    pipelineId: 'local-change',
    pipelineRowId: 'pb-local-change',
    source: 'explicit',
  },
  businessParams: { ticket: 'T-1' },
  profile: { source: 'inline', profileHash: 'sha256:' + '0'.repeat(64) },
  pipeline: {
    executableGraph: LOCAL_CHANGE_TEMPLATE,
    graphDigest: hashTemplate(LOCAL_CHANGE_TEMPLATE as never),
    materializerVersion: MATERIALIZER_VERSION,
    policyVersion: POLICY_VERSION,
    routeGates: [],
    executionPolicy: LOCAL_CHANGE_POLICY,
  },
  agentBindings: [{
    slotKey: 'node:developer',
    nodeId: 'developer',
    roleId: 'developer',
    roleDocumentId: 'pb-developer',
    runnerId: 'codex',
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
    modelParams: {},
    permissionMode: 'workspace-write',
    permissionSource: 'profile',
    runner: LOCAL_CHANGE_MANIFEST,
  }],
  scriptBindings: [],
}));

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    kind: 'approval',
    runId: 'run-1',
    taskId: '',
    stepId: '',
    projectId: '',
    title: 'Plan approval',
    context: { topic: 'plan', summary: { outcomes: ['approved', 'changes_requested'] } },
    options: ['approved', 'changes_requested'],
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
        routeGates: [],
        executionPolicy: LOCAL_CHANGE_POLICY,
      };
    },
    async getPipeline() {
      return null;
    },
    async resolveRunProfile() {
      return {
        id: 'pb-local-change-stub',
        playbookId: 'pb',
        pipelineId: 'local-change',
        profileId: 'local-change-stub',
        schemaVersion: 'run-profile/v1',
        version: '1',
        displayName: 'Local change stub',
        summary: 'Test stub profile',
        profile: LOCAL_CHANGE_PROFILE,
        profileHash: 'local-change-stub-hash',
        profileRevisionHash: 'local-change-stub-revision-hash',
        status: 'active' as const,
      };
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
            route_decision: LOCAL_CHANGE_ROUTE,
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
            runnerId: 'codex',
            provider: 'openai',
            modelId: 'gpt-5.6-luna',
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

test('TaskControlPlaneApiService.getRunWorkflow marks signaled question step payloads as succeeded', async () => {
  const questionTemplate = {
    specVersion: '1.0',
    pipelineId: 'question-projection',
    entry: 'analyst',
    verdicts: { domain: ['answered'] },
    nodes: {
      analyst: { id: 'analyst', kind: 'agent', roleRef: 'role:developer', next: 'doneEnd', onFailure: 'abort' },
      doneEnd: { id: 'doneEnd', kind: 'terminal', status: 'succeeded' },
    },
  };
  const api = makeApi({
    runService: {
      async getRun() {
        return {
          rowId: 'run-1',
          data: {
            id: 'run-1',
            title: 'Run',
            route_decision: {
              ...routeForTemplate(questionTemplate as never, 'question-projection'),
            },
          },
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-question-pending',
            type: 'question_signal_pending',
            actor: 'mcp',
            createdAt: '2026-06-13T00:00:59.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: {
              inboxId: 'inbox-question',
              topic: 'question',
              signalTopic: 'question:agent-analyst',
              stepKey: 'analyst',
            },
          },
          {
            eventId: 'event-question-signaled',
            type: 'question_signaled',
            actor: 'mcp',
            createdAt: '2026-06-13T00:01:00.000Z',
            taskId: 'task-1',
            stepId: '',
            payload: {
              inboxId: 'inbox-question',
              topic: 'question',
              signalTopic: 'question:agent-analyst',
              stepKey: 'analyst',
            },
          },
        ];
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
  });

  const workflow = await api.getRunWorkflow('run-1');

  assert.equal(workflow.nodes.find((node) => node.id === 'analyst')?.status, 'succeeded');
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
      payload: {
        outcome: 'approved',
        resolvedBy: 'tester',
        resolvedAt: (calls[1]?.kind === 'signal' ? (calls[1].payload as { resolvedAt: string }).resolvedAt : ''),
        inboxId: 'inbox-1',
      },
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

test('TaskControlPlaneApiService.resolveGate validates named outcomes and propagates human note', async () => {
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['approve_anyway', 'rework', 'cancel'],
          context: { topic: 'plan', summary: { nodeId: 'codeStuckGate', outcomes: ['approve_anyway', 'rework', 'cancel'] } },
        });
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });

  const result = await api.resolveGate({
    inboxId: 'inbox-1',
    outcome: 'rework',
    note: 'Please fix the cited issue.',
    resolvedBy: 'human',
  });

  assert.equal(result.signaled, true);
  assert.deepEqual(signals, [
    {
      outcome: 'rework',
      note: 'Please fix the cited issue.',
      resolvedBy: 'human',
      resolvedAt: (signals[0] as { resolvedAt: string }).resolvedAt,
      inboxId: 'inbox-1',
    },
  ]);
  assert.match((signals[0] as { resolvedAt: string }).resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('TaskControlPlaneApiService.resolveGate supports retry gates with reconcile metadata', async () => {
  const signalTopic = 'retry:unique-gate-topic';
  const signals: Array<{ topic: string; payload: unknown }> = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['retry', 'give_up'],
          context: { topic: 'retry', signalTopic, summary: { kind: 'transient_retry', outcomes: ['retry', 'give_up'] } },
        });
      },
    },
    dbosService: {
      async signal(_workflowId, topic, payload) {
        signals.push({ topic, payload });
      },
    },
  });

  const result = await api.resolveGate({
    inboxId: 'inbox-1',
    outcome: 'retry',
    reconcile: 'keep',
    note: 'try the provider again',
    resolvedBy: 'human',
  });

  assert.equal(result.topic, 'retry');
  assert.deepEqual(signals, [
    {
      topic: signalTopic,
      payload: {
        outcome: 'retry',
        note: 'try the provider again',
        reconcile: 'keep',
        resolvedBy: 'human',
        resolvedAt: (signals[0]?.payload as { resolvedAt: string }).resolvedAt,
        inboxId: 'inbox-1',
      },
    },
  ]);
});

test('TaskControlPlaneApiService.resolveGate rejects invalid outcome and approve_anyway without note', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['approve_anyway', 'rework', 'cancel'],
          context: { topic: 'plan', summary: { outcomes: ['approve_anyway', 'rework', 'cancel'] } },
        });
      },
    },
  });

  await assert.rejects(() => api.resolveGate({ inboxId: 'inbox-1', outcome: 'approved', resolvedBy: 'human' }), /invalid gate outcome/);
  await assert.rejects(() => api.resolveGate({ inboxId: 'inbox-1', outcome: 'approve_anyway', resolvedBy: 'human' }), /requires a non-empty note/);
});

test('TaskControlPlaneApiService.resolveGate rejects invalid retry reconcile values', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['retry', 'give_up'],
          context: { topic: 'retry', summary: { kind: 'transient_retry', outcomes: ['retry', 'give_up'] } },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'retry', reconcile: 'wipe' as never, resolvedBy: 'human' }),
    /gate reconcile must be keep/,
  );
  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'retry', reconcile: 'reset' as never, resolvedBy: 'human' }),
    /gate reconcile must be keep/,
  );
});

test('TaskControlPlaneApiService requires a human note for questionGate fix and wontfix outcomes', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['fix', 'wontfix', 'cancel'],
          context: { topic: 'question', summary: { nodeId: 'questionGate', outcomes: ['fix', 'wontfix', 'cancel'] } },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'fix', resolvedBy: 'human' }),
    /questionGate fix requires a non-empty note/,
  );
  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'wontfix', note: '   ', resolvedBy: 'human' }),
    /questionGate wontfix requires a non-empty note/,
  );
  await assert.rejects(
    () => api.resolveInboxItem({ inboxId: 'inbox-1', answer: { outcome: 'fix' }, resolvedBy: 'human' }),
    /questionGate fix requires a non-empty note/,
  );
  await assert.rejects(
    () => api.resolveInboxItem({ inboxId: 'inbox-1', answer: { outcome: 'wontfix', note: '   ' }, resolvedBy: 'human' }),
    /questionGate wontfix requires a non-empty note/,
  );
});

const completeAdoptionAudit = {
  runId: 'run-1',
  step: 'developer',
  role: 'developer-codex',
  artifactRef: 'attempt:attempt-1',
  targetRepo: '/repo',
  targetBranch: 'feature/x',
  actor: 'anton',
  scope: 'apply generated patch only',
  risk: 'manual conflict resolution may change behavior',
  verificationResponsibility: 'main session must run pnpm verify',
};

test('TaskControlPlaneApiService.resolveGate requires complete audit for adopt_patch_manually', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'],
          context: {
            topic: 'question',
            runId: 'run-1',
            summary: { outcomes: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'] },
          },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'adopt_patch_manually', resolvedBy: 'human' }),
    /requires adoptionAudit/,
  );
  await assert.rejects(
    () => api.resolveGate({
      inboxId: 'inbox-1',
      outcome: 'adopt_patch_manually',
      resolvedBy: 'human',
      adoptionAudit: { ...completeAdoptionAudit, runId: 'other-run' },
    }),
    /must match gate runId run-1/,
  );
});

test('TaskControlPlaneApiService.resolveInboxItem requires gate runId before adopting a manual patch', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          runId: '',
          options: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'],
          context: {
            topic: 'question',
            summary: { outcomes: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'] },
          },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveInboxItem({
      inboxId: 'inbox-1',
      answer: { outcome: 'adopt_patch_manually', adoptionAudit: completeAdoptionAudit },
      resolvedBy: 'human',
      signalGate: false,
    }),
    /requires a gate runId/,
  );
});

test('TaskControlPlaneApiService.resolveGate persists adoptionAudit for adopt_patch_manually', async () => {
  const resolvedAnswers: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'],
          context: {
            topic: 'question',
            summary: { outcomes: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'] },
          },
        });
      },
      async resolveInbox(_id, answer) {
        resolvedAnswers.push(answer);
        return { status: 'pending' as const, answer };
      },
    },
  });

  await api.resolveGate({
    inboxId: 'inbox-1',
    outcome: 'adopt_patch_manually',
    resolvedBy: 'human',
    adoptionAudit: completeAdoptionAudit,
  });

  assert.deepEqual((resolvedAnswers[0] as { adoptionAudit: unknown }).adoptionAudit, completeAdoptionAudit);
});

const completeMergeOverrideAudit = {
  threadIds: ['thread-abc', 'thread-def'],
  actor: 'kap',
  reason: 'threads are stale and authors are unavailable; proceeding with documented risk',
  risk: 'unresolved reviewer concern may resurface post-merge',
  verificationResponsibility: 'release engineer must re-review threads within 24 h',
  headSha: 'abc123def456',
};

test('TaskControlPlaneApiService.resolveGate requires complete audit for override_merge', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          runId: 'run-1',
          options: ['recheck', 'address_review_threads', 'return_to_development', 'override_merge', 'cancel'],
          context: {
            topic: 'merge',
            summary: { outcomes: ['recheck', 'address_review_threads', 'return_to_development', 'override_merge', 'cancel'] },
          },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveGate({
      inboxId: 'inbox-1',
      outcome: 'override_merge',
      note: 'operator accepts advisory risk',
      resolvedBy: 'human',
    }),
    /requires mergeOverrideAudit/,
  );
  await assert.rejects(
    () => api.resolveGate({
      inboxId: 'inbox-1',
      outcome: 'override_merge',
      note: 'operator accepts advisory risk',
      resolvedBy: 'human',
      mergeOverrideAudit: {
        actor: completeMergeOverrideAudit.actor,
        reason: completeMergeOverrideAudit.reason,
        risk: completeMergeOverrideAudit.risk,
        verificationResponsibility: completeMergeOverrideAudit.verificationResponsibility,
        headSha: completeMergeOverrideAudit.headSha,
      },
    }),
    /threadIds must be an array/,
  );
  await assert.rejects(
    () => api.resolveGate({
      inboxId: 'inbox-1',
      outcome: 'override_merge',
      note: 'operator accepts advisory risk',
      resolvedBy: 'human',
      mergeOverrideAudit: { ...completeMergeOverrideAudit, threadIds: ['ok', ''] },
    }),
    /threadIds must contain non-empty strings/,
  );
  await assert.rejects(
    () => api.resolveGate({
      inboxId: 'inbox-1',
      outcome: 'override_merge',
      resolvedBy: 'human',
      mergeOverrideAudit: completeMergeOverrideAudit,
    }),
    /override_merge requires a non-empty note/,
  );
});

test('TaskControlPlaneApiService.resolveGate persists mergeOverrideAudit for override_merge', async () => {
  const resolvedAnswers: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          runId: 'run-1',
          options: ['recheck', 'address_review_threads', 'return_to_development', 'override_merge', 'cancel'],
          context: {
            topic: 'merge',
            summary: { outcomes: ['recheck', 'address_review_threads', 'return_to_development', 'override_merge', 'cancel'] },
          },
        });
      },
      async resolveInbox(_id, answer) {
        resolvedAnswers.push(answer);
        return { status: 'pending' as const, answer };
      },
    },
  });

  await api.resolveGate({
    inboxId: 'inbox-1',
    outcome: 'override_merge',
    note: 'operator accepts advisory risk',
    resolvedBy: 'human',
    mergeOverrideAudit: { ...completeMergeOverrideAudit, threadIds: [] },
  });

  assert.deepEqual((resolvedAnswers[0] as { mergeOverrideAudit: unknown }).mergeOverrideAudit, { ...completeMergeOverrideAudit, threadIds: [] });
  assert.equal((resolvedAnswers[0] as { note: string }).note, 'operator accepts advisory risk');
});

test('TaskControlPlaneApiService.resolveInboxItem normalizes named gate outcome before persist and signal', async () => {
  const resolvedAnswers: unknown[] = [];
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['approve_anyway', 'rework', 'cancel'],
          context: { topic: 'plan', summary: { outcomes: ['approve_anyway', 'rework', 'cancel'] } },
        });
      },
      async resolveInbox(_id, answer) {
        resolvedAnswers.push(answer);
        return { status: 'pending' as const, answer };
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });

  const result = await api.resolveInboxItem({
    inboxId: 'inbox-1',
    answer: { outcome: ' rework ', note: ' fix the review finding ' },
    resolvedBy: 'human',
  });

  assert.deepEqual(resolvedAnswers, [{ outcome: 'rework', note: 'fix the review finding' }]);
  assert.deepEqual(signals, [{ outcome: 'rework', note: 'fix the review finding' }]);
  assert.deepEqual(result.answer, { outcome: 'rework', note: 'fix the review finding' });
});

test('TaskControlPlaneApiService.resolveInboxItem requires adoption audit for adopt_patch_manually', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'],
          context: {
            topic: 'question',
            summary: { outcomes: ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'] },
          },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveInboxItem({ inboxId: 'inbox-1', answer: { outcome: 'adopt_patch_manually' } }),
    /requires adoptionAudit/,
  );
  await assert.rejects(
    () => api.resolveInboxItem({
      inboxId: 'inbox-1',
      answer: { outcome: 'adopt_patch_manually' },
      signalGate: false,
    }),
    /requires adoptionAudit/,
  );
  await assert.rejects(
    () => api.resolveInboxItem({
      inboxId: 'inbox-1',
      answer: { outcome: 'adopt_patch_manually', adoptionAudit: { ...completeAdoptionAudit, artifactRef: ' ' } },
    }),
    /requires artifactRef or worktreeRef/,
  );
});

test('TaskControlPlaneApiService.resolveInboxItem rejects blank named gate outcome', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['approve_anyway', 'rework', 'cancel'],
          context: { topic: 'plan', summary: { outcomes: ['approve_anyway', 'rework', 'cancel'] } },
        });
      },
    },
  });

  await assert.rejects(
    () => api.resolveInboxItem({ inboxId: 'inbox-1', answer: { outcome: '   ' }, resolvedBy: 'human' }),
    /gate outcome must be non-empty/,
  );
});

test('TaskControlPlaneApiService approve/reject wrappers reject ambiguous named stuck gates', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['approve_anyway', 'rework', 'cancel'],
          context: { topic: 'plan', summary: { outcomes: ['approve_anyway', 'rework', 'cancel'] } },
        });
      },
    },
  });

  await assert.rejects(() => api.approveGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
  await assert.rejects(() => api.rejectGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
});

test('TaskControlPlaneApiService approve/reject wrappers reject question gates that require notes', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['fix', 'wontfix'],
          context: { topic: 'question', summary: { nodeId: 'questionGate', outcomes: ['fix', 'wontfix'] } },
        });
      },
    },
  });

  await assert.rejects(() => api.approveGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
  await assert.rejects(() => api.rejectGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
});

test('TaskControlPlaneApiService approve/reject wrappers reject retry gates', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          options: ['retry', 'give_up'],
          context: { topic: 'retry', summary: { kind: 'transient_retry', outcomes: ['retry', 'give_up'] } },
        });
      },
    },
  });

  await assert.rejects(() => api.approveGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
  await assert.rejects(() => api.rejectGate({ inboxId: 'inbox-1' }), /use resolve_gate/);
});

test('TaskControlPlaneApiService.rejectGate uses legacy reject when named gates have no rejection outcome', async () => {
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          context: { topic: 'plan', summary: { outcomes: ['approved'] } },
          options: ['approved'],
        });
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });

  const rejected = await api.rejectGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.deepEqual(rejected.answer, { decision: 'reject', resolvedBy: 'tester' });
  assert.deepEqual(signals, [{ decision: 'reject', resolvedBy: 'tester' }]);
});

test('TaskControlPlaneApiService.approveGate keeps legacy payloads for single-outcome approval gates', async () => {
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          context: { topic: 'plan', summary: { outcomes: ['approved'] } },
          options: ['approved'],
        });
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });

  const approved = await api.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.deepEqual(approved.answer, { decision: 'approve', resolvedBy: 'tester' });
  assert.deepEqual(signals, [{ decision: 'approve', resolvedBy: 'tester' }]);
});

test('TaskControlPlaneApiService.resolveGate requires declared named outcomes for legacy gates', async () => {
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ context: { topic: 'plan' }, options: ['approve', 'reject'] });
      },
    },
  });

  await assert.rejects(
    () => api.resolveGate({ inboxId: 'inbox-1', outcome: 'approve' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('TaskControlPlaneApiService wrappers preserve legacy approve/reject answers without declared outcomes', async () => {
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ context: { topic: 'plan' }, options: ['approve', 'reject'] });
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });

  const approved = await api.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.deepEqual(approved.answer, { decision: 'approve', resolvedBy: 'tester' });
  assert.deepEqual(signals, [{ decision: 'approve', resolvedBy: 'tester' }]);
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

function gateReplayFixture() {
  let inbox = makeInboxItem();
  const signals: unknown[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return inbox;
      },
      async resolveInbox(_id, answer, resolvedBy) {
        if (inbox.status === 'pending') {
          inbox = {
            ...inbox,
            status: 'resolved',
            answer,
            resolvedBy,
            resolvedAt: '2026-07-10T12:00:00.000Z',
          };
          return { status: 'pending' as const, answer };
        }
        return { status: 'resolved' as const, answer: inbox.answer };
      },
    },
    dbosService: {
      async signal(_workflowId, _topic, payload) {
        signals.push(payload);
      },
    },
  });
  return { api, getInbox: () => inbox, signals };
}

test(focusedCaseTitle(
  'B5',
  focusedOwner,
  'same-answer duplicate exposes resolved previousStatus and reuses the first stored answer',
), async () => {
  const fixture = gateReplayFixture();

  const first = await fixture.api.approveGate({ inboxId: fixture.getInbox().id, resolvedBy: 'alice' });
  const duplicate = await fixture.api.approveGate({ inboxId: fixture.getInbox().id, resolvedBy: 'alice-retry' });

  assert.equal(first.previousStatus, 'pending');
  assert.equal(duplicate.previousStatus, 'resolved');
  assert.deepEqual(duplicate.answer, first.answer);
  assert.equal(first.signaled, true);
  assert.equal(duplicate.signaled, true);
  assert.deepEqual(fixture.signals, [first.answer, first.answer]);
});

test(focusedCaseTitle(
  'B6',
  focusedOwner,
  'different-answer conflict exposes resolved previousStatus and signals the first stored answer',
), async () => {
  const fixture = gateReplayFixture();

  const approved = await fixture.api.approveGate({ inboxId: fixture.getInbox().id, resolvedBy: 'alice' });
  const conflicting = await fixture.api.rejectGate({ inboxId: fixture.getInbox().id, resolvedBy: 'bob' });

  assert.equal(approved.previousStatus, 'pending');
  assert.equal(conflicting.previousStatus, 'resolved');
  assert.deepEqual(conflicting.answer, approved.answer, 'first decision wins over a conflicting replay');
  assert.equal(approved.signaled, true);
  assert.equal(conflicting.signaled, true);
  assert.deepEqual(fixture.signals, [approved.answer, approved.answer]);
});

test(focusedCaseTitle('B7', focusedOwner, 'answerQuestion refuses gate rows'), async () => {
  const api = makeApi();
  await assert.rejects(
    () => api.answerQuestion({ inboxId: 'inbox-1', answer: 'yes' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test(focusedCaseTitle('B9', focusedOwner, 'unknown inbox gate operations preserve ROW_NOT_FOUND'), async () => {
  const missing = new ControlPlaneError('ROW_NOT_FOUND', 'inbox item not found: inbox-missing');
  const api = makeApi({
    inboxService: {
      async getInbox() {
        throw missing;
      },
    },
  });

  await assert.rejects(() => api.approveGate({ inboxId: 'inbox-missing' }), missing);
  await assert.rejects(() => api.rejectGate({ inboxId: 'inbox-missing' }), missing);
  await assert.rejects(() => api.getInboxItem('inbox-missing'), missing);
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

test('TaskControlPlaneApiService.answerQuestion records retryable signal state around workflow-owned agent questions', async () => {
  const calls: Array<
    | { kind: 'event'; type: string; runId: string; taskId: string; stepKey: string; idempotencyKey?: string; payload: unknown }
    | { kind: 'signal'; workflowId: string; topic: string; payload: unknown; key?: string }
  > = [];
  const answer = { provider: 'oauth' };
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          kind: 'question',
          taskId: '',
          context: {
            topic: 'question',
            signalTopic: 'question:agent-analyst',
            summary: { kind: 'agent_question', nodeId: 'analyst', step: 'analyst', taskId: 'task-1' },
          },
          runId: 'run-1',
        });
      },
      async resolveInbox(_id, value, resolvedBy) {
        assert.equal(resolvedBy, 'human');
        return { status: 'pending' as const, answer: value };
      },
    },
    runService: {
      async appendEvent(input) {
        calls.push({
          kind: 'event',
          type: input.type,
          runId: input.runId,
          taskId: input.taskId,
          stepKey: input.stepKey,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
        });
      },
    },
    dbosService: {
      async signal(workflowId, topic, payload, key) {
        calls.push({ kind: 'signal', workflowId, topic, payload, key });
      },
    },
  });

  const result = await api.answerQuestion({ inboxId: 'inbox-1', answer, resolvedBy: 'human' });

  assert.equal(result.signaled, true);
  assert.equal(result.topic, 'question');
  assert.deepEqual(calls, [
    {
      kind: 'event',
      type: 'question_signal_pending',
      runId: 'run-1',
      taskId: 'task-1',
      stepKey: 'analyst',
      idempotencyKey: 'inbox-1',
      payload: {
        inboxId: 'inbox-1',
        topic: 'question',
        signalTopic: 'question:agent-analyst',
        stepKey: 'analyst',
      },
    },
    {
      kind: 'signal',
      workflowId: 'run-1',
      topic: 'question:agent-analyst',
      payload: { answer, resolvedBy: 'human', inboxId: 'inbox-1' },
      key: 'inbox-1',
    },
    {
      kind: 'event',
      type: 'question_signaled',
      runId: 'run-1',
      taskId: 'task-1',
      stepKey: 'analyst',
      idempotencyKey: 'inbox-1',
      payload: {
        inboxId: 'inbox-1',
        topic: 'question',
        signalTopic: 'question:agent-analyst',
        stepKey: 'analyst',
      },
    },
  ]);
});

test('TaskControlPlaneApiService.answerQuestion leaves pending signal state when workflow question signaling fails', async () => {
  const events: string[] = [];
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return makeInboxItem({
          kind: 'question',
          context: {
            topic: 'question',
            signalTopic: 'question:agent-analyst',
            summary: { kind: 'agent_question', nodeId: 'analyst', step: 'analyst', taskId: 'task-1' },
          },
          runId: 'run-1',
        });
      },
    },
    runService: {
      async appendEvent(input) {
        events.push(input.type);
      },
    },
    dbosService: {
      async signal() {
        throw new Error('question signal failed');
      },
    },
  });

  await assert.rejects(() => api.answerQuestion({ inboxId: 'inbox-1', answer: 'answer' }), /question signal failed/);
  assert.deepEqual(events, ['question_signal_pending']);
});

test('TaskControlPlaneApiService.answerQuestion retries failed workflow question signal with stored resolver', async () => {
  const answer = { provider: 'oauth' };
  const signals: Array<{ workflowId: string; topic: string; payload: unknown; key?: string }> = [];
  let signalAttempts = 0;
  let inbox = makeInboxItem({
    kind: 'question',
    context: {
      topic: 'question',
      signalTopic: 'question:agent-analyst',
      summary: { kind: 'agent_question', nodeId: 'analyst', step: 'analyst', taskId: 'task-1' },
    },
    runId: 'run-1',
  });
  const api = makeApi({
    inboxService: {
      async getInbox() {
        return inbox;
      },
      async resolveInbox(_id, value, resolvedBy) {
        if (inbox.status === 'pending') {
          inbox = {
            ...inbox,
            status: 'resolved',
            answer: value,
            resolvedBy,
            resolvedAt: '2026-06-13T00:01:00.000Z',
          };
          return { status: 'pending' as const, answer: value };
        }
        return { status: 'resolved' as const, answer: inbox.answer };
      },
    },
    dbosService: {
      async signal(workflowId, topic, payload, key) {
        signalAttempts += 1;
        if (signalAttempts === 1) {
          throw new Error('question signal failed');
        }
        signals.push({ workflowId, topic, payload, key });
      },
    },
  });

  await assert.rejects(
    () => api.answerQuestion({ inboxId: 'inbox-1', answer, resolvedBy: 'human' }),
    /question signal failed/,
  );
  const result = await api.answerQuestion({ inboxId: 'inbox-1', answer: { provider: 'retry-default' } });

  assert.equal(result.previousStatus, 'resolved');
  assert.deepEqual(signals, [
    {
      workflowId: 'run-1',
      topic: 'question:agent-analyst',
      payload: { answer, resolvedBy: 'human', inboxId: 'inbox-1' },
      key: 'inbox-1',
    },
  ]);
});

test('TaskControlPlaneApiService.createRun can immediately start the workflow', async () => {
  const starts: Array<{ runId: string; pipelineId?: string; override?: string }> = [];
  const api = makeApi({
    pipelineService: {
      async startDataDrivenTask(runId, opts) {
        starts.push({
          runId,
          pipelineId: executionPlanFromRouteDecision(opts.route).selection.pipelineId,
          override: executionPlanFromRouteDecision(opts.route).agentBindings.find((binding) => binding.roleId === 'developer')?.runnerId,
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  const result = await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
    profile: LOCAL_CHANGE_PROFILE,
    start: true,
  });

  assert.equal(result.started, true);
  assert.deepEqual(starts, [{ runId: 'run-1', pipelineId: 'local-change', override: 'codex' }]);
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
  assert.equal((record.route as RouteDecision).projection.pipelineId, 'local-change');
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
      error.message.includes('parent route_decision is invalid'),
  );
});

test('TaskControlPlaneApiService.resumeRun rejects recovery when route_decision is an invalid record', async () => {
  const parentData = pausedRecoveryParentData({
    title: 'Recover invalid route decision record',
    route_decision: {},
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
        return [preflightBlockedEvent({ payload: { reason: 'preflight', lesson: 'empty route decision' } })];
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
      error.message.includes('parent route_decision is invalid'),
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
    profile: LOCAL_CHANGE_PROFILE,
  });

  assert.equal(persistedPipelineId, 'local-change');
});

test('TaskControlPlaneApiService.createRun normalizes issueRef into public params', async () => {
  const issueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  let persistedParams: Record<string, unknown> = {};
  const api = makeApi({
    runService: {
      async createRun(input) {
        persistedParams = input.params ?? {};
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
    },
  });

  await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
    profile: LOCAL_CHANGE_PROFILE,
    params: { ticket: 'RV-147' },
    issueRef,
  });

  assert.deepEqual(persistedParams, { ticket: 'RV-147', issueRef, issueAction: 'close' });
});

test('TaskControlPlaneApiService.createRun rejects conflicting top-level and params issueRef', async () => {
  const issueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const api = makeApi();

  await assert.rejects(
    () => api.createRun({
      title: 'MCP task',
      repo: '.',
      pipelineId: 'local-change',
      params: { issueRef },
      issueRef: { ...issueRef, number: 148 },
    }),
    /issueRef conflicts with params\.issueRef/,
  );
});

test(focusedCaseTitle(
  ['I4', 'H4'],
  focusedOwner,
  'createRun treats public route-looking params as inert data',
), async () => {
  const starts: Array<{ override?: string; params: Record<string, unknown> }> = [];
  const api = makeApi({
    pipelineService: {
      async startDataDrivenTask(runId, opts) {
        starts.push({
          override: executionPlanFromRouteDecision(opts.route).agentBindings.find((binding) => binding.roleId === 'developer')?.runnerId,
          params: executionPlanFromRouteDecision(opts.route).businessParams,
        });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });

  await api.createRun({
    title: 'MCP task',
    repo: '.',
    pipelineId: 'local-change',
    profile: {
      schemaVersion: 'run-profile/v1',
      topology: { stages: { developer: { mode: 'single' } } },
      bindings: { slots: { 'node:developer': { runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {} } } },
    },
    params: { profileLike: { runner: 'stub-agent' }, ticket: 'ABC-1' },
    start: true,
  });

  assert.deepEqual(starts, [{ override: 'codex', params: { profileLike: { runner: 'stub-agent' }, ticket: 'ABC-1' } }]);
});

test('TaskControlPlaneApiService.resolveRunState exposes issueRef from run params', async () => {
  const issueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const api = makeApi({
    runService: {
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
            issueRef,
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
        return null;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'ready');
  assert.deepEqual(state.issueRef, issueRef);
});

test('TaskControlPlaneApiService.resolveRunState reports ready when a run has not started', async () => {
  const api = makeApi({
    runService: {
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
          tasks: [{ taskId: 'task-1', title: 'Task', status: 'ready', roleHint: 'developer' }],
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
        return null;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'ready');
  assert.equal(state.runStatus, 'ready');
  assert.equal(state.workflowStatus, '');
  assert.equal(state.nextAction, 'start_run');
});

test('TaskControlPlaneApiService.resolveRunState reports cancelled as a terminal state', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: {
            runId: 'run-1',
            title: 'Run',
            status: 'cancelled',
            priority: 0,
            createdAt: '2026-06-13T00:00:00.000Z',
            description: '',
            scope: '',
            repos: [],
          },
          tasks: [{ taskId: 'task-1', title: 'Task', status: 'cancelled', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [];
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'SUCCESS',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-13T00:00:00.000Z'),
          updatedAt: Date.parse('2026-06-13T00:00:01.000Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'cancelled');
  assert.equal(state.runStatus, 'cancelled');
  assert.equal(state.workflowStatus, 'SUCCESS');
  assert.equal(state.nextAction, 'run was cancelled intentionally');
});

test('TaskControlPlaneApiService.resolveRunState reports running when workflow progressed but row stayed ready', async () => {
  const api = makeApi({
    runService: {
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
          tasks: [{ taskId: 'task-1', title: 'Task', status: 'ready', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-step',
            type: 'step_succeeded',
            actor: 'orchestrator',
            createdAt: '2026-06-28T07:36:41.803Z',
            taskId: 'task-1',
            stepId: 'pstep-1',
            payload: { stepKey: 'developer', attemptId: 'attempt-1' },
          },
        ];
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'PENDING',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-28T07:33:58.483Z'),
          updatedAt: Date.parse('2026-06-28T07:36:41.803Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'running');
  assert.equal(state.runStatus, 'running');
  assert.equal(state.workflowStatus, 'PENDING');
});

test('hasWorkflowProgress recognizes data-driven integrator progress events', () => {
  for (const type of INTEGRATOR_PROGRESS_EVENT_TYPES) {
    assert.equal(hasWorkflowProgress([{ type } as never]), true, type);
  }
  assert.equal(hasWorkflowProgress([{ type: 'run_created' } as never]), false);
});

test('TaskControlPlaneApiService.resolveRunState treats foreign_pr_adopted as workflow progress', async () => {
  const api = makeApi({
    runService: {
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
          tasks: [{ taskId: 'task-1', title: 'Task', status: 'ready', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-foreign-pr',
            type: 'foreign_pr_adopted',
            actor: 'orchestrator',
            createdAt: '2026-06-28T07:36:41.803Z',
            taskId: 'task-1',
            stepId: 'integrator',
            payload: { prNumber: 42 },
          },
        ];
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return null;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'running');
  assert.equal(state.runStatus, 'running');
  assert.equal(state.workflowStatus, '');
  assert.equal(state.latestEventType, 'foreign_pr_adopted');
});

test('TaskControlPlaneApiService.resolveRunState exposes the latest workflow event pulse', async () => {
  const api = makeApi({
    runService: {
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
          tasks: [{ taskId: 'task-1', title: 'Task', status: 'ready', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [
          {
            eventId: 'event-old',
            type: 'integrate_succeeded',
            actor: 'orchestrator',
            createdAt: '2026-06-28T09:36:56.844Z',
            taskId: 'task-1',
            stepId: '',
            payload: {},
          },
          {
            eventId: 'event-new',
            type: 'pr_polled',
            actor: 'orchestrator',
            createdAt: '2026-06-28T09:40:19.802Z',
            taskId: 'task-1',
            stepId: '',
            payload: { verdict: 'clean' },
          },
        ];
      },
    },
    inboxService: {
      async listInbox() {
        return [];
      },
    },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1',
          status: 'PENDING',
          workflowName: 'dataDrivenTask',
          workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-28T09:34:06.403Z'),
          updatedAt: Date.parse('2026-06-28T09:40:19.802Z'),
          priority: 0,
          applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'running');
  assert.equal(state.latestEventAt, '2026-06-28T09:40:19.802Z');
  assert.equal(state.latestEventType, 'pr_polled');
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

test('TaskControlPlaneApiService.resolveInboxItem signals merge gates without completing the run', async () => {
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

test('TaskControlPlaneApiService.resolveInboxItem skips merge gate signaling when signalGate is false', async () => {
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
  assert.equal(completeRunCalled, false);
});

test('TaskControlPlaneApiService.resolveInboxItem does not complete a plan gate', async () => {
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
  assert.equal(completeRunCalled, false);
});

test('TaskControlPlaneApiService.resolveRunState surfaces blockedReason from a pipeline_blocked event', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'running', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [{ eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'plan gate rejected', nodeId: 'reviewer' } }];
      },
    },
    inboxService: { async listInbox() { return []; } },
    dbosService: { async getWorkflowStatus() { return null; } },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'blocked');
  assert.equal(state.blockedReason, 'plan gate rejected');
});

test('TaskControlPlaneApiService.resolveRunState omits blockedReason without a pipeline_blocked event', async () => {
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
    inboxService: { async listInbox() { return []; } },
    dbosService: { async getWorkflowStatus() { return null; } },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.blockedReason, undefined);
});

test('TaskControlPlaneApiService.resolveRunState surfaces blockedReason for a paused run', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'paused', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [],
        };
      },
      async listRunEvents() {
        return [{ eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'reviewer blocked' } }];
      },
    },
    inboxService: { async listInbox() { return []; } },
    dbosService: { async getWorkflowStatus() { return null; } },
  });

  const state = await api.resolveRunState('run-1');

  assert.equal(state.state, 'blocked');
  assert.equal(state.blockedReason, 'reviewer blocked');
});

test('TaskControlPlaneApiService.getRunDigest includes blockedReason from a pipeline_blocked event', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return { run: { runId: 'run-1', title: 'R', status: 'paused', priority: 0, createdAt: '', description: '', scope: '', repos: [] }, tasks: [] };
      },
      async listRunEvents() {
        return [{ eventId: 'e1', type: 'pipeline_blocked', actor: 'engine', createdAt: '', taskId: '', stepId: '', payload: { reason: 'no budget' } }];
      },
      async listRunAttempts() { return []; },
    },
    inboxService: { async listInbox() { return []; } },
  });

  const digest = await api.getRunDigest('run-1');

  assert.equal(digest.blockedReason, 'no budget');
});

test('TaskControlPlaneApiService.getRunDigest omits blockedReason without a pipeline_blocked event', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return { run: { runId: 'run-1', title: 'R', status: 'running', priority: 0, createdAt: '', description: '', scope: '', repos: [] }, tasks: [] };
      },
      async listRunEvents() { return []; },
      async listRunAttempts() { return []; },
    },
    inboxService: { async listInbox() { return []; } },
  });

  const digest = await api.getRunDigest('run-1');

  assert.equal(digest.blockedReason, undefined);
});

test('TaskControlPlaneApiService.getRunDigest normalizes a stale ready row while workflow is running', async () => {
  const api = makeApi({
    runService: {
      async showRun() {
        return {
          run: { runId: 'run-1', title: 'R', status: 'ready', priority: 0, createdAt: '', description: '', scope: '', repos: [] },
          tasks: [{ taskId: 'task-1', title: 'T', status: 'ready', roleHint: 'developer' }],
        };
      },
      async listRunEvents() {
        return [{ eventId: 'e1', type: 'step_succeeded', actor: 'engine', createdAt: '', taskId: 'task-1', stepId: 'step-1', payload: { stepKey: 'developer' } }];
      },
      async listRunAttempts() { return []; },
    },
    inboxService: { async listInbox() { return []; } },
    dbosService: {
      async getWorkflowStatus() {
        return {
          workflowID: 'run-1', status: 'PENDING', workflowName: 'dataDrivenTask', workflowClassName: 'PipelineService',
          createdAt: Date.parse('2026-06-28T09:34:06.403Z'), updatedAt: Date.parse('2026-06-28T09:36:16.078Z'), priority: 0, applicationID: 'test',
        } as Awaited<ReturnType<DbosService['getWorkflowStatus']>>;
      },
    },
  });

  const digest = await api.getRunDigest('run-1');

  assert.equal(digest.run.status, 'running');
  assert.equal(digest.tasks[0]?.status, 'running');
});

test('TaskControlPlaneApiService.previewPipelineSelection returns confident wouldAutoRoute pick', async () => {
  const api = makeApi();

  const preview = await api.previewPipelineSelection({ title: 'small local edit' });

  assert.equal(preview.playbookId, 'pb');
  assert.ok(Array.isArray(preview.candidatePipelines) && preview.candidatePipelines.length > 0, 'candidatePipelines must be non-empty');
  assert.deepEqual(preview.wouldAutoRoute, { pipelineId: 'local-change', pipelineRowId: 'pb-local-change' });
  assert.equal(preview.wouldAutoRouteReason, undefined);
});

test('TaskControlPlaneApiService.previewPipelineSelection returns wouldAutoRoute:null with reason when ambiguous', async () => {
  const api = makeApi({
    playbooksService: {
      async resolvePlaybook() {
        return { id: 'pb', name: 'PB', packageName: '@x/pb', version: '1.0.0', source: 'local:/pb', schemaVersion: 2 };
      },
      async listPipelines() {
        return [
          {
            id: 'pb-a',
            playbookId: 'pb',
            pipelineId: 'a',
            path: 'pipelines/a/PIPELINE.md',
            triggers: ['review task'],
            routeGates: [],
            executionPolicy: {},
          },
          {
            id: 'pb-b',
            playbookId: 'pb',
            pipelineId: 'b',
            path: 'pipelines/b/PIPELINE.md',
            triggers: ['review task'],
            routeGates: [],
            executionPolicy: {},
          },
        ];
      },
      async resolvePipeline() { return null as never; },
      async getPipeline() { return null; },
    },
  });

  const preview = await api.previewPipelineSelection({ title: 'review task' });

  assert.equal(preview.wouldAutoRoute, null);
  assert.ok(typeof preview.wouldAutoRouteReason === 'string' && preview.wouldAutoRouteReason.length > 0, 'reason must be non-empty');
  assert.equal(preview.candidatePipelines.length, 2, 'both pipelines are candidates');
});

test('TaskControlPlaneApiService.previewPipelineSelection filters candidatePipelines to resolved playbook and sorts by id', async () => {
  const api = makeApi({
    playbooksService: {
      async resolvePlaybook() {
        return { id: 'pb', name: 'PB', packageName: '@x/pb', version: '1.0.0', source: 'local:/pb', schemaVersion: 2 };
      },
      async listPipelines() {
        return [
          {
            id: 'pb-z',
            playbookId: 'pb',
            pipelineId: 'z-pipeline',
            path: 'pipelines/z/PIPELINE.md',
            triggers: [],
            routeGates: [],
            executionPolicy: {},
          },
          {
            id: 'pb-a',
            playbookId: 'pb',
            pipelineId: 'a-pipeline',
            path: 'pipelines/a/PIPELINE.md',
            triggers: [],
            routeGates: [],
            executionPolicy: {},
          },
          {
            id: 'other-x',
            playbookId: 'other-playbook',
            pipelineId: 'x-pipeline',
            path: 'pipelines/x/PIPELINE.md',
            triggers: [],
            routeGates: [],
            executionPolicy: {},
          },
        ];
      },
      async resolvePipeline() { return null as never; },
      async getPipeline() { return null; },
    },
  });

  const preview = await api.previewPipelineSelection({ title: 'anything' });

  assert.equal(preview.candidatePipelines.length, 2, 'only pipelines for playbook pb');
  assert.equal(preview.candidatePipelines[0]?.id, 'pb-a', 'sorted by id ascending');
  assert.equal(preview.candidatePipelines[1]?.id, 'pb-z');
  assert.ok(preview.candidatePipelines.every((p) => p.playbookId === 'pb'), 'all from correct playbook');
});


test('TaskControlPlaneApiService requires pipelineId and exactly one exact profile source', async () => {
  const api = makeApi();

  await assert.rejects(
    () => api.simulateRoute({ title: 'Task', pipelineId: undefined as never, profile: LOCAL_CHANGE_PROFILE }),
    (error: unknown) => error instanceof ControlPlaneError && error.message.includes('pipelineId is required'),
  );
  await assert.rejects(
    () => api.simulateRoute({ title: 'Task', pipelineId: 'local-change', profileId: 'local', profile: LOCAL_CHANGE_PROFILE }),
    (error: unknown) => error instanceof ControlPlaneError && error.message.includes('exactly one of profileId or profile'),
  );
});

test('focused adapter: simulateRoute materializes analyst consensus at the route boundary', async () => {
  let persistedRoute: RouteDecision | undefined;
  const analystTemplate: Template = {
    specVersion: '1.0',
    pipelineId: 'analysis-only',
    entry: 'analyst',
    verdicts: { domain: ['approved'] },
    nodes: {
      analyst: {
        id: 'analyst',
        kind: 'agent',
        roleRef: 'role:analyst',
        next: 'done',
        onFailure: 'abort',
        resultSchema: 'schema:analysis',
        produces: { name: 'analysis' },
      },
      done: { id: 'done', kind: 'terminal', status: 'succeeded' },
    },
  };
  const api = makeApi({
    runService: {
      async createRun(input) {
        persistedRoute = input.routeDecision as RouteDecision;
        return { runId: 'run-analysis', taskId: 'task-analysis', stepId: 'step-analysis', eventId: 'event-analysis', status: 'ready' };
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-analysis-only',
          playbookId: 'pb',
          pipelineId: 'analysis-only',
          path: 'pipelines/analysis-only/PIPELINE.md',
          triggers: [],
          routeGates: [],
          executionPolicy: { template_json: analystTemplate },
        };
      },
    },
    rolesService: {
      async listRoles() {
        return [{ playbookId: 'pb', playbookRoleId: 'analyst', id: 'pb-analyst', name: 'analyst', surface: '', rights: '' }];
      },
    },
  });

  const route = await api.simulateRoute({
    title: 'Analyze this task',
    pipelineId: 'analysis-only',
    profile: {
      schemaVersion: 'run-profile/v1',
      topology: { stages: { analyst: { mode: 'consensus', branches: 2 } } },
      bindings: {
        slots: {
          'node:analystPrimary': {
            runnerId: 'codex',
            provider: 'openai',
            modelId: 'gpt-5.6-luna',
            modelParams: {},
            permissionMode: 'read-only',
          },
          'node:analystSecondary': {
            runnerId: 'claude-code',
            provider: 'anthropic',
            modelId: 'claude-opus-4-8',
            modelParams: {},
            permissionMode: 'plan',
          },
        },
      },
    },
  });
  const graph = executionPlanFromRouteDecision(route).pipeline.executableGraph as Template;
  const created = await api.createRun({
    title: 'Analyze this task',
    repo: '.',
    pipelineId: 'analysis-only',
    profile: {
      schemaVersion: 'run-profile/v1',
      topology: { stages: { analyst: { mode: 'consensus', branches: 2 } } },
      bindings: {
        slots: {
          'node:analystPrimary': { runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {}, permissionMode: 'read-only' },
          'node:analystSecondary': { runnerId: 'claude-code', provider: 'anthropic', modelId: 'claude-opus-4-8', modelParams: {}, permissionMode: 'plan' },
        },
      },
    },
    start: false,
  });
  assert.ok(persistedRoute);
  assert.equal(route.executionPlanBytes, persistedRoute.executionPlanBytes);
  assert.equal(route.executionPlanDigest, persistedRoute.executionPlanDigest);
  assert.equal(created.route.executionPlanBytes, route.executionPlanBytes);
  assert.equal(created.route.executionPlanDigest, route.executionPlanDigest);
  const plan = executionPlanFromRouteDecision(route);
  const createdPlan = executionPlanFromRouteDecision(persistedRoute);
  assert.deepEqual(plan.pipeline.executableGraph, createdPlan.pipeline.executableGraph);
  assert.equal(plan.pipeline.graphDigest, createdPlan.pipeline.graphDigest);
  assert.equal(plan.pipeline.policyVersion, createdPlan.pipeline.policyVersion);
  assert.equal(plan.profile.profileHash, createdPlan.profile.profileHash);
  assert.equal(plan.pipeline.materializerVersion, '2');
  assert.equal(plan.pipeline.materializerVersion, createdPlan.pipeline.materializerVersion);
  assert.deepEqual(plan.selection.requestedPipelineId, 'analysis-only');
  assert.deepEqual(plan.selection.basePipelineId, 'analysis-only');
  assert.equal(plan.profile.source, 'inline');
  assert.equal(plan.profile.profileId, undefined);
  assert.equal(plan.profile.profileVersion, undefined);
  assert.equal(plan.agentBindings.length, 2);
  assert.equal(plan.agentBindings[0]?.roleDocumentId, plan.agentBindings[1]?.roleDocumentId);
  assert.equal(plan.agentBindings[0]?.runner.runnerId, 'codex');
  assert.equal(plan.agentBindings[1]?.runner.runnerId, 'claude-code');
  assert.deepEqual(plan.agentBindings.map((binding) => ({
    slotKey: binding.slotKey, nodeId: binding.nodeId, roleId: binding.roleId, runnerId: binding.runnerId,
    provider: binding.provider, modelId: binding.modelId, permissionMode: binding.permissionMode, permissionSource: binding.permissionSource,
  })), [
    { slotKey: 'node:analystPrimary', nodeId: 'analystPrimary', roleId: 'analyst', runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', permissionMode: 'read-only', permissionSource: 'profile' },
    { slotKey: 'node:analystSecondary', nodeId: 'analystSecondary', roleId: 'analyst', runnerId: 'claude-code', provider: 'anthropic', modelId: 'claude-opus-4-8', permissionMode: 'plan', permissionSource: 'profile' },
  ]);

  assert.equal(graph.entry, 'analystFanout');
  assert.equal(graph.nodes['analyst'], undefined);
  assert.deepEqual(graph.nodes['analystJoin'], {
    id: 'analystJoin',
    kind: 'join',
    joinMode: { kind: 'all' },
    merge: { analysis: 'appendByBranchOrder' },
    next: 'done',
  });
  assert.equal('verdictReducer' in graph.nodes['analystJoin']!, false);
});

test('focused adapter: simulateRoute rejects developer consensus with a stable topology capability error', async () => {
  const developerTemplate: Template = {
    specVersion: '1.0',
    pipelineId: 'local-change',
    entry: 'developer',
    verdicts: { domain: ['approved'] },
    nodes: {
      developer: {
        id: 'developer',
        kind: 'agent',
        roleRef: 'role:developer',
        next: 'done',
        onFailure: 'abort',
        resultSchema: 'schema:change',
        produces: { name: 'change' },
      },
      done: { id: 'done', kind: 'terminal', status: 'succeeded' },
    },
  };
  let persisted = false;
  const unsupportedProfile = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: { developer: { mode: 'consensus', branches: 2 } } },
    bindings: {
      slots: {
        'role:developer': {
          runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {}, permissionMode: 'workspace-write',
        },
      },
    },
  };
  const api = makeApi({
    runService: {
      async createRun() {
        persisted = true;
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-local-change', playbookId: 'pb', pipelineId: 'local-change',
          path: 'pipelines/local-change/PIPELINE.md', triggers: [], routeGates: [],
          executionPolicy: { template_json: developerTemplate },
        };
      },
    },
    rolesService: {
      async listRoles() {
        return [{ playbookId: 'pb', playbookRoleId: 'developer', id: 'pb-developer', name: 'developer', surface: '', rights: '' }];
      },
    },
  });

  await assert.rejects(
    () => api.simulateRoute({
      title: 'Unsupported developer consensus',
      pipelineId: 'local-change',
      profile: unsupportedProfile,
    }),
    (error: unknown) => error instanceof ControlPlaneError &&
      (error.details as { code?: string } | undefined)?.code === 'profile_topology_unsupported' &&
      error.message.includes('schema:analysis') && error.message.includes('schema:reviewVerdict'),
  );

  await assert.rejects(
    () => api.createRun({
      title: 'Unsupported developer consensus must not persist',
      repo: '.',
      pipelineId: 'local-change',
      profile: unsupportedProfile,
      start: false,
    }),
    (error: unknown) => error instanceof ControlPlaneError &&
      (error.details as { code?: string } | undefined)?.code === 'profile_topology_unsupported',
  );
  assert.equal(persisted, false);

  const nonAgentProfile = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: { done: { mode: 'consensus', branches: 2 } } },
    bindings: { slots: {} },
  };
  await assert.rejects(
    () => api.createRun({
      title: 'Unsupported non-agent consensus must not persist',
      repo: '.',
      pipelineId: 'local-change',
      profile: nonAgentProfile,
      start: false,
    }),
    (error: unknown) => error instanceof ControlPlaneError &&
      (error.details as { code?: string } | undefined)?.code === 'profile_topology_unsupported' &&
      error.message.includes('kind "terminal"'),
  );
  assert.equal(persisted, false);
});

test('simulateRoute and createRun reject the same invalid materialized graph before persistence', async () => {
  let persisted = false;
  const invalidTemplate: Template = {
    specVersion: '1.0',
    pipelineId: 'analysis-only',
    entry: 'analyst',
    verdicts: { domain: ['approved'] },
    nodes: {
      analyst: { id: 'analyst', kind: 'agent', roleRef: 'role:analyst', next: 'missing' },
      done: { id: 'done', kind: 'terminal', status: 'succeeded' },
    },
  };
  const api = makeApi({
    runService: {
      async createRun() {
        persisted = true;
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
    },
    playbooksService: {
      async resolvePipeline() {
        return {
          id: 'pb-analysis-only', playbookId: 'pb', pipelineId: 'analysis-only',
          path: 'pipelines/analysis-only/PIPELINE.md', triggers: [], routeGates: [],
          executionPolicy: { template_json: invalidTemplate },
        };
      },
    },
    rolesService: {
      async listRoles() {
        return [{ playbookId: 'pb', playbookRoleId: 'analyst', id: 'pb-analyst', name: 'analyst', surface: '', rights: '' }];
      },
    },
  });

  const profile = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: { analyst: { mode: 'single' } } },
    bindings: {
      slots: {
        'role:analyst': {
          runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {}, permissionMode: 'read-only',
        },
      },
    },
  };
  let simulateError: ControlPlaneError | undefined;
  await assert.rejects(
    () => api.simulateRoute({ title: 'Invalid graph', pipelineId: 'analysis-only', profile }),
    (error: unknown) => (simulateError = error instanceof ControlPlaneError ? error : undefined) !== undefined &&
      (simulateError.details as { code?: string } | undefined)?.code === 'execution_plan_invalid',
  );
  let createError: ControlPlaneError | undefined;
  await assert.rejects(
    () => api.createRun({
      title: 'Invalid graph',
      repo: '.',
      pipelineId: 'analysis-only',
      profile,
      start: false,
    }),
    (error: unknown) => (createError = error instanceof ControlPlaneError ? error : undefined) !== undefined &&
      (createError.details as { code?: string } | undefined)?.code === 'execution_plan_invalid',
  );
  assert.ok(simulateError && createError);
  assert.deepEqual(simulateError.details, createError.details);
  assert.equal(persisted, false);
});

test('simulateRoute and createRun share canonical plan bytes and createRun persists before start', async () => {
  let persistedRoute: RouteDecision | undefined;
  const api = makeApi({
    runService: {
      async createRun(input) {
        persistedRoute = input.routeDecision as RouteDecision;
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
    },
  });

  const simulated = await api.simulateRoute({ title: 'Task', repo: '.', pipelineId: 'local-change', profile: LOCAL_CHANGE_PROFILE, params: { ticket: 'T-1' } });
  const created = await api.createRun({ title: 'Task', repo: '.', pipelineId: 'local-change', profile: LOCAL_CHANGE_PROFILE, params: { ticket: 'T-1' } });

  assert.ok(persistedRoute);
  assert.equal(simulated.executionPlanBytes, persistedRoute.executionPlanBytes);
  assert.equal(simulated.executionPlanDigest, persistedRoute.executionPlanDigest);
  assert.ok('route' in created);
  assert.equal(created.route.executionPlanBytes, simulated.executionPlanBytes);
  assert.equal(created.route.executionPlanDigest, simulated.executionPlanDigest);
  assert.deepEqual(created.route.executionPlan.agentBindings, simulated.executionPlan.agentBindings);
  assert.deepEqual(created.route.executionPlan.scriptBindings, simulated.executionPlan.scriptBindings);
  const plan = executionPlanFromRouteDecision(simulated);
  assert.equal(plan.agentBindings[0]?.runnerId, 'codex');
  assert.equal(plan.agentBindings[0]?.provider, 'openai');
  assert.equal(plan.agentBindings[0]?.modelId, 'gpt-5.6-luna');
  assert.deepEqual(plan.agentBindings[0]?.modelParams, {});
  assert.equal(plan.businessParams.ticket, 'T-1');
});

test('startRun uses only the stored plan after the source profile object is mutated', async () => {
  let storedRoute: RouteDecision | undefined;
  let startedRoute: RouteDecision | undefined;
  const api = makeApi({
    runService: {
      async createRun(input) {
        storedRoute = input.routeDecision as RouteDecision;
        return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
      },
      async getRun() {
        return { rowId: 'run-1', data: { id: 'run-1', status: 'ready', route_decision: storedRoute } };
      },
    },
    pipelineService: {
      async startDataDrivenTask(_runId, options) {
        startedRoute = options.route;
        return { workflowID: 'run-1' } as Awaited<ReturnType<PipelineService['startDataDrivenTask']>>;
      },
    },
  });
  const profile = structuredClone(LOCAL_CHANGE_PROFILE) as Record<string, unknown>;
  await api.createRun({ title: 'Task', repo: '.', pipelineId: 'local-change', profile });
  (((profile.bindings as Record<string, unknown>).slots as Record<string, Record<string, unknown>>)['node:developer']).modelId = 'tampered-after-launch';

  await api.startRun({ runId: 'run-1' });

  assert.ok(storedRoute);
  assert.ok(startedRoute);
  assert.equal(startedRoute.executionPlanBytes, storedRoute.executionPlanBytes);
  assert.equal(executionPlanFromRouteDecision(startedRoute).agentBindings[0]?.modelId, 'gpt-5.6-luna');
});

test('stored profile errors remain stable and deprecated profiles cannot launch', async () => {
  const missing = makeApi({
    playbooksService: {
      async resolveRunProfile() {
        throw new ControlPlaneError('ROW_NOT_FOUND', 'missing profile');
      },
    },
  });
  await assert.rejects(
    () => missing.simulateRoute({ title: 'Task', pipelineId: 'local-change', profileId: 'missing' }),
    (error: unknown) => error instanceof ControlPlaneError && (error.details as { code?: string })?.code === 'profile_not_found',
  );

  const deprecated = makeApi({
    playbooksService: {
      async resolveRunProfile() {
        return {
          id: 'pb-deprecated', playbookId: 'pb', pipelineId: 'local-change', profileId: 'deprecated',
          schemaVersion: 'run-profile/v1', version: '1', displayName: 'Deprecated', summary: '',
          profile: LOCAL_CHANGE_PROFILE, profileHash: 'ignored', profileRevisionHash: 'revision', status: 'deprecated' as const,
        };
      },
    },
  });
  await assert.rejects(
    () => deprecated.simulateRoute({ title: 'Task', pipelineId: 'local-change', profileId: 'deprecated' }),
    (error: unknown) => error instanceof ControlPlaneError && error.message.includes('is deprecated') &&
      (error.details as { code?: string })?.code === 'profile_not_launchable',
  );
});

test('profile CRUD APIs keep pipeline scope and exact profile bodies', async () => {
  const calls: unknown[] = [];
  const api = makeApi({
    playbooksService: {
      async createRunProfile(input) { calls.push(['create', input]); return { profileId: input.profileId } as never; },
      async updateRunProfile(input) { calls.push(['update', input]); return { profileId: input.profileId } as never; },
      async resolveRunProfile(input) { calls.push(['get', input]); return { profileId: input.profileId } as never; },
      async deprecateRunProfile(input) { calls.push(['deprecate', input]); return { profileId: input.profileId, status: 'deprecated' } as never; },
    },
  });
  await api.createProfile({ pipelineId: 'local-change', profileId: 'exact', displayName: 'Exact', profile: LOCAL_CHANGE_PROFILE });
  await api.updateProfile({ pipelineId: 'local-change', profileId: 'exact', expectedProfileRevisionHash: 'revision', profile: LOCAL_CHANGE_PROFILE });
  await api.getProfile({ pipelineId: 'local-change', profileId: 'exact' });
  await api.deprecateProfile({ pipelineId: 'local-change', profileId: 'exact', expectedProfileRevisionHash: 'revision' });

  assert.equal(calls.length, 4);
  assert.equal((calls[0] as [string, { pipelineId: string }])[1].pipelineId, 'local-change');
  assert.equal('modelLevel' in JSON.parse(JSON.stringify(LOCAL_CHANGE_PROFILE)), false);
  assert.equal((calls[2] as [string, { includeDeprecated?: boolean }])[1].includeDeprecated, true);
});
