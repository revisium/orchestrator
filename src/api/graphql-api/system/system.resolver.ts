import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { SystemApiService } from '../../../features/system/system-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { DoctorResultModel } from './model/doctor-result.model.js';
import { ProjectModel } from './model/project.model.js';
import { RepositoryContextModel } from './model/repository-context.model.js';
import { RepositoryValidationModel } from './model/repository-validation.model.js';
import { SystemStatusModel } from './model/system-status.model.js';

@Resolver(() => SystemStatusModel)
export class SystemResolver {
  constructor(@Inject(SystemApiService) private readonly api: SystemApiService) {}

  @Query(() => SystemStatusModel)
  status() {
    return this.api.status();
  }

  @Query(() => ProjectModel)
  project() {
    return this.api.project();
  }

  @Query(() => DoctorResultModel)
  doctor() {
    return this.api.doctor();
  }

  @Query(() => RepositoryValidationModel)
  @GraphqlParamTypes(String)
  validateRepository(@Args('repo', { type: () => String }) repo: string) {
    return this.api.validateRepository({ repo });
  }

  @Query(() => RepositoryContextModel)
  @GraphqlParamTypes(String)
  repositoryContext(@Args('repo', { type: () => String }) repo: string) {
    return this.api.repositoryContext({ repo });
  }
}
