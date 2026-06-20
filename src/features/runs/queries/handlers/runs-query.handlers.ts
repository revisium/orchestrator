import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { toConnection } from '../../../shared/connection.js';
import { GetRunDigestQuery } from '../impl/get-run-digest.query.js';
import { GetRunEventsQuery } from '../impl/get-run-events.query.js';
import { GetRunQuery } from '../impl/get-run.query.js';
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
  if (value instanceof Date) return value;
  return value ? new Date(value) : new Date(0);
}

function mapRun(run: RunLike) {
  return {
    id: run.runId ?? run.id ?? '',
    title: run.title ?? '',
    status: run.status ?? '',
    priority: run.priority ?? 0,
    description: run.description,
    scope: run.scope,
    repos: run.repos ?? [],
    createdAt: date(run.createdAt),
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
    const runs = await this.api.listRuns({ status: query.data.status, limit: 500 });
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

@QueryHandler(GetRunEventsQuery)
export class GetRunEventsHandler implements IQueryHandler<GetRunEventsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRunEventsQuery) {
    const events = await this.api.getRunEvents({
      runId: query.data.runId,
      type: query.data.type,
      limit: 500,
    });
    return toConnection(events.map((event) => mapEvent(query.data.runId, event)), query.data);
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
