import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { baseUrl, getConfig, isAlive, isHealthy, readRuntime } from '../cli/config.js';
import { AgentObservabilityService, type GetAgentLogInput } from '../observability/agent-observability.service.js';
import type {
  AgentAttemptSummary,
  AgentLogChunk,
  AgentOutputEvent,
  AgentRunActivity,
  ReadAgentOutputEventsInput,
  ReadAgentOutputEventsResult,
  WatchAgentOutputInput,
} from '../observability/types.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { InboxItem } from '../control-plane/inbox.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { DbosService } from '../engine/dbos.service.js';
import { PipelineService, type RunnerMode } from '../pipeline/pipeline.service.js';
import { RUN_PROGRESS_EVENT_KEY, type DataDrivenProgressCursor } from '../pipeline/data-driven-task.workflow.js';
import { templateFromExecutionPolicy } from '../pipeline/data-driven-template.js';
import {
  normalizeExecutionProfile,
  normalizeParams,
  normalizeRouteGates,
  resolveRunnerForProfile,
  type ExecutionProfile,
  type RouteDecision,
  type RouteRoleBinding,
} from '../pipeline/route-contract.js';
import { InboxService } from '../revisium/inbox.service.js';
import { PlaybooksService } from '../revisium/playbooks.service.js';
import type { PipelineSummary } from '../revisium/playbooks.service.js';
import { RolesService, type RoleSummary } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import {
  CreateRunWorkflowError,
  previewCreateRunIds,
  type CreateRunInput,
  type CreateRunResult,
} from '../run/create-run.js';
import type { AttemptSummary, EventSummary } from '../run/inspect-run.js';
import type { IssueRef } from '../run/issue-ref.js';
import { PrReadinessService, type GetPrReadinessInput } from './pr-readiness.service.js';

const execFileAsync = promisify(execFile);
const GATE_TOPICS = new Set<string>(['plan', 'merge', 'question']);
const WORKFLOW_SUCCESS_EVENT_TYPES = new Set(['step_succeeded', 'gate_signaled']);
const WORKFLOW_FAILURE_EVENT_TYPES = new Set(['step_failed', 'attempt_failed']);
const BUILTIN_RUNNERS = new Set(['claude-code', 'codex', 'script', 'stub-agent', 'revo-integrator', 'revo-merger', 'revo-deterministic']);

export type RunnerModeInput = RunnerMode;

export type RepositoryValidation = {
  input: string;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  gitRoot: string;
  branch: string;
  clean: boolean;
  remote: string;
  error: string;
};

export type RepositoryContext = RepositoryValidation & {
  files: Array<{ path: string; exists: boolean }>;
  packageName: string;
  scripts: string[];
  packageError: string;
};

export type RunProgress = {
  workflowStatus: string;
  graphCursor: DataDrivenProgressCursor | null;
  updatedAt: Date;
};

/**
 * The resolved, actionable state of a single run — the tagged union `resolveRunState` returns.
 * Reused by `waitForRun` (single run) and the `RunWatchService` watch primitives (fan-out, slice 141 D2).
 */
export type RunState = {
  runId: string;
  state: 'ready' | 'pending_gate' | 'question' | 'running' | 'blocked' | 'failed' | 'completed' | 'retrying';
  nextAction: string;
  runStatus: string;
  workflowStatus: string;
  inbox?: InboxItem;
  latestBlockingEvent?: unknown;
  blockedReason?: string;
  issueRef?: IssueRef;
  latestEventAt?: string;
  latestEventType?: string;
};

/* node:coverage disable */
type WorkflowStatusSnapshot = Awaited<ReturnType<DbosService['getWorkflowStatus']>>;

type RecoverablePreflightBlock = {
  blockedEvent: EventSummary;
  blockedEventId: string;
  reason: 'preflight';
  workflowID: string;
  workflowStatus: 'SUCCESS';
};

type RecoveryRunLineage = {
  parentRunId: string;
  recoveryRunId: string;
  blockedEventId: string;
  reason: 'preflight';
};
/* node:coverage enable */

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dateOrEpoch(value: Date | string | number | undefined): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (value === undefined || value === '') return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function gateTopic(item: InboxItem): 'plan' | 'merge' | 'question' | null {
  if (item.kind !== 'approval' || !item.runId) return null;
  const context = asRecord(item.context);
  const topic = context?.topic;
  if (typeof topic !== 'string' || !GATE_TOPICS.has(topic)) return null;
  return topic as 'plan' | 'merge' | 'question';
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      stdout: String(result.stdout).trim(),
      stderr: String(result.stderr).trim(),
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      stderr: typeof err.stderr === 'string' ? err.stderr.trim() : asErrorMessage(error),
    };
  }
}

function readPackageContext(repoPath: string): { packageName: string; scripts: string[]; packageError: string } {
  const packagePath = join(repoPath, 'package.json');
  if (!existsSync(packagePath)) return { packageName: '', scripts: [], packageError: '' };
  try {
    const parsed = asRecord(JSON.parse(readFileSync(packagePath, 'utf8')));
    const scripts = asRecord(parsed?.scripts);
    return {
      packageName: typeof parsed?.name === 'string' ? parsed.name : '',
      scripts: scripts ? Object.keys(scripts).sort((left, right) => left.localeCompare(right)) : [],
      packageError: '',
    };
  } catch (error) {
    return { packageName: '', scripts: [], packageError: asErrorMessage(error) };
  }
}

function pathDirectoryState(path: string): { exists: boolean; isDirectory: boolean; error: string } {
  const exists = existsSync(path);
  if (!exists) return { exists: false, isDirectory: false, error: 'Path does not exist.' };
  try {
    return { exists: true, isDirectory: statSync(path).isDirectory(), error: '' };
  } catch (error) {
    return { exists: true, isDirectory: false, error: asErrorMessage(error) };
  }
}

function summarizeAttempts(attempts: Array<{ inputTokens: number; outputTokens: number; costAmount: number }>) {
  return attempts.reduce(
    (acc, attempt) => ({
      inputTokens: acc.inputTokens + attempt.inputTokens,
      outputTokens: acc.outputTokens + attempt.outputTokens,
      costAmount: acc.costAmount + attempt.costAmount,
    }),
    { inputTokens: 0, outputTokens: 0, costAmount: 0 },
  );
}

function normalizedRunStatus(status: string): string {
  return status === 'paused' ? 'blocked' : status;
}

function hasWorkflowProgress(events: EventSummary[]): boolean {
  return events.some((event) => (
    event.type.startsWith('step_')
    || event.type.startsWith('attempt_')
    || event.type.startsWith('gate_')
    || event.type === 'pipeline_blocked'
    || event.type === 'pr_polled'
    || event.type === 'integrate_succeeded'
  ));
}

