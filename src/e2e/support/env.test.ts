import test from 'node:test';
import assert from 'node:assert/strict';
import { dbosDbNameForFile } from './env.js';

test('dbosDbNameForFile derives a valid per-file SQL identifier', () => {
  assert.equal(
    dbosDbNameForFile('/repo/src/e2e/pipeline/agent-failures.e2e.test.ts'),
    'dbos_e2e_pipeline_agent_failures',
  );
  assert.equal(
    dbosDbNameForFile('/repo/src/e2e/surfaces/mcp/stdio.e2e.test.ts'),
    'dbos_e2e_surfaces_mcp_stdio',
  );
  assert.notEqual(
    dbosDbNameForFile('/repo/src/e2e/surfaces/cli/lifecycle.e2e.test.ts'),
    dbosDbNameForFile('/repo/src/e2e/runtime/lifecycle/lifecycle.e2e.test.ts'),
  );
  assert.equal(dbosDbNameForFile('/repo/scripts/e2e-setup.ts'), 'dbos_e2e_e2e_setup');
});

test('dbosDbNameForFile output always matches the REVO_DBOS_DB identifier rule', () => {
  for (const p of ['/a/b/seed-default-playbook.e2e.test.ts', 'weird name!.ts', 'x.mts']) {
    assert.match(dbosDbNameForFile(p), /^[a-z_][a-z0-9_]*$/i);
  }
});
