import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
} from './kit/index.js';

// Group I — ROUTING. A task is mapped to a pipeline + roles + gates + execution profile by
// resolveRouteDecision (the routing "brain"). It is deterministic and read-only via simulate_route,
// so this suite asserts the route contract directly (no workflow runs): explicit vs deterministic
// pipeline selection, role bindings + runner resolution, route gates, the param-safety invariant,
// errors, and that simulate_route matches what a created run is bound to. Data-driven off the
// installed pipeline catalog so it survives playbook edits. One shared host.

type Pipeline = { pipelineId: string; requiredRoles: string[]; triggers: string[]; routeGates: string[] };
type Binding = { roleId: string; runnerId: string; resolvedRunnerId: string; runnerSource: string; modelLevel: string };
type Route = {
  pipelineId: string;
  source: string;
  roles: string[];
  routeGates: string[];
  executionProfile: { runnerOverrides: Record<string, string> };
  roleBindings: Binding[];
  params: Record<string, unknown>;
};

let h: RunHarness;
let pipelines: Pipeline[];
const byId = (id: string): Pipeline | undefined => pipelines.find((p) => p.pipelineId === id);
const hasCode = (code: string) => (err: unknown) => (err as { code?: string }).code === code;

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
  const lc = await (h.api.simulateRoute({ title: 'explicit', pipeline: 'local-change' }) as Promise<Route>);
  assert.equal(lc.pipelineId, 'local-change');
  assert.equal(lc.source, 'explicit');
  assert.deepEqual(lc.roles, ['orchestrator', 'developer'], 'local-change is orchestrator + developer only (no integrator)');
  // No plan gate → a developer-only run completes autonomously (any declared merge gate is inert without an integrator).
  assert.ok(!lc.routeGates.includes('plan'), 'local-change does not park at a plan gate');

  const fd = await (h.api.simulateRoute({ title: 'explicit', pipeline: 'feature-development' }) as Promise<Route>);
  assert.equal(fd.pipelineId, 'feature-development');
  assert.equal(fd.source, 'explicit');
  for (const role of byId('feature-development')?.requiredRoles ?? []) {
    assert.ok(fd.roles.includes(role), `feature-development routes required role ${role}`);
  }
  assert.ok(fd.routeGates.includes('plan') && fd.routeGates.includes('merge'), 'feature-development gates normalize to plan + merge');
});

test('I2: deterministic auto-selection picks a pipeline reproducibly from task text', { skip: e2eSkip }, async () => {
  // A pipeline's own triggers as the task text score highest for it → it is selected.
  const target = byId('feature-development')?.triggers.length ? byId('feature-development')! : pipelines.find((p) => p.triggers.length > 0)!;
  assert.ok(target, 'at least one pipeline has triggers');
  const title = target.triggers.join(' ');
  const r1 = await (h.api.simulateRoute({ title }) as Promise<Route>);
  const r2 = await (h.api.simulateRoute({ title }) as Promise<Route>);
  assert.equal(r1.source, 'deterministic-installed-playbook');
  assert.equal(r1.pipelineId, r2.pipelineId, 'auto-selection is reproducible for the same task text');
  assert.equal(r1.pipelineId, target.pipelineId, "task text from a pipeline's triggers selects that pipeline");
});

test('I2b: a task matching no trigger is rejected (fail-closed, no silent fallback)', { skip: e2eSkip }, async () => {
  await assert.rejects(
    () => h.api.simulateRoute({ title: 'zzqq xyzzy frobnicate wibblewobble' }),
    hasCode('VALIDATION_FAILURE'),
  );
});

test('I3: every required role binds a runner + model level (default: resolved from the playbook)', { skip: e2eSkip }, async () => {
  const route = await (h.api.simulateRoute({ title: 'bindings', pipeline: 'feature-development' }) as Promise<Route>);
  for (const roleId of byId('feature-development')?.requiredRoles ?? []) {
    const b = route.roleBindings.find((x) => x.roleId === roleId);
    assert.ok(b, `binding present for ${roleId}`);
    assert.ok(b.modelLevel.length > 0, `${roleId} has a model level`);
    assert.equal(b.resolvedRunnerId, b.runnerId, `${roleId} default: resolvedRunnerId === runnerId`);
    assert.equal(b.runnerSource, 'playbook', `${roleId} default runner comes from the playbook`);
  }
  const integrator = route.roleBindings.find((x) => x.roleId === 'integrator');
  if (integrator) assert.equal(integrator.runnerId, 'revo-integrator', 'integrator binds the real integrator runner');
});

test('I4: public params cannot smuggle runner overrides (stripped from params + execution profile)', { skip: e2eSkip }, async () => {
  const route = await (h.api.simulateRoute({
    title: 'safety',
    pipeline: 'local-change',
    params: {
      executionProfile: { runnerOverrides: { 'claude-code': 'must-not-leak' } },
      runnerOverrides: { 'claude-code': 'must-not-leak' },
      ticket: 'OK-1',
    },
  }) as Promise<Route>);
  assert.deepEqual(route.executionProfile.runnerOverrides, {}, 'no overrides leak into the route');
  assert.ok(!('executionProfile' in route.params), 'executionProfile stripped from public params');
  assert.ok(!('runnerOverrides' in route.params), 'runnerOverrides stripped from public params');
  assert.equal(route.params.ticket, 'OK-1', 'genuine public params survive');
});

test('I5: an execution-profile override resolves the runner from the profile, not the playbook', { skip: e2eSkip }, async () => {
  // executionProfile is a private service seam (not public params) — createRun accepts it; start:false skips execution.
  const created = (await h.api.createRun({
    title: 'override',
    repo: process.cwd(),
    pipelineId: 'feature-development',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  })) as { route: Route };
  const overridden = created.route.roleBindings.filter((b) => b.runnerId === 'claude-code');
  assert.ok(overridden.length > 0, 'feature-development has claude-code roles to override');
  for (const b of overridden) {
    assert.equal(b.resolvedRunnerId, 'stub-agent', `${b.roleId} resolves to the override`);
    assert.equal(b.runnerSource, 'execution-profile', `${b.roleId} override is sourced from the profile`);
  }
  const integrator = created.route.roleBindings.find((b) => b.roleId === 'integrator');
  if (integrator) assert.equal(integrator.runnerSource, 'playbook', 'a non-overridden role stays bound from the playbook');
});

test('I6: unknown pipeline and unknown playbook are rejected with ROW_NOT_FOUND', { skip: e2eSkip }, async () => {
  await assert.rejects(() => h.api.simulateRoute({ title: 'x', pipeline: 'no-such-pipeline' }), hasCode('ROW_NOT_FOUND'));
  await assert.rejects(() => h.api.simulateRoute({ title: 'x', playbookId: 'no-such-playbook' }), hasCode('ROW_NOT_FOUND'));
});

test('I7: simulate_route matches the route a created run is actually bound to', { skip: e2eSkip }, async () => {
  const sim = await (h.api.simulateRoute({ title: 'consistency', repo: process.cwd(), pipeline: 'feature-development' }) as Promise<Route>);
  const created = (await h.api.createRun({
    title: 'consistency',
    repo: process.cwd(),
    pipelineId: 'feature-development',
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
