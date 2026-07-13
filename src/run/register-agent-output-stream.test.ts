import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { listAgentOutputStreamRegistrations, registerAgentOutputStream } from './register-agent-output-stream.js';

function store(rows: ControlPlaneRow[] = []): ControlPlaneDataAccess {
  return {
    assertReady: async () => undefined,
    listRows: async () => rows,
    getRow: async (_table, id) => rows.find((row) => row.rowId === id) ?? null,
    createRow: async (_table, id, data) => {
      if (rows.some((row) => row.rowId === id)) throw new ControlPlaneError('ROW_CONFLICT', 'duplicate');
      const row = { rowId: id, data: { ...data }, cursor: id };
      rows.push(row);
      return row;
    },
    updateRow: async () => { throw new Error('unused'); },
    patchRow: async () => { throw new Error('unused'); },
  };
}

test('agent output registration is deterministic and strict-idempotent', async () => {
  const da = store();
  const input = { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', attemptId: 'attempt-1' };
  await registerAgentOutputStream(da, input);
  await registerAgentOutputStream(da, input);
  assert.equal((await listAgentOutputStreamRegistrations(da, input.runId)).length, 1);
  await assert.rejects(() => registerAgentOutputStream(da, { ...input, attemptId: 'attempt/unsafe' }), /safe non-empty/);
});

test('agent output registration rejects an immutable conflict', async () => {
  const da = store();
  const input = { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', attemptId: 'attempt-1' };
  await registerAgentOutputStream(da, input);
  const row = (await da.listRows('events'))[0]!;
  row.data.task_id = 'other-task';
  await assert.rejects(() => registerAgentOutputStream(da, input), (error) => error instanceof ControlPlaneError && error.code === 'ROW_CONFLICT');
});

test('agent output discovery rejects malformed or reordered rows', async () => {
  const da = store();
  await registerAgentOutputStream(da, { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', attemptId: 'attempt-1' });
  const row = (await da.listRows('events'))[0]!;
  row.data.id = 'wrong-row-id';
  await assert.rejects(() => listAgentOutputStreamRegistrations(da, 'run-1'), (error) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE');
});

test('agent output registration rejects extra immutable fields and payload fields', async () => {
  const da = store();
  const input = { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', attemptId: 'attempt-1' };
  await registerAgentOutputStream(da, input);
  const row = (await da.listRows('events'))[0]!;
  (row.data.payload as Record<string, unknown>).extra = true;
  await assert.rejects(() => registerAgentOutputStream(da, input), (error) => error instanceof ControlPlaneError && error.code === 'ROW_CONFLICT');
});
