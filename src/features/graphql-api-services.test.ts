import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueryBus } from '@nestjs/cqrs';
import { InboxApiService } from './inbox/inbox-api.service.js';
import { MethodApiService } from './method/method-api.service.js';
import { PrApiService } from './pr/pr-api.service.js';
import { RunsApiService } from './runs/runs-api.service.js';

test('GraphQL facade services wrap query-bus requests', async () => {
  const names: string[] = [];
  const queryBus = {
    execute(query: object) {
      names.push(query.constructor.name);
      return Promise.resolve(query);
    },
  } as unknown as QueryBus;

  await new RunsApiService(queryBus).listRuns({});
  await new RunsApiService(queryBus).getRun({ runId: 'run_1' });
  await new RunsApiService(queryBus).getRunEvents({ runId: 'run_1' });
  await new RunsApiService(queryBus).getRunProgress({ runId: 'run_1' });
  await new RunsApiService(queryBus).getRunDigest({ runId: 'run_1' });
  await new RunsApiService(queryBus).simulateRoute({ title: 'Build' });
  await new InboxApiService(queryBus).listInbox({});
  await new InboxApiService(queryBus).getInboxItem({ inboxId: 'inbox_1' });
  await new InboxApiService(queryBus).pendingDecisions({});
  await new InboxApiService(queryBus).gateRisk({ inboxId: 'inbox_1' });
  await new MethodApiService(queryBus).listRoles({});
  await new MethodApiService(queryBus).getRole({ roleId: 'developer' });
  await new MethodApiService(queryBus).listPlaybooks({});
  await new MethodApiService(queryBus).listPipelines({});
  await new MethodApiService(queryBus).getPipeline({ pipelineId: 'pipe_1' });
  await new PrApiService(queryBus).prReadiness({ repo: 'revisium/orchestrator' });
  await new PrApiService(queryBus).prFeedback({ repo: 'revisium/orchestrator' });

  assert.deepEqual(names, [
    'ListRunsQuery',
    'GetRunQuery',
    'GetRunEventsQuery',
    'GetRunProgressQuery',
    'GetRunDigestQuery',
    'SimulateRouteQuery',
    'ListInboxQuery',
    'GetInboxItemQuery',
    'GetPendingDecisionsQuery',
    'SummarizeGateRiskQuery',
    'ListRolesQuery',
    'GetRoleQuery',
    'ListPlaybooksQuery',
    'ListPipelinesQuery',
    'GetPipelineQuery',
    'GetPrReadinessQuery',
    'ListPrFeedbackQuery',
  ]);
});
