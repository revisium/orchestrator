import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  DEFAULT_PLAYBOOK_ID,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  stubDefaultAgentProfile,
} from './kit/index.js';

// Group I — ROUTING. resolveRouteDecision maps a task to an explicit pipeline + run profile.
// It is deterministic and read-only, so these tests assert the route contract directly via
// simulate_route (no workflow runs): profile selection, role bindings, param isolation, errors,
// and that simulate_route matches what a created run is bound to.

type Pipeline = { pipelineId: string; requiredRoles: string[]; triggers: string[]; routeGates: string[] };
type Binding = { roleId: string; runnerId: string; resolvedRunnerId: string; runnerSource: string; modelLevel: string };
type Route = {
  pipelineId: string;
  source: string;
  roles: string[];
  routeGates: string[];
  launchBindings: unknown[];
  roleBindings: Binding[];
  params: Record<string, unknown>;
};

let h: RunHarness;
let pipelines: Pipeline[];
const byId = (id: string) => pipelines.find((p) => p.pipelineId === id);
const hasCode = (code: string) => (err: unknown) => (err as { code?: string }).code === code;

/** simulate_route returns an untyped JSON projection — narrow once to the routing contract. */
function emptyProfile() {
  return {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: { slots: {} },
  };
}

const route = (input: { title: string; pipeline: string; params?: Record<string, unknown>; repo?: string; profile?: unknown }) =>
  h.api.simulateRoute(input) as Promise<Route>;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
  pipelines = (await h.api.listPipelines()) as unknown as Pipeline[];
});

after(async () => {
  if (h) await h.close();
});

test('I1: explicit pipeline selection returns that pipeline, its required roles, and its gates', { skip: e2eSkip }, async () => {
  const lc = await route({ title: 'explicit', pipeline: 'local-change', profile: emptyProfile() });
  assert.equal(lc.pipelineId, 'local-change');
  assert.equal(lc.source, 'explicit');
  assert.deepEqual(lc.roles, ['orchestrator', 'developer'], 'local-change is orchestrator + developer only (no integrator)');
  // No plan gate → a developer-only run completes autonomously; a merge gate is inert without an integrator.
  assert.ok(!lc.routeGates.includes('plan'), 'local-change does not park at a plan gate');

  const fd = await route({ title: 'explicit', pipeline: 'feature-development', profile: emptyProfile() });
  assert.equal(fd.pipelineId, 'feature-development');
  assert.equal(fd.source, 'explicit');
  for (const role of byId('feature-development')?.requiredRoles ?? []) {
    assert.ok(fd.roles.includes(role), `feature-development routes required role ${role}`);
  }
  assert.ok(fd.routeGates.includes('plan') && fd.routeGates.includes('merge'), 'feature-development gates normalize to plan + merge');
});

test('I2: missing pipeline is rejected (fail-closed, no silent fallback)', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () => h.api.simulateRoute({ title: 'zzqq xyzzy frobnicate wibblewobble', profile: emptyProfile() }),
    hasCode('VALIDATION_FAILURE'),
  );
});

test('I3: every required role binds a runner + model level (default: resolved from the playbook)', { skip: e2eSkip }, async () => {
  const r = await route({ title: 'bindings', pipeline: 'feature-development', profile: emptyProfile() });
  for (const roleId of byId('feature-development')?.requiredRoles ?? []) {
    const b = r.roleBindings.find((x) => x.roleId === roleId);
    assert.ok(b, `binding present for ${roleId}`);
    assert.ok(b.modelLevel.length > 0, `${roleId} has a model level`);
    assert.equal(b.resolvedRunnerId, b.runnerId, `${roleId} default: resolvedRunnerId === runnerId`);
    assert.equal(b.runnerSource, 'playbook', `${roleId} default runner comes from the playbook`);
  }
  const integrator = r.roleBindings.find((x) => x.roleId === 'integrator');
  if (integrator) assert.equal(integrator.runnerId, 'revo-integrator', 'integrator binds the real integrator runner');
});

test('I4: public params cannot smuggle launch bindings', { skip: e2eSkip }, async () => {
  const r = await route({
    title: 'safety',
    pipeline: 'local-change',
    profile: stubDefaultAgentProfile(),
    params: {
      profileLike: { runner: 'must-not-leak' },
      runnerSelectionDraft: { runner: 'must-not-leak' },
      ticket: 'OK-1',
    },
  });
  assert.ok(r.roleBindings.every((binding) => binding.resolvedRunnerId !== 'must-not-leak'), 'params cannot change route bindings');
  assert.equal((r.params.profileLike as Record<string, unknown>).runner, 'must-not-leak', 'business params are inert data');
  assert.equal((r.params.runnerSelectionDraft as Record<string, unknown>).runner, 'must-not-leak', 'business params survive');
  assert.equal(r.params.ticket, 'OK-1', 'genuine public params survive');
});