function observedRunStatus(rowStatus: string, workflowStatus: string, events: EventSummary[]): string {
  if (rowStatus !== 'ready') return rowStatus;
  if (workflowStatus === 'SUCCESS') return 'completed';
  if (workflowStatus === 'ERROR') return 'failed';
  if (workflowStatus && workflowStatus !== 'NOT_STARTED') return 'running';
  if (hasWorkflowProgress(events)) return 'running';
  return rowStatus;
}

function observedTaskStatus(rowStatus: string, runStatus: string): string {
  if (rowStatus !== 'ready') return rowStatus;
  if (runStatus === 'running' || runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
    return runStatus;
  }
  return rowStatus;
}

function latestEventPulse(events: EventSummary[]): Pick<RunState, 'latestEventAt' | 'latestEventType'> {
  const latest = [...events]
    .sort((left, right) => dateOrEpoch(right.createdAt).getTime() - dateOrEpoch(left.createdAt).getTime())[0];
  return latest ? { latestEventAt: latest.createdAt, latestEventType: latest.type } : {};
}

function payloadRecord(event: EventSummary): Record<string, unknown> | null {
  return asRecord(event.payload);
}

function eventStepKey(event: EventSummary): string {
  const payload = payloadRecord(event);
  const stepKey = payload?.stepKey;
  return typeof stepKey === 'string' ? stepKey : '';
}

function eventSummary(event: EventSummary): string {
  const payload = payloadRecord(event);
  const reason = payload?.reason;
  const output = payload?.output;
  if (typeof reason === 'string' && reason) return reason;
  if (typeof output === 'string' && output) return output.slice(0, 180);
  return event.type;
}

function blockedReasonFromEvent(event: EventSummary): string | undefined {
  const reason = payloadRecord(event)?.reason;
  return typeof reason === 'string' && reason ? reason : undefined;
}

function latestPipelineBlockedEvent(events: EventSummary[]): EventSummary | undefined {
  return [...events].reverse().find((event) => event.type === 'pipeline_blocked');
}

function recoveryCreatedForBlockedEvent(events: EventSummary[], blockedEventId: string): EventSummary | undefined {
  return [...events]
    .reverse()
    .find((event) => {
      if (event.type !== 'run_recovery_created') return false;
      return payloadRecord(event)?.blockedEventId === blockedEventId;
    });
}

function requiredString(value: unknown, field: string, runId: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new ControlPlaneError('VALIDATION_FAILURE', `Cannot recover run ${runId}: parent ${field} is missing`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function requiredRecord(value: unknown, field: string, runId: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record) return record;
  throw new ControlPlaneError(
    'VALIDATION_FAILURE',
    `Cannot recover run ${runId}: parent ${field} is not a record`,
  );
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function firstRepoRef(value: unknown, runId: string): string {
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0];
  throw new ControlPlaneError(
    'VALIDATION_FAILURE',
    `Cannot recover run ${runId}: parent repo is missing`,
  );
}

function makeRecoveryLineage(parentRunId: string, recoveryRunId: string, blockedEventId: string): RecoveryRunLineage {
  return { parentRunId, recoveryRunId, blockedEventId, reason: 'preflight' };
}

function recoveryLineagePayload(lineage: RecoveryRunLineage): Record<string, unknown> {
  return { parentRunId: lineage.parentRunId, recoveryRunId: lineage.recoveryRunId, blockedEventId: lineage.blockedEventId, reason: lineage.reason };
}

function recoveryLineageEvent(
  lineage: RecoveryRunLineage,
  runId: string,
  taskId: string,
  type: 'run_recovery_created' | 'run_recovery_parent',
) {
  const payload = recoveryLineagePayload(lineage);
  return { runId, taskId, stepId: '', stepKey: 'recovery', type, idempotencyKey: lineage.blockedEventId, payload, actor: 'orchestrator' };
}

function recoverableStartRunResponse(runId: string, route: RouteDecision, recoverable: RecoverablePreflightBlock) {
  return {
    runId,
    workflowID: recoverable.workflowID,
    alreadyStarted: true,
    recoverable: true,
    retryStarted: false,
    nextAction: 'resume_run' as const,
    blockedEventId: recoverable.blockedEventId,
    blockedReason: recoverable.reason,
    workflowStatus: recoverable.workflowStatus,
    route,
    engine: 'data-driven' as const,
  };
}

function stepKeyBase(stepKey: string): string {
  return stepKey.split('#')[0] ?? stepKey;
}

function activeNodeIds(progress: RunProgress): string[] {
  const cursor = asRecord(progress.graphCursor);
  const value = cursor?.activeNodeIds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function cursorStatus(progress: RunProgress): string {
  const cursor = asRecord(progress.graphCursor);
  const status = cursor?.status;
  return typeof status === 'string' ? status : progress.workflowStatus;
}

function templateNodeLabel(node: { id: string; displayName?: string }): string {
  return node.displayName ?? node.id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
}

function roleFromRef(roleRef: string | undefined): string | null {
  if (!roleRef) return null;
  return roleRef.startsWith('role:') ? roleRef.slice('role:'.length) : roleRef;
}

function scriptFromRef(scriptRef: string | undefined): string | null {
  if (!scriptRef) return null;
  return scriptRef.startsWith('script:') ? scriptRef.slice('script:'.length) : scriptRef;
}

function mapAttemptForWorkflow(runId: string, attempt: AttemptSummary) {
  return {
    id: attempt.attemptId,
    runId,
    stepId: attempt.stepId,
    stepKey: attempt.stepId,
    iteration: attempt.iteration,
    status: attempt.status,
    verdict: attempt.verdict,
    modelProfile: attempt.modelProfile,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costAmount: attempt.costAmount,
    currency: attempt.currency,
    durationMs: attempt.durationMs,
    outputSummary: attempt.outputSummary,
    artifactRef: attempt.artifactRef,
    lesson: attempt.lesson,
    error: attempt.error,
    startedAt: dateOrEpoch(attempt.startedAt),
  };
}

function mapInboxForWorkflow(item: InboxItem) {
  return {
    ...item,
    runId: item.runId || null,
    taskId: item.taskId || null,
    stepId: item.stepId || null,
    projectId: item.projectId || null,
    resolvedBy: item.resolvedBy || null,
    createdAt: dateOrEpoch(item.createdAt),
    resolvedAt: item.resolvedAt ? dateOrEpoch(item.resolvedAt) : null,
  };
}

function mapRunForWorkflow(run: {
  runId?: string;
  id?: string;
  title?: string;
  status?: string;
  priority?: number;
  description?: string;
  scope?: string;
  repos?: string[];
  createdAt?: Date | string;
  issueRef?: IssueRef;
}) {
  return {
    id: run.runId ?? run.id ?? '',
    title: run.title ?? '',
    status: normalizedRunStatus(run.status ?? ''),
    priority: run.priority ?? 0,
    description: run.description,
    scope: run.scope,
    repos: run.repos ?? [],
    createdAt: dateOrEpoch(run.createdAt),
    ...(run.issueRef ? { issueRef: run.issueRef } : {}),
  };
}

function workflowNodeStatus(input: { gate?: InboxItem; failed: boolean; active: boolean; succeeded: boolean }): string {
  if (input.gate) return 'awaiting_approval';
  if (input.failed) return 'failed';
  if (input.active) return 'running';
  if (input.succeeded) return 'succeeded';
  return 'pending';
}

function workflowGateTopic(node: { id: string; metadata: unknown }): string {
  const metadata = asRecord(node.metadata);
  const reason = metadata?.reason;
  return typeof reason === 'string' && reason ? reason : node.id;
}

function addAttemptForWorkflowNode(
  attemptsByBase: Map<string, AttemptSummary[]>,
  seenAttemptIdsByBase: Map<string, Set<string>>,
  base: string,
  attempt: AttemptSummary,
) {
  const seen = seenAttemptIdsByBase.get(base) ?? new Set<string>();
  if (seen.has(attempt.attemptId)) return;
  seen.add(attempt.attemptId);
  seenAttemptIdsByBase.set(base, seen);
  attemptsByBase.set(base, [...(attemptsByBase.get(base) ?? []), attempt]);
}

function workflowEdges(node: { id: string; kind: string }): Array<{ from: string; to: string; label: string; kind: string }> {
  const record = node as Record<string, unknown>;
  const edges: Array<{ from: string; to: string; label: string; kind: string }> = [];
  const add = (to: unknown, label = '', kind = 'next') => {
    if (typeof to === 'string' && to) edges.push({ from: node.id, to, label, kind });
  };
  add(record.next);
  add(record.join, 'join', 'join');
  const branches = Array.isArray(record.branches) ? record.branches : [];
  for (const branch of branches) {
    const item = asRecord(branch);
    add(item?.goto ?? item?.entry, typeof item?.id === 'string' ? item.id : '', node.kind === 'humanGate' ? 'gate' : 'branch');
  }
  return edges;
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2));
}

