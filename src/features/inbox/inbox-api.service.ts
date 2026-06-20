import { Inject, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { GetInboxItemQuery, type GetInboxItemQueryData } from './queries/impl/get-inbox-item.query.js';
import { GetPendingDecisionsQuery, type GetPendingDecisionsQueryData } from './queries/impl/get-pending-decisions.query.js';
import { ListInboxQuery, type ListInboxQueryData } from './queries/impl/list-inbox.query.js';
import { SummarizeGateRiskQuery, type SummarizeGateRiskQueryData } from './queries/impl/summarize-gate-risk.query.js';

@Injectable()
export class InboxApiService {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  listInbox(data: ListInboxQueryData) {
    return this.queryBus.execute(new ListInboxQuery(data));
  }

  getInboxItem(data: GetInboxItemQueryData) {
    return this.queryBus.execute(new GetInboxItemQuery(data));
  }

  pendingDecisions(data: GetPendingDecisionsQueryData) {
    return this.queryBus.execute(new GetPendingDecisionsQuery(data));
  }

  gateRisk(data: SummarizeGateRiskQueryData) {
    return this.queryBus.execute(new SummarizeGateRiskQuery(data));
  }
}