test('I5: inline run profile resolves the runner from the profile, not the playbook', { skip: e2eSkip }, async () => {
  const created = (await h.api.createRun({
    title: 'override',
    repo: process.cwd(),
    pipelineId: 'feature-development',
    profile: stubDefaultAgentProfile(),
    start: false,
  })) as { route: Route };
  const overridden = created.route.roleBindings.filter((b) => b.roleId !== 'integrator');
  assert.ok(overridden.length > 0, 'feature-development has claude-code roles to override');
  for (const b of overridden) {
    assert.equal(b.resolvedRunnerId, 'stub-agent', `${b.roleId} resolves to the override`);
    assert.equal(b.runnerSource, 'profile', `${b.roleId} override is sourced from the profile`);
  }
  const integrator = created.route.roleBindings.find((b) => b.roleId === 'integrator');
  if (integrator) assert.equal(integrator.runnerSource, 'playbook', 'a non-overridden role stays bound from the playbook');
});

test('I6: unknown pipeline and unknown playbook are rejected with ROW_NOT_FOUND', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () => h.api.simulateRoute({ title: 'x', pipeline: 'no-such-pipeline', profile: emptyProfile() }),
    hasCode('ROW_NOT_FOUND'),
  );
  await assert.rejects(
    () => h.api.simulateRoute({
      title: 'x',
      pipeline: 'feature-development',
      playbookId: 'no-such-playbook',
      profile: emptyProfile(),
    }),
    hasCode('ROW_NOT_FOUND'),
  );
});

test('I7: simulate_route matches the route a created run is actually bound to', { skip: e2eSkip }, async () => {
  const profile = stubDefaultAgentProfile();
  const sim = await route({ title: 'consistency', repo: process.cwd(), pipeline: 'feature-development', profile });
  const created = (await h.api.createRun({
    title: 'consistency',
    repo: process.cwd(),
    pipelineId: 'feature-development',
    profile,
    start: false,
  })) as { route: Route };
  assert.equal(created.route.pipelineId, sim.pipelineId);
  assert.deepEqual(created.route.roles, sim.roles);
  assert.deepEqual(created.route.routeGates, sim.routeGates);
  assert.deepEqual(
    created.route.roleBindings.map((b) => [b.roleId, b.resolvedRunnerId, b.runnerSource]),
    sim.roleBindings.map((b) => [b.roleId, b.resolvedRunnerId, b.runnerSource]),
    'role bindings are identical between simulate and create',
  );
});

// Group I — run-profile bindings

type FullBinding = Binding & {
  resolvedModelLevel?: string;
  modelSource?: string;
  resolvedTimeoutMs?: number;
  timeoutSource?: string;
  resolvedPermissionMode?: string;
  permissionSource?: string;
};
type FullRoute = Omit<Route, 'roleBindings'> & { roleBindings: FullBinding[] };

test('I8: profile bindings by roleId records per-axis provenance on resolved bindings', { skip: e2eSkip }, async () => {
  // developer defaults: standard model, claude-code runner — override all three overridable axes.
  const r = (await h.api.simulateRoute({
    title: 'provenance',
    pipeline: 'feature-development',
    profile: {
      ...emptyProfile(),
      bindings: {
        slots: {
          'role:developer': { modelLevel: 'deep', timeoutMs: 60000, permissionMode: 'acceptEdits' },
        },
      },
    },
  })) as FullRoute;

  const dev = r.roleBindings.find((b) => b.roleId === 'developer');
  assert.ok(dev, 'developer binding present');
  assert.equal(dev.resolvedModelLevel, 'deep', 'modelLevel override applied');
  assert.equal(dev.modelSource, 'profile', 'model sourced from profile');
  assert.equal(dev.resolvedTimeoutMs, 60000, 'timeoutMs override applied');
  assert.equal(dev.timeoutSource, 'profile', 'timeout sourced from profile');
  assert.equal(dev.resolvedPermissionMode, 'acceptEdits', 'permissionMode override applied');
  assert.equal(dev.permissionSource, 'profile', 'permission sourced from profile');

  // non-overridden roles retain playbook-sourced model
  const others = r.roleBindings.filter((b) => b.roleId !== 'developer');
  for (const b of others) {
    if (b.modelSource !== undefined) {
      assert.equal(b.modelSource, 'playbook', `non-overridden ${b.roleId} has playbook model source`);
    }
  }
});

