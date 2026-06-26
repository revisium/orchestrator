import { Injectable } from '@nestjs/common';
import {
  TaskControlPlaneApiService,
  type RepositoryContext,
  type RepositoryValidation,
} from '../task-control-plane/task-control-plane-api.service.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { AgentObservabilityError } from '../observability/types.js';
import { CreateRunWorkflowError } from '../run/create-run.js';
import {
  RunWatchService,
  type ObserveRunInput,
  type ObserveRunResult,
  type WatchInput,
  type WatchResult,
} from '../task-control-plane/run-watch.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';

export type { RepositoryContext, RepositoryValidation };

function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function exposeApplicationError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    if (error instanceof AgentObservabilityError) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    throw error;
  });
}

@Injectable()
export class McpFacadeService {
  /**
   * `runWatch` is injected by the daemon with a pubSub-backed instance (slice 141 D2, option A). When
   * absent (e2e/stdio/tests construct the facade with only the api), we lazily build a poll-fallback
   * watch (option B) — equivalent correctness, slightly higher latency.
   */
  private runWatchInstance?: RunWatchService;

  constructor(
    private readonly api: TaskControlPlaneApiService,
    runWatch?: RunWatchService,
  ) {
    this.runWatchInstance = runWatch;
  }

  private get runWatch(): RunWatchService {
    return (this.runWatchInstance ??= new RunWatchService(this.api));
  }

  getCapabilities() {
    return {
      transport: 'stdio',
      auth: 'none',
      tools: [...MCP_TOOL_NAMES],
      notes: [
        'Local stdio MCP server; no remote HTTP listener.',
        'Tools expose product operations, not generic Revisium row CRUD.',
        'Runs are driven by installed playbooks, pipeline catalogs, and execution profiles.',
        'Normal run polling should use observe_run with its cursor; compatibility watch tools remain available for older clients and diagnostics.',
      ],
      observation: {
        preferredOrder: [
          'observe_run with cursor for normal observation',
          'observe_run mode:"heartbeat" for explicit liveness checks',
          'get_run_digest when observe_run.nextAction is "inspect_digest"',
          'get_agent_log with offsetBytes/limitBytes or tailBytes when observe_run.nextAction is "inspect_log" or explicit debugging requires logs',
          'avoid get_run(includeEvents:true) and raw agent logs in polling loops',
        ],
        compatibilityTools: ['wait_for_run', 'wait_for_any_gate', 'watch_runs'],
        diagnosticTools: ['get_run_digest', 'get_agent_log', 'get_run_events', 'get_agent_activity'],
      },
    };
  }

  getStatus() {
    return this.api.getStatus();
  }

  doctor() {
    return this.api.doctor();
  }

  getProject() {
    return this.api.getProject();
  }

  validateRepository(input: string): Promise<RepositoryValidation> {
    return this.api.validateRepository(input);
  }

  getRepositoryContext(input: string): Promise<RepositoryContext> {
    return this.api.getRepositoryContext(input);
  }

  createRun(input: {
    title: string;
    repo: string;
    description?: string;
    scope?: string;
    playbookId?: string;
    pipelineId?: string;
    params?: Record<string, unknown>;
    priority?: number;
    start?: boolean;
  }) {
    return this.api.createRun(input).catch((error: unknown) => {
      if (error instanceof CreateRunWorkflowError) {
        const created = Object.keys(error.createdIds).length > 0
          ? `; createdBeforeFailure=${JSON.stringify(error.createdIds)}`
          : '';
        throw new Error(`${error.message}: ${formatCause(error.cause)}${created}`);
      }
      throw error;
    });
  }

  startRun(input: { runId: string }) {
    return this.api.startRun(input);
  }

  resumeRun(input: { runId: string }) {
    return this.api.resumeRun(input);
  }

  cancelRun(runId: string) {
    return this.api.cancelRun(runId);
  }

