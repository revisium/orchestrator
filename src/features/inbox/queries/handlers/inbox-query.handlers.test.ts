import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetInboxItemQuery } from '../impl/get-inbox-item.query.js';
import { GetPendingDecisionsQuery } from '../impl/get-pending-decisions.query.js';
import { ListInboxQuery } from '../impl/list-inbox.query.js';
import { SummarizeGateRiskQuery } from '../impl/summarize-gate-risk.query.js';
import {
  GetInboxItemHandler,
  GetPendingDecisionsHandler,
  ListInboxHandler,
  SummarizeGateRiskHandler,
} from './inbox-query.handlers.js';

test('inbox query handlers delegate through TaskControlPlaneApiService', async () => {
  const item = { id: 'inbox_1', kind: 'approval', title: 'Approve', status: 'pending', createdAt: new Date() };
  const api = {
    async listInbox(input: unknown) {
      assert.deepEqual(input, { status: 'pending', runId: 'run_1', limit: 51 });
      return [item];
    },
    async getInboxItem(id: string) {
      assert.equal(id, 'inbox_1');
      return item;
    },
    async getPendingDecisions(runId?: string) {
      assert.equal(runId, 'run_1');
      return [item];
    },
    async summarizeGateRisk(id: string) {
      assert.equal(id, 'inbox_1');
      return { inboxId: id, kind: 'approval', title: 'Approve', topic: 'plan', risk: 'Requires decision.' };
    },
  } as unknown as TaskControlPlaneApiService;

  assert.equal((await new ListInboxHandler(api).execute(new ListInboxQuery({ status: 'pending', runId: 'run_1' }))).edges[0]?.node.id, 'inbox_1');
  assert.equal((await new GetInboxItemHandler(api).execute(new GetInboxItemQuery({ inboxId: 'inbox_1' }))).id, 'inbox_1');
  assert.equal((await new GetPendingDecisionsHandler(api).execute(new GetPendingDecisionsQuery({ runId: 'run_1' })))[0]?.id, 'inbox_1');
  assert.equal((await new SummarizeGateRiskHandler(api).execute(new SummarizeGateRiskQuery({ inboxId: 'inbox_1' }))).topic, 'plan');
});
