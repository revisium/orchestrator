import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeTemplate, hashTemplate } from './materialize.js';
import { validateTemplate } from './validate.js';
import { reduceJoinVerdict, selectJoinWinner } from './interpret.js';
import type { Template, JoinNode, JoinArrival } from './types.js';
import type { TopologyProfile } from './materialize.js';

function makeBase(): Template {
  return {
    specVersion: '1.0',
    pipelineId: 'synthetic',
    entry: 'analyst',
    verdicts: { domain: ['approved', 'clean', 'changes_requested'] },
    nodes: {
      analyst: {
        id: 'analyst',
        kind: 'agent',
        roleRef: 'role:analyst',
        next: 'planReviewer',
        produces: { name: 'plan' },
        consumes: [
          { node: 'analyst', as: 'priorPlan', optional: true, staleOk: true },
          { node: 'planReviewer', as: 'planReview', optional: true, staleOk: true },
        ],
      },
      planReviewer: {
        id: 'planReviewer',
        kind: 'agent',
        roleRef: 'role:reviewer',
        next: 'developer',
        resultSchema: 'schema:reviewVerdict',
        produces: { name: 'planReview' },
        consumes: [{ node: 'analyst', as: 'plan' }],
      },
      developer: {
        id: 'developer',
        kind: 'agent',
        roleRef: 'role:developer',
        next: 'codeReview',
        produces: { name: 'change' },
        consumes: [{ node: 'planReviewer', as: 'approvedPlan', optional: true, staleOk: true }],
      },
      codeReview: {
        id: 'codeReview',
        kind: 'agent',
        roleRef: 'role:reviewer',
        next: 'done',
        resultSchema: 'schema:reviewVerdict',
        produces: { name: 'review' },
        consumes: [{ node: 'developer', as: 'change' }],
      },
      done: {
        id: 'done',
        kind: 'terminal',
        status: 'succeeded',
      },
    },
  };
}

function makePlanReviewerToggle(): TopologyProfile['toggles'][number] {
  return {
    target: 'planReviewer',
    baseName: 'planReview',
    fanout: { branches: 2 },
  };
}

function makeCodeReviewToggle(): TopologyProfile['toggles'][number] {
  return {
    target: 'codeReview',
    baseName: 'codeReview',
    fanout: { branches: 2 },
  };
}

function makeAnalystToggle(): TopologyProfile['toggles'][number] {
  return {
    target: 'analyst',
    fanout: { branches: 2 },
  };
}

function makeAnalystBase(): Template {
  return {
    specVersion: '1.0',
    pipelineId: 'analysis-only',
    entry: 'analyst',
    verdicts: { domain: ['approved'] },
    nodes: {
      analyst: {
        id: 'analyst',
        kind: 'agent',
        roleRef: 'role:analyst',
        next: 'done',
        resultSchema: 'schema:analysis',
        produces: { name: 'analysis' },
      },
      done: { id: 'done', kind: 'terminal', status: 'succeeded' },
    },
  };
}

function makeConsensusProfile(): TopologyProfile {
  return {
    profileId: 'review-consensus',
    pipelineId: 'synthetic',
    toggles: [makePlanReviewerToggle(), makeCodeReviewToggle()],
  };
}

function assertNoErrors(template: Template): void {
  const diags = validateTemplate(template);
  const errors = diags.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors,
    [],
    `expected 0 validateTemplate errors; got: ${errors.map((d) => `${d.code}(${d.nodeId ?? ''})`).join(', ')}`,
  );
}

function emittedJoin(template: Template, joinId: string): JoinNode {
  const node = template.nodes[joinId];
  assert.ok(node, `join node "${joinId}" missing from materialized template`);
  assert.equal(node.kind, 'join');
  return node as JoinNode;
}

function arrivals(...pairs: Array<[string, string]>): JoinArrival[] {
  return pairs.map(([branchId, verdict], i) => ({ branchId, seq: i, verdict }));
}

// ─── default = identity ───────────────────────────────────────────────────────

