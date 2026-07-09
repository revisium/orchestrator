import {
  GetPipelineHandler,
  GetRunProfileHandler,
  GetRoleHandler,
  ListPipelinesHandler,
  ListPlaybooksHandler,
  ListRunProfilesHandler,
  ListRolesHandler,
  ValidateRunProfileHandler,
} from './handlers/method-query.handlers.js';

export const methodQueryHandlers = [
  GetPipelineHandler,
  GetRunProfileHandler,
  GetRoleHandler,
  ListPipelinesHandler,
  ListPlaybooksHandler,
  ListRunProfilesHandler,
  ListRolesHandler,
  ValidateRunProfileHandler,
];
