import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhEmulator, routedGhEmulator, type GhScenario } from './gh-emulator.js';

function createExternalTerminalPr(scenario: GhScenario): ReturnType<typeof createGhEmulator> {
  const gh = createGhEmulator([], scenario);
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);
  return gh;
}

function readinessView(gh: ReturnType<typeof createGhEmulator>): { isDraft: boolean } {
  return JSON.parse(gh(['pr', 'view', 'feat/t-1', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])) as { isDraft: boolean };
}

test('gh emulator: externally merged PR is absent from open lookup and visible to all-state lookup', () => {
  const gh = createExternalTerminalPr('merged-externally');

  const open = JSON.parse(gh(['pr', 'list', '--repo', 'e2e/repo', '--head', 'feat/t-1', '--state', 'open', '--json', 'number,baseRefName,state'])) as unknown[];
  const all = JSON.parse(gh(['pr', 'list', '--repo', 'e2e/repo', '--head', 'feat/t-1', '--state', 'all', '--json', 'number,baseRefName,state'])) as Array<{ state: string }>;
  const view = JSON.parse(gh(['pr', 'view', 'feat/t-1', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])) as { state: string };

  assert.deepEqual(open, []);
  assert.equal(all[0]?.state, 'MERGED');
  assert.equal(view.state, 'MERGED');
});

test('gh emulator: externally closed PR is absent from open lookup and visible to all-state lookup', () => {
  const gh = createExternalTerminalPr('closed-externally');

  const open = JSON.parse(gh(['pr', 'list', '--repo', 'e2e/repo', '--head', 'feat/t-1', '--state', 'open', '--json', 'number,baseRefName,state'])) as unknown[];
  const all = JSON.parse(gh(['pr', 'list', '--repo', 'e2e/repo', '--head', 'feat/t-1', '--state', 'all', '--json', 'number,baseRefName,state'])) as Array<{ state: string }>;
  const view = JSON.parse(gh(['pr', 'view', 'feat/t-1', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])) as { state: string };

  assert.deepEqual(open, []);
  assert.equal(all[0]?.state, 'CLOSED');
  assert.equal(view.state, 'CLOSED');
});

test('gh emulator: readiness view reports draft until pr ready flips it', () => {
  const gh = createGhEmulator([], 'happy');
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);

  assert.equal(readinessView(gh).isDraft, true);
  gh(['pr', 'ready', 'feat/t-1', '--repo', 'e2e/repo']);
  assert.equal(readinessView(gh).isDraft, false);
});

test('gh emulator: number-based pr view shares draft state with the created branch', () => {
  const gh = createGhEmulator([], 'happy');
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);

  assert.equal(JSON.parse(gh(['pr', 'view', '7', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])).isDraft, true);
  gh(['pr', 'ready', 'feat/t-1', '--repo', 'e2e/repo']);
  assert.equal(JSON.parse(gh(['pr', 'view', '7', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])).isDraft, false);
});

test('gh emulator: ready-fails scenario throws on pr ready and keeps PR draft', () => {
  const gh = createGhEmulator([], 'ready-fails');
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);

  assert.throws(
    () => gh(['pr', 'ready', 'feat/t-1', '--repo', 'e2e/repo']),
    /permission denied/,
  );
  assert.equal(readinessView(gh).isDraft, true);
});

test('gh emulator: routed ready-fails scenario matches task branch on pr ready', () => {
  const calls: string[][] = [];
  const taskId = 'task_20260709T135000204Z_e2e-integrator-failur_30f1a98c';
  const gh = routedGhEmulator(new Map([[
    'run_1',
    {
      runId: 'run_1',
      taskId,
      title: 'E2E integrator-failure feature run',
      gh: 'ready-fails',
    },
  ]]), calls);
  const branch = 'feat/30f1a98c-e2e-integrator-failure-feature-run';

  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', branch, '--title', 't', '--body', '']);
  assert.throws(
    () => gh(['pr', 'ready', branch, '--repo', 'e2e/repo']),
    /permission denied/,
  );
});
