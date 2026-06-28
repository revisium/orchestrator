






















import { Injectable, Inject } from '@nestjs/common';
import type { WorkflowHandle } from '../engine/types.js';
import { DbosService } from '../engine/dbos.service.js';
import { RolesService } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import { InboxService } from '../revisium/inbox.service.js';
import { IntegratorService } from '../runners/integrator.js';
import { WorktreeService } from '../runners/worktree.service.js';
import { redactTokens } from '../runners/gh-identity.js';
import { RUN_AGENT } from '../runners/tokens.js';
import { buildContext, ContextMissingError } from '../worker/build-context.js';
import type { RunAgent, AttemptResult } from '../worker/runner.js';
import { artifactsFromRunAgentError, failureMetadataFromRunAgentError } from '../worker/runner.js';
import { fnv1a64Hex, type CostRecord, type Step } from '../control-plane/steps.js';
import { getConfig } from '../config.js';
import type { AppendEventInput } from '../run/append-event.js';
import {
  createAgentActivityReporter,
  type AgentActivityReporter,
} from '../observability/agent-activity-reporter.js';
import { AGENT_OUTPUT_STREAM_KEY, type AgentOutputEvent } from '../observability/types.js';
import { makeAwaitHuman } from './await-human.js';
import {
  makeDataDrivenTask,
  resolveRunnerTransientRetryPolicy,
  RUN_PROGRESS_EVENT_KEY,
  type DataDrivenResult,
  type DataDrivenTaskDeps,
  type DataDrivenTaskOpts,
  type RunnerTransientRetryPolicy,
} from './data-driven-task.workflow.js';
import {
  dispatchRunnerId,
  type ExecutionProfile,
} from './route-contract.js';


const DEV_TASKS_QUEUE = 'dev-tasks';





export function resolveDevTasksConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env['REVO_DEV_TASKS_CONCURRENCY']?.trim();
  if (!value) return 20;
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 20;
}

const DEV_TASKS_CONCURRENCY = resolveDevTasksConcurrency();

const RUNNER_FAILURE_REASON_MAX = 2_000;

type StartDataDrivenTaskOpts = Omit<DataDrivenTaskOpts, 'runnerRetryPolicy'> & {
  runnerRetryPolicy?: RunnerTransientRetryPolicy;
};

function validateRunnerTransientRetryPolicy(
  policy: RunnerTransientRetryPolicy,
): RunnerTransientRetryPolicy {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new Error('runnerRetryPolicy.maxAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.backoffMs) || policy.backoffMs < 0) {
    throw new Error('runnerRetryPolicy.backoffMs must be a non-negative integer');
  }
  return policy;
}

function pinRunnerTransientRetryPolicy(
  policy: RunnerTransientRetryPolicy | undefined,
): RunnerTransientRetryPolicy {
  return validateRunnerTransientRetryPolicy(policy ?? resolveRunnerTransientRetryPolicy());
}






export type RunnerMode = 'script' | 'live';

export type RunStepPhysicalAttempt = {
  attemptNo: number;
  attemptId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}



export type RunStepDeps = {
  loadRole: RolesService['loadRole'];
  loadModelProfile: RolesService['loadModelProfile'];
  loadPipelineContext: RunService['loadPipelineContext'];
  appendEvent: (input: AppendEventInput) => Promise<void>;
  appendCost: RunService['appendCost'];

  appendAttempt: RunService['appendAttempt'];
  runAgent: RunAgent;
  writeAgentOutputEvent?: (event: AgentOutputEvent) => Promise<void>;

  now?: () => number;
};







function verdictForAttemptRow(result: AttemptResult): string {
  if (typeof result.verdict === 'string' && result.verdict.trim().length > 0) return result.verdict;
  return 'unknown';
}


