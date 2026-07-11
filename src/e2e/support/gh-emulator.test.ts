import test from 'node:test';
import assert from 'node:assert/strict';
import { CasePlanRegistry } from './case-plan.js';
import { createGhEmulator, plannedGhEmulator, type GhScenario } from './gh-emulator.js';

function createExternalTerminalPr(scenario: GhScenario): ReturnType<typeof createGhEmulator> {
  const gh = createGhEmulator([], scenario);
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);
  return gh;
}

function readinessView(gh: ReturnType<typeof createGhEmulator>): { isDraft: boolean } {
  return JSON.parse(gh(['pr', 'view', 'feat/t-1', '--repo', 'e2e/repo', '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable,closingIssuesReferences'])) as { isDraft: boolean };
}

function reviewThreadIds(gh: ReturnType<typeof createGhEmulator>): string[] {
  const response = JSON.parse(gh([
    'api',
    'graphql',
    '-f',
    'query=query { repository { pullRequest { reviewThreads { nodes { id } } } } }',
  ])) as { data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string }> } } } } };
  return response.data.repository.pullRequest.reviewThreads.nodes.map((node) => node.id);
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

test('gh emulator: planned ready-fails scenario matches task branch on pr ready', () => {
  const calls: string[][] = [];
  const taskId = 'task_20260709T135000204Z_e2e-integrator-failur_30f1a98c';
  const plans = new CasePlanRegistry();
  plans.register(taskId, { title: 'E2E integrator-failure feature run', gh: 'ready-fails' });
  const gh = plannedGhEmulator(plans, calls);
  const branch = 'feat/30f1a98c-e2e-integrator-failure-feature-run';

  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', branch, '--title', 't', '--body', '']);
  assert.throws(
    () => gh(['pr', 'ready', branch, '--repo', 'e2e/repo']),
    /permission denied/,
  );
});

test('gh emulator: advisory thread appears only after explicit per-case gate control', () => {
  const calls: string[][] = [];
  const taskId = 'task_20260709T135000204Z_e2e-override-advisory_30f1a98c';
  const plans = new CasePlanRegistry();
  plans.register(taskId, { title: 'E2E override advisory thread', gh: 'force-advisory-thread' });
  const gh = plannedGhEmulator(plans, calls);
  const branch = 'feat/30f1a98c-e2e-override-advisory-thread';

  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', branch, '--title', 't', '--body', '']);
  gh(['pr', 'ready', branch, '--repo', 'e2e/repo']);
  gh(['pr', 'ready', branch, '--repo', 'e2e/repo']);
  gh(['pr', 'ready', branch, '--repo', 'e2e/repo']);
  assert.deepEqual(reviewThreadIds(gh), [], 'readiness polling must not reveal the advisory thread');

  plans.showAdvisoryThread(taskId);
  assert.deepEqual(reviewThreadIds(gh), ['PRRT_T1']);

  gh([
    'api',
    'graphql',
    '-f',
    'query=mutation { resolveReviewThread(input: {}) { thread { id } } }',
    '-f',
    'id=PRRT_T1',
  ]);
  assert.deepEqual(reviewThreadIds(gh), [], 'resolved advisory thread must not be re-seeded');
});
