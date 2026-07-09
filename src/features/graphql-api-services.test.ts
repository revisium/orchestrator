import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
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
  const commandBus = {
    execute(command: object) {
      names.push(command.constructor.name);
      return Promise.resolve(command);
    },
  } as unknown as CommandBus;

  await new RunsApiService(queryBus, commandBus).listRuns({});
  await new RunsApiService(queryBus, commandBus).getRun({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).getRunEvents({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).getAgentActivity({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).getAgentAttempts({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).getAgentLog({ runId: 'run_1', stream: 'stdout' });
  await new RunsApiService(queryBus, commandBus).getRunProgress({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).getRunDigest({ runId: 'run_1' });
  await new RunsApiService(queryBus, commandBus).simulateRoute({ title: 'Build', pipeline: 'local-change' });
  await new RunsApiService(queryBus, commandBus).createRun({ title: 'Build', repo: '.', pipelineId: 'local-change' });
  await new InboxApiService(queryBus, commandBus).listInbox({});
  await new InboxApiService(queryBus, commandBus).getInboxItem({ inboxId: 'inbox_1' });
  await new InboxApiService(queryBus, commandBus).pendingDecisions({});
  await new InboxApiService(queryBus, commandBus).gateRisk({ inboxId: 'inbox_1' });
  await new InboxApiService(queryBus, commandBus).approveGate({ inboxId: 'inbox_1' });
  await new InboxApiService(queryBus, commandBus).rejectGate({ inboxId: 'inbox_1' });
  await new InboxApiService(queryBus, commandBus).resolveGate({ inboxId: 'inbox_1', outcome: 'recheck' });
  await new InboxApiService(queryBus, commandBus).answerQuestion({ inboxId: 'inbox_1', answer: 'yes' });
  await new InboxApiService(queryBus, commandBus).resolveInboxItem({ inboxId: 'inbox_1', answer: { decision: 'approve' } });
  await new MethodApiService(queryBus, commandBus).listRoles({});
  await new MethodApiService(queryBus, commandBus).getRole({ roleId: 'developer' });
  await new MethodApiService(queryBus, commandBus).listPlaybooks({});
  await new MethodApiService(queryBus, commandBus).listPipelines({});
  await new MethodApiService(queryBus, commandBus).getPipeline({ pipelineId: 'pipe_1' });
  await new MethodApiService(queryBus, commandBus).listRunProfiles({ pipelineId: 'local-change' });
  await new MethodApiService(queryBus, commandBus).getRunProfile({ pipelineId: 'local-change', profileId: 'custom-standard' });
  await new MethodApiService(queryBus, commandBus).validateRunProfile({ pipelineId: 'local-change', profile: {} });
  await new MethodApiService(queryBus, commandBus).createRunProfile({ pipelineId: 'local-change', profileId: 'custom-standard', displayName: 'Custom', profile: {} });
  await new MethodApiService(queryBus, commandBus).updateRunProfile({ pipelineId: 'local-change', profileId: 'custom-standard', expectedProfileHash: 'hash' });
  await new MethodApiService(queryBus, commandBus).deprecateRunProfile({ pipelineId: 'local-change', profileId: 'custom-standard', expectedProfileHash: 'hash' });
  await new PrApiService(queryBus).prReadiness({ repo: 'revisium/orchestrator' });
  await new PrApiService(queryBus).prFeedback({ repo: 'revisium/orchestrator' });

  assert.deepEqual(names, [
    'ListRunsQuery',
    'GetRunQuery',
    'GetRunEventsQuery',
    'GetAgentActivityQuery',
    'GetAgentAttemptsQuery',
    'GetAgentLogQuery',
    'GetRunProgressQuery',
    'GetRunDigestQuery',
    'SimulateRouteQuery',
    'CreateRunCommand',
    'ListInboxQuery',
    'GetInboxItemQuery',
    'GetPendingDecisionsQuery',
    'SummarizeGateRiskQuery',
    'ApproveGateCommand',
    'RejectGateCommand',
    'ResolveGateCommand',
    'AnswerQuestionCommand',
    'ResolveInboxItemCommand',
    'ListRolesQuery',
    'GetRoleQuery',
    'ListPlaybooksQuery',
    'ListPipelinesQuery',
    'GetPipelineQuery',
    'ListRunProfilesQuery',
    'GetRunProfileQuery',
    'ValidateRunProfileQuery',
    'CreateRunProfileCommand',
    'UpdateRunProfileCommand',
    'DeprecateRunProfileCommand',
    'GetPrReadinessQuery',
    'ListPrFeedbackQuery',
  ]);
});