function iterationOf(stepKey: string): number {
  const hashIdx = stepKey.lastIndexOf('#');
  if (hashIdx < 0) return 0;
  const n = Number.parseInt(stepKey.slice(hashIdx + 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function runnerFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactTokens(message).slice(0, RUNNER_FAILURE_REASON_MAX);
}

function defaultPhysicalAttempt(runId: string, stepKey: string): RunStepPhysicalAttempt {
  const attemptKey = `${runId}|${stepKey}`;
  return {
    attemptNo: iterationOf(stepKey) + 1,
    attemptId: `attempt_${fnv1a64Hex(attemptKey)}`,
  };
}

function resolvePhysicalAttempt(
  runId: string,
  stepKey: string,
  physicalAttempt: RunStepPhysicalAttempt | undefined,
): RunStepPhysicalAttempt {
  if (!physicalAttempt) return defaultPhysicalAttempt(runId, stepKey);
  if (!Number.isSafeInteger(physicalAttempt.attemptNo) || physicalAttempt.attemptNo <= 0) {
    throw new Error(`physicalAttempt.attemptNo must be a positive integer for ${stepKey}`);
  }
  if (physicalAttempt.attemptId.trim().length === 0) {
    throw new Error(`physicalAttempt.attemptId must be non-empty for ${stepKey}`);
  }
  return physicalAttempt;
}

async function flushReporter(reporter: AgentActivityReporter | undefined): Promise<void> {
  if (!reporter) return;
  try {
    await reporter.flush();
  } catch (err) {
    console.warn(`[pipeline] agent activity reporter flush failed — observability only. ${String(err)}`);
  }
}

function processArtifactFields(artifacts: unknown): { artifactRef?: string; stdoutTail?: string; stderrTail?: string } {
  const processArtifact = isRecord(artifacts) && isRecord(artifacts.process) ? artifacts.process : artifacts;
  if (!isRecord(processArtifact)) return {};
  const ref = processArtifact.ref;
  const stdoutTail = processArtifact.stdoutTail;
  const stderrTail = processArtifact.stderrTail;
  return {
    artifactRef: typeof ref === 'string' ? ref : undefined,
    stdoutTail: typeof stdoutTail === 'string' ? stdoutTail : undefined,
    stderrTail: typeof stderrTail === 'string' ? stderrTail : undefined,
  };
}

type StepAttemptContext = {
  runId: string;
  role: string;
  stepKey: string;
  attemptId: string;
  attemptNo: number;
  step: Step;
  durationMs: number;
};

type RunnerFailureDetails = {
  reason: string;
  output: {
    verdict: 'BLOCKER';
    error: 'runner_failed';
    role: string;
    stepKey: string;
    reason: string;
    failureKind?: string;
    retryableCandidate?: boolean;
    timing?: unknown;
  };
  artifactFields: { artifactRef?: string; stdoutTail?: string; stderrTail?: string };
};

async function runAgentWithReporterFlush(
  runAgent: RunAgent,
  args: Parameters<RunAgent>[0],
): Promise<AttemptResult> {
  try {
    return await runAgent(args);
  } finally {
    await flushReporter(args.reporter);
  }
}

function runnerFailureDetails(err: unknown, role: string, stepKey: string): RunnerFailureDetails {
  const reason = runnerFailureReason(err);
  const output: RunnerFailureDetails['output'] = {
    verdict: 'BLOCKER',
    error: 'runner_failed',
    role,
    stepKey,
    reason,
  };
  const failureMetadata = failureMetadataFromRunAgentError(err);
  if (failureMetadata.failureKind) output.failureKind = failureMetadata.failureKind;
  if (failureMetadata.retryableCandidate !== undefined) output.retryableCandidate = failureMetadata.retryableCandidate;
  if (failureMetadata.timing) output.timing = failureMetadata.timing;

  return {
    reason,
    output,
    artifactFields: processArtifactFields(artifactsFromRunAgentError(err)),
  };
}

async function appendRunnerFailureAttempt(
  appendAttempt: RunStepDeps['appendAttempt'],
  attemptContext: StepAttemptContext,
  failure: RunnerFailureDetails,
): Promise<void> {
  try {
    await appendAttempt({
      runId: attemptContext.runId,
      stepId: attemptContext.step.id,
      attemptId: attemptContext.attemptId,
      attemptNo: attemptContext.attemptNo,
      iteration: iterationOf(attemptContext.stepKey),
      status: 'failed',
      modelProfile: attemptContext.step.modelProfile,
      verdict: 'BLOCKER',
      inputTokens: 0,
      outputTokens: 0,
      costAmount: 0,
      durationMs: attemptContext.durationMs,
      output: failure.output,
      lesson: failure.reason,
      error: failure.reason,
      ...failure.artifactFields,
    });
  } catch (attemptErr) {
    console.warn(
      `[pipeline] failed-attempt row write failed for ${attemptContext.stepKey} (${attemptContext.attemptId}) — observability only. ` +
        `${String(attemptErr)}`,
    );
  }
}

async function handleRunnerFailure(
  appendEvent: RunStepDeps['appendEvent'],
  appendAttempt: RunStepDeps['appendAttempt'],
  attemptContext: StepAttemptContext,
  err: unknown,
): Promise<AttemptResult> {
  const failure = runnerFailureDetails(err, attemptContext.role, attemptContext.stepKey);
  await appendEvent({
    runId: attemptContext.runId,
    taskId: attemptContext.step.taskId,
    stepId: attemptContext.step.id,
    stepKey: attemptContext.stepKey,
    type: 'step_failed',
    idempotencyKey: attemptContext.attemptId,
    payload: {
      output: failure.output,
      role: attemptContext.role,
      stepKey: attemptContext.stepKey,
      attemptId: attemptContext.attemptId,
      attemptNo: attemptContext.attemptNo,
    },
  });
  await appendRunnerFailureAttempt(appendAttempt, attemptContext, failure);
  return { output: failure.output, nextSteps: [], costs: [], needsHuman: true, lesson: failure.reason };
}

async function appendAttemptCosts(
  appendCost: RunStepDeps['appendCost'],
  runId: string,
  step: Step,
  stepKey: string,
  attemptId: string,
  costs: CostRecord[],
): Promise<void> {
  for (let i = 0; i < costs.length; i++) {
    const cost = costs[i];
    if (!cost) continue;
    await appendCost({
      runId,
      stepId: step.id,
      stepKey,
      attemptId,
      cost,
      index: i,
    });
  }
}

function aggregateCostTotals(
  costs: readonly (Partial<CostRecord> | undefined)[],
): { inputTokens: number; outputTokens: number; costAmount: number } {
  return costs.reduce<{ inputTokens: number; outputTokens: number; costAmount: number }>(
    (sum, cost) => ({
      inputTokens: sum.inputTokens + (cost?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (cost?.outputTokens ?? 0),
      costAmount: sum.costAmount + (cost?.costAmount ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costAmount: 0 },
  );
}

async function appendSuccessfulAttempt(
  appendAttempt: RunStepDeps['appendAttempt'],
  attemptContext: StepAttemptContext,
  result: AttemptResult,
  artifactFields: { artifactRef?: string; stdoutTail?: string; stderrTail?: string },
): Promise<void> {
  const { inputTokens, outputTokens, costAmount } = aggregateCostTotals(result.costs);
  try {
    await appendAttempt({
      runId: attemptContext.runId,
      stepId: attemptContext.step.id,
      attemptId: attemptContext.attemptId,
      attemptNo: attemptContext.attemptNo,
      iteration: iterationOf(attemptContext.stepKey),
      status: result.needsHuman ? 'awaiting_approval' : 'succeeded',
      modelProfile: attemptContext.step.modelProfile,
      verdict: verdictForAttemptRow(result),
      inputTokens,
      outputTokens,
      costAmount,
      durationMs: attemptContext.durationMs,
      output: result.output,
      lesson: result.lesson,
      ...artifactFields,
    });
  } catch (err) {
    console.warn(
      `[pipeline] attempt-row write failed for ${attemptContext.stepKey} (${attemptContext.attemptId}) — observability only, step still succeeds. ` +
        `If this is a schema-drift error, migrate the control-plane attempts table to the 0008 fields. ${String(err)}`,
    );
  }
}






export function makeRunStep(deps: RunStepDeps) {
  const {
    loadRole,
    loadModelProfile,
    loadPipelineContext,
    appendEvent,
    appendCost,
    appendAttempt,
    runAgent,
    writeAgentOutputEvent,
  } = deps;
  const clock = deps.now ?? (() => Date.now());

  return async function runStepImpl(
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
    physicalAttempt?: RunStepPhysicalAttempt,
  ): Promise<AttemptResult> {
    const loadedRole = await loadRole(role);

    const profile = await loadModelProfile(loadedRole.modelLevel);

    const { da, step, runContext } = await loadPipelineContext(
      runId,
      role,
      stepKey,
      stepInput,
      profile.level,
    );

    const { attemptId, attemptNo } = resolvePhysicalAttempt(runId, stepKey, physicalAttempt);

    let context: string;
    try {
      context = await buildContext(da, step, loadedRole, runContext, getConfig().dataDir);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendEvent({
        runId,
        taskId: step.taskId,
        stepId: step.id,
        stepKey,
        type: 'step_failed',
        idempotencyKey: attemptId,
        payload: {
          error: err instanceof ContextMissingError ? err.code : 'revo.ContextBuildFailed',
          reason,
          role,
          stepKey,
          attemptId,
          attemptNo,
        },
      });
      throw err;
    }

    const effectiveRunner = dispatchRunnerId(resolveStepRunner(loadedRole.runner, resolvedRunnerId, executionProfile));
    const dispatchRole = { ...loadedRole, runner: effectiveRunner };
    const reporter = writeAgentOutputEvent
      ? createAgentActivityReporter(
          {
            runId,
            attemptId,
            stepId: step.id,
            stepKey,
            role,
            runner: effectiveRunner,
          },
          writeAgentOutputEvent,
        )
      : undefined;

    const startedAt = clock();
    let result: AttemptResult;
    try {
      result = await runAgentWithReporterFlush(runAgent, { role: dispatchRole, profile, context, attemptId, step, reporter });
    } catch (err) {
      const durationMs = Math.max(0, clock() - startedAt);
      return handleRunnerFailure(appendEvent, appendAttempt, { runId, role, stepKey, attemptId, attemptNo, step, durationMs }, err);
    }
    const durationMs = Math.max(0, clock() - startedAt);
    const attemptContext = { runId, role, stepKey, attemptId, attemptNo, step, durationMs };
    const artifactFields = processArtifactFields(result.artifacts);

    await appendEvent({
      runId,
      taskId: step.taskId,
      stepId: step.id,
      stepKey,
      type: 'step_succeeded',
      idempotencyKey: attemptId,
      payload: { output: result.output, role, stepKey, attemptId, attemptNo },
    });

    await appendAttemptCosts(appendCost, runId, step, stepKey, attemptId, result.costs);

    await appendSuccessfulAttempt(appendAttempt, attemptContext, result, artifactFields);

    return result;
  };
}

function resolveStepRunner(
  roleRunner: string,
  resolvedRunnerId?: string,
  executionProfile?: ExecutionProfile,
): string {
  if (resolvedRunnerId && resolvedRunnerId !== 'live') return resolvedRunnerId;
  if (resolvedRunnerId === 'script') return 'script';
  const profileResolved = executionProfile?.runnerOverrides[roleRunner];
  return profileResolved || roleRunner;
}

@Injectable()
export class PipelineService {

  private readonly runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
    physicalAttempt?: RunStepPhysicalAttempt,
  ) => Promise<AttemptResult>;




  private readonly dataDrivenTaskFn: (
    runId: string,
    opts: DataDrivenTaskOpts,
  ) => Promise<DataDrivenResult>;


  private readonly runAgent: RunAgent;

  constructor(
    @Inject(DbosService)
    private readonly dbos: DbosService,
    @Inject(RolesService)
    private readonly rolesService: RolesService,
    @Inject(RunService)
    private readonly runService: RunService,
    @Inject(InboxService)
    private readonly inboxService: InboxService,
    @Inject(IntegratorService)
    private readonly integratorService: IntegratorService,
    @Inject(WorktreeService)
    private readonly worktreeService: WorktreeService,
    @Inject(RUN_AGENT) runAgentToken: RunAgent,
  ) {
    this.runAgent = runAgentToken;

    const stepDeps: RunStepDeps = {
      loadRole: this.rolesService.loadRole.bind(this.rolesService),
      loadModelProfile: this.rolesService.loadModelProfile.bind(this.rolesService),
      loadPipelineContext: this.runService.loadPipelineContext.bind(this.runService),
      appendEvent: this.runService.appendEvent.bind(this.runService),
      appendCost: this.runService.appendCost.bind(this.runService),
      appendAttempt: this.runService.appendAttempt.bind(this.runService),
      runAgent: this.runAgent,
      writeAgentOutputEvent: (event) => this.dbos.writeStream(AGENT_OUTPUT_STREAM_KEY, event),
    };

    this.runStepFn = this.dbos.registerStep(
      'PipelineService.runStep',
      makeRunStep(stepDeps),
    );

    const integrateFn = this.dbos.registerStep(
      'PipelineService.integrate',
      this.integratorService.runIntegrate.bind(this.integratorService),
    );

    const confirmMergeFn = this.dbos.registerStep(
      'PipelineService.confirmMerge',
      this.integratorService.runConfirmMerge.bind(this.integratorService),
    );

    const pollPrFn = this.dbos.registerStep(
      'PipelineService.pollPr',
      this.integratorService.runPollPr.bind(this.integratorService),
    );
    const respondThreadsFn = this.dbos.registerStep(
      'PipelineService.respondThreads',
      this.integratorService.runRespondThreads.bind(this.integratorService),
    );

    const captureChangeFn = this.dbos.registerStep(
      'PipelineService.captureProducedChange',
      this.integratorService.runCaptureProducedChange.bind(this.integratorService),
    );

    const preflightFn = this.dbos.registerStep(
      'PipelineService.preflightLive',
      this.integratorService.runPreflight.bind(this.integratorService),
    );

    const createWorktreeFn = this.dbos.registerStep(
      'PipelineService.worktreeCreate',
      this.worktreeService.ensure,
    );
    const releaseWorktreeFn = this.dbos.registerStep(
      'PipelineService.worktreeRelease',
      this.worktreeService.release,
    );

    const awaitHuman = makeAwaitHuman({
      pushInbox: (item, id) => this.inboxService.pushInbox(item, { id }),
      awaitDecision: (topic) => this.dbos.awaitDecision(topic),
      appendEvent: stepDeps.appendEvent,
    });

    const dataDrivenDeps: DataDrivenTaskDeps = {
      appendEvent: stepDeps.appendEvent,
      appendRunOutput: this.runService.appendRunOutput.bind(this.runService),
      setProgress: (_runId, cursor) => this.dbos.setEvent(RUN_PROGRESS_EVENT_KEY, cursor),
      sleep: (ms) => this.dbos.sleep(ms),
      awaitHuman,
      completeRun: (
        runId: string,
        completeOpts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
      ) => this.runService.completeRun(runId, completeOpts),
      failRun: (runId: string, reason: string) => this.runService.failRun(runId, reason),
      blockRun: (
        runId: string,
        blockOpts?: { actor?: string; source?: string; reason?: string },
      ) => this.runService.blockRun(runId, blockOpts),
      loadRunTaskContext: this.runService.loadRunTaskContext.bind(this.runService),
      integrateFn,
      runStub: this.integratorService.runStub,
      confirmMergeFn,
      runConfirmStub: this.integratorService.runConfirmStub,
      pollPrFn,
      runPollStub: this.integratorService.runPollStub,
      respondThreadsFn,
      runRespondStub: this.integratorService.runRespondStub,
      captureChangeFn,
      preflightFn,
      createWorktreeFn,
      releaseWorktreeFn,
    };
    this.dataDrivenTaskFn = this.dbos.registerWorkflow(
      'PipelineService.dataDrivenTask',
      makeDataDrivenTask(this.runStepFn, dataDrivenDeps),
    );

    this.dbos.registerQueue(DEV_TASKS_QUEUE, { concurrency: DEV_TASKS_CONCURRENCY });
  }








  startDataDrivenTask(
    runId: string,
    opts: StartDataDrivenTaskOpts,
  ): Promise<WorkflowHandle<DataDrivenResult>> {
    const pinnedOpts: DataDrivenTaskOpts = {
      ...opts,
      runnerRetryPolicy: pinRunnerTransientRetryPolicy(opts.runnerRetryPolicy),
    };
    return this.dbos.startWorkflowOn(this.dataDrivenTaskFn, runId, DEV_TASKS_QUEUE, runId, pinnedOpts);
  }
}
