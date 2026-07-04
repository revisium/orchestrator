import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhEmulator, type GhScenario } from './gh-emulator.js';

function createExternalTerminalPr(scenario: GhScenario): ReturnType<typeof createGhEmulator> {
  const gh = createGhEmulator([], scenario);
  gh(['pr', 'create', '--repo', 'e2e/repo', '--draft', '--base', 'master', '--head', 'feat/t-1', '--title', 't', '--body', '']);
  return gh;
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
