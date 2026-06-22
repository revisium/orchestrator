import {
  GetAgentActivityHandler,
  GetAgentAttemptsHandler,
  GetAgentLogHandler,
  GetRunAttemptsHandler,
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  GetRunWorkflowHandler,
  ListRunsHandler,
  SimulateRouteHandler,
} from './handlers/runs-query.handlers.js';

export const runsQueryHandlers = [
  GetAgentActivityHandler,
  GetAgentAttemptsHandler,
  GetAgentLogHandler,
  GetRunAttemptsHandler,
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  GetRunWorkflowHandler,
  ListRunsHandler,
  SimulateRouteHandler,
];
