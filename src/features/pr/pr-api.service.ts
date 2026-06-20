import { Inject, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { GetPrReadinessQuery, type GetPrReadinessQueryData } from './queries/impl/get-pr-readiness.query.js';
import { ListPrFeedbackQuery, type ListPrFeedbackQueryData } from './queries/impl/list-pr-feedback.query.js';

@Injectable()
export class PrApiService {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  prReadiness(data: GetPrReadinessQueryData) {
    return this.queryBus.execute(new GetPrReadinessQuery(data));
  }

  prFeedback(data: ListPrFeedbackQueryData) {
    return this.queryBus.execute(new ListPrFeedbackQuery(data));
  }
}
