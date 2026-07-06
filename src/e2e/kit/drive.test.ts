import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import { approveUntilTerminal } from './drive.js';

test('approveUntilTerminal falls back to the first declared gate outcome', async () => {
  const resolved: Array<{ inboxId: string; outcome: string; resolvedBy?: string }> = [];
  let pending = true;
  const api = {
    async waitForRun() {
      if (!pending) {
        return {
          state: 'completed',
          workflowStatus: 'SUCCESS',
          runStatus: 'completed',
          nextAction: '',
          runId: 'run-1',
        };
      }
      return {
        state: 'pending_gate',
        workflowStatus: 'PENDING',
        runStatus: 'running',
        nextAction: '',
        runId: 'run-1',
        inbox: {
          id: 'inbox-1',
          context: { topic: 'plan', summary: { outcomes: ['manual_review', 'defer'] } },
        },
      };
    },
    async resolveGate(input: { inboxId: string; outcome: string; resolvedBy?: string }) {
      resolved.push(input);
      pending = false;
      return {};
    },
  } as unknown as TaskControlPlaneApiService;

  const result = await approveUntilTerminal(api, 'run-1');

  assert.equal(result.state, 'completed');
  assert.deepEqual(result.approvedTopics, ['plan']);
  assert.deepEqual(resolved, [{ inboxId: 'inbox-1', outcome: 'manual_review', resolvedBy: 'e2e' }]);
});
