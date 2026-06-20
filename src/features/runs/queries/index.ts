import {
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
  GetRunAttemptsHandler,
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  GetRunWorkflowHandler,
  ListRunsHandler,
  SimulateRouteHandler,
];