function routeScore(pipeline: PipelineSummary, text: string): number {
  const input = words(text);
  let score = 0;
  for (const trigger of pipeline.triggers) {
    for (const word of words(trigger)) {
      if (input.has(word)) score += 1;
    }
  }
  return score;
}

function isRouteDecision(value: unknown): value is RouteDecision {
  const record = asRecord(value);
  return Boolean(record?.playbookId && record?.pipelineRowId && Array.isArray(record.roleBindings));
}

function assertRunnerAvailable(runnerId: string, profile: ExecutionProfile, roleId: string): void {
  const available = profile.availableRunners;
  if (available && !available.includes(runnerId)) {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `runner unavailable for role ${roleId}: ${runnerId}`,
    );
  }
  if (!available && !BUILTIN_RUNNERS.has(runnerId)) {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `runner implementation is not registered for role ${roleId}: ${runnerId}`,
    );
  }
}

function assertProductionRunnerBinding(runnerId: string, runnerSource: RouteRoleBinding['runnerSource'], roleId: string): void {
  if (runnerId !== 'stub-agent' || runnerSource === 'execution-profile') return;
  throw new ControlPlaneError(
    'VALIDATION_FAILURE',
    `role ${roleId} binds production runner stub-agent; use an execution profile override for test stubs`,
  );
}

@Injectable()
export class TaskControlPlaneApiService {
  constructor(
    @Inject(RunService)
    private readonly runs: RunService,
    @Inject(InboxService)
    private readonly inbox: InboxService,
    @Inject(RolesService)
    private readonly roles: RolesService,
    @Inject(PlaybooksService)
    private readonly playbooks: PlaybooksService,
    @Inject(PipelineService)
    private readonly pipeline: PipelineService,
    @Inject(DbosService)
    private readonly dbos: DbosService,
    @Inject(AgentObservabilityService)
    private readonly observability: AgentObservabilityService,
    private readonly prReadiness: PrReadinessService = new PrReadinessService(),
  ) {}

  async getStatus() {
    const runtime = readRuntime();
    const alive = runtime ? isAlive(runtime.pid) : false;
    const healthy = runtime && alive ? await isHealthy(runtime.httpPort) : false;
    return {
      daemon: {
        running: Boolean(runtime && alive),
        healthy,
        pid: runtime?.pid ?? null,
        baseUrl: runtime ? baseUrl(runtime.httpPort) : null,
        httpPort: runtime?.httpPort ?? null,
        pgPort: runtime?.pgPort ?? null,
      },
      project: this.getProject(),
    };
  }

  async doctor() {
    const status = await this.getStatus();
    const issues: string[] = [];
    if (!status.daemon.running) issues.push('Local Revisium daemon is not running.');
    if (status.daemon.running && !status.daemon.healthy) issues.push('Local Revisium daemon is running but unhealthy.');
    try {
      await this.roles.loadPipelinePolicy();
    } catch (error) {
      issues.push(`Control-plane read failed: ${asErrorMessage(error)}`);
    }
    return { ok: issues.length === 0, issues, status };
  }

  getProject() {
    const config = getConfig();
    return {
      org: config.org,
      project: config.project,
      branch: config.branch,
      dataDir: config.dataDir,
    };
  }

  async validateRepository(input: string): Promise<RepositoryValidation> {
    const repoPath = resolve(input);
    const { exists, isDirectory, error } = pathDirectoryState(repoPath);
    if (!isDirectory) {
      return {
        input,
        path: repoPath,
        exists,
        isDirectory,
        gitRoot: '',
        branch: '',
        clean: false,
        remote: '',
        error: error || 'Path is not a directory.',
      };
    }

    const root = await git(repoPath, ['rev-parse', '--show-toplevel']);
    if (!root.ok) {
      return {
        input,
        path: repoPath,
        exists,
        isDirectory,
        gitRoot: '',
        branch: '',
        clean: false,
        remote: '',
        error: root.stderr || 'Path is not inside a git repository.',
      };
    }

    const branch = await git(repoPath, ['branch', '--show-current']);
    const status = await git(repoPath, ['status', '--porcelain']);
    const remote = await git(repoPath, ['remote', 'get-url', 'origin']);
    return {
      input,
      path: repoPath,
      exists,
      isDirectory,
      gitRoot: root.stdout,
      branch: branch.stdout,
      clean: status.ok && status.stdout.length === 0,
      remote: remote.ok ? remote.stdout : '',
      error: '',
    };
  }

