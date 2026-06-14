import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { baseUrl, getConfig, isAlive, isHealthy, readRuntime } from '../cli/config.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { InboxItem } from '../control-plane/inbox.js';
import { DbosService } from '../engine/dbos.service.js';
import { PipelineService, type RunnerMode } from '../pipeline/develop-task.workflow.js';
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
import { PrReadinessService, type GetPrReadinessInput } from './pr-readiness.service.js';

const execFileAsync = promisify(execFile);
const GATE_TOPICS = new Set<string>(['plan', 'merge']);
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

function gateTopic(item: InboxItem): 'plan' | 'merge' | null {
  if (item.kind !== 'approval' || !item.runId) return null;
  const context = asRecord(item.context);
  const topic = context?.topic;
  if (typeof topic !== 'string' || !GATE_TOPICS.has(topic)) return null;
  return topic as 'plan' | 'merge';
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
    private readonly runs: RunService,
    private readonly inbox: InboxService,
    private readonly roles: RolesService,
    private readonly playbooks: PlaybooksService,
    private readonly pipeline: PipelineService,
    private readonly dbos: DbosService,
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
    const route = input.route ?? await this.routeForRun(run);
    const existingStatus = await this.dbos.getWorkflowStatus(input.runId);
    const handle = await this.pipeline.startDevelopTask(input.runId, {
      runnerMode: input.runnerMode,
      route,
    });
    return {
      runId: input.runId,
      workflowID: handle.workflowID,
      alreadyStarted: existingStatus !== null,
      route,
    };
  }

  resumeRun(input: { runId: string; runnerMode?: RunnerModeInput }) {
    return this.startRun(input);
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

  getRunEvents(input: { runId: string; type?: string; limit?: number }) {
    return this.runs.listRunEvents(input.runId, { type: input.type, limit: input.limit });
  }

  getRunLog(input: { runId: string; limit?: number }) {
    return this.runs.listRunAttempts(input.runId, { limit: input.limit });
  }

  async getRunDigest(runId: string) {
    const detail = await this.runs.showRun(runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const [events, attempts, inbox] = await Promise.all([
      this.runs.listRunEvents(runId, { limit: 20 }),
      this.runs.listRunAttempts(runId, { limit: 100 }),
      this.inbox.listInbox({ runId, status: 'pending', limit: 50 }),
    ]);
    return {
      run: detail.run,
      tasks: detail.tasks,
      pendingInbox: inbox,
      latestEvents: events.slice(-10),
      usage: summarizeAttempts(attempts),
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

  private async resolveRunState(runId: string): Promise<{
    runId: string;
    state: 'pending_gate' | 'question' | 'running' | 'blocked' | 'failed' | 'completed';
    nextAction: string;
    runStatus: string;
    workflowStatus: string;
    inbox?: InboxItem;
    latestBlockingEvent?: unknown;
  }> {
    const detail = await this.runs.showRun(runId);
    if (!detail) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    const [inbox, events, workflow] = await Promise.all([
      this.inbox.listInbox({ runId, status: 'pending', limit: 20 }),
      this.runs.listRunEvents(runId, { limit: 20 }),
      this.dbos.getWorkflowStatus(runId),
    ]);
    const gate = inbox.find((item) => item.kind === 'approval');
    if (gate) {
      return {
        runId,
        state: 'pending_gate',
        nextAction: 'resolve approval with approve_gate or reject_gate',
        runStatus: detail.run.status,
        workflowStatus: workflow?.status ?? '',
        inbox: gate,
      };
    }
    const question = inbox.find((item) => item.kind === 'question');
    if (question) {
      return {
        runId,
        state: 'question',
        nextAction: 'answer question with answer_question',
        runStatus: detail.run.status,
        workflowStatus: workflow?.status ?? '',
        inbox: question,
      };
    }
    if (detail.run.status === 'completed') {
      return { runId, state: 'completed', nextAction: 'none', runStatus: detail.run.status, workflowStatus: workflow?.status ?? '' };
    }
    if (detail.run.status === 'failed') {
      return { runId, state: 'failed', nextAction: 'inspect get_run_events/get_run_log', runStatus: detail.run.status, workflowStatus: workflow?.status ?? '' };
    }
    if (detail.run.status === 'cancelled') {
      return { runId, state: 'blocked', nextAction: 'run was cancelled; create or resume a different run', runStatus: detail.run.status, workflowStatus: workflow?.status ?? '' };
    }
    const blocked = [...events].reverse().find((event) => event.type === 'pipeline_blocked');
    if (blocked) {
      return {
        runId,
        state: 'blocked',
        nextAction: 'inspect blocking event and decide whether to create a follow-up run',
        runStatus: detail.run.status,
        workflowStatus: workflow?.status ?? '',
        latestBlockingEvent: blocked,
      };
    }
    if (workflow?.status === 'ERROR') {
      return { runId, state: 'failed', nextAction: 'inspect get_run_events/get_run_log', runStatus: detail.run.status, workflowStatus: workflow.status };
    }
    if (workflow?.status === 'SUCCESS') {
      return { runId, state: 'completed', nextAction: 'none', runStatus: detail.run.status, workflowStatus: workflow.status };
    }
    return {
      runId,
      state: 'running',
      nextAction: 'wait_for_run again or inspect get_run_digest',
      runStatus: detail.run.status,
      workflowStatus: workflow?.status ?? '',
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

  private async signalGate(item: InboxItem, topic: 'plan' | 'merge', answer: unknown, inboxId: string) {
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
    executionProfile?: unknown;
    source: RouteDecision['source'];
  }): Promise<RouteDecision> {
    const params = normalizeParams(input.params);
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
    const selected = new Set<string>(pipeline.requiredRoles);
    for (const group of pipeline.alternativeRoles) {
      const match = group.roles.find((roleId) => byPlaybookRole.has(roleId));
      if (!match) {
        throw new ControlPlaneError(
          'VALIDATION_FAILURE',
          `pipeline ${pipeline.pipelineId} alternative group ${group.group_id} has no installed role`,
        );
      }
      selected.add(match);
    }
    for (const roleId of selected) {
      if (!byPlaybookRole.has(roleId)) {
        throw new ControlPlaneError(
          'VALIDATION_FAILURE',
          `pipeline ${pipeline.pipelineId} references missing installed role: ${roleId}`,
        );
      }
    }
    return [...selected].map((roleId): RouteRoleBinding => {
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
}