test('materialize: default profile (no toggles) deep-equals base', () => {
  const base = makeBase();
  const profile: TopologyProfile = { profileId: 'default', pipelineId: 'synthetic', toggles: [] };
  const { template } = materializeTemplate(base, profile);
  assert.deepEqual(template, base);
});

test('materialize: default profile hash is stable across two calls', () => {
  const profile: TopologyProfile = { profileId: 'default', pipelineId: 'synthetic', toggles: [] };
  const r1 = materializeTemplate(makeBase(), profile);
  const r2 = materializeTemplate(makeBase(), profile);
  assert.equal(r1.materializedTemplateHash, r2.materializedTemplateHash);
});

// ─── determinism / hash ───────────────────────────────────────────────────────

test('materialize: same (base, profile) yields byte-identical template and hash', () => {
  const profile = makeConsensusProfile();
  const r1 = materializeTemplate(makeBase(), profile);
  const r2 = materializeTemplate(makeBase(), profile);
  assert.deepEqual(r1.template, r2.template);
  assert.equal(r1.materializedTemplateHash, r2.materializedTemplateHash);
});

test('materialize: hash changes when topology changes', () => {
  const base = makeBase();
  const profile = makeConsensusProfile();
  const { materializedTemplateHash: h1 } = materializeTemplate(base, profile);
  const { materializedTemplateHash: h2 } = materializeTemplate(base, { profileId: 'default', pipelineId: 'synthetic', toggles: [] });
  assert.notEqual(h1, h2);
});

// ─── hash binding-independence ────────────────────────────────────────────────

test('materialize: hashTemplate has no binding parameter — hash is (base, topology-profile) only', () => {
  const base = makeBase();
  const h1 = hashTemplate(base);
  const h2 = hashTemplate(structuredClone(base));
  assert.equal(h1, h2, 'hashTemplate is deterministic; binding is not an input');
});

// ─── unknown profile key (schema-closed) ──────────────────────────────────────

test('materialize: unknown top-level profile key → MATERIALIZE_UNKNOWN_PROFILE_KEY', () => {
  const profile = { profileId: 'test', pipelineId: 'synthetic', toggles: [], extraField: 'oops' } as unknown as TopologyProfile;
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes('MATERIALIZE_UNKNOWN_PROFILE_KEY'), `expected MATERIALIZE_UNKNOWN_PROFILE_KEY; got: ${codes.join(', ')}`);
});

test('materialize: unknown toggle key → MATERIALIZE_UNKNOWN_PROFILE_KEY', () => {
  const toggle = { ...makePlanReviewerToggle(), unknownKey: 'bad' } as unknown as TopologyProfile['toggles'][number];
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [toggle] };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes('MATERIALIZE_UNKNOWN_PROFILE_KEY'), `expected MATERIALIZE_UNKNOWN_PROFILE_KEY; got: ${codes.join(', ')}`);
});

// ─── unknown profile ──────────────────────────────────────────────────────────

test('materialize: profile pipelineId mismatch → MATERIALIZE_UNKNOWN_PROFILE', () => {
  const profile: TopologyProfile = { profileId: 'review-consensus', pipelineId: 'other-pipeline', toggles: [] };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes('MATERIALIZE_UNKNOWN_PROFILE'), `expected MATERIALIZE_UNKNOWN_PROFILE; got: ${codes.join(', ')}`);
});

// ─── semantic capability enforcement ─────────────────────────────────────────

test('materialize: unsupported agent semantics are rejected by pipeline-declared capability', () => {
  const toggle = { ...makePlanReviewerToggle(), target: 'developer' };
  const base = makeBase();
  base.nodes.developer = {
    ...base.nodes.developer,
    resultSchema: 'schema:change',
  } as typeof base.nodes.developer;
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [toggle] };
  const { diagnostics } = materializeTemplate(base, profile);
  const diag = diagnostics.find((d) => d.code === 'MATERIALIZE_TOGGLE_UNSUPPORTED');
  assert.ok(diag, `expected MATERIALIZE_TOGGLE_UNSUPPORTED; got: ${diagnostics.map((d) => d.code).join(', ')}`);
  assert.equal(diag.target, 'developer');
  assert.match(diag.message, /schema:analysis/);
  assert.match(diag.message, /schema:reviewVerdict/);
});

