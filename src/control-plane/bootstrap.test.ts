import test from 'node:test';
import assert from 'node:assert/strict';
import { listInstalledPlaybooksFromTransport } from './bootstrap.js';
import type { ControlPlaneTransport } from './transport.js';

test('listInstalledPlaybooksFromTransport: maps the head playbooks-table rows to id + version + catalogHash', async () => {
  const transport = {
    mode: 'head',
    assertReady: async () => undefined,
    listRows: async () => ({
      edges: [
        { node: { id: 'revisium-default', data: { version: '0.1.1', catalog_hash: 'abc123' } } },
        { node: { id: 'feature-x', data: { version: '1.0.0' } } },
        { node: { id: 'legacy' } },
      ],
    }),
    getRow: async () => {
      throw new Error('unused');
    },
    createRow: async () => {
      throw new Error('unused');
    },
    updateRow: async () => {
      throw new Error('unused');
    },
    patchRow: async () => {
      throw new Error('unused');
    },
  } satisfies ControlPlaneTransport;

  assert.deepEqual(await listInstalledPlaybooksFromTransport(transport), [
    { id: 'revisium-default', version: '0.1.1', catalogHash: 'abc123' },
    { id: 'feature-x', version: '1.0.0', catalogHash: undefined },
    { id: 'legacy', version: undefined, catalogHash: undefined },
  ]);
});
