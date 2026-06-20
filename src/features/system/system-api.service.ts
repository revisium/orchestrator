import { Inject, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { DoctorQuery } from './queries/impl/doctor.query.js';
import { GetProjectQuery } from './queries/impl/get-project.query.js';
import { GetRepositoryContextQuery, type GetRepositoryContextQueryData } from './queries/impl/get-repository-context.query.js';
import { GetStatusQuery } from './queries/impl/get-status.query.js';
import { ValidateRepositoryQuery, type ValidateRepositoryQueryData } from './queries/impl/validate-repository.query.js';

@Injectable()
export class SystemApiService {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  status() {
    return this.queryBus.execute(new GetStatusQuery());
  }

  project() {
    return this.queryBus.execute(new GetProjectQuery());
  }

  doctor() {
    return this.queryBus.execute(new DoctorQuery());
  }

  validateRepository(data: ValidateRepositoryQueryData) {
    return this.queryBus.execute(new ValidateRepositoryQuery(data));
  }

  repositoryContext(data: GetRepositoryContextQueryData) {
    return this.queryBus.execute(new GetRepositoryContextQuery(data));
  }
}
