/**
 * Unit tests for the in-process control-plane bootstrap (ADR 0006). A fake `RevisiumClient` drives
 * the two paths — fresh (create project + REST endpoint + tables + rows, then commit) and already-
 * bootstrapped (existence checks only, no writes) — plus the `listInstalledPlaybooks` head read.
 * Exercising bootstrapControlPlane also covers applyAdditiveSchemaMigration's create/patch branches.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import type { RevisiumClient } from '@revisium/client';

process.env['REVO_DATA_DIR'] = mkdtempSync(join(os.tmpdir(), 'revo-bootstrap-'));
delete process.env['REVO_PROFILE'];

// Static import is safe: getConfig() is lazy, and bootstrapConfigPath() uses repoRoot (no getConfig).
import { bootstrapControlPlane, bootstrapConfigPath, listInstalledPlaybooks } from './bootstrap.js';

const TMP = process.env['REVO_DATA_DIR'] as string;
after(() => rmSync(TMP, { recursive: true, force: true }));

type Config = { tables: { id: string; schema: object }[]; rows?: { tableId: string; rowId: string }[] };
const cfg = JSON.parse(readFileSync(bootstrapConfigPath(), 'utf8')) as Config;
const schemaById = new Map(cfg.tables.map((t) => [t.id, t.schema]));

type Calls = { createProject: number; createEndpoint: number; createTable: number; updateTable: number; createRow: number; commit: number };

/** A fake RevisiumClient: `fresh` makes every existence read miss; `existing` makes them all hit. */
function fakeClient(mode: 'fresh' | 'existing'): { client: RevisiumClient; calls: Calls } {
  const calls: Calls = { createProject: 0, createEndpoint: 0, createTable: 0, updateTable: 0, createRow: 0, commit: 0 };
  const miss = (): never => {
    throw new Error('not found');
  };
  const draft = {
    getTableSchema: async (id: string) => (mode === 'existing' ? schemaById.get(id) ?? miss() : miss()),
    createTable: async () => {
      calls.createTable += 1;
    },
    updateTable: async () => {
      calls.updateTable += 1;
    },
    getRow: async () => (mode === 'existing' ? {} : miss()),
    createRow: async () => {
      calls.createRow += 1;
    },
    commit: async () => {
      calls.commit += 1;
    },
  };
  const projectScope = {
    get: async () => (mode === 'existing' ? {} : miss()),
    getEndpoints: async () => (mode === 'existing' ? [{ type: 'REST_API' }] : []),
    createEndpoint: async () => {
      calls.createEndpoint += 1;
    },
  };
  const orgScope = {
    project: () => projectScope,
    createProject: async () => {
      calls.createProject += 1;
    },
  };
  const client = { org: () => orgScope, revision: async () => draft } as unknown as RevisiumClient;
  return { client, calls };
}

test('bootstrapControlPlane: fresh control-plane creates project + endpoint + tables + rows, then commits', async () => {
  const { client, calls } = fakeClient('fresh');
  await bootstrapControlPlane(0, client);
  assert.equal(calls.createProject, 1);
  assert.equal(calls.createEndpoint, 1);
  assert.equal(calls.createTable, cfg.tables.length, 'every config table is created');
  assert.equal(calls.createRow, cfg.rows?.length ?? 0, 'every seed row is created');
  assert.equal(calls.commit, 1, 'one commit for the whole bootstrap');
});

test('bootstrapControlPlane: an already-bootstrapped control-plane is a no-op (no writes, no commit)', async () => {
  const { client, calls } = fakeClient('existing');
  await bootstrapControlPlane(0, client);
  assert.deepEqual(calls, { createProject: 0, createEndpoint: 0, createTable: 0, updateTable: 0, createRow: 0, commit: 0 });
});

test('listInstalledPlaybooks: maps the head playbooks-table rows to id + recorded version', async () => {
  const client = {
    revision: async () => ({
      getRows: async () => ({
        edges: [
          { node: { id: 'revisium-default', data: { version: '0.1.1' } } },
          { node: { id: 'feature-x' } }, // no data → version undefined (slice 144 B1 reads it as "older")
        ],
      }),
    }),
  } as unknown as RevisiumClient;
  assert.deepEqual(await listInstalledPlaybooks(0, client), [
    { id: 'revisium-default', version: '0.1.1' },
    { id: 'feature-x', version: undefined },
  ]);
});
