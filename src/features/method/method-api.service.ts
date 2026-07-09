import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateRunProfileCommand, type CreateRunProfileCommandData } from './commands/impl/create-run-profile.command.js';
import { DeprecateRunProfileCommand, type DeprecateRunProfileCommandData } from './commands/impl/deprecate-run-profile.command.js';
import { UpdateRunProfileCommand, type UpdateRunProfileCommandData } from './commands/impl/update-run-profile.command.js';
import { GetPipelineQuery, type GetPipelineQueryData } from './queries/impl/get-pipeline.query.js';
import { GetRunProfileQuery, type GetRunProfileQueryData } from './queries/impl/get-run-profile.query.js';
import { GetRoleQuery, type GetRoleQueryData } from './queries/impl/get-role.query.js';
import { ListPipelinesQuery, type ListPipelinesQueryData } from './queries/impl/list-pipelines.query.js';
import { ListPlaybooksQuery, type ListPlaybooksQueryData } from './queries/impl/list-playbooks.query.js';
import { ListRunProfilesQuery, type ListRunProfilesQueryData } from './queries/impl/list-run-profiles.query.js';
import { ListRolesQuery, type ListRolesQueryData } from './queries/impl/list-roles.query.js';
import { ValidateRunProfileQuery, type ValidateRunProfileQueryData } from './queries/impl/validate-run-profile.query.js';

@Injectable()
export class MethodApiService {
  constructor(
    @Inject(QueryBus) private readonly queryBus: QueryBus,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

  listRoles(data: ListRolesQueryData) {
    return this.queryBus.execute(new ListRolesQuery(data));
  }

  getRole(data: GetRoleQueryData) {
    return this.queryBus.execute(new GetRoleQuery(data));
  }

  listPlaybooks(data: ListPlaybooksQueryData) {
    return this.queryBus.execute(new ListPlaybooksQuery(data));
  }

  listPipelines(data: ListPipelinesQueryData) {
    return this.queryBus.execute(new ListPipelinesQuery(data));
  }

  getPipeline(data: GetPipelineQueryData) {
    return this.queryBus.execute(new GetPipelineQuery(data));
  }

  listRunProfiles(data: ListRunProfilesQueryData) {
    return this.queryBus.execute(new ListRunProfilesQuery(data));
  }

  getRunProfile(data: GetRunProfileQueryData) {
    return this.queryBus.execute(new GetRunProfileQuery(data));
  }

  validateRunProfile(data: ValidateRunProfileQueryData) {
    return this.queryBus.execute(new ValidateRunProfileQuery(data));
  }

  createRunProfile(data: CreateRunProfileCommandData) {
    return this.commandBus.execute(new CreateRunProfileCommand(data));
  }

  updateRunProfile(data: UpdateRunProfileCommandData) {
    return this.commandBus.execute(new UpdateRunProfileCommand(data));
  }

  deprecateRunProfile(data: DeprecateRunProfileCommandData) {
    return this.commandBus.execute(new DeprecateRunProfileCommand(data));
  }
}
