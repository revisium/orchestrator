import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpContext } from './mcp-context.js';
import type { TargetRepo } from './git-target-repo.js';

function toolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

test('MCP context tracks created runs and unparks leftovers through public tools before target cleanup', async () => {
  const calls: string[] = [];
  let gateResolved = false;
  let statusChecks = 0;
  let targetCleaned = false;
  const registeredTaskIds: string[] = [];
  const client = {
    async callTool(input: { name: string }) {
      calls.push(input.name);
      if (input.name === 'create_run') return toolResult({ runId: 'run-1', taskId: 'task-1' });
      if (input.name === 'get_run_attention') {
        return toolResult(gateResolved
          ? { runId: 'run-1', state: 'completed', nextAction: 'done', requiresAttention: false }
          : {
              runId: 'run-1',
              state: 'pending_gate',
              nextAction: 'ask_human',
              requiresAttention: true,
              inbox: { id: 'inbox-1' },
            });
      }
      if (input.name === 'get_inbox_item') {
        return toolResult({
          id: 'inbox-1',
          kind: 'approval',
          status: 'pending',
          options: ['approved', 'cancel'],
          context: { topic: 'plan' },
        });
      }
      if (input.name === 'resolve_gate') {
        gateResolved = true;
        return toolResult({ status: 'resolved' });
      }
      if (input.name === 'get_run_status') {
        statusChecks += 1;
        return toolResult({
          state: 'completed',
          runStatus: 'completed',
          workflowStatus: statusChecks === 1 ? '' : 'SUCCESS',
        });
      }
      throw new Error(`unexpected tool ${input.name}`);
    },
    async close() {},
  } as unknown as Client;
  const transport = { async close() {} } as unknown as StdioClientTransport;
  const target = {
    root: '/tmp/fake-target',
    worktree: '/tmp/fake-target/worktree',
    repairDirty() {},
    cleanup() { targetCleaned = true; },
  } satisfies TargetRepo;
  const context = new McpContext(
    client,
    transport,
    () => target,
    ({ taskId }) => registeredTaskIds.push(taskId),
  );

  const created = await context.createRun({
    title: 'tracked cleanup',
    pipelineId: 'feature-development',
    start: false,
  });
  assert.equal(created.data?.runId, 'run-1');
  assert.deepEqual(registeredTaskIds, ['task-1']);
  await context.close();

  assert.deepEqual(calls, [
    'create_run',
    'get_run_attention',
    'get_inbox_item',
    'resolve_gate',
    'get_run_attention',
    'get_run_status',
    'get_run_attention',
    'get_run_status',
  ]);
  assert.equal(targetCleaned, true);
});

test('MCP context cancels an active running run through public tools before target cleanup', async () => {
  const calls: string[] = [];
  let cancelled = false;
  let runningInspections = 0;
  let targetCleaned = false;
  const client = {
    async callTool(input: { name: string }) {
      calls.push(input.name);
      if (input.name === 'create_run') return toolResult({ runId: 'run-running', taskId: 'task-running' });
      if (input.name === 'get_run_attention') {
        if (!cancelled) {
          runningInspections += 1;
          if (runningInspections > 1) throw new Error('cleanup polled a running run instead of cancelling it');
          return toolResult({
            runId: 'run-running',
            state: 'running',
            nextAction: 'wait',
            requiresAttention: false,
          });
        }
        return toolResult({
          runId: 'run-running',
          state: 'cancelled',
          nextAction: 'done',
          requiresAttention: false,
        });
      }
      if (input.name === 'cancel_run') {
        cancelled = true;
        return toolResult({ status: 'cancelled' });
      }
      if (input.name === 'get_run_status') {
        return toolResult({ state: 'cancelled', runStatus: 'cancelled', workflowStatus: 'PENDING' });
      }
      throw new Error(`unexpected tool ${input.name}`);
    },
    async close() {},
  } as unknown as Client;
  const transport = { async close() {} } as unknown as StdioClientTransport;
  const target = {
    root: '/tmp/fake-running-target',
    worktree: '/tmp/fake-running-target/worktree',
    repairDirty() {},
    cleanup() { targetCleaned = true; },
  } satisfies TargetRepo;
  const context = new McpContext(client, transport, () => target);

  const created = await context.createRun({
    title: 'running cleanup',
    pipelineId: 'feature-development',
    start: false,
  });
  assert.equal(created.data?.runId, 'run-running');
  await context.cleanupRun('run-running');
  await context.close();

  assert.deepEqual(calls, [
    'create_run',
    'get_run_attention',
    'cancel_run',
    'get_run_attention',
    'get_run_status',
  ]);
  assert.equal(targetCleaned, true);
});

test('MCP context aggregates every target cleanup failure and does not retain targets for a second close', async () => {
  const cleanupAttempts: string[] = [];
  const targets = ['first', 'second'].map((name) => ({
    root: `/tmp/${name}`,
    worktree: `/tmp/${name}/worktree`,
    repairDirty() {},
    cleanup() {
      cleanupAttempts.push(name);
      throw new Error(`${name} cleanup failed`);
    },
  }) satisfies TargetRepo);
  const client = {
    async callTool() {
      return toolError('create failed');
    },
    async close() {},
  } as unknown as Client;
  const transport = { async close() {} } as unknown as StdioClientTransport;
  let targetIndex = 0;
  const context = new McpContext(client, transport, () => targets[targetIndex++] as TargetRepo);

  await context.createRun({ title: 'first', pipelineId: 'local-change', start: false });
  await context.createRun({ title: 'second', pipelineId: 'local-change', start: false });

  await assert.rejects(context.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(String), [
      'Error: first cleanup failed',
      'Error: second cleanup failed',
    ]);
    return true;
  });
  assert.deepEqual(cleanupAttempts, ['first', 'second']);

  await context.close();
  assert.deepEqual(cleanupAttempts, ['first', 'second']);
});
