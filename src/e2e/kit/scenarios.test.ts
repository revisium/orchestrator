import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunHarness } from './harness.js';
import {
  DEFAULT_PLAYBOOK_ID,
  PLAYBOOK_ID,
  givenSeededDefaultPlaybook,
  startDefaultFeatureRun,
  startDefaultLocalChangeRun,
} from './scenarios.js';

function fakeHarness(api: Record<string, unknown>): RunHarness {
  return { api } as unknown as RunHarness;
}

test('default playbook run helpers create runs against the shipped default playbook', async () => {
  const createRunCalls: unknown[] = [];
  const h = fakeHarness({
    async createRun(input: unknown) {
      createRunCalls.push(input);
      return { runId: `run-${createRunCalls.length}`, workflow: { engine: 'data-driven' } };
    },
  });

  await startDefaultFeatureRun(h, '/repo');
  await startDefaultLocalChangeRun(h, '/repo');

  assert.deepEqual(createRunCalls, [
    {
      repo: '/repo',
      title: 'E2E seeded default feature-development run',
      description: 'Group M — the bootstrap-seeded default pipeline on real DBOS/embedded engine.',
      scope: 'seeded-default e2e',
      playbookId: DEFAULT_PLAYBOOK_ID,
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
      start: true,
    },
    {
      repo: '/repo',
      title: 'E2E seeded default local-change run',
      description: 'Group M — the bootstrap-seeded local-change pipeline on real DBOS/embedded engine.',
      scope: 'seeded-default e2e',
      playbookId: DEFAULT_PLAYBOOK_ID,
      pipelineId: 'local-change',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
      start: true,
    },
  ]);
});

test('givenSeededDefaultPlaybook installs the shipped default playbook when it is absent', async () => {
  const installCalls: unknown[] = [];
  const h = fakeHarness({
    async listPlaybooks() {
      return [{ id: PLAYBOOK_ID }];
    },
    async installPlaybook(options: unknown) {
      installCalls.push(options);
      return { playbookId: DEFAULT_PLAYBOOK_ID, roles: 12, pipelines: 3 };
    },
  });

  await givenSeededDefaultPlaybook(h);

  assert.equal(installCalls.length, 1);
  const install = installCalls[0] as { source?: unknown; name?: unknown; commit?: unknown };
  const source = install.source;
  if (typeof source !== 'string') assert.fail('install source must be a string');
  assert.ok(source.endsWith('control-plane/default-playbook'));
  assert.deepEqual(install, {
    source,
    name: DEFAULT_PLAYBOOK_ID,
    commit: true,
  });
});
