import {
  AnswerQuestionHandler,
  ApproveGateHandler,
  RejectGateHandler,
  ResolveInboxItemHandler,
} from './handlers/inbox-command.handlers.js';

export const inboxCommandHandlers = [
  AnswerQuestionHandler,
  ApproveGateHandler,
  RejectGateHandler,
  ResolveInboxItemHandler,
];
