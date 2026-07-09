import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { CreateRunProfileCommand } from '../impl/create-run-profile.command.js';
import { DeprecateRunProfileCommand } from '../impl/deprecate-run-profile.command.js';
import { UpdateRunProfileCommand } from '../impl/update-run-profile.command.js';

@CommandHandler(CreateRunProfileCommand)
export class CreateRunProfileHandler implements ICommandHandler<CreateRunProfileCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: CreateRunProfileCommand) {
    return this.api.createProfile(command.data);
  }
}

@CommandHandler(UpdateRunProfileCommand)
export class UpdateRunProfileHandler implements ICommandHandler<UpdateRunProfileCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: UpdateRunProfileCommand) {
    return this.api.updateProfile(command.data);
  }
}

@CommandHandler(DeprecateRunProfileCommand)
export class DeprecateRunProfileHandler implements ICommandHandler<DeprecateRunProfileCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: DeprecateRunProfileCommand) {
    return this.api.deprecateProfile(command.data);
  }
}
