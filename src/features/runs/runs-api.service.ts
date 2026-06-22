import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateRunCommand, type CreateRunCommandData } from './commands/impl/create-run.command.js';
import { GetAgentActivityQuery, type GetAgentActivityQueryData } from './queries/impl/get-agent-activity.query.js';
import { GetAgentAttemptsQuery, type GetAgentAttemptsQueryData } from './queries/impl/get-agent-attempts.query.js';
import { GetAgentLogQuery, type GetAgentLogQueryData } from './queries/impl/get-agent-log.query.js';
import { GetRunAttemptsQuery, type GetRunAttemptsQueryData } from './queries/impl/get-run-attempts.query.js';
import { GetRunDigestQuery, type GetRunDigestQueryData } from './queries/impl/get-run-digest.query.js';
import { GetRunEventsQuery, type GetRunEventsQueryData } from './queries/impl/get-run-events.query.js';
import { GetRunProgressQuery, type GetRunProgressQueryData } from './queries/impl/get-run-progress.query.js';
import { GetRunQuery, type GetRunQueryData } from './queries/impl/get-run.query.js';
import { GetRunWorkflowQuery, type GetRunWorkflowQueryData } from './queries/impl/get-run-workflow.query.js';
import { ListRunsQuery, type ListRunsQueryData } from './queries/impl/list-runs.query.js';
import { SimulateRouteQuery, type SimulateRouteQueryData } from './queries/impl/simulate-route.query.js';

@Injectable()
export class RunsApiService {
  constructor(
    @Inject(QueryBus) private readonly queryBus: QueryBus,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

  listRuns(data: ListRunsQueryData) {
    return this.queryBus.execute(new ListRunsQuery(data));
  }

  getRun(data: GetRunQueryData) {
    return this.queryBus.execute(new GetRunQuery(data));
  }

  getRunEvents(data: GetRunEventsQueryData) {
    return this.queryBus.execute(new GetRunEventsQuery(data));
  }

  getRunAttempts(data: GetRunAttemptsQueryData) {
    return this.queryBus.execute(new GetRunAttemptsQuery(data));
  }

  getRunProgress(data: GetRunProgressQueryData) {
    return this.queryBus.execute(new GetRunProgressQuery(data));
  }

  getRunWorkflow(data: GetRunWorkflowQueryData) {
    return this.queryBus.execute(new GetRunWorkflowQuery(data));
  }

  getRunDigest(data: GetRunDigestQueryData) {
    return this.queryBus.execute(new GetRunDigestQuery(data));
  }

  simulateRoute(data: SimulateRouteQueryData) {
    return this.queryBus.execute(new SimulateRouteQuery(data));
  }

  createRun(data: CreateRunCommandData) {
    return this.commandBus.execute(new CreateRunCommand(data));
  }

  getAgentActivity(data: GetAgentActivityQueryData) {
    return this.queryBus.execute(new GetAgentActivityQuery(data));
  }

  getAgentAttempts(data: GetAgentAttemptsQueryData) {
    return this.queryBus.execute(new GetAgentAttemptsQuery(data));
  }

  getAgentLog(data: GetAgentLogQueryData) {
    return this.queryBus.execute(new GetAgentLogQuery(data));
  }
}