test('materialize: toggle targeting absent node → MATERIALIZE_TOGGLE_UNRESOLVED with target', () => {
  const toggle = { ...makePlanReviewerToggle(), target: 'nonExistentNode' };
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [toggle] };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const diag = diagnostics.find((d) => d.code === 'MATERIALIZE_TOGGLE_UNRESOLVED');
  assert.ok(diag, `expected MATERIALIZE_TOGGLE_UNRESOLVED; got: ${diagnostics.map((d) => d.code).join(', ')}`);
  assert.equal(diag.target, 'nonExistentNode');
});

test('materialize: two toggles targeting the same node → MATERIALIZE_TOGGLE_DUPLICATE_TARGET, no crash', () => {
  const profile: TopologyProfile = {
    profileId: 'test',
    pipelineId: 'synthetic',
    toggles: [makePlanReviewerToggle(), { ...makePlanReviewerToggle() }],
  };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const diag = diagnostics.find((d) => d.code === 'MATERIALIZE_TOGGLE_DUPLICATE_TARGET');
  assert.ok(diag, `expected MATERIALIZE_TOGGLE_DUPLICATE_TARGET; got: ${diagnostics.map((d) => d.code).join(', ')}`);
  assert.equal(diag.target, 'planReviewer');
});

test('materialize: toggle targeting a non-agent node → MATERIALIZE_TOGGLE_NOT_AGENT', () => {
  const toggle = { ...makePlanReviewerToggle(), target: 'done' };
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [toggle] };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const diag = diagnostics.find((d) => d.code === 'MATERIALIZE_TOGGLE_NOT_AGENT');
  assert.ok(diag, `expected MATERIALIZE_TOGGLE_NOT_AGENT; got: ${diagnostics.map((d) => d.code).join(', ')}`);
  assert.equal(diag.target, 'done');
});

test('materialize: invalid fanout.branches count → MATERIALIZE_TOGGLE_INVALID_BRANCH_COUNT', () => {
  const toggle = { ...makePlanReviewerToggle(), fanout: { branches: 1 } };
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [toggle] };
  const { diagnostics } = materializeTemplate(makeBase(), profile);
  const diag = diagnostics.find((d) => d.code === 'MATERIALIZE_TOGGLE_INVALID_BRANCH_COUNT');
  assert.ok(diag, `expected MATERIALIZE_TOGGLE_INVALID_BRANCH_COUNT; got: ${diagnostics.map((d) => d.code).join(', ')}`);
  assert.equal(diag.target, 'planReviewer');
});

test('materialize: fanned-out branches preserve catch/escalateTo/incrementCounters from the collapsed node', () => {
  const base = makeBase();
  base.nodes['planReviewer'] = {
    ...base.nodes['planReviewer'],
    kind: 'agent',
    catch: [{ onError: 'revo.ScriptFailed', goto: 'done' }],
    escalateTo: 'done',
    incrementCounters: ['planReviewLoop'],
  } as typeof base.nodes['planReviewer'];
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(base, profile);
  const branch = template.nodes['planReviewPrimary'] as typeof base.nodes['planReviewer'] & {
    catch?: unknown;
    escalateTo?: string;
    incrementCounters?: string[];
  };
  assert.ok(branch, 'expected planReviewPrimary to exist');
  assert.deepEqual(branch.catch, [{ onError: 'revo.ScriptFailed', goto: 'done' }], 'catch must survive fanout');
  assert.equal(branch.escalateTo, 'done', 'escalateTo must survive fanout');
  assert.deepEqual(branch.incrementCounters, ['planReviewLoop'], 'incrementCounters must survive fanout');
});

// ─── validateTemplate pass on materialized output ─────────────────────────────

test('materialize: materialized planReviewer-only output has zero validateTemplate errors', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template, diagnostics } = materializeTemplate(makeBase(), profile);
  assert.deepEqual(diagnostics, []);
  assertNoErrors(template);
});

