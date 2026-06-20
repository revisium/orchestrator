import { Inject, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { GetRunDigestQuery, type GetRunDigestQueryData } from './queries/impl/get-run-digest.query.js';
import { GetRunEventsQuery, type GetRunEventsQueryData } from './queries/impl/get-run-events.query.js';
import { GetRunQuery, type GetRunQueryData } from './queries/impl/get-run.query.js';
import { ListRunsQuery, type ListRunsQueryData } from './queries/impl/list-runs.query.js';
import { SimulateRouteQuery, type SimulateRouteQueryData } from './queries/impl/simulate-route.query.js';

@Injectable()
export class RunsApiService {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  listRuns(data: ListRunsQueryData) {
    return this.queryBus.execute(new ListRunsQuery(data));
  }

  getRun(data: GetRunQueryData) {
    return this.queryBus.execute(new GetRunQuery(data));
  }

  getRunEvents(data: GetRunEventsQueryData) {
    return this.queryBus.execute(new GetRunEventsQuery(data));
  }

  getRunDigest(data: GetRunDigestQueryData) {
    return this.queryBus.execute(new GetRunDigestQuery(data));
  }

  simulateRoute(data: SimulateRouteQueryData) {
    return this.queryBus.execute(new SimulateRouteQuery(data));
  }
}
