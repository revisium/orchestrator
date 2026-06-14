import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import {
  createControlPlaneDataAccessForTransport,
  type ControlPlaneDataAccess,
  type ListRowsOptions,
  type PatchOperation,
} from './data-access.js';
import type { ControlPlaneTransport, TransportList, TransportRow } from './client-transport.js';

type CapturedCall = {
  method: 'listRows' | 'getRow' | 'createRow' | 'updateRow' | 'patchRow';
  table: string;
  rowId?: string;
  options?: ListRowsOptions;
  data?: object;
  patches?: PatchOperation[];
};

function fakeTransportRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-05-31T00:00:00.000Z', updatedAt: '2026-05-31T00:00:00.000Z' };
}

function createFakeAccess(handler?: (call: CapturedCall) => unknown): {
  access: ControlPlaneDataAccess;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];

  const transport: ControlPlaneTransport = {
    mode: 'draft' as const,
    async assertReady() {},

    async listRows(table, options) {
      const call: CapturedCall = { method: 'listRows', table, options };
      calls.push(call);
      if (handler) return handler(call) as TransportList;
      return { edges: [{ node: fakeTransportRow('row-1', { id: 'row-1' }) }] };
    },

    async getRow(table, rowId) {
      const call: CapturedCall = { method: 'getRow', table, rowId };
      calls.push(call);
      if (handler) return handler(call) as TransportRow;
      return fakeTransportRow(rowId, { id: rowId });
    },

    async createRow(table, rowId, data) {
      const call: CapturedCall = { method: 'createRow', table, rowId, data };
      calls.push(call);
      if (handler) return handler(call) as TransportRow;
      return fakeTransportRow(rowId, data as Record<string, unknown>);
    },

    async updateRow(table, rowId, data) {
      const call: CapturedCall = { method: 'updateRow', table, rowId, data };
      calls.push(call);
      if (handler) return handler(call) as TransportRow;
      return fakeTransportRow(rowId, data as Record<string, unknown>);
    },

    async patchRow(table, rowId, patches) {
      const call: CapturedCall = { method: 'patchRow', table, rowId, patches };
      calls.push(call);
      if (handler) return handler(call) as TransportRow;
      return fakeTransportRow(rowId, { id: rowId });
    },
  };

  return { access: createControlPlaneDataAccessForTransport(transport), calls };
}

test('list rows passes options and maps response to ControlPlaneRow', async () => {
  const { access, calls } = createFakeAccess(() => ({
    edges: [{ node: fakeTransportRow('run-1', { id: 'run-1', title: 'Run' }) }],
  }));

  const rows = await access.listRows('task_runs', { first: 1, where: { id: { equals: 'run-1' } } });

  assert.equal(calls[0]?.method, 'listRows');
  assert.equal(calls[0]?.table, 'task_runs');
  assert.deepEqual(calls[0]?.options, { first: 1, where: { id: { equals: 'run-1' } } });
  assert.deepEqual(rows[0]?.data, {
    id: 'run-1',
    title: 'Run',
    params: null,
    route_decision: null,
    execution_profile: null,
  });
});

test('list rows passes empty options when no options provided', async () => {
  const { access, calls } = createFakeAccess(() => ({ edges: [] }));

  await access.listRows('task_runs');

  assert.equal(calls[0]?.method, 'listRows');
  assert.equal(calls[0]?.table, 'task_runs');
});

test('createRow serializes JSON-ish fields before transport call', async () => {
  const { access, calls } = createFakeAccess((call) => {
    return fakeTransportRow('step-1', call.data as Record<string, unknown>);
  });

  await access.createRow('steps', 'step-1', { input: { a: 1 }, output: null });

  assert.equal(calls[0]?.method, 'createRow');
  assert.equal(calls[0]?.table, 'steps');
  assert.equal(calls[0]?.rowId, 'step-1');
  const d = calls[0]?.data as Record<string, unknown>;
  assert.equal(d?.input, '{"a":1}');
  assert.equal(d?.output, 'null');
});

test('updateRow serializes JSON-ish fields before transport call', async () => {
  const { access, calls } = createFakeAccess((call) => {
    return fakeTransportRow('step-1', call.data as Record<string, unknown>);
  });

  await access.updateRow('steps', 'step-1', { input: { a: 2 }, output: null });

  const d = calls[0]?.data as Record<string, unknown>;
  assert.equal(d?.input, '{"a":2}');
  assert.equal(d?.output, 'null');
});

test('patchRow serializes JSON-ish patch values before transport call', async () => {
  const { access, calls } = createFakeAccess(() => fakeTransportRow('step-1', { id: 'step-1' }));

  await access.patchRow('steps', 'step-1', [{ op: 'replace', path: 'output', value: { done: true } }]);

  assert.equal(calls[0]?.method, 'patchRow');
  assert.deepEqual(calls[0]?.patches, [{ op: 'replace', path: 'output', value: '{"done":true}' }]);
});

