import {
  DoctorHandler,
  GetProjectHandler,
  GetRepositoryContextHandler,
  GetStatusHandler,
  ValidateRepositoryHandler,
} from './handlers/system-query.handlers.js';

export const systemQueryHandlers = [
  DoctorHandler,
  GetProjectHandler,
  GetRepositoryContextHandler,
  GetStatusHandler,
  ValidateRepositoryHandler,
];