  listRuns(filter?: { status?: string; limit?: number }) {
    return this.api.listRuns(filter);
  }

  getRun(input: { runId: string; includeEvents?: boolean; includeLog?: boolean }) {
    return this.api.getRun(input);
  }

  getRunEvents(input: { runId: string; type?: string; limit?: number; expand?: ('graph')[] }) {
    return this.api.getRunEvents(input);
  }

  getRunLog(input: { runId: string; limit?: number }) {
    return this.api.getRunLog(input);
  }

  getAgentActivity(runId: string) {
    return exposeApplicationError(this.api.getAgentActivity(runId));
  }

  getAgentAttempts(runId: string) {
    return exposeApplicationError(this.api.getAgentAttempts(runId));
  }

  getAgentLog(input: {
    runId: string;
    attemptId?: string;
    stream: 'stdout' | 'stderr' | 'events' | 'combined';
    offsetBytes?: number;
    limitBytes?: number;
    tailBytes?: number;
  }) {
    return exposeApplicationError(this.api.getAgentLog(input));
  }

  tailAgentLog(input: { runId: string; cursor?: string; limit?: number; timeoutMs?: number }) {
    return exposeApplicationError(this.api.readAgentOutputEvents(input));
  }

  readAgentOutputEvents(input: { runId: string; cursor?: string; limit?: number; timeoutMs?: number }) {
    return exposeApplicationError(this.api.readAgentOutputEvents(input));
  }

  getRunDigest(runId: string) {
    return this.api.getRunDigest(runId);
  }

  waitForRun(input: { runId: string; timeoutMs?: number; intervalMs?: number }) {
    return this.api.waitForRun(input);
  }

  observeRun(input: ObserveRunInput): Promise<ObserveRunResult> {
    return this.runWatch.observeRun(input);
  }

  waitForAnyGate(input: WatchInput): Promise<WatchResult> {
    return this.runWatch.waitForAnyGate(input);
  }

  watchRuns(input: WatchInput): Promise<WatchResult> {
    return this.runWatch.watchRuns(input);
  }

  listInbox(filter?: { status?: 'pending' | 'resolved'; runId?: string; limit?: number }) {
    return this.api.listInbox(filter);
  }

  getInboxItem(inboxId: string) {
    return this.api.getInboxItem(inboxId);
  }

  getPendingDecisions(runId?: string) {
    return this.api.getPendingDecisions(runId);
  }

  approveGate(input: { inboxId: string; resolvedBy?: string }) {
    return this.api.approveGate(input);
  }

  rejectGate(input: { inboxId: string; resolvedBy?: string }) {
    return this.api.rejectGate(input);
  }

  answerQuestion(input: { inboxId: string; answer: unknown; resolvedBy?: string }) {
    return this.api.answerQuestion(input);
  }

  resolveInboxItem(input: {
    inboxId: string;
    answer: unknown;
    resolvedBy?: string;
    signalGate?: boolean;
  }) {
    return this.api.resolveInboxItem(input);
  }

  summarizeGateRisk(inboxId: string) {
    return this.api.summarizeGateRisk(inboxId);
  }

  installPlaybook(input: {
    source: string;
    commit?: boolean;
    dryRun?: boolean;
    name?: string;
    version?: string;
  }) {
    return this.api.installPlaybook(input);
  }

  listPlaybooks() {
    return this.api.listPlaybooks();
  }

  listRoles() {
    return this.api.listRoles();
  }

  getRole(roleId: string) {
    return this.api.getRole(roleId);
  }

  listPipelines() {
    return this.api.listPipelines();
  }

  getPipeline(pipelineId: string) {
    return this.api.getPipeline(pipelineId);
  }

  simulateRoute(input: { title: string; repo?: string; pipeline?: string; playbookId?: string; params?: unknown }) {
    return this.api.simulateRoute(input);
  }

  getPrReadiness(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.getPrReadiness(input);
  }

  listPrFeedback(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.listPrFeedback(input);
  }
}
