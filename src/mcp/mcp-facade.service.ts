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
  type RunAttentionResult,
  type RunStatusResult,
  type WatchRunChangesInput,
  type WatchResult,
} from '../task-control-plane/run-watch.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';

export type { RepositoryContext, RepositoryValidation };

const MCP_ACTIVITY_TIMEOUT_MS = 500;
const COMPACT_TEXT_LIMIT = 240;

type JsonRecord = Record<string, unknown>;
type SimulateRouteMcpInput = {
  title: string;
  repo?: string;
  pipeline?: string;
  playbookId?: string;
  params?: unknown;
  includeDetails?: boolean;
};
type ListPipelinesMcpInput = {
  includeDetails?: boolean;
};
type GetPipelineMcpInput = {
  pipelineId: string;
  includeDetails?: boolean;
};

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

function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactText(value: unknown, limit = COMPACT_TEXT_LIMIT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function compactStringArray(value: unknown, limit = COMPACT_TEXT_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item, limit)).filter((item): item is string => Boolean(item));
}

function compactRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is JsonRecord => item !== null);
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function definedEntries(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function compactRouteSummary(result: JsonRecord): JsonRecord | undefined {
  const workflow = asRecord(result.workflow);
  const route = asRecord(workflow?.route) ?? asRecord(result.route) ?? result;
  if (!route) return undefined;
  const routeGates = compactStringArray(route.routeGates);
  const roles = Array.isArray(route.roles)
    ? route.roles
      .map((role) => {
        if (typeof role === 'string') return role;
        const roleRecord = asRecord(role);
        return asString(roleRecord?.role) ?? asString(roleRecord?.roleId) ?? asString(roleRecord?.id);
      })
      .filter((role): role is string => Boolean(role))
    : [];
  const summary = definedEntries({
    playbookId: asString(route.playbookId),
    pipelineId: asString(route.pipelineId),
    engine: asString(workflow?.engine) ?? asString(route.engine),
    routeGates: routeGates.length > 0 ? routeGates : undefined,
    roles: roles.length > 0 ? roles : undefined,
  });
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function compactExecutionProfile(value: unknown): JsonRecord | undefined {
  const profile = asRecord(value);
  if (!profile) return undefined;
  return definedEntries({
    id: asString(profile.id),
  });
}

function compactRouteDecision(value: unknown): unknown {
  const route = asRecord(value);
  if (!route) return value;
  const roleBindings = compactRecordArray(route.roleBindings);
  const summary = compactRouteSummary(route) ?? {};
  return definedEntries({
    ...summary,
    source: asString(route.source),
    executionProfile: compactExecutionProfile(route.executionProfile),
    roleBindingCount: roleBindings.length > 0 ? roleBindings.length : undefined,
  });
}

function compactExecutionPolicySummary(value: unknown): JsonRecord {
  const policy = asRecord(value);
  const template = asRecord(policy?.template_json) ?? asRecord(policy?.templateJson);
  const nodes = asRecord(template?.nodes);
  return definedEntries({
    hasTemplate: Boolean(template),
    specVersion: asString(template?.specVersion),
    pipelineId: asString(template?.pipelineId),
    nodeCount: nodes ? Object.keys(nodes).length : undefined,
  });
}

function compactPipeline(value: unknown): unknown {
  const pipeline = asRecord(value);
  if (!pipeline) return value;
  return definedEntries({
    id: asString(pipeline.id),
    playbookId: asString(pipeline.playbookId),
    pipelineId: asString(pipeline.pipelineId),
    path: asString(pipeline.path),
    triggers: compactStringArray(pipeline.triggers),
    requiredRoles: compactStringArray(pipeline.requiredRoles),
    alternativeRoles: compactRecordArray(pipeline.alternativeRoles),
    optionalRoles: compactStringArray(pipeline.optionalRoles),
    routeGates: compactStringArray(pipeline.routeGates),
    executionPolicySummary: compactExecutionPolicySummary(pipeline.executionPolicy),
  });
}

function compactCreateRunResult(value: unknown): unknown {
  const result = asRecord(value);
  if (!result) return value;
  const workflow = asRecord(result.workflow);
  return definedEntries({
    runId: asString(result.runId),
    taskId: asString(result.taskId),
    eventId: asString(result.eventId),
    status: asString(result.status),
    started: typeof result.started === 'boolean' ? result.started : undefined,
    workflow: workflow
      ? definedEntries({
        runId: asString(workflow.runId),
        workflowID: asString(workflow.workflowID),
        alreadyStarted: typeof workflow.alreadyStarted === 'boolean' ? workflow.alreadyStarted : undefined,
        engine: asString(workflow.engine),
      })
      : undefined,
    routeSummary: compactRouteSummary(result),
  });
}

function compactInboxItem(value: unknown): JsonRecord | unknown {
  const item = asRecord(value);
  if (!item) return value;
  const context = asRecord(item.context);
  const options = Array.isArray(context?.options) ? context.options.length : undefined;
  return definedEntries({
    id: asString(item.id),
    kind: asString(item.kind),
    status: asString(item.status),
    title: compactText(item.title),
    runId: asString(item.runId),
    stepId: asString(item.stepId),
    topic: asString(context?.topic),
    optionCount: options,
  });
}

function compactEventSummary(event: JsonRecord): string {
  const payload = asRecord(event.payload);
  const parts = [payload?.role, payload?.stepKey, payload?.attemptId]
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (parts.length > 0) return parts.join(' ');
  return compactText(payload?.reason) ?? compactText(payload?.verdict) ?? compactText(payload?.lesson) ?? asString(event.type) ?? 'event';
}

function compactRunEvent(value: unknown): JsonRecord | unknown {
  const event = asRecord(value);
  if (!event) return value;
  return definedEntries({
    eventId: asString(event.eventId),
    type: asString(event.type),
    actor: asString(event.actor),
    createdAt: event.createdAt,
    taskId: asString(event.taskId),
    stepId: asString(event.stepId),
    summary: compactEventSummary(event),
  });
}

function compactRunDigest(value: unknown): unknown {
  const digest = asRecord(value);
  if (!digest) return value;
  return definedEntries({
    run: digest.run,
    tasks: digest.tasks,
    pendingInbox: Array.isArray(digest.pendingInbox) ? digest.pendingInbox.map(compactInboxItem) : digest.pendingInbox,
    latestEvents: Array.isArray(digest.latestEvents) ? digest.latestEvents.map(compactRunEvent) : digest.latestEvents,
    usage: digest.usage,
    blockedReason: compactText(digest.blockedReason),
  });
}

function compactFeedbackItems(value: unknown): JsonRecord[] {
  return compactRecordArray(value).map((item) => definedEntries({
    source: asString(item.source),
    summary: compactText(item.summary),
    severity: asString(item.severity),
    path: asString(item.path),
    location: asString(item.location),
    line: asNumber(item.line),
    author: asString(item.author),
    provider: asString(item.provider),
    reason: compactText(item.reason),
    blocking: typeof item.blocking === 'boolean' ? item.blocking : undefined,
    evidence: compactStringArray(item.evidence),
    resumeAfter: asString(item.resumeAfter),
  }));
}

function compactFeedback(value: unknown): unknown {
  const feedback = asRecord(value);
  if (!feedback) return value;
  return definedEntries({
    developerFixes: compactFeedbackItems(feedback.developerFixes),
    reviewerQuestions: compactFeedbackItems(feedback.reviewerQuestions),
    humanDecisions: compactFeedbackItems(feedback.humanDecisions),
    providerWait: compactFeedbackItems(feedback.providerWait),
    ignoredNoise: compactFeedbackItems(feedback.ignoredNoise),
    residualRisks: compactStringArray(feedback.residualRisks),
  });
}

function compactReviewThreads(value: unknown): unknown {
  const reviewThreads = asRecord(value);
  if (!reviewThreads) return value;
  return definedEntries({
    totalCount: asNumber(reviewThreads.totalCount),
    items: compactRecordArray(reviewThreads.items).map((thread) => definedEntries({
      id: asString(thread.id),
      path: asString(thread.path),
      line: asNumber(thread.line),
      author: asString(thread.author),
      body: compactText(thread.body),
      url: asString(thread.url),
    })),
  });
}

function compactCiSummary(value: unknown): unknown {
  const summary = asRecord(value);
  if (!summary) return value;
  return definedEntries({
    ci_passed: typeof summary.ci_passed === 'boolean' ? summary.ci_passed : undefined,
    checks: summary.checks,
    isDraft: typeof summary.isDraft === 'boolean' ? summary.isDraft : undefined,
    mergeStateStatus: asString(summary.mergeStateStatus),
    reviewDecision: asString(summary.reviewDecision),
    mergeable: asString(summary.mergeable),
    issueRef: summary.issueRef,
    sonar_issues: compactRecordArray(summary.sonar_issues).length,
    sonar_hotspots_to_review: compactRecordArray(summary.sonar_hotspots_to_review).length,
    sonar_unavailable: summary.sonar_unavailable,
    humanReviewCount: compactRecordArray(summary.human_reviews).length,
    humanCommentCount: compactRecordArray(summary.human_comments).length,
    botCommentCount: compactRecordArray(summary.bot_comments).length,
  });
}

function compactPrReadiness(value: unknown): unknown {
  const readiness = asRecord(value);
  if (!readiness) return value;
  const evidence = compactStringArray(readiness.evidence);
  return definedEntries({
    verdict: asString(readiness.verdict),
    pr: readiness.pr,
    checks: readiness.checks,
    reviewDecision: asString(readiness.reviewDecision),
    reviewThreads: compactReviewThreads(readiness.reviewThreads),
    providerState: readiness.providerState,
    sonar: readiness.sonar,
    nextAction: asString(readiness.nextAction),
    evidence: evidence.length > 0 ? evidence : undefined,
    feedback: compactFeedback(readiness.feedback),
    ciSummary: compactCiSummary(readiness.ciSummary),
  });
}

@Injectable()
export class McpFacadeService {



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
        'Agent run monitoring: follow task_monitoring_loop — poll get_run_attention, react to nextAction.',
      ],
      observation: {
        primaryTool: 'get_run_attention',
        supportingTools: ['get_run_status', 'get_run_digest', 'get_run_events', 'get_agent_activity', 'get_agent_log'],
        deliveryTool: 'watch_run_changes',
        diagnosticTools: ['get_run_digest', 'get_agent_log', 'get_run_events', 'get_agent_activity'],
        preferredOrder: [
          'get_run_attention for current attention state and next action — agents poll this UNLESS explicitly implementing a change-stream consumer',
          'get_run_status for neutral dashboard or status checks',
          'get_run_digest when nextAction is "inspect_digest"',
          'get_agent_log with offsetBytes/limitBytes or tailBytes when nextAction is "inspect_log" or explicit debugging requires logs',
          'watch_run_changes for UI/change-stream consumers needing cursor-based transition delivery; not for normal task monitoring',
          'avoid get_run(includeEvents:true) and raw agent logs in polling loops',
        ],
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
    issueRef?: { repo: string; number: number; url: string };
    priority?: number;
    start?: boolean;
  }) {
    const pipelineId = input.pipelineId?.trim();
    if (!pipelineId) return this.requirePipelineSelection(input);
    return this.api.createRun(input).then((result) => compactCreateRunResult(result) as JsonRecord).catch((error: unknown) => {
      if (error instanceof CreateRunWorkflowError) {
        const created = Object.keys(error.createdIds).length > 0
          ? `; createdBeforeFailure=${JSON.stringify(error.createdIds)}`
          : '';
        throw new Error(`${error.message}: ${formatCause(error.cause)}${created}`);
      }
      throw error;
    });
  }

  private async requirePipelineSelection(input: {
    title: string;
    description?: string;
    scope?: string;
    playbookId?: string;
  }): Promise<JsonRecord> {
    const preview = await this.api.previewPipelineSelection({
      title: input.title,
      description: input.description,
      scope: input.scope,
      playbookId: input.playbookId,
    });
    return {
      confirmationRequired: true,
      reason: 'pipeline_selection_required',
      message: 'create_run requires an explicit pipelineId; no run was created. Choose one of candidatePipelines (by its pipelineId) and call create_run again with that pipelineId.',
      playbookId: preview.playbookId,
      candidatePipelines: preview.candidatePipelines.map(compactPipeline),
      wouldAutoRoute: preview.wouldAutoRoute,
      ...(preview.wouldAutoRouteReason ? { wouldAutoRouteReason: preview.wouldAutoRouteReason } : {}),
    };
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
    return withDeadline(exposeApplicationError(this.api.getAgentActivity(runId)), MCP_ACTIVITY_TIMEOUT_MS)
      .then((activity) => activity === undefined
        ? { runId, activity: null, unavailable: true, reason: 'timeout' }
        : activity);
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
    return this.api.getRunDigest(runId).then((digest) => compactRunDigest(digest) as JsonRecord);
  }

  getRunAttention(runId: string): Promise<RunAttentionResult> {
    return this.runWatch.getRunAttention(runId);
  }

  getRunStatus(runId: string): Promise<RunStatusResult> {
    return this.runWatch.getRunStatus(runId);
  }

  watchRunChanges(input: WatchRunChangesInput): Promise<WatchResult> {
    return this.runWatch.watchRunChanges(input);
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

  resolveGate(input: { inboxId: string; outcome: string; note?: string; resolvedBy?: string }) {
    return this.api.resolveGate(input);
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

  async listPipelines(input: ListPipelinesMcpInput = {}) {
    const pipelines = await this.api.listPipelines();
    return input.includeDetails ? pipelines : pipelines.map(compactPipeline);
  }

  async getPipeline(input: GetPipelineMcpInput) {
    const pipeline = await this.api.getPipeline(input.pipelineId);
    return input.includeDetails ? pipeline : compactPipeline(pipeline);
  }

  async simulateRoute(input: SimulateRouteMcpInput) {
    const { includeDetails, ...routeInput } = input;
    const route = await this.api.simulateRoute(routeInput);
    return includeDetails ? route : compactRouteDecision(route);
  }

  getPrReadiness(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    issueRef?: { repo: string; number: number; url: string };
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.getPrReadiness(input).then((readiness) => compactPrReadiness(readiness) as JsonRecord);
  }

  listPrFeedback(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    issueRef?: { repo: string; number: number; url: string };
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.listPrFeedback(input);
  }
}
