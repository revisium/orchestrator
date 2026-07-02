import test from 'node:test';
import assert from 'node:assert/strict';
import { dbosDbNameForFile } from './env.js';

test('dbosDbNameForFile derives a valid per-file SQL identifier', () => {
  assert.equal(dbosDbNameForFile('/repo/src/e2e/agent-failures.e2e.test.ts'), 'dbos_e2e_agent_failures');
  assert.equal(dbosDbNameForFile('/repo/src/e2e/mcp.e2e.test.ts'), 'dbos_e2e_mcp');
  assert.equal(dbosDbNameForFile('/repo/scripts/e2e-setup.ts'), 'dbos_e2e_e2e_setup');
});

test('dbosDbNameForFile output always matches the REVO_DBOS_DB identifier rule', () => {
  for (const p of ['/a/b/seed-default-playbook.e2e.test.ts', 'weird name!.ts', 'x.mts']) {
    assert.match(dbosDbNameForFile(p), /^[a-z_][a-z0-9_]*$/i);
  }
});
