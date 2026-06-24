import test from 'node:test';
import assert from 'node:assert/strict';
import { DBOS_WORKFLOW_VERSION, dbosExecutorId, dbosEnvPin } from './dbos-identity.js';

test('dbosExecutorId: stable per-profile owner identity', () => {
  assert.equal(dbosExecutorId('default'), 'revo-default');
  assert.equal(dbosExecutorId('dev'), 'revo-dev');
});

test('dbosEnvPin: pins VMID + APPVERSION from the profile when unset', () => {
  const pin = dbosEnvPin('default', {});
  assert.deepEqual(pin, { DBOS__VMID: 'revo-default', DBOS__APPVERSION: DBOS_WORKFLOW_VERSION });
});

test('dbosEnvPin: an explicit env value wins (custom layout / test override)', () => {
  const pin = dbosEnvPin('dev', { DBOS__VMID: 'custom-vmid', DBOS__APPVERSION: '9.9.9' });
  assert.deepEqual(pin, { DBOS__VMID: 'custom-vmid', DBOS__APPVERSION: '9.9.9' });
});

test('dbosEnvPin: pins per profile (dev band)', () => {
  assert.equal(dbosEnvPin('dev', {}).DBOS__VMID, 'revo-dev');
});

test('DBOS_WORKFLOW_VERSION: is a non-empty stable string (decoupled from npm version)', () => {
  assert.equal(typeof DBOS_WORKFLOW_VERSION, 'string');
  assert.ok(DBOS_WORKFLOW_VERSION.length > 0);
});
