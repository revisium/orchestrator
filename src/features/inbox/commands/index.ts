import {
  AnswerQuestionHandler,
  ApproveGateHandler,
  RejectGateHandler,
  ResolveGateHandler,
  ResolveInboxItemHandler,
} from './handlers/inbox-command.handlers.js';

export const inboxCommandHandlers = [
  AnswerQuestionHandler,
  ApproveGateHandler,
  RejectGateHandler,
  ResolveGateHandler,
  ResolveInboxItemHandler,
];
