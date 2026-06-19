/**
 * inbox.test.ts — unit tests for pure inbox verbs.
 *
 * Covers:
 *  - pushInbox: inserts row with correct shape, seeds answer:null/resolved_by/resolved_at,
 *    redacts secrets in context.
 *  - listInbox / getInbox: read delegation, null on missing.
 *  - resolveInbox: inbox flip to resolved, idempotency (double-resolve / already-resolved),
 *    illegal-transition guard. (The originating-step park/unblock was retired — audit §3.1.)
 *  - Invariant: no @dbos-inc/* import in inbox.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from './data-access.js';
import type { RuntimeTable } from './tables.js';
import { pushInbox, listInbox, getInbox, resolveInbox, redactSecrets, type NewInboxItem } from './inbox.js';
import { ControlPlaneError } from './errors.js';

// ─── fake DataAccess factory ─────────────────────────────────

type StoredRow = Record<string, unknown>;

function makeFakeDa(
  initialRows: { table: RuntimeTable; rowId: string; data: StoredRow }[] = [],
  opts: { assertReadyError?: Error } = {},
) {
  const store = new Map<string, { rowId: string; data: StoredRow }>();
  for (const r of initialRows) {
    store.set(`${r.table}:${r.rowId}`, { rowId: r.rowId, data: r.data });
  }

  const createCalls: Array<{ table: RuntimeTable; rowId: string; data: StoredRow }> = [];
  const patchCalls: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const getCalls: Array<{ table: RuntimeTable; rowId: string }> = [];

  const da: ControlPlaneDataAccess = {
    async assertReady() {
      if (opts.assertReadyError) throw opts.assertReadyError;
    },
    async listRows(table) {
      const rows: ControlPlaneRow[] = [];
      for (const [key, val] of store) {
        if (key.startsWith(`${String(table)}:`)) {
          rows.push({ rowId: val.rowId, data: val.data });
        }
      }
      return rows;
    },
    async getRow(table, rowId) {
      getCalls.push({ table, rowId });
      return store.get(`${String(table)}:${rowId}`) ?? null;
    },
    async createRow(table, rowId, data) {
      createCalls.push({ table, rowId, data: data as StoredRow });
      const row = { rowId, data: data as StoredRow };
      store.set(`${String(table)}:${rowId}`, row);
      return row;
    },
    async updateRow(_table, rowId, data) {
      return { rowId, data: data as StoredRow };
    },
    async patchRow(table, rowId, ops) {
      patchCalls.push({ table, rowId, ops });
      // Apply patches to the in-memory store so subsequent reads see updates.
      const key = `${String(table)}:${rowId}`;
      const existing = store.get(key);
      if (existing) {
        for (const op of ops) {
          if (op.op === 'replace') {
            existing.data[op.path] = op.value;
          }
        }
      }
      return existing ?? { rowId, data: { id: rowId } };
    },
  };

  return { da, createCalls, patchCalls, getCalls, store };
}

const FIXED_NOW = new Date('2026-06-07T10:00:00.000Z');
const FIXED_SUFFIX = 'abc12345';

const BASE_ITEM: NewInboxItem = {
  kind: 'approval',
  runId: 'run-1',
  taskId: 'task-1',
  stepId: 'step-1',
  title: 'Approve deployment',
  context: { env: 'prod', version: '1.2.3' },
};

// ─── pushInbox ───────────────────────────────────────────────

test('pushInbox inserts inbox row with correct id and shape', async () => {
  const { da, createCalls } = makeFakeDa();
  const id = await pushInbox(da, BASE_ITEM, { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.equal(id, `inbox_20260607T100000000Z_${FIXED_SUFFIX}`);
  assert.equal(createCalls.length, 1);
  const row = createCalls[0];
  assert.ok(row);
  assert.equal(row.table, 'inbox');
  assert.equal(row.rowId, id);
  assert.equal(row.data.status, 'pending');
  assert.equal(row.data.kind, 'approval');
  assert.equal(row.data.title, 'Approve deployment');
  assert.equal(row.data.run_id, 'run-1');
  assert.equal(row.data.created_at, '2026-06-07T10:00:00.000Z');
});

test('pushInbox seeds answer:null, resolved_by:"", resolved_at:"" (G10)', async () => {
  const { da, createCalls } = makeFakeDa();
  await pushInbox(da, BASE_ITEM, { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });
  const row = createCalls[0];
  assert.ok(row);
  // answer must be present (null), not undefined/absent, so later `replace` patches succeed.
  assert.ok('answer' in row.data, 'answer field must be present in the row data');
  assert.equal(row.data.answer, null);
  assert.equal(row.data.resolved_by, '');
  assert.equal(row.data.resolved_at, '');
});

test('pushInbox writes no step row (no originating-step park — audit §3.1)', async () => {
  const { da, patchCalls } = makeFakeDa();
  await pushInbox(da, BASE_ITEM, { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });
  assert.equal(patchCalls.length, 0, 'pushInbox must not patch any step row');
});

test('pushInbox redacts secret-shaped context keys before write (edge 15)', async () => {
  const item: NewInboxItem = {
    ...BASE_ITEM,
    context: { env: 'prod', token: 'abc123', api_key: 'secret', version: '1.0' },
  };
  const { da, createCalls } = makeFakeDa();
  await pushInbox(da, item, { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });
  const stored = createCalls[0]?.data.context as Record<string, unknown>;
  assert.ok(stored);
  assert.equal(stored.token, '[REDACTED]');
  assert.equal(stored.api_key, '[REDACTED]');
  assert.equal(stored.env, 'prod');
  assert.equal(stored.version, '1.0');
});

// ─── listInbox / getInbox ────────────────────────────────────

test('listInbox returns mapped items', async () => {
  const { da } = makeFakeDa([
    {
      table: 'inbox',
      rowId: 'inbox-1',
      data: {
        id: 'inbox-1', kind: 'approval', status: 'pending',
        title: 'T', run_id: '', task_id: '', step_id: '',
        project_id: '', context: null, answer: null,
        resolved_by: '', resolved_at: '', created_at: '',
        options: [],
      },
    },
  ]);
  const items = await listInbox(da);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'inbox-1');
  assert.equal(items[0]?.status, 'pending');
});

test('getInbox returns item when found and null when missing', async () => {
  const { da } = makeFakeDa([
    {
      table: 'inbox',
      rowId: 'inbox-1',
      data: {
        id: 'inbox-1', kind: 'question', status: 'pending',
        title: 'Q', run_id: '', task_id: '', step_id: '',
        project_id: '', context: null, answer: null,
        resolved_by: '', resolved_at: '', created_at: '',
        options: [],
      },
    },
  ]);
  const found = await getInbox(da, 'inbox-1');
  assert.ok(found);
  assert.equal(found.id, 'inbox-1');

  const missing = await getInbox(da, 'nope');
  assert.equal(missing, null);
});

// ─── resolveInbox — happy path ───────────────────────────────

function makePendingInbox(inboxId = 'inbox-1', stepId = 'step-1') {
  return makeFakeDa([
    {
      table: 'inbox',
      rowId: inboxId,
      data: {
        id: inboxId, kind: 'approval', status: 'pending',
        title: 'T', run_id: 'run-1', task_id: 'task-1', step_id: stepId,
        project_id: '', context: null, answer: null,
        resolved_by: '', resolved_at: '', created_at: '2026-06-07T10:00:00.000Z',
        options: [],
      },
    },
  ]);
}

test('resolveInbox happy-path: flips inbox to resolved', async () => {
  const { da, patchCalls } = makePendingInbox();
  await resolveInbox(da, 'inbox-1', 'approve', 'alice', { now: FIXED_NOW });

  const inboxPatches = patchCalls.filter((p) => p.table === 'inbox');

  assert.equal(inboxPatches.length, 1);
  const ip = inboxPatches[0];
  assert.ok(ip?.ops.some((o) => o.op === 'replace' && o.path === 'status' && o.value === 'resolved'));
  assert.ok(ip?.ops.some((o) => o.op === 'replace' && o.path === 'answer' && o.value === 'approve'));
  assert.ok(ip?.ops.some((o) => o.op === 'replace' && o.path === 'resolved_by' && o.value === 'alice'));
  assert.ok(ip?.ops.some((o) => o.op === 'replace' && o.path === 'resolved_at' && o.value === '2026-06-07T10:00:00.000Z'));

  // No step row is touched — the originating-step unblock was retired (audit §3.1).
  assert.equal(patchCalls.filter((p) => p.table === 'steps').length, 0);
});

test('resolveInbox bare patch paths (G6): no JSON-Pointer slashes', async () => {
  const { da, patchCalls } = makePendingInbox();
  await resolveInbox(da, 'inbox-1', 'yes', 'bob');
  for (const pc of patchCalls) {
    for (const op of pc.ops) {
      assert.ok(!op.path.startsWith('/'), `path must be bare (no leading /): got ${op.path}`);
    }
  }
});

test('resolveInbox unknown itemId throws ROW_NOT_FOUND (edge 13)', async () => {
  const { da } = makeFakeDa();
  await assert.rejects(
    () => resolveInbox(da, 'nope', null, 'alice'),
    (err: unknown) =>
      err instanceof ControlPlaneError && err.code === 'ROW_NOT_FOUND' &&
      err.message.includes('inbox item not found: nope'),
  );
});

// ─── resolveInbox — G9 idempotency ───────────────────────────

test('G9 double-resolve: inbox patched exactly once, no second patch', async () => {
  const { da, patchCalls } = makePendingInbox();

  // First resolve — patches inbox.
  await resolveInbox(da, 'inbox-1', 'approve', 'alice', { now: FIXED_NOW });
  const afterFirst = patchCalls.length;

  // Second resolve — inbox is already `resolved`; should NOT re-patch inbox.
  await resolveInbox(da, 'inbox-1', 'approve', 'alice', { now: FIXED_NOW });

  const inboxPatchesTotal = patchCalls.filter((p) => p.table === 'inbox').length;
  assert.equal(inboxPatchesTotal, 1, 'inbox must only be patched once (no second patch on double-resolve)');

  assert.ok(patchCalls.length === afterFirst, 'second resolve must emit no new patches');
});

test('G9 double-resolve: already-resolved inbox is a clean no-op (no duplicate patch)', async () => {
  // inbox already resolved — double-resolve scenario where the resolve is done.
  const inboxId = 'inbox-done';
  const { da, patchCalls } = makeFakeDa([
    {
      table: 'inbox',
      rowId: inboxId,
      data: {
        id: inboxId, kind: 'approval', status: 'resolved',
        title: 'T', run_id: '', task_id: '', step_id: '',
        project_id: '', context: null, answer: 'yes',
        resolved_by: 'alice', resolved_at: '2026-06-07T10:00:00.000Z',
        created_at: '', options: [],
      },
    },
  ]);

  await resolveInbox(da, inboxId, 'yes', 'alice', { now: FIXED_NOW });

  assert.equal(patchCalls.length, 0, 'no patches when the inbox is already resolved');
});

// ─── resolveInbox — G5 state guards ──────────────────────────

test('G5 illegal transition: non-pending/non-resolved status throws VALIDATION_FAILURE (edge 18)', async () => {
  const { da } = makeFakeDa([
    {
      table: 'inbox',
      rowId: 'inbox-bad',
      data: {
        id: 'inbox-bad', kind: 'approval', status: 'corrupted',
        title: 'T', run_id: '', task_id: '', step_id: '',
        project_id: '', context: null, answer: null,
        resolved_by: '', resolved_at: '', created_at: '', options: [],
      },
    },
  ]);
  await assert.rejects(
    () => resolveInbox(da, 'inbox-bad', null, 'alice'),
    (err: unknown) =>
      err instanceof ControlPlaneError && err.code === 'VALIDATION_FAILURE',
  );
});

test('G5 resolveInbox resolves inbox without touching any step row', async () => {
  const { da, patchCalls } = makeFakeDa([
    {
      table: 'inbox',
      rowId: 'inbox-alert',
      data: {
        id: 'inbox-alert', kind: 'alert', status: 'pending',
        title: 'Alert', run_id: '', task_id: '', step_id: '',
        project_id: '', context: null, answer: null,
        resolved_by: '', resolved_at: '', created_at: '', options: [],
      },
    },
  ]);
  await resolveInbox(da, 'inbox-alert', null, 'alice');
  assert.equal(patchCalls.filter((p) => p.table === 'steps').length, 0);
  assert.equal(patchCalls.filter((p) => p.table === 'inbox').length, 1);
});

// ─── redactSecrets (C3: recursive redaction) ─────────────────

test('redactSecrets: top-level secret keys are redacted', () => {
  const result = redactSecrets({ env: 'prod', token: 'abc123', version: '1.0' }) as Record<string, unknown>;
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.env, 'prod');
  assert.equal(result.version, '1.0');
});

test('redactSecrets: nested object secret keys are redacted at any depth', () => {
  const input = { deploy: { token: 'x', region: 'us-east-1' } };
  const result = redactSecrets(input) as Record<string, Record<string, unknown>>;
  assert.equal(result.deploy?.token, '[REDACTED]');
  assert.equal(result.deploy?.region, 'us-east-1');
});

test('redactSecrets: array of objects — each element is recursed', () => {
  const input = [{ password: 'x', name: 'alice' }, { password: 'y', name: 'bob' }];
  const result = redactSecrets(input) as Array<Record<string, unknown>>;
  assert.equal(result[0]?.password, '[REDACTED]');
  assert.equal(result[0]?.name, 'alice');
  assert.equal(result[1]?.password, '[REDACTED]');
  assert.equal(result[1]?.name, 'bob');
});

test('redactSecrets: mixed primitives and nested — primitives survive, secrets redacted', () => {
  const input = {
    title: 'Deploy',
    count: 42,
    config: { api_key: 'secret', timeout: 30 },
    tags: ['a', 'b'],
  };
  const result = redactSecrets(input) as Record<string, unknown>;
  assert.equal(result.title, 'Deploy');
  assert.equal(result.count, 42);
  assert.deepEqual(result.tags, ['a', 'b']);
  const config = result.config as Record<string, unknown>;
  assert.equal(config.api_key, '[REDACTED]');
  assert.equal(config.timeout, 30);
});

test('redactSecrets: non-secret fields survive intact', () => {
  const input = { env: 'staging', region: 'eu-west-1', version: '2.0' };
  const result = redactSecrets(input);
  assert.deepEqual(result, input);
});

test('redactSecrets: null input is returned as-is', () => {
  assert.equal(redactSecrets(null), null);
});

test('redactSecrets: primitive input is returned as-is', () => {
  assert.equal(redactSecrets('hello'), 'hello');
  assert.equal(redactSecrets(42), 42);
});

// ─── Invariant #4: inbox.ts must not import @dbos-inc/* ──────

test('inbox.ts imports no @dbos-inc/* (edge 16)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, 'inbox.ts'), 'utf8');
  assert.ok(
    !src.includes('@dbos-inc'),
    'inbox.ts must not import from @dbos-inc/* (DBOS coupling deferred to 0004)',
  );
});

// ─── 0004 G1: pushInbox opts.id (deterministic id, ROW_CONFLICT no-op) ───────

// A8 (G1): pushInbox with opts.id uses id verbatim; ROW_CONFLICT is swallowed and same id returned.
test('A8 (G1): pushInbox uses opts.id verbatim when provided (deterministic gate path)', async () => {
  const { da, createCalls } = makeFakeDa();
  const deterministicId = 'inbox_deadbeefdeadbeef';
  const id = await pushInbox(da, { kind: 'approval', title: 'Gate', context: { topic: 'plan' } }, {
    id: deterministicId,
  });

  assert.equal(id, deterministicId, 'returned id must match the supplied opts.id');
  assert.equal(createCalls.length, 1, 'one createRow call expected');
  assert.equal(createCalls[0]?.rowId, deterministicId, 'createRow rowId must be the deterministic id');
});

test('A8 (G1): pushInbox with opts.id swallows ROW_CONFLICT and returns same id (replay no-op)', async () => {
  // Simulate a store where the row ALREADY exists (ROW_CONFLICT scenario).
  const conflictStore = new Map<string, unknown>();
  const conflictId = 'inbox_1234567890abcdef';

  let createCallCount = 0;
  const da = {
    async assertReady() {},
    async listRows() { return []; },
    async getRow() { return null; },
    async createRow(_table: string, rowId: string) {
      createCallCount++;
      if (conflictStore.has(rowId)) {
        throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      }
      conflictStore.set(rowId, true);
      return { rowId, data: {} };
    },
    async updateRow(_t: string, rowId: string) { return { rowId, data: {} }; },
    async patchRow(_t: string, rowId: string) { return { rowId, data: {} }; },
  };

  // First call — succeeds, stores the row.
  const id1 = await pushInbox(da as never, { kind: 'approval', title: 'Gate', context: {} }, { id: conflictId });
  assert.equal(id1, conflictId, 'first call returns the id');
  assert.equal(createCallCount, 1, 'first call creates the row');

  // Second call (replay) — ROW_CONFLICT swallowed, same id returned, no throw.
  let threw = false;
  let id2: string | undefined;
  try {
    id2 = await pushInbox(da as never, { kind: 'approval', title: 'Gate', context: {} }, { id: conflictId });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'ROW_CONFLICT must NOT propagate (replay no-op)');
  assert.equal(id2, conflictId, 'second call returns the same id');
  assert.equal(createCallCount, 2, 'createRow was attempted again (ROW_CONFLICT caught)');
});

// ─── 0004 G2: resolveInbox returns stored decision ───────────────────────────

// A9 (G2 + C2): resolveInbox on pending row returns the STORED (re-read) answer on first resolve.
// C2 fix: after patching, the function re-reads the inbox row and returns stored.data.answer —
// not the raw caller argument — so concurrent/round-tripped values converge to what is recorded.
test('A9 (G2+C2): resolveInbox on pending row returns stored (re-read) answer on first resolve', async () => {
  const { da } = makePendingInbox();

  const result = await resolveInbox(da, 'inbox-1', 'approve', 'alice', { now: FIXED_NOW });

  // status is the BEFORE-this-call status: 'pending' (just resolved).
  assert.equal(result.status, 'pending', 'status before call must be pending');
  // C2: answer is the STORED (re-read from the patched row) value, not merely the caller arg.
  // The fake patchRow applies the patch to the in-memory store, so the re-read returns 'approve'.
  assert.equal(result.answer, 'approve', 'returned answer must equal the stored/re-read value (C2)');
});

test('A9 (G2): resolveInbox on already-resolved row returns stored answer (not caller arg)', async () => {
  const inboxId = 'inbox-g2';
  const storedAnswer = { decision: 'approve' };

  const { da } = makeFakeDa([
    {
      table: 'inbox',
      rowId: inboxId,
      data: {
        id: inboxId, kind: 'approval', status: 'resolved',
        title: 'T', run_id: 'run-g2', task_id: '', step_id: '',
        project_id: '', context: null,
        answer: storedAnswer,
        resolved_by: 'alice', resolved_at: '2026-06-07T10:00:00.000Z',
        created_at: '2026-06-07T09:00:00.000Z', options: [],
      },
    },
  ]);

  // Second call with a DIFFERENT answer (crash-after-resolve retry scenario).
  const result = await resolveInbox(da, inboxId, { decision: 'reject' }, 'bob', { now: FIXED_NOW });

  // status is 'resolved' (was already resolved before this call).
  assert.equal(result.status, 'resolved', 'status must be resolved (was already)');
  // answer is the STORED value, NOT the caller's argument.
  assert.deepEqual(result.answer, storedAnswer, 'stored answer must win over caller arg (G2)');
});