  async getRepositoryContext(input: string): Promise<RepositoryContext> {
    const validation = await this.validateRepository(input);
    const contextRoot = validation.gitRoot || validation.path;
    const files = ['AGENTS.md', 'VERIFICATION.md', 'REVIEW.md', 'REPOSITORY.md', 'package.json'].map((name) => {
      const path = join(contextRoot, name);
      return { path, exists: existsSync(path) };
    });
    const packageContext = validation.gitRoot
      ? readPackageContext(validation.gitRoot)
      : { packageName: basename(contextRoot), scripts: [], packageError: '' };
    return { ...validation, files, ...packageContext };
  }

  async createRun(input: {
    title: string;
    repo: string;
    description?: string;
    scope?: string;
    priority?: number;
    playbookId?: string;
    pipelineId?: string;
    params?: unknown;
    issueRef?: unknown;
    /** Private test/service seam; public MCP/CLI do not expose runner profile selection. */
    executionProfile?: unknown;
    role?: string;
    start?: boolean;
    /** Deprecated private shim for route-less compatibility tests. */
    runnerMode?: RunnerModeInput;
  }) {
    const route = await this.resolveRouteDecision({
      title: input.title,
      repo: input.repo,
      description: input.description,
      scope: input.scope,
      playbookId: input.playbookId,
      pipelineId: input.pipelineId,
      params: input.params,
      issueRef: input.issueRef,
      executionProfile: input.executionProfile,
      source: input.pipelineId ? 'explicit' : 'deterministic-installed-playbook',
    });
    const result = await this.runs.createRun({
      title: input.title,
      repo: input.repo,
      description: input.description,
      scope: input.scope,
      priority: input.priority ?? 0,
      role: route.roleBindings[0]?.rowId ?? input.role ?? 'architect',
      playbookId: route.playbookId,
      pipelineId: route.pipelineId,
      params: route.params,
      issueRef: route.params.issueRef,
      routeDecision: route,
      executionProfile: route.executionProfile,
    });
    if (!input.start) return { ...result, started: false, route };
    const started = await this.startRun({
      runId: result.runId,
      runnerMode: input.runnerMode,
      route,
    });
    return { ...result, started: true, workflow: started };
  }

  async startRun(input: { runId: string; runnerMode?: RunnerModeInput; route?: RouteDecision }) {
    const run = await this.runs.getRun(input.runId);
    if (!run) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${input.runId}`);
    const existingStatus = await this.dbos.getWorkflowStatus(input.runId);
    const route = input.route ?? await this.routeForRun(run);
    const recoverable = await this.detectRecoverablePreflightBlock(input.runId, run.data.status, existingStatus);
    if (recoverable) return recoverableStartRunResponse(input.runId, route, recoverable);

    // CUTOVER (plan 0015 slice 3): the data-driven engine is the SOLE pipeline engine. EVERY pipeline
    // routes to the data-driven workflow, executing the state-machine template carried in its
    // execution_policy (template_json). A pipeline lacking a valid template FAILS LOUD here
    // (PIPELINE_NOT_DATA_DRIVEN) rather than silently no-op-ing — there is no hardcoded fallback engine.
    // A present-but-malformed/invalid template likewise throws (templateFromExecutionPolicy).
    const template = templateFromExecutionPolicy(route.executionPolicy);
    if (!template) {
      throw new ControlPlaneError(
        'VALIDATION_FAILURE',
        `PIPELINE_NOT_DATA_DRIVEN: pipeline ${route.pipelineId} carries no state-machine template ` +
          `(execution_policy.template_json); the data-driven engine is the only engine`,
      );
    }
    const handle = await this.pipeline.startDataDrivenTask(input.runId, { route, template });
    return {
      runId: input.runId,
      workflowID: handle.workflowID,
      alreadyStarted: existingStatus !== null,
      route,
      engine: 'data-driven' as const,
    };
  }

  async resumeRun(input: { runId: string; runnerMode?: RunnerModeInput }) {
    const run = await this.runs.getRun(input.runId);
    if (!run) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${input.runId}`);
    const workflow = await this.dbos.getWorkflowStatus(input.runId);
    const recoverable = await this.detectRecoverablePreflightBlock(input.runId, run.data.status, workflow);
    if (!recoverable) return this.startRun(input);

