import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { DoctorQuery } from '../impl/doctor.query.js';
import { GetProjectQuery } from '../impl/get-project.query.js';
import { GetRepositoryContextQuery } from '../impl/get-repository-context.query.js';
import { GetStatusQuery } from '../impl/get-status.query.js';
import { ValidateRepositoryQuery } from '../impl/validate-repository.query.js';

@QueryHandler(GetStatusQuery)
export class GetStatusHandler implements IQueryHandler<GetStatusQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute() {
    return this.api.getStatus();
  }
}

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute() {
    return this.api.getProject();
  }
}

@QueryHandler(DoctorQuery)
export class DoctorHandler implements IQueryHandler<DoctorQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute() {
    return this.api.doctor();
  }
}

@QueryHandler(ValidateRepositoryQuery)
export class ValidateRepositoryHandler implements IQueryHandler<ValidateRepositoryQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: ValidateRepositoryQuery) {
    return this.api.validateRepository(query.data.repo);
  }
}

@QueryHandler(GetRepositoryContextQuery)
export class GetRepositoryContextHandler implements IQueryHandler<GetRepositoryContextQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(query: GetRepositoryContextQuery) {
    return this.api.getRepositoryContext(query.data.repo);
  }
}
