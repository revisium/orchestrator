import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetPrReadinessQuery } from '../impl/get-pr-readiness.query.js';
import { ListPrFeedbackQuery } from '../impl/list-pr-feedback.query.js';

@QueryHandler(GetPrReadinessQuery)
export class GetPrReadinessHandler implements IQueryHandler<GetPrReadinessQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetPrReadinessQuery) {
    return this.api.getPrReadiness(query.data);
  }
}

@QueryHandler(ListPrFeedbackQuery)
export class ListPrFeedbackHandler implements IQueryHandler<ListPrFeedbackQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: ListPrFeedbackQuery) {
    return this.api.listPrFeedback(query.data);
  }
}
