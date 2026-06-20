import {
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  ListRunsHandler,
  SimulateRouteHandler,
} from './handlers/runs-query.handlers.js';

export const runsQueryHandlers = [
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  ListRunsHandler,
  SimulateRouteHandler,
];
