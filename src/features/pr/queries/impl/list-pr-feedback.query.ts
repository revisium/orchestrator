import type { GetPrReadinessQueryData } from './get-pr-readiness.query.js';

export type ListPrFeedbackQueryData = GetPrReadinessQueryData;

export class ListPrFeedbackQuery {
  constructor(readonly data: ListPrFeedbackQueryData) {}
}