test('materialize: materialized codeReview-only output has zero validateTemplate errors', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makeCodeReviewToggle()] };
  const { template, diagnostics } = materializeTemplate(makeBase(), profile);
  assert.deepEqual(diagnostics, []);
  assertNoErrors(template);
});

test('materialize: analyst consensus rewrites entry and merges its produced artifact without a verdict reducer', () => {
  const { template, diagnostics } = materializeTemplate(makeAnalystBase(), {
    profileId: 'test',
    pipelineId: 'analysis-only',
    toggles: [makeAnalystToggle()],
  });

  assert.deepEqual(diagnostics, []);
  assert.equal(template.entry, 'analystFanout');
  assert.equal(template.nodes['analyst'], undefined);
  const join = emittedJoin(template, 'analystJoin');
  assert.deepEqual(join.merge, { analysis: 'appendByBranchOrder' });
  assert.equal(join.verdictReducer, undefined);
  assertNoErrors(template);
});

test('materialize: reviewer consensus keeps allIn verdict reduction and uses the produced review artifact', () => {
  const { template, diagnostics } = materializeTemplate(makeBase(), {
    profileId: 'test',
    pipelineId: 'synthetic',
    toggles: [makeCodeReviewToggle()],
  });

  assert.deepEqual(diagnostics, []);
  const join = emittedJoin(template, 'codeReviewJoin');
  assert.deepEqual(join.merge, { review: 'appendByBranchOrder' });
  assert.deepEqual(join.verdictReducer, {
    kind: 'allIn',
    pass: ['approved', 'clean'],
    passVerdict: 'approved',
    failVerdict: 'changes_requested',
  });
});

test('materialize: full consensus (both toggles) output has zero validateTemplate errors', () => {
  const { template, diagnostics } = materializeTemplate(makeBase(), makeConsensusProfile());
  assert.deepEqual(diagnostics, []);
  assertNoErrors(template);
});

// ─── structural assertions on materialized graph ──────────────────────────────

test('materialize: planReviewer toggle adds fanout/branch/join nodes, removes planReviewer', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const ids = new Set(Object.keys(template.nodes));
  assert.ok(!ids.has('planReviewer'), 'planReviewer must be removed');
  assert.ok(ids.has('planReviewFanout'), 'planReviewFanout must be added');
  assert.ok(ids.has('planReviewPrimary'), 'planReviewPrimary must be added');
  assert.ok(ids.has('planReviewSecondary'), 'planReviewSecondary must be added');
  assert.ok(ids.has('planReviewJoin'), 'planReviewJoin must be added');
});

test('materialize: analyst.next rewired to planReviewFanout', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const analyst = template.nodes['analyst'];
  assert.ok(analyst && analyst.kind === 'agent');
  assert.equal(analyst.next, 'planReviewFanout');
});

test('materialize: analyst consumes rewired from planReviewer to branch nodes with suffixed aliases', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const analyst = template.nodes['analyst'];
  assert.ok(analyst && analyst.kind === 'agent' && analyst.consumes);
  const consumedNodes = analyst.consumes.map((c) => c.node);
  assert.ok(!consumedNodes.includes('planReviewer'), 'planReviewer consume ref must be replaced');
  assert.ok(consumedNodes.includes('planReviewPrimary'), 'planReviewPrimary consume ref must be present');
  assert.ok(consumedNodes.includes('planReviewSecondary'), 'planReviewSecondary consume ref must be present');
  const primaryRef = analyst.consumes.find((c) => c.node === 'planReviewPrimary');
  const secondaryRef = analyst.consumes.find((c) => c.node === 'planReviewSecondary');
  assert.equal(primaryRef?.as, 'planReviewPrimary', 'primary alias must be planReviewPrimary');
  assert.equal(secondaryRef?.as, 'planReviewSecondary', 'secondary alias must be planReviewSecondary');
});

