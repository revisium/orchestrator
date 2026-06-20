import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { toConnection } from '../../../shared/connection.js';
import { GetInboxItemQuery } from '../impl/get-inbox-item.query.js';
import { GetPendingDecisionsQuery } from '../impl/get-pending-decisions.query.js';
import { ListInboxQuery } from '../impl/list-inbox.query.js';
import { SummarizeGateRiskQuery } from '../impl/summarize-gate-risk.query.js';

function normalizeStatus(status: string | undefined): 'pending' | 'resolved' | undefined {
  if (status === 'pending' || status === 'resolved') return status;
  return undefined;
}

@QueryHandler(ListInboxQuery)
export class ListInboxHandler implements IQueryHandler<ListInboxQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListInboxQuery) {
    const items = await this.api.listInbox({
      status: normalizeStatus(query.data.status),
      runId: query.data.runId,
      limit: 500,
    });
    return toConnection(items, query.data);
  }
}

@QueryHandler(GetInboxItemQuery)
export class GetInboxItemHandler implements IQueryHandler<GetInboxItemQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetInboxItemQuery) {
    return this.api.getInboxItem(query.data.inboxId);
  }
}

@QueryHandler(GetPendingDecisionsQuery)
export class GetPendingDecisionsHandler implements IQueryHandler<GetPendingDecisionsQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetPendingDecisionsQuery) {
    return this.api.getPendingDecisions(query.data.runId);
  }
}

@QueryHandler(SummarizeGateRiskQuery)
export class SummarizeGateRiskHandler implements IQueryHandler<SummarizeGateRiskQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: SummarizeGateRiskQuery) {
    return this.api.summarizeGateRisk(query.data.inboxId);
  }
}
