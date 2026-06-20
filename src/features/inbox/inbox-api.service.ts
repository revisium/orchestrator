import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { AnswerQuestionCommand, type AnswerQuestionCommandData } from './commands/impl/answer-question.command.js';
import { ApproveGateCommand, type ApproveGateCommandData } from './commands/impl/approve-gate.command.js';
import { RejectGateCommand, type RejectGateCommandData } from './commands/impl/reject-gate.command.js';
import { ResolveInboxItemCommand, type ResolveInboxItemCommandData } from './commands/impl/resolve-inbox-item.command.js';
import { GetInboxItemQuery, type GetInboxItemQueryData } from './queries/impl/get-inbox-item.query.js';
import { GetPendingDecisionsQuery, type GetPendingDecisionsQueryData } from './queries/impl/get-pending-decisions.query.js';
import { ListInboxQuery, type ListInboxQueryData } from './queries/impl/list-inbox.query.js';
import { SummarizeGateRiskQuery, type SummarizeGateRiskQueryData } from './queries/impl/summarize-gate-risk.query.js';

@Injectable()
export class InboxApiService {
  constructor(
    @Inject(QueryBus) private readonly queryBus: QueryBus,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

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

  approveGate(data: ApproveGateCommandData) {
    return this.commandBus.execute(new ApproveGateCommand(data));
  }

  rejectGate(data: RejectGateCommandData) {
    return this.commandBus.execute(new RejectGateCommand(data));
  }

  answerQuestion(data: AnswerQuestionCommandData) {
    return this.commandBus.execute(new AnswerQuestionCommand(data));
  }

  resolveInboxItem(data: ResolveInboxItemCommandData) {
    return this.commandBus.execute(new ResolveInboxItemCommand(data));
  }
}
