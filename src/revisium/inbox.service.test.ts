import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../control-plane/errors.js';
import { createInMemoryRuntimeDataAccess } from '../testing/runtime-data-access.js';
import { InboxService } from './inbox.service.js';

const INBOX_ROW_DATA: Record<string, unknown> = {
  id: 'inbox-1', kind: 'approval', status: 'pending',
  title: 'T', run_id: '', task_id: '', step_id: '',
  project_id: '', context: null, answer: null,
  resolved_by: '', resolved_at: '', created_at: '2026-06-07T10:00:00.000Z',
  options: [],
};

test('InboxService constructor wires runtime data access', () => {
  const { access } = createInMemoryRuntimeDataAccess();
  assert.doesNotThrow(() => new InboxService(access));
});

test('InboxService uses injected runtime data access', () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new InboxService(access);
  assert.ok(svc instanceof InboxService);
});

test('InboxService.pushInbox delegates to pushInbox verb and returns id', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new InboxService(access);
  const id = await svc.pushInbox({
    kind: 'approval',
    title: 'Approve this',
    context: { env: 'staging' },
  });
  assert.ok(typeof id === 'string');
  assert.ok(id.startsWith('inbox_'));
});

test('InboxService.listInbox delegates to listInbox verb', async () => {
  const { access } = createInMemoryRuntimeDataAccess({
    inbox: {
      'inbox-1': INBOX_ROW_DATA,
    },
  });
  const svc = new InboxService(access);
  const items = await svc.listInbox();
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'inbox-1');
});

test('InboxService.getInbox returns item when found, null when missing', async () => {
  const { access } = createInMemoryRuntimeDataAccess({
    inbox: {
      'inbox-1': INBOX_ROW_DATA,
    },
  });
  const svc = new InboxService(access);

  const found = await svc.getInbox('inbox-1');
  assert.ok(found !== null);
  assert.equal(found.id, 'inbox-1');

  const missing = await svc.getInbox('nope');
  assert.equal(missing, null);
});

test('InboxService.resolveInbox delegates to resolveInbox verb (pure, no DBOS)', async () => {
  const inboxId = 'inbox-r';
  const { access } = createInMemoryRuntimeDataAccess({
    inbox: {
      [inboxId]: {
        ...INBOX_ROW_DATA,
        id: inboxId,
        status: 'pending',
      },
    },
  });
  const svc = new InboxService(access);

  await assert.doesNotReject(() => svc.resolveInbox(inboxId, 'approve', 'alice'));
});

test('InboxService.resolveInbox propagates ROW_NOT_FOUND for unknown id', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new InboxService(access);
  await assert.rejects(
    () => svc.resolveInbox('nope', null, 'alice'),
    (err: unknown) => err instanceof ControlPlaneError && err.code === 'ROW_NOT_FOUND',
  );
});

test('InboxService.pushInbox with opts.id forwards id to the pure verb (deterministic gate path)', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new InboxService(access);
  const deterministicId = 'inbox_cafebabecafebabe';
  const id = await svc.pushInbox(
    { kind: 'approval', title: 'Gate', context: { topic: 'plan' } },
    { id: deterministicId },
  );
  assert.equal(id, deterministicId, 'service must return the supplied deterministic id verbatim');
});

test('InboxService.pushInbox without opts.id uses timestamp+suffix (0002 back-compat)', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new InboxService(access);
  const id = await svc.pushInbox({ kind: 'approval', title: 'Gate', context: {} });
  assert.ok(typeof id === 'string', 'id must be a string');
  assert.ok(id.startsWith('inbox_'), 'id must start with inbox_');
  assert.notEqual(id, 'inbox_cafebabecafebabe');
});

test('InboxService.resolveInbox returns { status, answer } (G2 forward)', async () => {
  const inboxId = 'inbox-rt';
  const { access } = createInMemoryRuntimeDataAccess({
    inbox: {
      [inboxId]: { ...INBOX_ROW_DATA, id: inboxId, status: 'pending' },
    },
  });
  const svc = new InboxService(access);

  const result = await svc.resolveInbox(inboxId, 'approve', 'alice');

  assert.ok(typeof result === 'object' && result !== null, 'must return an object');
  assert.ok('status' in result, 'must have status');
  assert.ok('answer' in result, 'must have answer');
  assert.equal(result.status, 'pending', 'status before call must be pending');
});
