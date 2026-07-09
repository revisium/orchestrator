import {
  CreateRunProfileHandler,
  DeprecateRunProfileHandler,
  UpdateRunProfileHandler,
} from './handlers/method-command.handlers.js';

export const methodCommandHandlers = [
  CreateRunProfileHandler,
  UpdateRunProfileHandler,
  DeprecateRunProfileHandler,
];