test('JSON-ish fields deserialize after reads', async () => {
  const { access } = createFakeAccess(() => fakeTransportRow('event-1', { id: 'event-1', payload: '[{"ok":true}]' }));

  const row = await access.getRow('events', 'event-1');

  assert.deepEqual(row?.data.payload, [{ ok: true }]);
});

test('unsupported table id is rejected', async () => {
  const { access } = createFakeAccess();

  await assert.rejects(
    () => access.listRows('unknown_table' as never),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('get missing row returns null while update and patch missing rows throw ROW_NOT_FOUND', async () => {
  const { access } = createFakeAccess(() => {
    throw new ControlPlaneError('ROW_NOT_FOUND', 'missing', { status: 404 });
  });

  assert.equal(await access.getRow('task_runs', 'missing'), null);
  await assert.rejects(
    () => access.updateRow('task_runs', 'missing', { title: 'Missing' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND',
  );
  await assert.rejects(
    () => access.patchRow('task_runs', 'missing', [{ op: 'replace', path: 'title', value: 'Missing' }]),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND',
  );
});

test('duplicate and validation errors pass through as explicit codes', async () => {
  const duplicate = createFakeAccess(() => {
    throw new ControlPlaneError('ROW_CONFLICT', 'duplicate', { status: 400 });
  }).access;
  const invalid = createFakeAccess(() => {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'invalid', { status: 422 });
  }).access;

  await assert.rejects(
    () => duplicate.createRow('task_runs', 'run-1', { title: 'Run' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_CONFLICT',
  );
  await assert.rejects(
    () => invalid.createRow('task_runs', 'run-1', { title: 'Run' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('nested JSON-ish patch paths are rejected before transport', async () => {
  const { access, calls } = createFakeAccess();
  const patches: PatchOperation[] = [{ op: 'replace', path: 'input.repo.path', value: 'repo-value' }];

  await assert.rejects(
    () => access.patchRow('steps', 'step-1', patches),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
  assert.equal(calls.length, 0);
});

test('assertReady propagates BOOTSTRAP_NOT_APPLIED from transport', async () => {
  const transport: ControlPlaneTransport = {
    mode: 'draft' as const,
    async assertReady() {
      throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Bootstrap missing');
    },
    async listRows() { return { edges: [] }; },
    async getRow() { return fakeTransportRow('x', {}); },
    async createRow() { return fakeTransportRow('x', {}); },
    async updateRow() { return fakeTransportRow('x', {}); },
    async patchRow() { return fakeTransportRow('x', {}); },
  };

  const access = createControlPlaneDataAccessForTransport(transport);

  await assert.rejects(
    () => access.assertReady(),
    (e: unknown) => e instanceof ControlPlaneError && e.code === 'BOOTSTRAP_NOT_APPLIED',
  );
});

test('head access rejects updateRow and patchRow before transport call', async () => {
  let transportCallCount = 0;
  const transport: ControlPlaneTransport = {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() { return { edges: [] }; },
    async getRow() { return fakeTransportRow('x', {}); },
    async createRow() { transportCallCount++; return fakeTransportRow('x', {}); },
    async updateRow() { transportCallCount++; return fakeTransportRow('x', {}); },
    async patchRow() { transportCallCount++; return fakeTransportRow('x', {}); },
  };

  const headAccess = createControlPlaneDataAccessForTransport(transport);

  await assert.rejects(
    () => headAccess.createRow('task_runs', 'run-1', { title: 'Run' }),
    (e: unknown) => e instanceof ControlPlaneError && e.code === 'VALIDATION_FAILURE',
  );
  await assert.rejects(
    () => headAccess.updateRow('task_runs', 'run-1', { title: 'Run' }),
    (e: unknown) => e instanceof ControlPlaneError && e.code === 'VALIDATION_FAILURE',
  );
  await assert.rejects(
    () => headAccess.patchRow('task_runs', 'run-1', [{ op: 'replace', path: 'title', value: 'Run' }]),
    (e: unknown) => e instanceof ControlPlaneError && e.code === 'VALIDATION_FAILURE',
  );
  assert.equal(transportCallCount, 0);
});

test('default access mode (draft) allows createRow writes', async () => {
  const { access, calls } = createFakeAccess();

  await access.createRow('task_runs', 'run-1', { title: 'Run' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'createRow');
});

test('head access allows reads via listRows and getRow', async () => {
  let readCallCount = 0;
  const transport: ControlPlaneTransport = {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() {
      readCallCount++;
      return { edges: [{ node: fakeTransportRow('run-1', { id: 'run-1' }) }] };
    },
    async getRow() {
      readCallCount++;
      return fakeTransportRow('run-1', { id: 'run-1' });
    },
    async createRow() { return fakeTransportRow('x', {}); },
    async updateRow() { return fakeTransportRow('x', {}); },
    async patchRow() { return fakeTransportRow('x', {}); },
  };

  const headAccess = createControlPlaneDataAccessForTransport(transport);

  const rows = await headAccess.listRows('task_runs');
  const row = await headAccess.getRow('task_runs', 'run-1');

  assert.equal(readCallCount, 2);
  assert.equal(rows.length, 1);
  assert.equal(row?.rowId, 'run-1');
});
