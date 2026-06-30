import test from 'node:test';
import assert from 'node:assert/strict';
import { McpFacadeService } from './mcp-facade.service.js';
import { MCP_TOOL_NAMES, MCP_INSTRUCTIONS } from './mcp-capabilities.js';
import type { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { AgentObservabilityError } from '../observability/types.js';
import { CreateRunWorkflowError } from '../run/create-run.js';
import { RunWatchService, type WatchResult } from '../task-control-plane/run-watch.service.js';

const never = <T>() => new Promise<T>(() => undefined);

async function resultBeforeDeadline<T>(promise: Promise<T>, ms = 500): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('McpFacadeService.getCapabilities exposes the MCP transport surface', () => {
  const facade = new McpFacadeService({} as TaskControlPlaneApiService);
  const capabilities = facade.getCapabilities();

  assert.equal(capabilities.transport, 'stdio');
  assert.equal(capabilities.auth, 'none');
  assert.deepEqual(capabilities.tools, [...MCP_TOOL_NAMES]);
  assert.ok(capabilities.tools.includes('create_run'));
  assert.ok(capabilities.tools.includes('approve_gate'));
  assert.ok(capabilities.tools.includes('simulate_route'));
  assert.ok(capabilities.tools.includes('get_pr_readiness'));
  assert.ok(capabilities.tools.includes('list_pr_feedback'));
  assert.ok(capabilities.tools.includes('get_agent_activity'));
  assert.ok(capabilities.tools.includes('get_agent_attempts'));
  assert.ok(capabilities.tools.includes('get_agent_log'));
  assert.ok(capabilities.tools.includes('tail_agent_log'));
  assert.ok(capabilities.tools.includes('read_agent_output_events'));
  assert.ok(capabilities.tools.includes('get_run_attention'), 'get_run_attention must be in tools');
  assert.ok(capabilities.tools.includes('get_run_status'), 'get_run_status must be in tools');
  assert.ok(capabilities.tools.includes('watch_run_changes'), 'watch_run_changes must be in tools');
  const toolSet = new Set<string>(capabilities.tools);
  assert.equal(toolSet.has('observe_run'), false, 'observe_run must be removed');
  assert.equal(toolSet.has('wait_for_any_gate'), false, 'wait_for_any_gate must be removed');
  assert.equal(toolSet.has('watch_runs'), false, 'watch_runs must be removed');
  assert.equal(capabilities.observation.primaryTool, 'get_run_attention');
  assert.equal(capabilities.observation.deliveryTool, 'watch_run_changes');
  assert.equal('compatibilityTools' in capabilities.observation, false, 'no compatibilityTools in new surface');
  assert.equal(capabilities.observation.preferredOrder[0]?.startsWith('get_run_attention'), true);
  assert.ok(capabilities.observation.preferredOrder.some((item) => item.includes('avoid get_run(includeEvents:true)')));
  assert.ok(
    capabilities.observation.preferredOrder[0]?.includes('change-stream consumer'),
    'preferredOrder[0] must carry the "unless implementing a change-stream consumer" rule',
  );
  assert.ok(
    capabilities.observation.preferredOrder.some((item) => item.includes('watch_run_changes') && item.toLowerCase().includes('not for normal task monitoring')),
    'watch_run_changes entry must carry "not for normal task monitoring"',
  );
});

test('MCP_INSTRUCTIONS contains task_monitoring_loop algorithm', () => {
  assert.ok(MCP_INSTRUCTIONS.includes('task_monitoring_loop'), 'MCP_INSTRUCTIONS must contain task_monitoring_loop');
  assert.ok(MCP_INSTRUCTIONS.includes('get_run_attention'), 'MCP_INSTRUCTIONS must reference get_run_attention');
  assert.ok(
    MCP_INSTRUCTIONS.toLowerCase().includes('not for normal task monitoring'),
    'MCP_INSTRUCTIONS must state watch_run_changes is not for normal task monitoring',
  );
});

test('McpFacadeService delegates attention/status/watch primitives to the injected RunWatchService', async () => {
  const api = {} as TaskControlPlaneApiService;
  const calls: Array<{ method: string; input: unknown }> = [];
  const runWatch = {
    async getRunAttention(runId: unknown) {
      calls.push({ method: 'getRunAttention', input: runId });
      return { runId: 'r1', state: 'pending_gate', requiresAttention: true, nextAction: 'ask_human', suggestedTools: [] };
    },
    async getRunStatus(runId: unknown) {
      calls.push({ method: 'getRunStatus', input: runId });
      return { runId: 'r1', state: 'running', runStatus: 'running', workflowStatus: 'PENDING' };
    },
    async watchRunChanges(input: unknown) {
      calls.push({ method: 'watchRunChanges', input });
      return { transitions: [], cursor: 'c1', timedOut: true } as WatchResult;
    },
  } as unknown as RunWatchService;
  const facade = new McpFacadeService(api, runWatch);

  const attentionResult = await facade.getRunAttention('r1');
  const statusResult = await facade.getRunStatus('r1');
  const watchResult = await facade.watchRunChanges({ runId: 'r1', cursor: 'c0' });

  assert.deepEqual(calls[0], { method: 'getRunAttention', input: 'r1' });
  assert.deepEqual(calls[1], { method: 'getRunStatus', input: 'r1' });
  assert.deepEqual(calls[2], { method: 'watchRunChanges', input: { runId: 'r1', cursor: 'c0' } });
  assert.equal(attentionResult.nextAction, 'ask_human');
  assert.equal(statusResult.runStatus, 'running');
  assert.equal(watchResult.timedOut, true);
});

test('McpFacadeService lazily builds a poll-fallback watch when none is injected', async () => {
  const api = {
    async resolveRunState(runId: string) {
      return { runId, state: 'pending_gate', nextAction: 'approve', runStatus: 'running', workflowStatus: 'PENDING', inbox: { id: 'ix' } };
    },
    async listRuns() {
      return [];
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const attention = await facade.getRunAttention('r1');
  const watchResult = await facade.watchRunChanges({ runId: 'r1', timeoutMs: 0 });

  assert.equal(attention.runId, 'r1');
  assert.equal(attention.nextAction, 'ask_human');
  assert.equal(watchResult.transitions[0]?.runId, 'r1');
  assert.equal(watchResult.transitions[0]?.inbox?.id, 'ix');
});

test('McpFacadeService delegates product operations to TaskControlPlaneApiService', async () => {
  let received: unknown;
  const issueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const api = {
    async createRun(input: unknown) {
      received = input;
      return { runId: 'run-1', started: false };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Task', repo: '.', pipelineId: 'feature-development', start: false, issueRef });

  assert.deepEqual(received, { title: 'Task', repo: '.', pipelineId: 'feature-development', start: false, issueRef });
  assert.deepEqual(result, { runId: 'run-1', started: false });
});

test('McpFacadeService.createRun returns a compact default response without the full route graph', async () => {
  const api = {
    async createRun() {
      return {
        runId: 'run-1',
        taskId: 'task-1',
        eventId: 'event-1',
        status: 'ready',
        started: true,
        workflow: {
          runId: 'run-1',
          workflowID: 'run-1',
          alreadyStarted: false,
          engine: 'data-driven',
          route: {
            playbookId: 'pb',
            pipelineId: 'feature-development',
            routeGates: ['plan', 'merge'],
            roles: ['analyst', 'developer', 'reviewer'],
            executionPolicy: {
              raw: ['large'],
              template_json: {
                nodes: {
                  analyst: { id: 'analyst', kind: 'agent', next: 'reviewer' },
                  reviewer: { id: 'reviewer', kind: 'agent', next: 'gate' },
                },
              },
            },
          },
        },
        route: {
          playbookId: 'pb',
          pipelineId: 'feature-development',
          executionPolicy: { template_json: { nodes: { too: 'large' } } },
        },
      };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Task', repo: '.', pipelineId: 'feature-development', start: true });
  const serialized = JSON.stringify(result);

  assert.equal(result.runId, 'run-1');
  assert.equal(result.started, true);
  assert.deepEqual(result.routeSummary, {
    playbookId: 'pb',
    pipelineId: 'feature-development',
    engine: 'data-driven',
    routeGates: ['plan', 'merge'],
    roles: ['analyst', 'developer', 'reviewer'],
  });
  assert.equal(serialized.includes('template_json'), false);
  assert.equal(serialized.includes('executionPolicy'), false);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 1_200, 'create_run MCP response stays compact by default');
});

test('McpFacadeService pipeline tools return compact defaults without execution policy graphs', async () => {
  const pipeline = {
    id: 'pb-feature-development',
    playbookId: 'pb',
    pipelineId: 'feature-development',
    path: 'pipelines/feature-development.json',
    triggers: ['feature', 'implementation'],
    requiredRoles: ['analyst', 'developer'],
    alternativeRoles: [],
    optionalRoles: ['watcher'],
    routeGates: ['plan', 'merge'],
    executionPolicy: {
      raw: ['large'],
      template_json: {
        specVersion: '1.0',
        nodes: {
          analyst: { id: 'analyst', kind: 'agent', next: 'developer' },
          developer: { id: 'developer', kind: 'agent', next: 'done' },
        },
      },
    },
  };
  const api = {
    async listPipelines() {
      return [pipeline];
    },
    async getPipeline() {
      return pipeline;
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const listResult = await facade.listPipelines({});
  const getResult = await facade.getPipeline({ pipelineId: 'pb-feature-development' });
  const serialized = JSON.stringify({ listResult, getResult });

  assert.deepEqual(listResult, [{
    id: 'pb-feature-development',
    playbookId: 'pb',
    pipelineId: 'feature-development',
    path: 'pipelines/feature-development.json',
    triggers: ['feature', 'implementation'],
    requiredRoles: ['analyst', 'developer'],
    alternativeRoles: [],
    optionalRoles: ['watcher'],
    routeGates: ['plan', 'merge'],
    executionPolicySummary: {
      hasTemplate: true,
      specVersion: '1.0',
      nodeCount: 2,
    },
  }]);
  assert.deepEqual(getResult, listResult[0]);
  assert.equal(serialized.includes('template_json'), false);
  assert.equal(serialized.includes('executionPolicy":'), false);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 1_200, 'pipeline MCP responses stay compact by default');
});

test('McpFacadeService pipeline tools can include execution policy details when explicitly requested', async () => {
  const pipeline = {
    id: 'pb-feature-development',
    pipelineId: 'feature-development',
    executionPolicy: { template_json: { nodes: { analyst: { id: 'analyst' } } } },
  };
  const api = {
    async listPipelines() {
      return [pipeline];
    },
    async getPipeline() {
      return pipeline;
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.deepEqual(await facade.listPipelines({ includeDetails: true }), [pipeline]);
  assert.equal(await facade.getPipeline({ pipelineId: 'pb-feature-development', includeDetails: true }), pipeline);
});

test('McpFacadeService.simulateRoute returns a compact default response without the full route graph', async () => {
  const route = {
    playbookId: 'pb',
    pipelineId: 'feature-development',
    source: 'explicit',
    routeGates: ['plan', 'merge'],
    roles: ['analyst', 'developer', 'reviewer'],
    executionPolicy: {
      raw: ['large'],
      template_json: {
        nodes: {
          analyst: { id: 'analyst', kind: 'agent', next: 'reviewer' },
          reviewer: { id: 'reviewer', kind: 'agent', next: 'gate' },
        },
      },
    },
    executionProfile: { id: 'default', runnerOverrides: {} },
    roleBindings: [
      { roleId: 'analyst', runnerId: 'claude-code', resolvedRunnerId: 'claude-code' },
      { roleId: 'developer', runnerId: 'claude-code', resolvedRunnerId: 'claude-code' },
    ],
    params: {},
  };
  const api = {
    async simulateRoute() {
      return route;
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.simulateRoute({ title: 'Task', repo: '.', pipeline: 'feature-development' });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result, {
    playbookId: 'pb',
    pipelineId: 'feature-development',
    source: 'explicit',
    routeGates: ['plan', 'merge'],
    roles: ['analyst', 'developer', 'reviewer'],
    executionProfile: { id: 'default' },
    roleBindingCount: 2,
  });
  assert.equal(serialized.includes('template_json'), false);
  assert.equal(serialized.includes('executionPolicy'), false);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 800, 'simulate_route MCP response stays compact by default');
});

test('McpFacadeService.simulateRoute can include route details when explicitly requested', async () => {
  const route = {
    playbookId: 'pb',
    pipelineId: 'feature-development',
    executionPolicy: { template_json: { nodes: { analyst: { id: 'analyst' } } } },
  };
  const api = {
    async simulateRoute() {
      return route;
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.simulateRoute({ title: 'Task', includeDetails: true });

  assert.equal(result, route);
});

test('McpFacadeService.createRun returns confirmationRequired when pipelineId is omitted', async () => {
  const pipeline = {
    id: 'pb-feature-development',
    playbookId: 'pb',
    pipelineId: 'feature-development',
    path: 'pipelines/feature-development.json',
    triggers: ['feature'],
    requiredRoles: ['developer'],
    alternativeRoles: [],
    optionalRoles: [],
    routeGates: [],
    executionPolicy: { template_json: { specVersion: '1.0', nodes: { developer: { id: 'developer' } } } },
  };
  let createRunCalled = false;
  const api = {
    async createRun() {
      createRunCalled = true;
      return { runId: 'run-1' };
    },
    async previewPipelineSelection() {
      return {
        playbookId: 'pb',
        candidatePipelines: [pipeline],
        wouldAutoRoute: { pipelineId: 'feature-development', pipelineRowId: 'pb-feature-development' },
      };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Add auth', repo: '.' });

  assert.equal(createRunCalled, false, 'api.createRun must NOT be called when pipelineId is omitted');
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.reason, 'pipeline_selection_required');
  assert.ok(typeof result.message === 'string' && result.message.includes('pipelineId'));
  assert.equal(result.playbookId, 'pb');
  assert.deepEqual(result.wouldAutoRoute, { pipelineId: 'feature-development', pipelineRowId: 'pb-feature-development' });
  const candidates = result.candidatePipelines as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.pipelineId, 'feature-development');
  assert.equal(JSON.stringify(candidates).includes('template_json'), false, 'candidatePipelines must be compact');
});

test('McpFacadeService.createRun confirmationRequired includes wouldAutoRouteReason when auto-route is ambiguous', async () => {
  const api = {
    async createRun() {
      return { runId: 'run-1' };
    },
    async previewPipelineSelection() {
      return {
        playbookId: 'pb',
        candidatePipelines: [],
        wouldAutoRoute: null,
        wouldAutoRouteReason: 'ambiguous pipeline route; provide pipelineId',
      };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Fix bug', repo: '.' });

  assert.equal(result.confirmationRequired, true);
  assert.equal(result.wouldAutoRoute, null);
  assert.ok(typeof result.wouldAutoRouteReason === 'string' && result.wouldAutoRouteReason.includes('ambiguous'));
  assert.equal('wouldAutoRouteReason' in result, true);
});

test('McpFacadeService.createRun exposes workflow row failure cause for MCP debugging', async () => {
  const api = {
    async createRun() {
      throw new CreateRunWorkflowError(
        'Failed to create run workflow rows',
        { runId: 'run-1' },
        new ControlPlaneError('VALIDATION_FAILURE', 'Validation failure: task_runs/run-1', { status: 422 }),
      );
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  await assert.rejects(
    () => facade.createRun({ title: 'Task', repo: '.', pipelineId: 'feature-development', start: false }),
    /Failed to create run workflow rows: VALIDATION_FAILURE status=422: Validation failure: task_runs\/run-1; createdBeforeFailure=\{"runId":"run-1"\}/,
  );
});

test('McpFacadeService delegates PR readiness tools to TaskControlPlaneApiService', async () => {
  const issueRef = {
    repo: 'owner/repo',
    number: 147,
    url: 'https://github.com/owner/repo/issues/147',
  };
  const calls: Array<{ name: string; input: unknown }> = [];
  const api = {
    async getPrReadiness(input: unknown) {
      calls.push({ name: 'getPrReadiness', input });
      return { verdict: 'ready' };
    },
    async listPrFeedback(input: unknown) {
      calls.push({ name: 'listPrFeedback', input });
      return { developerFixes: [] };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.deepEqual(await facade.getPrReadiness({ repo: 'owner/repo', prNumber: 1, issueRef }), { verdict: 'ready' });
  assert.deepEqual(await facade.listPrFeedback({ repo: 'owner/repo', prNumber: 1, issueRef }), { developerFixes: [] });
  assert.deepEqual(calls, [
    { name: 'getPrReadiness', input: { repo: 'owner/repo', prNumber: 1, issueRef } },
    { name: 'listPrFeedback', input: { repo: 'owner/repo', prNumber: 1, issueRef } },
  ]);
});

test('McpFacadeService delegates agent observability tools to TaskControlPlaneApiService', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const api = {
    async getAgentActivity(input: unknown) {
      calls.push({ name: 'getAgentActivity', input });
      return { runId: input, aggregateStatus: 'running' };
    },
    async getAgentAttempts(input: unknown) {
      calls.push({ name: 'getAgentAttempts', input });
      return [];
    },
    async getAgentLog(input: unknown) {
      calls.push({ name: 'getAgentLog', input });
      return { runId: 'run-1', attemptId: 'attempt-1', stream: 'combined', offsetBytes: 0, truncated: false, content: '' };
    },
    async readAgentOutputEvents(input: unknown) {
      calls.push({ name: 'readAgentOutputEvents', input });
      return { runId: 'run-1', events: [], cursorExpired: false };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.deepEqual(await facade.getAgentActivity('run-1'), { runId: 'run-1', aggregateStatus: 'running' });
  assert.deepEqual(await facade.getAgentAttempts('run-1'), []);
  assert.equal((await facade.getAgentLog({ runId: 'run-1', stream: 'combined', tailBytes: 65_536 })).stream, 'combined');
  assert.deepEqual(await facade.tailAgentLog({ runId: 'run-1', limit: 100, timeoutMs: 250 }), { runId: 'run-1', events: [], cursorExpired: false });
  assert.deepEqual(await facade.readAgentOutputEvents({ runId: 'run-1', cursor: 'c1', limit: 1 }), { runId: 'run-1', events: [], cursorExpired: false });
  assert.deepEqual(calls, [
    { name: 'getAgentActivity', input: 'run-1' },
    { name: 'getAgentAttempts', input: 'run-1' },
    { name: 'getAgentLog', input: { runId: 'run-1', stream: 'combined', tailBytes: 65_536 } },
    { name: 'readAgentOutputEvents', input: { runId: 'run-1', limit: 100, timeoutMs: 250 } },
    { name: 'readAgentOutputEvents', input: { runId: 'run-1', cursor: 'c1', limit: 1 } },
  ]);
});

test('McpFacadeService.getAgentActivity is bounded when the activity projection stalls', async () => {
  const api = {
    async getAgentActivity() {
      return never();
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await resultBeforeDeadline(facade.getAgentActivity('run-1'), 800);

  assert.notEqual(result, 'deadline', 'get_agent_activity must return before the outer MCP timeout');
  if (result === 'deadline') return;
  assert.deepEqual(result, {
    runId: 'run-1',
    activity: null,
    unavailable: true,
    reason: 'timeout',
  });
});

test('McpFacadeService.getAgentActivity preserves a legitimate no-activity null result', async () => {
  const api = {
    async getAgentActivity() {
      return null;
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.equal(await facade.getAgentActivity('run-1'), null);
});

test('McpFacadeService.getRunDigest strips raw event payloads from MCP digest output', async () => {
  const api = {
    async getRunDigest() {
      return {
        run: { runId: 'run-1', title: 'Run', status: 'running' },
        tasks: [{ taskId: 'task-1', title: 'Task', status: 'running', roleHint: 'developer' }],
        pendingInbox: [],
        latestEvents: [{
          eventId: 'event-1',
          type: 'step_succeeded',
          actor: 'orchestrator',
          createdAt: '2026-06-28T00:00:00.000Z',
          taskId: 'task-1',
          stepId: 'step-1',
          payload: {
            output: 'x'.repeat(10_000),
            role: 'developer',
            stepKey: 'developer',
            attemptId: 'attempt-1',
          },
        }],
        usage: { inputTokens: 1, outputTokens: 2, costAmount: 0.1 },
      };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const digest = await facade.getRunDigest('run-1');
  const serialized = JSON.stringify(digest);

  assert.equal(serialized.includes('"payload"'), false);
  assert.equal(serialized.includes('x'.repeat(100)), false);
  assert.deepEqual(digest.latestEvents, [{
    eventId: 'event-1',
    type: 'step_succeeded',
    actor: 'orchestrator',
    createdAt: '2026-06-28T00:00:00.000Z',
    taskId: 'task-1',
    stepId: 'step-1',
    summary: 'developer developer attempt-1',
  }]);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 2_000, 'MCP digest response stays compact');
});

test('McpFacadeService.getPrReadiness strips raw GitHub comment metadata while preserving actionable summaries', async () => {
  const api = {
    async getPrReadiness() {
      return {
        verdict: 'needs_human',
        pr: { number: 10, url: 'https://github.com/o/r/pull/10', state: 'OPEN', draft: false, base: 'master', head: 'h', headSha: 'sha', title: 'T', mergeState: 'CLEAN' },
        checks: { terminal: ['CodeRabbit'], pending: [], pass: ['CodeRabbit'], fail: [], list: [{ name: 'CodeRabbit', result: 'SUCCESS' }] },
        reviewDecision: 'CHANGES_REQUESTED',
        reviewThreads: { included: true, unresolvedCount: 0, items: [] },
        providerState: {},
        sonar: { configured: true, issues: [{ key: 'S1', message: 'Fix null handling', severity: 'MAJOR' }], hotspots: [], unavailable: false },
        nextAction: 'reviewer_triage',
        evidence: ['checks pass=1 fail=0 pending=0'],
        feedback: {
          developerFixes: [],
          reviewerQuestions: [{ source: 'human_comment', summary: 'Can you explain the migration?', author: 'reviewer', path: 'src/a.ts', line: 42 }],
          providerWait: [],
          humanDecisions: [{ source: 'github_review_decision', summary: 'Review decision is CHANGES_REQUESTED' }],
          ignoredNoise: [{
            source: 'sonarqubecloud[bot]',
            summary: '## Quality Gate passed ' + 'noise '.repeat(500),
          }],
          residualRisks: ['Review threads were not requested.'],
        },
        ciSummary: {
          ci_passed: true,
          checks: [{ name: 'CodeRabbit', result: 'SUCCESS' }],
          reviewDecision: 'CHANGES_REQUESTED',
          human_reviews: [],
          human_comments: [],
          bot_comments: [{
            url: 'https://api.github.com/raw',
            user: { login: 'coderabbitai[bot]', avatar_url: 'https://avatar' },
            body: 'full raw bot body ' + 'y'.repeat(10_000),
            performed_via_github_app: { permissions: { contents: 'write' } },
            reactions: { total_count: 0 },
          }],
          sonar_issues: [{ key: 'S1', message: 'Fix null handling', severity: 'MAJOR' }],
          sonar_hotspots_to_review: [{ key: 'H1', message: 'Review hotspot', vulnerabilityProbability: 'HIGH' }],
        },
	      };
	    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const readiness = await facade.getPrReadiness({ repo: 'o/r', prNumber: 10, includeComments: true });
  const feedback = readiness.feedback as {
    humanDecisions: Array<{ summary?: string }>;
    reviewerQuestions: Array<{ summary?: string; path?: string; line?: number }>;
    ignoredNoise: Array<{ summary?: string }>;
    residualRisks: string[];
  };
  const ciSummary = readiness.ciSummary as { sonar_issues?: number; sonar_hotspots_to_review?: number };
  const serialized = JSON.stringify(readiness);

  assert.equal(serialized.includes('performed_via_github_app'), false);
  assert.equal(serialized.includes('avatar_url'), false);
  assert.equal(serialized.includes('full raw bot body'), false);
  assert.equal(serialized.includes('permissions'), false);
  assert.equal(feedback.humanDecisions[0]?.summary, 'Review decision is CHANGES_REQUESTED');
  assert.equal(feedback.reviewerQuestions[0]?.summary, 'Can you explain the migration?');
  assert.equal(feedback.reviewerQuestions[0]?.path, 'src/a.ts');
  assert.equal(feedback.reviewerQuestions[0]?.line, 42);
  assert.deepEqual(feedback.residualRisks, ['Review threads were not requested.']);
  assert.equal(ciSummary.sonar_issues, 1);
  assert.equal(ciSummary.sonar_hotspots_to_review, 1);
  assert.ok((feedback.ignoredNoise[0]?.summary?.length ?? 0) <= 240);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 5_000, 'MCP readiness response stays compact');
});

test('McpFacadeService exposes agent observability application error codes', async () => {
  const api = {
    async getAgentLog() {
      throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
    },
    async readAgentOutputEvents() {
      throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  await assert.rejects(
    () => facade.getAgentLog({ runId: 'missing', stream: 'combined' }),
    /RUN_NOT_FOUND: run was not found/,
  );
  await assert.rejects(
    () => facade.tailAgentLog({ runId: 'missing', timeoutMs: 1 }),
    /RUN_NOT_FOUND: run was not found/,
  );
  await assert.rejects(
    () => facade.readAgentOutputEvents({ runId: 'missing', timeoutMs: 1 }),
    /RUN_NOT_FOUND: run was not found/,
  );
});