    const recovery = await this.createOrReusePreflightRecoveryRun(input.runId, run.data, recoverable.blockedEvent);
    const started = await this.startRun({
      runId: recovery.recoveryRunId,
      runnerMode: input.runnerMode,
    });
    return {
      ...started,
      recovered: true,
      recovery,
    };
  }

  private async detectRecoverablePreflightBlock(
    runId: string,
    runStatus: unknown,
    workflow: WorkflowStatusSnapshot,
  ): Promise<RecoverablePreflightBlock | null> {
    if (runStatus !== 'paused' || workflow?.status !== 'SUCCESS') return null;
    const events = await this.runs.listRunEvents(runId, { type: 'pipeline_blocked', limit: 500 });
    const blockedEvent = latestPipelineBlockedEvent(events);
    if (!blockedEvent || blockedReasonFromEvent(blockedEvent) !== 'preflight') return null;
    return {
      blockedEvent,
      blockedEventId: blockedEvent.eventId,
      reason: 'preflight',
      workflowID: workflow.workflowID,
      workflowStatus: 'SUCCESS',
    };
  }

  private async createOrReusePreflightRecoveryRun(
    parentRunId: string,
    parentData: Record<string, unknown>,
    blockedEvent: EventSummary,
  ): Promise<RecoveryRunLineage> {
    const existing = await this.existingPreflightRecoveryRun(parentRunId, blockedEvent);
    if (existing) return existing;

    const parentDetail = await this.runs.showRun(parentRunId);
    const parentTask = parentDetail?.tasks[0];
    if (!parentTask) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot recover run ${parentRunId}: parent task is missing`);
    }

    const createInput = this.buildPreflightRecoveryCreateInput(parentRunId, parentData, parentTask.roleHint, blockedEvent);
    const expected = previewCreateRunIds(createInput);
    const created = await this.createRecoveryRunOrReuseExpected(createInput, expected);
    const lineage = makeRecoveryLineage(parentRunId, created.runId, blockedEvent.eventId);
    await this.recordRecoveryLineage(lineage);
    return lineage;
  }

  private async existingPreflightRecoveryRun(
    parentRunId: string,
    blockedEvent: EventSummary,
  ): Promise<RecoveryRunLineage | null> {
    const events = await this.runs.listRunEvents(parentRunId, { limit: 500 });
    const event = recoveryCreatedForBlockedEvent(events, blockedEvent.eventId);
    if (!event) return null;
    const recoveryRunId = payloadRecord(event)?.recoveryRunId;
    if (typeof recoveryRunId !== 'string' || !recoveryRunId) return null;
    const recovery = await this.runs.showRun(recoveryRunId);
    if (!recovery) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `Cannot recover run ${parentRunId}: recovery run ${recoveryRunId} referenced by lineage event is missing`,
      );
    }
    const lineage = makeRecoveryLineage(parentRunId, recoveryRunId, blockedEvent.eventId);
    await this.recordRecoveryLineage(lineage);
    return lineage;
  }

  private buildPreflightRecoveryCreateInput(
    parentRunId: string,
    parentData: Record<string, unknown>,
    role: string,
    blockedEvent: EventSummary,
  ): CreateRunInput {
    const now = dateOrEpoch(blockedEvent.createdAt);
    const title = requiredString(parentData.title, 'title', parentRunId);
    const repo = firstRepoRef(parentData.repos, parentRunId);
    const description = optionalString(parentData.description);
    const scope = optionalString(parentData.scope);
    const priority = optionalInteger(parentData.priority);
    const recoveryRole = requiredString(role, 'task role_hint', parentRunId);
    const playbookId = optionalString(parentData.playbook_id);
    const pipelineId = optionalString(parentData.pipeline_id);
    const params = optionalRecord(parentData.params);
    const routeDecision = parentData.route_decision;
    if (!isRouteDecision(routeDecision)) {
      throw new ControlPlaneError(
        'VALIDATION_FAILURE',
        `Cannot recover run ${parentRunId}: parent route_decision is invalid`,
      );
    }
    const executionProfile = requiredRecord(parentData.execution_profile, 'execution_profile', parentRunId);
    const idSuffix = fnv1a64Hex(`${parentRunId}|${blockedEvent.eventId}`).slice(0, 8);
    return { title, repo, description, scope, priority, role: recoveryRole, playbookId, pipelineId, params, routeDecision, executionProfile, now, idSuffix };
  }

  /* node:coverage disable */
  private async createRecoveryRunOrReuseExpected(
    input: CreateRunInput,
    expected: CreateRunResult,
  ): Promise<CreateRunResult> {
    try {
      /* node:coverage enable */
      return await this.runs.createRun(input);
    } catch (error) {
      if (!(error instanceof CreateRunWorkflowError)) throw error;
      const existing = await this.runs.showRun(expected.runId);
      if (existing?.tasks[0]) return expected;
      throw error;
    }
  }

  private async recordRecoveryLineage(lineage: RecoveryRunLineage): Promise<void> {
    const [parentDetail, recoveryDetail] = await Promise.all([
      this.runs.showRun(lineage.parentRunId),
      this.runs.showRun(lineage.recoveryRunId),
    ]);
    const parentTaskId = parentDetail?.tasks[0]?.taskId ?? '';
    const recoveryTaskId = recoveryDetail?.tasks[0]?.taskId ?? '';
    await this.runs.appendEvent(recoveryLineageEvent(lineage, lineage.parentRunId, parentTaskId, 'run_recovery_created'));
    await this.runs.appendEvent(recoveryLineageEvent(lineage, lineage.recoveryRunId, recoveryTaskId, 'run_recovery_parent'));
  }

  async cancelRun(runId: string) {
    const result = await this.runs.cancelRun(runId, { actor: 'mcp', source: 'mcp-cancel' });
    if (!result) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    return result;
  }

  listRuns(filter?: { status?: string; limit?: number }) {
    return this.runs.listRuns(filter);
  }

  async getRun(input: { runId: string; includeEvents?: boolean; includeLog?: boolean }) {
    const detail = await this.runs.showRun(input.runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${input.runId}`);
    return {
      ...detail,
      events: input.includeEvents ? await this.runs.listRunEvents(input.runId, { limit: 100 }) : undefined,
      attempts: input.includeLog ? await this.runs.listRunAttempts(input.runId, { limit: 100 }) : undefined,
    };
  }

  getRunEvents(input: { runId: string; type?: string; limit?: number; expand?: ('graph')[] }) {
    return this.runs.listRunEvents(input.runId, { type: input.type, limit: input.limit, expand: input.expand });
  }

  async getRunProgress(runId: string): Promise<RunProgress> {
    const detail = await this.runs.showRun(runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const workflow = await this.dbos.getWorkflowStatus(runId);
    if (!workflow) {
      return {
        workflowStatus: 'NOT_STARTED',
        graphCursor: null,
        updatedAt: dateOrEpoch(detail.run.createdAt),
      };
    }
    const graphCursor = await this.dbos.getEvent<DataDrivenProgressCursor>(
      workflow.workflowID,
      RUN_PROGRESS_EVENT_KEY,
      { timeoutSeconds: 0 },
    );
    return {
      workflowStatus: workflow.status,
      graphCursor,
      updatedAt: dateOrEpoch(workflow.updatedAt ?? workflow.createdAt),
    };
  }

  getRunLog(input: { runId: string; limit?: number }) {
    return this.runs.listRunAttempts(input.runId, { limit: input.limit });
  }

  async getRunWorkflow(runId: string) {
    const [detail, runRow, events, attempts, pendingInbox, progress] = await Promise.all([
      this.getRun({ runId }),
      this.runs.getRun(runId),
      this.runs.listRunEvents(runId, { limit: 500 }),
      this.runs.listRunAttempts(runId, { limit: 500 }),
      this.inbox.listInbox({ runId, status: 'pending', limit: 100 }),
      this.getRunProgress(runId),
    ]);
    if (!runRow) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const route = await this.routeForRun(runRow);
    const template = templateFromExecutionPolicy(route.executionPolicy);
    const activeIds = activeNodeIds(progress);
    const active = new Set(activeIds);
    const succeeded = new Set(
      events
        .filter((event) => WORKFLOW_SUCCESS_EVENT_TYPES.has(event.type))
        .map(eventStepKey)
        .filter(Boolean)
        .map(stepKeyBase),
    );
    const failed = new Set(
      events
        .filter((event) => WORKFLOW_FAILURE_EVENT_TYPES.has(event.type))
        .map(eventStepKey)
        .filter(Boolean)
        .map(stepKeyBase),
    );
    const inboxByNode = new Map<string, InboxItem>();
    for (const item of pendingInbox) {
      const context = asRecord(item.context);
      const summary = asRecord(context?.summary);
      const nodeId = typeof summary?.nodeId === 'string' ? summary.nodeId : '';
      if (nodeId) inboxByNode.set(nodeId, item);
    }
    const attemptsByBase = new Map<string, AttemptSummary[]>();
    const seenAttemptIdsByBase = new Map<string, Set<string>>();
    for (const event of events) {
      const key = eventStepKey(event);
      if (!key) continue;
      const base = stepKeyBase(key);
      const eventAttempts = attempts.filter((attempt) => attempt.attemptId === asRecord(event.payload)?.attemptId);
      for (const attempt of eventAttempts) {
        addAttemptForWorkflowNode(attemptsByBase, seenAttemptIdsByBase, base, attempt);
      }
    }
    const nodes = Object.values(template?.nodes ?? {}).map((node) => {
      const record = node as typeof node & { roleRef?: string; scriptRef?: string };
      const nodeAttempts = attemptsByBase.get(node.id) ?? [];
      const roleId = roleFromRef(record.roleRef);
      const binding = roleId ? route.roleBindings.find((item) => item.roleId === roleId) : undefined;
      const isActive = active.has(node.id);
      const gate = inboxByNode.get(node.id);
      const status = workflowNodeStatus({
        gate,
        failed: failed.has(node.id),
        active: isActive,
        succeeded: succeeded.has(node.id),
      });
      return {
        id: node.id,
        label: templateNodeLabel(node),
        kind: node.kind,
        roleId,
        scriptId: scriptFromRef(record.scriptRef),
        modelLevel: binding?.modelLevel ?? null,
        runner: binding?.resolvedRunnerId ?? null,
        status,
        attemptCount: nodeAttempts.length,
        inputTokens: nodeAttempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
        outputTokens: nodeAttempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
        costAmount: nodeAttempts.reduce((sum, attempt) => sum + attempt.costAmount, 0),
        verdict: nodeAttempts.at(-1)?.verdict ?? null,
        inboxId: gate?.id ?? null,
        metadata: node,
      };
    });
    const edges = Object.values(template?.nodes ?? {}).flatMap((node) => workflowEdges(node));
    return {
      run: {
        ...mapRunForWorkflow(detail.run),
      },
      pipeline: {
        id: route.pipelineRowId,
        pipelineId: route.pipelineId,
        playbookId: route.playbookId,
        title: template?.title ?? route.pipelineId,
        routeGates: route.routeGates,
        activeNodeIds: activeIds,
        status: cursorStatus(progress),
      },
      nodes,
      edges,
      currentNodeIds: activeIds,
      gates: nodes
        .filter((node) => node.kind === 'humanGate')
        .map((node) => {
          const inbox = inboxByNode.get(node.id);
          return {
            nodeId: node.id,
            topic: workflowGateTopic(node),
            status: inbox ? 'pending' : node.status,
            inboxId: inbox?.id ?? null,
            answer: inbox?.answer ?? null,
          };
        }),
      attempts: attempts.map((attempt) => mapAttemptForWorkflow(runId, attempt)),
      pendingInbox: pendingInbox.map(mapInboxForWorkflow),
      usage: summarizeAttempts(attempts),
      activity: events.slice(-50).reverse().map((event) => ({
        id: event.eventId,
        type: event.type,
        actor: event.actor,
        createdAt: dateOrEpoch(event.createdAt),
        summary: eventSummary(event),
        payload: event.payload,
      })),
    };
  }

  async getRunDigest(runId: string) {
    const detail = await this.runs.showRun(runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const [events, attempts, inbox, workflow] = await Promise.all([
      this.runs.listRunEvents(runId, { limit: 20 }),
      this.runs.listRunAttempts(runId, { limit: 100 }),
      this.inbox.listInbox({ runId, status: 'pending', limit: 50 }),
      this.dbos.getWorkflowStatus(runId).catch(() => null),
    ]);
    const latestBlockingEvent = latestPipelineBlockedEvent(events);
    const blockedReason = latestBlockingEvent ? blockedReasonFromEvent(latestBlockingEvent) : undefined;
    const runStatus = observedRunStatus(detail.run.status, workflow?.status ?? '', events);
    return {
      run: { ...detail.run, status: runStatus },
      tasks: detail.tasks.map((task) => ({ ...task, status: observedTaskStatus(task.status, runStatus) })),
      pendingInbox: inbox,
      latestEvents: events.slice(-10),
      usage: summarizeAttempts(attempts),
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    };
  }

  async waitForRun(input: { runId: string; timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = input.timeoutMs ?? 0;
    const intervalMs = input.intervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.resolveRunState(input.runId);
      if (state.state !== 'running' || Date.now() >= deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Resolve a single run to its actionable state. Public so `RunWatchService` (slice 141 D2) can
   * fan it out across many runs; it is a point-in-time level read (gate = `inbox.find(approval)`),
   * not an event cursor — the watch primitive layers at-least-once + idempotent delivery on top.
   */
  async resolveRunState(runId: string): Promise<RunState> {
    const detail = await this.runs.showRun(runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const issueRef = detail.run.issueRef;
    const issueRefPart = issueRef ? { issueRef } : {};
    const [inbox, events, workflow] = await Promise.all([
      this.inbox.listInbox({ runId, status: 'pending', limit: 20 }),
      this.runs.listRunEvents(runId, { limit: 20 }),
      this.dbos.getWorkflowStatus(runId),
    ]);
    const workflowStatus = workflow?.status ?? '';
    const runStatus = observedRunStatus(detail.run.status, workflowStatus, events);
    const eventPulsePart = latestEventPulse(events);
    const gate = inbox.find((item) => item.kind === 'approval');
    if (gate) {
      return {
        runId,
        state: 'pending_gate',
        nextAction: 'resolve approval with approve_gate or reject_gate',
        runStatus,
        workflowStatus,
        inbox: gate,
        ...issueRefPart,
        ...eventPulsePart,
      };
    }
    const question = inbox.find((item) => item.kind === 'question');
    if (question) {
      return {
        runId,
        state: 'question',
        nextAction: 'answer question with answer_question',
        runStatus,
        workflowStatus,
        inbox: question,
        ...issueRefPart,
        ...eventPulsePart,
      };
    }
    if (detail.run.status === 'completed') {
      return { runId, state: 'completed', nextAction: 'none', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    if (detail.run.status === 'failed') {
      return { runId, state: 'failed', nextAction: 'inspect get_run_events/get_run_log', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    if (detail.run.status === 'cancelled') {
      return { runId, state: 'blocked', nextAction: 'run was cancelled; create or resume a different run', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    const blockingEvent = latestPipelineBlockedEvent(events);
    const blockedReason = blockingEvent ? blockedReasonFromEvent(blockingEvent) : undefined;
    if (detail.run.status === 'paused') {
      return {
        runId,
        state: 'blocked',
        nextAction: 'inspect blocking event and decide whether to create a follow-up run',
        runStatus,
        workflowStatus,
        ...(blockedReason !== undefined ? { blockedReason } : {}),
        ...issueRefPart,
        ...eventPulsePart,
      };
    }
    if (blockingEvent) {
      return {
        runId,
        state: 'blocked',
        nextAction: 'inspect blocking event and decide whether to create a follow-up run',
        runStatus,
        workflowStatus,
        latestBlockingEvent: blockingEvent,
        ...(blockedReason !== undefined ? { blockedReason } : {}),
        ...issueRefPart,
        ...eventPulsePart,
      };
    }
    if (workflow?.status === 'ERROR') {
      return { runId, state: 'failed', nextAction: 'inspect get_run_events/get_run_log', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    if (workflow?.status === 'SUCCESS') {
      return { runId, state: 'completed', nextAction: 'none', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    if (runStatus === 'ready') {
      return { runId, state: 'ready', nextAction: 'start_run', runStatus, workflowStatus, ...issueRefPart, ...eventPulsePart };
    }
    return {
      runId,
      state: 'running',
      nextAction: 'wait_for_run again or inspect get_run_digest',
      runStatus,
      workflowStatus,
      ...issueRefPart,
      ...eventPulsePart,
    };
  }

  listInbox(filter?: { status?: 'pending' | 'resolved'; runId?: string; limit?: number }) {
    return this.inbox.listInbox(filter);
  }

  async getInboxItem(inboxId: string) {
    const item = await this.inbox.getInbox(inboxId);
    if (!item) throw new ControlPlaneError('ROW_NOT_FOUND', `inbox item not found: ${inboxId}`);
    return item;
  }

  getPendingDecisions(runId?: string) {
    return this.inbox.listInbox({ status: 'pending', runId, limit: 100 });
  }

  approveGate(input: { inboxId: string; resolvedBy?: string }) {
    const resolvedBy = input.resolvedBy ?? 'mcp';
    return this.resolveGate(input.inboxId, { decision: 'approve', resolvedBy }, resolvedBy);
  }

  rejectGate(input: { inboxId: string; resolvedBy?: string }) {
    const resolvedBy = input.resolvedBy ?? 'mcp';
    return this.resolveGate(input.inboxId, { decision: 'reject', resolvedBy }, resolvedBy);
  }

  async answerQuestion(input: { inboxId: string; answer: unknown; resolvedBy?: string }) {
    const item = await this.getInboxItem(input.inboxId);
    if (gateTopic(item)) {
      throw new ControlPlaneError(
        'VALIDATION_FAILURE',
        `inbox item is a gate; use approve_gate or reject_gate: ${input.inboxId}`,
      );
    }
    return this.resolveInboxItem({
      inboxId: input.inboxId,
      answer: input.answer,
      resolvedBy: input.resolvedBy ?? 'mcp',
      signalGate: false,
    });
  }

  private async resolveGate(inboxId: string, answer: unknown, resolvedBy: string) {
    const item = await this.getInboxItem(inboxId);
    const topic = gateTopic(item);
    if (!topic) {
      throw new ControlPlaneError('VALIDATION_FAILURE', `inbox item is not a plan or merge gate: ${inboxId}`);
    }
    const result = await this.inbox.resolveInbox(inboxId, answer, resolvedBy);
    await this.signalGate(item, topic, result.answer, inboxId);
    return {
      inboxId,
      previousStatus: result.status,
      answer: result.answer,
      signaled: true,
      topic,
      runId: item.runId,
    };
  }

  async resolveInboxItem(input: {
    inboxId: string;
    answer: unknown;
    resolvedBy?: string;
    signalGate?: boolean;
  }) {
    const item = await this.getInboxItem(input.inboxId);
    const topic = gateTopic(item);
    const result = await this.inbox.resolveInbox(input.inboxId, input.answer, input.resolvedBy ?? 'mcp');
    const shouldSignal = input.signalGate !== false && topic !== null;
    if (shouldSignal) {
      await this.signalGate(item, topic, result.answer, input.inboxId);
    }
    return {
      inboxId: input.inboxId,
      previousStatus: result.status,
      answer: result.answer,
      signaled: shouldSignal,
      topic,
      runId: item.runId,
    };
  }

  private async signalGate(item: InboxItem, topic: 'plan' | 'merge' | 'question', answer: unknown, inboxId: string) {
    const eventBase = {
      runId: item.runId,
      taskId: item.taskId,
      stepId: item.stepId,
      stepKey: `gate:${topic}`,
      actor: 'mcp',
      payload: { inboxId, topic },
    };
    await this.runs.appendEvent({ ...eventBase, type: 'gate_signal_pending' });
    await this.dbos.signal(item.runId, topic, answer, inboxId);
    await this.runs.appendEvent({ ...eventBase, type: 'gate_signaled' });
  }

  async summarizeGateRisk(inboxId: string) {
    const item = await this.getInboxItem(inboxId);
    return {
      inboxId,
      kind: item.kind,
      title: item.title,
      topic: gateTopic(item),
      risk: item.kind === 'approval' ? 'Requires an explicit approve/reject decision.' : 'Question or alert.',
      context: item.context,
      options: item.options,
    };
  }

  installPlaybook(input: {
    source: string;
    commit?: boolean;
    dryRun?: boolean;
    name?: string;
    version?: string;
  }) {
    return this.playbooks.install(input);
  }

  listPlaybooks() {
    return this.playbooks.listPlaybooks();
  }

  listRoles() {
    return this.roles.listRoles();
  }

  getRole(roleId: string) {
    return this.roles.loadRole(roleId);
  }

  listPipelines() {
    return this.playbooks.listPipelines();
  }

  async getPipeline(pipelineId: string) {
    const result = await this.playbooks.getPipeline(pipelineId);
    if (!result) throw new ControlPlaneError('ROW_NOT_FOUND', `pipeline not found: ${pipelineId}`);
    return result;
  }

  simulateRoute(input: { title: string; repo?: string; pipeline?: string; playbookId?: string; params?: unknown }) {
    return this.resolveRouteDecision({
      title: input.title,
      repo: input.repo ?? '',
      playbookId: input.playbookId,
      pipelineId: input.pipeline,
      params: input.params,
      source: input.pipeline ? 'explicit' : 'deterministic-installed-playbook',
    });
  }

  private async routeForRun(run: { data: Record<string, unknown> }): Promise<RouteDecision> {
    if (isRouteDecision(run.data.route_decision)) return run.data.route_decision;
    return this.resolveRouteDecision({
      title: typeof run.data.title === 'string' ? run.data.title : 'Run',
      repo: Array.isArray(run.data.repos) && typeof run.data.repos[0] === 'string' ? run.data.repos[0] : '',
      description: typeof run.data.description === 'string' ? run.data.description : '',
      scope: typeof run.data.scope === 'string' ? run.data.scope : '',
      playbookId: typeof run.data.playbook_id === 'string' ? run.data.playbook_id : undefined,
      pipelineId: typeof run.data.pipeline_id === 'string' ? run.data.pipeline_id : undefined,
      params: run.data.params,
      source: run.data.pipeline_id ? 'explicit' : 'deterministic-installed-playbook',
    });
  }

  private async resolveRouteDecision(input: {
    title: string;
    repo: string;
    description?: string;
    scope?: string;
    playbookId?: string;
    pipelineId?: string;
    params?: unknown;
    issueRef?: unknown;
    executionProfile?: unknown;
    source: RouteDecision['source'];
  }): Promise<RouteDecision> {
    const params = normalizeParams(input.params, input.issueRef);
    const executionProfile = normalizeExecutionProfile(input.executionProfile);
    const playbook = await this.playbooks.resolvePlaybook(input.playbookId);
    const pipeline = input.pipelineId
      ? await this.playbooks.resolvePipeline({ playbookId: playbook.id, pipelineId: input.pipelineId })
      : await this.resolveAutoPipeline(playbook.id, [input.title, input.description, input.scope].join(' '));
    const roleBindings = await this.resolveRouteRoles(playbook.id, pipeline, executionProfile);
    return {
      playbookId: playbook.id,
      pipelineId: pipeline.pipelineId,
      pipelineRowId: pipeline.id,
      source: input.source,
      roles: roleBindings.map((binding) => binding.roleId),
      requiredRoles: pipeline.requiredRoles,
      optionalRoles: pipeline.optionalRoles,
      routeGates: normalizeRouteGates(pipeline.routeGates),
      executionPolicy: pipeline.executionPolicy,
      executionProfile,
      roleBindings,
      params,
    };
  }

  private async resolveAutoPipeline(playbookId: string, text: string): Promise<PipelineSummary> {
    const pipelines = (await this.playbooks.listPipelines())
      .filter((pipeline) => pipeline.playbookId === playbookId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (pipelines.length === 0) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `no installed pipelines found for playbook ${playbookId}`);
    }
    const scored = pipelines
      .map((pipeline) => ({ pipeline, score: routeScore(pipeline, text) }))
      .sort((left, right) => right.score - left.score || left.pipeline.id.localeCompare(right.pipeline.id));
    const best = scored[0];
    const second = scored[1];
    if (!best || best.score <= 0) {
      throw new ControlPlaneError(
        'VALIDATION_FAILURE',
        `unable to choose a pipeline confidently; provide pipelineId`,
      );
    }
    if (second?.score === best.score) {
      throw new ControlPlaneError(
        'VALIDATION_FAILURE',
        `ambiguous pipeline route; provide pipelineId`,
      );
    }
    return best.pipeline;
  }

  private async resolveRouteRoles(
    playbookId: string,
    pipeline: PipelineSummary,
    executionProfile: ExecutionProfile,
  ): Promise<RouteRoleBinding[]> {
    const roles = (await this.roles.listRoles()).filter((role) => role.playbookId === playbookId);
    const byPlaybookRole = new Map(roles.map((role) => [role.playbookRoleId || role.name, role]));
    // The route selects WHICH roles a pipeline binds (capability handles the data-driven engine
    // resolves). Order is no longer load-bearing — the data-driven template owns node sequencing — so
    // alternative-group selections simply append (the old `insertBeforeFirstDeveloperRole` phase-order
    // hardcode is removed with the rest of the hardcoded engine, plan 0015 slice 3).
    const selected = [...pipeline.requiredRoles];
    for (const group of pipeline.alternativeRoles) {
      const match = group.roles.find((roleId) => byPlaybookRole.has(roleId));
      if (!match) {
        throw new ControlPlaneError(
          'VALIDATION_FAILURE',
          `pipeline ${pipeline.pipelineId} alternative group ${group.group_id} has no installed role`,
        );
      }
      if (!selected.includes(match)) selected.push(match);
    }
    for (const roleId of selected) {
      if (!byPlaybookRole.has(roleId)) {
        throw new ControlPlaneError(
          'VALIDATION_FAILURE',
          `pipeline ${pipeline.pipelineId} references missing installed role: ${roleId}`,
        );
      }
    }
    return selected.map((roleId): RouteRoleBinding => {
      const role = byPlaybookRole.get(roleId) as RoleSummary;
      assertProductionRunnerBinding(role.runner, 'playbook', roleId);
      const resolved = resolveRunnerForProfile(role.runner, executionProfile);
      assertProductionRunnerBinding(resolved.runnerId, resolved.source, roleId);
      assertRunnerAvailable(resolved.runnerId, executionProfile, roleId);
      return {
        roleId,
        rowId: role.id,
        modelLevel: role.modelLevel,
        runnerId: role.runner,
        resolvedRunnerId: resolved.runnerId,
        runnerSource: resolved.source,
      };
    });
  }

  getPrReadiness(input: GetPrReadinessInput) {
    return this.prReadiness.getPrReadiness(input);
  }

  listPrFeedback(input: GetPrReadinessInput) {
    return this.prReadiness.listPrFeedback(input);
  }

  getAgentActivity(runId: string): Promise<AgentRunActivity | null> {
    return this.observability.getAgentActivity(runId);
  }

  getAgentAttempts(runId: string): Promise<AgentAttemptSummary[]> {
    return this.observability.listAgentAttempts(runId);
  }

  getAgentLog(input: GetAgentLogInput): Promise<AgentLogChunk> {
    return this.observability.getAgentLog(input);
  }

  readAgentOutputEvents(input: ReadAgentOutputEventsInput): Promise<ReadAgentOutputEventsResult> {
    return this.observability.readAgentOutputEvents(input);
  }

  watchAgentActivity(input: WatchAgentOutputInput): AsyncIterable<AgentRunActivity> {
    return this.observability.watchAgentActivity(input);
  }

  watchAgentOutput(input: WatchAgentOutputInput): AsyncIterable<AgentOutputEvent> {
    return this.observability.watchAgentOutput(input);
  }
}
