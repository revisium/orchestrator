import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostFixture } from './harness.js';
import { IntegrationRun } from './integration-context.js';

test('integration context rejects added gate options before resolving the gate', async () => {
  const resolvedInputs: unknown[] = [];
  const host = {
    api: {
      async waitForRun() {
        return {
          state: 'pending_gate',
          workflowStatus: 'PENDING',
          runStatus: 'running',
          nextAction: '',
          runId: 'run-1',
          inbox: {
            id: 'inbox-1',
            context: { topic: 'plan', summary: { outcomes: ['approved', 'surprise'] } },
            options: ['approved', 'surprise'],
          },
        };
      },
      async resolveGate(input: unknown) {
        resolvedInputs.push(input);
        return {};
      },
    },
  } as unknown as HostFixture;
  const run = new IntegrationRun(host, { runId: 'run-1', taskId: 'task-1' });

  await assert.rejects(
    () => run.resolveGate({ topic: 'plan', options: ['approved'], outcome: 'approved' }),
    /unexpected plan gate options/,
  );
  assert.deepEqual(resolvedInputs, []);
});
