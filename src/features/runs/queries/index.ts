import {
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunHandler,
  ListRunsHandler,
  SimulateRouteHandler,
} from './handlers/runs-query.handlers.js';

export const runsQueryHandlers = [
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunHandler,
  ListRunsHandler,
  SimulateRouteHandler,
];