test('I9: profile binding with unknown runnerId is rejected with VALIDATION_FAILURE before run starts', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () =>
      h.api.simulateRoute({
        title: 'bad-runner',
        pipeline: 'feature-development',
        profile: {
          ...emptyProfile(),
          bindings: { slots: { 'role:developer': { runnerId: 'no-such-runner', modelLevel: 'standard' } } },
        },
      }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'VALIDATION_FAILURE');
      assert.ok((err as { message?: string }).message?.includes('no-such-runner'), 'error names the bad runner');
      return true;
    },
  );
});

test('I9b: node-only profile binding with unknown runnerId fails closed-schema validation', { skip: e2eSkip }, async () => {
  // Phase A validates EVERY override entry regardless of whether it matches a selected role.
  await assert.rejects(
    () =>
      h.api.simulateRoute({
        title: 'node-bad-runner',
        pipeline: 'feature-development',
        profile: {
          ...emptyProfile(),
          bindings: { slots: { 'node:developer': { runnerId: 'no-such-runner', modelLevel: 'standard' } } },
        },
      }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'VALIDATION_FAILURE');
      assert.ok((err as { message?: string }).message?.includes('no-such-runner'), 'error names the bad runner');
      return true;
    },
  );
});

test('I10: profile permissionMode mismatched for runner is rejected (PROFILE_SCHEMA_CLOSED)', { skip: e2eSkip }, async () => {
  // developer is claude-code; workspace-write is codex-only — must fail closed.
  await assert.rejects(
    () =>
      h.api.simulateRoute({
        title: 'bad-permission',
        pipeline: 'feature-development',
        profile: {
          ...emptyProfile(),
          bindings: { slots: { 'role:developer': { permissionMode: 'workspace-write' } } },
        },
      }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'VALIDATION_FAILURE');
      assert.ok((err as { message?: string }).message?.includes('workspace-write'), 'error names the bad permissionMode');
      return true;
    },
  );
});

test('I11: feature-development profile routes through stored run profile and stamps provenance', { skip: e2eSkip }, async () => {
  type ProvenanceRoute = Route & {
    requestedPipelineId?: string;
    basePipelineId?: string;
    profileId?: string;
    materializedTemplateHash?: string;
    profileHash?: string;
    profileVersion?: string;
    materializerVersion?: string;
    policyVersion?: string;
  };

  const r = (await h.api.simulateRoute({
    title: 'profile routing test',
    pipeline: 'feature-development',
    playbookId: DEFAULT_PLAYBOOK_ID,
    profileId: 'codex-primary-claude-review-consensus',
  })) as ProvenanceRoute;

  assert.equal(r.pipelineId, 'feature-development', 'public pipelineId is the selected pipeline');
  assert.equal(r.requestedPipelineId, 'feature-development', 'requestedPipelineId is the selected pipeline');
  assert.equal(r.basePipelineId, 'feature-development', 'basePipelineId resolves to the selected pipeline');
  assert.equal(r.profileId, 'codex-primary-claude-review-consensus', 'profileId is stamped');
  assert.ok(
    typeof r.materializedTemplateHash === 'string' && r.materializedTemplateHash.length === 64,
    'materializedTemplateHash is a SHA-256 hex string',
  );
  assert.ok(typeof r.profileHash === 'string' && r.profileHash.length > 0, 'profileHash is stamped');
  assert.ok(typeof r.profileVersion === 'string' && r.profileVersion.length > 0, 'profileVersion is stamped');
  assert.ok(r.roles.length > 0, 'profile route includes required roles');
  assert.ok(r.routeGates.includes('plan') && r.routeGates.includes('merge'), 'profile route includes plan + merge gates');

  const created = (await h.api.createRun({
    title: 'profile routing test',
    repo: process.cwd(),
    pipelineId: 'feature-development',
    playbookId: DEFAULT_PLAYBOOK_ID,
    profileId: 'codex-primary-claude-review-consensus',
    start: false,
  })) as { route: ProvenanceRoute };
  assert.equal(created.route.basePipelineId, 'feature-development', 'createRun route basePipelineId matches');
  assert.equal(created.route.materializedTemplateHash, r.materializedTemplateHash, 'createRun materializedTemplateHash matches simulateRoute');
});
