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
import { InboxService } from '../revisium/inbox.service.js';
import { PlaybooksService } from '../revisium/playbooks.service.js';
import { RolesService } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import { PrReadinessService, type GetPrReadinessInput } from './pr-readiness.service.js';

const execFileAsync = promisify(execFile);
const GATE_TOPICS = new Set<string>(['plan', 'merge']);

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
    role?: string;
    start?: boolean;
    runnerMode?: RunnerModeInput;
  }) {
    const result = await this.runs.createRun({
      title: input.title,
      repo: input.repo,
      description: input.description,
      scope: input.scope,
      priority: input.priority ?? 0,
      role: input.role ?? 'architect',
    });
    if (!input.start) return { ...result, started: false };
    const started = await this.startRun({
      runId: result.runId,
      runnerMode: input.runnerMode ?? 'script',
    });
    return { ...result, started: true, workflow: started };
  }

  async startRun(input: { runId: string; runnerMode?: RunnerModeInput }) {
    const run = await this.runs.getRun(input.runId);
    if (!run) throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${input.runId}`);
    const existingStatus = await this.dbos.getWorkflowStatus(input.runId);
    const handle = await this.pipeline.startDevelopTask(input.runId, {
      runnerMode: input.runnerMode ?? 'script',
    });
    return {
      runId: input.runId,
      workflowID: handle.workflowID,
      alreadyStarted: existingStatus !== null,
      runnerMode: input.runnerMode ?? 'script',
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
    if (topic === 'merge') {
      const decision = asRecord(answer)?.decision;
      await this.runs.completeRun(item.runId, {
        actor: 'mcp',
        source: decision === 'reject' ? 'merge-gate-reject' : 'merge-gate-approve',
        verdict: '',
        iterations: 0,
      });
    }
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

  simulateRoute(input: { title: string; repo?: string; pipeline?: string; live?: boolean }) {
    const pipeline = input.pipeline ?? 'feature-development';
    return {
      title: input.title,
      repo: input.repo ?? '',
      pipeline,
      executionMode: 'agent-method-compatible',
      runnerMode: input.live ? 'live' : 'script',
      roles: ['architect', 'developer', 'reviewer', 'integrator'],
      gates: ['plan', 'merge'],
      reviewLoop: { maxIterationsSource: 'routing_policy.pipeline' },
      notes: [
        'MCP route simulation is advisory; workflow-as-data route proposal is a later slice.',
        'Use create_run then start_run to execute the current DBOS developTask workflow.',
      ],
    };
  }

  getPrReadiness(input: GetPrReadinessInput) {
    return this.prReadiness.getPrReadiness(input);
  }

  listPrFeedback(input: GetPrReadinessInput) {
    return this.prReadiness.listPrFeedback(input);
  }
}
