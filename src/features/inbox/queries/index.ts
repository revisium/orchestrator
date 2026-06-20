import {
  GetInboxItemHandler,
  GetPendingDecisionsHandler,
  ListInboxHandler,
  SummarizeGateRiskHandler,
} from './handlers/inbox-query.handlers.js';

export const inboxQueryHandlers = [
  GetInboxItemHandler,
  GetPendingDecisionsHandler,
  ListInboxHandler,
  SummarizeGateRiskHandler,
];
