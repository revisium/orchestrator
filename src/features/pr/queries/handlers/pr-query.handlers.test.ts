import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetPrReadinessQuery } from '../impl/get-pr-readiness.query.js';
import { ListPrFeedbackQuery } from '../impl/list-pr-feedback.query.js';
import { GetPrReadinessHandler, ListPrFeedbackHandler } from './pr-query.handlers.js';

test('pr query handlers delegate readiness and feedback requests', async () => {
  const input = {
    repo: 'revisium/orchestrator',
    prNumber: 90,
    issueRef: {
      repo: 'revisium/orchestrator',
      number: 147,
      url: 'https://github.com/revisium/orchestrator/issues/147',
    },
  };
  const api = {
    async getPrReadiness(data: unknown) {
      assert.deepEqual(data, input);
      return { status: 'clean' };
    },
    async listPrFeedback(data: unknown) {
      assert.deepEqual(data, input);
      return { developerFixes: [] };
    },
  } as unknown as TaskControlPlaneApiService;

  assert.deepEqual(await new GetPrReadinessHandler(api).execute(new GetPrReadinessQuery(input)), { status: 'clean' });
  assert.deepEqual(await new ListPrFeedbackHandler(api).execute(new ListPrFeedbackQuery(input)), { developerFixes: [] });
});
