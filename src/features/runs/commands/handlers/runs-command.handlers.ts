import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { CreateRunCommand } from '../impl/create-run.command.js';

@CommandHandler(CreateRunCommand)
export class CreateRunHandler implements ICommandHandler<CreateRunCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: CreateRunCommand) {
    return this.api.createRun(command.data);
  }
}
