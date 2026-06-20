import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { connectionFetchLimit, toConnection } from '../../../shared/connection.js';
import { GetRunAttemptsQuery } from '../impl/get-run-attempts.query.js';
import { GetRunDigestQuery } from '../impl/get-run-digest.query.js';
import { GetRunEventsQuery } from '../impl/get-run-events.query.js';
import { GetRunProgressQuery } from '../impl/get-run-progress.query.js';
import { GetRunQuery } from '../impl/get-run.query.js';
import { GetRunWorkflowQuery } from '../impl/get-run-workflow.query.js';
import { ListRunsQuery } from '../impl/list-runs.query.js';
import { SimulateRouteQuery } from '../impl/simulate-route.query.js';

type RunLike = {
  runId?: string;
  id?: string;
  title?: string;
  status?: string;
  priority?: number;
  description?: string;
  scope?: string;
  repos?: string[];
  createdAt?: Date | string;
};

type EventLike = {
  eventId?: string;
  id?: string;
  type?: string;
  actor?: string;
  createdAt?: Date | string;
  taskId?: string;
  stepId?: string;
  payload?: unknown;
};

function date(value: Date | string | undefined): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function status(value: string | undefined): string {
  return value === 'paused' ? 'blocked' : value ?? '';
}

function rawStatusFilter(value: string | undefined): string | undefined {
  return value === 'blocked' ? 'paused' : value;
}

function mapRun(run: RunLike) {
  return {
    id: run.runId ?? run.id ?? '',
    title: run.title ?? '',
    status: status(run.status),
    priority: run.priority ?? 0,
    description: run.description,
    scope: run.scope,
    repos: run.repos ?? [],
    createdAt: date(run.createdAt),
  };
}

function mapAttempt(runId: string, attempt: {
  attemptId?: string;
  stepId?: string;
  iteration?: number;
  status?: string;
  verdict?: string;
  modelProfile?: string;
  inputTokens?: number;
  outputTokens?: number;
  costAmount?: number;
  currency?: string;
  durationMs?: number;
  outputSummary?: string;
  artifactRef?: string;
  lesson?: string;
  error?: string;
  startedAt?: Date | string;
}) {
  return {
    id: attempt.attemptId ?? '',
    runId,
    stepId: attempt.stepId ?? '',
    stepKey: attempt.stepId ?? '',
    iteration: attempt.iteration ?? 0,
    status: attempt.status ?? '',
    verdict: attempt.verdict ?? '',
    modelProfile: attempt.modelProfile ?? '',
    inputTokens: attempt.inputTokens ?? 0,
    outputTokens: attempt.outputTokens ?? 0,
    costAmount: attempt.costAmount ?? 0,
    currency: attempt.currency ?? 'USD',
    durationMs: attempt.durationMs ?? 0,
    outputSummary: attempt.outputSummary ?? '',
    artifactRef: attempt.artifactRef ?? '',
    lesson: attempt.lesson ?? '',
    error: attempt.error ?? '',
    startedAt: date(attempt.startedAt),
  };
}

function mapEvent(runId: string, event: EventLike) {
  return {
    id: event.eventId ?? event.id ?? '',
    runId,
    type: event.type ?? '',
    actor: event.actor ?? '',
    createdAt: date(event.createdAt),
    taskId: event.taskId ?? '',
    stepId: event.stepId ?? '',
    payload: event.payload,
  };
}

@QueryHandler(ListRunsQuery)
export class ListRunsHandler implements IQueryHandler<ListRunsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListRunsQuery) {
    const runs = await this.api.listRuns({
      status: rawStatusFilter(query.data.status),
      limit: connectionFetchLimit(query.data),
    });
    return toConnection(runs.map(mapRun), query.data);
  }
}

@QueryHandler(GetRunQuery)
export class GetRunHandler implements IQueryHandler<GetRunQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRunQuery) {
    const detail = await this.api.getRun({ runId: query.data.runId, includeEvents: query.data.includeEvents });
    return mapRun(detail.run);
  }
}

@QueryHandler(GetRunProgressQuery)
export class GetRunProgressHandler implements IQueryHandler<GetRunProgressQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetRunProgressQuery) {
    return this.api.getRunProgress(query.data.runId);
  }
}

@QueryHandler(GetRunEventsQuery)
export class GetRunEventsHandler implements IQueryHandler<GetRunEventsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRunEventsQuery) {
    const events = await this.api.getRunEvents({
      runId: query.data.runId,
      type: query.data.type,
      limit: connectionFetchLimit(query.data),
    });
    return toConnection(events.map((event) => mapEvent(query.data.runId, event)), query.data);
  }
}

@QueryHandler(GetRunAttemptsQuery)
export class GetRunAttemptsHandler implements IQueryHandler<GetRunAttemptsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRunAttemptsQuery) {
    const attempts = await this.api.getRunLog({
      runId: query.data.runId,
      limit: connectionFetchLimit(query.data),
    });
    return toConnection(attempts.map((attempt) => mapAttempt(query.data.runId, attempt)), query.data);
  }
}

@QueryHandler(GetRunWorkflowQuery)
export class GetRunWorkflowHandler implements IQueryHandler<GetRunWorkflowQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetRunWorkflowQuery) {
    return this.api.getRunWorkflow(query.data.runId);
  }
}

@QueryHandler(GetRunDigestQuery)
export class GetRunDigestHandler implements IQueryHandler<GetRunDigestQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRunDigestQuery) {
    const digest = await this.api.getRunDigest(query.data.runId);
    return {
      ...digest,
      run: mapRun(digest.run),
      latestEvents: digest.latestEvents.map((event) => mapEvent(query.data.runId, event)),
    };
  }
}

@QueryHandler(SimulateRouteQuery)
export class SimulateRouteHandler implements IQueryHandler<SimulateRouteQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: SimulateRouteQuery) {
    return this.api.simulateRoute(query.data);
  }
}
