import {
  GetPipelineHandler,
  GetRoleHandler,
  ListPipelinesHandler,
  ListPlaybooksHandler,
  ListRolesHandler,
} from './handlers/method-query.handlers.js';

export const methodQueryHandlers = [
  GetPipelineHandler,
  GetRoleHandler,
  ListPipelinesHandler,
  ListPlaybooksHandler,
  ListRolesHandler,
];
