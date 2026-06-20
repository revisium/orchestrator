import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { connectionFetchLimit, toConnection } from '../../../shared/connection.js';
import { GetInboxItemQuery } from '../impl/get-inbox-item.query.js';
import { GetPendingDecisionsQuery } from '../impl/get-pending-decisions.query.js';
import { ListInboxQuery } from '../impl/list-inbox.query.js';
import { SummarizeGateRiskQuery } from '../impl/summarize-gate-risk.query.js';

function normalizeStatus(status: string | undefined): 'pending' | 'resolved' | undefined {
  if (status === 'pending' || status === 'resolved') return status;
  return undefined;
}

function date(value: Date | string | undefined): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function optionalDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  return date(value);
}

function mapInboxItem<T extends { createdAt?: Date | string; resolvedAt?: Date | string }>(item: T) {
  return {
    ...item,
    createdAt: date(item.createdAt),
    resolvedAt: optionalDate(item.resolvedAt),
  };
}

@QueryHandler(ListInboxQuery)
export class ListInboxHandler implements IQueryHandler<ListInboxQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListInboxQuery) {
    const items = await this.api.listInbox({
      status: normalizeStatus(query.data.status),
      runId: query.data.runId,
      limit: connectionFetchLimit(query.data),
    });
    return toConnection(items.map(mapInboxItem), query.data);
  }
}

@QueryHandler(GetInboxItemQuery)
export class GetInboxItemHandler implements IQueryHandler<GetInboxItemQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetInboxItemQuery) {
    return this.api.getInboxItem(query.data.inboxId).then(mapInboxItem);
  }
}

@QueryHandler(GetPendingDecisionsQuery)
export class GetPendingDecisionsHandler implements IQueryHandler<GetPendingDecisionsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetPendingDecisionsQuery) {
    return this.api.getPendingDecisions(query.data.runId).then((items) => items.map(mapInboxItem));
  }
}

@QueryHandler(SummarizeGateRiskQuery)
export class SummarizeGateRiskHandler implements IQueryHandler<SummarizeGateRiskQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: SummarizeGateRiskQuery) {
    return this.api.summarizeGateRisk(query.data.inboxId);
  }
}