test('materialize: developer consumes rewired from planReviewer to branch nodes', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const developer = template.nodes['developer'];
  assert.ok(developer && developer.kind === 'agent' && developer.consumes);
  const consumedNodes = developer.consumes.map((c) => c.node);
  assert.ok(!consumedNodes.includes('planReviewer'), 'planReviewer consume ref must be replaced in developer');
  assert.ok(consumedNodes.includes('planReviewPrimary'));
  assert.ok(consumedNodes.includes('planReviewSecondary'));
});

test('materialize: planReviewJoin.next is the collapsed node original next (developer)', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = template.nodes['planReviewJoin'];
  assert.ok(join && join.kind === 'join');
  assert.equal(join.next, 'developer');
});

test('materialize: branch nodes inherit roleRef and produces from collapsed node', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const primary = template.nodes['planReviewPrimary'];
  const secondary = template.nodes['planReviewSecondary'];
  assert.ok(primary && primary.kind === 'agent');
  assert.ok(secondary && secondary.kind === 'agent');
  assert.equal(primary.roleRef, 'role:reviewer');
  assert.equal(secondary.roleRef, 'role:reviewer');
  assert.deepEqual(primary.produces, { name: 'planReview' });
  assert.deepEqual(secondary.produces, { name: 'planReview' });
});

// ─── join consensus behavior ──────────────────────────────────────────────────

function assertJoinReduces(join: JoinNode, arr: JoinArrival[], expectedVerdict: string): void {
  const winner = selectJoinWinner(join.joinMode, arr, join.id);
  const verdict = reduceJoinVerdict(join, arr, winner);
  assert.equal(verdict, expectedVerdict);
}

test('materialize: planReviewJoin all-pass → approved', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'planReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'approved'], ['secondary', 'clean']), 'approved');
});

test('materialize: planReviewJoin one-reject → changes_requested', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'planReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'approved'], ['secondary', 'changes_requested']), 'changes_requested');
});

test('materialize: planReviewJoin both-reject → changes_requested', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'planReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'changes_requested'], ['secondary', 'changes_requested']), 'changes_requested');
});

test('materialize: planReviewJoin verdict is branch-order-invariant', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makePlanReviewerToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'planReviewJoin');
  const v1 = reduceJoinVerdict(join, arrivals(['primary', 'approved'], ['secondary', 'changes_requested']), selectJoinWinner(join.joinMode, arrivals(['primary', 'approved'], ['secondary', 'changes_requested']), join.id));
  const v2 = reduceJoinVerdict(join, arrivals(['secondary', 'changes_requested'], ['primary', 'approved']), selectJoinWinner(join.joinMode, arrivals(['secondary', 'changes_requested'], ['primary', 'approved']), join.id));
  assert.equal(v1, v2);
});

test('materialize: codeReviewJoin all-pass → approved', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makeCodeReviewToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'codeReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'approved'], ['secondary', 'clean']), 'approved');
});

test('materialize: codeReviewJoin one-reject → changes_requested', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makeCodeReviewToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'codeReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'approved'], ['secondary', 'changes_requested']), 'changes_requested');
});

test('materialize: codeReviewJoin both-reject → changes_requested', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makeCodeReviewToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'codeReviewJoin');
  assertJoinReduces(join, arrivals(['primary', 'changes_requested'], ['secondary', 'changes_requested']), 'changes_requested');
});

test('materialize: codeReviewJoin verdict is branch-order-invariant', () => {
  const profile: TopologyProfile = { profileId: 'test', pipelineId: 'synthetic', toggles: [makeCodeReviewToggle()] };
  const { template } = materializeTemplate(makeBase(), profile);
  const join = emittedJoin(template, 'codeReviewJoin');
  const a1 = arrivals(['primary', 'approved'], ['secondary', 'changes_requested']);
  const a2 = arrivals(['secondary', 'changes_requested'], ['primary', 'approved']);
  const v1 = reduceJoinVerdict(join, a1, selectJoinWinner(join.joinMode, a1, join.id));
  const v2 = reduceJoinVerdict(join, a2, selectJoinWinner(join.joinMode, a2, join.id));
  assert.equal(v1, v2);
});
